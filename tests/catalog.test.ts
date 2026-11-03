import { describe, expect, it } from 'vitest';
import {
	assertModelCatalog,
	standardThinkingMode,
	assertModelSupports,
	assertThinkingPresets,
	availableThinkingModes,
	defaultModel,
	defaultThinkingMode,
	hasThinkingValue,
	getModelDefinition,
	isMaximumThinkingMode,
	listModelChoices,
	modelSupports,
	modelCompactionSettings,
	orderThinkingModes,
	thinkingParameters,
	validateThinkingParameters,
	validateModelCompactionSettings,
} from '../src/lib/catalog';
import { initialState, newConnection } from '../src/lib/state';
import { validateState } from '../electron/validation';
import type { ModelDefinition, ThinkingMode } from '../src/types';

function model(overrides: Partial<ModelDefinition> = {}): ModelDefinition {
	return {
		id: 'custom-reasoner',
		name: 'My reasoner',
		enabled: true,
		tasks: ['chat'],
		inputModalities: ['text', 'image'],
		outputModalities: ['text'],
		thinkingModes: [
			{
				id: 'deep',
				name: 'Think deeply',
				parameters: {
					responses: { reasoning: { effort: 'high' } },
					chat: { reasoning_effort: 'high' },
				},
			},
		],
		defaultThinkingMode: 'deep',
		...overrides,
	};
}

describe('model context window settings', () => {
	it('keeps legacy catalogs valid and labels effective defaults as a fallback budget', () => {
		const legacy = model();
		expect(() => assertModelCatalog([legacy])).not.toThrow();
		expect(modelCompactionSettings(legacy)).toEqual({
			contextWindow: 128_000,
			thresholdPercent: 90,
			reserveTokens: 32_000,
			triggerTokens: 96_000,
		});
		expect(legacy).not.toHaveProperty('contextWindow');
	});

	it('combines a model window with the shared Code percentage and remaining-token trigger', () => {
		expect(
			modelCompactionSettings(
				{ contextWindow: 256_000 },
				{
					thresholdPercent: 90,
					reserveTokens: 32_000,
				},
			).triggerTokens,
		).toBe(224_000);
		expect(
			modelCompactionSettings(
				{ contextWindow: 256_000 },
				{
					thresholdPercent: 80,
					reserveTokens: 32_000,
				},
			).triggerTokens,
		).toBe(204_800);
		expect(
			modelCompactionSettings(
				{ contextWindow: 1001 },
				{
					thresholdPercent: 90,
					reserveTokens: 0,
				},
			).triggerTokens,
		).toBe(900);
	});

	it.each([16_000, 32_000])(
		'uses a usable default reserve for a %i-token model',
		(contextWindow) => {
			expect(modelCompactionSettings({ contextWindow })).toEqual({
				contextWindow,
				thresholdPercent: 90,
				reserveTokens: contextWindow / 4,
				triggerTokens: (contextWindow * 3) / 4,
			});
		},
	);

	it('retains model capacity and the independent global policy through workspace validation', () => {
		const configured = model({ contextWindow: 256_000 });
		const state = initialState();
		state.codeCompaction = { thresholdPercent: 85, reserveTokens: 0 };
		state.connections[0].catalog = [configured];
		expect(() => assertModelCatalog([configured])).not.toThrow();
		expect(() => validateState(state)).not.toThrow();
		expect(JSON.parse(JSON.stringify(state)).connections[0].catalog[0]).toEqual(configured);
		expect(modelCompactionSettings(configured, state.codeCompaction).triggerTokens).toBe(217_600);
	});

	it.each([0, -1, 32_000.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])(
		'rejects invalid explicit context capacity: %j',
		(contextWindow) => {
			const settings = { contextWindow };
			expect(() => validateModelCompactionSettings(settings)).toThrow();
			expect(() => modelCompactionSettings(settings)).toThrow();
			expect(() => assertModelCatalog([model(settings)])).toThrow();
		},
	);

	it('rejects string token settings and context fields on non-chat models', () => {
		expect(() => assertModelCatalog([{ ...model(), contextWindow: '128000' }])).toThrow(
			'positive whole number',
		);
		expect(() =>
			assertModelCatalog([
				model({
					tasks: ['images'],
					outputModalities: ['image'],
					thinkingModes: [],
					defaultThinkingMode: undefined,
					contextWindow: 128_000,
				}),
			]),
		).toThrow('require the chat task');
	});

	it('ignores former per-model policy fields when resolving Chat defaults', () => {
		const legacy = {
			...model(),
			contextWindow: 256_000,
			compactionThresholdPercent: 40,
			compactionReserveTokens: 80_000,
		};
		expect(modelCompactionSettings(legacy)).toEqual({
			contextWindow: 256_000,
			thresholdPercent: 90,
			reserveTokens: 32_000,
			triggerTokens: 224_000,
		});
	});
});

