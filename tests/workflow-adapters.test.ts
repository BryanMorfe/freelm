import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentHost } from '../electron/agent-host';
import { createWorkflowAdapters } from '../electron/workflows/adapters';
import { initialState } from '../src/lib/state';
import { defaultToolSettings } from '../src/lib/tool-settings';
import { toolApiName } from '../src/lib/agent';
import type { WireRequest, WireResponse } from '../src/types';
import type { ToolApproval } from '../src/agent-types';
import type {
	WorkflowDefinition,
	WorkflowExecutionContext,
	WorkflowNode,
	WorkflowRun,
} from '../src/workflow-types';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});
const response = (value: unknown): WireResponse => ({
	status: 200,
	contentType: 'application/json',
	encoding: 'text',
	body: JSON.stringify(value),
});
const completion = (content: string, calls?: { name: string; arguments: string }[]): WireResponse =>
	response({
		choices: [
			{
				finish_reason: calls ? 'tool_calls' : 'stop',
				message: {
					role: 'assistant',
					content,
					...(calls
						? {
								tool_calls: calls.map((call, i) => ({
									id: `call-${i}-${crypto.randomUUID()}`,
									type: 'function',
									function: { ...call, name: toolApiName(call.name) },
								})),
							}
						: {}),
				},
			},
		],
	});
const png =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const node = (type: WorkflowNode['type'], config: Record<string, unknown> = {}): WorkflowNode => ({
	id: 'node',
	type,
	label: type,
	config,
	position: { x: 0, y: 0 },
});
async function fixture(withKnowledge = false) {
	const directory = await mkdtemp(path.join(tmpdir(), 'freelm-workflow-adapter-'));
	cleanups.push(() => rm(directory, { recursive: true, force: true }));
	const current = initialState();
	current.connections = [
		{
			id: 'api',
			name: 'Test API',
			baseUrl: 'https://provider.invalid/v1',
			apiKey: 'test-secret',
			chatApi: 'chat/completions',
			models: {
				chat: 'model',
				images: 'image',
				videos: 'video',
				speech: 'speech',
				transcription: 'transcribe',
			},
			discoveredModels: [],
			catalog: ['model', 'image', 'video', 'speech', 'transcribe'].map((id, index) => ({
				id,
				name: id,
				enabled: true,
				tasks: [['chat'], ['images'], ['videos'], ['speech'], ['transcription']][index] as any,
				inputModalities: ['text', 'image', 'audio'],
				outputModalities: ['text'],
				thinkingModes: [
					{
						id: 'none',
						name: 'None',
						parameters: {
							chat: { reasoning_effort: 'none' },
							responses: { reasoning: { effort: 'none' } },
						},
					},
				],
				defaultThinkingMode: 'none',
			})),
		},
	];
	current.activeConnectionId = 'api';
	current.threads = [];
	current.toolSettings = {
		...defaultToolSettings(),
		enabled: true,
		workspaceRoot: directory,
		approvalMode: 'full-access',
	};
	const request = vi.fn(
		async (
			_request: WireRequest,
			_onChunk: (text: string) => void = () => {},
		): Promise<WireResponse> => completion('done'),
	);
	const approve = vi.fn(async (_approval: ToolApproval, _signal: AbortSignal) => false);
	const task = vi.fn(
		async (
			_name: string,
			_args: Record<string, unknown>,
			_operationId: string,
			_signal: AbortSignal,
		) => ({ threadId: 'created', status: 'started' }),
	);
	const notify = vi.fn();
	const adapters = createWorkflowAdapters({
		loadState: async () => current,
		request,
		createAgentHost: (load) =>
			new AgentHost(
				load,
				approve,
				undefined,
				undefined,
				undefined,
				withKnowledge ? path.join(directory, 'knowledge') : undefined,
				withKnowledge
					? async (id) => {
							const thread = (await load())?.threads.find((item) => item.id === id);
							if (!thread) throw new Error('Test workflow thread unavailable.');
							return thread;
						}
					: undefined,
			),
		task,
		notify,
		artifactDirectory: path.join(directory, 'assets'),
	});
	cleanups.push(() => adapters.close());
	const workflow: WorkflowDefinition = {
		version: 1,
		id: 'workflow',
		name: 'Test workflow',
		enabled: true,
		nodes: [],
		edges: [],
		createdAt: 1,
		updatedAt: 1,
		settings: { workspaceRoot: directory },
	};
	const run: WorkflowRun = {
		id: 'run',
		workflowId: workflow.id,
		workflowName: workflow.name,
		workflowSnapshot: workflow,
		nodes: {},
		status: 'running',
		inputs: {},
		trigger: { kind: 'manual' },
		createdAt: 1,
	};
	const context: WorkflowExecutionContext = { run, workflow, signal: new AbortController().signal };
	return { adapters, directory, current, request, approve, task, notify, context };
}

