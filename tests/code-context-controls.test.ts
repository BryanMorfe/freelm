import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamAgentChat, toolApiName } from '../src/lib/agent';
import { codeContextTools } from '../src/lib/code-context-tools';
import type { Connection, DesktopBridge, Message, WireRequest } from '../src/types';
import { validTranscript } from '../electron/agent-validation';

const connection: Connection = {
	id: 'api',
	name: 'API',
	baseUrl: 'http://test.invalid/v1',
	apiKey: '',
	chatApi: 'responses',
	models: { chat: 'model', images: '', videos: '', speech: '', transcription: '' },
	discoveredModels: [],
	catalog: [
		{
			id: 'model',
			name: 'Model',
			enabled: true,
			tasks: ['chat'],
			inputModalities: ['text'],
			outputModalities: ['text'],
			contextWindow: 128000,
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
	],
};
const history: Message[] = [
	{ id: 'old', role: 'user', content: 'An old request', createdAt: 1 },
	{ id: 'answer', role: 'assistant', content: 'Old answer', createdAt: 2 },
	{ id: 'latest', role: 'user', content: 'The current request', createdAt: 3 },
];
afterEach(() => vi.unstubAllGlobals());
for (const api of ['responses', 'chat'] as const)
	describe(`Code context controls (${api})`, () => {
		it('resets only at a complete tool boundary and preserves original protocol history', async () => {
			const bodies: Record<string, unknown>[] = [];
			let turn = 0;
			const output = (tools: boolean) =>
				api === 'responses'
					? {
							status: 'completed',
							usage: { input_tokens: 90, output_tokens: 12 },
							output: tools
								? [
										{
											type: 'function_call',
											call_id: 'context',
											name: 'new_context',
											arguments: '{}',
										},
									]
								: [
										{
											type: 'message',
											role: 'assistant',
											content: [{ type: 'output_text', text: 'Continued.' }],
										},
									],
						}
					: {
							choices: [
								{
									finish_reason: tools ? 'tool_calls' : 'stop',
									message: tools
										? {
												role: 'assistant',
												tool_calls: [
													{
														id: 'context',
														type: 'function',
														function: { name: 'new_context', arguments: '{}' },
													},
												],
											}
										: { role: 'assistant', content: 'Continued.' },
								},
							],
							usage: { prompt_tokens: 90, completion_tokens: 12 },
						};
			vi.stubGlobal('window', {
				desktop: {
					request: async (request: WireRequest) => {
						bodies.push(request.body!);
						return {
							status: 200,
							contentType: 'application/json',
							body: JSON.stringify(output(turn++ === 0)),
							encoding: 'text',
						};
					},
					onChunk: () => () => {},
					cancel: async () => {},
				} as unknown as DesktopBridge,
			});
			const execute = vi.fn();
			const usage = vi.fn();
			const result = await streamAgentChat({
				connection: { ...connection, chatApi: api },
				model: 'model',
				history,
				instructions: 'Code',
				thinkingMode: 'low',
				contextControls: true,
				tools: codeContextTools,
				execute,
				onUsage: usage,
				onUpdate: () => {},
			});
			expect(execute).not.toHaveBeenCalled();
			expect(JSON.stringify(bodies[1])).toContain('The current request');
			expect(JSON.stringify(bodies[1])).not.toContain('An old request');
			expect(JSON.stringify(bodies[1])).toContain('context');
			expect(result.transcript.items).toHaveLength(3);
			expect(result.transcript.contextWindows?.[0].kind).toBe('reset');
			expect(validTranscript(result.transcript)).toBe(true);
			expect(usage).toHaveBeenCalledWith({ tokens: 102, estimated: false });
		});
		it('reports bounded estimated capacity without calling the host', async () => {
			let turn = 0;
			vi.stubGlobal('window', {
				desktop: {
					request: async () => ({
						status: 200,
						contentType: 'application/json',
						body: JSON.stringify(
							api === 'responses'
								? {
										status: 'completed',
										output:
											turn++ === 0
												? [
														{
															type: 'function_call',
															call_id: 'remaining',
															name: toolApiName('get_context_remaining'),
															arguments: '{}',
														},
													]
												: [
														{
															type: 'message',
															role: 'assistant',
															content: [{ type: 'output_text', text: 'Done' }],
														},
													],
									}
								: {
										choices: [
											{
												message:
													turn++ === 0
														? {
																tool_calls: [
																	{
																		id: 'remaining',
																		type: 'function',
																		function: { name: 'get_context_remaining', arguments: '{}' },
																	},
																],
															}
														: { content: 'Done' },
												finish_reason: 'stop',
											},
										],
									},
						),
						encoding: 'text',
					}),
					onChunk: () => () => {},
					cancel: async () => {},
				} as unknown as DesktopBridge,
			});
			const result = await streamAgentChat({
				connection: { ...connection, chatApi: api },
				model: 'model',
				history,
				instructions: 'Code',
				thinkingMode: 'low',
				contextControls: true,
				tools: codeContextTools,
				execute: async () => {
					throw new Error('Host must not run context controls');
				},
				onUpdate: () => {},
			});
			const part = result.toolCalls[0].result!.content[0];
			expect(part.type).toBe('text');
			const value = JSON.parse((part as { text: string }).text);
			expect(value.context_window).toBe(128000);
			expect(value.remaining_tokens).toBeLessThan(128000);
			expect(value.estimated).toBe(true);
		});
	});
