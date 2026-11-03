import { validateNodeManifest } from '../custom-nodes/manifest';
import { createHash, randomUUID } from 'node:crypto';
import type { CodePermissionMode } from '../../src/agent-types';
import { normalizeWorkflowInputs, validateWorkflowRequest } from '../../src/lib/workflow-inputs';
import { watch, type FSWatcher } from 'node:fs';
import type {
	WorkflowCollectionRequest,
	WorkflowCommand,
	WorkflowAttachOptions,
	WorkflowBindingPatch,
	WorkflowBindingSettings,
	WorkflowBindingSummary,
	WorkflowProjectBinding,
	WorkflowProjectContext,
	WorkflowDefinition,
	WorkflowEdge,
	WorkflowNode,
	WorkflowNodeExecutor,
	WorkflowNodeRun,
	WorkflowRun,
	WorkflowSnapshot,
	WorkflowTrigger,
} from '../../src/workflow-types';
import { WorkflowStore } from './store';
import { definitionHash, type DefinitionBase } from './definition-version';
import { WorkflowScheduler, scheduleConfig, validateSchedule } from './scheduler';

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'skipped', 'interrupted']);
const TRIGGERS = new Set(['entry', 'schedule', 'event']);
const AUTHORITY_FIELDS = [
	'permissionMode',
	'tools',
	'allowedTools',
	'skills',
	'connectionId',
	'model',
	'projectId',
	'workspaceRoot',
];
function authorityFields(node: WorkflowNode): string[] {
	return node.type === 'tool'
		? [...AUTHORITY_FIELDS, 'tool', 'toolName', 'name']
		: ['loop', 'subworkflow', 'foreach', 'repeat'].includes(node.type)
			? [...AUTHORITY_FIELDS, 'workflowId']
			: node.type === 'collection'
				? [...AUTHORITY_FIELDS, 'scope', 'name']
				: AUTHORITY_FIELDS;
}
const NODE_TYPES = new Set([
 'custom',
	'entry',
	'schedule',
	'event',
	'text',
	'agent',
	'image',
	'video',
	'audio',
	'transcribe',
	'tool',
	'code',
	'thread',
	'condition',
	'foreach',
	'join',
	'repeat',
	'loop',
	'wait',
	'subworkflow',
	'value',
	'context',
	'transform',
	'media-transform',
	'state',
	'collection',
	'output',
	'save',
	'notify',
]);
class WorkflowPersistenceError extends Error {}
const message = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);
const object = (value: unknown): Record<string, unknown> =>
	value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
const own = (value: unknown, key: string): unknown =>
	value !== null && typeof value === 'object' && Object.hasOwn(value, key)
		? (value as Record<string, unknown>)[key]
		: undefined;
const firstDefined = (...values: unknown[]): unknown => values.find((value) => value !== undefined);
const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null &&
	typeof value === 'object' &&
	!Array.isArray(value) &&
	(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const validId = (value: unknown): value is string =>
	typeof value === 'string' &&
	/^[a-zA-Z0-9_-]{1,160}$/.test(value) &&
	!['__proto__', 'constructor', 'prototype'].includes(value);
/** Bound JSON before cloning, persisting, or sending it to an execution adapter. */
function validateJson(value: unknown, maximum = 8 * 1024 * 1024): void {
	let bytes = 0,
		items = 0;
	const stack = new Set<object>();
	function visit(current: unknown, depth: number): void {
		if (depth > 32 || ++items > 100_000)
			throw new Error('Workflow data is nested too deeply or contains too many values.');
		if (typeof current === 'string') bytes += Buffer.byteLength(current, 'utf8');
		else if (typeof current === 'number') {
			if (!Number.isFinite(current)) throw new Error('Workflow numbers must be finite.');
			bytes += 16;
		} else if (current === undefined || current === null || typeof current === 'boolean')
			bytes += 8;
		else if (typeof current === 'object') {
			if ((!Array.isArray(current) && !isRecord(current)) || stack.has(current))
				throw new Error('Workflow data must contain plain, non-circular JSON values.');
			stack.add(current);
			for (const [key, child] of Object.entries(current)) {
				if (['__proto__', 'constructor', 'prototype'].includes(key))
					throw new Error('Workflow data contains an unsafe property name.');
				bytes += Buffer.byteLength(key, 'utf8') + 4;
				visit(child, depth + 1);
			}
			stack.delete(current);
		} else throw new Error('Workflow data must contain JSON values.');
		if (bytes > maximum)
			throw new Error(`Workflow data exceeds the ${Math.round(maximum / 1024 / 1024)} MB limit.`);
	}
	visit(value, 0);
}
export function validateWorkflowCommand(input: unknown): asserts input is WorkflowCommand {
	if (!isRecord(input) || typeof input.type !== 'string')
		throw new Error('Invalid workflow command.');
	validateJson(input);
	const id = (value: unknown) => {
		if (!validId(value)) throw new Error('Invalid workflow identifier.');
	};
	switch (input.type) {
		case 'refresh-definitions': break;
 case 'discover-custom-node':
 case 'authorize-custom-node':
 case 'set-custom-node-secret':
 if(typeof input.packageId!=='string'||typeof input.version!=='string'||typeof input.digest!=='string')throw new Error('Invalid custom node identity.');break;
 case 'install-custom-node':
 if(typeof input.source!=='string'||input.source.length>1024*1024)throw new Error('Invalid node package.');break;
 case 'remove-custom-node':
 if(typeof input.packageId!=='string'||typeof input.version!=='string')throw new Error('Invalid node identity.');break;
		case 'save':
			if (input.expectedRevision !== undefined && (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0)) throw new Error('Invalid expected definition revision.');
			if (input.expectedContentHash !== undefined && (typeof input.expectedContentHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedContentHash))) throw new Error('Invalid expected definition content hash.');
			if (!isRecord(input.workflow)) throw new Error('Invalid workflow definition.');
			validateWorkflow(input.workflow as unknown as WorkflowDefinition);
			break;
		case 'delete':
			id(input.id);
			break;
		case 'attach':
			id(input.workflowId);
			id(input.projectId);
			if (input.bindingId !== undefined) id(input.bindingId);
			validateBindingPatch(input);
			break;
		case 'update-binding':
			id(input.bindingId);
			validateBindingPatch(input);
			break;
		case 'detach':
			id(input.bindingId);
			break;
		case 'run':
			id(input.id);
			if (input.bindingId !== undefined) id(input.bindingId);
			if (input.sourceThreadId !== undefined) id(input.sourceThreadId);
			if (
				input.requestId !== undefined &&
				(typeof input.requestId !== 'string' || !input.requestId || input.requestId.length > 200)
			)
				throw new Error('Invalid workflow request ID.');
			if (input.entryNodeId !== undefined) id(input.entryNodeId);
			if (input.inputs !== undefined) {
				if (!isRecord(input.inputs)) throw new Error('Workflow inputs must be a JSON object.');
				validateJson(input.inputs, 1024 * 1024);
			}
			break;
		case 'cancel':
		case 'retry':
			id(input.runId);
			break;
		case 'resume':
			id(input.runId);
			if (input.nodeId !== undefined) id(input.nodeId);
			validateJson(input.value, 1024 * 1024);
			break;
		case 'emit':
			if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200)
				throw new Error('Workflow events require a name of at most 200 characters.');
			if (input.payload !== undefined) {
				if (!isRecord(input.payload)) throw new Error('Workflow event payload must be an object.');
				validateJson(input.payload, 1024 * 1024);
			}
			break;
		case 'catalog':
			if (input.workflowId !== undefined) id(input.workflowId);
			if (input.bindingId !== undefined) id(input.bindingId);
			if (input.projectId !== undefined) id(input.projectId);
			break;
		default:
			throw new Error('Unknown workflow command.');
	}
}
function validateBindingPatch(input: Record<string, unknown>): void {
	if (input.name !== undefined && (typeof input.name !== 'string' || input.name.length > 200))
		throw new Error('Project workflow names are limited to 200 characters.');
	if (input.settings !== undefined) {
		if (!isRecord(input.settings)) throw new Error('Invalid project workflow settings.');
		for (const [key, value] of Object.entries(input.settings)) {
			if (
				!['connectionId', 'model', 'thinkingMode', 'permissionMode'].includes(key) ||
				(value !== undefined &&
					(typeof value !== 'string' || value.length > 500 || value.includes('{{')))
			)
				throw new Error('Invalid project workflow setting.');
		}
		if (
			input.settings.permissionMode !== undefined &&
			!['ask', 'auto-review', 'full-access'].includes(String(input.settings.permissionMode))
		)
			throw new Error('Invalid project workflow permission mode.');
	}
	if (input.defaultInputs !== undefined) {
		if (!isRecord(input.defaultInputs)) throw new Error('Default inputs must be an object.');
		validateJson(input.defaultInputs, 1024 * 1024);
	}
	if (
		input.expectedRevision !== undefined &&
		(!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 1)
	)
		throw new Error('Invalid project workflow revision.');
	if (input.workflow !== undefined) validateWorkflow(input.workflow as WorkflowDefinition);
	if (input.dependencies !== undefined) {
		if (!Array.isArray(input.dependencies) || input.dependencies.length > 100)
			throw new Error('A workflow supports up to 100 pinned dependencies.');
		for (const definition of input.dependencies) validateWorkflow(definition);
	}
}
function permissionCeiling(
	saved: CodePermissionMode | undefined,
	ceiling: CodePermissionMode | undefined,
): CodePermissionMode | undefined {
	if (!ceiling) return saved;
	const rank = { ask: 0, 'auto-review': 1, 'full-access': 2 };
	return rank[saved ?? 'ask'] <= rank[ceiling] ? (saved ?? 'ask') : ceiling;
}
const persistentScope = (run: WorkflowRun): string =>
	run.bindingId
		? `binding-${createHash('sha256').update(`${run.bindingId}:${run.workflowId}`).digest('hex')}`
		: run.workflowId;
