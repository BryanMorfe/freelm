import { parentPort, workerData } from 'node:worker_threads';
import {
  getQuickJS,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
} from 'quickjs-emscripten';
interface Input {
  code: string;
  config: {
    kind: 'tool' | 'action' | 'provider';
    name: string;
    args: Record<string, unknown>;
    account: { id: string; label: string };
    operationId?: string;
  };
  cpuBudgetMs: number;
  jsonLimit: number;
}
const input = workerData as Input,
  port = parentPort!;
let finished = false;
function finish(error?: string, json?: string) {
  if (finished) return;
  finished = true;
  port.postMessage({ kind: 'done', error, json });
}
function errorText(context: QuickJSContext, handle: QuickJSHandle): string {
  const value = context.dump(handle);
  return value && typeof value === 'object'
    ? String(value.message || value.name || 'Custom node execution failed.')
    : String(value);
}
async function main() {
  const module = await getQuickJS(),
    runtime = module.newRuntime();
  runtime.setMemoryLimit(64 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  const context = runtime.newContext();
  let used = 0,
    started = 0,
    nextId = 1,
    callCount = 0,
    scheduled = false;
  const pending = new Map<number, QuickJSDeferredPromise>();
  runtime.setInterruptHandler(() => finished || used + Date.now() - started > input.cpuBudgetMs);
  const guarded = (operation: () => void) => {
    started = Date.now();
    try {
      operation();
    } catch (error) {
      finish(error instanceof Error ? error.message : 'Custom node interpreter failed.');
    } finally {
      used += Date.now() - started;
    }
  };
  const schedule = () => {
    if (finished || scheduled) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      if (finished) return;
      guarded(() => {
        const result = runtime.executePendingJobs(128);
        if (result.error) {
          const error = errorText(context, result.error);
          result.error.dispose();
          finish(error.includes('interrupted') ? 'Custom node CPU budget exceeded.' : error);
        }
      });
      if (!finished && runtime.hasPendingJob()) schedule();
    });
  };
  const bridge = context.newFunction('__host', (...handles) => {
    try {
      const kind = context.getString(handles[0]),
        serialized = context.getString(handles[1]);
      if (Buffer.byteLength(serialized) > input.jsonLimit)
        throw new Error('Custom node JSON payload exceeds 1 MiB.');
      if (kind === 'done') {
        finish(undefined, serialized);
        return context.undefined;
      }
      if (kind === 'error') {
        finish(serialized.slice(0, 4000));
        return context.undefined;
      }
      if (
        ![
          'request',
          'artifact.write',
          'artifact.read',
          'artifact.writeBytes',
          'artifact.readBytes',
          'download',
          'upload',
          'stream.open',
          'stream.read',
          'stream.close',
          'inference',
          'progress',
          'sleep',
        ].includes(kind) ||
        ++callCount > 2048 ||
        pending.size >= 8
      )
        throw new Error('Custom node host-call limit exceeded.');
      const id = nextId++,
        deferred = context.newPromise();
      pending.set(id, deferred);
      port.postMessage({ kind: 'call', id, method: kind, json: serialized });
      return deferred.handle;
    } catch (error) {
      return {
        error: context.newError(
          error instanceof Error ? error.message : 'Invalid plugin host call.',
        ),
      };
    }
  });
  context.setProp(context.global, '__host', bridge);
  bridge.dispose();
  const bootstrap = `(() => {
  'use strict'; const bridge = globalThis.__host; delete globalThis.__host;
  const encode = value => { const json = JSON.stringify(value); if (json === undefined) throw new TypeError('Return a JSON value.'); return json; };
  const host = (method,args) => bridge(method,encode(args));
  for (const name of ['console','Atomics','SharedArrayBuffer','WebAssembly']) delete globalThis[name];
  globalThis.__invoke = config => {
   const ctx = Object.freeze({operationId:config.operationId, config:config.args.config,
    request:request=>host('request',request), inference:request=>host('inference',request),
    download:request=>host('download',request),upload:request=>host('upload',request),
    stream:async function*(request){const opened=await host('stream.open',request);try{if(opened.status>=400)throw new Error('Stream request failed ('+opened.status+').');while(true){const part=await host('stream.read',{streamId:opened.streamId});if(part.chunk)yield part.chunk;if(part.done)break;}}finally{await host('stream.close',{streamId:opened.streamId});}},
    progress:message=>host('progress',{message}),sleep:milliseconds=>host('sleep',{milliseconds}),
    artifacts:Object.freeze({write:(name,mimeType,text)=>host('artifact.write',{name,mimeType,text}),read:artifact=>host('artifact.read',{artifact}),writeBytes:(name,mimeType,base64)=>host('artifact.writeBytes',{name,mimeType,base64}),readBytes:(artifact,offset=0,length=393216)=>host('artifact.readBytes',{artifact,offset,length})})});
   Promise.resolve().then(() => { const node = globalThis.__freelmNode && globalThis.__freelmNode.default;
    if (!node || !['execute','discover'].includes(config.name) || typeof node[config.name] !== 'function') throw new Error('Custom node does not implement '+config.name+'.');
    return config.name==='discover'?node.discover(ctx):node.execute(config.args.inputs,ctx);
   }).then(value=>bridge('done',encode(value))).catch(error=>bridge('error',String(error && error.message || error)));
  };
 })();`;
  guarded(() => {
    const result = context.evalCode(bootstrap, 'freelm-plugin-bridge.js');
    if (result.error) {
      const error = errorText(context, result.error);
      result.error.dispose();
      finish(error);
      return;
    }
    result.value.dispose();
    const invoke = context.getProp(context.global, '__invoke');
    context.setProp(context.global, '__invoke', context.undefined);
    const loaded = context.evalCode(input.code, 'custom-node.js');
    if (loaded.error) {
      const error = errorText(context, loaded.error);
      loaded.error.dispose();
      invoke.dispose();
      finish(error.includes('interrupted') ? 'Custom node CPU budget exceeded.' : error);
      return;
    }
    loaded.value.dispose();
    const config = context.evalCode(`JSON.parse(${JSON.stringify(JSON.stringify(input.config))})`);
    if (config.error) {
      const error = errorText(context, config.error);
      config.error.dispose();
      invoke.dispose();
      finish(error);
      return;
    }
    const result2 = context.callFunction(invoke, context.undefined, config.value);
    config.value.dispose();
    invoke.dispose();
    if (result2.error) {
      const error = errorText(context, result2.error);
      result2.error.dispose();
      finish(error);
    } else result2.value.dispose();
  });
  port.on('message', (message: { kind: string; id: number; json?: string; error?: string }) => {
    if (finished || message.kind !== 'result') return;
    const deferred = pending.get(message.id);
    if (!deferred) return;
    pending.delete(message.id);
    guarded(() => {
      if (message.error) {
        const handle = context.newError(message.error);
        deferred.reject(handle);
        handle.dispose();
      } else {
        const parsed = context.evalCode(`JSON.parse(${JSON.stringify(message.json || 'null')})`);
        if (parsed.error) {
          deferred.reject(parsed.error);
          parsed.error.dispose();
        } else {
          deferred.resolve(parsed.value);
          parsed.value.dispose();
        }
      }
      deferred.dispose();
    });
    schedule();
  });
  schedule();
}
void main().catch((error) =>
  finish(error instanceof Error ? error.message : 'Custom node interpreter failed.'),
);
