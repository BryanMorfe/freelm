import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
	access,
	lstat,
	mkdir,
	mkdtemp,
	open,
	opendir,
	realpath,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolHostRequest, ToolResult } from '../../src/agent-types';
import { pythonWorkerSource } from './python-worker';
import { decodeWebImage } from './web-image';

interface RuntimeOptions {
	/** Trusted host/test values only. These are never accepted from the model or renderer. */
	executablePath?: string;
	runtimeRoot?: string;
	isolationExecutable?: string;
	platform?: NodeJS.Platform;
	sessionRoot?: string;
	idleTimeoutMs?: number;
	/** Host/test quotas, not renderer/model settings. */
	maxSessionBytes?: number;
	maxSessionEntries?: number;
	monitorIntervalMs?: number;
}
interface Launch {
	executable: string;
	root: string;
	isolation: string;
	platform: 'darwin' | 'linux';
}
interface Reply {
	type: string;
	id?: string;
	python?: string;
	libraries?: string[];
	stdout?: string;
	stderr?: string;
	result?: string;
	error?: string;
	timed_out?: boolean;
}
interface Session {
	key: string;
	directory: string;
	output: string;
	child: ChildProcessWithoutNullStreams;
	ready: Promise<Reply>;
	closed: boolean;
	busy: boolean;
	activeRun?: string;
	idleTimer?: ReturnType<typeof setTimeout>;
	quotaTimer?: ReturnType<typeof setInterval>;
	checkingQuota?: boolean;
	failure?: Error;
	pending?: { id: string; resolve: (reply: Reply) => void; reject: (error: Error) => void };
	files: Map<string, string>;
	metadata?: Reply;
}

const OUTPUT_LIMIT = 2 * 1024 * 1024;
const ARTIFACT_LIMIT = 8 * 1024 * 1024;
const MAX_SESSIONS = 8;
const MIME: Record<string, string> = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.gif': 'image/gif',
	'.svg': 'image/svg+xml',
	'.pdf': 'application/pdf',
	'.csv': 'text/csv',
	'.json': 'application/json',
	'.txt': 'text/plain',
	'.md': 'text/markdown',
	'.html': 'text/html',
	'.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function aborted(signal: AbortSignal) {
	if (signal.aborted) throw new DOMException('Python execution cancelled.', 'AbortError');
}

/** Default-deny profile. User homes and network are never granted to the interpreter. */
export function macPythonProfile(executable: string, runtime: string, directory: string): string {
	const literal = (value: string) => JSON.stringify(value);
	const systemRoots = [
		'/System/Library',
		'/usr/lib',
		'/System/Volumes/Preboot/Cryptexes/OS',
		'/private/var/db/dyld',
		'/Library/Apple/usr/libexec/oah',
		'/private/var/db/oah',
	];
	const readRoots = [runtime, ...systemRoots, '/usr/share/zoneinfo', directory];
	return [
		'(version 1)',
		'(deny default)',
		`(allow process-exec (literal ${literal(executable)}))`,
		'(allow signal (target self))',
		'(allow sysctl-read)',
		`(allow file-read* ${readRoots.map((value) => `(subpath ${literal(value)})`).join(' ')})`,
		// dyld opens the root directory while resolving its system-library cache.
		// This grants only that directory, never its descendants.
		'(allow file-read* (literal "/"))',
		`(allow file-map-executable ${[runtime, ...systemRoots].map((value) => `(subpath ${literal(value)})`).join(' ')})`,
		'(allow file-read* (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom") (literal "/etc/localtime") (literal "/private/etc/localtime"))',
		`(allow file-write* (subpath ${literal(path.join(directory, 'output'))}) (subpath ${literal(path.join(directory, 'scratch'))}))`,
		// A read-only parent prevents replacing output/scratch roots with symlinks.
		`(deny file-write-unlink (literal ${literal(path.join(directory, 'output'))}) (literal ${literal(path.join(directory, 'scratch'))}))`,
		'(allow file-write-data (literal "/dev/null"))',
	].join('\n');
}

/** Persistent, isolated interpreters. Local Code command settings never grant Python access. */
export class PythonRuntime {
	private sessions = new Map<string, Session>();
	private startups = new Map<string, Promise<Session>>();
	private workers = new Set<Session>();
	private cleanups = new Set<Promise<unknown>>();
	private closed = false;
	constructor(private options: RuntimeOptions = {}) {}

