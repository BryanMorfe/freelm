import type { BotMessage } from '../bot-types';

type Appearance = 'hidden' | 'typing' | 'message';

export interface BotMessageAppearanceSnapshot {
	conversationId: string | undefined;
	latestCreatedAt: number;
	appearances: Map<string, Appearance>;
}

function appearance(message: BotMessage): Appearance {
	if (message.status === 'unsent') return 'hidden';
	if (message.role === 'bot' && message.status === 'pending')
		return message.activity === 'writing' ? 'typing' : 'hidden';
	if (message.role === 'bot' && message.status === 'completed' && !message.content.trim())
		return 'hidden';
	return 'message';
}

/** Compare committed snapshots so reactions, edits, and history refreshes never replay entrances. */
export function nextBotMessageAppearances(
	previous: BotMessageAppearanceSnapshot | undefined,
	conversationId: string | undefined,
	messages: readonly BotMessage[],
	loading = false,
): { snapshot: BotMessageAppearanceSnapshot; entering: Set<string> } {
	const snapshot: BotMessageAppearanceSnapshot = {
		conversationId,
		latestCreatedAt: 0,
		appearances: new Map(),
	};
	const entering = new Set<string>();
	const sameConversation = !!previous && previous.conversationId === conversationId;
	for (const message of messages) {
		const next = appearance(message);
		snapshot.appearances.set(message.id, next);
		snapshot.latestCreatedAt = Math.max(snapshot.latestCreatedAt, message.createdAt);
		if (!sameConversation || loading || next === 'hidden') continue;
		const before = previous.appearances.get(message.id);
		if (
			(before !== undefined && before !== next) ||
			(before === undefined && message.createdAt >= previous.latestCreatedAt)
		)
			entering.add(message.id);
	}
	return { snapshot, entering };
}
