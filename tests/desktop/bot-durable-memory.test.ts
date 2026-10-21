import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BotHost, type BotHostOptions } from '../../electron/bot-host';
import type {
	BotConversation,
	BotMemory,
	BotMessage,
	BotProfile,
	BotReplyRequest,
	BotSnapshot,
} from '../../src/bot-types';
import { initialState } from '../../src/lib/state';
import type { WireRequest, WireResponse } from '../../src/types';

type Api = 'responses' | 'chat/completions';
const folders: string[] = [],
	hosts: BotHost[] = [];
const decision = 'Research decision: use the cobalt baseline with a 73 millisecond latency target.';
const correctedDecision =
	'Research correction: use the amber baseline with a 51 millisecond latency target.';
const privateFact = 'PRIVATE_SENTINEL: the field station access phrase is violet-moon.';

afterEach(async () => {
	for (const host of hosts.splice(0)) host.close();
	await Promise.all(
		folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
	);
});

function answer(api: Api, content: string): WireResponse {
	return {
		status: 200,
		encoding: 'text',
		contentType: 'application/json',
		body: JSON.stringify(
			api === 'responses'
				? {
						status: 'completed',
						output: [
							{
								type: 'message',
								role: 'assistant',
								content: [{ type: 'output_text', text: content }],
							},
						],
					}
				: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] },
		),
	};
}

function silence(api: Api): WireResponse {
	return {
		status: 200,
		encoding: 'text',
		contentType: 'application/json',
		body: JSON.stringify(
			api === 'responses'
				? {
						status: 'completed',
						output: [
							{ type: 'function_call', call_id: 'silence', name: 'bot_silence', arguments: '{}' },
						],
					}
				: {
						choices: [
							{
								finish_reason: 'tool_calls',
								message: {
									role: 'assistant',
									content: '',
									tool_calls: [
										{
											id: 'silence',
											type: 'function',
											function: { name: 'bot_silence', arguments: '{}' },
										},
									],
								},
							},
						],
					},
		),
	};
}

function isExtraction(request: WireRequest): boolean {
	const body = request.body as {
		text?: { format?: { type?: string } };
		response_format?: { type?: string };
	};
	return body.text?.format?.type === 'json_schema' || body.response_format?.type === 'json_schema';
}

function toolCall(api: Api, name: string, args: Record<string, unknown>): WireResponse {
	const id = `call-${name}`;
	return {
		status: 200,
		encoding: 'text',
		contentType: 'application/json',
		body: JSON.stringify(
			api === 'responses'
				? {
						status: 'completed',
						output: [{ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) }],
					}
				: {
						choices: [
							{
								finish_reason: 'tool_calls',
								message: {
									role: 'assistant',
									content: '',
									tool_calls: [
										{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
									],
								},
							},
						],
					},
		),
	};
}

function toolOutputs(request: WireRequest): string[] {
	const body = request.body as {
		input?: Record<string, unknown>[];
		messages?: Record<string, unknown>[];
	};
	return (body.input ?? body.messages ?? [])
		.filter((item) => item.type === 'function_call_output' || item.role === 'tool')
		.map((item) => String(item.output ?? item.content));
}

function instructions(request: WireRequest): string {
	const body = request.body as {
		instructions?: string;
		messages?: { role: string; content: string }[];
	};
	return (
		body.instructions ?? body.messages?.find((message) => message.role === 'system')?.content ?? ''
	);
}

function message(id: string, content: string, timestamp = Date.now() - 1000): BotMessage {
	return {
		id,
		role: 'user',
		content,
		status: 'completed',
		createdAt: timestamp,
		updatedAt: timestamp,
		reactions: [],
	};
}

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function stored(
	config: BotHostOptions,
): Promise<{ bots: BotProfile[]; conversations: BotConversation[]; [key: string]: unknown }> {
	return JSON.parse(await readFile(config.filename, 'utf8'));
}

async function memories(config: BotHostOptions, botId = 'nova'): Promise<BotMemory[]> {
	return (await stored(config)).bots.find((bot) => bot.id === botId)?.memories ?? [];
}

