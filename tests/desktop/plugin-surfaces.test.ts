import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Connection, WireRequest, WireResponse } from '../../src/types';
import type { InstalledPlugin, PluginCapability, PluginLocalManifest } from '../../src/plugin-types';
import type { PluginSurfaceBinding, PluginSurfaceCall } from '../../src/plugin-surface-types';
import type { PluginHost } from '../../electron/plugins/host';
import type { PluginInferenceExecutor } from '../../electron/plugins/inference';

const runtimes = vi.hoisted(() => [] as { input: any; event: ReturnType<typeof vi.fn>; command: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }[]);
vi.mock('../../electron/plugins/surface-runtime', () => ({ startPluginSurfaceRuntime: vi.fn(async (input: any) => {
	const runtime = { input, event: vi.fn(), command: vi.fn(), dispose: vi.fn() };
	runtimes.push(runtime); return runtime;
}) }));
import { PluginSurfaceHost } from '../../electron/plugins/surfaces';

const hosts: PluginSurfaceHost[] = [];
afterEach(() => { hosts.splice(0).forEach(host => host.closeAll()); runtimes.length = 0; });
const model = { hostId: 'local', connectionId: 'fixture', modelId: 'fixture-model', thinkingModeId: 'low' };
const binding: PluginSurfaceBinding = { id: 'binding-1', composerId: 'composer-1', workspaceId: 'local', threadId: 'thread-1', theme: 'dark', surface: { kind: 'home', mode: 'chat' }, model };
function makeConnection(): Connection {
	return { id: 'fixture', name: 'Fixture', baseUrl: 'https://provider.invalid/v1', apiKey: 'host-owned-secret', chatApi: 'responses', models: { chat: 'fixture-model', images: '', videos: '', speech: '', transcription: '' }, discoveredModels: [], catalog: [{ id: 'fixture-model', name: 'Fixture', enabled: true, tasks: ['chat'], inputModalities: ['text'], outputModalities: ['text'], thinkingModes: [{ id: 'low', name: 'Low', parameters: { responses: { reasoning: { effort: 'low' } }, chat: { reasoning_effort: 'low' } } }] }] };
}
function plugin(capabilities: PluginCapability[]): InstalledPlugin {
	const manifest: PluginLocalManifest = { manifestVersion: 2, id: 'fixture.surface', name: 'Fixture surface', description: 'Isolated extension fixture.', version: '1', auth: { type: 'none' }, runtime: { apiVersion: 2, entry: 'index.ts' }, permissions: { network: [], storage: false, capabilities }, contributes: { tools: [], tabs: [], actions: [], activation: { surfaces: ['home.chat', 'home.code'] } } };
	return { manifest, enabled: true, installedAt: 1, settings: {}, grantedCapabilities: capabilities, surfaceAccess: { chat: true, code: true } } as InstalledPlugin;
}
function completed(text = 'Suggestion'): WireResponse {
	return { status: 200, contentType: 'application/json', encoding: 'text', body: JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 12 } }) };
}
function fixture(capabilities: PluginCapability[] = []) {
	const installed = plugin(capabilities), connection = makeConnection();
	let invalidate: (id: string) => void = () => {};
	const plugins = {
		snapshot: vi.fn(async () => ({ plugins: [structuredClone(installed)] })),
		surfacePackage: vi.fn(async () => ({ plugin: structuredClone(installed), code: 'fixture code' })),
		surfaceView: vi.fn(async () => ({ html: '<p>Fixture</p>' })),
		setSurfaceError: vi.fn(),
		onSurfaceInvalidation: (listener: (id: string) => void) => { invalidate = listener; return () => { invalidate = () => {}; }; },
	};
	const calls: PluginSurfaceCall[] = [];
	const execute = vi.fn<PluginInferenceExecutor>(async () => completed());
	const resolveConnection = vi.fn(async () => connection as Connection | undefined);
	let reply: ((call: PluginSurfaceCall) => unknown | Promise<unknown>) | undefined = call => call.method === 'conversation.getTurns'
		? { revision: 'r1', turns: [{ messages: [{ id: 'u1', role: 'user', text: 'Hello', createdAt: 1 }, { id: 'a1', role: 'assistant', text: 'Hi', createdAt: 2 }] }], truncated: false }
		: call.method === 'composer.getState' ? { revision: 7, empty: true, editable: true } : null;
	const busy = { value: false };
	const host = new PluginSurfaceHost({
		plugins: plugins as unknown as PluginHost,
		connection: resolveConnection,
		execute,
		foregroundBusy: () => busy.value,
		viewURL: () => 'freelm-plugin://fixture',
		emit: (owner, call) => {
			calls.push(call);
			if (!call.requestId || !reply) return;
			void Promise.resolve().then(() => reply!(call)).then(result => host.reply(owner, call.sessionId, call.requestId, { result }), error => host.reply(owner, call.sessionId, call.requestId, { error: String(error) }));
		},
	});
	hosts.push(host);
	return { host, installed, connection, execute, resolveConnection, calls, plugins, busy, invalidate: () => invalidate(installed.manifest.id), setReply: (next: typeof reply) => { reply = next; } };
}
async function open(f: ReturnType<typeof fixture>, owner = 1, value = binding) {
	const { sessions } = await f.host.open(owner, value);
	await f.host.activate(owner, sessions.map(session => session.id));
	return sessions[0].id;
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => { resolve = done; });
	return { promise, resolve };
}

