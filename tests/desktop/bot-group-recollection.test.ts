import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BotHost, type BotHostOptions } from '../../electron/bot-host';
import type {
	BotConversation,
	BotMessage,
	BotReplyRequest,
	BotSnapshot,
} from '../../src/bot-types';
import { initialState } from '../../src/lib/state';
import type { WireRequest, WireResponse } from '../../src/types';

type Api = 'responses' | 'chat/completions';
type Call = { name: string; args: Record<string, unknown> };
const hosts: BotHost[] = [],
	folders: string[] = [];
const decision = 'We selected the cobalt-velvet baseline with a 73 millisecond latency target.';
const unrelatedGroup = 'The field station uses a silver-lantern inventory protocol.';
const privateGroup = 'PRIVATE_GROUP_SENTINEL: Helium storage is on shelf 94.';
const privateDm = 'PRIVATE_DM_SENTINEL: personal appointment is on the 23rd.';

afterEach(async () => {
	for (const host of hosts.splice(0)) host.close();
	await Promise.all(
		folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
	);
});

function message(id: string, content: string, index = 0): BotMessage {
	const time = Date.now() - 60_000 + index;
	return {
		id,
		role: 'user',
		content,
		status: 'completed',
		createdAt: time,
		updatedAt: time,
		reactions: [],
	};
}

function reply(api: Api, call?: Call): WireResponse {
	return {
		status: 200,
		encoding: 'text',
		contentType: 'application/json',
		body: JSON.stringify(
			api === 'responses'
				? {
						status: 'completed',
						output: call
							? [
									{
										type: 'function_call',
										call_id: 'recall-call',
										name: call.name,
										arguments: JSON.stringify(call.args),
									},
								]
							: [
									{
										type: 'message',
										role: 'assistant',
										content: [{ type: 'output_text', text: 'Noted.' }],
									},
								],
					}
				: {
						choices: [
							{
								finish_reason: call ? 'tool_calls' : 'stop',
								message: {
									role: 'assistant',
									content: call ? '' : 'Noted.',
									...(call
										? {
												tool_calls: [
													{
														id: 'recall-call',
														type: 'function',
														function: { name: call.name, arguments: JSON.stringify(call.args) },
													},
												],
											}
										: {}),
								},
							},
						],
					},
		),
	};
}

function body(request: WireRequest) {
	return request.body as Record<string, unknown>;
}
function instructions(request: WireRequest): string {
	const payload = body(request);
	if (typeof payload.instructions === 'string') return payload.instructions;
	return (payload.messages as { role: string; content: string }[]).find(
		(item) => item.role === 'system',
	)!.content;
}
function toolNames(request: WireRequest): string[] {
	return ((body(request).tools ?? []) as { name?: string; function?: { name: string } }[]).map(
		(tool) => tool.name ?? tool.function!.name,
	);
}
function toolOutputs(request: WireRequest): string[] {
	const payload = body(request);
	return (
		(payload.input ?? payload.messages) as {
			type?: string;
			role?: string;
			output?: string;
			content?: string;
		}[]
	)
		.filter((item) => item.type === 'function_call_output' || item.role === 'tool')
		.map((item) => item.output ?? item.content!);
}

async function fixture(
	api: Api = 'responses',
	options: Partial<BotHostOptions> = {},
	researchMessages = [message('decision', decision)],
) {
	const folder = await mkdtemp(path.join(os.tmpdir(), 'freelm-bot-recollection-'));
	folders.push(folder);
	const workspace = initialState(),
		connection = workspace.connections[0];
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
	const requests: WireRequest[] = [],
		calls: Call[] = [];
	const config: BotHostOptions = {
		filename: path.join(folder, 'mailbox.json'),
		identity: async () => ({ id: 'home', name: 'Home' }),
		workspace: async () => workspace,
		request: async (request) => {
			requests.push(structuredClone(request));
			return reply(api, calls.shift());
		},
		watchIntervalMs: 60_000,
		...options,
	};
	const setup = new BotHost(config);
	hosts.push(setup);
	for (const id of ['nova', 'pip', 'other'])
		await setup.command({
			type: 'create-bot',
			id,
			profile: {
				memoryEnabled: false,
				name: id,
				identity: 'A research collaborator.',
				connectionId: 'connection',
				model: 'test-model',
				historyAccess: false,
				personalityLearning: false,
			},
		});
	for (const [id, title, bots] of [
		['research', 'Research team', ['nova', 'pip']],
		['fieldwork', 'Fieldwork team', ['nova', 'pip']],
		['private-group', 'Private team', ['pip', 'other']],
		['pip-dm', '', ['pip']],
		['nova-dm', '', ['nova']],
	] as const)
		await setup.command({
			type: 'create-conversation',
			id,
			title,
			participants: bots.map((botId) => ({ hostId: 'home', botId })),
		});
	setup.close();
	// Model a mailbox created before automatic group recollection existed. No personality
	// note, index migration, or new group event is needed to recover its existing messages.
	const stored = JSON.parse(await readFile(config.filename, 'utf8')) as {
		conversations: BotConversation[];
	};
	const history = new Map([
		['research', researchMessages],
		['fieldwork', [message('field-note', unrelatedGroup)]],
		['private-group', [message('private-note', privateGroup)]],
		['pip-dm', [message('personal-note', privateDm)]],
	]);
	for (const conversation of stored.conversations) {
		conversation.messages = history.get(conversation.id) ?? [];
		conversation.groupReplyLimit = 1;
	}
	await writeFile(config.filename, JSON.stringify(stored));
	const host = new BotHost(config);
	hosts.push(host);
	await host.start();
	return { host, config, requests, calls };
}

