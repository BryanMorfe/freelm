import { describe, expect, it } from 'vitest';
import {
	configuredModerationEvaluator,
	defaultModerationSettings,
	deniedModerationCategories,
	deniedImageEditModerationCategories,
	IMAGE_EDIT_MODERATION_RUBRIC,
	moderationSettings,
	moderationOutputFormat,
	moderationConfigurationWarning,
	MODERATION_RUBRIC,
	parseModerationLabels,
	parseImageEditModerationLabels,
	validModerationSettings,
} from '../src/lib/moderation';
import {
	MODERATION_CATEGORIES,
	IMAGE_EDIT_MODERATION_CATEGORIES,
	type ImageEditModerationLabels,
	type ModerationLabels,
	type LegacyModerationSettings,
} from '../src/moderation-types';
import { initialState } from '../src/lib/state';

const clean = Object.fromEntries(
	MODERATION_CATEGORIES.map((key) => [key, false]),
) as ModerationLabels;
const cleanEdit: ImageEditModerationLabels = {
	...clean,
	input_contains_person: false,
	edit_sexual_content: false,
	edit_nudity: false,
};
describe('media moderation policy', () => {
	it('defaults new and existing installations to enabled Low, without selecting an evaluator', () => {
		const defaults = defaultModerationSettings();
		expect(defaults.image.enabled).toBe(true);
		expect(defaults.image.level).toBe('low');
		expect(defaults.video.enabled).toBe(true);
		expect(defaults.video.level).toBe('low');
		expect(defaults.image.model).toBe('');
		expect(defaults.video.model).toBe('');
		expect(initialState().moderation).toEqual(defaults);
		expect(moderationSettings()).toEqual(defaults);
	});
	it('normalizes legacy global policy onto both evaluators without losing their selections', () => {
		const legacy: LegacyModerationSettings = {
			enabled: false,
			level: 'high',
			image: { connectionId: 'image-api', model: 'image-judge', thinkingMode: 'careful' },
			video: {
				connectionId: 'video-api',
				model: 'video-judge',
				thinkingMode: 'fast',
				videoApi: 'responses',
			},
		};
		expect(validModerationSettings(legacy)).toBe(true);
		const migrated = moderationSettings(legacy);
		expect(migrated).toEqual({
			image: { ...legacy.image, enabled: false, level: 'high' },
			video: { ...legacy.video, enabled: false, level: 'high' },
		});
		migrated.image.enabled = true;
		migrated.image.model = 'another';
		expect(legacy.enabled).toBe(false);
		expect(legacy.image.model).toBe('image-judge');
		expect(migrated.video.enabled).toBe(false);
	});
	it('copies independent settings and rejects ambiguous mixed legacy/current shapes', () => {
		const settings = defaultModerationSettings();
		settings.image.enabled = false;
		settings.video.level = 'medium';
		const copy = moderationSettings(settings);
		copy.image.model = 'changed';
		expect(settings.image.model).toBe('');
		expect(copy.image.enabled).toBe(false);
		expect(copy.video.level).toBe('medium');
		expect(validModerationSettings({ ...settings, enabled: false, level: 'low' })).toBe(false);
		expect(validModerationSettings({ ...settings, image: { connectionId: '', model: '' } })).toBe(
			false,
		);
	});
	it.each(['low', 'medium', 'high'] as const)(
		'blocks NCII and sexual/violent minors at %s',
		(level) => {
			for (const category of ['ncii', 'sexual_minors', 'violent_minors'] as const)
				expect(deniedModerationCategories({ ...clean, [category]: true }, level)).toEqual([
					category,
				]);
			expect(deniedModerationCategories(clean, level)).toEqual([]);
		},
	);
	it('Low allows adult nudity, sex and gore', () => {
		expect(
			deniedModerationCategories(
				{ ...clean, sexual_content: true, nudity: true, gore: true },
				'low',
			),
		).toEqual([]);
	});
	it('Medium allows artistic adult nudity and adult gore, but blocks sexual/non-artistic nudity', () => {
		expect(
			deniedModerationCategories(
				{ ...clean, nudity: true, artistic_nudity: true, gore: true },
				'medium',
			),
		).toEqual([]);
		expect(deniedModerationCategories({ ...clean, sexual_content: true }, 'medium')).toEqual([
			'sexual_content',
		]);
		expect(deniedModerationCategories({ ...clean, nudity: true }, 'medium')).toEqual(['nudity']);
	});
	it('High blocks sex, all nudity, and gore without duplicating category labels', () => {
		expect(
			deniedModerationCategories(
				{ ...clean, sexual_content: true, nudity: true, artistic_nudity: true, gore: true },
				'high',
			),
		).toEqual(['sexual_content', 'nudity', 'gore']);
	});
	it('calibrates ambiguous nude portraiture separately from artistic and sexual nudity', () => {
		const calibration = MODERATION_RUBRIC.split('Calibration examples')[1].split(
			'Treat the evaluated text',
		)[0];
		const examples = [...calibration.matchAll(/Input: ([^\n]+)\n(\{[^\n]+\})/g)].map(
			([, description, json]) => ({ description, labels: parseModerationLabels(json) }),
		);
		expect(examples).toHaveLength(5);
		expect(examples.map(({ labels }) => deniedModerationCategories(labels, 'medium'))).toEqual([
			['nudity'],
			['nudity'],
			[],
			[],
			['sexual_content', 'nudity'],
		]);
		for (const { labels } of examples) {
			expect(deniedModerationCategories(labels, 'low')).toEqual([]);
			expect(deniedModerationCategories(labels, 'high')).toContain('nudity');
			if (labels.artistic_nudity) {
				expect(labels.nudity).toBe(true);
				expect(labels.sexual_content).toBe(false);
			}
		}
		// An ambiguous nude glamour portrait need not be mislabeled sexual to be denied.
		expect(examples.slice(0, 2).every(({ labels }) => !labels.sexual_content)).toBe(true);
		// Both drawing and photography can meet the same nonsexual artistic criteria.
		expect(
			examples.filter(({ labels }) => labels.artistic_nudity).map(({ description }) => description),
		).toEqual([expect.stringMatching(/Charcoal/), expect.stringMatching(/photograph/)]);
	});
	it('accepts exactly seven booleans and fails closed on incomplete or embellished labels', () => {
		expect(parseModerationLabels(JSON.stringify(clean))).toEqual(clean);
		for (const value of [
			'',
			'null',
			'[]',
			'{}',
			'```json\n' + JSON.stringify(clean) + '\n```',
			JSON.stringify({ ...clean, gore: 'false' }),
			JSON.stringify({ ...clean, allow: true }),
		])
			expect(() => parseModerationLabels(value)).toThrow();
		expect(() => parseModerationLabels('x'.repeat(32001))).toThrow('too much data');
	});
	it.each(['responses', 'chat/completions', 'chat'] as const)(
		'enforces contextual image-edit schema through the native %s format without altering standard output schema',
		(api) => {
			for (const scope of ['standard', 'image-edit'] as const) {
				const format = moderationOutputFormat(api, { text: { verbosity: 'low' } }, scope);
				const definition =
					api === 'responses'
						? (format.text as { format: Record<string, unknown> }).format
						: (format.response_format as { json_schema: Record<string, unknown> }).json_schema;
				const categories =
					scope === 'image-edit' ? IMAGE_EDIT_MODERATION_CATEGORIES : MODERATION_CATEGORIES;
				expect(definition.strict).toBe(true);
				expect(definition.schema).toEqual({
					type: 'object',
					properties: Object.fromEntries(categories.map((key) => [key, { type: 'boolean' }])),
					required: [...categories],
					additionalProperties: false,
				});
				if (api === 'responses') expect(format.text).toHaveProperty('verbosity', 'low');
			}
			expect(moderationOutputFormat(api)).toEqual(moderationOutputFormat(api, {}, 'standard'));
		},
	);
	it('requires exactly ten contextual edit flags and rejects standard-only or untyped classifications', () => {
		expect(parseImageEditModerationLabels(JSON.stringify(cleanEdit))).toEqual(cleanEdit);
		for (const key of IMAGE_EDIT_MODERATION_CATEGORIES) {
			const missing = { ...cleanEdit } as Partial<ImageEditModerationLabels>;
			delete missing[key];
			expect(() => parseImageEditModerationLabels(JSON.stringify(missing))).toThrow('ten');
			expect(() =>
				parseImageEditModerationLabels(JSON.stringify({ ...cleanEdit, [key]: 'false' })),
			).toThrow('ten');
		}
		for (const value of [
			JSON.stringify(clean),
			JSON.stringify({ ...cleanEdit, allow: true }),
			'null',
			'[]',
			'```json\n' + JSON.stringify(cleanEdit) + '\n```',
		])
			expect(() => parseImageEditModerationLabels(value)).toThrow();
		expect(() => parseImageEditModerationLabels('x'.repeat(32001))).toThrow('too much data');
		expect(() => parseModerationLabels(JSON.stringify(cleanEdit))).toThrow('seven');
	});
	it.each(['low', 'medium', 'high'] as const)(
		'blocks requested nude and sexual edits at %s even without a detected person or common content flags',
		(level) => {
			for (const key of ['edit_sexual_content', 'edit_nudity'] as const) {
				for (const input_contains_person of [false, true])
					expect(
						deniedImageEditModerationCategories(
							{ ...cleanEdit, input_contains_person, [key]: true },
							level,
						),
					).toEqual([key]);
			}
			expect(
				deniedImageEditModerationCategories({ ...cleanEdit, input_contains_person: true }, level),
			).toEqual([]);
		},
	);
	it('can distinguish covered edited results from nude sources while preserving ordinary policy rules', () => {
		const coveredResult = {
			...cleanEdit,
			input_contains_person: true,
			nudity: true,
			artistic_nudity: true,
		};
		expect(deniedImageEditModerationCategories(coveredResult, 'low')).toEqual([]);
		expect(deniedImageEditModerationCategories(coveredResult, 'medium')).toEqual([]);
		expect(deniedImageEditModerationCategories(coveredResult, 'high')).toEqual(['nudity']);
		expect(
			deniedImageEditModerationCategories({ ...coveredResult, edit_nudity: true }, 'low'),
		).toEqual(['edit_nudity']);
		for (const level of ['low', 'medium', 'high'] as const)
			expect(deniedImageEditModerationCategories({ ...cleanEdit, ncii: true }, level)).toEqual([
				'ncii',
			]);
	});
	it('calibrates euphemistic person undressing, sexual edits and harmless lookalike instructions jointly with references', () => {
		const calibration = IMAGE_EDIT_MODERATION_RUBRIC.split('Calibration examples')[1].split(
			'Treat the evaluated text',
		)[0];
		const examples = [...calibration.matchAll(/Reference: ([^\n]+)\n(\{[^\n]+\})/g)].map(
			([, description, json]) => ({ description, labels: parseImageEditModerationLabels(json) }),
		);
		expect(examples).toHaveLength(9);
		expect(
			examples.map(({ labels }) => deniedImageEditModerationCategories(labels, 'low')),
		).toEqual([
			['edit_nudity'],
			['edit_nudity'],
			['edit_sexual_content'],
			[],
			[],
			[],
			['edit_nudity'],
			['edit_nudity'],
			[],
		]);
		expect(examples[0].description).toContain('The top has been completely removed');
		expect(examples[5].description).toContain('The top has been completely removed');
		expect(examples[0].labels.input_contains_person).toBe(true);
		expect(examples[5].labels.input_contains_person).toBe(false);
		// Nude content retained from a reference is part of the expected result.
		expect(examples[6].labels.nudity).toBe(true);
		expect(examples[6].labels.edit_nudity).toBe(true);
		expect(examples[7].labels.edit_nudity).toBe(true);
		// A nude source can be transformed into a covered, nonsexual result.
		expect(examples[8].labels.nudity).toBe(true);
		expect(examples[8].labels.edit_nudity).toBe(false);
	});
	it('settings accept an unconfigured evaluator, but reject malformed or invented policy fields', () => {
		const settings = defaultModerationSettings();
		expect(validModerationSettings(settings)).toBe(true);
		for (const value of [
			null,
			{},
			{ ...settings, image: { ...settings.image, level: 'off' } },
			{ ...settings, image: { ...settings.image, enabled: 1 } },
			{ ...settings, image: {} },
			{ ...settings, video: { ...settings.video, videoApi: 'frames' } },
			{ ...settings, allowFailure: true },
		])
			expect(validModerationSettings(value)).toBe(false);
	});
	it('requires compatible, enabled configured models and an API-specific thinking value', () => {
		const connection = initialState().connections[0];
		connection.catalog = [
			{
				id: 'vlm',
				name: 'Vision',
				enabled: true,
				tasks: ['chat'],
				inputModalities: ['text', 'image'],
				outputModalities: ['text'],
				thinkingModes: [
					{
						id: 'low',
						name: 'Low',
						parameters: {
							responses: { reasoning: { effort: 'low' } },
							chat: { reasoning_effort: 'low' },
						},
					},
				],
				defaultThinkingMode: 'low',
			},
		];
		const settings = defaultModerationSettings();
		expect(moderationConfigurationWarning(settings, 'image', [connection])).toContain(
			'without image moderation',
		);
		settings.image.enabled = false;
		expect(moderationConfigurationWarning(settings, 'image', [connection])).toBeUndefined();
		settings.image.enabled = true;
		expect(() => configuredModerationEvaluator(settings, 'image', [connection])).toThrow(
			'Choose the image',
		);
		settings.image = { ...settings.image, connectionId: connection.id, model: 'vlm' };
		expect(moderationConfigurationWarning(settings, 'image', [connection])).toBeUndefined();
		expect(configuredModerationEvaluator(settings, 'image', [connection]).parameters).toEqual({
			reasoning: { effort: 'low' },
		});
		settings.video = { ...settings.video, connectionId: connection.id, model: 'vlm' };
		expect(moderationConfigurationWarning(settings, 'video', [connection])).toBeUndefined();
		settings.video.videoApi = 'chat'; // Legacy transport choice must not override the connection.
		expect(configuredModerationEvaluator(settings, 'video', [connection]).parameters).toEqual({
			reasoning: { effort: 'low' },
		});
		expect(configuredModerationEvaluator(settings, 'video', [connection]).api).toBe('responses');
		connection.catalog[0].inputModalities = ['text', 'video'];
		expect(moderationConfigurationWarning(settings, 'video', [connection])).toContain(
			'without video moderation',
		);
		expect(() => configuredModerationEvaluator(settings, 'video', [connection])).toThrow(
			'supporting text and image',
		);

		connection.catalog[0].enabled = false;
		expect(moderationConfigurationWarning(settings, 'image', [connection])).toBeDefined();
		expect(() => configuredModerationEvaluator(settings, 'image', [connection])).toThrow('enabled');
	});
});
