import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BotHost, type BotHostOptions, type BotTaskToolDefinition } from '../../electron/bot-host';
import type { BotProfile, BotReplyRequest } from '../../src/bot-types';
import { initialState } from '../../src/lib/state';
import {
	validBotTaskWatch,
	validateBotReplyRequest,
	validateBotReplyResult,
} from '../../src/lib/bots';
import type { WireRequest, WireResponse } from '../../src/types';

type Api = 'responses' | 'chat/completions';
const createdThreadId = `bot-thread:bot:${'a'.repeat(64)}`;
const folders: string[] = [],
	hosts: BotHost[] = [];
afterEach(async () => {
	for (const host of hosts.splice(0)) host.close();
	await Promise.all(
		folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
	);
});
const profile = (id = 'nova'): BotProfile => ({
	memoryEnabled: false,
	id,
	name: id,
	address: `${id}@freelm`,
	color: '#abcdef',
	identity: 'A direct, friendly companion.',
	learnedPersonality: '',
	enabled: true,
	historyAccess: true,
	personalityLearning: true,
	connectionId: 'connection',
	model: 'test-model',
	createdAt: 1,
	updatedAt: 1,
});
function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function reply(
	content = 'Done.',
	api: Api = 'responses',
	calls: { name: string; args?: unknown }[] = [],
): WireResponse {
	return {
		status: 200,
		encoding: 'text',
		contentType: 'application/json',
		body: JSON.stringify(
			api === 'responses'
				? {
						status: 'completed',
						output: [
							...(content
								? [
										{
											type: 'message',
											role: 'assistant',
											content: [{ type: 'output_text', text: content }],
										},
									]
								: []),
							...calls.map((call, i) => ({
								type: 'function_call',
								call_id: `call-${i}`,
								name: call.name,
								arguments: JSON.stringify(call.args ?? {}),
							})),
						],
					}
				: {
						choices: [
							{
								finish_reason: calls.length ? 'tool_calls' : 'stop',
								message: {
									role: 'assistant',
									content,
									...(calls.length
										? {
												tool_calls: calls.map((call, i) => ({
													id: `call-${i}`,
													type: 'function',
													function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
												})),
											}
										: {}),
								},
							},
						],
					},
		),
	};
}
const taskDefinition = (name: string): BotTaskToolDefinition => ({
	name,
	description: name,
	parameters: { type: 'object', properties: {} },
});
async function fixture(options: Partial<BotHostOptions> = {}, api: Api = 'responses') {
	const folder = await mkdtemp(path.join(os.tmpdir(), 'freelm-bot-notifications-'));
	folders.push(folder);
	const state = initialState(),
		connection = state.connections[0];
	connection.id = 'connection';
	connection.chatApi = api;
	connection.catalog = [
		{
			id: 'test-model',
			name: 'Test',
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
	const config: BotHostOptions = {
		filename: path.join(folder, 'mailbox.json'),
		identity: async () => ({ id: 'home', name: 'Home' }),
		workspace: async () => state,
		request: async () => reply('Done.', api),
		watchIntervalMs: 60_000,
		remoteProfile: async (participant) => profile(participant.botId),
		...options,
	};
	const host = new BotHost(config);
	hosts.push(host);
	await host.command({
		type: 'create-bot',
		id: 'nova',
		profile: {
			memoryEnabled: false,
			name: 'Nova',
			identity: 'A direct, friendly companion.',
			connectionId: 'connection',
			model: 'test-model',
		},
	});
	await host.command({
		type: 'create-conversation',
		id: 'dm',
		participants: [{ hostId: 'home', botId: 'nova' }],
	});
	return { host, config, filename: config.filename };
}
const send = (host: BotHost, conversationId = 'dm') =>
	host.command({
		type: 'send',
		conversationId,
		messageId: 'request',
		content: 'Please finish the existing Code task.',
	});
const messages = async (host: BotHost, id = 'dm') =>
	(await host.snapshot()).conversations.find((c) => c.id === id)!.messages;

describe('bot event notifications', () => {
	it('retains an older reacted message and its user turn when bounding a long conversation', async () => {
		const received: BotReplyRequest[] = [];
		const { host, config, filename } = await fixture({
			remoteRespond: async (_participant, request) => {
				received.push(structuredClone(request));
				return { content: '', reactions: [], silent: true };
			},
		});
		await host.command({
			type: 'create-conversation',
			id: 'remote',
			participants: [{ hostId: 'remote', botId: 'fred' }],
		});
		host.close();
		const stored = JSON.parse(await readFile(filename, 'utf8'));
		const conversation = stored.conversations.find((item: { id: string }) => item.id === 'remote');
		conversation.messages = Array.from({ length: 45 }, (_, index) => [
			{
				id: `user-${index}`,
				role: 'user',
				content: `User message ${index}`,
				status: 'completed',
				createdAt: index * 2 + 1,
				updatedAt: index * 2 + 1,
				reactions: [],
			},
			{
				id: `bot-${index}`,
				role: 'bot',
				author: { hostId: 'remote', botId: 'fred' },
				content: `Bot answer ${index}`,
				replyTo: `user-${index}`,
				status: 'completed',
				createdAt: index * 2 + 2,
				updatedAt: index * 2 + 2,
				reactions: [],
			},
		]).flat();
		await writeFile(filename, JSON.stringify(stored));
		const reopened = new BotHost(config);
		hosts.push(reopened);
		await reopened.command({
			type: 'react',
			conversationId: 'remote',
			messageId: 'bot-0',
			emoji: '❤️',
		});
		await reopened.idle();
		expect(received).toHaveLength(1);
		expect(received[0].messages.length).toBeLessThanOrEqual(80);
		expect(received[0].messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: 'user-0', content: 'User message 0' }),
				expect.objectContaining({
					id: 'bot-0',
					content: 'Bot answer 0',
					reactions: [expect.objectContaining({ actorId: 'user', emoji: '❤️' })],
				}),
			]),
		);
		expect(received[0]).toMatchObject({
			userMessageId: 'user-0',
			notification: { type: 'reaction', messageId: 'bot-0' },
		});
	});
	it('notifies only the author of a reacted group reply without inventing a human message', async () => {
		const received: BotReplyRequest[] = [];
		const { host } = await fixture({
			remoteRespond: async (_participant, request) => {
				received.push(structuredClone(request));
				return request.notification
					? { content: '', reactions: [], silent: true }
					: { content: `Hi from ${request.botId}.`, reactions: [] };
			},
		});
		await host.command({
			type: 'create-conversation',
			id: 'group',
			participants: [
				{ hostId: 'remote-a', botId: 'fred' },
				{ hostId: 'remote-b', botId: 'vera' },
			],
		});
		await send(host, 'group');
		await host.idle();
		const fred = (await messages(host, 'group')).find(
			(message) => message.author?.botId === 'fred',
		)!;
		received.length = 0;
		await host.command({ type: 'react', conversationId: 'group', messageId: fred.id, emoji: '❤️' });
		await host.idle();
		expect(received).toHaveLength(1);
		expect(received[0]).toMatchObject({
			botId: 'fred',
			userMessageId: 'request',
			notification: { type: 'reaction', messageId: fred.id, emoji: '❤️' },
		});
		expect(
			received[0].messages
				.filter((message) => message.role === 'user')
				.map((message) => message.content),
		).toEqual(['Please finish the existing Code task.']);
		expect(received[0].messages.find((message) => message.id === fred.id)?.reactions).toMatchObject(
			[{ actorId: 'user', emoji: '❤️' }],
		);
		expect(await messages(host, 'group')).toHaveLength(3);
		await host.command({ type: 'react', conversationId: 'group', messageId: fred.id, emoji: null });
		await host.idle();
		expect(received.at(-1)?.notification).toMatchObject({
			type: 'reaction',
			messageId: fred.id,
			emoji: null,
			previousEmoji: '❤️',
		});
	});
	it('notifies each group participant of a reaction to the user message', async () => {
		const notified: string[] = [];
		const { host } = await fixture({
			remoteRespond: async (_participant, request) => {
				if (request.notification) {
					if (request.notification.type === 'reaction') notified.push(request.botId);
					return { content: '', reactions: [], silent: true };
				}
				return { content: 'Received.', reactions: [] };
			},
		});
		await host.command({
			type: 'create-conversation',
			id: 'group',
			participants: [
				{ hostId: 'remote-a', botId: 'fred' },
				{ hostId: 'remote-b', botId: 'vera' },
			],
		});
		await send(host, 'group');
		await host.idle();
		await host.command({
			type: 'react',
			conversationId: 'group',
			messageId: 'request',
			emoji: '‼️',
		});
		await host.idle();
		expect(notified.sort()).toEqual(['fred', 'vera']);
		expect(await messages(host, 'group')).toHaveLength(3);
	});
	it('coalesces changed and removed reactions and discards a stale in-flight reply', async () => {
		const started = deferred(),
			release = deferred();
		const notifications: BotReplyRequest['notification'][] = [];
		const { host } = await fixture({
			remoteRespond: async (_participant, request) => {
				if (!request.notification) return { content: 'Received.', reactions: [] };
				notifications.push(request.notification);
				if (notifications.length === 1) {
					started.resolve();
					await release.promise;
					return { content: 'Stale reaction reply.', reactions: [] };
				}
				return { content: '', reactions: [], silent: true };
			},
		});
		await host.command({
			type: 'create-conversation',
			id: 'remote',
			participants: [{ hostId: 'remote', botId: 'fred' }],
		});
		await send(host, 'remote');
		await host.idle();
		const bot = (await messages(host, 'remote'))[1];
		await host.command({ type: 'react', conversationId: 'remote', messageId: bot.id, emoji: '👍' });
		await started.promise;
		await host.command({ type: 'react', conversationId: 'remote', messageId: bot.id, emoji: '❤️' });
		await host.command({ type: 'react', conversationId: 'remote', messageId: bot.id, emoji: null });
		release.resolve();
		await host.idle();
		expect(notifications.at(-1)).toMatchObject({ type: 'reaction', emoji: null });
		expect(await messages(host, 'remote')).toHaveLength(2);
		expect((await messages(host, 'remote'))[1].reactions).toEqual([]);
	});
	it('allows a silent reaction acknowledgment but never treats the reaction as authorization to send work', async () => {
		const executeTaskTool = vi.fn(async () => ({ accepted: true }));
		let count = 0;
		const { host } = await fixture({
			taskToolDefinitions: () => [taskDefinition('threads_send')],
			executeTaskTool,
			request: async () => {
				count++;
				if (count === 1) return reply('All set.');
				if (count === 2)
					return reply('', 'responses', [
						{ name: 'threads_send', args: { threadId: 'code', prompt: 'Do more work.' } },
					]);
				return reply('', 'responses', [{ name: 'bot_silence' }]);
			},
		});
		await send(host);
		await host.idle();
		await host.command({
			type: 'react',
			conversationId: 'dm',
			messageId: (await messages(host))[1].id,
			emoji: '👍',
		});
		await host.idle();
		expect(executeTaskTool).not.toHaveBeenCalled();
		expect(count).toBe(3);
		expect(await messages(host)).toHaveLength(2);
	});
	it.each(['responses', 'chat/completions'] as const)(
		'keeps %s tool-loop commentary out of the final message bubble',
		async (api) => {
			let count = 0;
			const { host } = await fixture(
				{
					taskToolDefinitions: () => [taskDefinition('threads_read')],
					executeTaskTool: async () => ({ status: 'completed' }),
					request: async () =>
						++count === 1
							? reply('Let me inspect that thread.', api, [
									{ name: 'threads_read', args: { threadId: 'code' } },
								])
							: reply('The export is ready.', api),
				},
				api,
			);
			await send(host);
			await host.idle();
			expect((await messages(host))[1]).toMatchObject({
				content: 'The export is ready.',
				status: 'completed',
			});
		},
	);
});

