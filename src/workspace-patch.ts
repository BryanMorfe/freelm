import type { AppState, Message } from './types';

export const workspaceFields = [
	'version',
	'connections',
	'activeConnectionId',
	'threads',
	'projects',
	'generations',
	'theme',
	'appearance',
	'debugMode',
	'systemPrompt',
	'thinkingPresets',
	'toolSettings',
	'memorySettings',
	'savedMemories',
	'personalization',
	'chatDrafts',
	'dictation',
	'backgroundNotifications',
	'codeCompaction',
	'moderation',
] as const satisfies readonly (keyof AppState)[];
const optionalFields = [
	'appearance',
	'debugMode',
	'systemPrompt',
	'thinkingPresets',
	'toolSettings',
	'memorySettings',
	'savedMemories',
	'personalization',
	'chatDrafts',
	'dictation',
	'backgroundNotifications',
	'codeCompaction',
	'moderation',
] as const;
type OptionalField = (typeof optionalFields)[number];
const collections = ['threads', 'projects', 'generations'] as const;
type Collection = (typeof collections)[number];
const recordFields = {
	threads: [
		'kind',
		'title',
		'titleSource',
		'projectId',
		'connectionId',
		'model',
		'thinkingMode',
		'messages',
		'createdAt',
		'updatedAt',
		'pinned',
		'memorySummary',
		'messageHistory',
		'branchedFrom',
		'archivedAt',
		'temporary',
		'queuedMessages',
		'codeQueueFailures',
		'codeQueueDelivery',
	],
	projects: ['kind', 'directories', 'name', 'instructions', 'createdAt'],
	generations: [
		'kind',
		'prompt',
		'model',
		'connectionId',
		'createdAt',
		'status',
		'assets',
		'text',
		'error',
		'remoteId',
		'progress',
		'parameters',
	],
	messages: [
		'role',
		'content',
		'createdAt',
		'attachments',
		'replyTo',
		'parentId',
		'error',
		'interrupted',
		'model',
		'thinkingMode',
		'toolCalls',
		'agentTranscript',
		'phase',
		'activityFinishedAt',
		'completedAt',
		'activity',
	],
} as const;
type RecordKind = keyof typeof recordFields;

interface Identified {
	id: string;
}
export interface WorkspaceRecordUpdate {
	id: string;
	changes: Record<string, unknown>;
	removed?: string[];
	messages?: WorkspaceRecordDelta<Message>;
}
export interface WorkspaceRecordDelta<T extends Identified> {
	upsert?: T[];
	updates?: WorkspaceRecordUpdate[];
	removed?: string[];
	order?: string[];
}

/** A local IPC delta. Omitted fields and records retain their canonical values. */
export interface WorkspacePatch {
	changes: Partial<AppState>;
	removed?: OptionalField[];
	records?: { [K in Collection]?: WorkspaceRecordDelta<AppState[K][number]> };
}
const record = (candidate: unknown): candidate is Record<string, unknown> =>
	candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate);
const id = (candidate: unknown): candidate is string =>
	typeof candidate === 'string' && candidate.length <= 256;
