import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BotHost, type BotHostOptions } from '../../electron/bot-host';
import { listOutreachGroups } from '../../electron/bot-group-outreach';
import type { BotGroupSendRequest, BotSnapshot } from '../../src/bot-types';
import { initialState } from '../../src/lib/state';
import type { WireRequest, WireResponse } from '../../src/types';

const hosts: BotHost[] = [],
	folders: string[] = [];
afterEach(async () => {
	for (const host of hosts.splice(0)) host.close();
	await new Promise((resolve) => setTimeout(resolve, 30));
	await Promise.all(
		folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
	);
});
type Api = 'responses' | 'chat';
function response(
	api: Api,
	content = '',
	calls: [string, Record<string, unknown>][] = [],
): WireResponse {
	return {
		status: 200,
		encoding: 'text',
		contentType: 'application/json',
		body: JSON.stringify(
			api === 'responses'
				? {
						status: 'completed',
						output: calls.length
							? calls.map(([name, args], index) => ({
									type: 'function_call',
									call_id: `call-${index}`,
									name,
									arguments: JSON.stringify(args),
								}))
							: [
									{
										type: 'message',
										role: 'assistant',
										content: [{ type: 'output_text', text: content }],
									},
								],
					}
				: {
						choices: [
							{
								finish_reason: calls.length ? 'tool_calls' : 'stop',
								message: {
									role: 'assistant',
									content: content || null,
									...(calls.length
										? {
												tool_calls: calls.map(([name, args], index) => ({
													id: `call-${index}`,
													type: 'function',
													function: { name, arguments: JSON.stringify(args) },
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
function toolNames(wire: WireRequest): string[] {
	return ((wire.body?.tools as { name?: string; function?: { name?: string } }[]) ?? []).map(
		(tool) => tool.name ?? tool.function?.name ?? '',
	);
}
function toolResults(wire: WireRequest): unknown[] {
	const rows = (wire.body?.input ?? wire.body?.messages) as Record<string, unknown>[];
	return rows
		.filter((row) => row.type === 'function_call_output' || row.role === 'tool')
		.map((row) => JSON.parse(String(row.output ?? row.content)));
}
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
async function fixture(options: Partial<BotHostOptions> = {}, api: Api = 'responses') {
	const folder = await mkdtemp(path.join(os.tmpdir(), 'freelm-bot-group-outreach-'));
	folders.push(folder);
	const state = initialState();
	Object.assign(state.connections[0], {
		id: 'connection',
		chatApi: api,
		catalog: ['nova', 'pip', 'outsider'].map((id) => ({
			id,
			name: id,
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
		})),
	});
	const config: BotHostOptions = {
		filename: path.join(folder, 'mailbox.json'),
		identity: async () => ({ id: 'home', name: 'Fixture' }),
		workspace: async () => state,
		request: async () => response(api, '', [['bot_silence', {}]]),
		...options,
	};
	const host = new BotHost(config);
	hosts.push(host);
	for (const id of ['nova', 'pip', 'outsider'])
		await host.command({
			type: 'create-bot',
			id,
			profile: {
				name: id === 'nova' ? 'Nova' : id === 'pip' ? 'Pip' : 'Outsider',
				identity: 'A helpful collaborator.',
				connectionId: 'connection',
				model: id,
				memoryEnabled: false,
				personalityLearning: false,
				historyAccess: false,
			},
		});
	await host.command({
		type: 'create-conversation',
		id: 'dm',
		participants: [{ hostId: 'home', botId: 'nova' }],
	});
	await host.command({
		type: 'create-conversation',
		id: 'general',
		title: 'General',
		participants: [
			{ hostId: 'home', botId: 'nova' },
			{ hostId: 'home', botId: 'pip' },
		],
	});
	return { host, config };
}
const group = async (host: BotHost) =>
	(await host.snapshot()).conversations.find((item) => item.id === 'general')!;
const outreach = (changes: Partial<BotGroupSendRequest> = {}): BotGroupSendRequest => ({
	operationId: 'operation-one',
	author: { hostId: 'home', botId: 'nova' },
	conversationId: 'general',
	text: 'Hi @Pip, does anyone need anything?',
	...changes,
});

describe('bot-initiated group messages', () => {
	it('keeps same-named groups on different hosts distinct and excludes nonmember groups', async () => {
		const { host } = await fixture();
		const local = await group(host);
		const foreign = {
			...local,
			participants: [
				{ hostId: 'other', botId: 'nova' },
				{ hostId: 'other', botId: 'pip' },
			],
		};
		expect(
			listOutreachGroups(
				{ query: '#gEnErAl' },
				{ hostId: 'home', botId: 'nova' },
				[local],
				[
					{ hostId: 'connected', conversation: structuredClone(local) },
					{ hostId: 'other', conversation: foreign },
				],
			).map(({ host_id, conversation_id }) => ({ host_id, conversation_id })),
		).toEqual([
			{ host_id: 'home', conversation_id: 'general' },
			{ host_id: 'connected', conversation_id: 'general' },
		]);
	});

	it('runs connected-host delivery in a background job and wakes the bot only after its receipt', async () => {
		const release = deferred();
		let remoteSnapshot!: BotSnapshot,
			dmRound = 0,
			completedWakeups = 0,
			deliveryJobId = '';
		const remoteGroupSend = vi.fn(async (_hostId: string, request: BotGroupSendRequest) => {
			await release.promise;
			return {
				hostId: 'connected',
				conversationId: request.conversationId,
				messageId: 'remote-message',
				createdAt: Date.now(),
				deduplicated: false,
			};
		});
		const { host } = await fixture({
			groupSnapshots: async () => [remoteSnapshot],
			remoteGroupSend,
			request: async (wire) => {
				const names = toolNames(wire);
				if (!names.includes('bot_groups_send')) {
					if (toolResults(wire).length === 0) {
						completedWakeups++;
						expect(names).toContain('bot_jobs_get');
						return response('responses', '', [['bot_jobs_get', { jobId: deliveryJobId }]]);
					}
					expect(JSON.stringify(toolResults(wire))).toContain('remote-message');
					return response('responses', 'The group message was delivered.');
				}
				if (++dmRound === 1)
					return response('responses', '', [['bot_groups_list', { query: '#general' }]]);
				if (dmRound === 2) {
					expect(toolResults(wire)[0]).toEqual(
						expect.arrayContaining([
							expect.objectContaining({ host_id: 'home', conversation_id: 'general' }),
							expect.objectContaining({ host_id: 'connected', conversation_id: 'general' }),
						]),
					);
					return response('responses', '', [
						[
							'bot_groups_send',
							{
								host_id: 'connected',
								conversation_id: 'general',
								text: 'Anyone need anything?',
							},
						],
					]);
				}
				expect(JSON.stringify(toolResults(wire))).not.toContain('remote-message');
				return response('responses', '', [['bot_silence', {}]]);
			},
		});
		remoteSnapshot = {
			host: { id: 'connected', name: 'Connected computer' },
			revision: 1,
			bots: [],
			connections: [],
			conversations: [await group(host)],
		};
		await host.command({
			type: 'send',
			conversationId: 'dm',
			messageId: 'remote-request',
			content: 'Ask General on Connected computer if they need anything.',
		});
		try {
			await host.idle();
			await vi.waitFor(() => expect(remoteGroupSend).toHaveBeenCalledOnce());
			deliveryJobId = (await host.snapshot()).jobs![0].id;
			expect((await host.snapshot()).jobs).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ toolName: 'bot_groups_send', status: 'running' }),
				]),
			);
			expect(completedWakeups).toBe(0);
			expect(
				(await host.snapshot()).conversations
					.find((item) => item.id === 'dm')
					?.messages.filter((message) => message.role === 'bot'),
			).toHaveLength(0);
			expect(remoteGroupSend.mock.calls[0]).toEqual([
				'connected',
				expect.objectContaining({
					operationId: expect.any(String),
					author: { hostId: 'home', botId: 'nova' },
					conversationId: 'general',
					text: 'Anyone need anything?',
				}),
				expect.any(AbortSignal),
			]);
		} finally {
			release.resolve();
		}
		await vi.waitFor(
			async () => expect((await host.snapshot()).jobs?.[0].status).toBe('succeeded'),
			{ timeout: 5000 },
		);
		// Completion persists the receipt, admits a new turn, then reads the result through
		// bot_jobs_get before replying. Allow those durable stages to finish under suite load.
		await vi.waitFor(
			async () =>
				expect(
					(await host.snapshot()).conversations.find((item) => item.id === 'dm')?.messages.at(-1)
						?.content,
				).toBe('The group message was delivered.'),
			{ timeout: 5000 },
		);
		expect(completedWakeups).toBe(1);
		expect((await group(host)).messages).toHaveLength(0);
	});

	it.each(['responses', 'chat'] as const)(
		'uses live discovery and sends as the bot from a private %s turn',
		async (api) => {
			let dmRound = 0;
			const peerRequests: WireRequest[] = [];
			const { host } = await fixture(
				{
					request: async (wire) => {
						const names = toolNames(wire);
						if (names.includes('bot_groups_send')) {
							expect(wire.body?.model).toBe('nova');
							expect(names).toContain('bot_groups_list');
							if (++dmRound === 1)
								return response(api, '', [['bot_groups_list', { query: '#GeNeRaL' }]]);
							if (dmRound === 2) {
								const listed = JSON.stringify(toolResults(wire));
								expect(listed).toContain('general');
								expect(listed).toContain('home');
								expect(listed).not.toContain('restricted');
								return response(api, '', [
									[
										'bot_groups_send',
										{
											host_id: 'home',
											conversation_id: 'general',
											text: 'Hi @Pip, does anyone need anything?',
										},
									],
								]);
							}
							expect(JSON.stringify(toolResults(wire))).toContain('messageId');
							return response(api, 'I asked General.');
						}
						peerRequests.push(structuredClone(wire));
						expect(JSON.stringify(wire.body)).not.toContain('private-account-secret');
						expect(names).not.toContain('bot_groups_list');
						expect(names).not.toContain('bot_history_search');
						expect(names).not.toContain('threads_send');
						return wire.body?.model === 'pip'
							? response(api, 'All set, thanks, Nova!')
							: response(api, '', [['bot_silence', {}]]);
					},
				},
				api,
			);
			await host.command({
				type: 'create-conversation',
				id: 'restricted',
				title: 'General private',
				participants: [
					{ hostId: 'home', botId: 'pip' },
					{ hostId: 'home', botId: 'outsider' },
				],
			});
			await host.command({
				type: 'send',
				conversationId: 'dm',
				messageId: 'private-request',
				content:
					'Ask the group in #general if they need anything. My private-account-secret stays here.',
			});
			await host.idle();
			const saved = await group(host);
			expect(dmRound).toBe(3);
			expect(peerRequests.map((wire) => wire.body?.model)).toEqual(['pip', 'nova']);
			expect(saved.messages.map((message) => message.content)).toEqual([
				'Hi @Pip, does anyone need anything?',
				'All set, thanks, Nova!',
			]);
			expect(saved.messages[0]).toMatchObject({
				role: 'bot',
				author: { hostId: 'home', botId: 'nova' },
				groupOutreach: true,
				replyTo: saved.messages[0].id,
				status: 'completed',
			});
			expect(saved.messages[0].mentions).toEqual([
				{ hostId: 'home', botId: 'pip', start: 3, end: 7, label: 'Pip' },
			]);
			expect(saved.messages[1].notification).toMatchObject({
				type: 'group_message',
				readOnly: true,
			});
			expect(saved.messages.every((message) => message.role === 'bot')).toBe(true);
			expect(saved.groupReplyState?.rootMessageId).toBe(saved.messages[0].id);
			expect(
				(await host.snapshot()).conversations.find((item) => item.id === 'dm')?.messages.at(-1)
					?.content,
			).toBe('I asked General.');
		},
	);

	it('deduplicates concurrent delivery and retries after reopening the mailbox', async () => {
		const request = vi.fn(async () => response('responses', '', [['bot_silence', {}]]));
		const { host, config } = await fixture({ request });
		const receipts = await Promise.all([host.sendGroup(outreach()), host.sendGroup(outreach())]);
		await host.idle();
		expect(new Set(receipts.map((receipt) => receipt.messageId)).size).toBe(1);
		expect(receipts.map((receipt) => receipt.deduplicated).sort()).toEqual([false, true]);
		expect((await group(host)).messages).toHaveLength(1);
		expect(request).toHaveBeenCalledOnce();
		host.close();
		const recovered = new BotHost(config);
		hosts.push(recovered);
		await recovered.start();
		const retry = await recovered.sendGroup(outreach());
		await recovered.idle();
		expect(retry).toMatchObject({
			hostId: 'home',
			conversationId: 'general',
			messageId: receipts[0].messageId,
			deduplicated: true,
		});
		expect((await group(recovered)).messages).toHaveLength(1);
		expect(request).toHaveBeenCalledOnce();
		await expect(
			recovered.sendGroup(outreach({ text: 'Different message under the same operation.' })),
		).rejects.toThrow(/operation|different|already/i);
	});
	it.each(['outreach-in-empty-group', 'peer-after-older-human'] as const)(
		'keeps a reaction to %s attached to the bot outreach root',
		async (scenario) => {
			let phase: 'seed' | 'outreach' | 'reaction' = 'seed';
			const reactionModels: string[] = [];
			const { host } = await fixture({
				request: async (wire) => {
					if (phase === 'seed') return response('responses', '', [['bot_silence', {}]]);
					if (phase === 'outreach')
						return wire.body?.model === 'pip'
							? response('responses', 'No requests for now.')
							: response('responses', '', [['bot_silence', {}]]);
					reactionModels.push(String(wire.body?.model));
					expect(toolNames(wire)).not.toContain('bot_groups_send');
					return reactionModels.length === 1
						? response('responses', 'Thanks for checking in.')
						: response('responses', '', [['bot_silence', {}]]);
				},
			});
			if (scenario === 'peer-after-older-human') {
				await host.command({
					type: 'send',
					conversationId: 'general',
					messageId: 'older-human',
					content: 'An older topic.',
				});
				await host.idle();
			}
			phase = 'outreach';
			const sent = await host.sendGroup(outreach());
			await host.idle();
			const before = await group(host);
			const target =
				scenario === 'outreach-in-empty-group'
					? sent.messageId
					: before.messages.find((message) => message.content === 'No requests for now.')!.id;
			phase = 'reaction';
			await host.command({
				type: 'react',
				conversationId: 'general',
				messageId: target,
				emoji: '❤️',
			});
			await host.idle();
			const after = await group(host);
			expect(reactionModels).toEqual(
				scenario === 'outreach-in-empty-group' ? ['nova', 'pip'] : ['pip', 'nova'],
			);
			expect(
				after.messages.find((message) => message.content === 'Thanks for checking in.'),
			).toMatchObject({
				status: 'completed',
				replyTo: sent.messageId,
				notification: { type: 'reaction', messageId: target },
			});
			expect(after.messages.some((message) => message.status === 'failed')).toBe(false);
			expect(after.groupReplyState?.rootMessageId).toBe(sent.messageId);
		},
	);

	it('checks current membership, bot availability, and a group destination before delivery', async () => {
		const { host } = await fixture();
		await expect(host.sendGroup(outreach(), undefined, true)).rejects.toThrow(
			/local|identity|author|host|computer/i,
		);
		await expect(
			host.sendGroup(outreach({ author: { hostId: 'home', botId: 'outsider' } })),
		).rejects.toThrow(/member|participant/i);
		await expect(host.sendGroup(outreach({ conversationId: 'dm' }))).rejects.toThrow(/group/i);
		await expect(host.sendGroup(outreach({ conversationId: 'missing' }))).rejects.toThrow(
			/conversation|group|found/i,
		);
		await host.command({ type: 'update-bot', botId: 'nova', changes: { enabled: false } });
		await expect(host.sendGroup(outreach())).rejects.toThrow(/disabled|enabled|available/i);
		expect((await group(host)).messages).toHaveLength(0);
	});

	it('rejects outreach while an existing group exchange has pending work', async () => {
		const started = deferred(),
			release = deferred();
		const { host } = await fixture({
			request: async () => {
				started.resolve();
				await release.promise;
				return response('responses', '', [['bot_silence', {}]]);
			},
		});
		await host.command({
			type: 'send',
			conversationId: 'general',
			messageId: 'existing',
			content: 'Discuss the project.',
		});
		await started.promise;
		try {
			await expect(host.sendGroup(outreach())).rejects.toThrow(
				/active|pending|working|progress|busy|replying/i,
			);
			expect((await group(host)).messages.some((message) => message.groupOutreach)).toBe(false);
			expect((await group(host)).groupReplyState?.rootMessageId).toBe('existing');
		} finally {
			release.resolve();
		}
		await host.idle();
	});

	it('bounds peer turns following an outreach root by the configured group limit', async () => {
		const request = vi.fn(async (wire: WireRequest) =>
			response('responses', `A short reply from ${wire.body?.model}.`),
		);
		const { host } = await fixture({ request });
		await host.command({
			type: 'update-conversation',
			conversationId: 'general',
			groupReplyLimit: 2,
		});
		const sent = await host.sendGroup(outreach());
		await host.idle();
		expect(request).toHaveBeenCalledTimes(2);
		expect((await group(host)).groupReplyState).toEqual({
			rootMessageId: sent.messageId,
			automaticReplies: 2,
			paused: 'limit',
		});
		expect((await group(host)).messages).toHaveLength(3);
		expect(
			(await group(host)).messages
				.slice(1)
				.every(
					(message) =>
						message.notification?.type === 'group_message' && message.notification.readOnly,
				),
		).toBe(true);
	});

	it('Stop cancels an outreach peer evaluation and discards its late output', async () => {
		const started = deferred(),
			release = deferred();
		let activeSignal: AbortSignal | undefined;
		const { host } = await fixture({
			request: async (_wire, _onChunk, signal) => {
				activeSignal = signal;
				started.resolve();
				await release.promise;
				return response('responses', 'This late reply must not be delivered.');
			},
		});
		const sent = await host.sendGroup(outreach());
		await started.promise;
		try {
			await host.command({ type: 'stop', conversationId: 'general' });
			expect(activeSignal?.aborted).toBe(true);
			expect((await group(host)).groupReplyState).toMatchObject({
				rootMessageId: sent.messageId,
				paused: 'stopped',
			});
		} finally {
			release.resolve();
		}
		await host.idle();
		expect((await group(host)).messages).toHaveLength(1);
		expect((await group(host)).messages[0].id).toBe(sent.messageId);
	});
	it('preserves restrictions on immediate peer bubbles and rejects a late remote bubble after Stop', async () => {
		const started = deferred(),
			release = deferred();
		const progress = {
			id: 'remote-progress',
			content: 'I am checking the group request.',
			createdAt: Date.now(),
		};
		const late = {
			id: 'remote-late',
			content: 'A late network message must be discarded.',
			createdAt: Date.now(),
		};
		const { host } = await fixture({
			remoteProfile: async () => (await host.snapshot()).bots.find((bot) => bot.id === 'pip')!,
			remoteRespond: async (_participant, input, _signal, _onActivity, onMessage) => {
				expect(input.notification).toMatchObject({ type: 'group_message', readOnly: true });
				await onMessage!(progress);
				started.resolve();
				await release.promise;
				await onMessage!(late);
				return { content: '', reactions: [], silent: true, messages: [progress, late] };
			},
		});
		await host.command({ type: 'delete-conversation', conversationId: 'general' });
		await host.command({
			type: 'create-conversation',
			id: 'general',
			title: 'General',
			participants: [
				{ hostId: 'home', botId: 'nova' },
				{ hostId: 'connected', botId: 'pip' },
			],
		});
		const sent = await host.sendGroup(outreach());
		await started.promise;
		try {
			const before = await group(host);
			expect(before.messages.find((message) => message.id === progress.id)).toMatchObject({
				author: { hostId: 'connected', botId: 'pip' },
				replyTo: sent.messageId,
				notification: { type: 'group_message', readOnly: true },
			});
			await host.command({ type: 'stop', conversationId: 'general' });
		} finally {
			release.resolve();
		}
		await host.idle();
		expect((await group(host)).messages.map((message) => message.id)).toEqual([
			sent.messageId,
			progress.id,
		]);
		expect((await group(host)).groupReplyState?.paused).toBe('stopped');
	});
});
