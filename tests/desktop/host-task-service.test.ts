import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HostTaskService, type HostTaskServiceOptions } from '../../electron/host-task-service';
import { WorkspaceAuthority } from '../../electron/workspace-authority';
import { StateStore } from '../../electron/state-store';
import { AgentHost } from '../../electron/agent-host';
import { initialState } from '../../src/lib/state';
import { botThreadAttachments } from '../../src/lib/bot-thread-attachments';
import { imageTool, videoTool } from '../../src/lib/interaction-tools';
import { defaultToolSettings } from '../../src/lib/tool-settings';
import type { Connection, WireResponse } from '../../src/types';
import { toolApiName, type AgentChatOptions, type AgentChatResult } from '../../src/lib/agent';

const folders: string[] = [];
const services: HostTaskService[] = [];
afterEach(async () => {
	for (const service of services.splice(0)) await service.close();
	for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});
const response = (api: Connection['chatApi'], text: string): WireResponse => ({
	status: 200,
	contentType: 'application/json',
	encoding: 'text',
	body: JSON.stringify(
		api === 'responses'
			? {
					output: [
						{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
					],
				}
			: { choices: [{ message: { role: 'assistant', content: text } }] },
	),
});
const result = (content = 'Finished'): AgentChatResult => ({
	content,
	toolCalls: [],
	transcript: { api: 'responses', items: [] },
	activity: [],
	phase: 'responding',
});
function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
async function fixture(
	api: Connection['chatApi'] = 'responses',
	overrides: Partial<HostTaskServiceOptions> = {},
) {
	const folder = await mkdtemp(path.join(tmpdir(), 'freelm-host-task-'));
	folders.push(folder);
	const store = new StateStore(
		path.join(folder, 'workspace.json'),
		{ available: () => false, encrypt: () => Buffer.from(''), decrypt: () => '' },
		path.join(folder, 'config.json'),
	);
	const authority = new WorkspaceAuthority(store);
	const state = initialState();
	const connection = state.connections[0];
	connection.chatApi = api;
	connection.models.chat = 'test-model';
	connection.catalog = [
		{
			id: 'test-model',
			name: 'Fixture',
			enabled: true,
			tasks: ['chat'],
			inputModalities: ['text', 'image'],
			outputModalities: ['text'],
			thinkingModes: [
				{
					id: 'high',
					name: 'High',
					parameters: {
						responses: { reasoning: { effort: 'high' } },
						chat: { reasoning_effort: 'high' },
					},
				},
			],
		},
	];
	state.toolSettings = {
		...defaultToolSettings(),
		enabled: true,
		workspaceRoot: folder,
		commandExecution: true,
		approvalMode: 'ask',
	};
	state.projects = [
		{
			id: 'research',
			kind: 'code',
			name: 'Research',
			instructions: 'Preserve source attribution.',
			directories: [folder],
			createdAt: 1,
		},
	];
	await authority.save(state, (await authority.load()).revision);
	const approve = vi.fn(async () => true);
	const agent = new AgentHost(() => authority.loadToolState(), approve);
	const requests: Parameters<HostTaskServiceOptions['request']>[0][] = [];
	const service = new HostTaskService({
		authority,
		agent,
		hostId: () => 'this-host',
		request: async (request) => {
			requests.push(request);
			return response(api, 'Completed without a workspace window.');
		},
		...overrides,
	});
	services.push(service);
	await service.ready;
	return { folder, store, authority, service, agent, approve, requests, connection };
}
async function finish(service: HostTaskService, id: string) {
	await vi.waitFor(
		async () => expect((await service.statuses([id]))[id]).not.toMatch(/working|queued|waiting/),
		{ timeout: 5000 },
	);
}
async function create(
	service: HostTaskService,
	kind: 'chat' | 'code' = 'chat',
	operation = 'create-one',
) {
	const value = (await service.execute(
		'threads_create',
		{
			kind,
			prompt: 'Investigate the test result.',
			...(kind === 'code' ? { projectId: 'research' } : {}),
		},
		operation,
	)) as { threadId: string; delivery: { status: string } };
	return value;
}

describe('host-owned Bot task execution', () => {
	it.each(['responses', 'chat'] as const)(
		'runs and persists %s Chat with no renderer and accepts immediate asynchronous delivery',
		async (api) => {
			const f = await fixture(api);
			f.service.setReady(false);
			const created = await create(f.service);
			expect(created.delivery.status).toBe('started');
			await finish(f.service, created.threadId);
			const disk = await f.store.load();
			const thread = disk!.threads.find((t) => t.id === created.threadId)!;
			expect(thread.messages.map((m) => m.content)).toEqual([
				'Investigate the test result.',
				'Completed without a workspace window.',
			]);
			expect(thread.messages.at(-1)?.completedAt).toBeGreaterThan(0);
			expect(f.requests).toHaveLength(1);
			expect(f.requests[0].connectionId).toBe(f.connection.id);
			expect(f.requests[0].workspaceId).toBe('local');
			const repeated = await create(f.service);
			expect(repeated.threadId).toBe(created.threadId);
			expect(f.requests).toHaveLength(1);
			const list = (await f.service.execute('threads_list', {}, 'list')) as {
				threads: { id: string }[];
			};
			expect(list.threads[0].id).toBe(created.threadId);
		},
	);
	it('uses the canonical Code system prompt, compaction and real approval enforcement', async () => {
		let call = 0;
		const f = await fixture('responses', {
			request: async (request) => {
				if (++call === 1) {
					expect(String(request.body?.instructions)).toContain('FreeLM');
					expect(JSON.stringify(request.body)).toContain('Preserve source attribution.');
					return {
						status: 200,
						contentType: 'application/json',
						encoding: 'text',
						body: JSON.stringify({
							output: [
								{
									type: 'function_call',
									id: 'f1',
									call_id: 'c1',
									name: 'exec_command',
									arguments: JSON.stringify({ cmd: 'pwd', max_output_tokens: 100 }),
								},
							],
						}),
					};
				}
				expect(JSON.stringify(request.body)).toContain('function_call_output');
				return response('responses', 'Inspected the workspace.');
			},
		});
		const created = await create(f.service, 'code');
		await finish(f.service, created.threadId);
		const thread = (await f.authority.load()).state!.threads[0];
		expect(thread.permissionMode).toBe('ask');
		expect(f.approve).toHaveBeenCalled();
		expect(thread.messages.at(-1)?.toolCalls?.[0]?.name).toBe('exec_command');
		expect(thread.messages.at(-1)?.content).toBe('Inspected the workspace.');
	});
	it('queues steering during a running task and continues at a complete tool boundary', async () => {
		const began = deferred();
		const continueFirst = deferred();
		const histories: string[][] = [];
		const f = await fixture('responses', {
			stream: async (options) => {
				histories.push(options.history.map((m) => m.content));
				if (histories.length === 1) {
					began.resolve();
					await continueFirst.promise;
					await vi.waitFor(() => expect(options.shouldYieldForInput?.()).toBe(true));
					options.onUpdate(result('First segment.'));
					return { ...result('First segment.'), yieldedForInput: true };
				}
				options.onUpdate(result('Used corrected scope.'));
				return result('Used corrected scope.');
			},
		});
		const created = await create(f.service, 'code');
		await began.promise;
		const follow = (await f.service.execute(
			'threads_send',
			{ threadId: created.threadId, prompt: 'Use the other account.' },
			'follow',
		)) as { delivery: { status: string } };
		expect(follow.delivery.status).toBe('queued');
		continueFirst.resolve();
		await finish(f.service, created.threadId);
		expect(histories).toHaveLength(2);
		expect(histories[1]).toEqual([
			'Investigate the test result.',
			'First segment.',
			'Use the other account.',
		]);
		const stored = (await f.store.load())!.threads[0];
		expect(stored.queuedMessages).toEqual([]);
		expect(stored.messages.at(-1)?.content).toBe('Used corrected scope.');
	});
	it.each(['responses', 'chat'] as const)(
		'delivers queued corrections through actual %s protocol tool boundaries',
		async (api) => {
			const began = deferred();
			const release = deferred();
			let requests = 0;
			const f = await fixture(api, {
				request: async (request) => {
					if (++requests === 1) {
						began.resolve();
						await release.promise;
						const tool = { name: toolApiName('clock.curr_time'), arguments: '{}' };
						return {
							status: 200,
							contentType: 'application/json',
							encoding: 'text',
							body: JSON.stringify(
								api === 'responses'
									? { output: [{ type: 'function_call', id: 'fc', call_id: 'call', ...tool }] }
									: {
											choices: [
												{
													message: {
														role: 'assistant',
														content: '',
														tool_calls: [{ id: 'call', type: 'function', function: tool }],
													},
												},
											],
										},
							),
						};
					}
					expect(JSON.stringify(request.body)).toContain('Use the corrected scope');
					return response(api, 'Correction incorporated.');
				},
			});
			const created = await create(f.service, 'code');
			await began.promise;
			await f.service.execute(
				'threads_send',
				{ threadId: created.threadId, prompt: 'Use the corrected scope' },
				'corrected',
			);
			release.resolve();
			await finish(f.service, created.threadId);
			expect(requests).toBe(2);
			const thread = (await f.store.load())!.threads[0];
			expect(thread.messages.at(-1)?.content).toBe('Correction incorporated.');
			expect(thread.messages.filter((message) => message.role === 'user')).toHaveLength(2);
		},
	);

	it('coordinates visible and host runners so a queued input is executed only once', async () => {
		const f = await fixture();
		await f.authority.mutate((state) => ({
			state: {
				...state,
				threads: [
					{
						id: 'existing',
						kind: 'chat',
						title: 'Existing',
						connectionId: f.connection.id,
						model: 'test-model',
						thinkingMode: 'high',
						createdAt: 1,
						updatedAt: 1,
						messages: [],
					},
				],
			},
			value: undefined,
		}));
		expect(f.service.claimRenderer('existing', 'ui-run')).toBe(true);
		const delivery = (await f.service.execute(
			'threads_send',
			{ threadId: 'existing', prompt: 'Additional request.' },
			'send',
		)) as { delivery: { status: string } };
		expect(delivery.delivery.status).toBe('queued');
		expect(f.requests).toHaveLength(0);
		expect(f.service.claimRenderer('existing', 'other-ui-run')).toBe(false);
		await f.service.releaseRenderer('existing', 'not-the-owner');
		expect(f.requests).toHaveLength(0);
		await f.service.releaseRenderer('existing', 'ui-run');
		await finish(f.service, 'existing');
		expect(f.requests).toHaveLength(1);
	});
	it('keeps a human question pending with no renderer and resumes when the UI answers', async () => {
		const f = await fixture('responses', {
			stream: async (options) => {
				const answer = await options.execute(
					'request_user_input',
					{ questions: [{ id: 'account', question: 'Which account?' }] },
					'question-1',
				);
				expect(JSON.stringify(answer)).toContain('Research');
				options.onUpdate(result('Continued.'));
				return result('Continued.');
			},
		});
		const created = await create(f.service, 'code');
		await vi.waitFor(() => expect(f.service.snapshot().questions).toHaveLength(1));
		expect((await f.service.statuses([created.threadId]))[created.threadId]).toBe(
			'waiting_for_input',
		);
		f.service.answerQuestion('question-1', { account: { answers: ['Research'] } });
		await finish(f.service, created.threadId);
		expect(f.service.snapshot().questions).toEqual([]);
	});
	it('Stop cancels only the selected task and preserves completed output and queued input', async () => {
		const begun = deferred();
		const f = await fixture('responses', {
			stream: async (options) => {
				options.onUpdate(result('Started this task.'));
				begun.resolve();
				await new Promise((_resolve, reject) =>
					options.signal!.addEventListener(
						'abort',
						() => reject(new DOMException('Aborted', 'AbortError')),
						{ once: true },
					),
				);
				return result();
			},
		});
		const created = await create(f.service, 'code');
		await begun.promise;
		await f.service.execute(
			'threads_send',
			{ threadId: created.threadId, prompt: 'Keep this queued.' },
			'queued',
		);
		await f.service.execute('threads_stop', { threadId: created.threadId }, 'stop');
		const stored = (await f.store.load())!.threads[0];
		expect(stored.messages.at(-1)?.interrupted).toBe(true);
		expect(stored.messages.at(-1)?.content).toBe('Started this task.');
		expect(stored.queuedMessages?.map((m) => m.content)).toEqual(['Keep this queued.']);
		expect(f.service.snapshot().runs).toEqual([]);
	});
	it('full host close interrupts active work and restart does not replay completed side effects', async () => {
		const began = deferred();
		const effects = vi.fn();
		const f = await fixture('responses', {
			stream: async (options) => {
				effects();
				options.onUpdate(result('Action completed; awaiting another tool.'));
				began.resolve();
				await new Promise((_resolve, reject) =>
					options.signal!.addEventListener(
						'abort',
						() => reject(new DOMException('Aborted', 'AbortError')),
						{ once: true },
					),
				);
				return result();
			},
		});
		const created = await create(f.service, 'code');
		await began.promise;
		await f.service.execute(
			'threads_send',
			{ threadId: created.threadId, prompt: 'Leave queued for a later resume.' },
			'queued-after-close',
		);
		await f.service.close();
		expect(f.service.snapshot().runs).toEqual([]);
		const stored = (await f.store.load())!.threads[0];
		expect(stored.messages.at(-1)).toMatchObject({
			content: 'Action completed; awaiting another tool.',
			interrupted: true,
		});
		expect(stored.queuedMessages).toHaveLength(1);
		const request = vi.fn(async () => response('responses', 'Must not run automatically.'));
		const restarted = new HostTaskService({
			authority: f.authority,
			agent: f.agent,
			hostId: () => 'this-host',
			request,
		});
		services.push(restarted);
		await restarted.ready;
		expect(request).not.toHaveBeenCalled();
		expect(effects).toHaveBeenCalledTimes(1);
		expect(restarted.snapshot().runs).toEqual([]);
	});
	it('retains a renderer lease until the final response is durably completed', async () => {
		const f = await fixture();
		await f.authority.mutate((state) => ({
			state: {
				...state,
				threads: [
					{
						id: 'visible',
						kind: 'chat',
						title: 'Visible',
						connectionId: f.connection.id,
						model: 'test-model',
						thinkingMode: 'high',
						createdAt: 1,
						updatedAt: 1,
						messages: [
							{
								id: 'stream',
								role: 'assistant',
								content: 'Partial',
								phase: 'working',
								createdAt: 1,
							},
						],
					},
				],
			},
			value: undefined,
		}));
		expect(f.service.claimRenderer('visible', 'renderer')).toBe(true);
		await expect(f.service.releaseRenderer('visible', 'renderer')).rejects.toThrow(
			'Save the completed response',
		);
		expect(await f.service.dispatch('visible')).toEqual({ status: 'queued' });
		await f.authority.mutate((state) => ({
			state: {
				...state,
				threads: state.threads.map((thread) => ({
					...thread,
					messages: thread.messages.map((message) => ({ ...message, completedAt: 2 })),
				})),
			},
			value: undefined,
		}));
		await f.service.releaseRenderer('visible', 'renderer');
		expect(f.service.snapshot().runs).toEqual([]);
		expect((await f.service.statuses(['visible'])).visible).toBe('completed');
	});
	it('renderer loss persists interruption and does not falsely report completion or affect remote ownership', async () => {
		const f = await fixture();
		await f.authority.mutate((state) => ({
			state: {
				...state,
				threads: ['visible', 'remote'].map((id) => ({
					id,
					kind: 'chat',
					title: id,
					connectionId: f.connection.id,
					model: 'test-model',
					thinkingMode: 'high',
					createdAt: 1,
					updatedAt: 1,
					messages: [
						{
							id: id + '-answer',
							role: 'assistant',
							content: 'Partial',
							phase: 'working',
							createdAt: 1,
						},
					],
				})),
			},
			value: undefined,
		}));
		expect(f.service.claimRenderer('visible', 'renderer')).toBe(true);
		expect(f.service.claimExternal('remote', 'remote:run')).toBe(true);
		await f.service.rendererClosed();
		const state = (await f.store.load())!;
		expect(state.threads[0].messages.at(-1)?.interrupted).toBe(true);
		expect(state.threads[1].messages.at(-1)?.interrupted).toBeUndefined();
		expect(await f.service.statuses(['visible', 'remote'])).toEqual({
			visible: 'error',
			remote: 'working',
		});
		await f.service.releaseExternal('remote:run', true);
		expect((await f.service.statuses(['remote'])).remote).toBe('error');
	});
	it('publishes revision-only idle updates without cloning the workspace for its cache', async () => {
		const f = await fixture();
		const before = f.service.snapshot().workspaceRevision;
		const load = vi.spyOn(f.authority, 'load');
		await f.authority.mutate(state => ({ state: { ...state, theme: 'light' }, value: undefined }));
		await Promise.resolve();
		expect(f.service.snapshot().workspaceRevision).not.toBe(before);
		expect(f.service.snapshot().workspaceRevision).toBe(f.authority.currentRevision());
		expect(load).not.toHaveBeenCalled();
	});
	it('a destroyed UI observer cannot abort a host task', async () => {
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const f = await fixture('responses', {
				changed: () => {
					throw new Error('Destroyed window');
				},
			});
			const created = await create(f.service);
			await finish(f.service, created.threadId);
			expect((await f.store.load())!.threads[0].messages.at(-1)?.content).toBe(
				'Completed without a workspace window.',
			);
			expect(log).toHaveBeenCalled();
			await f.service.close();
		} finally {
			log.mockRestore();
		}
	});
	it('survives renderer detach while host execution is pending', async () => {
		const began = deferred();
		const finishWork = deferred();
		const f = await fixture('responses', {
			stream: async (options) => {
				began.resolve();
				await finishWork.promise;
				expect(options.signal?.aborted).toBe(false);
				options.onUpdate(result());
				return result();
			},
		});
		const created = await create(f.service);
		await began.promise;
		await f.service.rendererClosed();
		f.service.setReady(false);
		finishWork.resolve();
		await finish(f.service, created.threadId);
		expect((await f.store.load())!.threads[0].messages.at(-1)?.content).toBe('Finished');
	});
	it.each(['image_gen.imagegen', 'video_gen.videogen'])(
		'forwards reference images and saves %s outputs in the shared gallery',
		async (name) => {
			const png =
				'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
			const execute = vi.fn(async (request) => {
				expect(request.recentImages?.[0]?.dataUrl).toBe(png);
				return {
					content:
						name === 'image_gen.imagegen'
							? [{ type: 'image' as const, dataUrl: png, name: 'generated.png' }]
							: [
									{
										type: 'file' as const,
										dataUrl: 'data:video/mp4;base64,AAAA',
										mimeType: 'video/mp4',
										name: 'generated.mp4',
									},
								],
				};
			});
			const f = await fixture('responses', {
				agent: {
					catalog: async () => ({ tools: [imageTool, videoTool], instructions: '', warnings: [] }),
					execute,
					cancel: () => {},
				},
				stream: async (options) => {
					expect(options.history[0].attachments?.[0]?.dataUrl).toBe(png);
					await options.execute(
						name,
						{ prompt: 'Harmless landscape edit', num_last_images_to_include: 1 },
						'generate',
					);
					options.onUpdate(result('Media completed.'));
					return result('Media completed.');
				},
			});
			const source = {
				id: 'reference',
				role: 'user' as const,
				content: 'Reference landscape',
				createdAt: 1,
				attachments: [{ name: 'source.png', type: 'image/png', dataUrl: png }],
			};
			await f.authority.mutate((state) => ({
				state: {
					...state,
					toolSettings: {
						...state.toolSettings!,
						imageGeneration: {
							enabled: true,
							model: 'image',
							connectionId: f.connection.id,
							size: '1024x1024',
							quality: 'high',
						},
						videoGeneration: {
							enabled: true,
							model: 'video',
							connectionId: f.connection.id,
							size: '1024x576',
							seconds: '10',
						},
					},
					threads: [
						{
							id: 'source',
							kind: 'chat',
							title: 'Reference',
							connectionId: f.connection.id,
							model: 'test-model',
							thinkingMode: 'high',
							createdAt: 1,
							updatedAt: 1,
							messages: [source],
						},
					],
				},
				value: undefined,
			}));
			const ref = botThreadAttachments('this-host', 'source', source, 1).attachments[0].ref;
			const created = (await f.service.execute(
				'threads_create',
				{ kind: 'chat', prompt: 'Use this reference.', attachmentRefs: [ref] },
				'with-reference',
			)) as { threadId: string };
			await finish(f.service, created.threadId);
			expect(execute).toHaveBeenCalledTimes(1);
			const generations = (await f.store.load())!.generations;
			expect(generations).toHaveLength(1);
			expect(generations[0].kind).toBe(name.startsWith('image') ? 'images' : 'videos');
			expect(generations[0].parameters?.size).toBe(
				name.startsWith('image') ? '1024x1024' : '1024x576',
			);
		},
	);

	it('exposes saved Chat memory and reference-image attachments through the same shared agent loop', async () => {
		let observed: AgentChatOptions | undefined;
		const f = await fixture('responses', {
			stream: async (options) => {
				observed = options;
				options.onUpdate(result());
				return result();
			},
		});
		await f.authority.mutate((state) => ({
			state: {
				...state,
				savedMemories: [
					{
						id: 'memory',
						content: 'The preferred research label is Zebra.',
						createdAt: 1,
						updatedAt: 1,
						revision: 1,
						source: 'user',
					},
				],
			},
			value: undefined,
		}));
		const created = await create(f.service);
		await finish(f.service, created.threadId);
		expect(observed!.instructions).toContain('Zebra');
		expect(observed!.tools.some((t) => t.name === 'memory.search')).toBe(true);
		expect(observed!.compaction).toBe(true);
	});
});
