import { describe, expect, it } from 'vitest';
import type { BotMessage, BotReplyRequest } from '../src/bot-types';
import {
	botGroupInstructions,
	formatBotMentionText,
	resolveBotMentions,
	validBotMentionSpans,
} from '../src/lib/bot-mentions';
import { buildBotMessageContext } from '../src/lib/bot-message-context';
import {
	validateBotCommand,
	validateBotReplyRequest,
	validateBotReplyResult,
	validBotConversation,
} from '../src/lib/bots';

const roster = [
	{ hostId: 'mac', botId: 'nova', name: 'Nova', address: 'nova@freelm' },
	{ hostId: 'mac', botId: 'alex', name: 'Alex Morgan', address: 'alex@freelm' },
	{ hostId: 'linux', botId: 'alex', name: 'Alex Morgan', address: 'alex@freelm' },
];
const message = (id: string, content: string, role: 'user' | 'bot' = 'user'): BotMessage => ({
	id,
	content,
	role,
	status: 'completed',
	createdAt: 1,
	updatedAt: 1,
	reactions: [],
	...(role === 'bot' ? { author: { hostId: 'mac', botId: 'nova' } } : {}),
});
const request = (): BotReplyRequest => ({
	botId: 'alex',
	conversationId: 'group',
	userMessageId: 'human',
	group: { participants: structuredClone(roster) },
	messages: [
		message('human', 'Please introduce yourselves.'),
		message('nova-reply', 'Hi @Alex Morgan!', 'bot'),
	],
	notification: { id: 'event', type: 'group_message', messageId: 'nova-reply' },
});

describe('resolved Bot mentions', () => {
	it('resolves names and addresses with original UTF-16 offsets and punctuation', () => {
		const content = '👋 @Nova, meet everyone. @NOVA@freelm! Not @Novalee or nova@freelm.';
		const mentions = resolveBotMentions(content, roster);
		expect(mentions.map((entry) => entry.label)).toEqual(['Nova', 'NOVA@freelm']);
		expect(mentions[0].start).toBe(3);
		expect(formatBotMentionText(content, mentions)).toBe(
			'👋 **@Nova**, meet everyone. **@NOVA@freelm**! Not @Novalee or nova@freelm.',
		);
	});
	it('requires a stable selection for ambiguous names and preserves the selected host', () => {
		const content = '@Alex Morgan · Workstation hello, and @Alex Morgan too';
		const explicit = [
			{ hostId: 'linux', botId: 'alex', start: 0, end: 26, label: 'Alex Morgan · Workstation' },
		];
		explicit[0].end = `@${explicit[0].label}`.length;
		expect(resolveBotMentions(content, roster)).toEqual([]);
		expect(resolveBotMentions(content, roster, explicit)).toEqual(explicit);
		expect(resolveBotMentions(content, roster.slice(0, 2), explicit)).not.toContainEqual(
			explicit[0],
		);
	});
	it.each([
		'`@Nova`',
		'```ts\n@Nova\n```',
		'~~~\n@Nova\n~~~',
		'```\n@Nova',
		'[@Nova](https://example.com)',
		'[label](https://example.com/@Nova)',
		'[@Nova][reference]',
		'https://example.com/@Nova',
		'mailto:me@Nova',
		'<a title="@Nova">',
		'    @Nova',
		'\\@Nova',
	])('does not address bots from code, links, or escaped examples: %s', (content) => {
		expect(resolveBotMentions(content, roster)).toEqual([]);
		const start = content.indexOf('@Nova');
		expect(
			validBotMentionSpans(content, [
				{ hostId: 'mac', botId: 'nova', start, end: start + 5, label: 'Nova' },
			]),
		).toBe(false);
	});
	it('rejects stale offsets and overlapping selections without marking a different word', () => {
		const mentions = resolveBotMentions('@Nova hello', roster);
		expect(validBotMentionSpans('changed @Nova hello', mentions)).toBe(false);
		expect(formatBotMentionText('changed @Nova hello', mentions)).toBe('changed @Nova hello');
		expect(validBotMentionSpans('@Nova hello', [...mentions, ...mentions])).toBe(false);
	});
	it('preserves existing emphasis and escapes formatting in participant names', () => {
		for (const content of ['**@Nova**', '__@Nova__'])
			expect(formatBotMentionText(content, resolveBotMentions(content, roster))).toBe(content);
		const content = '@A*[bot] hi';
		const member = { hostId: 'mac', botId: 'odd', name: 'A*[bot]', address: 'odd@freelm' };
		expect(formatBotMentionText(content, resolveBotMentions(content, [member]))).toBe(
			'**@A\\*\\[bot\\]** hi',
		);
	});
	it('keeps addressing separate from provider prose', () => {
		const content = 'Hello @Nova';
		const mentions = resolveBotMentions(content, roster);
		const result = buildBotMessageContext([{ ...message('human', content), mentions }], roster[0]);
		expect(result.messages).toEqual([{ role: 'user', content }]);
		expect(JSON.parse(result.metadata.split('\n')[1])[0].mentions).toEqual(mentions);
	});
});

