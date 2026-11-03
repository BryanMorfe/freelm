import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { WorkflowEngine } from '../electron/workflows/engine';
import { WorkflowStore } from '../electron/workflows/store';
import { WorkflowToolService } from '../electron/workflows/tool-service';
import { AgentHost } from '../electron/agent-host';
import { initialState } from '../src/lib/state';
import { defaultToolSettings } from '../src/lib/tool-settings';
import { codePlanToolDenial } from '../src/lib/code-plan';
import type { ToolResult } from '../src/agent-types';
import type { WorkflowToolContext } from '../src/lib/workflow-tools';
import type { WorkflowDefinition, WorkflowNodeExecutor } from '../src/workflow-types';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
});
function result(output: ToolResult): any {
	return JSON.parse(
		output.content
			.filter((item) => item.type === 'text')
			.map((item) => (item.type === 'text' ? item.text : ''))
			.join('\n'),
	);
}
const context = (projectId = 'novis'): WorkflowToolContext => ({
	projectId,
	threadId: `thread-${projectId}`,
	connectionId: 'local-models',
	model: 'qwen',
	thinkingMode: 'medium',
	permissionMode: 'ask',
	signal: new AbortController().signal,
});
const graph = (): Pick<WorkflowDefinition, 'name' | 'request' | 'nodes' | 'edges'> => ({
	name: 'Research input',
	request: { prompt: { key: 'question', required: true } },
	nodes: [
		{ id: 'entry', type: 'entry', label: 'Request', position: { x: 0, y: 0 }, config: {} },
		{
			id: 'result',
			type: 'output',
			label: 'Result',
			position: { x: 300, y: 0 },
			config: { name: 'result' },
		},
	],
	edges: [
		{ id: 'edge', source: 'entry', target: 'result', sourceHandle: 'value', targetHandle: 'input' },
	],
});
async function fixture(execute?: WorkflowNodeExecutor) {
	const directory = await mkdtemp(path.join(tmpdir(), 'freelm-workflow-tools-'));
	const engine = new WorkflowEngine({
		store: new WorkflowStore(directory),
		execute: execute ?? (async (_node, inputs) => ({ value: inputs.input })),
		autoSchedule: false,
		resolveProject: (id) =>
			['novis', 'biology'].includes(id)
				? { id, name: id, directories: [directory], instructions: '' }
				: undefined,
	});
	await engine.init();
	cleanups.push(async () => {
		await engine.dispose();
		await rm(directory, { recursive: true, force: true });
	});
	const service = new WorkflowToolService(engine);
	const call = async (name: string, args: Record<string, unknown>, scope = context()) =>
		result(await service.execute(`workflows.${name}`, args, scope));
	return { engine, service, call };
}

