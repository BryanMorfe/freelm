import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AppState } from '../../src/types';
import type { SavedMemory } from '../../src/memory-types';
import { initialState } from '../../src/lib/state';
import {
	StateStore,
	splitLegacyWorkspace,
	validateSplitWorkspace,
} from '../../electron/state-store';
import { validateState } from '../../electron/validation';
import {
	applyWorkspacePatch,
	assertWorkspacePatch,
	createWorkspacePatch,
} from '../../src/workspace-patch';

const folders: string[] = [];
afterEach(async () => {
	await Promise.all(
		folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
	);
});
const secrets = {
	available: () => false,
	encrypt: () => {
		throw new Error('No keys');
	},
	decrypt: () => {
		throw new Error('No keys');
	},
};
function note(): SavedMemory {
	return {
		id: 'note',
		content: 'I prefer TypeScript.',
		createdAt: 1,
		updatedAt: 2,
		revision: 1,
		source: 'user',
		projectId: 'project',
		sourceThreadId: 'chat',
	};
}
function fixture(): AppState {
	return {
		...initialState(),
		memorySettings: { savedMemories: false, referenceHistory: true },
		savedMemories: [note()],
		threads: [
			{
				id: 'chat',
				kind: 'chat',
				title: 'Chat',
				projectId: 'project',
				connectionId: 'connection',
				model: 'fixture',
				createdAt: 1,
				updatedAt: 2,
				messages: [
					{
						id: 'user',
						role: 'user',
						content: 'Large asset',
						createdAt: 1,
						attachments: [
							{
								name: 'asset.png',
								type: 'image/png',
								dataUrl: 'data:image/png;base64,' + 'A'.repeat(300_000),
							},
						],
					},
				],
				memorySummary: {
					content: 'Cached conversation facts',
					sourceRevision: 'chat-memory-v1:revision',
					generatedAt: 3,
					model: 'fixture',
				},
			},
		],
	};
}
async function files() {
	const folder = await mkdtemp(path.join(os.tmpdir(), 'freelm-memory-storage-'));
	folders.push(folder);
	return { file: path.join(folder, 'workspace.json'), config: path.join(folder, 'config.json') };
}

