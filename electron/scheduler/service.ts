import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type {
	SchedulerCommand,
	SchedulerCommandResult,
	SchedulerDispatchResult,
	SchedulerJob,
	SchedulerJobInput,
	SchedulerOccurrence,
	SchedulerSnapshot,
} from '../../src/scheduler-types';
import { atomicWrite, jsonPayloadAsync } from '../json-file';
import { dateValue, nextScheduleAt } from './recurrence';
import {
	schedulerText,
	validateSchedulerCommand,
	validateSchedulerInput,
	validateSchedulerResult,
} from './validation';

export { validateSchedulerCommand } from './validation';

/** The target is temporarily unavailable. Keep the same occurrence and retry later. */
export class SchedulerUnavailableError extends Error {
	constructor(
		message: string,
		readonly retryAfterMs?: number,
	) {
		super(message);
		this.name = 'SchedulerUnavailableError';
	}
}

export interface SchedulerServiceOptions {
	filename: string;
	hostId: string;
	dispatch(
		job: SchedulerJob,
		occurrence: SchedulerOccurrence,
		signal: AbortSignal,
	): Promise<SchedulerDispatchResult>;
	now?: () => number;
	onChange?: () => void;
	onError?: (error: unknown) => void;
	/** Timers are disabled for deterministic tests; commands then require an explicit tick. */
	autoStart?: boolean;
}
interface SchedulerState extends SchedulerSnapshot {
	version: 1;
	hostId: string;
	creationRequests: Record<string, string>;
}
const ACTIVE = new Set(['pending', 'dispatching', 'waiting']);
const RETAIN = new Set([...ACTIVE, 'failed']);
const STATUSES = new Set([...RETAIN, 'delivered', 'admitted', 'cancelled', 'dismissed']);
const MAX_JOBS = 500;
const MAX_OCCURRENCES = 2000;
const MAX_CREATION_REQUESTS = 10_000;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const errorMessage = (error: unknown) =>
	(error instanceof Error ? error.message : String(error)).slice(0, 2000) ||
	'Scheduled delivery failed.';
const finiteTime = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(new Date(value).getTime());

