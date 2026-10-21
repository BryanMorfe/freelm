import { randomUUID } from 'node:crypto';
import {
	MAX_BOT_TASK_ERROR_LENGTH,
	validateBotTaskRequest,
	validateBotTaskResponse,
	type BotTaskRequest,
} from '../src/bot-task-types';

export const BOT_TASK_TIMEOUT_MS = 90_000;

export interface BotTaskService {
	execute(
		name: string,
		args: Record<string, unknown>,
		operationId: string,
		signal?: AbortSignal,
	): Promise<unknown>;
	claimExternal?(threadId: string, runId: string): boolean;
	releaseExternal?(runId: string, interrupted?: boolean): Promise<void>;
	setReady(ready: boolean): void;
	settle(id: string, result: unknown): boolean;
	close(): void | Promise<void>;
}
const MAX_PENDING_REQUESTS = 128;

export interface RendererTaskBridgeOptions {
	/** Deliver immediately to the registered renderer; never retain for a later window. */
	deliver: (request: BotTaskRequest) => void;
	/** Notify the renderer to stop a delivery that is no longer wanted. */
	cancel?: (id: string) => void;
	/** Primarily for tests; cannot exceed the normal 90-second deadline. */
	timeoutMs?: number;
}
interface PendingTask {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
	detach: () => void;
}

function abortError(reason: string) {
	const error = new Error(reason.slice(0, MAX_BOT_TASK_ERROR_LENGTH));
	error.name = 'AbortError';
	return error;
}

/**
 * Correlates host requests with the renderer that owns Chat/Code state and execution.
 * It never edits the persisted workspace or transports connection credentials.
 */
export class RendererTaskBridge {
	private readonly pending = new Map<string, PendingTask>();
	private ready = false;
	private closed = false;
	private readonly timeoutMs: number;

	constructor(private readonly options: RendererTaskBridgeOptions) {
		const timeout = options.timeoutMs ?? BOT_TASK_TIMEOUT_MS;
		if (!Number.isFinite(timeout) || timeout < 1 || timeout > BOT_TASK_TIMEOUT_MS)
			throw new Error('Bot task timeout must be between 1 and 90,000 milliseconds.');
		this.timeoutMs = timeout;
	}

	/** Register only after the renderer has loaded the local workspace and listeners. */
	setReady(ready: boolean): void {
		if (this.closed) return;
		this.ready = ready;
		if (!ready)
			this.cancelAll('The local workspace is no longer available. Retry when it is open.');
	}

	async execute(
		name: string,
		args: Record<string, unknown>,
		operationId: string,
		signal?: AbortSignal,
	): Promise<unknown> {
		if (this.closed) throw new Error('The bot task service has closed.');
		if (signal?.aborted) throw abortError('The bot task was cancelled before delivery.');
		if (!this.ready)
			throw new Error('Open this computer’s workspace in FreeLM before using bot task tools.');
		if (this.pending.size >= MAX_PENDING_REQUESTS)
			throw new Error('Too many bot task requests are waiting. Try again after they finish.');
		const request = validateBotTaskRequest({
			id: randomUUID(),
			name,
			arguments: args,
			operationId,
		});
		return new Promise((resolve, reject) => {
			const abort = () => this.cancel(request.id, 'The bot task was cancelled.');
			const timer = setTimeout(() => {
				this.cancel(request.id, 'The bot task timed out after waiting for this computer.');
			}, this.timeoutMs);
			this.pending.set(request.id, {
				resolve,
				reject,
				timer,
				detach: () => signal?.removeEventListener('abort', abort),
			});
			signal?.addEventListener('abort', abort, { once: true });
			try {
				this.options.deliver(request);
			} catch (error) {
				this.finish(request.id)?.reject(
					new Error(
						(error instanceof Error ? error.message : 'Bot task delivery failed.').slice(
							0,
							MAX_BOT_TASK_ERROR_LENGTH,
						),
					),
				);
			}
		});
	}

	/** Late, duplicate, or unrelated replies never settle a different request. */
	settle(id: string, value: unknown): boolean {
		const pending = this.finish(id);
		if (!pending) return false;
		try {
			const response = validateBotTaskResponse(value);
			if (response.ok) pending.resolve(response.result);
			else pending.reject(new Error(response.error));
		} catch (error) {
			pending.reject(error instanceof Error ? error : new Error('Invalid bot task response.'));
		}
		return true;
	}

	cancel(id: string, reason = 'The bot task was cancelled.'): boolean {
		const pending = this.finish(id);
		if (!pending) return false;
		try {
			this.options.cancel?.(id);
		} catch {
			// The renderer may already have closed. The host still releases its pending request.
		}
		pending.reject(abortError(reason));
		return true;
	}

	close(): void {
		this.closed = true;
		this.ready = false;
		this.cancelAll('The bot task service closed before the task finished.');
	}

	private finish(id: string): PendingTask | undefined {
		const pending = this.pending.get(id);
		if (!pending) return;
		this.pending.delete(id);
		clearTimeout(pending.timer);
		pending.detach();
		return pending;
	}

	private cancelAll(reason: string): void {
		for (const id of this.pending.keys()) this.cancel(id, reason);
	}
}
