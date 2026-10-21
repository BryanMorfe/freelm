import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { BotHost, type BotHostOptions } from '../../electron/bot-host';
import { BotExecutionStore } from '../../electron/bot-execution-store';
import { InstanceHost } from '../../electron/instance-host';
import { InstanceClient } from '../../electron/instance-client';
import { InstanceManager } from '../../electron/instance-manager';
import { StateStore } from '../../electron/state-store';
import { WorkspaceAuthority } from '../../electron/workspace-authority';
import { initialState } from '../../src/lib/state';
import { validateBotReplyRequest } from '../../src/lib/bots';
import type {
	BotCommand,
	BotReplyActivity,
	BotReplyRequest,
	BotSnapshot,
	BotSentMessage,
	BotGroupSendRequest,
} from '../../src/bot-types';
import type { WireRequest, WireResponse } from '../../src/types';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const token = 'bots-fixture-auth-token';
const response = (content: string): WireResponse => ({
	status: 200,
	contentType: 'application/json',
	encoding: 'text',
	body: JSON.stringify({
		status: 'completed',
		output: [
			{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: content }] },
		],
	}),
});
const silence = (): WireResponse => ({
	status: 200,
	contentType: 'application/json',
	encoding: 'text',
	body: JSON.stringify({
		status: 'completed',
		output: [
			{ type: 'function_call', call_id: 'silent-group', name: 'bot_silence', arguments: '{}' },
		],
	}),
});
function notificationFor(wire: WireRequest) {
	const block = String(wire.body?.instructions).match(
		/<freelm_notification>\n([\s\S]*?)\n<\/freelm_notification>/,
	);
	return block ? JSON.parse(block[1]) : undefined;
}
async function hostFixture(id: string, overrides: Partial<BotHostOptions> = {}) {
	const directory = await mkdtemp(path.join(tmpdir(), 'freelm-bots-remote-'));
	cleanups.push(() => rm(directory, { force: true, recursive: true }));
	const state = initialState();
	state.connections[0].id = 'connection';
	state.activeConnectionId = 'connection';
	state.connections[0].apiKey = 'owner-api-key';
	state.connections[0].catalog = [
		{
			id: 'model',
			name: 'Model',
			enabled: true,
			tasks: ['chat'],
			inputModalities: ['text'],
			outputModalities: ['text'],
			thinkingModes: [
				{ id: 'low', name: 'Low', parameters: { responses: { reasoning: { effort: 'low' } } } },
			],
		},
	];
	const store = new StateStore(path.join(directory, 'workspace.json'), {
		available: () => true,
		encrypt: (value) => Buffer.from(value),
		decrypt: (value) => value.toString(),
	});
	await store.save(state);
	const authority = new WorkspaceAuthority(store);
	const mailbox = path.join(directory, 'bots', 'mailbox.json');
	const bots = new BotHost({
		filename: mailbox,
		identity: async () => ({ id, name: `Host ${id}` }),
		workspace: () => authority.loadBotState(),
		request: async (wire) =>
			notificationFor(wire)?.type === 'group_message' ? silence() : response(`Reply from ${id}`),
		...overrides,
	});
	const host = new InstanceHost({
		instanceId: id,
		name: `Host ${id}`,
		token,
		port: 0,
		authority,
		bots,
	});
	const port = await host.start();
	cleanups.push(async () => {
		bots.close();
		await host.stop();
	});
	const url = `http://127.0.0.1:${port}`;
	const { client, info } = await InstanceClient.connect({
		transport: 'direct',
		url,
		token,
		name: id,
	});
	cleanups.push(async () => client.disconnect());
	const post = (route: string, body: unknown, headers: Record<string, string> = {}) =>
		fetch(url + route, {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
			body: JSON.stringify(body),
		});
	return { client, info, bots, url, mailbox, post, directory, authority };
}
async function createBot(client: InstanceClient, botId: string) {
	return client.botsCommand({
		type: 'create-bot',
		id: botId,
		profile: {
			name: botId,
			identity: 'Helpful and curious.',
			connectionId: 'connection',
			model: 'model',
			memoryEnabled: false,
		},
	});
}
function outreachReplyRequest(): BotReplyRequest {
	const input = peerMessageRequest();
	input.userMessageId = 'outreach';
	input.messages = [
		{
			id: 'outreach',
			role: 'bot',
			author: { hostId: 'mac', botId: 'sam' },
			content: 'Does anyone need anything?',
			createdAt: 1,
			updatedAt: 1,
			status: 'completed',
			reactions: [],
			replyTo: 'outreach',
			groupOutreach: true,
		},
	];
	input.notification = {
		id: 'outreach-notification',
		type: 'group_message',
		messageId: 'outreach',
		readOnly: true,
	};
	return input;
}
const replyRequest = (botId: string): BotReplyRequest => ({
	botId,
	conversationId: 'group',
	userMessageId: 'message',
	messages: [
		{
			id: 'message',
			role: 'user',
			content: 'Hello from the other host',
			createdAt: 1,
			updatedAt: 1,
			status: 'completed',
			reactions: [],
		},
	],
});
function peerMessageRequest(hostId = 'peer'): BotReplyRequest {
	const input = replyRequest('fred');
	input.group = {
		participants: [
			{ hostId, botId: 'fred', name: 'Fred', address: 'fred@freelm' },
			{ hostId: 'mac', botId: 'sam', name: 'Sam', address: 'sam@freelm' },
		],
	};
	input.messages.push({
		id: 'peer-message',
		role: 'bot',
		author: { hostId: 'mac', botId: 'sam' },
		content: 'Thank you for the reaction.',
		createdAt: 2,
		updatedAt: 2,
		status: 'completed',
		reactions: [],
	});
	input.notification = {
		id: 'peer-notification',
		type: 'group_message',
		messageId: 'peer-message',
		readOnly: true,
	};
	return input;
}

