import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppState, Message, Thread } from '../src/types';
import { initialState } from '../src/lib/state';
import {
	codeTaskTools,
	executeCodeTaskTool,
	isCodeTaskTool,
	type CodeTaskToolContext,
	type CodeTaskStatus,
} from '../src/lib/code-task-tools';

const message = (id: string, role: Message['role'], content = id): Message => ({
	id,
	role,
	content,
	createdAt: 1,
	...(role === 'assistant' ? { completedAt: 2 } : {}),
});
function fixture() {
	let state: AppState = initialState();
	state.connections[0].apiKey = 'sk-super-secret';
	state.connections[0].catalog = [
		{
			id: 'other',
			name: 'Other',
			enabled: true,
			tasks: ['chat'],
			inputModalities: ['text'],
			outputModalities: ['text'],
			thinkingModes: [
				{ id: 'high', name: 'High', parameters: { responses: { reasoning: { effort: 'high' } } } },
			],
			defaultThinkingMode: 'high',
		},
	];
	state.projects = [
		{
			id: 'code-project',
			kind: 'code',
			name: 'Project',
			instructions: 'Private project instructions',
			directories: ['/project'],
			createdAt: 1,
		},
	];
	const thread = (id: string, overrides: Partial<Thread> = {}): Thread => ({
		id,
		kind: 'code',
		title: id,
		connectionId: state.connections[0].id,
		projectId: 'code-project',
		model: 'current-model',
		thinkingMode: 'medium',
		permissionMode: 'auto-review',
		messages: [message(`${id}-user`, 'user'), message(`${id}-answer`, 'assistant')],
		createdAt: 1,
		updatedAt: 2,
		...overrides,
	});
	state.threads = [
		thread('caller'),
		thread('other'),
		thread('chat', { kind: 'chat' }),
		thread('archived', { archivedAt: 3, updatedAt: 3 }),
	];
	let ids = 0,
		mutations = 0;
	const authorized: unknown[] = [],
		dispatched: string[] = [],
		cancelled: readonly string[][] = [];
	const statuses: Record<string, CodeTaskStatus> = {
		caller: 'working',
		other: 'completed',
		archived: 'idle',
	};
	const context: CodeTaskToolContext = {
		currentThreadId: 'caller',
		loadState: async () => state,
		mutate: async <T>(update: (value: AppState) => { state: AppState; value: T }) => {
			mutations++;
			const changed = update(state);
			state = changed.state;
			return changed.value;
		},
		authorize: async (action) => {
			authorized.push(action);
			return true;
		},
		dispatch: async (id) => {
			expect(
				state.threads.find((thread) => thread.id === id)?.queuedMessages?.length,
			).toBeGreaterThan(0);
			dispatched.push(id);
			return { status: statuses[id] === 'working' ? 'queued' : 'started' };
		},
		cancel: async (ids) => {
			(cancelled as string[][]).push([...ids]);
		},
		statuses: async (ids) => Object.fromEntries(ids.map((id) => [id, statuses[id] ?? 'idle'])),
		now: () => 100,
		id: () => `new-${++ids}`,
	};
	return {
		context,
		get state() {
			return state;
		},
		thread,
		statuses,
		authorized,
		dispatched,
		cancelled,
		get mutations() {
			return mutations;
		},
	};
}
const data = async (name: string, args: Record<string, unknown>, context: CodeTaskToolContext) => {
	const result = await executeCodeTaskTool(`tasks.${name}`, args, context);
	return JSON.parse((result.content[0] as { text: string }).text);
};
afterEach(() => vi.useRealTimers());

