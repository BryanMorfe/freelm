import { describe, expect, it } from 'vitest';
import {
	composeSystemPrompt,
	conversationInput,
	initialState,
	recoverState,
} from '../src/lib/state';
import { validateState } from '../electron/validation';
import { createWorkspacePatch, emptyWorkspacePatch } from '../src/workspace-patch';
import type { Message } from '../src/types';

describe('workspace settings recovery', () => {
	it.each([undefined, 'The resumed provider request failed.'])(
		'keeps a successfully committed checkpoint without response items on continuation (%s)',
		(error) => {
			const user: Message = { id: 'user', role: 'user', content: 'Continue.', createdAt: 1 };
			const owner: Message = {
				id: 'checkpoint-owner',
				role: 'assistant',
				content: '',
				createdAt: 2,
				interrupted: error === undefined,
				error,
				agentTranscript: {
					api: 'responses',
					items: [],
					context: {
						version: 1,
						api: 'responses',
						model: 'chat',
						connectionId: 'local',
						historyMessageIds: ['user'],
						transcriptItemCount: 0,
						items: [{ role: 'user', content: 'The completed continuity checkpoint.' }],
						createdAt: 2,
						compactionCount: 1,
						inputTokensBefore: 10000,
						inputTokensAfter: 30,
					},
				},
			};
			expect(conversationInput([user, owner])).toEqual([user, owner]);
		},
	);
	it('loads older v1 workspaces with new settings while preserving model-specific thinking modes', () => {
		const legacy = initialState();
		delete legacy.systemPrompt;
		delete legacy.thinkingPresets;
		delete legacy.debugMode;
		legacy.connections[0].catalog = [
			{
				id: 'reasoner',
				name: 'Reasoner',
				enabled: true,
				tasks: ['chat'],
				inputModalities: ['text'],
				outputModalities: ['text'],
				thinkingModes: [
					{ id: 'custom', name: 'Custom budget', parameters: { chat: { thinking_budget: 1234 } } },
				],
			},
		];
		const original = structuredClone(legacy);
		validateState(legacy);
		const recovered = recoverState(legacy);
		expect(recovered.systemPrompt).toBe('');
		expect(recovered.debugMode).toBe(false);
		expect(recovered.thinkingPresets?.map((preset) => preset.id)).toEqual([
			'low',
			'medium',
			'high',
		]);
		expect(recovered.connections).toEqual(original.connections);
		expect(legacy).toEqual(original);
		validateState(recovered);
	});

	it('defaults debug mode off and preserves an explicitly enabled setting', () => {
		const state = initialState();
		expect(state.debugMode).toBe(false);
		const enabled = { ...state, debugMode: true };
		expect(recoverState(enabled)).toBe(enabled);
		validateState(enabled);
		for (const debugMode of ['true', 1, null, {}])
			expect(() => validateState({ ...state, debugMode })).toThrow('Workspace data is invalid');
	});

	it('preserves an intentionally cleared preset list and keeps new workspaces independent', () => {
		const first = initialState();
		const second = initialState();
		first.thinkingPresets![0].parameters.chat = { reasoning_effort: 'custom' };
		expect(second.thinkingPresets![0].parameters.chat).toEqual({ reasoning_effort: 'low' });
		first.systemPrompt = 'Use brief answers.';
		first.thinkingPresets = [];
		expect(recoverState(first)).toMatchObject({
			systemPrompt: 'Use brief answers.',
			thinkingPresets: [],
		});
	});

	it('recovers unfinished tool calls without marking completed image-only turns as interrupted', () => {
		const state = initialState();
		state.threads = [
			{
				id: 'tools',
				title: 'Tool recovery',
				connectionId: state.activeConnectionId,
				model: 'chat',
				createdAt: 1,
				updatedAt: 1,
				messages: [
					{
						id: 'completed',
						role: 'assistant',
						content: '',
						createdAt: 1,
						toolCalls: [
							{
								id: 'image',
								name: 'image_gen.imagegen',
								arguments: '{}',
								status: 'completed',
								startedAt: 1,
							},
						],
						agentTranscript: {
							api: 'responses',
							items: [{ type: 'function_call_output', call_id: 'image', output: 'Image created.' }],
						},
					},
					{
						id: 'running',
						role: 'assistant',
						content: '',
						createdAt: 1,
						toolCalls: [
							{
								id: 'command',
								name: 'exec_command',
								arguments: '{}',
								status: 'running',
								startedAt: 1,
							},
						],
					},
					{ id: 'empty', role: 'assistant', content: '', createdAt: 1 },
				],
			},
		];
		const messages = recoverState(state).threads[0].messages;
		expect(messages[0]).toBe(state.threads[0].messages[0]);
		expect(messages[0].toolCalls).toBe(state.threads[0].messages[0].toolCalls);
		expect(messages[0].interrupted).toBeUndefined();
		expect(messages[0].toolCalls?.[0].status).toBe('completed');
		expect(conversationInput(messages)).toEqual([messages[0]]);
		expect(messages[1].toolCalls?.[0]).toMatchObject({
			status: 'failed',
			result: { isError: true },
		});
		expect(messages[2].interrupted).toBe(true);
		expect(state.threads[0].messages[1].toolCalls?.[0].status).toBe('running');
	});
	it('keeps completed image history out of startup autosaves while recovering genuine interruptions', () => {
		const state = initialState();
		const dataUrl = 'data:image/png;base64,' + 'A'.repeat(2_000_000);
		state.threads = [
			{
				id: 'image',
				kind: 'chat',
				title: 'Image chat',
				connectionId: state.activeConnectionId,
				model: 'chat',
				createdAt: 1,
				updatedAt: 1,
				messages: [
					{
						id: 'done',
						role: 'assistant',
						content: '',
						createdAt: 1,
						completedAt: 2,
						toolCalls: [
							{
								id: 'image-tool',
								name: 'image_gen',
								arguments: '{}',
								status: 'completed',
								startedAt: 1,
								result: { content: [{ type: 'image', dataUrl }] },
							},
						],
					},
				],
			},
		];
		const recovered = recoverState(state);
		expect(recovered).toBe(state);
		expect(emptyWorkspacePatch(createWorkspacePatch(state, recovered))).toBe(true);
		const legacy = { ...state, threads: [{ ...state.threads[0], kind: undefined }] };
		const classified = recoverState(legacy);
		expect(classified.threads[0].messages).toBe(legacy.threads[0].messages);
		expect(classified.threads[0].messages[0].toolCalls).toBe(
			legacy.threads[0].messages[0].toolCalls,
		);
		expect(JSON.stringify(createWorkspacePatch(legacy, classified)).length).toBeLessThan(300);
		const pending = {
			...state,
			threads: [
				{
					...state.threads[0],
					messages: [
						...state.threads[0].messages,
						{
							id: 'pending',
							role: 'assistant' as const,
							content: '',
							createdAt: 3,
							phase: 'working' as const,
						},
					],
				},
			],
		};
		const interrupted = recoverState(pending);
		expect(interrupted.threads[0].messages[0]).toBe(state.threads[0].messages[0]);
		expect(interrupted.threads[0].messages[1].interrupted).toBe(true);
		expect(JSON.stringify(createWorkspacePatch(pending, interrupted)).length).toBeLessThan(300);
		expect(recoverState(interrupted)).toBe(interrupted);
	});
});

describe('system prompt composition', () => {
	it('keeps workspace and project instructions in order and preserves internal formatting', () => {
		expect(
			composeSystemPrompt('  Be concise.\nUse metric units.  ', '\nExplain this project.\n'),
		).toBe('Be concise.\nUse metric units.\n\nExplain this project.');
	});
	it('handles missing and blank prompts without adding empty instruction blocks', () => {
		expect(composeSystemPrompt()).toBe('');
		expect(composeSystemPrompt(' \n ', ' ')).toBe('');
		expect(composeSystemPrompt(undefined, ' Project only ')).toBe('Project only');
		expect(composeSystemPrompt(' Workspace only ', undefined)).toBe('Workspace only');
	});
});
