import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type {
	ComputerAction,
	ComputerApp,
	ComputerObservation,
	ComputerStatus,
} from '../src/computer-types';
import type { ComputerAdapter } from './tools/computer';
import { createLinuxComputerAdapter } from './computer-linux';

export interface ComputerCursorEvent {
	appId: string;
	x: number;
	y: number;
	visible: boolean;
	animate?: boolean;
}
export interface ComputerAdapterOptions {
	helperPath?: string;
	onCursor?: (event: ComputerCursorEvent) => void;
}
interface Pending {
	id: string;
	appId?: string;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	cleanup: () => void;
}
const MAX_RESPONSE_BYTES = 4_000_000;
const abortError = () => new Error('Computer Use was stopped. No further input will be sent.');
export function computerHelperPath() {
	const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
	const packaged = resources && path.join(resources, 'computer', 'freelm-computer');
	if (packaged && existsSync(packaged)) return packaged;
	return path.resolve(__dirname, '../resources/computer/freelm-computer');
}

/** One bounded request at a time; cancellation kills the native queue itself. */
export class NativeComputerAdapter implements ComputerAdapter {
	private child?: ChildProcessWithoutNullStreams;
	private pending?: Pending;
	private tail: Promise<unknown> = Promise.resolve();
	private cursor?: ComputerCursorEvent;
	private generation = 0;
	private refreshPermissionProbe = false;
	constructor(private options: ComputerAdapterOptions = {}) {}

