import { Worker } from 'node:worker_threads';
import { pluginWorkerPath } from './runtime';
let active = 0;
export function createProviderSession(code: string, name: string, signal: AbortSignal, workerPath?: string) {
	signal.throwIfAborted();
	if (active >= 8 || Buffer.byteLength(code) > 4 * 1024 * 1024) throw new Error('Provider session limit exceeded.');
	const worker = new Worker(workerPath ?? pluginWorkerPath('runtime'), { env: {}, workerData: { providerSession: true, code, name }, resourceLimits: { maxOldGenerationSizeMb: 96, stackSizeMb: 2 } });
	active++;
	let stopped = false, serial = 0, ready = false;
	let pending: { id: number; json: string; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | undefined;
	const close = (error = new Error('Provider session closed.')) => {
		if (stopped) return; stopped = true; active--;
		signal.removeEventListener('abort', abort); clearTimeout(lifetime);
		if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = undefined; }
		void worker.terminate();
	};
	const abort = () => close(new Error('Provider request cancelled.'));
	const lifetime = setTimeout(() => close(new Error('Provider session timed out.')), 120000);
	signal.addEventListener('abort', abort, { once: true });
	worker.on('error', close); worker.on('exit', () => close(new Error('Provider worker exited.')));
	worker.on('message', message => {
		if (stopped) return;
		if (message.error && message.id === undefined) { close(new Error(message.error)); return; }
		if (message.ready) { ready = true; if (pending) worker.postMessage({ id: pending.id, json: pending.json }); return; }
		if (!pending || message.id !== pending.id) { close(new Error('Invalid provider worker response.')); return; }
		const call = pending; pending = undefined; clearTimeout(call.timer);
		try {
			if (message.error) throw new Error(message.error);
			if (typeof message.json !== 'string' || Buffer.byteLength(message.json) > 1024 * 1024) throw new Error('Provider result exceeds its limit.');
			call.resolve(JSON.parse(message.json));
		} catch (error) { call.reject(error as Error); close(); }
	});
	if (signal.aborted) abort();
	return {
		close,
		transform(input: unknown): Promise<unknown> {
			if (stopped || pending || ++serial > 16384) return Promise.reject(new Error('Provider session is unavailable or busy.'));
			const json = JSON.stringify(input);
			if (Buffer.byteLength(json) > 1024 * 1024) return Promise.reject(new Error('Provider input exceeds its limit.'));
			return new Promise((resolve, reject) => {
				const id = serial, timer = setTimeout(() => close(new Error('Provider transformation timed out.')), 5000);
				pending = { id, json, resolve, reject, timer }; if (ready) worker.postMessage({ id, json });
			});
		},
	};
}
