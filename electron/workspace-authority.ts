import { persistentWorkspace } from '../src/lib/temporary-chats';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AppState, Thread } from '../src/types';
import type { ToolSettings } from '../src/agent-types';
import type { WorkspaceSnapshot } from '../src/remote-types';
import { StateStore } from './state-store';
import { validateState } from './validation';
import { applyWorkspacePatch, assertWorkspacePatch, workspaceFields } from '../src/workspace-patch';
import { assertRemoteProjectAssignments, assertRemoteProjectDirectories } from './project-roots';
import { threadKind } from '../src/lib/conversation-kind';
import { normalizeJson } from '../src/json-normalize';
import { projectToolScope } from './project-roots';
import { codeReviewMessages, codeReviewProjectionOmissions } from './code-review-context';
import type { ComposerHostScope, ComposerScopeRequest } from './composer-context';
import { projectKind } from '../src/lib/conversation-kind';

export class WorkspaceConflictError extends Error {
	constructor() {
		super(
			'WORKSPACE_CONFLICT: This workspace changed on another client. Reload it before saving again.',
		);
		this.name = 'WorkspaceConflictError';
	}
}

/** The single writer shared by the host UI and every connected client. */
export class WorkspaceAuthority {
	private queue: Promise<void> = Promise.resolve();
	private initialized = false;
	private state: AppState | null = null;
	private epoch = randomUUID();
	private sequence = 0;

	constructor(private readonly store: StateStore) {}
	private readonly listeners = new Set<() => void>();
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Trusted in-process writers share this queue with every UI/client save. */
	mutate<T>(update: (state: AppState) => { state: AppState; value: T }): Promise<T> {
		return this.serialize(async () => {
			if (!this.state) throw new Error('Initialize the workspace before running a task.');
			const changed = update(this.snapshot(false));
			validateState(changed.state);
			await this.commit(normalizeJson(changed.state), this.revision, false);
			return changed.value;
		});
	}

	/** Compact checkpoint identity; does not clone or hydrate workspace media. */
	currentRevision(): string {
		return this.revision;
	}