describe('Bots over real FreeLM instance HTTP transport', () => {
	it('accepts bounded group source metadata and rejects unknown or invalid source fields', async () => {
		const remote = await hostFixture('source-home');
		expect(remote.info.botGroupRecollection).toBe(1);
		expect(remote.info.botMemory).toBe(1);
		const input = peerMessageRequest('source-home');
		input.group!.source = { hostId: 'coordinator', title: 'Research group', updatedAt: 15 };
		expect(() => validateBotReplyRequest(input)).not.toThrow();
		for (const source of [
			null,
			{ hostId: 'bad host', title: 'Research group', updatedAt: 15 },
			{ hostId: 'coordinator', title: 'x'.repeat(257), updatedAt: 15 },
			{ hostId: 'coordinator', title: 'Research group', updatedAt: -1 },
			{ hostId: 'coordinator', title: 'Research group', updatedAt: Infinity },
			{ hostId: 'coordinator', title: 'Research group' },
			{ hostId: 'coordinator', title: 'Research group', updatedAt: 15, extra: true },
		]) {
			const invalid = { ...input, group: { ...input.group, source } };
			expect(() => validateBotReplyRequest(invalid)).toThrow('Invalid bot reply context');
			const response = await remote.post('/bots/respond', invalid);
			expect(response.status).toBe(400);
		}
	});
	it('returns only snapshots matching the paired host and propagates snapshot cancellation', async () => {
		const remote = await hostFixture('snapshot-home');
		const manager = new InstanceManager(
			path.join(remote.directory, 'snapshot-caller.json'),
			{
				available: () => true,
				encrypt: (value) => Buffer.from(value),
				decrypt: (value) => value.toString(),
			},
			remote.authority,
		);
		cleanups.push(() => manager.close());
		await manager.connect({ transport: 'direct', name: 'Home', url: remote.url, token });
		const snapshot = await remote.bots.snapshot();
		const snapshots = vi.spyOn(remote.bots, 'snapshot');
		expect(await manager.connectedBotSnapshots()).toEqual([
			{ ...snapshot, memorySupported: true, runtimeSupported: true },
		]);
		snapshots.mockResolvedValueOnce({ ...snapshot, host: { id: 'forged-home', name: 'Forged' } });
		expect(await manager.connectedBotSnapshots()).toEqual([]);
		snapshots.mockRejectedValueOnce(new Error('Temporarily unavailable'));
		expect(await manager.connectedBotSnapshots()).toEqual([]);
		// A transport failure must not disconnect a valid host or invent an empty mailbox.
		expect(await manager.connectedBotSnapshots()).toEqual([
			{ ...snapshot, memorySupported: true, runtimeSupported: true },
		]);
		let finish!: () => void;
		snapshots.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = () => resolve(snapshot);
				}),
		);
		const controller = new AbortController();
		const pending = manager.connectedBotSnapshots(controller.signal);
		const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
		await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
		controller.abort();
		await rejected;
		finish();
		await expect(manager.connectedBotSnapshots(controller.signal)).rejects.toMatchObject({
			name: 'AbortError',
		});
	});
	it('polls a remote bot task through its home host, retaining a third-host target', async () => {
		const pollTask = vi.fn(async () => ({
			hostId: 'third-host',
			result: { polls: [{ id: 'code', status: 'completed', cursor: 'done' }] },
		}));
		const remote = await hostFixture('bot-home', { pollTask });
		await createBot(remote.client, 'nova');
		const manager = new InstanceManager(
			path.join(remote.directory, 'caller-instances.json'),
			{
				available: () => true,
				encrypt: (value) => Buffer.from(value),
				decrypt: (value) => value.toString(),
			},
			remote.authority,
		);
		cleanups.push(() => manager.close());
		await manager.connect({ transport: 'direct', name: 'Bot home', url: remote.url, token });
		const watch = { hostId: 'third-host', threadId: 'code', afterCursor: 'working' };
		const result = await manager.botsPollTask({ hostId: 'bot-home', botId: 'nova' }, watch);
		expect(result).toMatchObject({
			hostId: 'third-host',
			result: { polls: [{ id: 'code', status: 'completed' }] },
		});
		expect(pollTask).toHaveBeenCalledWith(
			{ hostId: 'bot-home', botId: 'nova' },
			watch,
			expect.any(AbortSignal),
		);
		expect((await manager.status()).instances).toHaveLength(1);
		await expect(
			manager.botsPollTask({ hostId: 'third-host', botId: 'nova' }, watch),
		).rejects.toThrow('disconnected');
		expect(pollTask).toHaveBeenCalledTimes(1);
	});

	it('authenticates and bounds bot watch requests and rechecks the bot access setting', async () => {
		const pollTask = vi.fn(async () => ({
			polls: [{ id: 'code', status: 'working', cursor: 'working' }],
		}));
		const { client, info, url, post } = await hostFixture('watch-host', { pollTask });
		await createBot(client, 'nova');
		expect(info.botNotifications).toBe(1);
		const watch = { hostId: 'watch-host', threadId: 'code' };
		expect(
			(
				await fetch(url + '/bots/watch', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ botId: 'nova', watch }),
				})
			).status,
		).toBe(401);
		expect(
			(await post('/bots/watch', { botId: 'nova', watch }, { Origin: 'https://example.com' }))
				.status,
		).toBe(403);
		expect((await post('/bots/watch', { botId: 'nova', watch, forged: true })).status).toBe(400);
		expect(
			(await post('/bots/watch', { botId: 'nova', watch: { ...watch, operation: 'threads_send' } }))
				.status,
		).toBe(400);
		expect(
			(await post('/bots/watch', { botId: 'nova', watch, oversized: 'x'.repeat(8192) })).status,
		).toBe(413);
		expect(pollTask).not.toHaveBeenCalled();
		await client.botsPollTask('nova', watch);
		expect(pollTask).toHaveBeenCalledTimes(1);
		await client.botsCommand({
			type: 'update-bot',
			botId: 'nova',
			changes: { historyAccess: false },
		});
		await expect(client.botsPollTask('nova', watch)).rejects.toThrow('Thread access is disabled');
		expect(pollTask).toHaveBeenCalledTimes(1);
	});

	it('bounds watch response bytes and cancels in-flight observation when the client aborts', async () => {
		let signal: AbortSignal | undefined;
		let oversized = true;
		const { client } = await hostFixture('watch-cancel', {
			pollTask: async (_participant, _watch, currentSignal) => {
				if (oversized) return { data: 'x'.repeat(512 * 1024) };
				signal = currentSignal;
				return new Promise((_resolve, reject) =>
					currentSignal.addEventListener('abort', () => reject(new Error('Cancelled'))),
				);
			},
		});
		await createBot(client, 'nova');
		const watch = { hostId: 'watch-cancel', threadId: 'code' };
		await expect(client.botsPollTask('nova', watch)).rejects.toThrow('512 KiB');
		oversized = false;
		const controller = new AbortController();
		const pending = client.botsPollTask('nova', watch, controller.signal);
		const rejected = expect(pending).rejects.toBeDefined();
		await vi.waitFor(() => expect(signal).toBeDefined());
		controller.abort();
		await rejected;
		await vi.waitFor(() => expect(signal?.aborted).toBe(true));
	});

	it('marks HTTP bot commands and replies as remote instead of granting local execution authority', async () => {
		const { client, bots } = await hostFixture('remote-origin');
		const command = vi.spyOn(bots, 'command');
		const respond = vi.spyOn(bots, 'respond');
		await createBot(client, 'fred');
		expect(command).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'create-bot' }), true);
		await client.botsRespond(replyRequest('fred'));
		expect(respond).toHaveBeenLastCalledWith(
			replyRequest('fred'),
			expect.any(AbortSignal),
			true,
			undefined,
			undefined,
			undefined,
			true,
		);
	});

	it('negotiates support, requires authentication, and persists remote mailbox commands', async () => {
		const { client, info, bots, url, mailbox, post } = await hostFixture('owner');
		expect(info.bots).toBe(1);
		expect((await fetch(url + '/bots')).status).toBe(401);
		expect(
			(
				await fetch(url + '/bots', {
					headers: { Authorization: `Bearer ${token}`, Origin: 'https://example.com' },
				})
			).status,
		).toBe(403);
		const created = await createBot(client, 'fred');
		expect(created.snapshot.bots[0].address).toBe('fred@freelm');
		expect(created.snapshot.connections[0].apiKey).toBe('');
		await client.botsCommand({
			type: 'create-conversation',
			id: 'dm',
			participants: [{ hostId: 'owner', botId: 'fred' }],
		});
		const sent = await client.botsCommand({
			type: 'send',
			conversationId: 'dm',
			messageId: 'one',
			content: 'Hi Fred',
		});
		expect(sent.snapshot.conversations[0].messages[1].status).toBe('pending');
		await bots.idle();
		const snapshot = await client.botsSnapshot();
		expect(snapshot.conversations[0].messages[1].content).toBe('Reply from owner');
		expect(await readFile(mailbox, 'utf8')).toContain('Reply from owner');
		expect(await readFile(mailbox, 'utf8')).not.toContain('owner-api-key');
		expect(
			(
				await post('/bots/command', {
					type: 'send',
					conversationId: 'dm',
					messageId: 'two',
					content: 'Hi',
					model: 'forged',
				})
			).status,
		).toBe(400);
		await client.botsCommand({
			type: 'react',
			conversationId: 'dm',
			messageId: 'one',
			emoji: '👍',
		});
		expect((await client.botsSnapshot()).conversations[0].messages[0].reactions[0].emoji).toBe(
			'👍',
		);
	});
	it('runs a two-host group through the real authenticated reply route without copying remote identity', async () => {
		const remote = await hostFixture('workstation');
		await createBot(remote.client, 'fred');
		const local = await hostFixture('mac', {
			remoteProfile: async (participant) => {
				const snapshot = await remote.client.botsSnapshot();
				if (participant.hostId !== snapshot.host.id) throw new Error('Unknown host');
				return snapshot.bots.find((bot) => bot.id === participant.botId)!;
			},
			remoteRespond: (_participant, request, signal, onActivity) =>
				remote.client.botsRespond(request, signal, onActivity),
		});
		await createBot(local.client, 'sam');
		await local.client.botsCommand({
			type: 'create-conversation',
			id: 'group',
			participants: [
				{ hostId: 'mac', botId: 'sam' },
				{ hostId: 'workstation', botId: 'fred' },
			],
		});
		await local.client.botsCommand({
			type: 'send',
			conversationId: 'group',
			messageId: 'hello',
			content: 'Hello everyone',
		});
		await local.bots.idle();
		const snapshot = await local.client.botsSnapshot();
		expect(snapshot.conversations[0].messages.map((message) => message.content)).toEqual([
			'Hello everyone',
			'Reply from mac',
			'Reply from workstation',
		]);
		expect(snapshot.bots.map((bot) => bot.id)).toEqual(['sam']);
		expect((await remote.client.botsSnapshot()).bots.map((bot) => bot.id)).toEqual(['fred']);
		expect(
			(
				await remote.post('/bots/respond', {
					...replyRequest('fred'),
					identity: 'Overridden by sender',
				})
			).status,
		).toBe(400);
		expect((await remote.post('/bots/respond', replyRequest('sam'))).status).toBe(400);
	});
	it('delivers mentions and peer replies across hosts while allowing a quiet final turn', async () => {
		const remoteWires: WireRequest[] = [],
			localWires: WireRequest[] = [],
			remoteRequests: BotReplyRequest[] = [];
		const remote = await hostFixture('workstation', {
			request: async (wire) => {
				remoteWires.push(structuredClone(wire));
				return notificationFor(wire)?.type === 'group_message'
					? silence()
					: response('Hi Sam, I am Fred.');
			},
		});
		await createBot(remote.client, 'fred');
		const local = await hostFixture('mac', {
			request: async (wire) => {
				localWires.push(structuredClone(wire));
				return response(
					notificationFor(wire)?.type === 'group_message'
						? 'Nice to meet you, Fred.'
						: 'Hi Fred, I am Sam.',
				);
			},
			remoteProfile: async () => (await remote.client.botsSnapshot()).bots[0],
			remoteRespond: (_participant, request, signal, onActivity) => {
				remoteRequests.push(structuredClone(request));
				return remote.client.botsRespond(request, signal, onActivity);
			},
		});
		await createBot(local.client, 'sam');
		await local.client.botsCommand({
			type: 'create-conversation',
			id: 'meet',
			participants: [
				{ hostId: 'mac', botId: 'sam' },
				{ hostId: 'workstation', botId: 'fred' },
			],
		});
		const mention = { hostId: 'workstation', botId: 'fred', start: 0, end: 5, label: 'fred' };
		await local.client.botsCommand({
			type: 'send',
			conversationId: 'meet',
			messageId: 'intro',
			content: '@fred meet Sam.',
			mentions: [mention],
		});
		await local.bots.idle();
		const conversation = (await local.client.botsSnapshot()).conversations[0];
		expect(conversation.messages.map((message) => message.content)).toEqual([
			'@fred meet Sam.',
			'Hi Fred, I am Sam.',
			'Hi Sam, I am Fred.',
			'Nice to meet you, Fred.',
		]);
		expect(
			conversation.messages.every((message) => message.status === 'completed' && message.content),
		).toBe(true);
		expect(
			conversation.messages[0].readBy?.map(({ hostId, botId }) => ({ hostId, botId })),
		).toEqual([
			{ hostId: 'mac', botId: 'sam' },
			{ hostId: 'workstation', botId: 'fred' },
		]);
		expect(remote.info.botGroups).toBe(1);
		expect(remoteRequests).toHaveLength(2);
		expect(remoteRequests[0].group?.participants).toEqual([
			{ hostId: 'mac', botId: 'sam', name: 'sam', address: 'sam@freelm' },
			{ hostId: 'workstation', botId: 'fred', name: 'fred', address: 'fred@freelm' },
		]);
		expect(remoteRequests[0].messages[0].mentions).toEqual([mention]);
		expect(remoteRequests[1].notification).toMatchObject({
			type: 'group_message',
			messageId: conversation.messages[3].id,
		});
		expect(remoteRequests[1].userMessageId).toBe('intro');
		expect(localWires).toHaveLength(2);
		expect(remoteWires).toHaveLength(2);
		expect((await remote.client.botsSnapshot()).conversations).toEqual([]);
	});
	it('accepts an initial silent group reply and rejects off-roster mentions before inference', async () => {
		const request = vi.fn(async () => silence());
		const remote = await hostFixture('workstation', { request });
		await createBot(remote.client, 'fred');
		const input = replyRequest('fred');
		input.group = {
			participants: [
				{ hostId: 'workstation', botId: 'fred', name: 'Fred', address: 'fred@freelm' },
				{ hostId: 'mac', botId: 'sam', name: 'Sam', address: 'sam@freelm' },
			],
		};
		input.messages[0].content = '@Sam please handle this.';
		input.messages[0].mentions = [{ hostId: 'mac', botId: 'sam', start: 0, end: 4, label: 'Sam' }];
		await expect(remote.client.botsRespond(input)).resolves.toMatchObject({
			content: '',
			reactions: [],
			silent: true,
		});
		expect(request).toHaveBeenCalledTimes(1);
		const badMention = structuredClone(input);
		badMention.messages[0].mentions![0].hostId = 'outsider';
		expect((await remote.post('/bots/respond', badMention)).status).toBe(400);
		const wrongHome = structuredClone(input);
		wrongHome.group!.participants[0].hostId = 'other-workstation';
		expect((await remote.post('/bots/respond', wrongHome)).status).toBe(400);
		expect(request).toHaveBeenCalledTimes(1);
	});
	it('transports restricted peer notifications and rejects malformed restriction metadata before inference', async () => {
		const received: WireRequest[] = [];
		const remote = await hostFixture('workstation', {
			request: async (wire) => {
				received.push(structuredClone(wire));
				return silence();
			},
		});
		await createBot(remote.client, 'fred');
		expect(remote.info.botGroupReadOnly).toBe(1);
		const input = peerMessageRequest('workstation');
		await expect(remote.client.botsRespond(input, undefined, () => {})).resolves.toMatchObject({
			content: '',
			reactions: [],
			silent: true,
		});
		expect(received).toHaveLength(1);
		expect(notificationFor(received[0])).toMatchObject({ type: 'group_message', readOnly: true });
		expect(
			(
				await remote.post('/bots/respond', {
					...input,
					notification: { ...input.notification, readOnly: 'true' },
				})
			).status,
		).toBe(400);
		expect(received).toHaveLength(1);
	});
	it('cancels actual in-flight remote reply HTTP work when the client aborts', async () => {
		let providerSignal: AbortSignal | undefined;
		const { client } = await hostFixture('remote', {
			request: async (_wire, _chunk, signal) => {
				providerSignal = signal;
				return new Promise((_resolve, reject) =>
					signal?.addEventListener('abort', () => reject(new Error('Cancelled'))),
				);
			},
		});
		await createBot(client, 'fred');
		const controller = new AbortController();
		const result = client.botsRespond(replyRequest('fred'), controller.signal, () => {});
		const rejected = expect(result).rejects.toBeDefined();
		await vi.waitFor(() => expect(providerSignal).toBeDefined());
		controller.abort();
		await rejected;
		await vi.waitFor(() => expect(providerSignal?.aborted).toBe(true));
	});
});

