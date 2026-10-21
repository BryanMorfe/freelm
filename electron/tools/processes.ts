import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { OutputFileTracker } from './output-files';
import type { ToolHostRequest, ToolResult, ToolSettings } from '../../src/agent-types';
import {
	boundedNumber,
	checkAbort,
	requiredString,
	safeWorkspacePath,
	textResult,
	workspaceRoots,
} from './common';

const MAX_BUFFER_CHARACTERS = 128_000;
const MAX_PROCESS_MS = 30 * 60_000;

interface ProcessSession {
	id: string;
	command: string;
	owner: string;
	runId: string;
	child: ChildProcessWithoutNullStreams;
	outputs: OutputFileTracker;
	output: string;
	omitted: number;
	exited: boolean;
	exitCode: number | null;
	exitSignal: string | null;
	waiters: Set<() => void>;
	dispose: () => void;
	killTimer?: ReturnType<typeof setTimeout>;
}

function owner(request: ToolHostRequest): string {
	return JSON.stringify([request.workspaceId, request.threadId, request.runId]);
}

function stop(session: ProcessSession, signal: NodeJS.Signals = 'SIGTERM'): void {
	try {
		if (process.platform !== 'win32' && session.child.pid) process.kill(-session.child.pid, signal);
		else if (!session.exited) session.child.kill(signal);
	} catch {
		// The process may have exited between checking and signalling it.
	}
}

export class ProcessRuntime {
	private sessions = new Map<string, ProcessSession>();

	async exec(
		request: ToolHostRequest,
		settings: ToolSettings,
		signal: AbortSignal,
	): Promise<ToolResult> {
		if (!settings.commandExecution)
			throw new Error('Command execution is disabled in Tools settings.');
		checkAbort(signal);
		const args = request.arguments;
		if (args.tty === true)
			throw new Error(
				'PTY mode is not available in this build. Omit tty to use pipes with write_stdin.',
			);
		const command = requiredString(args, 'cmd', 100_000);
		const roots = await workspaceRoots(settings);
		const cwd = await safeWorkspacePath(
			roots,
			typeof args.workdir === 'string' ? args.workdir : '.',
			true,
			settings.workspacePathsUnrestricted === true,
		);
		if (!(await stat(cwd)).isDirectory()) throw new Error('workdir must be a directory.');
		const shell = typeof args.shell === 'string' ? args.shell : process.env.SHELL || '/bin/bash';
		if (!path.isAbsolute(shell)) throw new Error('shell must be an absolute executable path.');
		if (this.sessions.size >= 32)
			throw new Error('Too many command sessions are active. Finish or cancel another run first.');
		// Host-derived project roots and an explicitly approved workdir are observed.
		// An unbound task's automatic home-directory fallback is never inventoried.
		const trackingRoots =
			settings.workspaceRoots === undefined || settings.workspaceRoots.length
				? roots.map((root) => root.path)
				: [];
		if (typeof args.workdir === 'string' && args.workdir.trim()) trackingRoots.push(cwd);
		const outputs = await OutputFileTracker.create(trackingRoots);
		let child: ChildProcessWithoutNullStreams;
		try {
			checkAbort(signal);
			child = spawn(shell, [args.login === true ? '-lc' : '-c', command], {
				cwd,
				env: { ...process.env, FREELM_TOOL_EXECUTION: '1' },
				stdio: ['pipe', 'pipe', 'pipe'],
				detached: process.platform !== 'win32',
			});
		} catch (error) {
			outputs.close();
			throw error;
		}
		const session: ProcessSession = {
			id: randomUUID(),
			command,
			owner: owner(request),
			runId: request.runId,
			child,
			outputs,
			output: '',
			omitted: 0,
			exited: false,
			exitCode: null,
			exitSignal: null,
			waiters: new Set(),
			dispose: () => {},
		};
		this.sessions.set(session.id, session);
		const append = (text: string) => {
			session.output += text;
			if (session.output.length > MAX_BUFFER_CHARACTERS) {
				const excess = session.output.length - MAX_BUFFER_CHARACTERS;
				session.omitted += excess;
				session.output = session.output.slice(excess);
			}
		};
		child.stdout.setEncoding('utf8').on('data', append);
		child.stderr.setEncoding('utf8').on('data', append);
		// Handle EPIPE when an interactive program closes stdin between writes.
		child.stdin.on('error', () => {});
		const timeout = setTimeout(() => {
			append('\n[FreeLM stopped this command after the 30-minute process limit.]\n');
			this.terminate(session);
		}, MAX_PROCESS_MS);
		timeout.unref();
		const abort = () => this.terminate(session);
		signal.addEventListener('abort', abort, { once: true });
		session.dispose = () => {
			clearTimeout(timeout);
			signal.removeEventListener('abort', abort);
		};
		child.on('error', (error) => {
			append(`\nFailed to start process: ${error.message}\n`);
		});
		child.on('close', (code, exitSignal) => {
			// The shell may have launched redirected background children. End its group
			// while ownership is current, rather than retaining a reusable PID after exit.
			if (session.killTimer) clearTimeout(session.killTimer);
			stop(session, 'SIGKILL');
			session.exited = true;
			session.exitCode = code;
			session.exitSignal = exitSignal;
			session.dispose();
			for (const wake of session.waiters) wake();
		});
		await this.wait(session, boundedNumber(args.yield_time_ms, 1000, 0, 30_000), signal);
		return this.result(session, args.max_output_tokens);
	}

