import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { ToolContent, ToolDefinition, ToolResult } from '../../src/agent-types';
import { boundedNumber, objectSchema, requiredString, stringParam, textResult } from './common';

/** Codex code-mode protocol adapted to JSON function calls for arbitrary providers. */
export const orchestrationDefinitions: ToolDefinition[] = [
	{
		name: 'functions.exec',
		source: 'builtin',
		description:
			'Execute JavaScript with top-level await in an isolated interpreter. Pass {code: "..."}. No Node, filesystem, network, console, or imports are available. tools contains normalized callable tool names (dots become underscores); every nested call uses the ordinary host approvals and task scope. ALL_TOOLS lists their names and descriptions. Helpers: text(value), image(dataUrl or ToolContent), audio(dataUrl or ToolContent), generatedImage({image_url}), store(key, serializableValue), load(key), setTimeout/clearTimeout, notify(value), yield_control(), exit(). Await independent calls with Promise.all/Promise.allSettled. Store is shared by cells in this run, not durable notes. Do not call video generation, Computer Use, lifecycle, question, permission, context, or task tools from JavaScript; call those directly. Optional first line // @exec: {"yield_time_ms": 1000, "max_output_tokens": 10000}. Yielded scripts return a cell ID; resume with functions.wait. Code has a 5-second cumulative CPU budget, 32 MiB interpreter memory, and 30-minute wall-clock lifetime. When the script ends, unawaited calls and timers are cancelled.',
		parameters: objectSchema(
			{
				code: stringParam('JavaScript source, at most 128 KiB. Top-level await is supported.'),
				yield_time_ms: { type: 'integer', description: 'Initial wait, 0–30000 ms; default 1000.' },
				max_output_tokens: {
					type: 'integer',
					description: 'Approximate text output budget, 1–32000; default 10000.',
				},
			},
			['code'],
		),
	},
	{
		name: 'functions.wait',
		source: 'builtin',
		description:
			'Resume a cell only after functions.exec returned Script running with cell ID. Returns new output since the previous yield, or completion/error, and closes finished cells. terminate:true cancels the worker and outstanding nested calls. Cells belong to this run and cannot be accessed from other tasks.',
		parameters: objectSchema(
			{
				cell_id: stringParam('Cell ID returned by functions.exec.'),
				yield_time_ms: { type: 'integer', description: 'Wait 0–30000 ms; default 1000.' },
				max_tokens: { type: 'integer', description: 'New text budget, 1–32000; default 10000.' },
				terminate: { type: 'boolean', description: 'Cancel the cell and outstanding tools.' },
			},
			['cell_id'],
		),
	},
];

export interface OrchestrationRunContext {
	runId: string;
	tools: ToolDefinition[];
}
export type OrchestrationDispatch = (
	name: string,
	args: Record<string, unknown>,
	signal: AbortSignal,
) => Promise<ToolResult>;
interface Options {
	/** Test injection only. Production runs the adjacent unpacked worker. */
	workerPath?: string;
	cpuBudgetMs?: number;
	lifetimeMs?: number;
	outputLimitBytes?: number;
}
interface Cell {
	id: string;
	runId: string;
	worker: Worker;
	controller: AbortController;
	tools: Map<string, ToolDefinition>;
	dispatch: OrchestrationDispatch;
	content: ToolContent[];
	metadata: ToolResult;
	finished: boolean;
	error?: string;
	yielded: boolean;
	busy: boolean;
	bytes: number;
	outputs: number;
	cpuTimer?: NodeJS.Timeout;
	calls: number;
	pending: Set<number>;
	wake: Set<() => void>;
	cleanup: () => void;
}
const MAX_RESULT_BYTES = 16 * 1024 * 1024;
const MAX_STORE_BYTES = 2 * 1024 * 1024;
const directOnly = new Set([
	'video_gen.videogen',
	'functions.exec',
	'functions.wait',
	'wait',
	'create_goal',
	'get_goal',
	'update_goal',
	'get_context_remaining',
	'new_context',
	'request_user_input',
	'request_user_input_async',
	'request_permissions',
]);
export function isNestedOrchestrationTool(name: string): boolean {
	return !directOnly.has(name) && !/^tasks?\./.test(name) && !name.startsWith('computer_');
}
export function orchestrationWorkerPath(directory: string): string {
	return path.join(
		directory.replace(/\.asar(?=[\\/])/g, '.asar.unpacked'),
		'code-orchestration-worker.cjs',
	);
}
function jsonBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value));
}
function execOptions(args: Record<string, unknown>) {
	const code = requiredString(args, 'code', 128 * 1024);
	let options = args;
	const first = code.split('\n', 1)[0].match(/^\s*\/\/\s*@exec:\s*(.*)$/);
	if (first) {
		const pragma: unknown = JSON.parse(first[1]);
		if (
			!pragma ||
			typeof pragma !== 'object' ||
			Array.isArray(pragma) ||
			Object.entries(pragma).some(
				([key, value]) =>
					!['yield_time_ms', 'max_output_tokens'].includes(key) ||
					!Number.isSafeInteger(value) ||
					(value as number) < 0,
			)
		)
			throw new Error(
				'Invalid @exec pragma. Use nonnegative integer yield_time_ms/max_output_tokens.',
			);
		options = { ...pragma, ...args };
	}
	return {
		code,
		yieldMs: boundedNumber(options.yield_time_ms, 1000, 0, 30_000),
		tokens: boundedNumber(options.max_output_tokens, 10_000, 1, 32_000),
	};
}

