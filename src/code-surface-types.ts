/** A user-driven file/review operation confined to the selected Code task's host roots. */
export interface CodeSurfaceRequest {
	workspaceId: string;
	threadId?: string;
	projectId?: string;
	action: 'list' | 'read' | 'write' | 'diff' | 'preview';
	path?: string;
	content?: string;
	revision?: string;
	review?: 'uncommitted' | 'staged' | 'unstaged';
}

export interface CodeSurfaceRoot {
	path: string;
	name: string;
}
export interface CodeSurfaceEntry {
	name: string;
	path: string;
	kind: 'file' | 'directory';
	size?: number;
}
export interface CodeSurfaceListResult {
	kind: 'list';
	roots: CodeSurfaceRoot[];
	path?: string;
	entries: CodeSurfaceEntry[];
	truncated: boolean;
	notices: string[];
}
export interface CodeSurfaceFileResult {
	kind: 'file';
	path: string;
	name: string;
	size: number;
	/** SHA-256 of the complete bytes when readable. Required for optimistic saves. */
	revision: string;
	editable: boolean;
	content?: string;
	image?: { dataUrl: string; mimeType: string };
	truncated: boolean;
	unavailable?: string;
}
export interface CodeSurfaceSavedResult {
	kind: 'saved';
	path: string;
	revision: string;
	size: number;
}
export interface CodeSurfacePreviewResult {
	kind: 'preview';
	path: string;
	html: string;
	/** Local desktop replaces the transportable document with an isolated, short-lived URL. */
	url?: string;
	notices: string[];
}
export interface CodeSurfaceDiffResult {
	kind: 'diff';
	/** The selected authorized directory; the diff never broadens to its parent repository. */
	path: string;
	review: 'uncommitted' | 'staged' | 'unstaged';
	diff: string;
	truncated: boolean;
	notices: string[];
}
export type CodeSurfaceResult =
	| CodeSurfaceListResult
	| CodeSurfaceFileResult
	| CodeSurfaceSavedResult
	| CodeSurfaceDiffResult
	| CodeSurfacePreviewResult;
