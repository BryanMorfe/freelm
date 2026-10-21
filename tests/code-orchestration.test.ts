import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import type { ToolDefinition, ToolResult } from '../src/agent-types';
import { AgentHost } from '../electron/agent-host';
import { ToolRuntime } from '../electron/tools/runtime';
import { initialState } from '../src/lib/state';
import { defaultToolSettings } from '../src/lib/tool-settings';
import {
	OrchestrationRuntime,
	isNestedOrchestrationTool,
	orchestrationDefinitions,
	orchestrationWorkerPath,
	type OrchestrationDispatch,
} from '../electron/tools/orchestration';

// Real WASM interpreter and workers, isolated fake host. No profile/provider/local commands.
let directory: string;
let workerPath: string;
const runtimes: OrchestrationRuntime[] = [];
const hosts: AgentHost[] = [];
const tool = (name: string): ToolDefinition => ({
	name,
	description: `Test ${name}`,
	source: 'builtin',
	parameters: { type: 'object' },
});
const result = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const stringify = (value: ToolResult) =>
	value.content
		.filter((i) => i.type === 'text')
		.map((i) => i.text)
		.join('\n');
function setup(options: ConstructorParameters<typeof OrchestrationRuntime>[0] = {}) {
	const runtime = new OrchestrationRuntime({ workerPath, ...options });
	runtimes.push(runtime);
	return runtime;
}
async function exec(
	runtime: OrchestrationRuntime,
	code: string,
	dispatch: OrchestrationDispatch = async () => result('ok'),
	names = ['exec_command'],
	runId = 'run-a',
	signal = new AbortController().signal,
	args: Record<string, unknown> = {},
) {
	return runtime.execute(
		'functions.exec',
		{ code, yield_time_ms: 1000, ...args },
		{ runId, tools: names.map(tool) },
		dispatch,
		signal,
	);
}
async function completed(runtime: OrchestrationRuntime, first: ToolResult, runId = 'run-a') {
	const output = [first];
	for (let i = 0; i < 20; i++) {
		const match = stringify(output.at(-1)!).match(/Script running with cell ID ([\w-]+)/);
		if (!match)
			return {
				...Object.assign({}, ...output),
				content: output.flatMap((r) => r.content),
				approvalDenied: output.find((r) => r.approvalDenied)?.approvalDenied,
				fileChanges: output.flatMap((r) => r.fileChanges ?? []),
				outputFiles: output.flatMap((r) => r.outputFiles ?? []),
				discoveredTools: output.flatMap((r) => r.discoveredTools ?? []),
			};
		output.push(
			await runtime.execute(
				'functions.wait',
				{ cell_id: match[1], yield_time_ms: 1000 },
				{ runId, tools: [] },
				async () => result('unused'),
				new AbortController().signal,
			),
		);
	}
	throw new Error('Cell did not complete.');
}
beforeAll(async () => {
	const cache = path.join(process.cwd(), 'node_modules/.cache');
	await mkdir(cache, { recursive: true });
	directory = await mkdtemp(path.join(cache, 'freelm-orchestration-'));
	workerPath = path.join(directory, 'worker.cjs');
	await build({
		entryPoints: ['electron/tools/orchestration-worker.ts'],
		outfile: workerPath,
		bundle: true,
		platform: 'node',
		format: 'cjs',
		external: ['quickjs-emscripten'],
	});
});
afterEach(async () => {
	for (const host of hosts.splice(0)) await host.close();
	for (const runtime of runtimes.splice(0)) runtime.close();
	vi.restoreAllMocks();
});
afterAll(async () => await rm(directory, { recursive: true, force: true }));

