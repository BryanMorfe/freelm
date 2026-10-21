import { describe, expect, it } from 'vitest';
import {
	appearanceOptions,
	defaultAppearance,
	isAppearanceSettings,
	normalizeAccentColor,
	normalizeAppearance,
	resolveAppearance,
} from '../src/lib/appearance';
import { initialState, recoverState } from '../src/lib/state';
import { validateState } from '../electron/validation';

// Independent WCAG measurement of the actual six-digit output colors.
function luminance(color: string): number {
	const rgb = Number.parseInt(color.slice(1), 16);
	const values = [rgb >> 16, (rgb >> 8) & 255, rgb & 255].map((channel) => {
		const fraction = channel / 255;
		return fraction <= 0.04045 ? fraction / 12.92 : Math.pow((fraction + 0.055) / 1.055, 2.4);
	});
	return values.reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
}
function contrast(first: string, second: string): number {
	const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
	return (values[0] + 0.05) / (values[1] + 0.05);
}

describe('appearance configuration', () => {
	it('offers the requested choices and keeps fresh defaults independent', () => {
		expect(appearanceOptions.map((option) => option.label)).toEqual([
			'Default',
			'Blue',
			'Green',
			'Yellow',
			'Pink',
			'Orange',
			'Purple',
			'White',
			'Custom',
		]);
		expect(appearanceOptions[0].color).toBe('#808080');
		expect(appearanceOptions.at(-1)).not.toHaveProperty('color');
		const first = defaultAppearance();
		first.accent = 'yellow';
		expect(defaultAppearance().accent).toBe('default');
		expect(normalizeAppearance()).toEqual(defaultAppearance());
		const state = initialState();
		state.appearance!.customAccent = '#000000';
		expect(initialState().appearance).toEqual(defaultAppearance());
	});
	it('canonicalizes hex input and refuses CSS syntax or incomplete present settings', () => {
		for (const [input, expected] of [
			['#abc', '#aabbcc'],
			[' #AbC ', '#aabbcc'],
			['#A1B2C3', '#a1b2c3'],
			['#000000', '#000000'],
		])
			expect(normalizeAccentColor(input)).toBe(expected);
		for (const input of [
			'',
			'blue',
			'rgb(1,2,3)',
			'#ab',
			'#abcd',
			'#12345678',
			'123456',
			'#aabbgg',
			'#123456; color:red',
			'var(--primary)',
		])
			expect(normalizeAccentColor(input)).toBeUndefined();
		expect(normalizeAppearance({ accent: 'custom', customAccent: ' #AbC ' })).toEqual({
			accent: 'custom',
			customAccent: '#aabbcc',
		});
		for (const invalid of [
			null,
			[],
			'blue',
			{},
			{ accent: 'blue' },
			{ customAccent: '#123456' },
			{ accent: 'unknown', customAccent: '#123456' },
			{ ...defaultAppearance(), extra: 1 },
			{ accent: 'custom', customAccent: 'red' },
		])
			expect(() => normalizeAppearance(invalid)).toThrow('Appearance settings are invalid');
		expect(isAppearanceSettings({ accent: 'custom', customAccent: '#abc' })).toBe(false);
		expect(isAppearanceSettings({ accent: 'custom', customAccent: '#aabbcc' })).toBe(true);
	});
	it('recovers older profiles without mutating their data and keeps completed current profiles stable', () => {
		const legacy = initialState();
		delete legacy.appearance;
		const previous = structuredClone(legacy);
		expect(() => validateState(legacy)).not.toThrow();
		const recovered = recoverState(legacy);
		expect(recovered.appearance).toEqual(defaultAppearance());
		expect(recovered.theme).toBe(previous.theme);
		expect(recovered.connections).toBe(legacy.connections);
		expect(legacy).toEqual(previous);
		expect(recoverState(recovered)).toBe(recovered);
		expect(recoverState(initialState()).appearance).toEqual(defaultAppearance());
	});
});

describe('appearance color resolution', () => {
	it('preserves the existing neutral theme colors exactly for default and legacy profiles', () => {
		expect(resolveAppearance(undefined, 'dark')).toEqual({
			bubble: '#2f2f2f',
			bubbleText: '#ececec',
			primary: '#f1f1f1',
			onPrimary: '#171717',
			accent: '#a8d6bd',
		});
		expect(resolveAppearance(defaultAppearance(), 'light')).toEqual({
			bubble: '#f0f0f0',
			bubbleText: '#222222',
			primary: '#242424',
			onPrimary: '#ffffff',
			accent: '#276346',
		});
	});
	it('keeps every preset readable, with dark bubbles shaded from the primary hue', () => {
		for (const option of appearanceOptions.filter((entry) => entry.value !== 'custom')) {
			for (const theme of ['light', 'dark'] as const) {
				const colors = resolveAppearance({ ...defaultAppearance(), accent: option.value }, theme);
				for (const color of Object.values(colors)) expect(color).toMatch(/^#[0-9a-f]{6}$/);
				expect(contrast(colors.bubble, colors.bubbleText)).toBeGreaterThanOrEqual(4.5);
				expect(contrast(colors.primary, colors.onPrimary)).toBeGreaterThanOrEqual(4.5);
				expect(
					contrast(colors.accent, theme === 'dark' ? '#212121' : '#ffffff'),
				).toBeGreaterThanOrEqual(4.5);
				if (option.value !== 'default') {
					expect(colors.primary).toBe(option.color);
					if (theme === 'dark' && option.value !== 'white')
						expect(luminance(colors.bubble)).toBeLessThan(luminance(colors.primary));
				}
			}
		}
	});
	it('keeps white bubbles white with black text in both themes, including custom white', () => {
		for (const accent of ['white', 'custom'] as const) {
			for (const theme of ['light', 'dark'] as const) {
				const colors = resolveAppearance({ accent, customAccent: '#ffffff' }, theme);
				expect(colors).toMatchObject({
					bubble: '#ffffff',
					bubbleText: '#000000',
					primary: '#ffffff',
					onPrimary: '#000000',
				});
			}
		}
	});
	it('guarantees readable bubble and button colors across arbitrary custom RGB colors without changing semantic accents', () => {
		for (const red of [0, 36, 72, 108, 144, 180, 216, 255]) {
			for (const green of [0, 36, 72, 108, 144, 180, 216, 255]) {
				for (const blue of [0, 36, 72, 108, 144, 180, 216, 255]) {
					const customAccent = `#${[red, green, blue].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
					for (const theme of ['light', 'dark'] as const) {
						const colors = resolveAppearance({ accent: 'custom', customAccent }, theme);
						expect(colors.primary).toBe(customAccent);
						expect(contrast(colors.bubble, colors.bubbleText)).toBeGreaterThanOrEqual(4.5);
						expect(contrast(colors.primary, colors.onPrimary)).toBeGreaterThanOrEqual(4.5);
						expect(colors.accent).toBe(theme === 'dark' ? '#a8d6bd' : '#276346');
					}
				}
			}
		}
	});
});
