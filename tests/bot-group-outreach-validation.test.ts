import { describe, expect, it } from 'vitest';
import type {
	BotGroupSendRequest,
	BotGroupSendResult,
	BotMessage,
	BotProfile,
	BotReplyRequest,
} from '../src/bot-types';
import {
	botSystemPrompt,
	MAX_BOT_MESSAGE,
	validBotMessage,
	validateBotGroupSendRequest,
	validateBotGroupSendResult,
	validateBotReplyRequest,
} from '../src/lib/bots';

const nova = { hostId: 'mac', botId: 'nova' };
const pip = { hostId: 'linux', botId: 'pip' };
const root = (): BotMessage => ({
	id: 'outreach',
	role: 'bot',
	author: { ...nova },
	content: 'Does anyone need anything?',
	createdAt: 1,
	updatedAt: 1,
	status: 'completed',
	reactions: [],
	replyTo: 'outreach',
	groupOutreach: true,
});
const request = (): BotReplyRequest => ({
	botId: 'pip',
	conversationId: 'general',
	userMessageId: 'outreach',
	source: { hostId: 'mac', title: 'General', updatedAt: 1 },
	group: {
		source: { hostId: 'mac', title: 'General', updatedAt: 1 },
		participants: [
			{ ...nova, name: 'Nova', address: 'nova@freelm' },
			{ ...pip, name: 'Pip', address: 'pip@freelm' },
		],
	},
	messages: [root()],
	notification: {
		id: 'event',
		type: 'group_message',
		messageId: 'outreach',
		readOnly: true,
	},
});
const send = (): BotGroupSendRequest => ({
	operationId: 'bot-action-01234567',
	author: { ...nova },
	conversationId: 'general',
	text: 'Does anyone need anything?',
});
const receipt = (): BotGroupSendResult => ({
	hostId: 'mac',
	conversationId: 'general',
	messageId: 'outreach',
	createdAt: 1,
	deduplicated: false,
});

describe('bot outreach reply context', () => {
	it('accepts an explicit bot-authored root without inventing a human message', () => {
		const value = request();
		expect(validBotMessage(value.messages[0])).toBe(true);
		expect(() => validateBotReplyRequest(value)).not.toThrow();
		expect(value.messages.every((message) => message.role === 'bot')).toBe(true);
	});
	it('accepts a later peer notification while retaining the restricted outreach root', () => {
		const value = request();
		value.messages.push({
			...root(),
			id: 'peer-reply',
			author: { ...pip },
			content: 'I could use a review.',
			groupOutreach: undefined,
		});
		value.notification = {
			id: 'next-event',
			type: 'group_message',
			messageId: 'peer-reply',
			readOnly: true,
		};
		expect(() => validateBotReplyRequest(value)).not.toThrow();
	});
	it.each([
		['missing group', (value: BotReplyRequest): unknown => delete value.group],
		['missing notification', (value: BotReplyRequest): unknown => delete value.notification],
		[
			'unmarked bot root',
			(value: BotReplyRequest): unknown => delete value.messages[0].groupOutreach,
		],
		[
			'different root reference',
			(value: BotReplyRequest): unknown => (value.messages[0].replyTo = 'old-human'),
		],
		[
			'missing root reference',
			(value: BotReplyRequest): unknown => delete value.messages[0].replyTo,
		],
		[
			'foreign author',
			(value: BotReplyRequest): unknown => (value.messages[0].author!.hostId = 'other'),
		],
		['missing author', (value: BotReplyRequest): unknown => delete value.messages[0].author],
		['empty root', (value: BotReplyRequest): unknown => (value.messages[0].content = ' ')],
		['duplicate message ID', (value: BotReplyRequest): unknown => value.messages.push(root())],
	] as const)('rejects %s', (_label, change) => {
		const value = request();
		change(value);
		expect(() => validateBotReplyRequest(value)).toThrow('Invalid bot reply context');
	});
	it('rejects an unrestricted outreach notification and unrelated event types', () => {
		const value = request();
		value.notification = { id: 'event', type: 'group_message', messageId: 'outreach' };
		expect(() => validateBotReplyRequest(value)).toThrow();
		value.notification = {
			id: 'event',
			type: 'job',
			jobId: 'job',
			status: 'succeeded',
			summary: '',
		};
		expect(() => validateBotReplyRequest(value)).toThrow();
	});
	it('accepts reaction feedback on an outreach exchange without turning it into a human request', () => {
		const value = request();
		value.notification = { id: 'event', type: 'reaction', messageId: 'outreach', emoji: '👍' };
		expect(() => validateBotReplyRequest(value)).not.toThrow();
		delete value.group;
		expect(() => validateBotReplyRequest(value)).toThrow();
	});
	it.each(['pending', 'failed', 'unsent'] as const)('rejects a %s outreach marker', (status) => {
		expect(validBotMessage({ ...root(), status })).toBe(false);
	});
	it('rejects marking human messages and preserves ordinary human-root requests', () => {
		const value = request();
		value.messages[0] = { ...root(), role: 'user', author: undefined };
		expect(validBotMessage(value.messages[0])).toBe(false);
		delete value.messages[0].groupOutreach;
		delete value.messages[0].replyTo;
		delete value.group;
		delete value.notification;
		expect(() => validateBotReplyRequest(value)).not.toThrow();
	});
});

