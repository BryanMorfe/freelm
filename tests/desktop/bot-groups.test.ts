import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BotHost, type BotHostOptions } from '../../electron/bot-host';
import type { BotProfile, BotReplyRequest, BotReplyResult } from '../../src/bot-types';
import type { WireRequest, WireResponse } from '../../src/types';
import { initialState } from '../../src/lib/state';

const hosts: BotHost[] = [],
	folders: string[] = [];
afterEach(async () => {
	for (const host of hosts.splice(0)) host.close();
	await Promise.all(
		folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
	);
});
const silent = (): BotReplyResult => ({ content: '', reactions: [], silent: true });
const profile = (id: string): BotProfile => ({
	memoryEnabled: false,
	id,
	name: id.toUpperCase(),
	address: `${id}@freelm`,
	color: '#abcdef',
	identity: 'A friendly collaborator.',
	learnedPersonality: '',
	enabled: true,
	historyAccess: false,
	personalityLearning: false,
	connectionId: 'connection',
	model: 'test-model',
	createdAt: 1,
	updatedAt: 1,
});
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
async function remoteGroup(
	respond: (request: BotReplyRequest, signal?: AbortSignal) => Promise<BotReplyResult>,
	ids = ['a', 'b'],
	options: Partial<BotHostOptions> = {},
) {
	const folder = await mkdtemp(path.join(os.tmpdir(), 'freelm-bot-groups-'));
	folders.push(folder);
	const requests: BotReplyRequest[] = [];
	const config: BotHostOptions = {
		filename: path.join(folder, 'mailbox.json'),
		identity: async () => ({ id: 'home', name: 'Home' }),
		workspace: async () => initialState(),
		remoteProfile: async ({ botId }) => profile(botId),
		remoteRespond: async (_participant, request, signal) => {
			requests.push(structuredClone(request));
			return respond(request, signal);
		},
		...options,
	};
	const host = new BotHost(config);
	hosts.push(host);
	await host.command({
		type: 'create-conversation',
		id: 'group',
		participants: ids.map((botId) => ({ hostId: `host-${botId}`, botId })),
	});
	return { host, requests, config };
}
const send = (host: BotHost, content = 'Introduce yourselves.', messageId = 'human') =>
	host.command({ type: 'send', conversationId: 'group', messageId, content });
const conversation = async (host: BotHost) =>
	(await host.snapshot()).conversations.find((item) => item.id === 'group')!;

async function legacyGroup(respond: (request: BotReplyRequest) => Promise<BotReplyResult>) {
	let ready = false;
	const fixture = await remoteGroup(async (request) =>
		ready
			? respond(request)
			: request.notification
				? silent()
				: { content: `Hello from ${request.botId}.`, reactions: [] },
	);
	await send(fixture.host);
	await fixture.host.idle();
	fixture.host.close();
	const stored = JSON.parse(await readFile(fixture.config.filename, 'utf8'));
	delete stored.conversations[0].groupReplyState;
	await writeFile(fixture.config.filename, JSON.stringify(stored));
	const host = new BotHost(fixture.config);
	hosts.push(host);
	await host.start();
	fixture.requests.length = 0;
	ready = true;
	return { ...fixture, host };
}