describe('durable bot thread notifications', () => {
	it.each(['responses', 'chat/completions'] as const)(
		'keeps %s completion notifications conversational while retaining the original report as context',
		async (api) => {
			const report =
				'## Export\n\n- PNG passed.\n- JPEG failed on large images.\n\n## Tests\n\n12 passed.';
			let instructions = '';
			const { host } = await fixture(
				{
					request: async (wire) => {
						instructions =
							api === 'responses'
								? String(wire.body!.instructions)
								: (wire.body!.messages as { role: string; content: string }[])[0].content;
						return reply('PNG is ready, but JPEG still fails on large images.', api);
					},
				},
				api,
			);
			const result = await host.respond(
				{
					botId: 'nova',
					conversationId: 'dm',
					userMessageId: 'original',
					messages: [
						{
							id: 'original',
							role: 'user',
							content: 'Finish the export.',
							status: 'completed',
							createdAt: 1,
							updatedAt: 1,
							reactions: [],
						},
					],
					notification: {
						id: 'finished',
						type: 'thread',
						hostId: 'home',
						threadId: createdThreadId,
						cursor: 'done',
						status: 'completed',
						title: 'Export',
						summary: report,
					},
				},
				undefined,
				true,
			);
			const event = JSON.parse(
				instructions.match(/<freelm_notification>\n(.+)\n<\/freelm_notification>/)![1],
			);
			expect(event.summary).toBe(report);
			expect(instructions).toContain('Plain conversational text is the default');
			expect(instructions).toContain('Paraphrase the result and any important blocker');
			expect(instructions).toContain('do not copy its Markdown report');
			expect(result.content).toBe('PNG is ready, but JPEG still fails on large images.');
		},
	);
	it('accepts opaque task IDs at remote event and watch boundaries without widening bot or host IDs', async () => {
		const { host } = await fixture();
		const request: BotReplyRequest = {
			botId: 'nova',
			conversationId: 'remote-group',
			userMessageId: 'original',
			messages: [
				{
					id: 'original',
					role: 'user',
					content: 'Finish the task.',
					status: 'completed',
					createdAt: 1,
					updatedAt: 1,
					reactions: [],
				},
			],
			notification: {
				id: 'event',
				type: 'thread',
				hostId: 'home',
				threadId: createdThreadId,
				cursor: 'done',
				status: 'completed',
				title: 'Notebook',
				summary: 'Finished.',
			},
		};
		expect(() => validateBotReplyRequest(request)).not.toThrow();
		expect(validBotTaskWatch({ hostId: 'home', threadId: createdThreadId })).toBe(true);
		expect(await host.respond(request, undefined, true)).toMatchObject({ content: 'Done.' });
		expect(() =>
			validateBotReplyResult(
				{
					content: 'Running.',
					reactions: [],
					taskWatches: [{ hostId: 'home', threadId: createdThreadId }],
				},
				request,
			),
		).not.toThrow();
		for (const threadId of ['', '   ', 'x'.repeat(257), null]) {
			expect(validBotTaskWatch({ hostId: 'home', threadId })).toBe(false);
			expect(() =>
				validateBotReplyRequest({
					...request,
					notification: { ...request.notification, threadId },
				}),
			).toThrow();
		}
		expect(validBotTaskWatch({ hostId: 'bad:host', threadId: createdThreadId })).toBe(false);
		expect(() => validateBotReplyRequest({ ...request, botId: 'bad:bot' })).toThrow();
	});
	it('resumes persisted watches at host startup without opening Bots or manually polling', async () => {
		const requests: WireRequest[] = [];
		const pollTask = vi.fn(async () => ({
			polls: [
				{
					id: createdThreadId,
					status: 'completed',
					cursor: 'finished',
					title: 'Notebook',
					answer: 'Export complete.',
				},
			],
		}));
		const { host, config } = await fixture({
			pollTask,
			taskToolDefinitions: () => [taskDefinition('threads_send')],
			executeTaskTool: async () => ({
				hostId: 'home',
				result: { threadId: createdThreadId, promptSaved: true },
			}),
			request: async (wire) => {
				requests.push(structuredClone(wire));
				return requests.length === 1
					? reply('', 'responses', [
							{
								name: 'threads_send',
								args: { threadId: createdThreadId, prompt: 'Export the notebook.' },
							},
						])
					: reply(requests.length === 2 ? 'The export is running.' : 'Your notebook is ready.');
			},
		});
		await send(host);
		await host.idle();
		host.close();
		expect(pollTask).not.toHaveBeenCalled();
		const reopened = new BotHost({ ...config, watchIntervalMs: 1000 });
		hosts.push(reopened);
		await reopened.start();
		// Deliberately do not open a snapshot, issue a command, or call pollTaskWatches.
		await vi.waitFor(() => expect(requests).toHaveLength(3), { timeout: 3500, interval: 25 });
		await reopened.idle();
		expect(pollTask).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(requests[2].body)).toContain('Export complete.');
		expect((await messages(reopened)).at(-1)?.content).toBe('Your notebook is ready.');
	});
	it('stays quiet while working and reports attention then completion without repeating a cursor', async () => {
		let current = { id: 'code', status: 'working', cursor: 'working', title: 'Export', answer: '' };
		const events: BotReplyRequest[] = [];
		const pollTask = vi.fn(async () => ({ polls: [{ ...current }] }));
		const { host } = await fixture({
			pollTask,
			remoteRespond: async (_participant, request) => {
				if (request.notification) {
					events.push(structuredClone(request));
					return {
						content:
							request.notification.type === 'thread' ? request.notification.summary : 'Reaction.',
						reactions: [],
					};
				}
				return {
					content: 'It’s running.',
					reactions: [],
					taskWatches: [{ hostId: 'workstation', threadId: 'code', afterCursor: 'started' }],
				};
			},
		});
		await host.command({
			type: 'create-conversation',
			id: 'remote',
			participants: [{ hostId: 'remote', botId: 'fred' }],
		});
		await send(host, 'remote');
		await host.idle();
		await host.pollTaskWatches();
		await host.idle();
		expect(events).toHaveLength(0);
		current = {
			...current,
			status: 'waiting_for_input',
			cursor: 'question',
			answer: 'Choose PNG or JPEG.',
		};
		await host.pollTaskWatches();
		await host.idle();
		await host.pollTaskWatches();
		await host.idle();
		expect(events).toHaveLength(1);
		expect(events[0].notification).toMatchObject({
			status: 'waiting_for_input',
			summary: 'Choose PNG or JPEG.',
		});
		current = { ...current, status: 'completed', cursor: 'finished', answer: 'The PNG is ready.' };
		await host.pollTaskWatches();
		await host.idle();
		await host.pollTaskWatches();
		await host.idle();
		expect(events).toHaveLength(2);
		expect(events[1].notification).toMatchObject({
			status: 'completed',
			summary: 'The PNG is ready.',
		});
		expect(pollTask).toHaveBeenCalledTimes(4);
	});
	it('reports a disconnected task host once and resumes its existing watch after reconnect', async () => {
		let offline = true;
		const events: BotReplyRequest[] = [];
		const pollTask = vi.fn(async () => {
			if (offline) throw new Error('Task host is offline.');
			return {
				polls: [
					{
						id: 'code',
						status: 'completed',
						cursor: 'finished',
						title: 'Export',
						answer: 'Export complete.',
					},
				],
			};
		});
		const { host } = await fixture({
			pollTask,
			remoteRespond: async (_participant, request) => {
				if (request.notification) {
					events.push(structuredClone(request));
					return { content: 'Task status changed.', reactions: [] };
				}
				return {
					content: 'It’s running.',
					reactions: [],
					taskWatches: [{ hostId: 'workstation', threadId: 'code' }],
				};
			},
		});
		await host.command({
			type: 'create-conversation',
			id: 'remote',
			participants: [{ hostId: 'remote', botId: 'fred' }],
		});
		await send(host, 'remote');
		await host.idle();
		await host.pollTaskWatches();
		await host.idle();
		await host.pollTaskWatches();
		await host.idle();
		expect(events).toHaveLength(1);
		expect(events[0].notification).toMatchObject({
			status: 'unavailable',
			summary: 'Task host is offline.',
		});
		offline = false;
		await host.pollTaskWatches();
		await host.idle();
		await host.pollTaskWatches();
		await host.idle();
		expect(events).toHaveLength(2);
		expect(events[1].notification).toMatchObject({
			status: 'completed',
			summary: 'Export complete.',
		});
		expect(pollTask).toHaveBeenCalledTimes(3);
	});
	it('gives follow-up work a distinct operation ID when a provider reuses a tool call ID on notification', async () => {
		let requestCount = 0;
		const executeTaskTool = vi.fn(async (_name, _args, _context) => ({
			hostId: 'home',
			result: { threadId: 'code', messageId: 'task-message', promptSaved: true },
		}));
		const { host } = await fixture({
			taskToolDefinitions: () => [taskDefinition('threads_send')],
			executeTaskTool,
			pollTask: async () => ({
				polls: [
					{
						id: 'code',
						status: 'completed',
						cursor: 'finished',
						title: 'Export',
						answer: 'Export complete; verify the output.',
					},
				],
			}),
			request: async () => {
				requestCount++;
				return requestCount === 1 || requestCount === 3
					? reply('', 'responses', [
							{
								name: 'threads_send',
								args: {
									threadId: 'code',
									prompt:
										requestCount === 1 ? 'Export the notebook.' : 'Verify the exported notebook.',
								},
							},
						])
					: reply('The task is running.');
			},
		});
		await send(host);
		await host.idle();
		await host.pollTaskWatches();
		await host.idle();
		expect(executeTaskTool).toHaveBeenCalledTimes(2);
		expect(executeTaskTool.mock.calls[0][2].userMessageId).toBe('request');
		expect(executeTaskTool.mock.calls[1][2].userMessageId).toBe('request');
		expect(executeTaskTool.mock.calls[1][2].operationId).not.toBe(
			executeTaskTool.mock.calls[0][2].operationId,
		);
	});
	it('resumes remote task watches after reopen and sends a completion event only once', async () => {
		const received: BotReplyRequest[] = [];
		const pollTask = vi.fn(async () => ({
			hostId: 'workstation',
			result: {
				polls: [
					{
						id: 'code',
						status: 'completed',
						cursor: 'finished',
						title: 'Export notebook',
						answer: 'Created notebook.png.',
					},
				],
			},
		}));
		const { host, config, filename } = await fixture({
			pollTask,
			remoteRespond: async (_participant, request) => {
				received.push(structuredClone(request));
				return request.notification
					? { content: 'Your notebook image is ready.', reactions: [] }
					: {
							content: 'I’ll let you know when it’s ready.',
							reactions: [],
							taskWatches: [{ hostId: 'workstation', threadId: 'code', afterCursor: 'working' }],
						};
			},
		});
		await host.command({
			type: 'create-conversation',
			id: 'remote',
			participants: [{ hostId: 'remote', botId: 'fred' }],
		});
		await send(host, 'remote');
		await host.idle();
		host.close();
		expect(await readFile(filename, 'utf8')).toContain('workstation');
		const reopened = new BotHost(config);
		hosts.push(reopened);
		await reopened.pollTaskWatches();
		await reopened.idle();
		await reopened.pollTaskWatches();
		await reopened.idle();
		expect(pollTask).toHaveBeenCalledTimes(1);
		expect(received).toHaveLength(2);
		expect(received[1]).toMatchObject({
			userMessageId: 'request',
			notification: {
				type: 'thread',
				hostId: 'workstation',
				threadId: 'code',
				cursor: 'finished',
				status: 'completed',
				title: 'Export notebook',
				summary: 'Created notebook.png.',
			},
		});
		expect(received[1].messages.filter((message) => message.role === 'user')).toHaveLength(1);
		expect((await messages(reopened, 'remote')).at(-1)?.content).toBe(
			'Your notebook image is ready.',
		);
	});
	it.each(['threads_send', 'threads_create', 'threads_wait', 'threads_watch'])(
		'watches an opaque auto-created task ID handled by %s',
		async (name) => {
			const requests: WireRequest[] = [];
			const pollTask = vi.fn(async () => ({
				polls: [
					{
						id: createdThreadId,
						status: 'waiting_for_input',
						cursor: 'question',
						title: 'Notebook',
						answer: 'Choose PNG or JPEG.',
					},
				],
			}));
			const { host } = await fixture({
				pollTask,
				taskToolDefinitions: () => [
					taskDefinition(name === 'threads_watch' ? 'threads_wait' : name),
				],
				executeTaskTool: async () => ({
					hostId: 'home',
					result:
						name === 'threads_wait' || name === 'threads_watch'
							? {
									polls: [
										{
											id: createdThreadId,
											status: 'working',
											cursor: 'running',
											title: 'Notebook',
										},
									],
								}
							: {
									threadId: createdThreadId,
									messageId: 'task-message',
									promptSaved: true,
									delivery: { status: 'accepted' },
								},
				}),
				request: async (wire) => {
					requests.push(structuredClone(wire));
					return requests.length === 1
						? reply('', 'responses', [
								{
									name,
									args:
										name === 'threads_watch'
											? { hostId: 'home', threadId: createdThreadId }
											: {
													hostId: 'home',
													threadId: createdThreadId,
													prompt: 'Export.',
													targets: [{ threadId: createdThreadId }],
													timeoutMs: 0,
												},
								},
							])
						: reply(
								requests.length === 2
									? 'It’s running.'
									: 'The task needs your choice: PNG or JPEG?',
							);
				},
			});
			await send(host);
			await host.idle();
			await host.pollTaskWatches();
			await host.idle();
			expect(pollTask).toHaveBeenCalledTimes(1);
			expect(requests).toHaveLength(3);
			expect((await messages(host)).at(-1)?.content).toBe(
				'The task needs your choice: PNG or JPEG?',
			);
			expect(JSON.stringify(requests[2].body)).toContain('Choose PNG or JPEG.');
		},
	);
});

