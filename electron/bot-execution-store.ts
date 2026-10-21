import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { atomicWrite, jsonPayload } from './json-file';

export type BotRunStatus = 'pending' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled';
export type BotActionStatus =
	| 'pending'
	| 'awaiting_approval'
	| 'running'
	| 'succeeded'
	| 'failed'
	| 'outcome_unknown'
	| 'cancelled';
export interface BotToolExecutionPolicy {
	mode: 'sync' | 'async';
	readOnly: boolean;
}
export interface BotExecutionRun {
	id: string;
	/** Caller key is namespaced by host, bot, conversation and trigger. */
	key: string;
	hostId: string;
	botId: string;
	conversationId: string;
	triggerId: string;
	status: BotRunStatus;
	context?: unknown;
	seenUserMessageIds: string[];
	pendingToolCalls: unknown[];
	incomingMessages?: unknown[];
	error?: string;
	createdAt: number;
	updatedAt: number;
}
export interface BotExecutionAction extends BotToolExecutionPolicy {
	id: string;
	runId: string;
	stepKey: string;
	/** Stable host-generated identity, independent of provider call IDs. */
	operationId: string;
	toolName: string;
	args: unknown;
	status: BotActionStatus;
	/** Approval applies only to this immutable tool/arguments/policy tuple. */
	approvalGrantedAt?: number;
	result?: unknown;
	error?: string;
	attempts: number;
	createdAt: number;
	updatedAt: number;
}
export interface BotExecutionJob {
	id: string;
	actionId: string;
	runId: string;
	status: BotActionStatus;
	context?: unknown;
	result?: unknown;
	error?: string;
	notificationDelivered: boolean;
	createdAt: number;
	updatedAt: number;
}
interface BotExecutionData {
	format: 'freelm-bot-execution-v1';
	revision: number;
	runs: BotExecutionRun[];
	actions: BotExecutionAction[];
	jobs: BotExecutionJob[];
}
export interface BotExecutionStoreOptions {
	filename: string;
	now?: () => number;
	id?: () => string;
	maxBytes?: number;
	onChanged?: () => void;
}
export interface BotRunInput {
	key?: string;
	hostId: string;
	botId: string;
	conversationId: string;
	triggerId: string;
	context?: unknown;
	seenUserMessageIds?: string[];
	pendingToolCalls?: unknown[];
}
export type BotRunUpdate = Partial<
	Pick<BotExecutionRun, 'status' | 'context' | 'seenUserMessageIds' | 'pendingToolCalls' | 'error'>
>;
export interface BotActionInput extends Partial<BotToolExecutionPolicy> {
	runId: string;
	stepKey: string;
	toolName: string;
	args: unknown;
}
export interface BotExecutionFilter {
	runId?: string;
	hostId?: string;
	botId?: string;
	conversationId?: string;
	status?: BotActionStatus | BotRunStatus;
}
export interface BotActionFailureOptions {
	/** Set false only when the executor knows the action did not have uncertain effects. */
	outcomeUnknown?: boolean;
}

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const MAX_RUNS = 10_000,
	MAX_ACTIONS = 100_000,
	MAX_JOBS = 20_000;
const runStatuses = new Set<BotRunStatus>([
	'pending',
	'running',
	'waiting',
	'succeeded',
	'failed',
	'cancelled',
]);
const actionStatuses = new Set<BotActionStatus>([
	'pending',
	'awaiting_approval',
	'running',
	'succeeded',
	'failed',
	'outcome_unknown',
	'cancelled',
]);
const terminal = (status: BotActionStatus) =>
	status === 'succeeded' ||
	status === 'failed' ||
	status === 'cancelled' ||
	status === 'outcome_unknown';
const object = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === 'object' && !Array.isArray(value);
const validText = (value: unknown, max = 2048): value is string =>
	typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const validTime = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0;
const fail = (message: string): never => {
	throw new Error(message);
};

