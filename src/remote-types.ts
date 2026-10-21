import type { AppState, WireRequest } from './types';

export interface WorkspaceSnapshot {
	state: AppState | null;
	revision: string;
	/** Negotiated transport metadata; never part of the persisted workspace. */
	memorySupported?: boolean;
	/** Negotiated transport metadata; never persisted. */
	personalizationSupported?: boolean;
	/** Whether the remote host persists global Code compaction policy. */
	codeCompactionSupported?: boolean;
	/** Host evaluates generated media before returning it. */
	moderationSupported?: boolean;
	/** Whether host-owned task output files can be read through the authenticated bridge. */
	taskOutputsSupported?: boolean;
	/** Whether the host verifies task output existence and physical file identities. */
	taskOutputStatusSupported?: boolean;
	/** Host-backed workspace and skill composer references. */
	composerContextSupported?: boolean;
	/** Host-scoped Code files, explicit edits, and Git review. */
	codeSurfaceSupported?: boolean;
}
export interface RemoteInstanceInput {
	id?: string;
	name: string;
	transport: 'ssh' | 'direct';
	sshHost?: string;
	port?: number;
	url?: string;
	token?: string;
}
export interface RemoteInstance extends Omit<RemoteInstanceInput, 'token' | 'id'> {
	id: string;
	instanceId?: string;
	connected: boolean;
	hasToken: boolean;
}
export interface HostStatus {
	running: boolean;
	name: string;
	instanceId: string;
	port: number;
	token?: string;
}
export interface InstanceOverview {
	host: HostStatus;
	instances: RemoteInstance[];
}
export interface RemoteInfo {
	bots?: 1;
	botNotifications?: 1;
	/** Streams bot activity separately from the final text message. */
	botActivity?: 1;
	/** Group roster, host-qualified mentions, and optional group-message replies. */
	botGroups?: 1;
	/** Preserves reaction-triggered restrictions through group-message follow-ups. */
	botGroupReadOnly?: 1;
	/** Accepts owner/revision metadata for remembering shared group conversations. */
	botGroupRecollection?: 1;
	/** Accepts bot-authored group outreach and read-only replies rooted in it. */
	botGroupOutreach?: 1;
	/** Stores, learns, and manages durable per-bot knowledge independently of transcripts. */
	botMemory?: 1;
	/** Durable Bot jobs and explicit messages delivered before a run completes. */
	botRuntime?: 1;
	botTasks?: 1;
	protocol: 1;
	instanceId: string;
	name: string;
	conversationModes?: true;
	chatMemory?: true;
	personalization?: true;
	codeCompaction?: true;
	mediaModeration?: true;
	/** Host evaluator requests use strict API JSON-schema output. */
	moderationStructuredOutput?: true;
	/** Independent image/video policies and warnings for missing evaluator configuration. */
	moderationPolicies?: 1;
	/** Image edits evaluate reference images together with the requested transformation. */
	moderationImageEdits?: 1;
	/** Video output is evaluated as one image frame per second. */
	moderationVideoFrames?: 1;
	/** Classifies video prompts together with their reference images before generation. */
	moderationVideoReferences?: 1;
	taskOutputs?: true;
	taskOutputStatus?: true;
	composerContext?: 1;
	codeSurface?: 1;
}
export interface RemoteWireRequest extends Omit<WireRequest, 'baseUrl' | 'apiKey' | 'workspaceId'> {
	connectionId: string;
}
