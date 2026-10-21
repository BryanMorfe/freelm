import { describe, expect, it } from 'vitest';
import { pluginConversationContext } from '../src/lib/plugin-conversation-context';
import type { Message, Thread } from '../src/types';

const message = (id: string, role: Message['role'], content = id): Message => ({
	id,
	role,
	content,
	createdAt: 1,
});
const thread = (messages: Message[]): Thread => ({
	id: 'thread',
	title: 'Test',
	connectionId: 'api',
	model: 'model',
	createdAt: 1,
	updatedAt: 1,
	messages,
});
describe('plugin conversation snapshots', () => {
	it('returns completed active-path exchanges without hidden model context or attachments', () => {
		const value = thread([
			message('u1', 'user'),
			message('a1', 'assistant'),
			message('u2', 'user'),
			message('a2', 'assistant'),
		]);
		value.messageHistory = [message('hidden', 'assistant')];
		value.messages[0].attachments = [
			{ name: 'secret.txt', type: 'text/plain', dataUrl: 'data:text/plain,secret' },
		];
		const result = pluginConversationContext(value, 1, false);
		expect(result.turns).toEqual([
			{
				messages: [
					{ id: 'u2', role: 'user', text: 'u2', createdAt: 1 },
					{ id: 'a2', role: 'assistant', text: 'a2', createdAt: 1 },
				],
			},
		]);
		expect(JSON.stringify(pluginConversationContext(value, 2, false))).not.toMatch(/secret|hidden/);
	});
	it('does not expose an active answer or failed and interrupted exchanges', () => {
		const value = thread([
			message('u1', 'user'),
			{ ...message('a1', 'assistant'), error: 'failure' },
			message('u2', 'user'),
			{ ...message('a2', 'assistant'), interrupted: true },
			message('u3', 'user'),
			message('a3', 'assistant'),
		]);
		expect(pluginConversationContext(value, 3, true).turns).toEqual([]);
		expect(pluginConversationContext(value, 3, false).turns).toHaveLength(1);
	});
	it('groups queued user messages with their final reply, skipping unfinished user input', () => {
		const value = thread([
			message('u1', 'user'),
			message('u2', 'user'),
			message('a1', 'assistant'),
			message('u3', 'user'),
		]);
		expect(pluginConversationContext(value, 3, false).turns[0].messages.map((m) => m.id)).toEqual([
			'u1',
			'u2',
			'a1',
		]);
	});
	it('bounds text and rejects temporary context', () => {
		const value = thread(
			Array.from({ length: 20 }, (_, index) => [
				message(`u${index}`, 'user', 'u'.repeat(20000)),
				message(`a${index}`, 'assistant', 'a'.repeat(20000)),
			]).flat(),
		);
		const result = pluginConversationContext(value, 20, false);
		expect(result.truncated).toBe(true);
		expect(
			result.turns.flatMap((turn) => turn.messages).reduce((sum, m) => sum + m.text.length, 0),
		).toBeLessThanOrEqual(64000);
		expect(() => pluginConversationContext({ ...value, temporary: true }, 1, false)).toThrow(
			/temporary/,
		);
		expect(() => pluginConversationContext(value, 21, false)).toThrow(/between/);
	});
});
