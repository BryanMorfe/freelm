import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { PluginHostCall } from './runtime';
import { SURFACE_HOST_METHODS } from './surface-runtime-bridge';
import { REQUEST_TIMEOUT_MS } from '../request-policy';

export interface PluginSurfaceRuntime {
	event(name: string, payload: unknown): void;
	command(id: string, payload: unknown): void;
	dispose(): void;
}
export interface PluginSurfaceRuntimeInput {
	code: string;
	context: object;
	signal: AbortSignal;
	onError?(error: Error): void;
	/** Test injection; production loads the unpacked adjacent worker. */
	workerPath?: string;
	cpuBudgetMs?: number;
	startupTimeoutMs?: number;
	hostCallTimeoutMs?: number;
}
const JSON_LIMIT = 1024 * 1024;
let active = 0;
function json(value: unknown): string {
	const encoded = JSON.stringify(value);
	if (encoded === undefined || Buffer.byteLength(encoded) > JSON_LIMIT) throw new Error('Plugin JSON payload exceeds 1 MiB or is not serializable.');
	return encoded;
}
function defaultWorkerPath(): string {
	const directory = typeof __dirname === 'string' ? __dirname : path.join(process.cwd(), 'dist-electron');
	return path.join(directory.replace(/\.asar(?=[\\/])/g, '.asar.unpacked'), 'plugin-surface-runtime-worker.cjs');
}

