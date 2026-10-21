import { parentPort, workerData } from 'node:worker_threads';
import {
	getQuickJS,
	type QuickJSContext,
	type QuickJSDeferredPromise,
	type QuickJSHandle,
} from 'quickjs-emscripten';

/** Untrusted source is interpreted inside WASM, never evaluated by Node or node:vm. */
interface Input {
	code: string;
	tools: { name: string; description: string }[];
	store: Record<string, unknown>;
	cpuBudgetMs: number;
	outputLimitBytes: number;
}
const input = workerData as Input;
const port = parentPort!;
let finished = false;
const send = (value: unknown) => port.postMessage(value);
function finish(error?: string) {
	if (finished) return;
	finished = true;
	send({ kind: 'done', ...(error ? { error } : {}) });
}
function errorText(context: QuickJSContext, value: QuickJSHandle): string {
	const dumped: unknown = context.dump(value);
	if (dumped && typeof dumped === 'object') {
		const { name, message, stack } = dumped as Record<string, unknown>;
		return `${typeof name === 'string' ? name : 'Error'}: ${typeof message === 'string' ? message : 'JavaScript execution failed.'}${typeof stack === 'string' ? `\n${stack}` : ''}`;
	}
	return String(dumped);
}

async function main() {
	const QuickJS = await getQuickJS();
	const runtime = QuickJS.newRuntime();
	runtime.setMemoryLimit(32 * 1024 * 1024);
	runtime.setMaxStackSize(512 * 1024);
	// No module loader: import() and module references cannot access the host.
	const context = runtime.newContext();
	let usedCpuMs = 0;
	let started = 0;
	runtime.setInterruptHandler(
		() => finished || usedCpuMs + Date.now() - started > input.cpuBudgetMs,
	);
	let nextCall = 1;
	let outputBytes = 0;
	let outputCount = 0;
	const pending = new Map<number, QuickJSDeferredPromise>();
	const timers = new Map<number, NodeJS.Timeout>();
	let scheduled = false;
	const pump = () => {
		scheduled = false;
		if (finished) return;
		started = Date.now();
		send({ kind: 'cpu', running: true });
		try {
			const result = runtime.executePendingJobs(256);
			if (result.error) {
				const message = errorText(context, result.error);
				result.error.dispose();
				finish(message.includes('interrupted') ? 'JavaScript CPU budget exceeded.' : message);
			}
		} catch (error) {
			finish(error instanceof Error ? error.message : String(error));
		} finally {
			usedCpuMs += Date.now() - started;
			send({ kind: 'cpu', running: false });
		}
		if (!finished && runtime.hasPendingJob()) schedule();
	};
	const schedule = () => {
		if (scheduled || finished) return;
		scheduled = true;
		setImmediate(pump);
	};
	const bridge = context.newFunction('__bridge', (...handles) => {
		const kind = context.getString(handles[0]);
		const serialized = context.getString(handles[1]);
		if (serialized.length > 16 * 1024 * 1024)
			return { error: context.newError('Bridge payload exceeds 16 MiB.') };
		try {
			const value = JSON.parse(serialized) as Record<string, unknown>;
			if (kind === 'call' || kind === 'timer') {
				if (pending.size >= 64) throw new Error('Too many pending tool calls or timers.');
				const id = nextCall++;
				const deferred = context.newPromise();
				pending.set(id, deferred);
				if (kind === 'call') send({ kind: 'call', id, name: value.name, args: value.args });
				else {
					const delay = Math.min(30_000, Math.max(0, Number(value.delay) || 0));
					timers.set(
						id,
						setTimeout(() => {
							timers.delete(id);
							pending.delete(id);
							if (finished) return;
							deferred.resolve();
							deferred.dispose();
							schedule();
						}, delay),
					);
				}
				return deferred.handle;
			}
			if (kind === 'output') {
				outputBytes += Buffer.byteLength(serialized);
				if (outputBytes > input.outputLimitBytes || ++outputCount > 4096)
					throw new Error('Script output exceeded its byte limit.');
				send({ kind: 'output', content: value });
			} else if (kind === 'store') send({ kind: 'store', key: value.key, value: value.value });
			else if (kind === 'yield') send({ kind: 'yield' });
			else if (kind === 'done') finish(typeof value.error === 'string' ? value.error : undefined);
			else throw new Error('Unknown interpreter helper.');
			return context.undefined;
		} catch (error) {
			return { error: context.newError(error instanceof Error ? error.message : String(error)) };
		}
	});
	context.setProp(context.global, '__bridge', bridge);
	bridge.dispose();
	const config = JSON.stringify({ tools: input.tools, store: input.store });
	// Host callback is captured in a closure, then removed from the guest global namespace.
	const bootstrap = `(() => {
		"use strict";
		const bridge = globalThis.__bridge;
		delete globalThis.__bridge;
		for (const name of ["console", "Atomics", "SharedArrayBuffer", "WebAssembly"]) delete globalThis[name];
		const config = ${config};
		const encode = value => { const text = JSON.stringify(value); if (text === undefined) throw new TypeError("Value must be JSON serializable."); return text; };
		const call = (kind, value) => bridge(kind, encode(value));
		const tools = Object.create(null);
		for (const tool of config.tools) tools[tool.name] = args => call("call", { name: tool.name, args });
		globalThis.tools = Object.freeze(tools);
		globalThis.ALL_TOOLS = Object.freeze(config.tools.map(tool => Object.freeze(tool)));
		globalThis.text = value => call("output", { type: "text", text: typeof value === "string" ? value : String(JSON.stringify(value)) });
		const media = (value, kind) => {
			let url = typeof value === "string" ? value : value && (value.dataUrl || value.image_url || value.audio_url);
			if (!url && value && typeof value.data === "string" && typeof value.mimeType === "string") url = "data:" + value.mimeType + ";base64," + value.data;
			if (typeof url !== "string" || !/^data:[a-zA-Z0-9.+-]+\\/[a-zA-Z0-9.+-]+;base64,[a-zA-Z0-9+/=\\r\\n]+$/.test(url)) throw new TypeError("Media must be a base64 data URL or tool media content.");
			if (kind === "image" && !url.startsWith("data:image/")) throw new TypeError("image() requires image content.");
			if (kind === "audio" && !url.startsWith("data:audio/")) throw new TypeError("audio() requires audio content.");
			const content = kind === "image" ? { type: "image", dataUrl: url } : { type: "file", dataUrl: url, name: value && value.name || "audio", mimeType: url.slice(5, url.indexOf(";")) };
			call("output", content);
		};
		globalThis.image = value => media(value, "image");
		globalThis.audio = value => media(value, "audio");
		globalThis.generatedImage = value => { media(value, "image"); if (value.output_hint) text(value.output_hint); };
		const values = Object.assign(Object.create(null), config.store);
		globalThis.store = (key, value) => {
			if (typeof key !== "string" || !key || key.length > 256) throw new TypeError("Store key must have 1–256 characters.");
			const copy = JSON.parse(encode(value));
			const next = Object.assign(Object.create(null), values, { [key]: copy });
			if (Object.keys(next).length > 256 || encode(next).length > 2 * 1024 * 1024) throw new TypeError("Run store exceeds 256 keys or 2 MiB.");
			values[key] = copy;
			call("store", { key, value: copy });
		};
		globalThis.load = key => values[key] === undefined ? undefined : JSON.parse(encode(values[key]));
		globalThis.notify = value => { text(value); call("yield", {}); };
		globalThis.yield_control = () => call("yield", {});
		let exited = false;
		globalThis.exit = () => { exited = true; throw new Error("FreeLM script exited."); };
		const timerIds = new Map();
		let timerId = 1;
		globalThis.setTimeout = (callback, delay = 0) => {
			if (typeof callback !== "function") throw new TypeError("Timer callback must be a function.");
			const id = timerId++;
			timerIds.set(id, true);
			call("timer", { delay }).then(() => { if (timerIds.delete(id)) callback(); });
			return id;
		};
		globalThis.clearTimeout = id => { timerIds.delete(id); };
		globalThis.__run = source => {
			const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
			Promise.resolve().then(() => new AsyncFunction(source)()).then(
				() => call("done", {}),
				error => call("done", exited ? {} : { error: String(error) + (error && error.stack ? "\\n" + error.stack : "") })
			);
		};
	})();`;
	started = Date.now();
	send({ kind: 'cpu', running: true });
	const init = context.evalCode(bootstrap, 'freelm-helpers.js');
	if (init.error) {
		finish(errorText(context, init.error));
		init.error.dispose();
		return;
	}
	init.value.dispose();
	const source = context.newString(input.code);
	const run = context.getProp(context.global, '__run');
	context.setProp(context.global, '__run', context.undefined);
	const initial = context.callFunction(run, context.undefined, source);
	if (initial.error) {
		finish(errorText(context, initial.error));
		initial.error.dispose();
	} else initial.value.dispose();
	run.dispose();
	source.dispose();
	usedCpuMs += Date.now() - started;
	send({ kind: 'cpu', running: false });
	port.on('message', (message: { kind: string; id: number; result?: unknown; error?: string }) => {
		if (finished || message.kind !== 'result') return;
		const deferred = pending.get(message.id);
		if (!deferred) return;
		pending.delete(message.id);
		started = Date.now();
		send({ kind: 'cpu', running: true });
		try {
			if (message.error) {
				const error = context.newError(message.error);
				deferred.reject(error);
				error.dispose();
			} else {
				const parsed = context.evalCode(
					`JSON.parse(${JSON.stringify(JSON.stringify(message.result))})`,
				);
				if (parsed.error) {
					deferred.reject(parsed.error);
					parsed.error.dispose();
				} else {
					deferred.resolve(parsed.value);
					parsed.value.dispose();
				}
			}
			deferred.dispose();
		} catch (error) {
			finish(error instanceof Error ? error.message : String(error));
		} finally {
			usedCpuMs += Date.now() - started;
			send({ kind: 'cpu', running: false });
		}
		schedule();
	});
	schedule();
}
void main().catch((error) => finish(error instanceof Error ? error.message : String(error)));