let sequence = 0;
async function send(
	host: BotHost,
	content = 'What happened in our group?',
	conversationId = 'nova-dm',
) {
	await host.command({ type: 'send', conversationId, messageId: `request-${++sequence}`, content });
	await host.idle();
}

function remoteSnapshot(
	hostId = 'lab',
	content = 'The remote team chose the sapphire-copper protocol.',
): BotSnapshot {
	const now = Date.now();
	return {
		host: { id: hostId, name: `${hostId} computer` },
		revision: 1,
		connections: [],
		bots: [
			{
				id: 'pip',
				name: `Pip on ${hostId}`,
				address: 'pip@freelm',
				identity: '',
				learnedPersonality: '',
				color: '#abcdef',
				enabled: true,
				historyAccess: false,
				personalityLearning: false,
				connectionId: '',
				model: '',
				createdAt: now,
				updatedAt: now,
			},
		],
		conversations: [
			{
				id: 'research',
				title: `Research on ${hostId}`,
				participants: [
					{ hostId: 'home', botId: 'nova' },
					{ hostId, botId: 'pip' },
				],
				messages: [
					message('remote-decision', content),
					{
						...message('peer-note', 'I will run the replication.'),
						role: 'bot',
						author: { hostId, botId: 'pip' },
					},
				],
				draft: '',
				createdAt: now - 60_000,
				updatedAt: now,
				readAt: 0,
			},
		],
	};
}

function groupRequest(snapshot: BotSnapshot): BotReplyRequest {
	const conversation = snapshot.conversations[0];
	return {
		botId: 'nova',
		conversationId: conversation.id,
		userMessageId: conversation.messages[0].id,
		messages: structuredClone(conversation.messages),
		group: {
			source: {
				hostId: snapshot.host.id,
				title: conversation.title,
				updatedAt: conversation.updatedAt,
			},
			participants: conversation.participants.map((participant) => ({
				...participant,
				name: participant.botId === 'nova' ? 'Nova' : `Pip on ${participant.hostId}`,
				address: `${participant.botId}@freelm`,
			})),
		},
	};
}

