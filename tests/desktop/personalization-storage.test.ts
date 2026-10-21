import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initialState } from '../../src/lib/state';
import { PERSONALITIES, PERSONALIZATION_LEVELS } from '../../src/personalization-types';
import { personalizationFixture } from '../fixtures/personalization';
import {
	StateStore,
	splitLegacyWorkspace,
	validateSplitWorkspace,
} from '../../electron/state-store';
import { validateState } from '../../electron/validation';
import { WorkspaceAuthority } from '../../electron/workspace-authority';
import {
	applyWorkspacePatch,
	assertWorkspacePatch,
	createWorkspacePatch,
} from '../../src/workspace-patch';

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});
const secrets = {
	available: () => false,
	encrypt: () => {
		throw new Error('Unused');
	},
	decrypt: () => {
		throw new Error('Unused');
	},
};
async function files() {
	const directory = await mkdtemp(path.join(tmpdir(), 'freelm-personalization-'));
	directories.push(directory);
	return {
		workspace: path.join(directory, 'workspace.json'),
		config: path.join(directory, 'config.json'),
	};
}

describe('personalization persistence', () => {
	it('preserves both independent profiles in config, reloads and split exports', async () => {
		const { workspace, config } = await files();
		const state = { ...initialState(), personalization: personalizationFixture() };
		await new StateStore(workspace, secrets, config).save(state);
		const rawConfig = JSON.parse(await readFile(config, 'utf8'));
		const rawWorkspace = JSON.parse(await readFile(workspace, 'utf8'));
		expect(rawConfig.personalization).toEqual(state.personalization);
		expect(rawWorkspace).not.toHaveProperty('personalization');
		const reloaded = await new StateStore(workspace, secrets, config).load();
		expect(reloaded).toEqual(state);
		reloaded!.personalization!.chat.customInstructions = 'Edited isolated snapshot';
		expect((await new StateStore(workspace, secrets, config).load())?.personalization).toEqual(
			state.personalization,
		);
		const exported = splitLegacyWorkspace({
			format: 'freelm-workspace-v1',
			state,
			encryptedKeys: {},
		});
		expect(validateSplitWorkspace(exported.config, exported.workspace).state).toEqual(state);
		expect(() =>
			validateSplitWorkspace(exported.config, {
				...exported.workspace,
				personalization: state.personalization,
			}),
		).toThrow('Configuration belongs');
	});
	it('keeps legacy absence unchanged when loading and migrating existing data', async () => {
		const state = initialState();
		delete state.personalization;
		const raw = { format: 'freelm-workspace-v1', state, encryptedKeys: {} };
		const pair = splitLegacyWorkspace(raw);
		expect(pair.config).not.toHaveProperty('personalization');
		expect(validateSplitWorkspace(pair.config, pair.workspace).state).toEqual(state);
		const { workspace, config } = await files();
		const original = JSON.stringify(raw);
		await writeFile(workspace, original);
		expect(await new StateStore(workspace, secrets).load()).toEqual(state);
		expect(await readFile(workspace, 'utf8')).toBe(original);
		await new StateStore(workspace, secrets, config).save(state);
		expect(JSON.parse(await readFile(config, 'utf8'))).not.toHaveProperty('personalization');
	});
	it('accepts every supported choice and exact instruction limit, rejecting missing or invalid profile fields', () => {
		const state = { ...initialState(), personalization: personalizationFixture() };
		state.personalization.chat.customInstructions = 'c'.repeat(10_000);
		state.personalization.code.customInstructions = 'k'.repeat(10_000);
		for (const personality of PERSONALITIES) {
			state.personalization.chat.personality = personality;
			expect(() => validateState(state)).not.toThrow();
		}
		for (const level of PERSONALIZATION_LEVELS) {
			for (const key of ['warmth', 'enthusiasm', 'responseLength', 'formatting', 'emojis'] as const)
				state.personalization.code[key] = level;
			expect(() => validateState(state)).not.toThrow();
		}
		const invalid = [
			null,
			[],
			{},
			{ chat: state.personalization.chat },
			{ code: state.personalization.code },
			...[
				{ personality: 'unknown' },
				{ warmth: 'warm' },
				{ enthusiasm: 1 },
				{ responseLength: 'short' },
				{ formatting: null },
				{ emojis: true },
				{ customInstructions: 'x'.repeat(10_001) },
				{ customInstructions: undefined },
			].flatMap((change) =>
				['chat', 'code'].map((mode) => ({
					...state.personalization,
					[mode]: { ...state.personalization[mode as 'chat' | 'code'], ...change },
				})),
			),
		];
		for (const personalization of invalid)
			expect(() => validateState({ ...state, personalization })).toThrow(
				'Workspace data is invalid',
			);
	});
	it('rejects invalid edits before changing either persisted file', async () => {
		const { workspace, config } = await files();
		const state = { ...initialState(), personalization: personalizationFixture() };
		const store = new StateStore(workspace, secrets, config);
		await store.save(state);
		const before = [await readFile(workspace, 'utf8'), await readFile(config, 'utf8')];
		expect(() =>
			store.save({
				...state,
				personalization: {
					...state.personalization,
					chat: { ...state.personalization.chat, customInstructions: 'x'.repeat(10_001) },
				},
			}),
		).toThrow('Workspace data is invalid');
		expect([await readFile(workspace, 'utf8'), await readFile(config, 'utf8')]).toEqual(before);
	});
	it('recovers personalization from a committed split transaction', async () => {
		const { workspace, config } = await files();
		const state = { ...initialState(), personalization: personalizationFixture() };
		const pair = splitLegacyWorkspace({ format: 'freelm-workspace-v1', state, encryptedKeys: {} });
		await writeFile(
			`${workspace}.pending`,
			JSON.stringify({ format: 'freelm-state-transaction-v1', ...pair }),
		);
		expect(await new StateStore(workspace, secrets, config).load()).toEqual(state);
		expect(JSON.parse(await readFile(config, 'utf8')).personalization).toEqual(
			state.personalization,
		);
	});
});