export function workflowPath(value: unknown, path: string): unknown {
	return path
		.split('.')
		.filter(Boolean)
		.reduce(
			(item, key) =>
				['__proto__', 'constructor', 'prototype'].includes(key) ? undefined : own(item, key),
			value,
		);
}
function interpolate(value: unknown, scope: Record<string, unknown>, depth = 0): unknown {
	if (depth > 30) throw new Error('Workflow configuration is nested too deeply.');
	if (typeof value === 'string') {
		const exact = value.match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
		if (exact) return workflowPath(scope, exact[1].trim());
		return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, key: string) => {
			const result = workflowPath(scope, key.trim());
			return typeof result === 'string'
				? result
				: result === undefined
					? ''
					: JSON.stringify(result);
		});
	}
	if (Array.isArray(value)) return value.map((item) => interpolate(item, scope, depth + 1));
	if (value && typeof value === 'object')
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, interpolate(item, scope, depth + 1)]),
		);
	return value;
}

function conditionMatches(value: unknown, operator: string, compare: unknown): boolean {
	switch (operator) {
		case 'equals':
			return JSON.stringify(value) === JSON.stringify(compare);
		case 'not-equals':
			return JSON.stringify(value) !== JSON.stringify(compare);
		case 'contains':
			return Array.isArray(value)
				? value.some((item) => JSON.stringify(item) === JSON.stringify(compare))
				: String(value ?? '').includes(String(compare ?? ''));
		case 'greater-than':
			return Number(value) > Number(compare);
		case 'less-than':
			return Number(value) < Number(compare);
		case 'empty':
			return value == null || value === '' || (Array.isArray(value) && value.length === 0);
		case 'truthy':
			return !!value;
		case 'never':
			return false;
		default:
			throw new Error('Unknown condition operator.');
	}
}

export function validateWorkflow(workflow: WorkflowDefinition): void {
	validateJson(workflow);
	validateWorkflowRequest(workflow?.request);
	if (
		!workflow ||
		workflow.version !== 1 ||
		typeof workflow.id !== 'string' ||
		!/^[a-zA-Z0-9_-]{1,160}$/.test(workflow.id) ||
		['__proto__', 'constructor', 'prototype'].includes(workflow.id) ||
		typeof workflow.name !== 'string' ||
		!workflow.name.trim() ||
		workflow.name.length > 200
	)
		throw new Error('Workflow requires an identifier and a name of at most 200 characters.');
	if (typeof workflow.enabled !== 'boolean')
		throw new Error('Workflow enabled state must be a boolean.');
	if (
		![workflow.createdAt, workflow.updatedAt].every(
			(value) => typeof value === 'number' && Number.isFinite(value) && value >= 0,
		)
	)
		throw new Error('Workflow timestamps must be finite nonnegative numbers.');
	if (
		workflow.revision !== undefined &&
		(!Number.isSafeInteger(workflow.revision) || workflow.revision < 0)
	)
		throw new Error('Invalid workflow revision.');
	if (
		workflow.description !== undefined &&
		(typeof workflow.description !== 'string' || workflow.description.length > 10_000)
	)
		throw new Error('Workflow descriptions are limited to 10000 characters.');
	if (
		workflow.viewport &&
		(!isRecord(workflow.viewport) ||
			![workflow.viewport.x, workflow.viewport.y, workflow.viewport.zoom].every(
				(value) => typeof value === 'number' && Number.isFinite(value),
			) ||
			workflow.viewport.zoom < 0.05 ||
			workflow.viewport.zoom > 8)
	)
		throw new Error('Invalid workflow viewport.');
	if (workflow.settings !== undefined) {
		const settings = workflow.settings;
		if (
			!isRecord(settings) ||
			(settings.workspaceRoot !== undefined &&
				(typeof settings.workspaceRoot !== 'string' || settings.workspaceRoot.length > 4096)) ||
			(settings.permissionMode !== undefined &&
				!['ask', 'auto-review', 'full-access'].includes(settings.permissionMode)) ||
			(settings.concurrency !== undefined &&
				(!Number.isInteger(settings.concurrency) ||
					settings.concurrency < 1 ||
					settings.concurrency > 16))
		)
			throw new Error('Invalid workflow execution settings.');
	}
	if (
		!Array.isArray(workflow.nodes) ||
		workflow.nodes.length > 500 ||
		!Array.isArray(workflow.edges) ||
		workflow.edges.length > 2000
	)
		throw new Error('A workflow supports up to 500 nodes and 2000 connections.');
	const ids = new Set<string>(),
		edges = new Set<string>(),
		incoming = new Map<string, number>(),
		outgoing = new Map<string, string[]>();
	for (const node of workflow.nodes) {
		if (
			!node ||
			typeof node.id !== 'string' ||
			!/^[a-zA-Z0-9_-]{1,160}$/.test(node.id) ||
			ids.has(node.id) ||
			['__proto__', 'constructor', 'prototype'].includes(node.id)
		)
			throw new Error('Workflow node identifiers must be unique.');
		if (
			!NODE_TYPES.has(node.type) ||
			!node.config ||
			typeof node.config !== 'object' ||
			Array.isArray(node.config)
		)
			throw new Error(`Invalid workflow node: ${node.label || node.id}.`);
		if (
			typeof node.label !== 'string' ||
			node.label.length > 200 ||
			!isRecord(node.position) ||
			![node.position.x, node.position.y].every(
				(value) =>
					typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 10_000_000,
			)
		)
			throw new Error('Workflow nodes require a label and finite canvas coordinates.');
		ids.add(node.id);
		incoming.set(node.id, 0);
		outgoing.set(node.id, []);
		if(node.type==='custom'){ if(!node.custom||typeof node.custom.digest!=='string'||!/^[a-f0-9]{64}$/.test(node.custom.digest))throw new Error('Invalid custom node reference.');validateNodeManifest(node.custom.definition);if(node.custom.packageId!==node.custom.definition.id||node.custom.version!==node.custom.definition.version)throw new Error('Custom node identity mismatch.');}
		if (node.type === 'schedule') validateSchedule(scheduleConfig(node));
		for (const key of authorityFields(node)) {
			const value = node.config[key];
			if (value === undefined) continue;
			if (['tools', 'allowedTools', 'skills'].includes(key)) {
				if (
					!Array.isArray(value) ||
					value.length > 500 ||
					value.some((item) => typeof item !== 'string' || item.length > 500 || item.includes('{{'))
				)
					throw new Error(`The ${key} allowlist must contain saved, literal names.`);
			} else if (typeof value !== 'string' || value.length > 4096 || value.includes('{{'))
				throw new Error(`The ${key} setting must be a saved, literal value.`);
		}
		if (
			node.config.permissionMode !== undefined &&
			!['ask', 'auto-review', 'full-access'].includes(String(node.config.permissionMode))
		)
			throw new Error('Invalid node permission mode.');
	}
	for (const edge of workflow.edges) {
		if (!edge || !validId(edge.id) || edges.has(edge.id))
			throw new Error('Workflow connection identifiers must be unique.');
		if (!ids.has(edge.source) || !ids.has(edge.target))
			throw new Error('Workflow connection references a missing node.');
		if (
			(edge.targetHandle !== undefined && !validId(edge.targetHandle)) ||
			(edge.sourceHandle !== undefined && !validId(edge.sourceHandle))
		)
			throw new Error('Invalid workflow input name.');
		edges.add(edge.id);
		outgoing.get(edge.source)!.push(edge.target);
		incoming.set(edge.target, incoming.get(edge.target)! + 1);
	}
	const ready = [...ids].filter((id) => incoming.get(id) === 0);
	let visited = 0;
	while (ready.length) {
		const id = ready.pop()!;
		visited++;
		for (const target of outgoing.get(id)!) {
			incoming.set(target, incoming.get(target)! - 1);
			if (incoming.get(target) === 0) ready.push(target);
		}
	}
	if (visited !== ids.size)
		throw new Error(
			'Workflow connections contain a cycle. Use Feedback Loop, Repeat, or For Each with a subworkflow for bounded loops.',
		);
}

export interface WorkflowEngineOptions {
	store: WorkflowStore;
	execute: WorkflowNodeExecutor;
	onChange?: () => void;
	onCompleted?: (run: WorkflowRun) => void;
	onError?: (error: unknown) => void;
	maxConcurrentRuns?: number;
	/** Host startup gate. Queued runs stay durable until renderer-dependent services are ready. */
	canRun?: () => boolean;
	now?: () => number;
	/** Disable background timers for deterministic embedding/tests; tick remains available. */
	autoSchedule?: boolean;
	/** Resolve only this host's live project; missing projects must never fall back to a global directory. */
	resolveProject?: (
		id: string,
	) => Promise<WorkflowProjectContext | undefined> | WorkflowProjectContext | undefined;
}
export interface StartWorkflowOptions {
	/** Host-owned automatic-trigger generation, never accepted from tool arguments. */
	expectedDefinitionHash?: string;
	inputs?: Record<string, unknown>;
	trigger?: WorkflowTrigger;
	parentRunId?: string;
	overlap?: 'skip' | 'queue';
	bindingId?: string;
	sourceThreadId?: string;
	requestId?: string;
	/** Trusted host ceiling, never taken from model output. */
	permissionMode?: CodePermissionMode;
}

