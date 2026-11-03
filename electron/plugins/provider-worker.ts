import type { MessagePort } from 'node:worker_threads';
import { getQuickJS } from 'quickjs-emscripten';
import { PluginCpuBudget } from './cpu-budget';

/** A provider session owns one realm; transforms are synchronous, pure JSON functions. */
export async function runProviderWorker(input: { code: string; name: string }, port: MessagePort) {
	const module = await getQuickJS(), runtime = module.newRuntime();
	runtime.setMemoryLimit(64 * 1024 * 1024); runtime.setMaxStackSize(512 * 1024);
	const context = runtime.newContext(), budget = new PluginCpuBudget(100);
	runtime.setInterruptHandler(() => budget.exceeded());
	const evaluate = (code: string) => {
		budget.begin();
		try {
			const result = context.evalCode(code);
			if (result.error) { const error = context.dump(result.error); result.error.dispose(); throw new Error(String(error?.message ?? 'Provider transformation failed.')); }
			try { return context.dump(result.value); } finally { result.value.dispose(); }
		} finally { budget.end(); }
	};
	evaluate(`for (const k of ['console','Atomics','SharedArrayBuffer','WebAssembly']) delete globalThis[k];`);
	evaluate(input.code);
	// Capture the intrinsic JSON functions and the declared handler before guest invocations.
	evaluate(`globalThis.__transform = (() => { const parse=JSON.parse, stringify=JSON.stringify, fn=globalThis.__freelmPlugin?.default?.providers?.[${JSON.stringify(input.name)}]; if(typeof fn !== 'function') throw Error('Provider handler is missing.'); return raw => {const value=fn(parse(raw),Object.freeze({})); if(value && typeof value.then === 'function') throw Error('Provider transforms must be synchronous.'); const result=stringify(value); if(typeof result !== 'string' || result.length>1048576) throw Error('Provider result exceeds its limit.'); return result;}; })();`);
	port.on('message', (message: { id: number; json: string }) => {
		try {
			if (typeof message.json !== 'string' || Buffer.byteLength(message.json) > 1024 * 1024) throw new Error('Provider input exceeds its limit.');
			const json = evaluate(`__transform(${JSON.stringify(message.json)})`);
			port.postMessage({ id: message.id, json });
		} catch (error) { port.postMessage({ id: message.id, error: error instanceof Error ? error.message.slice(0, 1000) : 'Provider worker failed.' }); }
	});
	port.postMessage({ ready: true });
}