	private async launch(): Promise<Launch> {
		const platform = this.options.platform ?? process.platform;
		if (platform !== 'darwin' && platform !== 'linux')
			throw new Error('Isolated Chat Python is supported only on macOS and Linux.');
		const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
		const candidates = this.options.executablePath
			? [this.options.executablePath]
			: [
					...(resources
						? [
								path.join(
									resources,
									'search/runtime',
									`${platform}-${process.arch}`,
									'python/bin/python3',
								),
							]
						: []),
					path.resolve(
						'resources/search/runtime',
						`${platform}-${process.arch}`,
						'python/bin/python3',
					),
					...(platform === 'linux' ? ['/usr/bin/python3'] : []),
				];
		let executable = '';
		for (const candidate of candidates) {
			try {
				await access(candidate, constants.X_OK);
				executable = await realpath(candidate);
				break;
			} catch {
				/* Try only trusted packaged/system paths. */
			}
		}
		if (!executable)
			throw new Error(
				'The bundled Python runtime is unavailable. Reinstall FreeLM with its Python resources.',
			);
		const root = await realpath(this.options.runtimeRoot ?? path.dirname(path.dirname(executable)));
		const isolationCandidates = this.options.isolationExecutable
			? [this.options.isolationExecutable]
			: platform === 'darwin'
				? ['/usr/bin/sandbox-exec']
				: ['/usr/bin/bwrap', '/bin/bwrap'];
		let isolation = '';
		for (const candidate of isolationCandidates) {
			try {
				await access(candidate, constants.X_OK);
				isolation = await realpath(candidate);
				break;
			} catch {
				/* Fail closed below. */
			}
		}
		if (!isolation)
			throw new Error(
				platform === 'linux'
					? 'Chat Python requires bubblewrap (bwrap) and enabled unprivileged user namespaces. No code was executed.'
					: 'The macOS sandbox is unavailable. Chat Python is disabled; no code was executed.',
			);
		return { executable, root, isolation, platform };
	}

