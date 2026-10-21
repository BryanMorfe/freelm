import type { Message, Thread } from '../types';

/** Keep version order stable when a selected node moves between active and inactive history. */
const compareMessages = (a: Message, b: Message) =>
	a.createdAt - b.createdAt || a.id.localeCompare(b.id);

/** Upgrade legacy linear history without changing message IDs or provider transcripts. */
export function conversationNodes(thread: Thread): Message[] {
	const nodes = new Map<string, Message>();
	for (const message of thread.messageHistory ?? []) nodes.set(message.id, message);
	let parentId: string | null = null;
	for (const message of thread.messages) {
		const node: Message = message.parentId === undefined ? { ...message, parentId } : message;
		nodes.set(node.id, node);
		parentId = node.id;
	}
	return [...nodes.values()];
}

export function selectConversationPath(
	thread: Thread,
	leafId: string,
	added: Message[] = [],
): Thread {
	const nodes = new Map(conversationNodes(thread).map((message) => [message.id, message]));
	for (const message of added) nodes.set(message.id, message);
	const path: Message[] = [];
	const visited = new Set<string>();
	let current = nodes.get(leafId);
	while (current && !visited.has(current.id)) {
		visited.add(current.id);
		path.push(current);
		current = current.parentId ? nodes.get(current.parentId) : undefined;
	}
	path.reverse();
	if (!path.length) return thread;
	return {
		...thread,
		messages: path,
		messageHistory: [...nodes.values()].filter((message) => !visited.has(message.id)),
		memorySummary: undefined,
		updatedAt: Date.now(),
	};
}

function siblings(thread: Thread, messageId: string) {
	const nodes = conversationNodes(thread);
	const message = nodes.find((node) => node.id === messageId);
	return message
		? nodes
				.filter((node) => node.parentId === message.parentId && node.role === message.role)
				.sort(compareMessages)
		: [];
}
export function versionInfo(thread: Thread, messageId: string): { index: number; count: number } {
	const versions = siblings(thread, messageId);
	return {
		index: Math.max(
			0,
			versions.findIndex((message) => message.id === messageId),
		),
		count: versions.length,
	};
}
export function conversationVersionInfo(
	thread: Thread,
): Map<string, { index: number; count: number }> {
	const groups = new Map<string, Message[]>();
	for (const message of conversationNodes(thread)) {
		const key = JSON.stringify([message.parentId ?? null, message.role]);
		const group = groups.get(key) ?? [];
		group.push(message);
		groups.set(key, group);
	}
	const result = new Map<string, { index: number; count: number }>();
	for (const versions of groups.values()) {
		versions.sort(compareMessages);
		versions.forEach((message, index) => result.set(message.id, { index, count: versions.length }));
	}
	return result;
}
export function selectMessageVersion(thread: Thread, messageId: string, direction: -1 | 1): Thread {
	const versions = siblings(thread, messageId);
	const index = versions.findIndex((message) => message.id === messageId);
	const target = versions[index + direction];
	if (!target) return thread;
	const nodes = conversationNodes(thread);
	const latestChildren = new Map<string, Message>();
	for (const node of nodes) {
		if (!node.parentId) continue;
		const previous = latestChildren.get(node.parentId);
		if (!previous || compareMessages(previous, node) < 0) latestChildren.set(node.parentId, node);
	}
	const visited = new Set<string>();
	let leaf = target;
	while (!visited.has(leaf.id)) {
		visited.add(leaf.id);
		const child = latestChildren.get(leaf.id);
		if (!child) break;
		leaf = child;
	}
	return selectConversationPath(thread, leaf.id);
}

export function forkConversation(
	thread: Thread,
	messageId: string,
	id: string = crypto.randomUUID(),
): Thread {
	const index = thread.messages.findIndex((message) => message.id === messageId);
	if (index < 0) throw new Error('Message not found.');
	if (thread.messages[index].role !== 'assistant')
		throw new Error('Conversations can only branch from assistant replies.');
	const nodes = new Map(conversationNodes(thread).map((message) => [message.id, message]));
	const now = Date.now();
	return {
		...thread,
		id,
		title: `${thread.title} · Branch`,
		titleSource: 'manual',
		messages: thread.messages.slice(0, index + 1).map((message) => nodes.get(message.id)!),
		messageHistory: [],
		queuedMessages: undefined,
		codeQueueFailures: undefined,
		codeQueueDelivery: undefined,
		branchedFrom: { threadId: thread.id, messageId },
		pinned: false,
		archivedAt: undefined,
		memorySummary: undefined,
		createdAt: now,
		updatedAt: now,
	};
}