export class WorkflowEngine {
	readonly store: WorkflowStore;
	readonly scheduler: WorkflowScheduler;
	private workflows = new Map<string, WorkflowDefinition>();
	private definitionSerial: Promise<unknown> = Promise.resolve();
	private definitionErrors: { file: string; message: string }[] = [];
	private runs = new Map<string, WorkflowRun>();
	private bindings = new Map<string, WorkflowProjectBinding>();
	private bindingSerial: Promise<unknown> = Promise.resolve();
	private controllers = new Map<string, AbortController>();
	private executing = new Set<string>();
	private active = new Set<Promise<void>>();
	private queue: string[] = [];
	private watchers: FSWatcher[] = [];
	private eventTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private eventTimerDefinitions = new Map<string, { workflowId: string; hash: string }>();
	private timer?: ReturnType<typeof setInterval>;
	private closed = false;
	private initialized = false;
	private startSerial: Promise<unknown> = Promise.resolve();
	constructor(private readonly options: WorkflowEngineOptions) {
		this.store = options.store;
		this.scheduler = new WorkflowScheduler({
			store: this.store,
			workflows: () => [...this.workflows.values()],
			runs: () => [...this.runs.values()],
			start: (id, args, definition, definitions) => this.startRun(id, { ...args, expectedDefinitionHash: this.triggerDefinitionHash(definition, new Map(definitions.map(graph => [graph.id, graph]))) }),
			now: options.now,
			onError: (error) => options.onError?.(error),
		});
	}
	private now(): number {
		return this.options.now?.() ?? Date.now();
	}
	async init(): Promise<void> {
		if (this.initialized) return;
		await this.store.init();
		const [_, runs, bindings] = await Promise.all([
			this.refreshDefinitions(),
			this.store.listRuns(),
			this.store.listBindings(),
		]);
		for (const binding of bindings) {
			this.validateBinding(binding);
			this.bindings.set(binding.id, binding);
		}
		for (const run of runs) this.runs.set(run.id, run);
		for (const run of runs) {
			if (!run.rootRunId) {
				let root = run;
				const visited = new Set<string>();
				while (root.parentRunId && !visited.has(root.id)) {
					visited.add(root.id);
					const parent = this.runs.get(root.parentRunId);
					if (!parent) break;
					root = parent;
				}
				run.rootRunId = root.id;
			}
			if (
				run.status === 'running' ||
				Object.values(run.nodes).some((node) => node.status === 'running')
			) {
				for (const node of Object.values(run.nodes))
					if (node.status === 'running') {
						node.status = 'interrupted';
						node.error =
							'FreeLM stopped while this step was active. Review any external effects before retrying.';
					}
				run.status = 'interrupted';
				run.error =
					'Execution was interrupted. Explicit retry is required; active steps were not replayed.';
				await this.store.saveRun(run);
			}
			if (run.status === 'queued') this.enqueue(run.id);
		}
		// A crash may leave a child queued after its parent was cancelled/interrupted.
		// Recover the whole ancestry before admitting any restored work.
		for (const run of runs) {
			if (!['queued', 'waiting'].includes(run.status) || !run.parentRunId) continue;
			let ancestor = this.runs.get(run.parentRunId);
			const visited = new Set<string>();
			while (ancestor && !visited.has(ancestor.id)) {
				visited.add(ancestor.id);
				if (TERMINAL.has(ancestor.status)) {
					run.status = ancestor.status === 'cancelled' ? 'cancelled' : 'interrupted';
					run.error =
						'The parent stopped before this child could continue. Retry the parent to resume.';
					this.queue = this.queue.filter((id) => id !== run.id);
					await this.store.saveRun(run);
					break;
				}
				ancestor = ancestor.parentRunId ? this.runs.get(ancestor.parentRunId) : undefined;
			}
		}
		this.initialized = true;
		this.refreshWatchers();
		if (this.options.autoSchedule !== false) {
			this.scheduler.start();
			this.timer = setInterval(() => {
				void this.tick().catch((error) => this.options.onError?.(error));
			}, 1000);
			this.timer.unref?.();
		}
		await this.tick();
		this.pump();
		this.changed();
	}
	snapshot(scope: { bindingId?: string; projectId?: string } = {}): WorkflowSnapshot {
		return structuredClone({
			version: 1,
			hostId: 'local',
			definitionVersions: Object.fromEntries([...this.workflows.values()].map(item => [item.id, { revision: item.revision ?? 0, contentHash: definitionHash(item) }])),
			definitionErrors: this.definitionErrors,
			bindings: [...this.bindings.values()].sort((a, b) => b.updatedAt - a.updatedAt),
			workflows: [...this.workflows.values()].sort((a, b) => b.updatedAt - a.updatedAt),
			runs: [...this.runs.values()]
				.filter(
					(run) =>
						(!scope.bindingId || run.bindingId === scope.bindingId) &&
						(!scope.projectId || run.projectId === scope.projectId),
				)
				.sort((a, b) => b.createdAt - a.createdAt)
				.slice(0, 200),
		});
	}
	private changed(): void {
		try {
			this.options.onChange?.();
		} catch (error) {
			this.report(error);
		}
	}
	private report(error: unknown): void {
		try {
			this.options.onError?.(error);
		} catch {
			/* Reporting must not change durable execution state. */
		}
	}
	private async persist(run: WorkflowRun): Promise<void> {
		try {
			await this.store.saveRun(run);
		} catch (error) {
			throw new WorkflowPersistenceError(`Could not checkpoint workflow: ${message(error)}`);
		}
		this.changed();
		if (run.status === 'completed' && !run.parentRunId) {
			try {
				await this.options.onCompleted?.(structuredClone(run));
			} catch (error) {
				this.report(error);
			}
		}
	}
	getWorkflow(id: string): WorkflowDefinition | undefined {
		return structuredClone(this.workflows.get(id));
	}
	listWorkflows(): WorkflowDefinition[] {
		return structuredClone([...this.workflows.values()]);
	}
	getRun(id: string): WorkflowRun | undefined {
		return structuredClone(this.runs.get(id));
	}
	listRuns(workflowId?: string): WorkflowRun[] {
		return structuredClone(
			[...this.runs.values()].filter((run) => !workflowId || run.workflowId === workflowId),
		);
	}
	listThreadRuns(): WorkflowRun[] {
		return structuredClone(
			[...this.runs.values()].filter((run) => run.sourceThreadId && !run.parentRunId),
		);
	}
	listThreadCompletions(): (Pick<
		WorkflowRun,
		'id' | 'sourceThreadId' | 'projectId' | 'workflowName' | 'status' | 'finishedAt' | 'startedAt'
	> & { outputNames: string[] })[] {
		return [...this.runs.values()]
			.filter((run) => run.sourceThreadId && !run.parentRunId && TERMINAL.has(run.status))
			.map((run) => ({
				id: run.id,
				sourceThreadId: run.sourceThreadId,
				projectId: run.projectId,
				workflowName: run.workflowName,
				status: run.status,
				finishedAt: run.finishedAt,
				startedAt: run.startedAt,
				outputNames: Object.keys(run.outputs ?? {}),
			}));
	}
	listBindings(projectId?: string): WorkflowProjectBinding[] {
		return structuredClone(
			[...this.bindings.values()].filter(
				(binding) => !projectId || binding.projectId === projectId,
			),
		);
	}
	listBindingSummaries(projectId?: string): WorkflowBindingSummary[] {
		return [...this.bindings.values()]
			.filter((binding) => !projectId || binding.projectId === projectId)
			.map((binding) => ({
				id: binding.id,
				hostId: binding.hostId,
				projectId: binding.projectId,
				workflowId: binding.workflowId,
				revision: binding.revision,
				name: binding.name || binding.workflowSnapshot.name,
			}));
	}
	getBinding(id: string): WorkflowProjectBinding | undefined {
		return structuredClone(this.bindings.get(id));
	}
	private async project(id: string): Promise<WorkflowProjectContext> {
		const project = await this.options.resolveProject?.(id);
		if (!project || project.id !== id) throw new Error('Project not found on this computer.');
		if (
			!Array.isArray(project.directories) ||
			project.directories.some((item) => typeof item !== 'string')
		)
			throw new Error('Project directories are invalid.');
		return structuredClone(project);
	}
	async assertLibraryProject(id: string): Promise<void> { await this.project(id); }
	private dependencies(
		workflow: WorkflowDefinition,
		available: Map<string, WorkflowDefinition>,
	): Record<string, WorkflowDefinition> {
		const result: Record<string, WorkflowDefinition> = {};
		const visit = (current: WorkflowDefinition, ancestors: Set<string>): void => {
			if (ancestors.has(current.id)) throw new Error('Recursive subworkflows are not allowed.');
			if (ancestors.size >= 12) throw new Error('Subworkflows exceed the maximum depth of 12.');
			const chain = new Set([...ancestors, current.id]);
			for (const node of current.nodes) {
				if (!['subworkflow', 'loop', 'repeat', 'foreach'].includes(node.type)) continue;
				const id = String(node.config.workflowId ?? '');
				if (!id) continue;
				const child = available.get(id);
				if (!child)
					throw new Error(
						`Subworkflow ${id} was not found. Include every dependency before running or adding this workflow.`,
					);
				if (chain.has(id)) throw new Error('Recursive subworkflows are not allowed.');
				if (Object.hasOwn(result, id)) continue;
				validateWorkflow(child);
				visit(child, chain);
				result[id] = child;
				if (Object.keys(result).length > 100)
					throw new Error('A workflow supports up to 100 pinned dependencies.');
			}
		};
		visit(workflow, new Set());
		validateJson({ workflow, dependencies: result });
		return structuredClone(result);
	}
	private validateBinding(binding: WorkflowProjectBinding): void {
		if (
			!validId(binding.id) ||
			!validId(binding.projectId) ||
			binding.hostId !== 'local' ||
			binding.workflowId !== binding.workflowSnapshot?.id ||
			!Number.isSafeInteger(binding.revision) ||
			binding.revision < 1 ||
			![binding.createdAt, binding.updatedAt].every(
				(value) => Number.isFinite(value) && value >= 0,
			) ||
			!isRecord(binding.dependencySnapshots)
		)
			throw new Error('Invalid project workflow binding.');
		validateBindingPatch(binding as unknown as Record<string, unknown>);
		validateWorkflow(binding.workflowSnapshot);
		validateJson(binding);
		this.dependencies(
			binding.workflowSnapshot,
			new Map(Object.entries(binding.dependencySnapshots)),
		);
	}
	private mutateBinding<T>(action: () => Promise<T>): Promise<T> {
		const result = this.bindingSerial
			.catch(() => undefined)
			.then(() => {
				if (this.closed) throw new Error('Workflow engine is closed.');
				return action();
			});
		this.bindingSerial = result;
		return result;
	}
	attachWorkflow(options: WorkflowAttachOptions): Promise<WorkflowProjectBinding> {
		validateWorkflowCommand({ type: 'attach', ...options });
		const captured = structuredClone(options);
		return this.mutateBinding(async () => {
			await this.project(captured.projectId);
			const existing = captured.bindingId ? this.bindings.get(captured.bindingId) : undefined;
			if (existing) {
				if (
					existing.projectId !== captured.projectId ||
					existing.workflowId !== captured.workflowId
				)
					throw new Error('Project workflow ID is already in use.');
				return structuredClone(existing);
			}
			if (this.bindings.size >= 2000) throw new Error('Project workflow limit reached (2000).');
			const definition = captured.workflow ?? this.workflows.get(captured.workflowId);
			if (!definition || definition.id !== captured.workflowId)
				throw new Error('Workflow not found.');
			validateWorkflow(definition);
			const dependencySnapshots = this.dependencies(
				definition,
				captured.workflow
					? new Map((captured.dependencies ?? []).map((item) => [item.id, item]))
					: this.workflows,
			);
			const now = this.now();
			const binding: WorkflowProjectBinding = {
				id: captured.bindingId ?? randomUUID(),
				hostId: 'local',
				projectId: captured.projectId,
				workflowId: definition.id,
				name: captured.name,
				revision: 1,
				workflowSnapshot: structuredClone(definition),
				dependencySnapshots,
				settings: captured.settings,
				defaultInputs: captured.defaultInputs,
				createdAt: now,
				updatedAt: now,
			};
			this.validateBinding(binding);
			await this.store.saveBinding(binding);
			this.bindings.set(binding.id, binding);
			this.changed();
			return structuredClone(binding);
		});
	}
	updateBinding(bindingId: string, patch: WorkflowBindingPatch): Promise<WorkflowProjectBinding> {
		validateWorkflowCommand({ type: 'update-binding', bindingId, ...patch });
		const captured = structuredClone(patch);
		return this.mutateBinding(async () => {
			const existing = this.bindings.get(bindingId);
			if (!existing) throw new Error('Project workflow not found.');
			await this.project(existing.projectId);
			if (
				captured.expectedRevision !== undefined &&
				captured.expectedRevision !== existing.revision
			)
				throw new Error('This project workflow changed. Inspect it again before updating.');
			if (captured.workflow && captured.workflow.id !== existing.workflowId)
				throw new Error('Project workflow edits must preserve the workflow identifier.');
			const workflow = captured.workflow ?? existing.workflowSnapshot;
			const available = captured.dependencies
				? new Map(captured.dependencies.map((item) => [item.id, item]))
				: new Map(Object.entries(existing.dependencySnapshots));
			const updated: WorkflowProjectBinding = {
				...existing,
				...Object.fromEntries(
					['name', 'settings', 'defaultInputs']
						.filter((key) => Object.hasOwn(captured, key))
						.map((key) => [key, (captured as Record<string, unknown>)[key]]),
				),
				workflowSnapshot: workflow,
				dependencySnapshots: this.dependencies(workflow, available),
				revision: existing.revision + 1,
				updatedAt: this.now(),
			};
			this.validateBinding(updated);
			await this.store.saveBinding(updated);
			this.bindings.set(bindingId, updated);
			this.changed();
			return structuredClone(updated);
		});
	}
	detachWorkflow(bindingId: string): Promise<void> {
		return this.mutateBinding(async () => {
			if (!validId(bindingId)) throw new Error('Invalid project workflow identifier.');
			await this.store.deleteBinding(bindingId);
			this.bindings.delete(bindingId);
			this.changed();
		});
	}
	private triggerDefinitionHash(graph: WorkflowDefinition, available = this.workflows): string {
		return definitionHash({ graph, dependencies: this.dependencies(graph, available) });
	}
	private mutateDefinitions<T>(action: () => Promise<T>): Promise<T> {
		const result = this.definitionSerial.catch(() => undefined).then(() => {
			if (this.closed) throw new Error('Workflow engine is closed.');
			return action();
		});
		this.definitionSerial = result;
		return result;
	}
	/** Explicit read-only disk reconciliation; never called by a directory watcher. */
	refreshDefinitions(): Promise<void> {
		return this.mutateDefinitions(async () => {
			const scan = await this.store.readDefinitions();
			const errors = [...scan.errors];
			const bad = new Set(scan.errors.map(item => item.file.replace(/\.json$/, '')));
			const next = new Map<string, WorkflowDefinition>();
			for (const { file, value } of scan.records) {
				try {
					validateWorkflow(value as WorkflowDefinition);
					const graph = value as WorkflowDefinition;
					if (file !== `${graph.id}.json` || next.has(graph.id)) throw new Error('Definition filename and unique graph identifier must match.');
					next.set(graph.id, graph);
				} catch (error) { bad.add(file.replace(/\.json$/, '')); if (isRecord(value) && validId(value.id)) bad.add(String(value.id)); errors.push({ file, message: String(error) }); }
			}
			// Hold the affected dependency component at its last valid generation.
			const links = new Map<string, Set<string>>();
			for (const graph of [...this.workflows.values(), ...next.values()]) {
				if (!links.has(graph.id)) links.set(graph.id, new Set());
				for (const node of graph.nodes) if (['subworkflow', 'loop', 'repeat', 'foreach'].includes(node.type)) {
					const child = String(node.config.workflowId);
					links.get(graph.id)!.add(child);
					if (!links.has(child)) links.set(child, new Set());
					links.get(child)!.add(graph.id);
				}
			}
			for (const graph of next.values()) {
				try { this.dependencies(graph, next); }
				catch (error) { bad.add(graph.id); errors.push({ file: `${graph.id}.json`, message: String(error) }); }
			}
			const held = new Set(bad), visit = [...bad];
			for (let index = 0; index < visit.length; index++) for (const id of links.get(visit[index]) ?? []) {
				if (!held.has(id)) { held.add(id); visit.push(id); }
			}
			for (const id of held) { const old = this.workflows.get(id); if (old) next.set(id, old); else next.delete(id); }
			const changed = next.size !== this.workflows.size || [...next].some(([id, graph]) => !this.workflows.has(id) || definitionHash(graph) !== definitionHash(this.workflows.get(id)!));
			const diagnosticsChanged = JSON.stringify(errors) !== JSON.stringify(this.definitionErrors);
			this.definitionErrors = errors;
			if (changed) { this.workflows = next; this.refreshWatchers(); }
			if (this.initialized && (changed || diagnosticsChanged)) this.changed();
		});
	}
	saveWorkflow(workflow: WorkflowDefinition, expected: DefinitionBase = {}, validateDependencies = false): Promise<WorkflowDefinition> {
		validateWorkflow(workflow);
		const captured = structuredClone(workflow), base = structuredClone(expected);
		return this.mutateDefinitions(async () => {
			const current = this.workflows.get(captured.id), disk = await this.store.readDefinition(captured.id);
			if (validateDependencies) this.dependencies(captured, new Map([...this.workflows, [captured.id, captured]]));
			if ((current ? definitionHash(current) : undefined) !== (disk ? definitionHash(disk) : undefined) ||
				(base.expectedRevision !== undefined && base.expectedRevision !== (current?.revision ?? 0)) ||
				(base.expectedContentHash !== undefined && (!current || base.expectedContentHash !== definitionHash(current))))
				throw new Error('This library workflow changed. Refresh definitions and review your draft before saving.');
			const saved = { ...captured, revision: (current?.revision ?? 0) + 1, updatedAt: this.now() };
			await this.store.saveWorkflow(saved);
			this.workflows.set(saved.id, saved);
			this.refreshWatchers(); this.changed();
			return structuredClone(saved);
		});
	}
	async deleteWorkflow(id: string): Promise<void> {
		return this.mutateDefinitions(async () => {
		const current = this.workflows.get(id), disk = await this.store.readDefinition(id);
		if ((current ? definitionHash(current) : undefined) !== (disk ? definitionHash(disk) : undefined)) throw new Error('This library workflow changed. Refresh definitions before deleting.');
		await this.store.deleteWorkflow(id);
		this.workflows.delete(id);
		this.refreshWatchers();
		this.changed();
		});
	}
	async command(command: WorkflowCommand): Promise<WorkflowSnapshot> {
		validateWorkflowCommand(command);
		switch (command.type) {
			case 'refresh-definitions': await this.refreshDefinitions(); break;
 case 'install-custom-node':
 case 'remove-custom-node':
 case 'discover-custom-node':
 case 'authorize-custom-node':
 case 'set-custom-node-secret':
 throw new Error('Manage custom node packages on the owning desktop host.');
			case 'save':
				if (this.workflows.has(command.workflow.id) && (command.expectedRevision === undefined || command.expectedContentHash === undefined)) throw new Error('Refresh this library workflow before saving; its base revision and content are required.');
				await this.saveWorkflow(command.workflow, { ...command, expectedRevision: command.expectedRevision ?? 0 });
				break;
			case 'delete':
				await this.deleteWorkflow(command.id);
				break;
			case 'attach':
				await this.attachWorkflow(command);
				break;
			case 'update-binding':
				await this.updateBinding(command.bindingId, command);
				break;
			case 'detach':
				await this.detachWorkflow(command.bindingId);
				break;
			case 'run':
				await this.startRun(command.id, {
					inputs: command.inputs,
					bindingId: command.bindingId,
					sourceThreadId: command.sourceThreadId,
					requestId: command.requestId,
					trigger: { kind: 'manual', nodeId: command.entryNodeId },
				});
				break;
			case 'cancel':
				await this.cancelRun(command.runId);
				break;
			case 'resume':
				await this.resumeRun(command.runId, { nodeId: command.nodeId, value: command.value });
				break;
			case 'retry':
				await this.resumeRun(command.runId, { retry: true });
				break;
			case 'emit':
				await this.emit(command.name, command.payload);
				break;
			case 'catalog':
				break;
		}
		return this.snapshot(command.type === 'catalog' ? command : {});
	}
	startRun(workflowId: string, options: StartWorkflowOptions = {}): Promise<WorkflowRun> {
		// Serial admission makes deduplication and persistence one durable operation.
		const captured = structuredClone(options);
		const result = this.startSerial
			.catch(() => undefined)
			.then(() => this.admit(workflowId, captured));
		this.startSerial = result;
		return result;
	}
	private async admit(workflowId: string, options: StartWorkflowOptions): Promise<WorkflowRun> {
		if (this.closed) throw new Error('Workflow engine is closed.');
		if (options.expectedDefinitionHash !== undefined && (!this.workflows.has(workflowId) || this.triggerDefinitionHash(this.workflows.get(workflowId)!) !== options.expectedDefinitionHash)) throw new Error('The workflow definition changed before its automatic trigger was admitted.');
		if (!validId(workflowId)) throw new Error('Invalid workflow identifier.');
		for (const value of [options.bindingId, options.sourceThreadId, options.parentRunId])
			if (value !== undefined && !validId(value))
				throw new Error('Invalid workflow context identifier.');
		if (
			options.requestId !== undefined &&
			(typeof options.requestId !== 'string' ||
				!options.requestId ||
				options.requestId.length > 200)
		)
			throw new Error('Invalid workflow request ID.');
		if (
			options.permissionMode !== undefined &&
			!['ask', 'auto-review', 'full-access'].includes(options.permissionMode)
		)
			throw new Error('Invalid workflow permission ceiling.');
		const parent = options.parentRunId ? this.runs.get(options.parentRunId) : undefined;
		if (options.parentRunId && (!parent || TERMINAL.has(parent.status)))
			throw new Error('The parent workflow is no longer active.');
		const bindingId = parent?.bindingId ?? options.bindingId;
		if (parent && options.bindingId && options.bindingId !== parent.bindingId)
			throw new Error('A child cannot change its project workflow binding.');
		const binding = !parent && bindingId ? this.bindings.get(bindingId) : undefined;
		if (!parent && bindingId && !binding) throw new Error('Project workflow not found.');
		if (binding && binding.workflowId !== workflowId)
			throw new Error('Workflow does not match the project binding.');
		const original = parent?.dependencySnapshots
			? parent.dependencySnapshots[workflowId]
			: (binding?.workflowSnapshot ?? this.workflows.get(workflowId));
		if (!original) throw new Error('Workflow not found in the pinned dependency snapshot.');
		validateWorkflow(original);
		const trigger = options.trigger ?? { kind: 'manual' };
		validateJson(trigger, 1024 * 1024);
		if (trigger.key || options.requestId) {
			const duplicate = [...this.runs.values()].find(
				(run) =>
					run.workflowId === workflowId &&
					run.bindingId === bindingId &&
					(options.requestId
						? run.requestId === options.requestId && run.sourceThreadId === options.sourceThreadId
						: run.trigger.key === trigger.key),
			);
			if (duplicate) return structuredClone(duplicate);
		}
		if (options.inputs !== undefined) {
			if (!isRecord(options.inputs)) throw new Error('Workflow inputs must be an object.');
			validateJson(options.inputs, 1024 * 1024);
		}
		const inputs = normalizeWorkflowInputs(
			original,
			{ ...options.inputs, ...trigger.payload },
			parent ? {} : binding?.defaultInputs,
		);
		validateJson(inputs, 1024 * 1024);
		const projectContext =
			parent?.projectContext ?? (binding ? await this.project(binding.projectId) : undefined);
		const bindingSettings = parent?.bindingSettings ?? binding?.settings;
		const ceiling = parent?.permissionMode
			? permissionCeiling(parent.permissionMode, options.permissionMode)
			: options.permissionMode;
		const workflow = structuredClone(original);
		if (projectContext) {
			if (!projectContext.directories[0])
				throw new Error('Choose a project directory before running this workflow.');
			workflow.settings = { ...workflow.settings, workspaceRoot: projectContext.directories[0] };
		}
		if (bindingSettings?.permissionMode || ceiling)
			workflow.settings = {
				...workflow.settings,
				permissionMode: permissionCeiling(
					bindingSettings?.permissionMode ?? workflow.settings?.permissionMode,
					ceiling,
				),
			};
		for (const node of workflow.nodes) {
			if (projectContext) node.config.projectId = projectContext.id;
			if (bindingSettings && ['agent', 'text'].includes(node.type)) {
				for (const key of ['connectionId', 'model', 'thinkingMode'] as const)
					if (bindingSettings[key]) node.config[key] = bindingSettings[key];
			}
			if (bindingSettings?.permissionMode || ceiling)
				node.config.permissionMode = permissionCeiling(
					bindingSettings?.permissionMode ??
						(node.config.permissionMode as CodePermissionMode | undefined) ??
						workflow.settings?.permissionMode,
					ceiling,
				);
		}
		const dependencySnapshots =
			parent?.dependencySnapshots ??
			binding?.dependencySnapshots ??
			this.dependencies(original, this.workflows);
		if (
			trigger.nodeId &&
			!workflow.nodes.some((node) => node.id === trigger.nodeId && TRIGGERS.has(node.type))
		)
			throw new Error('The selected entry node does not exist.');
		if (options.parentRunId) {
			let ancestor = this.runs.get(options.parentRunId),
				depth = 0;
			while (ancestor) {
				if (ancestor.workflowId === workflowId)
					throw new Error('Recursive subworkflows are not allowed.');
				if (++depth > 12) throw new Error('Subworkflows exceed the maximum depth of 12.');
				ancestor = ancestor.parentRunId ? this.runs.get(ancestor.parentRunId) : undefined;
			}
		}
		if (this.queue.length >= 1000) throw new Error('Workflow queue is full (1000 runs).');
		const run: WorkflowRun = {
			id: randomUUID(),
			workflowId,
			workflowName: binding?.name || workflow.name,
			workflowSnapshot: structuredClone(workflow),
			nodes: Object.fromEntries(
				workflow.nodes.map((node) => [node.id, { nodeId: node.id, status: 'pending', attempt: 0 }]),
			),
			status: 'queued',
			inputs: structuredClone(inputs),
			trigger: structuredClone(trigger),
			createdAt: this.now(),
			parentRunId: options.parentRunId,
			bindingId,
			projectId: projectContext?.id,
			sourceThreadId: parent?.sourceThreadId ?? options.sourceThreadId,
			requestId: options.requestId,
			projectContext,
			bindingSettings: structuredClone(bindingSettings),
			permissionMode: ceiling,
			dependencySnapshots: structuredClone(dependencySnapshots),
		};
		run.rootRunId = options.parentRunId
			? (this.runs.get(options.parentRunId)?.rootRunId ?? options.parentRunId)
			: run.id;
		await this.store.saveRun(run);
		this.runs.set(run.id, run);
		// Cancellation can race the first disk commit, before cancelRun can see this child.
		if (this.closed || (parent && TERMINAL.has(parent.status))) {
			run.status = parent?.status === 'cancelled' ? 'cancelled' : 'interrupted';
			run.error = 'Admission stopped because the parent or workflow engine stopped.';
			run.finishedAt = this.now();
			await this.persist(run);
			throw new Error(run.error);
		}
		this.enqueue(run.id);
		this.changed();
		this.pump();
		return structuredClone(run);
	}
	private enqueue(id: string, priority = false): void {
		if (!this.queue.includes(id)) {
			if (priority) this.queue.unshift(id);
			else this.queue.push(id);
		}
	}
	private pump(): void {
		if (this.closed || !this.initialized || this.options.canRun?.() === false) return;
		const limit = Math.max(1, Math.min(16, this.options.maxConcurrentRuns ?? 3));
		while (this.executing.size < limit && this.queue.length) {
			// Scheduled overlap=queue is serialized by workflow. Child runs may always make progress.
			const index = this.queue.findIndex((id) => {
				const run = this.runs.get(id);
				return (
					!!run &&
					(run.parentRunId ||
						run.trigger.kind !== 'schedule' ||
						![...this.runs.values()].some(
							(other) =>
								other.id !== run.id &&
								other.workflowId === run.workflowId &&
								['running', 'waiting'].includes(other.status),
						))
				);
			});
			if (index < 0) break;
			const id = this.queue.splice(index, 1)[0],
				run = this.runs.get(id);
			if (!run || run.status !== 'queued') continue;
			this.executing.add(id);
			const task = this.drive(run)
				.catch(async (error) => {
					if (!this.closed && run.status !== 'cancelled') {
						run.status = error instanceof WorkflowPersistenceError ? 'interrupted' : 'failed';
						run.error = message(error);
						run.finishedAt = this.now();
						for (const node of Object.values(run.nodes))
							if (node.status === 'running') {
								node.status = 'interrupted';
								node.error = run.error;
							}
						try {
							await this.persist(run);
						} catch (saveError) {
							this.report(saveError);
							this.changed();
						}
					}
					this.report(error);
				})
				.finally(() => {
					this.executing.delete(id);
					this.controllers.delete(id);
					this.active.delete(task);
					void this.tick().catch((error) => this.options.onError?.(error));
					this.pump();
				});
			this.active.add(task);
		}
	}
	private edgeActive(run: WorkflowRun, edge: WorkflowEdge): boolean {
		const parent = run.nodes[edge.source];
		if (parent.status !== 'completed') return false;
		const source = run.workflowSnapshot.nodes.find((node) => node.id === edge.source)!;
		return (
			source.type !== 'condition' ||
			!['true', 'false'].includes(edge.sourceHandle ?? '') ||
			edge.sourceHandle === String(parent.output?.result)
		);
	}
	private nodeInputs(run: WorkflowRun, edges: WorkflowEdge[]): Record<string, unknown> {
		const grouped = new Map<string, unknown[]>();
		for (const edge of edges.filter((edge) => this.edgeActive(run, edge))) {
			const output = run.nodes[edge.source].output ?? {},
				handle = edge.sourceHandle ?? 'value';
			const value = ['true', 'false'].includes(handle)
				? output.value
				: handle === 'output'
					? output
					: own(output, handle);
			const target = edge.targetHandle ?? 'input';
			const values = grouped.get(target) ?? [];
			values.push(value);
			grouped.set(target, values);
		}
		return Object.fromEntries(
			[...grouped].map(([key, values]) => [key, values.length === 1 ? values[0] : values]),
		);
	}
	private async drive(run: WorkflowRun): Promise<void> {
		const controller = new AbortController();
		this.controllers.set(run.id, controller);
		run.status = 'running';
		run.startedAt ??= this.now();
		await this.persist(run);
		const concurrency = Math.max(1, Math.min(16, run.workflowSnapshot.settings?.concurrency ?? 2));
		let progress = true;
		while (progress && !controller.signal.aborted && !this.closed) {
			progress = false;
			const ready: WorkflowNode[] = [];
			for (const node of run.workflowSnapshot.nodes) {
				const state = run.nodes[node.id];
				if (state.status !== 'pending') continue;
				const edges = run.workflowSnapshot.edges.filter((edge) => edge.target === node.id);
				if (edges.some((edge) => !TERMINAL.has(run.nodes[edge.source].status))) continue;
				const selectedTrigger = run.trigger.nodeId
					? run.trigger.nodeId === node.id
					: node.type === 'entry';
				if (
					(TRIGGERS.has(node.type) && !selectedTrigger) ||
					(edges.length > 0 && !edges.some((edge) => this.edgeActive(run, edge)))
				) {
					state.status = 'skipped';
					state.finishedAt = this.now();
					progress = true;
					continue;
				}
				if (ready.length >= concurrency) continue;
				state.inputs = this.nodeInputs(run, edges);
				state.status = 'running';
				state.startedAt = this.now();
				state.attempt++;
				delete state.error;
				ready.push(node);
			}
			if (!ready.length && !progress) break;
			// Persist the whole ready batch before any external effects can begin.
			await this.persist(run);
			if (this.closed || controller.signal.aborted) return;
			await Promise.all(
				ready.map(async (node) => {
					if (this.closed || controller.signal.aborted) return;
					const state = run.nodes[node.id],
						inputs = state.inputs!;
					try {
						const scope = {
							input: firstDefined(inputs.input, inputs.value, inputs),
							inputs,
							run: { inputs: run.inputs, id: run.id, rootRunId: run.rootRunId ?? run.id },
							trigger: run.trigger,
							nodes: Object.fromEntries(
								Object.entries(run.nodes).map(([id, value]) => [id, value.output]),
							),
						};
						const configured = {
							...node,
							config: interpolate(node.config, scope) as Record<string, unknown>,
						};
						for (const key of authorityFields(node))
							if (Object.hasOwn(node.config, key)) configured.config[key] = node.config[key];
						const output = await this.executeNode(
							configured,
							inputs,
							run,
							state,
							controller.signal,
						);
						if (this.closed || controller.signal.aborted) return;
						if (output !== undefined) {
							validateJson(output);
							state.output = output;
							state.status = 'completed';
							state.finishedAt = this.now();
						}
						await this.persist(run);
						progress = true;
					} catch (error) {
						if (this.closed || controller.signal.aborted) return;
						state.status = error instanceof WorkflowPersistenceError ? 'interrupted' : 'failed';
						state.error = message(error);
						state.finishedAt = this.now();
						run.status = error instanceof WorkflowPersistenceError ? 'interrupted' : 'failed';
						run.error = `${node.label || node.type}: ${message(error)}`;
						run.finishedAt = this.now();
						controller.abort();
						for (const sibling of Object.values(run.nodes))
							if (
								sibling.status === 'running' ||
								(sibling.status === 'waiting' && sibling.childRunIds?.length)
							) {
								sibling.status = 'interrupted';
								sibling.error =
									'A parallel step failed. Review any effects before retrying this step.';
							}
						await this.persist(run);
						for (const child of this.runs.values())
							if (child.parentRunId === run.id && !TERMINAL.has(child.status))
								await this.cancelRun(child.id);
					}
				}),
			);
		}

		if (this.closed || controller.signal.aborted) return;
		if (Object.values(run.nodes).some((node) => node.status === 'waiting')) run.status = 'waiting';
		else if (
			Object.values(run.nodes).every((node) => ['completed', 'skipped'].includes(node.status))
		) {
			run.status = 'completed';
			run.finishedAt = this.now();
			const outputs = run.workflowSnapshot.nodes.filter(
				(node) => node.type === 'output' && run.nodes[node.id].status === 'completed',
			);
			run.outputs = outputs.length
				? Object.fromEntries(
						outputs.map((node) => [
							String(node.config.name || node.label || node.id),
							run.nodes[node.id].output?.value,
						]),
					)
				: Object.fromEntries(
						run.workflowSnapshot.nodes
							.filter(
								(node) =>
									!run.workflowSnapshot.edges.some((edge) => edge.source === node.id) &&
									run.nodes[node.id].status === 'completed',
							)
							.map((node) => [node.id, run.nodes[node.id].output]),
					);
		} else {
			run.status = 'failed';
			run.error = 'Workflow cannot make progress. Check its connections.';
			run.finishedAt = this.now();
		}
		await this.persist(run);
	}
	private async executeNode(
		node: WorkflowNode,
		inputs: Record<string, unknown>,
		run: WorkflowRun,
		state: WorkflowNodeRun,
		signal: AbortSignal,
	): Promise<Record<string, unknown> | undefined> {
		const config = node.config,
			input = firstDefined(inputs.value, inputs.input);
		switch (node.type) {
			case 'entry':
			case 'schedule':
			case 'event':
				return {
					...run.inputs,
					...run.trigger.payload,
					value: run.inputs,
					text:
						(run.workflowSnapshot.request
							? run.inputs[run.workflowSnapshot.request.prompt.key]
							: undefined) ??
						run.inputs.prompt ??
						run.inputs.text ??
						'',
					trigger: run.trigger,
				};
			case 'value':
				return { value: config.value };
			case 'condition': {
				const value = firstDefined(inputs.value, inputs.input, config.value),
					compare = firstDefined(inputs.compare, config.compare);
				const result = conditionMatches(value, String(config.operator ?? 'truthy'), compare);
				return {
					value,
					result,
					true: result ? value : undefined,
					false: result ? undefined : value,
				};
			}
			case 'join':
				return {
					...inputs,
					value: config.mode === 'list' ? Object.values(inputs).flat() : inputs,
					items: Object.values(inputs),
				};
			case 'output':
				return { ...inputs, value: firstDefined(input, inputs.text, inputs) };
			case 'context':
				if (['input', 'trigger', 'run'].includes(String(config.source ?? config.mode))) {
					const mode = config.source ?? config.mode;
					const source =
						mode === 'trigger'
							? run.trigger
							: mode === 'run'
								? {
										id: run.id,
										rootRunId: run.rootRunId ?? run.id,
										workflowId: run.workflowId,
										inputs: run.inputs,
									}
								: run.inputs;
					return { value: config.path ? workflowPath(source, String(config.path)) : source };
				}
				break;
			case 'transform': {
				let value: unknown;
				switch (config.operation ?? 'template') {
					case 'template':
						value = firstDefined(config.template, input, '');
						break;
					case 'json-parse':
						value = JSON.parse(String(input ?? inputs.text ?? ''));
						break;
					case 'json-stringify':
						value = JSON.stringify(
							firstDefined(input, inputs),
							null,
							config.pretty ? 2 : undefined,
						);
						break;
					case 'get':
						value = workflowPath(input ?? inputs, String(config.path ?? ''));
						break;
					case 'split':
						value = String(input ?? inputs.text ?? '').split(String(config.separator ?? '\n'));
						break;
					case 'join':
						if (!Array.isArray(input)) throw new Error('Join transform requires a list.');
						value = input.join(String(config.separator ?? '\n'));
						break;
					case 'merge':
						value = Object.assign({}, ...Object.values(inputs).map(object));
						break;
					case 'pick':
						value = Object.fromEntries(
							(Array.isArray(config.keys) ? config.keys : String(config.keys ?? '').split(',')).map(
								(key) => [String(key).trim(), workflowPath(input ?? inputs, String(key).trim())],
							),
						);
						break;
					default:
						throw new Error('Unknown transform operation.');
				}
				return {
					value,
					...(typeof value === 'string' ? { text: value } : {}),
					...(Array.isArray(value) ? { items: value } : {}),
				};
			}
			case 'state': {
				const key = String(config.key ?? '');
				if (!key) throw new Error('State requires a key.');
				if (config.operation === 'set')
					await this.store.setState(persistentScope(run), key, firstDefined(input, config.value));
				else if (config.operation === 'delete')
					await this.store.setState(persistentScope(run), key, undefined);
				else if (config.operation && config.operation !== 'get')
					throw new Error('Unknown state operation.');
				return {
					value: firstDefined(this.store.getState(persistentScope(run), key), config.value),
				};
			}
			case 'collection': {
				const scope = config.scope ?? 'run';
				if (scope !== 'run' && scope !== 'workflow') throw new Error('Unknown collection scope.');
				return this.store.collections.execute({
					scope,
					scopeId: scope === 'run' ? (run.rootRunId ?? run.id) : persistentScope(run),
					name: String(config.name ?? 'records'),
					operation: (config.operation ?? 'list') as WorkflowCollectionRequest['operation'],
					recordId: firstDefined(inputs.id, config.recordId) as string | undefined,
					value: firstDefined(input, config.value),
					expectedRevision: firstDefined(inputs.expectedRevision, config.expectedRevision) as
						number | undefined,
					filter: config.filter as Record<string, unknown> | undefined,
					query: config.query as string | undefined,
					limit: config.limit as number | undefined,
					offset: config.offset as number | undefined,
					mutationId: `${run.id}:${node.id}`,
					provenance: { runId: run.id, nodeId: node.id, workflowId: run.workflowId },
				});
			}
			case 'loop': {
				const id = String(config.workflowId ?? '');
				if (!id) throw new Error('Select a feedback subworkflow.');
				const maximum = Number(config.maxIterations ?? 3),
					minimum = Number(config.minIterations ?? 1);
				if (
					!Number.isSafeInteger(maximum) ||
					maximum < 1 ||
					maximum > 100 ||
					!Number.isSafeInteger(minimum) ||
					minimum < 1 ||
					minimum > maximum
				)
					throw new Error('Feedback rounds must be integers with 1 ≤ minimum ≤ maximum ≤ 100.');
				const stopOperator = String(config.stopOperator ?? 'truthy');
				if (
					![
						'truthy',
						'equals',
						'not-equals',
						'contains',
						'greater-than',
						'less-than',
						'empty',
						'never',
					].includes(stopOperator)
				)
					throw new Error('Unknown feedback stop operator.');
				state.loop ??= {
					value: firstDefined(input, config.value, {}),
					items: [],
					iterations: 0,
					stopped: false,
				};
				state.childRunIds ??= [];
				const loop = state.loop;
				const existingId = state.childRunIds[loop.iterations];
				let child = existingId ? this.runs.get(existingId) : undefined;
				if (existingId && !child) throw new Error('A feedback round is missing.');
				if (child?.status === 'completed') {
					const resultPath = String(config.resultPath ?? 'result');
					const value = resultPath ? workflowPath(child.outputs, resultPath) : child.outputs;
					if (value === undefined)
						throw new Error(
							`Feedback result is missing at outputs.${resultPath}. Add a named Output to the subworkflow.`,
						);
					validateJson(value, 1024 * 1024);
					loop.value = value;
					loop.items.push(value);
					loop.iterations++;
					const stopValue = workflowPath(value, String(config.stopPath ?? 'done'));
					loop.stopped =
						loop.iterations >= minimum &&
						conditionMatches(stopValue, stopOperator, config.stopValue);
					validateJson(loop);
					// Commit completed feedback before admitting the next round. Stable child keys close the crash gap.
					await this.persist(run);
					child = undefined;
				}
				if (loop.stopped || loop.iterations >= maximum)
					return {
						value: loop.value,
						items: loop.items,
						iterations: loop.iterations,
						stopped: loop.stopped,
						runs: state.childRunIds,
					};
				if (signal.aborted) throw new Error('Cancelled.');
				if (!child) {
					child = await this.startRun(id, {
						parentRunId: run.id,
						inputs: {
							...run.inputs,
							...inputs,
							...object(config.inputs),
							value: loop.value,
							current: loop.value,
							previous: loop.iterations ? loop.value : null,
							index: loop.iterations,
							iteration: loop.iterations + 1,
						},
						trigger: {
							kind: 'subworkflow',
							key: `${run.id}:${node.id}:feedback:${loop.iterations}`,
						},
					});
					state.childRunIds[loop.iterations] = child.id;
				}
				if (signal.aborted) {
					if (!this.closed) await this.cancelRun(child.id);
					throw new Error('Cancelled.');
				}
				if (['failed', 'interrupted', 'cancelled'].includes(child.status))
					await this.resumeRun(child.id, { retry: true });
				state.status = 'waiting';
				state.waitReason = `Waiting for feedback round ${loop.iterations + 1} of ${maximum}`;
				return undefined;
			}
			case 'wait': {
				const mode = config.mode ?? 'human';
				state.status = 'waiting';
				state.waitReason = String(
					config.message ??
						(mode === 'human' ? 'Waiting for approval' : 'Waiting until the scheduled time'),
				);
				if (mode === 'duration') {
					const duration = Number(config.durationMs ?? Number(config.seconds ?? 0) * 1000);
					if (!Number.isFinite(duration) || duration < 0)
						throw new Error('Wait duration must be a positive number.');
					state.waitUntil = this.now() + duration;
				} else if (mode === 'until') {
					const at =
						typeof config.until === 'number' ? config.until : Date.parse(String(config.until));
					if (!Number.isFinite(at)) throw new Error('Wait requires a valid date and time.');
					state.waitUntil = at;
				} else if (mode !== 'human') throw new Error('Unknown wait mode.');
				return undefined;
			}
			case 'subworkflow':
			case 'foreach':
			case 'repeat': {
				const id = String(config.workflowId ?? '');
				if (!id) throw new Error('Select a subworkflow.');
				let items: unknown[] = [input ?? inputs];
				if (node.type === 'foreach') {
					const values = inputs.items ?? input ?? config.items;
					if (!Array.isArray(values)) throw new Error('For Each requires a list.');
					items = values;
				}
				if (node.type === 'repeat') {
					const count = Number(inputs.count ?? config.count ?? 1),
						maximum = Math.min(100, Number(config.maxIterations ?? 100));
					if (!Number.isInteger(count) || count < 0 || count > maximum)
						throw new Error(`Repeat count must be between 0 and ${maximum}.`);
					items = Array.from({ length: count }, (_, index) => index);
				}
				if (items.length > 100) throw new Error('Loops are limited to 100 iterations.');
				state.childRunIds ??= [];
				for (let index = 0; index < items.length; index++) {
					if (signal.aborted) throw new Error('Cancelled.');
					const child = await this.startRun(id, {
						parentRunId: run.id,
						inputs: {
							...inputs,
							...object(config.inputs),
							value: items[index],
							item: items[index],
							index,
							iteration: index + 1,
						},
						trigger: { kind: 'subworkflow', key: `${run.id}:${node.id}:${index}` },
					});
					if (!state.childRunIds.includes(child.id)) state.childRunIds.push(child.id);
					if (signal.aborted) {
						if (!this.closed) await this.cancelRun(child.id);
						throw new Error('Cancelled.');
					}
					if (state.attempt > 1 && ['failed', 'interrupted', 'cancelled'].includes(child.status))
						await this.resumeRun(child.id, { retry: true });
				}
				if (!items.length) return { value: [], items: [] };
				state.status = 'waiting';
				state.waitReason = 'Waiting for subworkflow runs';
				return undefined;
			}
		}
		return this.options.execute(node, inputs, {
			run: structuredClone(run),
			workflow: structuredClone(run.workflowSnapshot),
			signal,
			onProgress: (progress) => {
				state.waitReason = progress.slice(0, 2000);
				this.changed();
			},
		});
	}
	async cancelRun(id: string): Promise<void> {
		const run = this.runs.get(id);
		if (!run) throw new Error('Workflow run not found.');
		if (['completed', 'cancelled'].includes(run.status)) return;
		this.controllers.get(id)?.abort();
		this.queue = this.queue.filter((queued) => queued !== id);
		run.status = 'cancelled';
		run.finishedAt = this.now();
		for (const node of Object.values(run.nodes))
			if (['pending', 'running', 'waiting'].includes(node.status)) {
				node.status = 'cancelled';
				node.finishedAt = this.now();
			}
		await this.persist(run);
		for (const child of this.runs.values())
			if (child.parentRunId === id && !TERMINAL.has(child.status)) await this.cancelRun(child.id);
		this.pump();
	}
	async resumeRun(
		id: string,
		options: { nodeId?: string; value?: unknown; retry?: boolean } = {},
	): Promise<void> {
		const run = this.runs.get(id);
		if (!run) throw new Error('Workflow run not found.');
		if (this.executing.has(id)) throw new Error('This run is still active.');
		if (options.retry) {
			if (!['failed', 'interrupted', 'cancelled'].includes(run.status))
				throw new Error('Only failed, interrupted, or cancelled runs can be retried.');
			for (const node of Object.values(run.nodes))
				if (['failed', 'interrupted', 'cancelled'].includes(node.status)) {
					node.status = 'pending';
					delete node.error;
					delete node.finishedAt;
				}
		} else {
			if (run.status !== 'waiting') throw new Error('This run is not waiting.');
			const selected = Object.values(run.nodes).filter(
				(node) =>
					node.status === 'waiting' &&
					!node.childRunIds?.length &&
					(!options.nodeId || node.nodeId === options.nodeId),
			);
			if (!selected.length) throw new Error('No waiting step is available to resume.');
			for (const node of selected) {
				node.output = {
					...node.inputs,
					value: options.value ?? node.inputs?.value ?? node.inputs?.input ?? true,
					approved: options.value !== false,
				};
				node.status = 'completed';
				node.finishedAt = this.now();
				delete node.waitUntil;
				delete node.waitReason;
			}
		}
		run.status = 'queued';
		delete run.error;
		delete run.finishedAt;
		await this.persist(run);
		this.enqueue(id, true);
		this.pump();
	}
	async tick(): Promise<void> {
		if (this.closed) return;
		for (const run of this.runs.values()) {
			if (run.status !== 'waiting' || this.executing.has(run.id)) continue;
			let changed = false;
			for (const node of Object.values(run.nodes)) {
				if (node.status !== 'waiting') continue;
				if (node.loop && node.childRunIds?.length) {
					const child = this.runs.get(node.childRunIds[node.loop.iterations]);
					if (!child) {
						node.status = 'failed';
						node.error = 'A feedback round is missing.';
						changed = true;
					} else if (child.status === 'completed') {
						node.status = 'pending';
						changed = true;
					} else if (['failed', 'interrupted', 'cancelled'].includes(child.status)) {
						node.status = child.status === 'interrupted' ? 'interrupted' : 'failed';
						node.error = child.error ?? `Feedback round ${child.status}.`;
						changed = true;
					}
				} else if (node.childRunIds?.length) {
					const children = node.childRunIds.map((id) => this.runs.get(id));
					if (children.some((child) => !child)) {
						node.status = 'failed';
						node.error = 'A subworkflow run is missing.';
						changed = true;
					} else if (
						children.some(
							(child) => child && ['failed', 'cancelled', 'interrupted'].includes(child.status),
						)
					) {
						const failed = children.find(
							(child) => child && ['failed', 'cancelled', 'interrupted'].includes(child.status),
						)!;
						node.status = failed.status === 'interrupted' ? 'interrupted' : 'failed';
						node.error = failed.error ?? `Subworkflow ${failed.status}.`;
						changed = true;
					} else if (children.every((child) => child!.status === 'completed')) {
						const values = children.map((child) => child!.outputs ?? {}),
							type = run.workflowSnapshot.nodes.find((item) => item.id === node.nodeId)?.type;
						node.status = 'completed';
						node.output = {
							value: type === 'subworkflow' ? values[0] : values,
							items: values,
							runs: node.childRunIds,
						};
						node.finishedAt = this.now();
						changed = true;
					}
				} else if (node.waitUntil !== undefined && node.waitUntil <= this.now()) {
					node.status = 'completed';
					node.output = { ...node.inputs, value: node.inputs?.value ?? node.inputs?.input ?? true };
					node.finishedAt = this.now();
					delete node.waitUntil;
					changed = true;
				}
			}
			if (changed) {
				const failed = Object.values(run.nodes).find((node) =>
					['failed', 'interrupted'].includes(node.status),
				);
				if (failed) {
					for (const sibling of Object.values(run.nodes))
						if (sibling.status === 'waiting' && sibling.childRunIds?.length) {
							sibling.status = 'interrupted';
							sibling.error = 'A parallel step failed. Retry resumes this subworkflow too.';
						}
					run.error = failed.error;
					run.finishedAt = this.now();
					for (const child of this.runs.values())
						if (child.parentRunId === run.id && !TERMINAL.has(child.status))
							await this.cancelRun(child.id);
				}
				// Expose retry only after sibling cancellation has settled.
				run.status = failed
					? failed.status === 'interrupted'
						? 'interrupted'
						: 'failed'
					: 'queued';
				await this.persist(run);
				if (!failed) this.enqueue(run.id, true);
			}
		}
		this.pump();
	}
	async emit(name: string, payload: Record<string, unknown> = {}): Promise<WorkflowRun[]> {
		const result: WorkflowRun[] = [];
		for (const workflow of this.workflows.values())
			if (workflow.enabled) {
				for (const node of workflow.nodes.filter(
					(node) =>
						node.type === 'event' && String(node.config.event ?? node.config.name ?? '') === name,
				)) {
					const filter = object(node.config.filter);
					if (
						Object.entries(filter).some(
							([key, value]) =>
								JSON.stringify(workflowPath(payload, key)) !== JSON.stringify(value),
						)
					)
						continue;
					result.push(
						await this.startRun(workflow.id, {
							inputs: payload,
							trigger: { kind: 'event', nodeId: node.id, name, payload },
						}),
					);
				}
			}
		return result;
	}
	private refreshWatchers(): void {
		for (const [key, timer] of this.eventTimers) {
			const captured = this.eventTimerDefinitions.get(key);
			const current = captured && this.workflows.get(captured.workflowId);
			try {
				if (current?.enabled && this.triggerDefinitionHash(current) === captured?.hash) continue;
			} catch { /* An invalid dependency makes the pending event stale. */ }
			clearTimeout(timer);
			this.eventTimers.delete(key);
			this.eventTimerDefinitions.delete(key);
		}
		for (const watcher of this.watchers) watcher.close();
		this.watchers = [];
		if (!this.initialized || this.closed) return;
		for (const workflow of this.workflows.values())
			if (workflow.enabled)
				for (const node of workflow.nodes) {
					if (node.type !== 'event' || !node.config.path) continue;
					try {
						const generation = this.triggerDefinitionHash(workflow);
						const watcher = watch(
							String(node.config.path),
							{ persistent: false },
							(eventType, filename) => {
								const key = `${workflow.id}:${node.id}`;
								const previous = this.eventTimers.get(key);
								if (previous) clearTimeout(previous);
								this.eventTimerDefinitions.set(key, { workflowId: workflow.id, hash: generation });
								this.eventTimers.set(
									key,
									setTimeout(
										() => {
											this.eventTimers.delete(key);
											this.eventTimerDefinitions.delete(key);
											const payload = {
												path: String(node.config.path),
												filename: filename?.toString(),
												eventType,
											};
											void this.startRun(workflow.id, {
													expectedDefinitionHash: generation,
												inputs: payload,
												trigger: { kind: 'event', nodeId: node.id, name: 'file.changed', payload },
											}).catch((error) => this.options.onError?.(error));
										},
										Math.max(100, Number(node.config.debounceMs ?? 500)),
									),
								);
							},
						);
						watcher.on('error', (error) => this.options.onError?.(error));
						this.watchers.push(watcher);
					} catch (error) {
						this.options.onError?.(new Error(`File trigger “${node.label}”: ${message(error)}`));
					}
				}
	}
	async dispose(): Promise<void> {
		this.closed = true;
		if (this.timer) clearInterval(this.timer);
		for (const watcher of this.watchers) watcher.close();
		for (const timer of this.eventTimers.values()) clearTimeout(timer);
		this.eventTimers.clear();
		this.eventTimerDefinitions.clear();
		await this.scheduler.dispose();
		for (const [id, controller] of this.controllers) {
			controller.abort();
			const run = this.runs.get(id)!;
			if (run.status === 'running') {
				run.status = 'interrupted';
				run.error = 'FreeLM stopped during execution. Review the active step before retrying.';
				for (const node of Object.values(run.nodes))
					if (node.status === 'running') {
						node.status = 'interrupted';
						node.error = run.error;
					}
				await this.store.saveRun(run);
			}
		}
		await Promise.allSettled([this.startSerial, this.bindingSerial, this.definitionSerial]);
		await this.store.flush();
	}
}