describe('connection model catalog', () => {
	it('orders known thinking labels from None through Max regardless of insertion order', () => {
		const modes = ['high', 'low', 'max', 'xhigh', 'medium', 'none', 'minimal'].map((id) => ({
			id,
			name: id,
			parameters: { responses: { reasoning: { effort: id } } },
		}));
		const before = structuredClone(modes);
		const ordered = orderThinkingModes(modes);
		expect(ordered.map((mode) => mode.id)).toEqual([
			'none',
			'minimal',
			'low',
			'medium',
			'high',
			'xhigh',
			'max',
		]);
		expect(modes).toEqual(before);
		for (const mode of ordered)
			expect(mode).toBe(modes.find((original) => original.id === mode.id));
	});

	it('recognizes display labels and aliases while retaining unknown custom slots and equal-rank order', () => {
		const modes = [
			{ id: 'opaque-max', name: 'Maximum' },
			{ id: 'constructor', name: 'Custom budget' },
			{ id: 'opaque-medium', name: 'Medium' },
			{ id: 'another-custom', name: 'Deliberate' },
			{ id: 'extra_high', name: 'Extended' },
			{ id: 'opaque-low', name: 'Low' },
			{ id: 'second-medium', name: 'Medium' },
		];
		expect(orderThinkingModes(modes).map((mode) => mode.id)).toEqual([
			'opaque-low',
			'constructor',
			'opaque-medium',
			'another-custom',
			'second-medium',
			'extra_high',
			'opaque-max',
		]);
		expect(
			orderThinkingModes([
				{ id: 'xhigh', name: 'XHigh' },
				{ id: 'high', name: 'High' },
			]).map((mode) => mode.id),
		).toEqual(['high', 'xhigh']);
	});

	it('presentation ordering preserves legacy defaults, selected IDs, and arbitrary provider parameters', () => {
		const modes: ThinkingMode[] = [
			{
				id: 'high',
				name: 'High',
				parameters: { responses: { thinking: { budget_tokens: 9000 } } },
			},
			{ id: 'low', name: 'Low', parameters: { responses: { enable_thinking: false } } },
			{
				id: 'custom-medium',
				name: 'Medium',
				parameters: {
					responses: { reasoning: { effort: 'provider-specific' }, custom_budget: 4096 },
				},
			},
		];
		const definition = model({ thinkingModes: modes, defaultThinkingMode: undefined });
		const connection = { ...newConnection(), catalog: [definition] };
		expect(
			orderThinkingModes(availableThinkingModes(connection, definition.id)).map((mode) => mode.id),
		).toEqual(['low', 'custom-medium', 'high']);
		expect(defaultThinkingMode(connection, definition.id)).toBe('high');
		expect(availableThinkingModes(connection, definition.id).map((mode) => mode.id)).toEqual([
			'high',
			'low',
			'custom-medium',
		]);
		expect(thinkingParameters(connection, definition.id, 'custom-medium')).toEqual(
			modes[2].parameters.responses,
		);
		expect(definition.thinkingModes).toBe(modes);
	});

	it('highlights semantic Max rather than a slider index or a conflicting display name', () => {
		expect(isMaximumThinkingMode({ id: 'max', name: 'Provider maximum' })).toBe(true);
		expect(isMaximumThinkingMode({ id: 'custom', name: 'Maximum' })).toBe(true);
		expect(isMaximumThinkingMode({ id: 'high', name: 'Max' })).toBe(false);
		expect(isMaximumThinkingMode({ id: 'custom-last', name: 'Deliberate' })).toBe(false);
		expect(isMaximumThinkingMode(undefined)).toBe(false);
	});

	it('preserves uncatalogued defaults, discovery and arbitrary IDs without mutating legacy connections', () => {
		const connection = newConnection();
		connection.models.chat = 'legacy-default';
		connection.discoveredModels = ['discovered', 'legacy-default'];
		const before = structuredClone(connection);
		expect(listModelChoices(connection, 'chat')).toEqual([
			{ id: 'legacy-default', name: 'legacy-default' },
			{ id: 'discovered', name: 'discovered' },
		]);
		expect(defaultModel(connection, 'chat')).toBe('legacy-default');
		expect(modelSupports(connection, 'typed-manually', 'images', ['image'])).toBe(true);
		expect(() => thinkingParameters(connection, 'typed-manually')).toThrow(
			'Configure a thinking value',
		);
		expect(connection).toEqual(before);
		expect(connection).not.toHaveProperty('catalog');
	});

	it('filters explicit disabled and incompatible models even when defaults or discovery contain them', () => {
		const connection = newConnection();
		connection.catalog = [
			model(),
			model({ id: 'disabled', enabled: false }),
			model({
				id: 'painter',
				name: 'Painter',
				tasks: ['images'],
				outputModalities: ['image'],
				thinkingModes: [],
				defaultThinkingMode: undefined,
			}),
		];
		connection.models.chat = 'disabled';
		connection.discoveredModels = ['painter', 'custom-reasoner', 'unknown'];
		expect(listModelChoices(connection, 'chat').map((choice) => [choice.id, choice.name])).toEqual([
			['custom-reasoner', 'My reasoner'],
			['unknown', 'unknown'],
		]);
		expect(defaultModel(connection, 'chat')).toBe('custom-reasoner');
		expect(getModelDefinition(connection, 'custom-reasoner')).toBe(connection.catalog[0]);
		expect(() => assertModelSupports(connection, 'disabled', 'chat')).toThrow('disabled');
		expect(() => assertModelSupports(connection, 'painter', 'chat')).toThrow(
			'not configured for chat',
		);
	});

	it('enforces both input and output declarations, including optional image inputs', () => {
		const connection = { ...newConnection(), catalog: [model({ inputModalities: ['text'] })] };
		expect(modelSupports(connection, 'custom-reasoner', 'chat')).toBe(true);
		expect(modelSupports(connection, 'custom-reasoner', 'chat', ['image'])).toBe(false);
		expect(() => assertModelSupports(connection, 'custom-reasoner', 'chat', ['image'])).toThrow(
			'image input',
		);
		connection.catalog[0].outputModalities = ['image'];
		expect(modelSupports(connection, 'custom-reasoner', 'chat')).toBe(false);
		expect(defaultModel(connection, 'chat')).toBe('');
		expect(modelSupports(connection, '', 'chat')).toBe(false);
	});

	it('always supplies default thinking parameters for Responses and both Chat routes', () => {
		const connection = { ...newConnection(), catalog: [model()] };
		expect(thinkingParameters(connection, 'custom-reasoner')).toEqual({
			reasoning: { effort: 'high' },
		});
		expect(thinkingParameters(connection, 'custom-reasoner', '')).toEqual({
			reasoning: { effort: 'high' },
		});
		const parameters = thinkingParameters(connection, 'custom-reasoner', 'deep');
		expect(parameters).toEqual({ reasoning: { effort: 'high' } });
		(parameters.reasoning as Record<string, unknown>).effort = 'low';
		expect(thinkingParameters(connection, 'custom-reasoner', 'deep')).toEqual({
			reasoning: { effort: 'high' },
		});
		for (const chatApi of ['chat/completions', 'chat'] as const)
			expect(thinkingParameters({ ...connection, chatApi }, 'custom-reasoner', 'deep')).toEqual({
				reasoning_effort: 'high',
			});
		expect(() => thinkingParameters(connection, 'custom-reasoner', 'missing')).toThrow(
			'Choose a mode again',
		);
		expect(() => thinkingParameters(connection, 'unknown', 'deep')).toThrow('not configured');
	});

	it('rejects unavailable endpoint mappings and supports custom provider parameters', () => {
		const definition = model({
			thinkingModes: [
				{
					id: 'budget',
					name: 'Budget',
					parameters: {
						chat: {
							thinking: { type: 'enabled', budget_tokens: 2048 },
							chat_template_kwargs: { enable_thinking: true },
						},
					},
				},
			],
		});
		const connection = { ...newConnection(), catalog: [definition] };
		expect(() => thinkingParameters(connection, definition.id, 'budget')).toThrow(
			'needs an explicit thinking value for the Responses API',
		);
		expect(thinkingParameters({ ...connection, chatApi: 'chat' }, definition.id, 'budget')).toEqual(
			definition.thinkingModes[0].parameters.chat,
		);
	});

	it('chooses the first compatible mode when the default is absent or belongs to another API', () => {
		const definition = model({ defaultThinkingMode: undefined });
		definition.thinkingModes.unshift({
			id: 'chat-only',
			name: 'Chat only',
			parameters: { chat: { enable_thinking: false } },
		});
		const connection = { ...newConnection(), catalog: [definition] };
		expect(defaultThinkingMode(connection, definition.id)).toBe('deep');
		expect(availableThinkingModes(connection, definition.id).map((mode) => mode.id)).toEqual([
			'deep',
		]);
		definition.defaultThinkingMode = 'chat-only';
		expect(defaultThinkingMode(connection, definition.id)).toBe('deep');
		expect(defaultThinkingMode({ ...connection, chatApi: 'chat' }, definition.id)).toBe(
			'chat-only',
		);
		expect(thinkingParameters({ ...connection, chatApi: 'chat' }, definition.id)).toEqual({
			enable_thinking: false,
		});
	});

	it('blocks unconfigured models and legacy empty mappings without making saved catalogs unreadable', () => {
		const connection = {
			...newConnection(),
			catalog: [model({ thinkingModes: [], defaultThinkingMode: undefined })],
		};
		expect(() => thinkingParameters(connection, connection.catalog[0].id)).toThrow(
			'before sending',
		);
		connection.catalog[0].thinkingModes = [
			{ id: 'empty', name: 'Empty', parameters: { responses: {} } },
		];
		expect(() => assertModelCatalog(connection.catalog)).not.toThrow();
		expect(defaultThinkingMode(connection, connection.catalog[0].id)).toBeUndefined();
		expect(() => thinkingParameters(connection, connection.catalog[0].id, 'empty')).toThrow(
			'explicit thinking value',
		);
		expect(hasThinkingValue({ reasoning: {} })).toBe(false);
		expect(hasThinkingValue({ reasoning: { effort: '' } })).toBe(false);
		expect(hasThinkingValue({ enable_thinking: false })).toBe(true);
		expect(hasThinkingValue({ budget_tokens: 0 })).toBe(true);
	});
});

