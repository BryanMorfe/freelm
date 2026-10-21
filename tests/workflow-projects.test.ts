import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WorkflowEngine } from '../electron/workflows/engine';
import { WorkflowStore } from '../electron/workflows/store';
import { normalizeWorkflowInputs, validateWorkflowRequest } from '../src/lib/workflow-inputs';
import type {
	WorkflowDefinition,
	WorkflowNode,
	WorkflowNodeExecutor,
	WorkflowProjectContext,
} from '../src/workflow-types';

const roots: string[] = [],
	engines: WorkflowEngine[] = [];
const projects = new Map<string, WorkflowProjectContext>([
	[
		'novis',
		{
			id: 'novis',
			name: 'Novis',
			directories: ['/projects/novis', '/shared'],
			instructions: 'Investigate learning systems.',
		},
	],
	[
		'materials',
		{
			id: 'materials',
			name: 'Materials',
			directories: ['/projects/materials'],
			instructions: 'Investigate materials.',
		},
	],
]);
const node = (
	id: string,
	type: WorkflowNode['type'],
	config: Record<string, unknown> = {},
): WorkflowNode => ({ id, type, config, label: id, position: { x: 0, y: 0 } });
const graph = (
	id: string,
	nodes: WorkflowNode[],
	wires: [string, string][] = [],
): WorkflowDefinition => ({
	version: 1,
	id,
	name: id,
	enabled: false,
	createdAt: 0,
	updatedAt: 0,
	nodes,
	edges: wires.map(([source, target], index) => ({ id: `e${index}`, source, target })),
});
async function create(
	execute: WorkflowNodeExecutor = async (_, inputs) => ({ value: inputs.input }),
	directory?: string,
	canRun?: () => boolean,
) {
	const root = directory ?? (await mkdtemp(path.join(os.tmpdir(), 'freelm-project-workflow-')));
	if (!directory) roots.push(root);
	const engine = new WorkflowEngine({
		store: new WorkflowStore(root),
		execute,
		autoSchedule: false,
		canRun,
		resolveProject: (id) => projects.get(id),
	});
	engines.push(engine);
	await engine.init();
	return engine;
}
async function done(engine: WorkflowEngine, id: string) {
	await vi.waitFor(() => expect(engine.getRun(id)?.status).toBe('completed'), {
		timeout: 10000,
		interval: 10,
	});
	return engine.getRun(id)!;
}
afterEach(async () => {
	for (const engine of engines.splice(0)) await engine.dispose();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('project workflow bindings', () => {
	it('clears optional model overrides through native structured-clone settings and persists the reset', async () => {
		let engine = await create();
		await engine.saveWorkflow(graph('reset', [node('value', 'value')]));
		const binding = await engine.attachWorkflow({
			workflowId: 'reset',
			projectId: 'novis',
			settings: { connectionId: 'api', model: 'qwen', thinkingMode: undefined },
		});
		await engine.updateBinding(binding.id, {
			settings: { connectionId: undefined, model: undefined, thinkingMode: undefined },
		});
		const directory = engine.store.directory;
		await engine.dispose();
		engine = await create(undefined, directory);
		expect(engine.getBinding(binding.id)?.settings).toEqual({});
		expect(() =>
			engine.updateBinding(binding.id, { settings: { projectId: undefined } as never }),
		).toThrow(/Invalid project workflow setting/);
	});

	it('isolates shared state, workflow collections, and request history across two projects, including restart', async () => {
		let engine = await create();
		const workflow = graph(
			'research',
			[
				node('old', 'state', { key: 'topic', value: 'empty' }),
				node('old-output', 'output', { name: 'previous' }),
				node('set', 'state', { key: 'topic', operation: 'set', value: '{{run.inputs.goal}}' }),
				node('record', 'collection', {
					scope: 'workflow',
					name: 'history',
					operation: 'append',
					value: '{{run.inputs.goal}}',
				}),
				node('records', 'collection', { scope: 'workflow', name: 'history', operation: 'list' }),
			],
			[
				['old', 'old-output'],
				['old-output', 'set'],
				['set', 'record'],
				['record', 'records'],
			],
		);
		// The set input deliberately comes from the previous node; give it a distinct handle below.
		workflow.edges.find((edge) => edge.target === 'set')!.targetHandle = 'dependency';
		workflow.edges.find((edge) => edge.target === 'record')!.targetHandle = 'dependency';
		workflow.request = { prompt: { key: 'goal', label: 'Research request', required: true } };
		await engine.saveWorkflow(workflow);
		const a = await engine.attachWorkflow({ workflowId: 'research', projectId: 'novis' });
		const b = await engine.attachWorkflow({ workflowId: 'research', projectId: 'materials' });
		const first = await done(
			engine,
			(
				await engine.startRun('research', {
					bindingId: a.id,
					inputs: { prompt: 'Continual learning' },
				})
			).id,
		);
		const second = await done(
			engine,
			(
				await engine.startRun('research', {
					bindingId: b.id,
					inputs: { text: 'Conductive polymers' },
				})
			).id,
		);
		expect(first.inputs.goal).toBe('Continual learning');
		expect(second.inputs.goal).toBe('Conductive polymers');
		expect(first.outputs?.previous).toBe('empty');
		expect(second.outputs?.previous).toBe('empty');
		expect(first.nodes.records.output?.count).toBe(1);
		expect(second.nodes.records.output?.count).toBe(1);
		const directory = engine.store.directory;
		await engine.dispose();
		engine = await create(undefined, directory);
		const third = await done(
			engine,
			(
				await engine.startRun('research', {
					bindingId: a.id,
					inputs: { goal: 'Memory consolidation' },
				})
			).id,
		);
		expect(third.outputs?.previous).toBe('Continual learning');
		expect(third.nodes.records.output?.count).toBe(2);
		expect(engine.listBindings('materials')).toHaveLength(1);
		expect(engine.listRuns().filter((run) => run.projectId === 'novis')).toHaveLength(2);
	});
	it('pins all nested dependencies and project model/settings for children despite library edits or deletion', async () => {
		const observed: { model: unknown; project: unknown; permission: unknown; text: unknown }[] = [];
		const engine = await create(async (node, _, context) => {
			observed.push({
				model: node.config.model,
				project: context.run.projectContext,
				permission: node.config.permissionMode,
				text: node.config.prompt,
			});
			return { value: node.config.prompt };
		});
		const child = graph(
			'child',
			[
				node('agent', 'agent', {
					model: 'old',
					prompt: 'Version one',
					permissionMode: 'full-access',
				}),
				node('out', 'output', { name: 'result' }),
			],
			[['agent', 'out']],
		);
		const middle = graph(
			'middle',
			[
				node('child', 'subworkflow', { workflowId: 'child' }),
				node('out', 'output', { name: 'result' }),
			],
			[['child', 'out']],
		);
		const parent = graph('parent', [node('middle', 'subworkflow', { workflowId: 'middle' })]);
		for (const definition of [child, middle, parent]) await engine.saveWorkflow(definition);
		const binding = await engine.attachWorkflow({
			workflowId: 'parent',
			projectId: 'novis',
			settings: {
				connectionId: 'api',
				model: 'qwen',
				thinkingMode: 'medium',
				permissionMode: 'full-access',
			},
		});
		child.nodes[0].config.prompt = 'Changed later';
		await engine.saveWorkflow(child);
		await engine.deleteWorkflow('middle');
		const run = await done(
			engine,
			(
				await engine.startRun('parent', {
					bindingId: binding.id,
					inputs: { prompt: 'A new subject' },
					sourceThreadId: 'code-thread',
					permissionMode: 'auto-review',
				})
			).id,
		);
		expect(observed).toEqual([
			{
				model: 'qwen',
				text: 'Version one',
				permission: 'auto-review',
				project: projects.get('novis'),
			},
		]);
		expect(run.workflowSnapshot.settings?.workspaceRoot).toBe('/projects/novis');
		expect(Object.keys(run.dependencySnapshots!)).toHaveLength(2);
		expect(
			engine
				.listRuns()
				.every((item) => item.bindingId === binding.id && item.sourceThreadId === 'code-thread'),
		).toBe(true);
		expect(engine.listThreadRuns()).toHaveLength(1);
	});
	it('pins unbound dependencies at run admission and never rereads the mutable library for children', async () => {
		let ready = false;
		const engine = await create(
			async (node) => ({ value: node.config.value }),
			undefined,
			() => ready,
		);
		const child = graph(
			'child',
			[node('value', 'value', { value: 'original' }), node('out', 'output', { name: 'result' })],
			[['value', 'out']],
		);
		await engine.saveWorkflow(child);
		await engine.saveWorkflow(
			graph('root', [node('child', 'subworkflow', { workflowId: 'child' })]),
		);
		const run = await engine.startRun('root');
		child.nodes[0].config.value = 'new';
		await engine.saveWorkflow(child);
		ready = true;
		await engine.tick();
		await done(engine, run.id);
		expect(engine.listRuns('child')[0].nodes.value.output?.value).toBe('original');
	});
	it('keeps private project variants out of the library and preserves binding history across edits', async () => {
		const engine = await create();
		const definition = graph('private', [node('value', 'value', { value: 1 })]);
		const binding = await engine.attachWorkflow({
			workflowId: definition.id,
			workflow: definition,
			projectId: 'novis',
			bindingId: 'private-binding',
		});
		const run = await done(
			engine,
			(await engine.startRun('private', { bindingId: binding.id })).id,
		);
		definition.nodes[0].config.value = 2;
		const updated = await engine.updateBinding(binding.id, {
			workflow: definition,
			expectedRevision: 1,
		});
		expect(updated.revision).toBe(2);
		expect(engine.listWorkflows()).toEqual([]);
		expect(engine.getRun(run.id)?.nodes.value.output?.value).toBe(1);
		await expect(
			engine.updateBinding(binding.id, { name: 'Stale', expectedRevision: 1 }),
		).rejects.toThrow(/changed/);
		await engine.detachWorkflow(binding.id);
		expect(engine.getRun(run.id)?.bindingId).toBe(binding.id);
		expect(engine.listBindings()).toEqual([]);
	});
	it('deduplicates concurrent admission and rejects deleted projects before any work', async () => {
		const engine = await create();
		await engine.saveWorkflow(graph('simple', [node('value', 'value')]));
		const [a, b] = await Promise.all(
			[1, 2].map(() =>
				engine.attachWorkflow({ workflowId: 'simple', projectId: 'novis', bindingId: 'one' }),
			),
		);
		expect(a.id).toBe(b.id);
		const runs = await Promise.all(
			[1, 2].map(() =>
				engine.startRun('simple', {
					bindingId: a.id,
					requestId: 'one-call',
					sourceThreadId: 'thread',
				}),
			),
		);
		expect(runs[0].id).toBe(runs[1].id);
		await done(engine, runs[0].id);
		await expect(
			engine.attachWorkflow({ workflowId: 'simple', projectId: 'gone' }),
		).rejects.toThrow(/Project not found/);
		const project = projects.get('novis')!;
		projects.delete('novis');
		try {
			await expect(engine.startRun('simple', { bindingId: a.id })).rejects.toThrow(
				/Project not found/,
			);
		} finally {
			projects.set('novis', project);
		}
	});
});

describe('workflow request contract', () => {
	it('normalizes composer and named tool inputs identically, validates fields, and does not change legacy graphs', () => {
		const workflow = graph('request', []);
		workflow.request = {
			prompt: { key: 'goal', required: true },
			fields: [{ key: 'rounds', label: 'Rounds', type: 'number', defaultValue: 2 }],
		};
		expect(
			normalizeWorkflowInputs(workflow, { prompt: 'Chemistry' }, { goal: 'Old topic' }),
		).toEqual({ prompt: 'Chemistry', goal: 'Chemistry', rounds: 2 });
		expect(normalizeWorkflowInputs(workflow, { goal: 'Physics' }).goal).toBe('Physics');
		expect(() => normalizeWorkflowInputs(workflow, {})).toThrow(/required/);
		expect(() => normalizeWorkflowInputs(workflow, { goal: 'Math', rounds: '2' })).toThrow(
			/Rounds must be number/,
		);
		expect(() => validateWorkflowRequest({ prompt: { key: '__proto__' } })).toThrow(/valid prompt/);
		expect(
			normalizeWorkflowInputs(graph('legacy', []), { current: { goal: 'Unchanged' } }),
		).toEqual({ current: { goal: 'Unchanged' } });
	});
});
