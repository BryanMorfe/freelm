import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
	BotMemoryQueue,
	type BotMemoryQueueEntry,
	type BotMemoryQueueOptions,
} from '../../electron/bot-memory-queue';

const folders: string[] = [],
	queues: BotMemoryQueue[] = [];
afterEach(async () => {
	await Promise.allSettled(queues.splice(0).map((queue) => queue.stop()));
	await Promise.all(
		folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
	);
});
const source = { botId: 'nova', hostId: 'home', conversationId: 'research' };
async function fixture(options: Partial<BotMemoryQueueOptions> = {}) {
	const folder = await mkdtemp(path.join(os.tmpdir(), 'freelm-bot-memory-queue-'));
	folders.push(folder);
	const filename = BotMemoryQueue.filenameForMailbox(path.join(folder, 'bots.json'));
	const queue = new BotMemoryQueue({
		filename,
		execute: async () => undefined,
		debounceMs: 0,
		...options,
	});
	queues.push(queue);
	return { queue, filename };
}
function restore(filename: string, options: Partial<BotMemoryQueueOptions> = {}) {
	const queue = new BotMemoryQueue({
		filename,
		execute: async () => undefined,
		debounceMs: 0,
		...options,
	});
	queues.push(queue);
	return queue;
}
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function untilAborted(signal: AbortSignal) {
	return new Promise<void>((_resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		signal.addEventListener('abort', () => reject(signal.reason), { once: true });
	});
}

