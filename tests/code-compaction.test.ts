import { describe, expect, it } from 'vitest';
import { validateState } from '../electron/validation';
import { modelCompactionSettings } from '../src/lib/catalog';
import {
	defaultCodeCompactionSettings,
	migrateCodeCompactionSettings,
	validateCodeCompactionSettings,
} from '../src/lib/code-compaction';
import { initialState, newConnection, recoverState } from '../src/lib/state';
import {
	applyWorkspacePatch,
	assertWorkspacePatch,
	createWorkspacePatch,
} from '../src/workspace-patch';
import type { ModelDefinition } from '../src/types';

function model(id: string, overrides: object = {}): ModelDefinition {
	return {
		id,
		name: id,
		enabled: true,
		tasks: ['chat'],
		inputModalities: ['text'],
		outputModalities: ['text'],
		thinkingModes: [],
		contextWindow: 262_144,
		...overrides,
	};
}

function legacyState() {
	const state = initialState();
	delete state.codeCompaction;
	return state;
}

describe('global Code compaction policy', () => {
	it('defaults once, with independent objects for new workspaces', () => {
		const first = initialState(),
			second = initialState();
		expect(first.codeCompaction).toEqual({ thresholdPercent: 90, reserveTokens: 32_000 });
		first.codeCompaction!.thresholdPercent = 75;
		expect(second.codeCompaction).toEqual(defaultCodeCompactionSettings());
		const legacy = legacyState();
		const recovered = recoverState(legacy);
		expect(recovered.codeCompaction).toEqual(defaultCodeCompactionSettings());
		expect(recoverState(recovered)).toBe(recovered);
		expect(legacy.codeCompaction).toBeUndefined();
	});

	it('promotes the active connection selected chat model policy and strips divergent legacy fields', () => {
		const state = legacyState();
		const other = newConnection();
		other.catalog = [
			model('first', { compactionThresholdPercent: 65, compactionReserveTokens: 10_000 }),
		];
		state.connections.unshift(other);
		const active = state.connections[1];
		active.models.chat = 'selected';
		active.catalog = [
			model('other', { compactionThresholdPercent: 70, compactionReserveTokens: 15_000 }),
			model('selected', { compactionThresholdPercent: 85, compactionReserveTokens: 40_000 }),
		];
		const original = structuredClone(state);
		const recovered = recoverState(state);
		expect(recovered.codeCompaction).toEqual({ thresholdPercent: 85, reserveTokens: 40_000 });
		for (const connection of recovered.connections)
			for (const definition of connection.catalog ?? []) {
				expect(definition).not.toHaveProperty('compactionThresholdPercent');
				expect(definition).not.toHaveProperty('compactionReserveTokens');
				expect(definition.contextWindow).toBe(262_144);
			}
		expect(recovered.threads).toBe(state.threads);
		expect(recovered.generations).toBe(state.generations);
		expect(recovered.projects).toBe(state.projects);
		expect(state).toEqual(original);
		expect(recoverState(recovered)).toBe(recovered);
		validateState(recovered);
	});

	it('uses the first configured model deterministically when the selected model has no policy', () => {
		const state = legacyState();
		state.connections[0].models.chat = 'selected';
		state.connections[0].catalog = [
			model('selected'),
			model('first-configured', { compactionThresholdPercent: 80 }),
			model('later', { compactionThresholdPercent: 60, compactionReserveTokens: 20_000 }),
		];
		expect(recoverState(state).codeCompaction).toEqual({
			thresholdPercent: 80,
			reserveTokens: 32_000,
		});
	});

	it('keeps explicit zero and fills only absent legacy values from defaults', () => {
		const state = legacyState();
		state.connections[0].catalog = [model('selected', { compactionReserveTokens: 0 })];
		state.connections[0].models.chat = 'selected';
		expect(recoverState(state).codeCompaction).toEqual({ thresholdPercent: 90, reserveTokens: 0 });
	});

	it('preserves an already configured global policy while removing former model fields', () => {
		const state = initialState();
		state.codeCompaction = { thresholdPercent: 75, reserveTokens: 24_000 };
		state.connections[0].catalog = [
			model('selected', { compactionThresholdPercent: 85, compactionReserveTokens: 40_000 }),
		];
		const recovered = migrateCodeCompactionSettings(state);
		expect(recovered.codeCompaction).toBe(state.codeCompaction);
		expect(recovered.connections[0].catalog?.[0].contextWindow).toBe(262_144);
		expect(recoverState(recovered)).toBe(recovered);
	});

	it('leaves older remote hosts unchanged until they can persist the new global preference', () => {
		const state = legacyState();
		state.connections[0].catalog = [
			model('selected', { compactionThresholdPercent: 85, compactionReserveTokens: 40_000 }),
		];
		const recovered = recoverState(state, { codeCompactionSupported: false });
		expect(recovered).toBe(state);
		expect(recovered.codeCompaction).toBeUndefined();
		expect(recovered.connections[0].catalog?.[0]).toHaveProperty('compactionThresholdPercent', 85);
	});

	it('shares one valid policy across model sizes with a usable reserve fallback for smaller windows', () => {
		const policy = { thresholdPercent: 85, reserveTokens: 40_000 };
		validateCodeCompactionSettings(policy);
		expect(modelCompactionSettings({ contextWindow: 262_144 }, policy)).toMatchObject({
			reserveTokens: 40_000,
			triggerTokens: 222_144,
		});
		expect(modelCompactionSettings({ contextWindow: 32_000 }, policy)).toMatchObject({
			reserveTokens: 8_000,
			triggerTokens: 24_000,
		});
		expect(policy.reserveTokens).toBe(40_000);
		expect(
			modelCompactionSettings({ contextWindow: 1000 }, { reserveTokens: 0 }).reserveTokens,
		).toBe(0);
		expect(modelCompactionSettings({ contextWindow: 1 }, policy).triggerTokens).toBe(0);
		const state = initialState();
		state.codeCompaction = { thresholdPercent: 90, reserveTokens: Number.MAX_SAFE_INTEGER };
		expect(() => validateState(state)).not.toThrow();
	});

	it.each([
		{ thresholdPercent: 0, reserveTokens: 32_000 },
		{ thresholdPercent: 100, reserveTokens: 32_000 },
		{ thresholdPercent: 85.5, reserveTokens: 32_000 },
		{ thresholdPercent: NaN, reserveTokens: 32_000 },
		{ thresholdPercent: 90, reserveTokens: -1 },
		{ thresholdPercent: 90, reserveTokens: 32_000.5 },
		{ thresholdPercent: 90, reserveTokens: Infinity },
		{ thresholdPercent: 90, reserveTokens: Number.MAX_SAFE_INTEGER + 1 },
	])('rejects invalid shared policy: %j', (policy) => {
		expect(() => validateCodeCompactionSettings(policy)).toThrow();
		expect(() => modelCompactionSettings({}, policy)).toThrow();
		expect(() => validateState({ ...initialState(), codeCompaction: policy })).toThrow();
	});

	it.each([
		null,
		[],
		{},
		{ thresholdPercent: '90', reserveTokens: 32_000 },
		{ thresholdPercent: 90 },
	])('rejects incomplete or nonnumeric persisted global policy: %j', (codeCompaction) => {
		expect(() => validateState({ ...initialState(), codeCompaction })).toThrow(
			'Code compaction settings are invalid',
		);
	});

	it('patches and removes the preference without resending thread history', () => {
		const previous = initialState();
		const next = { ...previous, codeCompaction: { thresholdPercent: 85, reserveTokens: 40_000 } };
		const patch = createWorkspacePatch(previous, next);
		assertWorkspacePatch(patch);
		expect(patch).toEqual({ changes: { codeCompaction: next.codeCompaction } });
		expect(applyWorkspacePatch(previous, patch)).toEqual(next);
		const { codeCompaction: _removed, ...without } = next;
		const removed = createWorkspacePatch(next, without);
		assertWorkspacePatch(removed);
		expect(removed).toEqual({ changes: {}, removed: ['codeCompaction'] });
		expect(applyWorkspacePatch(next, removed)).toEqual(without);
	});
});
