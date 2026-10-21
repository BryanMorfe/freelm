import type { AppState, ConversationKind, Project, Thread } from '../types';

export function projectKind(project: Project): ConversationKind {
	return project.kind ?? (project.directories?.length ? 'code' : 'chat');
}

export function threadKind(thread: Thread, projects: readonly Project[] = []): ConversationKind {
	if (thread.kind) return thread.kind;
	if (thread.messages.some((message) => message.toolCalls?.length || message.agentTranscript))
		return 'code';
	const project = projects.find((project) => project.id === thread.projectId);
	return project ? projectKind(project) : 'chat';
}

/** Materialize legacy classifications without changing conversation contents or project links. */
export function migrateConversationKinds(state: AppState): AppState {
	const projects = state.projects.some((project) => project.kind === undefined)
		? state.projects.map((project) =>
				project.kind === undefined ? { ...project, kind: projectKind(project) } : project,
			)
		: state.projects;
	const threads = state.threads.some((thread) => thread.kind === undefined)
		? state.threads.map((thread) =>
				thread.kind === undefined ? { ...thread, kind: threadKind(thread, projects) } : thread,
			)
		: state.threads;
	return projects === state.projects && threads === state.threads
		? state
		: { ...state, projects, threads };
}