describe('optional group participation', () => {
	it('offers fresh reaction-triggered text to peers in an existing pre-upgrade group', async () => {
		const { host, requests } = await legacyGroup(async (request) =>
			request.notification?.type === 'reaction'
				? { content: 'Nice to meet you, @B.', reactions: [] }
				: request.botId === 'b'
					? { content: 'Nice to meet you too.', reactions: [] }
					: silent(),
		);
		expect((await conversation(host)).groupReplyState).toBeUndefined();
		const greeting = (await conversation(host)).messages.find(
			(item) => item.author?.botId === 'a',
		)!;
		await host.command({
			type: 'react',
			conversationId: 'group',
			messageId: greeting.id,
			emoji: '❤️',
		});
		await host.idle();
		expect(requests.map((item) => item.botId)).toEqual(['a', 'b', 'a']);
		expect(requests.slice(1).map((item) => item.notification)).toEqual([
			expect.objectContaining({ type: 'group_message', readOnly: true }),
			expect.objectContaining({ type: 'group_message', readOnly: true }),
		]);
		expect(requests[1].messages.at(-1)?.content).toBe('Nice to meet you, @B.');
		expect((await conversation(host)).groupReplyState).toEqual({
			rootMessageId: 'human',
			automaticReplies: 2,
		});
	});

	it.each(['silent', 'emoji'] as const)(
		'does not initialize or fan out legacy %s reaction acknowledgments',
		async (mode) => {
			const { host, requests } = await legacyGroup(async (request) =>
				mode === 'silent'
					? silent()
					: {
							content: '',
							reactions: [
								{
									messageId:
										request.notification?.type === 'reaction'
											? request.notification.messageId
											: 'human',
									emoji: '❤️',
								},
							],
						},
			);
			const before = await conversation(host);
			await host.command({
				type: 'react',
				conversationId: 'group',
				messageId: before.messages[1].id,
				emoji: '👍',
			});
			await host.idle();
			expect(requests).toHaveLength(1);
			expect((await conversation(host)).groupReplyState).toBeUndefined();
			expect((await conversation(host)).messages).toHaveLength(before.messages.length);
		},
	);

	it('remembers Stop on a legacy group before any new reply initializes its state', async () => {
		const { host, requests } = await legacyGroup(async (request) =>
			request.notification?.type === 'reaction'
				? { content: 'Thanks, @B.', reactions: [] }
				: silent(),
		);
		await host.command({ type: 'stop', conversationId: 'group' });
		expect((await conversation(host)).groupReplyState).toEqual({
			rootMessageId: 'human',
			automaticReplies: 0,
			paused: 'stopped',
		});
		await host.command({
			type: 'react',
			conversationId: 'group',
			messageId: (await conversation(host)).messages[1].id,
			emoji: '❤️',
		});
		await host.idle();
		expect(requests).toHaveLength(1);
		expect((await conversation(host)).groupReplyState?.paused).toBe('stopped');
		await send(host, 'A fresh message.', 'fresh');
		await host.idle();
		expect((await conversation(host)).groupReplyState).toEqual({
			rootMessageId: 'fresh',
			automaticReplies: 0,
		});
	});

	it.each(['stopped', 'limit'] as const)(
		'reaction-triggered text cannot reset a %s group exchange',
		async (paused) => {
			const { host, requests } = await remoteGroup(async () => ({
				content: 'A short reply.',
				reactions: [],
			}));
			await host.command({
				type: 'update-conversation',
				conversationId: 'group',
				groupReplyLimit: 1,
			});
			await send(host);
			await host.idle();
			if (paused === 'stopped') await host.command({ type: 'stop', conversationId: 'group' });
			const before = await conversation(host),
				count = requests.length;
			await host.command({
				type: 'react',
				conversationId: 'group',
				messageId: before.messages[1].id,
				emoji: '❤️',
			});
			await host.idle();
			expect(requests).toHaveLength(count + 1);
			expect((await conversation(host)).groupReplyState).toEqual(before.groupReplyState);
			expect((await conversation(host)).groupReplyState?.paused).toBe(paused);
		},
	);

	it('does not reopen an older human root when a reaction produces new text', async () => {
		const { host, requests } = await legacyGroup(async (request) =>
			request.notification?.type === 'reaction'
				? { content: 'Hello again, @B.', reactions: [] }
				: silent(),
		);
		const oldGreeting = (await conversation(host)).messages[1];
		await send(host, 'A newer request.', 'new-human');
		await host.idle();
		requests.length = 0;
		await host.command({
			type: 'react',
			conversationId: 'group',
			messageId: oldGreeting.id,
			emoji: '❤️',
		});
		await host.idle();
		expect(requests).toHaveLength(1);
		expect((await conversation(host)).groupReplyState).toEqual({
			rootMessageId: 'new-human',
			automaticReplies: 0,
		});
	});

	it('does not skip a newer unsent human message to bootstrap an older legacy exchange', async () => {
		const { host, requests, config } = await legacyGroup(async (request) =>
			request.notification?.type === 'reaction'
				? { content: 'Hello again, @B.', reactions: [] }
				: silent(),
		);
		const oldGreeting = (await conversation(host)).messages[1];
		await send(host, 'A newer request.', 'new-human');
		await host.idle();
		await host.command({ type: 'unsend', conversationId: 'group', messageId: 'new-human' });
		host.close();
		const stored = JSON.parse(await readFile(config.filename, 'utf8'));
		delete stored.conversations[0].groupReplyState;
		await writeFile(config.filename, JSON.stringify(stored));
		const reopened = new BotHost(config);
		hosts.push(reopened);
		await reopened.start();
		requests.length = 0;
		await reopened.command({
			type: 'react',
			conversationId: 'group',
			messageId: oldGreeting.id,
			emoji: '❤️',
		});
		await reopened.idle();
		expect(requests).toHaveLength(1);
		expect((await conversation(reopened)).groupReplyState).toBeUndefined();
	});

	it('keeps the stricter reaction provenance when a new message coalesces into a queued peer turn', async () => {
		const started = deferred(),
			release = deferred();
		const { host, requests } = await remoteGroup(
			async (request) => {
				if (!request.notification) {
					if (request.botId === 'c') {
						started.resolve();
						await release.promise;
					}
					return { content: `Hello from ${request.botId}.`, reactions: [] };
				}
				return request.notification.type === 'reaction' && request.botId === 'a'
					? { content: 'Thanks, friends.', reactions: [] }
					: silent();
			},
			['a', 'b', 'c'],
		);
		await send(host);
		await started.promise;
		await host.command({ type: 'react', conversationId: 'group', messageId: 'human', emoji: '❤️' });
		release.resolve();
		await host.idle();
		const peerB = requests.filter(
			(item) => item.botId === 'b' && item.notification?.type === 'group_message',
		);
		expect(peerB).toHaveLength(1);
		expect(peerB[0].notification).toMatchObject({ readOnly: true });
		expect(peerB[0].messages.map((item) => item.content)).toContain('Thanks, friends.');
	});

	it('lets every participant consider a human turn while silence and reactions add no empty bubble', async () => {
		const { host, requests } = await remoteGroup(async (request) =>
			request.botId === 'a'
				? silent()
				: { content: '', reactions: [{ messageId: 'human', emoji: '👍' }] },
		);
		await send(host, '@A, please take a look.');
		await host.idle();
		expect(requests.map((item) => item.botId)).toEqual(['a', 'b']);
		for (const request of requests)
			expect(request.group?.participants).toEqual([
				{ hostId: 'host-a', botId: 'a', name: 'A', address: 'a@freelm' },
				{ hostId: 'host-b', botId: 'b', name: 'B', address: 'b@freelm' },
			]);
		const saved = await conversation(host);
		expect(saved.messages).toHaveLength(1);
		expect(saved.messages[0].mentions).toEqual([
			{ hostId: 'host-a', botId: 'a', start: 0, end: 2, label: 'A' },
		]);
		expect(saved.messages[0].reactions).toMatchObject([{ actorId: 'bot:host-b:b', emoji: '👍' }]);
		expect(saved.groupReplyState).toEqual({ rootMessageId: 'human', automaticReplies: 0 });
	});

	it('shares A -> B -> A context without separately waking B for a message its initial turn already sees', async () => {
		const { host, requests } = await remoteGroup(async (request) => {
			if (!request.notification)
				return {
					content: request.botId === 'a' ? 'Hello @B, I am A.' : 'Hello A, I am B.',
					reactions: [],
				};
			return request.botId === 'a' ? { content: 'Nice to meet you, B.', reactions: [] } : silent();
		});
		await send(host);
		await host.idle();
		expect(requests.map((item) => item.botId)).toEqual(['a', 'b', 'a', 'b']);
		expect(requests[1].notification).toBeUndefined();
		expect(requests[1].messages.map((item) => item.content)).toEqual([
			'Introduce yourselves.',
			'Hello @B, I am A.',
		]);
		expect(requests[2].notification).toMatchObject({
			type: 'group_message',
			messageId: requests[2].messages.at(-1)?.id,
		});
		expect(requests[2].messages.map((item) => item.content)).toEqual([
			'Introduce yourselves.',
			'Hello @B, I am A.',
			'Hello A, I am B.',
		]);
		expect(requests.every((item) => item.userMessageId === 'human')).toBe(true);
		const saved = await conversation(host);
		expect(saved.messages.map((item) => item.content)).toEqual([
			'Introduce yourselves.',
			'Hello @B, I am A.',
			'Hello A, I am B.',
			'Nice to meet you, B.',
		]);
		expect(saved.messages[1].mentions).toEqual([
			{ hostId: 'host-b', botId: 'b', start: 6, end: 8, label: 'B' },
		]);
		expect(saved.groupReplyState?.automaticReplies).toBe(2);
	});

	it('coalesces several peers into already queued observations', async () => {
		const { host, requests } = await remoteGroup(
			async (request) =>
				request.notification
					? silent()
					: { content: `${request.botId} introduces itself.`, reactions: [] },
			['a', 'b', 'c'],
		);
		await send(host);
		await host.idle();
		expect(requests.map((item) => item.botId)).toEqual(['a', 'b', 'c', 'a', 'b']);
		for (const request of requests.slice(3))
			expect(request.messages.map((item) => item.content)).toContain('c introduces itself.');
		expect((await conversation(host)).messages).toHaveLength(4);
	});

	it('bounds automatic followups while keeping every initial human-message turn outside the limit', async () => {
		const { host, requests, config } = await remoteGroup(async (request) => ({
			content: `Reply from ${request.botId}.`,
			reactions: [],
		}));
		await host.command({
			type: 'update-conversation',
			conversationId: 'group',
			groupReplyLimit: 2,
		});
		await send(host);
		await host.idle();
		expect(requests).toHaveLength(4);
		expect((await conversation(host)).groupReplyState).toEqual({
			rootMessageId: 'human',
			automaticReplies: 2,
			paused: 'limit',
		});
		await host.command({
			type: 'update-conversation',
			conversationId: 'group',
			groupReplyLimit: 4,
		});
		await host.idle();
		expect(requests).toHaveLength(4);
		host.close();
		const reopened = new BotHost(config);
		hosts.push(reopened);
		await reopened.start();
		expect((await conversation(reopened)).groupReplyState?.paused).toBe('limit');
		expect((await conversation(reopened)).groupReplyLimit).toBe(4);
		await send(reopened, 'Start a new exchange.', 'next');
		await reopened.idle();
		expect(requests).toHaveLength(10);
		expect((await conversation(reopened)).groupReplyState?.rootMessageId).toBe('next');
	});

	it('stops active and queued turns, rejects late output, and resumes only on a new human message', async () => {
		const started = deferred(),
			release = deferred();
		let firstSignal: AbortSignal | undefined;
		const { host, requests } = await remoteGroup(async (request, signal) => {
			if (request.userMessageId !== 'human') return silent();
			firstSignal = signal;
			started.resolve();
			await release.promise;
			return { content: 'Late output must not return.', reactions: [] };
		});
		await send(host);
		await started.promise;
		await host.command({ type: 'stop', conversationId: 'group' });
		expect(firstSignal?.aborted).toBe(true);
		expect((await conversation(host)).messages).toHaveLength(1);
		expect((await conversation(host)).groupReplyState?.paused).toBe('stopped');
		release.resolve();
		await host.idle();
		expect(requests).toHaveLength(1);
		await send(host, 'Fresh request.', 'fresh');
		await host.idle();
		expect(requests.map((item) => item.userMessageId)).toEqual(['human', 'fresh', 'fresh']);
		expect((await conversation(host)).messages.map((item) => item.content)).toEqual([
			'Introduce yourselves.',
			'Fresh request.',
		]);
	});

	it.each(['stopped', 'limit'] as const)(
		'an explicit failed-peer retry cannot reopen a %s exchange',
		async (paused) => {
			let fail = true;
			const { host, requests } = await remoteGroup(async (request) => {
				if (request.notification?.type === 'group_message' && fail) {
					fail = false;
					throw new Error('Temporary provider failure.');
				}
				return { content: `Reply from ${request.botId}.`, reactions: [] };
			});
			await host.command({
				type: 'update-conversation',
				conversationId: 'group',
				groupReplyLimit: 1,
			});
			await send(host);
			await host.idle();
			const failed = (await conversation(host)).messages.find((item) => item.status === 'failed')!;
			expect(failed.notification?.type).toBe('group_message');
			if (paused === 'stopped') await host.command({ type: 'stop', conversationId: 'group' });
			await host.command({ type: 'retry', conversationId: 'group', messageId: failed.id });
			await host.idle();
			expect(requests).toHaveLength(4);
			expect((await conversation(host)).groupReplyState).toEqual({
				rootMessageId: 'human',
				automaticReplies: 1,
				paused,
			});
			expect((await conversation(host)).messages.some((item) => item.status === 'pending')).toBe(
				false,
			);
		},
	);

	it.each(['edit', 'unsend', 'new-message'] as const)(
		'%s cancels stale cascades without empty placeholders',
		async (action) => {
			const started = deferred(),
				release = deferred();
			let first = true;
			const { host, requests } = await remoteGroup(async () => {
				if (!first) return silent();
				first = false;
				started.resolve();
				await release.promise;
				return { content: 'Obsolete answer.', reactions: [] };
			});
			await send(host);
			await started.promise;
			if (action === 'edit')
				await host.command({
					type: 'edit',
					conversationId: 'group',
					messageId: 'human',
					content: '@B, changed my request.',
				});
			else if (action === 'unsend')
				await host.command({ type: 'unsend', conversationId: 'group', messageId: 'human' });
			else await send(host, 'New request.', 'new');
			release.resolve();
			await host.idle();
			const saved = await conversation(host);
			expect(saved.messages.every((item) => item.role === 'user')).toBe(true);
			expect(requests).toHaveLength(action === 'unsend' ? 1 : 3);
			if (action === 'edit') {
				expect(requests[1].messages.map((item) => item.content)).toEqual([
					'@B, changed my request.',
				]);
				expect(saved.messages[0].mentions?.[0].botId).toBe('b');
			}
			if (action === 'new-message')
				expect(requests[1].messages.map((item) => item.content)).toEqual([
					'Introduce yourselves.',
					'New request.',
				]);
		},
	);

	it('persists explicit mentions and draft addressing without requiring a remote profile to be online', async () => {
		let offline = false;
		const remoteProfile = vi.fn(async ({ botId }: { botId: string }) => {
			if (offline) throw new Error('offline');
			return profile(botId);
		});
		const { host } = await remoteGroup(async () => silent(), ['a', 'b'], {
			remoteProfile,
		});
		offline = true;
		remoteProfile.mockClear();
		const mention = { hostId: 'host-a', botId: 'a', start: 2, end: 4, label: 'A' };
		await host.command({
			type: 'update-conversation',
			conversationId: 'group',
			draft: '  @A hello',
			draftMentions: [mention],
		});
		expect((await conversation(host)).draftMentions).toEqual([mention]);
		expect(remoteProfile).not.toHaveBeenCalled();
		await host.command({
			type: 'send',
			conversationId: 'group',
			messageId: 'human',
			content: '  @A hello',
			mentions: [mention],
		});
		await host.idle();
		const saved = await conversation(host);
		expect(saved.messages[0].content).toBe('@A hello');
		expect(saved.messages[0].mentions).toEqual([{ ...mention, start: 0, end: 2 }]);
		expect(saved.draftMentions).toBeUndefined();
		await expect(
			host.command({
				type: 'send',
				conversationId: 'group',
				messageId: 'invalid',
				content: '@A hi',
				mentions: [{ ...mention, hostId: 'foreign', start: 0, end: 2 }],
			}),
		).rejects.toThrow('belongs to this conversation');
	});
});

