import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentHost } from '../electron/agent-host';
import { InstanceHost } from '../electron/instance-host';
import { InstanceClient } from '../electron/instance-client';
import { StateStore, type SecretStorage } from '../electron/state-store';
import { WorkspaceAuthority } from '../electron/workspace-authority';
import { ToolRuntime } from '../electron/tools/runtime';
import { MCPRuntime } from '../electron/tools/mcp';
import { WebRuntime } from '../electron/tools/web';
import { defaultToolSettings } from '../src/lib/tool-settings';
import type { AppState, ConversationKind } from '../src/types';
import type { ToolCatalog, ToolHostRequest, ToolResult, WebServiceInfo } from '../src/agent-types';

const cleanup: (() => Promise<unknown>)[] = [];
const webResult: ToolResult = {
	content: [{ type: 'text', text: 'Search results: [Example](https://example.com/)' }],
};
const secrets: SecretStorage = {
	available: () => false,
	encrypt: () => {
		throw new Error('Not available in this fixture.');
	},
	decrypt: () => {
		throw new Error('Not available in this fixture.');
	},
};
beforeEach(() => {
	vi.spyOn(WebRuntime.prototype, 'execute').mockResolvedValue(structuredClone(webResult));
});
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
	vi.restoreAllMocks();
});

function call(extra: Partial<ToolHostRequest> = {}): ToolHostRequest {
	return {
		workspaceId: 'local',
		runId: 'run',
		threadId: 'thread',
		name: 'web.run',
		arguments: { search_query: [{ q: 'test search' }] },
		...extra,
	};
}

async function fixture(kind: ConversationKind = 'chat') {
	const directory = await mkdtemp(path.join(tmpdir(), 'freelm-web-host-'));
	cleanup.push(() => rm(directory, { recursive: true, force: true }));
	const state: AppState = {
		version: 1,
		theme: 'dark',
		activeConnectionId: 'provider',
		projects: [],
		generations: [],
		connections: [
			{
				id: 'provider',
				name: 'Provider',
				baseUrl: 'http://provider.invalid/v1',
				apiKey: 'host-owned-secret',
				chatApi: 'responses',
				models: { chat: 'model', images: '', videos: '', speech: '', transcription: '' },
				discoveredModels: [],
			},
		],
		threads: [
			{
				id: 'thread',
				kind,
				title: 'Web fixture',
				connectionId: 'provider',
				model: 'model',
				messages: [],
				createdAt: 1,
				updatedAt: 1,
			},
		],
		toolSettings: {
			...defaultToolSettings(),
			enabled: kind === 'code',
			allowRemote: false,
			workspaceRoot: directory,
			commandExecution: true,
			webBrowsing: { enabled: true, searxngUrl: 'http://search.invalid/searxng/' },
		},
	};
	const approve = vi.fn(async () => true);
	const host = new AgentHost(async () => structuredClone(state), approve);
	cleanup.push(() => host.close());
	return { directory, state, host, approve };
}

async function remoteFixture() {
	const local = await fixture();
	const authority = new WorkspaceAuthority(
		new StateStore(path.join(local.directory, 'workspace.json'), secrets),
	);
	await authority.save(local.state, (await authority.load()).revision);
	const agent = new AgentHost(() => authority.loadToolState(), local.approve);
	cleanup.push(() => agent.close());
	const instance = new InstanceHost({
		authority,
		agent,
		instanceId: 'web-remote-fixture',
		name: 'Web fixture',
		token: 'isolated-test-token',
		port: 0,
	});
	const port = await instance.start();
	cleanup.push(() => instance.stop());
	const { client } = await InstanceClient.connect({
		name: 'Web fixture',
		transport: 'direct',
		url: `http://127.0.0.1:${port}`,
		token: 'isolated-test-token',
	});
	cleanup.push(async () => client.disconnect());
	const save = async (update: (state: AppState) => void) => {
		const snapshot = await authority.load();
		update(snapshot.state!);
		await authority.save(snapshot.state!, snapshot.revision);
	};
	return { ...local, authority, agent, client, save };
}

