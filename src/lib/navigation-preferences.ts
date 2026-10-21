import type { ConversationKind, WorkspaceMode } from '../types';

export interface NavigationPreferences {
	version: 1;
	mode: WorkspaceMode;
	conversationKind: ConversationKind;
	audioMode: 'speech' | 'transcription';
	pluginKey: string | null;
}

type NavigationStorage = Pick<Storage, 'getItem' | 'setItem'>;
type NavigationPatch = Partial<Omit<NavigationPreferences, 'version'>>;
const STORAGE_KEY = 'freelm-navigation-v1';
const workspaceModes: readonly WorkspaceMode[] = [
	'chat',
	'code',
	'bots',
	'workflows',
	'images',
	'videos',
	'audio',
];

function defaults(): NavigationPreferences {
	return {
		version: 1,
		mode: 'chat',
		conversationKind: 'chat',
		audioMode: 'speech',
		pluginKey: null,
	};
}

function browserStorage(): NavigationStorage | null {
	try {
		return globalThis.localStorage ?? null;
	} catch {
		return null;
	}
}

function mergePreferences(
	previous: NavigationPreferences,
	value: Record<string, unknown>,
): NavigationPreferences {
	const mode = workspaceModes.includes(value.mode as WorkspaceMode)
		? (value.mode as WorkspaceMode)
		: previous.mode;
	const conversationKind =
		value.conversationKind === 'chat' || value.conversationKind === 'code'
			? value.conversationKind
			: previous.conversationKind;
	return {
		version: 1,
		mode,
		conversationKind: mode === 'chat' || mode === 'code' ? mode : conversationKind,
		audioMode:
			value.audioMode === 'speech' || value.audioMode === 'transcription'
				? value.audioMode
				: previous.audioMode,
		pluginKey:
			value.pluginKey === null ||
			(typeof value.pluginKey === 'string' &&
				value.pluginKey.length <= 512 &&
				value.pluginKey.trim().length > 0)
				? value.pluginKey
				: previous.pluginKey,
	};
}

/** Local UI navigation only: never includes workspace data, drafts, or credentials. */
export function loadNavigationPreferences(
	storage: NavigationStorage | null = browserStorage(),
): NavigationPreferences {
	const fallback = defaults();
	try {
		const raw = storage?.getItem(STORAGE_KEY);
		if (!raw) return fallback;
		const value: unknown = JSON.parse(raw);
		if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
		const record = value as Record<string, unknown>;
		return record.version === 1 ? mergePreferences(fallback, record) : fallback;
	} catch {
		return fallback;
	}
}

/** Read before each sparse write so independent surface controls preserve one another. */
export function saveNavigationPreferences(
	patch: NavigationPatch,
	storage: NavigationStorage | null = browserStorage(),
): void {
	try {
		if (!storage) return;
		const next = mergePreferences(loadNavigationPreferences(storage), patch);
		storage.setItem(STORAGE_KEY, JSON.stringify(next));
	} catch {
		// A disabled or full local store must never prevent navigation.
	}
}