function ids(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.length <= 100_000 &&
		value.every(id) &&
		new Set(value).size === value.length
	);
}
function validDelta(value: unknown, kind: RecordKind): boolean {
	if (
		!record(value) ||
		Object.keys(value).some((key) => !['upsert', 'updates', 'removed', 'order'].includes(key))
	)
		return false;
	if (value.removed !== undefined && !ids(value.removed)) return false;
	if (value.order !== undefined && !ids(value.order)) return false;
	if (
		value.upsert !== undefined &&
		(!Array.isArray(value.upsert) ||
			value.upsert.length > 100_000 ||
			!value.upsert.every((entry) => record(entry) && id(entry.id)) ||
			new Set(value.upsert.map((entry) => entry.id)).size !== value.upsert.length)
	)
		return false;
	if (value.updates !== undefined) {
		if (
			!Array.isArray(value.updates) ||
			value.updates.length > 100_000 ||
			!value.updates.every((entry) => {
				if (
					!record(entry) ||
					!id(entry.id) ||
					!record(entry.changes) ||
					Object.keys(entry).some((key) => !['id', 'changes', 'removed', 'messages'].includes(key))
				)
					return false;
				if (
					Object.entries(entry.changes).some(
						([key, field]) =>
							!(recordFields[kind] as readonly string[]).includes(key) || field === undefined,
					)
				)
					return false;
				if (
					entry.removed !== undefined &&
					(!ids(entry.removed) ||
						entry.removed.some(
							(key) =>
								!(recordFields[kind] as readonly string[]).includes(key) ||
								Object.hasOwn(entry.changes as object, key),
						))
				)
					return false;
				if (
					entry.messages !== undefined &&
					(kind !== 'threads' ||
						Object.hasOwn(entry.changes, 'messages') ||
						(entry.removed as string[] | undefined)?.includes('messages') ||
						!validDelta(entry.messages, 'messages'))
				)
					return false;
				return true;
			})
		)
			return false;
		if (new Set(value.updates.map((entry) => entry.id)).size !== value.updates.length) return false;
	}
	const changed = [
		...((value.upsert as Identified[] | undefined) ?? []),
		...((value.updates as Identified[] | undefined) ?? []),
	].map((entry) => entry.id);
	return (
		new Set(changed).size === changed.length &&
		!(value.removed as string[] | undefined)?.some((entry) => changed.includes(entry))
	);
}

export function assertWorkspacePatch(value: unknown): asserts value is WorkspacePatch {
	if (
		!record(value) ||
		Object.keys(value).some((key) => !['changes', 'removed', 'records'].includes(key)) ||
		!record(value.changes) ||
		Object.entries(value.changes).some(
			([key, entry]) => !workspaceFields.includes(key as keyof AppState) || entry === undefined,
		) ||
		(value.removed !== undefined &&
			(!Array.isArray(value.removed) ||
				value.removed.some(
					(key) =>
						!optionalFields.includes(key as OptionalField) ||
						Object.hasOwn(value.changes as object, key),
				) ||
				new Set(value.removed).size !== value.removed.length)) ||
		(value.records !== undefined &&
			(!record(value.records) ||
				Object.entries(value.records).some(
					([key, delta]) =>
						!collections.includes(key as Collection) ||
						Object.hasOwn(value.changes as object, key) ||
						!validDelta(delta, key as Collection),
				)))
	)
		throw new Error('Invalid workspace patch.');
}

function recordDelta<T extends Identified>(
	previous: T[],
	next: T[],
	kind: RecordKind,
): WorkspaceRecordDelta<T> | undefined {
	const old = new Map(previous.map((entry) => [entry.id, entry]));
	if (old.size !== previous.length || new Set(next.map((entry) => entry.id)).size !== next.length)
		return undefined;
	const upsert: T[] = [],
		updates: WorkspaceRecordUpdate[] = [];
	for (const entry of next) {
		const before = old.get(entry.id);
		if (before === entry) continue;
		if (
			!before ||
			Object.keys(entry).some(
				(key) => key !== 'id' && !(recordFields[kind] as readonly string[]).includes(key),
			) ||
			Object.keys(before).some(
				(key) => key !== 'id' && !(recordFields[kind] as readonly string[]).includes(key),
			)
		) {
			upsert.push(entry);
			continue;
		}
		const changes: Record<string, unknown> = {},
			removed: string[] = [];
		let messages: WorkspaceRecordDelta<Message> | undefined;
		for (const field of recordFields[kind]) {
			const current = (entry as unknown as Record<string, unknown>)[field];
			const prior = (before as unknown as Record<string, unknown>)[field];
			if (Object.is(current, prior)) continue;
			if (current === undefined) removed.push(field);
			else if (
				kind === 'threads' &&
				field === 'messages' &&
				Array.isArray(prior) &&
				Array.isArray(current)
			) {
				messages = recordDelta(prior as Message[], current as Message[], 'messages');
				if (!messages) changes[field] = current;
			} else changes[field] = current;
		}
		if (Object.keys(changes).length || removed.length || (messages && !emptyDelta(messages)))
			updates.push({
				id: entry.id,
				changes,
				...(removed.length ? { removed } : {}),
				...(messages && !emptyDelta(messages) ? { messages } : {}),
			});
	}
	const nextIds = new Set(next.map((entry) => entry.id));
	const removed = previous.filter((entry) => !nextIds.has(entry.id)).map((entry) => entry.id);
	const order =
		previous.length !== next.length || next.some((entry, index) => entry.id !== previous[index]?.id)
			? next.map((entry) => entry.id)
			: undefined;
	return {
		...(upsert.length ? { upsert } : {}),
		...(updates.length ? { updates } : {}),
		...(removed.length ? { removed } : {}),
		...(order ? { order } : {}),
	};
}

