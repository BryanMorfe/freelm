import { parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { build, initialize, stop, type Loader } from 'esbuild-wasm/lib/browser.js';
import type { PluginLocalManifest } from '../../src/plugin-types';
import { createPluginUIBridge } from '../../packages/plugin-ui/bridge';
interface Input {
	manifest: PluginLocalManifest;
	files: { name: string; data: Uint8Array }[];
}
const input = workerData as Input;
const files = new Map(input.files.map((file) => [file.name, new Uint8Array(file.data)]));
const loaders: Record<string, Loader> = {
	'.ts': 'ts',
	'.tsx': 'tsx',
	'.js': 'js',
	'.jsx': 'jsx',
	'.mjs': 'js',
	'.cjs': 'js',
	'.json': 'json',
	'.css': 'css',
	'.png': 'dataurl',
	'.jpg': 'dataurl',
	'.jpeg': 'dataurl',
	'.webp': 'dataurl',
	'.gif': 'dataurl',
	'.svg': 'dataurl',
	'.woff': 'dataurl',
	'.woff2': 'dataurl',
};
const sdk = `export const definePlugin = definition => definition;`;
// Serialize the shared, self-contained browser factory after TypeScript compilation.
// Public module and compiled ZIPs therefore run the same protocol implementation.
const uiSdk = `const bridge = (${createPluginUIBridge.toString()})();
export const invoke = bridge.invoke;
export const call = bridge.call;
export const runCommand = (id, payload) => bridge.runCommand(id, payload).then(() => undefined);
export const getViewProps = bridge.getViewProps;
export const onViewPropsChanged = bridge.onViewPropsChanged;`;

function resolveFile(requested: string): string {
	const candidates = [
		requested,
		...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css'].map(
			(ext) => requested + ext,
		),
		...['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.cjs'].map(
			(file) => requested + '/' + file,
		),
	];
	if (/\.m?js$/.test(requested))
		candidates.push(requested.replace(/\.m?js$/, '.ts'), requested.replace(/\.m?js$/, '.tsx'));
	const found = candidates.find((file) => files.has(file));
	if (!found) throw new Error(`Package import was not found: ${requested}`);
	return found;
}
async function compile(entry: string, kind: 'runtime' | 'ui') {
	const result = await build({
		entryPoints: [entry],
		bundle: true,
		write: false,
		format: 'iife',
		globalName: kind === 'runtime' ? '__freelmPlugin' : undefined,
		platform: 'neutral',
		target: 'es2020',
		outfile: 'output.js',
		logLevel: 'silent',
		legalComments: 'none',
		treeShaking: true,
		tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
		packages: 'bundle',
		plugins: [
			{
				name: 'freelm-package-only',
				setup(builder) {
					builder.onResolve({ filter: /.*/ }, (args) => {
						if (args.kind === 'entry-point' && kind === 'runtime')
							return { path: 'entry', namespace: 'freelm-entry' };
						if (args.path === '@freelm/plugin-sdk') return { path: 'sdk', namespace: 'freelm-sdk' };
						if (args.path === '@freelm/plugin-ui') {
							if (kind !== 'ui')
								throw new Error('The UI SDK is available only to tab entry points.');
							return { path: 'ui', namespace: 'freelm-sdk' };
						}
						if (args.kind === 'entry-point')
							return { path: resolveFile(args.path), namespace: 'freelm-package' };
						if (!args.path.startsWith('./') && !args.path.startsWith('../'))
							throw new Error(
								`Only package-relative imports and the FreeLM SDK are supported: ${args.path}`,
							);
						if (
							args.path.includes('\\') ||
							args.path.includes('?') ||
							args.path.includes('#') ||
							args.path.includes('\0')
						)
							throw new Error('Invalid package import.');
						const resolved = path.posix.normalize(
							path.posix.join(path.posix.dirname(args.importer), args.path),
						);
						if (resolved === '..' || resolved.startsWith('../') || resolved.startsWith('/'))
							throw new Error('Package import escapes its archive.');
						return { path: resolveFile(resolved), namespace: 'freelm-package' };
					});
					builder.onLoad({ filter: /.*/, namespace: 'freelm-entry' }, () => ({
						contents: `export { default } from ${JSON.stringify('./' + entry)};`,
						loader: 'js',
					}));
					builder.onLoad({ filter: /.*/, namespace: 'freelm-sdk' }, (args) => ({
						contents: args.path === 'ui' ? uiSdk : sdk,
						loader: 'js',
					}));
					builder.onLoad({ filter: /.*/, namespace: 'freelm-package' }, (args) => {
						const loader = loaders[path.posix.extname(args.path).toLowerCase()];
						if (!loader) throw new Error(`Unsupported package source or asset: ${args.path}`);
						if (kind === 'runtime' && loader === 'css')
							throw new Error('CSS belongs in a plugin tab, not its runtime.');
						return { contents: files.get(args.path)!, loader };
					});
				},
			},
		],
	});
	const js = result.outputFiles.find((file) => file.path.endsWith('.js'))?.text,
		css = result.outputFiles.find((file) => file.path.endsWith('.css'))?.text || '';
	if (!js) throw new Error('Plugin compilation produced no JavaScript.');
	if (Buffer.byteLength(js) + Buffer.byteLength(css) > 4 * 1024 * 1024)
		throw new Error('Compiled plugin entry exceeds 4 MiB.');
	return { js, css };
}
async function main() {
	// The Node entry launches a separate `node` binary from PATH. Run the browser
	// WASM service in this bounded worker instead, including in packaged Electron.
	Object.defineProperty(globalThis, 'self', { value: globalThis, configurable: true });
	await initialize({
		wasmModule: await WebAssembly.compile(
			await readFile(require.resolve('esbuild-wasm/esbuild.wasm')),
		),
		worker: false,
	});
	const runtime = await compile(input.manifest.runtime.entry, 'runtime');
	const tabs: Record<string, { js: string; css: string }> = Object.create(null);
	for (const tab of input.manifest.contributes.tabs) tabs[tab.id] = await compile(tab.entry, 'ui');
	for (const view of input.manifest.contributes.views ?? []) tabs[`view:${view.id}`] = await compile(view.entry, 'ui');
	parentPort!.postMessage({ runtime: runtime.js, tabs });
}
void main()
	.catch((error) =>
		parentPort!.postMessage({
			error: error instanceof Error ? error.message.slice(0, 4000) : 'Plugin compilation failed.',
		}),
	)
	.finally(() => stop());
