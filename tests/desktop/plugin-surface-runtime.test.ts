import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { startPluginSurfaceRuntime, type PluginSurfaceRuntime, type PluginSurfaceRuntimeInput } from '../../electron/plugins/surface-runtime';
import type { PluginHostCall } from '../../electron/plugins/runtime';

const directory = path.join(process.cwd(), 'node_modules', '.freelm-surface-worker-tests-' + process.pid);
const workerPath = path.join(directory, 'plugin-surface-runtime-worker.cjs');
const sessions: PluginSurfaceRuntime[] = [];
const context = { surface: { kind: 'home', mode: 'chat' }, workspaceId: 'local', composerId: 'fixture-composer', threadId: 'fixture-thread', plugin: { id: 'fixture.plugin', name: 'Fixture' } };
async function start(activate: string, host: PluginHostCall, options: Partial<PluginSurfaceRuntimeInput> = {}) {
	const session = await startPluginSurfaceRuntime({
		code: `globalThis.__freelmPlugin = {default: {activate: ${activate}}};`,
		context, signal: new AbortController().signal, workerPath, ...options,
	}, host);
	sessions.push(session);
	return session;
}
beforeAll(async () => {
	await build({ entryPoints: ['electron/plugins/surface-runtime-worker.ts'], outfile: workerPath, bundle: true, platform: 'node', format: 'cjs', external: ['quickjs-emscripten'] });
});
afterEach(() => { sessions.splice(0).forEach(session => session.dispose()); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

describe('isolated persistent API v2 surface activations', () => {
	it('retains callback state across edits, exposes generic services, and never passes executable callbacks to the host', async () => {
		const calls: { method: string; args: Record<string, unknown> }[] = [];
		const host = vi.fn(async (method, args) => { calls.push({ method, args }); return null; });
		const session = await start(`ctx => {
      let changes = 0;
      const command = ctx.commands.register({id:'inspect', title:'Inspect', run: invocation => ctx.composer.setText('edit-' + changes, {expectedRevision:invocation.composerRevision})});
      const row = ctx.composer.drawer.addItem({id:'status',title:'Ready',actions:[{title:'Inspect',command:command.id}]});
      ctx.composer.onDidChange(event => { changes++; return row.update({description:'Changes: ' + changes}); });
      return () => { row.dispose(); command.dispose(); };
    }`, host);
		expect(calls.find(call => call.method === 'commands.register')?.args).toEqual({ id: 'inspect', title: 'Inspect' });
		session.event('composer.changed', { revision: 1 });
		await vi.waitFor(() => expect(calls.some(call => call.args.description === 'Changes: 1')).toBe(true));
		session.event('composer.changed', { revision: 2 });
		await vi.waitFor(() => expect(calls.some(call => call.args.description === 'Changes: 2')).toBe(true));
		session.command('inspect', { composerRevision: 2 });
		await vi.waitFor(() => expect(calls).toContainEqual({ method: 'composer.setText', args: { text: 'edit-2', expectedRevision: 2 } }));
	});

	it('isolates globals and captures the supplied surface binding without exposing Node or host callbacks', async () => {
		const host = vi.fn<PluginHostCall>(async () => null);
		await start(`ctx => { ctx.composer.drawer.addItem({id:'inspect',title: JSON.stringify({process:typeof process,require:typeof require,host:typeof __host,surface:typeof __surface,threadId:ctx.threadId})}); }`, host);
		expect(JSON.parse(String(host.mock.calls[0][1].title))).toEqual({ process: 'undefined', require: 'undefined', host: 'undefined', surface: 'undefined', threadId: 'fixture-thread' });
	});

	it('preserves exact revision and action descriptors and supports all attachment phases without suggestion-specific APIs', async () => {
		const calls: { method: string; args: Record<string, unknown> }[] = [];
		const asset = { id: 'opaque-resource', name: 'report.txt', mimeType: 'text/plain', size: 7 };
		await start(`async ctx => {
      const placeholder = ctx.composer.setPlaceholder('Try this', {expectedRevision:7,hint:'Tab',acceptCommand:'accept'});
      ctx.commands.register({id:'accept',title:'Accept',action:{type:'composer.setText',text:'Try this',expectedRevision:7}});
      ctx.keybindings.register({id:'accept-tab',key:'Tab',command:'accept',when:{composerFocused:true,composerEmpty:true,contributionVisible:placeholder.id}});
      const resource = await ctx.assets.create({name:'report.txt',mimeType:'text/plain',text:'Report.'});
      await ctx.composer.attachments.add(resource,{expectedRevision:7});
      await ctx.composer.attachments.read(resource.id);
      await ctx.composer.attachments.remove(resource.id,{expectedRevision:8});
    }`, async (method, args) => { calls.push({ method, args }); return method === 'assets.create' ? asset : null; });
		await vi.waitFor(() => expect(calls).toContainEqual({ method: 'composer.attachments.remove', args: { id: asset.id, expectedRevision: 8 } }));
		expect(calls).toContainEqual({ method: 'composer.attachments.add', args: { asset, expectedRevision: 7 } });
		expect(calls).toContainEqual({ method: 'composer.attachments.read', args: { id: asset.id } });
		expect(calls.find(call => call.method === 'commands.register')?.args.action).toEqual({ type: 'composer.setText', text: 'Try this', expectedRevision: 7 });
	});

	it('cancels a child inference operation while keeping the activation usable', async () => {
		let cancelled = false;
		const calls: { method: string; args: Record<string, unknown> }[] = [];
		const session = await start(`ctx => {
      let operation;
      ctx.commands.register({id:'start',title:'Start',run:async () => {
        operation = new AbortController();
        try { await ctx.inference.generateText({model:{source:'conversation'},messages:[],signal:operation.signal}); }
        catch(error) { await ctx.composer.drawer.addItem({id:'result',title:error.message}).ready; }
      }});
      ctx.commands.register({id:'cancel',title:'Cancel',run:() => operation.abort()});
      ctx.commands.register({id:'later',title:'Later',run:() => ctx.composer.getState()});
    }`, async (method, args, signal) => {
			calls.push({ method, args });
			if (method !== 'inference.generateText') return null;
			return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => { cancelled = true; reject(new Error('Provider cancelled.')); }, { once: true }));
		});
		session.command('start', {});
		await vi.waitFor(() => expect(calls.some(call => call.method === 'inference.generateText')).toBe(true));
		session.command('cancel', {});
		await vi.waitFor(() => expect(cancelled).toBe(true));
		await vi.waitFor(() => expect(calls.some(call => call.args.id === 'result' && String(call.args.title).includes('cancelled'))).toBe(true));
		session.command('later', {});
		await vi.waitFor(() => expect(calls.some(call => call.method === 'composer.getState')).toBe(true));
	});

	it('does not count inference waiting against the guest CPU budget', async () => {
		const host = vi.fn(async method => {
			if (method === 'inference.generateText') {
				await new Promise(resolve => setTimeout(resolve, 150));
				return { text: 'Ready' };
			}
			return null;
		});
		await start(`async ctx => { const result = await ctx.inference.generateText({model:{source:'conversation'},messages:[]}); ctx.composer.drawer.addItem({id:'ready',title:result.text}); }`, host, { cpuBudgetMs: 50 });
		await vi.waitFor(() => expect(host.mock.calls.some(call => call[0] === 'composer.drawer.addItem')).toBe(true));
	});

	it('terminates runaway activation code without blocking the host', async () => {
		await expect(start(`() => { while (true) {} }`, vi.fn(async () => null), { cpuBudgetMs: 10 })).rejects.toThrow(/CPU budget/);
	});

	it('terminates a runaway callback and reports it once, without affecting another session', async () => {
		const onError = vi.fn();
		const broken = await start(`ctx => { ctx.composer.onDidChange(() => { while (true) {} }); }`, async () => null, { cpuBudgetMs: 10, onError });
		const healthyHost = vi.fn<PluginHostCall>(async () => null);
		const healthy = await start(`ctx => { ctx.commands.register({id:'read',title:'Read',run:() => ctx.composer.getState()}); }`, healthyHost);
		broken.event('composer.changed', { revision: 1 });
		await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
		expect(onError.mock.calls[0][0].message).toMatch(/CPU budget/);
		healthy.command('read', {});
		await vi.waitFor(() => expect(healthyHost.mock.calls.some(call => call[0] === 'composer.getState')).toBe(true));
	});

	it('removes listeners and handles once, and disposes pending host requests without late mutations', async () => {
		const calls: { method: string; args: Record<string, unknown> }[] = [];
		let resolveRead: ((result: unknown) => void) | undefined, aborted = false;
		const session = await start(`ctx => {
      const listener = ctx.composer.onDidChange(() => ctx.composer.readDraft());
      listener.dispose(); listener.dispose();
      ctx.commands.register({id:'read',title:'Read',run:async () => { const draft = await ctx.composer.readDraft(); await ctx.composer.setText(draft.text,{expectedRevision:0}); }});
    }`, async (method, args, signal) => {
			calls.push({ method, args });
			if (method !== 'composer.readDraft') return null;
			signal!.addEventListener('abort', () => { aborted = true; });
			return new Promise(resolve => { resolveRead = resolve; });
		});
		await vi.waitFor(() => expect(calls.filter(call => call.method === 'events.remove')).toHaveLength(1));
		session.event('composer.changed', { revision: 1 });
		session.command('read', {});
		await vi.waitFor(() => expect(resolveRead).toBeTypeOf('function'));
		session.dispose(); session.dispose();
		expect(aborted).toBe(true);
		resolveRead!({ text: 'Stale' });
		await new Promise(resolve => setTimeout(resolve, 30));
		expect(calls.some(call => call.method === 'composer.setText')).toBe(false);
	});

	it('rejects forbidden registrations and bounds pathological subscription growth', async () => {
		await expect(start(`ctx => { ctx.composer.drawer.addItem({id:'denied',title:'No'}); }`, async () => { throw new Error('Capability not granted.'); })).rejects.toThrow('Capability not granted');
		await expect(start(`ctx => { for(let i=0;i<200;i++) ctx.composer.onDidChange(()=>{}); }`, async () => null)).rejects.toThrow(/limit/);
	});

	it('lets plugins handle a stale registration without terminating the activation or reporting cancellation as an error', async () => {
		const onError = vi.fn(), calls: string[] = [];
		const session = await start(`ctx => {
      ctx.commands.register({id:'publish',title:'Publish',run:async () => {
        const placeholder=ctx.composer.setPlaceholder('Stale',{expectedRevision:0});
        try { await placeholder.ready; } catch (_) { placeholder.dispose(); }
        await ctx.composer.getState();
      }});
    }`, async method => {
			calls.push(method);
			if (method === 'composer.setPlaceholder') throw new Error('Draft changed.');
			return null;
		}, { onError });
		session.command('publish', { composerRevision: 0 });
		await vi.waitFor(() => expect(calls).toContain('composer.getState'));
		expect(calls).not.toContain('diagnostics.report');
		expect(onError).not.toHaveBeenCalled();
	});

	it('serializes replacement of a named contribution behind removal of its prior instance', async () => {
		const calls: string[] = [];
		const session = await start(`ctx => {
      const old = ctx.composer.setPlaceholder('Old',{id:'same',expectedRevision:0});
      ctx.commands.register({id:'replace',title:'Replace',run:async () => {
        old.dispose();
        const replacement=ctx.composer.setPlaceholder('New',{id:'same',expectedRevision:0});
        await replacement.ready;
        old.dispose();
      }});
    }`, async (method, args) => {
			if (method === 'composer.placeholder.remove') { await new Promise(resolve => setTimeout(resolve, 30)); calls.push('remove'); }
			if (method === 'composer.setPlaceholder') calls.push(String(args.text));
			return null;
		});
		session.command('replace', {});
		await vi.waitFor(() => expect(calls).toEqual(['Old', 'remove', 'New']));
	});
});
