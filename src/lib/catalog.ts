import type {
	CodeCompactionSettings,
	Connection,
	JsonValue,
	Modality,
	ModelDefinition,
	ModelKind,
	ThinkingMode,
} from '../types';
import {
	DEFAULT_COMPACTION_RESERVE_TOKENS,
	DEFAULT_COMPACTION_THRESHOLD_PERCENT,
	validateCodeCompactionSettings,
} from './code-compaction';

export {
	DEFAULT_COMPACTION_RESERVE_TOKENS,
	DEFAULT_COMPACTION_THRESHOLD_PERCENT,
} from './code-compaction';

export interface ModelChoice {
	id: string;
	name: string;
	definition?: ModelDefinition;
}

type CompactionModel = Pick<ModelDefinition, 'contextWindow'>;

export interface ModelCompactionSettings {
	contextWindow: number;
	thresholdPercent: number;
	reserveTokens: number;
	triggerTokens: number;
}

/** Compatibility defaults, not a declaration of any provider model's capacity. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

export function validateModelCompactionSettings(model: CompactionModel, label = 'Model'): void {
	if (
		model.contextWindow !== undefined &&
		(!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0)
	)
		throw new Error(`${label}: context window must be a positive whole number of tokens.`);
}

/** Use whichever bound compacts earlier, preserving space for the next response and tools. */
export function modelCompactionSettings(
	model: CompactionModel = {},
	policy: Partial<CodeCompactionSettings> = {},
): ModelCompactionSettings {
	validateModelCompactionSettings(model);
	validateCodeCompactionSettings(policy);
	const contextWindow = model.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
	const thresholdPercent = policy.thresholdPercent ?? DEFAULT_COMPACTION_THRESHOLD_PERCENT;
	const configuredReserve = policy.reserveTokens ?? DEFAULT_COMPACTION_RESERVE_TOKENS;
	const reserveTokens =
		configuredReserve >= contextWindow ? Math.floor(contextWindow * 0.25) : configuredReserve;
	return {
		contextWindow,
		thresholdPercent,
		reserveTokens,
		triggerTokens: Math.min(
			Math.floor((contextWindow * thresholdPercent) / 100),
			contextWindow - reserveTokens,
		),
	};
}

const tasks: ModelKind[] = ['chat', 'images', 'videos', 'speech', 'transcription'];
const modalities: Modality[] = ['text', 'image', 'audio', 'video'];
const requirements: Record<ModelKind, { input: Modality; output: Modality; name: string }> = {
	chat: { input: 'text', output: 'text', name: 'chat' },
	images: { input: 'text', output: 'image', name: 'image generation' },
	videos: { input: 'text', output: 'video', name: 'video generation' },
	speech: { input: 'text', output: 'audio', name: 'speech generation' },
	transcription: { input: 'audio', output: 'text', name: 'transcription' },
};

/** Reusable examples; a model only uses a preset after it is explicitly assigned. */
export function defaultThinkingPresets(): ThinkingMode[] {
	return ['low', 'medium', 'high'].map((effort) => ({
		id: effort,
		name: effort[0].toUpperCase() + effort.slice(1),
		parameters: { responses: { reasoning: { effort } }, chat: { reasoning_effort: effort } },
	}));
}

const thinkingRanks: Record<string, number> = {
	none: 0,
	off: 0,
	disabled: 0,
	minimal: 1,
	minimum: 1,
	low: 2,
	medium: 3,
	high: 4,
	xhigh: 5,
	extrahigh: 5,
	max: 6,
	maximum: 6,
};
type ThinkingLabel = Pick<ThinkingMode, 'id' | 'name'>;
function thinkingRank(mode: ThinkingLabel): number | undefined {
	const normalize = (value: string) =>
		value
			.trim()
			.toLowerCase()
			.replace(/[\s_-]+/g, '');
	const rank = (value: string) => {
		const key = normalize(value);
		return Object.hasOwn(thinkingRanks, key) ? thinkingRanks[key] : undefined;
	};
	return rank(mode.id) ?? rank(mode.name);
}

/** Order known effort labels without assigning an intensity to arbitrary custom values. */
export function orderThinkingModes<T extends ThinkingLabel>(modes: readonly T[]): T[] {
	const known = modes
		.map((mode, index) => ({ mode, index, rank: thinkingRank(mode) }))
		.filter((entry): entry is typeof entry & { rank: number } => entry.rank !== undefined)
		.sort((left, right) => left.rank - right.rank || left.index - right.index);
	let index = 0;
	// Custom values keep their slots and relative order. This also preserves user
	// ordering for model-specific modes whose intensity cannot be inferred.
	return modes.map((mode) => (thinkingRank(mode) === undefined ? mode : known[index++].mode));
}