describe('background bot memory queue', () => {
	it('persists only source identities and coalesces pending changes without retaining messages or credentials', async () => {
		const { queue, filename } = await fixture();
		const withSecrets = {
			...source,
			connection: { apiKey: 'DO_NOT_SAVE' },
			messages: ['PRIVATE_COPY'],
		};
		const first = await queue.enqueue(withSecrets),
			second = await queue.enqueue(source);
		expect(second).toMatchObject({ id: first.id, generation: 2, status: 'pending' });
		expect(await queue.list()).toHaveLength(1);
		const stored = await readFile(filename, 'utf8');
		expect(stored).not.toMatch(/DO_NOT_SAVE|PRIVATE_COPY|connection|messages/);
		expect(await restore(filename).list()).toMatchObject([{ id: first.id, generation: 2 }]);
	});

	it('returns from scheduling before inference completes and removes successfully consolidated work', async () => {
		const gate = deferred(),
			began = deferred();
		const { queue } = await fixture({
			execute: async () => {
				began.resolve();
				await gate.promise;
			},
		});
		await queue.start();
		const entry = await queue.enqueue(source);
		await began.promise;
		expect(await queue.list()).toMatchObject([{ id: entry.id, status: 'running' }]);
		gate.resolve();
		await queue.flush();
		expect(await queue.list()).toEqual([]);
	});

	it('resumes an interrupted extraction after restart and resolves current data in the worker', async () => {
		const { queue, filename } = await fixture();
		await queue.enqueue(source);
		const data = JSON.parse(await readFile(filename, 'utf8'));
		data.entries[0].status = 'running';
		data.entries[0].attempts = 1;
		await writeFile(filename, JSON.stringify(data));
		const execute = vi.fn(async (_entry: BotMemoryQueueEntry) => undefined),
			restarted = restore(filename, { execute });
		expect(await restarted.list()).toMatchObject([{ status: 'pending', attempts: 0 }]);
		await restarted.start();
		await restarted.flush();
		expect(execute).toHaveBeenCalledTimes(1);
		expect(execute.mock.calls[0][0]).toMatchObject(source);
		expect(await restarted.list()).toEqual([]);
	});

	it('serializes sources for one bot while allowing separate bots within the concurrency limit', async () => {
		const gate = deferred();
		let active = 0,
			maximum = 0;
		const botActive = new Set<string>(),
			started: string[] = [];
		const { queue } = await fixture({
			maxConcurrent: 2,
			execute: async (entry) => {
				expect(botActive.has(entry.botId)).toBe(false);
				botActive.add(entry.botId);
				active++;
				maximum = Math.max(maximum, active);
				started.push(`${entry.botId}:${entry.conversationId}`);
				if (entry.conversationId === 'research') await gate.promise;
				active--;
				botActive.delete(entry.botId);
			},
		});
		await queue.enqueue(source);
		await queue.enqueue({ ...source, conversationId: 'private' });
		await queue.enqueue({ ...source, botId: 'pip' });
		await queue.start();
		await vi.waitFor(() => expect(started).toHaveLength(2));
		expect(started).toEqual(['nova:research', 'pip:research']);
		gate.resolve();
		await queue.flush();
		expect(maximum).toBe(2);
		expect(started).toContain('nova:private');
	});

	it('schedules another extraction when new messages arrive while the current source is running', async () => {
		const gate = deferred();
		const generations: number[] = [];
		const { queue } = await fixture({
			execute: async (entry) => {
				generations.push(entry.generation);
				if (generations.length === 1) await gate.promise;
			},
		});
		await queue.enqueue(source);
		await queue.start();
		await vi.waitFor(() => expect(generations).toEqual([1]));
		await queue.enqueue(source);
		await queue.enqueue(source);
		gate.resolve();
		await queue.flush();
		expect(generations).toEqual([1, 3]);
		expect(await queue.list()).toEqual([]);
	});

	it('preempts learning for a foreground reply and resumes only after every pause is released', async () => {
		let calls = 0,
			wasAborted = false;
		const { queue } = await fixture({
			execute: async (_entry, signal) => {
				calls++;
				if (calls === 1) {
					try {
						await untilAborted(signal);
					} finally {
						wasAborted = signal.aborted;
					}
				}
			},
		});
		await queue.enqueue(source);
		await queue.start();
		await vi.waitFor(() => expect(calls).toBe(1));
		const releaseOne = queue.pauseBot('nova'),
			releaseTwo = queue.pauseBot('nova');
		await queue.flush();
		expect(wasAborted).toBe(true);
		expect(await queue.list()).toMatchObject([{ status: 'pending', attempts: 0 }]);
		releaseOne();
		releaseOne();
		await queue.flush();
		expect(calls).toBe(1);
		releaseTwo();
		await queue.flush();
		expect(calls).toBe(2);
		expect(await queue.list()).toEqual([]);
	});

	it('persists bounded exponential retries and leaves exhausted work visible for a later new event', async () => {
		let now = 1000;
		const failures: string[] = [];
		const execute = vi.fn(async () => {
			throw new Error('Evaluator unavailable');
		});
		const { queue } = await fixture({
			now: () => now,
			retryBaseMs: 1000,
			maxAttempts: 3,
			execute,
			onError: async (_entry, error) => {
				failures.push(error.message);
			},
		});
		await queue.enqueue(source);
		await queue.start();
		await queue.flush();
		expect(await queue.list()).toMatchObject([
			{ status: 'pending', attempts: 1, notBefore: 2000, lastError: 'Evaluator unavailable' },
		]);
		now = 1999;
		await queue.flush();
		expect(execute).toHaveBeenCalledTimes(1);
		now = 2000;
		await queue.flush();
		expect(await queue.list()).toMatchObject([{ status: 'pending', attempts: 2, notBefore: 4000 }]);
		now = 4000;
		await queue.flush();
		expect(await queue.list()).toMatchObject([{ status: 'failed', attempts: 3 }]);
		now = 10000;
		await queue.flush();
		expect(execute).toHaveBeenCalledTimes(3);
		expect(failures).toEqual(Array(3).fill('Evaluator unavailable'));
		await queue.enqueue(source);
		expect(await queue.list()).toMatchObject([{ status: 'pending', attempts: 0, generation: 2 }]);
	});

	it('stops cleanly without losing read-only work and a fresh queue resumes it', async () => {
		let began = false;
		const { queue, filename } = await fixture({
			execute: async (_entry, signal) => {
				began = true;
				await untilAborted(signal);
			},
		});
		await queue.enqueue(source);
		await queue.start();
		await vi.waitFor(() => expect(began).toBe(true));
		await queue.stop();
		expect(await queue.list()).toMatchObject([{ status: 'pending', attempts: 0 }]);
		const restarted = restore(filename);
		await restarted.flush();
		expect(await restarted.list()).toEqual([]);
	});

	it('source removal cancels active work and prevents stale completion from deleting a new generation', async () => {
		let calls = 0;
		const gate = deferred();
		const { queue } = await fixture({
			execute: async (_entry, signal) => {
				calls++;
				if (calls === 1) {
					await untilAborted(signal);
				} else await gate.promise;
			},
		});
		const old = await queue.enqueue(source);
		await queue.start();
		await vi.waitFor(() => expect(calls).toBe(1));
		const release = queue.pauseBot('nova');
		await queue.remove({ botId: 'nova', conversationId: 'research' });
		const replacement = await queue.enqueue(source);
		expect(replacement.id).not.toBe(old.id);
		await queue.flush();
		expect(await queue.list()).toMatchObject([{ id: replacement.id }]);
		release();
		gate.resolve();
		await queue.flush();
		expect(await queue.list()).toEqual([]);
	});

	it('enforces the queue storage limit without discarding previously queued work', async () => {
		const { queue, filename } = await fixture({ maxBytes: 600 });
		await queue.enqueue(source);
		const before = await readFile(filename, 'utf8');
		await expect(queue.enqueue({ ...source, conversationId: 'other'.repeat(40) })).rejects.toThrow(
			'storage limit',
		);
		expect(await readFile(filename, 'utf8')).toBe(before);
		expect(await queue.list()).toHaveLength(1);
	});

	it('preserves malformed persisted data and rejects extra secret-bearing fields', async () => {
		const { queue, filename } = await fixture();
		await queue.enqueue(source);
		const data = JSON.parse(await readFile(filename, 'utf8'));
		data.entries[0].apiKey = 'SECRET';
		const before = JSON.stringify(data);
		await writeFile(filename, before);
		await expect(restore(filename).start()).rejects.toThrow('invalid');
		expect(await readFile(filename, 'utf8')).toBe(before);
	});
});