describe('catalog validation and persisted state compatibility', () => {
	it('validates reusable presets with the same safe tuning rules as model-specific modes', () => {
		const preset = model().thinkingModes[0];
		expect(() => assertThinkingPresets([preset])).not.toThrow();
		for (const [presets, error] of [
			[[preset, preset], 'appears more than once'],
			[[{ ...preset, name: ' ' }], 'nonempty ID and name'],
			[[{ ...preset, parameters: {} }], 'at least one API'],
			[[{ ...preset, parameters: { unsupported: {} } }], 'Responses and/or Chat'],
			[
				[{ ...preset, parameters: { chat: { extra_body: { model: 'override' } } } }],
				'cannot override',
			],
			[
				[{ ...preset, parameters: { responses: JSON.parse('{"reasoning":{"__proto__":{}}}') } }],
				'unsafe property',
			],
		] as const) {
			expect(() => assertThinkingPresets(presets)).toThrow(error);
			expect(() => validateState({ ...initialState(), thinkingPresets: presets })).toThrow(error);
		}
	});

	it('rejects invalid workspace prompts while accepting an intentionally blank prompt', () => {
		expect(() => validateState({ ...initialState(), systemPrompt: '' })).not.toThrow();
		for (const systemPrompt of [null, 123, 'x'.repeat(100_001)])
			expect(() => validateState({ ...initialState(), systemPrompt })).toThrow(
				'Workspace data is invalid',
			);
	});

	it('validates and round-trips catalogs and per-thread/message choices in v1 workspaces', () => {
		const state = initialState();
		validateState(state);
		expect(state.connections[0].catalog).toBeUndefined();
		state.connections[0].catalog = [model()];
		state.threads = [
			{
				id: 'thread',
				title: 'Test',
				connectionId: state.activeConnectionId,
				model: 'custom-reasoner',
				thinkingMode: 'deep',
				createdAt: 1,
				updatedAt: 1,
				messages: [
					{
						id: 'message',
						role: 'assistant',
						content: 'Done',
						createdAt: 1,
						model: 'custom-reasoner',
						thinkingMode: 'deep',
					},
				],
			},
		];
		const reloaded = JSON.parse(JSON.stringify(state));
		validateState(reloaded);
		expect(reloaded).toEqual(state);
		state.connections[0].catalog[0].thinkingModes[0].parameters.responses = {
			model: 'other-model',
		};
		expect(() => validateState(state)).toThrow('cannot override the request field "model"');
	});

	it.each([
		['duplicate model IDs', () => [model(), model()], 'appears more than once'],
		['blank ID', () => [model({ id: ' ' })], 'nonempty API model ID'],
		['empty tasks', () => [model({ tasks: [] })], 'supported task'],
		[
			'missing task modality',
			() => [model({ outputModalities: ['image'] })],
			'requires text input and text output',
		],
		[
			'invalid default mode',
			() => [model({ defaultThinkingMode: 'missing' })],
			'default thinking mode',
		],
		[
			'duplicate thinking IDs',
			() => {
				const result = model();
				result.thinkingModes.push(structuredClone(result.thinkingModes[0]));
				return [result];
			},
			'appears more than once',
		],
		[
			'missing endpoint parameters',
			() => [model({ thinkingModes: [{ id: 'empty', name: 'Empty', parameters: {} }] })],
			'at least one API',
		],
	] as const)('rejects %s with an actionable message', (_label, catalog, error) => {
		expect(() => assertModelCatalog(catalog())).toThrow(error);
	});

	it.each([
		'model',
		'messages',
		'input',
		'instructions',
		'stream',
		'store',
		'tools',
		'path',
		'apiKey',
	])('prevents thinking parameter override of %s', (field) => {
		expect(() => validateThinkingParameters({ [field]: 'overridden' })).toThrow('cannot override');
		expect(() => validateThinkingParameters({ extra_body: { [field]: 'overridden' } })).toThrow(
			'cannot override',
		);
	});

	it('rejects prototype keys, cycles, nonfinite values, invalid containers, and oversized tuning objects', () => {
		for (const unsafe of [
			JSON.parse('{"reasoning":{"__proto__":{}}}'),
			JSON.parse('{"reasoning":{"constructor":{}}}'),
			{ effort: undefined },
			{ budget: Infinity },
			{ budget: NaN },
			[],
			new Date(),
			{ one: 'x'.repeat(16_384), two: 'x'.repeat(16_384) },
		])
			expect(() => validateThinkingParameters(unsafe)).toThrow();
		const cycle: Record<string, unknown> = {};
		cycle.child = cycle;
		expect(() => validateThinkingParameters(cycle)).toThrow('circular');
		let deep: Record<string, unknown> = {};
		const root = deep;
		for (let n = 0; n < 14; n++) {
			deep.next = {};
			deep = deep.next as Record<string, unknown>;
		}
		expect(() => validateThinkingParameters(root)).toThrow('maximum depth');
	});
});