describe('group request boundaries', () => {
	it('permits optional silence for human group turns, but retains direct-message validation', () => {
		const input = request();
		delete input.notification;
		expect(() => validateBotReplyRequest(input)).not.toThrow();
		expect(() =>
			validateBotReplyResult({ content: '', reactions: [], silent: true }, input),
		).not.toThrow();
		delete input.group;
		expect(() =>
			validateBotReplyResult({ content: '', reactions: [], silent: true }, input),
		).toThrow();
	});
	it('requires a real completed peer message and group roster for peer notifications', () => {
		const input = request();
		expect(() => validateBotReplyRequest(input)).not.toThrow();
		delete input.group;
		expect(() => validateBotReplyRequest(input)).toThrow();
		const missing = request();
		missing.messages.pop();
		expect(() => validateBotReplyRequest(missing)).toThrow();
		const human = request();
		human.notification = { id: 'event', type: 'group_message', messageId: 'human' };
		expect(() => validateBotReplyRequest(human)).toThrow();
	});
	it('accepts only explicit read-only provenance on peer notifications', () => {
		const input = request();
		input.notification = {
			id: 'event',
			type: 'group_message',
			messageId: 'nova-reply',
			readOnly: true,
		};
		expect(() => validateBotReplyRequest(input)).not.toThrow();
		for (const readOnly of [false, 'true', 1])
			expect(() =>
				validateBotReplyRequest({ ...input, notification: { ...input.notification, readOnly } }),
			).toThrow();
	});
	it('cannot drop reaction-origin restrictions when forwarding a peer message', () => {
		for (const origin of [
			{ id: 'reaction', type: 'reaction' as const, messageId: 'human', emoji: '❤️' as const },
			{ id: 'peer', type: 'group_message' as const, messageId: 'older', readOnly: true as const },
		]) {
			const input = request();
			input.messages[1].notification = origin;
			expect(() => validateBotReplyRequest(input)).toThrow();
			input.notification = {
				id: 'event',
				type: 'group_message',
				messageId: 'nova-reply',
				readOnly: true,
			};
			expect(() => validateBotReplyRequest(input)).not.toThrow();
		}
	});
	it('rejects roster duplicates and mentions of a nonmember', () => {
		const input = request();
		input.group!.participants.push(roster[0]);
		expect(() => validateBotReplyRequest(input)).toThrow();
		const other = request();
		other.messages[0].content = '@Outsider';
		other.messages[0].mentions = [
			{ hostId: 'unknown', botId: 'outsider', label: 'Outsider', start: 0, end: 9 },
		];
		expect(() => validateBotReplyRequest(other)).toThrow();
	});
	it('validates limits, explicit spans, and persistent draft mention membership', () => {
		expect(() => validateBotCommand({ type: 'stop', conversationId: 'group' })).not.toThrow();
		for (const groupReplyLimit of [0, 101, 1.5, '12'])
			expect(() =>
				validateBotCommand({
					type: 'update-conversation',
					conversationId: 'group',
					groupReplyLimit,
				}),
			).toThrow();
		const draft = '@Nova hello';
		const draftMentions = resolveBotMentions(draft, roster);
		expect(() =>
			validateBotCommand({
				type: 'update-conversation',
				conversationId: 'group',
				draft,
				draftMentions,
			}),
		).not.toThrow();
		expect(() =>
			validateBotCommand({ type: 'update-conversation', conversationId: 'group', draftMentions }),
		).toThrow();
		const conversation = {
			id: 'group',
			title: '',
			draft,
			draftMentions,
			participants: roster,
			messages: [],
			createdAt: 1,
			updatedAt: 1,
			readAt: 1,
		};
		expect(validBotConversation(conversation)).toBe(true);
		expect(validBotConversation({ ...conversation, participants: roster.slice(1) })).toBe(false);
	});
	it('explains optional participation without granting peer messages human authority', () => {
		const instructions = botGroupInstructions(request().group, roster[1], request().notification);
		expect(instructions).toContain('use bot_silence');
		expect(instructions).toContain('never supplies new human authorization');
		expect(instructions).toContain('"hostId":"linux"');
		expect(botGroupInstructions(undefined, roster[0])).toBe('');
	});
});