describe('personalization workspace patches', () => {
	it('atomically changes or removes profiles without altering history', () => {
		const before = initialState();
		const next = { ...before, personalization: personalizationFixture() };
		const patch = createWorkspacePatch(before, next);
		assertWorkspacePatch(patch);
		expect(patch).toEqual({ changes: { personalization: next.personalization } });
		const applied = applyWorkspacePatch(before, patch);
		expect(applied).toEqual(next);
		expect(applied.threads).toBe(before.threads);
		const removed = createWorkspacePatch(applied, before);
		expect(removed).toEqual({ changes: {}, removed: ['personalization'] });
		expect(applyWorkspacePatch(applied, removed)).toEqual(before);
	});
	it('persists native patches, captures profile edits and rejects stale or invalid writes', async () => {
		const { workspace, config } = await files();
		const store = new StateStore(workspace, secrets, config);
		const authority = new WorkspaceAuthority(store);
		const initialized = await authority.save(initialState(), (await authority.load()).revision);
		const history = await readFile(workspace, 'utf8');
		const personalization = personalizationFixture();
		const expected = structuredClone(personalization);
		const save = authority.patch({ changes: { personalization } }, initialized.revision);
		personalization.chat.customInstructions = 'Mutated after dispatch';
		const saved = await save;
		expect((await store.load())?.personalization).toEqual(expected);
		expect(
			await authority.patch({ changes: { personalization: expected } }, saved.revision),
		).toEqual(saved);
		await expect(
			authority.patch({ changes: { personalization } }, initialized.revision),
		).rejects.toThrow('WORKSPACE_CONFLICT');
		await expect(
			authority.patch({ changes: { personalization: { chat: {}, code: {} } } }, saved.revision),
		).rejects.toThrow('Workspace data is invalid');
		expect((await authority.load()).state?.personalization).toEqual(expected);
		expect(await readFile(workspace, 'utf8')).toBe(history);
		const removed = await authority.patch(
			{ changes: {}, removed: ['personalization'] },
			saved.revision,
		);
		expect((await authority.load()).revision).toBe(removed.revision);
		expect(await new StateStore(workspace, secrets, config).load()).not.toHaveProperty(
			'personalization',
		);
	});
});
