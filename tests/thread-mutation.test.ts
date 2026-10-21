import { describe, expect, it } from 'vitest';
import type { AppState, Message, QueuedCodeMessage, Thread } from '../src/types';
import { initialState } from '../src/lib/state';
import { rollbackThreadMutation } from '../src/lib/thread-mutation';

const queued = (id: string, content = id): QueuedCodeMessage => ({ id, content, createdAt: 1 });
const message = (id: string, content = id): Message => ({
	id,
	role: 'user',
	content,
	createdAt: 1,
});
const thread = (id: string, changes: Partial<Thread> = {}): Thread => ({
	id,
	kind: 'code',
	title: id,
	connectionId: 'provider',
	model: 'model',
	messages: [message(`${id}-message`)],
	createdAt: 1,
	updatedAt: 1,
	...changes,
});
const state = (...threads: Thread[]): AppState => ({ ...initialState(), threads });
const replace = (current: AppState, replacement: Thread): AppState => ({
	...current,
	threads: current.threads.map((item) => (item.id === replacement.id ? replacement : item)),
});

describe('rollbackThreadMutation', () => {
	it('restores the original snapshot when no newer update exists', () => {
		const before = state(thread('one'));
		const attempted = replace(before, { ...before.threads[0], title: 'Attempted' });
		expect(rollbackThreadMutation(attempted, before, attempted)).toBe(before);
	});
	it('rolls back the target while preserving another thread’s streamed response', () => {
		const before = state(thread('one'), thread('two'));
		const attempted = replace(before, { ...before.threads[0], title: 'Attempted', updatedAt: 2 });
		const streamed = {
			...before.threads[1],
			messages: [
				...before.threads[1].messages,
				{ ...message('reply', 'Streaming answer'), role: 'assistant' as const },
			],
			updatedAt: 3,
		};
		const current = replace(attempted, streamed);
		const restored = rollbackThreadMutation(current, before, attempted);
		expect(restored.threads[0]).toBe(before.threads[0]);
		expect(restored.threads[1]).toBe(streamed);
	});
	it('rolls back unchanged fields within a concurrently streaming target', () => {
		const before = state(thread('one', { titleSource: 'generated' }));
		const attempted = replace(before, {
			...before.threads[0],
			title: 'Attempted',
			titleSource: 'manual',
			archivedAt: 2,
			updatedAt: 2,
		});
		const streaming = {
			...attempted.threads[0],
			messages: [
				...before.threads[0].messages,
				{ ...message('reply', 'Partial reply'), role: 'assistant' as const },
			],
			updatedAt: 3,
		};
		const current = replace(attempted, streaming);
		const restored = rollbackThreadMutation(current, before, attempted).threads[0];
		expect(restored).toMatchObject({ title: 'one', titleSource: 'generated', updatedAt: 3 });
		expect(restored).not.toHaveProperty('archivedAt');
		expect(restored.messages).toBe(streaming.messages);
	});
	it('preserves fields changed again by the user and keeps unchanged object identities', () => {
		const before = state(thread('one'), thread('two'));
		const attempted = replace(before, { ...before.threads[0], title: 'Attempted' });
		const current = replace(attempted, { ...attempted.threads[0], title: 'Human title' });
		expect(rollbackThreadMutation(current, before, attempted)).toBe(current);
	});
	it('removes a failed new thread only while it is still the attempted object', () => {
		const before = state(thread('one'));
		const created = thread('created');
		const attempted = { ...before, threads: [...before.threads, created] };
		const unrelated = thread('human-created');
		const current = { ...attempted, threads: [...attempted.threads, unrelated] };
		expect(rollbackThreadMutation(current, before, attempted).threads).toEqual([
			before.threads[0],
			unrelated,
		]);
		const changed = { ...created, title: 'Human edit' };
		const later = replace(current, changed);
		expect(rollbackThreadMutation(later, before, attempted)).toBe(later);
	});
	it('retains a concurrently edited new thread but removes its failed initial queued prompt', () => {
		const before = state(thread('existing'));
		const bot = queued('initial-bot'),
			human = queued('human-follow-up');
		const created = thread('created', { queuedMessages: [bot] });
		const attempted = { ...before, threads: [...before.threads, created] };
		const edited = { ...created, title: 'Human title', queuedMessages: [bot, human] };
		const current = replace(attempted, edited);
		const result = rollbackThreadMutation(current, before, attempted);
		expect(result.threads[1]).toMatchObject({
			id: 'created',
			title: 'Human title',
			queuedMessages: [human],
		});
		expect(edited.queuedMessages).toEqual([bot, human]);
		const renamedOnly = replace(attempted, { ...created, title: 'Human title' });
		expect(
			rollbackThreadMutation(renamedOnly, before, attempted).threads[1].queuedMessages,
		).toEqual([]);
	});
	it('does not undo an initial prompt already committed by a concurrent task runner', () => {
		const before = state(thread('existing'));
		const bot = queued('initial-bot'),
			human = queued('human-follow-up');
		const created = thread('created', { queuedMessages: [bot] });
		const attempted = { ...before, threads: [...before.threads, created] };
		const delivered = { ...created, messages: [message(bot.id)], queuedMessages: [human] };
		const current = replace(attempted, delivered);
		expect(rollbackThreadMutation(current, before, attempted)).toBe(current);
	});
	it('restores failed removals in their previous order and retains newly added threads', () => {
		const before = state(thread('one'), thread('two'), thread('three'));
		const attempted = { ...before, threads: [before.threads[2]] };
		const added = thread('new');
		const current = { ...attempted, threads: [...attempted.threads, added] };
		expect(rollbackThreadMutation(current, before, attempted).threads).toEqual([
			...before.threads,
			added,
		]);
	});
	it('does not resurrect a concurrently deleted thread that was only edited by the failed write', () => {
		const before = state(thread('one'), thread('two'));
		const attempted = replace(before, { ...before.threads[0], title: 'Attempted' });
		const current = { ...attempted, threads: [before.threads[1]] };
		expect(rollbackThreadMutation(current, before, attempted)).toBe(current);
	});
	it('does not replace a restored or recreated removed thread', () => {
		const before = state(thread('one'));
		const attempted = { ...before, threads: [] };
		const replacement = thread('one', { title: 'Recreated' });
		const current = { ...attempted, threads: [replacement] };
		expect(rollbackThreadMutation(current, before, attempted)).toBe(current);
	});
	it('rolls back changed top-level fields only while their attempted values survive', () => {
		const before = state(thread('one'));
		const attempted = {
			...before,
			theme: 'light' as const,
			systemPrompt: 'Attempted',
			chatDrafts: { one: { content: 'attempted', attachments: [], updatedAt: 1 } },
		};
		const humanDrafts = {
			...attempted.chatDrafts,
			two: { content: 'Human draft', attachments: [], updatedAt: 2 },
		};
		const current = { ...attempted, systemPrompt: 'Human instructions', chatDrafts: humanDrafts };
		const restored = rollbackThreadMutation(current, before, attempted);
		expect(restored.theme).toBe(before.theme);
		expect(restored.systemPrompt).toBe('Human instructions');
		expect(restored.chatDrafts).toBe(humanDrafts);
		expect(restored.threads).toBe(current.threads);
	});
	it('removes a failed queue append while preserving a concurrent human append', () => {
		const first = queued('first'),
			bot = queued('bot'),
			human = queued('human');
		const before = state(thread('one', { queuedMessages: [first] }));
		const attempted = replace(before, {
			...before.threads[0],
			queuedMessages: [first, bot],
			updatedAt: 2,
		});
		const current = replace(attempted, {
			...attempted.threads[0],
			queuedMessages: [first, bot, human],
			updatedAt: 3,
		});
		const restored = rollbackThreadMutation(current, before, attempted).threads[0];
		expect(restored.queuedMessages).toEqual([first, human]);
		expect(restored.updatedAt).toBe(3);
		expect(current.threads[0].queuedMessages).toEqual([first, bot, human]);
	});
	it('removes the failed append by ID even after another edit replaces that entry', () => {
		const bot = queued('bot'),
			human = queued('human');
		const before = state(thread('one'));
		const attempted = replace(before, { ...before.threads[0], queuedMessages: [bot] });
		const current = replace(attempted, {
			...attempted.threads[0],
			queuedMessages: [{ ...bot, content: 'Edited bot request' }, human],
		});
		expect(rollbackThreadMutation(current, before, attempted).threads[0].queuedMessages).toEqual([
			human,
		]);
	});
	it('preserves concurrent removals of untouched queue entries', () => {
		const first = queued('first'),
			second = queued('second'),
			bot = queued('bot'),
			human = queued('human');
		const before = state(thread('one', { queuedMessages: [first, second] }));
		const attempted = replace(before, {
			...before.threads[0],
			queuedMessages: [first, second, bot],
		});
		const current = replace(attempted, {
			...attempted.threads[0],
			queuedMessages: [second, bot, human],
		});
		expect(rollbackThreadMutation(current, before, attempted).threads[0].queuedMessages).toEqual([
			second,
			human,
		]);
	});
	it('restores a failed queue removal ahead of later human appends', () => {
		const first = queued('first'),
			second = queued('second'),
			human = queued('human');
		const before = state(thread('one', { queuedMessages: [first, second] }));
		const attempted = replace(before, { ...before.threads[0], queuedMessages: [first] });
		const current = replace(attempted, { ...attempted.threads[0], queuedMessages: [first, human] });
		expect(rollbackThreadMutation(current, before, attempted).threads[0].queuedMessages).toEqual([
			first,
			second,
			human,
		]);
	});
	it.each(['messages', 'messageHistory'] as const)(
		'does not requeue a removed input already committed in %s',
		(field) => {
			const input = queued('input'),
				human = queued('human');
			const before = state(thread('one', { queuedMessages: [input] }));
			const attempted = replace(before, { ...before.threads[0], queuedMessages: [] });
			const currentThread = {
				...attempted.threads[0],
				queuedMessages: [human],
				[field]: [...(before.threads[0][field] ?? []), message(input.id)],
			};
			const current = replace(attempted, currentThread);
			expect(rollbackThreadMutation(current, before, attempted)).toBe(current);
		},
	);
	it('restores a failed queue delivery when its optimistic transcript is rolled back', () => {
		const input = queued('input'),
			human = queued('human');
		const before = state(thread('one', { queuedMessages: [input] }));
		const attempted = replace(before, {
			...before.threads[0],
			queuedMessages: [],
			messages: [...before.threads[0].messages, message(input.id)],
		});
		const current = replace(attempted, { ...attempted.threads[0], queuedMessages: [human] });
		const restored = rollbackThreadMutation(current, before, attempted).threads[0];
		expect(restored.messages).toBe(before.threads[0].messages);
		expect(restored.queuedMessages).toEqual([input, human]);
	});
	it('rolls back only unchanged fields of an edited queue entry', () => {
		const input = {
			...queued('input', 'Original'),
			replyTo: { messageId: 'quote', text: 'Original quote' },
		};
		const edited = {
			...input,
			content: 'Attempted',
			replyTo: { messageId: 'quote', text: 'Attempted quote' },
		};
		const humanQuote = { messageId: 'quote', text: 'Human quote' };
		const before = state(thread('one', { queuedMessages: [input] }));
		const attempted = replace(before, { ...before.threads[0], queuedMessages: [edited] });
		const current = replace(attempted, {
			...attempted.threads[0],
			queuedMessages: [{ ...edited, replyTo: humanQuote }],
		});
		const restored = rollbackThreadMutation(current, before, attempted).threads[0]
			.queuedMessages![0];
		expect(restored.content).toBe('Original');
		expect(restored.replyTo).toBe(humanQuote);
	});
	it('does not restore an edited queue entry removed concurrently', () => {
		const input = queued('input', 'Original');
		const before = state(thread('one', { queuedMessages: [input] }));
		const attempted = replace(before, {
			...before.threads[0],
			queuedMessages: [{ ...input, content: 'Attempted' }],
		});
		const current = replace(attempted, { ...attempted.threads[0], queuedMessages: [] });
		expect(rollbackThreadMutation(current, before, attempted)).toBe(current);
	});
	it('undoes an added optional queue field but preserves a concurrent empty-array identity', () => {
		const before = state(thread('one'));
		const attempted = replace(before, { ...before.threads[0], queuedMessages: [queued('bot')] });
		const streamed = replace(attempted, {
			...attempted.threads[0],
			messages: [...attempted.threads[0].messages, message('concurrent')],
		});
		expect(rollbackThreadMutation(streamed, before, attempted).threads[0]).not.toHaveProperty(
			'queuedMessages',
		);
		const emptied = replace(attempted, { ...attempted.threads[0], queuedMessages: [] });
		expect(rollbackThreadMutation(emptied, before, attempted)).toBe(emptied);
	});
	it('preserves property absence when a concurrent change deleted an optional field', () => {
		const before = state(thread('one', { archivedAt: 1 }));
		const attempted = replace(before, { ...before.threads[0], archivedAt: undefined });
		const nextThread = { ...attempted.threads[0] };
		delete nextThread.archivedAt;
		const current = replace(attempted, nextThread);
		expect(rollbackThreadMutation(current, before, attempted)).toBe(current);
	});
});
