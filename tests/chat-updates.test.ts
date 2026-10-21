import { afterEach, describe, expect, it, vi } from 'vitest';
import { latestStreamUpdates } from '../src/lib/stream-updates';
import { cleanThreadTitle } from '../src/lib/thread-title';
import { validateState } from '../electron/validation';
import { initialState, recoverState } from '../src/lib/state';

afterEach(() => vi.useRealTimers());
describe('chat stream rendering', () => {
	it('coalesces a token burst while flushing the exact final text before EOF', () => {
		vi.useFakeTimers();
		const commit = vi.fn();
		const updates = latestStreamUpdates(commit);
		let content = '';
		for (let i = 0; i < 1000; i++) {
			content += `token${i} `;
			updates.push(content);
		}
		expect(commit).not.toHaveBeenCalled();
		vi.advanceTimersByTime(50);
		expect(commit).toHaveBeenCalledTimes(1);
		expect(commit).toHaveBeenLastCalledWith(content);
		updates.push(content + '尾');
		updates.flush();
		expect(commit).toHaveBeenLastCalledWith(content + '尾');
		vi.runAllTimers();
		expect(commit).toHaveBeenCalledTimes(2);
	});
	it('keeps the last reasoning phase/text/tool update together through cancellation', () => {
		vi.useFakeTimers();
		const commit = vi.fn();
		const updates = latestStreamUpdates(commit);
		updates.push({ phase: 'working', content: '' });
		updates.push({ phase: 'tools', content: 'Checking files', tools: ['read'] });
		updates.flush();
		expect(commit).toHaveBeenCalledExactlyOnceWith({
			phase: 'tools',
			content: 'Checking files',
			tools: ['read'],
		});
	});
});

describe('chat persistence metadata', () => {
	it('accepts ordered activity and title provenance, and recovers a interrupted active message', () => {
		const state = initialState();
		state.threads = [
			{
				id: 'thread',
				title: 'Working',
				titleSource: 'pending',
				connectionId: state.activeConnectionId,
				model: 'model',
				createdAt: 1,
				updatedAt: 1,
				messages: [
					{
						id: 'a',
						role: 'assistant',
						content: 'Checking files',
						createdAt: 1,
						phase: 'tools',
						activity: [
							{ type: 'text', id: 'text', text: 'Checking files' },
							{ type: 'tool', id: 'tool', toolCallId: 'call' },
						],
					},
				],
			},
		];
		expect(() => validateState(state)).not.toThrow();
		expect(recoverState(state).threads[0].messages[0].interrupted).toBe(true);
		state.threads[0].messages[0].completedAt = 2;
		expect(recoverState(state).threads[0].messages[0].interrupted).toBeUndefined();
		state.threads[0].messages[0].activityFinishedAt = 1.5;
		expect(() => validateState(state)).not.toThrow();
		expect(recoverState(state).threads[0].messages[0].activityFinishedAt).toBe(1.5);
		(state.threads[0].messages[0].activity![0] as { text: unknown }).text = 32;
		expect(() => validateState(state)).toThrow('Workspace data is invalid');
	});
	it.each([NaN, Infinity, -1, '2', null])(
		'rejects an invalid activity finish timestamp: %s',
		(activityFinishedAt) => {
			const state = initialState();
			state.threads = [
				{
					id: 'thread',
					title: 'Ready',
					connectionId: state.activeConnectionId,
					model: 'model',
					createdAt: 1,
					updatedAt: 3,
					messages: [
						{
							id: 'a',
							role: 'assistant',
							content: 'Done',
							createdAt: 1,
							completedAt: 3,
							activityFinishedAt: activityFinishedAt as number,
						},
					],
				},
			];
			expect(() => validateState(state)).toThrow('Workspace data is invalid');
		},
	);
	it('cleans generated titles without retaining a model preamble or multiline output', () => {
		expect(cleanThreadTitle('Title: “Build a desktop app”\nExtra explanation')).toBe(
			'Build a desktop app',
		);
		expect(cleanThreadTitle('  # **Fix chat performance** ')).toBe('Fix chat performance');
		expect(cleanThreadTitle('')).toBe('');
		expect(cleanThreadTitle('x'.repeat(200)).length).toBeLessThanOrEqual(90);
	});
});
