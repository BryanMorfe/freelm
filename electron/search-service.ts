import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, mkdir, open, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import type { SearchServiceStatus, WebServiceInfo } from '../src/agent-types';

export interface SearchServiceOptions {
	/** All paths come from the desktop host, never from a renderer or a model. */
	searchHome: string;
	bundleRoot: string;
	executablePath: string;
	launcherPath: string;
	startupTimeoutMs?: number;
	pollIntervalMs?: number;
	stopTimeoutMs?: number;
	/** Test fixture may deliberately create a port conflict. Production always uses an ephemeral port. */
	allocatePort?: () => Promise<number>;
}

const LOG_LIMIT = 128 * 1024;
const EXCERPT_LIMIT = 8192;
const CONFIG_LIMIT = 2 * 1024 * 1024;

function message(error: unknown): string {
	return redact(error instanceof Error ? error.message : String(error)).slice(0, 1000);
}

function redact(value: string): string {
	return value
		.replace(/\u001b\[[0-9;]*m/g, '')
		.replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/gi, '$1[redacted]')
		.replace(/((?:api[_-]?key|password|secret|token)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
		.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
		.replace(/([?&](?:q|query|key|token|api_key|password)=)[^\s&#]+/gi, '$1[redacted]');
}

function selectedEngines(input: string[]): string[] {
	if (!Array.isArray(input) || !input.length || input.length > 100)
		throw new Error('Select between 1 and 100 search engines before starting search.');
	const values = input.map((value) => {
		if (
			typeof value !== 'string' ||
			!value.trim() ||
			value.length > 160 ||
			/[\u0000-\u001f]/.test(value)
		)
			throw new Error('A selected search engine has an invalid name.');
		return value.trim();
	});
	return [...new Set(values)].sort();
}

async function freePort(): Promise<number> {
	const server = createServer();
	try {
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen({ port: 0, host: '127.0.0.1', exclusive: true }, resolve);
		});
		return (server.address() as { port: number }).port;
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) throw new Error('Search startup cancelled.');
	await new Promise<void>((resolve, reject) => {
		const abort = () => {
			clearTimeout(timer);
			signal.removeEventListener('abort', abort);
			reject(new Error('Search startup cancelled.'));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', abort);
			resolve();
		}, ms);
		signal.addEventListener('abort', abort, { once: true });
	});
}

async function boundedBody(response: Response, limit: number): Promise<string> {
	if (!response.body) return '';
	const reader = response.body.getReader();
	const buffers: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > limit) throw new Error('The bundled search service response is too large.');
			buffers.push(value);
		}
		return Buffer.concat(buffers).toString('utf8');
	} finally {
		await reader.cancel().catch(() => undefined);
	}
}

function parseConfig(value: unknown): { version?: string; engines: WebServiceInfo['engines'] } {
	if (!value || typeof value !== 'object')
		throw new Error('Search engine discovery returned an invalid configuration.');
	const config = value as { version?: unknown; engines?: unknown };
	if (!Array.isArray(config.engines) || !config.engines.length || config.engines.length > 512)
		throw new Error('Search engine discovery returned an invalid engine list.');
	const engines: WebServiceInfo['engines'] = [];
	for (const raw of config.engines) {
		if (!raw || typeof raw !== 'object')
			throw new Error('Search engine discovery returned an invalid engine.');
		const engine = raw as Record<string, unknown>;
		if (typeof engine.name !== 'string' || !engine.name.trim() || engine.name.length > 160)
			throw new Error('Search engine discovery returned an invalid engine name.');
		engines.push({
			name: engine.name,
			enabled: engine.enabled === true,
			categories: Array.isArray(engine.categories)
				? engine.categories
						.filter((item): item is string => typeof item === 'string' && item.length <= 100)
						.slice(0, 64)
				: [],
			paging: engine.paging === true,
			timeRangeSupport: engine.time_range_support === true,
			safeSearch: engine.safesearch === true,
		});
	}
	if (new Set(engines.map((engine) => engine.name)).size !== engines.length)
		throw new Error('Search engine discovery returned duplicate engines.');
	return {
		...(typeof config.version === 'string' ? { version: config.version.slice(0, 160) } : {}),
		engines,
	};
}

/** Owns only the bundled helper; never starts a system interpreter or connects to external services. */
export class SearchServiceManager {
	readonly ready: Promise<void>;
	private state: SearchServiceStatus = { phase: 'stopped', engines: [], selectedEngineNames: [] };
	private catalogue: WebServiceInfo['engines'] = [];
	private listeners = new Set<(status: SearchServiceStatus) => void>();
	private child?: ChildProcessWithoutNullStreams;
	private childEnded?: Promise<void>;
	private startup?: AbortController;
	private startPromise?: Promise<SearchServiceStatus>;
	private stopPromise?: Promise<SearchServiceStatus>;
	private closed = false;
	private stopVersion = 0;
	private log = '';
	private pendingLine = '';
	private logTimer?: ReturnType<typeof setTimeout>;
	private logWrite: Promise<void> = Promise.resolve();
	private canWriteLog = false;

