import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { strToU8, zipSync } from 'fflate';
import { PluginPackageStore, PACKAGE_LIMITS } from '../../electron/plugins/packages';
import { executeLocalPlugin, type PluginHostCall } from '../../electron/plugins/runtime';
import type { PluginLocalManifest } from '../../src/plugin-types';

const roots: string[] = [],
	workers = path.join(process.cwd(), 'node_modules', '.freelm-plugin-worker-tests-' + process.pid);
const compilerWorkerPath = path.join(workers, 'plugin-compiler-worker.cjs'),
	workerPath = path.join(workers, 'plugin-runtime-worker.cjs');
const base: PluginLocalManifest = {
	manifestVersion: 2,
	id: 'test.package',
	name: 'Fixture',
	description: 'Isolated package test.',
	version: '1.0.0',
	auth: { type: 'none' },
	permissions: { network: [], storage: true },
	runtime: { apiVersion: 1, entry: 'src/index.ts' },
	contributes: {
		tools: [
			{
				name: 'read_note',
				description: 'Read a fixture note.',
				parameters: { type: 'object', properties: {} },
				readOnly: true,
			},
		],
		tabs: [{ id: 'notes', title: 'Notes', entry: 'src/tab.ts' }],
		actions: ['save_note'],
	},
};
function archive(
	runtime = `import {definePlugin} from '@freelm/plugin-sdk';import {suffix} from './helper';export default definePlugin({tools:{read_note:async(args,ctx)=>({value:await ctx.storage.get('note'),suffix,account:ctx.account})},actions:{save_note:async(args,ctx)=>{await ctx.storage.set('note',args.text);return {saved:true};}}});`,
	extra: Record<string, Uint8Array> = {},
	manifest = base,
) {
	return zipSync({
		'manifest.json': strToU8(JSON.stringify(manifest)),
		'src/index.ts': strToU8(runtime),
		'src/helper.ts': strToU8('export const suffix: string = "compiled";'),
		'src/tab.ts': strToU8(
			`import {invoke} from '@freelm/plugin-ui';import './tab.css';document.getElementById('root').textContent='Notes';globalThis.save=()=>invoke('save_note',{text:'from UI'});`,
		),
		'src/tab.css': strToU8('button { border-radius: 8px; }'),
		...extra,
	});
}
async function store(options: { now?: () => number } = {}) {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'freelm-plugin-package-'));
	roots.push(dir);
	return { dir, store: new PluginPackageStore(dir, { compilerWorkerPath, ...options }) };
}
async function install(source?: string) {
	const fixture = await store();
	const preview = await fixture.store.prepare(archive(source));
	const installed = await fixture.store.consume(preview.reviewId);
	return { ...fixture, ...installed, code: await fixture.store.readBundle(installed.hash) };
}
const run = (
	code: string,
	name = 'read_note',
	kind: 'tool' | 'action' = 'tool',
	args: Record<string, unknown> = {},
	host: PluginHostCall = vi.fn(async () => null),
	options: Record<string, unknown> = {},
) =>
	executeLocalPlugin(
		{
			code,
			name,
			kind,
			args,
			account: { id: 'a', label: 'Fixture' },
			signal: new AbortController().signal,
			workerPath,
			...options,
		},
		host,
	);
beforeAll(async () => {
	await Promise.all([
		build({
			entryPoints: ['electron/plugins/compiler-worker.ts'],
			outfile: compilerWorkerPath,
			bundle: true,
			platform: 'node',
			format: 'cjs',
			external: ['esbuild-wasm'],
		}),
		build({
			entryPoints: ['electron/plugins/runtime-worker.ts'],
			outfile: workerPath,
			bundle: true,
			platform: 'node',
			format: 'cjs',
			external: ['quickjs-emscripten'],
		}),
	]);
});
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
afterAll(async () => {
	await rm(workers, { recursive: true, force: true });
});