async function cachedGroups(config: BotHostOptions) {
	const store = JSON.parse(await readFile(config.filename, 'utf8')) as {
		groupRecollections?: {
			botId: string;
			hostId: string;
			observedAt: number;
			conversation: BotConversation;
		}[];
	};
	return store.groupRecollections ?? [];
}

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe('bot group recollection across conversations', () => {
	it.each(['responses', 'chat/completions'] as const)(
		'injects pre-existing group context into a DM using %s without learned notes or thread access',
		async (api) => {
			const { host, requests } = await fixture(api);
			await send(host);
			expect(requests).toHaveLength(1);
			const prompt = instructions(requests[0]);
			expect(prompt).toContain(decision);
			expect(prompt).toContain('Research team');
			expect(prompt).not.toContain(privateGroup);
			expect(prompt).not.toContain(privateDm);
			expect(toolNames(requests[0])).toEqual(
				expect.arrayContaining(['bot_groups_search', 'bot_groups_read']),
			);
			expect(toolNames(requests[0])).not.toContain('bot_remember');
			expect((await host.snapshot()).bots.find((bot) => bot.id === 'nova')).toMatchObject({
				historyAccess: false,
				personalityLearning: false,
				learnedPersonality: '',
			});
		},
	);

	it('reads current group revisions and removes unsent or deleted history from new DM context', async () => {
		const { host, requests } = await fixture();
		await send(host);
		expect(instructions(requests.at(-1)!)).toContain(decision);
		const revised =
			'We replaced that baseline with amber-cedar and a 41 millisecond latency target.';
		await host.command({
			type: 'edit',
			conversationId: 'research',
			messageId: 'decision',
			content: revised,
		});
		await send(host);
		expect(instructions(requests.at(-1)!)).toContain(revised);
		expect(instructions(requests.at(-1)!)).not.toContain(decision);
		await host.command({ type: 'unsend', conversationId: 'research', messageId: 'decision' });
		await send(host);
		expect(instructions(requests.at(-1)!)).not.toContain(revised);
		expect(instructions(requests.at(-1)!)).toContain(unrelatedGroup);
		await host.command({ type: 'delete-conversation', conversationId: 'fieldwork' });
		await send(host);
		expect(instructions(requests.at(-1)!)).not.toContain(unrelatedGroup);
	});

	it('does not expose other groups or recollection tools while replying inside a group', async () => {
		const { host, requests } = await fixture();
		await send(host, 'Please acknowledge the current research discussion.', 'research');
		expect(requests.length).toBeGreaterThan(0);
		for (const request of requests) {
			const payload = JSON.stringify(body(request));
			expect(payload).not.toContain(unrelatedGroup);
			expect(payload).not.toContain(privateGroup);
			expect(payload).not.toContain(privateDm);
			expect(toolNames(request)).not.toContain('bot_groups_search');
			expect(toolNames(request)).not.toContain('bot_groups_read');
		}
	});

	it.each(['responses', 'chat/completions'] as const)(
		'lets %s recover an older group fact outside the automatic excerpt with search and read',
		async (api) => {
			const research = [
				message('decision', decision),
				...Array.from({ length: 16 }, (_, i) =>
					message(
						`recent-${i}`,
						`Observation ${i}: standard calibration completed successfully.`,
						i + 1,
					),
				),
			];
			const { host, requests, calls } = await fixture(api, {}, research);
			calls.push(
				{ name: 'bot_groups_search', args: { query: 'cobalt-velvet', offset: 0, limit: 10 } },
				{
					name: 'bot_groups_read',
					args: { host_id: 'home', conversation_id: 'research', offset: 0, limit: 2 },
				},
			);
			await send(host);
			expect(requests).toHaveLength(3);
			expect(instructions(requests[0])).not.toContain(decision);
			expect(toolOutputs(requests[1])[0]).toContain(decision);
			expect(toolOutputs(requests[2]).at(-1)).toContain(decision);
			for (const request of requests) {
				expect(JSON.stringify(body(request))).not.toContain(privateGroup);
				expect(JSON.stringify(body(request))).not.toContain(privateDm);
			}
		},
	);

	it.each(['private-group', 'pip-dm', 'missing-group'])(
		'rejects reading %s rather than exposing nonmember or nonexistent history',
		async (conversationId) => {
			const { host, requests, calls } = await fixture();
			calls.push({
				name: 'bot_groups_read',
				args: { host_id: 'home', conversation_id: conversationId, offset: 0, limit: 20 },
			});
			await send(host);
			expect(requests).toHaveLength(2);
			const result = toolOutputs(requests[1])[0];
			expect(result).toMatch(
				/error|unavailable|not available|not found|unknown|not belong|not a member/i,
			);
			expect(result).not.toContain(privateGroup);
			expect(result).not.toContain(privateDm);
		},
	);

	it.each(['bot_groups_search', 'bot_groups_read'])(
		'reserves %s against host tool name collisions',
		async (name) => {
			const { host, requests } = await fixture('responses', {
				taskToolDefinitions: () => [
					{ name, description: 'Conflicting tool', parameters: { type: 'object', properties: {} } },
				],
				executeTaskTool: async () => ({ unexpected: true }),
			});
			await send(host);
			expect(requests).toHaveLength(0);
			const dm = (await host.snapshot()).conversations.find(
				(conversation) => conversation.id === 'nova-dm',
			)!;
			expect(dm.messages.at(-1)).toMatchObject({
				status: 'failed',
				error: expect.stringMatching(/duplicate|invalid/i),
			});
		},
	);
});

