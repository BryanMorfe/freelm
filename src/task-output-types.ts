/** A user-requested, bounded read of a file recorded in a Code task's Outputs. */
export interface TaskOutputReadResult {
	id: string;
	name: string;
	path: string;
	size?: number;
	mimeType?: string;
	preview?: { kind: 'text'; text: string; truncated: boolean } | { kind: 'image'; dataUrl: string };
	/** Always a data URL; never a host filesystem URL or executable application target. */
	downloadUrl?: string;
	unavailable?: string;
}

/** Host-verified filesystem metadata; never includes file contents. */
export interface TaskOutputFileStatus {
	id: string;
	/** False also covers unsafe or unverified paths, which should not be shown as available. */
	exists: boolean;
	canonicalPath?: string;
	/** Physical file identity on this host, with canonical path as a fallback. */
	identity?: string;
	unavailable?: string;
}
export interface TaskOutputStatusResult {
	threadId: string;
	files: TaskOutputFileStatus[];
	notices: string[];
	truncated: boolean;
	checkedAt: number;
}
