import type { ProviderTransformInput, ProviderTransformOutput } from '../../src/provider-types';
/** FreeLM Plugin API. The installer supplies this module; no npm install is required. */
export type JSONValue =
	null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };
export interface PluginFetchOptions {
	method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
	headers?: Record<string, string>;
	body?: string;
	/** Inject the host-owned OAuth bearer for the manifest's exact auth.apiOrigin. */
	authenticated?: boolean;
}
export interface PluginContext {
	/** Stable host action identity. Use it with provider idempotency support; this alone does not guarantee exactly-once effects. */
	readonly operationId?: string;
	readonly account: { readonly id: string; readonly label: string };
	readonly storage: {
		get(key: string): Promise<JSONValue | null>;
		set(key: string, value: JSONValue): Promise<void>;
		remove(key: string): Promise<void>;
	};
	/** Requests only declared origins. Response bodies are bounded; redirects are not followed. */
	fetch(
		url: string,
		options?: PluginFetchOptions,
	): Promise<{
		status: number;
		headers: Record<string, string>;
		body: string;
	}>;
}
export type PluginHandler = (
	args: Record<string, JSONValue>,
	context: PluginContext,
) => JSONValue | Promise<JSONValue>;
export type { ProviderRequest, ProviderEvent, ProviderResult, ProviderRequestPlan, ProviderTransformInput, ProviderTransformOutput } from '../../src/provider-types';
/** Pure synchronous provider transform; no fetch/storage context. One realm lives for one request. */
export type ProviderTransform = (input: ProviderTransformInput) => ProviderTransformOutput;
export interface PluginDefinition {
 providers?: Record<string, ProviderTransform>;
	tools?: Record<string, PluginHandler>;
	actions?: Record<string, PluginHandler>;
	/** API v2. Bound to one visible composer; callbacks remain in the isolated runtime. */
	activate?(context: SurfaceContext): void | (() => void) | Promise<void | (() => void)>;
}
/** Export this value as default from the runtime entry declared in manifest.json. */
export function definePlugin<T extends PluginDefinition>(definition: T): T {
	return definition;
}

export interface Disposable { dispose(): void }
export interface Registration extends Disposable {
	readonly id: string;
	/** Resolves after the host validates and installs the contribution. */
	readonly ready: Promise<void>;
}
export interface Contribution<Patch> extends Registration { update(patch: Patch): Promise<void> }
export type ModelSelection =
	| { source: 'conversation' }
	| { source: 'configured'; hostId: string; connectionId: string; modelId: string; thinkingModeId: string };