describe('remote bot group recollection', () => {
	it('distinguishes the same conversation and bot IDs across hosts and preserves remote display names', async () => {
		const lab = remoteSnapshot(),
			second = remoteSnapshot(
				'workstation',
				'The workstation team selected the ruby-marble protocol.',
			);
		const { host, requests, calls } = await fixture('responses', {
			groupSnapshots: async () => [lab, second],
		});
		calls.push({
			name: 'bot_groups_read',
			args: { host_id: 'lab', conversation_id: 'research', offset: 0, limit: 20 },
		});
		await send(host);
		const prompt = instructions(requests[0]);
		expect(prompt).toContain(decision);
		expect(prompt).toContain(lab.conversations[0].messages[0].content);
		expect(prompt).toContain(second.conversations[0].messages[0].content);
		expect(prompt).toContain('Pip on lab');
		expect(prompt).toContain('Pip on workstation');
		const read = toolOutputs(requests[1])[0];
		expect(read).toContain('Pip on lab');
		expect(read).toContain(lab.conversations[0].messages[0].content);
		expect(read).not.toContain(decision);
		expect(read).not.toContain(second.conversations[0].messages[0].content);
	});

	it('recalls last-observed remote groups with provenance while offline after restart', async () => {
		const remote = remoteSnapshot();
		let online = true;
		const { host, config, requests } = await fixture('responses', {
			groupSnapshots: async () => (online ? [remote] : []),
		});
		await send(host);
		const before = await cachedGroups(config);
		expect(before).toHaveLength(1);
		expect(before[0]).toMatchObject({
			botId: 'nova',
			hostId: 'lab',
			observedAt: expect.any(Number),
		});
		host.close();
		online = false;
		const reopened = new BotHost(config);
		hosts.push(reopened);
		await reopened.start();
		await send(reopened);
		const prompt = instructions(requests.at(-1)!);
		expect(prompt).toContain(remote.conversations[0].messages[0].content);
		expect(prompt).toContain('observedAt');
		expect(prompt).toContain('stale');
		expect(await cachedGroups(config)).toEqual(before);
	});

	it.each(['edit', 'unsend', 'remove-member', 'delete-group'] as const)(
		'uses a successful remote snapshot to apply %s instead of retaining old cached text',
		async (action) => {
			const remote = remoteSnapshot();
			const original = remote.conversations[0].messages[0].content;
			const { host, config, requests } = await fixture('responses', {
				groupSnapshots: async () => [structuredClone(remote)],
			});
			await send(host);
			expect(instructions(requests.at(-1)!)).toContain(original);
			const conversation = remote.conversations[0];
			conversation.updatedAt++;
			remote.revision++;
			if (action === 'edit')
				conversation.messages[0].content = 'The revised protocol uses granite-orchid measurements.';
			if (action === 'unsend')
				Object.assign(conversation.messages[0], {
					content: '',
					status: 'unsent',
					unsentAt: Date.now(),
				});
			if (action === 'remove-member')
				conversation.participants[0] = { hostId: 'elsewhere', botId: 'nova' };
			if (action === 'delete-group') remote.conversations = [];
			await send(host);
			expect(instructions(requests.at(-1)!)).not.toContain(original);
			expect(JSON.stringify(await cachedGroups(config))).not.toContain(original);
			if (action === 'edit')
				expect(instructions(requests.at(-1)!)).toContain(conversation.messages[0].content);
			if (action === 'remove-member' || action === 'delete-group')
				expect(await cachedGroups(config)).toHaveLength(0);
		},
	);

	it('records an incoming remote group observation and ignores an older source revision', async () => {
		const remote = remoteSnapshot(),
			older = structuredClone(remote);
		remote.conversations[0].updatedAt += 1000;
		remote.conversations[0].messages[0].content =
			'Our current decision is the jade-river protocol.';
		const { host, config, requests } = await fixture();
		await host.respond(groupRequest(remote), undefined, true);
		await host.respond(groupRequest(older), undefined, true);
		await send(host);
		const prompt = instructions(requests.at(-1)!);
		expect(prompt).toContain(remote.conversations[0].messages[0].content);
		expect(prompt).not.toContain(older.conversations[0].messages[0].content);
		expect(prompt).toContain('Pip on lab');
		expect(await cachedGroups(config)).toHaveLength(1);
	});

	it('does not revive an incoming message marked unsent when caching its completed record', async () => {
		const remote = remoteSnapshot();
		const withdrawn = 'WITHDRAWN_SENTINEL: superseded private experiment details.';
		remote.conversations[0].messages.push({
			...message('withdrawn', withdrawn),
			unsentAt: Date.now(),
		});
		const { host, config, requests } = await fixture();
		await host.respond(groupRequest(remote), undefined, true);
		await send(host);
		expect(JSON.stringify(await cachedGroups(config))).not.toContain(withdrawn);
		expect(instructions(requests.at(-1)!)).not.toContain(withdrawn);
	});

	it('does not overwrite a newer observation when an older remote snapshot resolves later', async () => {
		const old = remoteSnapshot(),
			newer = structuredClone(old),
			started = deferred(),
			result = deferred<BotSnapshot[]>();
		newer.conversations[0].updatedAt += 1000;
		newer.conversations[0].messages[0].content = 'The latest decision uses the onyx-lake protocol.';
		const { host, config, requests } = await fixture('responses', {
			groupSnapshots: async () => {
				started.resolve();
				return result.promise;
			},
		});
		const sending = send(host);
		await started.promise;
		await host.respond(groupRequest(newer), undefined, true);
		result.resolve([old]);
		await sending;
		expect(JSON.stringify(await cachedGroups(config))).toContain(
			newer.conversations[0].messages[0].content,
		);
		expect(JSON.stringify(await cachedGroups(config))).not.toContain(
			old.conversations[0].messages[0].content,
		);
		expect(instructions(requests.at(-1)!)).toContain(newer.conversations[0].messages[0].content);
		expect(instructions(requests.at(-1)!)).not.toContain(old.conversations[0].messages[0].content);
	});

	it('does not replace a newer observed conversation with an older revision from a later refresh', async () => {
		const old = remoteSnapshot(),
			newer = structuredClone(old);
		newer.conversations[0].updatedAt += 1000;
		newer.conversations[0].messages[0].content =
			'The committed decision uses the coral-cedar protocol.';
		const { host, config, requests } = await fixture('responses', {
			groupSnapshots: async () => [old],
		});
		await host.respond(groupRequest(newer), undefined, true);
		await send(host);
		expect(JSON.stringify(await cachedGroups(config))).toContain(
			newer.conversations[0].messages[0].content,
		);
		expect(JSON.stringify(await cachedGroups(config))).not.toContain(
			old.conversations[0].messages[0].content,
		);
		expect(instructions(requests.at(-1)!)).toContain(newer.conversations[0].messages[0].content);
		expect(instructions(requests.at(-1)!)).not.toContain(old.conversations[0].messages[0].content);
	});

	it.each(['disable', 'delete'] as const)(
		'does not restore cache after %s during an incoming remote observation',
		async (action) => {
			let waitForIdentity = false;
			const started = deferred(),
				identity = deferred<{ id: string; name: string }>();
			const { host, config, requests } = await fixture('responses', {
				identity: async () => {
					if (!waitForIdentity) return { id: 'home', name: 'Home' };
					waitForIdentity = false;
					started.resolve();
					return identity.promise;
				},
			});
			waitForIdentity = true;
			const responding = host.respond(groupRequest(remoteSnapshot()), undefined, true);
			const rejected = expect(responding).rejects.toThrow(/unavailable|disabled|aborted/i);
			await started.promise;
			await host.command(
				action === 'delete'
					? { type: 'delete-bot', botId: 'nova' }
					: { type: 'update-bot', botId: 'nova', changes: { enabled: false } },
			);
			identity.resolve({ id: 'home', name: 'Home' });
			await rejected;
			expect(await cachedGroups(config)).toHaveLength(0);
			expect(requests).toHaveLength(0);
		},
	);

	it('bounds remote cache by group count, message count, and bytes', async () => {
		const remote = remoteSnapshot(),
			template = remote.conversations[0];
		remote.conversations = Array.from({ length: 280 }, (_, groupIndex) => ({
			...structuredClone(template),
			id: `remote-${groupIndex}`,
			messages: Array.from({ length: groupIndex < 232 ? 1 : 90 }, (_, index) =>
				message(`entry-${index}`, `Record ${index} ${'x'.repeat(995)}`, index),
			),
		}));
		const { host, config } = await fixture('responses', { groupSnapshots: async () => [remote] });
		await send(host);
		const cache = await cachedGroups(config);
		expect(cache.length).toBeGreaterThan(0);
		expect(cache.length).toBeLessThanOrEqual(256);
		expect(Buffer.byteLength(JSON.stringify(cache))).toBeLessThanOrEqual(2 * 1024 * 1024);
		for (const item of cache) {
			expect(item.conversation.messages.length).toBeLessThanOrEqual(80);
			expect(
				item.conversation.messages.reduce((total, entry) => total + entry.content.length, 0),
			).toBeLessThanOrEqual(60_000);
		}
	});
});