/** An intentionally small protocol peer for compatibility and malformed-stream coverage. */
async function activityPeer(
	handler: (request: IncomingMessage, response: ServerResponse) => void,
	capability = true,
	groupCapabilities: {
		botGroups?: 1;
		botNotifications?: 1;
		botGroupReadOnly?: 1;
		botGroupRecollection?: 1;
		botGroupOutreach?: 1;
		botMemory?: 1;
		botRuntime?: 1;
	} = {},
) {
	const server = createServer((request, response) => {
		if (request.url === '/info') {
			response.setHeader('Content-Type', 'application/json');
			response.end(
				JSON.stringify({
					protocol: 1,
					instanceId: 'peer',
					name: 'Peer',
					bots: 1,
					...(capability ? { botActivity: 1 } : {}),
					...groupCapabilities,
				}),
			);
		} else handler(request, response);
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	cleanups.push(
		() =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			}),
	);
	const { client } = await InstanceClient.connect({
		transport: 'direct',
		url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
		token,
		name: 'Peer',
	});
	cleanups.push(async () => client.disconnect());
	return client;
}

describe('Remote bot activity phases', () => {
	it.each([false, true])(
		'negotiates persistent memory settings and commands: supported=%s',
		async (supported) => {
			const received: BotCommand[] = [];
			const snapshot: BotSnapshot = {
				host: { id: 'peer', name: 'Peer' },
				revision: 1,
				conversations: [],
				connections: [],
				bots: [
					{
						id: 'fred',
						name: 'Fred',
						address: 'fred@freelm',
						color: '#799fdf',
						identity: '',
						learnedPersonality: '',
						enabled: true,
						historyAccess: true,
						personalityLearning: true,
						connectionId: 'connection',
						model: 'model',
						createdAt: 1,
						updatedAt: 1,
					},
				],
			};
			const peer = await activityPeer(
				async (request, response) => {
					response.setHeader('Content-Type', 'application/json');
					if (request.url === '/bots') {
						response.end(JSON.stringify(snapshot));
						return;
					}
					let body = '';
					for await (const chunk of request) body += chunk;
					received.push(JSON.parse(body));
					response.end(JSON.stringify({ snapshot }));
				},
				false,
				supported ? { botMemory: 1 } : {},
			);
			const loaded = await peer.botsSnapshot();
			expect(loaded.memorySupported).toBe(supported);
			expect(loaded.bots[0].memoryEnabled).toBe(supported ? undefined : false);
			const create: BotCommand = {
				type: 'create-bot',
				profile: {
					name: 'Fred',
					identity: '',
					connectionId: 'connection',
					model: 'model',
					memoryEnabled: true,
				},
			};
			const update: BotCommand = {
				type: 'update-bot',
				botId: 'fred',
				changes: { name: 'Frederick', memoryEnabled: true },
			};
			const created = await peer.botsCommand(create);
			const updated = await peer.botsCommand(update);
			expect(created.snapshot.memorySupported).toBe(supported);
			expect(updated.snapshot.bots[0].memoryEnabled).toBe(supported ? undefined : false);
			expect(received[0]).toEqual(
				supported
					? create
					: {
							...create,
							profile: { name: 'Fred', identity: '', connectionId: 'connection', model: 'model' },
						},
			);
			expect(received[1]).toEqual(
				supported ? update : { ...update, changes: { name: 'Frederick' } },
			);
			expect(create.profile.memoryEnabled).toBe(true);
			expect(update.changes.memoryEnabled).toBe(true);
			for (const command of [
				{ type: 'update-memory', botId: 'fred', memoryId: 'memory', content: 'Corrected fact.' },
				{ type: 'delete-memory', botId: 'fred', memoryId: 'memory' },
			] satisfies BotCommand[]) {
				if (supported)
					await expect(peer.botsCommand(command)).resolves.toMatchObject({
						snapshot: { memorySupported: true },
					});
				else
					await expect(peer.botsCommand(command)).rejects.toThrow(
						'Update FreeLM on this bot’s home computer to manage persistent memories',
					);
			}
			expect(received).toHaveLength(supported ? 4 : 2);
		},
	);
	it.each([
		{ streaming: false, recollection: false },
		{ streaming: true, recollection: false },
		{ streaming: false, recollection: true },
		{ streaming: true, recollection: true },
	])(
		'negotiates group recollection metadata for $streaming streaming/$recollection support',
		async ({ streaming, recollection }) => {
			const received: BotReplyRequest[] = [];
			const peer = await activityPeer(
				async (request, response) => {
					let body = '';
					for await (const chunk of request) body += chunk;
					received.push(JSON.parse(body));
					const result = { content: 'Hello from the group.', reactions: [] };
					if (streaming) {
						response.setHeader('Content-Type', 'text/event-stream');
						response.end(`event: result\ndata: ${JSON.stringify(result)}\n\n`);
					} else {
						response.setHeader('Content-Type', 'application/json');
						response.end(JSON.stringify(result));
					}
				},
				streaming,
				{ botGroups: 1, ...(recollection ? { botGroupRecollection: 1 } : {}) },
			);
			const input = peerMessageRequest();
			delete input.notification;
			input.group!.source = { hostId: 'coordinator', title: 'Research group', updatedAt: 15 };
			await expect(
				peer.botsRespond(input, undefined, streaming ? () => {} : undefined),
			).resolves.toMatchObject({ content: 'Hello from the group.' });
			expect(received).toHaveLength(1);
			expect(received[0].group?.participants).toEqual(input.group!.participants);
			expect(received[0].group?.source).toEqual(recollection ? input.group!.source : undefined);
			expect(input.group!.source.title).toBe('Research group');
		},
	);
	it('requires restricted-group support only for reaction-derived peer notifications', async () => {
		const received: BotReplyRequest[] = [];
		const peer = await activityPeer(
			async (request, response) => {
				let body = '';
				for await (const chunk of request) body += chunk;
				received.push(JSON.parse(body));
				response.setHeader('Content-Type', 'application/json');
				response.end(JSON.stringify({ content: '', reactions: [], silent: true }));
			},
			false,
			{ botGroups: 1, botNotifications: 1 },
		);
		const input = peerMessageRequest();
		await expect(peer.botsRespond(input)).rejects.toThrow('preserve reaction permissions');
		const laterHumanTurn = structuredClone(input);
		delete laterHumanTurn.notification;
		laterHumanTurn.messages.push({
			id: 'restricted-history',
			role: 'bot',
			author: { hostId: 'peer', botId: 'fred' },
			content: 'Glad that helped.',
			createdAt: 3,
			updatedAt: 3,
			status: 'completed',
			reactions: [],
			notification: input.notification,
		});
		await expect(peer.botsRespond(laterHumanTurn)).rejects.toThrow('preserve reaction permissions');
		expect(received).toHaveLength(0);
		input.notification = {
			id: 'peer-notification',
			type: 'group_message',
			messageId: 'peer-message',
		};
		await expect(peer.botsRespond(input)).resolves.toMatchObject({ silent: true });
		expect(received).toHaveLength(1);
		expect(received[0].notification).toEqual(input.notification);
	});
	it('strips empty mention metadata from ordinary DM commands to older peers', async () => {
		const received: unknown[] = [];
		const peer = await activityPeer(async (request, response) => {
			let body = '';
			for await (const chunk of request) body += chunk;
			received.push(JSON.parse(body));
			response.setHeader('Content-Type', 'application/json');
			response.end(
				JSON.stringify({
					snapshot: {
						host: { id: 'peer', name: 'Peer' },
						revision: 0,
						bots: [],
						conversations: [],
						connections: [],
					},
				}),
			);
		}, false);
		const send = {
			type: 'send' as const,
			conversationId: 'dm',
			messageId: 'one',
			content: 'Hello',
			mentions: [],
		};
		await peer.botsCommand(send);
		await peer.botsCommand({
			type: 'edit',
			conversationId: 'dm',
			messageId: 'one',
			content: 'Updated hello',
			mentions: [],
		});
		await peer.botsCommand({
			type: 'update-conversation',
			conversationId: 'dm',
			draft: 'Unsent hello',
			draftMentions: [],
		});
		expect(received).toEqual([
			{ type: 'send', conversationId: 'dm', messageId: 'one', content: 'Hello' },
			{ type: 'edit', conversationId: 'dm', messageId: 'one', content: 'Updated hello' },
			{ type: 'update-conversation', conversationId: 'dm', draft: 'Unsent hello' },
		]);
		expect(send.mentions).toEqual([]);
	});
	it('requires a group-aware peer without breaking ordinary legacy replies', async () => {
		let requests = 0;
		const peer = await activityPeer((_request, response) => {
			requests += 1;
			response.setHeader('Content-Type', 'application/json');
			response.end(JSON.stringify({ content: 'Legacy direct reply.', reactions: [] }));
		}, false);
		const input = replyRequest('fred');
		input.group = {
			participants: [
				{ hostId: 'peer', botId: 'fred', name: 'Fred', address: 'fred@freelm' },
				{ hostId: 'mac', botId: 'sam', name: 'Sam', address: 'sam@freelm' },
			],
		};
		await expect(peer.botsRespond(input)).rejects.toThrow(
			'Update FreeLM on this bot’s home computer',
		);
		await expect(peer.botsCommand({ type: 'stop', conversationId: 'group' })).rejects.toThrow(
			'Update FreeLM on this conversation’s computer',
		);
		await expect(
			peer.botsCommand({
				type: 'send',
				conversationId: 'group',
				messageId: 'one',
				content: '@Fred hi',
				mentions: [{ hostId: 'peer', botId: 'fred', label: 'Fred', start: 0, end: 5 }],
			}),
		).rejects.toThrow('Update FreeLM');
		expect(requests).toBe(0);
		await expect(peer.botsRespond(replyRequest('fred'))).resolves.toMatchObject({
			content: 'Legacy direct reply.',
		});
		expect(requests).toBe(1);
	});
	it('persists observed remote phases in the conversation owner mailbox without leaking drafts', async () => {
		let writeReply!: () => void;
		let completeReply!: () => void;
		const remote = await hostFixture('writer', {
			request: async (_wire, onChunk) => {
				const emit = (value: unknown) => onChunk?.(`data: ${JSON.stringify(value)}\n\n`);
				emit({ type: 'response.reasoning_text.delta', delta: 'Private reasoning' });
				await new Promise<void>((resolve) => {
					writeReply = resolve;
				});
				emit({ type: 'response.output_text.delta', delta: 'Hello there.' });
				await new Promise<void>((resolve) => {
					completeReply = resolve;
				});
				emit({ type: 'response.completed', response: { status: 'completed', output: [] } });
				return { status: 200, contentType: 'text/event-stream', encoding: 'text', body: '' };
			},
		});
		await createBot(remote.client, 'fred');
		const changed = vi.fn();
		const local = await hostFixture('reader', {
			onChanged: changed,
			remoteProfile: async () => (await remote.client.botsSnapshot()).bots[0],
			remoteRespond: (_participant, request, signal, onActivity) =>
				remote.client.botsRespond(request, signal, onActivity),
		});
		await local.client.botsCommand({
			type: 'create-conversation',
			id: 'dm',
			participants: [{ hostId: 'writer', botId: 'fred' }],
		});
		await local.client.botsCommand({
			type: 'send',
			conversationId: 'dm',
			messageId: 'one',
			content: 'Hi Fred',
		});
		await vi.waitFor(async () => {
			expect(writeReply).toBeTypeOf('function');
			expect((await local.client.botsSnapshot()).conversations[0].messages[1]).toMatchObject({
				status: 'pending',
				activity: 'thinking',
				content: '',
			});
		});
		const notificationsBeforeWriting = changed.mock.calls.length;
		writeReply();
		await vi.waitFor(async () => {
			expect((await local.client.botsSnapshot()).conversations[0].messages[1]).toMatchObject({
				status: 'pending',
				activity: 'writing',
				content: '',
			});
		});
		expect(changed.mock.calls.length).toBeGreaterThan(notificationsBeforeWriting);
		completeReply();
		await local.bots.idle();
		const reply = (await local.client.botsSnapshot()).conversations[0].messages[1];
		expect(reply).toMatchObject({ status: 'completed', content: 'Hello there.' });
		expect(reply.activity).toBeUndefined();
		expect(await readFile(local.mailbox, 'utf8')).not.toContain('Private reasoning');
	});
	it('streams only enum phases before the final message through the authenticated manager', async () => {
		const remote = await hostFixture('activity-home');
		await createBot(remote.client, 'fred');
		expect(remote.info.botActivity).toBe(1);
		let finish!: () => void;
		let continueWriting!: () => void;
		vi.spyOn(remote.bots, 'respond').mockImplementation(
			async (_input, _signal, origin, _onRead, onActivity) => {
				expect(origin).toBe(true);
				onActivity?.('thinking');
				await new Promise<void>((resolve) => {
					continueWriting = resolve;
				});
				onActivity?.('writing');
				await new Promise<void>((resolve) => {
					finish = resolve;
				});
				return { content: 'Here is the reply.', reactions: [] };
			},
		);
		const manager = new InstanceManager(
			path.join(remote.directory, 'activity-caller.json'),
			{
				available: () => true,
				encrypt: (value) => Buffer.from(value),
				decrypt: (value) => value.toString(),
			},
			remote.authority,
		);
		cleanups.push(() => manager.close());
		await manager.connect({ transport: 'direct', name: 'Home', url: remote.url, token });
		const phases: BotReplyActivity[] = [];
		let completed = false;
		const pending = manager
			.botsRespond(
				{ hostId: 'activity-home', botId: 'fred' },
				replyRequest('fred'),
				undefined,
				(phase) => phases.push(phase),
			)
			.then((result) => {
				completed = true;
				return result;
			});
		await vi.waitFor(() => expect(phases).toEqual(['thinking']));
		expect(completed).toBe(false);
		continueWriting();
		await vi.waitFor(() => expect(phases).toEqual(['thinking', 'writing']));
		expect(completed).toBe(false);
		finish();
		expect(await pending).toEqual({ content: 'Here is the reply.', reactions: [] });
	});

	it.each([false, true])(
		'keeps JSON peers compatible without invented phases (advertised: %s)',
		async (capability) => {
			const peer = await activityPeer((request, response) => {
				expect(request.headers.authorization).toBe(`Bearer ${token}`);
				expect(request.headers.accept).toBe(capability ? 'text/event-stream' : '*/*');
				response.setHeader('Content-Type', 'application/json');
				response.end(JSON.stringify({ content: 'Old host reply.', reactions: [] }));
			}, capability);
			const onActivity = vi.fn();
			expect(await peer.botsRespond(replyRequest('fred'), undefined, onActivity)).toEqual({
				content: 'Old host reply.',
				reactions: [],
			});
			expect(onActivity).not.toHaveBeenCalled();
		},
	);

	it('decodes split UTF-8, CRLF, and buffered final events before EOF', async () => {
		const peer = await activityPeer((_request, response) => {
			response.setHeader('Content-Type', 'text/event-stream');
			response.write('event: activity\r\ndata: {"activity":"thinking"}\r\n\r\n');
			const final = Buffer.from('event: result\r\ndata: {"content":"I’m ready.","reactions":[]}');
			const split = final.indexOf(Buffer.from('’')) + 1;
			response.write(final.subarray(0, split));
			setTimeout(() => response.end(final.subarray(split)), 5);
		});
		const phases = vi.fn();
		expect(await peer.botsRespond(replyRequest('fred'), undefined, phases)).toEqual({
			content: 'I’m ready.',
			reactions: [],
		});
		expect(phases.mock.calls).toEqual([['thinking']]);
	});

	it.each([
		[
			'unknown phase',
			'event: activity\ndata: {"activity":"reasoning-secret"}\n\n',
			/invalid activity/,
		],
		[
			'extra data',
			'event: activity\ndata: {"activity":"writing","text":"secret"}\n\n',
			/invalid activity/,
		],
		['invalid JSON', 'event: activity\ndata: {\n\n', /malformed activity/],
		['EOF', 'event: activity\ndata: {"activity":"thinking"}\n\n', /before the bot reply completed/],
		['invalid result', 'event: result\ndata: {"content":"bad"}\n\n', /invalid reply/],
		[
			'explicit failure',
			'event: error\ndata: {"message":"Provider unavailable"}\n\n',
			/Provider unavailable/,
		],
		[
			'duplicate completion',
			'event: result\ndata: {"content":"done","reactions":[]}\n\nevent: result\ndata: {"content":"done","reactions":[]}\n\n',
			/after its final reply/,
		],
	] as const)('rejects %s safely', async (_label, data, expected) => {
		const peer = await activityPeer((_request, response) => {
			response.setHeader('Content-Type', 'text/event-stream');
			response.end(data);
		});
		await expect(peer.botsRespond(replyRequest('fred'), undefined, () => {})).rejects.toThrow(
			expected,
		);
	});

	it('bounds activity streams and surfaces decoder failures', async () => {
		let oversized = true;
		const peer = await activityPeer((_request, response) => {
			response.setHeader('Content-Type', 'text/event-stream');
			response.end(oversized ? 'x'.repeat(1024 * 1024 + 1) : Buffer.from([0xc3]));
		});
		await expect(peer.botsRespond(replyRequest('fred'), undefined, () => {})).rejects.toThrow(
			'too large',
		);
		oversized = false;
		await expect(peer.botsRespond(replyRequest('fred'), undefined, () => {})).rejects.toThrow(
			'incomplete UTF-8',
		);
	});

	it('preserves authenticated HTTP failures when requesting an activity stream', async () => {
		const peer = await activityPeer((_request, response) => {
			response.writeHead(401, { 'Content-Type': 'application/json' });
			response.end(JSON.stringify({ error: 'Invalid FreeLM access token.' }));
		});
		await expect(peer.botsRespond(replyRequest('fred'), undefined, () => {})).rejects.toThrow(
			'Invalid FreeLM access token',
		);
		expect(peer.connected).toBe(false);
	});
});

