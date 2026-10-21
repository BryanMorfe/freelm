import { describe, expect, it } from 'vitest';
import { initialState } from '../src/lib/state';
import { persistentWorkspace } from '../src/lib/temporary-chats';
import {
	eligibleMemoryThreads,
	memoryContext,
	visibleSavedMemories,
	conversationSearch,
} from '../src/lib/memories';
import type { Thread } from '../src/types';

const thread = (id: string): Thread => ({
	id,
	kind: 'chat',
	title: id,
	model: 'fixture',
	connectionId: 'provider',
	createdAt: 1,
	updatedAt: 2,
	messages: [
		{ id: `${id}-u`, role: 'user', content: `${id} private question`, createdAt: 1 },
		{
			id: `${id}-a`,
			role: 'assistant',
			content: `${id} private answer`,
			createdAt: 2,
			completedAt: 3,
		},
	],
});

describe('temporary Chat persistence and memory boundaries', () => {
	it('removes temporary threads and both unsent/sent temporary drafts without changing settings', () => {
		const state = initialState();
		state.threads = [thread('normal'), { ...thread('temporary'), temporary: true }];
		state.chatDrafts = {
			normal: { content: 'normal draft', attachments: [], updatedAt: 1 },
			temporary: { content: 'private sent draft', attachments: [], updatedAt: 1 },
			'new:chat:temporary': { content: 'private unsent draft', attachments: [], updatedAt: 1 },
			'new:chat:general': { content: 'general draft', attachments: [], updatedAt: 1 },
		};
		state.dictation = {
			enabled: false,
			connectionId: state.activeConnectionId,
			model: 'preferred-asr',
		};
		state.backgroundNotifications = true;
		const persisted = persistentWorkspace(state);
		expect(persisted.threads.map((item) => item.id)).toEqual(['normal']);
		expect(Object.keys(persisted.chatDrafts!)).toEqual(['normal', 'new:chat:general']);
		expect(JSON.stringify(persisted)).not.toContain('temporary private');
		expect(JSON.stringify(persisted)).not.toContain('private sent draft');
		expect(JSON.stringify(persisted)).not.toContain('private unsent draft');
		expect(state.threads).toHaveLength(2);
		expect(state.chatDrafts.temporary.content).toBe('private sent draft');
		expect(persisted.connections).toBe(state.connections);
		expect(persisted.personalization).toBe(state.personalization);
		expect(persisted.dictation).toBe(state.dictation);
		expect(persisted.backgroundNotifications).toBe(true);
	});
	it('does not copy or alter a workspace that contains only normal conversations', () => {
		const state = initialState();
		state.threads = [thread('normal')];
		expect(persistentWorkspace(state)).toBe(state);
	});
	it('never injects saved memories or other-thread recall into a temporary current conversation', () => {
		const state = initialState();
		const current = { ...thread('temporary'), temporary: true };
		state.threads = [current, thread('normal')];
		state.savedMemories = [
			{
				id: 'saved',
				content: 'Saved preference',
				createdAt: 1,
				updatedAt: 1,
				revision: 1,
				source: 'user',
			},
		];
		expect(eligibleMemoryThreads(state, current)).toEqual([]);
		expect(visibleSavedMemories(state, current)).toEqual([]);
		expect(memoryContext(state, current)).toBe('');
	});
	it('excludes temporary and archived conversations from recall while preserving normal project scope', () => {
		const state = initialState();
		const current = { ...thread('current'), projectId: 'project' };
		state.threads = [
			current,
			{ ...thread('normal'), projectId: 'project' },
			{ ...thread('temporary'), temporary: true, projectId: 'project' },
			{ ...thread('archived'), archivedAt: 4, projectId: 'project' },
			thread('outside'),
		];
		expect(eligibleMemoryThreads(state, current).map((item) => item.id)).toEqual(['normal']);
		const context = memoryContext(state, current);
		expect(context).toContain('normal private answer');
		expect(context).not.toContain('temporary private answer');
		expect(context).not.toContain('archived private answer');
		expect(context).not.toContain('outside private answer');
		expect([
			...new Set(
				conversationSearch(state, current, { query: 'private' }).results.map(
					(item) => item.thread_id,
				),
			),
		]).toEqual(['normal']);
	});
});
