import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BotHost, type BotHostOptions } from '../../electron/bot-host';
import { initialState } from '../../src/lib/state';
import type { WireResponse, WireRequest } from '../../src/types';
const hosts: BotHost[] = [],
	folders: string[] = [];
afterEach(async () => {
	for (const host of hosts.splice(0)) host.close();
	await new Promise((resolve) => setTimeout(resolve, 30));
	await Promise.all(
		folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
	);
});
function response(text = '', calls: [string, Record<string, unknown>][] = []): WireResponse {
	return {
		status: 200,
		encoding: 'text',
		contentType: 'application/json',
		body: JSON.stringify({
			status: 'completed',
			output: calls.length
				? calls.map(([name, args], index) => ({
						type: 'function_call',
						call_id: `call-${index}`,
						name,
						arguments: JSON.stringify(args),
					}))
				: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
		}),
	};
}
const schema = { type: 'object', properties: {}, additionalProperties: false };
const send = (host: BotHost, id: string, content: string) =>
	host.command({ type: 'send', conversationId: 'dm', messageId: id, content });
async function fixture(options: Partial<BotHostOptions>) {
	const folder = await mkdtemp(path.join(os.tmpdir(), 'freelm-bot-runtime-'));
	folders.push(folder);
	const state = initialState();
	Object.assign(state.connections[0], {
		id: 'connection',
		chatApi: 'responses',
		catalog: [
			{
				id: 'test',
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
		],
	});
	const config: BotHostOptions = {
		filename: path.join(folder, 'mailbox.json'),
		identity: async () => ({ id: 'home', name: 'Fixture' }),
		workspace: async () => state,
		...options,
	};
	const host = new BotHost(config);
	hosts.push(host);
	await host.command({
		type: 'create-bot',
		id: 'nova',
		profile: {
			name: 'Nova',
			identity: 'A companion',
			connectionId: 'connection',
			model: 'test',
			memoryEnabled: false,
		},
	});
	await host.command({
		type: 'create-conversation',
		id: 'dm',
		participants: [{ hostId: 'home', botId: 'nova' }],
	});
	return { host, config };
}
const rows = (wire: WireRequest) => wire.body!.input as Record<string, unknown>[];
describe('durable and responsive bot execution', () => {
	it('delivers a text before work, keeps long tools async, and wakes on completion', async () => {
		let release!: () => void;
		const wait = new Promise<void>((resolve) => (release = resolve));
		let requests = 0;
		const { host } = await fixture({
			pluginDefinitions: () => [
				{
					name: 'plugin_slow_read',
					description: 'Slow read',
					parameters: schema,
					readOnly: true,
					execution: 'async',
				},
			],
			executePlugin: async () => {
				// The acknowledgment must be committed before work starts, not just before it ends.
				expect((await host.snapshot()).conversations[0].messages).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							role: 'bot',
							content: 'I’ll check that now.',
							status: 'completed',
						}),
					]),
				);
				await wait;
				return { answer: 42 };
			},
			request: async (wire) => {
				requests++;
				if (requests === 1)
					return response('', [
						['bot_send_message', { text: 'I’ll check that now.' }],
						['plugin_slow_read', {}],
					]);
				if (requests === 2) return response('', [['bot_silence', {}]]);
				return response(
					JSON.stringify(wire.body).includes('"type":"job"')
						? 'The check finished.'
						: 'Yes, I’m still here.',
				);
			},
		});
		await send(host, 'request', 'Run the check');
		await host.idle();
		let snapshot = await host.snapshot();
		expect(
			snapshot.conversations[0].messages.filter((m) => m.role === 'bot').map((m) => m.content),
		).toEqual(['I’ll check that now.']);
		expect(snapshot.jobs?.[0].status).toBe('running');
		await send(host, 'follow-up', 'Are you there?');
		await host.idle();
		expect((await host.snapshot()).conversations[0].messages.at(-1)?.content).toBe(
			'Yes, I’m still here.',
		);
		release();
		await vi.waitFor(async () =>
			expect((await host.snapshot()).jobs?.[0].status).toBe('succeeded'),
		);
		await host.idle();
		await vi.waitFor(async () =>
			expect(
				(await host.snapshot()).conversations[0].messages.some(
					(m) => m.notification?.type === 'job' && m.status === 'completed',
				),
			).toBe(true),
		);
	});
	it('requires approval for exact plugin action even when a tool was granted', async () => {
		const executePlugin = vi.fn(
			async (_name: string, _args: Record<string, unknown>, _context: unknown) => ({ sent: true }),
		);
		let count = 0;
		const { host } = await fixture({
			pluginDefinitions: () => [
				{
					name: 'plugin_send',
					description: 'Send',
					parameters: schema,
					execution: 'async',
					readOnly: false,
				},
			],
			executePlugin,
			request: async () =>
				++count === 1 ? response('', [['plugin_send', {}]]) : response('Please approve the send.'),
		});
		await send(host, 'request', 'Send the message');
		await host.idle();
		const job = (await host.snapshot()).jobs![0];
		expect(job.status).toBe('awaiting_approval');
		expect(executePlugin).not.toHaveBeenCalled();
		await host.command({ type: 'job-approve', conversationId: 'dm', jobId: job.id });
		await vi.waitFor(() => expect(executePlugin).toHaveBeenCalledOnce());
		expect(executePlugin.mock.calls[0][2]).toMatchObject({
			operationId: expect.any(String),
			approval: { approved: true },
		});
	});
	it('reuses a completed action result after a provider error and process restart', async () => {
		let calls = 0;
		const executeTaskTool = vi.fn(async () => ({ created: 'thread-one' }));
		const { host, config } = await fixture({
			taskToolDefinitions: () => [
				{ name: 'threads_create', description: 'Create', parameters: schema },
			],
			executeTaskTool,
			request: async () => {
				if (++calls === 1) return response('', [['threads_create', {}]]);
				throw new Error('Provider disconnected');
			},
		});
		await send(host, 'request', 'Create a task');
		await host.idle();
		const failed = (await host.snapshot()).conversations[0].messages.find(
			(m) => m.status === 'failed',
		)!;
		expect(executeTaskTool).toHaveBeenCalledOnce();
		host.close();
		const recovered = new BotHost({
			...config,
			request: async (wire) => {
				expect(JSON.stringify(rows(wire))).toContain('thread-one');
				return response('Your task is ready.');
			},
		});
		hosts.push(recovered);
		await recovered.command({ type: 'retry', conversationId: 'dm', messageId: failed.id });
		await recovered.idle();
		expect(executeTaskTool).toHaveBeenCalledOnce();
		expect((await recovered.snapshot()).conversations[0].messages.at(-1)?.content).toBe(
			'Your task is ready.',
		);
	});
	it('admits a correction after a tool boundary and cancels the rest of the old batch', async () => {
		let release!: () => void;
		const wait = new Promise<void>((resolve) => (release = resolve));
		let provider = 0;
		const executeTaskTool = vi.fn(async () => {
			await wait;
			return { ok: true };
		});
		const { host } = await fixture({
			taskToolDefinitions: () => [
				{ name: 'threads_read', description: 'Read', parameters: schema },
				{ name: 'threads_create', description: 'Create', parameters: schema },
			],
			executeTaskTool,
			request: async (wire) => {
				if (++provider === 1)
					return response('', [
						['threads_read', {}],
						['threads_create', {}],
					]);
				expect(JSON.stringify(rows(wire))).toContain('Wait, use the other project');
				return response('I’ll use the other project.');
			},
		});
		await send(host, 'request', 'Read then create');
		await vi.waitFor(() => expect(executeTaskTool).toHaveBeenCalledOnce());
		await send(host, 'steer', 'Wait, use the other project');
		release();
		await host.idle();
		expect(executeTaskTool).toHaveBeenCalledOnce();
		expect(provider).toBe(2);
		expect(
			(await host.snapshot()).conversations[0].messages.filter((m) => m.role === 'bot'),
		).toHaveLength(1);
	});
	it('a direct message interrupts inference without cancelling an admitted background job', async () => {
		let first = true,
			started = false;
		const { host } = await fixture({
			request: async (wire, _chunk, signal) => {
				if (first) {
					first = false;
					started = true;
					await new Promise((_, reject) =>
						signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }),
					);
				}
				expect(JSON.stringify(rows(wire))).toContain('Use the new name');
				return response('Using the new name.');
			},
		});
		await send(host, 'first', 'Use the old name');
		await vi.waitFor(() => expect(started).toBe(true));
		await send(host, 'steer', 'Use the new name');
		await host.idle();
		expect(
			(await host.snapshot()).conversations[0].messages
				.filter((m) => m.role === 'bot')
				.map((m) => m.content),
		).toEqual(['Using the new name.']);
	});
});