describe('host-owned web browsing in Chat and Code', () => {
	it('routes built-in Chat browsing to the host service without changing saved settings or starting work tools', async () => {
		const local = await fixture();
		local.state.toolSettings!.webBrowsing = {
			enabled: true,
			mode: 'builtin',
			autoStart: false,
			searxngUrl: 'http://external-preserved.invalid',
			engines: ['bing'],
		};
		const before = structuredClone(local.state);
		const resolve = vi.fn(() => 'http://127.0.0.1:12345');
		const host = new AgentHost(async () => structuredClone(local.state), local.approve, resolve);
		cleanup.push(() => host.close());
		const runtime = vi.spyOn(ToolRuntime.prototype, 'catalog');
		expect((await host.catalog('run', 'thread')).tools.map((tool) => tool.name)).toEqual([
			'web.run',
			'image.view',
		]);
		await host.execute(call());
		expect(resolve).toHaveBeenCalledWith(before.toolSettings!.webBrowsing);
		expect(WebRuntime.prototype.execute).toHaveBeenCalledWith(
			call(),
			expect.objectContaining({ searxngUrl: 'http://127.0.0.1:12345' }),
			expect.any(AbortSignal),
		);
		expect(local.state).toEqual(before);
		expect(runtime).not.toHaveBeenCalled();
	});
	it('reports a stopped bundled service before issuing a web request', async () => {
		const local = await fixture();
		local.state.toolSettings!.webBrowsing = {
			enabled: true,
			mode: 'builtin',
			searxngUrl: '',
			engines: ['bing'],
		};
		const host = new AgentHost(
			async () => structuredClone(local.state),
			local.approve,
			() => {
				throw new Error('Start the built-in search service in Settings → Search before browsing.');
			},
		);
		cleanup.push(() => host.close());
		await host.catalog('run', 'thread');
		await expect(host.execute(call())).rejects.toThrow('Start the built-in');
		expect(WebRuntime.prototype.execute).not.toHaveBeenCalled();
	});
	it('discovers a draft service URL without loading provider credentials or starting work tools', async () => {
		const { host, state } = await fixture();
		const before = structuredClone(state);
		const info: WebServiceInfo = {
			serviceUrl: 'http://draft.invalid/',
			version: 'fixture',
			categories: ['general'],
			engines: [],
			health: 'ok',
			notices: [],
		};
		const discover = vi.spyOn(WebRuntime.prototype, 'discover').mockResolvedValue(info);
		const catalog = vi.spyOn(ToolRuntime.prototype, 'catalog');
		expect(await host.discoverWeb(info.serviceUrl)).toEqual(info);
		expect(discover).toHaveBeenCalledWith(info.serviceUrl, expect.any(AbortSignal));
		expect(catalog).not.toHaveBeenCalled();
		expect(state).toEqual(before);
	});

	it('bounds concurrent service discovery and cancels it with the host', async () => {
		const { host } = await fixture();
		vi.spyOn(WebRuntime.prototype, 'discover').mockImplementation(
			async (_url, signal) =>
				await new Promise((_resolve, reject) => {
					signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true });
				}),
		);
		const pending = Array.from({ length: 4 }, () => host.discoverWeb('http://draft.invalid'));
		await expect(host.discoverWeb('http://draft.invalid')).rejects.toThrow('busy');
		host.cancelAll();
		const outcomes = await Promise.allSettled(pending);
		expect(outcomes.every((outcome) => outcome.status === 'rejected')).toBe(true);
	});

	it('offers and executes web browsing in Chat with Code and image tools disabled', async () => {
		const { state, host, approve } = await fixture();
		state.toolSettings!.workspaceRoot = '/missing-chat-workspace';
		state.toolSettings!.skillDirectories = ['/missing-chat-skills'];
		state.toolSettings!.mcpServers = [
			{
				id: 'never-start',
				name: 'Never start',
				enabled: true,
				transport: 'stdio',
				command: 'must-not-run',
			},
		];
		const localCatalog = vi.spyOn(ToolRuntime.prototype, 'catalog');
		const localExecute = vi.spyOn(ToolRuntime.prototype, 'execute');
		const discover = vi.spyOn(MCPRuntime.prototype, 'discover');
		const catalog = await host.catalog('run', 'thread');
		expect(catalog.tools.map((tool) => tool.name)).toEqual(['web.run', 'image.view']);
		expect(catalog.instructions).toMatch(/web|brows|search/i);
		expect(catalog.tools[0].parameters.properties).not.toHaveProperty('searxngUrl');
		expect(await host.execute(call())).toEqual(webResult);
		expect(WebRuntime.prototype.execute).toHaveBeenCalledWith(
			call(),
			state.toolSettings!.webBrowsing,
			expect.any(AbortSignal),
		);
		expect(localCatalog).not.toHaveBeenCalled();
		expect(localExecute).not.toHaveBeenCalled();
		expect(discover).not.toHaveBeenCalled();
		expect(approve).not.toHaveBeenCalled();
	});

	it('advertises image generation and web browsing together while keeping Chat machine-independent', async () => {
		const { state, host } = await fixture();
		state.toolSettings!.imageGeneration = {
			enabled: true,
			connectionId: 'provider',
			model: 'image-model',
			size: '1024x1024',
			quality: '',
		};
		const catalog = await host.catalog('run', 'thread');
		expect(catalog.tools.map((tool) => tool.name).sort()).toEqual([
			'image.view',
			'image_gen.imagegen',
			'web.run',
		]);
		for (const name of [
			'exec_command',
			'write_stdin',
			'apply_patch',
			'view_image',
			'skills.read',
			'tool_search',
			'read_mcp_resource',
		]) {
			await expect(host.execute(call({ name, arguments: {} }))).rejects.toThrow(
				'available only in Code',
			);
		}
		await expect(
			host.execute(
				call({
					name: 'image_gen.imagegen',
					arguments: {
						prompt: 'Read private files',
						referenced_image_paths: ['/private/secret.png'],
					},
				}),
			),
		).rejects.toThrow('Chat cannot read local file paths');
		expect(WebRuntime.prototype.execute).not.toHaveBeenCalled();
	});

	it.each([
		{ label: 'disabled', config: { enabled: false, searxngUrl: 'http://search.invalid/' } },
		{ label: 'legacy settings', config: undefined },
	])('does not offer an unavailable web capability: $label', async ({ config }) => {
		const { state, host } = await fixture();
		state.toolSettings!.webBrowsing = config;
		const localCatalog = vi.spyOn(ToolRuntime.prototype, 'catalog');
		const offered = await host.catalog('run', 'thread');
		expect(offered.tools).toEqual([]);
		expect(offered.context ?? []).toEqual([]);
		expect(offered.codeCapabilities).toBeUndefined();
		await expect(host.execute(call())).rejects.toThrow('unavailable');
		expect(localCatalog).not.toHaveBeenCalled();
		expect(WebRuntime.prototype.execute).not.toHaveBeenCalled();
		host.cancel('run');
		state.toolSettings!.webBrowsing = { enabled: true, searxngUrl: 'http://search.invalid/' };
		expect((await host.catalog('run', 'thread')).tools.map((tool) => tool.name)).toEqual([
			'web.run',
			'image.view',
		]);
	});

	it('rejects malformed enabled web settings before Chat tool discovery and accepts corrected settings', async () => {
		const { state, host } = await fixture();
		state.toolSettings!.webBrowsing = { enabled: true, searxngUrl: '' };
		const localCatalog = vi.spyOn(ToolRuntime.prototype, 'catalog');
		await expect(host.catalog('run', 'thread')).rejects.toThrow(/Enable|SearXNG/i);
		expect(localCatalog).not.toHaveBeenCalled();
		expect(WebRuntime.prototype.execute).not.toHaveBeenCalled();
		state.toolSettings!.webBrowsing = { enabled: true, searxngUrl: 'http://search.invalid/' };
		const offered = await host.catalog('run', 'thread');
		expect(offered.tools.map((tool) => tool.name)).toEqual(['web.run', 'image.view']);
		expect(offered.context ?? []).toEqual([]);
		expect(localCatalog).not.toHaveBeenCalled();
	});

	it('does not let model arguments replace the host search service', async () => {
		const { state, host } = await fixture();
		await host.catalog('run', 'thread');
		const request = call({
			arguments: {
				search_query: [{ q: 'test search' }],
				searxngUrl: 'https://model-selected.invalid/',
				settings: { webBrowsing: { enabled: true, searxngUrl: 'https://override.invalid/' } },
			},
		});
		await host.execute(request);
		expect(WebRuntime.prototype.execute).toHaveBeenCalledWith(
			request,
			state.toolSettings!.webBrowsing,
			expect.any(AbortSignal),
		);
	});

	it.each(['enabled', 'url'] as const)(
		'revokes an old Chat run after its web %s changes',
		async (change) => {
			const { state, host } = await fixture();
			await host.catalog('run', 'thread');
			if (change === 'enabled') state.toolSettings!.webBrowsing!.enabled = false;
			else state.toolSettings!.webBrowsing!.searxngUrl = 'http://different.invalid/';
			await expect(host.execute(call())).rejects.toThrow('settings changed');
			expect(WebRuntime.prototype.execute).not.toHaveBeenCalled();
			await expect(host.execute(call())).rejects.toThrow('no longer active');
		},
	);

	it('rejects a stale result when host settings change during a web request', async () => {
		const { state, host } = await fixture();
		let finish!: (value: ToolResult) => void;
		vi.mocked(WebRuntime.prototype.execute).mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		await host.catalog('run', 'thread');
		const pending = host.execute(call());
		const rejected = expect(pending).rejects.toThrow('settings changed');
		await vi.waitFor(() => expect(WebRuntime.prototype.execute).toHaveBeenCalledOnce());
		const signal = vi.mocked(WebRuntime.prototype.execute).mock.calls[0][2];
		state.toolSettings!.webBrowsing!.enabled = false;
		finish(webResult);
		await rejected;
		expect(signal.aborted).toBe(true);
	});

	it('rechecks the host conversation kind before dispatching a web request', async () => {
		const { state, host } = await fixture();
		await host.catalog('run', 'thread');
		state.threads[0].kind = 'code';
		await expect(host.execute(call())).rejects.toThrow('kind changed');
		expect(WebRuntime.prototype.execute).not.toHaveBeenCalled();
	});

	it.each(['cancel', 'close'] as const)(
		'aborts an active web request on %s and discards its result',
		async (operation) => {
			const { host } = await fixture();
			let finish!: (value: ToolResult) => void;
			vi.mocked(WebRuntime.prototype.execute).mockImplementation(
				() =>
					new Promise((resolve) => {
						finish = resolve;
					}),
			);
			const cancel = vi.spyOn(WebRuntime.prototype, 'cancel');
			await host.catalog('run', 'thread');
			const pending = host.execute(call());
			const rejected = expect(pending).rejects.toThrow(/cancel/i);
			await vi.waitFor(() => expect(WebRuntime.prototype.execute).toHaveBeenCalledOnce());
			const signal = vi.mocked(WebRuntime.prototype.execute).mock.calls[0][2];
			if (operation === 'close') await host.close();
			else host.cancel('run');
			expect(signal.aborted).toBe(true);
			expect(cancel).toHaveBeenCalledWith('run');
			finish(webResult);
			await rejected;
		},
	);

	it('includes the configured web capability in Code and settings inspection', async () => {
		const { state, host } = await fixture('code');
		const catalog = await host.catalog('run', 'thread');
		expect(catalog.tools.map((tool) => tool.name)).toContain('web.run');
		expect(catalog.tools.map((tool) => tool.name)).toContain('exec_command');
		expect(await host.execute(call())).toEqual(webResult);
		const inspection = await host.inspect(state.toolSettings!);
		expect(inspection.tools.map((tool) => tool.name)).toContain('web.run');
	});

	it('requires Code enablement even when web browsing is configured', async () => {
		const { state, host } = await fixture('code');
		state.toolSettings!.enabled = false;
		await expect(host.catalog('run', 'thread')).rejects.toThrow('Enable Code tools');
		expect(WebRuntime.prototype.execute).not.toHaveBeenCalled();
	});

	it('omits a disabled web tool from Code and settings inspection', async () => {
		const { state, host } = await fixture('code');
		state.toolSettings!.webBrowsing!.enabled = false;
		expect((await host.catalog('run', 'thread')).tools.map((tool) => tool.name)).not.toContain(
			'web.run',
		);
		expect((await host.inspect(state.toolSettings!)).tools.map((tool) => tool.name)).not.toContain(
			'web.run',
		);
		await expect(host.execute(call())).rejects.toThrow('unavailable');
		expect(WebRuntime.prototype.execute).not.toHaveBeenCalled();
	});
});

