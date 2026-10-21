import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../../src/types';
import { applyWorkspacePatch, type WorkspacePatch } from '../../src/workspace-patch';
import { personalizationFixture } from '../fixtures/personalization';
import { mergeWorkspaceState } from '../../src/lib/workspace-merge';

const state = (): AppState => ({
	version: 1,
	activeConnectionId: 'provider',
	theme: 'dark',
	threads: [],
	projects: [],
	generations: [],
	connections: [
		{
			id: 'provider',
			name: 'Provider',
			baseUrl: 'http://localhost:8000/v1',
			apiKey: 'host-secret',
			chatApi: 'responses',
			models: {
				chat: 'chat',
				images: 'image',
				videos: 'video',
				speech: 'speech',
				transcription: 'transcribe',
			},
			discoveredModels: [],
		},
	],
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
});

describe('workspace-aware renderer persistence', () => {
	it('does not hydrate the workspace for a host notification at the accepted revision', async () => {
		const original = state();
		const load = vi.fn(async () => ({
			revision: 'host:1',
			state: { ...original, theme: 'light' as const },
		}));
		vi.stubGlobal('window', { desktop: { hostTasksSnapshot: vi.fn(), workspaceLoad: load } });
		const storage = await import('../../src/lib/storage');
		storage.acceptWorkspaceSnapshot('local', { revision: 'host:0', state: original });
		const apply = vi.fn();
		storage.onWorkspaceRebased(() => apply);
		await storage.refreshHostWorkspace('host:0');
		expect(load).not.toHaveBeenCalled();
		expect(apply).not.toHaveBeenCalled();
		await storage.refreshHostWorkspace('host:1');
		expect(load).toHaveBeenCalledTimes(1);
		expect(apply).toHaveBeenCalledTimes(1);
		await storage.refreshHostWorkspace('host:1');
		expect(load).toHaveBeenCalledTimes(1);
	});
	it('keeps a rejected host refresh from replacing the baseline or overwriting a host checkpoint', async () => {
		const original = state();
		let canonical = { ...original, systemPrompt: 'Host update' };
		let revision = 'host:1';
		let local = { ...original, systemPrompt: 'Unsaved local edit' };
		const patch = vi.fn(async (_target: string, expected: string, value: WorkspacePatch) => {
			if (expected !== revision) throw new Error('WORKSPACE_CONFLICT');
			canonical = applyWorkspacePatch(canonical, value) as typeof canonical;
			revision = 'host:2';
			return { revision };
		});
		vi.stubGlobal('window', {
			desktop: {
				hostTasksSnapshot: vi.fn(),
				workspacePatch: patch,
				workspaceLoad: async () => ({ revision, state: canonical }),
			},
		});
		const storage = await import('../../src/lib/storage');
		storage.acceptWorkspaceSnapshot('local', { revision: 'host:0', state: original });
		const apply = vi.fn();
		storage.onWorkspaceRebased(() => apply);
		const remove = storage.onWorkspaceRebased((_target, before, next) => {
			const merged = mergeWorkspaceState(before, local, next);
			return () => {
				local = merged as typeof local;
			};
		});
		await expect(storage.refreshHostWorkspace()).rejects.toThrow('WORKSPACE_CONFLICT');
		expect(local.systemPrompt).toBe('Unsaved local edit');
		expect(apply).not.toHaveBeenCalled();
		await expect(storage.saveState(local)).rejects.toThrow('WORKSPACE_CONFLICT');
		// Repeated host notifications must not implicitly clear a rejected merge.
		remove();
		await expect(storage.refreshHostWorkspace()).rejects.toThrow('WORKSPACE_CONFLICT');
		await expect(storage.flushStateSaves()).rejects.toThrow('WORKSPACE_CONFLICT');
		expect(patch).not.toHaveBeenCalled();
		expect(canonical.systemPrompt).toBe('Host update');
		// Only an explicit reload establishes a new baseline and permits saving.
		const reloaded = (await storage.loadState())!;
		await storage.saveState({ ...reloaded, theme: 'light' });
		expect(canonical.systemPrompt).toBe('Host update');
		expect(canonical.theme).toBe('light');
	});
	it('accepts a host refresh after preparing the merge and preserves a local draft', async () => {
		const original = state();
		let canonical: AppState = { ...original, systemPrompt: 'Host update' };
		let local: AppState = {
			...original,
			chatDrafts: { task: { content: 'Unsaved draft', attachments: [], updatedAt: 3 } },
		};
		const patch = vi.fn(async (_target: string, revision: string, value: WorkspacePatch) => {
			expect(revision).toBe('host:1');
			canonical = applyWorkspacePatch(canonical, value);
			return { revision: 'host:2' };
		});
		vi.stubGlobal('window', {
			desktop: {
				hostTasksSnapshot: vi.fn(),
				workspacePatch: patch,
				workspaceLoad: async () => ({ revision: 'host:1', state: canonical }),
			},
		});
		const storage = await import('../../src/lib/storage');
		storage.acceptWorkspaceSnapshot('local', { revision: 'host:0', state: original });
		storage.onWorkspaceRebased((_target, before, next) => {
			const merged = mergeWorkspaceState(before, local, next);
			return () => {
				local = merged;
			};
		});
		await storage.refreshHostWorkspace();
		expect(local.systemPrompt).toBe('Host update');
		expect(local.chatDrafts?.task.content).toBe('Unsaved draft');
		await storage.saveState(local);
		expect(canonical.systemPrompt).toBe('Host update');
		expect(canonical.chatDrafts?.task.content).toBe('Unsaved draft');
		expect(patch).toHaveBeenCalledTimes(1);
	});
	it('does not retry a committed write when a newer local edit rejects its UI rebase', async () => {
		const original = state();
		let canonical: AppState = { ...original, systemPrompt: 'Host update' };
		let revision = 'host:1';
		const toSave = { ...original, theme: 'light' as const };
		const newerLocal = { ...toSave, systemPrompt: 'Local edit during save' };
		const patch = vi.fn(async (_target: string, expected: string, value: WorkspacePatch) => {
			if (expected !== revision) throw new Error('WORKSPACE_CONFLICT');
			canonical = applyWorkspacePatch(canonical, value);
			revision = 'host:2';
			return { revision };
		});
		const load = vi.fn(async () => ({ revision, state: canonical }));
		vi.stubGlobal('window', {
			desktop: {
				hostTasksSnapshot: vi.fn(),
				workspacePatch: patch,
				workspaceLoad: load,
			},
		});
		const storage = await import('../../src/lib/storage');
		storage.acceptWorkspaceSnapshot('local', { revision: 'host:0', state: original });
		storage.onWorkspaceRebased((_target, before, next) => {
			mergeWorkspaceState(before, newerLocal, next);
		});
		await expect(storage.saveState(toSave)).rejects.toThrow('WORKSPACE_CONFLICT');
		expect(canonical.systemPrompt).toBe('Host update');
		expect(canonical.theme).toBe('light');
		expect(patch).toHaveBeenCalledTimes(2); // One stale revision, then one committed patch.
		expect(load).toHaveBeenCalledTimes(1);
		await expect(storage.saveState(newerLocal)).rejects.toThrow('WORKSPACE_CONFLICT');
		expect(patch).toHaveBeenCalledTimes(2);
	});
	it('rebases a local composer draft over a concurrent host reply and publishes the merged state', async () => {
		const original = state();
		original.threads = [
			{
				id: 'task',
				kind: 'code',
				title: 'Task',
				connectionId: 'provider',
				model: 'chat',
				createdAt: 1,
				updatedAt: 1,
				messages: [{ id: 'reply', role: 'assistant', content: 'Working', createdAt: 1 }],
			},
		];
		let canonical: AppState = {
			...original,
			threads: original.threads.map((thread) => ({
				...thread,
				messages: thread.messages.map((message) => ({
					...message,
					content: 'Finished',
					completedAt: 2,
				})),
			})),
		};
		let revision = 'host:1';
		const patch = vi.fn(async (_target: string, expected: string, value: WorkspacePatch) => {
			if (expected !== revision) throw new Error('WORKSPACE_CONFLICT');
			canonical = applyWorkspacePatch(canonical, value);
			revision = 'host:2';
			return { revision };
		});
		vi.stubGlobal('window', {
			desktop: {
				hostTasksSnapshot: vi.fn(),
				workspacePatch: patch,
				workspaceLoad: async () => ({ revision, state: canonical }),
			},
		});
		const storage = await import('../../src/lib/storage');
		storage.acceptWorkspaceSnapshot('local', { revision: 'host:0', state: original });
		const observer = vi.fn();
		storage.onWorkspaceRebased(observer);
		await storage.saveState({
			...original,
			chatDrafts: { task: { content: 'My next request', attachments: [], updatedAt: 3 } },
		});
		expect(canonical.threads[0].messages[0].content).toBe('Finished');
		expect(canonical.chatDrafts?.task.content).toBe('My next request');
		expect(observer).toHaveBeenCalledTimes(1);
		expect(observer.mock.calls[0][2]).toEqual(canonical);
		expect(patch).toHaveBeenCalledTimes(2);
	});
	it('rejects overlapping transcript edits while keeping the authoritative host reply', async () => {
		const original = state();
		original.threads = [
			{
				id: 'task',
				title: 'Task',
				connectionId: 'provider',
				model: 'chat',
				createdAt: 1,
				updatedAt: 1,
				messages: [{ id: 'reply', role: 'assistant', content: 'Before', createdAt: 1 }],
			},
		];
		const change = (text: string) => ({
			...original,
			threads: original.threads.map((thread) => ({
				...thread,
				messages: thread.messages.map((message) => ({ ...message, content: text })),
			})),
		});
		const canonical = change('Host reply');
		const patch = vi.fn(async () => {
			throw new Error('WORKSPACE_CONFLICT');
		});
		vi.stubGlobal('window', {
			desktop: {
				hostTasksSnapshot: vi.fn(),
				workspacePatch: patch,
				workspaceLoad: async () => ({ revision: 'host:1', state: canonical }),
			},
		});
		const storage = await import('../../src/lib/storage');
		storage.acceptWorkspaceSnapshot('local', { revision: 'host:0', state: original });
		await expect(storage.saveState(change('User transcript edit'))).rejects.toThrow(
			'WORKSPACE_CONFLICT',
		);
		expect(canonical.threads[0].messages[0].content).toBe('Host reply');
		expect(patch).toHaveBeenCalledTimes(1);
	});

	it('negotiates global Code compaction per target without silently discarding policies', async () => {
		const original = state();
		const save = vi.fn(async (_target: string, _revision: string, _state: AppState) => ({
			revision: 'saved:1',
		}));
		vi.stubGlobal('window', { desktop: { workspaceSave: save } });
		const storage = await import('../../src/lib/storage');
		expect(storage.workspaceSupportsCodeCompaction()).toBe(true);
		storage.acceptWorkspaceSnapshot('legacy', {
			state: original,
			revision: 'legacy:0',
			codeCompactionSupported: false,
		});
		storage.acceptWorkspaceSnapshot('modern', {
			state: original,
			revision: 'modern:0',
			codeCompactionSupported: true,
		});
		storage.acceptWorkspaceSnapshot('local', {
			state: original,
			revision: 'local:0',
			codeCompactionSupported: false,
		});
		expect(storage.workspaceSupportsCodeCompaction('legacy')).toBe(false);
		expect(storage.workspaceSupportsCodeCompaction('modern')).toBe(true);
		expect(storage.workspaceSupportsCodeCompaction('local')).toBe(true);
		storage.acceptWorkspaceSnapshot('legacy', { state: original, revision: 'legacy:1' });
		expect(storage.workspaceSupportsCodeCompaction('legacy')).toBe(false);
		const changed = { ...original, codeCompaction: { thresholdPercent: 85, reserveTokens: 40000 } };
		await expect(storage.saveState(changed, 'legacy')).rejects.toThrow('configure Code compaction');
		expect(save).not.toHaveBeenCalled();
		await storage.saveState({ ...original, theme: 'light' }, 'legacy');
		expect(save.mock.calls[0]).toEqual(['legacy', 'legacy:1', { ...original, theme: 'light' }]);
		await storage.saveState(changed, 'modern');
		expect(save.mock.calls[1]).toEqual(['modern', 'modern:0', changed]);
		expect(save.mock.calls[1][2]).not.toHaveProperty('codeCompactionSupported');
		storage.acceptWorkspaceSnapshot('legacy', {
			state: original,
			revision: 'legacy:2',
			codeCompactionSupported: true,
		});
		expect(storage.workspaceSupportsCodeCompaction('legacy')).toBe(true);
	});

	it('negotiates personalization per target and rejects unsupported saves before desktop delivery', async () => {
		const original = state();
		const save = vi.fn(async (_target: string, _revision: string, _state: AppState) => ({
			revision: 'saved:1',
		}));
		vi.stubGlobal('window', { desktop: { workspaceSave: save } });
		const storage = await import('../../src/lib/storage');
		expect(storage.workspaceSupportsPersonalization()).toBe(true);
		expect(storage.workspaceSupportsPersonalization('unknown')).toBe(true);
		storage.acceptWorkspaceSnapshot('legacy', {
			state: original,
			revision: 'legacy:0',
			personalizationSupported: false,
		});
		storage.acceptWorkspaceSnapshot('modern', {
			state: original,
			revision: 'modern:0',
			personalizationSupported: true,
		});
		storage.acceptWorkspaceSnapshot('local', {
			state: original,
			revision: 'local:0',
			personalizationSupported: false,
		});
		expect(storage.workspaceSupportsPersonalization('legacy')).toBe(false);
		expect(storage.workspaceSupportsPersonalization('modern')).toBe(true);
		expect(storage.workspaceSupportsPersonalization('local')).toBe(true);
		storage.acceptWorkspaceSnapshot('legacy', { state: original, revision: 'legacy:1' });
		expect(storage.workspaceSupportsPersonalization('legacy')).toBe(false);
		const changed = { ...original, personalization: personalizationFixture() };
		await expect(storage.saveState(changed, 'legacy')).rejects.toThrow('use personalization');
		expect(save).not.toHaveBeenCalled();
		await storage.saveState({ ...original, theme: 'light' }, 'legacy');
		expect(save.mock.calls[0]).toEqual(['legacy', 'legacy:1', { ...original, theme: 'light' }]);
		await storage.saveState(changed, 'modern');
		expect(save.mock.calls[1]).toEqual(['modern', 'modern:0', changed]);
		expect(save.mock.calls[1][2]).not.toHaveProperty('personalizationSupported');
		storage.acceptWorkspaceSnapshot('legacy', {
			state: original,
			revision: 'legacy:2',
			personalizationSupported: true,
		});
		expect(storage.workspaceSupportsPersonalization('legacy')).toBe(true);
	});

	it('captures profiles when saving and sends only the changed configuration in local patches', async () => {
		const original = state();
		const patch = vi.fn(async () => ({ revision: 'local:1' }));
		vi.stubGlobal('window', { desktop: { workspacePatch: patch } });
		const storage = await import('../../src/lib/storage');
		storage.acceptWorkspaceSnapshot('local', { state: original, revision: 'local:0' });
		const personalization = personalizationFixture();
		const expected = structuredClone(personalization);
		const saving = storage.saveState({ ...original, personalization });
		personalization.code.customInstructions = 'Mutated after save';
		await saving;
		expect(patch.mock.calls[0]).toEqual([
			'local',
			'local:0',
			{ changes: { personalization: expected } },
		]);
	});

	it('remembers negotiated memory support per workspace without persisting transport metadata', async () => {
		const original = state();
		const save = vi.fn(async () => ({ revision: 'remote:1' }));
		vi.stubGlobal('window', { desktop: { workspaceSave: save } });
		const storage = await import('../../src/lib/storage');
		expect(storage.workspaceSupportsMemory()).toBe(true);
		expect(storage.workspaceSupportsMemory('unknown')).toBe(true);
		storage.acceptWorkspaceSnapshot('legacy', {
			state: original,
			revision: 'legacy:0',
			memorySupported: false,
		});
		storage.acceptWorkspaceSnapshot('modern', {
			state: original,
			revision: 'modern:0',
			memorySupported: true,
		});
		storage.acceptWorkspaceSnapshot('local', {
			state: original,
			revision: 'local:0',
			memorySupported: false,
		});
		expect(storage.workspaceSupportsMemory('legacy')).toBe(false);
		expect(storage.workspaceSupportsMemory('modern')).toBe(true);
		expect(storage.workspaceSupportsMemory('local')).toBe(true);
		storage.acceptWorkspaceSnapshot('legacy', { state: original, revision: 'legacy:1' });
		expect(storage.workspaceSupportsMemory('legacy')).toBe(false);
		await storage.saveState({ ...original, theme: 'light' }, 'legacy');
		expect(save.mock.calls[0]).toEqual(['legacy', 'legacy:1', { ...original, theme: 'light' }]);
		storage.acceptWorkspaceSnapshot('legacy', {
			state: original,
			revision: 'legacy:2',
			memorySupported: true,
		});
		expect(storage.workspaceSupportsMemory('legacy')).toBe(true);
	});

	it('sends chat-only local patches without media and skips duplicate immutable autosaves', async () => {
		const original = state();
		original.generations = [
			{
				id: 'image',
				kind: 'images',
				prompt: '',
				model: 'fixture',
				connectionId: 'provider',
				createdAt: 1,
				status: 'completed',
				assets: [
					{
						url: 'data:image/png;base64,' + 'A'.repeat(1_000_000),
						mimeType: 'image/png',
						name: 'fixture.png',
					},
				],
			},
		];
		const patch = vi.fn(async () => ({ revision: 'local:1' }));
		const save = vi.fn();
		vi.stubGlobal('window', { desktop: { workspaceSave: save, workspacePatch: patch } });
		const storage = await import('../../src/lib/storage');
		storage.acceptWorkspaceSnapshot('local', { state: original, revision: 'local:0' });
		const changed = {
			...original,
			threads: [
				{
					id: 'chat',
					title: 'Chat',
					connectionId: 'provider',
					model: 'fixture',
					createdAt: 1,
					updatedAt: 1,
					messages: [],
				},
			],
		};
		await Promise.all([storage.saveState(changed), storage.saveState(changed)]);
		expect(patch).toHaveBeenCalledTimes(1);
		const dispatched = patch.mock.calls[0] as unknown as [string, string, WorkspacePatch];
		expect(dispatched.slice(0, 2)).toEqual(['local', 'local:0']);
		expect(applyWorkspacePatch(original, dispatched[2])).toEqual(changed);
		expect(JSON.stringify(patch.mock.calls[0]).length).toBeLessThan(1000);
		expect(save).not.toHaveBeenCalled();
	});

	it('carries failed queued changes into the next patch and captures changed fields at dispatch', async () => {
		const original = state();
		const patch = vi
			.fn()
			.mockRejectedValueOnce(new Error('Temporary disk failure'))
			.mockResolvedValue({ revision: 'local:1' });
		vi.stubGlobal('window', { desktop: { workspacePatch: patch } });
		const storage = await import('../../src/lib/storage');
		storage.acceptWorkspaceSnapshot('local', { state: original, revision: 'local:0' });
		const first = { ...original, theme: 'light' as const };
		const second = {
			...first,
			projects: [{ id: 'project', name: 'Captured', instructions: '', createdAt: 1 }],
		};
		const failed = storage.saveState(first);
		const saved = storage.saveState(second);
		second.projects[0].name = 'Mutated after dispatch';
		await expect(failed).rejects.toThrow('Temporary disk failure');
		await saved;
		const dispatched = patch.mock.calls[1] as [string, string, WorkspacePatch];
		expect(dispatched.slice(0, 2)).toEqual(['local', 'local:0']);
		expect(applyWorkspacePatch(original, dispatched[2])).toEqual({
			...first,
			projects: [{ id: 'project', name: 'Captured', instructions: '', createdAt: 1 }],
		});
	});

	it('captures changed messages without transferring old generated image results', async () => {
		const original = state();
		original.threads = [
			{
				id: 'chat',
				connectionId: 'provider',
				model: 'fixture',
				title: 'Chat',
				createdAt: 1,
				updatedAt: 1,
				messages: [
					{
						id: 'old',
						role: 'assistant',
						content: 'Generated image',
						createdAt: 1,
						toolCalls: [
							{
								id: 'tool',
								name: 'image_gen',
								arguments: '{}',
								status: 'completed',
								startedAt: 1,
								result: {
									content: [
										{ type: 'image', dataUrl: 'data:image/png;base64,' + 'A'.repeat(2_000_000) },
									],
								},
							},
						],
					},
					{ id: 'reply', role: 'assistant', content: 'First reply', createdAt: 1 },
				],
			},
		];
		let canonical = original;
		const patch = vi.fn(async (_target: string, _revision: string, delta: WorkspacePatch) => {
			canonical = applyWorkspacePatch(canonical, delta);
			return { revision: 'local:1' };
		});
		vi.stubGlobal('window', { desktop: { workspacePatch: patch } });
		const storage = await import('../../src/lib/storage');
		storage.acceptWorkspaceSnapshot('local', { state: original, revision: 'local:0' });
		const thread = original.threads[0];
		const reply = { ...thread.messages[1], content: 'Saved reply' };
		const changed = {
			...original,
			threads: [{ ...thread, updatedAt: 2, messages: [thread.messages[0], reply] }],
		};
		const saving = storage.saveState(changed);
		reply.content = 'Mutated after dispatch';
		await saving;
		expect(patch).toHaveBeenCalledOnce();
		expect(JSON.stringify(patch.mock.calls[0][2]).length).toBeLessThan(500);
		expect(canonical.threads[0].messages[1].content).toBe('Saved reply');
		expect(canonical.threads[0].messages[0].toolCalls).toBe(thread.messages[0].toolCalls);
		expect(original.threads[0].messages[1].content).toBe('First reply');
	});

	it('uses explicit removals for optional fields and keeps remote compatibility with older hosts', async () => {
		const original = { ...state(), systemPrompt: 'Old prompt' };
		const patch = vi.fn(async () => ({ revision: 'local:1' }));
		const save = vi.fn(async () => ({ revision: 'remote:1' }));
		vi.stubGlobal('window', { desktop: { workspacePatch: patch, workspaceSave: save } });
		const storage = await import('../../src/lib/storage');
		storage.acceptWorkspaceSnapshot('local', { state: original, revision: 'local:0' });
		await storage.saveState({ ...original, systemPrompt: undefined });
		expect(patch.mock.calls[0]).toEqual([
			'local',
			'local:0',
			{ changes: {}, removed: ['systemPrompt'] },
		]);
		storage.acceptWorkspaceSnapshot('remote', { state: original, revision: 'remote:0' });
		await storage.saveState({ ...original, theme: 'light' }, 'remote');
		expect(save).toHaveBeenCalledOnce();
		expect(patch).toHaveBeenCalledOnce();
	});

	it('serializes saves and pins each save to its original workspace', async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const calls: unknown[][] = [];
		const desktop = {
			workspaceLoad: vi.fn(async () => ({ state: state(), revision: 'local:0' })),
			workspaceSave: vi.fn(async (id: string, revision: string) => {
				calls.push([id, revision]);
				if (calls.length === 1) await gate;
				return { revision: id === 'local' ? 'local:1' : 'remote:1' };
			}),
		};
		vi.stubGlobal('window', { desktop });
		const storage = await import('../../src/lib/storage');
		await storage.loadState('local');
		storage.acceptWorkspaceSnapshot('remote', { state: state(), revision: 'remote:0' });
		const localSave = storage.saveState(state(), 'local');
		const remoteSave = storage.saveState(state(), 'remote');
		await remoteSave;
		release();
		await localSave;
		expect(calls).toEqual([
			['local', 'local:0'],
			['remote', 'remote:0'],
		]);
	});
	it('uses the acknowledged revision for subsequent saves', async () => {
		let version = 0;
		const save = vi.fn(async (_id: string, revision: string) => {
			expect(revision).toBe(`epoch:${version}`);
			return { revision: `epoch:${++version}` };
		});
		vi.stubGlobal('window', { desktop: { workspaceSave: save } });
		const storage = await import('../../src/lib/storage');
		storage.acceptWorkspaceSnapshot('remote', { state: state(), revision: 'epoch:0' });
		await Promise.all([storage.saveState(state(), 'remote'), storage.saveState(state(), 'remote')]);
		expect(save).toHaveBeenCalledTimes(2);
	});
	it('never retries a stale snapshot with a fresh revision after conflict', async () => {
		const save = vi
			.fn()
			.mockRejectedValueOnce(new Error('WORKSPACE_CONFLICT: newer host state'))
			.mockResolvedValue({ revision: 'epoch:3' });
		vi.stubGlobal('window', { desktop: { workspaceSave: save } });
		const storage = await import('../../src/lib/storage');
		storage.acceptWorkspaceSnapshot('remote', { state: state(), revision: 'epoch:0' });
		await expect(storage.saveState(state(), 'remote')).rejects.toThrow('WORKSPACE_CONFLICT');
		await expect(storage.saveState(state(), 'remote')).rejects.toThrow('WORKSPACE_CONFLICT');
		expect(save).toHaveBeenCalledTimes(1);
		storage.acceptWorkspaceSnapshot('remote', { state: state(), revision: 'epoch:2' });
		await storage.saveState(state(), 'remote');
		expect(save.mock.calls[1].slice(0, 2)).toEqual(['remote', 'epoch:2']);
	});
});

it('routes remote API requests by provider ID without sending provider URL or credentials', async () => {
	const request = vi.fn(async (_wire: unknown) => ({
		status: 200,
		contentType: 'application/json',
		encoding: 'text',
		body: JSON.stringify({ data: [{ id: 'remote-model' }] }),
	}));
	vi.stubGlobal('window', {
		desktop: { request, onChunk: () => () => {}, cancel: async () => {} },
	});
	const workspace = await import('../../src/lib/workspace');
	workspace.activateWorkspace('remote-machine');
	const { listModels } = await import('../../src/lib/api');
	expect(await listModels(state().connections[0])).toEqual(['remote-model']);
	expect(request.mock.calls[0][0]).toMatchObject({
		workspaceId: 'remote-machine',
		connectionId: 'provider',
		apiKey: '',
		baseUrl: '',
	});
});