export function isMaximumThinkingMode(mode: ThinkingLabel | undefined): boolean {
	return !!mode && thinkingRank(mode) === thinkingRanks.max;
}

export function getModelDefinition(
	connection: Connection,
	id: string,
): ModelDefinition | undefined {
	return connection.catalog?.find((model) => model.id === id);
}

function incompatibility(
	connection: Connection,
	id: string,
	kind: ModelKind,
	inputModalities: Modality[] = [],
): string | undefined {
	if (!id.trim()) return 'Choose a model first.';
	const model = getModelDefinition(connection, id);
	// A discovered or manually entered ID has no capability declaration to enforce.
	if (!model) return;
	if (!model.enabled) return `${model.name} is disabled in this connection's model catalog.`;
	const required = requirements[kind];
	if (!model.tasks.includes(kind)) return `${model.name} is not configured for ${required.name}.`;
	for (const input of new Set([required.input, ...inputModalities])) {
		if (!model.inputModalities.includes(input))
			return `${model.name} does not support ${input} input in the model catalog.`;
	}
	if (!model.outputModalities.includes(required.output))
		return `${model.name} does not support ${required.output} output in the model catalog.`;
}

export function modelSupports(
	connection: Connection,
	id: string,
	kind: ModelKind,
	inputModalities: Modality[] = [],
): boolean {
	return !incompatibility(connection, id, kind, inputModalities);
}

export function assertModelSupports(
	connection: Connection,
	id: string,
	kind: ModelKind,
	inputModalities: Modality[] = [],
): void {
	const error = incompatibility(connection, id, kind, inputModalities);
	if (error) throw new Error(error);
}

export function listModelChoices(connection: Connection, kind: ModelKind): ModelChoice[] {
	const choices = new Map<string, ModelChoice>();
	for (const definition of connection.catalog || []) {
		if (modelSupports(connection, definition.id, kind))
			choices.set(definition.id, { id: definition.id, name: definition.name, definition });
	}
	for (const id of [connection.models[kind], ...connection.discoveredModels]) {
		if (id.trim() && !choices.has(id) && modelSupports(connection, id, kind))
			choices.set(id, { id, name: id });
	}
	return [...choices.values()];
}

export function defaultModel(connection: Connection, kind: ModelKind): string {
	const configured = connection.models[kind];
	return configured && modelSupports(connection, configured, kind)
		? configured
		: listModelChoices(connection, kind)[0]?.id || '';
}

