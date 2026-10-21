import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BotRuntime, type BotJobContext } from '../../electron/bot-runtime';
import { BotExecutionStore, type BotExecutionAction } from '../../electron/bot-execution-store';
import { BotHost, type BotHostOptions } from '../../electron/bot-host';
import { initialState } from '../../src/lib/state';
import type { WireResponse } from '../../src/types';

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
const context: BotJobContext = {
	input: { botId: 'nova', conversationId: 'dm', userMessageId: 'request', messages: [] },
	remote: false,
	sourceHostId: 'home',
	kind: 'plugin',
};
async function journal() {
	const directory = await mkdtemp(path.join(tmpdir(), 'freelm-runtime-safety-'));
	cleanup.push(() => rm(directory, { force: true, recursive: true }));
	const filename = path.join(directory, 'execution.json');
	const store = new BotExecutionStore({ filename });
	const run = await store.getOrCreateRun({
		hostId: 'home',
		botId: 'nova',
		conversationId: 'dm',
		triggerId: 'request',
	});
	return { store, run, filename };
}
function wireResponse(text = '', name?: string): WireResponse {
	return {
		status: 200,
		encoding: 'text',
		contentType: 'application/json',
		body: JSON.stringify({
			status: 'completed',
			output: name
				? [{ type: 'function_call', call_id: 'call', name, arguments: '{}' }]
				: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
		}),
	};
}

