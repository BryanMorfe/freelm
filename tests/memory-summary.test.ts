import { afterEach, describe, expect, it, vi } from 'vitest';
import { initialState } from '../src/lib/state';
import {
	ChatSummaryQueue,
	generateMemorySummary,
	refreshChatSummaries,
	SUMMARY_INSTRUCTIONS,
	summaryTranscript,
} from '../src/lib/memory-summary';
import { threadMemoryRevision } from '../src/lib/memories';
import type { Thread } from '../src/types';
import { streamChat } from '../src/lib/api';

vi.mock('../src/lib/api', () => ({ streamChat: vi.fn() }));
function fixture() {
	const state = initialState();
	const connection = state.connections[0];
	connection.models.chat = 'model';
	connection.catalog = [
		{
			id: 'model',
			name: 'Model',
			enabled: true,
			tasks: ['chat'],
			inputModalities: ['text'],
			outputModalities: ['text'],
			thinkingModes: [
				{
					id: 'low',
					name: 'Low',
					parameters: {
						responses: { reasoning: { effort: 'low' } },
						chat: { reasoning_effort: 'low' },
					},
				},
			],
		},
	];
	const thread: Thread = {
		id: 'current',
		kind: 'chat',
		title: 'Current',
		connectionId: connection.id,
		model: 'model',
		thinkingMode: 'low',
		createdAt: 1,
		updatedAt: 2,
		messages: [
			{ id: 'user', role: 'user', content: 'My preferred color is amber.', createdAt: 1 },
			{
				id: 'answer',
				role: 'assistant',
				content: 'I will use amber.',
				createdAt: 2,
				completedAt: 3,
			},
		],
	};
	state.threads = [thread];
	vi.mocked(streamChat).mockImplementation(
		async (_connection, _model, _messages, _instructions, delta) => {
			delta('The user prefers amber.');
		},
	);
	return { state, connection, thread };
}
afterEach(() => {
	vi.clearAllMocks();
	vi.useRealTimers();
});
describe('background conversation summaries', () => {
	it('makes a bounded tool-free summary request with explicit thinking effort and source revision', async () => {
		const { thread, connection } = fixture();
		const summary = await generateMemorySummary({
			thread,
			connection,
			signal: new AbortController().signal,
		});
		expect(summary).toMatchObject({
			content: 'The user prefers amber.',
			model: 'model',
			sourceRevision: threadMemoryRevision(thread),
		});
		const call = vi.mocked(streamChat).mock.calls[0];
		expect(call[3]).toBe(SUMMARY_INSTRUCTIONS);
		expect(call[6]).toBe('low');
		expect(call[2][0].content).toContain('My preferred color is amber.');
	});
	it('does not apply a result after a source is edited, deleted or moved', async () => {
		for (const change of ['edited', 'deleted', 'moved']) {
			const { state } = fixture();
			vi.mocked(streamChat).mockImplementation(async (_c, _m, _history, _instructions, delta) => {
				if (change === 'edited')
					state.threads = [
						{
							...state.threads[0],
							messages: [{ id: 'new', role: 'user', content: 'Changed', createdAt: 4 }],
						},
					];
				if (change === 'deleted') state.threads = [];
				if (change === 'moved') state.threads = [{ ...state.threads[0], projectId: 'other' }];
				delta('Old information');
			});
			const apply = vi.fn();
			await refreshChatSummaries({
				threadId: 'current',
				getState: () => state,
				signal: new AbortController().signal,
				apply,
			});
			expect(apply).not.toHaveBeenCalled();
		}
	});
	it('skips Code, disabled history and valid cached summaries; tolerates provider failures', async () => {
		const { state, thread } = fixture();
		const apply = vi.fn();
		const options = {
			threadId: thread.id,
			getState: () => state,
			signal: new AbortController().signal,
			apply,
		};
		state.threads = [{ ...thread, kind: 'code' }];
		await refreshChatSummaries(options);
		state.threads = [thread];
		state.memorySettings = { savedMemories: true, referenceHistory: false };
		await refreshChatSummaries(options);
		state.memorySettings.referenceHistory = true;
		state.threads = [
			{
				...thread,
				memorySummary: {
					content: 'Cached',
					generatedAt: 1,
					model: 'model',
					sourceRevision: threadMemoryRevision(thread),
				},
			},
		];
		await refreshChatSummaries(options);
		expect(streamChat).not.toHaveBeenCalled();
		state.threads = [thread];
		vi.mocked(streamChat).mockRejectedValueOnce(new Error('Unavailable'));
		await expect(refreshChatSummaries(options)).resolves.toBeUndefined();
		expect(apply).not.toHaveBeenCalled();
	});
	it('bounds long transcript excerpts while retaining the start and latest messages', () => {
		const { thread } = fixture();
		const huge = {
			...thread,
			messages: Array.from({ length: 100 }, (_, i) => ({
				id: `${i}`,
				role: 'user' as const,
				content: `entry${i} ${'x'.repeat(1000)}`,
				createdAt: i,
			})),
		};
		const text = summaryTranscript(huge);
		expect(text.length).toBeLessThanOrEqual(24000);
		expect(text).toContain('entry0');
		expect(text).toContain('entry99');
	});
	it('cancels delayed and active work when foreground work resumes', async () => {
		vi.useFakeTimers();
		const queue = new ChatSummaryQueue();
		const pending = vi.fn(async () => {});
		queue.schedule(pending);
		queue.stop();
		await vi.advanceTimersByTimeAsync(2000);
		expect(pending).not.toHaveBeenCalled();
		let signal: AbortSignal | undefined;
		queue.schedule(async (current) => {
			signal = current;
			await new Promise<void>((resolve) =>
				current.addEventListener('abort', () => resolve(), { once: true }),
			);
		});
		await vi.advanceTimersByTimeAsync(1200);
		expect(signal?.aborted).toBe(false);
		queue.stop();
		expect(signal?.aborted).toBe(true);
	});
});