describe('Remote durable bot runtime', () => {
	const first: BotSentMessage = {
		id: 'explicit-first',
		content: 'I’ll check that now.',
		createdAt: 123,
	};
	it('delivers explicit text before work completes and deduplicates its final replay through the manager', async () => {
		const remote = await hostFixture('runtime-home');
		await createBot(remote.client, 'fred');
		expect(remote.info.botRuntime).toBe(1);
		let finish!: () => void;
		vi.spyOn(remote.bots, 'respond').mockImplementation(
			async (_input, _signal, origin, _onRead, onActivity, onMessage, runtimeSupported) => {
				expect(origin).toBe(true);
				expect(runtimeSupported).toBe(true);
				onActivity?.('thinking');
				await onMessage?.(first);
				await new Promise<void>((resolve) => {
					finish = resolve;
				});
				return { content: 'The result is ready.', reactions: [], messages: [first] };
			},
		);
		const manager = new InstanceManager(
			path.join(remote.directory, 'runtime-caller.json'),
			{
				available: () => true,
				encrypt: (value) => Buffer.from(value),
				decrypt: (value) => value.toString(),
			},
			remote.authority,
		);
		cleanups.push(() => manager.close());
		await manager.connect({ transport: 'direct', name: 'Home', url: remote.url, token });
		const delivered: BotSentMessage[] = [];
		let completed = false;
		const pending = manager
			.botsRespond(
				{ hostId: 'runtime-home', botId: 'fred' },
				replyRequest('fred'),
				undefined,
				undefined,
				async (message) => {
					delivered.push(message);
				},
			)
			.then((result) => {
				completed = true;
				return result;
			});
		await vi.waitFor(() => expect(delivered).toEqual([first]));
		expect(completed).toBe(false);
		finish();
		expect((await pending).content).toBe('The result is ready.');
		expect(delivered).toEqual([first]);
	});
	it.each([false, true])(
		'folds explicit messages for a legacy client, streaming=%s',
		async (streaming) => {
			const remote = await hostFixture('runtime-home');
			await createBot(remote.client, 'fred');
			vi.spyOn(remote.bots, 'respond').mockImplementation(
				async (_input, _signal, _origin, _onRead, _activity, onMessage, runtimeSupported) => {
					expect(runtimeSupported).toBe(false);
					expect(onMessage).toBeUndefined();
					return { content: '', silent: true, reactions: [], messages: [first] };
				},
			);
			const result = await remote.post(
				'/bots/respond',
				replyRequest('fred'),
				streaming ? { Accept: 'text/event-stream' } : {},
			);
			expect(result.status).toBe(200);
			const body = await result.text();
			const value = streaming ? JSON.parse(body.split('data: ')[1].trim()) : JSON.parse(body);
			expect(value).toEqual({ content: first.content, reactions: [] });
		},
	);
	it('replays a JSON fallback message once when a paired host no longer streams', async () => {
		const peer = await activityPeer(
			(request, response) => {
				expect(request.headers['x-freelm-bot-runtime']).toBe('1');
				response.setHeader('Content-Type', 'application/json');
				response.end(JSON.stringify({ content: 'Done.', reactions: [], messages: [first, first] }));
			},
			false,
			{ botRuntime: 1 },
		);
		const delivered: BotSentMessage[] = [];
		await peer.botsRespond(replyRequest('fred'), undefined, undefined, async (message) => {
			delivered.push(message);
		});
		expect(delivered).toEqual([first]);
	});
	it.each([
		['invalid', { id: 'bad', content: 'x', createdAt: -1 }, /invalid explicit message/],
		['changed', { ...first, content: 'Changed text' }, /changed an already delivered message/],
	] as const)('rejects %s explicit messages', async (_name, second, error) => {
		const peer = await activityPeer(
			(_request, response) => {
				response.setHeader('Content-Type', 'text/event-stream');
				response.end(
					`event: message\ndata: ${JSON.stringify(first)}\n\nevent: message\ndata: ${JSON.stringify(second)}\n\n`,
				);
			},
			false,
			{ botRuntime: 1 },
		);
		await expect(
			peer.botsRespond(replyRequest('fred'), undefined, undefined, async () => {}),
		).rejects.toThrow(error);
	});
	it('blocks job commands and job notifications to old hosts before network execution', async () => {
		const handler = vi.fn((_request: IncomingMessage, response: ServerResponse) =>
			response.end('{}'),
		);
		const peer = await activityPeer(handler, false);
		await expect(
			peer.botsCommand({ type: 'job-cancel', conversationId: 'group', jobId: 'job' }),
		).rejects.toThrow(/background jobs/);
		await expect(
			peer.botsRespond({
				...replyRequest('fred'),
				notification: {
					id: 'event',
					type: 'job',
					jobId: 'job',
					status: 'succeeded',
					summary: 'Finished',
				},
			}),
		).rejects.toThrow(/background job updates/);
		expect(handler).not.toHaveBeenCalled();
	});
});

