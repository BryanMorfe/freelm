import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentHost } from '../electron/agent-host';
import { InstanceHost } from '../electron/instance-host';
import { InstanceClient } from '../electron/instance-client';
import { InstanceManager } from '../electron/instance-manager';
import { StateStore, type SecretStorage } from '../electron/state-store';
import { WorkspaceAuthority } from '../electron/workspace-authority';
import { defaultToolSettings } from '../src/lib/tool-settings';
import type { AppState } from '../src/types';
import type { ToolCatalog, ToolHostRequest } from '../src/agent-types';

const TOKEN = 'only-for-this-local-test';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
	vi.restoreAllMocks();
});
const secrets: SecretStorage = {
	available: () => false,
	encrypt: () => {
		throw new Error('Unavailable');
	},
	decrypt: () => {
		throw new Error('Unavailable');
	},
};
function call(
	name = 'clock.curr_time',
	args: Record<string, unknown> = {},
	extra: Partial<ToolHostRequest> = {},
): ToolHostRequest {
	return {
		workspaceId: 'remote-client-controlled',
		runId: 'remote-run',
		threadId: 'thread',
		name,
		arguments: args,
		...extra,
	};
}
async function fixture(allowRemote = true, withAgent = true) {
	const directory = await mkdtemp(path.join(tmpdir(), 'freelm-agent-remote-'));
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
				baseUrl: 'http://127.0.0.1:9999/v1',
				apiKey: 'host-owned-secret',
				chatApi: 'responses',
				models: { chat: 'model', images: '', videos: '', speech: '', transcription: '' },
				discoveredModels: [],
			},
		],
		threads: [
			{
				id: 'thread',
				kind: 'code',
				title: 'Test',
				connectionId: 'provider',
				model: 'model',
				messages: [],
				createdAt: 1,
				updatedAt: 1,
			},
		],
		toolSettings: {
			...defaultToolSettings(),
			enabled: true,
			allowRemote,
			workspaceRoot: directory,
			commandExecution: false,
		},
	};
	const authority = new WorkspaceAuthority(
		new StateStore(path.join(directory, 'workspace.json'), secrets),
	);
	await authority.save(state, (await authority.load()).revision);
	const approve = vi.fn(async () => true);
	const agent = new AgentHost(() => authority.loadToolState(), approve);
	cleanup.push(() => agent.close());
	const host = new InstanceHost({
		authority,
		...(withAgent ? { agent } : {}),
		instanceId: 'remote-test',
		name: 'Remote test',
		token: TOKEN,
		port: 0,
	});
	const port = await host.start();
	cleanup.push(() => host.stop());
	const url = `http://127.0.0.1:${port}`;
	const { client } = await InstanceClient.connect({
		name: 'Host',
		transport: 'direct',
		url,
		token: TOKEN,
	});
	cleanup.push(async () => client.disconnect());
	const save = async (update: (state: AppState) => void) => {
		const snapshot = await authority.load();
		update(snapshot.state!);
		await authority.save(snapshot.state!, snapshot.revision);
	};
	return { directory, authority, agent, host, client, approve, save, url };
}