function providerResponse(
	calls: { name: string; args?: unknown }[] = [],
	content = '',
): WireResponse {
	return {
		status: 200,
		encoding: 'text',
		contentType: 'application/json',
		body: JSON.stringify({
			status: 'completed',
			output: [
				...calls.map((call, index) => ({
					type: 'function_call',
					name: call.name,
					call_id: `call-${index}`,
					arguments: JSON.stringify(call.args ?? {}),
				})),
				...(content
					? [
							{
								type: 'message',
								role: 'assistant',
								content: [{ type: 'output_text', text: content }],
							},
						]
					: []),
			],
		}),
	};
}

it('offers real local bot_silence on initial group turns and retains reaction-only results', async () => {
	const state = initialState();
	state.connections[0].id = 'connection';
	state.connections[0].chatApi = 'responses';
	state.connections[0].catalog = [
		{
			id: 'test-model',
			name: 'Test model',
			enabled: true,
			tasks: ['chat'],
			inputModalities: ['text'],
			outputModalities: ['text'],
			thinkingModes: [
				{ id: 'low', name: 'Low', parameters: { responses: { reasoning: { effort: 'low' } } } },
			],
		},
	];
	let count = 0;
	const request = vi.fn(async (wire: WireRequest) => {
		expect(wire.body?.tools).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: 'bot_silence' })]),
		);
		expect(wire.body?.instructions).toContain('original human request');
		count += 1;
		return count === 1
			? providerResponse([
					{ name: 'bot_react', args: { message_id: 'human', emoji: '❤️' } },
					{ name: 'bot_silence' },
				])
			: providerResponse([{ name: 'bot_silence' }]);
	});
	const { host } = await remoteGroup(async () => silent(), ['a', 'b'], {
		workspace: async () => state,
		request,
	});
	for (const id of ['a', 'b'])
		await host.command({
			type: 'create-bot',
			id,
			profile: {
				memoryEnabled: false,
				name: id.toUpperCase(),
				identity: 'A friendly collaborator.',
				connectionId: 'connection',
				model: 'test-model',
			},
		});
	await host.command({
		type: 'create-conversation',
		id: 'local',
		participants: [
			{ hostId: 'home', botId: 'a' },
			{ hostId: 'home', botId: 'b' },
		],
	});
	await host.command({
		type: 'send',
		conversationId: 'local',
		messageId: 'human',
		content: '@A, hello.',
	});
	await host.idle();
	expect(request).toHaveBeenCalledTimes(2);
	const saved = (await host.snapshot()).conversations.find((item) => item.id === 'local')!;
	expect(saved.messages).toHaveLength(1);
	expect(saved.messages[0].reactions).toMatchObject([{ actorId: 'bot:home:a', emoji: '❤️' }]);
});

