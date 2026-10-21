import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WorkflowEngine } from '../electron/workflows/engine';
import { WorkflowStore } from '../electron/workflows/store';
import type { WorkflowDefinition, WorkflowNode, WorkflowNodeExecutor } from '../src/workflow-types';

const roots: string[] = [],
	engines: WorkflowEngine[] = [];
const node = (
	id: string,
	type: WorkflowNode['type'],
	config: Record<string, unknown> = {},
): WorkflowNode => ({ id, type, config, label: id, position: { x: 0, y: 0 } });
const graph = (
	id: string,
	nodes: WorkflowNode[],
	wires: [string, string, string?, string?][] = [],
): WorkflowDefinition => ({
	version: 1,
	id,
	name: id,
	enabled: false,
	createdAt: 0,
	updatedAt: 0,
	nodes,
	edges: wires.map(([source, target, sourceHandle, targetHandle], index) => ({
		id: `e${index}`,
		source,
		target,
		sourceHandle,
		targetHandle,
	})),
});
async function create(
	execute: WorkflowNodeExecutor = async (_, inputs) => ({ value: inputs.input }),
	directory?: string,
) {
	const root = directory ?? (await mkdtemp(path.join(os.tmpdir(), 'freelm-feedback-')));
	if (!directory) roots.push(root);
	const engine = new WorkflowEngine({
		store: new WorkflowStore(root),
		execute,
		autoSchedule: false,
	});
	engines.push(engine);
	await engine.init();
	return engine;
}
async function status(engine: WorkflowEngine, id: string, expected: string) {
	await vi.waitFor(() => expect(engine.getRun(id)?.status).toBe(expected), {
		timeout: 10000,
		interval: 10,
	});
	return engine.getRun(id)!;
}
async function setup(
	engine: WorkflowEngine,
	config: Record<string, unknown> = {},
	child?: WorkflowDefinition,
) {
	await engine.saveWorkflow(
		child ??
			graph(
				'round',
				[node('agent', 'agent'), node('out', 'output', { name: 'result' })],
				[['agent', 'out']],
			),
	);
	await engine.saveWorkflow(
		graph(
			'parent',
			[
				node('seed', 'value', { value: { count: 0 } }),
				node('loop', 'loop', { workflowId: 'round', maxIterations: 5, ...config }),
				node('out', 'output', { name: 'final' }),
			],
			[
				['seed', 'loop'],
				['loop', 'out'],
			],
		),
	);
}
afterEach(async () => {
	for (const engine of engines.splice(0)) await engine.dispose();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('durable feedback loops', () => {
	it('passes sequential results and outer context into exactly one child at a time and stops early', async () => {
		const seen: Record<string, unknown>[] = [];
		let active = 0,
			maxActive = 0;
		const engine = await create(async (_, _inputs, context) => {
			active++;
			maxActive = Math.max(maxActive, active);
			seen.push(context.run.inputs);
			await new Promise((resolve) => setTimeout(resolve, 5));
			active--;
			const count = (context.run.inputs.current as { count: number }).count + 1;
			return { value: { count, done: count === 3 } };
		});
		await setup(engine);
		const run = await engine.startRun('parent', { inputs: { goal: 'a generic task' } });
		const finished = await status(engine, run.id, 'completed');
		expect(finished.outputs?.final).toEqual({ count: 3, done: true });
		expect(finished.nodes.loop.output).toMatchObject({ iterations: 3, stopped: true });
		expect(maxActive).toBe(1);
		expect(seen.map((value) => (value.current as { count: number }).count)).toEqual([0, 1, 2]);
		expect(seen.map((value) => value.iteration)).toEqual([1, 2, 3]);
		expect(seen.every((value) => value.goal === 'a generic task')).toBe(true);
		expect(seen[0].previous).toBeNull();
		expect(engine.listRuns('round').every((child) => child.rootRunId === run.id)).toBe(true);
	});
	it('honors minimum and maximum rounds while preserving explicit null results', async () => {
		const execute = vi.fn(async () => ({ value: null }));
		const engine = await create(execute);
		await setup(engine, {
			maxIterations: 4,
			minIterations: 2,
			stopPath: '',
			stopOperator: 'equals',
			stopValue: null,
		});
		const first = await engine.startRun('parent');
		expect((await status(engine, first.id, 'completed')).nodes.loop.output).toMatchObject({
			value: null,
			iterations: 2,
			stopped: true,
		});
		await setup(engine, { maxIterations: 3, stopOperator: 'never' });
		const second = await engine.startRun('parent');
		expect((await status(engine, second.id, 'completed')).nodes.loop.output).toMatchObject({
			value: null,
			iterations: 3,
			stopped: false,
		});
		expect(execute).toHaveBeenCalledTimes(5);
	});
	it('rejects a missing result, invalid limits, and missing subworkflow without silently continuing', async () => {
		const engine = await create(async () => ({ value: 1 }));
		await setup(engine, { resultPath: 'absent' });
		const run = await engine.startRun('parent');
		expect((await status(engine, run.id, 'failed')).error).toContain('outputs.absent');
		await setup(engine, { maxIterations: 101 });
		const invalid = await engine.startRun('parent');
		expect((await status(engine, invalid.id, 'failed')).error).toContain('100');
	});
	it('persists a mid-loop human wait and resumes without replaying completed rounds', async () => {
		const engine = await create();
		const child = graph(
			'round',
			[node('wait', 'wait'), node('out', 'output', { name: 'result' })],
			[['wait', 'out']],
		);
		await setup(engine, { maxIterations: 2, stopOperator: 'never' }, child);
		const run = await engine.startRun('parent');
		await status(engine, run.id, 'waiting');
		const first = engine.listRuns('round')[0];
		await status(engine, first.id, 'waiting');
		await vi.waitFor(() => engine.resumeRun(first.id, { value: { round: 1 } }));
		await vi.waitFor(() => expect(engine.listRuns('round')).toHaveLength(2));
		const second = engine.listRuns('round').find((item) => item.id !== first.id)!;
		await status(engine, second.id, 'waiting');
		await engine.dispose();
		const restored = await create(undefined, engine.store.directory);
		expect(restored.getRun(run.id)?.nodes.loop.loop?.iterations).toBe(1);
		await restored.resumeRun(second.id, { value: { round: 2 } });
		expect((await status(restored, run.id, 'completed')).outputs?.final).toEqual({ round: 2 });
		expect(restored.listRuns('round')).toHaveLength(2);
	});
	it('cancels the active child and explicitly retries it without redoing prior rounds', async () => {
		const engine = await create();
		await setup(
			engine,
			{ maxIterations: 2, stopOperator: 'never' },
			graph(
				'round',
				[node('wait', 'wait'), node('out', 'output', { name: 'result' })],
				[['wait', 'out']],
			),
		);
		const run = await engine.startRun('parent');
		await status(engine, run.id, 'waiting');
		const first = engine.listRuns('round')[0];
		await status(engine, first.id, 'waiting');
		await vi.waitFor(() => engine.resumeRun(first.id, { value: 1 }));
		await vi.waitFor(() => expect(engine.listRuns('round')).toHaveLength(2));
		const second = engine.listRuns('round').find((item) => item.id !== first.id)!;
		await status(engine, second.id, 'waiting');
		await status(engine, run.id, 'waiting');
		await engine.cancelRun(run.id);
		expect(engine.getRun(second.id)?.status).toBe('cancelled');
		await engine.resumeRun(run.id, { retry: true });
		await status(engine, second.id, 'waiting');
		await vi.waitFor(() => engine.resumeRun(second.id, { value: 2 }));
		expect((await status(engine, run.id, 'completed')).outputs?.final).toBe(2);
		expect(engine.listRuns('round')).toHaveLength(2);
	});
	it('retries a failed round without admitting a replacement or replaying its predecessor', async () => {
		let failure = true;
		const calls: number[] = [];
		const engine = await create(async (_node, _inputs, context) => {
			const iteration = Number(context.run.inputs.iteration);
			calls.push(iteration);
			if (iteration === 2 && failure) throw new Error('temporary failure');
			return { value: { count: iteration, done: iteration === 2 } };
		});
		await setup(engine);
		const run = await engine.startRun('parent');
		expect((await status(engine, run.id, 'failed')).nodes.loop.loop?.iterations).toBe(1);
		failure = false;
		await vi.waitFor(() => engine.resumeRun(run.id, { retry: true }));
		expect((await status(engine, run.id, 'completed')).nodes.loop.output?.iterations).toBe(2);
		expect(calls).toEqual([1, 2, 2]);
		expect(engine.listRuns('round')).toHaveLength(2);
	});
	it('recovers a child admitted before its parent checkpoint without duplicating the child or effects', async () => {
		const execute = vi.fn(async () => ({ value: { done: true, answer: 42 } }));
		const engine = await create(execute);
		await setup(engine);
		const run = await engine.startRun('parent');
		const completed = await status(engine, run.id, 'completed');
		await engine.dispose();
		// Simulate the old parent checkpoint while the separately persisted child is already complete.
		completed.status = 'running';
		completed.nodes.loop.status = 'running';
		completed.nodes.loop.loop = { value: { count: 0 }, items: [], iterations: 0, stopped: false };
		completed.nodes.loop.childRunIds = [];
		delete completed.nodes.loop.output;
		completed.nodes.out.status = 'pending';
		delete completed.nodes.out.output;
		await engine.store.saveRun(completed);
		const restored = await create(execute, engine.store.directory);
		await restored.resumeRun(run.id, { retry: true });
		expect((await status(restored, run.id, 'completed')).outputs?.final).toEqual({
			done: true,
			answer: 42,
		});
		expect(execute).toHaveBeenCalledTimes(1);
		expect(restored.listRuns('round')).toHaveLength(1);
	});
	it('does not dispatch a child admitted while its parent is being cancelled', async () => {
		const execute = vi.fn(async () => ({ value: { done: true } }));
		const engine = await create(execute);
		await setup(engine);
		const save = engine.store.saveRun.bind(engine.store);
		let release!: () => void,
			entered!: () => void,
			held = false;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const admission = new Promise<void>((resolve) => {
			entered = resolve;
		});
		engine.store.saveRun = async (run) => {
			if (run.parentRunId && !held) {
				held = true;
				entered();
				await gate;
			}
			await save(run);
		};
		const run = await engine.startRun('parent');
		await admission;
		await engine.cancelRun(run.id);
		release();
		await vi.waitFor(() => expect(engine.listRuns('round')[0]?.status).toBe('cancelled'));
		expect(engine.getRun(run.id)?.nodes.loop.status).toBe('cancelled');
		expect(execute).not.toHaveBeenCalled();
		await vi.waitFor(() => engine.resumeRun(run.id, { retry: true }));
		await status(engine, run.id, 'completed');
		expect(execute).toHaveBeenCalledTimes(1);
		expect(engine.listRuns('round')).toHaveLength(1);
	});
	it('holds an orphaned queued child after restart until its interrupted parent is retried', async () => {
		const execute = vi.fn(async () => ({ value: { done: true } }));
		const engine = await create(execute);
		await setup(engine);
		const started = await engine.startRun('parent');
		const parent = await status(engine, started.id, 'completed');
		const child = engine.listRuns('round')[0];
		await engine.dispose();
		parent.status = 'interrupted';
		parent.nodes.loop.status = 'interrupted';
		parent.nodes.loop.loop = { value: { count: 0 }, items: [], iterations: 0, stopped: false };
		parent.nodes.out.status = 'pending';
		child.status = 'queued';
		for (const node of Object.values(child.nodes)) node.status = 'pending';
		await engine.store.saveRun(parent);
		await engine.store.saveRun(child);
		const restored = await create(execute, engine.store.directory);
		expect(restored.getRun(child.id)?.status).toBe('interrupted');
		expect(execute).toHaveBeenCalledTimes(1);
		await restored.resumeRun(parent.id, { retry: true });
		await status(restored, parent.id, 'completed');
		expect(execute).toHaveBeenCalledTimes(2);
		expect(restored.listRuns('round')).toHaveLength(1);
	});
	it('retries all interrupted parallel feedback branches after one child fails', async () => {
		let fail = true;
		const engine = await create(async (_node, _inputs, context) => {
			if (context.workflow.id === 'round-a' && fail) {
				await vi.waitFor(() => expect(engine.listRuns('round-b')[0]?.status).toBe('waiting'));
				throw new Error('one parallel round failed');
			}
			return { value: { done: true } };
		});
		await engine.saveWorkflow(
			graph(
				'round-a',
				[node('agent', 'agent'), node('out', 'output', { name: 'result' })],
				[['agent', 'out']],
			),
		);
		await engine.saveWorkflow(
			graph(
				'round-b',
				[node('wait', 'wait'), node('out', 'output', { name: 'result' })],
				[['wait', 'out']],
			),
		);
		await engine.saveWorkflow(
			graph('parallel', [
				node('a', 'loop', { workflowId: 'round-a' }),
				node('b', 'loop', { workflowId: 'round-b' }),
			]),
		);
		const run = await engine.startRun('parallel');
		await status(engine, run.id, 'failed');
		fail = false;
		await vi.waitFor(() => engine.resumeRun(run.id, { retry: true }));
		await vi.waitFor(() => expect(engine.listRuns('round-b')[0]?.status).toBe('waiting'));
		await vi.waitFor(() =>
			engine.resumeRun(engine.listRuns('round-b')[0].id, { value: { done: true } }),
		);
		await status(engine, run.id, 'completed');
	});
	it('allows parent and nested children to share records while isolating separate root runs', async () => {
		const engine = await create();
		await engine.saveWorkflow(
			graph(
				'reader',
				[
					node('read', 'collection', { name: 'facts', operation: 'list' }),
					node('out', 'output', { name: 'result' }),
				],
				[['read', 'out']],
			),
		);
		await engine.saveWorkflow(
			graph(
				'parent',
				[
					node('write', 'collection', {
						name: 'facts',
						operation: 'append',
						value: { fact: 'kept' },
					}),
					node('child', 'subworkflow', { workflowId: 'reader' }),
					node('out', 'output', { name: 'result' }),
				],
				[
					['write', 'child'],
					['child', 'out'],
				],
			),
		);
		const run = await engine.startRun('parent');
		expect((await status(engine, run.id, 'completed')).outputs?.result).toEqual({
			result: [{ fact: 'kept' }],
		});
		const separate = await engine.startRun('reader');
		expect((await status(engine, separate.id, 'completed')).outputs?.result).toEqual([]);
	});
	it('does not duplicate an append if a crash loses the node checkpoint after the record commit', async () => {
		const engine = await create();
		await engine.saveWorkflow(
			graph('append', [
				node('write', 'collection', { name: 'facts', operation: 'append', value: { answer: 42 } }),
			]),
		);
		const run = await engine.startRun('append');
		const completed = await status(engine, run.id, 'completed');
		await engine.dispose();
		completed.status = 'running';
		completed.nodes.write.status = 'running';
		delete completed.nodes.write.output;
		await engine.store.saveRun(completed);
		const restored = await create(undefined, engine.store.directory);
		expect(restored.getRun(run.id)?.status).toBe('interrupted');
		await restored.resumeRun(run.id, { retry: true });
		const retried = await status(restored, run.id, 'completed');
		expect(retried.nodes.write.output?.record).toMatchObject({ revision: 1 });
		const list = await restored.store.collections.execute({
			scope: 'run',
			scopeId: run.id,
			name: 'facts',
			operation: 'list',
			mutationId: 'inspect',
			provenance: { runId: run.id, nodeId: 'test', workflowId: 'append' },
		});
		expect(list.count).toBe(1);
	});
});