describe('background execution safety boundaries', () => {
	it('does not claim confirmed cancellation when a pending job starts during Stop', async () => {
		const { store, run } = await journal();
		const action = await store.prepareAction({
			runId: run.id,
			stepKey: '0',
			toolName: 'send',
			args: {},
			mode: 'async',
			readOnly: false,
		});
		const job = await store.createJob(action.id, { context });
		const readJob = store.getJob.bind(store);
		vi.spyOn(store, 'getJob').mockImplementationOnce(async (id) => {
			const snapshot = await readJob(id);
			await store.startJob(id); // Dispatch wins after Stop read the pending snapshot.
			return snapshot;
		});
		const notify = vi.fn(async () => true);
		const runtime = new BotRuntime({ store, execute: vi.fn(), notify });
		cleanup.push(() => runtime.close());
		await runtime.command('job-cancel', job.id);
		expect(await readJob(job.id)).toMatchObject({
			status: 'outcome_unknown',
			notificationDelivered: true,
		});
		expect(notify).toHaveBeenCalledWith(
			expect.objectContaining({ status: 'outcome_unknown' }),
			context,
		);
	});

	it('never launches a job denied before dispatch', async () => {
		const { store, run } = await journal();
		const action = await store.prepareAction({
			runId: run.id,
			stepKey: '0',
			toolName: 'send',
			args: {},
			mode: 'async',
			readOnly: false,
		});
		const execute = vi.fn();
		const runtime = new BotRuntime({ store, execute, notify: async () => true });
		cleanup.push(() => runtime.close());
		const job = await runtime.admit(action, context, true);
		await runtime.command('job-deny', job.jobId);
		runtime.launch(job.jobId);
		await runtime.idle();
		expect(execute).not.toHaveBeenCalled();
		expect(await store.getJob(job.jobId)).toMatchObject({ status: 'cancelled' });
	});

	it('restarts interrupted reads but reports an interrupted mutation without repeating it', async () => {
		const { store, run, filename } = await journal();
		const read = await store.prepareAction({
			runId: run.id,
			stepKey: 'read',
			toolName: 'read',
			args: {},
			mode: 'async',
			readOnly: true,
		});
		const write = await store.prepareAction({
			runId: run.id,
			stepKey: 'write',
			toolName: 'write',
			args: {},
			mode: 'async',
			readOnly: false,
		});
		const readJob = await store.createJob(read.id, { context });
		const writeJob = await store.createJob(write.id, { context });
		await store.startJob(readJob.id);
		await store.startJob(writeJob.id);
		const restarted = new BotExecutionStore({ filename });
		const execute = vi.fn(async (_action: BotExecutionAction) => 'Recovered read');
		const notify = vi.fn(async () => true);
		const runtime = new BotRuntime({ store: restarted, execute, notify });
		cleanup.push(() => runtime.close());
		await runtime.start();
		await runtime.idle();
		expect(execute).toHaveBeenCalledOnce();
		expect(execute.mock.calls[0]?.[0]).toMatchObject({ id: read.id });
		expect(await restarted.getJob(writeJob.id)).toMatchObject({
			status: 'outcome_unknown',
			notificationDelivered: true,
		});
		expect(await restarted.getJob(readJob.id)).toMatchObject({
			status: 'succeeded',
			result: 'Recovered read',
		});
	});

	it('rechecks plugin grants after a saved user approval and before calling the executor', async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'freelm-approval-revoked-'));
		cleanup.push(() => rm(directory, { recursive: true, force: true }));
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
		let granted = true,
			calls = 0;
		const executePlugin = vi.fn(async () => ({ sent: true }));
		const options: BotHostOptions = {
			filename: path.join(directory, 'mailbox.json'),
			identity: async () => ({ id: 'home', name: 'Fixture' }),
			workspace: async () => state,
			pluginDefinitions: () =>
				granted
					? [
							{
								name: 'plugin_send',
								description: 'Send',
								parameters: { type: 'object', properties: {}, additionalProperties: false },
								execution: 'async',
								readOnly: false,
							},
						]
					: [],
			executePlugin,
			request: async () =>
				++calls === 1 ? wireResponse('', 'plugin_send') : wireResponse('Waiting for approval.'),
		};
		const host = new BotHost(options);
		cleanup.push(async () => {
			host.close();
			await host.idle();
		});
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
		await host.command({
			type: 'send',
			conversationId: 'dm',
			messageId: 'request',
			content: 'Send it.',
		});
		await host.idle();
		const job = (await host.snapshot()).jobs![0];
		expect(job.status).toBe('awaiting_approval');
		granted = false;
		await host.command({ type: 'job-approve', conversationId: 'dm', jobId: job.id });
		await vi.waitFor(async () =>
			expect((await host.snapshot()).jobs?.[0].error).toContain('no longer granted'),
		);
		expect(executePlugin).not.toHaveBeenCalled();
		await vi.waitFor(async () =>
			expect(
				JSON.parse(await readFile(BotExecutionStore.filenameForMailbox(options.filename), 'utf8'))
					.jobs[0].notificationDelivered,
			).toBe(true),
		);
		await host.idle();
	});

	it('retries a failed completion notification without blocking other notifications or work', async () => {
		const { store, run } = await journal();
		const prepare = async (stepKey: string, complete: boolean) => {
			const action = await store.prepareAction({
				runId: run.id,
				stepKey,
				toolName: 'read',
				args: {},
				mode: 'async',
				readOnly: true,
			});
			const job = await store.createJob(action.id, { context });
			if (complete) {
				await store.startJob(job.id);
				await store.succeedJob(job.id, stepKey);
			}
			return job;
		};
		const first = await prepare('first', true);
		const second = await prepare('second', true);
		const pending = await prepare('pending', false);
		let firstFails = true;
		const onError = vi.fn();
		const notify = vi.fn(async (job: { id: string }) => {
			if (job.id === first.id && firstFails) {
				firstFails = false;
				throw new Error('Mailbox write unavailable');
			}
			return true;
		});
		const execute = vi.fn(async () => 'Read completed');
		const runtime = new BotRuntime({ store, notify, execute, onError });
		cleanup.push(() => runtime.close());
		await runtime.start();
		await runtime.idle();
		expect(execute).toHaveBeenCalledOnce();
		expect(onError).toHaveBeenCalledOnce();
		expect(await store.getJob(first.id)).toMatchObject({ notificationDelivered: false });
		expect(await store.getJob(second.id)).toMatchObject({ notificationDelivered: true });
		expect(await store.getJob(pending.id)).toMatchObject({
			status: 'succeeded',
			notificationDelivered: true,
		});
		await runtime.retryNotifications();
		expect(await store.getJob(first.id)).toMatchObject({ notificationDelivered: true });
		expect(notify.mock.calls.filter(([job]) => job.id === first.id)).toHaveLength(2);
		expect(notify.mock.calls.filter(([job]) => job.id === second.id)).toHaveLength(1);
	});
});
