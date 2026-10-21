import { createHash } from 'node:crypto';
import Ajv from 'ajv';
import type { ToolResult } from '../../src/agent-types';
import type {
	WorkflowDefinition,
	WorkflowProjectBinding,
	WorkflowRun,
} from '../../src/workflow-types';
import { WORKFLOW_CATALOG } from '../../src/lib/workflow-catalog';
import { createResearchWorkflows } from '../../src/lib/workflow-research';
import {
	workflowTools,
	type WorkflowToolContext,
	type WorkflowToolProvider,
} from '../../src/lib/workflow-tools';
import { textResult } from '../../src/lib/interaction-tools';
import { WorkflowEngine, validateWorkflow } from './engine';

type Data = Record<string, unknown>;
const ajv = new Ajv({ allErrors: false, strict: false });
const validators = new Map(workflowTools.map((tool) => [tool.name, ajv.compile(tool.parameters)]));
const hash = (value: unknown) =>
	createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 40);
const childTypes = new Set(['subworkflow', 'loop', 'foreach', 'repeat']);
const authority = new Set([
	'projectId',
	'workspaceId',
	'workspaceRoot',
	'workspaceRoots',
	'permissionMode',
	'approvalMode',
	'sourceThreadId',
	'bindingId',
]);

function summary(binding: WorkflowProjectBinding) {
	return {
		bindingId: binding.id,
		workflowId: binding.workflowId,
		projectId: binding.projectId,
		name: binding.name || binding.workflowSnapshot.name,
		description: binding.workflowSnapshot.description?.slice(0, 1000),
		revision: binding.revision,
		hasRequest: !!binding.workflowSnapshot.request,
		createdAt: binding.createdAt,
		updatedAt: binding.updatedAt,
	};
}
function runSummary(run: WorkflowRun) {
	return {
		runId: run.id,
		bindingId: run.bindingId,
		projectId: run.projectId,
		workflowName: run.workflowName,
		status: run.status,
		createdAt: run.createdAt,
		startedAt: run.startedAt,
		finishedAt: run.finishedAt,
		completedNodes: Object.values(run.nodes).filter((node) => node.status === 'completed').length,
		totalNodes: Object.keys(run.nodes).length,
		error: run.error?.slice(0, 2000),
	};
}
function page<T>(items: T[], args: Data) {
	const offset = Number(args.offset ?? 0),
		limit = Number(args.limit ?? 25);
	return {
		items: items.slice(offset, offset + limit),
		nextOffset: offset + limit < items.length ? offset + limit : null,
		total: items.length,
	};
}
function excerpt(value: unknown, args: Data) {
	const serialized = JSON.stringify(value, null, 2) ?? 'null';
	const offset = Number(args.characterOffset ?? 0),
		limit = Number(args.characterLimit ?? 16000);
	return {
		text: serialized.slice(offset, offset + limit),
		characterOffset: offset,
		nextCharacterOffset: offset + limit < serialized.length ? offset + limit : null,
		totalCharacters: serialized.length,
	};
}
function authoredGraph(input: Data, id: string): WorkflowDefinition {
	const now = Date.now();
	const graph = {
		...structuredClone(input),
		id,
		version: 1,
		enabled: false,
		createdAt: now,
		updatedAt: now,
	} as unknown as WorkflowDefinition;
	validateWorkflow(graph);
	for (const node of graph.nodes) {
		for (const key of Object.keys(node.config))
			if (authority.has(key)) throw new Error(`Node ${node.id} cannot override host-owned ${key}.`);
	}
	return graph;
}
function dependencyGraphs(value: unknown): WorkflowDefinition[] {
	return ((value ?? []) as { id: string; graph: Data }[]).map((item) =>
		authoredGraph(item.graph, item.id),
	);
}
function validatePackage(root: WorkflowDefinition, dependencies: WorkflowDefinition[]) {
	const all = new Map<string, WorkflowDefinition>();
	for (const graph of [root, ...dependencies]) {
		validateWorkflow(graph);
		if (all.has(graph.id)) throw new Error('Workflow dependency IDs must be unique.');
		all.set(graph.id, graph);
	}
	const visiting = new Set<string>(),
		visited = new Set<string>();
	const visit = (graph: WorkflowDefinition, depth = 0) => {
		if (depth > 12 || visiting.has(graph.id))
			throw new Error('Recursive or excessively nested workflow dependencies are not allowed.');
		if (visited.has(graph.id)) return;
		visiting.add(graph.id);
		for (const node of graph.nodes.filter((node) => childTypes.has(node.type))) {
			const child = all.get(String(node.config.workflowId));
			if (!child) throw new Error(`Supply the child workflow for ${node.label} in dependencies.`);
			visit(child, depth + 1);
		}
		visiting.delete(graph.id);
		visited.add(graph.id);
	};
	for (const graph of all.values()) visit(graph);
}