	private hideCursor() {
		if (this.cursor) this.options.onCursor?.({ ...this.cursor, visible: false });
		this.cursor = undefined;
	}
	private terminateChild() {
		const child = this.child;
		this.child = undefined;
		this.hideCursor();
		// The helper's SIGTERM handler releases a held drag before exiting. A hard
		// deadline still kills a hung helper and prevents queued input afterward.
		if (child && !child.killed) {
			child.kill('SIGTERM');
			const hardStop = setTimeout(() => {
				if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
			}, 150);
			hardStop.unref();
			child.once('exit', () => clearTimeout(hardStop));
		}
	}
	private stop(error: Error) {
		this.generation += 1;
		const pending = this.pending;
		this.pending = undefined;
		pending?.cleanup();
		pending?.reject(error);
		this.terminateChild();
	}
	private start() {
		if (this.child) return this.child;
		const executable = this.options.helperPath ?? computerHelperPath();
		if (!existsSync(executable))
			throw new Error('Computer Use helper is missing. Rebuild or reinstall FreeLM.');
		const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
		this.child = child;
		const decoder = new StringDecoder('utf8');
		let buffer = '',
			bytes = 0,
			diagnostics = '';
		child.stderr.on('data', (chunk: Buffer) => {
			diagnostics = (diagnostics + chunk.toString('utf8')).slice(-1500);
		});
		child.stdout.on('data', (chunk: Buffer) => {
			if (this.child !== child) return;
			bytes += chunk.length;
			if (bytes > MAX_RESPONSE_BYTES) {
				this.stop(new Error('Computer Use helper exceeded its response limit.'));
				return;
			}
			buffer += decoder.write(chunk);
			let newline: number;
			while ((newline = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				bytes = Buffer.byteLength(buffer, 'utf8');
				if (!line) continue;
				let data: Record<string, unknown>;
				try {
					data = JSON.parse(line);
				} catch {
					this.stop(new Error('Computer Use helper returned invalid data.'));
					return;
				}
				if (!data || typeof data !== 'object' || Array.isArray(data)) {
					this.stop(new Error('Computer Use helper returned invalid data.'));
					return;
				}
				if (data.event === 'cursor') {
					if (
						typeof data.appId !== 'string' ||
						typeof data.x !== 'number' ||
						!Number.isFinite(data.x) ||
						typeof data.y !== 'number' ||
						!Number.isFinite(data.y) ||
						typeof data.visible !== 'boolean'
					)
						continue;
					// Movement must belong to the current approved request. A native
					// focus-loss notification can hide its existing marker while idle.
					if (data.visible ? data.appId !== this.pending?.appId : data.appId !== this.cursor?.appId)
						continue;
					const cursor = {
						appId: data.appId,
						x: data.x,
						y: data.y,
						visible: data.visible,
						...(typeof data.animate === 'boolean' ? { animate: data.animate } : {}),
					};
					this.cursor = data.visible ? cursor : undefined;
					this.options.onCursor?.(cursor);
					continue;
				}
				const pending = this.pending;
				if (!pending || data.id !== pending.id) {
					this.stop(new Error('Computer Use helper response did not match the active request.'));
					return;
				}
				this.pending = undefined;
				pending.cleanup();
				if (typeof data.error === 'string') {
					this.hideCursor();
					pending.reject(new Error(data.error.slice(0, 2000)));
				} else pending.resolve(data.result);
			}
		});
		child.on('error', (error) => {
			if (this.child === child)
				this.stop(new Error(`Computer Use helper could not start: ${error.message}`));
		});
		child.on('exit', () => {
			if (this.child === child)
				this.stop(
					new Error(
						`Computer Use helper stopped unexpectedly.${diagnostics ? ` ${diagnostics}` : ''}`,
					),
				);
		});
		return child;
	}
	private request<T>(
		method: string,
		parameters: Record<string, unknown> = {},
		signal?: AbortSignal,
	): Promise<T> {
		const generation = this.generation;
		const execute = () =>
			new Promise<T>((resolve, reject) => {
				if (generation !== this.generation || signal?.aborted) {
					reject(abortError());
					return;
				}
				// Only executes after preceding requests settle; a settings probe never
				// terminates an active capture/action. A fresh process drops cached TCC denial.
				if (method === 'status' && this.refreshPermissionProbe) this.terminateChild();
				let child: ChildProcessWithoutNullStreams;
				try {
					child = this.start();
				} catch (error) {
					reject(error);
					return;
				}
				const id = randomUUID();
				const abort = () => this.stop(abortError());
				const timer = setTimeout(
					() =>
						this.stop(
							new Error('Computer Use timed out. No action was retried; observe the app again.'),
						),
					30_000,
				);
				const cleanup = () => {
					clearTimeout(timer);
					signal?.removeEventListener('abort', abort);
				};
				this.pending = {
					id,
					appId: typeof parameters.appId === 'string' ? parameters.appId : undefined,
					resolve: (value) => resolve(value as T),
					reject,
					cleanup,
				};
				signal?.addEventListener('abort', abort, { once: true });
				child.stdin.write(JSON.stringify({ id, method, ...parameters }) + '\n', (error) => {
					if (error && this.child === child) this.stop(error);
				});
			});
		const promise = this.tail.then(execute, execute);
		this.tail = promise.catch(() => {});
		return promise;
	}
	async status(signal?: AbortSignal): Promise<ComputerStatus> {
		try {
			const status = await this.request<ComputerStatus>('status', {}, signal);
			this.refreshPermissionProbe = !status.accessibility || !status.screenRecording;
			return status;
		} catch (error) {
			if (signal?.aborted) throw error;
			return {
				available: false,
				platform: 'darwin',
				accessibility: false,
				screenRecording: false,
				message: error instanceof Error ? error.message : String(error),
			};
		}
	}
	requestPermissions(): Promise<ComputerStatus> {
		return this.request('request_permissions');
	}
	apps(query: string, signal?: AbortSignal): Promise<ComputerApp[]> {
		return this.request('apps', { query: query.slice(0, 200) }, signal);
	}
	open(appId: string, signal?: AbortSignal): Promise<void> {
		if (this.cursor && this.cursor.appId !== appId) this.hideCursor();
		return this.request('open', { appId }, signal);
	}
	snapshot(appId: string, signal?: AbortSignal): Promise<ComputerObservation> {
		return this.request('snapshot', { appId }, signal);
	}
	act(appId: string, frameId: string, action: ComputerAction, signal?: AbortSignal): Promise<void> {
		return this.request('act', { appId, frameId, action }, signal);
	}
	close() {
		this.stop(abortError());
	}
}

export function createComputerAdapter(options: ComputerAdapterOptions = {}): ComputerAdapter {
	if (process.platform === 'darwin') return new NativeComputerAdapter(options);
	if (process.platform === 'linux')
		return createLinuxComputerAdapter({ onCursor: options.onCursor });
	const message = 'Computer Use is available on supported macOS and Linux desktop sessions.';
	return {
		async status() {
			return {
				available: false,
				platform: process.platform,
				accessibility: false,
				screenRecording: false,
				message,
			};
		},
		async apps() {
			return [];
		},
		async open() {
			throw new Error(message);
		},
		async snapshot() {
			throw new Error(message);
		},
		async act() {
			throw new Error(message);
		},
		close() {},
	};
}

/** Only call in response to the user's explicit Settings permission-setup click. */
export async function requestComputerPermissions(): Promise<ComputerStatus> {
	const adapter = new NativeComputerAdapter();
	try {
		if (process.platform !== 'darwin')
			return {
				available: false,
				platform: process.platform,
				accessibility: false,
				screenRecording: false,
				message: 'Configure desktop capture/input permissions using your Linux desktop session.',
			};
		return await adapter.requestPermissions();
	} finally {
		adapter.close();
	}
}