	private get revision() {
		return `${this.epoch}:${this.sequence}`;
	}

	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.queue.then(async () => {
			if (!this.initialized) {
				this.state = await this.store.load();
				this.initialized = true;
			}
			return operation();
		});
		this.queue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	load(remote = false): Promise<WorkspaceSnapshot> {
		return this.serialize(async () => ({
			revision: this.revision,
			state: this.state ? this.snapshot(remote) : null,
		}));
	}
	/** Search lifecycle reads only its host-owned configuration, never API credentials or media. */
	loadNotificationPreferences() {
		return this.serialize(async () => ({
			backgroundNotifications: this.state?.backgroundNotifications,
			botResponseSound: this.state?.botResponseSound,
		}));
	}
	loadSearchSettings(): Promise<ToolSettings['webBrowsing']> {
		return this.serialize(async () => structuredClone(this.state?.toolSettings?.webBrowsing));
	}
	/** Project routing for workflows excludes credentials, conversation bodies, and media. */
	loadWorkflowContext() {
		return this.serialize(async () => ({
			projects: structuredClone(this.state?.projects ?? []),
			threads: (this.state?.threads ?? []).map((thread) => ({
				id: thread.id,
				kind: threadKind(thread, this.state!.projects),
				projectId: thread.projectId,
				archivedAt: thread.archivedAt,
				temporary: thread.temporary,
			})),
		}));
	}
	/** Bots need bounded text history and host model settings, never gallery payloads or tool traces. */
	loadBotState(): Promise<AppState | null> {
		return this.serialize(async () => {
			if (!this.state) return null;
			return {
				version: 1,
				connections: structuredClone(this.state.connections),
				activeConnectionId: this.state.activeConnectionId,
				theme: this.state.theme,
				generations: [],
				projects: this.state.projects.map(({ id, name, kind, createdAt }) => ({
					id,
					name,
					kind,
					createdAt,
					instructions: '',
				})),
				threads: this.state.threads
					.filter((thread) => !thread.temporary)
					.sort((a, b) => b.updatedAt - a.updatedAt)
					.slice(0, 30)
					.map((thread) => ({
						id: thread.id,
						title: thread.title,
						kind: thread.kind,
						projectId: thread.projectId,
						connectionId: thread.connectionId,
						model: thread.model,
						createdAt: thread.createdAt,
						updatedAt: thread.updatedAt,
						memorySummary: structuredClone(thread.memorySummary),
						messages: thread.messages.slice(-12).map(({ id, role, content, createdAt }) => ({
							id,
							role,
							content: content.slice(0, 4000),
							createdAt,
						})),
					})),
			};
		});
	}
	/** Composer metadata never copies galleries, API credentials, or the complete task history. */
	loadComposerState(request: ComposerScopeRequest): Promise<ComposerHostScope> {
		return this.serialize(async () => {
			const thread = request.threadId
				? this.state?.threads.find((item) => item.id === request.threadId)
				: undefined;
			if (request.threadId && !thread) throw new Error('This Code task no longer exists.');
			if (thread && request.projectId !== undefined && request.projectId !== thread.projectId)
				throw new Error('The Code composer project changed. Open the context picker again.');
			const projectId = thread?.projectId ?? request.projectId;
			const project = projectId
				? this.state?.projects.find((item) => item.id === projectId)
				: undefined;
			if (projectId && !project) throw new Error('The selected Code project no longer exists.');
			const kind = thread
				? threadKind(thread, this.state!.projects)
				: project
					? projectKind(project)
					: 'code';
			if (kind !== 'code')
				throw new Error('Workspace and skill mentions are available only in Code.');
			const settings = this.state?.toolSettings;
			const message = request.messageId
				? thread?.messages.find((item) => item.id === request.messageId && item.role === 'user')
				: undefined;
			if (request.messageId && !message)
				throw new Error('The selected user message is no longer on this Code task’s active path.');
			return {
				projectId,
				kind,
				roots: [
					...(project
						? (project.directories ?? [])
						: settings?.workspaceRoot
							? [settings.workspaceRoot]
							: []),
				],
				skillDirectories: [...(settings?.skillDirectories ?? [])],
				allowRemote: settings?.allowRemote === true,
				...(message
					? {
							message: {
								id: message.id,
								content: message.content,
								references: structuredClone(message.composer?.references ?? []),
							},
						}
					: {}),
			};
		});
	}
	/** Original Code history, including pre-compaction replay; no API configuration. */
	loadCodeHistory(threadId: string): Promise<Thread> {
		return this.serialize(async () => {
			const thread = this.state?.threads.find((item) => item.id === threadId);
			if (!thread || threadKind(thread, this.state!.projects) !== 'code')
				throw new Error('Code task history is unavailable.');
			return {
				...thread,
				messages: thread.messages.map((message) => ({ ...message, attachments: undefined })),
				messageHistory: thread.messageHistory?.map((message) => ({
					...message,
					attachments: undefined,
				})),
			};
		});
	}