/** Project authority is injected by AgentHost. This service never accepts model-supplied scope. */
export class WorkflowToolService implements WorkflowToolProvider {
	private mutationSerial: Promise<unknown> = Promise.resolve();
	constructor(private readonly engine: WorkflowEngine) {}
	private binding(id: string, context: WorkflowToolContext): WorkflowProjectBinding {
		const binding = this.engine.getBinding(id);
		if (!binding || binding.projectId !== context.projectId)
			throw new Error('Workflow not found in this project.');
		return binding;
	}
	private run(id: string, context: WorkflowToolContext): WorkflowRun {
		const run = this.engine.getRun(id);
		if (!run || run.projectId !== context.projectId)
			throw new Error('Workflow run not found in this project.');
		return run;
	}
	async execute(name: string, args: Data, context: WorkflowToolContext): Promise<ToolResult> {
		context.signal.throwIfAborted();
		if (!context.projectId || !context.threadId)
			throw new Error('Workflow tools require a Code project.');
		const validator = validators.get(name);
		if (!validator || !validator(args))
			throw new Error(
				`Invalid ${name} arguments: ${validator ? ajv.errorsText(validator.errors) : 'unknown tool'}.`,
			);
		if (JSON.stringify(args).length > 1_000_000)
			throw new Error('Workflow arguments exceed the 1 MB limit.');
		if (name === 'workflows.list') {
			if (args.library)
				return textResult(
					page(
						this.engine.listWorkflows().map((workflow) => ({
							workflowId: workflow.id,
							name: workflow.name,
							description: workflow.description?.slice(0, 1000),
							hasRequest: !!workflow.request,
						})),
						args,
					),
				);
			return textResult(page(this.engine.listBindings(context.projectId).map(summary), args));
		}
		if (name === 'workflows.catalog')
			return textResult({
				templates: ['blank', 'research-team', 'co-scientist'],
				availableTools: page(
					(context.availableTools ?? []).slice(0, 500).map((tool) => ({
						name: tool.name.slice(0, 200),
						description: tool.description.slice(0, 500),
					})),
					{ offset: args.toolOffset ?? 0, limit: args.toolLimit ?? 20 },
				),
				requestExample: {
					prompt: { key: 'question', label: 'What would you like to investigate?', required: true },
					fields: [{ key: 'constraints', label: 'Constraints', type: 'text', required: false }],
				},
				...page(
					WORKFLOW_CATALOG.filter((node) => !args.nodeType || node.type === args.nodeType).map(
						({ type, title, description, inputs, outputs, defaults, fields }) => ({
							type,
							title,
							description,
							inputs,
							outputs,
							defaults,
							fields,
						}),
					),
					args,
				),
				notes:
					'Graphs contain name, nodes, edges and optional request. Every node has id, type, label, position:{x,y}, config. Edges have id, source, target and optional sourceHandle/targetHandle. Templates use {{input}}, {{inputs.field}} and {{run.inputs.field}}. Child graphs belong in dependencies:[{id,graph}]. Project, workspace and permissions are host-owned. Automatic triggers remain disabled for agent-created workflows. Thread and context nodes can access only threads in the installed project.',
			});
		if (name === 'workflows.inspect') {
			const binding = this.binding(String(args.bindingId), context);
			const value =
				args.section === 'runs'
					? this.engine
							.listRuns()
							.filter(
								(run) =>
									run.bindingId === binding.id &&
									run.projectId === context.projectId &&
									!run.parentRunId,
							)
							.map(runSummary)
					: args.section === 'dependencies'
						? binding.dependencySnapshots
						: binding.workflowSnapshot;
			return textResult({ ...summary(binding), content: excerpt(value, args) });
		}
		if (name === 'workflows.validate') {
			const graph = authoredGraph(args.graph as Data, 'validation');
			validatePackage(graph, dependencyGraphs(args.dependencies));
			return textResult({ valid: true, nodes: graph.nodes.length, edges: graph.edges.length });
		}
		if (name === 'workflows.read_run') {
			const run = this.run(String(args.runId), context);
			if (args.nodeId && !run.nodes[String(args.nodeId)])
				throw new Error('Workflow node not found.');
			const value = args.nodeId
				? run.nodes[String(args.nodeId)]
				: {
						inputs: run.inputs,
						outputs: run.outputs,
						error: run.error,
						nodes: Object.values(run.nodes).map(({ nodeId, status, error, childRunIds }) => ({
							nodeId,
							status,
							error,
							childRunIds,
						})),
					};
			return textResult({ ...runSummary(run), content: excerpt(value, args) });
		}
		// Serialize mutations so a retried create cannot race its durable binding commit.
		const result = this.mutationSerial.catch(() => {}).then(() => this.mutate(name, args, context));
		this.mutationSerial = result;
		return result;
	}
	private async mutate(
		name: string,
		args: Data,
		context: WorkflowToolContext,
	): Promise<ToolResult> {
		context.signal.throwIfAborted();
		if (name === 'workflows.create') {
			if (
				[args.graph, args.template, args.libraryWorkflowId].filter((value) => value !== undefined)
					.length !== 1
			)
				throw new Error('Provide exactly one of graph, template, or libraryWorkflowId.');
			if (args.dependencies && !args.graph)
				throw new Error('Dependencies are only accepted with an authored graph.');
			const bindingId = `code-${hash([context.projectId, context.threadId, args.idempotencyKey])}`;
			const graphId = `code-${hash([context.projectId, context.threadId, args])}`;
			const existing = this.engine.getBinding(bindingId);
			if (existing) {
				this.binding(bindingId, context);
				if (
					existing.workflowId !== (args.libraryWorkflowId || graphId) ||
					(args.name && existing.name !== args.name)
				)
					throw new Error('This idempotencyKey was already used for a different workflow.');
				return textResult({ ...summary(existing), created: false });
			}
			let graph: WorkflowDefinition | undefined, dependencies: WorkflowDefinition[] | undefined;
			if (args.graph) {
				graph = authoredGraph(args.graph as Data, graphId);
				dependencies = dependencyGraphs(args.dependencies);
			} else if (args.template === 'blank') {
				graph = authoredGraph(
					{
						name: args.name || 'New workflow',
						request: { prompt: { key: 'prompt', label: 'Request', required: true } },
						nodes: [
							{
								id: 'request',
								type: 'entry',
								label: 'Request',
								position: { x: 0, y: 0 },
								config: {},
							},
							{
								id: 'result',
								type: 'output',
								label: 'Result',
								position: { x: 320, y: 0 },
								config: { name: 'result' },
							},
						],
						edges: [
							{
								id: 'request-result',
								source: 'request',
								target: 'result',
								sourceHandle: 'value',
								targetHandle: 'input',
							},
						],
					},
					graphId,
				);
				dependencies = [];
			} else if (args.template) {
				const generated = createResearchWorkflows([], {
					kind: args.template as 'research-team' | 'co-scientist',
					model: context.model,
					thinkingMode: context.thinkingMode,
					tools: context.availableTools?.some((tool) => tool.name === 'web.run') ? ['web.run'] : [],
				});
				const ids = new Map(
					generated.workflows.map((workflow, index) => [
						workflow.id,
						workflow.id === generated.primaryId ? graphId : `${graphId}-${index}`,
					]),
				);
				for (const workflow of generated.workflows) {
					workflow.id = ids.get(workflow.id)!;
					for (const node of workflow.nodes) {
						if (childTypes.has(node.type))
							node.config.workflowId = ids.get(String(node.config.workflowId));
						if (node.type === 'agent' || node.type === 'text')
							node.config.connectionId = context.connectionId;
					}
				}
				graph = generated.workflows.find((workflow) => workflow.id === graphId)!;
				dependencies = generated.workflows.filter((workflow) => workflow.id !== graphId);
			}
			if (graph) validatePackage(graph, dependencies ?? []);
			const binding = await this.engine.attachWorkflow({
				workflowId: String(args.libraryWorkflowId ?? graphId),
				projectId: context.projectId,
				bindingId,
				...(args.name ? { name: String(args.name) } : {}),
				...(graph ? { workflow: graph, dependencies } : {}),
				settings: {
					connectionId: context.connectionId,
					model: context.model,
					thinkingMode: context.thinkingMode,
					permissionMode: context.permissionMode,
				},
			});
			return textResult({ ...summary(binding), created: true });
		}
		if (name === 'workflows.update') {
			const binding = this.binding(String(args.bindingId), context);
			const graph = authoredGraph(args.graph as Data, binding.workflowId);
			const dependencies =
				args.dependencies === undefined
					? Object.values(binding.dependencySnapshots)
					: dependencyGraphs(args.dependencies);
			validatePackage(graph, dependencies);
			return textResult(
				summary(
					await this.engine.updateBinding(binding.id, {
						workflow: graph,
						name: graph.name,
						dependencies,
						expectedRevision: Number(args.expectedRevision),
					}),
				),
			);
		}
		if (name === 'workflows.run') {
			const binding = this.binding(String(args.bindingId), context);
			const inputs = {
				...((args.inputs as Data) ?? {}),
				...(args.prompt ? { prompt: args.prompt } : {}),
			};
			const requestId = `code-${hash([context.threadId, args.idempotencyKey])}`;
			const existing = this.engine
				.listRuns()
				.find(
					(run) =>
						run.bindingId === binding.id &&
						run.sourceThreadId === context.threadId &&
						run.requestId === requestId,
				);
			if (existing) {
				// Engine-normalized aliases/defaults differ from the raw input; use the caller
				// payload captured as trigger data when comparing an idempotent retry.
				if (JSON.stringify(existing.trigger.payload) !== JSON.stringify(inputs))
					throw new Error('This idempotencyKey was already used for a different run request.');
				return textResult({ ...runSummary(existing), accepted: true, alreadyStarted: true });
			}
			const run = await this.engine.startRun(binding.workflowId, {
				bindingId: binding.id,
				inputs,
				sourceThreadId: context.threadId,
				requestId,
				permissionMode: context.permissionMode,
				trigger: { kind: 'manual', payload: inputs },
			});
			return textResult({
				...runSummary(run),
				accepted: true,
				notice:
					'Admitted asynchronously. Completion will be delivered to this Code thread; use read_run for results.',
			});
		}
		if (name === 'workflows.cancel') {
			const run = this.run(String(args.runId), context);
			await this.engine.cancelRun(run.id);
			return textResult(runSummary(this.engine.getRun(run.id)!));
		}
		throw new Error('Unknown workflow tool.');
	}
}
