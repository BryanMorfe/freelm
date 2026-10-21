import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BotHost, type BotHostOptions } from '../../electron/bot-host';
import { initialState } from '../../src/lib/state';
import { validBotNotification } from '../../src/lib/bots';
import type { WireRequest } from '../../src/types';

const folders: string[] = [];
const hosts: BotHost[] = [];
afterEach(async () => {
	for (const host of hosts.splice(0)) host.close();
	await Promise.all(
		folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
	);
});
const delivery = {
	occurrenceId: 'schedule:break:2026-10-18T18:00:00Z',
	botId: 'nova',
	conversationId: 'dm',
	userMessageId: 'source',
};
const tool = {
	name: 'schedules_create',
	description: 'Create requested future work.',
	parameters: { type: 'object', properties: {} },
};
const response = (api: 'responses' | 'chat/completions', call = false, silent = false) => ({
	status: 200,
	encoding: 'text' as const,
	contentType: 'application/json',
	body: JSON.stringify(
		api === 'responses'
			? {
					output:
						call || silent
							? [
									{
										type: 'function_call',
										call_id: 'call-1',
										name: silent ? 'bot_silence' : tool.name,
										arguments: '{}',
									},
								]
							: [
									{
										type: 'message',
										role: 'assistant',
										content: [{ type: 'output_text', text: 'Your scheduled check finished.' }],
									},
								],
				}
			: {
					choices: [
						{
							finish_reason: call || silent ? 'tool_calls' : 'stop',
							message:
								call || silent
									? {
											role: 'assistant',
											content: '',
											tool_calls: [
												{
													id: 'call-1',
													type: 'function',
													function: { name: silent ? 'bot_silence' : tool.name, arguments: '{}' },
												},
											],
										}
									: { role: 'assistant', content: 'Your scheduled check finished.' },
						},
					],
				},
	),
});
async function fixture(
	options: Partial<BotHostOptions> = {},
	api: 'responses' | 'chat/completions' = 'responses',
) {
	const folder = await mkdtemp(path.join(os.tmpdir(), 'freelm-bot-schedule-'));
	folders.push(folder);
	const state = initialState();
	state.connections[0].id = 'connection';
	state.connections[0].chatApi = api;
	state.connections[0].catalog = [
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
	];
	const config: BotHostOptions = {
		filename: path.join(folder, 'mailbox.json'),
		identity: async () => ({ id: 'home', name: 'Home' }),
		workspace: async () => state,
		request: async () => response(api),
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
			identity: '',
			connectionId: 'connection',
			model: 'test',
			historyAccess: false,
		},
	});
	await host.command({
		type: 'create-conversation',
		id: 'dm',
		participants: [{ hostId: 'home', botId: 'nova' }],
	});
	await host.command({
		type: 'send',
		conversationId: 'dm',
		messageId: 'source',
		content: 'Remind me to take a break, and run the requested check tomorrow.',
	});
	await host.idle();
	return { host, config, state };
}
const messages = async (host: BotHost) =>
	(await host.snapshot()).conversations.find((item) => item.id === 'dm')!.messages;

