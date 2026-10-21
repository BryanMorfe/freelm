import type { AppState, QueuedCodeMessage, Thread } from '../types';

type RecordValue = Record<string, unknown>;
const own = (value: object, key: string) => Object.hasOwn(value, key);
const sameSlot = (left: object, right: object, key: string) =>
	own(left, key) === own(right, key) &&
	Object.is((left as RecordValue)[key], (right as RecordValue)[key]);

/** Restore only fields which still hold the exact optimistic value. */
function rollbackFields<T extends object>(
	current: T,
	before: T,
	attempted: T,
	skip: ReadonlySet<string> = new Set(),
): T {
	let restored = current;
	for (const key of new Set([...Object.keys(before), ...Object.keys(attempted)])) {
		if (skip.has(key) || sameSlot(before, attempted, key) || !sameSlot(current, attempted, key))
			continue;
		if (restored === current) restored = { ...current };
		if (own(before, key)) (restored as RecordValue)[key] = (before as RecordValue)[key];
		else delete (restored as RecordValue)[key];
	}
	return restored;
}

function sameItems<T>(left: readonly T[], right: readonly T[]) {
	return left.length === right.length && left.every((item, index) => item === right[index]);
}

/** Restore the old position without reordering items added by a concurrent update. */
function insertAtPreviousPosition<T extends { id: string }>(
	items: T[],
	item: T,
	original: readonly T[],
) {
	const originalIndex = original.findIndex((candidate) => candidate.id === item.id);
	for (let index = originalIndex - 1; index >= 0; index--) {
		const previousIndex = items.findIndex((candidate) => candidate.id === original[index].id);
		if (previousIndex >= 0) {
			items.splice(previousIndex + 1, 0, item);
			return;
		}
	}
	for (let index = originalIndex + 1; index < original.length; index++) {
		const nextIndex = items.findIndex((candidate) => candidate.id === original[index].id);
		if (nextIndex >= 0) {
			items.splice(nextIndex, 0, item);
			return;
		}
	}
	items.unshift(item);
}

function rollbackQueue(current: Thread, before: Thread, attempted: Thread, retained: Thread) {
	if (sameSlot(before, attempted, 'queuedMessages')) return current.queuedMessages;
	const oldQueue = before.queuedMessages ?? [];
	const attemptedQueue = attempted.queuedMessages ?? [];
	const currentQueue = current.queuedMessages ?? [];
	const oldById = new Map(oldQueue.map((message) => [message.id, message]));
	const attemptedById = new Map(attemptedQueue.map((message) => [message.id, message]));
	const appended = new Set(
		attemptedQueue.filter((message) => !oldById.has(message.id)).map((message) => message.id),
	);
	const committed = new Set([
		...retained.messages.map((message) => message.id),
		...(retained.messageHistory ?? []).map((message) => message.id),
	]);
	const restored = currentQueue.flatMap((message): QueuedCodeMessage[] => {
		// A failed enqueue is removed by identity even when another enqueue changed the array.
		if (appended.has(message.id)) return [];
		const original = oldById.get(message.id),
			optimistic = attemptedById.get(message.id);
		return [original && optimistic ? rollbackFields(message, original, optimistic) : message];
	});
	const present = new Set(restored.map((message) => message.id));
	for (const message of oldQueue) {
		// Do not resurrect concurrent removals of untouched messages or input already delivered.
		if (attemptedById.has(message.id) || present.has(message.id) || committed.has(message.id))
			continue;
		insertAtPreviousPosition(restored, message, oldQueue);
		present.add(message.id);
	}
	if (sameItems(restored, currentQueue)) {
		// Preserve a concurrent empty array, but undo an optimistic addition of this field.
		if (sameSlot(current, attempted, 'queuedMessages') && sameItems(restored, oldQueue))
			return before.queuedMessages;
		return current.queuedMessages;
	}
	if (sameItems(restored, oldQueue)) return before.queuedMessages;
	return restored;
}

function rollbackThread(current: Thread, before: Thread, attempted: Thread): Thread {
	if (current === attempted) return before;
	let restored = rollbackFields(current, before, attempted, new Set(['queuedMessages']));
	const queue = rollbackQueue(current, before, attempted, restored);
	if (
		queue !== current.queuedMessages ||
		(sameSlot(current, attempted, 'queuedMessages') &&
			own(current, 'queuedMessages') !== own(before, 'queuedMessages'))
	) {
		if (restored === current) restored = { ...current };
		if (queue !== undefined || own(before, 'queuedMessages')) restored.queuedMessages = queue;
		else delete restored.queuedMessages;
	}
	return restored;
}

/**
 * Undo a failed immutable optimistic write without erasing newer streaming or human changes.
 * Queue deltas are reconciled by message ID because concurrent appends replace the array.
 * Call only for a write known not to have committed; this is not a server-conflict merge.
 */
export function rollbackThreadMutation(
	current: AppState,
	before: AppState,
	attempted: AppState,
): AppState {
	if (current === attempted) return before;
	let restored = rollbackFields(current, before, attempted, new Set(['threads']));
	if (before.threads === attempted.threads) return restored;
	let threads: Thread[];
	if (current.threads === attempted.threads) threads = before.threads;
	else {
		const oldById = new Map(before.threads.map((thread) => [thread.id, thread]));
		const attemptedById = new Map(attempted.threads.map((thread) => [thread.id, thread]));
		threads = current.threads.flatMap((thread): Thread[] => {
			const original = oldById.get(thread.id),
				optimistic = attemptedById.get(thread.id);
			if (!original && optimistic === thread) return [];
			if (!original && optimistic?.queuedMessages?.length && thread.queuedMessages?.length) {
				// A concurrently edited new thread survives, but its failed initial enqueue does not.
				const failedIds = new Set(optimistic.queuedMessages.map((message) => message.id));
				const queue = thread.queuedMessages.filter((message) => !failedIds.has(message.id));
				return [
					queue.length === thread.queuedMessages.length
						? thread
						: { ...thread, queuedMessages: queue },
				];
			}
			if (!original || !optimistic || original === optimistic) return [thread];
			return [rollbackThread(thread, original, optimistic)];
		});
		const present = new Set(threads.map((thread) => thread.id));
		for (const thread of before.threads) {
			if (attemptedById.has(thread.id) || present.has(thread.id)) continue;
			insertAtPreviousPosition(threads, thread, before.threads);
			present.add(thread.id);
		}
		if (sameItems(threads, current.threads)) threads = current.threads;
	}
	if (threads !== current.threads) {
		if (restored === current) restored = { ...current };
		restored.threads = threads;
	}
	return restored;
}
