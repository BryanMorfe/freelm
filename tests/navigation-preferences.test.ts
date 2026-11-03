import { describe, expect, it } from 'vitest';
import {
	loadNavigationPreferences,
	saveNavigationPreferences,
} from '../src/lib/navigation-preferences';
import type { WorkspaceMode } from '../src/types';

const key = 'freelm-navigation-v1';
const defaults = {
	version: 1,
	mode: 'chat',
	conversationKind: 'chat',
	audioMode: 'speech',
	pluginKey: null,
};
function fixture(raw?: string) {
	const data = new Map<string, string>(raw ? [[key, raw]] : []);
	return {
		getItem: (name: string) => data.get(name) ?? null,
		setItem: (name: string, value: string) => void data.set(name, value),
	};
}

describe('local navigation preferences', () => {
	it('restores every workspace mode and the last Home and Audio submodes', () => {
		const storage = fixture();
		const modes: WorkspaceMode[] = [
			'chat',
			'code',
			'images',
			'videos',
			'audio',
			'bots',
			'workflows',
			'plugins',
		];
		saveNavigationPreferences({ audioMode: 'transcription' }, storage);
		for (const mode of modes) {
			saveNavigationPreferences({ mode }, storage);
			expect(loadNavigationPreferences(storage)).toEqual({
				...defaults,
				mode,
				conversationKind: mode === 'chat' ? 'chat' : 'code',
				audioMode: 'transcription',
			});
		}
	});

	it('keeps the Home mode authoritative over a missing or conflicting conversation kind', () => {
		for (const mode of ['chat', 'code'] as const) {
			for (const conversationKind of [undefined, 'chat', 'code', 'unsupported']) {
				const storage = fixture(JSON.stringify({ version: 1, mode, conversationKind }));
				expect(loadNavigationPreferences(storage)).toMatchObject({
					mode,
					conversationKind: mode,
				});
			}
		}
	});

	it('merges each write with the latest stored values across independent writers', () => {
		const storage = fixture();
		saveNavigationPreferences({ mode: 'audio' }, storage);
		saveNavigationPreferences({ audioMode: 'transcription' }, storage);
		saveNavigationPreferences({ pluginKey: 'example.plugin:workspace' }, storage);
		saveNavigationPreferences({ conversationKind: 'code' }, storage);
		expect(loadNavigationPreferences(storage)).toEqual({
			version: 1,
			mode: 'audio',
			conversationKind: 'code',
			audioMode: 'transcription',
			pluginKey: 'example.plugin:workspace',
		});
		saveNavigationPreferences({ mode: 'images', pluginKey: null }, storage);
		expect(loadNavigationPreferences(storage)).toMatchObject({
			mode: 'images',
			audioMode: 'transcription',
			pluginKey: null,
		});
	});

	it('uses safe defaults for absent, corrupt, and unsupported records', () => {
		for (const raw of [
			undefined,
			'broken JSON',
			'null',
			'[]',
			'"images"',
			'{"mode":"images"}',
			'{"version":2,"mode":"images"}',
		])
			expect(loadNavigationPreferences(fixture(raw))).toEqual(defaults);
	});

	it('validates fields independently so one invalid value does not discard valid navigation', () => {
		const storage = fixture(
			JSON.stringify({
				version: 1,
				mode: 'images',
				conversationKind: 'unsupported',
				audioMode: 'transcription',
				pluginKey: { unexpected: true },
			}),
		);
		expect(loadNavigationPreferences(storage)).toEqual({
			...defaults,
			mode: 'images',
			audioMode: 'transcription',
		});
		for (const pluginKey of ['', '   ', 'x'.repeat(513), false]) {
			storage.setItem(key, JSON.stringify({ version: 1, pluginKey }));
			expect(loadNavigationPreferences(storage).pluginKey).toBeNull();
		}
	});

	it('ignores invalid or undefined patch fields and persists only navigation primitives', () => {
		const storage = fixture();
		saveNavigationPreferences({ mode: 'videos', conversationKind: 'code' }, storage);
		saveNavigationPreferences(
			{
				mode: 'unsupported',
				conversationKind: undefined,
				version: 9,
				draft: 'private message',
				credentials: 'secret',
			} as never,
			storage,
		);
		expect(JSON.parse(storage.getItem(key)!)).toEqual({
			...defaults,
			mode: 'videos',
			conversationKind: 'code',
		});
	});

	it('does not fail navigation when local storage is unavailable or throws', () => {
		expect(loadNavigationPreferences(null)).toEqual(defaults);
		expect(() => saveNavigationPreferences({ mode: 'images' }, null)).not.toThrow();
		const unavailable = {
			getItem: () => {
				throw new Error('Access denied');
			},
			setItem: () => {
				throw new Error('Quota exceeded');
			},
		};
		expect(loadNavigationPreferences(unavailable)).toEqual(defaults);
		expect(() => saveNavigationPreferences({ mode: 'images' }, unavailable)).not.toThrow();
	});
});