const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);
const reservedParameters = new Set([
	'model',
	'input',
	'messages',
	'instructions',
	'stream',
	'store',
	'tools',
	'tool_choice',
	'parallel_tool_calls',
	'stream_options',
	'previous_response_id',
	'conversation',
	'background',
	'baseUrl',
	'base_url',
	'apiKey',
	'api_key',
	'headers',
	'url',
	'path',
	'method',
	'body',
	'form',
	'connectionId',
	'workspaceId',
]);
function record(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** Validate arbitrary provider tuning without allowing request routing or content overrides. */
export function validateThinkingParameters(
	value: unknown,
	label = 'Thinking parameters',
): asserts value is Record<string, JsonValue> {
	if (!record(value)) throw new Error(`${label} must be a JSON object.`);
	let nodes = 0;
	const seen = new Set<object>();
	function visit(item: unknown, depth: number, path: string) {
		if (++nodes > 2000 || depth > 12)
			throw new Error(`${label} is too complex (maximum depth 12).`);
		if (item === null || typeof item === 'boolean') return;
		if (typeof item === 'number' && Number.isFinite(item)) return;
		if (typeof item === 'string' && item.length <= 16_384) return;
		if (typeof item !== 'object' || !item)
			throw new Error(`${label}: ${path} must contain finite JSON values.`);
		if (seen.has(item)) throw new Error(`${label} must not contain circular references.`);
		seen.add(item);
		if (Array.isArray(item)) {
			if (item.length > 1000) throw new Error(`${label}: ${path} has too many entries.`);
			for (const [index, child] of item.entries()) visit(child, depth + 1, `${path}[${index}]`);
		} else {
			if (!record(item)) throw new Error(`${label}: ${path} must be a plain JSON object.`);
			for (const [key, child] of Object.entries(item)) {
				if (!key || key.length > 256 || forbiddenKeys.has(key))
					throw new Error(`${label}: ${path} contains an unsafe property name.`);
				if ((depth === 0 || path === 'parameters.extra_body') && reservedParameters.has(key))
					throw new Error(`${label} cannot override the request field "${key}".`);
				visit(child, depth + 1, `${path}.${key}`);
			}
		}
		seen.delete(item);
	}
	visit(value, 0, 'parameters');
	if (JSON.stringify(value).length > 32_768) throw new Error(`${label} exceeds the 32 KB limit.`);
}

/** A named mode must supply a concrete provider value, including an explicit false/zero. */
export function hasThinkingValue(value: JsonValue | undefined): boolean {
	const seen = new Set<object>();
	function visit(item: JsonValue | undefined, depth: number): boolean {
		if (typeof item === 'boolean' || typeof item === 'number') return true;
		if (typeof item === 'string') return !!item.trim();
		if (!item || typeof item !== 'object' || depth > 12 || seen.has(item)) return false;
		seen.add(item);
		return Object.values(item).some((child) => visit(child, depth + 1));
	}
	return visit(value, 0);
}

export function availableThinkingModes(connection: Connection, modelId: string): ThinkingMode[] {
	const endpoint = connection.chatApi === 'responses' ? 'responses' : 'chat';
	return (getModelDefinition(connection, modelId)?.thinkingModes || []).filter((mode) =>
		hasThinkingValue(mode.parameters[endpoint]),
	);
}

/** Legacy catalogs without an explicit default use their first usable mode. */
export function defaultThinkingMode(connection: Connection, modelId: string): string | undefined {
	const modes = availableThinkingModes(connection, modelId);
	const preferred = getModelDefinition(connection, modelId)?.defaultThinkingMode;
	return modes.find((mode) => mode.id === preferred)?.id || modes[0]?.id;
}

export function resolveThinkingMode(
	connection: Connection,
	modelId: string,
	modeId?: string,
): ThinkingMode {
	const model = getModelDefinition(connection, modelId);
	const selected = modeId || defaultThinkingMode(connection, modelId);
	if (!selected)
		throw new Error(
			`Configure a thinking value for ${model?.name || modelId} in Settings → Configuration → Models before sending.`,
		);
	const mode = model?.thinkingModes.find((candidate) => candidate.id === selected);
	if (!mode)
		throw new Error(
			`Thinking mode "${selected}" is not configured for ${model?.name || modelId}. Choose a mode again.`,
		);
	const endpoint = connection.chatApi === 'responses' ? 'responses' : 'chat';
	if (!hasThinkingValue(mode.parameters[endpoint]))
		throw new Error(
			`${mode.name} needs an explicit thinking value for the ${endpoint === 'responses' ? 'Responses' : 'Chat'} API. Choose another thinking mode or configure its parameters.`,
		);
	return mode;
}

export function thinkingParameters(
	connection: Connection,
	modelId: string,
	modeId?: string,
): Record<string, JsonValue> {
	const mode = resolveThinkingMode(connection, modelId, modeId);
	const endpoint = connection.chatApi === 'responses' ? 'responses' : 'chat';
	const parameters = mode.parameters[endpoint]!;
	validateThinkingParameters(parameters, `${mode.name} parameters`);
	return structuredClone(parameters);
}

function nonempty(value: unknown, max: number): value is string {
	return (
		typeof value === 'string' && !!value.trim() && value === value.trim() && value.length <= max
	);
}
function enumList(value: unknown, choices: string[]): value is string[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.length <= choices.length &&
		value.every((item) => typeof item === 'string' && choices.includes(item)) &&
		new Set(value).size === value.length
	);
}

function validateThinkingModes(value: unknown, label: string, max: number): Set<string> {
	if (!Array.isArray(value) || value.length > max)
		throw new Error(`${label}: thinking modes must be a list of at most ${max} modes.`);
	const ids = new Set<string>();
	for (const mode of value) {
		if (!record(mode) || !nonempty(mode.id, 256) || !nonempty(mode.name, 128))
			throw new Error(
				`${label}: every thinking mode needs a nonempty ID and name without surrounding spaces.`,
			);
		if (ids.has(mode.id))
			throw new Error(`${label}: thinking mode ID "${mode.id}" appears more than once.`);
		ids.add(mode.id);
		if (
			!record(mode.parameters) ||
			Object.keys(mode.parameters).some((key) => !['responses', 'chat'].includes(key))
		)
			throw new Error(`${label} / ${mode.name}: use Responses and/or Chat parameter objects.`);
		if (mode.parameters.responses === undefined && mode.parameters.chat === undefined)
			throw new Error(`${label} / ${mode.name}: configure parameters for at least one API.`);
		for (const endpoint of ['responses', 'chat']) {
			if (mode.parameters[endpoint] !== undefined)
				validateThinkingParameters(
					mode.parameters[endpoint],
					`${label} / ${mode.name} ${endpoint} parameters`,
				);
		}
	}
	return ids;
}

export function assertThinkingPresets(value: unknown): asserts value is ThinkingMode[] {
	validateThinkingModes(value, 'Thinking presets', 128);
}

