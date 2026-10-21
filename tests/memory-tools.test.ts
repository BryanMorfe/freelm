import { describe, expect, it } from 'vitest';
import { initialState } from '../src/lib/state';
import { applyMemoryMutation, chatMemoryTools, executeMemoryTool } from '../src/lib/memory-tools';
import { machineIndependentTools } from '../src/lib/conversation-tools';
import type { Thread } from '../src/types';

function fixture() {
	const state = initialState();
	state.projects = ['a', 'b'].map((id) => ({
		id,
		kind: 'chat',
		name: id,
		instructions: '',
		createdAt: 1,
	}));
	const thread: Thread = {
		id: 'current',
		kind: 'chat',
		projectId: 'a',
		title: 'Current',
		connectionId: state.activeConnectionId,
		model: 'model',
		createdAt: 1,
		updatedAt: 1,
		messages: [],
	};
	state.threads = [thread];
	state.savedMemories = [
		{
			id: 'global',
			content: 'Use metric units.',
			source: 'user',
			revision: 1,
			createdAt: 1,
			updatedAt: 1,
		},
		{
			id: 'a-note',
			content: 'The project color is amber.',
			projectId: 'a',
			source: 'model',
			revision: 2,
			createdAt: 1,
			updatedAt: 2,
		},
		{
			id: 'b-note',
			content: 'Private blue details.',
			projectId: 'b',
			source: 'model',
			revision: 1,
			createdAt: 1,
			updatedAt: 1,
		},
	];
	const writes: unknown[] = [];
	const context = {
		getState: () => state,
		thread,
		write: async (mutation: Parameters<typeof applyMemoryMutation>[1]) => {
			writes.push(mutation);
			const result = applyMemoryMutation(
				state,
				mutation,
				{ source: 'model', sourceThreadId: thread.id },
				100,
				'new-note',
			);
			Object.assign(state, result.state);
			return { memory: result.memory, deleted: result.deleted };
		},
	};
	return { state, thread, context, writes };
}
const data = (result: Awaited<ReturnType<typeof executeMemoryTool>>) =>
	JSON.parse((result.content[0] as { text: string }).text);

describe('Chat memory tools', () => {
	it('offers history and saved-memory capabilities independently, with builtin-only filtering', () => {
		const { state } = fixture();
		expect(chatMemoryTools(state)).toHaveLength(7);
		const all = chatMemoryTools(state);
		expect(machineIndependentTools([...all, { ...all[0], source: 'mcp' }])).toHaveLength(7);
		state.memorySettings = { savedMemories: false, referenceHistory: true };
		expect(chatMemoryTools(state).map((tool) => tool.name)).toEqual([
			'conversations.search',
			'conversations.read',
		]);
		state.memorySettings = { savedMemories: false, referenceHistory: false };
		expect(chatMemoryTools(state)).toEqual([]);
	});
	it('searches visible notes and prevents guessed IDs from reading or changing other projects', async () => {
		const { context, writes } = fixture();
		expect(
			data(await executeMemoryTool('memory.search', {}, context)).memories.map(
				(m: { id: string }) => m.id,
			),
		).toEqual(['a-note', 'global']);
		for (const name of ['memory.read', 'memory.update', 'memory.delete'])
			await expect(
				executeMemoryTool(
					name,
					{
						id: 'b-note',
						...(name === 'memory.read' ? {} : { revision: 1 }),
						...(name === 'memory.update' ? { content: 'changed' } : {}),
					},
					context,
				),
			).rejects.toThrow('scope');
		expect(writes).toEqual([]);
	});
	it('saves to the current project and rejects model-selected scope', async () => {
		const { state, context, writes } = fixture();
		await expect(
			executeMemoryTool('memory.create', { content: 'Remember this', projectId: 'b' }, context),
		).rejects.toThrow('Unsupported');
		const created = data(
			await executeMemoryTool('memory.create', { content: 'Remember amber' }, context),
		).memory;
		expect(created).toMatchObject({
			projectId: 'a',
			source: 'model',
			sourceThreadId: 'current',
			revision: 1,
		});
		expect(writes).toHaveLength(1);
		expect(state.savedMemories).toHaveLength(4);
	});
	it('rejects stale edits and keeps saved notes after their source thread is deleted', async () => {
		const { state, context } = fixture();
		await expect(
			executeMemoryTool(
				'memory.update',
				{ id: 'a-note', content: 'New fact', revision: 1 },
				context,
			),
		).rejects.toThrow('changed');
		const updated = data(
			await executeMemoryTool(
				'memory.update',
				{ id: 'a-note', content: 'New fact', revision: 2 },
				context,
			),
		).memory;
		expect(updated.revision).toBe(3);
		state.threads = [];
		expect(state.savedMemories?.find((note) => note.id === 'a-note')?.content).toBe('New fact');
		await expect(executeMemoryTool('memory.read', { id: 'a-note' }, context)).rejects.toThrow(
			'scope changed',
		);
	});
	it('rejects calls when settings or conversation scope changes while running', async () => {
		const { state, context } = fixture();
		state.memorySettings = { savedMemories: false, referenceHistory: true };
		await expect(executeMemoryTool('memory.create', { content: 'No' }, context)).rejects.toThrow(
			'disabled',
		);
		state.memorySettings.savedMemories = true;
		state.threads = [{ ...state.threads[0], projectId: 'b' }];
		await expect(executeMemoryTool('memory.search', {}, context)).rejects.toThrow('scope changed');
		state.threads = [{ ...state.threads[0], projectId: 'a', kind: 'code' }];
		await expect(executeMemoryTool('memory.search', {}, context)).rejects.toThrow('scope changed');
	});
	it('only acknowledges a model memory after its write has completed', async () => {
		const { context } = fixture();
		let release!: () => void;
		let done = false;
		const call = executeMemoryTool(
			'memory.create',
			{ content: 'A durable note' },
			{
				...context,
				write: async () => {
					await new Promise<void>((resolve) => {
						release = resolve;
					});
					return { deleted: 'test' };
				},
			},
		).then(() => {
			done = true;
		});
		await Promise.resolve();
		expect(done).toBe(false);
		release();
		await call;
		expect(done).toBe(true);
	});
	it('rejects a yielded search result after another thread is deleted', async () => {
		const { state, thread, context } = fixture();
		let live = {
			...state,
			threads: [
				...state.threads,
				{
					...thread,
					id: 'history',
					messages: Array.from({ length: 24 }, (_, index) => ({
						id: `m-${index}`,
						role: 'assistant' as const,
						content: 'A remembered decision',
						createdAt: index,
						completedAt: index + 1,
					})),
				},
			],
		};
		const search = executeMemoryTool(
			'conversations.search',
			{ query: 'decision' },
			{
				...context,
				getState: () => live,
			},
		);
		live = { ...live, threads: [thread] };
		await expect(search).rejects.toThrow('history changed');
	});
	it('deduplicates exact notes and enforces note and collection bounds', () => {
		const { state } = fixture();
		expect(
			applyMemoryMutation(
				state,
				{ kind: 'create', content: 'Use metric units.' },
				{ source: 'user' },
			).state,
		).toBe(state);
		expect(() =>
			applyMemoryMutation(state, { kind: 'create', content: 'x'.repeat(4001) }, { source: 'user' }),
		).toThrow('4000');
		expect(() =>
			applyMemoryMutation(
				state,
				{ kind: 'create', content: 'a', projectId: 'missing' },
				{ source: 'user' },
			),
		).toThrow('Chat project');
	});
});
