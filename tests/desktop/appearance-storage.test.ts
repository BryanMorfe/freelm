import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AppState } from '../../src/types';
import { initialState } from '../../src/lib/state';
import {
	appearanceOptions,
	defaultAppearance,
	normalizeAppearance,
} from '../../src/lib/appearance';
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
	available: () => {
		throw new Error('A keyless appearance change must not check the keychain');
	},
	encrypt: () => {
		throw new Error('Unused');
	},
	decrypt: () => {
		throw new Error('Unused');
	},
};
async function files() {
	const directory = await mkdtemp(path.join(tmpdir(), 'freelm-appearance-'));
	directories.push(directory);
	return {
		workspace: path.join(directory, 'workspace.json'),
		config: path.join(directory, 'config.json'),
	};
}

describe('appearance persistence', () => {
	it('round trips canonical custom colors in configuration, keeping theme and history separate', async () => {
		const { workspace, config } = await files();
		const state = {
			...initialState(),
			theme: 'system' as const,
			appearance: normalizeAppearance({ accent: 'custom', customAccent: '#AbC' }),
		};
		await new StateStore(workspace, secrets, config).save(state);
		const rawConfig = JSON.parse(await readFile(config, 'utf8'));
		const rawWorkspace = JSON.parse(await readFile(workspace, 'utf8'));
		expect(rawConfig.appearance).toEqual({ accent: 'custom', customAccent: '#aabbcc' });
		expect(rawConfig.theme).toBe('system');
		expect(rawWorkspace).not.toHaveProperty('appearance');
		const reloaded = await new StateStore(workspace, secrets, config).load();
		expect(reloaded).toEqual(state);
		reloaded!.appearance!.customAccent = '#000000';
		expect((await new StateStore(workspace, secrets, config).load())?.appearance).toEqual(
			state.appearance,
		);
		const pair = splitLegacyWorkspace({ format: 'freelm-workspace-v1', state, encryptedKeys: {} });
		expect(validateSplitWorkspace(pair.config, pair.workspace).state).toEqual(state);
		expect(() =>
			validateSplitWorkspace(pair.config, { ...pair.workspace, appearance: state.appearance }),
		).toThrow('Configuration belongs');
	});
	it('preserves old profiles with no appearance field through load and migration', async () => {
		const state = initialState();
		delete state.appearance;
		const raw = { format: 'freelm-workspace-v1', state, encryptedKeys: {} };
		const pair = splitLegacyWorkspace(raw);
		expect(pair.config).not.toHaveProperty('appearance');
		expect(validateSplitWorkspace(pair.config, pair.workspace).state).toEqual(state);
		const { workspace, config } = await files();
		const original = JSON.stringify(raw);
		await writeFile(workspace, original);
		expect(await new StateStore(workspace, secrets).load()).toEqual(state);
		expect(await readFile(workspace, 'utf8')).toBe(original);
		await new StateStore(workspace, secrets, config).save(state);
		expect(JSON.parse(await readFile(config, 'utf8'))).not.toHaveProperty('appearance');
	});
	it('accepts every preset but rejects malformed persisted settings and noncanonical colors', () => {
		const state = initialState();
		for (const { value: accent } of appearanceOptions)
			expect(() =>
				validateState({ ...state, appearance: { ...defaultAppearance(), accent } }),
			).not.toThrow();
		for (const appearance of [
			null,
			[],
			{},
			'blue',
			{ accent: 'blue' },
			{ customAccent: '#aabbcc' },
			{ accent: 'invalid', customAccent: '#aabbcc' },
			{ ...defaultAppearance(), other: true },
			...[
				'#abc',
				'#AABBCC',
				'#12345678',
				'red',
				'#000000; background:url(https://example.com)',
				123,
			].map((customAccent) => ({ accent: 'custom', customAccent })),
		])
			expect(() => validateState({ ...state, appearance })).toThrow('Workspace data is invalid');
	});
	it('rejects an invalid edit or imported config without touching stored files', async () => {
		const { workspace, config } = await files();
		const state = initialState();
		const store = new StateStore(workspace, secrets, config);
		await store.save(state);
		const before = [await readFile(workspace, 'utf8'), await readFile(config, 'utf8')];
		expect(() =>
			store.save({ ...state, appearance: { accent: 'custom', customAccent: 'rgb(1,2,3)' } }),
		).toThrow('Workspace data is invalid');
		const pair = splitLegacyWorkspace({ format: 'freelm-workspace-v1', state, encryptedKeys: {} });
		expect(() =>
			validateSplitWorkspace({ ...pair.config, appearance: null }, pair.workspace),
		).toThrow('Workspace data is invalid');
		expect([await readFile(workspace, 'utf8'), await readFile(config, 'utf8')]).toEqual(before);
	});
	it('recovers appearance from a committed configuration transaction', async () => {
		const { workspace, config } = await files();
		const state = {
			...initialState(),
			appearance: { ...defaultAppearance(), accent: 'pink' as const },
		};
		const pair = splitLegacyWorkspace({ format: 'freelm-workspace-v1', state, encryptedKeys: {} });
		await writeFile(
			`${workspace}.pending`,
			JSON.stringify({ format: 'freelm-state-transaction-v1', ...pair }),
		);
		expect(await new StateStore(workspace, secrets, config).load()).toEqual(state);
		expect(JSON.parse(await readFile(config, 'utf8')).appearance).toEqual(state.appearance);
	});
});

