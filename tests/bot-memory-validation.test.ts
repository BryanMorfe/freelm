import { describe, expect, it } from 'vitest';
import type { BotMemory, BotProfile } from '../src/bot-types';
import { validBotMemory, validBotProfile, validateBotCommand } from '../src/lib/bots';

const memory: BotMemory = {
	id: 'memory-1',
	key: 'research-method',
	content: 'The research group chose a controlled benchmark before changing the model.',
	kind: 'decision',
	source: {
		hostId: 'host',
		conversationId: 'group',
		title: 'Research',
		messageIds: ['message-1'],
		group: true,
	},
	createdAt: 1,
	updatedAt: 2,
};
const profile: BotProfile = {
	id: 'researcher',
	name: 'Researcher',
	address: 'researcher@freelm',
	color: '#799fdf',
	identity: '',
	learnedPersonality: '',
	enabled: true,
	historyAccess: false,
	personalityLearning: false,
	connectionId: 'connection',
	model: 'model',
	createdAt: 1,
	updatedAt: 2,
};

describe('persistent bot memory validation', () => {
	it('accepts legacy profiles and independent memory settings with typed evidence', () => {
		expect(validBotProfile(profile)).toBe(true);
		expect(
			validBotProfile({
				...profile,
				memoryEnabled: true,
				memories: [memory],
				memoryError: 'Retry learning later.',
			}),
		).toBe(true);
		expect(validBotMemory(memory)).toBe(true);
		for (const kind of ['fact', 'decision', 'preference', 'relationship', 'task', 'lesson'])
			expect(validBotMemory({ ...memory, kind })).toBe(true);
	});
	it.each([
		{ key: '' },
		{ key: ' '.repeat(3) },
		{ key: 'k'.repeat(161) },
		{ content: '' },
		{ content: 'x'.repeat(2001) },
		{ kind: 'instruction' },
		{ createdAt: NaN },
		{ updatedAt: -1 },
		{ source: { ...memory.source, hostId: '../host' } },
		{ source: { ...memory.source, conversationId: '' } },
		{ source: { ...memory.source, title: 'x'.repeat(257) } },
		{ source: { ...memory.source, messageIds: Array.from({ length: 81 }, (_, i) => `m-${i}`) } },
		{ source: { ...memory.source, messageIds: ['same', 'same'] } },
		{ source: { ...memory.source, group: 'true' } },
	])('rejects malformed memory %j', (changes) => {
		expect(validBotMemory({ ...memory, ...changes })).toBe(false);
	});
	it('bounds profile memory and rejects duplicate memory identities', () => {
		const memories = Array.from({ length: 500 }, (_, index) => ({ ...memory, id: `m-${index}` }));
		expect(validBotProfile({ ...profile, memories })).toBe(true);
		expect(validBotProfile({ ...profile, memories: [...memories, memory] })).toBe(false);
		expect(validBotProfile({ ...profile, memories: [memory, memory] })).toBe(false);
		expect(validBotProfile({ ...profile, memoryEnabled: 'on' })).toBe(false);
		expect(validBotProfile({ ...profile, memoryError: 'x'.repeat(2001) })).toBe(false);
	});
	it('accepts only scoped edit/delete commands and the independent toggle', () => {
		expect(() =>
			validateBotCommand({
				type: 'update-memory',
				botId: 'bot',
				memoryId: 'memory',
				content: 'Corrected decision.',
			}),
		).not.toThrow();
		expect(() =>
			validateBotCommand({ type: 'delete-memory', botId: 'bot', memoryId: 'memory' }),
		).not.toThrow();
		expect(() =>
			validateBotCommand({ type: 'update-bot', botId: 'bot', changes: { memoryEnabled: false } }),
		).not.toThrow();
		for (const command of [
			{ type: 'update-memory', botId: 'bot', memoryId: 'memory', content: '' },
			{ type: 'update-memory', botId: 'bot', memoryId: 'memory', content: 'x'.repeat(2001) },
			{ type: 'delete-memory', botId: 'bot' },
			{ type: 'delete-memory', botId: 'bot', memoryId: '../memory' },
			{ type: 'delete-memory', botId: 'bot', memoryId: 'memory', source: memory.source },
			{ type: 'update-bot', botId: 'bot', changes: { memories: [memory] } },
			{ type: 'update-bot', botId: 'bot', changes: { memoryError: 'arbitrary' } },
		])
			expect(() => validateBotCommand(command)).toThrow();
	});
});