/** A persistent, isolated activation. Its idle lifetime is tied to the visible surface, not a tool timeout. */
export async function startPluginSurfaceRuntime(input: PluginSurfaceRuntimeInput, callHost: PluginHostCall): Promise<PluginSurfaceRuntime> {
	input.signal.throwIfAborted();
	if (active >= 8) throw new Error('Too many active plugin surfaces.');
	if (typeof input.code !== 'string' || Buffer.byteLength(input.code) > 4 * JSON_LIMIT) throw new Error('Invalid plugin surface code.');
	const binding = JSON.parse(json(input.context));
	active++;
	return new Promise((resolve, reject) => {
		let finished = false, ready = false, worker: Worker | undefined, nextEvent = 0, inFlight = 0;
		let released = false;
		const release = () => { if (!released) { released = true; active--; } };
		let intervalStart = Date.now(), calls = 0, replyBytes = 0;
		const pending = new Map<number, { operationId: string; controller: AbortController; cancel(): void }>();
		const queue: { kind: 'event' | 'command'; name: string; json: string; id: number }[] = [];
		const parentController = new AbortController();
		let startupTimer: NodeJS.Timeout | undefined;
		function finish(error?: Error) {
			if (finished) return;
			finished = true;
			clearTimeout(startupTimer);
			input.signal.removeEventListener('abort', abort);
			parentController.abort();
			for (const request of pending.values()) request.cancel();
			pending.clear(); queue.length = 0;
			if (worker) {
				worker.postMessage({ kind: 'dispose' });
				const termination = setTimeout(() => void worker?.terminate(), 100);
				termination.unref();
			} else release();
			if (!ready) reject(error ?? new Error('Plugin surface activation was cancelled.'));
			else if (error) { try { input.onError?.(error); } catch { /* Host diagnostics cannot crash the application. */ } }
		}
		const abort = () => finish();
		function flush() {
			if (finished || inFlight || !queue.length) return;
			const message = queue.shift()!; inFlight = message.id; worker!.postMessage(message);
		}
		function enqueue(kind: 'event' | 'command', name: string, payload: unknown) {
			if (finished) return;
			if (!/^[a-zA-Z][a-zA-Z0-9_.:-]{0,159}$/.test(name)) throw new Error('Invalid plugin event or command name.');
			const encoded = json(payload);
			if (kind === 'event' && ['composer.changed', 'composer.stateChanged', 'composer.selectionChanged', 'conversation.changed'].includes(name)) {
				let old = -1;
				for (let index = queue.length - 1; index >= 0; index--) if (queue[index].kind === 'event' && queue[index].name === name) { old = index; break; }
				if (old >= 0) queue.splice(old, 1);
			}
			if (queue.length >= 64) { finish(new Error('Plugin event queue limit exceeded.')); return; }
			queue.push({ kind, name, json: encoded, id: ++nextEvent }); flush();
		}
		input.signal.addEventListener('abort', abort, { once: true });
		startupTimer = setTimeout(() => finish(new Error('Plugin surface activation timed out.')), Math.max(10, Math.min(input.startupTimeoutMs ?? 300_000, 900_000)));
		try {
			worker = new Worker(input.workerPath ?? defaultWorkerPath(), {
				env: {},
				workerData: { code: input.code, context: binding, cpuBudgetMs: Math.max(1, Math.min(input.cpuBudgetMs ?? 200, 1000)), jsonLimit: JSON_LIMIT },
				resourceLimits: { maxOldGenerationSizeMb: 96, stackSizeMb: 2 },
			});
		} catch (error) { finish(error instanceof Error ? error : new Error('Could not start plugin interpreter.')); return; }
		worker.on('error', error => finish(error));
		worker.on('exit', code => { release(); if (!finished) finish(new Error(`Plugin interpreter exited (${code}).`)); });
		worker.on('message', (message: { kind: string; id?: number; method?: string; json?: string; error?: string; operationId?: string }) => {
			if (message.kind === 'disposed') { void worker?.terminate(); return; }
			if (finished) return;
			if (message.kind === 'error') { finish(new Error(String(message.error || 'Plugin activation failed.').slice(0, 4000))); return; }
			if (message.kind === 'ready') {
				if (ready) { finish(new Error('Plugin activation protocol violated.')); return; }
				ready = true; clearTimeout(startupTimer);
				resolve({ event: (name, payload) => enqueue('event', name, payload), command: (id, payload) => enqueue('command', id, payload), dispose: () => finish() });
				return;
			}
			if (message.kind === 'ack') { if (message.id === inFlight) { inFlight = 0; flush(); } return; }
			if (message.kind === 'cancel') {
				for (const request of pending.values()) if (request.operationId === message.operationId) request.cancel();
				return;
			}
			if (Date.now() - intervalStart >= 10_000) { intervalStart = Date.now(); calls = 0; replyBytes = 0; }
			if (message.kind !== 'call' || !Number.isSafeInteger(message.id) || !SURFACE_HOST_METHODS.has(message.method ?? '') || typeof message.json !== 'string' || Buffer.byteLength(message.json) > JSON_LIMIT || typeof message.operationId !== 'string' || message.operationId.length > 80 || pending.has(message.id!) || pending.size >= 32 || ++calls > 256) {
				finish(new Error('Plugin host-call limit or contract was violated.')); return;
			}
			let args: Record<string, unknown>;
			try { args = JSON.parse(message.json); if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error(); }
			catch { finish(new Error('Invalid plugin host-call arguments.')); return; }
			const id = message.id!, controller = new AbortController();
			const signal = AbortSignal.any([controller.signal, parentController.signal, input.signal]);
			let settled = false, timer: NodeJS.Timeout;
			function settle(error?: unknown, result?: unknown) {
				if (settled) return;
				settled = true; clearTimeout(timer); pending.delete(id);
				if (finished) return;
				try {
					if (error) throw error;
					const serialized = json(result ?? null);
					replyBytes += Buffer.byteLength(serialized);
					if (replyBytes > 8 * JSON_LIMIT) throw new Error('Plugin host replies exceeded 8 MiB in ten seconds.');
					worker!.postMessage({ kind: 'result', id, json: serialized });
				} catch (caught) { worker!.postMessage({ kind: 'result', id, error: String(caught instanceof Error ? caught.message : caught).slice(0, 4000) }); }
			}
			const cancel = () => { controller.abort(); settle(new Error('Plugin operation was cancelled.')); };
			pending.set(id, { operationId: message.operationId, controller, cancel });
			timer = setTimeout(() => { controller.abort(); settle(new Error('Plugin host operation timed out.')); }, Math.max(10, Math.min(input.hostCallTimeoutMs ?? (message.method === 'inference.generateText' ? REQUEST_TIMEOUT_MS : 30_000), REQUEST_TIMEOUT_MS)));
			void Promise.resolve().then(() => { signal.throwIfAborted(); return callHost(message.method!, args, signal); }).then(result => settle(undefined, result), error => settle(error));
		});
		if (input.signal.aborted) abort();
	});
}