it('validates host-qualified direct mailbox source and strips it only for legacy peers', async () => {
	const input = {
		...replyRequest('fred'),
		source: { hostId: 'source-home', title: 'Direct conversation', updatedAt: 123 },
	};
	expect(() => validateBotReplyRequest(input)).not.toThrow();
	for (const source of [
		{ ...input.source, hostId: '' },
		{ ...input.source, updatedAt: -1 },
		{ ...input.source, extra: true },
	])
		expect(() => validateBotReplyRequest({ ...input, source })).toThrow();
	for (const supported of [false, true]) {
		let received: BotReplyRequest | undefined;
		const peer = await activityPeer(
			async (request, response) => {
				let body = '';
				for await (const chunk of request) body += chunk;
				received = JSON.parse(body);
				response.setHeader('Content-Type', 'application/json');
				response.end(JSON.stringify({ content: 'Okay.', reactions: [] }));
			},
			false,
			supported ? { botRuntime: 1 } : {},
		);
		await peer.botsRespond(input);
		expect(received?.source).toEqual(supported ? input.source : undefined);
	}
	expect(input.source.hostId).toBe('source-home');
});

it('retains streamed messages in the final result when only an activity callback is requested', async () => {
	const message = { id: 'early', content: 'Started.', createdAt: 123 };
	const peer = await activityPeer(
		(_request, response) => {
			response.setHeader('Content-Type', 'text/event-stream');
			response.end(
				`event: message\ndata: ${JSON.stringify(message)}\n\nevent: result\ndata: ${JSON.stringify({ content: 'Done.', reactions: [], messages: [message] })}\n\n`,
			);
		},
		true,
		{ botRuntime: 1 },
	);
	const result = await peer.botsRespond(replyRequest('fred'), undefined, () => {});
	expect(result.messages).toEqual([message]);
});