	async write(request: ToolHostRequest, signal: AbortSignal): Promise<ToolResult> {
		checkAbort(signal);
		const id = requiredString(request.arguments, 'session_id', 100);
		const session = this.sessions.get(id);
		if (!session || session.owner !== owner(request))
			throw new Error(
				'This command session does not belong to the current run or is no longer available.',
			);
		const chars = typeof request.arguments.chars === 'string' ? request.arguments.chars : '';
		if (chars.length > 100_000) throw new Error('stdin input exceeds 100,000 characters.');
		if (!session.exited && chars) {
			if (chars === '\u0003') stop(session, 'SIGINT');
			else if (chars === '\u0004') session.child.stdin.end();
			else {
				await new Promise<void>((resolve, reject) =>
					session.child.stdin.write(chars, (error) => (error ? reject(error) : resolve())),
				);
			}
		}
		await this.wait(
			session,
			boundedNumber(request.arguments.yield_time_ms, chars ? 250 : 1000, 0, 30_000),
			signal,
		);
		return this.result(session, request.arguments.max_output_tokens);
	}

	private async wait(
		session: ProcessSession,
		milliseconds: number,
		signal: AbortSignal,
	): Promise<void> {
		if (session.exited || milliseconds === 0) return;
		await new Promise<void>((resolve) => {
			const finish = () => {
				clearTimeout(timer);
				session.waiters.delete(finish);
				signal.removeEventListener('abort', finish);
				resolve();
			};
			const timer = setTimeout(finish, milliseconds);
			session.waiters.add(finish);
			signal.addEventListener('abort', finish, { once: true });
		});
		checkAbort(signal);
	}

	private async result(session: ProcessSession, maxTokens: unknown): Promise<ToolResult> {
		const limit = boundedNumber(maxTokens, 6000, 1, 32_000) * 4;
		const pending = session.output;
		const omitted = session.omitted + Math.max(0, pending.length - limit);
		const output = `${omitted ? `[${omitted} earlier output characters omitted]\n` : ''}${pending.slice(-limit)}`;
		session.output = '';
		session.omitted = 0;
		const exitedBeforeScan = session.exited;
		let tracked = await session.outputs.collect(exitedBeforeScan);
		if (!exitedBeforeScan && session.exited) {
			const final = await session.outputs.collect(true);
			tracked = {
				outputFiles: [...tracked.outputFiles, ...final.outputFiles].slice(0, 1000),
				...(final.outputTrackingNotices
					? { outputTrackingNotices: final.outputTrackingNotices }
					: {}),
			};
		}
		if (session.exited) {
			this.sessions.delete(session.id);
			session.outputs.close();
		}
		return {
			...textResult(
				{
					output,
					...(session.exited
						? { exit_code: session.exitCode, signal: session.exitSignal }
						: { session_id: session.id }),
				},
				session.exited && session.exitCode !== 0,
			),
			process: {
				command: session.command,
				sessionId: session.id,
				...(session.exited ? { exitCode: session.exitCode } : {}),
			},
			...tracked,
		};
	}

	private terminate(session: ProcessSession): void {
		if (session.exited) return;
		stop(session);
		if (session.killTimer) clearTimeout(session.killTimer);
		session.killTimer = setTimeout(() => {
			if (!session.exited) stop(session, 'SIGKILL');
		}, 500);
		session.killTimer.unref();
		for (const wake of session.waiters) wake();
	}

	cancel(runId: string): void {
		for (const [id, session] of this.sessions) {
			if (session.runId !== runId) continue;
			this.terminate(session);
			session.dispose();
			session.outputs.close();
			this.sessions.delete(id);
		}
	}

	close(): void {
		for (const session of this.sessions.values()) {
			this.terminate(session);
			session.dispose();
			session.outputs.close();
		}
		this.sessions.clear();
	}
}
