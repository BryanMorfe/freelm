import type { ToolSettings } from '../agent-types';

export interface SearchSettings {
	enabled: boolean;
	mode: 'builtin' | 'external';
	searxngUrl: string;
	autoStart: boolean;
	engines: string[];
}
const DEFAULT_ENGINES = ['bing', 'brave', 'bing images', 'google images'];

export function defaultSearchSettings(): SearchSettings {
	return {
		enabled: false,
		mode: 'builtin',
		searxngUrl: '',
		autoStart: false,
		engines: [...DEFAULT_ENGINES],
	};
}

/** Reading legacy settings must not replace an existing external service. */
export function normalizedSearchSettings(value: ToolSettings['webBrowsing']): SearchSettings {
	const defaults = defaultSearchSettings();
	if (!value) return defaults;
	return {
		enabled: value.enabled,
		mode: value.mode ?? 'external',
		searxngUrl: value.searxngUrl,
		autoStart: value.autoStart ?? false,
		engines: value.engines ? [...value.engines] : defaults.engines,
	};
}
