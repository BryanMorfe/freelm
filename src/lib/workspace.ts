// Request routing is captured when a request starts, never inferred from provider URLs.
let activeWorkspaceId = 'local';
export function currentWorkspaceId() {
	return activeWorkspaceId;
}
export function activateWorkspace(id: string) {
	activeWorkspaceId = id;
}