let sequence = 0;
async function send(
	host: BotHost,
	content = 'What do you remember from our research?',
	conversationId = 'nova-dm',
) {
	const messageId = `request-${++sequence}`;
	await host.command({ type: 'send', conversationId, messageId, content });
	await host.idle();
	return messageId;
}

function extractionInput(request: WireRequest): {
	source: { hostId: string; conversationId: string; title: string; group: boolean };
	new_messages: { id: string; content: string }[];
} {
	const body = request.body as {
		input?: { role: string; content: string }[];
		messages?: { role: string; content: string }[];
	};
	const input = (body.input ?? body.messages)!.find((entry) => entry.role === 'user')!;
	return JSON.parse(input.content);
}

function extractionAnswer(api: Api, request: WireRequest): WireResponse {
	const input = extractionInput(request);
	const fact = [...input.new_messages]
		.reverse()
		.find((item) => [decision, correctedDecision, privateFact].includes(item.content));
	return answer(
		api,
		JSON.stringify({
			memories: fact
				? [
						{
							key: fact.content === privateFact ? 'private-fact' : 'research-baseline',
							content: fact.content,
							kind: 'decision',
							message_ids: [fact.id],
						},
					]
				: [],
			forget_keys: [],
		}),
	);
}

async function fixture(
	api: Api = 'responses',
	options: {
		request?: (request: WireRequest, signal?: AbortSignal) => Promise<WireResponse | undefined>;
		silent?: boolean;
		researchMessages?: BotMessage[];
		config?: Partial<BotHostOptions>;
	} = {},
) {
	const folder = await mkdtemp(path.join(os.tmpdir(), 'freelm-bot-durable-memory-'));
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
	const requests: WireRequest[] = [];
	const config: BotHostOptions = {
		filename: path.join(folder, 'mailbox.json'),
		identity: async () => ({ id: 'home', name: 'Home' }),
		workspace: async () => workspace,
		watchIntervalMs: 60_000,
		request: async (request, _onChunk, signal) => {
			requests.push(structuredClone(request));
			const custom = await options.request?.(request, signal);
			return (
				custom ??
				(isExtraction(request)
					? extractionAnswer(api, request)
					: options.silent
						? silence(api)
						: answer(api, 'Noted.'))
			);
		},
		...options.config,
	};
	const setup = new BotHost(config);
	hosts.push(setup);
	for (const id of ['nova', 'pip', 'other'])
		await setup.command({
			type: 'create-bot',
			id,
			profile: {
				name: id,
				identity: 'Research collaborator.',
				connectionId: 'connection',
				model: 'test-model',
				historyAccess: false,
				personalityLearning: false,
				memoryEnabled: true,
			},
		});
	for (const [id, title, botIds] of [
		['research', 'Research team', ['nova', 'pip']],
		['private-research', 'Private research', ['pip', 'other']],
		['nova-dm', '', ['nova']],
		['pip-dm', '', ['pip']],
	] as const)
		await setup.command({
			type: 'create-conversation',
			id,
			title,
			participants: botIds.map((botId) => ({ hostId: 'home', botId })),
		});
	setup.close();
	const state = await stored(config);
	for (const conversation of state.conversations) {
		conversation.messages =
			conversation.id === 'research'
				? (options.researchMessages ?? [message('decision', decision)])
				: conversation.id === 'private-research'
					? [message('private', privateFact)]
					: [];
		conversation.groupReplyLimit = 1;
	}
	await writeFile(config.filename, JSON.stringify(state));
	const host = new BotHost(config);
	hosts.push(host);
	await host.start();
	return { host, config, requests };
}

async function reopen(config: BotHostOptions) {
	const host = new BotHost(config);
	hosts.push(host);
	await host.start();
	return host;
}