export interface ModelBinding {
	hostId: string; connectionId: string; modelId: string; thinkingModeId: string;
}
export interface SurfaceBinding {
	surface: { kind: 'home'; mode: 'chat' | 'code' };
	workspaceId: string;
	composerId: string;
	threadId?: string;
	model?: ModelBinding;
	plugin: { id: string; name: string };
}
export interface ComposerState {
	revision: number;
	empty: boolean;
	editable: boolean;
	focused: boolean;
	working: boolean;
	running: boolean;
	hasAttachments: boolean;
	hasReply: boolean;
	hasContext: boolean;
	pendingAttachments: boolean;
	queueEditing: boolean;
	hasCompletedTurn: boolean;
	hasQueuedMessages?: boolean;
	awaitingInput?: boolean;
}
export interface SurfaceEvent {
	revision: number;
	sequence?: number;
	origin?: string;
	[key: string]: unknown;
}
export interface AssetHandle { id: string; name: string; mimeType: string; size: number }
export interface ComposerSelection { anchor: number; head: number; text?: string }
export interface ComposerDraft extends ComposerState {
	text: string;
	selection: ComposerSelection;
	attachments: AssetHandle[];
}
export interface ComposerEdit {
	expectedRevision: number;
	changes: { from: number; to: number; insert: string }[];
	selection?: { anchor: number; head: number };
}
export interface PlaceholderOptions {
	id?: string;
	expectedRevision?: number;
	acceptCommand?: string;
	hint?: string;
}
export interface DrawerItem {
	id: string;
	title: string;
	description?: string;
	icon?: string;
	progress?: number;
	dismissible?: boolean;
	actions?: { title: string; command: string }[];
}
export interface DrawerView {
	id: string;
	view: string;
	title?: string;
	props?: Record<string, JSONValue>;
	height?: number;
}
export interface CommandInvocation { composerRevision: number; [key: string]: unknown }
export interface PluginCommand {
	id: string;
	title: string;
	/** Runs atomically in the native editor; never submits a message. */
	action?: { type: 'composer.setText'; text: string; expectedRevision: number };
	run?(invocation: CommandInvocation): void | Promise<void>;
}
export interface PluginKeybinding {
	id?: string;
	key: string;
	command: string;
	when?: { composerFocused?: boolean; composerEmpty?: boolean; contributionVisible?: string };
}
export interface ConversationTurn {
	messages: { id: string; role: 'user' | 'assistant'; text: string; createdAt?: number }[];
}
export interface ConversationSnapshot {
	snapshotId: string;
	revision: string | number;
	turns: ConversationTurn[];
	truncated: boolean;
	omissions?: string[];
}
export interface GenerateTextRequest {
	model: ModelSelection;
	system?: string;
	messages: { role: 'user' | 'assistant'; content: string }[];
	maxOutputTokens?: number;
	snapshotId?: string;
	signal?: AbortSignal;
}
export interface SurfaceContext extends SurfaceBinding {
	readonly signal: AbortSignal;
	/** Reports a recoverable error in plugin diagnostics without stopping the activation. */
	reportError(message: string): Promise<void>;
	readonly events: { on(name: string, callback: (event: SurfaceEvent) => void | Promise<void>): Registration };
	readonly conversation: {
		getTurns(options: { limit: number }): Promise<ConversationSnapshot>;
		onDidCompleteTurn(callback: (event: SurfaceEvent) => void | Promise<void>): Registration;
		onDidChange(callback: (event: SurfaceEvent) => void | Promise<void>): Registration;
	};
	readonly settings: {
		get<T extends Record<string, unknown> = Record<string, JSONValue>>(): Promise<{ revision: number; values: T }>;
	};
	readonly inference: {
		generateText(request: GenerateTextRequest): Promise<{ text: string; model: ModelBinding; usage?: Record<string, number> }>;
	};
	readonly composer: {
		getState(): Promise<ComposerState>;
		readDraft(): Promise<ComposerDraft>;
		getSelection(): Promise<ComposerSelection>;
		onDidChange(callback: (event: SurfaceEvent) => void | Promise<void>): Registration;
		applyEdit(edit: ComposerEdit): Promise<ComposerState>;
		setText(text: string, options: { expectedRevision: number }): Promise<ComposerState>;
		insertText(text: string, options: { expectedRevision: number }): Promise<ComposerState>;
		setPlaceholder(text: string, options?: PlaceholderOptions): Contribution<Partial<PlaceholderOptions> & { text?: string }>;
		readonly drawer: {
			addItem(item: DrawerItem): Contribution<Partial<DrawerItem>>;
			addView(view: DrawerView): Contribution<Partial<DrawerView>>;
		};
		readonly attachments: {
			add(asset: AssetHandle, options: { expectedRevision: number }): Promise<ComposerState>;
			remove(id: string, options: { expectedRevision: number }): Promise<ComposerState>;
			read(id: string): Promise<{ name: string; mimeType: string; text?: string; base64?: string }>;
		};
	};
	readonly assets: {
		create(input: { name: string; mimeType: string; text?: string; base64?: string }): Promise<AssetHandle>;
	};
	readonly commands: { register(command: PluginCommand): Registration };
	readonly keybindings: { register(binding: PluginKeybinding): Registration };
}