describe('host-scoped Code task tools', () => {
	it('offers exactly the nine task capabilities with no workspace or credential fields', () => {
		expect(codeTaskTools).toHaveLength(9);
		expect(isCodeTaskTool('tasks.read_thread')).toBe(true);
		expect(isCodeTaskTool('tasks.unknown')).toBe(false);
		for (const tool of codeTaskTools) {
			expect(tool.parameters.additionalProperties).toBe(false);
			expect(Object.keys(tool.parameters.properties as object)).not.toContain('workspaceId');
		}
	});
	it('lists Code tasks only and paginates archived tasks independently', async () => {
		const f = fixture();
		f.state.threads.push(f.thread('archived-2', { archivedAt: 4, updatedAt: 4 }));
		expect(
			(await data('list_threads', {}, f.context)).threads.map((thread: Thread) => thread.id),
		).toEqual(['caller', 'other']);
		const first = await data('list_archived_threads', { limit: 1 }, f.context);
		expect(first.threads[0].id).toBe('archived-2');
		expect(first.nextCursor).toBe('archived-2');
		expect(
			(await data('list_archived_threads', { limit: 1, cursor: first.nextCursor }, f.context))
				.threads[0].id,
		).toBe('archived');
		await expect(data('list_threads', { cursor: 'archived' }, f.context)).rejects.toThrow(
			'Unsupported',
		);
	});
	it('reads bounded turns newest first with history cursors and no credentials, media or replay', async () => {
		const f = fixture(),
			target = f.state.threads[1];
		target.messages = [
			message('u1', 'user', 'sk-super-secret'),
			message('a1', 'assistant', 'old answer'),
			message('u2', 'user', 'new question'),
			{
				...message(
					'a2',
					'assistant',
					'new answer with sk-super-secret data:image/png;base64,aGVsbG8=',
				),
				attachments: [
					{ name: 'Private image', type: 'image/png', dataUrl: 'data:image/png;base64,aGVsbG8=' },
				],
				agentTranscript: { api: 'responses', items: [{ privateReplay: 'secret replay' }] },
				toolCalls: [
					{
						id: 'call',
						name: 'exec_command',
						arguments: '{"secret":"never return args"}',
						startedAt: 1,
						status: 'completed',
						result: {
							content: [
								{ type: 'text', text: 'Bearer secrettoken sk-super-secret' },
								{ type: 'image', dataUrl: 'private pixels' },
							],
						},
					},
				],
			},
		];
		const value = await data(
			'read_thread',
			{ threadId: 'other', turnLimit: 1, includeOutputs: true, maxOutputCharsPerItem: 80 },
			f.context,
		);
		expect(value.turns.map((turn: { id: string }) => turn.id)).toEqual(['u2']);
		expect(value.page.nextCursor).toBe('u2');
		expect(
			(
				await data(
					'read_thread',
					{ threadId: 'other', cursor: value.page.nextCursor, turnLimit: 1 },
					f.context,
				)
			).turns[0].id,
		).toBe('u1');
		const serialized = JSON.stringify(value);
		for (const absent of [
			'sk-super-secret',
			'secrettoken',
			'private pixels',
			'never return args',
			'secret replay',
			'data:image',
		])
			expect(serialized).not.toContain(absent);
		expect(serialized).toContain('credential redacted');
		expect(serialized).toContain('embedded media omitted');
		const noOutputs = await data('read_thread', { threadId: 'other' }, f.context);
		expect(noOutputs.turns[0].messages[1]).not.toHaveProperty('tools');
	});
	it('bounds large tool histories and text across the entire response', async () => {
		const f = fixture(),
			target = f.state.threads[1];
		target.messages = [];
		for (let turn = 0; turn < 20; turn++) {
			target.messages.push(message(`u${turn}`, 'user', 'x'.repeat(12_000)));
			for (let index = 0; index < 50; index++)
				target.messages.push({
					...message(`a${turn}-${index}`, 'assistant', 'y'.repeat(12_000)),
					toolCalls: Array.from({ length: 25 }, (_, tool) => ({
						id: `c${tool}`,
						name: 'exec_command',
						arguments: '{}',
						status: 'completed' as const,
						startedAt: 1,
						result: { content: [{ type: 'text' as const, text: 'z'.repeat(12_000) }] },
					})),
				});
		}
		const read = await data(
			'read_thread',
			{ threadId: 'other', turnLimit: 20, maxOutputCharsPerItem: 10_000, includeOutputs: true },
			f.context,
		);
		expect(JSON.stringify(read).length).toBeLessThan(120_000);
		expect(read.turns.flatMap((turn: { messages: Message[] }) => turn.messages)).toHaveLength(100);
		expect(
			read.turns.some((turn: { omittedMessageCount: number }) => turn.omittedMessageCount > 0),
		).toBe(true);
	});
	it.each([
		'read_thread',
		'send_message_to_thread',
		'set_thread_title',
		'set_thread_archived',
		'fork_thread',
	])('rejects Chat task IDs for %s', async (name) => {
		const f = fixture();
		await expect(
			data(
				name,
				{
					threadId: 'chat',
					...(name === 'send_message_to_thread' ? { prompt: 'message' } : {}),
					...(name === 'set_thread_title' ? { title: 'new' } : {}),
					...(name === 'set_thread_archived' ? { archived: true } : {}),
				},
				f.context,
			),
		).rejects.toThrow('Code task is unavailable');
		expect(f.mutations).toBe(0);
	});
	it('creates a task with inherited scope, persists its prompt before dispatch and does not move UI selection', async () => {
		const f = fixture();
		const created = await data(
			'create_thread',
			{ prompt: 'Run focused checks', title: 'Checks' },
			f.context,
		);
		expect(created.delivery.status).toBe('started');
		const thread = f.state.threads.find((thread) => thread.id === created.threadId)!;
		expect(thread).toMatchObject({
			kind: 'code',
			projectId: 'code-project',
			connectionId: f.state.connections[0].id,
			model: 'current-model',
			thinkingMode: 'medium',
			permissionMode: 'auto-review',
			title: 'Checks',
			messages: [],
		});
		expect(thread.queuedMessages?.[0].content).toBe('Run focused checks');
		expect(f.dispatched).toEqual([thread.id]);
		expect(f.context.currentThreadId).toBe('caller');
		expect(f.authorized).toHaveLength(1);
	});
	it('denied authorization and model-selected credentials cannot create or queue work', async () => {
		const f = fixture();
		f.context.authorize = async () => false;
		await expect(data('create_thread', { prompt: 'Run this' }, f.context)).rejects.toThrow(
			'not approved',
		);
		await expect(
			data('send_message_to_thread', { threadId: 'other', prompt: 'Run this' }, f.context),
		).rejects.toThrow('not approved');
		await expect(
			data('create_thread', { prompt: 'Run this', apiKey: 'anything' }, f.context),
		).rejects.toThrow('Unsupported');
		expect(f.mutations).toBe(0);
		expect(f.dispatched).toEqual([]);
	});
	it('requires an explicit host authorization callback for mutations that start or stop tasks', async () => {
		const f = fixture();
		delete f.context.authorize;
		await expect(data('create_thread', { prompt: 'Run this' }, f.context)).rejects.toThrow(
			'authorization',
		);
	});
	it('queues self follow-ups while working and makes retried host calls idempotent', async () => {
		const f = fixture();
		f.context.operationId = 'host-run-call';
		const sent = await data(
			'send_message_to_thread',
			{ threadId: 'caller', prompt: 'Focus the next step' },
			f.context,
		);
		expect(sent.delivery.status).toBe('queued');
		await data(
			'send_message_to_thread',
			{ threadId: 'caller', prompt: 'Focus the next step' },
			f.context,
		);
		expect(f.state.threads[0].queuedMessages).toHaveLength(1);
		expect(f.state.threads[0].queuedMessages![0].id).toBe(sent.messageId);
	});
	it('retains saved input after dispatch fails so delivery can be retried', async () => {
		const f = fixture();
		f.context.dispatch = async () => {
			throw new Error('Dispatcher offline');
		};
		const value = await data(
			'send_message_to_thread',
			{ threadId: 'other', prompt: 'Please continue' },
			f.context,
		);
		expect(value).toMatchObject({
			promptSaved: true,
			delivery: { status: 'unavailable', error: 'Dispatcher offline' },
		});
		expect(f.state.threads[1].queuedMessages?.[0].content).toBe('Please continue');
	});
	it('redacts credentials from dispatch errors without losing the saved prompt', async () => {
		const f = fixture();
		f.context.dispatch = async () => ({
			status: 'unavailable',
			error: 'Provider rejected Bearer another-token sk-super-secret',
		});
		const value = await data(
			'send_message_to_thread',
			{ threadId: 'other', prompt: 'Continue' },
			f.context,
		);
		expect(value.delivery.error).not.toContain('another-token');
		expect(value.delivery.error).not.toContain('sk-super-secret');
		expect(f.state.threads[1].queuedMessages?.[0].content).toBe('Continue');
	});
	it('uses the latest transaction state after approval and rejects a task that changed to Chat', async () => {
		const f = fixture();
		f.context.authorize = async () => {
			f.state.threads[1].messages.push(message('concurrent-message', 'user'));
			return true;
		};
		await data(
			'send_message_to_thread',
			{ threadId: 'other', prompt: 'Queued message' },
			f.context,
		);
		expect(f.state.threads[1].messages.at(-1)?.id).toBe('concurrent-message');
		f.context.authorize = async () => {
			f.state.threads[1].kind = 'chat';
			return true;
		};
		await expect(
			data('send_message_to_thread', { threadId: 'other', prompt: 'Do not deliver' }, f.context),
		).rejects.toThrow('Code task is unavailable');
		expect(f.state.threads[1].queuedMessages).toHaveLength(1);
	});
	it('allows only configured model overrides and inherits their explicit thinking value', async () => {
		const f = fixture();
		await expect(
			data('create_thread', { prompt: 'task', model: 'not-configured' }, f.context),
		).rejects.toThrow('must be enabled');
		const created = await data('create_thread', { prompt: 'task', model: 'other' }, f.context);
		expect(f.state.threads.find((thread) => thread.id === created.threadId)).toMatchObject({
			model: 'other',
			thinkingMode: 'high',
		});
	});
	it('forks without running, gives all messages new IDs, remaps checkpoints and keeps replay independent', async () => {
		const f = fixture(),
			source = f.state.threads[1];
		source.queuedMessages = [{ id: 'live-input', content: 'pending', createdAt: 3 }];
		source.messages[1].parentId = source.messages[0].id;
		source.messages[1].replyTo = { messageId: source.messages[0].id, text: 'quote' };
		source.messages[1].agentTranscript = {
			api: 'responses',
			items: [{ role: 'assistant', content: 'replay' }],
			contextWindows: [
				{
					id: 'source-window',
					kind: 'reset',
					transcriptItemCount: 1,
					historyMessageIds: [source.messages[0].id],
					createdAt: 2,
				},
				{
					id: 'invalid-window',
					kind: 'compaction',
					transcriptItemCount: 2,
					historyMessageIds: ['outside-branch'],
					createdAt: 3,
				},
			],
			context: {
				version: 1,
				api: 'responses',
				model: source.model,
				connectionId: source.connectionId,
				historyMessageIds: [source.messages[0].id],
				transcriptItemCount: 1,
				items: [{ summary: 'continuity' }],
				createdAt: 2,
				compactionCount: 1,
				inputTokensBefore: 100,
				inputTokensAfter: 50,
			},
			usage: {
				version: 1,
				model: source.model,
				connectionId: source.connectionId,
				historyMessageIds: [source.messages[0].id],
				estimatedInputTokens: 50,
				inputTokens: 55,
			},
		};
		const original = structuredClone(source);
		const value = await data('fork_thread', { threadId: 'other' }, f.context),
			branch = f.state.threads.find((thread) => thread.id === value.threadId)!;
		expect(value.started).toBe(false);
		expect(f.dispatched).toEqual([]);
		expect(branch.messages.map((message) => message.id)).not.toEqual(
			source.messages.map((message) => message.id),
		);
		expect(branch.messages[1].parentId).toBe(branch.messages[0].id);
		expect(branch.messages[1].replyTo?.messageId).toBe(branch.messages[0].id);
		expect(branch.messages[1].agentTranscript?.context?.historyMessageIds).toEqual([
			branch.messages[0].id,
		]);
		expect(branch.messages[1].agentTranscript?.usage?.historyMessageIds).toEqual([
			branch.messages[0].id,
		]);
		expect(branch.messages[1].agentTranscript?.contextWindows).toHaveLength(1);
		expect(branch.messages[1].agentTranscript?.contextWindows?.[0]).toMatchObject({
			kind: 'reset',
			historyMessageIds: [branch.messages[0].id],
		});
		expect(branch.messages[1].agentTranscript?.contextWindows?.[0].id).not.toBe('source-window');
		expect(branch.queuedMessages).toBeUndefined();
		expect(branch.codeQueueDelivery).toBeUndefined();
		expect(branch.branchedFrom).toEqual({ threadId: 'other', messageId: source.messages[1].id });
		expect(source).toEqual(original);
		branch.messages[1].agentTranscript!.items[0].content = 'changed';
		expect(source.messages[1].agentTranscript!.items[0].content).toBe('replay');
	});
	it('rejects user endpoints and streaming assistant forks, while legacy completed replies work', async () => {
		const f = fixture();
		await expect(
			data('fork_thread', { threadId: 'other', messageId: 'other-user' }, f.context),
		).rejects.toThrow('assistant reply');
		const reply = f.state.threads[1].messages[1];
		delete reply.completedAt;
		reply.phase = 'responding';
		await expect(
			data('fork_thread', { threadId: 'other', messageId: reply.id }, f.context),
		).rejects.toThrow('finish');
		delete reply.phase;
		expect((await data('fork_thread', { threadId: 'other' }, f.context)).started).toBe(false);
	});
	it('archives descendants and cancels work but restores only the selected task', async () => {
		const f = fixture();
		f.state.threads.push(
			f.thread('child', { branchedFrom: { threadId: 'other', messageId: 'other-answer' } }),
			f.thread('grandchild', { branchedFrom: { threadId: 'child', messageId: 'child-answer' } }),
		);
		await data('set_thread_archived', { threadId: 'other', archived: true }, f.context);
		expect(f.cancelled[0]).toEqual(['other', 'child', 'grandchild']);
		for (const id of ['other', 'child', 'grandchild'])
			expect(f.state.threads.find((thread) => thread.id === id)?.archivedAt).toBe(100);
		await data('set_thread_archived', { threadId: 'other', archived: false }, f.context);
		expect(f.state.threads[1].archivedAt).toBeUndefined();
		expect(f.state.threads.find((thread) => thread.id === 'child')?.archivedAt).toBe(100);
	});
	it('prevents archiving the caller or its ancestors and sending to archived tasks', async () => {
		const f = fixture();
		await expect(data('set_thread_archived', { archived: true }, f.context)).rejects.toThrow(
			'calling task',
		);
		f.state.threads[0].branchedFrom = { threadId: 'other', messageId: 'other-answer' };
		await expect(
			data('set_thread_archived', { threadId: 'other', archived: true }, f.context),
		).rejects.toThrow('ancestor');
		await expect(
			data('send_message_to_thread', { threadId: 'archived', prompt: 'Continue' }, f.context),
		).rejects.toThrow('Restore');
	});
	it('renames only the targeted Code task without altering model or queue', async () => {
		const f = fixture();
		await data('set_thread_title', { title: 'Focused task' }, f.context);
		expect(f.state.threads[0]).toMatchObject({
			title: 'Focused task',
			titleSource: 'manual',
			model: 'current-model',
		});
		expect(f.state.threads[1].title).toBe('other');
	});
	it('returns immediate completion snapshots and suppresses previously delivered answers using cursors', async () => {
		const f = fixture();
		const first = await data(
			'wait_threads',
			{ targets: [{ threadId: 'other' }], timeoutMs: 0 },
			f.context,
		);
		expect(first.wake).toBe('other');
		expect(first.polls[0].answer).toBe('other-answer');
		const next = await data(
			'wait_threads',
			{ targets: [{ threadId: 'other', afterCursor: first.polls[0].cursor }], timeoutMs: 0 },
			f.context,
		);
		expect(next.wake).toBeNull();
		expect(next.polls[0]).not.toHaveProperty('answer');
	});
	it('wakes on changed status and interrupts cancellable waits', async () => {
		vi.useFakeTimers();
		const f = fixture();
		f.statuses.other = 'working';
		const waiting = data(
			'wait_threads',
			{ targets: [{ threadId: 'other' }], timeoutMs: 1000 },
			f.context,
		);
		await vi.advanceTimersByTimeAsync(250);
		f.statuses.other = 'waiting_for_input';
		await vi.advanceTimersByTimeAsync(250);
		expect((await waiting).wake).toBe('other');
		f.statuses.other = 'working';
		const ctl = new AbortController();
		f.context.signal = ctl.signal;
		const cancelled = data('wait_threads', { targets: [{ threadId: 'other' }] }, f.context);
		const assertion = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
		await vi.advanceTimersByTimeAsync(1);
		ctl.abort();
		await assertion;
	});
	it('rejects self-wait and duplicate targets, and reports missing/Chat tasks without reading them', async () => {
		const f = fixture();
		await expect(
			data('wait_threads', { targets: [{ threadId: 'caller' }] }, f.context),
		).rejects.toThrow('calling task');
		await expect(
			data('wait_threads', { targets: [{ threadId: 'other' }, { threadId: 'other' }] }, f.context),
		).rejects.toThrow('unique');
		const value = await data(
			'wait_threads',
			{ targets: [{ threadId: 'chat' }, { threadId: 'missing' }], timeoutMs: 0 },
			f.context,
		);
		expect(value.polls.every((poll: { error?: string }) => poll.error)).toBe(true);
		expect(JSON.stringify(value)).not.toContain('chat-answer');
	});
});