describe('appearance workspace synchronization', () => {
	it('keeps appearance in remote snapshots and durably saves remote color changes', async () => {
		const { workspace, config } = await files();
		const authority = new WorkspaceAuthority(new StateStore(workspace, secrets, config));
		const original = initialState();
		await authority.save(original, (await authority.load()).revision);
		const remote = await authority.load(true);
		expect(remote.state?.appearance).toEqual(original.appearance);
		const appearance = { ...defaultAppearance(), accent: 'purple' as const };
		await authority.save({ ...remote.state!, appearance }, remote.revision, true);
		expect((await authority.load(true)).state?.appearance).toEqual(appearance);
		const reloaded = await new StateStore(workspace, secrets, config).load();
		expect(reloaded?.appearance).toEqual(appearance);
		expect(reloaded?.theme).toBe(original.theme);
		expect(reloaded?.threads).toEqual(original.threads);
		expect(JSON.parse(await readFile(config, 'utf8')).appearance).toEqual(appearance);
	});

	it('includes color changes and optional removal in deltas, retaining shared history', () => {
		const before = initialState();
		const appearance = { ...defaultAppearance(), accent: 'white' as const };
		const next = { ...before, appearance };
		const patch = createWorkspacePatch(before, next);
		assertWorkspacePatch(patch);
		expect(patch).toEqual({ changes: { appearance } });
		const applied = applyWorkspacePatch(before, patch);
		expect(applied).toEqual(next);
		expect(applied.threads).toBe(before.threads);
		const missing: AppState = { ...next };
		delete missing.appearance;
		const removed = createWorkspacePatch(applied, missing);
		expect(removed).toEqual({ changes: {}, removed: ['appearance'] });
		expect(applyWorkspacePatch(applied, removed)).toEqual(missing);
	});
	it('persists host patches and rejects malformed or stale changes before replacing configuration', async () => {
		const { workspace, config } = await files();
		const store = new StateStore(workspace, secrets, config);
		const authority = new WorkspaceAuthority(store);
		const initialized = await authority.save(initialState(), (await authority.load()).revision);
		const history = await readFile(workspace, 'utf8');
		const appearance = { accent: 'custom' as const, customAccent: '#aabbcc' };
		const expected = structuredClone(appearance);
		const save = authority.patch({ changes: { appearance } }, initialized.revision);
		appearance.customAccent = '#000000';
		const saved = await save;
		expect((await store.load())?.appearance).toEqual(expected);
		expect(await authority.patch({ changes: { appearance: expected } }, saved.revision)).toEqual(
			saved,
		);
		await expect(
			authority.patch({ changes: { appearance } }, initialized.revision),
		).rejects.toThrow('WORKSPACE_CONFLICT');
		await expect(
			authority.patch(
				{ changes: { appearance: { accent: 'custom', customAccent: '#abc' } } },
				saved.revision,
			),
		).rejects.toThrow('Workspace data is invalid');
		expect((await authority.load()).state?.appearance).toEqual(expected);
		expect(await readFile(workspace, 'utf8')).toBe(history);
		const removed = await authority.patch({ changes: {}, removed: ['appearance'] }, saved.revision);
		expect((await authority.load()).revision).toBe(removed.revision);
		expect(await new StateStore(workspace, secrets, config).load()).not.toHaveProperty(
			'appearance',
		);
	});
});
