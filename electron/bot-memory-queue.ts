import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { atomicWrite, jsonPayload } from './json-file';

export interface BotMemoryQueueSource {
	botId: string;
	/** Conversation's host; the bot always lives on this queue's local host. */
	hostId: string;
	conversationId: string;
}
export interface BotMemoryQueueEntry extends BotMemoryQueueSource {
	id: string;
	status: 'pending' | 'running' | 'failed';
	generation: number;
	attempts: number;
	notBefore: number;
	createdAt: number;
	updatedAt: number;
	lastError?: string;
}
export interface BotMemoryQueueOptions {
	filename: string;
	/** Resolve the current bot, source and connection here. Never persist credentials or message copies. */
	execute: (entry: BotMemoryQueueEntry, signal: AbortSignal) => Promise<void>;
	onError?: (entry: BotMemoryQueueEntry | undefined, error: Error) => void | Promise<void>;
	onChanged?: () => void;
	debounceMs?: number;
	retryBaseMs?: number;
	maxAttempts?: number;
	maxConcurrent?: number;
	maxBytes?: number;
	now?: () => number;
}
interface QueueData {
	format: 'freelm-bot-memory-queue-v1';
	revision: number;
	entries: BotMemoryQueueEntry[];
}
const MAX_ENTRIES = 2048;
const sourceKey = (source: BotMemoryQueueSource) =>
	JSON.stringify([source.botId, source.hostId, source.conversationId]);
const copy = <T>(value: T): T => structuredClone(value);
const isObject = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string =>
	typeof value === 'string' && !!value.trim() && value.length <= 256;
const time = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0;
const errorOf = (value: unknown): Error =>
	value instanceof Error ? value : new Error(String(value));
const matches = (entry: BotMemoryQueueEntry, filter: Partial<BotMemoryQueueSource>) =>
	(!filter.botId || filter.botId === entry.botId) &&
	(!filter.hostId || filter.hostId === entry.hostId) &&
	(!filter.conversationId || filter.conversationId === entry.conversationId);

function validate(value: unknown): asserts value is QueueData {
	const invalid = () => {
		throw new Error('The saved bot memory queue is invalid. Preserve it before making changes.');
	};
	if (
		!isObject(value) ||
		value.format !== 'freelm-bot-memory-queue-v1' ||
		!Number.isSafeInteger(value.revision) ||
		Number(value.revision) < 0 ||
		!Array.isArray(value.entries) ||
		value.entries.length > MAX_ENTRIES
	)
		invalid();
	const data = value as unknown as QueueData,
		ids = new Set<string>(),
		sources = new Set<string>();
	for (const entry of data.entries) {
		if (
			!isObject(entry) ||
			!identifier(entry.id) ||
			ids.has(entry.id) ||
			!identifier(entry.botId) ||
			!identifier(entry.hostId) ||
			!identifier(entry.conversationId) ||
			!['pending', 'running', 'failed'].includes(entry.status) ||
			!Number.isSafeInteger(entry.generation) ||
			entry.generation < 1 ||
			!Number.isSafeInteger(entry.attempts) ||
			entry.attempts < 0 ||
			!time(entry.notBefore) ||
			!time(entry.createdAt) ||
			!time(entry.updatedAt) ||
			(entry.lastError !== undefined &&
				(typeof entry.lastError !== 'string' || entry.lastError.length > 2000)) ||
			Object.keys(entry).some(
				(key) =>
					![
						'id',
						'botId',
						'hostId',
						'conversationId',
						'status',
						'generation',
						'attempts',
						'notBefore',
						'createdAt',
						'updatedAt',
						'lastError',
					].includes(key),
			)
		)
			invalid();
		const key = sourceKey(entry);
		if (sources.has(key)) invalid();
		ids.add(entry.id);
		sources.add(key);
	}
}