describe('bot read receipts', () => {
	it('marks a local message read when the provider request starts, before a reply completes', async () => {
		const definitions = deferred(),
			started = deferred(),
			finish = deferred();
		const { host } = await fixture({
			executeTaskTool: async () => ({}),
			taskToolDefinitions: async () => {
				await definitions.promise;
				return [];
			},
			request: async () => {
				started.resolve();
				await finish.promise;
				return reply('Done.');
			},
		});
		await send(host);
		expect((await messages(host))[0].readBy ?? []).toHaveLength(0);
		definitions.resolve();
		await started.promise;
		expect((await messages(host))[0].readBy).toMatchObject([
			{ hostId: 'home', botId: 'nova', readAt: expect.any(Number) },
		]);
		expect((await messages(host))[1].status).toBe('pending');
		finish.resolve();
		await host.idle();
	});
	it('uses a remote bot reported read time instead of inventing one on delivery', async () => {
		const started = deferred(),
			finish = deferred();
		const readAt = Date.now();
		const { host } = await fixture({
			remoteRespond: async () => {
				started.resolve();
				await finish.promise;
				return { content: 'Received.', reactions: [], readAt };
			},
		});
		await host.command({
			type: 'create-conversation',
			id: 'remote',
			participants: [{ hostId: 'remote', botId: 'fred' }],
		});
		await send(host, 'remote');
		await started.promise;
		expect((await messages(host, 'remote'))[0].readBy ?? []).toHaveLength(0);
		finish.resolve();
		await host.idle();
		expect((await messages(host, 'remote'))[0].readBy).toEqual([
			{ hostId: 'remote', botId: 'fred', readAt },
		]);
	});
});
