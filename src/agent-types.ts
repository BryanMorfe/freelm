export type CodePermissionMode = 'ask' | 'auto-review' | 'full-access';

export interface CodeActionDecision {
	approved: boolean;
	reason: string;
	/** An unavailable reviewer has not made an authorization decision. */
	reviewError?: {
		code: 'configuration' | 'context' | 'unavailable' | 'invalid_response';
		attempts: number;
	};
}

export type ToolApprovalResponse = boolean | { approved: boolean; remember?: boolean };

/** Host-owned configuration. Never accept these settings from a model tool call. */
export interface ToolSettings {
	enabled: boolean;
	workspaceRoot: string;
	/** Effective host-derived roots for a chat; never used to grant access from model input. */
	workspaceRoots?: string[];
	commandExecution: boolean;
	/** Explicit local Computer Use opt-in; never inferred from shell permissions. */
	computerUse?: { enabled: boolean };
	/** trusted is a persisted legacy alias for full-access. */
	approvalMode: CodePermissionMode | 'trusted';
	/** Host-derived for approved Code actions; never a grant from model arguments. */
	workspacePathsUnrestricted?: boolean;
	allowRemote?: boolean;
	/** Isolated Chat Python interpreter, separate from local Code commands. */
	pythonExecution?: { enabled: boolean };
	/** Optional for compatibility with configurations saved before web tools were added. */
	webBrowsing?: {
		enabled: boolean;
		searxngUrl: string;
		/** Missing mode preserves existing external-server configurations. */
		mode?: 'builtin' | 'external';
		autoStart?: boolean;
		/** Defaults for the bundled service; the external service remains host-managed. */
		engines?: string[];
	};
	imageGeneration: {
		enabled: boolean;
		connectionId: string;
		model: string;
		size: string;
		quality: string;
	};
	/** Optional for configurations created before video generation tools were added. */
	videoGeneration?: {
		enabled: boolean;
		connectionId: string;
		model: string;
		size: string;
		seconds: string;
	};
	mcpServers: MCPServerConfig[];
	skillDirectories: string[];
}
export interface MCPServerConfig {
	id: string;
	name: string;
	enabled: boolean;
	transport: 'stdio' | 'http';
	command?: string;
	args?: string[];
	url?: string;
	/** Secret values remain in the host environment, never in workspace JSON. */
	bearerTokenEnv?: string;
	env?: Record<string, string>;
}
export interface ToolDefinition {
	name: string;
	displayName?: string;
	description: string;
	parameters: Record<string, unknown>;
	source: 'builtin' | 'mcp' | 'skill' | 'plugin';
	requiresApproval?: boolean;
	/** Execution scheduling hint; async tools return a durable job in Bots. */
	execution?: 'sync' | 'async';
	/** Descriptive risk metadata; never overrides host authorization. */
	readOnly?: boolean;
	effect?: 'read' | 'write' | 'external' | 'destructive' | 'unknown';
	deferred?: boolean;
}
export interface WebServiceInfo {
	serviceUrl: string;
	version?: string;
	categories: string[];
	engines: {
		name: string;
		enabled: boolean;
		categories: string[];
		paging: boolean;
		timeRangeSupport: boolean;
		safeSearch: boolean;
	}[];
	health: 'ok' | 'unavailable';
	notices: string[];
}
export interface SearchServiceStatus {
	phase: 'stopped' | 'starting' | 'running' | 'stopping' | 'error' | 'unavailable';
	url?: string;
	version?: string;
	engines: WebServiceInfo['engines'];
	selectedEngineNames: string[];
	message?: string;
	logExcerpt?: string;
}
export type ToolContent =
	| { type: 'text'; text: string }
	| { type: 'image'; dataUrl: string; name?: string; purpose?: 'computer' }
	| { type: 'file'; dataUrl: string; name: string; mimeType: string };