it('delivers remote background completion to its originating mailbox exactly once over HTTP', async () => {
	let release!: () => void;
	const pendingWork = new Promise<void>((resolve) => {
		release = resolve;
	});
	let calls = 0;
	const requests: WireRequest[] = [];
	const toolReply = (name: string, args: Record<string, unknown> = {}) => ({
		...response(''),
		body: JSON.stringify({
			status: 'completed',
			output: [
				{ type: 'function_call', call_id: `call-${calls}`, name, arguments: JSON.stringify(args) },
			],
		}),
	});
	const remote = await hostFixture('job-home', {
		pluginDefinitions: () => [
			{
				name: 'plugin_long_read',
				description: 'Read the report',
				parameters: { type: 'object', properties: {}, additionalProperties: false },
				execution: 'async',
				readOnly: true,
			},
		],
		executePlugin: async () => {
			await pendingWork;
			return { answer: 'Remote result 42' };
		},
		request: async (wire) => {
			requests.push(wire);
			calls++;
			if (calls === 1)
				return toolReply('bot_send_message', { text: 'I’m checking on the other computer.' });
			if (calls === 2) return toolReply('plugin_long_read');
			if (calls === 3) return silence();
			const notification = notificationFor(wire);
			if (calls === 4) {
				expect(notification).toMatchObject({ type: 'job', status: 'succeeded' });
				return toolReply('bot_jobs_get', { jobId: notification.jobId });
			}
			expect(JSON.stringify(wire.body?.input)).toContain('Remote result 42');
			return response('The report is ready: 42.');
		},
	});
	await createBot(remote.client, 'fred');
	const local = await hostFixture('mailbox-home', {
		remoteProfile: async (participant) =>
			(await remote.client.botsSnapshot()).bots.find((bot) => bot.id === participant.botId)!,
		remoteRespond: (_participant, input, signal, activity, message) =>
			remote.client.botsRespond(input, signal, activity, message),
		groupSnapshots: async () => [await remote.client.botsSnapshot()],
	});
	await local.client.botsCommand({
		type: 'create-conversation',
		id: 'dm',
		participants: [{ hostId: 'job-home', botId: 'fred' }],
	});
	await local.client.botsCommand({
		type: 'send',
		conversationId: 'dm',
		messageId: 'request',
		content: 'Read that report.',
	});
	await local.bots.idle();
	expect(
		(await local.client.botsSnapshot()).conversations[0].messages.map((message) => message.content),
	).toEqual(['Read that report.', 'I’m checking on the other computer.']);
	expect((await remote.client.botsSnapshot()).jobs?.[0]).toMatchObject({
		sourceHostId: 'mailbox-home',
		userMessageId: 'request',
		conversationId: 'dm',
		status: 'running',
	});
	release();
	await vi.waitFor(async () =>
		expect((await remote.client.botsSnapshot()).jobs?.[0].status).toBe('succeeded'),
	);
	await local.bots.pollTaskWatches();
	await local.bots.idle();
	await local.bots.pollTaskWatches();
	await local.bots.idle();
	const messages = (await local.client.botsSnapshot()).conversations[0].messages;
	expect(
		messages
			.filter((message) => message.notification?.type === 'job')
			.map((message) => message.content),
	).toEqual(['The report is ready: 42.']);
	expect(requests).toHaveLength(5);
});

it('refuses asynchronous admission for a legacy remote caller before starting work', async () => {
	const executePlugin = vi.fn(async () => ({ changed: true }));
	let calls = 0;
	const remote = await hostFixture('new-runtime', {
		pluginDefinitions: () => [
			{
				name: 'plugin_long_read',
				description: 'Read',
				parameters: { type: 'object', properties: {}, additionalProperties: false },
				execution: 'async',
				readOnly: true,
			},
		],
		executePlugin,
		request: async (wire) => {
			if (++calls === 1)
				return {
					...response(''),
					body: JSON.stringify({
						status: 'completed',
						output: [
							{ type: 'function_call', call_id: 'long', name: 'plugin_long_read', arguments: '{}' },
						],
					}),
				};
			expect(JSON.stringify(wire.body?.input)).toContain('Update FreeLM');
			return response('Please update the conversation computer.');
		},
	});
	await createBot(remote.client, 'fred');
	const result = await remote.post('/bots/respond', replyRequest('fred'));
	expect(result.status).toBe(200);
	expect(await result.json()).toMatchObject({
		content: 'Please update the conversation computer.',
	});
	expect(executePlugin).not.toHaveBeenCalled();
	expect((await remote.client.botsSnapshot()).jobs).toEqual([]);
});