describe('remote host web browsing ownership', () => {
	it('allows remote Chat web browsing without Code opt-in and dispatches using host settings', async () => {
		const instance = await remoteFixture();
		const catalog: ToolCatalog = await instance.client.tools('catalog', {
			runId: 'run',
			threadId: 'thread',
			kind: 'code',
			settings: {
				enabled: true,
				allowRemote: true,
				webBrowsing: { enabled: true, searxngUrl: 'https://client-selected.invalid/' },
			},
		});
		expect(catalog.tools.map((tool) => tool.name)).toEqual(['web.run', 'image.view']);
		expect(
			await instance.client.tools('execute', call({ workspaceId: 'client-controlled' })),
		).toEqual(webResult);
		expect(WebRuntime.prototype.execute).toHaveBeenCalledWith(
			expect.objectContaining({ workspaceId: 'local', runId: 'remote:run' }),
			instance.state.toolSettings!.webBrowsing,
			expect.any(AbortSignal),
		);
		await expect(
			instance.client.tools(
				'execute',
				call({ name: 'exec_command', arguments: { cmd: 'must not run' } }),
			),
		).rejects.toThrow('available only in Code');
		expect(instance.approve).not.toHaveBeenCalled();
	});

	it('does not accept web settings supplied by a remote catalog or workspace save', async () => {
		const instance = await remoteFixture();
		const snapshot = await instance.client.load();
		const modified = structuredClone(snapshot.state!);
		modified.toolSettings!.webBrowsing!.searxngUrl = 'https://client-selected.invalid/';
		await expect(instance.client.save(snapshot.revision, modified)).rejects.toThrow(
			'configured on the host',
		);
		await instance.save((state) => {
			state.toolSettings!.webBrowsing!.enabled = false;
		});
		const localCatalog = vi.spyOn(ToolRuntime.prototype, 'catalog');
		const offered: ToolCatalog = await instance.client.tools('catalog', {
			runId: 'run',
			threadId: 'thread',
			settings: {
				webBrowsing: { enabled: true, searxngUrl: 'https://client-selected.invalid/' },
			},
		});
		expect(offered.tools).toEqual([]);
		expect(offered.context ?? []).toEqual([]);
		expect(offered.codeCapabilities).toBeUndefined();
		await expect(instance.client.tools('execute', call())).rejects.toThrow('unavailable');
		expect(localCatalog).not.toHaveBeenCalled();
		expect(instance.approve).not.toHaveBeenCalled();
		expect(WebRuntime.prototype.execute).not.toHaveBeenCalled();
	});

	it('rechecks host settings before remote execution and retains the Code remote opt-in', async () => {
		const instance = await remoteFixture();
		await instance.client.tools('catalog', { runId: 'run', threadId: 'thread' });
		await instance.save((state) => {
			state.toolSettings!.webBrowsing!.enabled = false;
		});
		await expect(instance.client.tools('execute', call())).rejects.toThrow('settings changed');
		expect(WebRuntime.prototype.execute).not.toHaveBeenCalled();
		await instance.save((state) => {
			state.threads[0].kind = 'code';
			state.toolSettings!.enabled = true;
			state.toolSettings!.webBrowsing!.enabled = true;
		});
		await expect(
			instance.client.tools('catalog', { runId: 'code-run', threadId: 'thread' }),
		).rejects.toThrow('not enabled tools');
	});
});
