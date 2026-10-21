import type { AppState, CodeCompactionSettings, ModelDefinition } from '../types';

export const DEFAULT_COMPACTION_THRESHOLD_PERCENT = 90;
export const DEFAULT_COMPACTION_RESERVE_TOKENS = 32_000;

export function defaultCodeCompactionSettings(): CodeCompactionSettings {
	return {
		thresholdPercent: DEFAULT_COMPACTION_THRESHOLD_PERCENT,
		reserveTokens: DEFAULT_COMPACTION_RESERVE_TOKENS,
	};
}

export function validateCodeCompactionSettings(
	settings: Partial<CodeCompactionSettings>,
	label = 'Code',
): void {
	if (
		settings.thresholdPercent !== undefined &&
		(!Number.isSafeInteger(settings.thresholdPercent) ||
			settings.thresholdPercent < 1 ||
			settings.thresholdPercent > 99)
	)
		throw new Error(`${label}: compaction percentage must be a whole number from 1 to 99.`);
	if (
		settings.reserveTokens !== undefined &&
		(!Number.isSafeInteger(settings.reserveTokens) || settings.reserveTokens < 0)
	)
		throw new Error(`${label}: remaining tokens must be a nonnegative whole number.`);
}

/** Legacy policy fields are read only while moving them out of model catalogs. */
type LegacyCompactionModel = ModelDefinition & {
	compactionThresholdPercent?: unknown;
	compactionReserveTokens?: unknown;
};

function legacyPolicy(
	model: ModelDefinition | undefined,
): Partial<CodeCompactionSettings> | undefined {
	if (!model) return undefined;
	const legacy = model as LegacyCompactionModel;
	const thresholdPercent = legacy.compactionThresholdPercent;
	const reserveTokens = legacy.compactionReserveTokens;
	const policy: Partial<CodeCompactionSettings> = {};
	if (
		typeof thresholdPercent === 'number' &&
		Number.isSafeInteger(thresholdPercent) &&
		thresholdPercent >= 1 &&
		thresholdPercent <= 99
	)
		policy.thresholdPercent = thresholdPercent;
	if (
		typeof reserveTokens === 'number' &&
		Number.isSafeInteger(reserveTokens) &&
		reserveTokens >= 0
	)
		policy.reserveTokens = reserveTokens;
	return Object.keys(policy).length ? policy : undefined;
}

/** Migrate metadata by reference, without cloning conversation or media payloads. */
export function migrateCodeCompactionSettings(state: AppState): AppState {
	const active = state.connections.find((connection) => connection.id === state.activeConnectionId);
	const selected = active?.catalog?.find((model) => model.id === active.models.chat);
	const previousPolicy =
		legacyPolicy(selected) ??
		state.connections
			.flatMap((connection) => connection.catalog ?? [])
			.map(legacyPolicy)
			.find(Boolean);
	const codeCompaction = state.codeCompaction ?? {
		...defaultCodeCompactionSettings(),
		...previousPolicy,
	};
	let changed = false;
	const connections = state.connections.map((connection) => {
		let catalogChanged = false;
		const catalog = connection.catalog?.map((model) => {
			if (
				!Object.hasOwn(model, 'compactionThresholdPercent') &&
				!Object.hasOwn(model, 'compactionReserveTokens')
			)
				return model;
			const {
				compactionThresholdPercent: _threshold,
				compactionReserveTokens: _reserve,
				...cleanModel
			} = model as LegacyCompactionModel;
			catalogChanged = true;
			return cleanModel;
		});
		if (!catalogChanged) return connection;
		changed = true;
		return { ...connection, catalog };
	});
	if (!changed && codeCompaction === state.codeCompaction) return state;
	return { ...state, codeCompaction, ...(changed ? { connections } : {}) };
}