describe('memory storage and validation', () => {
	it('persists switches in config, notes in workspace, and cached summaries alongside media', async () => {
		const { file, config } = await files(),
			state = fixture();
		await new StateStore(file, secrets, config).save(state);
		const settings = JSON.parse(await readFile(config, 'utf8'));
		const workspace = JSON.parse(await readFile(file, 'utf8'));
		expect(settings.memorySettings).toEqual(state.memorySettings);
		expect(settings).not.toHaveProperty('savedMemories');
		expect(workspace.savedMemories).toEqual(state.savedMemories);
		expect(workspace).not.toHaveProperty('memorySettings');
		expect(workspace.threads[0].memorySummary).toEqual(state.threads[0].memorySummary);
		expect(workspace.format).toBe('freelm-workspace-v3');
		expect(await new StateStore(file, secrets, config).load()).toEqual(state);
	});
	it('leaves optional memory fields absent when migrating legacy data, and rejects misplaced halves', () => {
		const legacy = initialState();
		const pair = splitLegacyWorkspace({
			format: 'freelm-workspace-v1',
			state: legacy,
			encryptedKeys: {},
		});
		expect(pair.config).not.toHaveProperty('memorySettings');
		expect(pair.workspace).not.toHaveProperty('savedMemories');
		expect(validateSplitWorkspace(pair.config, pair.workspace).state).toEqual(legacy);
		expect(() =>
			validateSplitWorkspace({ ...pair.config, savedMemories: [] }, pair.workspace),
		).toThrow('Configuration belongs');
		expect(() =>
			validateSplitWorkspace(pair.config, {
				...pair.workspace,
				memorySettings: { savedMemories: true, referenceHistory: true },
			}),
		).toThrow('Configuration belongs');
	});
	it('recovers committed memory changes from the split transaction journal', async () => {
		const { file, config } = await files(),
			state = fixture();
		state.threads[0] = { ...state.threads[0], messages: [] };
		const pair = splitLegacyWorkspace({ format: 'freelm-workspace-v1', state, encryptedKeys: {} });
		await writeFile(
			`${file}.pending`,
			JSON.stringify({ format: 'freelm-state-transaction-v1', ...pair }),
		);
		expect(await new StateStore(file, secrets, config).load()).toEqual(state);
		expect(JSON.parse(await readFile(file, 'utf8')).savedMemories).toEqual(state.savedMemories);
		expect(JSON.parse(await readFile(config, 'utf8')).memorySettings).toEqual(state.memorySettings);
	});
	it('accepts the exact note/content limits and rejects malformed or ambiguous records', () => {
		const state = fixture();
		state.savedMemories = Array.from({ length: 256 }, (_, index) => ({
			...note(),
			id: `note-${index}`,
			content: 'x'.repeat(4000),
		}));
		state.threads[0].memorySummary!.content = 's'.repeat(4000);
		expect(() => validateState(state)).not.toThrow();
		const invalid: unknown[] = [
			{ ...state, savedMemories: [...state.savedMemories, { ...note(), id: 'extra' }] },
			{ ...state, savedMemories: [note(), note()] },
			{ ...state, memorySettings: { savedMemories: true } },
			...[
				{ id: '' },
				{ content: ' ' },
				{ content: 'x'.repeat(4001) },
				{ revision: 0 },
				{ revision: 1.5 },
				{ source: 'unknown' },
				{ updatedAt: Infinity },
				{ projectId: '' },
				{ sourceThreadId: '' },
			].map((change) => ({ ...state, savedMemories: [{ ...note(), ...change }] })),
			...[
				{ content: 's'.repeat(4001) },
				{ content: '' },
				{ generatedAt: -1 },
				{ sourceRevision: '' },
				{ model: '' },
			].map((change) => ({
				...state,
				threads: [
					{ ...state.threads[0], memorySummary: { ...state.threads[0].memorySummary!, ...change } },
				],
			})),
		];
		for (const candidate of invalid)
			expect(() => validateState(candidate)).toThrow('Workspace data is invalid');
	});
	it('protects existing files when an invalid note edit is submitted', async () => {
		const { file, config } = await files(),
			state = fixture();
		const store = new StateStore(file, secrets, config);
		await store.save(state);
		const before = [await readFile(file, 'utf8'), await readFile(config, 'utf8')];
		expect(() =>
			store.save({ ...state, savedMemories: [{ ...note(), content: 'x'.repeat(4001) }] }),
		).toThrow('Workspace data is invalid');
		expect([await readFile(file, 'utf8'), await readFile(config, 'utf8')]).toEqual(before);
	});
});

describe('memory workspace patches', () => {
	it('atomically patches notes and per-thread summaries without sending existing media', () => {
		const before = fixture();
		const next: AppState = {
			...before,
			savedMemories: [{ ...note(), content: 'Edited preference', revision: 2 }],
			memorySettings: { savedMemories: true, referenceHistory: false },
			threads: [
				{
					...before.threads[0],
					memorySummary: { ...before.threads[0].memorySummary!, content: 'Updated facts' },
				},
			],
		};
		const patch = createWorkspacePatch(before, next);
		assertWorkspacePatch(patch);
		expect(patch.changes.savedMemories).toEqual(next.savedMemories);
		expect(patch.changes).not.toHaveProperty('threads');
		expect(patch.records?.threads?.updates?.[0].changes.memorySummary).toEqual(
			next.threads[0].memorySummary,
		);
		expect(JSON.stringify(patch).length).toBeLessThan(1000);
		const applied = applyWorkspacePatch(before, patch);
		expect(applied).toEqual(next);
		expect(applied.threads[0].messages).toBe(before.threads[0].messages);
	});
	it('supports explicit removal of optional notes, preferences and summary caches', () => {
		const before = fixture();
		const { savedMemories: _notes, memorySettings: _settings, ...base } = before;
		const { memorySummary: _summary, ...chat } = before.threads[0];
		const next: AppState = { ...base, threads: [chat] };
		const patch = createWorkspacePatch(before, next);
		assertWorkspacePatch(patch);
		expect(patch.removed).toEqual(['memorySettings', 'savedMemories']);
		expect(patch.records?.threads?.updates?.[0].removed).toEqual(['memorySummary']);
		expect(applyWorkspacePatch(before, patch)).toEqual(next);
	});
});