	constructor(private readonly options: SearchServiceOptions) {
		if (
			![options.searchHome, options.bundleRoot, options.executablePath, options.launcherPath].every(
				path.isAbsolute,
			)
		)
			throw new Error('Bundled search paths must be absolute.');
		this.ready = this.initialize();
	}

	private async initialize() {
		try {
			await this.paths();
			const filename = path.join(this.options.bundleRoot, 'engines.json');
			const file = await open(filename, 'r');
			let text: string;
			try {
				if ((await file.stat()).size > CONFIG_LIMIT)
					throw new Error('The bundled search catalogue is too large.');
				text = await file.readFile('utf8');
			} finally {
				await file.close();
			}
			const config = parseConfig(JSON.parse(text));
			this.catalogue = config.engines;
			this.setState({ ...this.state, ...config });
		} catch (error) {
			this.setState({ ...this.state, phase: 'unavailable', message: message(error) });
		}
	}

	onStatus(listener: (status: SearchServiceStatus) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emitStatus() {
		for (const listener of this.listeners) {
			try {
				listener(this.status());
			} catch {
				/* A UI subscriber cannot break the helper lifecycle. */
			}
		}
	}

	private setState(state: SearchServiceStatus) {
		this.state = state;
		this.emitStatus();
	}

	status(): SearchServiceStatus {
		return {
			...this.state,
			engines: this.state.engines.map((engine) => ({
				...engine,
				categories: [...engine.categories],
			})),
			selectedEngineNames: [...this.state.selectedEngineNames],
			...(this.log ? { logExcerpt: this.log.slice(-EXCERPT_LIMIT) } : {}),
		};
	}

	async inspect(): Promise<SearchServiceStatus> {
		await this.ready;
		if (this.state.phase !== 'stopped' && this.state.phase !== 'unavailable') return this.status();
		if (!this.catalogue.length) return this.status();
		try {
			await this.paths();
			this.setState({ ...this.state, phase: 'stopped', message: undefined });
		} catch (error) {
			this.setState({ ...this.state, phase: 'unavailable', message: message(error) });
		}
		return this.status();
	}

	private async paths() {
		const root = await realpath(this.options.bundleRoot).catch(() => {
			throw new Error('This FreeLM installation does not include its bundled search runtime.');
		});
		const resolve = async (filename: string, executable = false) => {
			const resolved = await realpath(filename).catch(() => {
				throw new Error(
					'The bundled search runtime is incomplete. Reinstall FreeLM to restore search.',
				);
			});
			const relative = path.relative(root, resolved);
			if (
				!relative ||
				relative.startsWith(`..${path.sep}`) ||
				relative === '..' ||
				path.isAbsolute(relative)
			)
				throw new Error('The search launcher must belong to the trusted FreeLM bundle.');
			if (!(await stat(resolved)).isFile())
				throw new Error('The bundled search launcher is not a file.');
			if (executable) await access(resolved, constants.X_OK);
			return resolved;
		};
		return {
			executable: await resolve(this.options.executablePath, true),
			launcher: await resolve(this.options.launcherPath),
		};
	}

	async start(engines: string[] = []): Promise<SearchServiceStatus> {
		const stopVersion = this.stopVersion;
		await this.ready;
		if (this.closed) throw new Error('FreeLM is shutting down.');
		if (stopVersion !== this.stopVersion) return this.status();
		if (!this.catalogue.length) return this.status();
		const selected = selectedEngines(engines);
		if (
			this.catalogue.length &&
			selected.some((name) => !this.catalogue.some((engine) => engine.name === name))
		)
			throw new Error('A selected engine is unavailable in this bundled search runtime.');
		if (this.stopPromise) await this.stopPromise;
		if (this.state.phase === 'running') {
			if (JSON.stringify(selected) !== JSON.stringify(this.state.selectedEngineNames))
				return this.restart(selected);
			return this.status();
		}
		if (this.startPromise) return this.startPromise;
		const controller = new AbortController();
		this.startup = controller;
		this.setState({
			...this.state,
			phase: 'starting',
			url: undefined,
			message: undefined,
			selectedEngineNames: selected,
		});
		const promise = this.launch(selected, controller);
		this.startPromise = promise;
		try {
			return await promise;
		} finally {
			if (this.startPromise === promise) this.startPromise = undefined;
			if (this.startup === controller) this.startup = undefined;
		}
	}

	private async launch(
		engines: string[],
		controller: AbortController,
	): Promise<SearchServiceStatus> {
		const timer = setTimeout(
			() => controller.abort('timeout'),
			this.options.startupTimeoutMs ?? 45_000,
		);
		let stage: 'bundle' | 'storage' | 'launch' = 'bundle';
		try {
			const { executable, launcher } = await this.paths();
			stage = 'storage';
			await mkdir(this.options.searchHome, { recursive: true, mode: 0o700 });
			await this.readLog();
			await this.saveLog();
			this.canWriteLog = true;
			if (controller.signal.aborted || this.closed) throw new Error('Search startup cancelled.');
			stage = 'launch';
			const port = await (this.options.allocatePort ?? freePort)();
			if (!Number.isInteger(port) || port <= 0 || port > 65535)
				throw new Error('Could not allocate a local search port.');
			if (controller.signal.aborted || this.closed) throw new Error('Search startup cancelled.');
			const instance = randomBytes(24).toString('hex');
			const child = spawn(
				executable,
				[
					'-I',
					'-B',
					launcher,
					'--config-dir',
					this.options.searchHome,
					'--port',
					String(port),
					'--engines-json',
					JSON.stringify(engines),
				],
				{
					cwd: this.options.searchHome,
					detached: process.platform !== 'win32',
					stdio: ['pipe', 'pipe', 'pipe'],
					env: {
						PATH: path.dirname(executable),
						LANG: process.env.LANG || 'en_US.UTF-8',
						...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
						FREELM_SEARCH_INSTANCE_ID: instance,
						FREELM_SEARCH_PARENT_PID: String(process.pid),
					},
				},
			);
			this.child = child;
			child.stdin.end();
			let exitError: Error | undefined;
			this.childEnded = new Promise<void>((resolve) => {
				child.once('error', (error) => {
					exitError = error;
					resolve();
				});
				child.once('exit', (code, signal) => {
					exitError = new Error(
						`Bundled search stopped${signal ? ` (${signal})` : ` (exit ${code ?? 'unknown'})`}.`,
					);
					if (this.child === child && this.state.phase === 'running') {
						this.setState({
							...this.state,
							phase: 'error',
							url: undefined,
							message: message(exitError),
						});
						this.child = undefined;
					}
					resolve();
				});
			});
			child.stdout.on('data', (data: Buffer) => this.appendLog(data.toString('utf8')));
			child.stderr.on('data', (data: Buffer) => this.appendLog(data.toString('utf8')));
			const url = `http://127.0.0.1:${port}`;
			for (;;) {
				if (exitError) throw exitError;
				if (controller.signal.aborted || this.closed) throw new Error('Search startup cancelled.');
				try {
					const requestSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(1500)]);
					const health = await fetch(`${url}/healthz`, {
						signal: requestSignal,
						redirect: 'error',
					});
					const text = await boundedBody(health, 128);
					if (
						health.ok &&
						/text\/plain/i.test(health.headers.get('content-type') || '') &&
						text.trim() === 'OK'
					) {
						if (health.headers.get('x-freelm-search-instance') !== instance)
							throw new Error(
								'Another process occupied the local search port. Start search again.',
							);
						const response = await fetch(`${url}/config`, {
							signal: requestSignal,
							redirect: 'error',
						});
						if (
							!response.ok ||
							!/application\/json/i.test(response.headers.get('content-type') || '')
						)
							throw new Error('Search engine discovery is not ready.');
						const config = parseConfig(JSON.parse(await boundedBody(response, CONFIG_LIMIT)));
						if (exitError || controller.signal.aborted || this.closed)
							throw new Error('Search startup cancelled.');
						const active = new Map(config.engines.map((engine) => [engine.name, engine]));
						const allEngines = this.catalogue.map(
							(engine) => active.get(engine.name) ?? { ...engine, enabled: false },
						);
						for (const engine of config.engines)
							if (!allEngines.some((item) => item.name === engine.name)) allEngines.push(engine);
						this.setState({
							...this.state,
							phase: 'running',
							url,
							...config,
							engines: allEngines,
							message: undefined,
						});
						return this.status();
					}
				} catch (error) {
					if (message(error).startsWith('Another process occupied')) throw error;
				}
				await delay(this.options.pollIntervalMs ?? 200, controller.signal);
			}
		} catch (error) {
			await this.terminate();
			const cancelled = controller.signal.aborted && controller.signal.reason !== 'timeout';
			this.setState({
				...this.state,
				phase: cancelled || this.closed ? 'stopped' : stage === 'bundle' ? 'unavailable' : 'error',
				url: undefined,
				message:
					cancelled || this.closed
						? undefined
						: controller.signal.reason === 'timeout'
							? 'Bundled search did not become ready before the startup deadline. Check its log and try again.'
							: stage === 'storage'
								? `Could not write the search configuration directory: ${message(error)}`
								: message(error),
			});
			return this.status();
		} finally {
			clearTimeout(timer);
			this.finishLogLine();
			await this.flushLog();
		}
	}

	async restart(engines: string[] = this.state.selectedEngineNames): Promise<SearchServiceStatus> {
		const selected = selectedEngines(engines);
		const stopVersion = this.stopVersion;
		await this.stop();
		// A newer Stop (including a saved disable/external change) wins over the
		// restart while its previous helper is shutting down.
		if (this.closed || this.stopVersion !== stopVersion + 1) return this.status();
		return this.start(selected);
	}

	async stop(): Promise<SearchServiceStatus> {
		this.stopVersion++;
		if (this.stopPromise) return this.stopPromise;
		if (this.state.phase === 'unavailable' && !this.startPromise && !this.child)
			return this.status();
		this.startup?.abort('stopped');
		this.setState({ ...this.state, phase: 'stopping', url: undefined, message: undefined });
		const promise = (async () => {
			await this.startPromise;
			await this.terminate();
			this.finishLogLine();
			await this.flushLog();
			this.setState({ ...this.state, phase: 'stopped', url: undefined, message: undefined });
			return this.status();
		})();
		this.stopPromise = promise;
		try {
			return await promise;
		} finally {
			if (this.stopPromise === promise) this.stopPromise = undefined;
		}
	}

	private async terminate() {
		const child = this.child;
		if (!child) return;
		const kill = (signal: NodeJS.Signals) => {
			if (!child.pid) return;
			try {
				if (process.platform !== 'win32') process.kill(-child.pid, signal);
				else child.kill(signal);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
					this.appendLog(`${message(error)}\n`);
			}
		};
		kill('SIGTERM');
		let timer: ReturnType<typeof setTimeout> | undefined;
		const ended = await Promise.race([
			this.childEnded!.then(() => true),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), this.options.stopTimeoutMs ?? 2000);
			}),
		]);
		if (timer) clearTimeout(timer);
		if (!ended) {
			kill('SIGKILL');
			await this.childEnded;
		}
		if (this.child === child) this.child = undefined;
		this.childEnded = undefined;
	}

	private appendLog(value: string) {
		this.pendingLine += value;
		while (this.pendingLine.includes('\n') || this.pendingLine.length > EXCERPT_LIMIT) {
			const newline = this.pendingLine.indexOf('\n');
			const length = newline >= 0 ? newline + 1 : EXCERPT_LIMIT;
			this.log = (this.log + redact(this.pendingLine.slice(0, length))).slice(-LOG_LIMIT / 4);
			this.pendingLine = this.pendingLine.slice(length);
		}
		if (this.canWriteLog && !this.logTimer)
			this.logTimer = setTimeout(() => {
				this.logTimer = undefined;
				void this.flushLog();
			}, 500);
	}

	private finishLogLine() {
		if (this.pendingLine) {
			this.log = (this.log + redact(this.pendingLine)).slice(-LOG_LIMIT / 4);
			this.pendingLine = '';
		}
	}

	private async readLog() {
		const file = await open(path.join(this.options.searchHome, 'service.log'), 'r').catch(
			(error: NodeJS.ErrnoException) => {
				if (error.code === 'ENOENT') return undefined;
				throw error;
			},
		);
		if (!file) return;
		try {
			const size = (await file.stat()).size;
			const buffer = Buffer.alloc(Math.min(size, LOG_LIMIT / 4));
			await file.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
			this.log = redact(buffer.toString('utf8'));
		} finally {
			await file.close();
		}
	}

	private async saveLog() {
		const filename = path.join(this.options.searchHome, 'service.log');
		const temporary = `${filename}.${randomBytes(8).toString('hex')}.tmp`;
		try {
			await writeFile(temporary, this.log, { flag: 'wx', mode: 0o600 });
			await rename(temporary, filename);
		} finally {
			await rm(temporary, { force: true }).catch(() => undefined);
		}
	}

	private async flushLog() {
		if (this.logTimer) clearTimeout(this.logTimer);
		this.logTimer = undefined;
		if (!this.canWriteLog) return;
		this.logWrite = this.logWrite
			.then(() => this.saveLog())
			.catch((error) => {
				this.canWriteLog = false;
				this.setState({
					...this.state,
					message: `The search log could not be saved: ${message(error)}`,
				});
			});
		await this.logWrite;
		this.emitStatus();
	}

	async close(): Promise<void> {
		this.closed = true;
		await this.stop();
		this.listeners.clear();
	}
}
