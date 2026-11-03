import type { ToolBridge } from './agent-types';
import type { ComposerContext } from './composer-types';
import type { ChatMemorySettings, SavedMemory, ThreadMemorySummary } from './memory-types';
import type { PersonalizationSettings } from './personalization-types';
import type { BotBridge } from './bot-types';
import type { BotTaskRendererBridge } from './bot-task-types';
import type { PluginBridge } from './plugin-types';

export type ConversationKind = 'chat' | 'code';
export type WorkspaceMode =
	ConversationKind | 'bots' | 'workflows' | 'images' | 'videos' | 'audio' | 'plugins';
export type ModelKind = 'chat' | 'images' | 'videos' | 'speech' | 'transcription';
export type Modality = 'text' | 'image' | 'audio' | 'video';
export type AppearanceAccent =
	'default' | 'blue' | 'green' | 'yellow' | 'pink' | 'orange' | 'purple' | 'white' | 'custom';
export interface AppearanceSettings {
	accent: AppearanceAccent;
	customAccent: string;
}
export type JsonValue =
	string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export interface ThinkingMode {
	/** Explicit opt-in; only empty, configured endpoint mappings send no tuning parameters. */
	useProviderDefaults?: boolean;
	id: string;
	name: string;
	parameters: { responses?: Record<string, JsonValue>; chat?: Record<string, JsonValue> };
}
export interface ImageAspectRatioPreset {
	id: string;
	name: string;
	width: number;
	height: number;
}
export interface ImageQualityPreset {
	id: string;
	name: string;
	/** Optional literal provider value. The display name is never sent as API quality. */
	quality?: string;
	aspectRatios: ImageAspectRatioPreset[];
	defaultAspectRatio?: string;
}
export interface ModelDefinition {
	id: string;
	name: string;
	enabled: boolean;
	tasks: ModelKind[];
	inputModalities: Modality[];
	outputModalities: Modality[];
	thinkingModes: ThinkingMode[];
	defaultThinkingMode?: string;
	/** Total model context capacity in tokens. Unset uses FreeLM's fallback budget. */
	contextWindow?: number;
	imagePresets?: ImageQualityPreset[];
	defaultImagePreset?: string;
}
export interface Connection {
	providerAdapter?: { pluginId: string; accountId: string; providerId: string; credentialHeader: 'authorization' | 'x-api-key' };
	id: string;
	name: string;
	baseUrl: string;
	apiKey: string;
	chatApi: 'responses' | 'chat/completions' | 'chat';
	models: Record<ModelKind, string>;
	discoveredModels: string[];
	catalog?: ModelDefinition[];
}
export interface Attachment {
	name: string;
	type: string;
	dataUrl: string;
}
export interface ReplyReference {
	messageId: string;
	/** Snapshot of the selected text, retained when conversation versions change. */
	text: string;
}
export interface ChatDraft {
	composer?: ComposerContext;
	content: string;
	attachments: Attachment[];
	replyTo?: ReplyReference;
	updatedAt: number;
}
/** Pending Code input remains editable until it joins an active model request. */
export interface QueuedCodeMessage {
	composer?: ComposerContext;
	id: string;
	content: string;
	attachments?: Attachment[];
	replyTo?: ReplyReference;
	createdAt: number;
}
/** Failure state references accepted inputs; their content and attachments stay in history. */
export interface CodeQueueFailure {
	id: string;
	assistantId: string;
	messageIds: string[];
	error: string;
	failedAt: number;
}
/** Persisted before an accepted queued input is sent to the provider. */
export interface CodeQueueDelivery {
	assistantId: string;
	messageIds: string[];
	startedAt: number;
}
export interface DictationSettings {
	enabled: boolean;
	connectionId: string;
	model: string;
}
/** Shared Code policy, applied to each model's own context capacity. */
export interface CodeCompactionSettings {
	thresholdPercent: number;
	reserveTokens: number;
}
export interface Message {
	composer?: ComposerContext;
	id: string;
	role: 'user' | 'assistant';
	content: string;
	createdAt: number;
	/** Conversation-tree parent. Missing on legacy messages until the first tree operation. */
	parentId?: string | null;
	attachments?: Attachment[];
	replyTo?: ReplyReference;
	error?: string;
	interrupted?: boolean;
	model?: string;
	thinkingMode?: string;
	toolCalls?: import('./agent-types').ToolCallRecord[];
	agentTranscript?: import('./agent-types').AgentTranscript;
	phase?: 'working' | 'responding' | 'tools' | 'compacting';
	/** First final-answer text timestamp, excluding the time spent streaming that answer. */
	activityFinishedAt?: number;
	completedAt?: number;
	activity?: import('./agent-types').ChatActivityPart[];
}
export interface Thread {
	id: string;
	kind?: ConversationKind;
	title: string;
	titleSource?: 'pending' | 'generated' | 'manual';
	projectId?: string;
	connectionId: string;
	model: string;
	thinkingMode?: string;
	/** Code tool permissions, enforced by the execution host. */
	permissionMode?: import('./agent-types').CodePermissionMode;
	/** Durable Code objective, independent of model context compaction. */
	goal?: import('./lib/code-goals').CodeGoal;
	messages: Message[];
	/** Uncommitted Code follow-ups, in submission order. */
	queuedMessages?: QueuedCodeMessage[];
	codeQueueFailures?: CodeQueueFailure[];
	codeQueueDelivery?: CodeQueueDelivery;
	/** Inactive conversation paths. Active messages remain in messages for provider compatibility. */
	messageHistory?: Message[];
	branchedFrom?: { threadId: string; messageId: string };
	archivedAt?: number;
	temporary?: boolean;
	createdAt: number;
	updatedAt: number;
	pinned?: boolean;
	memorySummary?: ThreadMemorySummary;
}
export interface Project {
	kind?: ConversationKind;
	/** Ordered host directories; the first is the default tool working directory. */
	directories?: string[];
	id: string;
	name: string;
	instructions: string;
	createdAt: number;
}
export interface MediaAsset {
	url: string;
	mimeType: string;
	name: string;
}
export interface Generation {
	id: string;
	kind: 'images' | 'videos' | 'speech' | 'transcription';
	prompt: string;
	model: string;
	connectionId: string;
	createdAt: number;
	status: 'pending' | 'completed' | 'failed' | 'cancelled';
	assets: MediaAsset[];
	text?: string;
	error?: string;
	remoteId?: string;
	progress?: number;
	/** Host warnings attached to this generation, independent of later settings changes. */
	moderationWarnings?: string[];
	parameters?: Record<string, string | number>;
}
export interface AppState {
	version: 1;
	connections: Connection[];
	activeConnectionId: string;
	threads: Thread[];
	projects: Project[];
	generations: Generation[];
	theme: 'dark' | 'light' | 'system';
	appearance?: AppearanceSettings;
	debugMode?: boolean;
	systemPrompt?: string;
	thinkingPresets?: ThinkingMode[];
	toolSettings?: import('./agent-types').ToolSettings;
	memorySettings?: ChatMemorySettings;
	savedMemories?: SavedMemory[];
	personalization?: PersonalizationSettings;
	chatDrafts?: Record<string, ChatDraft>;
	dictation?: DictationSettings;
	backgroundNotifications?: boolean;
	botResponseSound?: import('./notification-types').BotResponseSound;
	codeCompaction?: CodeCompactionSettings;
	/** Optional media classifiers and user-selected enforcement policy. */
	moderation?: import('./moderation-types').ModerationSettingsInput;
}
export interface WireFile {
	name: string;
	type: string;
	base64: string;
}
export interface WireRequest {
	/** Fail closed if the saved adapter binding is missing. */
	providerAdapterRequired?: boolean;
	/** Renderer requests may identify Chat or Code only; bot identity is host-owned. */
	providerCaller?: import('./plugin-types').PluginCaller;
	workspaceId?: string;
	connectionId?: string;
	id: string;
	baseUrl: string;
	apiKey: string;
	path: string;
	method: 'GET' | 'POST';
	body?: Record<string, unknown>;
	form?: { name: string; value?: string; file?: WireFile }[];
	stream?: boolean;
}
export interface WireResponse {
	status: number;
	contentType: string;
	body: string;
	encoding: 'text' | 'base64';
	/** Generation proceeded without a usable configured moderation evaluator. */
	moderationWarnings?: string[];
	/** Counts read by the transport, independent of renderer event delivery. */
	stream?: { bytes: number; characters: number };
}
export interface DesktopBridge
	extends
		ToolBridge,
		BotBridge,
		BotTaskRendererBridge,
		Partial<PluginBridge>,
		Partial<import('./scheduler-types').SchedulerBridge>,
		Partial<import('./plugin-surface-types').PluginSurfaceBridge> {
	onOpenScheduler?(listener: () => void): () => void;
	schedulerTakeNavigation?(): Promise<boolean>;
	workflowSnapshot?(scope?: {
		bindingId?: string;
		projectId?: string;
	}): Promise<import('./workflow-types').WorkflowSnapshot>;
	workflowBindings?(): Promise<import('./workflow-types').WorkflowBindingSummary[]>;
	workflowCommand?(
		command: import('./workflow-types').WorkflowCommand,
	): Promise<import('./workflow-types').WorkflowSnapshot>;
	onWorkflowsChanged?(listener: () => void): () => void;
	workflowAsset?(runId: string, path: string): Promise<string>;
	workflowThreadCompleted?(input: {
		threadId: string;
		title: string;
		workspaceId: string;
	}): Promise<void>;
	/** Create a new local project folder under ~/Documents/FreeLM. */
	projectCreateDirectory?(name: string): Promise<string>;
	workspaceTransfer?: import('./desktop-workspace-types').WorkspaceTransferBridge;
	clipboardWriteText?(text: string): Promise<void>;
	computerSetup?(
		action: 'request' | 'accessibility' | 'screen-recording' | 'helper',
	): Promise<import('./computer-types').ComputerStatus>;
	computerStatus?(): Promise<import('./computer-types').ComputerStatus>;
	computerSessions?(): Promise<import('./computer-types').ComputerSessionPreview[]>;
	computerStop?(sessionId: string): Promise<void>;
	onComputerPreview?(
		listener: (preview: import('./computer-types').ComputerSessionPreview) => void,
	): () => void;
	composerDiscover?(
		request: import('./composer-types').ComposerDiscoveryRequest,
	): Promise<import('./composer-types').ComposerDiscoveryResult>;
	composerResolve?(
		workspaceId: string,
		threadId: string,
		messageId: string,
	): Promise<import('./composer-types').ComposerResolutionResult>;
	codeSurface?(
		request: import('./code-surface-types').CodeSurfaceRequest,
	): Promise<import('./code-surface-types').CodeSurfaceResult>;
	codeBrowser?(
		request: import('./code-browser-types').CodeBrowserRequest,
	): Promise<import('./code-browser-types').CodeBrowserResult>;
	onCodeBrowserState?(
		listener: (state: import('./code-browser-types').CodeBrowserState) => void,
	): () => void;
	onCodeBrowserElement?(
		listener: (selection: import('./code-browser-types').CodeBrowserSelection) => void,
	): () => void;
	taskOutputStatus?(
		workspaceId: string,
		threadId: string,
	): Promise<import('./task-output-types').TaskOutputStatusResult>;
	taskOutputRead?(
		workspaceId: string,
		threadId: string,
		outputId: string,
	): Promise<import('./task-output-types').TaskOutputReadResult>;
	platform: string;
	request(request: WireRequest): Promise<WireResponse>;
	onChunk(listener: (event: { id: string; text: string }) => void): () => void;
	cancel(id: string): Promise<void>;
	load(): Promise<AppState | null>;
	save(state: AppState): Promise<void>;
	storageInfo(): Promise<{ secure: boolean; location: string; checked?: boolean }>;
	onPrepareClose(listener: () => void): () => void;
	completeClose(): Promise<void>;
	workspaceLoad(targetId: string): Promise<import('./remote-types').WorkspaceSnapshot>;
	workspaceSave(targetId: string, revision: string, state: AppState): Promise<{ revision: string }>;
	workspacePatch?(
		targetId: string,
		revision: string,
		patch: import('./workspace-patch').WorkspacePatch,
	): Promise<{ revision: string }>;
    localPairingStatus?(): Promise<import('./mobile-types').LocalPairingStatus>;
    localPairingStart?(options: {endpoint:string;bindAddress:string;initialize:boolean}): Promise<import('./mobile-types').LocalPairingStatus>;
    localPairingInvite?(): Promise<import('./mobile-types').LocalPairingInvitation>;
    localPairingDecide?(requestId:string,keyHash:string,approve:boolean): Promise<import('./mobile-types').LocalPairingStatus>;
    localPairingRevoke?(): Promise<import('./mobile-types').LocalPairingStatus>;
    localPairingStop?(): Promise<import('./mobile-types').LocalPairingStatus>;
    mobileStatus?(): Promise<import('./mobile-types').MobileStatus>;
    mobileStart?(options: { endpoint: string; bindAddress: string }): Promise<import('./mobile-types').MobileStatus | null>;
    mobileStop?(): Promise<void>;
    mobileInvite?(): Promise<import('./mobile-types').MobileInvitation>;
    mobileRevoke?(id: string): Promise<void>;
	instanceStatus(): Promise<import('./remote-types').InstanceOverview>;
	hostStart(options: { name: string; port: number }): Promise<import('./remote-types').HostStatus>;
	hostStop(): Promise<void>;
	instanceConnect(input: import('./remote-types').RemoteInstanceInput): Promise<{
		instance: import('./remote-types').RemoteInstance;
		snapshot: import('./remote-types').WorkspaceSnapshot;
	}>;
	instanceOpen(id: string): Promise<import('./remote-types').WorkspaceSnapshot>;
	instanceDisconnect(id: string): Promise<void>;
	instanceRemove(id: string): Promise<void>;
	instanceAsset(
		workspaceId: string,
		connectionId: string,
		url: string,
		kind?: 'image' | 'video',
	): Promise<WireResponse>;
	workspaceBackup(state: AppState): Promise<string>;
	notifyCompletion?(input: {
		threadId: string;
		title: string;
		workspaceId?: string;
		runId?: string;
	}): Promise<void>;
	onNotificationOpen?(
		listener: (destination: import('./notification-types').NotificationDestination) => void,
	): () => void;
	notificationReady?(): Promise<import('./notification-types').NotificationDestination | null>;
	onBotResponseSound?(listener: (volume: number, kind?: 'message') => void): () => void;
	onOpenThread?(listener: (threadId: string) => void): () => void;
}
declare global {
	interface Window {
		desktop?: DesktopBridge;
		desktopNative?: DesktopBridge;
	}
}