/** Reject unsupported values rather than silently dropping executable or non-JSON state. */
function jsonClone<T>(value: T): T {
	if (value === undefined) return value;
	const text = JSON.stringify(value, (_key, item: unknown) => {
		if (
			typeof item === 'function' ||
			typeof item === 'symbol' ||
			typeof item === 'bigint' ||
			(typeof item === 'number' && !Number.isFinite(item)) ||
			(object(item) &&
				Object.getPrototypeOf(item) !== Object.prototype &&
				Object.getPrototypeOf(item) !== null)
		)
			fail('Bot execution state must contain only serializable JSON data.');
		return item;
	});
	return JSON.parse(text) as T;
}
function canonical(value: unknown): string {
	const sorted = (item: unknown): unknown =>
		Array.isArray(item)
			? item.map(sorted)
			: object(item)
				? Object.fromEntries(
						Object.keys(item)
							.sort()
							.map((key) => [key, sorted(item[key])]),
					)
				: item;
	return JSON.stringify(sorted(jsonClone(value)));
}
function requireText(value: unknown, label: string, max?: number): asserts value is string {
	if (!validText(value, max)) fail(`${label} is invalid.`);
}
function errorText(error: unknown): string {
	const text =
		error instanceof Error
			? error.message
			: typeof error === 'string'
				? error
				: 'The action failed.';
	if (text.length > 16_384) fail('The bot action error exceeds the 16 KiB character limit.');
	return text;
}
function runKey(
	input: Pick<BotRunInput, 'hostId' | 'botId' | 'conversationId' | 'triggerId' | 'key'>,
) {
	return JSON.stringify([
		input.hostId,
		input.botId,
		input.conversationId,
		input.triggerId,
		input.key ?? '',
	]);
}
function validateStore(value: unknown): asserts value is BotExecutionData {
	const invalid = () =>
		fail('The saved bot execution journal is invalid. Preserve it before making changes.');
	if (
		!object(value) ||
		value.format !== 'freelm-bot-execution-v1' ||
		!Number.isSafeInteger(value.revision) ||
		Number(value.revision) < 0 ||
		!Array.isArray(value.runs) ||
		value.runs.length > MAX_RUNS ||
		!Array.isArray(value.actions) ||
		value.actions.length > MAX_ACTIONS ||
		!Array.isArray(value.jobs) ||
		value.jobs.length > MAX_JOBS
	)
		invalid();
	const data = value as unknown as BotExecutionData;
	const ids = new Set<string>(),
		keys = new Set<string>(),
		operations = new Set<string>();
	for (const run of data.runs) {
		if (
			!object(run) ||
			!validText(run.id) ||
			ids.has(run.id) ||
			!validText(run.key) ||
			!validText(run.hostId) ||
			!validText(run.botId) ||
			!validText(run.conversationId) ||
			!validText(run.triggerId) ||
			!runStatuses.has(run.status) ||
			!Array.isArray(run.seenUserMessageIds) ||
			run.seenUserMessageIds.length > 10_000 ||
			!run.seenUserMessageIds.every((id) => validText(id)) ||
			!Array.isArray(run.pendingToolCalls) ||
			run.pendingToolCalls.length > 1000 ||
			(run.incomingMessages !== undefined &&
				(!Array.isArray(run.incomingMessages) || run.incomingMessages.length > 1000)) ||
			!validTime(run.createdAt) ||
			!validTime(run.updatedAt) ||
			(run.error !== undefined && (typeof run.error !== 'string' || run.error.length > 16_384))
		)
			invalid();
		const key = runKey(run);
		if (keys.has(key)) invalid();
		ids.add(run.id);
		keys.add(key);
	}
	const runs = new Set(data.runs.map((run) => run.id));
	keys.clear();
	for (const action of data.actions) {
		if (
			!object(action) ||
			!validText(action.id) ||
			ids.has(action.id) ||
			!runs.has(action.runId) ||
			!validText(action.stepKey) ||
			!validText(action.operationId) ||
			operations.has(action.operationId) ||
			!validText(action.toolName, 512) ||
			!('args' in action) ||
			!actionStatuses.has(action.status) ||
			(action.mode !== 'sync' && action.mode !== 'async') ||
			typeof action.readOnly !== 'boolean' ||
			!Number.isSafeInteger(action.attempts) ||
			action.attempts < 0 ||
			!validTime(action.createdAt) ||
			!validTime(action.updatedAt) ||
			(action.approvalGrantedAt !== undefined && !validTime(action.approvalGrantedAt)) ||
			(action.error !== undefined &&
				(typeof action.error !== 'string' || action.error.length > 16_384))
		)
			invalid();
		const key = JSON.stringify([action.runId, action.stepKey]);
		if (keys.has(key)) invalid();
		ids.add(action.id);
		keys.add(key);
		operations.add(action.operationId);
	}
	keys.clear();
	const actions = new Map(data.actions.map((action) => [action.id, action]));
	for (const job of data.jobs) {
		if (!object(job)) invalid();
		const action = actions.get(job.actionId);
		if (
			!validText(job.id) ||
			ids.has(job.id) ||
			!action ||
			action.mode !== 'async' ||
			job.runId !== action.runId ||
			keys.has(job.actionId) ||
			!actionStatuses.has(job.status) ||
			job.status !== action.status ||
			typeof job.notificationDelivered !== 'boolean' ||
			canonical(job.result) !== canonical(action.result) ||
			job.error !== action.error ||
			(!terminal(job.status) && job.notificationDelivered) ||
			!validTime(job.createdAt) ||
			!validTime(job.updatedAt) ||
			(job.error !== undefined && (typeof job.error !== 'string' || job.error.length > 16_384))
		)
			invalid();
		ids.add(job.id);
		keys.add(job.actionId);
	}
}