/** One durable host clock and dispatch queue shared by reminders, Bots, and Code. */
export class SchedulerService {
	private state: SchedulerState;
	private serial: Promise<unknown> = Promise.resolve();
	private initializing?: Promise<void>;
	private initialized = false;
	private started = false;
	private closed = false;
	private timer?: ReturnType<typeof setInterval>;
	private ticking?: Promise<void>;
	private active = new Map<
		string,
		{ jobId: string; reminder: boolean; controller: AbortController; promise: Promise<void> }
	>();
	constructor(private readonly options: SchedulerServiceOptions) {
		schedulerText(options.hostId, 'Scheduler host ID');
		this.state = {
			version: 1,
			hostId: options.hostId,
			jobs: [],
			occurrences: [],
			creationRequests: {},
		};
	}
	private now() {
		return this.options.now?.() ?? Date.now();
	}
	private report(error: unknown) {
		try {
			this.options.onError?.(error);
		} catch {
			/* Reporting must not stop the clock. */
		}
	}
	private changed() {
		try {
			this.options.onChange?.();
		} catch (error) {
			this.report(error);
		}
	}
	private locked<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.serial.catch(() => undefined).then(operation);
		this.serial = result;
		return result;
	}
	private async commit(next: SchedulerState) {
		await atomicWrite(this.options.filename, await jsonPayloadAsync(next));
		this.state = next;
		this.changed();
	}
	init(): Promise<void> {
		return (this.initializing ??= this.initialize());
	}
	private async initialize() {
		if (this.closed) throw new Error('Scheduler is closed.');
		try {
			if ((await stat(this.options.filename)).size > 128 * 1024 * 1024)
				throw new Error(
					'Scheduler data exceeds the supported size. The saved data was not changed.',
				);
			const saved = JSON.parse(await readFile(this.options.filename, 'utf8')) as SchedulerState;
			this.validateState(saved);
			this.state = saved;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
		const next = structuredClone(this.state);
		let recovered = false;
		for (const occurrence of next.occurrences) {
			if (occurrence.status !== 'dispatching') continue;
			const job = next.jobs.find((job) => job.id === occurrence.jobId);
			occurrence.status = job?.enabled ? 'waiting' : 'cancelled';
			occurrence.cancellationReason = job?.enabled ? undefined : job ? 'paused' : 'deleted';
			occurrence.retryAt = job?.enabled ? this.now() : undefined;
			occurrence.error = job?.enabled
				? 'FreeLM restarted during delivery. Retrying the same delivery identity.'
				: 'This schedule is paused or deleted.';
			occurrence.updatedAt = this.now();
			recovered = true;
		}
		if (recovered) await this.commit(next);
		this.initialized = true;
		if (this.options.autoStart !== false) this.start();
	}
	/** Start only after destination adapters are attached and ready to accept durable admission. */
	start(): void {
		this.requireReady();
		if (this.started) return;
		this.started = true;
		this.timer = setInterval(() => {
			void this.tick().catch((error) => this.report(error));
		}, 1000);
		this.timer.unref?.();
		void this.tick().catch((error) => this.report(error));
	}
	private validateState(value: SchedulerState) {
		if (
			!value ||
			value.version !== 1 ||
			value.hostId !== this.options.hostId ||
			!Array.isArray(value.jobs) ||
			!Array.isArray(value.occurrences) ||
			value.jobs.length > MAX_JOBS ||
			value.occurrences.length > MAX_OCCURRENCES ||
			!value.creationRequests ||
			typeof value.creationRequests !== 'object' ||
			Array.isArray(value.creationRequests) ||
			Object.keys(value.creationRequests).length > MAX_CREATION_REQUESTS
		)
			throw new Error(
				'Invalid scheduler data or a different owning host. The saved data was not changed.',
			);
		const validateJob = (job: SchedulerJob) => {
			if (!job || typeof job !== 'object') throw new Error('Invalid saved schedule.');
			validateSchedulerInput({
				title: job.title,
				schedule: job.schedule,
				target: job.target,
				...(job.origin !== undefined ? { origin: job.origin } : {}),
			});
			schedulerText(job.id, 'Schedule ID');
			if (
				job.hostId !== this.options.hostId ||
				typeof job.enabled !== 'boolean' ||
				!finiteTime(job.createdAt) ||
				!finiteTime(job.updatedAt) ||
				(job.nextRunAt !== undefined && !finiteTime(job.nextRunAt)) ||
				(job.lastRunAt !== undefined && !finiteTime(job.lastRunAt))
			)
				throw new Error('Invalid saved schedule metadata.');
		};
		for (const job of value.jobs) validateJob(job);
		if (new Set(value.jobs.map((job) => job.id)).size !== value.jobs.length)
			throw new Error('Duplicate saved schedules.');
		for (const occurrence of value.occurrences) {
			schedulerText(occurrence.id, 'Occurrence ID');
			schedulerText(occurrence.jobId, 'Schedule ID');
			validateJob(occurrence.jobSnapshot);
			if (
				occurrence.hostId !== this.options.hostId ||
				occurrence.jobSnapshot.id !== occurrence.jobId ||
				!STATUSES.has(occurrence.status) ||
				!['scheduled', 'manual'].includes(occurrence.kind) ||
				!finiteTime(occurrence.createdAt) ||
				!finiteTime(occurrence.updatedAt) ||
				!finiteTime(occurrence.scheduledAt) ||
				!Number.isSafeInteger(occurrence.attempts) ||
				occurrence.attempts < 0 ||
				(occurrence.retryAt !== undefined && !finiteTime(occurrence.retryAt)) ||
				(occurrence.cancellationReason !== undefined &&
					!['paused', 'deleted', 'edited'].includes(occurrence.cancellationReason))
			)
				throw new Error('Invalid saved delivery metadata.');
			if (occurrence.result) validateSchedulerResult(occurrence.result);
		}
		if (
			new Set(value.occurrences.map((occurrence) => occurrence.id)).size !==
			value.occurrences.length
		)
			throw new Error('Duplicate saved deliveries.');
		for (const [id, fingerprint] of Object.entries(value.creationRequests))
			if (!/^scheduled-[a-f0-9]{64}$/.test(id) || !/^[a-f0-9]{64}$/.test(fingerprint))
				throw new Error('Invalid saved schedule request.');
	}
	snapshot(): SchedulerSnapshot {
		return structuredClone({
			jobs: [...this.state.jobs].sort((a, b) => b.updatedAt - a.updatedAt),
			occurrences: [...this.state.occurrences].sort(
				(a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id),
			),
		});
	}
	private requireReady() {
		if (!this.initialized) throw new Error('Scheduler is not ready.');
		if (this.closed) throw new Error('Scheduler is closed.');
	}
	private job(state: SchedulerState, id: string): SchedulerJob {
		const job = state.jobs.find((job) => job.id === id);
		if (!job) throw new Error('Scheduled task not found on this host.');
		return job;
	}
	private occurrence(state: SchedulerState, id: string): SchedulerOccurrence {
		const occurrence = state.occurrences.find((item) => item.id === id);
		if (!occurrence) throw new Error('Scheduled delivery not found.');
		return occurrence;
	}
	private cancelPending(
		state: SchedulerState,
		id: string,
		reason: string,
		cancellationReason: SchedulerOccurrence['cancellationReason'],
	) {
		for (const occurrence of state.occurrences)
			if (occurrence.jobId === id && ['pending', 'waiting'].includes(occurrence.status)) {
				occurrence.status = 'cancelled';
				occurrence.error = reason;
				occurrence.cancellationReason = cancellationReason;
				occurrence.updatedAt = this.now();
				delete occurrence.retryAt;
			}
	}
	private resumable(state: SchedulerState, occurrence: SchedulerOccurrence): boolean {
		const job = state.jobs.find((item) => item.id === occurrence.jobId);
		return (
			occurrence.status === 'cancelled' &&
			occurrence.cancellationReason === 'paused' &&
			occurrence.kind === 'scheduled' &&
			job?.schedule.kind === 'once' &&
			job.nextRunAt === undefined &&
			dateValue(job.schedule.at) === occurrence.scheduledAt
		);
	}
	private makeRoom(state: SchedulerState) {
		while (state.occurrences.length >= MAX_OCCURRENCES) {
			const oldest = state.occurrences
				.filter((item) => !RETAIN.has(item.status) && !this.resumable(state, item))
				.sort((a, b) => a.updatedAt - b.updatedAt)[0];
			if (!oldest)
				throw new Error(
					'Scheduled delivery history is full. Dismiss old failures or cancel pending tasks before adding work.',
				);
			state.occurrences = state.occurrences.filter((item) => item.id !== oldest.id);
		}
	}
	private addOccurrence(
		state: SchedulerState,
		job: SchedulerJob,
		scheduledAt: number,
		kind: 'scheduled' | 'manual',
		id: string,
	): SchedulerOccurrence {
		const existing = state.occurrences.find((item) => item.id === id);
		if (existing) return existing;
		this.makeRoom(state);
		const occurrence: SchedulerOccurrence = {
			id,
			jobId: job.id,
			hostId: job.hostId,
			scheduledAt,
			kind,
			status: 'pending',
			attempts: 0,
			createdAt: this.now(),
			updatedAt: this.now(),
			jobSnapshot: structuredClone(job),
		};
		state.occurrences.push(occurrence);
		return occurrence;
	}
	private initial(job: SchedulerJobInput, now: number) {
		return job.schedule.kind === 'once'
			? dateValue(job.schedule.at)
			: nextScheduleAt(job.schedule, now);
	}
	async command(input: SchedulerCommand): Promise<SchedulerCommandResult> {
		validateSchedulerCommand(input);
		const command = structuredClone(input);
		const result = await this.locked(async () => {
			this.requireReady();
			const next = structuredClone(this.state);
			const now = this.now();
			let jobId: string | undefined, occurrenceId: string | undefined;
			if (command.type === 'create') {
				jobId = command.idempotencyKey
					? `scheduled-${hash([this.options.hostId, command.idempotencyKey])}`
					: randomUUID();
				const fingerprint = hash(command.job),
					existing = next.jobs.find((job) => job.id === jobId);
				if (existing) {
					if (next.creationRequests[jobId] !== fingerprint)
						throw new Error('This idempotency key was used for a different scheduled task.');
					return { ...this.snapshot(), jobId };
				}
				if (next.creationRequests[jobId])
					throw new Error(
						'This scheduled task was deleted. A retried creation cannot restore it; use a new idempotency key to create a new task.',
					);
				if (
					command.idempotencyKey &&
					Object.keys(next.creationRequests).length >= MAX_CREATION_REQUESTS
				)
					throw new Error(
						'The scheduler creation journal is full (10,000 requests). Existing tasks and deletion receipts have been preserved.',
					);
				if (next.jobs.length >= MAX_JOBS)
					throw new Error(
						'You have reached 500 scheduled tasks. Delete an old task before adding another.',
					);
				const job: SchedulerJob = {
					...command.job,
					id: jobId,
					hostId: this.options.hostId,
					enabled: true,
					createdAt: now,
					updatedAt: now,
					nextRunAt: this.initial(command.job, now),
				};
				job.schedule.missed ??= job.schedule.kind === 'once' ? 'once' : 'skip';
				job.schedule.overlap ??= 'skip';
				next.jobs.push(job);
				if (command.idempotencyKey) next.creationRequests[jobId] = fingerprint;
			} else if (command.type === 'retry' || command.type === 'dismiss') {
				const occurrence = this.occurrence(next, command.occurrenceId);
				jobId = occurrence.jobId;
				occurrenceId = occurrence.id;
				if (occurrence.status === 'dispatching')
					throw new Error('This delivery has already started. Wait for its result.');
				if (command.type === 'retry') {
					const job = this.job(next, occurrence.jobId);
					if (!job.enabled) throw new Error('Resume the scheduled task before retrying.');
					if (!['failed', 'waiting'].includes(occurrence.status))
						throw new Error('Only a failed or waiting delivery can be retried.');
					occurrence.status = 'pending';
					occurrence.retryAt = now;
				} else {
					occurrence.status = 'dismissed';
					delete occurrence.retryAt;
				}
				occurrence.updatedAt = now;
				delete occurrence.error;
			} else {
				const job = this.job(next, command.id);
				jobId = job.id;
				job.updatedAt = now;
				if (command.type === 'update') {
					const targetChanged =
						command.patch.target !== undefined && hash(command.patch.target) !== hash(job.target);
					const replacements =
						targetChanged && !command.patch.schedule
							? next.occurrences.filter(
									(item) => item.jobId === job.id && ['pending', 'waiting'].includes(item.status),
								)
							: [];
					if (command.patch.schedule || targetChanged)
						this.cancelPending(
							next,
							job.id,
							'The schedule was edited before this delivery started.',
							'edited',
						);
					Object.assign(job, command.patch);
					if (command.patch.schedule) {
						job.schedule.missed ??= job.schedule.kind === 'once' ? 'once' : 'skip';
						job.schedule.overlap ??= 'skip';
						job.nextRunAt = this.initial(job, now);
					}
					for (const previous of replacements)
						this.addOccurrence(
							next,
							job,
							previous.scheduledAt,
							previous.kind,
							`replacement-${hash([previous.id, job.target])}`,
						);
					delete job.lastError;
				} else if (command.type === 'pause' || command.type === 'delete') {
					job.enabled = false;
					this.cancelPending(
						next,
						job.id,
						command.type === 'pause' ? 'The schedule was paused.' : 'The schedule was deleted.',
						command.type === 'pause' ? 'paused' : 'deleted',
					);
					if (command.type === 'delete') {
						next.jobs = next.jobs.filter((item) => item.id !== job.id);
						// Keep the creation receipt as a tombstone: an old tool retry cannot undo deletion.
					}
				} else if (command.type === 'resume') {
					job.enabled = true;
					delete job.lastError;
					// Resuming a due one-shot restores its undelivered intent. Recurring schedules
					// keep their future cadence, and user-dismissed/manual deliveries stay stopped.
					for (const occurrence of [...next.occurrences]) {
						if (occurrence.jobId !== job.id || !this.resumable(next, occurrence)) continue;
						if (hash(occurrence.jobSnapshot.target) !== hash(job.target)) {
							occurrence.cancellationReason = 'edited';
							occurrence.error = 'The destination was edited while this delivery was paused.';
							this.addOccurrence(
								next,
								job,
								occurrence.scheduledAt,
								occurrence.kind,
								`replacement-${hash([occurrence.id, job.target])}`,
							);
						} else {
							occurrence.status = 'pending';
							occurrence.retryAt = now;
							delete occurrence.error;
							delete occurrence.cancellationReason;
						}
						occurrence.updatedAt = now;
					}
				} else if (command.type === 'run-now') {
					if (!job.enabled) throw new Error('Resume the scheduled task before running it.');
					occurrenceId = command.idempotencyKey
						? `manual-${hash([job.id, command.idempotencyKey])}`
						: randomUUID();
					this.addOccurrence(next, job, now, 'manual', occurrenceId);
				} else if (command.type === 'snooze') {
					if (!job.enabled) throw new Error('Resume the reminder before snoozing.');
					if (job.target.kind !== 'reminder') throw new Error('Only reminders can be snoozed.');
					if (command.until <= now) throw new Error('Snooze must be in the future.');
					if (command.occurrenceId) {
						const previous = this.occurrence(next, command.occurrenceId);
						if (previous.jobId !== job.id || !['delivered', 'dismissed'].includes(previous.status))
							throw new Error('Only a delivered reminder from this schedule can be snoozed.');
						previous.status = 'dismissed';
						previous.updatedAt = now;
					}
					occurrenceId = command.occurrenceId
						? `snooze-${hash([command.occurrenceId, command.until])}`
						: randomUUID();
					this.addOccurrence(next, job, command.until, 'manual', occurrenceId);
				}
			}
			await this.commit(next);
			return { ...this.snapshot(), jobId, occurrenceId };
		});
		if (this.started) void this.tick().catch((error) => this.report(error));
		return result;
	}
	tick(): Promise<void> {
		if (this.closed) return Promise.resolve();
		if (this.ticking) return this.ticking;
		this.ticking = this.locked(async () => {
			if (this.closed) return;
			this.requireReady();
			const now = this.now();
			const enabled = new Set(this.state.jobs.filter((job) => job.enabled).map((job) => job.id));
			if (
				!this.state.jobs.some(
					(job) => job.enabled && job.nextRunAt !== undefined && job.nextRunAt <= now,
				) &&
				!this.state.occurrences.some(
					(item) =>
						enabled.has(item.jobId) &&
						['pending', 'waiting'].includes(item.status) &&
						item.scheduledAt <= now &&
						(item.retryAt === undefined || item.retryAt <= now),
				)
			)
				return;
			const next = structuredClone(this.state);
			let changed = false;
			for (const job of next.jobs) {
				if (!job.enabled || job.nextRunAt === undefined || job.nextRunAt > now) continue;
				try {
					const due = job.nextRunAt;
					const missed = now - due >= 60_000;
					const busy = next.occurrences.some(
						(item) => item.jobId === job.id && item.scheduledAt <= now && ACTIVE.has(item.status),
					);
					if (
						(!missed || job.schedule.missed === 'once') &&
						(!busy || job.schedule.overlap === 'queue')
					)
						this.addOccurrence(next, job, due, 'scheduled', `occurrence-${hash([job.id, due])}`);
					job.lastRunAt = due;
					job.nextRunAt = nextScheduleAt(
						job.schedule.kind === 'interval' ? { ...job.schedule, at: due } : job.schedule,
						now,
					);
					delete job.lastError;
					changed = true;
				} catch (error) {
					const message = errorMessage(error);
					if (job.lastError !== message) {
						job.lastError = message;
						changed = true;
						this.report(error);
					}
				}
			}
			const dispatch: SchedulerOccurrence[] = [];
			const occupied = new Set([...this.active.values()].map((value) => value.jobId));
			let reminders = [...this.active.values()].filter((value) => value.reminder).length;
			let tasks = this.active.size - reminders;
			for (const occurrence of [...next.occurrences].sort(
				(a, b) => a.scheduledAt - b.scheduledAt || a.createdAt - b.createdAt,
			)) {
				if (
					!['pending', 'waiting'].includes(occurrence.status) ||
					occurrence.scheduledAt > now ||
					(occurrence.retryAt !== undefined && occurrence.retryAt > now) ||
					occupied.has(occurrence.jobId)
				)
					continue;
				const job = next.jobs.find((job) => job.id === occurrence.jobId);
				if (!job?.enabled) continue;
				const reminder = occurrence.jobSnapshot.target.kind === 'reminder';
				if (reminder ? reminders >= 8 : tasks >= 4) continue;
				// Preserve FIFO for an overlap queue even when the preceding delivery is in backoff.
				if (
					next.occurrences.some(
						(other) =>
							other.id !== occurrence.id &&
							other.jobId === occurrence.jobId &&
							ACTIVE.has(other.status) &&
							(other.scheduledAt < occurrence.scheduledAt ||
								(other.scheduledAt === occurrence.scheduledAt &&
									other.createdAt < occurrence.createdAt)),
					)
				)
					continue;
				occurrence.status = 'dispatching';
				occurrence.attempts++;
				occurrence.updatedAt = now;
				delete occurrence.retryAt;
				delete occurrence.error;
				dispatch.push(occurrence);
				occupied.add(occurrence.jobId);
				if (reminder) reminders++;
				else tasks++;
				changed = true;
			}
			if (changed) await this.commit(next);
			for (const occurrence of dispatch) this.launch(occurrence);
		}).finally(() => {
			this.ticking = undefined;
		});
		return this.ticking;
	}
	private launch(occurrence: SchedulerOccurrence) {
		const controller = new AbortController();
		const copy = structuredClone(occurrence);
		const promise = Promise.resolve()
			.then(() => this.options.dispatch(copy.jobSnapshot, copy, controller.signal))
			.then((result) => {
				validateSchedulerResult(result);
				return this.finish(copy.id, result);
			})
			.catch((error) => this.finish(copy.id, undefined, error))
			.catch((error) => this.report(error))
			.finally(() => {
				this.active.delete(copy.id);
				if (!this.closed && this.started) void this.tick().catch((error) => this.report(error));
			});
		this.active.set(copy.id, {
			jobId: copy.jobId,
			reminder: copy.jobSnapshot.target.kind === 'reminder',
			controller,
			promise,
		});
	}
	private finish(id: string, result?: SchedulerDispatchResult, error?: unknown) {
		return this.locked(async () => {
			const next = structuredClone(this.state),
				occurrence = this.occurrence(next, id),
				now = this.now();
			const job = next.jobs.find((job) => job.id === occurrence.jobId);
			occurrence.updatedAt = now;
			if (result) {
				occurrence.result = structuredClone(result);
				occurrence.status = result.status;
				delete occurrence.error;
				if (job) delete job.lastError;
			} else if (error instanceof SchedulerUnavailableError || this.closed) {
				occurrence.status = job?.enabled ? 'waiting' : 'cancelled';
				occurrence.cancellationReason = job?.enabled ? undefined : job ? 'paused' : 'deleted';
				occurrence.error = errorMessage(error);
				if (job?.enabled) {
					const backoff = Math.min(300_000, 5000 * 2 ** Math.min(occurrence.attempts - 1, 6));
					const requested =
						error instanceof SchedulerUnavailableError && Number.isFinite(error.retryAfterMs)
							? Math.max(1000, Math.min(300_000, error.retryAfterMs!))
							: backoff;
					occurrence.retryAt = now + requested;
				}
			} else {
				occurrence.status = 'failed';
				occurrence.error = errorMessage(error);
				if (job) job.lastError = occurrence.error;
				this.report(error);
			}
			await this.commit(next);
		});
	}
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		if (this.timer) clearInterval(this.timer);
		await this.ticking?.catch((error) => this.report(error));
		for (const item of this.active.values())
			item.controller.abort(
				new SchedulerUnavailableError(
					'FreeLM is shutting down. Delivery will resume when it opens.',
				),
			);
		await Promise.all([...this.active.values()].map((item) => item.promise));
		// A rejected user command was already returned to its caller; it must not prevent shutdown.
		await this.serial.catch(() => undefined);
	}
}