it('does not grant mutating thread, plugin, or scheduler tools to reaction-descended peer turns', async () => {
	const state = initialState();
	state.connections[0].id = 'connection';
	state.connections[0].chatApi = 'responses';
	state.connections[0].catalog = [
		{
			id: 'test-model',
			name: 'Test model',
			enabled: true,
			tasks: ['chat'],
			inputModalities: ['text'],
			outputModalities: ['text'],
			thinkingModes: [
				{ id: 'low', name: 'Low', parameters: { responses: { reasoning: { effort: 'low' } } } },
			],
		},
	];
	const definition = (name: string) => ({
		name,
		description: name,
		parameters: { type: 'object', properties: {} },
	});
	const executeTaskTool = vi.fn(),
		executePlugin = vi.fn(),
		executeSchedulerTool = vi.fn();
	let calls = 0;
	const { host } = await remoteGroup(async () => silent(), ['a', 'b'], {
		workspace: async () => state,
		taskToolDefinitions: () => [definition('threads_read'), definition('threads_send')],
		executeTaskTool,
		pluginDefinitions: () => [definition('plugin_action')],
		executePlugin,
		schedulerToolDefinitions: () => [definition('scheduler_create')],
		executeSchedulerTool,
		request: async (wire) => {
			const names = (wire.body!.tools as { name: string }[]).map((tool) => tool.name);
			expect(names).toContain('threads_read');
			expect(names).not.toContain('threads_send');
			expect(names).not.toContain('plugin_action');
			expect(names).not.toContain('scheduler_create');
			expect(wire.body!.instructions).toContain('not a new human work request');
			return calls++ === 0
				? providerResponse([
						{ name: 'threads_send' },
						{ name: 'plugin_action' },
						{ name: 'scheduler_create' },
					])
				: providerResponse([{ name: 'bot_silence' }]);
		},
	});
	await host.command({
		type: 'create-bot',
		id: 'a',
		profile: {
			memoryEnabled: false,
			name: 'A',
			identity: 'A collaborator.',
			connectionId: 'connection',
			model: 'test-model',
		},
	});
	const input: BotReplyRequest = {
		botId: 'a',
		conversationId: 'group',
		userMessageId: 'human',
		group: {
			participants: [
				{ hostId: 'home', botId: 'a', name: 'A', address: 'a@freelm' },
				{ hostId: 'host-b', botId: 'b', name: 'B', address: 'b@freelm' },
			],
		},
		notification: { id: 'peer-event', type: 'group_message', messageId: 'peer', readOnly: true },
		messages: [
			{
				id: 'human',
				role: 'user',
				content: 'Introduce yourselves.',
				status: 'completed',
				createdAt: 1,
				updatedAt: 1,
				reactions: [],
			},
			{
				id: 'peer',
				role: 'bot',
				author: { hostId: 'host-b', botId: 'b' },
				content: 'Thanks for the heart.',
				status: 'completed',
				createdAt: 2,
				updatedAt: 2,
				reactions: [],
				replyTo: 'human',
				notification: { id: 'reaction', type: 'reaction', messageId: 'human', emoji: '❤️' },
			},
		],
	};
	const result = await host.respond(input);
	expect(result.silent).toBe(true);
	expect(executeTaskTool).not.toHaveBeenCalled();
	expect(executePlugin).not.toHaveBeenCalled();
	expect(executeSchedulerTool).not.toHaveBeenCalled();
});
