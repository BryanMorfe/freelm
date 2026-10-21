import { describe, expect, it } from 'vitest';
import type { Attachment, QueuedCodeMessage } from '../src/types';
import {
	addQueuedCodeMessage,
	drainQueuedCodeMessages,
	editQueuedCodeMessage,
	pruneCommittedCodeQueue,
	removeQueuedCodeMessage,
} from '../src/lib/code-queue';
import { forkConversation } from '../src/lib/conversation-tree';

const image: Attachment = {
	name: 'reference.png',
	type: 'image/png',
	dataUrl: 'data:image/png;base64,AA==',
};
const queued = (id: string, createdAt = 1): QueuedCodeMessage => ({
	id,
	content: `Follow-up ${id}`,
	createdAt,
});

describe('Code follow-up queue', () => {
	it('adds FIFO entries without mutating drafts and ignores existing or committed IDs', () => {
		const first = queued('first', 30);
		const next = { ...queued('second', 10), attachments: [image] };
		const original = [first];
		const queue = addQueuedCodeMessage(original, next);
		expect(queue.map((entry) => entry.id)).toEqual(['first', 'second']);
		expect(original).toEqual([first]);
		expect(queue[1]).toEqual(next);
		expect(queue[1].attachments).not.toBe(next.attachments);
		expect(addQueuedCodeMessage(queue, { ...first, content: 'Collision' })).toBe(queue);
		expect(addQueuedCodeMessage(queue, queued('committed'), [{ id: 'committed' }])).toBe(queue);
	});

	it('edits the selected entry without moving it or changing its submission identity', () => {
		const replyTo = { messageId: 'assistant', text: 'Selected passage' };
		const queue = [{ ...queued('first', 30), attachments: [image], replyTo }, queued('second')];
		const edited = editQueuedCodeMessage(queue, 'first', { content: 'Revised follow-up' });
		expect(edited[0]).toEqual({ ...queue[0], content: 'Revised follow-up' });
		expect(queue[0].content).toBe('Follow-up first');
		expect(edited[1]).toBe(queue[1]);
		expect(editQueuedCodeMessage(queue, 'missing', { content: 'No change' })).toBe(queue);
		expect(
			editQueuedCodeMessage(edited, 'first', { attachments: [], replyTo: undefined })[0],
		).toMatchObject({ id: 'first', createdAt: 30, attachments: [], replyTo: undefined });
	});

	it('removes only the requested entry and leaves an unknown ID alone', () => {
		const queue = [queued('first'), queued('second')];
		expect(removeQueuedCodeMessage(queue, 'first')).toEqual([queue[1]]);
		expect(removeQueuedCodeMessage(queue, 'missing')).toBe(queue);
		expect(removeQueuedCodeMessage(undefined, 'missing')).toEqual([]);
	});

	it('drains by ID in queue order, preserving attachments and replies', () => {
		const queue = [
			{
				...queued('first'),
				attachments: [image],
				replyTo: { messageId: 'answer', text: 'Excerpt' },
			},
			queued('second'),
			queued('third'),
		];
		const { drained, remaining } = drainQueuedCodeMessages(queue, ['third', 'first']);
		expect(drained).toEqual([queue[0], queue[2]]);
		expect(remaining).toEqual([queue[1]]);
		expect(queue).toHaveLength(3);
		expect(drainQueuedCodeMessages(queue)).toEqual({ drained: queue, remaining: [] });
		expect(drainQueuedCodeMessages(queue, []).remaining).toBe(queue);
	});

	it('prunes already committed and duplicate entries before replay', () => {
		const first = queued('first');
		const queue = [first, queued('second'), { ...first, content: 'Duplicate' }, queued('third')];
		expect(pruneCommittedCodeQueue(queue, [{ id: 'second' }])).toEqual([first, queue[3]]);
		expect(drainQueuedCodeMessages(queue, undefined, [{ id: 'second' }])).toEqual({
			drained: [first, queue[3]],
			remaining: [],
		});
	});

	it('does not copy pending work into a conversation branch', () => {
		const queue = [queued('pending')];
		const source = {
			id: 'source',
			kind: 'code' as const,
			title: 'Code task',
			model: 'fixture',
			connectionId: 'provider',
			createdAt: 1,
			updatedAt: 2,
			messages: [
				{ id: 'user', role: 'user' as const, content: 'Inspect the project.', createdAt: 1 },
				{ id: 'answer', role: 'assistant' as const, content: 'Done.', createdAt: 2 },
			],
			queuedMessages: queue,
		};
		expect(forkConversation(source, 'answer', 'branch').queuedMessages).toBeUndefined();
		expect(source.queuedMessages).toBe(queue);
	});
});