describe('scheduled bot deliveries', () => {
	it('durably delivers exact reminder text without inference, even with no configured provider', async () => {
		const request = vi.fn(async () => response('responses'));
		const { host, config, state } = await fixture({ request });
		request.mockClear();
		state.connections = [];
		const first = await host.deliverScheduledReminder({ ...delivery, message: 'Take a break.' });
		expect(first.delivered).toBe(true);
		const reminder = (await messages(host)).find((item) => item.id === first.messageId)!;
		expect(reminder).toMatchObject({
			role: 'bot',
			content: 'Take a break.',
			status: 'completed',
			replyTo: 'source',
			notification: { type: 'scheduled', kind: 'reminder', occurrenceId: delivery.occurrenceId },
		});
		expect(request).not.toHaveBeenCalled();
		expect((await messages(host)).filter((item) => item.role === 'user')).toHaveLength(1);
		host.close();
		const reopened = new BotHost(config);
		hosts.push(reopened);
		expect(
			await reopened.deliverScheduledReminder({ ...delivery, message: 'Take a break.' }),
		).toEqual({ messageId: first.messageId, delivered: false });
		expect(
			(await messages(reopened)).filter((item) => item.notification?.type === 'scheduled'),
		).toHaveLength(1);
		await expect(
			reopened.deliverScheduledReminder({ ...delivery, message: 'Different request.' }),
		).rejects.toThrow('different delivery');
		expect(request).not.toHaveBeenCalled();
	});

	it.each(['responses', 'chat/completions'] as const)(
		'wakes %s from saved event context without inventing a human message',
		async (api) => {
			const requests: WireRequest[] = [];
			const { host, config } = await fixture(
				{
					request: async (wire) => {
						requests.push(wire);
						return response(api);
					},
				},
				api,
			);
			requests.length = 0;
			const result = await host.wakeScheduled({
				...delivery,
				prompt: 'Perform the scheduled check now.',
			});
			expect(result.queued).toBe(true);
			await host.idle();
			expect(requests).toHaveLength(1);
			const body = requests[0].body as Record<string, unknown>;
			const wire = JSON.stringify(body);
			expect(wire).toContain('Perform the scheduled check now.');
			expect(wire).toContain('saved user request, triggered at');
			expect(wire).toContain('not a new human message');
			const input = (api === 'responses' ? body.input : body.messages) as { role?: string }[];
			expect(input.filter((item) => item.role === 'user')).toHaveLength(1);
			expect((await messages(host)).find((item) => item.id === result.messageId)).toMatchObject({
				status: 'completed',
				notification: { type: 'scheduled', kind: 'work' },
			});
			host.close();
			const reopened = new BotHost(config);
			hosts.push(reopened);
			expect(
				await reopened.wakeScheduled({ ...delivery, prompt: 'Perform the scheduled check now.' }),
			).toEqual({ messageId: result.messageId, queued: false });
			await reopened.idle();
			expect(requests).toHaveLength(1);
		},
	);

	it('keeps a delivery receipt when a scheduled wake is silently acknowledged', async () => {
		let silent = false;
		const { host, config } = await fixture({
			request: async () => response('responses', false, silent),
		});
		silent = true;
		const result = await host.wakeScheduled({
			...delivery,
			prompt: 'Only report a changed result.',
		});
		await host.idle();
		expect((await messages(host)).some((item) => item.id === result.messageId)).toBe(false);
		host.close();
		const reopened = new BotHost(config);
		hosts.push(reopened);
		expect(
			await reopened.wakeScheduled({ ...delivery, prompt: 'Only report a changed result.' }),
		).toEqual({ messageId: result.messageId, queued: false });
	});
	it('notifies only new terminal scheduled work and isolates notification failure', async () => {
		let fail = false;
		const notification = vi.fn(() => {
			throw new Error('Desktop notification unavailable.');
		});
		const { host } = await fixture({
			onScheduledReply: notification,
			request: async () => {
				if (fail) throw new Error('Provider unavailable.');
				return response('responses');
			},
		});
		expect(notification).not.toHaveBeenCalled();
		const first = await host.wakeScheduled({ ...delivery, prompt: 'Run the check.' });
		await host.idle();
		expect(notification).toHaveBeenCalledTimes(1);
		expect(notification).toHaveBeenLastCalledWith({
			conversationId: 'dm',
			botId: 'nova',
			title: 'Nova',
			content: 'Your scheduled check finished.',
		});
		expect((await messages(host)).find((item) => item.id === first.messageId)?.status).toBe(
			'completed',
		);
		await host.wakeScheduled({ ...delivery, prompt: 'Run the check.' });
		await host.idle();
		expect(notification).toHaveBeenCalledTimes(1);
		fail = true;
		await host.wakeScheduled({
			...delivery,
			occurrenceId: 'second',
			prompt: 'Run the check again.',
		});
		await host.idle();
		expect(notification).toHaveBeenCalledTimes(2);
		expect(notification).toHaveBeenLastCalledWith(
			expect.objectContaining({ failed: true, content: 'Provider unavailable.' }),
		);
	});

	it('rejects disabled bots, deleted conversations, and removed original requests before delivery', async () => {
		const { host } = await fixture();
		await host.command({ type: 'update-bot', botId: 'nova', changes: { enabled: false } });
		await expect(host.deliverScheduledReminder({ ...delivery, message: 'Break.' })).rejects.toThrow(
			'disabled',
		);
		await host.command({ type: 'update-bot', botId: 'nova', changes: { enabled: true } });
		await host.command({ type: 'unsend', conversationId: 'dm', messageId: 'source' });
		await expect(host.wakeScheduled({ ...delivery, prompt: 'Run the check.' })).rejects.toThrow(
			'original user request',
		);
		await host.command({ type: 'delete-conversation', conversationId: 'dm' });
		await expect(host.deliverScheduledReminder({ ...delivery, message: 'Break.' })).rejects.toThrow(
			'conversation',
		);
	});

	it('rejects invalid scheduled notification fields at the remote and storage boundary', () => {
		const notification = {
			id: 'notice',
			type: 'scheduled',
			kind: 'work',
			occurrenceId: 'occurrence:1',
			prompt: 'Check the project.',
			triggeredAt: 1,
		};
		expect(validBotNotification(notification)).toBe(true);
		expect(validBotNotification({ ...notification, triggeredAt: NaN })).toBe(false);
		expect(validBotNotification({ ...notification, prompt: '' })).toBe(false);
		expect(validBotNotification({ ...notification, grantTools: true })).toBe(false);
	});
});

