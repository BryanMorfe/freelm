import type { CodeQueueFailure, Message, QueuedCodeMessage, Thread } from '../types';

export const MAX_CODE_QUEUE_FAILURES = 10_000;
export const MAX_CODE_QUEUE_FAILURE_MESSAGE_IDS = 10_000;
export const MAX_CODE_QUEUE_FAILURE_ERROR = 10_000;
export const INTERRUPTED_CODE_QUEUE_ERROR =
	'This queued message was interrupted when FreeLM closed. Retry to continue.';

type CommittedMessage = Pick<Message, 'id'>;
type QueueEdit = Partial<
	Pick<QueuedCodeMessage, 'content' | 'attachments' | 'replyTo' | 'composer'>
>;

/** Stable IDs prevent replaying an input already accepted into conversation history. */
export function pruneCommittedCodeQueue(
	queue: QueuedCodeMessage[] | undefined,
	committed: readonly CommittedMessage[] = [],
): QueuedCodeMessage[] {
	const messages = queue ?? [];
	const ids = new Set(committed.map((message) => message.id));
	const seen = new Set<string>();
	const remaining = messages.filter((message) => {
		if (ids.has(message.id) || seen.has(message.id)) return false;
		seen.add(message.id);
		return true;
	});
	return remaining.length === messages.length ? messages : remaining;
}

export function addQueuedCodeMessage(
	queue: QueuedCodeMessage[] | undefined,
	message: QueuedCodeMessage,
	committed: readonly CommittedMessage[] = [],
): QueuedCodeMessage[] {
	const messages = pruneCommittedCodeQueue(queue, committed);
	if (
		messages.some((entry) => entry.id === message.id) ||
		committed.some((entry) => entry.id === message.id)
	)
		return messages;
	return [
		...messages,
		{
			...message,
			...(message.attachments && { attachments: message.attachments.slice() }),
			...(message.replyTo && { replyTo: { ...message.replyTo } }),
			...(message.composer && { composer: structuredClone(message.composer) }),
		},
	];
}

export function editQueuedCodeMessage(
	queue: QueuedCodeMessage[] | undefined,
	id: string,
	edit: QueueEdit,
): QueuedCodeMessage[] {
	const messages = queue ?? [];
	if (!messages.some((message) => message.id === id)) return messages;
	return messages.map((message) =>
		message.id === id
			? {
					...message,
					...(edit.content !== undefined && { content: edit.content }),
					...(Object.hasOwn(edit, 'composer') && {
						composer: edit.composer ? structuredClone(edit.composer) : undefined,
					}),
					...(Object.hasOwn(edit, 'attachments') && {
						attachments: edit.attachments?.slice(),
					}),
					...(Object.hasOwn(edit, 'replyTo') && {
						replyTo: edit.replyTo ? { ...edit.replyTo } : undefined,
					}),
				}
			: message,
	);
}

export function removeQueuedCodeMessage(
	queue: QueuedCodeMessage[] | undefined,
	id: string,
): QueuedCodeMessage[] {
	const messages = queue ?? [];
	return messages.some((message) => message.id === id)
		? messages.filter((message) => message.id !== id)
		: messages;
}

/** Select by ID without changing FIFO order, including when the selection is reversed. */
export function drainQueuedCodeMessages(
	queue: QueuedCodeMessage[] | undefined,
	selectedIds?: readonly string[],
	committed: readonly CommittedMessage[] = [],
): { drained: QueuedCodeMessage[]; remaining: QueuedCodeMessage[] } {
	const messages = pruneCommittedCodeQueue(queue, committed);
	if (selectedIds === undefined) return { drained: messages, remaining: [] };
	const selected = new Set(selectedIds);
	const drained: QueuedCodeMessage[] = [];
	const remaining: QueuedCodeMessage[] = [];
	for (const message of messages) (selected.has(message.id) ? drained : remaining).push(message);
	return { drained, remaining: drained.length ? remaining : messages };
}

function identifier(value: string): boolean {
	return value.trim().length > 0 && value.length <= 256;
}

/** Store references to already accepted users, never another copy of their assets. */
export function createCodeQueueFailure(
	assistantId: string,
	messages: readonly Pick<Message, 'id' | 'role'>[],
	error: string,
	failedAt = Date.now(),
	id: string = crypto.randomUUID(),
): CodeQueueFailure | undefined {
	const messageIds = [
		...new Set(
			messages
				.filter((message) => message.role === 'user' && identifier(message.id))
				.map((message) => message.id),
		),
	];
	if (!messageIds.length) return undefined;
	if (!identifier(assistantId) || !identifier(id) || !Number.isFinite(failedAt) || failedAt < 0)
		throw new Error('Invalid queued-message failure metadata.');
	if (messageIds.length > MAX_CODE_QUEUE_FAILURE_MESSAGE_IDS)
		throw new Error('Too many accepted inputs in one queued-message failure.');
	return {
		id,
		assistantId,
		messageIds,
		error: (error.trim() || 'FreeLM could not finish this queued message.').slice(
			0,
			MAX_CODE_QUEUE_FAILURE_ERROR,
		),
		failedAt,
	};
}

