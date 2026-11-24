import type { AppState } from '../types';
import type { WorkspaceSnapshot } from '../remote-types';
import { validateState } from '../../electron/validation';
import { createWorkspacePatch, emptyWorkspacePatch, workspaceFields } from '../workspace-patch';
import { normalizeJson } from '../json-normalize';
import { persistentWorkspace } from './temporary-chats';
import { mergeWorkspaceState } from './workspace-merge';

const DATABASE = 'freelm-workspace';
const STORE = 'state';
const KEY = 'workspace';
const sessionKeys = new Map<string, string>();
let pendingSave: Promise<void> = Promise.resolve();
const revisions = new Map<string, string>();
const desktopSaves = new Map<string, Promise<void>>();
interface QueuedSave {
	snapshot: AppState;
	committed: boolean;
	parent?: QueuedSave;
}
const queuedSaves = new Map<string, QueuedSave>();
const conflicts = new Map<string, Error>();
const acceptedStates = new Map<string, AppState>();
const capturedStates = new Map<string, { source: AppState; snapshot: AppState }>();
const captures = new Map<string, WeakMap<object, unknown>>();
const memorySupport = new Map<string, boolean>();
const personalizationSupport = new Map<string, boolean>();
const codeCompactionSupport = new Map<string, boolean>();
const moderationSupport = new Map<string, boolean>();
// Listeners prepare their merge synchronously, then return the state update to
// apply only after every listener has accepted the new persistence baseline.
type WorkspaceRebaseListener = (
	targetId: string,
	previous: AppState,
	next: AppState,
) => void | (() => void);
const workspaceListeners = new Set<WorkspaceRebaseListener>();
export function onWorkspaceRebased(listener: WorkspaceRebaseListener) {
	workspaceListeners.add(listener);
	return () => {
		workspaceListeners.delete(listener);
	};
}
function prepareRebase(targetId: string, previous: AppState, next: AppState): () => void {
	const reject = (error: unknown): never => {
		const message = error instanceof Error ? error.message : String(error);
		const failure = new Error(
			message.includes('WORKSPACE_CONFLICT')
				? message
				: `WORKSPACE_CONFLICT: Could not merge the host update. ${message} Reload before saving again.`,
		);
		conflicts.set(targetId, failure);
		throw failure;
	};
	const updates: (() => void)[] = [];
	try {
		for (const listener of workspaceListeners) {
			const update = listener(targetId, previous, next);
			if (update) updates.push(update);
		}
	} catch (error) {
		reject(error);
	}
	return () => {
		try {
			for (const update of updates) update();
		} catch (error) {
			reject(error);
		}
	};
}
/** Refresh host task checkpoints without overwriting a locally edited draft or setting. */
export async function refreshHostWorkspace(expectedRevision?: string): Promise<void> {
	if (!window.desktop?.hostTasksSnapshot) return;
	await desktopSaves.get('local')?.catch(() => {});
	if (conflicts.has('local')) throw conflicts.get('local');
	// Host activity notifications usually leave workspace data unchanged. Avoid
	// hydrating all inline media merely to discover that we already have this revision.
	if (expectedRevision !== undefined && expectedRevision === revisions.get('local')) return;
	const before = acceptedStates.get('local');
	const snapshot = await window.desktop.workspaceLoad('local');
	if (conflicts.has('local')) throw conflicts.get('local');
	if (!before || !snapshot.state) return;
	if (snapshot.revision === revisions.get('local')) return;
	// Serialize with saves that may have started while the snapshot crossed IPC.
	if (acceptedStates.get('local') !== before) return refreshHostWorkspace(expectedRevision);
	validateState(snapshot.state);
	const applyRebase = prepareRebase('local', before, snapshot.state);
	acceptWorkspaceSnapshot('local', snapshot);
	applyRebase();
}

export function workspaceSupportsMemory(targetId = 'local'): boolean {
	return targetId === 'local' || memorySupport.get(targetId) !== false;
}

export function workspaceSupportsPersonalization(targetId = 'local'): boolean {
	return targetId === 'local' || personalizationSupport.get(targetId) !== false;
}
export function workspaceSupportsCodeCompaction(targetId = 'local'): boolean {
	return targetId === 'local' || codeCompactionSupport.get(targetId) !== false;
}
export function workspaceSupportsModeration(targetId = 'local'): boolean {
	return targetId === 'local' || moderationSupport.get(targetId) === true;
}

