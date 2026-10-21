import path from 'node:path';
import { Worker } from 'node:worker_threads';

export interface LocalPluginInvocation {
	code: string;
	kind: 'tool' | 'action';
	name: string;
	args: Record<string, unknown>;
	account: { id: string; label: string };
	operationId?: string;
	signal: AbortSignal;
	/** Test injection; production uses the adjacent unpacked worker. */
	workerPath?: string;
	cpuBudgetMs?: number;
	wallTimeoutMs?: number;
}
export type PluginHostCall = (
	method: string,
	args: Record<string, unknown>,
	signal?: AbortSignal,
) => Promise<unknown>;
const JSON_LIMIT = 1024 * 1024;
const methods = new Set(['fetch', 'storage.get', 'storage.set', 'storage.remove']);
let active = 0;
function json(value: unknown): string {
	const text = JSON.stringify(value);
	if (text === undefined || Buffer.byteLength(text) > JSON_LIMIT)
		throw new Error('Plugin JSON payload exceeds 1 MiB or is not serializable.');
	return text;
}
export function pluginWorkerPath(name: 'runtime' | 'compiler'): string {
	const directory =
		typeof __dirname === 'string' ? __dirname : path.join(process.cwd(), 'dist-electron');
	return path.join(
		directory.replace(/\.asar(?=[\\/])/g, '.asar.unpacked'),
		`plugin-${name}-worker.cjs`,
	);
}
/** Only a JSON bridge crosses the WASM boundary. This never evals plugin code in Node. */
export async function executeLocalPlugin(
	input: LocalPluginInvocation,
	callHost: PluginHostCall,
): Promise<unknown> {
	input.signal.throwIfAborted();
	if (active >= 8) throw new Error('Too many active plugin calls. Try again shortly.');
	if (
		typeof input.code !== 'string' ||
		Buffer.byteLength(input.code) > 4 * JSON_LIMIT ||
		!['tool', 'action'].includes(input.kind) ||
		!/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(input.name)
	)
		throw new Error('Invalid plugin invocation.');
	const config = JSON.parse(
		json({
			kind: input.kind,
			name: input.name,
			args: input.args,
			account: { id: input.account.id, label: input.account.label },
			...(input.operationId ? { operationId: input.operationId } : {}),
		}),
	);
	active++;
	const controller = new AbortController();
	const signal = AbortSignal.any([controller.signal, input.signal]);
	let worker: Worker | undefined;
	try {
		return await new Promise<unknown>((resolve, reject) => {
			let finished = false,
				calls = 0,
				replyBytes = 0;
			const pending = new Set<number>();
			let timer: NodeJS.Timeout;
			const finish = (error?: Error, result?: unknown) => {
				if (finished) return;
				finished = true;
				clearTimeout(timer);
				input.signal.removeEventListener('abort', abort);
				controller.abort();
				void worker?.terminate();
				error ? reject(error) : resolve(result);
			};
			const abort = () => finish(new Error('Plugin execution was cancelled.'));
			input.signal.addEventListener('abort', abort, { once: true });
			timer = setTimeout(
				() => finish(new Error('Plugin execution exceeded its wall-clock limit.')),
				Math.max(10, Math.min(input.wallTimeoutMs ?? 30_000, 120_000)),
			);
			try {
				worker = new Worker(input.workerPath ?? pluginWorkerPath('runtime'), {
					workerData: {
						code: input.code,
						config,
						cpuBudgetMs: Math.max(1, Math.min(input.cpuBudgetMs ?? 2000, 5000)),
						jsonLimit: JSON_LIMIT,
					},
					resourceLimits: { maxOldGenerationSizeMb: 96, stackSizeMb: 2 },
				});
			} catch (error) {
				finish(error instanceof Error ? error : new Error('Could not start plugin interpreter.'));
				return;
			}
			worker.on('error', (error) => finish(error));
			worker.on('exit', (code) => {
				if (!finished) finish(new Error(`Plugin interpreter exited before completion (${code}).`));
			});
			worker.on(
				'message',
				(message: {
					kind?: string;
					id?: number;
					method?: string;
					json?: string;
					error?: string;
				}) => {
					if (finished) return;
					if (message.kind === 'done') {
						if (message.error) {
							finish(new Error(message.error.slice(0, 4000)));
							return;
						}
						try {
							if (typeof message.json !== 'string' || Buffer.byteLength(message.json) > JSON_LIMIT)
								throw new Error('Plugin result exceeds 1 MiB.');
							finish(undefined, JSON.parse(message.json));
						} catch (error) {
							finish(error instanceof Error ? error : new Error('Invalid plugin result.'));
						}
						return;
					}
					if (
						message.kind !== 'call' ||
						!Number.isSafeInteger(message.id) ||
						!methods.has(message.method ?? '') ||
						typeof message.json !== 'string' ||
						Buffer.byteLength(message.json) > JSON_LIMIT ||
						++calls > 64 ||
						pending.size >= 8 ||
						pending.has(message.id!)
					) {
						finish(new Error('Plugin host-call limit or contract was violated.'));
						return;
					}
					let args: Record<string, unknown>;
					try {
						args = JSON.parse(message.json);
						if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error();
					} catch {
						finish(new Error('Invalid plugin host-call arguments.'));
						return;
					}
					const id = message.id!;
					pending.add(id);
					void Promise.resolve()
						.then(() => callHost(message.method!, args, signal))
						.then((result) => {
							if (finished) return;
							const serialized = json(result ?? null);
							replyBytes += Buffer.byteLength(serialized);
							if (replyBytes > 8 * JSON_LIMIT)
								throw new Error('Plugin host replies exceeded 8 MiB.');
							worker!.postMessage({ kind: 'result', id, json: serialized });
						})
						.catch((error) => {
							if (!finished)
								worker!.postMessage({
									kind: 'result',
									id,
									error:
										error instanceof Error
											? error.message.slice(0, 4000)
											: 'Plugin host call failed.',
								});
						})
						.finally(() => pending.delete(id));
				},
			);
			if (input.signal.aborted) abort();
		});
	} finally {
		controller.abort();
		if (worker) await worker.terminate().catch(() => {});
		active--;
	}
}