describe('isolated Code orchestration', () => {
	it('describes provider-compatible JSON calls and handles unpacked workers', () => {
		expect(orchestrationDefinitions.map((d) => d.name)).toEqual([
			'functions.exec',
			'functions.wait',
		]);
		expect(orchestrationWorkerPath('/app/app.asar/dist-electron')).toBe(
			'/app/app.asar.unpacked/dist-electron/code-orchestration-worker.cjs',
		);
	});
	it('has no Node, filesystem, network, console, native/WASM/import access', async () => {
		const runtime = setup();
		const output = await completed(
			runtime,
			await exec(
				runtime,
				`
			text([typeof process, typeof require, typeof fetch, typeof console, typeof WebAssembly, typeof SharedArrayBuffer]);
			text(Function("return typeof process")());
			try { await import("node:fs"); } catch (error) { text("import denied"); }
		`,
			),
		);
		expect(output.isError).not.toBe(true);
		expect(stringify(output)).toContain(
			'["undefined","undefined","undefined","undefined","undefined","undefined"]',
		);
		expect(stringify(output)).toContain('import denied');
	});
	it('runs parallel independent calls through the supplied ordinary dispatcher', async () => {
		const runtime = setup();
		let active = 0;
		let peak = 0;
		const dispatch = vi.fn(async (name, args, signal) => {
			expect(name).toBe('safe.read');
			expect(signal.aborted).toBe(false);
			peak = Math.max(peak, ++active);
			await new Promise((resolve) => setTimeout(resolve, 25));
			active--;
			return result(String(args.index));
		});
		const output = await completed(
			runtime,
			await exec(
				runtime,
				`
			const values = await Promise.all([1, 2, 3].map(index => tools.safe_read({index})));
			text(values.map(r => r.content[0].text));
		`,
				dispatch,
				['safe.read'],
			),
		);
		expect(peak).toBe(3);
		expect(dispatch).toHaveBeenCalledTimes(3);
		expect(stringify(output)).toContain('["1","2","3"]');
	});
	it('preserves approval denial and tool errors without granting extra permissions', async () => {
		const runtime = setup();
		const dispatch = vi.fn(async (): Promise<ToolResult> => ({
			...result('Approval denied: outside this task.'),
			isError: true,
			approvalDenied: { reason: 'outside this task', permissionMode: 'auto-review' },
		}));
		const output = await completed(
			runtime,
			await exec(runtime, 'text(await tools.exec_command({cmd:"read private"}));', dispatch),
		);
		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(output.approvalDenied?.reason).toBe('outside this task');
		expect(output.isError).toBe(true);
		expect(stringify(output)).toContain('Approval denied');
	});
	it('marks a normally completed script failed when nested review fails, even without printing it', async () => {
		const runtime = setup();
		const reviewError = {
			reason: 'The reviewer was unavailable; the action was not executed.',
			code: 'unavailable' as const,
			attempts: 3,
			permissionMode: 'auto-review' as const,
		};
		const dispatch = vi.fn(async (): Promise<ToolResult> => ({
			...result(reviewError.reason),
			isError: true,
			approvalReviewError: reviewError,
		}));
		const output = await completed(
			runtime,
			await exec(runtime, 'await tools.exec_command({cmd:"read project"});', dispatch),
		);
		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(output.isError).toBe(true);
		expect(output.approvalReviewError).toEqual(reviewError);
		expect(output.approvalDenied).toBeUndefined();
		expect(stringify(output)).toContain(reviewError.reason);
		expect(stringify(output)).toContain('do not automatically resubmit');
		expect(stringify(output)).toContain('Script completed.');
	});
	it.each([false, true])(
		'keeps an actual denial distinct when mixed with review errors (denial first: %s)',
		async (denialFirst) => {
			const runtime = setup();
			const denied: ToolResult = {
				...result('Action denied.'),
				isError: true,
				approvalDenied: { reason: 'Not authorized.', permissionMode: 'auto-review' },
			};
			const failed: ToolResult = {
				...result('Reviewer unavailable.'),
				isError: true,
				approvalReviewError: {
					reason: 'Review could not complete.',
					code: 'unavailable',
					attempts: 3,
				},
			};
			const dispatch = vi.fn<OrchestrationDispatch>();
			dispatch.mockResolvedValueOnce(denialFirst ? denied : failed);
			dispatch.mockResolvedValueOnce(denialFirst ? failed : denied);
			const output = await completed(
				runtime,
				await exec(
					runtime,
					'const first = await tools.exec_command({cmd:"first"}); const second = await tools.exec_command({cmd:"second"}); text([first, second]);',
					dispatch,
				),
			);
			expect(dispatch).toHaveBeenCalledTimes(2);
			expect(output.isError).toBe(true);
			expect(output.approvalDenied).toEqual(denied.approvalDenied);
			expect(output.approvalReviewError).toBeUndefined();
			expect(stringify(output)).toContain('Action denied.');
			expect(stringify(output)).toContain('Reviewer unavailable.');
		},
	);
	it('filters direct-only tools and missing capabilities, including dynamic lookup', async () => {
		const runtime = setup();
		const dispatch = vi.fn(async () => result('bad'));
		const output = await completed(
			runtime,
			await exec(
				runtime,
				`
			text(ALL_TOOLS.map(t => t.name));
			text(typeof tools.new_context);
			await tools.functions_exec({ code: "text(1)" });
		`,
				dispatch,
				[
					'functions.exec',
					'functions.wait',
					'tasks.read',
					'new_context',
					'get_context_remaining',
					'request_user_input_async',
					'update_goal',
					'history.search',
					'computer_act',
					'computer_observe',
					'video_gen.videogen',
				],
			),
		);
		expect(stringify(output)).toContain('["history_search"]');
		expect(output.isError).toBe(true);
		expect(dispatch).not.toHaveBeenCalled();
		expect(isNestedOrchestrationTool('tasks.list')).toBe(false);
	});
	it('reports rejected host calls and JavaScript syntax/runtime errors visibly', async () => {
		const runtime = setup();
		const hostError = await completed(
			runtime,
			await exec(runtime, 'await tools.exec_command({});', async () => {
				throw new Error('host rejected request');
			}),
		);
		expect(hostError.isError).toBe(true);
		expect(stringify(hostError)).toContain('host rejected request');
		const syntax = await completed(runtime, await exec(runtime, 'const ???;'));
		expect(syntax.isError).toBe(true);
		expect(stringify(syntax)).toContain('SyntaxError');
	});
	it('shares serializable store across cells only in the same run', async () => {
		const runtime = setup();
		await completed(
			runtime,
			await exec(runtime, 'store("value", {count:7}); text(load("value"));'),
		);
		const restored = await completed(runtime, await exec(runtime, 'text(load("value"));'));
		expect(stringify(restored)).toContain('{"count":7}');
		const other = await completed(
			runtime,
			await exec(runtime, 'text(load("value"));', undefined, [], 'run-b'),
			'run-b',
		);
		expect(stringify(other)).toContain('undefined');
		runtime.stopRun('run-a');
		const reset = await completed(runtime, await exec(runtime, 'text(load("value"));'));
		expect(stringify(reset)).toContain('undefined');
	});
	it('yields incremental output, waits for completion, and rejects another run cell', async () => {
		const runtime = setup();
		const first = await exec(
			runtime,
			'text("first"); yield_control(); await new Promise(resolve => setTimeout(resolve, 80)); text("second");',
		);
		const cellId = stringify(first).match(/cell ID ([\w-]+)/)![1];
		const foreign = await runtime.execute(
			'functions.wait',
			{ cell_id: cellId },
			{ runId: 'other', tools: [] },
			async () => result('unused'),
			new AbortController().signal,
		);
		expect(foreign.isError).toBe(true);
		const tail = await completed(
			runtime,
			await runtime.execute(
				'functions.wait',
				{ cell_id: cellId, yield_time_ms: 1000 },
				{ runId: 'run-a', tools: [] },
				async () => result('unused'),
				new AbortController().signal,
			),
		);
		expect(stringify(first)).toContain('first');
		expect(stringify(tail)).toContain('second');
		expect(stringify(tail)).not.toContain('first');
		const closed = await runtime.execute(
			'functions.wait',
			{ cell_id: cellId },
			{ runId: 'run-a', tools: [] },
			async () => result('unused'),
			new AbortController().signal,
		);
		expect(closed.isError).toBe(true);
	});
	it('terminates CPU loops without blocking the host event loop', async () => {
		const runtime = setup({ cpuBudgetMs: 100 });
		let tick = false;
		const timer = setTimeout(() => {
			tick = true;
		}, 10);
		const output = await completed(runtime, await exec(runtime, 'while(true) {}'));
		clearTimeout(timer);
		expect(tick).toBe(true);
		expect(output.isError).toBe(true);
		expect(stringify(output)).toMatch(/CPU|interrupted/);
	});
	it('cancels pending calls when terminating or stopping a run', async () => {
		const runtime = setup();
		let signal!: AbortSignal;
		const dispatch: OrchestrationDispatch = async (_name, _args, pendingSignal) => {
			signal = pendingSignal;
			await new Promise((resolve) =>
				pendingSignal.addEventListener('abort', resolve, { once: true }),
			);
			return result('cancelled');
		};
		const first = await exec(runtime, 'yield_control(); await tools.exec_command({});', dispatch);
		await vi.waitFor(() => expect(signal).toBeDefined());
		const cellId = stringify(first).match(/cell ID ([\w-]+)/)![1];
		const ended = await runtime.execute(
			'functions.wait',
			{ cell_id: cellId, terminate: true },
			{ runId: 'run-a', tools: [] },
			dispatch,
			new AbortController().signal,
		);
		expect(signal.aborted).toBe(true);
		expect(stringify(ended)).toContain('terminated');
		const next = await exec(runtime, 'yield_control(); await new Promise(() => {});');
		runtime.stopRun('run-a');
		const old = await runtime.execute(
			'functions.wait',
			{ cell_id: stringify(next).match(/cell ID ([\w-]+)/)![1] },
			{ runId: 'run-a', tools: [] },
			dispatch,
			new AbortController().signal,
		);
		expect(old.isError).toBe(true);
	});
	it('bounds output, timer lifetime, run store, and interpreter allocations', async () => {
		const runtime = setup({ outputLimitBytes: 1024, lifetimeMs: 2000 });
		const output = await completed(runtime, await exec(runtime, 'text("x".repeat(4096));'));
		expect(output.isError).toBe(true);
		expect(stringify(output)).toContain('byte limit');
		const store = await completed(
			runtime,
			await exec(runtime, 'store("huge", "x".repeat(3 * 1024 * 1024));'),
		);
		expect(store.isError).toBe(true);
		const memory = await completed(
			runtime,
			await exec(runtime, 'const a = new Uint8Array(64 * 1024 * 1024);'),
		);
		expect(memory.isError).toBe(true);
	});
	it('forwards media and verified file/discovery metadata outside model text', async () => {
		const runtime = setup();
		const image = { type: 'image' as const, dataUrl: 'data:image/png;base64,aW1hZ2U=' };
		const dispatch = async (): Promise<ToolResult> => ({
			content: [image],
			moderationWarnings: ['Generation proceeds without image moderation.'],
			fileChanges: [{ kind: 'add', path: '/test/file.md', addedLines: 3, removedLines: 0 }],
			outputFiles: [{ kind: 'add', path: '/test/file.md' }],
			discoveredTools: [tool('mcp.new_tool')],
		});
		const output = await completed(
			runtime,
			await exec(runtime, 'await tools.image_gen({});', dispatch, ['image_gen']),
		);
		expect(output.content).toContainEqual(image);
		expect(output.moderationWarnings).toEqual(['Generation proceeds without image moderation.']);
		expect(output.fileChanges?.[0].addedLines).toBe(3);
		expect(output.outputFiles?.[0].path).toBe('/test/file.md');
		expect(output.discoveredTools?.[0].name).toBe('mcp.new_tool');
	});
	it('accepts Codex pragma options and rejects unsupported or negative fields', async () => {
		const runtime = setup();
		const valid = await completed(
			runtime,
			await exec(runtime, '// @exec: {"max_output_tokens": 4}\ntext("ok")'),
		);
		expect(valid.isError).not.toBe(true);
		const invalid = await exec(runtime, '// @exec: {"network": true}\ntext("bad")');
		expect(invalid.isError).toBe(true);
	});
});

