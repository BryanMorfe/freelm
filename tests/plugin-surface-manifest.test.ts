import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	defaultPluginSettings,
	validatePluginManifest,
	validatePluginSettings,
} from '../src/lib/plugin-manifest';

const sample = () => JSON.parse(readFileSync('examples/plugins/follow-up/manifest.json', 'utf8'));
describe('surface plugin manifest and settings contract', () => {
	it('accepts an accountless activation-only package and defaults old optional contributions', () => {
		const manifest = validatePluginManifest(sample());
		expect(manifest.manifestVersion).toBe(2);
		if (manifest.manifestVersion !== 2) throw new Error('Wrong manifest type');
		expect(manifest.runtime.apiVersion).toBe(2);
		expect(manifest.contributes.activation?.surfaces).toEqual(['home.chat', 'home.code']);
		expect(manifest.contributes.tools).toEqual([]);
		expect(manifest.contributes.tabs).toEqual([]);
		expect(manifest.auth).toEqual({ type: 'none' });
		expect(defaultPluginSettings(manifest)).toMatchObject({
			model: { source: 'conversation' },
			recentTurns: 3,
		});
	});
	it('rejects surface capabilities and declarations on API v1', () => {
		const manifest = sample();
		manifest.runtime.apiVersion = 1;
		expect(() => validatePluginManifest(manifest)).toThrow(/unsupported fields/);
	});
	it.each(['process.exec', 'conversation.all', 'composer.submit', 'network.all', '__proto__'])(
		'rejects undeclared capability family %s',
		(capability) => {
			const manifest = sample();
			manifest.permissions.capabilities.push(capability);
			expect(() => validatePluginManifest(manifest)).toThrow(/capability/);
		},
	);
	it.each(['bots', 'home', 'home.*'])('rejects unsupported activation surface %s', (surface) => {
		const manifest = sample();
		manifest.contributes.activation.surfaces = [surface];
		expect(() => validatePluginManifest(manifest)).toThrow(/surfaces/);
	});
	it('rejects duplicate settings, capabilities, surfaces, and reserved IDs', () => {
		for (const mutate of [
			(value: any) => value.contributes.settings.push(value.contributes.settings[0]),
			(value: any) => value.permissions.capabilities.push(value.permissions.capabilities[0]),
			(value: any) => value.contributes.activation.surfaces.splice(1, 1, 'home.chat'),
			(value: any) => (value.contributes.settings[0].id = '__proto__'),
		]) {
			const manifest = sample();
			mutate(manifest);
			expect(() => validatePluginManifest(manifest)).toThrow();
		}
	});
	it('validates bounded settings and custom model identities without adding credentials', () => {
		const manifest = validatePluginManifest(sample());
		const model = {
			source: 'configured',
			hostId: 'local',
			connectionId: 'connection',
			modelId: 'model',
			thinkingModeId: 'high',
		};
		expect(validatePluginSettings(manifest, { model, recentTurns: 7 })).toMatchObject({
			model,
			recentTurns: 7,
			maxOutputTokens: 8192,
		});
		for (const values of [
			{ recentTurns: 0 },
			{ recentTurns: 3.5 },
			{ recentTurns: Infinity },
			{ extra: true },
			{ model: { ...model, apiKey: 'secret' } },
			{ model: { ...model, thinkingModeId: '' } },
			{ instructions: 'x'.repeat(4001) },
		])
			expect(() => validatePluginSettings(manifest, values)).toThrow();
	});
	it('enforces all native settings constraints and validates defaults', () => {
		const manifest = sample();
		manifest.contributes.settings = [
			{ id: 'toggle', type: 'toggle', label: 'Enable', default: false },
			{ id: 'text', type: 'text', label: 'Name', maxLength: 4, default: '' },
			{ id: 'number', type: 'number', label: 'Amount', min: 0, max: 1, step: 0.25, default: 0.5 },
			{
				id: 'enum',
				type: 'enum',
				label: 'Style',
				default: 'short',
				options: [
					{ value: 'short', label: 'Short' },
					{ value: 'long', label: 'Long' },
				],
			},
		];
		const parsed = validatePluginManifest(manifest);
		expect(
			validatePluginSettings(parsed, {
				toggle: true,
				text: 'hello'.slice(0, 4),
				number: 0.75,
				enum: 'long',
			}),
		).toEqual({ toggle: true, text: 'hell', number: 0.75, enum: 'long' });
		for (const values of [
			{ toggle: 'true' },
			{ text: 'hello' },
			{ text: '\nx' },
			{ number: 0.1 },
			{ enum: 'other' },
		])
			expect(() => validatePluginSettings(parsed, values)).toThrow();
		manifest.contributes.settings[0].default = 'yes';
		expect(() => validatePluginManifest(manifest)).toThrow(/value/);
	});
	it('validates custom drawer view entries and keeps view IDs unique', () => {
		const manifest = sample();
		manifest.contributes.views = [{ id: 'report', entry: 'src/report.ts' }];
		expect(validatePluginManifest(manifest)).toHaveProperty(
			'contributes.views',
			manifest.contributes.views,
		);
		manifest.contributes.views[0].entry = '../secret.ts';
		expect(() => validatePluginManifest(manifest)).toThrow(/paths/);
	});
	it('keeps independent examples on minimal capabilities with no account dependency', () => {
		for (const name of ['attachment-drawer', 'rewrite-selection']) {
			const manifest = validatePluginManifest(
				JSON.parse(readFileSync(`examples/plugins/${name}/manifest.json`, 'utf8')),
			);
			expect(manifest.auth.type).toBe('none');
			if (manifest.manifestVersion !== 2) throw new Error('Wrong manifest');
			expect(manifest.permissions.capabilities).not.toContain('conversation.read');
			expect(manifest.permissions.capabilities).not.toContain('inference.text');
		}
	});
});