it('steers a private remote reply over HTTP without creating a duplicate follow-up turn', async () => {
	let started = false;
	let calls = 0;
	const remote = await hostFixture('steer-bot-home', {
		request: async (wire, _chunk, signal) => {
			if (++calls === 1) {
				started = true;
				await new Promise((_, reject) =>
					signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }),
				);
			}
			expect(JSON.stringify(wire.body?.input)).toContain('Wait, use the other account.');
			return response('I’ll use the other account.');
		},
	});
	await createBot(remote.client, 'fred');
	let original: BotReplyRequest | undefined;
	const local = await hostFixture('steer-mailbox', {
		remoteProfile: async (participant) =>
			(await remote.client.botsSnapshot()).bots.find((bot) => bot.id === participant.botId)!,
		remoteRespond: (_participant, input, signal, activity, message) => {
			original = structuredClone(input);
			return remote.client.botsRespond(input, signal, activity, message);
		},
		remoteSteer: (_participant, input, signal) => remote.client.botsSteer(input, signal),
	});
	await local.client.botsCommand({
		type: 'create-conversation',
		id: 'dm',
		participants: [{ hostId: 'steer-bot-home', botId: 'fred' }],
	});
	await local.client.botsCommand({
		type: 'send',
		conversationId: 'dm',
		messageId: 'first',
		content: 'Check the account.',
	});
	await vi.waitFor(() => expect(started).toBe(true));
	expect(original?.source?.hostId).toBe('steer-mailbox');
	expect(
		await remote.client.botsSteer({
			...original!,
			source: { ...original!.source!, hostId: 'other-host' },
		}),
	).toBe(false);
	expect(
		await remote.client.botsSteer({
			...original!,
			userMessageId: 'different-trigger',
			messages: [{ ...original!.messages[0], id: 'different-trigger' }],
		}),
	).toBe(false);
	expect((await remote.post('/bots/steer', original)).status).toBe(400);
	await local.client.botsCommand({
		type: 'send',
		conversationId: 'dm',
		messageId: 'correction',
		content: 'Wait, use the other account.',
	});
	await local.bots.idle();
	expect(
		(await local.client.botsSnapshot()).conversations[0].messages.map((message) => message.content),
	).toEqual(['Check the account.', 'Wait, use the other account.', 'I’ll use the other account.']);
	expect(calls).toBe(2);
	expect(await remote.client.botsSteer(original!)).toBe(false);
});

it('keeps legacy steering queued and rejects malformed steering acknowledgements', async () => {
	const handler = vi.fn((_request: IncomingMessage, response: ServerResponse) =>
		response.end('{}'),
	);
	const legacy = await activityPeer(handler, false);
	expect(await legacy.botsSteer(replyRequest('fred'))).toBe(false);
	expect(handler).not.toHaveBeenCalled();
	const malformed = await activityPeer(
		(_request, response) => {
			response.setHeader('Content-Type', 'application/json');
			response.end(JSON.stringify({ accepted: 'yes' }));
		},
		false,
		{ botRuntime: 1 },
	);
	await expect(malformed.botsSteer(replyRequest('fred'))).rejects.toThrow(
		'invalid bot steering result',
	);
});

it('recovers an acknowledged remote correction after closing before inference consumed it', async () => {
	let started = false;
	let failRequest!: (error: Error) => void;
	const remote = await hostFixture('durable-steer', {
		request: async () => {
			started = true;
			return new Promise<WireResponse>((_resolve, reject) => {
				failRequest = reject;
			});
		},
	});
	await createBot(remote.client, 'fred');
	const input = {
		...replyRequest('fred'),
		source: { hostId: 'mailbox-home', title: 'Private', updatedAt: 1 },
	};
	const pending = remote.client.botsRespond(input).catch((error) => error);
	await vi.waitFor(() => expect(started).toBe(true));
	const correction = {
		...input.messages[0],
		id: 'correction',
		content: 'Use the newer research dataset.',
		createdAt: 2,
		updatedAt: 2,
	};
	expect(
		await remote.client.botsSteer({ ...input, messages: [...input.messages, correction] }),
	).toBe(true);
	const journal = JSON.parse(
		await readFile(BotExecutionStore.filenameForMailbox(remote.mailbox), 'utf8'),
	);
	expect(journal.runs[0].incomingMessages).toEqual([correction]);
	expect(journal.runs[0].seenUserMessageIds).not.toContain('correction');
	remote.bots.close();
	failRequest(new Error('The host closed before consuming steering.'));
	expect(await pending).toBeInstanceOf(Error);
	const recovered = new BotHost({
		filename: remote.mailbox,
		identity: async () => ({ id: 'durable-steer', name: 'Recovered host' }),
		workspace: () => remote.authority.loadBotState(),
		request: async (wire) => {
			expect(JSON.stringify(wire.body?.input)).toContain('Use the newer research dataset.');
			return response('Using the newer dataset.');
		},
	});
	cleanups.push(async () => {
		recovered.close();
		await recovered.idle();
	});
	expect(await recovered.respond(input, undefined, true)).toMatchObject({
		content: 'Using the newer dataset.',
	});
});

it('does not drop remote steering accepted while a silence result was being checkpointed', async () => {
	let calls = 0;
	const remote = await hostFixture('silent-steer', {
		request: async (wire) => {
			if (++calls === 1)
				return {
					...response(''),
					body: JSON.stringify({
						status: 'completed',
						output: [
							{
								type: 'function_call',
								call_id: 'ack',
								name: 'bot_send_message',
								arguments: JSON.stringify({ text: 'I’m here.' }),
							},
						],
					}),
				};
			if (calls === 2) return silence();
			expect(JSON.stringify(wire.body?.input)).toContain('One more question before you go.');
			return response('I saw your follow-up.');
		},
	});
	await createBot(remote.client, 'fred');
	const input = {
		...replyRequest('fred'),
		source: { hostId: 'mailbox-home', title: 'Private', updatedAt: 1 },
	};
	const correction = {
		...input.messages[0],
		id: 'correction',
		content: 'One more question before you go.',
		createdAt: 2,
		updatedAt: 2,
	};
	let delivered = false;
	const update = BotExecutionStore.prototype.updateRun;
	const spy = vi.spyOn(BotExecutionStore.prototype, 'updateRun').mockImplementation(async function (
		this: BotExecutionStore,
		id,
		patch,
	) {
		const result = await update.call(this, id, patch);
		const checkpoint = patch.context as
			{ round?: number; pending?: unknown; result?: unknown } | undefined;
		if (!delivered && checkpoint?.round === 2 && !checkpoint.pending && !checkpoint.result) {
			delivered = true;
			expect(
				await remote.client.botsSteer({ ...input, messages: [...input.messages, correction] }),
			).toBe(true);
		}
		return result;
	});
	try {
		const result = await remote.client.botsRespond(input);
		expect(delivered).toBe(true);
		expect(result.content).toBe('I saw your follow-up.');
		expect(calls).toBe(3);
	} finally {
		spy.mockRestore();
	}
});

