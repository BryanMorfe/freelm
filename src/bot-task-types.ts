/** The only workspace actions a bot can request through the host-owned task bridge. */
export const BOT_TASK_NAMES = [
	'threads_list',
	'threads_search',
	'threads_read',
	'threads_create',
	'threads_send',
	'threads_wait',
	'threads_rename',
	'threads_archive',
	'threads_stop',
	'projects_list',
	'models_list',
] as const;

export type BotTaskName = (typeof BOT_TASK_NAMES)[number];
export interface BotTaskRequest {
	/** A unique delivery identifier. A response must match this exact request. */
	id: string;
	name: BotTaskName;
	arguments: Record<string, unknown>;
	/** Stable identity for an operation retried by the bot, distinct from delivery. */
	operationId: string;
}
export type BotTaskResponse = { ok: true; result: unknown } | { ok: false; error: string };

export interface HostTaskSnapshot {
	workspaceRevision?: string;
	runs: {
		threadId: string;
		runId: string;
		owner: 'host' | 'renderer' | 'remote';
		status: import('./lib/code-task-tools').CodeTaskStatus;
		cancelled?: boolean;
	}[];
	questions: {
		id: string;
		threadId: string;
		runId: string;
		questions: import('./lib/interaction-tools').UserQuestion[];
	}[];
}

export interface BotTaskRendererBridge {
	hostTasksSnapshot?(): Promise<HostTaskSnapshot>;
	onHostTasksChanged?(listener: () => void): () => void;
	hostTaskClaim?(threadId: string, runId: string): Promise<boolean>;
	hostTaskRelease?(threadId: string, runId: string): Promise<void>;
	hostTaskStop?(threadId: string): Promise<void>;
	hostTaskDispatch?(
		threadId: string,
	): Promise<{ status: 'started' | 'queued' | 'unavailable'; error?: string }>;
	hostTaskAnswer?(id: string, answers: Record<string, { answers: string[] }>): Promise<void>;
	onBotTaskRequest?(listener: (request: BotTaskRequest) => void): () => void;
	onBotTaskCancel?(listener: (id: string) => void): () => void;
	botTasksReady?(ready: boolean): Promise<void>;
	botTaskResult?(id: string, response: BotTaskResponse): Promise<void>;
}

export const MAX_BOT_TASK_REQUEST_BYTES = 128 * 1024;
export const MAX_BOT_TASK_RESPONSE_BYTES = 512 * 1024;
export const MAX_BOT_TASK_ERROR_LENGTH = 2000;

function record(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** Keep the cross-process contract JSON-only, bounded, and independent of Electron. */
function checkedJSON(value: unknown, maximumBytes: number): string {
	const seen = new Set<object>();
	const visit = (item: unknown, depth: number): void => {
		if (depth > 24) throw new Error('Bot task data is nested too deeply.');
		if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
		if (typeof item === 'number' && Number.isFinite(item)) return;
		if (typeof item !== 'object' || (!Array.isArray(item) && !record(item)))
			throw new Error('Bot task data must contain only JSON values.');
		if (seen.has(item)) throw new Error('Bot task data cannot contain cycles.');
		seen.add(item);
		for (const child of Object.values(item)) visit(child, depth + 1);
		seen.delete(item);
	};
	visit(value, 0);
	const json = JSON.stringify(value);
	if (new TextEncoder().encode(json).byteLength > maximumBytes)
		throw new Error('Bot task data exceeds the transport limit.');
	return json;
}

export function isBotTaskName(value: unknown): value is BotTaskName {
	return typeof value === 'string' && (BOT_TASK_NAMES as readonly string[]).includes(value);
}

/** Returns a detached JSON value so subsequent caller mutations cannot alter a delivery. */
export function validateBotTaskRequest(value: unknown): BotTaskRequest {
	if (
		!record(value) ||
		typeof value.id !== 'string' ||
		!value.id.trim() ||
		value.id.length > 200 ||
		!isBotTaskName(value.name) ||
		!record(value.arguments) ||
		typeof value.operationId !== 'string' ||
		!value.operationId.trim() ||
		value.operationId.length > 512 ||
		Object.keys(value).some((key) => !['id', 'name', 'arguments', 'operationId'].includes(key))
	)
		throw new Error('Invalid bot task request.');
	return JSON.parse(checkedJSON(value, MAX_BOT_TASK_REQUEST_BYTES)) as BotTaskRequest;
}

export function validateBotTaskResponse(value: unknown): BotTaskResponse {
	if (!record(value) || typeof value.ok !== 'boolean')
		throw new Error('Invalid bot task response.');
	if (value.ok) {
		if (
			!Object.hasOwn(value, 'result') ||
			Object.keys(value).some((key) => !['ok', 'result'].includes(key))
		)
			throw new Error('Invalid bot task response.');
	} else if (
		typeof value.error !== 'string' ||
		!value.error.trim() ||
		value.error.length > MAX_BOT_TASK_ERROR_LENGTH ||
		Object.keys(value).some((key) => !['ok', 'error'].includes(key))
	)
		throw new Error('Invalid bot task error response.');
	return JSON.parse(checkedJSON(value, MAX_BOT_TASK_RESPONSE_BYTES)) as BotTaskResponse;
}