describe('project-scoped Code workflow tools', () => {
	it('creates private project installations and retries idempotently across service restarts', async () => {
		const { engine, service, call } = await fixture();
		const args = { idempotencyKey: 'create-one', graph: graph() };
		const [one, duplicate] = await Promise.all([call('create', args), call('create', args)]);
		expect(one.bindingId).toBe(duplicate.bindingId);
		expect(engine.listBindings('novis')).toHaveLength(1);
		expect(engine.listWorkflows()).toHaveLength(0);
		const restarted = new WorkflowToolService(engine);
		expect(result(await restarted.execute('workflows.create', args, context())).created).toBe(
			false,
		);
		await expect(
			service.execute('workflows.create', { ...args, name: 'Different' }, context()),
		).rejects.toThrow('different workflow');
	});
	it('keeps project installations, history and outputs private', async () => {
		const { call, engine } = await fixture();
		const one = await call('create', { idempotencyKey: 'one', graph: graph() });
		const second = await call(
			'create',
			{ idempotencyKey: 'one', graph: graph() },
			context('biology'),
		);
		expect((await call('list', {})).items.map((item: any) => item.bindingId)).toEqual([
			one.bindingId,
		]);
		await expect(call('inspect', { bindingId: second.bindingId })).rejects.toThrow(
			'not found in this project',
		);
		await expect(
			call('run', {
				bindingId: second.bindingId,
				idempotencyKey: 'wrong',
				prompt: 'wrong project',
			}),
		).rejects.toThrow('not found in this project');
		const run = await call('run', {
			bindingId: one.bindingId,
			idempotencyKey: 'run',
			prompt: 'Novis research',
		});
		await vi.waitFor(() => expect(engine.getRun(run.runId)?.status).toBe('completed'));
		await expect(call('read_run', { runId: run.runId }, context('biology'))).rejects.toThrow(
			'not found in this project',
		);
		await expect(call('cancel', { runId: run.runId }, context('biology'))).rejects.toThrow(
			'not found in this project',
		);
		expect(JSON.stringify(await call('read_run', { runId: run.runId }))).toContain(
			'Novis research',
		);
	});
	it('returns admission while external work is pending, passes thread identity and deduplicates run retries', async () => {
		let finish!: () => void;
		const work = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const { call, engine } = await fixture(async () => {
			await work;
			return { value: 'done' };
		});
		const definition = graph();
		definition.nodes[1].type = 'text';
		const created = await call('create', { idempotencyKey: 'one', graph: definition });
		const args = {
			bindingId: created.bindingId,
			idempotencyKey: 'investigation',
			prompt: 'Investigate X',
		};
		const run = await call('run', args);
		expect(['running', 'queued']).toContain(run.status);
		expect(engine.getRun(run.runId)?.sourceThreadId).toBe(context().threadId);
		const duplicate = await call('run', args);
		expect(duplicate.runId).toBe(run.runId);
		expect(engine.listRuns()).toHaveLength(1);
		await expect(call('run', { ...args, prompt: 'Different request' })).rejects.toThrow(
			'different run request',
		);
		finish();
		await vi.waitFor(() => expect(engine.getRun(run.runId)?.status).toBe('completed'));
	});
	it('rejects graph authority changes, invalid graphs, unknown child definitions and forged scope arguments', async () => {
		const { call, engine } = await fixture();
		for (const key of ['projectId', 'permissionMode', 'workspaceRoot']) {
			const definition = graph();
			definition.nodes[0].config = { [key]: 'full-access' };
			await expect(call('create', { idempotencyKey: key, graph: definition })).rejects.toThrow(
				'host-owned',
			);
		}
		const bad = graph();
		bad.edges[0].target = 'missing';
		await expect(call('validate', { graph: bad })).rejects.toThrow();
		const child = graph();
		child.nodes[1].type = 'subworkflow';
		child.nodes[1].config = { workflowId: 'private-other-project' };
		await expect(call('create', { idempotencyKey: 'child', graph: child })).rejects.toThrow(
			'Supply the child',
		);
		await expect(call('list', { projectId: 'biology' })).rejects.toThrow('Invalid');
		expect(engine.listBindings()).toHaveLength(0);
	});
	it('updates one binding revision without changing a shared library or another project', async () => {
		const { call, engine } = await fixture();
		const saved = await engine.saveWorkflow({
			...graph(),
			id: 'shared',
			version: 1,
			createdAt: 1,
			updatedAt: 1,
			enabled: false,
		} as any);
		const a = await call('create', { idempotencyKey: 'one', libraryWorkflowId: saved.id });
		const b = await call(
			'create',
			{ idempotencyKey: 'one', libraryWorkflowId: saved.id },
			context('biology'),
		);
		const revised = { ...graph(), name: 'Novis custom process' };
		await call('update', { bindingId: a.bindingId, expectedRevision: 1, graph: revised });
		expect(engine.getBinding(a.bindingId)?.workflowSnapshot.name).toBe('Novis custom process');
		expect(engine.getBinding(b.bindingId)?.workflowSnapshot.name).toBe(saved.name);
		expect(engine.getWorkflow(saved.id)?.name).toBe(saved.name);
		await expect(
			call('update', { bindingId: a.bindingId, expectedRevision: 1, graph: revised }),
		).rejects.toThrow('changed');
	});
	it('builds the reusable Co-Scientist package with the trusted model', async () => {
		const { call, engine } = await fixture();
		const created = await call('create', { idempotencyKey: 'scientist', template: 'co-scientist' });
		const binding = engine.getBinding(created.bindingId)!;
		const all = [binding.workflowSnapshot, ...Object.values(binding.dependencySnapshots)];
		expect(all.length).toBeGreaterThan(1);
		expect(
			all
				.flatMap((item) => item.nodes)
				.filter((node) => node.type === 'agent')
				.every(
					(node) => node.config.connectionId === 'local-models' && node.config.model === 'qwen',
				),
		).toBe(true);
		expect(binding.settings?.permissionMode).toBe('ask');
		expect(
			all
				.flatMap((item) => item.nodes)
				.filter((node) => node.type === 'agent')
				.every((node) => Array.isArray(node.config.tools) && node.config.tools.length === 0),
		).toBe(true);
		expect(engine.listWorkflows()).toEqual([]);
	});
	it('discovers trusted available tools and enables research retrieval only when web is advertised', async () => {
		const { call, engine } = await fixture();
		const scope = {
			...context(),
			availableTools: [
				{ name: 'web.run', description: 'Search and read web pages' },
				{ name: 'exec_command', description: 'Run commands' },
			],
		};
		const catalog = await call('catalog', {}, scope);
		expect(catalog.availableTools).toEqual({
			items: scope.availableTools,
			total: 2,
			nextOffset: null,
		});
		const created = await call(
			'create',
			{ idempotencyKey: 'scientist-web', template: 'co-scientist' },
			scope,
		);
		const binding = engine.getBinding(created.bindingId)!;
		const agents = [binding.workflowSnapshot, ...Object.values(binding.dependencySnapshots)]
			.flatMap((workflow) => workflow.nodes)
			.filter((node) => node.type === 'agent');
		const retrieval = agents.filter((node) => ['generate', 'review'].includes(node.id));
		expect(retrieval).toHaveLength(2);
		expect(retrieval.every((node) => JSON.stringify(node.config.tools) === '["web.run"]')).toBe(
			true,
		);
		expect(
			agents
				.filter((node) => !retrieval.includes(node))
				.every((node) => JSON.stringify(node.config.tools) === '[]'),
		).toBe(true);
		await expect(call('catalog', { availableTools: scope.availableTools }, scope)).rejects.toThrow(
			/Invalid/,
		);
	});
	it('pages available tool discovery independently of node discovery with bounded descriptions', async () => {
		const { call } = await fixture();
		const scope = {
			...context(),
			availableTools: Array.from({ length: 73 }, (_, index) => ({
				name: `tool_${index}`,
				description: 'd'.repeat(1500),
			})),
		};
		const first = await call('catalog', { nodeType: 'entry', limit: 1 }, scope);
		expect(first.items).toHaveLength(1);
		expect(first.availableTools.items).toHaveLength(20);
		expect(first.availableTools).toMatchObject({ total: 73, nextOffset: 20 });
		expect(
			first.availableTools.items.every(
				(tool: { description: string }) => tool.description.length === 500,
			),
		).toBe(true);
		const next = await call('catalog', { nodeType: 'entry', toolOffset: 20, toolLimit: 50 }, scope);
		expect(next.items).toEqual(first.items);
		expect(next.availableTools.items[0].name).toBe('tool_20');
		expect(next.availableTools).toMatchObject({ total: 73, nextOffset: 70 });
		const end = await call('catalog', { toolOffset: 70 }, scope);
		expect(end.availableTools.items).toHaveLength(3);
		expect(end.availableTools.nextOffset).toBeNull();
		await expect(call('catalog', { toolLimit: 51 }, scope)).rejects.toThrow(/Invalid/);
		await expect(call('catalog', { toolOffset: -1 }, scope)).rejects.toThrow(/Invalid/);
	});
	it('caps a stronger saved workflow permission at the calling Code permission', async () => {
		const { engine, call } = await fixture();
		const definition = graph();
		definition.nodes[0].config.permissionMode = 'full-access';
		await engine.saveWorkflow({
			...definition,
			id: 'powerful',
			version: 1,
			enabled: false,
			createdAt: 1,
			updatedAt: 1,
			settings: { permissionMode: 'full-access' },
		});
		const binding = await call('create', {
			idempotencyKey: 'powerful',
			libraryWorkflowId: 'powerful',
		});
		const run = await call('run', {
			bindingId: binding.bindingId,
			idempotencyKey: 'safe-run',
			prompt: 'Question',
		});
		const snapshot = engine.getRun(run.runId)!.workflowSnapshot;
		expect(snapshot.settings?.permissionMode).toBe('ask');
		expect(snapshot.nodes.every((node) => node.config.permissionMode === 'ask')).toBe(true);
	});
	it('validates supplied child packages and bounds output excerpts', async () => {
		const { call } = await fixture();
		const root = graph();
		root.nodes[1].type = 'subworkflow';
		root.nodes[1].config = { workflowId: 'child' };
		const dependencies = [{ id: 'child', graph: graph() }];
		expect(await call('validate', { graph: root, dependencies })).toMatchObject({ valid: true });
		const binding = await call('create', {
			idempotencyKey: 'child-package',
			graph: root,
			dependencies,
		});
		const first = await call('inspect', { bindingId: binding.bindingId, characterLimit: 30 });
		expect(first.content.text).toHaveLength(30);
		expect(first.content.nextCharacterOffset).toBe(30);
		const second = await call('inspect', {
			bindingId: binding.bindingId,
			characterLimit: 30,
			characterOffset: 30,
		});
		expect(second.content.characterOffset).toBe(30);
	});
	it('allows project-scoped Thread nodes without accepting a project override', async () => {
		const { call, engine } = await fixture();
		const definition = graph();
		definition.nodes[1].type = 'thread';
		definition.nodes[1].config = { action: 'create', prompt: 'Research the request' };
		const created = await call('create', { idempotencyKey: 'thread-workflow', graph: definition });
		expect(engine.getBinding(created.bindingId)?.workflowSnapshot.nodes[1].type).toBe('thread');
		definition.nodes[1].config.projectId = 'biology';
		await expect(call('validate', { graph: definition })).rejects.toThrow('host-owned');
	});
	it('keeps Plan reads available while rejecting create/update/run/cancel', () => {
		for (const name of ['list', 'catalog', 'inspect', 'library_inspect', 'validate', 'read_run'])
			expect(codePlanToolDenial(`workflows.${name}`, {})).toBeUndefined();
		for (const name of ['create', 'update', 'library_save', 'run', 'cancel'])
			expect(codePlanToolDenial(`workflows.${name}`, {})).toContain('Plan mode blocked');
	});
});

