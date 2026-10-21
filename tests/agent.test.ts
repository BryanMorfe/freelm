import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamAgentChat, toolApiName, type AgentChatOptions } from '../src/lib/agent';
import type { AgentUpdate, ToolDefinition, ToolResult } from '../src/agent-types';
import type { Connection, DesktopBridge, Message, WireRequest, WireResponse } from '../src/types';
import * as imageContext from '../src/lib/generated-image-context';
import { COMPACTION_PROMPT, SUMMARY_PREFIX } from '../src/lib/context-compaction';
import { formatPromptContext } from '../src/lib/prompt-context';

const connection: Connection = {
	id: 'local',
	name: 'Test',
	baseUrl: 'http://localhost:9999/v1',
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
			inputModalities: ['text', 'image'],
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
	],
};
const history: Message[] = [
	{ id: 'user', role: 'user', content: 'Inspect this project', createdAt: 1 },
];
const shell: ToolDefinition = {
	name: 'exec_command',
	description: 'Run a command',
	parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] },
	source: 'builtin',
};
const search: ToolDefinition = {
	name: 'tool_search',
	description: 'Find tools',
	parameters: { type: 'object' },
	source: 'builtin',
};
const ok: ToolResult = { content: [{ type: 'text', text: 'Command output' }] };
const call = (id: string, name = 'exec_command', args = '{"cmd":"pwd"}') => ({
	type: 'function_call',
	id: `item_${id}`,
	call_id: id,
	name,
	arguments: args,
});
const message = (text: string) => ({
	type: 'message',
	role: 'assistant',
	content: [{ type: 'output_text', text }],
});
const json = (data: unknown, status = 200): WireResponse => ({
	status,
	contentType: 'application/json',
	body: JSON.stringify(data),
	encoding: 'text',
});
function bridge(
	handler: (
		request: WireRequest,
		emit: (text: string) => void,
		turn: number,
	) => Promise<WireResponse> | WireResponse,
) {
	const listeners = new Set<(event: { id: string; text: string }) => void>();
	let turn = 0;
	const desktop = {
		request: vi.fn((request: WireRequest) =>
			Promise.resolve(
				handler(
					request,
					(text) => listeners.forEach((listener) => listener({ id: request.id, text })),
					turn++,
				),
			),
		),
		onChunk: vi.fn((listener: (event: { id: string; text: string }) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}),
		cancel: vi.fn(async () => {}),
	};
	vi.stubGlobal('window', { desktop: desktop as unknown as DesktopBridge });
	return { desktop, listeners };
}
function sse(emit: (text: string) => void, events: unknown[], unterminated = false): WireResponse {
	const text =
		events
			.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}`)
			.join('\n\n') + (unterminated ? '' : '\n\n');
	for (let i = 0; i < text.length; i += 71) emit(text.slice(i, i + 71));
	return {
		status: 200,
		contentType: 'text/event-stream',
		body: '',
		encoding: 'text',
		stream: { bytes: new TextEncoder().encode(text).length, characters: text.length },
	};
}
function options(overrides: Partial<AgentChatOptions> = {}): AgentChatOptions {
	return {
		connection,
		model: 'model',
		history,
		instructions: 'Be careful',
		tools: [shell],
		execute: vi.fn(async () => ok),
		onUpdate: vi.fn(),
		...overrides,
	};
}
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('queued input at complete protocol boundaries', () => {
	const apis = ['responses', 'chat/completions'] as const;
	const round = (api: Connection['chatApi'], calls: ReturnType<typeof call>[], text = '') =>
		json(
			api === 'responses'
				? { output: [...(text ? [message(text)] : []), ...calls] }
				: {
						choices: [
							{
								message: {
									role: 'assistant',
									content: text || null,
									...(calls.length
										? {
												tool_calls: calls.map((entry) => ({
													id: entry.call_id,
													type: 'function',
													function: { name: entry.name, arguments: entry.arguments },
												})),
											}
										: {}),
								},
							},
						],
					},
		);
	const requestInput = (request: WireRequest) =>
		request.body![request.path === '/responses' ? 'input' : 'messages'] as Record<
			string,
			unknown
		>[];
	function gate() {
		let resolve!: () => void;
		const promise = new Promise<void>((done) => {
			resolve = done;
		});
		return { promise, resolve };
	}
	function continuation(previous: AgentUpdate): Message[] {
		return [
			...history,
			{
				id: 'previous-assistant',
				role: 'assistant',
				content: previous.content,
				createdAt: 2,
				agentTranscript: previous.transcript,
				toolCalls: previous.toolCalls,
			},
			{ id: 'queued-user', role: 'user', content: 'Also check the tests.', createdAt: 3 },
		];
	}
	it.each(apis)(
		'waits for every %s tool output before yielding and resumes without rerunning tools',
		async (api) => {
			const started = [gate(), gate()];
			const release = [gate(), gate()];
			const shouldYieldForInput = vi.fn(() => true);
			const { desktop } = bridge((request, _emit, turn) => {
				if (!turn) return round(api, [call('first'), call('second')], 'Checking the project');
				const input = requestInput(request);
				const outputs = input.filter(
					(item) => item.type === 'function_call_output' || item.role === 'tool',
				);
				expect(outputs.map((item) => item.call_id || item.tool_call_id)).toEqual([
					'first',
					'second',
				]);
				expect(outputs.map((item) => item.output || item.content)).toEqual([
					'Output 0',
					'Output 1',
				]);
				expect(JSON.stringify(input.at(-1))).toContain('Also check the tests.');
				return round(api, [], 'Tests completed');
			});
			let executed = 0;
			const execute = vi.fn(async () => {
				const index = executed++;
				started[index].resolve();
				await release[index].promise;
				return { content: [{ type: 'text' as const, text: `Output ${index}` }] };
			});
			const pending = streamAgentChat(
				options({ connection: { ...connection, chatApi: api }, execute, shouldYieldForInput }),
			);
			await started[0].promise;
			expect(shouldYieldForInput).not.toHaveBeenCalled();
			release[0].resolve();
			await started[1].promise;
			expect(shouldYieldForInput).not.toHaveBeenCalled();
			release[1].resolve();
			const result = await pending;
			expect(result.yieldedForInput).toBe(true);
			expect(shouldYieldForInput).toHaveBeenCalledTimes(1);
			expect(desktop.request).toHaveBeenCalledTimes(1);
			expect(result.toolCalls.map((entry) => entry.status)).toEqual(['completed', 'completed']);
			expect(result.activityFinishedAt).toBeTypeOf('number');
			const resumed = await streamAgentChat(
				options({
					connection: { ...connection, chatApi: api },
					history: continuation(result),
					tools: result.continuationTools!,
					execute,
				}),
			);
			expect(resumed.content).toBe('Tests completed');
			expect(resumed.yieldedForInput).toBeUndefined();
			expect(execute).toHaveBeenCalledTimes(2);
			expect(desktop.request).toHaveBeenCalledTimes(2);
		},
	);
	it.each(apis)('waits for the completed %s final response before yielding', async (api) => {
		const started = gate();
		const release = gate();
		const shouldYieldForInput = vi.fn(() => true);
		bridge(async (_request, emit) => {
			started.resolve();
			await release.promise;
			return sse(
				emit,
				api === 'responses'
					? [
							{ type: 'response.output_text.delta', delta: 'Completed answer' },
							{ type: 'response.completed', response: { output: [message('Completed answer')] } },
						]
					: [
							{
								choices: [
									{ index: 0, delta: { content: 'Completed answer' }, finish_reason: null },
								],
							},
							{ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
							'[DONE]',
						],
			);
		});
		const execute = vi.fn(async () => ok);
		const pending = streamAgentChat(
			options({ connection: { ...connection, chatApi: api }, execute, shouldYieldForInput }),
		);
		await started.promise;
		expect(shouldYieldForInput).not.toHaveBeenCalled();
		release.resolve();
		const result = await pending;
		expect(result).toMatchObject({ content: 'Completed answer', yieldedForInput: true });
		expect(result.transcript.items.at(-1)?.role).toBe('assistant');
		expect(execute).not.toHaveBeenCalled();
		expect(shouldYieldForInput).toHaveBeenCalledTimes(1);
	});
	it.each(apis)(
		'retains eager notes tools across %s queued continuation without discovery',
		async (api) => {
			const append = { ...shell, name: 'notes_append_to_file' };
			const execute = vi.fn(async () => ok);
			bridge((request, _emit, turn) => {
				expect(JSON.stringify(request.body?.tools)).toContain(append.name);
				expect(JSON.stringify(request.body?.tools)).not.toContain('tool_search');
				return turn < 2
					? round(api, [call(`append-${turn}`, append.name, '{}')])
					: round(api, [], 'Notes saved');
			});
			const yielded = await streamAgentChat(
				options({
					connection: { ...connection, chatApi: api },
					tools: [append],
					execute,
					shouldYieldForInput: () => true,
				}),
			);
			const resumed = await streamAgentChat(
				options({
					connection: { ...connection, chatApi: api },
					history: continuation(yielded),
					tools: yielded.continuationTools!,
					execute,
				}),
			);
			expect(resumed.content).toBe('Notes saved');
			expect(execute).toHaveBeenCalledTimes(2);
			expect(execute).toHaveBeenLastCalledWith(append.name, {}, 'append-1');
		},
	);
	it.each(apis)('retains %s discovered tool schemas across continuation', async (api) => {
		const deferred = { ...shell, deferred: true };
		const { desktop } = bridge((request, _emit, turn) => {
			const body = JSON.stringify(request.body?.tools);
			if (!turn) {
				expect(body).not.toContain('exec_command');
				return round(api, [call('discover', 'tool_search', '{"query":"commands"}')]);
			}
			expect(body).toContain('exec_command');
			return turn === 1 ? round(api, [call('command')]) : round(api, [], 'Finished');
		});
		const execute = vi.fn(async (name: string) =>
			name === 'tool_search' ? { ...ok, discoveredTools: [deferred] } : ok,
		);
		const yielded = await streamAgentChat(
			options({
				connection: { ...connection, chatApi: api },
				tools: [search, deferred],
				execute,
				shouldYieldForInput: () => true,
			}),
		);
		expect(yielded.continuationTools?.find((tool) => tool.name === 'exec_command')).toMatchObject({
			deferred: false,
			parameters: shell.parameters,
		});
		const resumed = await streamAgentChat(
			options({
				connection: { ...connection, chatApi: api },
				history: continuation(yielded),
				tools: yielded.continuationTools!,
				execute,
			}),
		);
		expect(resumed.content).toBe('Finished');
		expect(execute.mock.calls.map(([name]) => name)).toEqual(['tool_search', 'exec_command']);
		expect(desktop.request).toHaveBeenCalledTimes(3);
	});
	it.each(apis)('gives cancellation priority over queued input in %s', async (api) => {
		const controller = new AbortController();
		const shouldYieldForInput = vi.fn(() => true);
		bridge(() => round(api, [call('cancelled')]));
		await expect(
			streamAgentChat(
				options({
					connection: { ...connection, chatApi: api },
					signal: controller.signal,
					shouldYieldForInput,
					execute: async () => {
						controller.abort();
						return ok;
					},
				}),
			),
		).rejects.toMatchObject({ name: 'AbortError' });
		expect(shouldYieldForInput).not.toHaveBeenCalled();
	});
	it.each(apis)('does not yield after a failed %s model request', async (api) => {
		const shouldYieldForInput = vi.fn(() => true);
		bridge(() => json({ error: { message: 'Backend unavailable' } }, 503));
		await expect(
			streamAgentChat(
				options({ connection: { ...connection, chatApi: api }, shouldYieldForInput }),
			),
		).rejects.toThrow('Backend unavailable');
		expect(shouldYieldForInput).not.toHaveBeenCalled();
	});
	it.each(apis)('preserves %s compaction checkpoints at a queued boundary', async (api) => {
		const compactConnection: Connection = {
			...connection,
			chatApi: api,
			catalog: connection.catalog!.map((entry) => ({
				...entry,
				contextWindow: 4096,
			})),
		};
		const longHistory: Message[] = [
			...history,
			{ id: 'long-answer', role: 'assistant', content: 'x'.repeat(20_000), createdAt: 2 },
			{ id: 'latest-user', role: 'user', content: 'Continue checking the project.', createdAt: 3 },
		];
		let ordinaryRounds = 0;
		const shouldYieldForInput = vi.fn(() => true);
		const { desktop } = bridge((request) => {
			if (JSON.stringify(requestInput(request).at(-1)).includes(COMPACTION_PROMPT)) {
				expect(shouldYieldForInput).not.toHaveBeenCalled();
				return round(api, [], 'Project inspected. Continue checking tests.');
			}
			expect(JSON.stringify(requestInput(request))).toContain(SUMMARY_PREFIX.trim());
			expect(JSON.stringify(requestInput(request))).not.toContain('x'.repeat(1000));
			return ordinaryRounds++ ? round(api, [], 'All done') : round(api, [call('after-summary')]);
		});
		const execute = vi.fn(async () => ok);
		const yielded = await streamAgentChat(
			options({
				connection: compactConnection,
				history: longHistory,
				compaction: true,
				compactionSettings: { thresholdPercent: 90, reserveTokens: 1024 },
				execute,
				shouldYieldForInput,
			}),
		);
		expect(yielded.transcript.context).toMatchObject({
			historyMessageIds: longHistory.map((entry) => entry.id),
			transcriptItemCount: 0,
		});
		const resumedHistory = [...longHistory, ...continuation(yielded).slice(history.length)];
		const resumed = await streamAgentChat(
			options({
				connection: compactConnection,
				history: resumedHistory,
				compaction: true,
				compactionSettings: { thresholdPercent: 90, reserveTokens: 1024 },
				execute,
			}),
		);
		expect(resumed.content).toBe('All done');
		expect(execute).toHaveBeenCalledTimes(1);
		expect(desktop.request).toHaveBeenCalledTimes(3);
	});
});

describe('long agent trajectories and portable compaction', () => {
	const modelConnection = (api: Connection['chatApi'], contextWindow = 4096): Connection => ({
		...connection,
		chatApi: api,
		catalog: connection.catalog!.map((entry) => ({
			...entry,
			contextWindow,
		})),
	});
	const compactionPolicy = (contextWindow = 4096) => ({
		thresholdPercent: 90,
		reserveTokens: Math.floor(contextWindow / 4),
	});
	const input = (request: WireRequest) =>
		(request.body![request.path === '/responses' ? 'input' : 'messages'] || []) as Record<
			string,
			unknown
		>[];
	const isSummary = (request: WireRequest) =>
		JSON.stringify(input(request).at(-1)).includes(COMPACTION_PROMPT);
	const roundJson = (
		api: Connection['chatApi'],
		text: string,
		calls: ReturnType<typeof call>[] = [],
		usage?: number,
	) =>
		json(
			api === 'responses'
				? {
						output: [...(text ? [message(text)] : []), ...calls],
						...(usage === undefined ? {} : { usage: { input_tokens: usage } }),
					}
				: {
						choices: [
							{
								message: {
									role: 'assistant',
									content: text || null,
									...(calls.length
										? {
												tool_calls: calls.map((entry) => ({
													id: entry.call_id,
													type: 'function',
													function: { name: entry.name, arguments: entry.arguments },
												})),
											}
										: {}),
								},
							},
						],
						...(usage === undefined ? {} : { usage: { prompt_tokens: usage } }),
					},
		);
	const longHistory: Message[] = [
		{
			id: 'goal',
			role: 'user',
			content: 'Repair the project and preserve the existing files.',
			createdAt: 1,
		},
		{
			id: 'old-answer',
			role: 'assistant',
			content: 'Old investigation: ' + 'x'.repeat(20_000),
			createdAt: 2,
		},
		{ id: 'latest', role: 'user', content: 'Continue, then run the tests.', createdAt: 3 },
	];

	it.each(['responses', 'chat/completions'] as const)(
		'uses the supplied Code policy to change the trigger for the same %s model',
		async (api) => {
			const policyHistory = longHistory.map((entry) =>
				entry.id === 'old-answer' ? { ...entry, content: 'x'.repeat(10_000) } : entry,
			);
			let summaries = 0;
			bridge((request) => {
				if (isSummary(request)) {
					summaries++;
					return roundJson(api, 'The project investigation is complete; continue with tests.');
				}
				return roundJson(api, 'Done');
			});
			const run = (thresholdPercent: number) =>
				streamAgentChat(
					options({
						connection: modelConnection(api),
						history: policyHistory,
						compaction: true,
						compactionSettings: { thresholdPercent, reserveTokens: 0 },
					}),
				);
			const early = await run(50);
			const late = await run(90);
			expect(early.transcript.context?.compactionCount).toBe(1);
			expect(late.transcript.context).toBeUndefined();
			expect(summaries).toBe(1);
		},
	);
	it.each(['responses', 'chat/completions'] as const)(
		'applies one Code policy to different %s model context windows',
		async (api) => {
			let summaries = 0;
			bridge((request) => {
				if (isSummary(request)) {
					summaries++;
					return roundJson(api, 'The investigation is complete; run the pending tests.');
				}
				return roundJson(api, 'Done');
			});
			const policy = { thresholdPercent: 90, reserveTokens: 1024 };
			const run = (contextWindow: number) =>
				streamAgentChat(
					options({
						connection: modelConnection(api, contextWindow),
						history: longHistory,
						compaction: true,
						compactionSettings: policy,
					}),
				);
			const smaller = await run(4096);
			const larger = await run(8192);
			expect(smaller.transcript.context?.compactionCount).toBe(1);
			expect(larger.transcript.context).toBeUndefined();
			expect(summaries).toBe(1);
		},
	);
	it('ignores legacy model compaction policy when no Code policy is supplied', async () => {
		const legacyConnection: Connection = {
			...modelConnection('responses', 10_000),
			catalog: connection.catalog!.map((entry) => ({
				...entry,
				contextWindow: 10_000,
				// Imported legacy catalog data must not override the global/default policy.
				compactionThresholdPercent: 1,
				compactionReserveTokens: 9999,
			})),
		};
		const { desktop } = bridge((request) => {
			expect(isSummary(request)).toBe(false);
			return roundJson('responses', 'Done');
		});
		const result = await streamAgentChat(
			options({
				connection: legacyConnection,
				history: longHistory.map((entry) =>
					entry.id === 'old-answer' ? { ...entry, content: 'x'.repeat(10_000) } : entry,
				),
				compaction: true,
			}),
		);
		expect(result.transcript.context).toBeUndefined();
		expect(desktop.request).toHaveBeenCalledTimes(1);
	});

	it.each(['responses', 'chat/completions'] as const)(
		'keeps %s source context separate, survives compaction and replaces it on resume',
		async (api) => {
			const context = [{ id: 'repo', source: '/project/AGENTS.md', text: 'REPOSITORY_RULE_V1' }];
			const onRequest = vi.fn();
			let compacted = 0;
			const { desktop } = bridge((request) => {
				if (isSummary(request)) {
					compacted++;
					return roundJson(api, 'Repair in progress. Keep existing files and finish the checks.');
				}
				return roundJson(api, 'Checked.');
			});
			const result = await streamAgentChat(
				options({
					connection: modelConnection(api),
					history: longHistory,
					context,
					onRequest,
					compaction: true,
					compactionSettings: compactionPolicy(),
				}),
			);
			expect(compacted).toBe(1);
			for (const [request] of desktop.request.mock.calls) {
				const messages = input(request);
				const prefix = messages.filter(
					(item) => item.role === 'user' && JSON.stringify(item).includes('REPOSITORY_RULE_V1'),
				);
				expect(prefix).toHaveLength(1);
				expect(messages.findIndex((item) => item === prefix[0])).toBe(api === 'responses' ? 0 : 1);
				expect(prefix[0].content).toEqual(
					api === 'responses'
						? [{ type: 'input_text', text: formatPromptContext(context) }]
						: formatPromptContext(context),
				);
				expect(api === 'responses' ? request.body?.instructions : messages[0].content).toBe(
					'Be careful',
				);
			}
			expect(
				onRequest.mock.calls.every(
					([snapshot]) => snapshot.context[0].text === 'REPOSITORY_RULE_V1',
				),
			).toBe(true);
			expect(JSON.stringify(result.transcript)).not.toContain('REPOSITORY_RULE_V1');
			await streamAgentChat(
				options({
					connection: modelConnection(api),
					compaction: true,
					compactionSettings: compactionPolicy(),
					context: [{ ...context[0], text: 'REPOSITORY_RULE_V2' }],
					history: [
						...longHistory,
						{
							id: 'answer',
							role: 'assistant',
							content: result.content,
							createdAt: 4,
							agentTranscript: result.transcript,
						},
						{ id: 'followup', role: 'user', content: 'Continue', createdAt: 5 },
					],
				}),
			);
			const last = JSON.stringify(desktop.request.mock.calls.at(-1)![0].body);
			expect(last).toContain('REPOSITORY_RULE_V2');
			expect(last).not.toContain('REPOSITORY_RULE_V1');
		},
	);
	it.each(['responses', 'chat/completions', 'chat'] as const)(
		'finishes more than 32 rounds and 64 calls in %s with fresh output budgets',
		async (api) => {
			// The final response must contain text; do not rely on a turn-limit error to exit.
			const { desktop } = bridge((_request, _emit, turn) =>
				roundJson(
					api,
					turn < 70 ? '' : 'Finished the long task',
					turn < 70 ? [call(`long-${turn}`)] : [],
				),
			);
			const execute = vi.fn(async () => ({
				content: [{ type: 'text' as const, text: 'output ' + 'x'.repeat(30_000) }],
			}));
			const result = await streamAgentChat(options({ connection: modelConnection(api), execute }));
			expect(execute).toHaveBeenCalledTimes(70);
			expect(desktop.request).toHaveBeenCalledTimes(71);
			expect(result.content).toBe('Finished the long task');
			expect(result.toolCalls).toHaveLength(70);
			expect(
				result.toolCalls.every((entry) =>
					entry.result?.content.some((part) => part.type === 'text' && part.text.length >= 30_000),
				),
			).toBe(true);
		},
	);
	it('can cancel an unbounded trajectory after the former caps without losing tool pairing', async () => {
		const controller = new AbortController();
		let latest: AgentUpdate | undefined;
		bridge((_request, _emit, turn) => roundJson('responses', '', [call(`cancel-${turn}`)]));
		let executed = 0;
		await expect(
			streamAgentChat(
				options({
					signal: controller.signal,
					execute: async () => {
						if (++executed === 70) controller.abort();
						return ok;
					},
					onUpdate: (update) => {
						latest = update;
					},
				}),
			),
		).rejects.toMatchObject({ name: 'AbortError' });
		expect(executed).toBe(70);
		expect(latest!.toolCalls.at(-1)?.status).toBe('failed');
		expect(latest!.transcript.items.filter((item) => item.type === 'function_call')).toHaveLength(
			70,
		);
		expect(
			latest!.transcript.items.filter((item) => item.type === 'function_call_output'),
		).toHaveLength(70);
	});
	it.each(['responses', 'chat/completions', 'chat'] as const)(
		'compacts before a %s request, preserving the visible history and same model instructions',
		async (api) => {
			const original = structuredClone(longHistory);
			const updates: AgentUpdate[] = [];
			const { desktop } = bridge((request) => {
				if (isSummary(request)) {
					expect(request.body?.tools).toBeUndefined();
					expect(request.body?.model).toBe('model');
					expect(
						api === 'responses' ? request.body?.reasoning : request.body?.reasoning_effort,
					).toEqual(api === 'responses' ? { effort: 'low' } : 'low');
					expect(JSON.stringify(request.body)).toContain('Be careful');
					return roundJson(
						api,
						'Goal: repair the project. Old investigation is complete. Next: run tests.',
					);
				}
				expect(JSON.stringify(input(request))).toContain(SUMMARY_PREFIX.trim());
				expect(JSON.stringify(input(request))).not.toContain('x'.repeat(1000));
				return roundJson(api, 'Continuing the tests');
			});
			const result = await streamAgentChat(
				options({
					connection: modelConnection(api),
					history: longHistory,
					compaction: true,
					compactionSettings: compactionPolicy(),
					onUpdate: (update) => updates.push(update),
				}),
			);
			expect(desktop.request).toHaveBeenCalledTimes(2);
			expect(longHistory).toEqual(original);
			expect(result.transcript.items).toHaveLength(1);
			expect(result.transcript.context).toMatchObject({
				historyMessageIds: ['goal', 'old-answer', 'latest'],
				transcriptItemCount: 0,
				compactionCount: 1,
			});
			expect(result.transcript.context!.inputTokensAfter).toBeLessThan(
				result.transcript.context!.inputTokensBefore,
			);
			expect(
				updates.some((update) => update.phase === 'compacting' && !update.transcript.context),
			).toBe(true);
		},
	);
	it.each(['responses', 'chat/completions'] as const)(
		'repeatedly compacts %s tool runs and replays the latest checkpoint plus only later items',
		async (api) => {
			let rounds = 0;
			let summaries = 0;
			const { desktop } = bridge((request) => {
				if (isSummary(request)) {
					summaries++;
					expect(request.body?.tools).toBeUndefined();
					expect(JSON.stringify(input(request))).toContain('FACT checked file');
					return roundJson(
						api,
						`Goal: inspect project. Checked ${rounds} files. Tests passed; continue pending checks.`,
					);
				}
				return roundJson(
					api,
					rounds < 12 ? '' : 'All checks completed',
					rounds < 12 ? [call(`repeat-${rounds++}`)] : [],
				);
			});
			const result = await streamAgentChat(
				options({
					connection: modelConnection(api, 2048),
					compaction: true,
					compactionSettings: compactionPolicy(2048),
					execute: async () => ({
						content: [
							{
								type: 'text',
								text: 'FACT checked file; command returned zero. ' + 'x'.repeat(6000),
							},
						],
					}),
				}),
			);
			expect(summaries).toBeGreaterThan(2);
			expect(result.toolCalls).toHaveLength(12);
			expect(result.transcript.items).toHaveLength(api === 'responses' ? 25 : 25);
			expect(result.transcript.context?.compactionCount).toBe(summaries);
			const owner: Message = {
				id: 'owner',
				role: 'assistant',
				content: result.content,
				createdAt: 2,
				agentTranscript: result.transcript,
				toolCalls: result.toolCalls,
			};
			const resumed = [
				...history,
				owner,
				{ id: 'next', role: 'user' as const, content: 'What remains?', createdAt: 3 },
			];
			const firstRunCalls = desktop.request.mock.calls.length;
			await streamAgentChat(
				options({
					connection: modelConnection(api, 2048),
					history: resumed,
					compaction: true,
					compactionSettings: compactionPolicy(2048),
				}),
			);
			const body = desktop.request.mock.calls[firstRunCalls][0];
			expect(isSummary(body)).toBe(false);
			expect(JSON.stringify(input(body))).toContain('All checks completed');
			expect(JSON.stringify(input(body))).toContain('What remains?');
			expect(JSON.stringify(input(body))).toContain(SUMMARY_PREFIX.trim());
			expect(
				input(body).some((item) => item.type === 'function_call_output' || item.role === 'tool'),
			).toBe(false);
			expect(owner.agentTranscript!.items).toHaveLength(25);
		},
	);
	it('rejects a stale checkpoint when an earlier message is edited or model/connection changes', async () => {
		const prior = {
			version: 1 as const,
			api: 'responses' as const,
			model: 'model',
			connectionId: 'local',
			historyMessageIds: ['old-user'],
			transcriptItemCount: 1,
			items: [{ role: 'user', content: SUMMARY_PREFIX + 'STALE private work' }],
			createdAt: 2,
			compactionCount: 1,
			inputTokensBefore: 200,
			inputTokensAfter: 20,
		};
		const owner: Message = {
			id: 'owner',
			role: 'assistant',
			content: 'Original response',
			createdAt: 2,
			agentTranscript: { api: 'responses', items: [message('Original response')], context: prior },
		};
		const { desktop } = bridge(() => roundJson('responses', 'Fresh'));
		await streamAgentChat(
			options({
				compaction: true,
				history: [{ ...history[0], id: 'edited-user' }, owner, { ...history[0], id: 'followup' }],
			}),
		);
		expect(JSON.stringify(desktop.request.mock.calls[0][0].body)).not.toContain('STALE');
		expect(JSON.stringify(desktop.request.mock.calls[0][0].body)).toContain('Original response');
	});
	it.each(['empty', 'tool', 'nonreducing', 'transport', 'cancel'] as const)(
		'does not commit a %s failed summary or alter the original history',
		async (failure) => {
			const original = JSON.stringify(longHistory);
			const controller = new AbortController();
			let latest: AgentUpdate | undefined;
			bridge((request) => {
				expect(isSummary(request)).toBe(true);
				if (failure === 'cancel') {
					queueMicrotask(() => controller.abort());
					return new Promise<WireResponse>(() => {});
				}
				if (failure === 'transport')
					return json({ error: { message: 'Upstream unavailable' } }, 503);
				return roundJson(
					'responses',
					failure === 'empty' || failure === 'tool' ? '' : 'x'.repeat(30_000),
					failure === 'tool' ? [call('summary-tool')] : [],
				);
			});
			const operation = streamAgentChat(
				options({
					connection: modelConnection('responses'),
					history: longHistory,
					compaction: true,
					compactionSettings: compactionPolicy(),
					signal: controller.signal,
					onUpdate: (update) => {
						latest = update;
					},
				}),
			);
			if (failure === 'cancel')
				await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
			else await expect(operation).rejects.toThrow('original conversation is preserved');
			expect(latest!.transcript.context).toBeUndefined();
			expect(latest!.transcript.items).toEqual([]);
			expect(latest!.toolCalls).toEqual([]);
			expect(JSON.stringify(longHistory)).toBe(original);
		},
	);
	it('compacts after explicit overflow and retries once without rerunning previously executed tools', async () => {
		let normal = 0;
		let summaries = 0;
		const execute = vi.fn(async () => ({
			content: [
				{ type: 'text' as const, text: 'FACT: command completed once. ' + 'x'.repeat(2000) },
			],
		}));
		bridge((request) => {
			if (isSummary(request)) {
				summaries++;
				return roundJson(
					'responses',
					'Command completed successfully once. Continue with the final response.',
				);
			}
			normal++;
			if (normal === 1) return roundJson('responses', '', [call('once')]);
			if (normal === 2) return json({ error: { message: 'maximum context length exceeded' } }, 400);
			return roundJson('responses', 'Done');
		});
		const result = await streamAgentChat(
			options({
				connection: modelConnection('responses', 100_000),
				execute,
				compaction: true,
				compactionSettings: compactionPolicy(100_000),
			}),
		);
		expect(result.content).toBe('Done');
		expect(normal).toBe(3);
		expect(summaries).toBe(1);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(
			result.transcript.items.filter((item) => item.type === 'function_call_output'),
		).toHaveLength(1);
	});
	it('progressively trims old summary inputs with their paired outputs on explicit overflow', async () => {
		const paired: Message[] = [
			history[0],
			{
				id: 'prior',
				role: 'assistant',
				content: '',
				createdAt: 2,
				agentTranscript: {
					api: 'responses',
					items: [
						call('old-call', 'exec_command', JSON.stringify({ cmd: 'x'.repeat(8000) })),
						{ type: 'function_call_output', call_id: 'old-call', output: 'Old command done' },
					],
				},
			},
			{ ...history[0], id: 'new' },
		];
		let normal = 0;
		let summaries = 0;
		bridge((request) => {
			if (!isSummary(request)) {
				if (++normal === 1) return json({ error: { message: 'context_length_exceeded' } }, 400);
				return roundJson('responses', 'Done');
			}
			summaries++;
			const items = input(request);
			const hasCall = items.some(
				(item) => item.type === 'function_call' && item.call_id === 'old-call',
			);
			const hasOutput = items.some(
				(item) => item.type === 'function_call_output' && item.call_id === 'old-call',
			);
			expect(hasCall).toBe(hasOutput);
			if (summaries < 3) return json({ error: { message: 'context window exceeded' } }, 400);
			expect(hasCall).toBe(false);
			return roundJson('responses', 'Old command completed. Resume work.');
		});
		const result = await streamAgentChat(
			options({
				connection: modelConnection('responses', 100_000),
				history: paired,
				compaction: true,
				compactionSettings: compactionPolicy(100_000),
			}),
		);
		expect(result.content).toBe('Done');
		expect(summaries).toBe(3);
		expect(paired[1].agentTranscript!.items).toHaveLength(2);
	});
	it.each(['responses', 'chat/completions'] as const)(
		'uses streamed provider input usage to trigger %s compaction',
		async (api) => {
			let normals = 0;
			let summaries = 0;
			bridge((request, emit) => {
				if (isSummary(request)) {
					summaries++;
					return roundJson(api, 'The command ran successfully. Continue.');
				}
				if (++normals > 1) return roundJson(api, 'Done');
				if (api === 'responses')
					return sse(emit, [
						{
							type: 'response.completed',
							response: { output: [call('usage')], usage: { input_tokens: 8000 } },
						},
					]);
				return sse(emit, [
					{
						choices: [
							{
								index: 0,
								delta: {
									tool_calls: [
										{
											index: 0,
											id: 'usage',
											type: 'function',
											function: { name: 'exec_command', arguments: '{"cmd":"pwd"}' },
										},
									],
								},
								finish_reason: 'tool_calls',
							},
						],
					},
					{ choices: [], usage: { prompt_tokens: 8000 } },
					'[DONE]',
				]);
			});
			const result = await streamAgentChat(
				options({
					connection: modelConnection(api),
					compaction: true,
					compactionSettings: compactionPolicy(),
				}),
			);
			expect(summaries).toBe(1);
			expect(result.transcript.context!.inputTokensBefore).toBeGreaterThanOrEqual(8000);
			expect(result.content).toBe('Done');
		},
	);
	it.each(['responses', 'chat/completions'] as const)(
		'persists %s provider usage and restores threshold tracking on a tool-free subsequent turn',
		async (api) => {
			let normals = 0;
			let summaries = 0;
			const { desktop } = bridge((request) => {
				if (isSummary(request)) {
					summaries++;
					return roundJson(
						api,
						'The prior answer addressed the project. Continue with the latest user request.',
					);
				}
				return roundJson(
					api,
					++normals === 1 ? 'The first answer is complete.' : 'Next answer complete.',
					[],
					normals === 1 ? 8000 : 200,
				);
			});
			const first = await streamAgentChat(
				options({
					connection: modelConnection(api),
					compaction: true,
					compactionSettings: compactionPolicy(),
					tools: [],
				}),
			);
			expect(summaries).toBe(0);
			expect(first.transcript.usage).toMatchObject({
				inputTokens: 8000,
				historyMessageIds: ['user'],
				model: 'model',
				connectionId: 'local',
			});
			const reloaded: Message = JSON.parse(
				JSON.stringify({
					id: 'first-answer',
					role: 'assistant',
					content: first.content,
					createdAt: 2,
					agentTranscript: first.transcript,
				}),
			);
			const next = await streamAgentChat(
				options({
					connection: modelConnection(api),
					compaction: true,
					compactionSettings: compactionPolicy(),
					tools: [],
					history: [
						...history,
						reloaded,
						{ id: 'next-user', role: 'user', content: 'Keep going', createdAt: 3 },
					],
				}),
			);
			expect(isSummary(desktop.request.mock.calls[1][0])).toBe(true);
			expect(summaries).toBe(1);
			expect(next.transcript.context!.inputTokensBefore).toBeGreaterThan(8000);
			expect(next.transcript.usage?.inputTokens).toBe(200);
			expect(next.content).toBe('Next answer complete.');
		},
	);
	it('retries a rejected Chat usage option without disabling streaming or executing extra tools', async () => {
		const { desktop } = bridge((request, _emit, turn) =>
			turn === 0
				? json({ error: { message: 'Unknown parameter: stream_options' } }, 400)
				: roundJson('chat/completions', 'Done'),
		);
		await streamAgentChat(options({ connection: modelConnection('chat/completions') }));
		expect(desktop.request).toHaveBeenCalledTimes(2);
		expect(desktop.request.mock.calls[1][0].body?.stream_options).toBeUndefined();
		expect(desktop.request.mock.calls[1][0].body?.stream).toBe(true);
	});
	it.each(['usage-first', 'stream-first'] as const)(
		'negotiates unsupported streaming and usage with bounded %s fallbacks',
		async (order) => {
			const { desktop } = bridge((request, _emit, turn) => {
				if (turn === 0)
					return json(
						{
							error: {
								message:
									order === 'usage-first'
										? 'Unsupported parameter stream_options'
										: 'Streaming is not supported',
							},
						},
						400,
					);
				if (order === 'usage-first' && turn === 1)
					return json({ error: { message: 'Streaming is not supported' } }, 422);
				expect(request.stream).toBe(false);
				expect(request.body?.stream).toBe(false);
				expect(request.body?.stream_options).toBeUndefined();
				return roundJson('chat/completions', 'Finished');
			});
			const result = await streamAgentChat(
				options({ connection: modelConnection('chat/completions') }),
			);
			expect(result.content).toBe('Finished');
			expect(desktop.request).toHaveBeenCalledTimes(order === 'usage-first' ? 3 : 2);
		},
	);
	it('retries an overflowing normal model round exactly once', async () => {
		let normals = 0;
		let summaries = 0;
		bridge((request) => {
			if (isSummary(request)) {
				summaries++;
				return roundJson('responses', 'Investigation is complete; continue.');
			}
			normals++;
			return json({ error: { message: 'maximum context length exceeded' } }, 400);
		});
		await expect(
			streamAgentChat(
				options({
					connection: modelConnection('responses', 100_000),
					history: longHistory,
					compaction: true,
					compactionSettings: compactionPolicy(100_000),
				}),
			),
		).rejects.toThrow('maximum context length');
		expect(normals).toBe(2);
		expect(summaries).toBe(1);
	});
	it.each(['transport', 'cancel'] as const)(
		'retains the previous valid checkpoint and new paired tools when a later compaction fails with %s',
		async (failure) => {
			const controller = new AbortController();
			let normal = 0;
			let summaries = 0;
			let latest: AgentUpdate | undefined;
			bridge((request) => {
				if (isSummary(request)) {
					if (++summaries === 1)
						return roundJson('responses', 'First command completed. Continue the remaining work.');
					if (failure === 'cancel') {
						queueMicrotask(() => controller.abort());
						return new Promise<WireResponse>(() => {});
					}
					return json({ error: { message: 'Summary provider unavailable' } }, 503);
				}
				return roundJson('responses', '', [call(`preserved-${normal++}`)]);
			});
			const operation = streamAgentChat(
				options({
					connection: modelConnection('responses', 2048),
					compaction: true,
					compactionSettings: compactionPolicy(2048),
					signal: controller.signal,
					execute: async () => ({
						content: [{ type: 'text', text: 'Result: ' + 'x'.repeat(6000) }],
					}),
					onUpdate: (update) => {
						latest = update;
					},
				}),
			);
			if (failure === 'cancel')
				await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
			else await expect(operation).rejects.toThrow('original conversation is preserved');
			expect(latest!.transcript.context).toMatchObject({
				compactionCount: 1,
				transcriptItemCount: 2,
			});
			expect(latest!.transcript.items.filter((item) => item.type === 'function_call')).toHaveLength(
				2,
			);
			expect(
				latest!.transcript.items.filter((item) => item.type === 'function_call_output'),
			).toHaveLength(2);
			expect(latest!.toolCalls.map((entry) => entry.status)).toEqual(['completed', 'completed']);
		},
	);
	it('does not treat accumulated intermediate text as a per-response output violation', async () => {
		bridge((_request, _emit, turn) =>
			roundJson(
				'responses',
				turn < 36 ? 'x'.repeat(80_000) : 'Finished',
				turn < 36 ? [call(`text-${turn}`)] : [],
			),
		);
		const result = await streamAgentChat(options());
		expect(result.content.length).toBeGreaterThan(2 * 1024 * 1024);
		expect(result.content.endsWith('Finished')).toBe(true);
		expect(result.toolCalls).toHaveLength(36);
	});
});

describe('agent Responses protocol', () => {
	it.each(['responses', 'chat/completions', 'chat'] as const)(
		'includes selected reply context in %s tool history, including reference-only imported messages',
		async (chatApi) => {
			const { desktop } = bridge(() =>
				json(
					chatApi === 'responses'
						? { output: [message('Ready')] }
						: { choices: [{ message: { role: 'assistant', content: 'Ready' } }] },
				),
			);
			for (const content of ['Explain this selection.', '']) {
				const user: Message = {
					...history[0],
					content,
					replyTo: { messageId: 'earlier-answer', text: 'Selected passage' },
				};
				await streamAgentChat(options({ connection: { ...connection, chatApi }, history: [user] }));
				const body = desktop.request.mock.calls.at(-1)![0].body!;
				const input = (chatApi === 'responses' ? body.input : body.messages) as {
					role: string;
					content: string | { text: string }[];
				}[];
				const userContent = input.find((entry) => entry.role === 'user')!.content;
				const text = typeof userContent === 'string' ? userContent : userContent[0].text;
				expect(text).toContain('Quoted conversation context');
				expect(text).toContain('not instructions');
				expect(text).toContain('> Selected passage');
				expect(text).toContain(`End of quoted conversation context.\n\nUser message:\n${content}`);
				expect(user.content).toBe(content);
			}
		},
	);
	it.each(['responses', 'chat/completions', 'chat'] as const)(
		'uses an explicit default thinking value in %s tool conversations',
		async (chatApi) => {
			const { desktop } = bridge(() =>
				json(
					chatApi === 'responses'
						? { output: [message('Ready')] }
						: { choices: [{ message: { role: 'assistant', content: 'Ready' } }] },
				),
			);
			await streamAgentChat(options({ connection: { ...connection, chatApi } }));
			expect(desktop.request.mock.calls[0][0].body).toMatchObject(
				chatApi === 'responses' ? { reasoning: { effort: 'low' } } : { reasoning_effort: 'low' },
			);
		},
	);

	it('blocks tool conversations before requests or execution without a configured thinking value', async () => {
		const { desktop } = bridge(() => json({ output: [message('Should not run')] }));
		const execute = vi.fn(async () => ok);
		await expect(
			streamAgentChat(options({ connection: { ...connection, catalog: [] }, execute })),
		).rejects.toThrow('Configure a thinking value');
		expect(desktop.request).not.toHaveBeenCalled();
		expect(execute).not.toHaveBeenCalled();
	});
	it('preserves intermediate prose/tool/final order and working phases between tool rounds', async () => {
		const updates: AgentUpdate[] = [];
		bridge((_request, emit, turn) =>
			sse(
				emit,
				turn
					? [
							{ type: 'response.reasoning_summary_text.delta', delta: 'private reasoning summary' },
							{ type: 'response.output_text.delta', delta: 'The files are ready.' },
							{
								type: 'response.completed',
								response: { output: [message('The files are ready.')] },
							},
						]
					: [
							{ type: 'response.reasoning_text.delta', delta: 'private reasoning' },
							{ type: 'response.output_text.delta', delta: 'I will inspect the project.' },
							{
								type: 'response.completed',
								response: { output: [message('I will inspect the project.'), call('inspect')] },
							},
						],
			),
		);
		const result = await streamAgentChat({
			connection,
			model: 'model',
			history,
			instructions: '',
			tools: [shell],
			execute: async () => ok,
			onUpdate: (value) => updates.push(value),
		});
		expect(result.content).toBe('I will inspect the project.\n\nThe files are ready.');
		expect(result.activity?.map((part) => part.type)).toEqual(['text', 'tool', 'text']);
		expect(result.activity?.[1]).toMatchObject({ type: 'tool', toolCallId: 'inspect' });
		expect(
			updates.some((update) => update.phase === 'working' && update.toolCalls.length === 1),
		).toBe(true);
		expect(updates.some((update) => update.phase === 'tools')).toBe(true);
		expect(JSON.stringify(result.activity)).not.toContain('private reasoning');
	});
	it.each(['responses', 'chat/completions', 'chat'] as const)(
		'times activity through the first final-answer delta, excluding intermediate prose and answer streaming in %s',
		async (chatApi) => {
			let clock = 1000;
			vi.spyOn(Date, 'now').mockImplementation(() => clock);
			const updates: AgentUpdate[] = [];
			const event = (emit: (text: string) => void, data: unknown) =>
				emit(`data: ${JSON.stringify(data)}\n\n`);
			bridge((_request, emit, turn) => {
				clock = turn ? 5000 : 2000;
				const firstText = turn ? 'The final ' : 'I will check.';
				event(
					emit,
					chatApi === 'responses'
						? { type: 'response.output_text.delta', delta: firstText }
						: { choices: [{ delta: { content: firstText } }] },
				);
				clock = turn ? 7000 : 2500;
				if (turn)
					event(
						emit,
						chatApi === 'responses'
							? { type: 'response.output_text.delta', delta: 'answer.' }
							: { choices: [{ delta: { content: 'answer.' } }] },
					);
				else if (chatApi !== 'responses')
					event(emit, {
						choices: [
							{
								delta: {
									tool_calls: [
										{
											index: 0,
											id: 'check',
											function: { name: 'exec_command', arguments: '{}' },
										},
									],
								},
							},
						],
					});
				clock = turn ? 8000 : 3000;
				event(
					emit,
					chatApi === 'responses'
						? {
								type: 'response.completed',
								response: {
									output: turn
										? [message('The final answer.')]
										: [message(firstText), call('check', 'exec_command', '{}')],
								},
							}
						: { choices: [{ delta: {}, finish_reason: turn ? 'stop' : 'tool_calls' }] },
				);
				return { status: 200, contentType: 'text/event-stream', body: '', encoding: 'text' };
			});
			const result = await streamAgentChat(
				options({
					connection: { ...connection, chatApi },
					onUpdate: (update) => updates.push(update),
				}),
			);
			expect(result.activityFinishedAt).toBe(5000);
			expect(result.content).toBe('I will check.\n\nThe final answer.');
			expect(updates.filter((update) => update.activityFinishedAt !== undefined)).toEqual([result]);
		},
	);
	it('uses the final text arrival time for a nonstreaming response', async () => {
		vi.spyOn(Date, 'now').mockReturnValue(9000);
		bridge(() => json({ output: [message('Ready')] }));
		const result = await streamAgentChat(options());
		expect(result.activityFinishedAt).toBe(9000);
	});
	it('assembles interleaved argument streams and preserves reasoning and final output at EOF', async () => {
		const execute = vi.fn<AgentChatOptions['execute']>(async () => ok);
		const reasoning = {
			id: 'reasoning1',
			type: 'reasoning',
			summary: [],
			encrypted_content: 'opaque-provider-state',
		};
		const { desktop, listeners } = bridge((_request, emit, turn) => {
			if (turn)
				return sse(
					emit,
					[
						{ type: 'response.output_text.delta', delta: 'All done' },
						{ type: 'response.completed', response: { output: [message('All done')] } },
					],
					true,
				);
			const response = sse(
				emit,
				[
					{ type: 'response.output_item.added', output_index: 0, item: reasoning },
					{
						type: 'response.output_item.added',
						output_index: 1,
						item: call('call_a', 'exec_command', ''),
					},
					{
						type: 'response.output_item.added',
						output_index: 2,
						item: call('call_b', 'exec_command', ''),
					},
					{
						type: 'response.function_call_arguments.delta',
						item_id: 'item_call_a',
						delta: '{"cmd":',
					},
					{
						type: 'response.function_call_arguments.delta',
						output_index: 2,
						delta: '{"cmd":"ls"}',
					},
					{ type: 'response.function_call_arguments.delta', output_index: 1, delta: '"pwd"}' },
					{ type: 'response.completed', response: { status: 'completed' } },
				],
				true,
			);
			expect(execute).not.toHaveBeenCalled();
			return response;
		});
		const result = await streamAgentChat(options({ execute }));
		expect(execute.mock.calls).toEqual([
			['exec_command', { cmd: 'pwd' }, 'call_a'],
			['exec_command', { cmd: 'ls' }, 'call_b'],
		]);
		expect(result.content).toBe('All done');
		expect(result.toolCalls.map((item) => item.status)).toEqual(['completed', 'completed']);
		expect(result.transcript.items[0]).toEqual(reasoning);
		const next = desktop.request.mock.calls[1][0].body!;
		expect(next).toMatchObject({
			instructions: 'Be careful',
			store: false,
			include: ['reasoning.encrypted_content'],
		});
		expect(next.input).toEqual(
			expect.arrayContaining([
				reasoning,
				{ type: 'function_call_output', call_id: 'call_a', output: 'Command output' },
			]),
		);
		expect(listeners.size).toBe(0);
	});

	it('uses canonical completed items to recover complete arguments, including streams larger than 64 KB', async () => {
		const long = 'x'.repeat(73479);
		const execute = vi.fn<AgentChatOptions['execute']>(async () => ok);
		bridge((_request, emit, turn) =>
			turn
				? json({ output: [message('Finished')] })
				: sse(
						emit,
						[
							{ type: 'response.output_text.delta', delta: long },
							{
								type: 'response.output_item.added',
								output_index: 1,
								item: call('big', 'exec_command', ''),
							},
							{ type: 'response.completed', response: { output: [message(long), call('big')] } },
						],
						true,
					),
		);
		const result = await streamAgentChat(options({ execute }));
		expect(result.content).toBe(`${long}\n\nFinished`);
		expect(execute).toHaveBeenCalledExactlyOnceWith('exec_command', { cmd: 'pwd' }, 'big');
	});

	it.each(['missing completion', 'malformed JSON', 'incomplete', 'delivery mismatch'] as const)(
		'does not execute calls on %s and exposes stream diagnostics',
		async (failure) => {
			const execute = vi.fn<AgentChatOptions['execute']>(async () => ok);
			bridge((_request, emit) => {
				const events: unknown[] = [
					{ type: 'response.output_item.added', output_index: 0, item: call('unsafe') },
				];
				if (failure === 'malformed JSON') events.push('{broken');
				if (failure === 'incomplete')
					events.push({
						type: 'response.incomplete',
						response: { incomplete_details: { reason: 'max_output_tokens' } },
					});
				if (failure === 'delivery mismatch')
					events.push({ type: 'response.completed', response: { output: [call('unsafe')] } });
				const response = sse(emit, events, true);
				if (failure === 'delivery mismatch') response.stream!.characters += 100;
				return response;
			});
			await expect(streamAgentChat(options({ execute }))).rejects.toThrow(
				/Stream details:.*characters,.*events, last event:/,
			);
			expect(execute).not.toHaveBeenCalled();
		},
	);

	it('accepts a completion type carried by the SSE event field with no trailing newline', async () => {
		bridge((_request, emit) => {
			const text = `event: response.completed\ndata: ${JSON.stringify({ response: { output: [message('Done')] } })}`;
			emit(text);
			return { status: 200, contentType: 'text/event-stream', body: '', encoding: 'text' };
		});
		expect((await streamAgentChat(options())).content).toBe('Done');
	});

	it('returns invalid arguments, unknown tools, and host failures to the model without executing invalid calls', async () => {
		const execute = vi.fn(async () => {
			throw new Error('Approval denied');
		});
		const { desktop } = bridge((_request, _emit, turn) =>
			turn
				? json({ output: [message('Recovered')] })
				: json({
						output: [
							call('badjson', 'exec_command', 'broken'),
							call('unknown', 'not_discovered'),
							call('denied'),
						],
					}),
		);
		const result = await streamAgentChat(options({ execute }));
		expect(execute).toHaveBeenCalledExactlyOnceWith('exec_command', { cmd: 'pwd' }, 'denied');
		expect(result.toolCalls.map((item) => item.status)).toEqual(['failed', 'failed', 'failed']);
		const input = desktop.request.mock.calls[1][0].body!.input as Record<string, unknown>[];
		expect(
			input.filter((item) => item.type === 'function_call_output').map((item) => item.output),
		).toEqual([
			expect.stringContaining('valid JSON'),
			expect.stringContaining('unavailable'),
			expect.stringContaining('Approval denied'),
		]);
	});

	it('preserves structured authorization denial as one denied activity and returns its reason to the model', async () => {
		const reason = 'The destination was not authorized by the user.';
		const denial: ToolResult = {
			isError: true,
			approvalDenied: { reason, permissionMode: 'auto-review', effectiveDirectory: '/tmp/project' },
			content: [
				{ type: 'text', text: `${reason} Do not retry this action without a new user request.` },
			],
		};
		const execute = vi.fn(async () => denial);
		const { desktop } = bridge((_request, _emit, turn) =>
			turn
				? json({ output: [message('I need approval for this destination.')] })
				: json({ output: [call('denied-action')] }),
		);
		const result = await streamAgentChat(options({ execute }));
		expect(execute).toHaveBeenCalledExactlyOnceWith(
			'exec_command',
			{ cmd: 'pwd' },
			'denied-action',
		);
		expect(result.toolCalls).toHaveLength(1);
		expect(result.toolCalls[0]).toMatchObject({
			id: 'denied-action',
			status: 'denied',
			result: denial,
		});
		expect(result.activity?.filter((part) => part.type === 'tool')).toHaveLength(1);
		const input = desktop.request.mock.calls[1][0].body!.input as Record<string, unknown>[];
		const outputs = input.filter((item) => item.type === 'function_call_output');
		expect(outputs).toHaveLength(1);
		expect(outputs[0].output).toContain(reason);
		expect(outputs[0].output).toContain('Do not retry this action without a new user request.');
		expect(outputs[0].output).not.toContain('approvalDenied');
	});

	it('rejects duplicate or missing call IDs before executing any tools', async () => {
		for (const calls of [
			[call('same'), call('same')],
			[call('ok'), call('')],
		]) {
			const execute = vi.fn<AgentChatOptions['execute']>(async () => ok);
			bridge(() => json({ output: calls }));
			await expect(streamAgentChat(options({ execute }))).rejects.toThrow(/call ID/);
			expect(execute).not.toHaveBeenCalled();
		}
	});

	it('sends image tool results as multimodal function call output', async () => {
		const image = { type: 'image' as const, dataUrl: 'data:image/png;base64,aGVsbG8=' };
		const { desktop } = bridge((_request, _emit, turn) =>
			json({ output: turn ? [message('Image ready')] : [call('image')] }),
		);
		const result = await streamAgentChat(options({ execute: async () => ({ content: [image] }) }));
		expect(result.toolCalls[0].result?.content).toEqual([image]);
		expect(desktop.request.mock.calls[1][0].body!.input).toEqual(
			expect.arrayContaining([
				{
					type: 'function_call_output',
					call_id: 'image',
					output: [
						{ type: 'input_text', text: 'Tool returned an image.' },
						{ type: 'input_image', image_url: image.dataUrl, detail: 'auto' },
					],
				},
			]),
		);
	});

	it('keeps generated images in the UI but does not send them to a catalog-declared text-only model', async () => {
		const image = { type: 'image' as const, dataUrl: 'data:image/png;base64,aGVsbG8=' };
		const { desktop } = bridge((_request, _emit, turn) =>
			json({ output: turn ? [message('Ready')] : [call('image')] }),
		);
		const result = await streamAgentChat(
			options({
				connection: {
					...connection,
					catalog: [
						{
							id: 'model',
							name: 'Text model',
							enabled: true,
							tasks: ['chat'],
							inputModalities: ['text'],
							outputModalities: ['text'],
							thinkingModes: connection.catalog![0].thinkingModes,
						},
					],
				},
				execute: async () => ({ content: [image] }),
			}),
		);
		expect(result.toolCalls[0].result?.content).toEqual([image]);
		expect(JSON.stringify(desktop.request.mock.calls[1][0].body)).not.toContain(image.dataUrl);
		expect(JSON.stringify(desktop.request.mock.calls[1][0].body)).toContain(
			'does not accept image inputs',
		);
	});
});

describe('agent Chat Completions protocol', () => {
	it.each(['chat/completions', 'chat'] as const)(
		'assembles streamed calls and includes matching tool messages at /%s',
		async (chatApi) => {
			const execute = vi.fn<AgentChatOptions['execute']>(async () => ok);
			const { desktop } = bridge((_request, emit, turn) =>
				turn
					? json({
							choices: [{ message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }],
						})
					: sse(
							emit,
							[
								{
									choices: [
										{
											index: 0,
											delta: {
												content: 'Inspecting',
												reasoning_content: 'provider-reasoning',
												tool_calls: [
													{
														index: 0,
														id: 'first',
														type: 'function',
														function: { name: 'exec_command', arguments: '{"cmd":' },
													},
													{
														index: 1,
														id: 'second',
														type: 'function',
														function: { name: 'exec_command', arguments: '{"cmd":"ls"}' },
													},
												],
											},
										},
									],
								},
								{
									choices: [
										{
											index: 0,
											delta: { tool_calls: [{ index: 0, function: { arguments: '"pwd"}' } }] },
										},
									],
								},
								{ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
								'[DONE]',
							],
							true,
						),
			);
			const result = await streamAgentChat(
				options({ connection: { ...connection, chatApi }, execute }),
			);
			expect(execute.mock.calls.map((entry) => entry[2])).toEqual(['first', 'second']);
			expect(result.content).toBe('Inspecting\n\nDone');
			expect(result.transcript.api).toBe('chat');
			expect(result.transcript.items[0]).toMatchObject({
				role: 'assistant',
				reasoning_content: 'provider-reasoning',
				tool_calls: [{ id: 'first' }, { id: 'second' }],
			});
			expect(desktop.request.mock.calls[1][0]).toMatchObject({
				path: `/${chatApi}`,
				body: {
					messages: [
						{ role: 'system' },
						{ role: 'user' },
						{ role: 'assistant' },
						{ role: 'tool', tool_call_id: 'first' },
						{ role: 'tool', tool_call_id: 'second' },
					],
				},
			});
		},
	);

	it('attaches tool images after every tool result to preserve the Chat Completions ordering contract', async () => {
		const image = { type: 'image' as const, dataUrl: 'data:image/png;base64,aGVsbG8=' };
		const { desktop } = bridge((_request, _emit, turn) =>
			json({
				choices: [
					{
						message: turn
							? { content: 'Ready' }
							: {
									content: null,
									tool_calls: ['a', 'b'].map((id) => ({
										id,
										type: 'function',
										function: { name: 'exec_command', arguments: '{}' },
									})),
								},
						finish_reason: turn ? 'stop' : 'tool_calls',
					},
				],
			}),
		);
		await streamAgentChat(
			options({
				connection: { ...connection, chatApi: 'chat/completions' },
				execute: async () => ({ content: [image] }),
			}),
		);
		const messages = desktop.request.mock.calls[1][0].body!.messages as Record<string, unknown>[];
		expect(messages.map((item) => item.role)).toEqual([
			'system',
			'user',
			'assistant',
			'tool',
			'tool',
			'user',
			'user',
		]);
		expect(messages[5].content).toEqual(
			expect.arrayContaining([{ type: 'image_url', image_url: { url: image.dataUrl } }]),
		);
	});

	it('does not execute tool calls when only DONE arrives without a finish reason', async () => {
		const execute = vi.fn<AgentChatOptions['execute']>(async () => ok);
		bridge((_request, emit) =>
			sse(emit, [
				{
					choices: [
						{
							delta: {
								tool_calls: [
									{ index: 0, id: 'a', function: { name: 'exec_command', arguments: '{}' } },
								],
							},
						},
					],
				},
				'[DONE]',
			]),
		);
		await expect(
			streamAgentChat(options({ connection: { ...connection, chatApi: 'chat' }, execute })),
		).rejects.toThrow('ended before completion');
		expect(execute).not.toHaveBeenCalled();
	});
});

describe('agent discovery, history, and limits', () => {
	it.each(['responses', 'chat'] as const)(
		'keeps eager notes callable before and after listing in %s without discovery',
		async (api) => {
			const append = { ...shell, name: 'notes_append_to_file' };
			const listNotes = { ...shell, name: 'notes_list_files_by_prefix' };
			const execute = vi.fn(async () => ok);
			bridge((request, _emit, turn) => {
				expect(JSON.stringify(request.body?.tools)).toContain('notes_append_to_file');
				expect(JSON.stringify(request.body?.tools)).not.toContain('tool_search');
				const calls =
					turn === 0
						? [call('append-first', append.name, '{}'), call('list', listNotes.name, '{}')]
						: turn === 1
							? [call('append-again', append.name, '{}')]
							: [];
				return api === 'responses'
					? json({ output: calls.length ? calls : [message('Done')] })
					: json({
							choices: [
								{
									message: {
										content: calls.length ? null : 'Done',
										tool_calls: calls.map((entry) => ({
											id: entry.call_id,
											type: 'function',
											function: { name: entry.name, arguments: entry.arguments },
										})),
									},
								},
							],
						});
			});
			const result = await streamAgentChat(
				options({
					connection: { ...connection, chatApi: api },
					tools: [append, listNotes],
					execute,
				}),
			);
			expect(execute).toHaveBeenCalledTimes(3);
			expect(result.toolCalls.every((entry) => entry.status === 'completed')).toBe(true);
		},
	);

	it('rejects a prefixed notes name, explains the offered name, and executes only the corrected call', async () => {
		const append = { ...shell, name: 'notes_append_to_file' };
		const execute = vi.fn(async () => ok);
		bridge((_request, _emit, turn) =>
			json({
				output:
					turn === 0
						? [call('wrong', `functions.${append.name}`, '{}')]
						: turn === 1
							? [call('correct', append.name, '{}')]
							: [message('Done')],
			}),
		);
		const result = await streamAgentChat(options({ tools: [append], execute }));
		expect(execute).toHaveBeenCalledExactlyOnceWith(append.name, {}, 'correct');
		expect(result.toolCalls[0].status).toBe('failed');
		const diagnostic = JSON.stringify(result.toolCalls[0].result);
		expect(diagnostic).toContain('exact offered API name');
		expect(diagnostic).toContain('functions.notes_append_to_file');
		expect(diagnostic).not.toContain('tool_search');
	});

	it('waits for the next model turn before executing a tool discovered earlier in the same batch', async () => {
		const discovered = { ...shell, name: 'hidden', deferred: true };
		const execute = vi.fn(async () => ({ ...ok, discoveredTools: [discovered] }));
		bridge((_request, _emit, turn) =>
			json({
				output: turn
					? [message('Done')]
					: [call('discover', 'tool_search', '{}'), call('too_early', 'hidden')],
			}),
		);
		const result = await streamAgentChat(options({ tools: [search], execute }));
		expect(execute).toHaveBeenCalledExactlyOnceWith('tool_search', {}, 'discover');
		expect(result.toolCalls[1].status).toBe('failed');
		expect(JSON.stringify(result.toolCalls[1].result)).toContain(
			'discovered after the current request',
		);
	});

	it('exposes deferred tools only after tool_search and translates provider-safe names back to host names', async () => {
		const deferred = {
			...shell,
			name: 'mcp.server.run_task',
			source: 'mcp' as const,
			deferred: true,
		};
		const alias = toolApiName(deferred.name);
		const execute = vi.fn(async (name: string) =>
			name === 'tool_search'
				? {
						content: [{ type: 'text' as const, text: 'Found a tool' }],
						discoveredTools: [deferred],
					}
				: ok,
		);
		const { desktop } = bridge((_request, _emit, turn) =>
			json({
				output:
					turn === 0
						? [call('search', 'tool_search', '{}')]
						: turn === 1
							? [call('run', alias)]
							: [message('Done')],
			}),
		);
		const result = await streamAgentChat(options({ tools: [search, deferred], execute }));
		expect(desktop.request.mock.calls[0][0].body!.tools).toHaveLength(1);
		expect(desktop.request.mock.calls[1][0].body!.tools).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: alias })]),
		);
		expect(execute).toHaveBeenLastCalledWith(deferred.name, { cmd: 'pwd' }, 'run');
		expect(result.toolCalls[1].name).toBe(deferred.name);
	});

	it('does not execute a hidden tool or accept discovery from an unrelated tool', async () => {
		const deferred = { ...shell, name: 'hidden', deferred: true };
		const execute = vi.fn(async () => ({ ...ok, discoveredTools: [deferred] }));
		const { desktop } = bridge((_request, _emit, turn) =>
			json({
				output:
					turn === 0
						? [call('first')]
						: turn === 1
							? [call('hidden', 'hidden')]
							: [message('Stopped')],
			}),
		);
		const result = await streamAgentChat(options({ tools: [shell, deferred], execute }));
		expect(execute).toHaveBeenCalledTimes(1);
		expect(result.toolCalls[1].status).toBe('failed');
		expect(desktop.request.mock.calls[1][0].body!.tools).toHaveLength(1);
	});

	it('keeps dotted, underscored, and long names distinct and rejects a deliberate alias collision', async () => {
		expect(toolApiName('mcp.foo')).not.toBe(toolApiName('mcp_foo'));
		expect(toolApiName('x'.repeat(100))).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
		expect(toolApiName('x'.repeat(100))).not.toBe(toolApiName('x'.repeat(101)));
		await expect(
			streamAgentChat(
				options({
					tools: [
						{ ...shell, name: 'a.b' },
						{ ...shell, name: toolApiName('a.b') },
					],
				}),
			),
		).rejects.toThrow('same API name');
	});

	it.each(['responses', 'chat'] as const)(
		'replays only matching %s transcript items, including assistant turns without plain content',
		async (api) => {
			const transcriptItems: Record<string, unknown>[] =
				api === 'responses'
					? [
							call('old'),
							{ type: 'function_call_output', call_id: 'old', output: 'Previous result' },
							message('Prior final'),
						]
					: [
							{
								role: 'assistant',
								content: null,
								tool_calls: [
									{
										id: 'old',
										type: 'function',
										function: { name: 'exec_command', arguments: '{}' },
									},
								],
							},
							{ role: 'tool', tool_call_id: 'old', content: 'Previous result' },
						];
			const { desktop } = bridge(() =>
				api === 'responses'
					? json({ output: [message('Next')] })
					: json({ choices: [{ message: { content: 'Next' } }] }),
			);
			const past: Message = {
				id: 'past',
				role: 'assistant',
				content: '',
				createdAt: 2,
				agentTranscript: { api, items: transcriptItems },
			};
			const mismatched: Message = {
				id: 'mismatch',
				role: 'assistant',
				content: 'Plain history',
				createdAt: 3,
				agentTranscript: {
					api: api === 'responses' ? 'chat' : 'responses',
					items: [{ secret_mismatched_item: true }],
				},
			};
			const result = await streamAgentChat(
				options({
					connection: { ...connection, chatApi: api },
					history: [...history, past, mismatched],
				}),
			);
			const body = desktop.request.mock.calls[0][0].body!;
			expect(body[api === 'responses' ? 'input' : 'messages']).toEqual(
				expect.arrayContaining(transcriptItems),
			);
			expect(JSON.stringify(body)).not.toContain('secret_mismatched_item');
			expect(JSON.stringify(body)).toContain('Plain history');
			expect(result.transcript.items).toHaveLength(1);
		},
	);

	it('falls back to nonstreaming only on an explicit provider rejection of streaming', async () => {
		const { desktop } = bridge((_request, _emit, turn) =>
			turn
				? json({ output: [message('Nonstreamed')] })
				: json({ error: { message: 'Streaming is not supported' } }, 400),
		);
		expect((await streamAgentChat(options())).content).toBe('Nonstreamed');
		expect(desktop.request.mock.calls[1][0].body!.stream).toBe(false);
		const second = bridge(() => json({ error: { message: 'Model failed' } }, 500));
		await expect(streamAgentChat(options())).rejects.toThrow('API 500');
		expect(second.desktop.request).toHaveBeenCalledTimes(1);
	});

	it.each(['responses', 'chat'] as const)(
		'cancels pending execution and leaves a replayable %s transcript',
		async (api) => {
			const controller = new AbortController();
			let latest: AgentUpdate | undefined;
			const execute = vi.fn(async () => {
				queueMicrotask(() => controller.abort());
				return new Promise<ToolResult>(() => {});
			});
			bridge(() =>
				api === 'responses'
					? json({ output: [call('a'), call('b')] })
					: json({
							choices: [
								{
									message: {
										tool_calls: ['a', 'b'].map((id) => ({
											id,
											function: { name: 'exec_command', arguments: '{}' },
										})),
									},
								},
							],
						}),
			);
			await expect(
				streamAgentChat(
					options({
						connection: { ...connection, chatApi: api },
						signal: controller.signal,
						execute,
						onUpdate: (update) => {
							latest = update;
						},
					}),
				),
			).rejects.toMatchObject({ name: 'AbortError' });
			expect(execute).toHaveBeenCalledTimes(1);
			expect(latest!.toolCalls.map((item) => item.status)).toEqual(['failed', 'failed']);
			expect(latest!.activityFinishedAt).toBeUndefined();
			expect(
				latest!.transcript.items.filter((item) =>
					api === 'responses' ? item.type === 'function_call_output' : item.role === 'tool',
				),
			).toHaveLength(2);
		},
	);

	it('bounds individual tool output while preserving the completed tool result', async () => {
		let latest: AgentUpdate | undefined;
		bridge((_request, _emit, turn) => json({ output: turn ? [message('Done')] : [call('loop')] }));
		await streamAgentChat(
			options({
				execute: async () => ({ content: [{ type: 'text', text: 'x'.repeat(200000) }] }),
				onUpdate: (update) => {
					latest = update;
				},
			}),
		);
		const result = latest!.toolCalls[0].result!;
		expect(JSON.stringify(result).length).toBeLessThan(66000);
		expect(JSON.stringify(result)).toContain('truncated');
		expect(latest!.transcript.items.some((item) => item.type === 'function_call_output')).toBe(
			true,
		);
	});
});

describe('generated image context', () => {
	const imageTool: ToolDefinition = {
		name: 'image_gen.imagegen',
		description: 'Generate an image',
		parameters: { type: 'object' },
		source: 'builtin',
	};
	const original = `data:image/png;base64,${'A'.repeat(2 * 1024 * 1024)}`;
	const preview = 'data:image/jpeg;base64,cHJldmlldw==';
	const toolCall = (id: string) =>
		call(id, toolApiName(imageTool.name), '{"prompt":"A penguin eating ice cream"}');
	function protocolRound(api: string, calls: ReturnType<typeof call>[], text?: string) {
		return api === 'responses'
			? { output: text ? [message(text)] : calls }
			: {
					choices: [
						{
							message: text
								? { content: text }
								: {
										content: null,
										tool_calls: calls.map((call) => ({
											id: call.call_id,
											type: 'function',
											function: { name: call.name, arguments: call.arguments },
										})),
									},
							finish_reason: text ? 'stop' : 'tool_calls',
						},
					],
				};
	}
	for (const chatApi of ['responses', 'chat/completions'] as const) {
		it(`keeps the generated original and user attachments while sending a preview in ${chatApi}`, async () => {
			const uploaded = `data:image/png;base64,${'B'.repeat(2 * 1024 * 1024)}`;
			const prepare = vi.spyOn(imageContext, 'generatedImageContext').mockResolvedValue(preview);
			const { desktop } = bridge((_request, _emit, turn) =>
				json(protocolRound(chatApi, [toolCall('generated')], turn ? 'Ready' : undefined)),
			);
			const result = await streamAgentChat(
				options({
					connection: { ...connection, chatApi },
					history: [
						{
							...history[0],
							attachments: [{ name: 'upload.png', type: 'image/png', dataUrl: uploaded }],
						},
					],
					tools: [imageTool],
					execute: async () => ({ content: [{ type: 'image', dataUrl: original }] }),
				}),
			);
			const request = JSON.stringify(desktop.request.mock.calls[1][0].body);
			expect(request).toContain(uploaded);
			expect(request).toContain(preview);
			expect(request).not.toContain(original);
			expect(request).toContain('Full-resolution originals remain available');
			expect(result.toolCalls[0].result?.content).toEqual([{ type: 'image', dataUrl: original }]);
			expect(prepare).toHaveBeenCalledExactlyOnceWith(original, undefined);
			expect(JSON.stringify(result.transcript)).not.toContain(original);
		});

		it(`compacts legacy generated images by call identity without changing other tool images in ${chatApi}`, async () => {
			const prepare = vi.spyOn(imageContext, 'generatedImageContext').mockResolvedValue(preview);
			const output = (id: string) => ({
				type: 'function_call_output',
				call_id: id,
				output: [{ type: 'input_image', image_url: original, detail: 'auto' }],
			});
			const chatImage = (id: string, name: string) => ({
				role: 'user',
				content: [
					{ type: 'text', text: `Images returned by tool call ${id} (${name}).` },
					{ type: 'image_url', image_url: { url: original } },
				],
			});
			const legacy: Message = {
				id: 'legacy',
				role: 'assistant',
				content: 'Images ready',
				createdAt: 2,
				agentTranscript: {
					api: chatApi === 'responses' ? 'responses' : 'chat',
					items:
						chatApi === 'responses'
							? [toolCall('generated'), call('other'), output('generated'), output('other')]
							: [
									(protocolRound(chatApi, [toolCall('generated'), call('other')]) as any).choices[0]
										.message,
									{ role: 'tool', tool_call_id: 'generated', content: 'Generated' },
									{ role: 'tool', tool_call_id: 'other', content: 'Other' },
									chatImage('generated', imageTool.name),
									chatImage('other', 'exec_command'),
								],
				},
			};
			// The Chat message returned by the provider has an implicit assistant role.
			if (chatApi !== 'responses') legacy.agentTranscript!.items[0].role = 'assistant';
			const before = JSON.stringify(legacy);
			const { desktop } = bridge(() => json(protocolRound(chatApi, [], 'Ready')));
			await streamAgentChat(
				options({
					connection: { ...connection, chatApi },
					history: [history[0], legacy, { ...history[0], id: 'next' }],
				}),
			);
			const request = JSON.stringify(desktop.request.mock.calls[0][0].body);
			expect(request.split(original)).toHaveLength(2);
			expect(request.split(preview)).toHaveLength(2);
			expect(prepare).toHaveBeenCalledExactlyOnceWith(original, undefined);
			expect(JSON.stringify(legacy)).toBe(before);
		});

		it(`reports an unavailable preview instead of uploading an oversized undecodable original in ${chatApi}`, async () => {
			vi.spyOn(imageContext, 'generatedImageContext').mockResolvedValue(undefined);
			const { desktop } = bridge((_request, _emit, turn) =>
				json(protocolRound(chatApi, [toolCall('generated')], turn ? 'Ready' : undefined)),
			);
			const result = await streamAgentChat(
				options({
					connection: { ...connection, chatApi },
					tools: [imageTool],
					execute: async () => ({ content: [{ type: 'image', dataUrl: original }] }),
				}),
			);
			const request = JSON.stringify(desktop.request.mock.calls[1][0].body);
			expect(request).not.toContain(original);
			expect(request).toContain('bounded preview could not be decoded');
			expect(request).toContain('Do not claim to have inspected its pixels');
			expect(result.toolCalls[0].status).toBe('completed');
			expect(result.toolCalls[0].result?.content).toEqual([{ type: 'image', dataUrl: original }]);
		});

		it(`preserves a completed image and pairs remaining calls when preview preparation is cancelled in ${chatApi}`, async () => {
			const controller = new AbortController();
			vi.spyOn(imageContext, 'generatedImageContext').mockImplementation(async () => {
				controller.abort();
				throw new DOMException('Cancelled', 'AbortError');
			});
			const { desktop } = bridge(() =>
				json(protocolRound(chatApi, [toolCall('generated'), call('pending')])),
			);
			let latest: AgentUpdate | undefined;
			const execute = vi.fn(async () => ({
				content: [{ type: 'image' as const, dataUrl: original }],
			}));
			await expect(
				streamAgentChat(
					options({
						connection: { ...connection, chatApi },
						signal: controller.signal,
						tools: [imageTool, shell],
						execute,
						onUpdate: (update) => {
							latest = update;
						},
					}),
				),
			).rejects.toMatchObject({ name: 'AbortError' });
			expect(desktop.request).toHaveBeenCalledOnce();
			expect(execute).toHaveBeenCalledOnce();
			expect(latest!.toolCalls[0]).toMatchObject({
				status: 'completed',
				result: { content: [{ type: 'image', dataUrl: original }] },
			});
			expect(latest!.toolCalls[1].status).toBe('failed');
			const outputs = latest!.transcript.items.filter((item) =>
				chatApi === 'responses' ? item.type === 'function_call_output' : item.role === 'tool',
			);
			expect(outputs).toHaveLength(2);
			expect(JSON.stringify(outputs)).toContain('Image generation completed');
		});
	}

	it('retains generated originals beyond the generic tool image limit, while keeping other tools bounded', async () => {
		const large = `data:image/png;base64,${'A'.repeat(26 * 1024 * 1024)}`;
		vi.spyOn(imageContext, 'generatedImageContext').mockResolvedValue(preview);
		const { desktop } = bridge((_request, _emit, turn) =>
			json(
				protocolRound(
					'responses',
					[toolCall('generated'), call('other')],
					turn ? 'Ready' : undefined,
				),
			),
		);
		const result = await streamAgentChat(
			options({
				tools: [imageTool, shell],
				execute: async () => ({ content: [{ type: 'image', dataUrl: large }] }),
			}),
		);
		expect(result.toolCalls[0].result?.content[0]).toEqual({ type: 'image', dataUrl: large });
		expect(result.toolCalls[1].result?.content[0]).toMatchObject({
			type: 'text',
			text: expect.stringContaining('size limit'),
		});
		expect(JSON.stringify(desktop.request.mock.calls[1][0].body).length).toBeLessThan(5000);
	});

	it('bounds retained generated originals across the whole run', async () => {
		const large = `data:image/png;base64,${'A'.repeat(26 * 1024 * 1024)}`;
		vi.spyOn(imageContext, 'generatedImageContext').mockResolvedValue(preview);
		bridge((_request, _emit, turn) =>
			json(
				protocolRound(
					'responses',
					['one', 'two', 'three', 'four'].map(toolCall),
					turn ? 'Ready' : undefined,
				),
			),
		);
		const result = await streamAgentChat(
			options({
				tools: [imageTool],
				execute: async () => ({ content: [{ type: 'image', dataUrl: large }] }),
			}),
		);
		expect(
			result.toolCalls.slice(0, 3).every((call) => call.result?.content[0].type === 'image'),
		).toBe(true);
		expect(result.toolCalls[3].result?.content[0]).toMatchObject({
			type: 'text',
			text: expect.stringContaining('size limit'),
		});
	});
});

describe('generated video context', () => {
	it.each(['responses', 'chat/completions'] as const)(
		'keeps a large playable video outside the %s model context',
		async (chatApi) => {
			const videoTool: ToolDefinition = {
				name: 'video_gen.videogen',
				description: 'Generate a video',
				parameters: { type: 'object' },
				source: 'builtin',
			};
			const video = {
				type: 'file' as const,
				dataUrl: `data:video/mp4;base64,${'A'.repeat(13_000_000)}`,
				mimeType: 'video/mp4',
				name: 'generated.mp4',
			};
			const { desktop } = bridge((_request, _emit, turn) =>
				json(
					chatApi === 'responses'
						? {
								output: turn
									? [message('Ready')]
									: [call('video', toolApiName(videoTool.name), '{"prompt":"waves"}')],
							}
						: {
								choices: [
									{
										message: turn
											? { content: 'Ready' }
											: {
													content: null,
													tool_calls: [
														{
															id: 'video',
															type: 'function',
															function: {
																name: toolApiName(videoTool.name),
																arguments: '{"prompt":"waves"}',
															},
														},
													],
												},
										finish_reason: turn ? 'stop' : 'tool_calls',
									},
								],
							},
				),
			);
			const result = await streamAgentChat(
				options({
					connection: { ...connection, chatApi },
					tools: [videoTool],
					execute: async () => ({ content: [video] }),
				}),
			);
			expect(result.toolCalls[0].result?.content).toContainEqual(video);
			const request = JSON.stringify(desktop.request.mock.calls[1][0].body);
			expect(request).toContain('Created file: generated.mp4 (video/mp4). Available for download.');
			expect(request).not.toContain(video.dataUrl);
			expect(JSON.stringify(result.transcript)).not.toContain(video.dataUrl);
		},
	);
});
