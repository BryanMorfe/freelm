import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SchedulerService } from '../electron/scheduler/service';
import { SchedulerToolService } from '../electron/scheduler-tools';
import { createSchedulerDispatcher } from '../electron/scheduler-dispatch';
import { AgentHost } from '../electron/agent-host';
import { initialState } from '../src/lib/state';
import { defaultToolSettings } from '../src/lib/tool-settings';
import { codePlanToolDenial } from '../src/lib/code-plan';
import type { SchedulerJob, SchedulerOccurrence, SchedulerOrigin } from '../src/scheduler-types';
import type { ToolResult } from '../src/agent-types';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
});
const parse = (result: ToolResult) =>
	JSON.parse(result.content.map((item) => (item.type === 'text' ? item.text : '')).join('\n'));
const code: SchedulerOrigin = { kind: 'code', threadId: 'thread-one' };
const bot: SchedulerOrigin = {
	kind: 'bot',
	botId: 'nova',
	conversationId: 'dm',
	userMessageId: 'source',
};
const once = { kind: 'once', at: '2030-01-01T09:00:00-05:00' };
async function fixture() {
	const folder = await mkdtemp(path.join(tmpdir(), 'freelm-scheduler-tools-'));
	const scheduler = new SchedulerService({
		filename: path.join(folder, 'jobs.json'),
		hostId: 'local-host',
		autoStart: false,
		dispatch: async () => ({ status: 'delivered' }),
	});
	await scheduler.init();
	cleanups.push(async () => {
		await scheduler.close();
		await rm(folder, { recursive: true, force: true });
	});
	const service = new SchedulerToolService(scheduler);
	const call = async (name: string, args: Record<string, unknown>, origin = code) =>
		parse(
			await service.execute(`scheduler.${name}`, args, {
				origin,
				signal: new AbortController().signal,
			}),
		);
	return { scheduler, service, call };
}
describe('conversation-owned scheduling tools', () => {
	it('binds destinations and idempotency to trusted source context', async () => {
		const { call, scheduler } = await fixture();
		const args = {
			title: 'Check build',
			action: 'task',
			text: 'Check the build and report failures.',
			schedule: once,
			idempotencyKey: 'check',
		};
		const first = await call('create', args);
		expect((await call('create', args)).job.id).toBe(first.job.id);
		expect(first.job.target).toEqual({ kind: 'code', threadId: code.threadId, prompt: args.text });
		expect(first.job.origin).toEqual(code);
		const nova = await call('create', args, bot);
		expect(nova.job.target).toEqual({
			kind: 'bot',
			botId: 'nova',
			conversationId: 'dm',
			userMessageId: 'source',
			prompt: args.text,
		});
		expect(scheduler.snapshot().jobs).toHaveLength(2);
		expect((await call('list', {}, code)).jobs.map((job: SchedulerJob) => job.id)).toEqual([
			first.job.id,
		]);
		await expect(call('pause', { id: first.job.id }, bot)).rejects.toThrow('current conversation');
		await expect(call('create', { ...args, threadId: 'injected' })).rejects.toThrow(
			'Invalid scheduler',
		);
	});
	it('delivers bot reminders without requiring task/history access and preserves destination on edits', async () => {
		const { call } = await fixture();
		const { job } = await call(
			'create',
			{
				title: 'Stretch',
				action: 'reminder',
				text: 'Time to stretch.',
				schedule: once,
				idempotencyKey: 'stretch',
			},
			bot,
		);
		expect(job.target).toEqual({
			kind: 'reminder',
			message: 'Time to stretch.',
			destination: { botId: 'nova', conversationId: 'dm', userMessageId: 'source' },
		});
		const updated = await call('update', { id: job.id, text: 'Take a break.' }, bot);
		expect(updated.job.target.destination).toEqual(job.target.destination);
		expect(updated.job.target.message).toBe('Take a break.');
		await expect(
			call('update', { id: job.id, target: { kind: 'code', threadId: 'other' } }, bot),
		).rejects.toThrow('Invalid scheduler');
	});
	it('rejects ambiguous timestamps and validates recurrence instead of guessing', async () => {
		const { call } = await fixture();
		const args = { title: 'Reminder', action: 'reminder', text: 'Hello', idempotencyKey: 'time' };
		await expect(
			call('create', { ...args, schedule: { kind: 'once', at: '2030-01-01T09:00:00' } }),
		).rejects.toThrow('UTC offset');
		await expect(
			call('create', { ...args, schedule: { kind: 'daily', time: '25:30' } }),
		).rejects.toThrow();
		await expect(
			call('create', {
				...args,
				schedule: { kind: 'daily', time: '09:00', timezone: 'invalid/zone' },
			}),
		).rejects.toThrow();
	});
	it('allows Plan listing, blocks all schedule mutations', () => {
		expect(codePlanToolDenial('scheduler.list', {})).toBeUndefined();
		for (const name of [
			'create',
			'update',
			'pause',
			'resume',
			'delete',
			'run_now',
			'snooze',
			'retry',
		])
			expect(codePlanToolDenial(`scheduler.${name}`, {})).toContain('Plan mode blocked');
	});
});

