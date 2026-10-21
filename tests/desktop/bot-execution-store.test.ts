import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
	BotExecutionStore,
	type BotActionInput,
	type BotExecutionStoreOptions,
} from '../../electron/bot-execution-store';

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});
async function fixture(options: Partial<BotExecutionStoreOptions> = {}) {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'freelm-bot-execution-'));
	directories.push(directory);
	const filename = BotExecutionStore.filenameForMailbox(path.join(directory, 'bots.json'));
	return { filename, store: new BotExecutionStore({ filename, ...options }) };
}
const input = {
	hostId: 'host-one',
	botId: 'nova',
	conversationId: 'private',
	triggerId: 'user-one',
};
async function action(store: BotExecutionStore, patch: Partial<BotActionInput> = {}) {
	const run = await store.getOrCreateRun(input);
	return store.prepareAction({
		runId: run.id,
		stepKey: '0:0',
		toolName: 'send_email',
		args: { body: 'Hello' },
		...patch,
	});
}

describe('durable bot execution journal', () => {
	it('persists provider context, pending calls, and stable host-qualified run identities', async () => {
		const { store, filename } = await fixture();
		const run = await store.getOrCreateRun({
			...input,
			context: { messages: [{ role: 'user', content: 'Research this' }] },
		});
		await store.updateRun(run.id, {
			status: 'running',
			seenUserMessageIds: ['user-one', 'correction-two'],
			pendingToolCalls: [{ id: 'provider-one', name: 'search', arguments: '{}' }],
		});
		const restarted = new BotExecutionStore({ filename });
		const restored = await restarted.getOrCreateRun({ ...input, context: { messages: [] } });
		expect(restored).toMatchObject({
			id: run.id,
			status: 'waiting',
			seenUserMessageIds: ['user-one', 'correction-two'],
			context: run.context,
			pendingToolCalls: [{ id: 'provider-one', name: 'search', arguments: '{}' }],
		});
		const otherHost = await restarted.getOrCreateRun({ ...input, hostId: 'host-two' });
		expect(otherHost.id).not.toBe(run.id);
		expect(await restarted.listRuns({ hostId: 'host-two' })).toEqual([otherHost]);
	});

	it('preserves a successful side effect and its output despite a regenerated provider call ID', async () => {
		const { store, filename } = await fixture();
		const prepared = await action(store);
		await store.startAction(prepared.id);
		await store.succeedAction(prepared.id, { sent: true, providerMessageId: 'sent-123' });
		const restarted = new BotExecutionStore({ filename });
		const reused = await action(restarted);
		expect(reused).toMatchObject({
			id: prepared.id,
			operationId: prepared.operationId,
			status: 'succeeded',
			attempts: 1,
			result: { sent: true, providerMessageId: 'sent-123' },
		});
		await expect(restarted.startAction(reused.id)).rejects.toThrow('Cannot start a succeeded');
		await expect(
			restarted.succeedAction(reused.id, { sent: true, providerMessageId: 'different' }),
		).rejects.toThrow('cannot be replaced');
	});

	it('deduplicates concurrent prepare calls and rejects changed arguments or policies at the same step', async () => {
		const { store } = await fixture();
		const prepared = await Promise.all(
			Array.from({ length: 12 }, () => action(store, { args: { a: 1, b: 2 } })),
		);
		expect(new Set(prepared.map((entry) => entry.id)).size).toBe(1);
		const reordered = await action(store, { args: { b: 2, a: 1 } });
		expect(reordered.id).toBe(prepared[0].id);
		await expect(action(store, { args: { a: 2, b: 2 } })).rejects.toThrow('cannot be reused');
		await expect(action(store, { args: { a: 1, b: 2 }, readOnly: true })).rejects.toThrow(
			'cannot be reused',
		);
		await expect(action(store, { args: { a: 1, b: 2 }, mode: 'async' })).rejects.toThrow(
			'cannot be reused',
		);
		expect(await store.listActions()).toHaveLength(1);
	});

	it('marks interrupted side effects uncertain and blocks retry until explicit reconciliation', async () => {
		const { store, filename } = await fixture();
		const prepared = await action(store);
		await store.startAction(prepared.id);
		const restarted = new BotExecutionStore({ filename });
		expect(await restarted.getAction(prepared.id)).toMatchObject({
			status: 'outcome_unknown',
			operationId: prepared.operationId,
		});
		await expect(restarted.startAction(prepared.id)).rejects.toThrow('outcome_unknown');
		await expect(restarted.retryAction(prepared.id)).rejects.toThrow('known outcome');
		await expect(
			restarted.failAction(prepared.id, 'Network failed', { outcomeUnknown: false }),
		).rejects.toThrow('Reconcile');
		await restarted.reconcileAction(prepared.id, {
			status: 'succeeded',
			result: { verifiedSent: true },
		});
		expect(await restarted.getAction(prepared.id)).toMatchObject({
			status: 'succeeded',
			result: { verifiedSent: true },
			attempts: 1,
		});
	});

	it('resumes read-only work after restart while preserving queued actions and pending approvals', async () => {
		const { store, filename } = await fixture();
		const read = await action(store, { toolName: 'search', readOnly: true });
		const queued = await action(store, { stepKey: '0:1' });
		const approval = await action(store, { stepKey: '0:2' });
		await store.startAction(read.id);
		await store.awaitActionApproval(approval.id);
		const restarted = new BotExecutionStore({ filename });
		expect(await restarted.getAction(read.id)).toMatchObject({ status: 'pending', attempts: 1 });
		expect(await restarted.getAction(queued.id)).toMatchObject({ status: 'pending', attempts: 0 });
		expect(await restarted.getAction(approval.id)).toMatchObject({
			status: 'awaiting_approval',
			attempts: 0,
		});
		await expect(restarted.startAction(approval.id)).rejects.toThrow('awaiting_approval');
		await restarted.approveAction(approval.id);
		const approved = await new BotExecutionStore({ filename }).getAction(approval.id);
		expect(approved?.approvalGrantedAt).toEqual(expect.any(Number));
		expect(approved?.status).toBe('pending');
		await restarted.startAction(approval.id);
		expect(await restarted.startAction(read.id)).toMatchObject({ status: 'running', attempts: 2 });
	});

	it('persists asynchronous jobs, synchronizes output atomically, and durably acknowledges completion', async () => {
		const { store, filename } = await fixture();
		const prepared = await action(store, { mode: 'async', readOnly: true });
		const job = await store.createJob(prepared.id, {
			context: { completionConversationId: 'private' },
		});
		expect((await store.createJob(prepared.id)).id).toBe(job.id);
		await store.startJob(job.id);
		expect(await store.getAction(prepared.id)).toMatchObject({ status: 'running', attempts: 1 });
		await store.succeedJob(job.id, { findings: ['one', 'two'] });
		const restarted = new BotExecutionStore({ filename });
		expect(
			await restarted.listJobs({
				botId: 'nova',
				status: 'succeeded',
				notificationDelivered: false,
			}),
		).toMatchObject([
			{
				id: job.id,
				result: { findings: ['one', 'two'] },
				context: { completionConversationId: 'private' },
			},
		]);
		expect(await restarted.getAction(prepared.id)).toMatchObject({
			status: 'succeeded',
			result: { findings: ['one', 'two'] },
		});
		await restarted.markJobNotified(job.id);
		const again = new BotExecutionStore({ filename });
		expect(await again.listJobs({ notificationDelivered: false })).toEqual([]);
		expect(await again.getJob(job.id)).toMatchObject({ notificationDelivered: true });
	});

	it('recovers interrupted async side effects as uncertain jobs and read-only jobs as pending', async () => {
		const { store, filename } = await fixture();
		const effect = await action(store, { mode: 'async' });
		const read = await action(store, { stepKey: '0:1', mode: 'async', readOnly: true });
		const effectJob = await store.createJob(effect.id),
			readJob = await store.createJob(read.id);
		await store.startJob(effectJob.id);
		await store.startJob(readJob.id);
		const restarted = new BotExecutionStore({ filename });
		expect(await restarted.getJob(effectJob.id)).toMatchObject({
			status: 'outcome_unknown',
			notificationDelivered: false,
		});
		expect(await restarted.getJob(readJob.id)).toMatchObject({
			status: 'pending',
			notificationDelivered: false,
		});
		await expect(restarted.startJob(effectJob.id)).rejects.toThrow('outcome_unknown');
		await restarted.startJob(readJob.id);
		expect(await restarted.getAction(read.id)).toMatchObject({ attempts: 2 });
	});

	it('preserves approval jobs on restart and cannot acknowledge an unfinished job', async () => {
		const { store, filename } = await fixture();
		const prepared = await action(store, { mode: 'async' });
		const job = await store.createJob(prepared.id);
		await store.awaitActionApproval(prepared.id);
		const restarted = new BotExecutionStore({ filename });
		expect(await restarted.getJob(job.id)).toMatchObject({ status: 'awaiting_approval' });
		await expect(restarted.markJobNotified(job.id)).rejects.toThrow('Only a finished');
		await restarted.approveAction(prepared.id);
		expect(await restarted.getJob(job.id)).toMatchObject({ status: 'pending' });
	});

	it('does not label a running side effect safely cancelled without positive confirmation', async () => {
		const { store } = await fixture();
		const prepared = await action(store, { mode: 'async' });
		const job = await store.createJob(prepared.id);
		await store.startJob(job.id);
		expect(await store.cancelJob(job.id)).toMatchObject({ status: 'outcome_unknown' });
		expect(await store.getAction(prepared.id)).toMatchObject({ status: 'outcome_unknown' });
		expect(await store.cancelJob(job.id, { confirmed: true })).toMatchObject({
			status: 'cancelled',
		});
	});

	it('safely cancels queued and read-only work, while preserving already successful results', async () => {
		const { store } = await fixture();
		const queued = await action(store),
			read = await action(store, { stepKey: '0:1', readOnly: true });
		expect(await store.cancelAction(queued.id)).toMatchObject({ status: 'cancelled' });
		await store.startAction(read.id);
		expect(await store.cancelAction(read.id)).toMatchObject({ status: 'cancelled' });
		const done = await action(store, { stepKey: '0:2' });
		await store.startAction(done.id);
		await store.succeedAction(done.id, { saved: true });
		expect(await store.cancelAction(done.id)).toMatchObject({
			status: 'succeeded',
			result: { saved: true },
		});
	});

	it('treats failed running side effects as uncertain by default and allows known-safe retries explicitly', async () => {
		const { store } = await fixture();
		const unknown = await action(store);
		await store.startAction(unknown.id);
		expect(await store.failAction(unknown.id, 'Connection dropped')).toMatchObject({
			status: 'outcome_unknown',
		});
		const safe = await action(store, { stepKey: '0:1', mode: 'async' });
		const job = await store.createJob(safe.id);
		await store.startJob(job.id);
		expect(
			await store.failJob(job.id, 'Rejected before execution', { outcomeUnknown: false }),
		).toMatchObject({ status: 'failed' });
		await store.markJobNotified(job.id);
		await store.retryAction(safe.id);
		expect(await store.getJob(job.id)).toMatchObject({
			status: 'pending',
			notificationDelivered: false,
		});
		expect(await store.startAction(safe.id)).toMatchObject({
			operationId: safe.operationId,
			attempts: 2,
		});
	});

	it('isolate callers from stored objects and capture inputs before queued writes', async () => {
		const { store } = await fixture();
		const context = { nested: ['original'] };
		const pending = store.getOrCreateRun({ ...input, context });
		context.nested.push('mutated-before-save');
		const run = await pending;
		(run.context as typeof context).nested.push('mutated-after-save');
		expect((await store.getRun(run.id))?.context).toEqual({ nested: ['original'] });
		const patch = { context: { nested: ['updated'] } };
		const changed = store.updateRun(run.id, patch);
		patch.context.nested.push('mutation');
		await changed;
		expect((await store.getRun(run.id))?.context).toEqual({ nested: ['updated'] });
	});

	it('refuses storage overflow without evicting completed results or corrupting future writes', async () => {
		const { store, filename } = await fixture({ maxBytes: 4096 });
		const prepared = await action(store);
		await store.startAction(prepared.id);
		await store.succeedAction(prepared.id, { reference: 'preserved' });
		const bytes = await readFile(filename, 'utf8');
		await expect(
			store.updateRun(prepared.runId, { context: { giant: 'x'.repeat(5000) } }),
		).rejects.toThrow('storage limit');
		expect(await readFile(filename, 'utf8')).toBe(bytes);
		expect(await store.getAction(prepared.id)).toMatchObject({
			result: { reference: 'preserved' },
		});
		await store.updateRun(prepared.runId, { status: 'succeeded' });
		expect((await store.getRun(prepared.runId))?.status).toBe('succeeded');
	});

	it('rejects an oversized existing journal without overwriting it', async () => {
		const { store, filename } = await fixture();
		await store.getOrCreateRun(input);
		const before = await readFile(filename, 'utf8');
		const limited = new BotExecutionStore({ filename, maxBytes: 10 });
		await expect(limited.initialize()).rejects.toThrow('storage limit');
		expect(await readFile(filename, 'utf8')).toBe(before);
	});

	it.each([
		'invalid-json',
		'mismatched-job',
		'mismatched-output',
		'duplicate-action',
		'duplicate-operation',
		'non-object-job',
	])('preserves invalid journals on %s', async (kind) => {
		const { store, filename } = await fixture();
		const prepared = await action(store, { mode: 'async' });
		await store.createJob(prepared.id);
		const data = JSON.parse(await readFile(filename, 'utf8'));
		if (kind === 'mismatched-job') data.jobs[0].status = 'succeeded';
		if (kind === 'mismatched-output') data.jobs[0].result = { forged: true };
		if (kind === 'duplicate-action')
			data.actions.push({ ...data.actions[0], id: 'unique', operationId: 'other-operation' });
		if (kind === 'duplicate-operation')
			data.actions.push({ ...data.actions[0], id: 'unique', stepKey: 'other-step' });
		if (kind === 'non-object-job') data.jobs = [null];
		const content = kind === 'invalid-json' ? '{ nope' : JSON.stringify(data);
		await writeFile(filename, content);
		await expect(new BotExecutionStore({ filename }).initialize()).rejects.toThrow(
			/invalid|unreadable/,
		);
		expect(await readFile(filename, 'utf8')).toBe(content);
	});

	it('uses private file permissions and ignores observer failures after a committed write', async () => {
		const { store, filename } = await fixture({
			onChanged: () => {
				throw new Error('UI gone');
			},
		});
		const run = await store.getOrCreateRun(input);
		expect((await stat(filename)).mode & 0o777).toBe(0o600);
		expect((await new BotExecutionStore({ filename }).getRun(run.id))?.id).toBe(run.id);
	});

	it('rejects nonserializable and invalid state before replacing the journal', async () => {
		const { store, filename } = await fixture();
		const run = await store.getOrCreateRun(input);
		const before = await readFile(filename, 'utf8');
		expect(() => store.updateRun(run.id, { context: { infinity: Infinity } })).toThrow(
			'serializable JSON',
		);
		expect(() => store.updateRun(run.id, { context: { callback: () => undefined } })).toThrow(
			'serializable JSON',
		);
		expect(() =>
			store.updateRun(run.id, { context: { lostEntries: new Map([['id', 'value']]) } }),
		).toThrow('serializable JSON');
		await expect(
			store.prepareAction({ runId: run.id, toolName: 'tool', stepKey: '0:0', args: undefined }),
		).rejects.toThrow('JSON data');
		await expect(store.updateRun(run.id, { status: 'wrong' as 'pending' })).rejects.toThrow(
			'invalid',
		);
		expect(await readFile(filename, 'utf8')).toBe(before);
	});
});