export function acceptWorkspaceSnapshot(
	targetId: string,
	snapshot: WorkspaceSnapshot,
): AppState | null {
	if (snapshot.state) validateState(snapshot.state);
	if (snapshot.memorySupported !== undefined) memorySupport.set(targetId, snapshot.memorySupported);
	if (snapshot.personalizationSupported !== undefined)
		personalizationSupport.set(targetId, snapshot.personalizationSupported);
	if (snapshot.codeCompactionSupported !== undefined)
		codeCompactionSupport.set(targetId, snapshot.codeCompactionSupported);
	if (targetId !== 'local') moderationSupport.set(targetId, snapshot.moderationSupported === true);
	revisions.set(targetId, snapshot.revision);
	conflicts.delete(targetId);
	queuedSaves.delete(targetId);
	if (snapshot.state) {
		// AppState is updated immutably. Keep top-level references so changing a chat
		// does not copy or transfer every embedded image in the media gallery.
		acceptedStates.set(targetId, snapshot.state);
		capturedStates.set(targetId, { source: { ...snapshot.state }, snapshot: snapshot.state });
		const cache = new WeakMap<object, unknown>();
		const remember = (value: unknown) => {
			if (!value || typeof value !== 'object' || cache.has(value)) return;
			cache.set(value, value);
			for (const child of Object.values(value)) remember(child);
		};
		remember(snapshot.state);
		captures.set(targetId, cache);
	} else {
		acceptedStates.delete(targetId);
		capturedStates.delete(targetId);
		captures.delete(targetId);
	}
	return snapshot.state;
}

function captureState(state: AppState, targetId: string): AppState {
	const previous = capturedStates.get(targetId);
	const cache = captures.get(targetId) ?? new WeakMap<object, unknown>();
	captures.set(targetId, cache);
	const snapshot = previous ? { ...previous.snapshot } : ({} as AppState);
	for (const key of workspaceFields) {
		if (!previous || !Object.is(state[key], previous.source[key]))
			(snapshot as unknown as Record<string, unknown>)[key] = normalizeJson(state[key], cache);
	}
	capturedStates.set(targetId, { source: { ...state }, snapshot });
	return snapshot;
}

export async function flushStateSaves(targetId = 'local') {
	await desktopSaves.get(targetId);
	if (conflicts.has(targetId)) throw conflicts.get(targetId);
}

function openDatabase(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		if (!('indexedDB' in window)) {
			reject(
				new Error('This browser does not support local workspace storage. Use the desktop app.'),
			);
			return;
		}
		const request = indexedDB.open(DATABASE, 1);
		request.onupgradeneeded = () => request.result.createObjectStore(STORE);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(
				new Error(
					`Could not open local workspace storage: ${request.error?.message ?? 'storage unavailable'}`,
				),
			);
		request.onblocked = () =>
			reject(new Error('Local storage is blocked by another FreeLM tab. Close it and reload.'));
	});
}

export async function getStorageInfo(
	targetId = 'local',
): Promise<{ secure: boolean; location: string; checked?: boolean }> {
	if (targetId !== 'local')
		return { secure: false, location: 'Saved on the remote FreeLM instance' };
	if (window.desktop) return window.desktop.storageInfo();
	return {
		secure: false,
		location: 'This browser · API keys stay in memory until the page closes',
	};
}

export async function loadState(targetId = 'local'): Promise<AppState | null> {
	if (window.desktop) {
		await desktopSaves.get(targetId)?.catch(() => {});
		return acceptWorkspaceSnapshot(targetId, await window.desktop.workspaceLoad(targetId));
	}
	if (targetId !== 'local') throw new Error('Remote workspaces require the desktop app.');
	await pendingSave;
	const database = await openDatabase();
	try {
		const state = await new Promise<AppState | undefined>((resolve, reject) => {
			const transaction = database.transaction(STORE, 'readonly');
			const request = transaction.objectStore(STORE).get(KEY);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () =>
				reject(new Error(`Could not load your workspace: ${request.error?.message}`));
		});
		if (!state) return null;
		validateState(state);
		return {
			...state,
			connections: state.connections.map((connection) => ({
				...connection,
				apiKey: sessionKeys.get(connection.id) ?? '',
			})),
		};
	} finally {
		database.close();
	}
}