describe('scheduler destination dispatch', () => {
	function fixture() {
		const sendCode = vi.fn(async () => ({ promptSaved: true, delivery: { status: 'queued' } }));
		const options = {
			codeReady: () => true,
			codeThread: async () => ({ kind: 'code' }),
			sendCode,
			remindBot: vi.fn(async () => ({})),
			wakeBot: vi.fn(async () => ({})),
			notify: vi.fn(),
		};
		const job: SchedulerJob = {
			id: 'job',
			hostId: 'host',
			title: 'Reminder',
			schedule: once as SchedulerJob['schedule'],
			enabled: true,
			createdAt: 1,
			updatedAt: 1,
			target: { kind: 'code', threadId: 'thread', prompt: 'Check tests.' },
		};
		const occurrence = { id: 'occurrence', jobId: 'job', jobSnapshot: job } as SchedulerOccurrence;
		return { options, job, occurrence, dispatch: createSchedulerDispatcher(options) };
	}
	it('reports durable Code admission, uses a stable operation identity, waits when unavailable', async () => {
		const { options, job, occurrence, dispatch } = fixture();
		expect(await dispatch(job, occurrence)).toMatchObject({
			status: 'admitted',
			reference: 'thread',
		});
		expect(options.sendCode.mock.calls[0]).toEqual([
			'thread',
			'Check tests.',
			'schedule:occurrence',
			undefined,
		]);
		options.codeReady = () => false;
		await expect(dispatch(job, occurrence)).rejects.toThrow('Waiting');
		expect(options.sendCode).toHaveBeenCalledTimes(1);
	});
	it('recognizes durable queued admission even if starting is unavailable, but never claims completion', async () => {
		const { options, job, occurrence, dispatch } = fixture();
		options.sendCode.mockResolvedValue({ promptSaved: true, delivery: { status: 'unavailable' } });
		expect(await dispatch(job, occurrence)).toMatchObject({
			status: 'admitted',
			message: expect.stringContaining('resume or retry'),
		});
		options.sendCode.mockResolvedValue({ promptSaved: false, delivery: { status: 'unavailable' } });
		await expect(dispatch(job, occurrence)).rejects.toThrow('waiting for Code');
		options.codeThread = async () => ({ kind: 'chat' });
		await expect(dispatch(job, occurrence)).rejects.toThrow('destination Code task');
	});
	it('delivers a fixed reminder even when Code is unavailable and OS notifications are disabled', async () => {
		const { options, job, occurrence, dispatch } = fixture();
		options.codeReady = () => false;
		options.notify.mockImplementation(() => {
			throw new Error('Notifications disabled');
		});
		job.target = {
			kind: 'reminder',
			message: 'Take a break.',
			destination: { botId: 'nova', conversationId: 'dm', userMessageId: 'source' },
		};
		expect(await dispatch(job, occurrence)).toMatchObject({ status: 'delivered', reference: 'dm' });
		expect(options.remindBot).toHaveBeenCalledWith({
			occurrenceId: 'occurrence',
			botId: 'nova',
			conversationId: 'dm',
			userMessageId: 'source',
			message: 'Take a break.',
		});
		expect(options.sendCode).not.toHaveBeenCalled();
		expect(options.wakeBot).not.toHaveBeenCalled();
	});
});

describe('Code scheduler host boundary', () => {
	it('advertises tools without a project, approves mutations, and rechecks live Plan mode', async () => {
		const state = initialState();
		state.toolSettings = {
			...defaultToolSettings(),
			enabled: true,
			commandExecution: false,
			skillDirectories: [],
		};
		state.threads = [
			{
				id: 'task',
				kind: 'code',
				title: 'Task',
				model: 'qwen',
				connectionId: 'connection',
				messages: [],
				createdAt: 1,
				updatedAt: 1,
			},
		];
		const approve = vi.fn(async () => true);
		const service = {
			execute: vi.fn(
				async (
					_name: string,
					_args: Record<string, unknown>,
					_context: import('../src/lib/scheduler-tools').SchedulerToolContext,
				) => ({ content: [{ type: 'text' as const, text: '{}' }] }),
			),
		};
		const host = new AgentHost(async () => structuredClone(state), approve);
		host.setSchedulerTools(service);
		cleanups.push(() => host.close());
		const catalog = await host.catalog('run', 'task');
		expect(catalog.tools.some((tool) => tool.name === 'scheduler.create')).toBe(true);
		const execute = (name: string) =>
			host.execute({ workspaceId: 'local', runId: 'run', threadId: 'task', name, arguments: {} });
		await execute('scheduler.list');
		expect(approve).not.toHaveBeenCalled();
		await execute('scheduler.create');
		expect(approve).toHaveBeenCalledOnce();
		expect(service.execute.mock.calls.at(-1)?.[2]).toMatchObject({
			origin: { kind: 'code', threadId: 'task' },
		});
		state.threads[0].messages.push({
			id: 'plan',
			role: 'user',
			content: 'Plan only',
			composer: { mode: 'plan' },
			createdAt: 2,
		});
		expect((await execute('scheduler.create')).isError).toBe(true);
		expect(service.execute).toHaveBeenCalledTimes(2);
	});
});