describe('native workflow adapters', () => {
	it.each(['chat/completions', 'responses'] as const)(
		'keeps repository, memory and selected skill bodies as user context across %s agent rounds',
		async (api) => {
			const f = await fixture(true);
			f.approve.mockResolvedValue(true);
			f.current.connections[0].chatApi = api;
			await writeFile(path.join(f.directory, 'AGENTS.md'), 'REPOSITORY_CONTEXT_SENTINEL');
			await writeFile(path.join(f.directory, 'MEMORY.md'), 'MEMORY_CONTEXT_SENTINEL');
			const skillDirectory = path.join(f.directory, 'skills');
			await mkdir(path.join(skillDirectory, 'selected'), { recursive: true });
			await mkdir(path.join(skillDirectory, 'unselected'));
			await writeFile(
				path.join(skillDirectory, 'selected', 'SKILL.md'),
				'---\nname: Selected skill\ndescription: Read source evidence.\n---\nSELECTED_SKILL_CONTEXT_SENTINEL',
			);
			await writeFile(
				path.join(skillDirectory, 'unselected', 'SKILL.md'),
				'---\nname: Unselected skill\ndescription: Another capability.\n---\nUNSELECTED_SKILL_CONTEXT_SENTINEL',
			);
			f.current.toolSettings!.skillDirectories = [skillDirectory];
			let round = 0;
			f.request.mockImplementation(async () => {
				const first = ++round === 1;
				return api === 'responses'
					? response({
							status: 'completed',
							output: first
								? [
										{
											type: 'function_call',
											call_id: 'clock',
											name: toolApiName('clock.curr_time'),
											arguments: '{}',
										},
									]
								: [
										{
											type: 'message',
											role: 'assistant',
											content: [{ type: 'output_text', text: 'Completed.' }],
										},
									],
						})
					: first
						? completion('', [{ name: 'clock.curr_time', arguments: '{}' }])
						: completion('Completed.');
			});
			await f.adapters.execute(
				node('agent', {
					prompt: 'Check the time and answer.',
					instructions: 'NODE_POLICY_SENTINEL',
					tools: ['clock.curr_time'],
					skills: ['Selected skill'],
				}),
				{},
				f.context,
			);
			expect(f.request).toHaveBeenCalledTimes(2);
			for (const [request] of f.request.mock.calls) {
				const body = request.body as Record<string, any>;
				const messages = api === 'responses' ? body.input : body.messages;
				const instructions =
					api === 'responses'
						? body.instructions
						: messages
								.filter((message: any) => message.role === 'system')
								.map((message: any) => message.content)
								.join('\n');
				const userContext = JSON.stringify(
					messages.filter((message: any) => message.role === 'user'),
				);
				for (const sentinel of [
					'REPOSITORY_CONTEXT_SENTINEL',
					'MEMORY_CONTEXT_SENTINEL',
					'SELECTED_SKILL_CONTEXT_SENTINEL',
				]) {
					expect(instructions).not.toContain(sentinel);
					expect(userContext.split(sentinel)).toHaveLength(2);
				}
				expect(userContext).toContain('AGENTS.md');
				expect(userContext).toContain('MEMORY.md');
				expect(userContext).toContain('Selected workflow skill Selected skill');
				expect(JSON.stringify(body)).not.toContain('UNSELECTED_SKILL_CONTEXT_SENTINEL');
				expect(instructions).toContain('NODE_POLICY_SENTINEL');
				expect(instructions).not.toContain('Code working principles');
				expect(
					body.tools
						.map((tool: any) => (api === 'responses' ? tool.name : tool.function.name))
						.sort(),
				).toEqual(['clock.curr_time', 'skills.read', 'skills.list'].map(toolApiName).sort());
			}
		},
	);

	it('keeps bound thread actions and conversation context inside the owning project', async () => {
		const { adapters, current, task, context, directory } = await fixture();
		const project = {
			id: 'novis',
			name: 'Novis',
			directories: [directory],
			instructions: '',
			createdAt: 1,
		};
		current.projects = [project];
		current.threads = [
			{
				id: 'elsewhere',
				projectId: 'other',
				title: 'Other',
				kind: 'code',
				connectionId: 'api',
				model: 'model',
				messages: [],
				createdAt: 1,
				updatedAt: 1,
			},
		];
		context.run.projectContext = project;
		context.run.projectId = project.id;
		for (const action of ['read', 'send', 'rename', 'stop', 'archive']) {
			await expect(
				adapters.execute(node('thread', { action, threadId: 'elsewhere' }), {}, context),
			).rejects.toThrow(/only threads in its project/);
		}
		await expect(
			adapters.execute(
				node('thread', { action: 'wait' }),
				{ targets: [{ threadId: 'elsewhere' }] },
				context,
			),
		).rejects.toThrow(/only threads in its project/);
		await expect(
			adapters.execute(node('context', { source: 'thread', threadId: 'elsewhere' }), {}, context),
		).rejects.toThrow(/only threads in its project/);
		expect(task).not.toHaveBeenCalled();
		await adapters.execute(
			node('thread', { action: 'create', prompt: 'Continue research' }),
			{ projectId: 'other' },
			context,
		);
		expect(task.mock.calls[0][1]).toMatchObject({ projectId: 'novis' });
	});

	it('uses pinned project instructions and directories for text and tool-enabled agents', async () => {
		const { adapters, current, request, context, directory } = await fixture();
		const project = {
			id: 'novis',
			name: 'Novis',
			directories: [directory],
			instructions: 'Compare memory systems and record uncertainty.',
			createdAt: 1,
		};
		current.projects = [project];
		context.run.projectContext = { ...project, instructions: 'Pinned project instructions.' };
		context.run.projectId = project.id;
		await adapters.execute(
			node('text', { projectId: project.id, prompt: 'Investigate this.' }),
			{},
			context,
		);
		const textBody = request.mock.calls[0][0].body as {
			messages: { role: string; content: string }[];
		};
		expect(textBody.messages[0].content).toContain('Pinned project instructions.');
		await adapters.execute(
			node('agent', { projectId: project.id, prompt: 'Investigate this.', tools: [] }),
			{},
			context,
		);
		expect(JSON.stringify(request.mock.calls.at(-1)?.[0].body)).toContain(
			'Pinned project instructions.',
		);
		expect(JSON.stringify(request.mock.calls.at(-1)?.[0].body)).toContain(directory);
		current.projects = [];
		await expect(
			adapters.execute(node('text', { prompt: 'No fallback' }), {}, context),
		).rejects.toThrow(/project no longer exists/);
	});

	it('sends one structured multimodal inference through the host transport with connected context', async () => {
		const f = await fixture();
		f.request.mockResolvedValue(completion('{"answer":42}'));
		const output = await f.adapters.execute(
			node('text', {
				prompt: 'Use this evidence',
				responseFormat: 'json',
				schema: {
					type: 'object',
					properties: { answer: { type: 'integer' } },
					required: ['answer'],
					additionalProperties: false,
				},
			}),
			{
				prompt: 'What is shown?',
				context: 'Background facts',
				images: [{ name: 'image.png', type: 'image/png', dataUrl: `data:image/png;base64,${png}` }],
			},
			f.context,
		);
		expect(output.value).toEqual({ answer: 42 });
		expect(f.request).toHaveBeenCalledTimes(1);
		const sent = f.request.mock.calls[0][0];
		expect(sent.workspaceId).toBe('local');
		expect(sent.apiKey).toBe('test-secret');
		expect(sent.body?.response_format).toMatchObject({ type: 'json_schema' });
		expect(JSON.stringify(sent.body)).toContain('Use this evidence');
		expect(JSON.stringify(sent.body)).toContain('Background facts');
		expect(JSON.stringify(sent.body)).toContain('image_url');
	});
	it('does not accept invalid structured output as a completed value', async () => {
		const f = await fixture();
		f.request.mockResolvedValue(completion('not JSON'));
		await expect(
			f.adapters.execute(
				node('text', { prompt: 'Return JSON', responseFormat: 'json' }),
				{},
				f.context,
			),
		).rejects.toThrow();
	});
	it.each(['text', 'agent'] as const)(
		'validates %s schema locally even when the provider ignores strict format',
		async (type) => {
			const f = await fixture();
			f.request.mockResolvedValue(completion('{"score":"high"}'));
			await expect(
				f.adapters.execute(
					node(type, {
						prompt: 'Score the result',
						responseFormat: 'json',
						validationRetries: 0,
						schema: {
							type: 'object',
							properties: { score: { type: 'integer' } },
							required: ['score'],
							additionalProperties: false,
						},
					}),
					{},
					f.context,
				),
			).rejects.toThrow('must be integer');
			expect(f.request).toHaveBeenCalledTimes(1);
		},
	);
	it.each(['text', 'agent'] as const)(
		'repairs malformed %s output through bounded tool-free requests',
		async (type) => {
			const f = await fixture();
			f.request
				.mockResolvedValueOnce(completion('not JSON'))
				.mockResolvedValueOnce(completion('{"score":"bad"}'))
				.mockResolvedValueOnce(completion('{"score":8}'));
			const output = await f.adapters.execute(
				node(type, {
					prompt: 'Score the result',
					responseFormat: 'json',
					validationRetries: 2,
					schema: {
						type: 'object',
						properties: { score: { type: 'integer' } },
						required: ['score'],
						additionalProperties: false,
					},
				}),
				{},
				f.context,
			);
			expect(output).toMatchObject({
				value: { score: 8 },
				json: { score: 8 },
				text: '{"score":8}',
				validationAttempts: 3,
			});
			expect(f.request).toHaveBeenCalledTimes(3);
			for (const [request] of f.request.mock.calls.slice(1)) {
				expect(request.body?.tools).toBeUndefined();
				expect(request.body?.stream).toBe(false);
				expect(request.body?.response_format).toMatchObject({
					type: 'json_schema',
					json_schema: { strict: true },
				});
			}
		},
	);
	it('validates only the final agent response and never repeats executed tools during correction', async () => {
		const f = await fixture();
		const execute = vi.spyOn(AgentHost.prototype, 'execute');
		f.request
			.mockResolvedValueOnce(
				completion('I will check the time first.', [{ name: 'clock.curr_time', arguments: '{}' }]),
			)
			.mockResolvedValueOnce(completion('{"answer": "wrong type"}'))
			.mockResolvedValueOnce(completion('{"answer": 42}'));
		const output = await f.adapters.execute(
			node('agent', {
				prompt: 'Return the answer after checking the clock',
				tools: ['clock.curr_time'],
				responseFormat: 'json',
				schema: {
					type: 'object',
					properties: { answer: { type: 'integer' } },
					required: ['answer'],
					additionalProperties: false,
				},
			}),
			{},
			f.context,
		);
		expect(output.value).toEqual({ answer: 42 });
		expect(output.result).toEqual({ answer: 42 });
		expect(output.text).not.toContain('I will check');
		expect(
			execute.mock.calls.filter(([request]) => request.name === 'clock.curr_time'),
		).toHaveLength(1);
		expect(f.request.mock.calls[2][0].body?.tools).toBeUndefined();
		expect(JSON.stringify(f.request.mock.calls[2][0].body)).toContain('clock.curr_time');
	});
	it.each(['text', 'agent'] as const)(
		'enforces the Responses API format for %s and returns parsed nested data',
		async (type) => {
			const f = await fixture();
			f.current.connections[0].chatApi = 'responses';
			f.request.mockResolvedValue(
				response({
					output: [
						{
							type: 'message',
							role: 'assistant',
							content: [{ type: 'output_text', text: '{"findings":[{"score":8}]}' }],
						},
					],
				}),
			);
			const schema = {
				type: 'object',
				properties: {
					findings: {
						type: 'array',
						items: {
							type: 'object',
							properties: { score: { type: 'integer' } },
							required: ['score'],
							additionalProperties: false,
						},
					},
				},
				required: ['findings'],
				additionalProperties: false,
			};
			const output = await f.adapters.execute(
				node(type, { prompt: 'Return findings', responseFormat: 'json', schema }),
				{},
				f.context,
			);
			expect(output.json).toEqual({ findings: [{ score: 8 }] });
			expect(f.request.mock.calls[0][0].body?.text).toEqual({
				format: { type: 'json_schema', name: 'workflow_output', strict: true, schema },
			});
			expect(f.request.mock.calls[0][0].body?.response_format).toBeUndefined();
		},
	);
	it('fails invalid agent schemas before model requests or any tools', async () => {
		const f = await fixture();
		const execute = vi.spyOn(AgentHost.prototype, 'execute');
		await expect(
			f.adapters.execute(
				node('agent', { prompt: 'Act', tools: ['clock.curr_time'], schema: { type: 'invalid' } }),
				{},
				f.context,
			),
		).rejects.toThrow('Invalid output schema');
		expect(f.request).not.toHaveBeenCalled();
		expect(execute).not.toHaveBeenCalled();
	});
	it('keeps Responses streaming tool rounds valid while only validating the final JSON', async () => {
		const f = await fixture();
		f.current.connections[0].chatApi = 'responses';
		const execute = vi.spyOn(AgentHost.prototype, 'execute');
		let round = 0;
		f.request.mockImplementation(async (_request, onChunk) => {
			const first = round++ === 0;
			const content = first ? 'Looking at the clock.' : '{"done":true}';
			const output = [
				{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: content }] },
				...(first
					? [
							{
								type: 'function_call',
								call_id: 'clock',
								name: toolApiName('clock.curr_time'),
								arguments: '{}',
							},
						]
					: []),
			];
			for (const event of [
				{ type: 'response.output_text.delta', delta: content },
				{ type: 'response.completed', response: { status: 'completed', output } },
			])
				onChunk?.(`data: ${JSON.stringify(event)}\n\n`);
			return { status: 200, contentType: 'text/event-stream', encoding: 'text', body: '' };
		});
		const output = await f.adapters.execute(
			node('agent', {
				prompt: 'Check clock and finish',
				tools: ['clock.curr_time'],
				responseFormat: 'json',
				validationRetries: 0,
				schema: {
					type: 'object',
					properties: { done: { type: 'boolean' } },
					required: ['done'],
					additionalProperties: false,
				},
			}),
			{},
			f.context,
		);
		expect(output.json).toEqual({ done: true });
		expect(output.validationAttempts).toBe(1);
		expect(output.text).toBe('{"done":true}');
		expect(
			execute.mock.calls.filter(([request]) => request.name === 'clock.curr_time'),
		).toHaveLength(1);
		expect(f.request).toHaveBeenCalledTimes(2);
		for (const [request] of f.request.mock.calls) {
			expect(request.body?.text).toMatchObject({ format: { type: 'json_schema', strict: true } });
			expect(request.body?.tools).toHaveLength(1);
		}
	});
	it('does not bypass provider schema errors or execute tools requested by a correction', async () => {
		const f = await fixture();
		const execute = vi.spyOn(AgentHost.prototype, 'execute');
		f.request
			.mockResolvedValueOnce(completion('bad JSON'))
			.mockResolvedValueOnce(completion('', [{ name: 'clock.curr_time', arguments: '{}' }]));
		await expect(
			f.adapters.execute(
				node('agent', {
					prompt: 'Act',
					tools: ['clock.curr_time'],
					responseFormat: 'json',
					validationRetries: 2,
				}),
				{},
				f.context,
			),
		).rejects.toThrow('Inference stopped: tool_calls');
		expect(execute).not.toHaveBeenCalled();
		expect(f.request).toHaveBeenCalledTimes(2);
		f.request.mockClear();
		f.request.mockResolvedValue({
			status: 400,
			contentType: 'application/json',
			encoding: 'text',
			body: '{"error":"schema unsupported"}',
		});
		await expect(
			f.adapters.execute(node('agent', { prompt: 'Act', responseFormat: 'json' }), {}, f.context),
		).rejects.toThrow('schema unsupported');
		expect(f.request).toHaveBeenCalledTimes(1);
	});
	it('lets an agent finish after more than twenty tool rounds without writing a chat', async () => {
		const f = await fixture();
		let round = 0;
		f.request.mockImplementation(async () =>
			++round <= 24
				? completion('', [{ name: 'clock.curr_time', arguments: '{}' }])
				: completion('Finished after 24 actions'),
		);
		const output = await f.adapters.execute(
			node('agent', { prompt: 'Finish the task', tools: ['clock.curr_time'] }),
			{},
			f.context,
		);
		expect(output.text).toBe('Finished after 24 actions');
		expect(round).toBe(25);
		expect(f.current.threads).toEqual([]);
		expect(f.approve).not.toHaveBeenCalled();
	});
	it('keeps explicit tool actions on ask permissions even when global settings grant full access', async () => {
		const f = await fixture();
		await writeFile(path.join(f.directory, 'file.txt'), 'private');
		await expect(
			f.adapters.execute(
				node('tool', { tool: 'exec_command', arguments: { cmd: 'cat file.txt' } }),
				{},
				f.context,
			),
		).rejects.toThrow(/declined/);
		expect(f.approve).toHaveBeenCalled();
		expect(f.approve.mock.calls[0]?.[0]).toMatchObject({ permissionMode: 'ask' });
		expect(f.current.threads).toEqual([]);
	});
	it('does not execute tools the model calls outside its saved allowlist', async () => {
		const f = await fixture();
		let round = 0;
		f.request.mockImplementation(async () =>
			++round === 1
				? completion('', [{ name: 'read_file', arguments: '{"path":"file.txt"}' }])
				: completion('Unavailable tool'),
		);
		const output = await f.adapters.execute(
			node('agent', { prompt: 'Read nothing', tools: ['clock.curr_time'] }),
			{},
			f.context,
		);
		expect(output.text).toBe('Unavailable tool');
		expect(f.approve).not.toHaveBeenCalled();
	});
	it('exports connected input, refuses traversal/symlinks, and refuses accidental overwrite', async () => {
		const f = await fixture();
		const output = await f.adapters.execute(
			node('save', { path: 'out/result.txt', format: 'text' }),
			{ input: 'Actual connected text' },
			f.context,
		);
		expect(await readFile(String(output.path), 'utf8')).toBe('Actual connected text');
		await expect(
			f.adapters.execute(
				node('save', { path: 'out/result.txt', format: 'text' }),
				{ input: 'replacement' },
				f.context,
			),
		).rejects.toThrow();
		await expect(
			f.adapters.execute(node('save', { path: '../outside.txt' }), { input: 'x' }, f.context),
		).rejects.toThrow(/escapes/);
		await symlink(tmpdir(), path.join(f.directory, 'link'));
		await expect(
			f.adapters.execute(node('save', { path: 'link/out.txt' }), { input: 'x' }, f.context),
		).rejects.toThrow(/Symbolic/);
	});
	it('routes explicit thread actions through the renderer owner and preserves operation identity', async () => {
		const f = await fixture();
		const output = await f.adapters.execute(
			node('thread', { action: 'create', title: 'Created by workflow' }),
			{ prompt: 'Do the requested task' },
			f.context,
		);
		expect(output.threadId).toBe('created');
		expect(f.task).toHaveBeenCalledWith(
			'threads_create',
			expect.objectContaining({ prompt: 'Do the requested task', kind: 'chat' }),
			'run:node:create',
			expect.any(AbortSignal),
		);
	});
	it('honors cancellation before dispatch and delivers connected notification text', async () => {
		const f = await fixture();
		await f.adapters.execute(
			node('notify', { message: '' }),
			{ text: 'Completed output' },
			f.context,
		);
		expect(f.notify).toHaveBeenCalledWith('Test workflow', 'Completed output');
		await expect(
			f.adapters.execute(
				node('text', { prompt: 'Never dispatched' }),
				{},
				{ ...f.context, signal: AbortSignal.abort() },
			),
		).rejects.toThrow();
		expect(f.request).not.toHaveBeenCalled();
	});
	it('waits through thread timeouts and human attention before publishing completion', async () => {
		const f = await fixture();
		let call = 0;
		f.task.mockImplementation(
			async () =>
				({
					polls: [
						{
							id: 'created',
							status: ++call === 1 ? 'working' : call === 2 ? 'waiting_for_approval' : 'completed',
							cursor: `cursor-${call}`,
							...(call === 3 ? { answer: 'Done' } : {}),
						},
					],
					timedOut: call === 1,
				}) as any,
		);
		const output = await f.adapters.execute(
			node('thread', { action: 'wait', timeoutMs: 0 }),
			{ input: { threadId: 'created' } },
			f.context,
		);
		expect(call).toBe(3);
		expect(output.value).toMatchObject({
			polls: [{ status: 'completed', answer: 'Done' }],
			timedOut: false,
		});
		expect(f.task.mock.calls[1]?.[1]).toMatchObject({
			targets: [{ threadId: 'created', afterCursor: 'cursor-1' }],
		});
	});
});