	/** File preview needs only this task's recorded file effects, never credentials or galleries. */
	loadTaskOutputState(threadId: string): Promise<{
		thread: Pick<Thread, 'id' | 'messages' | 'messageHistory'>;
		workspaceRoot?: string;
		workspaceRoots: string[];
	}> {
		return this.serialize(async () => {
			projectToolScope(this.state, threadId);
			const thread = this.state!.threads.find((item) => item.id === threadId)!;
			const project = this.state!.projects.find((item) => item.id === thread.projectId);
			const configuredRoots = thread.projectId
				? (project?.directories ?? [])
				: this.state!.toolSettings?.workspaceRoot
					? [this.state!.toolSettings.workspaceRoot]
					: [];
			const projectMessage = (message: Thread['messages'][number]) => ({
				id: message.id,
				role: message.role,
				content: '',
				createdAt: message.createdAt,
				toolCalls: message.toolCalls
					?.filter((call) => ['apply_patch', 'exec_command', 'write_stdin'].includes(call.name))
					.map((call) => ({
						id: call.id,
						name: call.name,
						arguments: call.result?.outputFiles
							? ''
							: call.arguments.slice(0, 5 * 1024 * 1024 + 1024),
						status: call.status,
						startedAt: call.startedAt,
						completedAt: call.completedAt,
						...(call.result
							? {
									result: {
										isError: call.result.isError,
										approvalDenied: call.result.approvalDenied,
										approvalReviewError: call.result.approvalReviewError,
										fileChanges: call.result.fileChanges,
										outputFiles: call.result.outputFiles,
										content: call.result.content
											.filter(
												(part) => part.type === 'text' && part.text.startsWith('Applied patch:\n'),
											)
											.slice(0, 1),
									},
								}
							: {}),
					})),
			});
			return structuredClone({
				thread: {
					id: thread.id,
					messages: thread.messages.map(projectMessage),
					messageHistory: thread.messageHistory?.map(projectMessage),
				},
				workspaceRoot: configuredRoots[0],
				workspaceRoots: configuredRoots,
			});
		});
	}

	/** Tool configuration needs project/thread identity, not transcripts or media blobs. */
	loadModerationState(): Promise<Pick<AppState, 'connections' | 'moderation'>> {
		return this.serialize(async () => {
			if (!this.state) throw new Error('Load the workspace before generating media.');
			return structuredClone({
				connections: this.state.connections,
				moderation: this.state.moderation,
			});
		});
	}

	loadToolState(): Promise<AppState | null> {
		return this.serialize(async () =>
			this.state
				? structuredClone({
						...this.state,
						generations: [],
						chatDrafts: {},
						threads: this.state.threads.map((thread) => {
							const kind = threadKind(thread, this.state!.projects);
							let planningInput: Thread['messages'][number] | undefined;
							if (kind === 'code')
								for (let index = thread.messages.length - 1; index >= 0; index--) {
									const message = thread.messages[index];
									if (message.role !== 'user') continue;
									if (message.composer?.mode === 'plan') planningInput = message;
									break;
								}
							return {
								...thread,
								kind,
								// The host must retain the committed mode for execution
								// admission without copying any request text or media.
								messages: planningInput
									? [
											{
												id: planningInput.id,
												role: 'user' as const,
												content: '',
												createdAt: planningInput.createdAt,
												composer: { mode: 'plan' as const },
											},
										]
									: [],
								messageHistory: [],
							};
						}),
					})
				: null,
		);
	}

	/** Approval alone needs the selected task's human requests, never another task's history. */
	loadCodeReviewState(threadId: string): Promise<AppState | null> {
		return this.serialize(async () => {
			const state = this.state;
			const thread = state?.threads.find((candidate) => candidate.id === threadId);
			if (!state || !thread) return null;
			const project = state.projects.find((candidate) => candidate.id === thread.projectId);
			const reviewMessages = codeReviewMessages(thread.messages);
			const image = state.toolSettings?.imageGeneration;
			const video = state.toolSettings?.videoGeneration;
			const connectionIds = new Set([
				thread.connectionId,
				...(image?.enabled ? [image.connectionId] : []),
				...(video?.enabled ? [video.connectionId] : []),
			]);
			const connections = state.connections
				.filter((connection) => connectionIds.has(connection.id))
				.map((connection) => {
					const modelIds = new Set([
						...(connection.id === thread.connectionId ? [thread.model] : []),
						...(image?.enabled && connection.id === image.connectionId ? [image.model] : []),
						...(video?.enabled && connection.id === video.connectionId ? [video.model] : []),
					]);
					return {
						...connection,
						discoveredModels: connection.discoveredModels.filter((model) => modelIds.has(model)),
						...(connection.catalog
							? { catalog: connection.catalog.filter((model) => modelIds.has(model.id)) }
							: {}),
					};
				});
			return structuredClone({
				version: state.version,
				theme: state.theme,
				activeConnectionId: thread.connectionId,
				connections,
				projects: project ? [project] : [],
				generations: [],
				...(state.toolSettings ? { toolSettings: state.toolSettings } : {}),
				threads: [
					{
						id: thread.id,
						kind: threadKind(thread, state.projects),
						title: thread.title,
						projectId: thread.projectId,
						connectionId: thread.connectionId,
						model: thread.model,
						thinkingMode: thread.thinkingMode,
						permissionMode: thread.permissionMode,
						createdAt: thread.createdAt,
						updatedAt: thread.updatedAt,
						messages: reviewMessages,
						...{
							reviewEvidenceOmissions: codeReviewProjectionOmissions(
								thread.messages,
								reviewMessages,
							),
						},
					},
				],
			} satisfies AppState);
		});
	}

