import type { CodePermissionMode, ToolDefinition } from './agent-types';

export type WorkflowNodeType =
	| 'custom'
	| 'entry'
	| 'schedule'
	| 'event'
	| 'text'
	| 'agent'
	| 'image'
	| 'video'
	| 'audio'
	| 'transcribe'
	| 'tool'
	| 'code'
	| 'thread'
	| 'condition'
	| 'foreach'
	| 'join'
	| 'repeat'
	| 'loop'
	| 'wait'
	| 'subworkflow'
	| 'value'
	| 'context'
	| 'transform'
	| 'media-transform'
	| 'state'
	| 'collection'
	| 'output'
	| 'save'
	| 'notify';
export type WorkflowDataType =
	| 'any'
	| 'text'
	| 'number'
	| 'boolean'
	| 'object'
	| 'list'
	| 'image'
	| 'video'
	| 'audio'
	| 'file'
	| 'signal';
export interface WorkflowPort {
	id: string;
	label: string;
	type: WorkflowDataType;
	required?: boolean;
}
export interface WorkflowNode {
 custom?: import('./custom-node-types').CustomNodeReference;
	id: string;
	type: WorkflowNodeType;
	label: string;
	position: { x: number; y: number };
	config: Record<string, unknown>;
}
export interface WorkflowEdge {
	id: string;
	source: string;
	target: string;
	sourceHandle?: string;
	targetHandle?: string;
}
/** Reusable request contract; callers supply the same named fields from UI, tools, or triggers. */
export interface WorkflowRequestField {
	key: string;
	label: string;
	type: 'text' | 'number' | 'boolean' | 'object' | 'list';
	required?: boolean;
	defaultValue?: unknown;
}
export interface WorkflowRequest {
	prompt: { key: string; label?: string; placeholder?: string; required?: boolean };
	fields?: WorkflowRequestField[];
}
export interface WorkflowBindingSettings {
	connectionId?: string;
	model?: string;
	thinkingMode?: string;
	permissionMode?: CodePermissionMode;
}
export interface WorkflowProjectContext {
	id: string;
	name: string;
	directories: string[];
	instructions: string;
}
export interface WorkflowProjectBinding {
	id: string;
	hostId: 'local';
	projectId: string;
	workflowId: string;
	name?: string;
	revision: number;
	/** Pinned library version; editing the library never silently changes project behavior. */
	workflowSnapshot: WorkflowDefinition;
	dependencySnapshots: Record<string, WorkflowDefinition>;
	settings?: WorkflowBindingSettings;
	defaultInputs?: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
}
export type WorkflowBindingSummary = Pick<
	WorkflowProjectBinding,
	'id' | 'projectId' | 'workflowId' | 'hostId' | 'revision'
> & { name: string };
export interface WorkflowAttachOptions {
	workflowId: string;
	workflow?: WorkflowDefinition;
	dependencies?: WorkflowDefinition[];
	projectId: string;
	bindingId?: string;
	name?: string;
	settings?: WorkflowBindingSettings;
	defaultInputs?: Record<string, unknown>;
}
export interface WorkflowBindingPatch {
	name?: string;
	settings?: WorkflowBindingSettings;
	defaultInputs?: Record<string, unknown>;
	expectedRevision?: number;
	/** Project-only graph revision; the reusable library definition is unchanged. */
	workflow?: WorkflowDefinition;
	dependencies?: WorkflowDefinition[];
}
export interface WorkflowDefinition {
	version: 1;
	id: string;
	name: string;
	description?: string;
	request?: WorkflowRequest;
	enabled: boolean;
	revision?: number;
	nodes: WorkflowNode[];
	edges: WorkflowEdge[];
	viewport?: { x: number; y: number; zoom: number };
	settings?: { workspaceRoot?: string; permissionMode?: CodePermissionMode; concurrency?: number };
	createdAt: number;
	updatedAt: number;
}
export type WorkflowRunStatus =
	'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type WorkflowNodeStatus =
	| 'pending'
	| 'running'
	| 'waiting'
	| 'completed'
	| 'failed'
	| 'cancelled'
	| 'skipped'
	| 'interrupted';
