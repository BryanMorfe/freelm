import { describe, expect, it } from 'vitest';
import { initialState } from '../src/lib/state';
import {
	applyWorkspacePatch,
	assertWorkspacePatch,
	createWorkspacePatch,
	emptyWorkspacePatch,
} from '../src/workspace-patch';
import type { AppState, Thread } from '../src/types';

function fixture(): AppState {
	const state = initialState();
	const thread: Thread = {
		id: 'chat',
		title: 'Chat',
		model: 'fixture',
		connectionId: state.activeConnectionId,
		createdAt: 1,
		updatedAt: 1,
		messages: [
			{
				id: 'old',
				role: 'user',
				content: 'Old image',
				createdAt: 1,
				attachments: [
					{
						name: 'huge.png',
						type: 'image/png',
						dataUrl: 'data:image/png;base64,' + 'A'.repeat(10_000_000),
					},
				],
			},
			{ id: 'reply', role: 'assistant', content: 'First', createdAt: 1 },
		],
	};
	return { ...state, threads: [thread, { ...thread, id: 'other', messages: [] }] };
}

describe('record workspace patches', () => {
	it('patches the debug preference without resending conversation history', () => {
		const previous = fixture();
		const enabled = { ...previous, debugMode: true };
		const patch = createWorkspacePatch(previous, enabled);
		assertWorkspacePatch(patch);
		expect(patch).toEqual({ changes: { debugMode: true } });
		expect(applyWorkspacePatch(previous, patch)).toEqual(enabled);
		const { debugMode: _removed, ...legacy } = enabled;
		const removed = createWorkspacePatch(enabled, legacy);
		assertWorkspacePatch(removed);
		expect(removed).toEqual({ changes: {}, removed: ['debugMode'] });
		expect(applyWorkspacePatch(enabled, removed)).toEqual(legacy);
	});
	it('updates one message without sending historic media or unchanged records', () => {
		const previous = fixture();
		const thread = previous.threads[0];
		const next = {
			...previous,
			threads: [
				{
					...thread,
					updatedAt: 2,
					messages: [thread.messages[0], { ...thread.messages[1], content: 'First, then second' }],
				},
				previous.threads[1],
			],
		};
		const patch = createWorkspacePatch(previous, next);
		assertWorkspacePatch(patch);
		expect(JSON.stringify(patch).length).toBeLessThan(500);
		expect(patch.changes).not.toHaveProperty('threads');
		const applied = applyWorkspacePatch(previous, patch);
		expect(applied).toEqual(next);
		expect(applied.threads[1]).toBe(previous.threads[1]);
		expect(applied.threads[0].messages[0]).toBe(thread.messages[0]);
	});
	it('adds, changes and removes a selected reply reference without resending historic media', () => {
		const previous = fixture();
		const withReference = (
			state: AppState,
			replyTo?: { messageId: string; text: string },
		): AppState => ({
			...state,
			threads: state.threads.map((thread, index) =>
				index
					? thread
					: {
							...thread,
							messages: thread.messages.map((message, messageIndex) => {
								if (messageIndex) return message;
								const { replyTo: _removed, ...original } = message;
								return { ...original, ...(replyTo ? { replyTo } : {}) };
							}),
						},
			),
		});
		const added = withReference(previous, { messageId: 'source', text: 'Initial selection' });
		const changed = withReference(added, { messageId: 'other-source', text: 'Another selection' });
		const removed = withReference(changed);
		for (const [before, after] of [
			[previous, added],
			[added, changed],
			[changed, removed],
		]) {
			const patch = createWorkspacePatch(before, after);
			assertWorkspacePatch(patch);
			expect(JSON.stringify(patch).length).toBeLessThan(500);
			const applied = applyWorkspacePatch(before, patch);
			expect(applied).toEqual(after);
			expect(applied.threads[0].messages[0].attachments).toBe(
				before.threads[0].messages[0].attachments,
			);
		}
	});
	it('preserves order, deletion, new records and explicit optional property removal', () => {
		const previous = fixture();
		previous.threads[0].projectId = 'project';
		const { projectId: _removed, ...changed } = previous.threads[0];
		const next = { ...previous, threads: [{ ...previous.threads[1], id: 'new' }, changed] };
		const patch = createWorkspacePatch(previous, next);
		assertWorkspacePatch(patch);
		expect(applyWorkspacePatch(previous, patch)).toEqual(next);
		expect(applyWorkspacePatch(previous, patch).threads[1]).not.toHaveProperty('projectId');
		expect(
			emptyWorkspacePatch(createWorkspacePatch(next, { ...next, threads: [...next.threads] })),
		).toBe(true);
	});
	it('checkpoints queued delivery and failure metadata without copying historic images', () => {
		const previous = fixture();
		previous.threads[0].kind = 'code';
		const pending: AppState = {
			...previous,
			threads: previous.threads.map((thread, index) =>
				index
					? thread
					: {
							...thread,
							codeQueueDelivery: { assistantId: 'reply', messageIds: ['old'], startedAt: 2 },
						},
			),
		};
		const failed: AppState = {
			...pending,
			threads: pending.threads.map((thread, index) => {
				if (index) return thread;
				const { codeQueueDelivery: _delivery, ...rest } = thread;
				return {
					...rest,
					codeQueueFailures: [
						{
							id: 'failure',
							assistantId: 'reply',
							messageIds: ['old'],
							error: 'Connection closed',
							failedAt: 3,
						},
					],
				};
			}),
		};
		for (const [before, after] of [
			[previous, pending],
			[pending, failed],
		]) {
			const patch = createWorkspacePatch(before, after);
			assertWorkspacePatch(patch);
			expect(JSON.stringify(patch).length).toBeLessThan(500);
			expect(patch.records?.threads?.upsert).toBeUndefined();
			const applied = applyWorkspacePatch(before, patch);
			expect(applied).toEqual(after);
			expect(applied.threads[0].messages).toBe(before.threads[0].messages);
		}
	});
	it('rejects conflicting, invalid and ambiguous record patches', () => {
		for (const patch of [
			{ changes: { threads: [] }, records: { threads: {} } },
			{
				changes: {},
				records: { threads: { updates: [{ id: 'chat', changes: { id: 'changed' } }] } },
			},
			{
				changes: {},
				records: {
					threads: { updates: [{ id: 'chat', changes: { messages: [] }, messages: {} }] },
				},
			},
			{ changes: {}, records: { threads: { order: ['same', 'same'] } } },
			{ changes: {}, records: { threads: { upsert: [{ id: 'same' }], removed: ['same'] } } },
		])
			expect(() => assertWorkspacePatch(patch)).toThrow('Invalid workspace patch');
		expect(() =>
			applyWorkspacePatch(fixture(), { changes: {}, records: { threads: { order: ['chat'] } } }),
		).toThrow('Invalid workspace record order');
		expect(() =>
			applyWorkspacePatch(fixture(), {
				changes: {},
				records: { threads: { updates: [{ id: 'missing', changes: { title: 'Changed' } }] } },
			}),
		).toThrow('no longer exists');
	});
});