describe('reviewed, bounded plugin source packages', () => {
	it('compiles custom surface views with the same public UI bridge used by source modules', async () => {
		const { store: packages } = await store();
		const manifest: PluginLocalManifest = {
			...base,
			runtime: { ...base.runtime, apiVersion: 2 },
			permissions: { network: [], storage: false, capabilities: ['composer.drawer', 'commands'] },
			contributes: {
				tools: [],
				tabs: [],
				actions: [],
				activation: { surfaces: ['home.chat'] },
				views: [{ id: 'report', entry: 'src/view.ts' }],
			},
		};
		const preview = await packages.prepare(
			archive(
				`import {definePlugin} from '@freelm/plugin-sdk';export default definePlugin({activate(ctx){ctx.composer.drawer.addView({id:'report',view:'report'});}});`,
				{
					'src/view.ts': strToU8(
						`import {getViewProps,onViewPropsChanged,runCommand,call} from '@freelm/plugin-ui';globalThis.view={getViewProps,onViewPropsChanged,runCommand,call};`,
					),
				},
				manifest,
			),
		);
		const installed = await packages.consume(preview.reviewId);
		const view = await packages.readTab(installed.hash, 'view:report');
		const messages: Record<string, unknown>[] = [],
			listeners: ((event: unknown) => void)[] = [];
		const parent = { postMessage: (message: Record<string, unknown>) => messages.push(message) };
		const sandbox: Record<string, any> = { parent, structuredClone, setTimeout, clearTimeout };
		sandbox.window = sandbox;
		sandbox.addEventListener = (_name: string, listener: (event: unknown) => void) =>
			listeners.push(listener);
		const html = view.html.replaceAll('__FREELM_PLUGIN_CHANNEL__', 'fixture-nonce');
		for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g))
			runInNewContext(script[1], sandbox);
		expect(messages.shift()).toEqual({
			protocol: 'freelm-plugin-ui-v2',
			nonce: 'fixture-nonce',
			event: 'ready',
		});
		const notify = (data: unknown) =>
			listeners.forEach((listener) => listener({ source: parent, data }));
		notify({
			protocol: 'freelm-plugin-ui-v2',
			nonce: 'wrong',
			event: 'props',
			props: { title: 'Wrong' },
		});
		expect(sandbox.view.getViewProps()).toEqual({});
		notify({
			protocol: 'freelm-plugin-ui-v2',
			nonce: 'fixture-nonce',
			event: 'props',
			props: { title: 'Report' },
		});
		expect(sandbox.view.getViewProps()).toEqual({ title: 'Report' });
		const result = sandbox.view.runCommand('attach-report', { version: 1 });
		const request = messages.shift()!;
		expect(request).toMatchObject({
			method: 'commands.run',
			args: { id: 'attach-report', payload: { version: 1 } },
		});
		notify({ ...request, result: null });
		await expect(result).resolves.toBeUndefined();
	});
	it('reviews without compiling, installs TS/CSS without PATH or external Node, and runs actual WASM tools and actions', async () => {
		const { store: packages, dir } = await store();
		const preview = await packages.prepare(archive());
		expect(preview.manifest.id).toBe('test.package');
		expect(preview.files).toBe(5);
		await expect(readdir(dir)).resolves.toEqual([]);
		const installed = await packages.consume(preview.reviewId);
		expect(installed.hash).toMatch(/^[a-f0-9]{64}$/);
		expect(installed.installedBytes).toBeGreaterThan(100);
		const code = await packages.readBundle(installed.hash);
		const calls: unknown[] = [];
		expect(
			await run(
				code,
				'read_note',
				'tool',
				{},
				vi.fn<PluginHostCall>(async (method, args) => {
					calls.push({ method, args });
					return 'kept note';
				}),
			),
		).toEqual({ value: 'kept note', suffix: 'compiled', account: { id: 'a', label: 'Fixture' } });
		expect(calls).toEqual([{ method: 'storage.get', args: { key: 'note' } }]);
		const saved = vi.fn(async () => null);
		expect(await run(code, 'save_note', 'action', { text: 'new note' }, saved)).toEqual({
			saved: true,
		});
		expect(saved).toHaveBeenCalledWith(
			'storage.set',
			{ key: 'note', value: 'new note' },
			expect.any(AbortSignal),
		);
		const { html } = await packages.readTab(installed.hash, 'notes');
		expect(html).toContain('connect-src &#39;none&#39;');
		expect(html).toContain('__FREELM_PLUGIN_CHANNEL__');
		expect(html).toContain('__FREELM_PLUGIN_THEME__');
		expect(html).toContain('freelm-plugin-ui-v1');
		expect(html).toContain('exceeds 64 KB');
		expect(html).not.toContain('navigate-to');
		expect(html).toContain('border-radius: 8px');
		await expect(packages.consume(preview.reviewId)).rejects.toThrow('expired');
	});
	it('supports CommonJS runtime entries and package-relative require resolution', async () => {
		const { store: packages } = await store();
		const preview = await packages.prepare(
			archive(
				undefined,
				{
					'src/main.cjs': strToU8(
						`const {text}=require('./common');module.exports={tools:{read_note:()=>({text})}};`,
					),
					'src/common.cjs': strToU8(`exports.text='CommonJS works';`),
				},
				{ ...base, runtime: { apiVersion: 1, entry: 'src/main.cjs' } },
			),
		);
		const installed = await packages.consume(preview.reviewId);
		expect(await run(await packages.readBundle(installed.hash))).toEqual({
			text: 'CommonJS works',
		});
	});
	it.each([
		'../escape.ts',
		'/absolute.ts',
		'a/../../escape.ts',
		'a\\evil.ts',
		'.hidden/file.ts',
		'a:stream',
		'CON.txt',
	])('rejects unsafe ZIP path %s before writing', async (name) => {
		const { store: packages, dir } = await store();
		await expect(packages.prepare(archive(undefined, { [name]: strToU8('no') }))).rejects.toThrow();
		expect(await readdir(dir)).toEqual([]);
	});
	it('rejects symlinks, duplicate case paths, archives without manifest, and excessive file counts', async () => {
		const { store: packages } = await store();
		await expect(
			packages.prepare(
				zipSync({
					'manifest.json': strToU8(JSON.stringify(base)),
					link: [strToU8('target'), { os: 3, attrs: (0xa1ff << 16) >>> 0 }],
				}),
			),
		).rejects.toThrow('symlinks');
		await expect(
			packages.prepare(archive(undefined, { 'src/Index.ts': strToU8('collision') })),
		).rejects.toThrow('duplicate');
		await expect(packages.prepare(zipSync({ 'hello.txt': strToU8('hello') }))).rejects.toThrow(
			'manifest.json',
		);
		await expect(
			packages.prepare(
				zipSync(
					Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`${i}.txt`, strToU8('x')])),
				),
			),
		).rejects.toThrow('unsupported');
	});
	it('bounds inflated sizes, verifies CRC, and rejects lying ZIP sizes', async () => {
		const { store: packages } = await store();
		await expect(
			packages.prepare(archive(undefined, { 'bomb.txt': new Uint8Array(500_000) })),
		).rejects.toThrow('size limits');
		const corrupt = archive();
		const mutable = Buffer.from(corrupt);
		const central = mutable.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
		const local = mutable.readUInt32LE(central + 42);
		mutable.writeUInt32LE(4, central + 24);
		mutable.writeUInt32LE(4, local + 22);
		await expect(packages.prepare(mutable)).rejects.toThrow(/expansion|match/);
		await expect(packages.prepare(new Uint8Array(PACKAGE_LIMITS.archiveBytes + 1))).rejects.toThrow(
			'8 MiB',
		);
	});
	it('expires review handles and bounds concurrent pending package memory', async () => {
		let now = 1;
		const { store: packages } = await store({ now: () => now });
		const first = await packages.prepare(archive());
		await packages.prepare(archive());
		await packages.prepare(archive());
		await expect(packages.prepare(archive())).rejects.toThrow('Finish');
		now += PACKAGE_LIMITS.previewTTL;
		await expect(packages.consume(first.reviewId)).rejects.toThrow('expired');
		await expect(packages.prepare(archive())).resolves.toHaveProperty('reviewId');
	});
	it.each([
		"import fs from 'node:fs';export default {};",
		"import x from 'some-npm-package';export default {};",
		"import x from '../../outside.ts';export default {};",
		"import x from 'https://example.com/module.js';export default {};",
	])('does not resolve external compiler imports: %s', async (source) => {
		const { store: packages } = await store();
		const preview = await packages.prepare(archive(source));
		await expect(packages.consume(preview.reviewId)).rejects.toThrow(
			/Only package-relative|escapes/,
		);
	});
	it('does not execute package lifecycle scripts and detects installed bundle modification', async () => {
		const { store: packages, dir } = await store();
		const preview = await packages.prepare(
			archive(undefined, {
				'package.json': strToU8(
					JSON.stringify({ scripts: { install: 'touch /tmp/must-not-run' } }),
				),
			}),
		);
		const installed = await packages.consume(preview.reviewId);
		await writeFile(path.join(dir, 'packages', installed.hash, 'runtime.js'), 'tampered');
		await expect(packages.readBundle(installed.hash)).rejects.toThrow('integrity');
		await expect(packages.readTab('../escape', 'notes')).rejects.toThrow('hash');
	});
});
describe('fresh QuickJS plugin invocation boundary', () => {
	it('has no Node, filesystem, direct network or host escape through Function', async () => {
		const { code } = await install(
			`export default {tools:{read_note:()=>({process:typeof process,require:typeof globalThis.require,fetch:typeof fetch,global:Function('return typeof process')(),webassembly:typeof WebAssembly})}}`,
		);
		expect(await run(code)).toEqual({
			process: 'undefined',
			require: 'undefined',
			fetch: 'undefined',
			global: 'undefined',
			webassembly: 'undefined',
		});
	});
	it('provides host-bridged fetch JSON and starts a clean global realm every invocation', async () => {
		const { code } = await install(
			`let count=0;export default {tools:{read_note:async(args,ctx)=>({count:++count,response:await ctx.fetch('https://example.com/items',{method:'GET',authenticated:true})})}}`,
		);
		const host = vi.fn(async () => ({ status: 200, headers: {}, body: 'ok' }));
		for (let i = 0; i < 2; i++)
			expect(await run(code, 'read_note', 'tool', {}, host)).toMatchObject({
				count: 1,
				response: { body: 'ok' },
			});
		expect(host).toHaveBeenCalledWith(
			'fetch',
			{ url: 'https://example.com/items', init: { method: 'GET', authenticated: true } },
			expect.any(AbortSignal),
		);
	});
	it('stops CPU loops and never-completing async code', async () => {
		const { code } = await install(
			`export default {tools:{read_note:()=>{while(true){}}},actions:{save_note:()=>new Promise(()=>{})}}`,
		);
		await expect(
			run(
				code,
				'read_note',
				'tool',
				{},
				vi.fn(async () => null),
				{ cpuBudgetMs: 30 },
			),
		).rejects.toThrow(/CPU|interrupted/);
		await expect(
			run(
				code,
				'save_note',
				'action',
				{},
				vi.fn(async () => null),
				{ wallTimeoutMs: 80 },
			),
		).rejects.toThrow('wall-clock');
	});
	it('rejects oversized and non-JSON results without hanging', async () => {
		const { code } = await install(
			`export default {tools:{read_note:()=> 'x'.repeat(1100000)},actions:{save_note:()=>undefined}}`,
		);
		await expect(run(code)).rejects.toThrow('1 MiB');
		await expect(run(code, 'save_note', 'action')).rejects.toThrow('JSON');
	});
	it('enforces interpreter memory and concurrent bridge limits', async () => {
		const { code } = await install(
			`export default {tools:{read_note:()=>new ArrayBuffer(80*1024*1024)},actions:{save_note:(_args,ctx)=>Promise.all(Array.from({length:9},(_,i)=>ctx.storage.get(String(i))))}}`,
		);
		await expect(run(code)).rejects.toThrow(/memory|alloc/i);
		const host = vi.fn(async () => new Promise(() => {}));
		await expect(run(code, 'save_note', 'action', {}, host)).rejects.toThrow('host-call limit');
		expect(host.mock.calls.length).toBeLessThanOrEqual(8);
	});
	it('cancels outstanding host work and supports cancellation before startup', async () => {
		const { code } = await install();
		const controller = new AbortController();
		let started!: () => void;
		const began = new Promise<void>((resolve) => {
			started = resolve;
		});
		let hostSignal: AbortSignal | undefined;
		const host = vi.fn(async (_method, _args, signal?: AbortSignal) => {
			hostSignal = signal;
			started();
			return new Promise(() => {});
		});
		const pending = run(code, 'read_note', 'tool', {}, host, { signal: controller.signal });
		const rejected = expect(pending).rejects.toThrow('cancelled');
		await began;
		controller.abort();
		await rejected;
		expect(hostSignal!.aborted).toBe(true);
		await expect(
			run(code, 'read_note', 'tool', {}, host, { signal: controller.signal }),
		).rejects.toThrow();
	});
});

it('exposes the stable host operation identity in the isolated SDK context', async () => {
	const { code } = await install(
		"import {definePlugin} from '@freelm/plugin-sdk'; export default definePlugin({tools:{read_note:(_args,ctx)=>({operationId:ctx.operationId})}});",
	);
	expect(
		await run(code, 'read_note', 'tool', {}, undefined, { operationId: 'bot:durable-operation' }),
	).toEqual({ operationId: 'bot:durable-operation' });
});