export interface WorkflowNodeRun {
	nodeId: string;
	status: WorkflowNodeStatus;
	inputs?: Record<string, unknown>;
	output?: Record<string, unknown>;
	error?: string;
	startedAt?: number;
	finishedAt?: number;
	attempt: number;
	waitUntil?: number;
	waitReason?: string;
	childRunIds?: string[];
	/** Durable feedback accumulator; a child is admitted only after its predecessor finishes. */
	loop?: { value: unknown; items: unknown[]; iterations: number; stopped: boolean };
}
export interface WorkflowTrigger {
	kind: 'manual' | 'schedule' | 'event' | 'subworkflow';
	nodeId?: string;
	name?: string;
	payload?: Record<string, unknown>;
	key?: string;
}
export interface WorkflowRun {
	id: string;
	workflowId: string;
	workflowName: string;
	workflowSnapshot: WorkflowDefinition;
	nodes: Record<string, WorkflowNodeRun>;
	status: WorkflowRunStatus;
	inputs: Record<string, unknown>;
	trigger: WorkflowTrigger;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	outputs?: Record<string, unknown>;
	error?: string;
	parentRunId?: string;
	/** Shared investigation scope inherited by every nested run. */
	rootRunId?: string;
	bindingId?: string;
	projectId?: string;
	sourceThreadId?: string;
	requestId?: string;
	projectContext?: WorkflowProjectContext;
	bindingSettings?: WorkflowBindingSettings;
	permissionMode?: CodePermissionMode;
	/** Complete pinned dependency closure, also inherited by child runs. */
	dependencySnapshots?: Record<string, WorkflowDefinition>;
}
export interface WorkflowAsset {
	kind: 'image' | 'video' | 'audio' | 'file';
	name: string;
	mimeType: string;
	/** Absolute path on the owning host; media is not serialized into graph edges. */
	path: string;
}
export interface WorkflowSnapshot {
	definitionVersions?: Record<string, { revision: number; contentHash: string }>;
	definitionErrors?: { file: string; message: string }[];
 customNodeDiscovery?:{packageId:string;version:string;result:unknown};
 customNodes?: import('./custom-node-types').InstalledCustomNode[];
	/** This host's configured models. Credentials are never included. */
	connections?: import('./types').Connection[];
	projects?: import('./types').Project[];
	bindings?: WorkflowProjectBinding[];
	workflows: WorkflowDefinition[];
	runs: WorkflowRun[];
	tools?: ToolDefinition[];
	skills?: { id?: string; name: string; description: string; path: string }[];
	version: 1;
	hostId: 'local';
}
export type WorkflowCommand =
	| { type: 'refresh-definitions' }
 | {type:'discover-custom-node';packageId:string;version:string;digest:string;config:Record<string,unknown>}
 | {type:'authorize-custom-node';packageId:string;version:string;digest:string;network:string[];inference:boolean}
 | {type:'set-custom-node-secret';packageId:string;version:string;digest:string;name:string;value:string;origin:string;header?:string;prefix?:string}
 | { type: 'install-custom-node'; source: string }
 | { type: 'remove-custom-node'; packageId: string; version: string }
		| { type: 'save'; workflow: WorkflowDefinition; expectedRevision?: number; expectedContentHash?: string }
	| { type: 'delete'; id: string }
	| ({ type: 'attach' } & WorkflowAttachOptions)
	| ({ type: 'update-binding'; bindingId: string } & WorkflowBindingPatch)
	| { type: 'detach'; bindingId: string }
	| {
			type: 'run';
			id: string;
			bindingId?: string;
			inputs?: Record<string, unknown>;
			entryNodeId?: string;
			sourceThreadId?: string;
			requestId?: string;
	  }
	| { type: 'cancel'; runId: string }
	| { type: 'resume'; runId: string; nodeId?: string; value?: unknown }
	| { type: 'retry'; runId: string }
	| { type: 'emit'; name: string; payload?: Record<string, unknown> }
	| { type: 'catalog'; workflowId?: string; bindingId?: string; projectId?: string };

/** Host adapter contract. Configuration comes from the saved graph, never from model output. */
export interface WorkflowExecutionContext {
	run: WorkflowRun;
	workflow: WorkflowDefinition;
	signal: AbortSignal;
	onProgress?: (message: string) => void;
}
export type WorkflowNodeExecutor = (
	node: WorkflowNode,
	inputs: Record<string, unknown>,
	context: WorkflowExecutionContext,
) => Promise<Record<string, unknown>>;

/** Generic durable record, with provenance preserved independently of model-produced data. */
export interface WorkflowCollectionRecord {
	id: string;
	data: unknown;
	revision: number;
	createdAt: number;
	updatedAt: number;
	provenance: { runId: string; nodeId: string; workflowId: string };
}
export interface WorkflowCollectionRequest {
	scope: 'run' | 'workflow';
	scopeId: string;
	name: string;
	operation: 'list' | 'get' | 'upsert' | 'append' | 'delete';
	recordId?: string;
	value?: unknown;
	expectedRevision?: number;
	filter?: Record<string, unknown>;
	query?: string;
	limit?: number;
	offset?: number;
	/** Stable across retries, including a restart between commit and run checkpoint. */
	mutationId: string;
	provenance: WorkflowCollectionRecord['provenance'];
}