async function hostFixture() {
	const state = initialState();
	state.threads.push({
		id: 'thread',
		kind: 'code',
		title: 'Test',
		model: 'test',
		connectionId: state.activeConnectionId,
		messages: [],
		createdAt: 1,
		updatedAt: 1,
	});
	state.toolSettings = {
		...defaultToolSettings(),
		enabled: true,
		commandExecution: true,
		workspaceRoot: directory,
	};
	vi.spyOn(ToolRuntime.prototype, 'catalog').mockResolvedValue({
		tools: [tool('safe.read')],
		instructions: '',
		warnings: [],
	});
	const approve = vi.fn(async () => true);
	const host = new AgentHost(async () => structuredClone(state), approve);
	(host as unknown as { orchestration: OrchestrationRuntime }).orchestration = setup();
	hosts.push(host);
	await host.catalog('run-a', 'thread');
	const call = (name: string, args: Record<string, unknown> = {}) => ({
		workspaceId: 'local',
		runId: 'run-a',
		threadId: 'thread',
		name,
		arguments: args,
	});
	return { host, approve, call };
}
describe('Code host nested cancellation integration', () => {
	it('terminates a cell pending tool without cancelling unrelated work in its run', async () => {
		const { host, approve, call } = await hostFixture();
		let nestedSignal!: AbortSignal;
		let aborted = false;
		vi.spyOn(ToolRuntime.prototype, 'execute').mockImplementation(
			async (_request, _settings, signal) => {
				if (nestedSignal) return result('next call works');
				nestedSignal = signal;
				await new Promise<void>((resolve) =>
					signal.addEventListener(
						'abort',
						() => {
							aborted = true;
							resolve();
						},
						{ once: true },
					),
				);
				return result('cancelled');
			},
		);
		const first = await host.execute(
			call('functions.exec', { code: 'yield_control(); await tools.safe_read({});' }),
		);
		const cellId = stringify(first).match(/cell ID ([\w-]+)/)![1];
		await vi.waitFor(() => expect(nestedSignal).toBeDefined());
		await host.execute(call('functions.wait', { cell_id: cellId, terminate: true }));
		expect(aborted).toBe(true);
		expect(approve.mock.calls.length).toBe(1);
		const next = await host.execute(call('safe.read'));
		expect(stringify(next)).toBe('next call works');
	});
	it('cancels unawaited calls at completion through ordinary host approval and execution', async () => {
		const { host, approve, call } = await hostFixture();
		let nestedSignal!: AbortSignal;
		vi.spyOn(ToolRuntime.prototype, 'execute').mockImplementation(
			async (_request, _settings, signal) => {
				nestedSignal = signal;
				await new Promise<void>((resolve) =>
					signal.addEventListener('abort', () => resolve(), { once: true }),
				);
				return result('cancelled');
			},
		);
		let output = await host.execute(
			call('functions.exec', {
				code: 'tools.safe_read({}); await new Promise(resolve => setTimeout(resolve, 25)); text("finished");',
			}),
		);
		for (let i = 0; i < 10 && stringify(output).includes('Script running'); i++) {
			output = await host.execute(
				call('functions.wait', {
					cell_id: stringify(output).match(/cell ID ([\w-]+)/)![1],
					yield_time_ms: 1000,
				}),
			);
		}
		expect(nestedSignal?.aborted).toBe(true);
		expect(approve.mock.calls.length).toBe(1);
	});
	it('detaches cell cancellation after completed calls while keeping run cancellation', async () => {
		const { host, call } = await hostFixture();
		let retainedSignal!: AbortSignal;
		vi.spyOn(ToolRuntime.prototype, 'execute').mockImplementation(
			async (_request, _settings, signal) => {
				retainedSignal = signal;
				return result('session returned');
			},
		);
		const cell = new AbortController();
		await host.execute(call('safe.read'), cell.signal);
		cell.abort();
		expect(retainedSignal.aborted).toBe(false);
		host.cancel('run-a');
		expect(retainedSignal.aborted).toBe(true);
	});
	it('does not execute a cancelled approval even if its callback later approves', async () => {
		const { host, call } = await hostFixture();
		let approvalSignal!: AbortSignal;
		let accept!: (value: boolean) => void;
		(
			host as unknown as { approve: (request: unknown, signal: AbortSignal) => Promise<boolean> }
		).approve = async (_request, signal) => {
			approvalSignal = signal;
			return await new Promise<boolean>((resolve) => {
				accept = resolve;
			});
		};
		const execute = vi.spyOn(ToolRuntime.prototype, 'execute');
		const cell = new AbortController();
		const pending = host.execute(call('safe.read'), cell.signal);
		const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
		await vi.waitFor(() => expect(accept).toBeDefined());
		cell.abort();
		expect(approvalSignal.aborted).toBe(true);
		accept(true);
		await rejected;
		expect(execute).not.toHaveBeenCalled();
	});
});