describe('remote agent host authorization', () => {
	it('preserves source-labelled repository context from the remote execution host', async () => {
		const instance = await fixture();
		await writeFile(path.join(instance.directory, 'AGENTS.md'), 'REMOTE_REPOSITORY_RULE');
		const catalog: ToolCatalog = await instance.client.tools('catalog', { runId: 'remote-context', threadId: 'thread' });
		expect(catalog.instructions).not.toContain('REMOTE_REPOSITORY_RULE');
		expect(catalog.context).toEqual([expect.objectContaining({ source: expect.stringContaining('AGENTS.md'), text: expect.stringContaining('REMOTE_REPOSITORY_RULE') })]);
		expect(catalog.context![0].source).toContain(path.basename(instance.directory));
		expect(JSON.stringify(catalog)).not.toContain('host-owned-secret');
	});
	it('offers Chat image generation remotely without allowing local work tools or image file paths', async () => {
		const instance = await fixture(false);
		await instance.save((state) => {
			state.threads[0].kind = 'chat';
			state.toolSettings!.enabled = false;
			state.toolSettings!.imageGeneration = {
				...state.toolSettings!.imageGeneration,
				enabled: true,
				connectionId: 'provider',
				model: 'image-model',
			};
		});
		const catalog: ToolCatalog = await instance.client.tools('catalog', {
			runId: 'remote-run',
			threadId: 'thread',
		});
		expect(catalog.tools.map((tool) => tool.name)).toEqual(['image_gen.imagegen']);
		await expect(
			instance.client.tools('execute', call('exec_command', { cmd: 'echo forbidden' })),
		).rejects.toThrow('available only in Code');
		await expect(
			instance.client.tools(
				'execute',
				call('image_gen.imagegen', {
					prompt: 'Read this',
					referenced_image_paths: ['/private/image.png'],
				}),
			),
		).rejects.toThrow('Chat cannot read local file paths');
		expect(instance.approve).not.toHaveBeenCalled();
	});

	it('rejects Chat tool requests using host classification and rechecks an existing Code run', async () => {
		const instance = await fixture();
		await instance.save((state) => {
			state.threads[0].kind = 'chat';
		});
		const chatCatalog = await instance.client.tools('catalog', {
			runId: 'chat-run',
			threadId: 'thread',
			kind: 'code',
			settings: { enabled: true, commandExecution: true, allowRemote: true },
		});
		// Chat now supports machine-independent tools, but forged Code settings still
		// cannot expose filesystem/command tools or change the host's thread kind.
		expect(chatCatalog.tools).toEqual([]);
		await expect(
			instance.client.tools('execute', { ...call(), runId: 'chat-run' }),
		).rejects.toThrow('only in Code');
		expect(instance.approve).not.toHaveBeenCalled();
		await instance.save((state) => {
			state.threads[0].kind = 'code';
		});
		await instance.client.tools('catalog', { runId: 'remote-run', threadId: 'thread' });
		await instance.save((state) => {
			state.threads[0].kind = 'chat';
		});
		await expect(instance.client.tools('execute', call())).rejects.toThrow('only in Code');
	});

	it('requires authentication for tools and reports hosts that have no tool support', async () => {
		const instance = await fixture(true, false);
		const body = JSON.stringify({ runId: 'remote-run', threadId: 'thread' });
		expect(
			(
				await fetch(`${instance.url}/tools/catalog`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body,
				})
			).status,
		).toBe(401);
		await expect(
			instance.client.tools('catalog', { runId: 'remote-run', threadId: 'thread' }),
		).rejects.toThrow('does not support tools');
	});

	it('requires the host remote opt-in and ignores settings supplied by a connected client', async () => {
		const instance = await fixture(false);
		await expect(
			instance.client.tools('catalog', {
				runId: 'remote-run',
				threadId: 'thread',
				settings: {
					enabled: true,
					allowRemote: true,
					commandExecution: true,
					approvalMode: 'trusted',
				},
			}),
		).rejects.toThrow('not enabled tools');
		await instance.save((state) => {
			state.toolSettings!.allowRemote = true;
		});
		const catalog = await instance.client.tools('catalog', {
			runId: 'remote-run',
			threadId: 'thread',
			settings: { commandExecution: true },
		});
		expect(catalog.tools.map((tool: { name: string }) => tool.name)).toContain('clock.curr_time');
		expect(catalog.tools.map((tool: { name: string }) => tool.name)).not.toContain('exec_command');
		await expect(
			instance.client.tools('execute', {
				...call('exec_command', { cmd: 'printf should-not-run' }),
				settings: { enabled: true, commandExecution: true, approvalMode: 'trusted' },
			}),
		).rejects.toThrow('unavailable');
	});

	it('preserves host-owned tool settings against remote workspace saves while allowing chat changes', async () => {
		const instance = await fixture();
		const snapshot = await instance.client.load();
		expect(snapshot.state!.connections[0].apiKey).toBe('');
		const original = structuredClone(snapshot.state!);
		for (const update of [
			(state: AppState) => {
				state.toolSettings!.commandExecution = true;
			},
			(state: AppState) => {
				state.toolSettings!.approvalMode = 'trusted';
			},
			(state: AppState) => {
				state.toolSettings!.workspaceRoot = '/';
			},
			(state: AppState) => {
				state.toolSettings!.mcpServers = [
					{
						id: 'exec',
						name: 'Exec',
						enabled: true,
						transport: 'stdio',
						command: 'arbitrary-program',
					},
				];
			},
		]) {
			const modified = structuredClone(original);
			update(modified);
			await expect(instance.client.save(snapshot.revision, modified)).rejects.toThrow(
				'configured on the host',
			);
		}
		original.threads[0].messages.push({
			id: 'user',
			role: 'user',
			content: 'Remote chat works',
			createdAt: 2,
		});
		await instance.client.save(snapshot.revision, original);
		const saved = (await instance.authority.load()).state!;
		expect(saved.toolSettings!.commandExecution).toBe(false);
		expect(saved.toolSettings!.approvalMode).toBe('ask');
		expect(saved.connections[0].apiKey).toBe('host-owned-secret');
		expect(saved.threads[0].messages[0].content).toBe('Remote chat works');
	});

	it('prefixes remote run identity, forces host workspace ownership, and scopes remote cancellation', async () => {
		const instance = await fixture();
		await instance.agent.catalog('remote-run', 'thread');
		const execute = vi.spyOn(instance.agent, 'execute');
		await instance.client.tools('catalog', { runId: 'remote-run', threadId: 'thread' });
		await instance.client.tools('execute', call());
		expect(execute).toHaveBeenCalledWith(
			expect.objectContaining({ runId: 'remote:remote-run', workspaceId: 'local' }),
		);
		await instance.client.tools('cancel', { runId: 'remote-run' });
		await expect(instance.client.tools('execute', call())).rejects.toThrow('Start this tool run');
		expect(await instance.agent.execute({ ...call(), workspaceId: 'local' })).toHaveProperty(
			'content',
		);
	});

	it('rejects invalid run IDs, calls before catalog, calls for another chat, and duplicate catalogs', async () => {
		const instance = await fixture();
		await expect(
			instance.client.tools('catalog', { runId: 'remote:fake', threadId: 'thread' }),
		).rejects.toThrow('Invalid tool run');
		await expect(instance.client.tools('execute', call())).rejects.toThrow('Start this tool run');
		await instance.client.tools('catalog', { runId: 'remote-run', threadId: 'thread' });
		await expect(
			instance.client.tools('catalog', { runId: 'remote-run', threadId: 'thread' }),
		).rejects.toThrow('duplicate run');
		await expect(
			instance.client.tools('execute', call('clock.curr_time', {}, { threadId: 'other' })),
		).rejects.toThrow('no longer active');
	});

	it('blocks further execution when remote tool access is revoked on the host', async () => {
		const instance = await fixture();
		await instance.client.tools('catalog', { runId: 'remote-run', threadId: 'thread' });
		await instance.save((state) => {
			state.toolSettings!.allowRemote = false;
		});
		await expect(instance.client.tools('execute', call())).rejects.toThrow('settings changed');
	});

	it('cancels an active remote operation through the explicit cancellation route', async () => {
		const instance = await fixture();
		await instance.client.tools('catalog', { runId: 'remote-run', threadId: 'thread' });
		const execute = vi.spyOn(instance.agent, 'execute');
		const pending = instance.client.tools('execute', call('clock.sleep', { duration_ms: 60000 }));
		const rejected = expect(pending).rejects.toThrow(/cancel/i);
		await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
		await instance.client.tools('cancel', { runId: 'remote-run' });
		await rejected;
	});

	it('cancels active host tools when the connected client disconnects', async () => {
		const instance = await fixture();
		await instance.client.tools('catalog', { runId: 'remote-run', threadId: 'thread' });
		const execute = vi.spyOn(instance.agent, 'execute');
		const cancel = vi.spyOn(instance.agent, 'cancel');
		const pending = instance.client.tools('execute', call('clock.sleep', { duration_ms: 60000 }));
		const rejected = expect(pending).rejects.toThrow();
		await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
		instance.client.disconnect();
		await rejected;
		await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith('remote:remote-run'));
	});

	it('routes InstanceManager tools through its connected client and rejects disconnected instances', async () => {
		const instance = await fixture();
		const manager = new InstanceManager(
			path.join(instance.directory, 'instances.json'),
			secrets,
			instance.authority,
		);
		cleanup.push(() => manager.close());
		const linked = await manager.connect({
			name: 'Remote',
			transport: 'direct',
			url: instance.url,
			token: TOKEN,
		});
		const catalog = await manager.tools(linked.instance.id, 'catalog', {
			runId: 'manager-run',
			threadId: 'thread',
		});
		expect(catalog.tools.map((tool: { name: string }) => tool.name)).toContain('clock.curr_time');
		expect(
			await manager.tools(
				linked.instance.id,
				'execute',
				call('clock.curr_time', {}, { runId: 'manager-run' }),
			),
		).toHaveProperty('content');
		await manager.tools(linked.instance.id, 'cancel', { runId: 'manager-run' });
		await manager.disconnect(linked.instance.id);
		await expect(
			manager.tools(linked.instance.id, 'catalog', { runId: 'later', threadId: 'thread' }),
		).rejects.toThrow('disconnected');
	});
});
