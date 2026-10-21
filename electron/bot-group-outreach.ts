import type { BotConversation, BotParticipant } from '../src/bot-types';
import type { BotTaskToolDefinition } from './bot-host';
import type { BotRecallSource } from './bot-recollection';

export const botGroupOutreachTools: BotTaskToolDefinition[] = [
	{
		name: 'bot_groups_list',
		description:
			'Find groups you belong to by name (for example #general). Empty query lists all. Returns exact host_id and conversation_id; use these to send. Same names on different computers are distinct groups. Unreachable remote groups may be absent.',
		strict: true,
		readOnly: true,
		parameters: {
			type: 'object',
			properties: { query: { type: 'string', maxLength: 256 } },
			required: ['query'],
			additionalProperties: false,
		},
	},
	{
		name: 'bot_groups_send',
		description:
			'Post a user-authorized message as yourself to a member group, using exact IDs from bot_groups_list. Sends only the text you supply, never the private conversation. Other members may respond asynchronously; delivery is not proof of a reply. Resolve ambiguous group names with the user. Do not use for unsolicited cross-group relays.',
		strict: true,
		effect: 'write',
		parameters: {
			type: 'object',
			properties: {
				host_id: { type: 'string' },
				conversation_id: { type: 'string' },
				text: { type: 'string', minLength: 1, maxLength: 32000 },
			},
			required: ['host_id', 'conversation_id', 'text'],
			additionalProperties: false,
		},
	},
];

export function listOutreachGroups(
	args: Record<string, unknown>,
	self: BotParticipant,
	conversations: BotConversation[],
	remote: BotRecallSource[],
) {
	if (
		Object.keys(args).some((key) => key !== 'query') ||
		typeof args.query !== 'string' ||
		args.query.length > 256
	)
		throw new Error('Use a group name or an empty query to list groups.');
	const query = args.query.trim().replace(/^#/, '').toLocaleLowerCase();
	return [
		...conversations.map((conversation) => ({ hostId: self.hostId, conversation })),
		...remote,
	]
		.filter(
			({ conversation }) =>
				conversation.participants.length > 1 &&
				conversation.participants.some(
					(item) => item.hostId === self.hostId && item.botId === self.botId,
				) &&
				(!query || conversation.title.toLocaleLowerCase().includes(query)),
		)
		.map(({ hostId, conversation }) => ({
			host_id: hostId,
			conversation_id: conversation.id,
			title: conversation.title,
			participants: conversation.participants,
		}));
}
