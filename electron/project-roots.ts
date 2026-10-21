import type { AppState, Project, Thread } from '../src/types';
import type { ToolSettings } from '../src/agent-types';
import { homedir } from 'node:os';
import { defaultToolSettings, normalizeCodePermissionMode } from '../src/lib/tool-settings';
import { validProjectDirectories } from '../src/lib/project-directories';
import { projectKind, threadKind } from '../src/lib/conversation-kind';
export { validProjectDirectories } from '../src/lib/project-directories';

export interface ProjectToolScope {
	settings: ToolSettings;
	settingsFingerprint: string;
	projectFingerprint: string;
	executionFingerprint: string;
}

/** Pure selection; filesystem existence is checked by file/process tools when used. */
export function projectToolScope(state: AppState | null, threadId: string): ProjectToolScope {
	const thread = state?.threads.find((thread) => thread.id === threadId);
	if (!thread)
		throw new Error('Save the chat before starting its tools. The chat may no longer exist.');
	if (threadKind(thread, state?.projects) !== 'code')
		throw new Error(
			'Work tools are available only in Code conversations. Start a Code task to use them.',
		);
	const stored = state?.toolSettings ?? defaultToolSettings();
	const settings = structuredClone(stored);
	// Effective roots are host-derived and never accepted from persistent tool settings.
	delete settings.workspaceRoots;
	delete settings.workspacePathsUnrestricted;
	settings.approvalMode = normalizeCodePermissionMode(thread.permissionMode ?? stored.approvalMode);
	let directories: string[];
	if (thread.projectId) {
		const project = state?.projects.find((project) => project.id === thread.projectId);
		if (!project)
			throw new Error(
				'This chat’s project no longer exists. Choose another project before using tools.',
			);
		directories = project.directories ?? [];
		if (!validProjectDirectories(directories))
			throw new Error('Project directories must be distinct absolute paths.');
	} else directories = settings.workspaceRoot ? [settings.workspaceRoot] : [];
	// Project directories are task context, not an OS sandbox. The host gates access
	// before execution, and a task without bound folders starts in the user's home.
	settings.workspaceRoot = directories[0] ?? homedir();
	settings.workspaceRoots = [...directories];
	settings.workspacePathsUnrestricted = true;
	return {
		settings,
		settingsFingerprint: JSON.stringify(stored),
		executionFingerprint: JSON.stringify({
			kind: 'code',
			projectId: thread.projectId ?? null,
			directories,
		}),
		projectFingerprint: JSON.stringify({
			projectId: thread.projectId ?? null,
			directories,
			permissionMode: settings.approvalMode,
			connectionId: thread.connectionId,
			model: thread.model,
			thinkingMode: thread.thinkingMode,
		}),
	};
}

/** Connected clients can organize project records but cannot grant host file access. */
export function assertRemoteProjectDirectories(previous: Project[], next: Project[]): void {
	const bindings = new Map(previous.map((project) => [project.id, project.directories ?? []]));
	const kinds = new Map(previous.map((project) => [project.id, projectKind(project)]));
	for (const project of next) {
		if (kinds.has(project.id) && kinds.get(project.id) !== projectKind(project))
			throw new Error('Project kinds must be changed on the host computer.');
		const before = bindings.get(project.id) ?? [];
		if (JSON.stringify(before) !== JSON.stringify(project.directories ?? []))
			throw new Error('Project directories must be configured on the host computer.');
	}
}

/** A remote edit must not repoint an existing chat into a different host execution scope. */
export function assertRemoteProjectAssignments(previous: AppState, next: AppState): void {
	const threads = new Map(previous.threads.map((thread) => [thread.id, thread]));
	const roots = (state: AppState, thread: Thread) =>
		thread.projectId
			? (state.projects.find((project) => project.id === thread.projectId)?.directories ?? [])
			: state.toolSettings?.workspaceRoot
				? [state.toolSettings.workspaceRoot]
				: [];
	for (const thread of next.threads) {
		const before = threads.get(thread.id);
		if (threadKind(thread, next.projects) === 'code') {
			const defaultMode = previous.toolSettings?.approvalMode;
			if (
				normalizeCodePermissionMode(thread.permissionMode ?? defaultMode) !==
				normalizeCodePermissionMode(before?.permissionMode ?? defaultMode)
			)
				throw new Error('Code permissions must be changed on the host computer.');
		}
		if (before && threadKind(before, previous.projects) !== threadKind(thread, next.projects))
			throw new Error('Conversation kinds must be changed on the host computer.');
		if (
			before &&
			before.projectId !== thread.projectId &&
			JSON.stringify(roots(previous, before)) !== JSON.stringify(roots(next, thread))
		)
			throw new Error(
				'Moving a chat between project directories must be done on the host computer.',
			);
	}
}
