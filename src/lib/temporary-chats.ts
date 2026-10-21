import type { AppState } from '../types';

/** Temporary conversation content never crosses the persistence/export boundary. */
export function persistentWorkspace(state: AppState): AppState {
	const temporaryIds = new Set(state.threads.filter((thread) => thread.temporary).map((thread) => thread.id));
	const draftEntries = Object.entries(state.chatDrafts ?? {}).filter(([key]) => !temporaryIds.has(key) && key !== 'new:chat:temporary');
	const draftsChanged = draftEntries.length !== Object.keys(state.chatDrafts ?? {}).length;
	if (!temporaryIds.size && !draftsChanged) return state;
	return { ...state,
		threads: state.threads.filter((thread) => !thread.temporary),
		...(state.chatDrafts ? { chatDrafts: Object.fromEntries(draftEntries) } : {}),
	};
}
