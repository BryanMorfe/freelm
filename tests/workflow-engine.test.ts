import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
	WorkflowEngine,
	validateWorkflow,
	validateWorkflowCommand,
} from '../electron/workflows/engine';
import { WorkflowStore } from '../electron/workflows/store';
import { nextScheduleAt } from '../electron/workflows/scheduler';
import type {
	WorkflowDefinition,
	WorkflowNode,
	WorkflowNodeExecutor,
	WorkflowRun,
} from '../src/workflow-types';

const roots: string[] = [],
	engines: WorkflowEngine[] = [];
const node = (
	id: string,
	type: WorkflowNode['type'],
	config: Record<string, unknown> = {},
): WorkflowNode => ({ id, type, label: id, config, position: { x: 0, y: 0 } });
function definition(
	id: string,
	nodes: WorkflowNode[],
	connections: [string, string, string?, string?][] = [],
): WorkflowDefinition {
	return {
		version: 1,
		id,
		name: id,
		enabled: false,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		nodes,
		edges: connections.map(([source, target, sourceHandle, targetHandle], index) => ({
			id: `e${index}`,
			source,
			target,
			sourceHandle,
			targetHandle,
		})),
	};
}
async function create(
	execute: WorkflowNodeExecutor = async (_node, inputs) => ({ value: inputs.input }),
	directory?: string,
	now?: () => number,
	concurrency = 3,
	canRun?: () => boolean,
) {
	const root = directory ?? (await mkdtemp(path.join(os.tmpdir(), 'freelm-workflows-')));
	if (!directory) roots.push(root);
	const engine = new WorkflowEngine({
		store: new WorkflowStore(root),
		execute,
		autoSchedule: false,
		now,
		maxConcurrentRuns: concurrency,
		canRun,
	});
	engines.push(engine);
	await engine.init();
	return engine;
}
async function status(engine: WorkflowEngine, id: string, expected: string): Promise<WorkflowRun> {
	await vi.waitFor(() => expect(engine.getRun(id)?.status).toBe(expected), {
		timeout: 10_000,
		interval: 10,
	});
	return engine.getRun(id)!;
}
afterEach(async () => {
	for (const engine of engines.splice(0)) await engine.dispose();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('durable workflow graph engine', () => {
	it('preserves explicit JSON null through templates and outputs', async () => {
		const engine = await create();
		await engine.saveWorkflow(
			definition(
				'null',
				[
					node('value', 'value', { value: null }),
					node('template', 'transform', { template: '{{input}}' }),
					node('out', 'output', { name: 'result' }),
				],
				[
					['value', 'template'],
					['template', 'out'],
				],
			),
		);
		const run = await engine.startRun('null');
		expect((await status(engine, run.id, 'completed')).outputs).toEqual({ result: null });
	});
	it('holds restored and scheduled work until the host readiness gate opens', async () => {
		let ready = false,
			now = 0;
		const execute = vi.fn(async () => ({ value: 'ready' }));
		const engine = await create(
			execute,
			undefined,
			() => now,
			3,
			() => ready,
		);
		const graph = definition(
			'startup',
			[node('schedule', 'schedule', { kind: 'once', at: 1000 }), node('effect', 'tool')],
			[['schedule', 'effect']],
		);
		graph.enabled = true;
		await engine.saveWorkflow(graph);
		now = 1000;
		await engine.scheduler.tick();
		const run = engine.listRuns()[0];
		expect(run.status).toBe('queued');
		expect(execute).not.toHaveBeenCalled();
		await engine.dispose();
		const restored = await create(
			execute,
			engine.store.directory,
			() => now,
			3,
			() => ready,
		);
		expect(restored.getRun(run.id)?.status).toBe('queued');
		expect(execute).not.toHaveBeenCalled();
		ready = true;
		await restored.tick();
		await status(restored, run.id, 'completed');
		expect(execute).toHaveBeenCalledTimes(1);
	});
	it('validates untrusted commands, finite fields, safe ids, and bounded JSON', () => {
		for (const value of [
			null,
			{ type: 'other' },
			{ type: 'run', id: '__proto__' },
			{ type: 'run', id: 'ok', inputs: [] },
			{ type: 'resume', runId: '../outside' },
			{ type: 'emit', name: '' },
			{ type: 'run', id: 'ok', inputs: { value: Infinity } },
			{ type: 'run', id: 'ok', inputs: { text: 'x'.repeat(1024 * 1024 + 1) } },
		])
			expect(() => validateWorkflowCommand(value)).toThrow();
		const graph = definition('valid', [node('one', 'value')]);
		expect(() => validateWorkflowCommand({ type: 'save', workflow: graph })).not.toThrow();
		expect(() =>
			validateWorkflow({ ...graph, nodes: [{ ...graph.nodes[0], position: { x: NaN, y: 0 } }] }),
		).toThrow();
		expect(() => validateWorkflow({ ...graph, settings: { concurrency: 100 } })).toThrow();
		expect(() =>
			validateWorkflow(
				definition('authority', [node('agent', 'agent', { permissionMode: '{{input.mode}}' })]),
			),
		).toThrow(/literal/);
		expect(() =>
			validateWorkflow(
				definition('allowlist', [node('agent', 'agent', { tools: ['{{input.tool}}'] })]),
			),
		).toThrow(/literal/);
		expect(() =>
			validateWorkflowCommand(JSON.parse('{"type":"run","id":"ok","inputs":{"__proto__":{}}}')),
		).toThrow();
	});
	it('runs independent branches concurrently and waits for both before joining', async () => {
		const started: string[] = [];
		let release!: () => void;
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		const engine = await create(async (node) => {
			started.push(node.id);
			await barrier;
			return { value: node.id };
		});
		const graph = definition(
			'parallel',
			[
				node('a', 'tool'),
				node('b', 'tool'),
				node('join', 'join'),
				node('out', 'output', { name: 'results' }),
			],
			[
				['a', 'join', 'value', 'a'],
				['b', 'join', 'value', 'b'],
				['join', 'out'],
			],
		);
		graph.settings = { concurrency: 2 };
		await engine.saveWorkflow(graph);
		const run = await engine.startRun(graph.id);
		await vi.waitFor(() => expect(started).toEqual(['a', 'b']));
		expect(engine.getRun(run.id)?.nodes.join.status).toBe('pending');
		release();
		expect((await status(engine, run.id, 'completed')).outputs).toEqual({
			results: { a: 'a', b: 'b' },
		});
	});
	it('interrupts an active sibling when a parallel branch fails', async () => {
		let fail!: () => void;
		const barrier = new Promise<void>((resolve) => {
			fail = resolve;
		});
		const engine = await create(async (node, _inputs, { signal }) => {
			if (node.id === 'a') {
				await barrier;
				throw new Error('provider failed');
			}
			fail();
			await new Promise<void>((resolve) =>
				signal.addEventListener('abort', () => resolve(), { once: true }),
			);
			return { value: 'late' };
		});
		await engine.saveWorkflow(
			definition(
				'failure',
				[node('a', 'tool'), node('b', 'tool'), node('join', 'join')],
				[
					['a', 'join', 'value', 'a'],
					['b', 'join', 'value', 'b'],
				],
			),
		);
		const run = await engine.startRun('failure'),
			done = await status(engine, run.id, 'failed');
		expect(done.nodes.a.status).toBe('failed');
		expect(done.nodes.b.status).toBe('interrupted');
		expect(done.nodes.join.status).toBe('pending');
	});
	it('never invokes an adapter when persisting its execution intent fails', async () => {
		const execute = vi.fn(async () => ({ value: 'effect' })),
			engine = await create(execute);
		await engine.saveWorkflow(definition('disk-full', [node('external', 'tool')]));
		const save = engine.store.saveRun.bind(engine.store);
		let count = 0;
		vi.spyOn(engine.store, 'saveRun').mockImplementation(async (run) => {
			if (++count >= 3) throw new Error('Disk full');
			await save(run);
		});
		const run = await engine.startRun('disk-full');
		await status(engine, run.id, 'interrupted');
		expect(execute).not.toHaveBeenCalled();
		vi.mocked(engine.store.saveRun).mockRestore();
	});
	it('executes typed data and templates, and publishes named outputs', async () => {
		const execute = vi.fn(async () => ({ value: 'unexpected' })),
			engine = await create(execute);
		await engine.saveWorkflow(
			definition(
				'data',
				[
					node('value', 'value', { value: { topic: 'a better workflow' } }),
					node('format', 'transform', { template: 'Build {{input.topic}}.' }),
					node('out', 'output', { name: 'result' }),
				],
				[
					['value', 'format'],
					['format', 'out'],
				],
			),
		);
		const run = await engine.startRun('data');
		expect((await status(engine, run.id, 'completed')).outputs).toEqual({
			result: 'Build a better workflow.',
		});
		expect(execute).not.toHaveBeenCalled();
	});
	it('skips an unselected branch, propagates skips, and joins only selected inputs', async () => {
		const calls: string[] = [],
			engine = await create(async (node, inputs) => {
				calls.push(node.id);
				return { value: inputs.input };
			});
		await engine.saveWorkflow(
			definition(
				'branches',
				[
					node('value', 'value', { value: 5 }),
					node('if', 'condition', { operator: 'greater-than', compare: 3 }),
					node('yes', 'tool'),
					node('no', 'tool'),
					node('no2', 'tool'),
					node('join', 'join'),
					node('out', 'output', { name: 'result' }),
				],
				[
					['value', 'if', 'value', 'value'],
					['if', 'yes', 'true'],
					['if', 'no', 'false'],
					['no', 'no2'],
					['yes', 'join', 'value', 'yes'],
					['no2', 'join', 'value', 'no'],
					['join', 'out'],
				],
			),
		);
		const run = await engine.startRun('branches'),
			done = await status(engine, run.id, 'completed');
		expect(calls).toEqual(['yes']);
		expect(done.nodes.no.status).toBe('skipped');
		expect(done.nodes.no2.status).toBe('skipped');
		expect(done.outputs).toEqual({ result: { yes: 5 } });
	});
	it('validates missing nodes, duplicate ids, and graph cycles before saving', async () => {
		expect(() =>
			validateWorkflow(
				definition(
					'cycle',
					[node('a', 'value'), node('b', 'value')],
					[
						['a', 'b'],
						['b', 'a'],
					],
				),
			),
		).toThrow(/cycle/);
		expect(() =>
			validateWorkflow(definition('missing', [node('a', 'value')], [['a', 'absent']])),
		).toThrow(/missing node/);
		expect(() =>
			validateWorkflow(definition('duplicate', [node('a', 'value'), node('a', 'value')])),
		).toThrow(/unique/);
	});
	it('cancels an active adapter and never starts downstream side effects', async () => {
		const calls: string[] = [],
			engine = await create(async (node, _inputs, { signal }) => {
				calls.push(node.id);
				await new Promise<void>((resolve) =>
					signal.addEventListener('abort', () => resolve(), { once: true }),
				);
				return { value: 'late result' };
			});
		await engine.saveWorkflow(
			definition('cancel', [node('first', 'tool'), node('second', 'tool')], [['first', 'second']]),
		);
		const run = await engine.startRun('cancel');
		await vi.waitFor(() => expect(calls).toEqual(['first']));
		await engine.cancelRun(run.id);
		const done = await status(engine, run.id, 'cancelled');
		expect(done.nodes.first.status).toBe('cancelled');
		expect(done.nodes.second.status).toBe('cancelled');
		expect(calls).toEqual(['first']);
	});
	it('restores a human wait and resumes without repeating completed steps', async () => {
		const execute = vi.fn(async () => ({ value: 'draft' })),
			engine = await create(execute);
		await engine.saveWorkflow(
			definition(
				'pause',
				[
					node('draft', 'tool'),
					node('review', 'wait', { mode: 'human' }),
					node('out', 'output', { name: 'result' }),
				],
				[
					['draft', 'review'],
					['review', 'out'],
				],
			),
		);
		const run = await engine.startRun('pause');
		await status(engine, run.id, 'waiting');
		await engine.dispose();
		const restored = await create(execute, engine.store.directory);
		expect(restored.getRun(run.id)?.status).toBe('waiting');
		await restored.resumeRun(run.id);
		expect((await status(restored, run.id, 'completed')).outputs).toEqual({ result: 'draft' });
		expect(execute).toHaveBeenCalledTimes(1);
	});
	it('resumes a durable time wait after restart', async () => {
		let now = 1000;
		const engine = await create(undefined, undefined, () => now);
		await engine.saveWorkflow(
			definition(
				'timer',
				[
					node('wait', 'wait', { mode: 'duration', durationMs: 5000 }),
					node('out', 'output', { name: 'result' }),
				],
				[['wait', 'out']],
			),
		);
		const run = await engine.startRun('timer');
		await status(engine, run.id, 'waiting');
		await engine.dispose();
		now = 7000;
		const restored = await create(undefined, engine.store.directory, () => now);
		expect((await status(restored, run.id, 'completed')).outputs).toEqual({ result: true });
	});
	it('marks a crash-interrupted side effect for explicit retry, preserving completed steps', async () => {
		const first = await create();
		const graph = definition(
			'crash',
			[node('before', 'value', { value: 9 }), node('external', 'tool'), node('out', 'output')],
			[
				['before', 'external'],
				['external', 'out'],
			],
		);
		await first.saveWorkflow(graph);
		await first.dispose();
		const interrupted: WorkflowRun = {
			id: 'crashed-run',
			workflowId: graph.id,
			workflowName: graph.name,
			workflowSnapshot: graph,
			status: 'running',
			inputs: {},
			trigger: { kind: 'manual' },
			createdAt: 1,
			nodes: {
				before: { nodeId: 'before', status: 'completed', attempt: 1, output: { value: 9 } },
				external: { nodeId: 'external', status: 'running', attempt: 1 },
				out: { nodeId: 'out', status: 'pending', attempt: 0 },
			},
		};
		await first.store.saveRun(interrupted);
		const execute = vi.fn(async (_node, inputs) => ({ value: inputs.input })),
			restored = await create(execute, first.store.directory);
		expect(restored.getRun(interrupted.id)?.status).toBe('interrupted');
		expect(execute).not.toHaveBeenCalled();
		await restored.resumeRun(interrupted.id, { retry: true });
		const done = await status(restored, interrupted.id, 'completed');
		expect(done.nodes.before.attempt).toBe(1);
		expect(done.nodes.external.attempt).toBe(2);
		expect(execute).toHaveBeenCalledTimes(1);
	});
	it('runs bounded child iterations without deadlocking a single execution slot', async () => {
		const engine = await create(undefined, undefined, undefined, 1);
		await engine.saveWorkflow(
			definition(
				'child',
				[
					node('context', 'context', { source: 'run', path: 'inputs.item' }),
					node('out', 'output', { name: 'item' }),
				],
				[['context', 'out']],
			),
		);
		await engine.saveWorkflow(
			definition(
				'parent',
				[
					node('loop', 'foreach', { workflowId: 'child', items: ['a', 'b', 'c'] }),
					node('out', 'output', { name: 'results' }),
				],
				[['loop', 'out']],
			),
		);
		const run = await engine.startRun('parent'),
			done = await status(engine, run.id, 'completed');
		expect(done.outputs).toEqual({ results: [{ item: 'a' }, { item: 'b' }, { item: 'c' }] });
		expect(done.nodes.loop.childRunIds).toHaveLength(3);
	});
	it('rejects recursive child workflows and excessive loops', async () => {
		const engine = await create();
		await engine.saveWorkflow(
			definition('recursive', [node('loop', 'repeat', { workflowId: 'recursive', count: 2 })]),
		);
		await expect(engine.startRun('recursive')).rejects.toThrow(/Recursive/);
		await engine.saveWorkflow(definition('child', [node('value', 'value')]));
		await engine.saveWorkflow(
			definition('large', [node('loop', 'repeat', { workflowId: 'child', count: 101 })]),
		);
		const large = await engine.startRun('large');
		expect((await status(engine, large.id, 'failed')).error).toMatch(/between 0 and 100/);
	});
	it('persists workflow state independently of run outputs', async () => {
		const engine = await create();
		await engine.saveWorkflow(
			definition(
				'stateful',
				[
					node('set', 'state', { operation: 'set', key: 'counter', value: 7 }),
					node('get', 'state', { operation: 'get', key: 'counter' }),
					node('out', 'output', { name: 'counter' }),
				],
				[
					['set', 'get'],
					['get', 'out'],
				],
			),
		);
		const run = await engine.startRun('stateful');
		expect((await status(engine, run.id, 'completed')).outputs).toEqual({ counter: 7 });
		await engine.dispose();
		const restored = await create(undefined, engine.store.directory);
		expect(restored.store.getState('stateful', 'counter')).toBe(7);
	});
	it('starts only matching enabled events and selects their trigger branch', async () => {
		const engine = await create();
		const graph = definition(
			'event',
			[
				node('manual', 'entry'),
				node('event', 'event', { name: 'thread.completed', filter: { kind: 'chat' } }),
				node('out', 'output', { name: 'result' }),
			],
			[['event', 'out']],
		);
		graph.enabled = true;
		await engine.saveWorkflow(graph);
		expect(await engine.emit('thread.completed', { kind: 'code' })).toEqual([]);
		const [run] = await engine.emit('thread.completed', { kind: 'chat', text: 'ready' });
		const done = await status(engine, run.id, 'completed');
		expect(done.nodes.manual.status).toBe('skipped');
		expect(done.outputs).toEqual({ result: { kind: 'chat', text: 'ready' } });
	});
	it('deduplicates simultaneous admission and preserves deduplication across restart', async () => {
		const engine = await create();
		await engine.saveWorkflow(definition('dedup', [node('value', 'value', { value: 'once' })]));
		const started = await Promise.all(
			Array.from({ length: 8 }, () =>
				engine.startRun('dedup', { trigger: { kind: 'schedule', key: 'schedule:123' } }),
			),
		);
		expect(new Set(started.map((run) => run.id)).size).toBe(1);
		await status(engine, started[0].id, 'completed');
		await engine.dispose();
		const restored = await create(undefined, engine.store.directory);
		expect(
			(await restored.startRun('dedup', { trigger: { kind: 'schedule', key: 'schedule:123' } })).id,
		).toBe(started[0].id);
	});
});

describe('workflow scheduler', () => {
	it('computes interval and timezone-aware daily and weekly occurrences', () => {
		expect(nextScheduleAt({ kind: 'interval', intervalMinutes: 5, at: 0 }, 601_000)).toBe(900_000);
		expect(
			nextScheduleAt(
				{ kind: 'daily', time: '09:00', timezone: 'America/New_York' },
				Date.parse('2026-10-17T12:59:00Z'),
			),
		).toBe(Date.parse('2026-10-17T13:00:00Z'));
		expect(
			nextScheduleAt(
				{ kind: 'weekly', time: '09:00', timezone: 'UTC', weekdays: [1] },
				Date.parse('2026-10-17T12:00:00Z'),
			),
		).toBe(Date.parse('2026-10-19T09:00:00Z'));
	});
	it('skips nonexistent DST minutes and does not run twice during repeated wall times', () => {
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
	});
	it('persists schedule cursors and fires missed schedules only once', async () => {
		let now = 0;
		const engine = await create(undefined, undefined, () => now);
		const graph = definition(
			'scheduled',
			[
				node('schedule', 'schedule', { kind: 'interval', intervalMinutes: 1, missed: 'once' }),
				node('out', 'output'),
			],
			[['schedule', 'out']],
		);
		graph.enabled = true;
		await engine.saveWorkflow(graph);
		await engine.scheduler.tick();
		now = 310_000;
		await engine.scheduler.tick();
		await engine.scheduler.tick();
		expect(engine.listRuns('scheduled')).toHaveLength(1);
		const run = engine.listRuns('scheduled')[0];
		await status(engine, run.id, 'completed');
		await engine.dispose();
		const restored = await create(undefined, engine.store.directory, () => now);
		await restored.scheduler.tick();
		expect(restored.listRuns('scheduled')).toHaveLength(1);
	});
	it('skips missed occurrences and skips overlapping active runs', async () => {
		let now = 0;
		const engine = await create(undefined, undefined, () => now);
		const graph = definition(
			'skip',
			[
				node('schedule', 'schedule', {
					kind: 'interval',
					intervalMinutes: 1,
					missed: 'skip',
					overlap: 'skip',
				}),
				node('hold', 'wait'),
			],
			[['schedule', 'hold']],
		);
		graph.enabled = true;
		await engine.saveWorkflow(graph);
		await engine.scheduler.tick();
		now = 180_000;
		await engine.scheduler.tick();
		expect(engine.listRuns()).toHaveLength(0);
		now = 240_000;
		await engine.scheduler.tick();
		expect(engine.listRuns()).toHaveLength(1);
		await status(engine, engine.listRuns()[0].id, 'waiting');
		now = 300_000;
		await engine.scheduler.tick();
		expect(engine.listRuns()).toHaveLength(1);
	});
	it('queues overlapping schedules and finishes the resumed run before admitting the next', async () => {
		let now = 0;
		const engine = await create(undefined, undefined, () => now);
		const graph = definition(
			'queue',
			[
				node('schedule', 'schedule', { kind: 'interval', intervalMinutes: 1, overlap: 'queue' }),
				node('hold', 'wait'),
				node('out', 'output'),
			],
			[
				['schedule', 'hold'],
				['hold', 'out'],
			],
		);
		graph.enabled = true;
		await engine.saveWorkflow(graph);
		await engine.scheduler.tick();
		now = 60_000;
		await engine.scheduler.tick();
		const first = engine.listRuns()[0];
		await status(engine, first.id, 'waiting');
		now = 120_000;
		await engine.scheduler.tick();
		const second = engine.listRuns().find((run) => run.id !== first.id)!;
		expect(second.status).toBe('queued');
		await engine.resumeRun(first.id);
		await status(engine, first.id, 'completed');
		await status(engine, second.id, 'waiting');
	});
});
