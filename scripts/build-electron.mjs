import './build-pairing-native.mjs';
import './build-computer-native.mjs';
import { build } from 'esbuild';

await build({
	entryPoints: { main: 'electron/main.ts', preload: 'electron/preload.ts' },
	outdir: 'dist-electron',
	outExtension: { '.js': '.cjs' },
	bundle: true,
	platform: 'node',
	target: 'node22',
	format: 'cjs',
	external: ['electron', 'pdfjs-dist', '@napi-rs/canvas'],
	sourcemap: true,
	logLevel: 'info',
});

await build({
	entryPoints: ['electron/web-pdf-worker.ts'],
	outfile: 'dist-electron/web-pdf-worker.mjs',
	bundle: true,
	platform: 'node',
	target: 'node22',
	format: 'esm',
	external: ['pdfjs-dist', '@napi-rs/canvas'],
	sourcemap: true,
	logLevel: 'info',
});

await build({
	entryPoints: ['electron/tools/orchestration-worker.ts'],
	outfile: 'dist-electron/code-orchestration-worker.cjs',
	bundle: true,
	platform: 'node',
	target: 'node22',
	format: 'cjs',
	external: ['quickjs-emscripten'],
	sourcemap: true,
	logLevel: 'info',
});

for (const [entry, name, external] of [
	['runtime-worker', 'plugin-runtime-worker', 'quickjs-emscripten'],
	['surface-runtime-worker', 'plugin-surface-runtime-worker', 'quickjs-emscripten'],
	['compiler-worker', 'plugin-compiler-worker', 'esbuild-wasm'],
]) {
	await build({
		entryPoints: [`electron/plugins/${entry}.ts`],
		outfile: `dist-electron/${name}.cjs`,
		bundle: true,
		platform: 'node',
		target: 'node22',
		format: 'cjs',
		external: [external],
		sourcemap: true,
		logLevel: 'info',
	});
}

for (const [entry, external] of [['runtime','quickjs-emscripten'],['compiler','esbuild-wasm']]) {
 await build({entryPoints:[`electron/custom-nodes/${entry}-worker.ts`],outfile:`dist-electron/custom-node-${entry}-worker.cjs`,bundle:true,platform:'node',target:'node22',format:'cjs',external:[external],sourcemap:true,logLevel:'info'});
}
