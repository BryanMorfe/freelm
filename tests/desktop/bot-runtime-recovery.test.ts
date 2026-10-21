import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BotHost, type BotHostOptions } from '../../electron/bot-host';
import { BotExecutionStore } from '../../electron/bot-execution-store';
import { initialState } from '../../src/lib/state';
import type { WireResponse } from '../../src/types';

const hosts: BotHost[] = [],
	folders: string[] = [];
afterEach(async () => {
	for (const host of hosts.splice(0)) {
		host.close();
		await host.idle();
	}
	for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});
const schema = { type: 'object', properties: {}, additionalProperties: false };
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
async function fixture(overrides: Partial<BotHostOptions>) {
	const folder = await mkdtemp(path.join(tmpdir(), 'freelm-bot-recovery-'));
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
					{ id: 'low', name: 'Low', parameters: { responses: { reasoning: { effort: 'low' } } } },
				],
			},
		],
	});
	const config: BotHostOptions = {
		filename: path.join(folder, 'mailbox.json'),
		identity: async () => ({ id: 'home', name: 'Fixture' }),
		workspace: async () => state,
		...overrides,
	};
	const host = new BotHost(config);
	hosts.push(host);
	await host.command({
		type: 'create-bot',
		id: 'nova',
		profile: {
			name: 'Nova',
			identity: 'Helpful',
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

describe('bot run source recovery', () => {
	it.each([
		{ revoked: true, label: 'rejects a revoked request without side effects' },
		{ revoked: false, label: 'resumes an unchanged approved request exactly once' },
	])('recovery $label', async ({ revoked }) => {
		let count = 0;
		const executePlugin = vi.fn(async () => ({ sent: true }));
		const { host, config } = await fixture({
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
				++count === 1 ? response('', [['plugin_send', {}]]) : response('Waiting for approval.'),
		});
		await host.command({
			type: 'send',
			conversationId: 'dm',
			messageId: 'request',
			content: 'Send the message.',
		});
		await host.idle();
		const view = (await host.snapshot()).jobs![0];
		expect(view.status).toBe('awaiting_approval');
		host.close();
		await host.idle();
		// Crash boundary: approval is durable, then the source revocation commits,
		// but cross-file cancellation has not yet reached the execution journal.
		const store = new BotExecutionStore({
			filename: BotExecutionStore.filenameForMailbox(config.filename),
		});
		const job = (await store.getJob(view.id))!;
		await store.approveAction(job.actionId);
		if (revoked) {
			const mailbox = JSON.parse(await readFile(config.filename, 'utf8'));
			const source = mailbox.conversations[0].messages.find(
				(message: { id: string }) => message.id === 'request',
			);
			Object.assign(source, { status: 'unsent', unsentAt: Date.now(), content: '' });
			await writeFile(config.filename, JSON.stringify(mailbox));
		}
		const restarted = new BotHost(config);
		hosts.push(restarted);
		await restarted.start();
		await vi.waitFor(async () =>
			expect((await restarted.snapshot()).jobs?.[0].status).not.toMatch(/pending|running/),
		);
		expect(executePlugin).toHaveBeenCalledTimes(revoked ? 0 : 1);
		expect((await restarted.snapshot()).jobs?.[0].status).toBe(revoked ? 'failed' : 'succeeded');
	});

	it('does not replay old pending tool calls when the user edits the trigger during a reply', async () => {
		let release!: () => void;
		const waiting = new Promise<void>((resolve) => {
			release = resolve;
		});
		let count = 0;
		const prompts: string[] = [];
		const executeTaskTool = vi.fn(async (name: string) => {
			if (name === 'threads_read') await waiting;
			return { ok: true };
		});
		const { host } = await fixture({
			taskToolDefinitions: () => [
				{ name: 'threads_read', description: 'Read', parameters: schema },
				{ name: 'threads_create', description: 'Create', parameters: schema },
			],
			executeTaskTool,
			request: async (wire) => {
				prompts.push(JSON.stringify(wire.body));
				return ++count === 1
					? response('', [
							['threads_read', {}],
							['threads_create', { prompt: 'Use the old account' }],
						])
					: response('Using the corrected request.');
			},
		});
		await host.command({
			type: 'send',
			conversationId: 'dm',
			messageId: 'request',
			content: 'Read the project then create a task using the old account.',
		});
		await vi.waitFor(() => expect(executeTaskTool).toHaveBeenCalledOnce());
		await host.command({
			type: 'edit',
			conversationId: 'dm',
			messageId: 'request',
			content: 'Do not create a task. Just read the project.',
		});
		release();
		await host.idle();
		expect(executeTaskTool.mock.calls.map(([name]) => name)).not.toContain('threads_create');
		expect(prompts.slice(1).join('\n')).toContain('Do not create a task. Just read the project.');
	});
});