function validateImagePresets(value: unknown, label: string): Set<string> {
	if (!Array.isArray(value) || value.length > 32)
		throw new Error(`${label}: image presets must be a list of at most 32 presets.`);
	const ids = new Set<string>();
	for (const preset of value) {
		if (!record(preset) || !nonempty(preset.id, 256) || !nonempty(preset.name, 128))
			throw new Error(
				`${label}: every image preset needs a nonempty ID and name without surrounding spaces.`,
			);
		if (ids.has(preset.id))
			throw new Error(`${label}: image preset ID "${preset.id}" appears more than once.`);
		ids.add(preset.id);
		if (preset.quality !== undefined && !nonempty(preset.quality, 256))
			throw new Error(
				`${label} / ${preset.name}: API quality must be a nonempty value without surrounding spaces, or omitted for the provider default.`,
			);
		if (
			!Array.isArray(preset.aspectRatios) ||
			!preset.aspectRatios.length ||
			preset.aspectRatios.length > 64
		)
			throw new Error(`${label} / ${preset.name}: choose between 1 and 64 aspect ratios.`);
		const ratios = new Set<string>();
		for (const ratio of preset.aspectRatios) {
			if (!record(ratio) || !nonempty(ratio.id, 256) || !nonempty(ratio.name, 128))
				throw new Error(
					`${label} / ${preset.name}: every aspect ratio needs a nonempty ID and name without surrounding spaces.`,
				);
			if (ratios.has(ratio.id))
				throw new Error(
					`${label} / ${preset.name}: aspect ratio ID "${ratio.id}" appears more than once.`,
				);
			ratios.add(ratio.id);
			if (
				![ratio.width, ratio.height].every(
					(dimension) =>
						typeof dimension === 'number' && Number.isSafeInteger(dimension) && dimension > 0,
				)
			)
				throw new Error(
					`${label} / ${preset.name} / ${ratio.name}: width and height must be positive whole numbers.`,
				);
		}
		if (
			preset.defaultAspectRatio !== undefined &&
			(!nonempty(preset.defaultAspectRatio, 256) || !ratios.has(preset.defaultAspectRatio))
		)
			throw new Error(
				`${label} / ${preset.name}: the default aspect ratio must refer to one of this preset's ratios.`,
			);
	}
	return ids;
}

export function assertModelCatalog(value: unknown): asserts value is ModelDefinition[] {
	if (!Array.isArray(value) || value.length > 1000)
		throw new Error('Model catalog must be a list with at most 1,000 models.');
	const ids = new Set<string>();
	for (const [index, model] of value.entries()) {
		const label = `Model ${index + 1}`;
		if (!record(model) || !nonempty(model.id, 1024) || !nonempty(model.name, 512))
			throw new Error(
				`${label} needs a nonempty API model ID and display name without surrounding spaces.`,
			);
		if (ids.has(model.id)) throw new Error(`The model ID "${model.id}" appears more than once.`);
		ids.add(model.id);
		if (typeof model.enabled !== 'boolean')
			throw new Error(`${model.name}: enabled must be true or false.`);
		if (!enumList(model.tasks, tasks))
			throw new Error(`${model.name}: choose at least one distinct supported task.`);
		if (
			!enumList(model.inputModalities, modalities) ||
			!enumList(model.outputModalities, modalities)
		)
			throw new Error(`${model.name}: choose at least one distinct input and output modality.`);
		for (const task of model.tasks as ModelKind[]) {
			const required = requirements[task];
			if (
				!model.inputModalities.includes(required.input) ||
				!model.outputModalities.includes(required.output)
			)
				throw new Error(
					`${model.name}: ${required.name} requires ${required.input} input and ${required.output} output.`,
				);
		}
		validateModelCompactionSettings(model, model.name);
		if (model.contextWindow !== undefined && !model.tasks.includes('chat'))
			throw new Error(`${model.name}: context window settings require the chat task.`);
		const modes = validateThinkingModes(model.thinkingModes, model.name, 32);
		const imagePresets = validateImagePresets(model.imagePresets ?? [], model.name);
		if (imagePresets.size && !model.tasks.includes('images'))
			throw new Error(`${model.name}: image presets require the images task.`);
		if (
			model.defaultImagePreset !== undefined &&
			(!nonempty(model.defaultImagePreset, 256) || !imagePresets.has(model.defaultImagePreset))
		)
			throw new Error(
				`${model.name}: the default image preset must refer to one of this model's presets.`,
			);
		if (modes.size && !model.tasks.includes('chat'))
			throw new Error(`${model.name}: thinking modes currently require the chat task.`);
		if (
			model.defaultThinkingMode !== undefined &&
			(!nonempty(model.defaultThinkingMode, 256) || !modes.has(model.defaultThinkingMode))
		)
			throw new Error(
				`${model.name}: the default thinking mode must refer to one of this model's modes.`,
			);
	}
}
