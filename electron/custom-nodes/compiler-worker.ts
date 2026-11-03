import { defineNode, poll, parseSSE } from '../../packages/custom-node-sdk';
import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { initialize, build, stop } from 'esbuild-wasm/lib/browser.js';
async function main() {
  Object.defineProperty(globalThis, 'self', { value: globalThis, configurable: true });
  await initialize({
    wasmModule: await WebAssembly.compile(
      await readFile(require.resolve('esbuild-wasm/esbuild.wasm')),
    ),
    worker: false,
  });
  const result = await build({
    stdin: { contents: workerData.source, loader: 'ts' },
    bundle: true,
    write: false,
    format: 'iife',
    globalName: '__freelmNode',
    platform: 'neutral',
    target: 'es2020',
    logLevel: 'silent',
    plugins: [
      {
        name: 'node-sdk-only',
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, (args) => {
            if (args.path !== '@freelm/custom-node-sdk')
              throw new Error('Only @freelm/custom-node-sdk imports are supported.');
            return { path: 'sdk', namespace: 'sdk' };
          });
          builder.onLoad({ filter: /.*/, namespace: 'sdk' }, () => ({
            contents: `export const defineNode = ${defineNode.toString()};export const poll = ${poll.toString()};export const parseSSE = ${parseSSE.toString()};`,
            loader: 'js',
          }));
        },
      },
    ],
  });
  parentPort!.postMessage({ code: result.outputFiles[0].text });
}
void main()
  .catch((error) => parentPort!.postMessage({ error: String(error.message) }))
  .finally(() => stop());