	private async create(key: string, signal?: AbortSignal): Promise<Session> {
		if (this.closed) throw new Error('Python runtime is closed.');
		const launch = await this.launch();
		const parent = await realpath(this.options.sessionRoot ?? tmpdir());
		const directory = await mkdtemp(path.join(parent, 'freelm-python-'));
		const output = path.join(directory, 'output');
		const scratch = path.join(directory, 'scratch');
		await mkdir(output, { mode: 0o700 });
		await mkdir(scratch, { mode: 0o700 });
		const worker = path.join(directory, 'worker.py');
		await writeFile(worker, pythonWorkerSource, { mode: 0o400 });
		let args: string[];
		if (launch.platform === 'darwin') {
			const profile = path.join(directory, 'sandbox.sb');
			await writeFile(profile, macPythonProfile(launch.executable, launch.root, directory), {
				mode: 0o400,
			});
			args = ['-f', profile, launch.executable, '-I', '-u', '-B', worker, output];
		} else {
			args = [
				'--unshare-all',
				'--disable-userns',
				'--new-session',
				'--die-with-parent',
				'--cap-drop',
				'ALL',
				'--clearenv',
				'--setenv',
				'HOME',
				'/output',
				'--setenv',
				'TMPDIR',
				'/scratch',
				'--setenv',
				'LANG',
				'C.UTF-8',
				'--setenv',
				'MPLBACKEND',
				'Agg',
				// A system Python fallback exposes its executable and system libraries,
				// never all of /usr (which may contain user-managed content).
				'--ro-bind',
				launch.root === '/usr' ? launch.executable : launch.root,
				launch.root === '/usr' ? launch.executable : launch.root,
				'--ro-bind',
				directory,
				'/session',
				'--bind',
				output,
				'/output',
				'--bind',
				scratch,
				'/scratch',
				'--dev',
				'/dev',
				'--proc',
				'/proc',
			];
			for (const systemPath of ['/lib', '/lib64', '/usr/lib']) {
				if (
					await lstat(systemPath).then(
						() => true,
						() => false,
					)
				)
					args.push('--ro-bind', systemPath, systemPath);
			}
			args.push(
				'--chdir',
				'/output',
				launch.executable,
				'-I',
				'-u',
				'-B',
				'/session/worker.py',
				'/output',
			);
		}
		const child = spawn(launch.isolation, args, {
			cwd: directory,
			detached: true,
			stdio: ['pipe', 'pipe', 'pipe'],
			env: {
				HOME: output,
				TMPDIR: scratch,
				LANG: 'en_US.UTF-8',
				PATH: '',
				MPLBACKEND: 'Agg',
				OPENBLAS_NUM_THREADS: '1',
				OMP_NUM_THREADS: '1',
				MKL_NUM_THREADS: '1',
				NUMEXPR_NUM_THREADS: '1',
				VECLIB_MAXIMUM_THREADS: '1',
				BLIS_NUM_THREADS: '1',
			},
		});
		let resolveReady!: (value: Reply) => void;
		let rejectReady!: (error: Error) => void;
		const ready = new Promise<Reply>((resolve, reject) => {
			resolveReady = resolve;
			rejectReady = reject;
		});
		const session: Session = {
			key,
			directory,
			output,
			child,
			ready,
			closed: false,
			busy: false,
			files: new Map(),
		};
		this.workers.add(session);
		const startupAbort = () => this.destroy(session);
		signal?.addEventListener('abort', startupAbort, { once: true });
		if (this.closed || signal?.aborted) this.destroy(session);
		let buffered = '',
			diagnostics = '',
			receivedReady = false;
		const startupTimer = setTimeout(
			() => fail(new Error('The isolated Python interpreter did not start in time.')),
			15000,
		);
		startupTimer.unref();
		const fail = (error: Error) => {
			clearTimeout(startupTimer);
			rejectReady(error);
			session.pending?.reject(error);
			this.destroy(session);
		};
		child.stdout.on('data', (chunk: Buffer) => {
			buffered += chunk.toString('utf8');
			if (buffered.length > OUTPUT_LIMIT) {
				fail(new Error('Python output exceeded its delivery limit. The interpreter was reset.'));
				return;
			}
			for (;;) {
				const newline = buffered.indexOf('\n');
				if (newline < 0) break;
				const line = buffered.slice(0, newline);
				buffered = buffered.slice(newline + 1);
				try {
					const reply = JSON.parse(line) as Reply;
					if (
						!receivedReady &&
						reply.type === 'ready' &&
						typeof reply.python === 'string' &&
						Array.isArray(reply.libraries)
					) {
						receivedReady = true;
						session.metadata = reply;
						clearTimeout(startupTimer);
						resolveReady(reply);
					} else if (reply.type === 'result' && session.pending?.id === reply.id) {
						if (
							![reply.stdout, reply.stderr, reply.result, reply.error].every(
								(value) => typeof value === 'string',
							)
						)
							throw new Error();
						const pending = session.pending!;
						session.pending = undefined;
						pending.resolve(reply);
					} else throw new Error();
				} catch {
					fail(new Error('Python returned an invalid response. The interpreter was reset.'));
					return;
				}
			}
		});
		child.stderr.on('data', (chunk: Buffer) => {
			diagnostics = (diagnostics + chunk.toString('utf8')).slice(-4096);
		});
		child.on('error', (error) => fail(new Error(`Python isolation failed: ${error.message}`)));
		child.on('exit', (code, signal) =>
			fail(new Error(`Python interpreter stopped (${signal || code}). ${diagnostics.trim()}`)),
		);
		try {
			await ready;
			if (this.closed || signal?.aborted || session.closed)
				throw new Error('Python startup cancelled.');
			session.quotaTimer = setInterval(() => {
				if (session.closed || session.checkingQuota) return;
				session.checkingQuota = true;
				void this.checkQuota(session)
					.catch((error) => {
						session.failure = error instanceof Error ? error : new Error(String(error));
						session.pending?.reject(session.failure);
						this.destroy(session);
					})
					.finally(() => {
						session.checkingQuota = false;
					});
			}, this.options.monitorIntervalMs ?? 250);
			session.quotaTimer.unref();
			return session;
		} catch (error) {
			this.destroy(session);
			throw error;
		} finally {
			signal?.removeEventListener('abort', startupAbort);
		}
	}

	private destroy(session: Session) {
		if (session.closed) return;
		session.closed = true;
		this.workers.delete(session);
		clearTimeout(session.idleTimer);
		clearInterval(session.quotaTimer);
		if (this.sessions.get(session.key) === session) this.sessions.delete(session.key);
		session.pending?.reject(new Error('Python interpreter was reset.'));
		session.pending = undefined;
		try {
			if (session.child.pid) process.kill(-session.child.pid, 'SIGKILL');
		} catch {
			session.child.kill('SIGKILL');
		}
		const cleanup = new Promise<void>((resolve) => {
			if (session.child.exitCode !== null || session.child.signalCode !== null) resolve();
			else session.child.once('close', () => resolve());
		})
			.then(() => rm(session.directory, { recursive: true, force: true }))
			.catch(() => undefined);
		this.cleanups.add(cleanup);
		void cleanup.finally(() => this.cleanups.delete(cleanup));
	}
	private touch(session: Session) {
		clearTimeout(session.idleTimer);
		session.idleTimer = setTimeout(
			() => this.destroy(session),
			this.options.idleTimeoutMs ?? 30 * 60 * 1000,
		);
		session.idleTimer.unref();
	}
	private async session(key: string, signal: AbortSignal): Promise<Session> {
		const existing = this.sessions.get(key);
		if (existing && !existing.closed) return existing;
		let startup = this.startups.get(key);
		if (!startup) {
			if (this.sessions.size + this.startups.size >= MAX_SESSIONS)
				throw new Error('Too many Python sessions. Stop an active Chat or wait for idle cleanup.');
			startup = this.create(key, signal);
			this.startups.set(key, startup);
		}
		try {
			const session = await startup;
			this.sessions.set(key, session);
			return session;
		} finally {
			this.startups.delete(key);
		}
	}

