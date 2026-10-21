import type { BotMessage, BotParticipant } from '../bot-types';

const UUID = '[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}';
const LEADING_MESSAGE_ENVELOPE = new RegExp(
	`^[ \\t]*\\[message_id: ${UUID}(?:; replying to message: ${UUID})?(?:; another bot: ${UUID})?\\][ \\t]*(?:\\r?\\n|$)`,
	'i',
);

/**
 * Remove only the standalone transport header older bot prompts taught models to echo.
 * Deliberate protocol examples, ordinary prose, JSON, and fenced code remain untouched.
 * This is a projection for model/UI text, not a migration of the stored conversation.
 */
export function stripBotMessageEnvelope(content: string, triggeringUserText = ''): string {
	if (/\bmessage_id\b/i.test(triggeringUserText)) return content;
	return content.replace(LEADING_MESSAGE_ENVELOPE, '');
}

export interface BotMessageContext {
	messages: { role: 'user' | 'assistant'; content: string }[];
	metadata: string;
}

/** Keep conversation content separate from internal reaction/reply addressing. */
export function buildBotMessageContext(
	history: readonly BotMessage[],
	self: BotParticipant,
): BotMessageContext {
	const messages: BotMessageContext['messages'] = [];
	const references: {
		index: number;
		messageId: string;
		role: BotMessage['role'];
		author?: BotParticipant;
		replyTo?: string;
		reactions?: BotMessage['reactions'];
		mentions?: BotMessage['mentions'];
	}[] = [];
	const userTexts = new Map(
		history
			.filter((message) => message.role === 'user' && message.status === 'completed')
			.map((message) => [message.id, message.content]),
	);
	let precedingUserText = '';
	for (const message of history) {
		if (message.status !== 'completed') continue;
		if (message.role === 'user') precedingUserText = message.content;
		const content =
			message.role === 'user'
				? message.content
				: stripBotMessageEnvelope(
						message.content,
						(message.replyTo && userTexts.get(message.replyTo)) || precedingUserText,
					);
		if (!content.trim()) continue;
		const isPeer =
			message.role === 'bot' &&
			!(message.author?.hostId === self.hostId && message.author.botId === self.botId);
		const peerContent = isPeer
			? `<freelm_peer_message>\n${JSON.stringify({ kind: 'peer_bot_contribution', content }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')}\n</freelm_peer_message>`
			: content;
		messages.push({
			role:
				message.role === 'bot' &&
				message.author?.hostId === self.hostId &&
				message.author.botId === self.botId
					? 'assistant'
					: 'user',
			content: peerContent,
		});
		references.push({
			index: messages.length,
			messageId: message.id,
			role: message.role,
			...(message.author ? { author: { ...message.author } } : {}),
			...(message.replyTo ? { replyTo: message.replyTo } : {}),
			...(message.mentions?.length
				? { mentions: message.mentions.map((mention) => ({ ...mention })) }
				: {}),
			...(message.reactions.length
				? {
						reactions: message.reactions.map(({ actorId, emoji, createdAt }) => ({
							actorId,
							emoji,
							createdAt,
						})),
					}
				: {}),
		});
	}
	return {
		messages,
		metadata: references.length
			? `<freelm_message_context>\n${JSON.stringify(references)}\n</freelm_message_context>`
			: '',
	};
}