/** Workers only orchestrate. All authority stays in the supplied ordinary host dispatcher. */
export class OrchestrationRuntime {
	private readonly options: Required<Options>;
	private cells = new Map<string, Cell>();
	private stores = new Map<string, Record<string, unknown>>();
	private closed = false;
	constructor(options: Options = {}) {
		this.options = {
			workerPath:
				options.workerPath ??
				orchestrationWorkerPath(
					typeof __dirname === 'string' ? __dirname : path.join(process.cwd(), 'dist-electron'),
				),
			cpuBudgetMs: options.cpuBudgetMs ?? 5000,
			lifetimeMs: options.lifetimeMs ?? 30 * 60_000,
			outputLimitBytes: options.outputLimitBytes ?? MAX_RESULT_BYTES,
		};
	}
	async execute(
		name: string,
		args: Record<string, unknown>,
		run: OrchestrationRunContext,
		dispatch: OrchestrationDispatch,
		signal: AbortSignal,
	): Promise<ToolResult> {
		try {
			if (this.closed || signal.aborted) throw new Error('Tool orchestration was cancelled.');
			if (name === 'functions.exec') {
				const options = execOptions(args);
				const cell = this.start(options.code, run, dispatch, signal);
				return await this.observe(cell, options.yieldMs, options.tokens);
			}
			if (name !== 'functions.wait') throw new Error(`Unknown orchestration tool: ${name}.`);
			const cell = this.cells.get(requiredString(args, 'cell_id', 128));
			if (!cell || cell.runId !== run.runId)
				throw new Error(
					'Unknown or closed cell in this run. Use a cell ID returned by functions.exec.',
				);
			if (cell.busy) throw new Error('This cell already has a pending wait.');
			if (args.terminate === true && !cell.finished)
				this.finish(cell, 'Script terminated by request.');
			return await this.observe(
				cell,
				boundedNumber(args.yield_time_ms, 1000, 0, 30_000),
				boundedNumber(args.max_tokens, 10_000, 1, 32_000),
			);
		} catch (error) {
			return textResult(error instanceof Error ? error.message : String(error), true);
		}
	}
	stopRun(runId: string): void {
		for (const cell of this.cells.values()) {
			if (cell.runId !== runId) continue;
			this.finish(cell, 'Tool orchestration was cancelled.');
			this.cells.delete(cell.id);
		}
		this.stores.delete(runId);
	}
	close(): void {
		this.closed = true;
		for (const cell of this.cells.values()) this.finish(cell, 'Tool orchestration was cancelled.');
		this.cells.clear();
		this.stores.clear();
	}
	private start(
		code: string,
		run: OrchestrationRunContext,
		dispatch: OrchestrationDispatch,
		signal: AbortSignal,
	): Cell {
		if (
			this.cells.size >= 16 ||
			[...this.cells.values()].filter((c) => c.runId === run.runId).length >= 4
		)
			throw new Error('Too many orchestration cells. Finish or terminate a previous cell first.');
		const tools = new Map<string, ToolDefinition>();
		for (const tool of run.tools) {
			if (!isNestedOrchestrationTool(tool.name)) continue;
			const normalized = tool.name.replace(/[^a-zA-Z0-9_$]/g, '_');
			if (tools.has(normalized)) throw new Error(`Ambiguous JavaScript tool name: ${normalized}.`);
			tools.set(normalized, tool);
		}
		const worker = new Worker(this.options.workerPath, {
			workerData: {
				code,
				tools: [...tools].map(([name, t]) => ({ name, description: t.description })),
				store: this.stores.get(run.runId) ?? {},
				cpuBudgetMs: this.options.cpuBudgetMs,
				outputLimitBytes: this.options.outputLimitBytes,
			},
			resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 },
		});
		const cell: Cell = {
			id: randomUUID(),
			runId: run.runId,
			worker,
			controller: new AbortController(),
			tools,
			dispatch,
			content: [],
			metadata: { content: [] },
			finished: false,
			yielded: false,
			busy: false,
			bytes: 0,
			outputs: 0,
			calls: 0,
			pending: new Set(),
			wake: new Set(),
			cleanup: () => {},
		};
		const abort = () => this.finish(cell, 'Tool orchestration was cancelled.');
		const deadline = setTimeout(
			() => this.finish(cell, 'Script exceeded its wall-clock lifetime.'),
			this.options.lifetimeMs,
		);
		deadline.unref();
		cell.cleanup = () => {
			clearTimeout(deadline);
			signal.removeEventListener('abort', abort);
		};
		signal.addEventListener('abort', abort, { once: true });
		worker.on('message', (message: unknown) => this.message(cell, message));
		worker.on('error', (error) => this.finish(cell, `JavaScript worker failed: ${error.message}`));
		worker.on('exit', (code) => {
			if (!cell.finished) this.finish(cell, `JavaScript worker exited unexpectedly (${code}).`);
		});
		this.cells.set(cell.id, cell);
		if (signal.aborted) abort();
		return cell;
	}
	private message(cell: Cell, value: unknown): void {
		if (cell.finished || !value || typeof value !== 'object') return;
		const message = value as Record<string, unknown>;
		try {
			if (message.kind === 'call') {
				void this.call(cell, message);
				return;
			}
			if (message.kind === 'cpu') {
				clearTimeout(cell.cpuTimer);
				if (message.running === true)
					cell.cpuTimer = setTimeout(
						() => this.finish(cell, 'JavaScript CPU budget exceeded.'),
						this.options.cpuBudgetMs + 500,
					);
				return;
			}
			if (message.kind === 'store') {
				const key = requiredString(message, 'key', 256);
				const store = Object.assign(Object.create(null), this.stores.get(cell.runId));
				store[key] = message.value;
				if (Object.keys(store).length > 256 || jsonBytes(store) > MAX_STORE_BYTES)
					throw new Error('Run store exceeds 256 keys or 2 MiB.');
				this.stores.set(cell.runId, store);
				return;
			} else if (message.kind === 'output') {
				const content = message.content as ToolContent;
				if (!content || !['text', 'image', 'file'].includes(content.type))
					throw new Error('Invalid orchestration output.');
				cell.bytes += jsonBytes(content);
				if (cell.bytes > this.options.outputLimitBytes || ++cell.outputs > 4096)
					throw new Error('Script output exceeded its byte limit.');
				if (
					content.type === 'text' ||
					!cell.content.some((item) => item.type !== 'text' && item.dataUrl === content.dataUrl)
				)
					cell.content.push(content);
			} else if (message.kind === 'yield') {
				cell.yielded = true;
			} else if (message.kind === 'done') {
				this.finish(cell, typeof message.error === 'string' ? message.error : undefined);
			}
			for (const wake of cell.wake) wake();
		} catch (error) {
			this.finish(cell, error instanceof Error ? error.message : String(error));
		}
	}
	private async call(cell: Cell, message: Record<string, unknown>): Promise<void> {
		const id = message.id;
		try {
			if (!Number.isSafeInteger(id) || cell.pending.has(id as number))
				throw new Error('Invalid nested tool request ID.');
			const tool = cell.tools.get(requiredString(message, 'name', 256));
			if (!tool || !isNestedOrchestrationTool(tool.name))
				throw new Error('Tool is not available for nested orchestration.');
			if (++cell.calls > 512 || cell.pending.size >= 64)
				throw new Error('Script exceeded its nested tool call budget.');
			const args = message.args;
			if (!args || typeof args !== 'object' || Array.isArray(args) || jsonBytes(args) > 1024 * 1024)
				throw new Error('Nested tools require a JSON object of at most 1 MiB.');
			cell.pending.add(id as number);
			const result = await cell.dispatch(
				tool.name,
				args as Record<string, unknown>,
				cell.controller.signal,
			);
			if (cell.finished) return;
			if (jsonBytes(result) > MAX_RESULT_BYTES)
				throw new Error('Nested tool result exceeds 16 MiB.');
			const metadata: ToolResult = { ...cell.metadata };
			for (const key of [
				'fileChanges',
				'outputFiles',
				'outputTrackingNotices',
				'discoveredTools',
			] as const) {
				if (result[key]?.length)
					(metadata as unknown as Record<string, unknown>)[key] = [
						...(metadata[key] ?? []),
						...result[key],
					];
			}
			// An interpreter can finish normally after receiving an authorization error
			// as data. Preserve that failure for the outer activity even if it is not
			// printed. A real denial takes precedence over reviewer outages when this
			// one summary represents several calls; each full result still reaches JS.
			if (result.approvalDenied) {
				metadata.approvalDenied = result.approvalDenied;
				delete metadata.approvalReviewError;
				metadata.isError = true;
			} else if (result.approvalReviewError && !metadata.approvalDenied) {
				metadata.approvalReviewError = result.approvalReviewError;
				metadata.isError = true;
			}
			if (result.moderationWarnings?.length)
				metadata.moderationWarnings = [
					...new Set([...(metadata.moderationWarnings ?? []), ...result.moderationWarnings]),
				].slice(0, 8);
			if (result.research)
				metadata.research = {
					sources: [
						...new Map(
							[...(metadata.research?.sources ?? []), ...(result.research.sources ?? [])].map(
								(s) => [s.id, s],
							),
						).values(),
					],
					images: [
						...new Map(
							[...(metadata.research?.images ?? []), ...(result.research.images ?? [])].map((i) => [
								i.id,
								i,
							]),
						).values(),
					],
				};
			if (jsonBytes(metadata) > 2 * 1024 * 1024) {
				cell.metadata.outputTrackingNotices = [
					...(cell.metadata.outputTrackingNotices ?? []),
					'Orchestration metadata exceeded its 2 MiB budget; additional tracking was omitted.',
				];
				throw new Error('Nested tool metadata exceeds 2 MiB.');
			}
			cell.metadata = metadata;
			// Media is retained even if the model forgets to forward it with image()/audio().
			for (const content of result.content.filter((item) => item.type !== 'text')) {
				if (
					!cell.content.some((item) => item.type !== 'text' && item.dataUrl === content.dataUrl)
				) {
					cell.bytes += jsonBytes(content);
					if (cell.bytes > this.options.outputLimitBytes)
						throw new Error('Script output exceeded its byte limit.');
					cell.content.push(content);
				}
			}
			cell.worker.postMessage({ kind: 'result', id, result });
		} catch (error) {
			if (!cell.finished)
				cell.worker.postMessage({
					kind: 'result',
					id,
					error: error instanceof Error ? error.message : String(error),
				});
		} finally {
			cell.pending.delete(id as number);
		}
	}
	private finish(cell: Cell, error?: string): void {
		if (cell.finished) return;
		cell.finished = true;
		cell.error = error;
		cell.cleanup();
		clearTimeout(cell.cpuTimer);
		cell.controller.abort();
		void cell.worker.terminate();
		for (const wake of cell.wake) wake();
	}
	private async observe(cell: Cell, yieldMs: number, tokens: number): Promise<ToolResult> {
		cell.busy = true;
		try {
			if (!cell.finished && !cell.yielded) {
				await new Promise<void>((resolve) => {
					const done = () => {
						clearTimeout(timeout);
						cell.wake.delete(done);
						resolve();
					};
					const timeout = setTimeout(done, yieldMs);
					cell.wake.add(done);
				});
			}
			cell.yielded = false;
			let remaining = tokens * 4;
			const content: ToolContent[] = [];
			const rest: ToolContent[] = [];
			for (const item of cell.content) {
				if (item.type !== 'text') content.push(item);
				else if (remaining > 0) {
					content.push({ type: 'text', text: item.text.slice(0, remaining) });
					const extra = item.text.slice(remaining);
					remaining = Math.max(0, remaining - item.text.length);
					if (extra) rest.push({ type: 'text', text: extra });
				} else rest.push(item);
			}
			cell.content = rest;
			const result: ToolResult = { ...cell.metadata, content };
			cell.metadata = { content: [] };
			// The model must receive the reason as well as UI metadata when its script
			// did not print the nested error. Other actions in this script may have run.
			const authorizationError = result.approvalDenied ?? result.approvalReviewError;
			if (authorizationError)
				content.push({
					type: 'text',
					text: result.approvalDenied
						? `A nested tool action was denied: ${authorizationError.reason} Do not retry that action without a new user request.`
						: `A nested tool action could not be reviewed: ${authorizationError.reason} Explain the review error; do not automatically resubmit or reword that action to bypass the unavailable reviewer.`,
				});
			if (cell.finished) {
				if (rest.length)
					content.push({ type: 'text', text: '[Remaining output omitted by max_tokens.]' });
				content.push({
					type: 'text',
					text: cell.error ? `Script error: ${cell.error}` : 'Script completed.',
				});
				if (cell.error) result.isError = true;
				this.cells.delete(cell.id);
			} else
				content.push({
					type: 'text',
					text: `Script running with cell ID ${cell.id}. Resume with functions.wait.`,
				});
			return result;
		} finally {
			cell.busy = false;
		}
	}
}