/** One host-owned writer. The mailbox and this journal must not be shared by multiple processes. */
export class BotExecutionStore {
	private data: BotExecutionData = {
		format: 'freelm-bot-execution-v1',
		revision: 0,
		runs: [],
		actions: [],
		jobs: [],
	};
	private initialized = false;
	private queue: Promise<unknown> = Promise.resolve();
	private readonly maxBytes: number;
	constructor(private readonly options: BotExecutionStoreOptions) {
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1)
			fail('The execution journal storage limit is invalid.');
	}
	static filenameForMailbox(filename: string): string {
		return `${filename}.execution.json`;
	}
	private now() {
		return (this.options.now ?? Date.now)();
	}
	private newId() {
		return (this.options.id ?? randomUUID)();
	}
	private async load() {
		if (this.initialized) return;
		let content: string;
		try {
			if ((await stat(this.options.filename)).size > this.maxBytes) this.storageError();
			content = await readFile(this.options.filename, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			this.initialized = true;
			return;
		}
		if (Buffer.byteLength(content) > this.maxBytes) this.storageError();
		let next: unknown;
		try {
			next = JSON.parse(content);
		} catch {
			fail('The saved bot execution journal is unreadable. Preserve it before making changes.');
		}
		validateStore(next);
		this.data = next;
		const recovered = jsonClone(next);
		let changed = false;
		for (const run of recovered.runs)
			if (run.status === 'running') {
				run.status = 'waiting';
				run.updatedAt = this.now();
				changed = true;
			}
		for (const action of recovered.actions)
			if (action.status === 'running') {
				action.status = action.readOnly ? 'pending' : 'outcome_unknown';
				action.error = action.readOnly
					? 'FreeLM closed during this read-only action. It can be resumed.'
					: 'FreeLM closed before the action outcome was saved. Reconcile the outcome before retrying.';
				action.updatedAt = this.now();
				this.syncJob(recovered, action);
				changed = true;
			}
		if (changed) await this.commit(recovered);
		this.initialized = true;
	}
	private storageError(): never {
		return fail(
			`The bot execution journal exceeds its ${this.maxBytes} byte storage limit. Completed results were preserved; no records were removed.`,
		);
	}
	private async commit(next: BotExecutionData) {
		next.revision = this.data.revision + 1;
		validateStore(next);
		const payload = jsonPayload(next);
		if (payload.bytes > this.maxBytes) this.storageError();
		await atomicWrite(this.options.filename, payload);
		this.data = next;
		try {
			this.options.onChanged?.();
		} catch {
			/* Observers cannot undo a committed action. */
		}
	}
	private serial<T>(task: () => Promise<T> | T): Promise<T> {
		const pending = this.queue.then(async () => {
			await this.load();
			return task();
		});
		this.queue = pending.catch(() => undefined);
		return pending;
	}
	private mutate<T>(task: (data: BotExecutionData) => T): Promise<T> {
		return this.serial(async () => {
			const next = jsonClone(this.data),
				result = task(next);
			await this.commit(next);
			return jsonClone(result);
		});
	}
	initialize(): Promise<void> {
		return this.serial(() => undefined);
	}
	revision(): Promise<number> {
		return this.serial(() => this.data.revision);
	}
	appendRunInput(id: string, messages: { id: string }[]): Promise<void> {
		const captured = jsonClone(messages);
		return this.mutate((data) => {
			const run = this.run(data, id);
			const entries = new Map(
				(run.incomingMessages ?? []).map((message) => [(message as { id: string }).id, message]),
			);
			for (const message of captured) {
				requireText(message.id, 'Incoming message');
				if (entries.has(message.id) && canonical(entries.get(message.id)) !== canonical(message))
					fail('Incoming message identity was reused with different content.');
				entries.set(message.id, message);
			}
			if (entries.size > 1000)
				fail('This bot turn has too many pending inputs. Finish it before continuing.');
			run.incomingMessages = [...entries.values()];
			run.updatedAt = this.now();
		});
	}
	private run(data: BotExecutionData, id: string) {
		return data.runs.find((run) => run.id === id) ?? fail('The bot run does not exist.');
	}
	private action(data: BotExecutionData, id: string) {
		return (
			data.actions.find((action) => action.id === id) ?? fail('The bot action does not exist.')
		);
	}
	private job(data: BotExecutionData, id: string) {
		return data.jobs.find((job) => job.id === id) ?? fail('The bot job does not exist.');
	}
	private matches(data: BotExecutionData, runId: string, filter: BotExecutionFilter) {
		const run = this.run(data, runId);
		return (
			(!filter.runId || run.id === filter.runId) &&
			(!filter.hostId || run.hostId === filter.hostId) &&
			(!filter.botId || run.botId === filter.botId) &&
			(!filter.conversationId || run.conversationId === filter.conversationId)
		);
	}
	getOrCreateRun(input: BotRunInput): Promise<BotExecutionRun> {
		const captured = jsonClone(input);
		return this.mutate((data) => {
			for (const key of ['hostId', 'botId', 'conversationId', 'triggerId'] as const)
				requireText(captured[key], key);
			if (captured.key !== undefined) requireText(captured.key, 'Run key');
			const candidate = { ...captured, key: captured.key ?? captured.triggerId };
			const existing = data.runs.find((run) => runKey(run) === runKey(candidate));
			if (existing) return existing;
			if (data.runs.length >= MAX_RUNS)
				fail('The bot execution journal has reached its run limit. No history was removed.');
			const now = this.now();
			const run: BotExecutionRun = {
				...candidate,
				id: this.newId(),
				status: 'pending',
				seenUserMessageIds: [...new Set(captured.seenUserMessageIds ?? [])],
				pendingToolCalls: captured.pendingToolCalls ?? [],
				createdAt: now,
				updatedAt: now,
			};
			data.runs.push(run);
			return run;
		});
	}
	getRun(id: string): Promise<BotExecutionRun | undefined> {
		return this.serial(() => jsonClone(this.data.runs.find((run) => run.id === id)));
	}
	listRuns(filter: BotExecutionFilter = {}): Promise<BotExecutionRun[]> {
		return this.serial(() =>
			jsonClone(
				this.data.runs.filter(
					(run) =>
						this.matches(this.data, run.id, filter) &&
						(!filter.status || run.status === filter.status),
				),
			),
		);
	}
	updateRun(id: string, patch: BotRunUpdate): Promise<BotExecutionRun> {
		const captured = jsonClone(patch);
		const keys = Object.keys(patch);
		return this.mutate((data) => {
			const run = this.run(data, id);
			for (const key of [
				'status',
				'context',
				'seenUserMessageIds',
				'pendingToolCalls',
				'error',
			] as const)
				if (keys.includes(key)) {
					if (captured[key] === undefined) delete (run as unknown as Record<string, unknown>)[key];
					else (run as unknown as Record<string, unknown>)[key] = captured[key];
				}
			run.updatedAt = this.now();
			return run;
		});
	}
	prepareAction(input: BotActionInput): Promise<BotExecutionAction> {
		const captured = jsonClone(input);
		return this.mutate((data) => {
			this.run(data, captured.runId);
			requireText(captured.stepKey, 'Action step key');
			requireText(captured.toolName, 'Tool name', 512);
			if (captured.args === undefined) fail('Tool arguments must be JSON data.');
			const mode = captured.mode ?? 'sync',
				readOnly = captured.readOnly ?? false;
			const existing = data.actions.find(
				(action) => action.runId === captured.runId && action.stepKey === captured.stepKey,
			);
			if (existing) {
				if (
					existing.toolName !== captured.toolName ||
					existing.mode !== mode ||
					existing.readOnly !== readOnly ||
					canonical(existing.args) !== canonical(captured.args)
				)
					fail(
						'A saved action step cannot be reused with a different tool, arguments, or execution policy.',
					);
				return existing;
			}
			if (data.actions.length >= MAX_ACTIONS)
				fail('The bot execution journal has reached its action limit. No history was removed.');
			const id = this.newId(),
				now = this.now();
			const action: BotExecutionAction = {
				...captured,
				mode,
				readOnly,
				id,
				operationId: `bot-action-${id}`,
				status: 'pending',
				attempts: 0,
				createdAt: now,
				updatedAt: now,
			};
			data.actions.push(action);
			return action;
		});
	}
	getAction(id: string): Promise<BotExecutionAction | undefined> {
		return this.serial(() => jsonClone(this.data.actions.find((action) => action.id === id)));
	}
	listActions(filter: BotExecutionFilter = {}): Promise<BotExecutionAction[]> {
		return this.serial(() =>
			jsonClone(
				this.data.actions.filter(
					(action) =>
						this.matches(this.data, action.runId, filter) &&
						(!filter.status || action.status === filter.status),
				),
			),
		);
	}
	private syncJob(data: BotExecutionData, action: BotExecutionAction) {
		const job = data.jobs.find((entry) => entry.actionId === action.id);
		if (!job) return;
		const changed = job.status !== action.status;
		job.status = action.status;
		job.updatedAt = action.updatedAt;
		if (Object.prototype.hasOwnProperty.call(action, 'result'))
			job.result = jsonClone(action.result);
		else delete job.result;
		if (action.error !== undefined) job.error = action.error;
		else delete job.error;
		if (changed) job.notificationDelivered = false;
	}
	private transition(
		id: string,
		change: (action: BotExecutionAction) => void,
	): Promise<BotExecutionAction> {
		return this.mutate((data) => {
			const action = this.action(data, id);
			change(action);
			action.updatedAt = this.now();
			this.syncJob(data, action);
			return action;
		});
	}
	startAction(id: string): Promise<BotExecutionAction> {
		return this.transition(id, (action) => {
			if (action.status !== 'pending')
				fail(`Cannot start a ${action.status} action. Reconcile or explicitly retry it first.`);
			action.status = 'running';
			action.attempts++;
			delete action.error;
		});
	}
	awaitActionApproval(id: string): Promise<BotExecutionAction> {
		return this.transition(id, (action) => {
			if (action.status !== 'pending' && action.status !== 'awaiting_approval')
				fail('Approval must be requested before starting an action.');
			action.status = 'awaiting_approval';
			delete action.approvalGrantedAt;
		});
	}
	approveAction(id: string): Promise<BotExecutionAction> {
		return this.transition(id, (action) => {
			if (action.status !== 'awaiting_approval') fail('This action is not awaiting approval.');
			action.status = 'pending';
			action.approvalGrantedAt = this.now();
		});
	}
	private succeed(action: BotExecutionAction, result: unknown) {
		if (action.status === 'succeeded') {
			if (canonical(action.result) !== canonical(result))
				fail('A completed action result cannot be replaced.');
			return;
		}
		if (action.status !== 'running' && action.status !== 'outcome_unknown')
			fail(`Cannot complete a ${action.status} action.`);
		action.status = 'succeeded';
		action.result = result;
		delete action.error;
	}
	succeedAction(id: string, result: unknown): Promise<BotExecutionAction> {
		const captured = jsonClone(result ?? null);
		return this.transition(id, (action) => this.succeed(action, captured));
	}
	private failure(action: BotExecutionAction, error: string, options: BotActionFailureOptions) {
		if (action.status === 'succeeded' || action.status === 'cancelled')
			fail('A completed action cannot be changed to a failure.');
		const uncertain =
			options.outcomeUnknown ??
			(action.status === 'outcome_unknown' || (action.status === 'running' && !action.readOnly));
		if (action.status === 'outcome_unknown' && !uncertain)
			fail('Reconcile an uncertain action before declaring its outcome.');
		action.status = uncertain ? 'outcome_unknown' : 'failed';
		action.error = error;
	}
	failAction(
		id: string,
		error: unknown,
		options: BotActionFailureOptions = {},
	): Promise<BotExecutionAction> {
		const captured = errorText(error),
			policy = { ...options };
		return this.transition(id, (action) => this.failure(action, captured, policy));
	}
	private cancel(action: BotExecutionAction, confirmed: boolean) {
		if (
			action.status === 'succeeded' ||
			action.status === 'failed' ||
			action.status === 'cancelled'
		)
			return;
		if (
			!confirmed &&
			!action.readOnly &&
			(action.status === 'running' || action.status === 'outcome_unknown')
		) {
			action.status = 'outcome_unknown';
			action.error =
				'Cancellation was requested, but the action may have taken effect. Reconcile before retrying.';
		} else {
			action.status = 'cancelled';
			delete action.error;
		}
	}
	cancelAction(id: string, options: { confirmed?: boolean } = {}): Promise<BotExecutionAction> {
		const confirmed = options.confirmed === true;
		return this.transition(id, (action) => this.cancel(action, confirmed));
	}
	retryAction(id: string): Promise<BotExecutionAction> {
		return this.transition(id, (action) => {
			if (action.status !== 'failed' && !(action.status === 'outcome_unknown' && action.readOnly))
				fail('Only failed actions with a known outcome or read-only actions can be retried.');
			action.status = 'pending';
			delete action.error;
			delete action.result;
		});
	}
	reconcileAction(
		id: string,
		resolution: { status: 'succeeded' | 'failed' | 'cancelled'; result?: unknown; error?: string },
	): Promise<BotExecutionAction> {
		const captured = jsonClone(resolution);
		return this.transition(id, (action) => {
			if (action.status !== 'outcome_unknown')
				fail('Only uncertain actions require reconciliation.');
			if (!['succeeded', 'failed', 'cancelled'].includes(captured.status))
				fail('The action resolution is invalid.');
			action.status = captured.status;
			if (captured.status === 'succeeded') action.result = captured.result ?? null;
			else delete action.result;
			if (captured.error !== undefined) action.error = errorText(captured.error);
			else delete action.error;
		});
	}
	createJob(actionId: string, options: { context?: unknown } = {}): Promise<BotExecutionJob> {
		const captured = jsonClone(options);
		return this.mutate((data) => {
			const action = this.action(data, actionId);
			if (action.mode !== 'async') fail('Only asynchronous actions can create jobs.');
			const existing = data.jobs.find((job) => job.actionId === actionId);
			if (existing) return existing;
			if (data.jobs.length >= MAX_JOBS)
				fail('The bot execution journal has reached its job limit. No history was removed.');
			const now = this.now();
			const job: BotExecutionJob = {
				...captured,
				id: this.newId(),
				actionId,
				runId: action.runId,
				status: action.status,
				notificationDelivered: false,
				createdAt: now,
				updatedAt: now,
			};
			data.jobs.push(job);
			this.syncJob(data, action);
			return job;
		});
	}
	getJob(id: string): Promise<BotExecutionJob | undefined> {
		return this.serial(() => jsonClone(this.data.jobs.find((job) => job.id === id)));
	}
	listJobs(
		filter: BotExecutionFilter & { notificationDelivered?: boolean } = {},
	): Promise<BotExecutionJob[]> {
		return this.serial(() =>
			jsonClone(
				this.data.jobs.filter(
					(job) =>
						this.matches(this.data, job.runId, filter) &&
						(!filter.status || job.status === filter.status) &&
						(filter.notificationDelivered === undefined ||
							job.notificationDelivered === filter.notificationDelivered),
				),
			),
		);
	}
	private transitionJob(
		id: string,
		change: (action: BotExecutionAction) => void,
	): Promise<BotExecutionJob> {
		return this.mutate((data) => {
			const job = this.job(data, id),
				action = this.action(data, job.actionId);
			change(action);
			action.updatedAt = this.now();
			this.syncJob(data, action);
			return job;
		});
	}
	startJob(id: string): Promise<BotExecutionJob> {
		return this.transitionJob(id, (action) => {
			if (action.status !== 'pending') fail(`Cannot start a ${action.status} job.`);
			action.status = 'running';
			action.attempts++;
			delete action.error;
		});
	}
	succeedJob(id: string, result: unknown): Promise<BotExecutionJob> {
		const captured = jsonClone(result ?? null);
		return this.transitionJob(id, (action) => this.succeed(action, captured));
	}
	failJob(
		id: string,
		error: unknown,
		options: BotActionFailureOptions = {},
	): Promise<BotExecutionJob> {
		const captured = errorText(error),
			policy = { ...options };
		return this.transitionJob(id, (action) => this.failure(action, captured, policy));
	}
	cancelJob(id: string, options: { confirmed?: boolean } = {}): Promise<BotExecutionJob> {
		const confirmed = options.confirmed === true;
		return this.transitionJob(id, (action) => this.cancel(action, confirmed));
	}
	markJobNotified(id: string): Promise<BotExecutionJob> {
		return this.mutate((data) => {
			const job = this.job(data, id);
			if (!terminal(job.status)) fail('Only a finished or uncertain job can be acknowledged.');
			job.notificationDelivered = true;
			job.updatedAt = this.now();
			return job;
		});
	}
}