describe('explicit Standard mode', () => {
	it.each(['responses', 'chat/completions', 'chat'] as const)(
		'opts into parameter omission on %s without changing existing modes',
		(chatApi) => {
			const definition = model();
			const original = structuredClone(definition.thinkingModes);
			definition.thinkingModes.push(standardThinkingMode());
			const connection = { ...newConnection(), chatApi, catalog: [definition] };
			expect(defaultThinkingMode(connection, definition.id)).toBe('deep');
			expect(thinkingParameters(connection, definition.id, 'standard')).toEqual({});
			expect(thinkingParameters(connection, definition.id)).toEqual(
				original[0].parameters[chatApi === 'responses' ? 'responses' : 'chat'],
			);
			expect(definition.thinkingModes[0]).toEqual(original[0]);
		},
	);

	it('preserves the explicit flag across persisted-state validation without migrating legacy empties', () => {
		const state = initialState();
		state.connections[0].catalog = [
			model({ thinkingModes: [standardThinkingMode()], defaultThinkingMode: 'standard' }),
		];
		const restored = JSON.parse(JSON.stringify(state));
		validateState(restored);
		expect(thinkingParameters(restored.connections[0], 'custom-reasoner')).toEqual({});
		expect(restored.connections[0].catalog![0].thinkingModes[0]).toEqual(standardThinkingMode());
		delete restored.connections[0].catalog![0].thinkingModes[0].useProviderDefaults;
		expect(defaultThinkingMode(restored.connections[0], 'custom-reasoner')).toBeUndefined();
		expect(() => thinkingParameters(restored.connections[0], 'custom-reasoner')).toThrow(
			'before sending',
		);
	});

	it('still requires an endpoint mapping, a boolean opt-in and safe empty defaults', () => {
		const standard = standardThinkingMode();
		delete standard.parameters.chat;
		const connection = {
			...newConnection(),
			chatApi: 'chat' as const,
			catalog: [model({ thinkingModes: [standard] })],
		};
		expect(() => thinkingParameters(connection, 'custom-reasoner', 'standard')).toThrow(
			'explicit thinking value',
		);
		for (const mode of [
			{ ...standardThinkingMode(), useProviderDefaults: 'true' },
			{ ...standardThinkingMode(), parameters: { responses: { reasoning: { effort: 'high' } } } },
			{ ...standardThinkingMode(), parameters: { responses: { model: 'override' } } },
		])
			expect(() =>
				assertModelCatalog([model({ thinkingModes: [mode as unknown as ThinkingMode] })]),
			).toThrow();
	});
});

it('suggests Standard mode for unconfigured models and unavailable endpoint mappings', () => {
	const definition = model({ thinkingModes: [], defaultThinkingMode: undefined });
	const connection = { ...newConnection(), catalog: [definition] };
	expect(() => thinkingParameters(connection, definition.id)).toThrow('Standard mode');
	definition.thinkingModes = [{ id: 'legacy', name: 'Legacy', parameters: { responses: {} } }];
	expect(() => thinkingParameters(connection, definition.id, 'legacy')).toThrow('Standard mode');
});