function groupRequest(hostId = 'home', content = decision): BotReplyRequest {
	return {
		botId: 'nova',
		conversationId: 'research',
		userMessageId: 'decision',
		messages: [message('decision', content)],
		group: {
			source: { hostId, title: `Research on ${hostId}`, updatedAt: Date.now() },
			participants: [
				{ hostId: 'home', botId: 'nova', name: 'Nova', address: 'nova@freelm' },
				{ hostId, botId: 'pip', name: 'Pip', address: 'pip@freelm' },
			],
		},
	};
}

describe('durable bot experience, independent of conversation retrieval', () => {
	it('delivers replies before extraction and remains responsive while background learning is pending', async () => {
		const started = deferred(),
			release = deferred();
		let hold = true;
		const { host, config, requests } = await fixture('responses', {
			request: async (request) => {
				if (isExtraction(request) && hold) {
					started.resolve();
					await release.promise;
				}
				return undefined;
			},
		});
		await host.command({
			type: 'send',
			conversationId: 'nova-dm',
			messageId: 'immediate-first',
			content: 'Recall the team decision.',
		});
		await host.idle({ includeMemory: false });
		expect(
			(await host.snapshot()).conversations.find((item) => item.id === 'nova-dm')?.messages.at(-1),
		).toMatchObject({ role: 'bot', status: 'completed', content: 'Noted.' });
		expect(isExtraction(requests[0])).toBe(false);
		await started.promise;
		expect(await memories(config)).toEqual([]);
		await host.command({
			type: 'send',
			conversationId: 'nova-dm',
			messageId: 'immediate-second',
			content: 'One more question while you remember.',
		});
		await host.idle({ includeMemory: false });
		expect(requests.filter((request) => !isExtraction(request))).toHaveLength(2);
		expect(
			(await host.snapshot()).conversations.find((item) => item.id === 'nova-dm')?.messages.at(-1),
		).toMatchObject({ status: 'completed', replyTo: 'immediate-second' });
		hold = false;
		release.resolve();
		await host.idle();
		expect(await memories(config)).toEqual([expect.objectContaining({ content: decision })]);
	});

	it('resumes persisted background learning after shutdown using fresh live source data', async () => {
		const started = deferred(),
			release = deferred();
		let hold = true;
		const { host, config } = await fixture('responses', {
			request: async (request) => {
				if (isExtraction(request) && hold) {
					started.resolve();
					await release.promise;
				}
				return undefined;
			},
		});
		await host.command({
			type: 'send',
			conversationId: 'nova-dm',
			messageId: 'before-close',
			content: 'Learn our research decision.',
		});
		await host.idle({ includeMemory: false });
		await started.promise;
		host.close();
		hold = false;
		release.resolve();
		await host.idle();
		expect(await memories(config)).toEqual([]);
		const queue = JSON.parse(await readFile(`${config.filename}.memory-queue.json`, 'utf8'));
		expect(
			queue.entries.some(
				(entry: { conversationId: string; status: string }) =>
					entry.conversationId === 'research' && entry.status === 'pending',
			),
		).toBe(true);
		expect(JSON.stringify(queue)).not.toContain(decision);
		const state = await stored(config);
		const original = state.conversations
			.find((item) => item.id === 'research')!
			.messages.find((item) => item.id === 'decision')!;
		original.content = correctedDecision;
		original.updatedAt += 1000;
		original.editedAt = original.updatedAt;
		await writeFile(config.filename, JSON.stringify(state));
		const restarted = await reopen(config);
		await restarted.idle();
		expect(await memories(config)).toEqual([
			expect.objectContaining({ content: correctedDecision }),
		]);
	});

	it.each(['responses', 'chat/completions'] as const)(
		'extracts schema-enforced records, writes disk, and remembers after source deletion and restart using %s',
		async (api) => {
			const { host, config, requests } = await fixture(api);
			await send(host);
			const saved = await memories(config);
			expect(saved).toHaveLength(1);
			expect(saved[0]).toMatchObject({
				content: decision,
				kind: 'decision',
				source: {
					hostId: 'home',
					conversationId: 'research',
					title: 'Research team',
					messageIds: ['decision'],
					group: true,
				},
			});
			expect((await stored(config)).bots.find((bot) => bot.id === 'nova')!.learnedPersonality).toBe(
				'',
			);
			const extraction = requests.filter(isExtraction);
			expect(extraction.length).toBeGreaterThan(0);
			for (const request of extraction) {
				expect(request.body).not.toHaveProperty('tools');
				expect(request.body?.stream).toBe(false);
				const body = request.body as {
					text?: { format: { type: string; name: string; strict: boolean } };
					response_format?: { type: string; json_schema: { name: string; strict: boolean } };
				};
				expect(
					api === 'responses' ? body.text?.format : body.response_format?.json_schema,
				).toMatchObject({ name: 'freelm_bot_memory', strict: true });
			}
			expect(JSON.stringify(requests)).not.toContain(privateFact);
			await host.command({ type: 'delete-conversation', conversationId: 'research' });
			await host.command({ type: 'delete-conversation', conversationId: 'nova-dm' });
			host.close();
			const restarted = await reopen(config);
			await restarted.command({
				type: 'create-conversation',
				id: 'fresh-dm',
				participants: [{ hostId: 'home', botId: 'nova' }],
			});
			requests.length = 0;
			await send(restarted, 'What baseline did we decide?', 'fresh-dm');
			expect(
				(await stored(config)).conversations.every(
					(conversation) => conversation.id !== 'research',
				),
			).toBe(true);
			expect(await memories(config)).toEqual(saved);
			expect(instructions(requests.filter((request) => !isExtraction(request)).at(-1)!)).toContain(
				decision,
			);
			expect(
				instructions(requests.filter((request) => !isExtraction(request)).at(-1)!),
			).not.toContain(privateFact);
		},
	);

	it('consolidates group experience even when the participant elects not to send a reply', async () => {
		const { host, config } = await fixture('responses', { silent: true, researchMessages: [] });
		const sourceId = await send(host, decision, 'research');
		const conversation = (await host.snapshot()).conversations.find(
			(item) => item.id === 'research',
		)!;
		expect(conversation.messages.filter((item) => item.role === 'bot')).toEqual([]);
		for (const botId of ['nova', 'pip'])
			expect(await memories(config, botId)).toEqual([
				expect.objectContaining({
					content: decision,
					source: expect.objectContaining({ messageIds: [sourceId], group: true }),
				}),
			]);
		expect(await memories(config, 'other')).toEqual([]);
	});

	it('does not repeat consolidation for unchanged historical messages after restart', async () => {
		const { host, config, requests } = await fixture();
		await send(host);
		host.close();
		requests.length = 0;
		await send(await reopen(config));
		const sourceRequests = requests
			.filter(isExtraction)
			.filter((request) => extractionInput(request).source.conversationId === 'research');
		expect(sourceRequests).toEqual([]);
		expect(await memories(config)).toHaveLength(1);
	});

	it('honors memory controls independently of personality learning and thread access', async () => {
		const { host, config, requests } = await fixture();
		await send(host);
		const saved = await memories(config);
		await host.command({ type: 'update-bot', botId: 'nova', changes: { memoryEnabled: false } });
		await host.command({ type: 'delete-conversation', conversationId: 'research' });
		requests.length = 0;
		await send(host);
		expect(requests.some(isExtraction)).toBe(false);
		expect(instructions(requests.at(-1)!)).not.toContain(decision);
		expect(await memories(config)).toEqual(saved);
		await host.command({ type: 'update-bot', botId: 'nova', changes: { memoryEnabled: true } });
		requests.length = 0;
		await send(host);
		expect(instructions(requests.filter((request) => !isExtraction(request)).at(-1)!)).toContain(
			decision,
		);
	});

	it('persists manual memory edits and does not relearn a deleted memory from unchanged history', async () => {
		const { host, config } = await fixture();
		await send(host);
		const [saved] = await memories(config);
		await host.command({
			type: 'update-memory',
			botId: 'nova',
			memoryId: saved.id,
			content: 'User-corrected research note.',
		});
		host.close();
		const restarted = await reopen(config);
		expect((await memories(config))[0].content).toBe('User-corrected research note.');
		await restarted.command({ type: 'delete-memory', botId: 'nova', memoryId: saved.id });
		await send(restarted);
		expect(await memories(config)).toEqual([]);
		restarted.close();
		expect(
			(await (await reopen(config)).snapshot()).bots.find((bot) => bot.id === 'nova')?.memories ??
				[],
		).toEqual([]);
	});

	it('invalidates memories based on edited or unsent source messages and learns corrections', async () => {
		const { host, config } = await fixture();
		await send(host);
		await host.command({
			type: 'edit',
			conversationId: 'research',
			messageId: 'decision',
			content: correctedDecision,
		});
		expect(await memories(config)).toEqual([]);
		await send(host);
		expect(await memories(config)).toEqual([
			expect.objectContaining({ content: correctedDecision }),
		]);
		await host.command({ type: 'unsend', conversationId: 'research', messageId: 'decision' });
		expect(await memories(config)).toEqual([]);
		await send(host);
		expect(await memories(config)).toEqual([]);
	});

	it('keeps an invalid extraction nonfatal, exposes the failure, and retries later', async () => {
		let malformed = true;
		const { host, config } = await fixture('responses', {
			request: async (request) =>
				isExtraction(request) && malformed
					? answer('responses', 'This is not a structured memory record.')
					: undefined,
		});
		await send(host);
		expect(await memories(config)).toEqual([]);
		const first = await host.snapshot();
		expect(
			first.conversations.find((conversation) => conversation.id === 'nova-dm')!.messages.at(-1)
				?.status,
		).toBe('completed');
		expect(first.bots.find((bot) => bot.id === 'nova')?.memoryError).toEqual(expect.any(String));
		malformed = false;
		await send(host);
		expect(await memories(config)).toEqual([expect.objectContaining({ content: decision })]);
		expect(
			(await host.snapshot()).bots.find((bot) => bot.id === 'nova')?.memoryError,
		).toBeUndefined();
	});

	it('does not hide a failed group extraction when current-DM extraction succeeds', async () => {
		const { host, config } = await fixture('responses', {
			request: async (request) =>
				isExtraction(request) && extractionInput(request).source.conversationId === 'research'
					? answer('responses', 'Invalid structured memory response.')
					: undefined,
		});
		await send(host);
		expect(await memories(config)).toEqual([]);
		expect((await host.snapshot()).bots.find((bot) => bot.id === 'nova')?.memoryError).toEqual(
			expect.any(String),
		);
	});

	it.each(['disable', 'delete', 'disable-memory'] as const)(
		'does not commit an in-flight extraction after %s',
		async (operation) => {
			const started = deferred(),
				release = deferred();
			let pending = true;
			const { host, config } = await fixture('responses', {
				request: async (request) => {
					if (isExtraction(request) && pending) {
						pending = false;
						started.resolve();
						await release.promise;
					}
					return undefined;
				},
			});
			await host.command({
				type: 'send',
				conversationId: 'nova-dm',
				messageId: 'delayed-message',
				content: 'Recall the team decision.',
			});
			await started.promise;
			await host.command(
				operation === 'delete'
					? { type: 'delete-bot', botId: 'nova' }
					: {
							type: 'update-bot',
							botId: 'nova',
							changes: operation === 'disable' ? { enabled: false } : { memoryEnabled: false },
						},
			);
			release.resolve();
			await host.idle();
			expect(await memories(config)).toEqual([]);
		},
	);

	it('rejects stale extracted facts if the source is edited before the extraction returns', async () => {
		const started = deferred(),
			release = deferred();
		let pending = true;
		const { host, config } = await fixture('responses', {
			request: async (request) => {
				if (isExtraction(request) && pending) {
					pending = false;
					started.resolve();
					await release.promise;
				}
				return undefined;
			},
		});
		await host.command({
			type: 'send',
			conversationId: 'nova-dm',
			messageId: 'delayed-message',
			content: 'Recall the team decision.',
		});
		await started.promise;
		await host.command({
			type: 'edit',
			conversationId: 'research',
			messageId: 'decision',
			content: correctedDecision,
		});
		release.resolve();
		await host.idle();
		expect((await memories(config)).some((memory) => memory.content === decision)).toBe(false);
		await send(host);
		expect(await memories(config)).toEqual([
			expect.objectContaining({ content: correctedDecision }),
		]);
	});

	it('does not disclose private memories when responding in a group', async () => {
		const { host, config, requests } = await fixture();
		await send(host, privateFact);
		expect((await memories(config)).some((memory) => memory.content === privateFact)).toBe(true);
		requests.length = 0;
		const research = (await host.snapshot()).conversations.find(
			(conversation) => conversation.id === 'research',
		)!;
		await host.respond(
			{ ...groupRequest(), messages: research.messages },
			new AbortController().signal,
			false,
		);
		expect(JSON.stringify(requests)).not.toContain(privateFact);
		expect(instructions(requests.filter((request) => !isExtraction(request)).at(-1)!)).toContain(
			decision,
		);
	});

	it('persists remotely received group experience on the bot home and scopes identical conversation IDs by host', async () => {
		const { host, config, requests } = await fixture();
		await send(host);
		await host.respond(groupRequest('lab', correctedDecision), new AbortController().signal, true);
		await host.idle();
		const saved = await memories(config);
		expect(saved).toHaveLength(2);
		expect(saved).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					content: decision,
					source: expect.objectContaining({ hostId: 'home', conversationId: 'research' }),
				}),
				expect.objectContaining({
					content: correctedDecision,
					source: expect.objectContaining({ hostId: 'lab', conversationId: 'research' }),
				}),
			]),
		);
		host.close();
		// A remote cache can be evicted or unavailable. Durable memories are independent records.
		const state = await stored(config);
		delete state.groupRecollections;
		state.conversations = state.conversations.filter(
			(conversation) => conversation.participants.length === 1,
		);
		await writeFile(config.filename, JSON.stringify(state));
		requests.length = 0;
		await send(await reopen(config));
		expect(instructions(requests.filter((request) => !isExtraction(request)).at(-1)!)).toContain(
			correctedDecision,
		);
		expect((await memories(config)).find((memory) => memory.source.hostId === 'lab')?.content).toBe(
			correctedDecision,
		);
	});

	it('preempts learning for a new foreground turn, then retries the source without duplicate records', async () => {
		const started = deferred(),
			release = deferred();
		let pending = true;
		const { host, config, requests } = await fixture('responses', {
			request: async (request) => {
				if (isExtraction(request) && pending) {
					pending = false;
					started.resolve();
					await release.promise;
				}
				return undefined;
			},
		});
		const research = (await host.snapshot()).conversations.find(
			(conversation) => conversation.id === 'research',
		)!;
		const input = { ...groupRequest(), messages: research.messages };
		const first = host.respond(input, new AbortController().signal, false);
		await started.promise;
		const second = host.respond(input, new AbortController().signal, false);
		release.resolve();
		await Promise.all([first, second]);
		await host.idle();
		expect(requests.filter(isExtraction)).toHaveLength(2);
		expect(await memories(config)).toHaveLength(1);
	});

	it('forgets source-linked records when an authoritative remote snapshot marks a message unsent', async () => {
		let remote: BotSnapshot | undefined;
		const { host, config } = await fixture('responses', {
			config: { groupSnapshots: async () => (remote ? [remote] : []) },
		});
		await host.respond(groupRequest('lab', correctedDecision), new AbortController().signal, true);
		await host.idle();
		expect((await memories(config)).some((memory) => memory.source.hostId === 'lab')).toBe(true);
		const now = Date.now() + 1000;
		remote = {
			host: { id: 'lab', name: 'Lab' },
			revision: 2,
			bots: [],
			connections: [],
			conversations: [
				{
					id: 'research',
					title: 'Research on lab',
					participants: [
						{ hostId: 'home', botId: 'nova' },
						{ hostId: 'lab', botId: 'pip' },
					],
					messages: [{ ...message('decision', '', now), status: 'unsent', unsentAt: now }],
					draft: '',
					createdAt: now - 1000,
					updatedAt: now,
					readAt: 0,
				},
			],
		};
		await send(host);
		expect((await memories(config)).some((memory) => memory.source.hostId === 'lab')).toBe(false);
	});

	it('does not attribute an unqualified remote DM to a colliding local conversation', async () => {
		const { host, config, requests } = await fixture();
		await host.respond(
			{
				botId: 'nova',
				conversationId: 'research',
				userMessageId: 'remote-message',
				messages: [message('remote-message', privateFact)],
			},
			new AbortController().signal,
			true,
		);
		expect(requests.some(isExtraction)).toBe(false);
		expect(await memories(config)).toEqual([]);
		const body = requests.at(-1)!.body as { tools: { name: string }[] };
		expect(body.tools.map((tool) => tool.name)).not.toEqual(
			expect.arrayContaining(['bot_memory_save']),
		);
	});

	it('still learns in a locally owned conversation when its send command came from a remote client', async () => {
		const { host, config } = await fixture('responses', { researchMessages: [] });
		await host.command(
			{
				type: 'send',
				conversationId: 'nova-dm',
				messageId: 'remote-client-send',
				content: decision,
			},
			true,
		);
		await host.idle();
		expect(await memories(config)).toEqual([
			expect.objectContaining({
				content: decision,
				source: expect.objectContaining({
					hostId: 'home',
					conversationId: 'nova-dm',
					messageIds: ['remote-client-send'],
				}),
			}),
		]);
	});

	it.each(['responses', 'chat/completions'] as const)(
		'dispatches explicit save, search, and delete tools with durable results across provider rounds using %s',
		async (api) => {
			let config!: BotHostOptions;
			let round = 0;
			const persisted: BotMemory[][] = [];
			const setup = await fixture(api, {
				researchMessages: [],
				request: async (request) => {
					if (isExtraction(request)) return undefined;
					persisted.push(await memories(config));
					switch (round++) {
						case 0:
							return toolCall(api, 'bot_memory_save', {
								key: 'temperature-unit',
								content: 'The user prefers Celsius.',
								kind: 'preference',
								source_message_ids: ['explicit-source'],
							});
						case 1:
							return toolCall(api, 'bot_memory_search', { query: 'Celsius', offset: 0, limit: 10 });
						case 2:
							return toolCall(api, 'bot_memory_delete', {
								id: persisted.at(-1)![0]?.id ?? 'missing',
							});
						default:
							return answer(api, 'Saved, checked, and removed the test memory.');
					}
				},
			});
			config = setup.config;
			await setup.host.command({
				type: 'send',
				conversationId: 'nova-dm',
				messageId: 'explicit-source',
				content:
					'I prefer Celsius. Save that preference, confirm you can find it, then delete this test memory.',
			});
			await setup.host.idle();
			expect(round).toBe(4);
			expect(persisted.map((records) => records.length)).toEqual([0, 1, 1, 0]);
			expect(persisted[1][0]).toMatchObject({
				content: 'The user prefers Celsius.',
				kind: 'preference',
				source: {
					hostId: 'home',
					conversationId: 'nova-dm',
					messageIds: ['explicit-source'],
					group: false,
				},
			});
			const main = setup.requests.filter((request) => !isExtraction(request));
			const outputs = toolOutputs(main.at(-1)!).map((value) => JSON.parse(value));
			expect(outputs).toEqual([
				expect.objectContaining({ saved: true, memory: persisted[1][0] }),
				{ memories: [persisted[1][0]], total: 1, nextOffset: null },
				{ deleted: true, id: persisted[1][0].id },
			]);
			expect(await memories(config)).toEqual([]);
			expect(
				(await setup.host.snapshot()).conversations
					.find((conversation) => conversation.id === 'nova-dm')
					?.messages.at(-1),
			).toMatchObject({
				status: 'completed',
				content: 'Saved, checked, and removed the test memory.',
			});
			setup.host.close();
			expect(
				(await (await reopen(config)).snapshot()).bots.find((bot) => bot.id === 'nova')?.memories ??
					[],
			).toEqual([]);
		},
	);

	it('rejects provider attempts to save or delete another conversation’s evidence during a group turn', async () => {
		let phase = 'setup',
			round = 0,
			privateId = '';
		let privateSourceId = '';
		const { host, config, requests } = await fixture('responses', {
			request: async (request) => {
				if (phase !== 'group' || isExtraction(request)) return undefined;
				switch (round++) {
					case 0:
						return toolCall('responses', 'bot_memory_delete', { id: privateId });
					case 1:
						return toolCall('responses', 'bot_memory_save', {
							key: 'foreign-evidence',
							content: 'Forged cross-conversation note.',
							kind: 'fact',
							source_message_ids: [privateSourceId],
						});
					default:
						return answer('responses', 'Those memories are outside this group.');
				}
			},
		});
		privateSourceId = await send(host, privateFact);
		privateId = (await memories(config)).find(
			(memory) => memory.source.conversationId === 'nova-dm',
		)!.id;
		const before = await memories(config);
		const research = (await host.snapshot()).conversations.find(
			(conversation) => conversation.id === 'research',
		)!;
		phase = 'group';
		requests.length = 0;
		await host.respond(
			{ ...groupRequest(), messages: research.messages },
			new AbortController().signal,
			false,
		);
		const outputs = toolOutputs(requests.filter((request) => !isExtraction(request)).at(-1)!);
		expect(outputs).toHaveLength(2);
		expect(outputs[0]).toContain('not available in this conversation');
		expect(outputs[1]).toContain('exact visible source message IDs');
		expect(await memories(config)).toEqual(before);
		expect(JSON.stringify(requests)).not.toContain(privateFact);
	});

	it.each(['bot_memory_save', 'bot_memory_search', 'bot_memory_delete'])(
		'rejects a host tool that tries to shadow reserved %s',
		async (name) => {
			let executed = false;
			const { host, requests } = await fixture('responses', {
				config: {
					taskToolDefinitions: async () => [
						{
							name,
							description: 'A conflicting tool.',
							parameters: {
								type: 'object',
								properties: {},
								additionalProperties: false,
								required: [],
							},
						},
					],
					executeTaskTool: async () => {
						executed = true;
						return {};
					},
				},
			});
			await send(host);
			expect(executed).toBe(false);
			expect(requests.filter((request) => !isExtraction(request))).toEqual([]);
			expect(
				(await host.snapshot()).conversations
					.find((conversation) => conversation.id === 'nova-dm')!
					.messages.at(-1),
			).toMatchObject({
				status: 'failed',
				error: expect.stringContaining('duplicate bot tool definitions'),
			});
		},
	);

	it('does not resurrect a manually deleted memory from an in-flight source revision after restart', async () => {
		const started = deferred(),
			release = deferred();
		let blockNext = false;
		const { host, config, requests } = await fixture('responses', {
			researchMessages: [],
			request: async (request) => {
				if (isExtraction(request) && blockNext) {
					blockNext = false;
					started.resolve();
					await release.promise;
				}
				return undefined;
			},
		});
		await send(host, decision);
		const [saved] = await memories(config);
		expect(saved.source.conversationId).toBe('nova-dm');
		blockNext = true;
		await host.command({
			type: 'send',
			conversationId: 'nova-dm',
			messageId: 'same-source-update',
			content: decision,
		});
		await started.promise;
		await host.command({ type: 'delete-memory', botId: 'nova', memoryId: saved.id });
		release.resolve();
		await host.idle();
		expect(await memories(config)).toEqual([]);
		host.close();
		requests.length = 0;
		await send(await reopen(config), 'What have you kept in persistent memory?');
		expect(await memories(config)).toEqual([]);
		expect(
			requests
				.filter(isExtraction)
				.flatMap((request) => extractionInput(request).new_messages.map((item) => item.id)),
		).not.toContain('same-source-update');
	});
});