function validFailureReferences(
	failure: Pick<CodeQueueFailure, 'assistantId' | 'messageIds'>,
	messages: ReadonlyMap<string, Message>,
): boolean {
	return (
		messages.get(failure.assistantId)?.role === 'assistant' &&
		failure.messageIds.length > 0 &&
		failure.messageIds.every((id) => messages.get(id)?.role === 'user')
	);
}

/** Off-path inputs cannot offer a retry for the current conversation branch. */
export function pruneCodeQueueFailures(
	failures: CodeQueueFailure[] | undefined,
	activeMessages: readonly Message[],
): CodeQueueFailure[] {
	const current = failures ?? [];
	if (!current.length) return current;
	const messages = new Map(activeMessages.map((message) => [message.id, message]));
	const ids = new Set<string>(),
		assistants = new Set<string>(),
		users = new Set<string>();
	const retained = current.filter((failure) => {
		if (
			!validFailureReferences(failure, messages) ||
			ids.has(failure.id) ||
			assistants.has(failure.assistantId) ||
			failure.messageIds.some((id) => users.has(id))
		)
			return false;
		ids.add(failure.id);
		assistants.add(failure.assistantId);
		failure.messageIds.forEach((id) => users.add(id));
		return true;
	});
	return retained.length === current.length ? current : retained;
}

export function addCodeQueueFailure(
	failures: CodeQueueFailure[] | undefined,
	failure: CodeQueueFailure,
	activeMessages: readonly Message[],
): CodeQueueFailure[] {
	const current = pruneCodeQueueFailures(failures, activeMessages);
	if (
		!validFailureReferences(
			failure,
			new Map(activeMessages.map((message) => [message.id, message])),
		)
	)
		return current;
	const inputIds = new Set(failure.messageIds);
	const replaced = current.filter(
		(entry) =>
			entry.assistantId !== failure.assistantId &&
			entry.id !== failure.id &&
			!entry.messageIds.some((id) => inputIds.has(id)),
	);
	if (replaced.length >= MAX_CODE_QUEUE_FAILURES)
		throw new Error('Too many failed queued messages.');
	return [...replaced, { ...failure, messageIds: failure.messageIds.slice() }];
}

export function removeCodeQueueFailure(
	failures: CodeQueueFailure[] | undefined,
	id: string,
): CodeQueueFailure[] {
	const current = failures ?? [];
	return current.some((failure) => failure.id === id)
		? current.filter((failure) => failure.id !== id)
		: current;
}

/** Recover an unfinished delivery without replaying accepted user inputs or tools. */
export function recoverCodeQueueFailures(thread: Thread): Thread {
	if (!thread.codeQueueDelivery && !thread.codeQueueFailures?.length) return thread;
	const messages = new Map(thread.messages.map((message) => [message.id, message]));
	const pruned = pruneCodeQueueFailures(thread.codeQueueFailures, thread.messages);
	let codeQueueFailures = pruned.filter((failure) => {
		const owner = messages.get(failure.assistantId)!;
		return owner.completedAt === undefined || !!owner.error || !!owner.interrupted;
	});
	if (codeQueueFailures.length === pruned.length) codeQueueFailures = pruned;
	const delivery = thread.codeQueueDelivery;
	if (delivery) {
		const owner = messages.get(delivery.assistantId);
		if (
			owner &&
			validFailureReferences(delivery, messages) &&
			(owner.completedAt === undefined || owner.error || owner.interrupted)
		) {
			const previous = codeQueueFailures.find(
				(failure) => failure.assistantId === delivery.assistantId,
			);
			const failure = createCodeQueueFailure(
				delivery.assistantId,
				delivery.messageIds.map((id) => messages.get(id)!),
				owner.error || INTERRUPTED_CODE_QUEUE_ERROR,
				previous?.failedAt ?? delivery.startedAt,
				previous?.id,
			);
			if (failure)
				codeQueueFailures = addCodeQueueFailure(codeQueueFailures, failure, thread.messages);
		}
	}
	if (!delivery && codeQueueFailures === thread.codeQueueFailures) return thread;
	if (!delivery && thread.codeQueueFailures === undefined && codeQueueFailures.length === 0)
		return thread;
	const { codeQueueDelivery: _delivery, ...recovered } = thread;
	return {
		...recovered,
		...(codeQueueFailures.length || thread.codeQueueFailures ? { codeQueueFailures } : {}),
	};
}