/** Durable, coalesced read-only work; foreground replies never wait for model extraction. */
export class BotMemoryQueue {
	private data: QueueData = { format: 'freelm-bot-memory-queue-v1', revision: 0, entries: [] };
	private writer: Promise<unknown> = Promise.resolve();
	private initialized = false;
	private started = false;
	private timer?: ReturnType<typeof setTimeout>;
	private pumping?: Promise<void>;
	private workers = new Map<
		string,
		{ botId: string; controller: AbortController; promise: Promise<void> }
	>();
	private paused = new Map<string, number>();
	private readonly debounceMs: number;
	private readonly retryBaseMs: number;
	private readonly maxAttempts: number;
	private readonly maxConcurrent: number;
	private readonly maxBytes: number;
	constructor(private readonly options: BotMemoryQueueOptions) {
		this.debounceMs = options.debounceMs ?? 750;
		this.retryBaseMs = options.retryBaseMs ?? 5000;
		this.maxAttempts = options.maxAttempts ?? 3;
		this.maxConcurrent = options.maxConcurrent ?? 1;
		this.maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
		if (
			!Number.isSafeInteger(this.debounceMs) ||
			this.debounceMs < 0 ||
			this.debounceMs > 60_000 ||
			!Number.isSafeInteger(this.retryBaseMs) ||
			this.retryBaseMs < 1 ||
			this.retryBaseMs > 3_600_000 ||
			!Number.isSafeInteger(this.maxAttempts) ||
			this.maxAttempts < 1 ||
			this.maxAttempts > 10 ||
			!Number.isSafeInteger(this.maxConcurrent) ||
			this.maxConcurrent < 1 ||
			this.maxConcurrent > 8 ||
			!Number.isSafeInteger(this.maxBytes) ||
			this.maxBytes < 1
		)
			throw new Error('The bot memory queue limits are invalid.');
	}
	static filenameForMailbox(filename: string) {
		return `${filename}.memory-queue.json`;
	}
	private now() {
		return (this.options.now ?? Date.now)();
	}
	private async report(entry: BotMemoryQueueEntry | undefined, error: unknown) {
		try {
			await this.options.onError?.(entry && copy(entry), errorOf(error));
		} catch {
			/* Keep persisted work even if an error observer fails. */
		}
	}
	private overflow(): never {
		throw new Error(
			'The bot memory queue exceeded its storage limit. Pending work was preserved; no entries were removed.',
		);
	}
	private async commit(next: QueueData) {
		next.revision = this.data.revision + 1;
		validate(next);
		const payload = jsonPayload(next);
		if (payload.bytes > this.maxBytes) this.overflow();
		await atomicWrite(this.options.filename, payload);
		this.data = next;
		try {
			this.options.onChanged?.();
		} catch {
			/* A listener cannot fail durable work. */
		}
	}
	private async load() {
		if (this.initialized) return;
		let content: string;
		try {
			if ((await stat(this.options.filename)).size > this.maxBytes) this.overflow();
			content = await readFile(this.options.filename, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			this.initialized = true;
			return;
		}
		if (Buffer.byteLength(content) > this.maxBytes) this.overflow();
		let parsed: unknown;
		try {
			parsed = JSON.parse(content);
		} catch {
			throw new Error(
				'The saved bot memory queue is unreadable. Preserve it before making changes.',
			);
		}
		validate(parsed);
		this.data = parsed;
		const next = copy(parsed);
		let changed = false;
		for (const entry of next.entries)
			if (entry.status === 'running') {
				entry.status = 'pending';
				entry.notBefore = this.now();
				entry.updatedAt = this.now();
				entry.attempts = Math.max(0, entry.attempts - 1);
				changed = true;
			}
		if (changed) await this.commit(next);
		this.initialized = true;
	}
	private serial<T>(task: () => Promise<T> | T): Promise<T> {
		const pending = this.writer.then(async () => {
			await this.load();
			return task();
		});
		this.writer = pending.catch(() => undefined);
		return pending;
	}
	private mutate<T>(task: (data: QueueData) => T): Promise<T> {
		return this.serial(async () => {
			const next = copy(this.data),
				result = task(next);
			await this.commit(next);
			return copy(result);
		});
	}
	async start(): Promise<void> {
		await this.serial(() => undefined);
		this.started = true;
		this.schedule();
	}
	async enqueue(source: BotMemoryQueueSource): Promise<BotMemoryQueueEntry> {
		// Explicit projection ensures no connection, credentials, or transcript is persisted accidentally.
		const captured = {
			botId: source.botId,
			hostId: source.hostId,
			conversationId: source.conversationId,
		};
		const result = await this.mutate((data) => {
			if (
				!identifier(captured.botId) ||
				!identifier(captured.hostId) ||
				!identifier(captured.conversationId)
			)
				throw new Error('A bot memory source must have exact bot, host, and conversation IDs.');
			const existing = data.entries.find((entry) => sourceKey(entry) === sourceKey(captured)),
				now = this.now();
			if (existing) {
				existing.generation++;
				existing.updatedAt = now;
				existing.notBefore = now + this.debounceMs;
				if (existing.status !== 'running') {
					existing.status = 'pending';
					existing.attempts = 0;
					delete existing.lastError;
				}
				return existing;
			}
			if (data.entries.length >= MAX_ENTRIES)
				throw new Error('The bot memory queue is full. Existing pending work was preserved.');
			const entry: BotMemoryQueueEntry = {
				...captured,
				id: randomUUID(),
				status: 'pending',
				generation: 1,
				attempts: 0,
				notBefore: now + this.debounceMs,
				createdAt: now,
				updatedAt: now,
			};
			data.entries.push(entry);
			return entry;
		});
		this.schedule();
		return result;
	}
	list(filter: Partial<BotMemoryQueueSource> = {}): Promise<BotMemoryQueueEntry[]> {
		return this.serial(() => copy(this.data.entries.filter((entry) => matches(entry, filter))));
	}
	async remove(filter: Partial<BotMemoryQueueSource>): Promise<void> {
		if (!Object.keys(filter).length)
			throw new Error('Specify a bot or conversation when removing queued memory work.');
		const ids = await this.mutate((data) => {
			const selected = data.entries
				.filter((entry) => matches(entry, filter))
				.map((entry) => entry.id);
			data.entries = data.entries.filter((entry) => !selected.includes(entry.id));
			return selected;
		});
		for (const id of ids)
			this.workers.get(id)?.controller.abort(new Error('This memory source was removed.'));
		this.schedule();
	}
	/** Returns an idempotent release function. Multiple foreground operations may pause one bot. */
	pauseBot(botId: string): () => void {
		this.paused.set(botId, (this.paused.get(botId) ?? 0) + 1);
		for (const worker of this.workers.values())
			if (worker.botId === botId)
				worker.controller.abort(new Error('Memory learning paused for a foreground reply.'));
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const count = (this.paused.get(botId) ?? 0) - 1;
			if (count > 0) this.paused.set(botId, count);
			else this.paused.delete(botId);
			this.schedule();
		};
	}
	private schedule() {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		if (!this.started || this.workers.size >= this.maxConcurrent) return;
		const busy = new Set([...this.workers.values()].map((worker) => worker.botId));
		const eligible = this.data.entries.filter(
			(entry) =>
				entry.status === 'pending' && !this.paused.has(entry.botId) && !busy.has(entry.botId),
		);
		if (!eligible.length) return;
		const delay = Math.max(0, Math.min(...eligible.map((entry) => entry.notBefore)) - this.now());
		this.timer = setTimeout(
			() => {
				this.timer = undefined;
				void this.pump().catch((error) => this.report(undefined, error));
			},
			Math.min(delay, 2_147_483_647),
		);
		this.timer.unref?.();
	}
	private pump(): Promise<void> {
		if (this.pumping) return this.pumping;
		const operation = this.launchDue();
		this.pumping = operation;
		void operation
			.finally(() => {
				if (this.pumping === operation) this.pumping = undefined;
			})
			.catch(() => undefined);
		return operation;
	}
	private async launchDue() {
		while (this.started && this.workers.size < this.maxConcurrent) {
			const selected = await this.serial(async () => {
				if (!this.started) return;
				const busy = new Set([...this.workers.values()].map((worker) => worker.botId));
				const candidate = this.data.entries
					.filter(
						(entry) =>
							entry.status === 'pending' &&
							entry.notBefore <= this.now() &&
							!this.paused.has(entry.botId) &&
							!busy.has(entry.botId),
					)
					.sort((a, b) => a.notBefore - b.notBefore || a.createdAt - b.createdAt)[0];
				if (!candidate) return;
				const next = copy(this.data),
					entry = next.entries.find((item) => item.id === candidate.id)!;
				entry.status = 'running';
				entry.attempts++;
				entry.updatedAt = this.now();
				await this.commit(next);
				return copy(entry);
			});
			if (!selected) break;
			const controller = new AbortController();
			if (!this.started || this.paused.has(selected.botId))
				controller.abort(new Error('Memory learning paused.'));
			// Register the worker before starting its callback so another source for the bot cannot race it.
			const worker = { botId: selected.botId, controller, promise: Promise.resolve() };
			this.workers.set(selected.id, worker);
			worker.promise = this.run(selected, controller).finally(() => {
				this.workers.delete(selected.id);
				this.schedule();
			});
			void worker.promise.catch((error) => this.report(selected, error));
		}
		this.schedule();
	}
	private async run(selected: BotMemoryQueueEntry, controller: AbortController) {
		let failure: Error | undefined;
		try {
			controller.signal.throwIfAborted();
			await this.options.execute(copy(selected), controller.signal);
		} catch (error) {
			failure = errorOf(error);
		}
		await this.mutate((data) => {
			const entry = data.entries.find((item) => item.id === selected.id);
			if (!entry) return;
			const changed = entry.generation !== selected.generation;
			if (!failure && !controller.signal.aborted && !changed) {
				data.entries = data.entries.filter((item) => item.id !== entry.id);
				return;
			}
			entry.updatedAt = this.now();
			if (controller.signal.aborted || changed) {
				entry.status = 'pending';
				entry.attempts = changed ? 0 : Math.max(0, entry.attempts - 1);
				entry.notBefore = this.now() + this.debounceMs;
				delete entry.lastError;
				return;
			}
			entry.lastError = (failure?.message || 'Memory learning did not complete.').slice(0, 2000);
			entry.status = entry.attempts >= this.maxAttempts ? 'failed' : 'pending';
			entry.notBefore =
				this.now() + Math.min(3_600_000, this.retryBaseMs * 2 ** (entry.attempts - 1));
		});
		if (failure && !controller.signal.aborted) await this.report(selected, failure);
	}
	/** Run currently due work and wait for active workers, without bypassing retry/debounce delays. */
	async flush(includeDebounced = false): Promise<void> {
		if (!this.started) await this.start();
		for (;;) {
			if (includeDebounced)
				await this.serial(async () => {
					const now = this.now();
					if (
						!this.data.entries.some(
							(entry) =>
								entry.status === 'pending' && entry.attempts === 0 && entry.notBefore > now,
						)
					)
						return;
					const next = copy(this.data);
					for (const entry of next.entries)
						if (entry.status === 'pending' && entry.attempts === 0)
							entry.notBefore = Math.min(now, entry.notBefore);
					await this.commit(next);
				});
			await this.pump();
			const running = [...this.workers.values()].map((worker) => worker.promise);
			if (!running.length) break;
			await Promise.all(running);
		}
	}
	async stop(): Promise<void> {
		this.started = false;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		for (const worker of this.workers.values())
			worker.controller.abort(new Error('FreeLM is shutting down.'));
		await this.pumping;
		await Promise.allSettled([...this.workers.values()].map((worker) => worker.promise));
		await this.writer;
	}
}