describe('Bot-initiated group messages over HTTP', () => {
	const request: BotGroupSendRequest = {
		operationId: 'group-outreach-operation',
		author: { hostId: 'sender-home', botId: 'nova' },
		conversationId: 'general',
		text: 'Does anyone need anything?',
	};
	it('runs remote outreach asynchronously from a private request and delivers a real remote peer reply', async () => {
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		let group: Awaited<ReturnType<typeof hostFixture>>;
		let calls = 0;
		const peerRequests: WireRequest[] = [];
		const peer = await hostFixture('peer-home', {
			request: async (wire) => {
				peerRequests.push(wire);
				return response('I could use help reviewing the research outline.');
			},
		});
		await createBot(peer.client, 'pip');
		const sender = await hostFixture('sender-home', {
			groupSnapshots: async () => (group ? [await group.client.botsSnapshot()] : []),
			remoteGroupSend: async (_hostId, input, signal) => {
				await pending;
				return group.client.botsGroupSend(input, signal);
			},
			request: async (wire) => {
				const notification = notificationFor(wire);
				if (notification?.type === 'group_message') return silence();
				if (notification?.type === 'job') return response('I posted the question in General.');
				if (++calls === 1) {
					expect(JSON.stringify(wire.body?.tools)).toContain('bot_groups_send');
					return {
						...response(''),
						body: JSON.stringify({
							status: 'completed',
							output: [
								{
									type: 'function_call',
									call_id: 'outreach',
									name: 'bot_groups_send',
									arguments: JSON.stringify({
										host_id: 'group-host',
										conversation_id: 'general',
										text: request.text,
									}),
								},
							],
						}),
					};
				}
				return response('I’m sending that to the group.');
			},
		});
		await createBot(sender.client, 'nova');
		const homes = new Map([
			['sender-home', sender],
			['peer-home', peer],
		]);
		group = await hostFixture('group-host', {
			remoteProfile: async (participant) => {
				const home = homes.get(participant.hostId);
				const bot = (await home?.client.botsSnapshot())?.bots.find(
					(item) => item.id === participant.botId,
				);
				if (!bot) throw new Error('Bot home unavailable');
				return bot;
			},
			remoteRespond: (participant, input, signal, activity, message) =>
				homes.get(participant.hostId)!.client.botsRespond(input, signal, activity, message),
		});
		await group.client.botsCommand({
			type: 'create-conversation',
			id: 'general',
			title: 'General',
			participants: [request.author, { hostId: 'peer-home', botId: 'pip' }],
		});
		await sender.client.botsCommand({
			type: 'create-conversation',
			id: 'dm',
			participants: [request.author],
		});
		await sender.client.botsCommand({
			type: 'send',
			conversationId: 'dm',
			messageId: 'ask',
			content: 'Ask #general whether they need anything. Private unrelated detail: secret-419.',
		});
		await sender.bots.idle();
		expect((await sender.client.botsSnapshot()).jobs?.[0]).toMatchObject({
			status: 'running',
			toolName: 'bot_groups_send',
		});
		expect((await group.client.botsSnapshot()).conversations[0].messages).toEqual([]);
		release();
		await vi.waitFor(async () =>
			expect((await group.client.botsSnapshot()).conversations[0].messages).toContainEqual(
				expect.objectContaining({
					role: 'bot',
					author: { hostId: 'peer-home', botId: 'pip' },
					content: 'I could use help reviewing the research outline.',
				}),
			),
		);
		await vi.waitFor(async () =>
			expect((await sender.client.botsSnapshot()).conversations[0].messages).toContainEqual(
				expect.objectContaining({
					content: 'I posted the question in General.',
					notification: expect.objectContaining({ type: 'job' }),
				}),
			),
		);
		expect(peerRequests).toHaveLength(1);
		expect(notificationFor(peerRequests[0])).toMatchObject({
			type: 'group_message',
			readOnly: true,
		});
		expect(JSON.stringify(peerRequests)).not.toContain('secret-419');
		expect(JSON.stringify((await group.client.botsSnapshot()).conversations)).not.toContain(
			'secret-419',
		);
		await group.bots.idle();
		await sender.bots.idle();
		await peer.bots.idle();
	});
	it('posts as the remote bot, deduplicates the operation, and wakes a peer without human impersonation', async () => {
		const sender = await hostFixture('sender-home');
		await createBot(sender.client, 'nova');
		const peerNotifications: unknown[] = [];
		const group = await hostFixture('group-host', {
			remoteProfile: async (participant) => {
				const snapshot = await sender.client.botsSnapshot();
				const bot =
					participant.hostId === snapshot.host.id
						? snapshot.bots.find((bot) => bot.id === participant.botId)
						: undefined;
				if (!bot) throw new Error('Bot home computer unavailable.');
				return bot;
			},
			request: async (wire) => {
				peerNotifications.push(notificationFor(wire));
				return silence();
			},
		});
		await createBot(group.client, 'pip');
		await group.client.botsCommand({
			type: 'create-conversation',
			id: 'general',
			title: 'General',
			participants: [request.author, { hostId: 'group-host', botId: 'pip' }],
		});
		expect(group.info.botGroupOutreach).toBe(1);
		const first = await group.client.botsGroupSend(request);
		const duplicate = await group.client.botsGroupSend(request);
		expect(first).toMatchObject({
			hostId: 'group-host',
			conversationId: 'general',
			deduplicated: false,
		});
		expect(duplicate).toEqual({ ...first, deduplicated: true });
		await vi.waitFor(() =>
			expect(peerNotifications).toEqual([
				expect.objectContaining({
					type: 'group_message',
					messageId: first.messageId,
					readOnly: true,
				}),
			]),
		);
		const conversation = (await group.client.botsSnapshot()).conversations.find(
			(item) => item.id === 'general',
		)!;
		expect(conversation.messages.filter((message) => message.id === first.messageId)).toEqual([
			expect.objectContaining({
				role: 'bot',
				author: request.author,
				content: request.text,
				groupOutreach: true,
				replyTo: first.messageId,
			}),
		]);
		expect(conversation.messages.some((message) => message.role === 'user')).toBe(false);
		await expect(
			group.client.botsGroupSend({ ...request, text: 'A different message' }),
		).rejects.toThrow();
		await group.bots.idle();
		await expect(
			group.client.botsGroupSend({
				...request,
				operationId: 'impersonation',
				author: { hostId: 'group-host', botId: 'pip' },
			}),
		).rejects.toThrow('own connected home computer');
		await createBot(sender.client, 'outsider');
		await expect(
			group.client.botsGroupSend({
				...request,
				operationId: 'nonmember',
				author: { hostId: 'sender-home', botId: 'outsider' },
			}),
		).rejects.toThrow();
		await sender.client.botsCommand({
			type: 'update-bot',
			botId: 'nova',
			changes: { enabled: false },
		});
		await expect(
			group.client.botsGroupSend({ ...request, operationId: 'disabled' }),
		).rejects.toThrow('disabled');
		expect(
			(await group.client.botsSnapshot()).conversations[0].messages.filter(
				(message) => message.groupOutreach,
			),
		).toHaveLength(1);
	});
	it('rejects malformed, unauthenticated and unnegotiated outreach without admitting a message', async () => {
		const group = await hostFixture('group-host');
		const headers = { 'X-FreeLM-Bot-Group-Outreach': '1' };
		expect(
			(
				await group.post('/bots/group-send', request, {
					...headers,
					Authorization: 'Bearer invalid',
				})
			).status,
		).toBe(401);
		expect((await group.post('/bots/group-send', request)).status).toBe(400);
		for (const invalid of [
			{ ...request, text: '' },
			{ ...request, author: { ...request.author, user: true } },
			{ ...request, operationId: 'invalid operation' },
			{ ...request, userMessage: 'Private transcript' },
		])
			expect((await group.post('/bots/group-send', invalid, headers)).status).toBe(400);
		expect((await group.bots.snapshot()).conversations).toEqual([]);
	});
	it('never falls back to a human send on an older peer, and gates bot-rooted replies only', async () => {
		const paths: string[] = [];
		const peer = await activityPeer(
			(incoming, outgoing) => {
				paths.push(incoming.url!);
				outgoing.setHeader('Content-Type', 'application/json');
				outgoing.end(
					JSON.stringify({ content: 'I saw the human follow-up.', reactions: [], readAt: 3 }),
				);
			},
			false,
			{ botGroups: 1, botNotifications: 1, botGroupReadOnly: 1, botRuntime: 1 },
		);
		await expect(peer.botsGroupSend(request)).rejects.toThrow('initiate group messages');
		const input = outreachReplyRequest();
		await expect(peer.botsRespond(input)).rejects.toThrow('bot-initiated group messages');
		await expect(peer.botsSteer(input)).rejects.toThrow('bot-initiated group messages');
		expect(paths).toEqual([]);
		input.messages.push({
			id: 'human-follow-up',
			role: 'user',
			content: 'Thanks, please discuss.',
			createdAt: 2,
			updatedAt: 2,
			status: 'completed',
			reactions: [],
		});
		input.userMessageId = 'human-follow-up';
		delete input.notification;
		await expect(peer.botsRespond(input)).resolves.toMatchObject({
			content: 'I saw the human follow-up.',
		});
		expect(paths).toEqual(['/bots/respond']);
	});
	it('rejects malformed and cross-group delivery receipts from a capable peer', async () => {
		let receipt: unknown = {
			hostId: 'peer',
			conversationId: 'general',
			messageId: 'sent',
			createdAt: 1,
			deduplicated: false,
		};
		const peer = await activityPeer(
			(_incoming, outgoing) => {
				outgoing.setHeader('Content-Type', 'application/json');
				outgoing.end(JSON.stringify(receipt));
			},
			false,
			{ botGroupOutreach: 1 },
		);
		await expect(peer.botsGroupSend(request)).resolves.toEqual(receipt);
		for (const invalid of [
			{ ...(receipt as object), hostId: 'other-host' },
			{ ...(receipt as object), conversationId: 'other-group' },
			{ ...(receipt as object), deduplicated: 'yes' },
		]) {
			receipt = invalid;
			await expect(peer.botsGroupSend(request)).rejects.toThrow();
		}
	});
	it('routes only exact connected host IDs and refuses to originate as another home host', async () => {
		const group = await hostFixture('group-host');
		const manager = new InstanceManager(
			path.join(group.directory, 'outreach-sender.json'),
			{
				available: () => true,
				encrypt: (value) => Buffer.from(value),
				decrypt: (value) => value.toString(),
			},
			group.authority,
		);
		cleanups.push(() => manager.close());
		await manager.connect({ transport: 'direct', name: 'General computer', url: group.url, token });
		const { host } = await manager.status();
		const localRequest = { ...request, author: { ...request.author, hostId: host.instanceId } };
		const send = vi.spyOn(group.bots, 'sendGroup').mockResolvedValue({
			hostId: 'group-host',
			conversationId: 'general',
			messageId: 'sent',
			createdAt: 1,
			deduplicated: false,
		});
		await expect(manager.botsGroupSend('General computer', localRequest)).rejects.toThrow(
			'disconnected',
		);
		await expect(manager.botsGroupSend('group-host', request)).rejects.toThrow('home computer');
		expect(send).not.toHaveBeenCalled();
		await expect(manager.botsGroupSend('group-host', localRequest)).resolves.toMatchObject({
			messageId: 'sent',
		});
		expect(send).toHaveBeenCalledWith(localRequest, expect.any(AbortSignal), true);
		send.mockRestore();
	});
});