export async function saveState(state: AppState, targetId = 'local'): Promise<void> {
	state = persistentWorkspace(state);
	if (window.desktop) {
		validateState(state, capturedStates.get(targetId)?.source);
		if (!workspaceSupportsPersonalization(targetId) && state.personalization !== undefined)
			throw new Error('Update this remote FreeLM instance to use personalization.');
		if (!workspaceSupportsCodeCompaction(targetId) && state.codeCompaction !== undefined)
			throw new Error('Update this remote FreeLM instance to configure Code compaction.');
		if (!workspaceSupportsModeration(targetId) && state.moderation !== undefined)
			throw new Error('Update this remote FreeLM instance to configure media moderation.');
		const snapshot = captureState(state, targetId);
		const fallbackBase = acceptedStates.get(targetId);
		const entry: QueuedSave = { snapshot, committed: false, parent: queuedSaves.get(targetId) };
		queuedSaves.set(targetId, entry);
		const next = (desktopSaves.get(targetId) || Promise.resolve())
			.catch(() => {})
			.then(async () => {
				if (conflicts.has(targetId)) throw conflicts.get(targetId);
				const revision = revisions.get(targetId);
				if (!revision) throw new Error('Load this workspace before saving it.');
				try {
					let base = fallbackBase;
					for (let cursor = entry.parent; cursor; cursor = cursor.parent) {
						if (cursor.committed) {
							base = cursor.snapshot;
							break;
						}
					}
					const concurrentHost =
						targetId === 'local' && !!window.desktop!.hostTasksSnapshot && !!base;
					let expected = revision;
					let previous = acceptedStates.get(targetId);
					for (let attempt = 0; ; attempt++) {
						const nextState =
							concurrentHost && previous
								? mergeWorkspaceState(base!, snapshot, previous)
								: snapshot;
						const patch = previous && createWorkspacePatch(previous, nextState);
						try {
							if (!patch || !emptyWorkspacePatch(patch)) {
								const result =
									targetId === 'local' && patch && window.desktop!.workspacePatch
										? await window.desktop!.workspacePatch(targetId, expected, patch)
										: await window.desktop!.workspaceSave(targetId, expected, nextState);
								revisions.set(targetId, result.revision);
							}
						} catch (error) {
							if (
								!concurrentHost ||
								attempt >= 3 ||
								!(error instanceof Error) ||
								!error.message.includes('WORKSPACE_CONFLICT')
							)
								throw error;
							const fresh = await window.desktop!.workspaceLoad(targetId);
							if (!fresh.state) throw error;
							previous = fresh.state;
							expected = fresh.revision;
							revisions.set(targetId, expected);
							continue;
						}
						// A rejected UI merge is not a failed write: never retry an already
						// committed patch or advance the baseline over unsaved local changes.
						const applyRebase =
							nextState !== snapshot ? prepareRebase(targetId, snapshot, nextState) : undefined;
						acceptedStates.set(targetId, nextState);
						entry.committed = true;
						applyRebase?.();
						break;
					}
				} catch (error) {
					const failure = error instanceof Error ? error : new Error(String(error));
					if (failure.message.includes('WORKSPACE_CONFLICT')) conflicts.set(targetId, failure);
					throw failure;
				} finally {
					if (queuedSaves.get(targetId) === entry) queuedSaves.delete(targetId);
				}
			});
		desktopSaves.set(targetId, next);
		// Consumers receive the rejection; the bookkeeping promise itself must not be unhandled.
		void next.catch(() => {});
		return next;
	}
	if (targetId !== 'local') throw new Error('Remote workspaces require the desktop app.');
	validateState(state);
	const snapshot = structuredClone(state);
	const next = pendingSave.then(async () => {
		const keys = new Map(
			snapshot.connections.map((connection) => [connection.id, connection.apiKey]),
		);
		snapshot.connections = snapshot.connections.map((connection) => ({
			...connection,
			apiKey: '',
		}));
		const database = await openDatabase();
		try {
			await new Promise<void>((resolve, reject) => {
				const transaction = database.transaction(STORE, 'readwrite');
				transaction.objectStore(STORE).put(snapshot, KEY);
				transaction.oncomplete = () => resolve();
				transaction.onerror = () =>
					reject(
						new Error(
							`Could not save your workspace: ${transaction.error?.message ?? 'storage quota exceeded'}`,
						),
					);
				transaction.onabort = () =>
					reject(
						new Error(
							`Workspace save was interrupted: ${transaction.error?.message ?? 'storage quota exceeded'}`,
						),
					);
			});
			sessionKeys.clear();
			for (const [id, key] of keys) sessionKeys.set(id, key);
		} finally {
			database.close();
		}
	});
	pendingSave = next.catch(() => undefined);
	return next;
}