	async inspect(signal: AbortSignal): Promise<string> {
		aborted(signal);
		const key = `inspect:${randomUUID()}`;
		const session = await this.create(key, signal);
		try {
			aborted(signal);
			return `Isolated Python ${session.metadata!.python}; ${process.platform === 'darwin' ? 'macOS sandbox' : 'bubblewrap + seccomp'}. ${session.metadata!.libraries!.length ? `Libraries: ${session.metadata!.libraries!.join(', ')}.` : 'Standard library only; scientific plotting libraries are not installed.'}`;
		} finally {
			this.destroy(session);
		}
	}

	async execute(request: ToolHostRequest, signal: AbortSignal): Promise<ToolResult> {
		aborted(signal);
		const { code, timeout_ms } = request.arguments;
		if (typeof code !== 'string' || !code.trim() || code.length > 100000 || code.includes('\0'))
			throw new Error('Provide Python code of at most 100000 characters.');
		if (Object.keys(request.arguments).some((key) => key !== 'code' && key !== 'timeout_ms'))
			throw new Error('Unsupported Python arguments.');
		const timeout = timeout_ms === undefined ? 30000 : timeout_ms;
		if (
			typeof timeout !== 'number' ||
			!Number.isInteger(timeout) ||
			timeout < 100 ||
			timeout > 120000
		)
			throw new Error('Python timeout_ms must be between 100 and 120000.');
		const key = `${request.workspaceId}\0${request.threadId}`;
		const session = await this.session(key, signal);
		if (signal.aborted) this.destroy(session);
		aborted(signal);
		if (session.busy)
			throw new Error(
				'Python is already running in this conversation. Wait for that call to finish.',
			);
		session.busy = true;
		session.activeRun = request.runId;
		clearTimeout(session.idleTimer);
		const cancel = () => this.destroy(session);
		signal.addEventListener('abort', cancel, { once: true });
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const id = randomUUID();
			const reply = await new Promise<Reply>((resolve, reject) => {
				session.pending = { id, resolve, reject };
				timer = setTimeout(() => {
					reject(new Error('Python execution timed out. The interpreter was reset.'));
					this.destroy(session);
				}, timeout);
				session.child.stdin.write(
					JSON.stringify({ id, code, timeout_ms: timeout }) + '\n',
					(error) => {
						if (error) {
							reject(error);
							this.destroy(session);
						}
					},
				);
			});
			clearTimeout(timer);
			aborted(signal);
			if (reply.timed_out) {
				this.destroy(session);
				throw new Error('Python execution timed out. The interpreter was reset.');
			}
			try {
				await this.checkQuota(session);
			} catch (error) {
				this.destroy(session);
				throw error;
			}
			const content: ToolResult['content'] = [
				{
					type: 'text',
					text: [
						`Python ${session.metadata!.python}.`,
						reply.stdout ? `stdout:\n${reply.stdout}` : '',
						reply.stderr ? `stderr:\n${reply.stderr}` : '',
						reply.result ? `Result:\n${reply.result}` : '',
						reply.error ? `Error:\n${reply.error}` : '',
					]
						.filter(Boolean)
						.join('\n\n'),
				},
			];
			content.push(...(await this.artifacts(session, signal)));
			if (session.closed) throw session.failure ?? new Error('Python interpreter was reset.');
			return { content, ...(reply.error ? { isError: true } : {}) };
		} finally {
			clearTimeout(timer);
			signal.removeEventListener('abort', cancel);
			session.busy = false;
			session.activeRun = undefined;
			if (!session.closed) this.touch(session);
		}
	}

	private async checkQuota(session: Session): Promise<void> {
		let bytes = 0,
			entries = 0;
		const maxBytes = this.options.maxSessionBytes ?? 64 * 1024 * 1024;
		const maxEntries = this.options.maxSessionEntries ?? 512;
		const fail = () =>
			new Error(
				'Python session exceeded its storage quota. The interpreter was reset. Keep outputs below 64 MiB and 512 entries across output and scratch directories.',
			);
		const scan = async (directoryPath: string, depth: number): Promise<void> => {
			if (session.closed) return;
			if (depth > 8) throw fail();
			const resolved = await realpath(directoryPath).catch((error: NodeJS.ErrnoException) => {
				if (error.code === 'ENOENT') return '';
				throw error;
			});
			if (!resolved) return;
			if (!resolved.startsWith(`${session.directory}${path.sep}`))
				throw new Error('Python output directory escaped its session. The interpreter was reset.');
			const directory = await opendir(directoryPath).catch((error: NodeJS.ErrnoException) => {
				if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
				throw error;
			});
			if (!directory) return;
			for await (const entry of directory) {
				if (session.closed) return;
				if (++entries > maxEntries) throw fail();
				const filename = path.join(directoryPath, entry.name);
				const information = await lstat(filename).catch((error: NodeJS.ErrnoException) => {
					if (error.code === 'ENOENT') return null;
					throw error;
				});
				if (!information) continue;
				bytes += information.size;
				if (bytes > maxBytes) throw fail();
				if (information.isDirectory()) await scan(filename, depth + 1);
			}
		};
		await scan(session.output, 0);
		await scan(path.join(session.directory, 'scratch'), 0);
	}

	private async artifacts(session: Session, signal: AbortSignal): Promise<ToolResult['content']> {
		if ((await realpath(session.output)) !== session.output)
			throw new Error('Python output directory changed unexpectedly.');
		const content: ToolResult['content'] = [];
		let bytes = 0,
			files = 0,
			omitted = false;
		const directory = await opendir(session.output);
		let inspected = 0;
		for await (const entry of directory) {
			aborted(signal);
			if (++inspected > 256) {
				omitted = true;
				break;
			}
			if (!entry.isFile() || entry.name.startsWith('.') || entry.name.length > 240) continue;
			const filename = path.join(session.output, entry.name);
			const fd = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
			if (!fd) continue;
			try {
				const info = await fd.stat();
				if (
					!info.isFile() ||
					info.size > ARTIFACT_LIMIT ||
					bytes + info.size > ARTIFACT_LIMIT ||
					files >= 8
				) {
					omitted = true;
					continue;
				}
				const body = Buffer.alloc(info.size);
				let offset = 0;
				while (offset < body.length) {
					const read = await fd.read(body, offset, body.length - offset, offset);
					if (!read.bytesRead) break;
					offset += read.bytesRead;
				}
				if (offset !== body.length) continue;
				const fingerprint = createHash('sha256').update(body).digest('hex');
				if (session.files.get(entry.name) === fingerprint) continue;
				session.files.set(entry.name, fingerprint);
				bytes += body.length;
				files++;
				const mimeType = MIME[path.extname(entry.name).toLowerCase()] ?? 'application/octet-stream';
				const dataUrl = `data:${mimeType};base64,${body.toString('base64')}`;
				// Original bytes are downloads only. Pixel results always pass through
				// dimension validation and the bounded decoder worker before reaching
				// the renderer/model, including files with misleading extensions.
				content.push({ type: 'file', dataUrl, name: entry.name, mimeType });
				if (['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) {
					try {
						const image = await decodeWebImage(body, mimeType, signal);
						content.push({
							type: 'image',
							dataUrl: image.dataUrl,
							name: `${path.parse(entry.name).name}-preview.jpg`,
						});
					} catch (error) {
						aborted(signal);
						const detail = (
							error instanceof Error ? error.message : 'Image decoding failed.'
						).slice(0, 240);
						content.push({
							type: 'text',
							text: `${entry.name} is available for download; no inline preview was produced. ${detail}`,
						});
					}
				} else if (mimeType.startsWith('image/'))
					content.push({
						type: 'text',
						text: `${entry.name} is available for download. Inline previews support PNG, JPEG, and WebP only.`,
					});
			} finally {
				await fd.close();
			}
		}
		if (omitted)
			content.push({
				type: 'text',
				text: 'Some output files were omitted. Each call returns up to 8 files and 8 MiB total. Save smaller files in the current directory.',
			});
		return content;
	}

	cancel(runId: string) {
		for (const session of this.sessions.values())
			if (session.activeRun === runId) this.destroy(session);
	}
	async close() {
		this.closed = true;
		for (const session of this.workers) this.destroy(session);
		for (const startup of this.startups.values()) {
			const session = await startup.catch(() => undefined);
			if (session) this.destroy(session);
		}
		await Promise.all([...this.cleanups]);
	}
}