describe('bot scheduler tool admission', () => {
	it.each(['responses', 'chat/completions'] as const)(
		'offers scheduler tools without thread access through %s and passes source provenance',
		async (api) => {
			const execute = vi.fn(async () => ({ saved: true }));
			let calls = 0;
			const { host } = await fixture(
				{
					schedulerToolDefinitions: () => [tool],
					executeSchedulerTool: execute,
					request: async (wire) => {
						const body = JSON.stringify(wire.body);
						expect(body).toContain('schedules_create');
						expect(body).toContain('current host time');
						return response(api, calls++ === 0);
					},
				},
				api,
			);
			expect(execute).toHaveBeenCalledTimes(1);
			expect(execute.mock.calls[0]).toMatchObject([
				'schedules_create',
				{},
				{
					remote: false,
					conversationId: 'dm',
					userMessageId: 'source',
					bot: { historyAccess: false },
					input: { userMessageId: 'source' },
				},
			]);
			expect((await messages(host)).at(-1)?.status).toBe('completed');
		},
	);

	it('never offers or dispatches scheduling on remote-origin turns or reaction wakes', async () => {
		let probe = false,
			attempt = 0;
		const execute = vi.fn(async () => ({ saved: true }));
		const { host } = await fixture({
			schedulerToolDefinitions: () => [tool],
			executeSchedulerTool: execute,
			request: async (wire) => {
				if (!probe) return response('responses');
				const body = wire.body as { tools?: { name?: string }[] };
				expect(body.tools?.some((item) => item.name === tool.name)).toBe(false);
				return response('responses', attempt++ % 2 === 0);
			},
		});
		probe = true;
		await host.respond(
			{
				botId: 'nova',
				conversationId: 'dm',
				userMessageId: 'source',
				messages: await messages(host),
			},
			undefined,
			true,
		);
		const target = (await messages(host)).find((item) => item.role === 'bot')!;
		await host.command({ type: 'react', conversationId: 'dm', messageId: target.id, emoji: '👍' });
		await host.idle();
		expect(execute).not.toHaveBeenCalled();
	});
});
