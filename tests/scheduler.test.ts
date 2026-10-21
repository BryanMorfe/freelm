import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
	SchedulerService,
	SchedulerUnavailableError,
	validateSchedulerCommand,
} from '../electron/scheduler/service';
import { nextScheduleAt } from '../electron/scheduler/recurrence';
import { WorkflowScheduler } from '../electron/workflows/scheduler';
import { WorkflowStore } from '../electron/workflows/store';
import type { SchedulerJobInput, SchedulerOccurrenceStatus } from '../src/scheduler-types';
import type { SchedulerServiceOptions } from '../electron/scheduler/service';
import type { WorkflowDefinition } from '../src/workflow-types';

const roots: string[] = [],
	services: SchedulerService[] = [];
async function create(options: Partial<SchedulerServiceOptions> = {}) {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'freelm-scheduler-'));
	roots.push(directory);
	const service = new SchedulerService({
		filename: path.join(directory, 'schedule.json'),
		hostId: 'this-host',
		autoStart: false,
		dispatch: async () => ({ status: 'delivered' }),
		...options,
	});
	services.push(service);
	await service.init();
	return service;
}
const reminder = (at = 1000): SchedulerJobInput => ({
	title: 'Remember the test',
	schedule: { kind: 'once', at },
	target: { kind: 'reminder', message: 'Check the tests' },
});
async function settled(service: SchedulerService, status: SchedulerOccurrenceStatus, count = 1) {
	await vi.waitFor(
		() =>
			expect(service.snapshot().occurrences.filter((item) => item.status === status)).toHaveLength(
				count,
			),
		{ interval: 5 },
	);
}
afterEach(async () => {
	for (const service of services.splice(0)) await service.close();
	for (const directory of roots.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('shared durable host scheduler', () => {
	it('persists one-shot reminders and serializes concurrent ticks and creation retries', async () => {
		let now = 0;
		const dispatch = vi.fn(async () => ({ status: 'delivered' as const, message: 'Displayed' }));
		const service = await create({ now: () => now, dispatch });
		const created = await Promise.all(
			Array.from({ length: 8 }, () =>
				service.command({ type: 'create', job: reminder(), idempotencyKey: 'same-request' }),
			),
		);
		expect(new Set(created.map((item) => item.jobId)).size).toBe(1);
		expect(service.snapshot().jobs).toHaveLength(1);
		await service.tick();
		expect(dispatch).not.toHaveBeenCalled();
		now = 1000;
		await Promise.all(Array.from({ length: 8 }, () => service.tick()));
		await settled(service, 'delivered');
		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(service.snapshot().jobs[0].nextRunAt).toBeUndefined();
		await expect(
			service.command({
				type: 'create',
				job: { ...reminder(), title: 'Different' },
				idempotencyKey: 'same-request',
			}),
		).rejects.toThrow('different scheduled task');
	});
	it('runs one late occurrence on return, keeps interval cadence, and never catches up in a burst', async () => {
		let now = 0;
		const service = await create({ now: () => now });
		await service.command({
			type: 'create',
			job: { ...reminder(), schedule: { kind: 'interval', intervalMinutes: 1, missed: 'once' } },
		});
		now = 310_000;
		await service.tick();
		await settled(service, 'delivered');
		await service.tick();
		expect(service.snapshot().occurrences).toHaveLength(1);
		expect(service.snapshot().jobs[0].nextRunAt).toBe(360_000);
	});
	it('skips missed occurrences when selected and retains that decision through restart', async () => {
		let now = 0;
		const service = await create({ now: () => now });
		await service.command({
			type: 'create',
			job: { ...reminder(), schedule: { kind: 'interval', intervalMinutes: 1, missed: 'skip' } },
		});
		now = 310_000;
		await service.tick();
		expect(service.snapshot().occurrences).toHaveLength(0);
		expect(service.snapshot().jobs[0].nextRunAt).toBe(360_000);
	});
	it('waits durably for unavailable destinations while other reminders are delivered', async () => {
		let now = 0,
			available = false;
		const dispatch = vi.fn(async (job) => {
			if (job.target.kind === 'code' && !available)
				throw new SchedulerUnavailableError('Open the Code workspace');
			return {
				status: job.target.kind === 'code' ? ('admitted' as const) : ('delivered' as const),
			};
		});
		const service = await create({ now: () => now, dispatch });
		await service.command({
			type: 'create',
			job: {
				...reminder(),
				target: { kind: 'code', threadId: 'code-one', prompt: 'Check the build' },
			},
		});
		await service.command({ type: 'create', job: reminder() });
		now = 1000;
		await service.tick();
		await settled(service, 'waiting');
		await settled(service, 'delivered');
		const waiting = service.snapshot().occurrences.find((item) => item.status === 'waiting')!;
		expect(waiting.retryAt).toBe(6000);
		now = 5999;
		await service.tick();
		expect(dispatch).toHaveBeenCalledTimes(2);
		available = true;
		now = 6000;
		await service.tick();
		await settled(service, 'admitted');
		expect(service.snapshot().occurrences.find((item) => item.id === waiting.id)?.attempts).toBe(2);
		expect(dispatch).toHaveBeenCalledTimes(3);
	});
	it('does not block reminders behind a pending Code dispatch promise', async () => {
		let release: (() => void) | undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const service = await create({
			now: () => 1000,
			dispatch: async (job) => {
				if (job.target.kind === 'code') await held;
				return { status: job.target.kind === 'code' ? 'admitted' : 'delivered' };
			},
		});
		await service.command({
			type: 'create',
			job: {
				...reminder(),
				target: { kind: 'code', threadId: 'code-one', prompt: 'Check the build' },
			},
		});
		await service.command({ type: 'create', job: reminder() });
		await service.tick();
		await settled(service, 'delivered');
		expect(service.snapshot().occurrences.some((item) => item.status === 'dispatching')).toBe(true);
		release!();
		await settled(service, 'admitted');
	});
	it('recovers interrupted delivery with its original identity and frozen context', async () => {
		const effects = new Set<string>();
		let calls = 0;
		const service = await create({
			now: () => 1000,
			dispatch: async (_job, occurrence, signal) => {
				calls++;
				effects.add(occurrence.id);
				await new Promise<void>((_resolve, reject) =>
					signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
				);
				return { status: 'delivered' };
			},
		});
		await service.command({
			type: 'create',
			job: { ...reminder(), origin: { kind: 'code', threadId: 'source-thread' } },
		});
		await service.tick();
		await settled(service, 'dispatching');
		const crashCopy = path.join(roots[0], 'crashed.json');
		await writeFile(crashCopy, await readFile(path.join(roots[0], 'schedule.json')));
		await service.close();
		const restored = await create({
			filename: crashCopy,
			now: () => 1000,
			dispatch: async (job, occurrence) => {
				calls++;
				effects.add(occurrence.id);
				expect(job.origin).toEqual({ kind: 'code', threadId: 'source-thread' });
				return { status: 'delivered' };
			},
		});
		await restored.tick();
		await settled(restored, 'delivered');
		await restored.tick();
		expect(calls).toBe(2);
		expect(effects.size).toBe(1);
		expect(restored.snapshot().occurrences).toHaveLength(1);
	});
	it('persists unavailable retries across restart without dropping them', async () => {
		let now = 1000;
		const service = await create({
			now: () => now,
			dispatch: async () => {
				throw new SchedulerUnavailableError('Host not ready');
			},
		});
		await service.command({ type: 'create', job: reminder() });
		await service.tick();
		await settled(service, 'waiting');
		await service.close();
		const dispatch = vi.fn(async () => ({ status: 'delivered' as const }));
		const restored = await create({
			filename: path.join(roots[0], 'schedule.json'),
			now: () => now,
			dispatch,
		});
		await restored.tick();
		expect(dispatch).not.toHaveBeenCalled();
		now = 6000;
		await restored.tick();
		await settled(restored, 'delivered');
		expect(restored.snapshot().occurrences).toHaveLength(1);
	});
	it('isolates failed jobs, exposes errors, and retries the same occurrence explicitly', async () => {
		let fail = true;
		const service = await create({
			now: () => 1000,
			dispatch: async (job) => {
				if (job.title === 'Bad' && fail) throw new Error('Destination was deleted');
				return { status: 'delivered' };
			},
		});
		await service.command({ type: 'create', job: { ...reminder(), title: 'Bad' } });
		await service.command({ type: 'create', job: reminder() });
		await service.tick();
		await settled(service, 'failed');
		await settled(service, 'delivered');
		const failed = service.snapshot().occurrences.find((item) => item.status === 'failed')!;
		expect(failed.error).toBe('Destination was deleted');
		fail = false;
		await service.command({ type: 'retry', occurrenceId: failed.id });
		await service.tick();
		await settled(service, 'delivered', 2);
		expect(service.snapshot().occurrences.find((item) => item.id === failed.id)?.attempts).toBe(2);
	});
	it.each(['pause', 'delete'] as const)(
		'%s cancels undispatched retries and never delivers them later',
		async (type) => {
			let now = 1000;
			const dispatch = vi.fn(async () => {
				throw new SchedulerUnavailableError('Unavailable');
			});
			const service = await create({ now: () => now, dispatch });
			const created = await service.command({ type: 'create', job: reminder() });
			await service.tick();
			await settled(service, 'waiting');
			await service.command({ type, id: created.jobId! });
			now = 10_000;
			await service.tick();
			expect(dispatch).toHaveBeenCalledTimes(1);
			expect(service.snapshot().occurrences[0].status).toBe('cancelled');
		},
	);
	it('resumes a paused due one-shot with the same identity after restart', async () => {
		let now = 1000;
		const service = await create({
			now: () => now,
			dispatch: async () => {
				throw new SchedulerUnavailableError('Code is not ready');
			},
		});
		const created = await service.command({
			type: 'create',
			job: { ...reminder(), target: { kind: 'code', threadId: 'thread-one', prompt: 'Check' } },
		});
		await service.tick();
		await settled(service, 'waiting');
		const original = service.snapshot().occurrences[0];
		await service.command({ type: 'pause', id: created.jobId! });
		expect(service.snapshot().occurrences[0].cancellationReason).toBe('paused');
		await service.close();
		now = 500_000;
		const dispatch = vi.fn(async () => ({ status: 'admitted' as const }));
		const restored = await create({
			filename: path.join(roots[0], 'schedule.json'),
			now: () => now,
			dispatch,
		});
		await restored.command({ type: 'resume', id: created.jobId! });
		expect(restored.snapshot().occurrences[0].id).toBe(original.id);
		await restored.tick();
		await settled(restored, 'admitted');
		expect(restored.snapshot().occurrences).toHaveLength(1);
		expect(restored.snapshot().occurrences[0].attempts).toBe(2);
		expect(dispatch).toHaveBeenCalledTimes(1);
	});
	it.each(['delivered', 'admitted', 'dismissed'] as const)(
		'resume does not replay an already %s occurrence',
		async (status) => {
			const dispatch = vi.fn(async () => ({
				status: status === 'admitted' ? ('admitted' as const) : ('delivered' as const),
			}));
			const service = await create({ now: () => 1000, dispatch });
			const created = await service.command({ type: 'create', job: reminder() });
			await service.tick();
			await settled(service, status === 'admitted' ? 'admitted' : 'delivered');
			if (status === 'dismissed')
				await service.command({
					type: 'dismiss',
					occurrenceId: service.snapshot().occurrences[0].id,
				});
			await service.command({ type: 'pause', id: created.jobId! });
			await service.command({ type: 'resume', id: created.jobId! });
			await service.tick();
			expect(service.snapshot().occurrences).toHaveLength(1);
			expect(service.snapshot().occurrences[0].status).toBe(status);
			expect(dispatch).toHaveBeenCalledTimes(1);
		},
	);
	it('resume leaves cancelled manual deliveries stopped and recurring schedules on future cadence', async () => {
		let now = 0,
			available = false;
		const service = await create({
			now: () => now,
			dispatch: async () => {
				if (!available) throw new SchedulerUnavailableError('Unavailable');
				return { status: 'delivered' };
			},
		});
		const recurring = await service.command({
			type: 'create',
			job: { ...reminder(), schedule: { kind: 'interval', intervalMinutes: 1 } },
		});
		const manual = await service.command({ type: 'create', job: reminder(1_000_000) });
		await service.command({ type: 'run-now', id: manual.jobId! });
		now = 60_000;
		await service.tick();
		await settled(service, 'waiting', 2);
		for (const id of [recurring.jobId!, manual.jobId!])
			await service.command({ type: 'pause', id });
		available = true;
		now = 100_000;
		for (const id of [recurring.jobId!, manual.jobId!])
			await service.command({ type: 'resume', id });
		await service.tick();
		expect(service.snapshot().occurrences.every((item) => item.status === 'cancelled')).toBe(true);
		now = 120_000;
		await service.tick();
		await settled(service, 'delivered');
		expect(
			service.snapshot().occurrences.filter((item) => item.status === 'cancelled'),
		).toHaveLength(2);
	});
	it('retains creation tombstones so a lost-reply retry cannot resurrect a deleted task after restart', async () => {
		const service = await create({ now: () => 0 });
		const command = { type: 'create' as const, job: reminder(), idempotencyKey: 'original-create' };
		const created = await service.command(command);
		await service.command({ type: 'delete', id: created.jobId! });
		await expect(service.command(command)).rejects.toThrow('was deleted');
		await service.close();
		const restored = await create({ filename: path.join(roots[0], 'schedule.json'), now: () => 0 });
		await expect(restored.command(command)).rejects.toThrow('was deleted');
		expect(restored.snapshot().jobs).toHaveLength(0);
		expect(restored.snapshot().occurrences).toHaveLength(0);
	});
	it('queues overlapping deliveries in order but skips them when configured', async () => {
		let now = 0,
			available = false;
		const service = await create({
			now: () => now,
			dispatch: async () => {
				if (!available) throw new SchedulerUnavailableError('Unavailable', 300_000);
				return { status: 'delivered' };
			},
		});
		for (const overlap of ['queue', 'skip'] as const)
			await service.command({
				type: 'create',
				job: {
					...reminder(),
					title: overlap,
					schedule: { kind: 'interval', intervalMinutes: 1, overlap },
				},
			});
		now = 60_000;
		await service.tick();
		await settled(service, 'waiting', 2);
		now = 120_000;
		await service.tick();
		expect(
			service.snapshot().occurrences.filter((item) => item.jobSnapshot.title === 'queue'),
		).toHaveLength(2);
		expect(
			service.snapshot().occurrences.filter((item) => item.jobSnapshot.title === 'skip'),
		).toHaveLength(1);
		expect(
			service.snapshot().occurrences.find((item) => item.scheduledAt === 120_000)?.status,
		).toBe('pending');
		available = true;
		for (const occurrence of service
			.snapshot()
			.occurrences.filter((item) => item.status === 'waiting'))
			await service.command({ type: 'retry', occurrenceId: occurrence.id });
		await service.tick();
		await settled(service, 'delivered', 2);
		await service.tick();
		await settled(service, 'delivered', 3);
	});
	it('snoozes atomically without moving the recurring cadence and deduplicates snooze retries', async () => {
		let now = 0;
		const service = await create({ now: () => now });
		const created = await service.command({
			type: 'create',
			job: { ...reminder(), schedule: { kind: 'interval', intervalMinutes: 1 } },
		});
		now = 60_000;
		await service.tick();
		await settled(service, 'delivered');
		const occurrenceId = service.snapshot().occurrences[0].id;
		const command = { type: 'snooze' as const, id: created.jobId!, until: 150_000, occurrenceId };
		await service.command(command);
		await service.command(command);
		expect(service.snapshot().occurrences).toHaveLength(2);
		expect(service.snapshot().jobs[0].nextRunAt).toBe(120_000);
		now = 120_000;
		await service.tick();
		await settled(service, 'delivered');
		now = 150_000;
		await service.tick();
		await settled(service, 'delivered', 2);
		expect(service.snapshot().jobs[0].nextRunAt).toBe(180_000);
	});
	it('preserves origin, rejects origin edits, and gives manual runs stable retry identities', async () => {
		const service = await create({ now: () => 0 });
		const created = await service.command({
			type: 'create',
			job: { ...reminder(), origin: { kind: 'code', threadId: 'one' } },
		});
		await expect(
			service.command({
				type: 'update',
				id: created.jobId!,
				patch: { origin: { kind: 'code', threadId: 'two' } },
			} as never),
		).rejects.toThrow('fields');
		await service.command({ type: 'update', id: created.jobId!, patch: { title: 'Renamed' } });
		expect(service.snapshot().jobs[0].origin).toEqual({ kind: 'code', threadId: 'one' });
		for (let i = 0; i < 2; i++)
			await service.command({ type: 'run-now', id: created.jobId!, idempotencyKey: 'run-once' });
		await service.tick();
		await settled(service, 'delivered');
		expect(service.snapshot().occurrences).toHaveLength(1);
	});
	it('replaces a waiting one-shot delivery when its target changes, retaining cancelled history', async () => {
		const dispatch = vi.fn(async (job) => {
			if (job.target.kind === 'code') throw new SchedulerUnavailableError('Open Code');
			return { status: 'delivered' as const };
		});
		const service = await create({ now: () => 1000, dispatch });
		const created = await service.command({
			type: 'create',
			job: { ...reminder(), target: { kind: 'code', threadId: 'one', prompt: 'Original' } },
		});
		await service.tick();
		await settled(service, 'waiting');
		const original = service.snapshot().occurrences[0];
		expect(service.snapshot().jobs[0].nextRunAt).toBeUndefined();
		const update = {
			type: 'update' as const,
			id: created.jobId!,
			patch: { target: { kind: 'reminder' as const, message: 'New reminder' } },
		};
		await service.command(update);
		await service.command(update);
		expect(service.snapshot().occurrences).toHaveLength(2);
		expect(service.snapshot().occurrences.find((item) => item.id === original.id)?.status).toBe(
			'cancelled',
		);
		const pending = service.snapshot().occurrences.find((item) => item.status === 'pending')!;
		expect(pending.id).not.toBe(original.id);
		expect(pending.scheduledAt).toBe(original.scheduledAt);
		expect(pending.jobSnapshot.target).toEqual({ kind: 'reminder', message: 'New reminder' });
		await service.tick();
		await settled(service, 'delivered');
		expect(dispatch).toHaveBeenCalledTimes(2);
	});
	it('keeps a pending delivery identity on a title edit and never resubmits a dismissed snooze', async () => {
		let now = 1000;
		const service = await create({ now: () => now });
		const created = await service.command({ type: 'create', job: reminder() });
		await service.tick();
		await settled(service, 'delivered');
		const snoozed = await service.command({
			type: 'snooze',
			id: created.jobId!,
			until: 5000,
			occurrenceId: service.snapshot().occurrences[0].id,
		});
		await service.command({ type: 'update', id: created.jobId!, patch: { title: 'Renamed' } });
		expect(
			service.snapshot().occurrences.find((item) => item.id === snoozed.occurrenceId)?.status,
		).toBe('pending');
		await service.command({ type: 'dismiss', occurrenceId: snoozed.occurrenceId! });
		now = 10_000;
		await service.tick();
		expect(
			service.snapshot().occurrences.filter((item) => item.status === 'dismissed'),
		).toHaveLength(2);
		expect(service.snapshot().occurrences).toHaveLength(2);
	});
	it('bounds unavailable retries without exhausting or dropping the pending request', async () => {
		let now = 1000;
		const service = await create({
			now: () => now,
			dispatch: async () => {
				throw new SchedulerUnavailableError('Not ready');
			},
		});
		await service.command({ type: 'create', job: reminder() });
		for (let attempt = 1; attempt <= 10; attempt++) {
			await service.tick();
			await settled(service, 'waiting');
			const occurrence = service.snapshot().occurrences[0];
			expect(occurrence.attempts).toBe(attempt);
			expect(occurrence.retryAt! - now).toBe(Math.min(300_000, 5000 * 2 ** (attempt - 1)));
			now = occurrence.retryAt!;
		}
		expect(service.snapshot().occurrences).toHaveLength(1);
	});
	it('refuses admission at the active-record limit instead of silently dropping pending work', async () => {
		const service = await create({ now: () => 0 });
		const created = await service.command({ type: 'create', job: reminder() });
		await service.command({ type: 'run-now', id: created.jobId! });
		await service.close();
		const filename = path.join(roots[0], 'schedule.json'),
			state = JSON.parse(await readFile(filename, 'utf8'));
		state.occurrences = Array.from({ length: 2000 }, (_, index) => ({
			...state.occurrences[0],
			id: `pending-${index}`,
		}));
		await writeFile(filename, JSON.stringify(state));
		const restored = await create({ filename, now: () => 0 });
		await expect(restored.command({ type: 'run-now', id: created.jobId! })).rejects.toThrow(
			'history is full',
		);
		expect(restored.snapshot().occurrences).toHaveLength(2000);
		expect(restored.snapshot().occurrences.every((item) => item.status === 'pending')).toBe(true);
	});
	it('rejects foreign host data without dispatching or replacing the file', async () => {
		const service = await create();
		await service.command({ type: 'create', job: reminder() });
		await service.close();
		const filename = path.join(roots[0], 'schedule.json'),
			before = await readFile(filename, 'utf8');
		await expect(create({ filename, hostId: 'another-host' })).rejects.toThrow(
			'different owning host',
		);
		expect(await readFile(filename, 'utf8')).toBe(before);
	});
	it('validates untrusted commands, dates, recurrence, and target fields', () => {
		for (const command of [
			null,
			{ type: 'other' },
			{ type: 'create', job: { ...reminder(), hostId: 'foreign' } },
			{ type: 'create', job: { ...reminder(), schedule: { kind: 'once', at: 1e300 } } },
			{
				type: 'create',
				job: { ...reminder(), schedule: { kind: 'interval', intervalMinutes: 0 } },
			},
			{
				type: 'create',
				job: { ...reminder(), target: { kind: 'code', threadId: 'one', prompt: '' } },
			},
			{
				type: 'create',
				job: { ...reminder(), schedule: { kind: 'daily', time: '25:00', timezone: 'UTC' } },
			},
			{
				type: 'create',
				job: {
					...reminder(),
					schedule: { kind: 'daily', time: '09:00', timezone: 'Invalid/Zone' },
				},
			},
		])
			expect(() => validateSchedulerCommand(command)).toThrow();
	});
	it('uses the existing timezone and DST rules for both scheduler surfaces', () => {
		expect(
			nextScheduleAt(
				{ kind: 'daily', time: '02:30', timezone: 'America/New_York' },
				Date.parse('2026-03-08T06:00:00Z'),
			),
		).toBe(Date.parse('2026-03-09T06:30:00Z'));
		expect(
			nextScheduleAt(
				{ kind: 'daily', time: '01:30', timezone: 'America/New_York' },
				Date.parse('2026-11-01T05:30:00Z'),
			),
		).toBe(Date.parse('2026-11-02T06:30:00Z'));
		expect(
			nextScheduleAt(
				{ kind: 'weekly', time: '09:00', timezone: 'UTC', weekdays: [1] },
				Date.parse('2026-10-17T12:00:00Z'),
			),
		).toBe(Date.parse('2026-10-19T09:00:00Z'));
	});
	it('isolates an existing workflow schedule admission error from later schedules', async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), 'freelm-workflow-schedules-'));
		roots.push(directory);
		const store = new WorkflowStore(directory);
		await store.init();
		const workflows = ['bad', 'good'].map((id): WorkflowDefinition => ({
			id,
			version: 1,
			name: id,
			enabled: true,
			createdAt: 0,
			updatedAt: 0,
			edges: [],
			nodes: [
				{
					id: 'once',
					type: 'schedule',
					label: 'Due',
					position: { x: 0, y: 0 },
					config: { kind: 'once', at: 1000 },
				},
			],
		}));
		const start = vi.fn(async (id: string) => {
			if (id === 'bad') throw new Error('Could not admit');
		});
		const onError = vi.fn();
		const scheduler = new WorkflowScheduler({
			store,
			workflows: () => workflows,
			runs: () => [],
			start,
			onError,
		});
		await scheduler.tick(1000);
		expect(start.mock.calls.map((call) => call[0])).toEqual(['bad', 'good']);
		expect(onError).toHaveBeenCalledTimes(1);
		await scheduler.dispose();
	});
});