export function createWorkspacePatch(previous: AppState, next: AppState): WorkspacePatch {
	const changes: Record<string, unknown> = {};
	const removed: OptionalField[] = [];
	const records: NonNullable<WorkspacePatch['records']> = {};
	for (const key of workspaceFields) {
		if (Object.is(previous[key], next[key])) continue;
		if (collections.includes(key as Collection)) {
			const delta = recordDelta(
				previous[key] as Identified[],
				next[key] as Identified[],
				key as Collection,
			);
			if (delta) {
				if (!emptyDelta(delta)) (records as Record<string, unknown>)[key] = delta;
				continue;
			}
		}
		if (next[key] === undefined && optionalFields.includes(key as OptionalField))
			removed.push(key as OptionalField);
		else changes[key] = next[key];
	}
	return {
		changes,
		...(removed.length ? { removed } : {}),
		...(Object.keys(records).length ? { records } : {}),
	};
}

function applyDelta<T extends Identified>(previous: T[], delta: WorkspaceRecordDelta<T>): T[] {
	const items = new Map(previous.map((entry) => [entry.id, entry]));
	if (items.size !== previous.length)
		throw new Error('Workspace record identifiers must be distinct before applying a delta.');
	for (const id of delta.removed ?? []) items.delete(id);
	for (const entry of delta.upsert ?? []) items.set(entry.id, entry);
	for (const update of delta.updates ?? []) {
		const old = items.get(update.id);
		if (!old) throw new Error('The workspace record being updated no longer exists.');
		const next = { ...old, ...update.changes } as T;
		for (const key of update.removed ?? [])
			delete (next as unknown as Record<string, unknown>)[key];
		if (update.messages)
			(next as unknown as { messages: Message[] }).messages = applyDelta(
				(old as unknown as { messages: Message[] }).messages,
				update.messages,
			);
		items.set(update.id, next);
	}
	if (!delta.order) return [...items.values()];
	if (delta.order.length !== items.size || delta.order.some((id) => !items.has(id)))
		throw new Error('Invalid workspace record order.');
	return delta.order.map((id) => items.get(id)!);
}

export function applyWorkspacePatch(previous: AppState, patch: WorkspacePatch): AppState {
	const next = { ...previous, ...patch.changes };
	for (const key of patch.removed ?? []) delete next[key];
	for (const key of collections) {
		const delta = patch.records?.[key];
		if (delta)
			(next as unknown as Record<string, unknown>)[key] = applyDelta(
				previous[key] as Identified[],
				delta as WorkspaceRecordDelta<Identified>,
			);
	}
	return next;
}

function emptyDelta(delta: WorkspaceRecordDelta<Identified>): boolean {
	return (
		!delta.upsert?.length &&
		!delta.updates?.length &&
		!delta.removed?.length &&
		delta.order === undefined
	);
}
export function emptyWorkspacePatch(patch: WorkspacePatch): boolean {
	return (
		Object.keys(patch.changes).length === 0 &&
		!patch.removed?.length &&
		!Object.values(patch.records ?? {}).some((delta) => delta && !emptyDelta(delta))
	);
}
