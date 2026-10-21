import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StateStore } from '../../electron/state-store';
import { WorkspaceAuthority } from '../../electron/workspace-authority';
import { initialState } from '../../src/lib/state';
import type { AppState, Thread } from '../../src/types';

const folders: string[] = [];
afterEach(async () => {
	await Promise.all(
		folders.splice(0).map((folder) => rm(folder, { force: true, recursive: true })),
	);
});

function chat(state: AppState, projectId?: string): Thread {
	return {
		id: 'chat',
		title: 'Chat',
		connectionId: state.activeConnectionId,
		model: 'fixture',
		createdAt: 1,
		updatedAt: 1,
		projectId,
		messages: [{ id: 'message', role: 'user', content: 'Hello', createdAt: 1 }],
	};
}

async function fixture() {
	const directory = await mkdtemp(path.join(tmpdir(), 'freelm-patch-'));
	folders.push(directory);
	const store = new StateStore(
		path.join(directory, 'workspace.json'),
		{
			available: () => false,
			encrypt: () => {
				throw new Error('Unused');
			},
			decrypt: () => {
				throw new Error('Unused');
			},
		},
		path.join(directory, 'config.json'),
	);
	const authority = new WorkspaceAuthority(store);
	const state = initialState();
	state.connections[0].apiKey = 'memory-only-fixture-key';
	state.generations = [
		{
			id: 'media',
			kind: 'images',
			prompt: '',
			model: 'fixture',
			connectionId: state.activeConnectionId,
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
	const writes = vi.spyOn(store, 'saveSnapshot');
	const revision = (await authority.save(state, (await authority.load()).revision)).revision;
	return { authority, store, state, revision, writes };
}

describe('local workspace patches', () => {
	it('durably patches global Code compaction without rewriting historic media and rejects invalid policy', async () => {
		const { authority, store, revision } = await fixture();
		const history = await readFile(store.filename, 'utf8');
		const codeCompaction = { thresholdPercent: 85, reserveTokens: 40_000 };
		const updated = await authority.patch({ changes: { codeCompaction } }, revision);
		expect((await authority.load()).state?.codeCompaction).toEqual(codeCompaction);
		expect((await store.load())?.codeCompaction).toEqual(codeCompaction);
		expect(JSON.parse(await readFile(store.configFilename!, 'utf8')).codeCompaction).toEqual(
			codeCompaction,
		);
		await expect(
			authority.patch(
				{ changes: { codeCompaction: { thresholdPercent: 0, reserveTokens: 0 } } },
				updated.revision,
			),
		).rejects.toThrow('compaction percentage');
		expect((await authority.load()).state?.codeCompaction).toEqual(codeCompaction);
		expect(await readFile(store.filename, 'utf8')).toBe(history);
	});
	it('durably updates debug mode through small native patches and rejects invalid values', async () => {
		const { authority, store, revision } = await fixture();
		const history = await readFile(store.filename, 'utf8');
		const enabled = await authority.patch({ changes: { debugMode: true } }, revision);
		expect((await authority.load()).state?.debugMode).toBe(true);
		expect(JSON.parse(await readFile(store.configFilename!, 'utf8')).debugMode).toBe(true);
		await expect(
			authority.patch({ changes: { debugMode: 'enabled' } }, enabled.revision),
		).rejects.toThrow('Workspace data is invalid');
		await authority.patch({ changes: { debugMode: false } }, enabled.revision);
		expect((await store.load())?.debugMode).toBe(false);
		expect(await readFile(store.filename, 'utf8')).toBe(history);
	});
	it('durably saves only supplied changes while reusing immutable media and protecting snapshots', async () => {
		const { authority, store, state, revision, writes } = await fixture();
		const threads = [chat(state)];
		const save = authority.patch({ changes: { threads } }, revision);
		threads[0].messages[0].content = 'mutated after dispatch';
		await save;
		expect(writes.mock.calls[1][0].generations).toBe(writes.mock.calls[0][0].generations);
		expect(writes.mock.calls[1][0].connections).toBe(writes.mock.calls[0][0].connections);
		const disk = JSON.parse(await readFile(store.filename, 'utf8'));
		expect(disk.format).toBe('freelm-workspace-v3');
		expect(disk.threads[0].messages[0].content).toBe('Hello');
		expect(disk.generations[0].assets[0].url).toBe('');
		expect((await store.load())?.generations).toEqual(state.generations);
		expect(await readFile(store.configFilename!, 'utf8')).not.toContain('memory-only-fixture-key');
		expect((await store.load())?.connections[0].apiKey).toBe('memory-only-fixture-key');
	});

	it('keeps revisions stable for no-op patches and rejects changed stale patches', async () => {
		const { authority, revision, writes } = await fixture();
		expect(await authority.patch({ changes: {} }, revision)).toEqual({ revision });
		expect(writes).toHaveBeenCalledTimes(1);
		const saved = await authority.patch({ changes: { theme: 'light' } }, revision);
		await expect(authority.patch({ changes: { theme: 'dark' } }, revision)).rejects.toThrow(
			'WORKSPACE_CONFLICT',
		);
		expect((await authority.load()).revision).toBe(saved.revision);
		expect((await authority.load()).state?.theme).toBe('light');
	});

	it('validates patch fields and explicitly removes optional settings without damaging state', async () => {
		const { authority, revision, store } = await fixture();
		const saved = await authority.patch({ changes: { systemPrompt: 'Custom' } }, revision);
		const before = await readFile(store.filename, 'utf8');
		expect(() => authority.patch({ changes: { arbitrary: 'invalid' } }, saved.revision)).toThrow(
			'Invalid workspace patch',
		);
		expect(() =>
			authority.patch({ changes: {}, removed: ['connections'] }, saved.revision),
		).toThrow('Invalid workspace patch');
		await expect(
			authority.patch({ changes: { activeConnectionId: 'missing' } }, saved.revision),
		).rejects.toThrow('valid active connection');
		expect(await readFile(store.filename, 'utf8')).toBe(before);
		await authority.patch({ changes: {}, removed: ['systemPrompt'] }, saved.revision);
		expect((await authority.load()).state).not.toHaveProperty('systemPrompt');
	});

	it('returns small isolated tool state without changing full protocol snapshots', async () => {
		const { authority, state, revision } = await fixture();
		await authority.patch(
			{
				changes: {
					threads: [chat(state, 'project')],
					projects: [
						{
							id: 'project',
							name: 'Project',
							instructions: 'Notes',
							createdAt: 1,
							directories: ['/tmp/project'],
						},
					],
				},
			},
			revision,
		);
		const tools = (await authority.loadToolState())!;
		expect(tools.generations).toEqual([]);
		expect(tools.threads[0].messages).toEqual([]);
		expect(tools.threads[0].projectId).toBe('project');
		expect(tools.projects[0].directories).toEqual(['/tmp/project']);
		tools.projects[0].directories![0] = '/tmp/changed';
		tools.connections[0].apiKey = 'changed';
		const full = (await authority.load()).state!;
		expect(full.generations).toEqual(state.generations);
		expect(full.threads[0].messages).toHaveLength(1);
		expect(full.projects[0].directories).toEqual(['/tmp/project']);
		expect(full.connections[0].apiKey).toBe('memory-only-fixture-key');
	});

	it('retains host-only project directory and existing chat assignment protections for full remote saves', async () => {
		const { authority, state, revision } = await fixture();
		await authority.patch(
			{
				changes: {
					threads: [chat(state, 'bound')],
					projects: [
						{
							id: 'bound',
							name: 'Bound',
							instructions: '',
							createdAt: 1,
							directories: ['/tmp/bound'],
						},
						{
							id: 'other',
							name: 'Other',
							instructions: '',
							createdAt: 1,
							directories: ['/tmp/other'],
						},
					],
				},
			},
			revision,
		);
		let remote = await authority.load(true);
		remote.state!.projects[0].directories = ['/tmp/new-grant'];
		await expect(authority.save(remote.state!, remote.revision, true)).rejects.toThrow(
			'Project directories must be configured on the host',
		);
		remote = await authority.load(true);
		remote.state!.threads[0].projectId = 'other';
		await expect(authority.save(remote.state!, remote.revision, true)).rejects.toThrow(
			'Moving a chat between project directories',
		);
		remote = await authority.load(true);
		remote.state!.projects.push({
			id: 'plain',
			name: 'Remote notes',
			instructions: '',
			createdAt: 1,
		});
		remote.state!.threads.push({ ...chat(state, 'bound'), id: 'remote-new-chat' });
		await expect(authority.save(remote.state!, remote.revision, true)).resolves.toHaveProperty(
			'revision',
		);
	});
});
