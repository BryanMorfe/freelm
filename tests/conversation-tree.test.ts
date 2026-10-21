import { describe, expect, it } from 'vitest';
import type { Message, Thread } from '../src/types';
import {
	conversationNodes,
	conversationVersionInfo,
	forkConversation,
	selectConversationPath,
	selectMessageVersion,
	versionInfo,
} from '../src/lib/conversation-tree';

const message = (
	id: string,
	role: Message['role'],
	createdAt: number,
	parentId?: string | null,
): Message => ({
	id,
	role,
	content: id,
	createdAt,
	...(parentId !== undefined ? { parentId } : {}),
});
const thread = (messages: Message[]): Thread => ({
	id: 'chat',
	kind: 'chat',
	title: 'Tree',
	model: 'fixture',
	connectionId: 'provider',
	createdAt: 1,
	updatedAt: 1,
	messages,
});
const ids = (value: Thread) => value.messages.map((entry) => entry.id);

describe('conversation paths, edits and preserved response versions', () => {
	it('normalizes legacy linear parents without mutating IDs, attachments or provider transcripts', () => {
		const first = message('u1', 'user', 1);
		const reply = {
			...message('a1', 'assistant', 2),
			agentTranscript: {
				api: 'responses' as const,
				items: [{ type: 'message', content: 'Preserved replay' }],
			},
		};
		const value = thread([first, reply, message('u2', 'user', 3)]);
		const normalized = conversationNodes(value);
		expect(normalized.map((entry) => [entry.id, entry.parentId])).toEqual([
			['u1', null],
			['a1', 'u1'],
			['u2', 'a1'],
		]);
		expect(first).not.toHaveProperty('parentId');
		expect(reply).not.toHaveProperty('parentId');
		expect(normalized[1].agentTranscript).toBe(reply.agentTranscript);
	});
	it('regenerates an older answer as a sibling and restores its original continuation', () => {
		const value = thread([
			message('u1', 'user', 1),
			message('a1', 'assistant', 2),
			message('u2', 'user', 3),
			message('a2', 'assistant', 4),
		]);
		const regenerated = selectConversationPath(value, 'a1-new', [
			message('a1-new', 'assistant', 5, 'u1'),
		]);
		expect(ids(regenerated)).toEqual(['u1', 'a1-new']);
		expect(regenerated.messageHistory!.map((entry) => entry.id).sort()).toEqual(['a1', 'a2', 'u2']);
		expect(versionInfo(regenerated, 'a1-new')).toEqual({ index: 1, count: 2 });
		const restored = selectMessageVersion(regenerated, 'a1-new', -1);
		expect(ids(restored)).toEqual(['u1', 'a1', 'u2', 'a2']);
		expect(ids(selectMessageVersion(restored, 'a1', 1))).toEqual(['u1', 'a1-new']);
	});
	it('edits an older user prompt without leaking the replaced question or answer into the selected path', () => {
		const value = thread([
			message('u1', 'user', 1),
			message('a1', 'assistant', 2),
			message('u2', 'user', 3),
			message('a2', 'assistant', 4),
		]);
		const edited = selectConversationPath(value, 'a2-edited', [
			message('u2-edited', 'user', 5, 'a1'),
			message('a2-edited', 'assistant', 6, 'u2-edited'),
		]);
		expect(ids(edited)).toEqual(['u1', 'a1', 'u2-edited', 'a2-edited']);
		expect(conversationVersionInfo(edited).get('u2-edited')).toEqual({ index: 1, count: 2 });
		expect(ids(selectMessageVersion(edited, 'u2-edited', -1))).toEqual(['u1', 'a1', 'u2', 'a2']);
		expect(new Set(conversationNodes(edited).map((entry) => entry.id)).size).toBe(6);
	});
	it('forks the selected path in conversational order after switching versions', () => {
		const original = thread([
			message('u1', 'user', 1),
			message('a1', 'assistant', 2),
			message('u2', 'user', 3),
			message('a2', 'assistant', 4),
		]);
		const alternative = selectConversationPath(original, 'new-answer', [
			message('new-answer', 'assistant', 5, 'u1'),
		]);
		const restored = selectMessageVersion(alternative, 'new-answer', -1);
		const originalSnapshot = structuredClone(restored);
		const fork = forkConversation({ ...restored, pinned: true, archivedAt: 10 }, 'a1', 'fork');
		expect(ids(fork)).toEqual(['u1', 'a1']);
		expect(fork.messages.at(-1)?.role).toBe('assistant');
		expect(fork.branchedFrom).toEqual({ threadId: 'chat', messageId: 'a1' });
		expect(fork.messageHistory).toEqual([]);
		expect(fork.pinned).toBe(false);
		expect(fork.archivedAt).toBeUndefined();
		expect(fork.messages.every((entry) => entry.parentId !== undefined)).toBe(true);
		expect(ids(restored)).toEqual(['u1', 'a1', 'u2', 'a2']);
		expect(restored).toEqual(originalSnapshot);
	});
	it.each(['u1', 'u2'])(
		'rejects branching from user endpoint %s without changing the original',
		(endpoint) => {
			const original = thread([
				message('u1', 'user', 1),
				message('a1', 'assistant', 2),
				message('u2', 'user', 3),
				message('a2', 'assistant', 4),
			]);
			const snapshot = structuredClone(original);
			expect(() => forkConversation(original, endpoint, 'invalid-fork')).toThrowError(
				new Error('Conversations can only branch from assistant replies.'),
			);
			expect(original).toEqual(snapshot);
		},
	);
	it('keeps equal-timestamp version ordering stable after switching, including bulk version labels', () => {
		const value = thread([
			message('u1', 'user', 1, null),
			message('answer-z', 'assistant', 2, 'u1'),
		]);
		value.messageHistory = [message('answer-a', 'assistant', 2, 'u1')];
		expect(versionInfo(value, 'answer-z')).toEqual({ index: 1, count: 2 });
		const previous = selectMessageVersion(value, 'answer-z', -1);
		expect(ids(previous)).toEqual(['u1', 'answer-a']);
		expect(versionInfo(previous, 'answer-a')).toEqual({ index: 0, count: 2 });
		expect(conversationVersionInfo(previous).get('answer-a')).toEqual({ index: 0, count: 2 });
		expect(ids(selectMessageVersion(previous, 'answer-a', 1))).toEqual(['u1', 'answer-z']);
	});
	it('gracefully bounds malformed cycles and leaves unknown/out-of-range selections unchanged', () => {
		const value = thread([message('u1', 'user', 1, 'a1'), message('a1', 'assistant', 2, 'u1')]);
		const selected = selectConversationPath(value, 'a1');
		expect(ids(selected)).toEqual(['u1', 'a1']);
		expect(new Set(ids(selected)).size).toBe(2);
		expect(selectConversationPath(value, 'missing')).toBe(value);
		expect(selectMessageVersion(value, 'a1', 1)).toBe(value);
		expect(() => forkConversation(value, 'missing')).toThrow('Message not found');
	});
});
