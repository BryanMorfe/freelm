/** Explicit user selections, retained with drafts, queued inputs and messages. */
export type ComposerMode = 'goal' | 'plan';
export interface ComposerReference {
	kind: 'file' | 'folder' | 'skill' | 'app';
	id: string;
	label: string;
	icon?: string;
	path: string;
	/** Exact serialized inline mention in the Markdown document. */
	token: string;
}
export interface ComposerContext {
	mode?: ComposerMode;
	references?: ComposerReference[];
}
export interface ComposerSuggestion {
	kind: 'file' | 'folder' | 'skill' | 'app';
	id: string;
	label: string;
	icon?: string;
	path: string;
	description?: string;
}
export interface ComposerDiscoveryRequest {
	workspaceId: string;
	/** Local context capabilities are available only in Code. */
	conversationKind: 'code';
	threadId?: string;
	projectId?: string;
	kind: 'files' | 'skills' | 'apps';
	query: string;
}
export interface ComposerDiscoveryResult {
	items: ComposerSuggestion[];
	warnings?: string[];
}
export interface ComposerResolutionResult {
	instructions: string;
	warnings?: string[];
}
