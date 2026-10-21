import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AppState } from '../../src/types';
import { initialState, recoverState } from '../../src/lib/state';
import {
	StateStore,
	splitLegacyWorkspace,
	validateSplitWorkspace,
} from '../../electron/state-store';
import { validateState } from '../../electron/validation';
import { WorkspaceAuthority } from '../../electron/workspace-authority';
import { applyWorkspacePatch, createWorkspacePatch } from '../../src/workspace-patch';
import { defaultModerationSettings, moderationSettings } from '../../src/lib/moderation';
import type { LegacyModerationSettings, ModerationSettings } from '../../src/moderation-types';

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
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
describe('media moderation persistence', () => {
	it('stores policy in configuration only, restores independent evaluators, and rejects malformed edits', async () => {
		const dir = await mkdtemp(path.join(tmpdir(), 'freelm-moderation-'));
		directories.push(dir);
		const workspace = path.join(dir, 'workspace.json'),
			config = path.join(dir, 'config.json');
		const state = initialState();
		const moderation = defaultModerationSettings();
		moderation.image = {
			enabled: true,
			level: 'medium',
			connectionId: 'image-evaluator',
			model: 'image-vlm',
			thinkingMode: 'low',
		};
		moderation.video = {
			enabled: false,
			level: 'high',
			connectionId: 'video-evaluator',
			model: 'video-vlm',
			thinkingMode: 'high',
			videoApi: 'chat',
		};
		state.moderation = moderation;
		const store = new StateStore(workspace, secrets, config);
		await store.save(state);
		expect(JSON.parse(await readFile(config, 'utf8')).moderation).toEqual(state.moderation);
		expect(JSON.parse(await readFile(workspace, 'utf8'))).not.toHaveProperty('moderation');
		expect(await new StateStore(workspace, secrets, config).load()).toEqual(state);
		const authority = new WorkspaceAuthority(store);
		await authority.load();
		const narrow = await authority.loadModerationState();
		expect(Object.keys(narrow).sort()).toEqual(['connections', 'moderation']);
		(narrow.moderation as ModerationSettings).image.enabled = false;
		expect(
			moderationSettings((await authority.loadModerationState()).moderation).image.enabled,
		).toBe(true);
		const before = await readFile(config, 'utf8');
		expect(() =>
			store.save({
				...state,
				moderation: { ...moderation, image: { ...moderation.image, level: 'anything' as 'low' } },
			}),
		).toThrow();
		expect(await readFile(config, 'utf8')).toBe(before);
	});
	it('preserves absent legacy fields while runtime policy defaults to enabled', () => {
		const state = initialState();
		delete state.moderation;
		const pair = splitLegacyWorkspace({ format: 'freelm-workspace-v1', state, encryptedKeys: {} });
		expect(pair.config).not.toHaveProperty('moderation');
		expect(validateSplitWorkspace(pair.config, pair.workspace).state).toEqual(state);
		expect(recoverState(state)).not.toHaveProperty('moderation');
	});
	it('reads persisted legacy policy and retains both evaluator selections during normalization', async () => {
		const dir = await mkdtemp(path.join(tmpdir(), 'freelm-moderation-legacy-'));
		directories.push(dir);
		const legacy: LegacyModerationSettings = {
			enabled: false,
			level: 'medium',
			image: { connectionId: 'image-api', model: 'image-judge', thinkingMode: 'low' },
			video: {
				connectionId: 'video-api',
				model: 'video-judge',
				thinkingMode: 'high',
				videoApi: 'responses',
			},
		};
		const state = { ...initialState(), moderation: legacy };
		const workspace = path.join(dir, 'workspace.json'),
			config = path.join(dir, 'config.json');
		await new StateStore(workspace, secrets, config).save(state);
		const loaded = await new StateStore(workspace, secrets, config).load();
		if (!loaded) throw new Error('Saved legacy moderation configuration should load.');
		expect(moderationSettings(loaded.moderation)).toEqual({
			image: { ...legacy.image, enabled: false, level: 'medium' },
			video: { ...legacy.video, enabled: false, level: 'medium' },
		});
	});
	it('carries moderation edits and removals through atomic workspace patches', () => {
		const previous = initialState();
		const moderation = moderationSettings(previous.moderation);
		const next = {
			...previous,
			moderation: {
				...moderation,
				image: { ...moderation.image, enabled: false, level: 'high' as const },
			},
		};
		expect(applyWorkspacePatch(previous, createWorkspacePatch(previous, next))).toEqual(next);
		const removed: AppState = { ...next };
		delete removed.moderation;
		expect(applyWorkspacePatch(next, createWorkspacePatch(next, removed))).toEqual(removed);
		expect(() =>
			validateState({
				...next,
				moderation: {
					...next.moderation,
					video: { connectionId: '', model: '', videoApi: 'invalid' },
				},
			}),
		).toThrow();
	});
});