describe('native surface capability broker', () => {
	it('allows an accountless drawer without a selected model and enforces independent grants', async () => {
		const f = fixture(['composer.drawer', 'composer.state', 'inference.text']);
		const id = await open(f, 1, { ...binding, model: undefined });
		await expect(f.host.viewCall(1, id, 'composer.drawer.addItem', { id: 'row', title: 'Ready' })).resolves.toBeNull();
		await expect(f.host.viewCall(1, id, 'composer.getState', {})).resolves.toMatchObject({ revision: 7 });
		await expect(f.host.viewCall(1, id, 'composer.readDraft', {})).rejects.toThrow('composer.read');
		await expect(f.host.viewCall(1, id, 'inference.generateText', { messages: [] })).rejects.toThrow('Select a conversation model');
		expect(() => f.host.viewCall(99, id, 'composer.getState', {})).toThrow('expired');
		f.host.close(99, [id]);
		await expect(f.host.viewCall(1, id, 'composer.getState', {})).resolves.toBeTruthy();
	});

	it('separates state events from text/selection access and records recoverable errors', async () => {
		const f = fixture(['composer.state']), id = await open(f);
		await f.host.viewCall(1, id, 'events.subscribe', { id: 'state', name: 'composer.stateChanged' });
		await expect(f.host.viewCall(1, id, 'events.subscribe', { id: 'selection', name: 'composer.selectionChanged' })).rejects.toThrow('composer.read');
		f.host.event(1, id, 'composer.stateChanged', { revision: 3, running: true, text: 'Do not leak draft', attachments: ['secret'] });
		expect(runtimes[0].event).toHaveBeenCalledWith('composer.stateChanged', { revision: 3, running: true });
		await f.host.viewCall(1, id, 'diagnostics.report', { message: 'Try again later.' });
		expect(f.plugins.setSurfaceError).toHaveBeenLastCalledWith('fixture.surface', 'Try again later.');
		await expect(f.host.viewCall(1, id, 'composer.getState', {})).resolves.toBeTruthy();
	});

	it('gates declarative actions including aliases and sends view commands through the native composer', async () => {
		const f = fixture(['commands']), id = await open(f);
		await expect(f.host.viewCall(1, id, 'commands.register', { id: 'bad', title: 'Bad', hostAction: { type: 'composer.setText', text: 'Overwrite', expectedRevision: 1 } })).rejects.toThrow('composer.write');
		await f.host.viewCall(1, id, 'commands.register', { id: 'prepare', title: 'Prepare' });
		await f.host.viewCall(1, id, 'commands.run', { id: 'prepare', payload: { content: 'Action data' } });
		expect(f.calls.at(-1)).toMatchObject({ method: 'commands.run', args: { id: 'prepare', payload: { content: 'Action data' } } });
		await expect(f.host.viewCall(1, id, 'commands.run', { id: 'missing' })).rejects.toThrow('not registered');
		const powerful = fixture(['commands', 'composer.write']), other = await open(powerful);
		await expect(powerful.host.viewCall(1, other, 'commands.register', { id: 'bad', title: 'Bad', action: { type: 'composer.attachments.add', asset: { dataUrl: 'data:text/plain;base64,c2VjcmV0' } } })).rejects.toThrow('Unsupported declarative');
	});

	it('creates opaque assets and refuses resources from other activations or filesystem paths', async () => {
		const f = fixture(['assets.create', 'composer.attachments']);
		const one = await open(f, 1), two = await open(f, 2);
		const asset = await f.host.viewCall(1, one, 'assets.create', { name: 'report.txt', mimeType: 'text/plain', text: 'Report' }) as Record<string, unknown>;
		expect(asset).toMatchObject({ name: 'report.txt', mimeType: 'text/plain', size: 6 });
		expect(asset).not.toHaveProperty('dataUrl');
		await f.host.viewCall(1, one, 'composer.attachments.add', { asset, expectedRevision: 7 });
		expect(f.calls.at(-1)?.args.asset).toMatchObject({ dataUrl: 'data:text/plain;base64,UmVwb3J0' });
		await expect(f.host.viewCall(2, two, 'composer.attachments.add', { asset, expectedRevision: 7 })).rejects.toThrow('does not belong');
		await expect(f.host.viewCall(1, one, 'assets.create', { name: 'secret', mimeType: 'text/plain', path: '/private/file' })).rejects.toThrow('Invalid plugin asset');
		await expect(f.host.viewCall(1, one, 'composer.attachments.read', { id: asset.id })).rejects.toThrow('composer.attachments.read');
	});

	it('invalidates context handles even without change listeners, and rejects context that changed during a read', async () => {
		const f = fixture(['conversation.read', 'inference.text']), id = await open(f);
		const snapshot = await f.host.viewCall(1, id, 'conversation.getTurns', { limit: 3 }) as { snapshotId: string };
		f.host.event(1, id, 'conversation.changed', { revision: 'r2' });
		await expect(f.host.viewCall(1, id, 'inference.generateText', { model: { source: 'conversation' }, messages: [], snapshotId: snapshot.snapshotId })).rejects.toThrow('snapshot expired');
		const waiting = deferred<unknown>(); f.setReply(() => waiting.promise);
		const read = f.host.viewCall(1, id, 'conversation.getTurns', { limit: 3 });
		f.host.event(1, id, 'conversation.changed', { revision: 'r3' });
		waiting.resolve({ turns: [], revision: 'r2' });
		await expect(read).rejects.toThrow('Conversation changed');
	});

	it('checks snapshots again after waiting for foreground work, without dispatching stale inference', async () => {
		const f = fixture(['conversation.read', 'inference.text']), id = await open(f);
		const snapshot = await f.host.viewCall(1, id, 'conversation.getTurns', { limit: 1 }) as { snapshotId: string };
		f.busy.value = true;
		const inference = f.host.viewCall(1, id, 'inference.generateText', { messages: [], snapshotId: snapshot.snapshotId });
		f.host.event(1, id, 'conversation.changed', {}); f.busy.value = false;
		await expect(inference).rejects.toThrow('snapshot expired');
		expect(f.execute).not.toHaveBeenCalled();
	});

	it('routes the exact current or explicitly configured model, while keeping remote credentials on its host', async () => {
		const f = fixture(['inference.text']);
		const remote = { ...model, hostId: 'remote-host' };
		const id = await open(f, 1, { ...binding, workspaceId: 'remote-host', model: remote });
		await expect(f.host.viewCall(1, id, 'inference.generateText', { messages: [{ role: 'user', content: 'Hello' }], maxOutputTokens: 512 })).resolves.toMatchObject({ text: 'Suggestion', model: remote });
		expect(f.resolveConnection).toHaveBeenCalledWith('remote-host', 'fixture');
		expect(f.execute.mock.calls[0][0]).toBe('remote-host');
		expect(f.execute.mock.calls[0][1]).toMatchObject({ apiKey: '', baseUrl: '', workspaceId: 'remote-host' });
		await expect(f.host.viewCall(1, id, 'inference.generateText', { model: { source: 'configured', ...model }, messages: [] })).rejects.toThrow('plugin settings');
		f.installed.settings = { model: { source: 'configured', ...model } };
		const approved = await open(f, 1, { ...binding, workspaceId: 'remote-host', model: remote });
		await f.host.viewCall(1, approved, 'inference.generateText', { model: { source: 'configured', ...model }, messages: [] });
		expect(f.execute.mock.calls.at(-1)?.[0]).toBe('local');
	});

	it('cancels inference and pending UI work on close or grant invalidation', async () => {
		const f = fixture(['inference.text', 'composer.read']), id = await open(f);
		let signal: AbortSignal | undefined;
		f.execute.mockImplementation(async (_host, _request, _chunk, incoming) => {
			signal = incoming;
			return new Promise((_resolve, reject) => incoming.addEventListener('abort', () => reject(new Error('Aborted provider')), { once: true }));
		});
		const inference = f.host.viewCall(1, id, 'inference.generateText', { messages: [] });
		const rejectedInference = expect(inference).rejects.toThrow('Aborted provider');
		await vi.waitFor(() => expect(signal).toBeDefined());
		f.setReply(undefined);
		const draft = f.host.viewCall(1, id, 'composer.readDraft', {});
		const rejectedDraft = expect(draft).rejects.toThrow(/cancelled|closed/);
		f.invalidate();
		await Promise.all([rejectedInference, rejectedDraft]);
		expect(signal?.aborted).toBe(true);
		expect(runtimes[0].dispose).toHaveBeenCalledOnce();
		expect(() => f.host.viewCall(1, id, 'composer.readDraft', {})).toThrow('expired');
	});

	it('cannot recreate a closed owner from an earlier pending open', async () => {
		const f = fixture(), firstSnapshot = deferred<{ plugins: InstalledPlugin[] }>();
		f.plugins.snapshot.mockImplementationOnce(() => firstSnapshot.promise);
		const first = f.host.open(1, binding);
		const second = await f.host.open(1, { ...binding, id: 'new-binding' });
		firstSnapshot.resolve({ plugins: [f.installed] });
		await expect(first).resolves.toEqual({ sessions: [] });
		expect(second.sessions).toHaveLength(1);
		const thirdPackage = deferred<{ plugin: InstalledPlugin; code: string }>();
		f.plugins.surfacePackage.mockImplementationOnce(() => thirdPackage.promise);
		const third = f.host.open(1, binding);
		await vi.waitFor(() => expect(f.plugins.surfacePackage).toHaveBeenCalledTimes(2));
		f.host.closeOwner(1); thirdPackage.resolve({ plugin: f.installed, code: 'old' });
		await expect(third).resolves.toEqual({ sessions: [] });
	});

	it('cannot activate an outdated package if grants change while loading it', async () => {
		const f = fixture(), read = deferred<{ plugin: InstalledPlugin; code: string }>();
		f.plugins.surfacePackage.mockImplementationOnce(() => read.promise);
		const pending = f.host.open(1, binding);
		await vi.waitFor(() => expect(f.plugins.surfacePackage).toHaveBeenCalled());
		f.invalidate(); read.resolve({ plugin: f.installed, code: 'outdated' });
		await expect(pending).resolves.toEqual({ sessions: [] });
	});

	it('isolates a broken package while returning every healthy session for activation and cleanup', async () => {
		const f = fixture(['composer.state']);
		const broken = structuredClone(f.installed), later = structuredClone(f.installed);
		broken.manifest.id = 'fixture.broken'; later.manifest.id = 'fixture.later';
		f.plugins.snapshot.mockResolvedValueOnce({ plugins: [f.installed, broken, later] });
		f.plugins.surfacePackage
			.mockResolvedValueOnce({ plugin: f.installed, code: 'healthy first' })
			.mockRejectedValueOnce(new Error('Plugin bundle is missing.'))
			.mockResolvedValueOnce({ plugin: later, code: 'healthy later' });
		const { sessions } = await f.host.open(1, binding);
		expect(sessions.map(session => session.pluginId)).toEqual(['fixture.surface', 'fixture.later']);
		expect(f.plugins.setSurfaceError).toHaveBeenCalledWith('fixture.broken', 'Plugin bundle is missing.');
		await f.host.activate(1, sessions.map(session => session.id));
		expect(runtimes).toHaveLength(2);
		for (const session of sessions) await expect(f.host.viewCall(1, session.id, 'composer.getState', {})).resolves.toMatchObject({ revision: 7 });
		f.host.close(1, sessions.map(session => session.id));
		expect(runtimes.every(runtime => runtime.dispose.mock.calls.length === 1)).toBe(true);
		expect(f.calls.filter(call => call.method === '$disposed').map(call => call.sessionId)).toEqual(sessions.map(session => session.id));
		for (const session of sessions) expect(() => f.host.viewCall(1, session.id, 'composer.getState', {})).toThrow('expired');
		f.host.closeOwner(1);
		expect(f.calls.filter(call => call.method === '$disposed')).toHaveLength(2);
	});
});