describe('group delivery transport validation', () => {
	it('accepts a bounded message and host-qualified author', () => {
		expect(() => validateBotGroupSendRequest(send())).not.toThrow();
		expect(() =>
			validateBotGroupSendRequest({ ...send(), text: 'a'.repeat(MAX_BOT_MESSAGE) }),
		).not.toThrow();
	});
	it.each([
		{ ...send(), operationId: '' },
		{ ...send(), operationId: '../operation' },
		{ ...send(), conversationId: '' },
		{ ...send(), text: ' ' },
		{ ...send(), text: 'a'.repeat(MAX_BOT_MESSAGE + 1) },
		{ ...send(), author: { ...nova, hostId: '' } },
		{ ...send(), author: { ...nova, botId: '' } },
		{ ...send(), author: { ...nova, name: 'Human' } },
		{ ...send(), privateMessages: [] },
		{ ...send(), userMessageId: 'private-human' },
		{ ...send(), author: undefined },
		{ ...send(), text: undefined },
	])('rejects malformed requests %#', (value) => {
		expect(() => validateBotGroupSendRequest(value)).toThrow('Invalid bot group message');
	});
	it('accepts both new and deduplicated delivery receipts', () => {
		expect(() => validateBotGroupSendResult(receipt())).not.toThrow();
		expect(() => validateBotGroupSendResult({ ...receipt(), deduplicated: true })).not.toThrow();
	});
	it.each([
		{ ...receipt(), hostId: '' },
		{ ...receipt(), conversationId: '' },
		{ ...receipt(), messageId: '' },
		{ ...receipt(), createdAt: NaN },
		{ ...receipt(), createdAt: -1 },
		{ ...receipt(), deduplicated: undefined },
		{ ...receipt(), content: 'Unrequested transcript' },
	])('rejects malformed receipts %#', (value) => {
		expect(() => validateBotGroupSendResult(value)).toThrow('invalid delivery receipt');
	});
});

describe('group outreach prompt capabilities', () => {
	const bot = {
		name: 'Nova',
		address: 'nova@freelm',
		identity: '',
		learnedPersonality: '',
		personalityLearning: false,
	} as BotProfile;
	it('describes discovery, consent, privacy, and delivery when those tools are present', () => {
		const prompt = botSystemPrompt(bot, 'Mac', '', [], ['bot_groups_list', 'bot_groups_send']);
		expect(prompt).toContain('resolve group references such as #general');
		expect(prompt).toContain('ask the user to choose if more than one group matches');
		expect(prompt).toContain('human user has authorized that message');
		expect(prompt).toContain('never copy the private conversation transcript');
		expect(prompt).toContain('not that other bots have read it, replied, or completed work');
	});
	it('does not advertise unavailable group tools', () => {
		expect(botSystemPrompt(bot, 'Mac', '', [], [])).not.toContain('bot_groups_list');
		expect(botSystemPrompt(bot, 'Mac', '', [], [])).not.toContain('bot_groups_send');
		expect(botSystemPrompt(bot, 'Mac', '', [], ['bot_groups_list'])).not.toContain(
			'bot_groups_send',
		);
	});
});
