import { parentPort, workerData } from 'node:worker_threads';
import { getQuickJS, type QuickJSContext, type QuickJSDeferredPromise, type QuickJSHandle } from 'quickjs-emscripten';
import { SURFACE_HOST_METHODS, surfaceRuntimeBootstrap } from './surface-runtime-bridge';
import { PluginCpuBudget } from './cpu-budget';

interface Input {
	code: string;
	context: Record<string, unknown>;
	cpuBudgetMs: number;
	jsonLimit: number;
}
const input = workerData as Input, port = parentPort!;
let finished = false;
function fail(error: string) {
	if (finished) return;
	finished = true;
	port.postMessage({ kind: 'error', error: (error.includes('interrupted') ? 'Plugin CPU budget exceeded.' : error).slice(0, 4000) });
}
function errorText(context: QuickJSContext, handle: QuickJSHandle): string {
	const value = context.dump(handle);
	const text = value && typeof value === 'object' ? String(value.message || value.name || 'Plugin execution failed.') : String(value);
	return text.includes('interrupted') ? 'Plugin CPU budget exceeded.' : text;
}

async function main() {
	const module = await getQuickJS(), runtime = module.newRuntime();
	runtime.setMemoryLimit(64 * 1024 * 1024);
	runtime.setMaxStackSize(512 * 1024);
	const context = runtime.newContext();
	let nextId = 0, scheduled = false;
	const budget = new PluginCpuBudget(input.cpuBudgetMs);
	const pending = new Map<number, QuickJSDeferredPromise>();
	runtime.setInterruptHandler(() => finished || budget.exceeded());
	function guarded(operation: () => void) {
		budget.begin();
		try { operation(); }
		catch (error) { fail(error instanceof Error ? error.message : 'Plugin interpreter failed.'); }
		finally { budget.end(); }
	}
	function schedule() {
		if (scheduled || finished) return;
		scheduled = true;
		setImmediate(() => {
			scheduled = false;
			if (finished) return;
			guarded(() => {
				const result = runtime.executePendingJobs(128);
				if (result.error) { const error = errorText(context, result.error); result.error.dispose(); fail(error); }
			});
			if (!finished && runtime.hasPendingJob()) schedule();
		});
	}
	const bridge = context.newFunction('__host', (...handles) => {
		try {
			const method = context.getString(handles[0]), json = context.getString(handles[1]);
			if (Buffer.byteLength(json) > input.jsonLimit) throw new Error('Plugin JSON payload exceeds 1 MiB.');
			if (method === '__error') { fail(json); return context.undefined; }
			if (method === '__ready') { port.postMessage({ kind: 'ready' }); return context.undefined; }
			if (method === '__cancel') { port.postMessage({ kind: 'cancel', operationId: json }); return context.undefined; }
			if (!SURFACE_HOST_METHODS.has(method) || pending.size >= 32) throw new Error('Plugin host-call limit or contract was violated.');
			const operationId = context.getString(handles[2]), id = ++nextId, deferred = context.newPromise();
			pending.set(id, deferred);
			port.postMessage({ kind: 'call', id, method, json, operationId });
			return deferred.handle;
		} catch (error) {
			return { error: context.newError(error instanceof Error ? error.message : 'Invalid plugin host call.') };
		}
	});
	context.setProp(context.global, '__host', bridge); bridge.dispose();
	let surface: QuickJSHandle | undefined;
	function invoke(name: string, values: unknown[]) {
		if (finished || !surface) return;
		const fn = context.getProp(surface, name), args: QuickJSHandle[] = [];
		try {
			for (const value of values) {
				const result = context.evalCode(`JSON.parse(${JSON.stringify(JSON.stringify(value))})`);
				if (result.error) { const error = errorText(context, result.error); result.error.dispose(); fail(error); return; }
				args.push(result.value);
			}
			const result = context.callFunction(fn, surface, ...args);
			if (result.error) { const error = errorText(context, result.error); result.error.dispose(); fail(error); }
			else result.value.dispose();
		} finally { fn.dispose(); args.forEach(arg => arg.dispose()); }
	}
	guarded(() => {
		const bootstrap = context.evalCode(surfaceRuntimeBootstrap, 'freelm-surface-bridge.js');
		if (bootstrap.error) { const error = errorText(context, bootstrap.error); bootstrap.error.dispose(); fail(error); return; }
		bootstrap.value.dispose();
		surface = context.getProp(context.global, '__surface');
		context.setProp(context.global, '__surface', context.undefined);
		const loaded = context.evalCode(input.code, 'plugin.js');
		if (loaded.error) { const error = errorText(context, loaded.error); loaded.error.dispose(); fail(error); return; }
		loaded.value.dispose();
		invoke('start', [input.context]);
	});
	port.on('message', (message: { kind: string; id?: number; name?: string; json?: string; error?: string }) => {
		if (finished) return;
		if (message.kind === 'dispose') {
			guarded(() => invoke('dispose', []));
			finished = true;
			port.postMessage({ kind: 'disposed' });
			return;
		}
		if (message.kind === 'result') {
			const deferred = pending.get(message.id!);
			if (!deferred) return;
			pending.delete(message.id!);
			guarded(() => {
				if (message.error) {
					const handle = context.newError(message.error); deferred.reject(handle); handle.dispose();
				} else {
					const result = context.evalCode(`JSON.parse(${JSON.stringify(message.json || 'null')})`);
					if (result.error) { deferred.reject(result.error); result.error.dispose(); }
					else { deferred.resolve(result.value); result.value.dispose(); }
				}
				deferred.dispose();
			});
		} else if (message.kind === 'event' || message.kind === 'command') {
			guarded(() => invoke(message.kind, [message.name, JSON.parse(message.json || '{}')]));
			port.postMessage({ kind: 'ack', id: message.id });
		}
		schedule();
	});
	schedule();
}
void main().catch(error => fail(error instanceof Error ? error.message : 'Plugin interpreter failed.'));