	save(state: AppState, expectedRevision: string, remote = false): Promise<{ revision: string }> {
		validateState(state);
		// Keep canonical snapshots in the same shape as durable storage and the HTTP
		// protocol. Optional properties set to undefined disappear over JSON; retaining
		// them in memory would falsely reject an unchanged remote connection catalog.
		const snapshot = normalizeJson(state);
		return this.serialize(() => this.commit(snapshot, expectedRevision, remote));
	}

	/** Only the changed fields cross IPC or undergo JSON normalization. */
	patch(value: unknown, expectedRevision: string): Promise<{ revision: string }> {
		assertWorkspacePatch(value);
		const captured = normalizeJson(value);
		return this.serialize(() => {
			if (!this.state) throw new Error('Initialize the workspace before applying a patch.');
			assertWorkspacePatch(captured);
			const snapshot = applyWorkspacePatch(this.state, captured);
			validateState(snapshot, this.state);
			return this.commit(snapshot, expectedRevision, false);
		});
	}

	private async commit(snapshot: AppState, expectedRevision: string, remote: boolean) {
		snapshot = persistentWorkspace(snapshot);
		if (remote) {
			const redacted = this.state?.connections.map((connection) => ({ ...connection, apiKey: '' }));
			if (!this.state || !isDeepStrictEqual(snapshot.connections, redacted)) {
				if (expectedRevision !== this.revision) throw new WorkspaceConflictError();
				throw new Error('API connections must be configured on the host computer.');
			}
			snapshot.connections = this.state.connections;
			if (!isDeepStrictEqual(snapshot.toolSettings, this.state.toolSettings))
				throw new Error('Tools, MCP servers, and skills must be configured on the host computer.');
			assertRemoteProjectDirectories(this.state.projects, snapshot.projects);
			assertRemoteProjectAssignments(this.state, snapshot);
		}
		// Reuse canonical immutable values even when an older client sent a full save.
		// StateStore can then reuse encoded media without serializing it on each chat edit.
		if (this.state)
			for (const key of workspaceFields) {
				if (isDeepStrictEqual(snapshot[key], this.state[key])) {
					const fields = snapshot as unknown as Record<string, unknown>;
					if (Object.hasOwn(this.state, key)) fields[key] = this.state[key];
					else delete fields[key];
				}
			}
		// An autosave of unchanged data must not invalidate another client's revision.
		if (isDeepStrictEqual(snapshot, this.state)) return { revision: this.revision };
		if (expectedRevision !== this.revision) throw new WorkspaceConflictError();
		// Canonical snapshots are private and immutable after this handoff.
		await this.store.saveSnapshot(snapshot, this.state ?? undefined);
		this.state = snapshot;
		this.sequence += 1;
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				/* Observers never invalidate a committed save. */
			}
		}
		return { revision: this.revision };
	}

	private snapshot(remote: boolean): AppState {
		const copy = normalizeJson(this.state!);
		if (remote) for (const connection of copy.connections) connection.apiKey = '';
		return copy;
	}
}