describe('Code host workflow boundary', () => {
	async function hostFixture(kind: 'chat' | 'code' = 'code', projectId?: string, remote = false) {
		const state = initialState();
		state.toolSettings = {
			...defaultToolSettings(),
			enabled: true,
			skillDirectories: [],
			commandExecution: false,
			allowRemote: remote,
		};
		state.projects = [
			{ id: 'novis', name: 'Novis', kind: 'code', directories: [], instructions: '', createdAt: 1 },
		];
		state.threads = [
			{
				id: 'thread',
				title: 'Task',
				kind,
				projectId,
				model: 'qwen',
				connectionId: 'local-models',
				thinkingMode: 'medium',
				messages: [],
				createdAt: 1,
				updatedAt: 1,
			},
		];
		const approve = vi.fn(async () => true);
		const service = {
			execute: vi.fn(
				async (_name: string, _args: Record<string, unknown>, _context: WorkflowToolContext) => ({
					content: [{ type: 'text' as const, text: '{}' }],
				}),
			),
		};
		const host = new AgentHost(async () => structuredClone(state), approve);
		host.setWorkflowTools(service);
		cleanups.push(() => host.close());
		const catalog = await host.catalog('run', 'thread', remote);
		const execute = (name: string, args = {}) =>
			host.execute({
				workspaceId: 'local',
				runId: 'run',
				threadId: 'thread',
				name,
				arguments: args,
			});
		return { state, approve, service, host, catalog, execute };
	}
	it.each([
		['chat', undefined],
		['code', undefined],
	] as const)('does not advertise project tools to %s without a project', async (kind, project) => {
		const { catalog } = await hostFixture(kind, project);
		expect(catalog.tools.some((tool) => tool.name.startsWith('workflows.'))).toBe(false);
	});
	it.each(['workflows.run', 'workflows.library_save'])('derives scope/model from saved Code state and approves %s but not reads', async (name) => {
		const { execute, service, approve, catalog } = await hostFixture('code', 'novis');
		expect(catalog.tools.some((tool) => tool.name === 'workflows.run')).toBe(true);
		await execute('workflows.list');
		await execute('workflows.library_inspect');
		expect(approve).not.toHaveBeenCalled();
		await execute(name);
		expect(approve).toHaveBeenCalledOnce();
		expect(service.execute.mock.calls.at(-1)?.[2]).toMatchObject({
			projectId: 'novis',
			threadId: 'thread',
			model: 'qwen',
			connectionId: 'local-models',
			thinkingMode: 'medium',
			permissionMode: 'ask',
		});
	});
	it('enforces live Plan mode even after discovery', async () => {
		const { state, execute, service } = await hostFixture('code', 'novis');
		state.threads[0].messages.push({
			id: 'plan',
			role: 'user',
			content: 'Plan this',
			composer: { mode: 'plan' },
			createdAt: 2,
		});
		expect((await execute('workflows.create')).isError).toBe(true);
		expect((await execute('workflows.library_save')).isError).toBe(true);
		expect(service.execute).not.toHaveBeenCalled();
		await execute('workflows.list');
		expect(service.execute).toHaveBeenCalledOnce();
	});
	it.each(['workflows.run', 'workflows.library_save'])('does not execute a denied %s mutation', async (name) => {
		const { execute, service, approve } = await hostFixture('code', 'novis');
		approve.mockResolvedValue(false);
		const denied = await execute(name);
		expect(denied.isError).toBe(true);
		expect(denied.approvalDenied).toBeDefined();
		expect(service.execute).not.toHaveBeenCalled();
	});
	it('excludes shared library tools from remote Code sessions', async () => {
		const { catalog, execute, service } = await hostFixture('code', 'novis', true);
		expect(catalog.tools.some(tool => tool.name.startsWith('workflows.'))).toBe(false);
		await expect(execute('workflows.library_save')).rejects.toThrow();
		expect(service.execute).not.toHaveBeenCalled();
	});
	it('uses a newly changed permission mode and rejects a moved project scope', async () => {
		const { state, execute, service, approve } = await hostFixture('code', 'novis');
		state.threads[0].permissionMode = 'full-access';
		await execute('workflows.run');
		expect(approve).not.toHaveBeenCalled();
		expect(service.execute.mock.calls.at(-1)?.[2].permissionMode).toBe('full-access');
		state.threads[0].permissionMode = 'ask';
		await execute('workflows.run');
		expect(approve).toHaveBeenCalledOnce();
		expect(service.execute.mock.calls.at(-1)?.[2].permissionMode).toBe('ask');
		state.threads[0].projectId = 'biology';
		state.projects.push({
			id: 'biology',
			name: 'Biology',
			kind: 'code',
			directories: [],
			instructions: '',
			createdAt: 1,
		});
		await expect(execute('workflows.list')).rejects.toThrow(/changed|scope|project/i);
		expect(service.execute).toHaveBeenCalledTimes(2);
	});
});
