import type { AppearanceAccent, AppearanceSettings } from '../types';

export const appearanceOptions: readonly {
	value: AppearanceAccent;
	label: string;
	color?: string;
}[] = [
	{ value: 'default', label: 'Default', color: '#808080' },
	{ value: 'blue', label: 'Blue', color: '#2563eb' },
	{ value: 'green', label: 'Green', color: '#22c55e' },
	{ value: 'yellow', label: 'Yellow', color: '#eab308' },
	{ value: 'pink', label: 'Pink', color: '#ec4899' },
	{ value: 'orange', label: 'Orange', color: '#f97316' },
	{ value: 'purple', label: 'Purple', color: '#a855f7' },
	{ value: 'white', label: 'White', color: '#ffffff' },
	{ value: 'custom', label: 'Custom' },
];

export interface AppearanceColors {
	bubble: string;
	bubbleText: string;
	primary: string;
	onPrimary: string;
	accent: string;
}

export function defaultAppearance(): AppearanceSettings {
	return { accent: 'default', customAccent: '#2563eb' };
}

/** CSS names, alpha channels, functions, and arbitrary CSS are intentionally unsupported. */
export function normalizeAccentColor(input: string): string | undefined {
	const hex = input.trim().toLowerCase();
	if (/^#[0-9a-f]{6}$/.test(hex)) return hex;
	if (/^#[0-9a-f]{3}$/.test(hex))
		return `#${[...hex.slice(1)].map((character) => character.repeat(2)).join('')}`;
	return undefined;
}

/** Missing legacy settings use defaults; present settings must be complete and valid. */
export function normalizeAppearance(value?: unknown): AppearanceSettings {
	if (value === undefined) return defaultAppearance();
	if (
		value === null ||
		typeof value !== 'object' ||
		Array.isArray(value) ||
		Object.keys(value).some((key) => !['accent', 'customAccent'].includes(key))
	)
		throw new Error('Appearance settings are invalid.');
	const candidate = value as Record<string, unknown>;
	if (
		!appearanceOptions.some((option) => option.value === candidate.accent) ||
		typeof candidate.customAccent !== 'string'
	)
		throw new Error('Appearance settings are invalid.');
	const customAccent = normalizeAccentColor(candidate.customAccent);
	if (!customAccent) throw new Error('Appearance settings are invalid.');
	return { accent: candidate.accent as AppearanceAccent, customAccent };
}

/** Persisted settings are canonical six-digit hex; normalize input before saving. */
export function isAppearanceSettings(value: unknown): value is AppearanceSettings {
	try {
		const normalized = normalizeAppearance(value);
		return (
			value !== undefined && normalized.customAccent === (value as AppearanceSettings).customAccent
		);
	} catch {
		return false;
	}
}

const channels = (hex: string): number[] =>
	[1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
function luminance(hex: string): number {
	const linear = channels(hex).map((channel) => {
		const value = channel / 255;
		return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	});
	return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}
function contrast(first: string, second: string): number {
	const a = luminance(first);
	const b = luminance(second);
	return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
function foreground(background: string): string {
	return contrast(background, '#ffffff') >= contrast(background, '#000000') ? '#ffffff' : '#000000';
}
function blend(color: string, target: string, amount: number): string {
	const destination = channels(target);
	return `#${channels(color)
		.map((channel, index) =>
			Math.round(channel + (destination[index] - channel) * amount)
				.toString(16)
				.padStart(2, '0'),
		)
		.join('')}`;
}
export function resolveAppearance(
	value: AppearanceSettings | undefined,
	theme: 'light' | 'dark',
): AppearanceColors {
	const settings = normalizeAppearance(value);
	if (settings.accent === 'default')
		return theme === 'dark'
			? {
					bubble: '#242424',
					bubbleText: '#ececec',
					primary: '#f1f1f1',
					onPrimary: '#141414',
					accent: '#a8d6bd',
				}
			: {
					bubble: '#f0f0f0',
					bubbleText: '#222222',
					primary: '#242424',
					onPrimary: '#ffffff',
					accent: '#276346',
				};
	const primary =
		settings.accent === 'custom'
			? settings.customAccent
			: appearanceOptions.find((option) => option.value === settings.accent)!.color!;
	const bubble =
		theme === 'dark' && primary !== '#ffffff' ? blend(primary, '#000000', 0.5) : primary;
	return {
		bubble,
		bubbleText: foreground(bubble),
		primary,
		onPrimary: foreground(primary),
		accent: theme === 'dark' ? '#a8d6bd' : '#276346',
	};
}

/** Provide a subtle hairline border whenever a surface accent blends into the theme background. */
export function appearanceSurfaceBorders(
	colors: AppearanceColors,
	theme: 'light' | 'dark',
): { primaryBorder: string; bubbleBorder: string } {
	const background = theme === 'dark' ? '#121212' : '#ffffff';
	const edge = theme === 'dark' ? '#ffffff38' : '#00000024';
	return {
		primaryBorder: contrast(colors.primary, background) < 1.4 ? edge : 'transparent',
		bubbleBorder: contrast(colors.bubble, background) < 1.4 ? edge : 'transparent',
	};
}