export interface ToolFileChange {
	kind: 'add' | 'update' | 'delete' | 'move';
	path: string;
	previousPath?: string;
	/** Absent for binary or legacy changes whose line counts are unknown. */
	addedLines?: number;
	removedLines?: number;
}
/** Host-observed file effects for the task Outputs list, never supplied by model arguments. */
export interface ToolOutputFileChange {
	kind: 'add' | 'update' | 'delete' | 'move';
	/** Canonical absolute host path. */
	path: string;
	previousPath?: string;
	size?: number;
	modifiedAt?: number;
}
export interface ToolResult {
	content: ToolContent[];
	/** Host-verified app session metadata. Screen previews remain ephemeral. */
	computer?: { sessionId: string; app: import('./computer-types').ComputerApp };
	isError?: boolean;
	/** Host-owned generation warnings; also included in model-facing text. */
	moderationWarnings?: string[];
	/** Host-owned authorization outcome, separate from an error produced by the tool. */
	approvalDenied?: {
		reason: string;
		permissionMode?: CodePermissionMode;
		effectiveDirectory?: string;
	};
	/** The action was not executed because review could not complete, not because it was denied. */
	approvalReviewError?: {
		reason: string;
		code: NonNullable<CodeActionDecision['reviewError']>['code'];
		attempts: number;
		permissionMode?: CodePermissionMode;
		effectiveDirectory?: string;
	};
	/** Host process metadata for activity labels; kept outside model-facing text. */
	process?: {
		command: string;
		/** Stable across exec_command and subsequent write_stdin calls. */
		sessionId: string;
		/** Present only after the process closes, including signal termination (null). */
		exitCode?: number | null;
	};
	/** Tools discovered during this call become available on the next model turn. */
	discoveredTools?: ToolDefinition[];
	research?: import('./research-types').ResearchResults;
	/** Successful patch metadata from existing snapshots, outside model-facing text. */
	fileChanges?: ToolFileChange[];
	/** Confirmed patch effects or bounded filesystem observations around approved commands. */
	outputFiles?: ToolOutputFileChange[];
	/** Coverage limits of automatic output discovery, separate from tool errors. */
	outputTrackingNotices?: string[];
}
export interface ToolCallRecord {
	id: string;
	name: string;
	arguments: string;
	status: 'running' | 'approval' | 'completed' | 'failed' | 'denied';
	result?: ToolResult;
	startedAt: number;
	completedAt?: number;
}
export interface AgentContextCheckpoint {
	version: 1;
	/** Legacy checkpoints are compactions. Explicit resets need not reduce token count. */
	kind?: 'compaction' | 'reset';
	api: 'responses' | 'chat';
	model: string;
	connectionId: string;
	/** Exact active path before the assistant message that owns this checkpoint. */
	historyMessageIds: string[];
	/** Original transcript items already represented by the compacted context. */
	transcriptItemCount: number;
	items: Record<string, unknown>[];
	createdAt: number;
	compactionCount: number;
	inputTokensBefore: number;
	inputTokensAfter: number;
}
export interface AgentContextUsage {
	version: 1;
	model: string;
	connectionId: string;
	/** Exact active path before the assistant that owns this usage sample. */
	historyMessageIds: string[];
	/** Local estimate of the model request whose provider input usage was reported. */
	estimatedInputTokens: number;
	inputTokens: number;
}
export interface AgentTranscript {
	api: 'responses' | 'chat';
	/** Provider protocol items, including call IDs and matching results, for replay. */
	items: Record<string, unknown>[];
	/** Model-facing continuity state; original items remain available in history. */
	context?: AgentContextCheckpoint;
	/** Latest provider usage for this exact context, retained across user turns and reloads. */
	usage?: AgentContextUsage;
	/** Immutable recovery boundaries; summaries never replace the original items. */
	contextWindows?: {
		id: string;
		transcriptItemCount: number;
		historyMessageIds: string[];
		createdAt: number;
		kind: 'compaction' | 'reset';
	}[];
}
export interface AgentUpdate {
	content: string;
	toolCalls: ToolCallRecord[];
	transcript: AgentTranscript;
	phase?: 'working' | 'responding' | 'tools' | 'compacting';
	/** Published once the final model round is known to contain no further tool calls. */
	activityFinishedAt?: number;
	activity?: ChatActivityPart[];
}
export type ChatActivityPart =
	{ type: 'text'; id: string; text: string } | { type: 'tool'; id: string; toolCallId: string };
/** Source-labelled context supplied by the host/user, separate from application policy. */
export interface PromptContextSection {
	id: string;
	source: string;
	text: string;
}
export interface ToolCatalog {
	/** Host supports Code lifecycle authorization and durable knowledge tools. */
	codeCapabilities?: 1;
	/** Host enforces the Code planning workflow before tool execution. */
	codePlanMode?: 1;
	tools: ToolDefinition[];
	instructions: string;
	context?: PromptContextSection[];
	warnings: string[];
	skills?: { id?: string; name: string; description: string; path: string }[];
}
export interface ToolHostRequest {
	workspaceId: string;
	runId: string;
	threadId: string;
	name: string;
	arguments: Record<string, unknown>;
	recentImages?: import('./types').Attachment[];
}
export interface ToolApproval {
	id: string;
	runId: string;
	name: string;
	arguments: Record<string, unknown>;
	message: string;
	computer?: import('./computer-types').ComputerPermission;
	threadId?: string;
	permissionMode?: CodePermissionMode;
	effectiveDirectory?: string;
	rememberLabel?: string;
	cancelled?: boolean;
}
export interface InteractionRequest {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}
export interface ToolBridge {
	toolCatalog(
		workspaceId: string,
		runId: string,
		threadId: string,
		temporary?: boolean,
		claimTask?: boolean,
	): Promise<ToolCatalog>;
	toolExecute(request: ToolHostRequest): Promise<ToolResult>;
	toolCancel(runId: string): Promise<void>;
	toolRelease?(runId: string, interrupted?: boolean): Promise<void>;
	toolApprove(id: string, approved: boolean, remember?: boolean): Promise<void>;
	onToolApproval(listener: (approval: ToolApproval) => void): () => void;
	toolPickDirectory(): Promise<string | null>;
	toolInspect(settings: ToolSettings): Promise<ToolCatalog>;
	/** Discover this computer's selected SearXNG service without saving settings. */
	toolWebDiscover?(url: string): Promise<WebServiceInfo>;
	searchStatus?(): Promise<SearchServiceStatus>;
	/** Starts the trusted bundled service using the saved host configuration. */
	searchStart?(): Promise<SearchServiceStatus>;
	searchStop?(): Promise<SearchServiceStatus>;
	onSearchStatus?(listener: (status: SearchServiceStatus) => void): () => void;
}
