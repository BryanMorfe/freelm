import { randomUUID } from 'node:crypto';
import type {
	AppState,
	Attachment,
	Message,
	Thread,
	WireRequest,
	WireResponse,
} from '../src/types';
import type { ToolCatalog, ToolResult } from '../src/agent-types';
import type { HostTaskSnapshot } from '../src/bot-task-types';
import { validateBotTaskRequest } from '../src/bot-task-types';
import { executeBotTaskTool } from '../src/lib/bot-task-tools';
import { streamAgentChat, type AgentChatOptions } from '../src/lib/agent';
import { buildSystemPrompt } from '../src/lib/system-prompt';
import { conversationInput, recoverState } from '../src/lib/state';
import { threadKind } from '../src/lib/conversation-kind';
import { resolveThinkingMode } from '../src/lib/catalog';
import {
	drainQueuedCodeMessages,
	createCodeQueueFailure,
	addCodeQueueFailure,
} from '../src/lib/code-queue';
import {
	accountGoal,
	executeGoalTool,
	goalTools,
	isGoalTool,
	shouldContinueGoal,
} from '../src/lib/code-goals';
import { codeContextTools } from '../src/lib/code-context-tools';
import {
	codeTaskTools,
	executeCodeTaskTool,
	isCodeTaskTool,
	type CodeTaskStatus,
} from '../src/lib/code-task-tools';
import { composerGoal, latestComposerMode } from '../src/lib/composer-context';
import { codePlanToolDenial } from '../src/lib/code-plan';
import { assertChatToolCall } from '../src/lib/conversation-tools';
import { applyMemoryMutation, executeMemoryTool, isMemoryTool } from '../src/lib/memory-tools';
import { textResult, userQuestions } from '../src/lib/interaction-tools';
import { selectMediaToolReferences } from '../src/lib/media-tool-references';
import { resolveImageToolSize } from '../src/lib/image-tool';
import { resolveVideoToolSize, resolveVideoToolSeconds } from '../src/lib/video-tool';
import { conversationNodes, selectConversationPath } from '../src/lib/conversation-tree';
import type { WorkspaceAuthority } from './workspace-authority';
import type { AgentHost } from './agent-host';

export interface HostTaskServiceOptions {
	authority: WorkspaceAuthority;
	agent: Pick<AgentHost, 'catalog' | 'execute' | 'cancel'>;
	hostId: () => string | Promise<string>;
	request: (
		request: WireRequest,
		onChunk: (text: string) => void,
		signal?: AbortSignal,
	) => Promise<WireResponse>;
	changed?: () => void;
	completed?: (thread: Thread) => void | Promise<void>;
	resolveMentions?: (threadId: string, messageId: string) => Promise<string>;
	/** Test injection still runs the real prompt/state/permission plumbing. */
	stream?: typeof streamAgentChat;
}
interface Running {
	runId: string;
	controller: AbortController;
	completion: Promise<void>;
	status: CodeTaskStatus;
	owner: 'host' | 'renderer' | 'remote';
}
interface PendingQuestion {
	threadId: string;
	runId: string;
	questions: ReturnType<typeof userQuestions>;
	answer: (value: Record<string, { answers: string[] }>) => void;
}

/** Delegated work runs in the host process using the same prompt, protocol loop and tool host. */
export class HostTaskService {
	private readonly runs = new Map<string, Running>();
	private readonly questions = new Map<string, PendingQuestion>();
	private closed = false;
	private closing?: Promise<void>;
	private stopped = new Set<string>();
	private removeObserver: () => void;
	private refreshQueued = false;
	private cachedState: AppState | null = null;
	readonly ready: Promise<void>;
	constructor(private readonly options: HostTaskServiceOptions) {
		this.removeObserver = options.authority.onChange(() => this.scheduleRefresh());
		this.ready = this.initialize();
	}
	private async initialize() {
		const snapshot = await this.options.authority.load();
		if (snapshot.state && recoverState(snapshot.state) !== snapshot.state) {
			await this.options.authority.mutate((state) => ({
				state: recoverState(state),
				value: undefined,
			}));
		}
	}
	private publish() {
		// A closing window is only an observer; notification failures must never
		// interrupt durable background execution or renderer recovery.
		try {
			this.options.changed?.();
		} catch (error) {
			console.error('Host task notification:', error);
		}
	}
	private scheduleRefresh() {
		this.publish();
		if (
			this.refreshQueued ||
			this.closed ||
			![...this.runs.values()].some((run) => run.owner === 'host')
		)
			return;
		this.refreshQueued = true;
		queueMicrotask(() => {
			void this.options.authority
				.load()
				.then((snapshot) => {
					this.cachedState = snapshot.state;
				})
				.finally(() => {
					this.refreshQueued = false;
				});
		});
	}
	private async state(): Promise<AppState> {
		const state = (await this.options.authority.load()).state;
		if (!state) throw new Error('Initialize this computer’s FreeLM workspace first.');
		this.cachedState = state;
		return state;
	}
	snapshot(): HostTaskSnapshot {
		return {
			workspaceRevision: this.options.authority.currentRevision(),
			runs: [...this.runs].map(([threadId, run]) => ({
				threadId,
				runId: run.runId,
				owner: run.owner,
				status: run.status,
				cancelled: run.controller.signal.aborted,
			})),
			questions: [...this.questions].map(([id, question]) => ({
				id,
				threadId: question.threadId,
				runId: question.runId,
				questions: question.questions,
			})),
		};
	}
	/** Compatibility: availability no longer depends on any renderer. */
	setReady(_ready: boolean) {}
	settle(_id: string, _result: unknown) {
		return false;
	}
	async execute(
		name: string,
		args: Record<string, unknown>,
		operationId: string,
		signal?: AbortSignal,
	): Promise<unknown> {
		await this.ready;
		if (this.closed) throw new Error('The task host is shutting down.');
		const request = validateBotTaskRequest({
			id: randomUUID(),
			name,
			arguments: args,
			operationId,
		});
		return executeBotTaskTool(request.name, request.arguments, {
			hostId: await this.options.hostId(),
			operationId,
			signal,
			loadState: () => this.state(),
			mutate: (update) => this.options.authority.mutate(update),
			dispatch: (id) => this.dispatch(id),
			statuses: (ids) => this.statuses(ids),
			cancel: (ids) => this.cancelThreads(ids),
		});
	}
	async statuses(ids: readonly string[]): Promise<Record<string, CodeTaskStatus>> {
		const state = await this.state();
		return Object.fromEntries(
			ids.map((id) => {
				const active = this.runs.get(id);
				const thread = state.threads.find((item) => item.id === id);
				const last = thread?.messages.at(-1);
				return [
					id,
					active?.status ??
						(thread?.queuedMessages?.length
							? 'queued'
							: last?.error ||
								  last?.interrupted ||
								  (last?.role === 'assistant' && !!last.phase && last.completedAt === undefined)
								? 'error'
								: last?.role === 'assistant'
									? 'completed'
									: 'idle'),
				];
			}),
		);
	}
	/** A visible UI runner must claim first so delegation can never launch a competing runner. */
	claimRenderer(threadId: string, runId: string): boolean {
		if (this.closed || this.runs.has(threadId)) return false;
		this.stopped.delete(threadId);
		this.runs.set(threadId, {
			runId,
			owner: 'renderer',
			controller: new AbortController(),
			completion: Promise.resolve(),
			status: 'working',
		});
		this.publish();
		return true;
	}
	async releaseRenderer(threadId: string, runId: string) {
		const active = this.runs.get(threadId);
		if (active?.owner !== 'renderer' || active.runId !== runId) return;
		await this.assertDurableCompletion(threadId);
		if (this.runs.get(threadId) !== active) return;
		this.runs.delete(threadId);
		this.publish();
		if (!this.stopped.has(threadId)) void this.dispatch(threadId);
	}
	/** Connected clients share the same single-run lease, but outlive our local window. */
	claimExternal(threadId: string, runId: string): boolean {
		if (!this.claimRenderer(threadId, runId)) return false;
		this.runs.get(threadId)!.owner = 'remote';
		return true;
	}
	async releaseExternal(runId: string, interrupted = false) {
		const selected = [...this.runs].find(
			([, run]) => run.owner === 'remote' && run.runId === runId,
		);
		if (!selected) return;
		const [id, active] = selected;
		if (!interrupted) await this.assertDurableCompletion(id);
		if (this.runs.get(id) !== active) return;
		this.runs.delete(id);
		if (interrupted) {
			this.stopped.add(id);
			await this.recoverDetached([id]);
		} else if (!this.stopped.has(id)) void this.dispatch(id);
		this.publish();
	}
	async rendererClosed() {
		const detached: string[] = [];
		for (const [id, run] of this.runs)
			if (run.owner === 'renderer') {
				this.runs.delete(id);
				this.stopped.add(id);
				detached.push(id);
			}
		this.publish();
		await this.recoverDetached(detached);
	}
	private async assertDurableCompletion(id: string) {
		const thread = (await this.state()).threads.find((item) => item.id === id);
		const last = thread?.messages.at(-1);
		if (
			last?.role === 'assistant' &&
			last.phase &&
			last.completedAt === undefined &&
			!last.interrupted
		)
			throw new Error('Save the completed response before releasing this task.');
	}
	private async recoverDetached(ids: readonly string[]) {
		if (!ids.length) return;
		await this.options.authority.mutate((state) => {
			const recovered = recoverState(state, {
				activeThreadIds: state.threads
					.filter((thread) => !ids.includes(thread.id))
					.map((thread) => thread.id),
			});
			return { state: { ...state, threads: recovered.threads }, value: undefined };
		});
	}
	noteApproval(runId: string, waiting: boolean) {
		for (const run of this.runs.values())
			if (run.runId === runId) run.status = waiting ? 'waiting_for_approval' : 'working';
		this.publish();
	}
	answerQuestion(id: string, answers: Record<string, { answers: string[] }>) {
		const question = this.questions.get(id);
		if (!question) throw new Error('This question is no longer waiting for an answer.');
		if (
			!answers ||
			typeof answers !== 'object' ||
			Array.isArray(answers) ||
			Object.values(answers).some(
				(value) =>
					!value ||
					typeof value !== 'object' ||
					!Array.isArray(value.answers) ||
					value.answers.length > 10 ||
					value.answers.some((answer) => typeof answer !== 'string' || answer.length > 20_000),
			)
		)
			throw new Error('Invalid question answers.');
		if (Object.keys(answers).some((key) => !question.questions.some((q) => q.id === key)))
			throw new Error('Unknown question.');
		question.answer(answers);
	}
	async dispatch(
		threadId: string,
		automatic = false,
	): Promise<{ status: 'started' | 'queued' | 'unavailable'; error?: string }> {
		await this.ready;
		if (this.closed) return { status: 'unavailable', error: 'The task host is shutting down.' };
		if (this.runs.has(threadId)) return { status: 'queued' };
		const state = await this.state();
		// Recheck after the await; competing callers share one synchronous claim.
		if (this.runs.has(threadId)) return { status: 'queued' };
		const thread = state.threads.find((item) => item.id === threadId);
		if (!thread || thread.temporary || thread.archivedAt !== undefined)
			return { status: 'unavailable', error: 'This conversation is unavailable.' };
		if (
			!thread.queuedMessages?.length &&
			!(automatic && thread.goal?.status === 'active' && !thread.goal.awaitingResume)
		)
			return { status: 'unavailable', error: 'There is no queued input to deliver.' };
		const connection = state.connections.find((item) => item.id === thread.connectionId);
		try {
			if (!connection) throw new Error('The conversation API connection is unavailable.');
			resolveThinkingMode(connection, thread.model, thread.thinkingMode);
		} catch (error) {
			return {
				status: 'unavailable',
				error: error instanceof Error ? error.message : String(error),
			};
		}
		this.stopped.delete(threadId);
		const active: Running = {
			runId: randomUUID(),
			controller: new AbortController(),
			status: 'working',
			owner: 'host',
			completion: Promise.resolve(),
		};
		this.runs.set(threadId, active);
		this.publish();
		active.completion = this.run(threadId, active, automatic).catch((error) => {
			console.error('Delegated task persistence:', error);
		});
		return { status: 'started' };
	}
	async cancelThreads(ids: readonly string[]) {
		const completions: Promise<void>[] = [];
		const detached: string[] = [];
		for (const id of ids) {
			this.stopped.add(id);
			const run = this.runs.get(id);
			if (!run) continue;
			run.controller.abort();
			this.options.agent.cancel(run.runId);
			if (run.owner === 'host') completions.push(run.completion);
			else if (run.owner === 'remote') {
				this.runs.delete(id);
				detached.push(id);
			}
		}
		this.publish();
		await Promise.all([...completions, this.recoverDetached(detached)]);
	}
	isRendererCancelled(threadId: string): boolean {
		return this.runs.get(threadId)?.controller.signal.aborted === true;
	}
	close() {
		return (this.closing ??= this.shutdown());
	}
	private async shutdown() {
		this.closed = true;
		this.removeObserver();
		await this.cancelThreads([...this.runs.keys()]);
		await this.rendererClosed();
	}
	private mutateThread<T>(
		id: string,
		update: (thread: Thread, state: AppState) => { thread: Thread; value: T },
	) {
		return this.options.authority.mutate((state) => {
			const current = state.threads.find((item) => item.id === id);
			if (!current || current.temporary || current.archivedAt !== undefined)
				throw new Error('The delegated conversation was removed or archived.');
			const result = update(current, state);
			return {
				state: {
					...state,
					threads: state.threads.map((item) => (item.id === id ? result.thread : item)),
				},
				value: result.value,
			};
		});
	}
	private async run(threadId: string, active: Running, automatic: boolean) {
		const signal = active.controller.signal;
		const started = Date.now();
		let assistantId = '';
		let delivered: Message[] = [];
		let usedTools = false;
		let succeeded = false;
		let updates: Promise<void> = Promise.resolve();
		let latest: Partial<Message> = {};
		let updateTimer: ReturnType<typeof setTimeout> | undefined;
		const checkpoint = () => {
			if (updateTimer) clearTimeout(updateTimer);
			updateTimer = undefined;
			const patch = latest;
			latest = {};
			if (!assistantId || !Object.keys(patch).length) return updates;
			const selectedId = assistantId;
			updates = updates.then(() =>
				this.mutateThread(threadId, (thread) => ({
					thread: {
						...thread,
						updatedAt: Date.now(),
						messages: thread.messages.map((message) =>
							message.id === selectedId ? { ...message, ...patch } : message,
						),
					},
					value: undefined,
				})),
			);
			// Keep rejection observed until the next mandatory checkpoint awaits it.
			void updates.catch(() => {});
			return updates;
		};
		const beginSegment = () =>
			this.mutateThread(threadId, (thread, state) => {
				signal.throwIfAborted();
				const drained = drainQueuedCodeMessages(
					thread.queuedMessages,
					undefined,
					conversationNodes(thread),
				);
				delivered = drained.drained.map((message) => ({ ...message, role: 'user' as const }));
				const base = [...thread.messages];
				for (const message of delivered)
					base.push({ ...message, parentId: base.at(-1)?.id ?? null });
				assistantId = randomUUID();
				const pending: Message = {
					id: assistantId,
					role: 'assistant',
					parentId: base.at(-1)?.id ?? null,
					content: '',
					model: thread.model,
					thinkingMode: thread.thinkingMode,
					createdAt: Date.now(),
					phase: 'working',
				};
				const kind = threadKind(thread, state.projects);
				const next: Thread = {
					...selectConversationPath(thread, assistantId, [...base, pending]),
					queuedMessages: drained.remaining,
					updatedAt: Date.now(),
					...(kind === 'code'
						? {
								goal: composerGoal(thread.goal, delivered),
								codeQueueDelivery: {
									assistantId,
									messageIds: delivered.map((message) => message.id),
									startedAt: Date.now(),
								},
							}
						: {}),
				};
				return { thread: next, value: next };
			});
		try {
			let thread = await beginSegment();
			let state = await this.state();
			const kind = threadKind(thread, state.projects);
			const hostCatalog =
				kind === 'code' && !state.toolSettings?.enabled
					? ({ tools: [], instructions: '', warnings: [] } as ToolCatalog)
					: await this.options.agent.catalog(active.runId, threadId);
			const catalog: ToolCatalog = {
				...hostCatalog,
				tools: [
					...hostCatalog.tools,
					...(kind === 'code' && hostCatalog.codeCapabilities === 1
						? [...goalTools, ...codeContextTools, ...codeTaskTools]
						: []),
				],
			};
			for (;;) {
				signal.throwIfAborted();
				state = await this.state();
				thread = state.threads.find((item) => item.id === threadId)!;
				const connection = state.connections.find((item) => item.id === thread.connectionId);
				if (!connection) throw new Error('The conversation connection is unavailable.');
				const base = thread.messages.filter((message) => message.id !== assistantId);
				const user = [...base].reverse().find((message) => message.role === 'user');
				const selectedContext =
					user?.composer?.references?.length && this.options.resolveMentions
						? await this.options.resolveMentions(threadId, user.id)
						: '';
				if (
					kind === 'code' &&
					latestComposerMode(base) === 'plan' &&
					hostCatalog.codePlanMode !== 1
				)
					throw new Error('Plan mode requires an updated execution host.');
				const prompt = buildSystemPrompt({ state, kind, thread, catalog, selectedContext });
				const images: Attachment[] = base
					.flatMap((message) => [
						...(message.attachments ?? []).filter((a) => a.type.startsWith('image/')),
						...(message.toolCalls ?? []).flatMap(
							(call) =>
								call.result?.content.flatMap((part) =>
									part.type === 'image' && part.purpose !== 'computer'
										? [
												{
													name: part.name ?? 'tool-image.png',
													type: part.dataUrl.slice(5, part.dataUrl.indexOf(';')),
													dataUrl: part.dataUrl,
												},
											]
										: [],
								) ?? [],
						),
					])
					.slice(-5);
				const authorize = async (action: Record<string, unknown>) =>
					!(
						await this.options.agent.execute({
							workspaceId: 'local',
							runId: active.runId,
							threadId,
							name: 'code_task_authorize',
							arguments: action,
						})
					).isError;
				const result = await (this.options.stream ?? streamAgentChat)({
					connection,
					model: thread.model,
					thinkingMode: resolveThinkingMode(connection, thread.model, thread.thinkingMode).id,
					history: conversationInput(
						base.map((message) =>
							kind === 'code' && message.error && message.agentTranscript?.items.length
								? { ...message, error: undefined }
								: message,
						),
					),
					request: this.request,
					instructions: prompt.text,
					context: prompt.context,
					tools: prompt.tools,
					signal,
					compaction: true,
					compactionSettings: kind === 'code' ? state.codeCompaction : undefined,
					contextControls: kind === 'code',
					shouldYieldForInput: () =>
						!!this.cachedState?.threads.find((item) => item.id === threadId)?.queuedMessages
							?.length ||
						this.cachedState?.threads.find((item) => item.id === threadId)?.goal?.status ===
							'budget_limited',
					onUsage: (usage) => {
						if (kind !== 'code') return;
						updates = updates.then(() =>
							this.mutateThread(threadId, (thread) => ({
								thread:
									thread.goal?.status === 'active'
										? {
												...thread,
												goal: accountGoal(thread.goal, usage.tokens, 0, usage.estimated),
											}
										: thread,
								value: undefined,
							})),
						);
						void updates.catch(() => {});
					},
					onUpdate: (update) => {
						usedTools ||= update.toolCalls.length > 0;
						latest = {
							...latest,
							content: update.content,
							toolCalls: update.toolCalls,
							agentTranscript: update.transcript,
							activity: update.activity,
							phase: update.phase,
							activityFinishedAt: update.activityFinishedAt,
						};
						if (!updateTimer)
							updateTimer = setTimeout(() => {
								void checkpoint().catch(() => active.controller.abort());
							}, 100);
					},
					execute: async (name, args, callId): Promise<ToolResult> => {
						// Provider checkpoints are durable before side effects are admitted.
						await checkpoint();
						signal.throwIfAborted();
						if (kind === 'code' && latestComposerMode(base) === 'plan') {
							const denial = codePlanToolDenial(name, args);
							if (denial) throw new Error(denial);
						}
						if (
							kind === 'chat' &&
							!catalog.tools.some((tool) => tool.name === name && tool.source === 'plugin')
						)
							assertChatToolCall(name, args);
						if (kind === 'code' && isGoalTool(name))
							return executeGoalTool(name, args, {
								load: () => this.cachedState?.threads.find((item) => item.id === threadId)?.goal,
								write: (goal) =>
									this.mutateThread(threadId, (thread) => ({
										thread: { ...thread, goal },
										value: undefined,
									})),
								authorize: (message) => authorize({ action: name, message }),
							});
						if (kind === 'code' && isCodeTaskTool(name))
							return executeCodeTaskTool(name, args, {
								currentThreadId: threadId,
								operationId: `local:${threadId}:${active.runId}:${callId}`,
								signal,
								loadState: () => this.state(),
								mutate: (update) => this.options.authority.mutate(update),
								authorize: (action) => authorize({ ...action }),
								dispatch: (id) => this.dispatch(id),
								statuses: (ids) => this.statuses(ids),
								cancel: async (ids) => {
									// Archiving the calling task must not await its own unfinished tool promise.
									if (ids.includes(threadId)) {
										this.stopped.add(threadId);
										active.controller.abort();
									}
									await this.cancelThreads(ids.filter((id) => id !== threadId));
								},
							});
						if (kind === 'chat' && isMemoryTool(name))
							return executeMemoryTool(name, args, {
								getState: () => this.cachedState!,
								thread,
								signal,
								write: (mutation) =>
									this.options.authority.mutate((state) => {
										const result = applyMemoryMutation(state, mutation, {
											source: 'model',
											sourceThreadId: threadId,
										});
										return {
											state: result.state,
											value: { memory: result.memory, deleted: result.deleted },
										};
									}),
							});
						if (name === 'request_user_input')
							return new Promise((resolve, reject) => {
								const finish = () => {
									this.questions.delete(callId);
									active.status = 'working';
									this.publish();
									signal.removeEventListener('abort', abort);
								};
								const abort = () => {
									finish();
									reject(new DOMException('Cancelled', 'AbortError'));
								};
								signal.addEventListener('abort', abort, { once: true });
								this.questions.set(callId, {
									threadId,
									runId: active.runId,
									questions: userQuestions(args),
									answer: (answers) => {
										finish();
										resolve(textResult({ answers }));
									},
								});
								active.status = 'waiting_for_input';
								this.publish();
							});
						const result = await this.options.agent.execute({
							workspaceId: 'local',
							runId: active.runId,
							threadId,
							name,
							arguments: args,
							...selectMediaToolReferences(name, args, images),
						});
						for (const part of result.content)
							if (part.type === 'image' && part.purpose !== 'computer')
								images.push({
									name: part.name ?? 'tool-image.png',
									type: part.dataUrl.slice(5, part.dataUrl.indexOf(';')),
									dataUrl: part.dataUrl,
								});
						if (!result.isError && (name === 'image_gen.imagegen' || name === 'video_gen.videogen'))
							await this.options.authority.mutate((current) => {
								const video = name === 'video_gen.videogen';
								const config = video
									? state.toolSettings?.videoGeneration
									: state.toolSettings?.imageGeneration;
								if (!config) return { state: current, value: undefined };
								const assets = result.content.flatMap((part) =>
									!video && part.type === 'image' && part.purpose !== 'computer'
										? [
												{
													url: part.dataUrl,
													mimeType: part.dataUrl.slice(5, part.dataUrl.indexOf(';')),
													name: part.name ?? 'generated-image.png',
												},
											]
										: video && part.type === 'file' && part.mimeType.startsWith('video/')
											? [
													{
														url: part.dataUrl,
														mimeType: part.mimeType,
														name: part.name ?? 'generated-video.mp4',
													},
												]
											: [],
								);
								if (!assets.length) return { state: current, value: undefined };
								const size = video
									? resolveVideoToolSize(args.size, config.size)
									: resolveImageToolSize(args.size, config.size);
								const seconds = video
									? resolveVideoToolSeconds(
											args.seconds,
											state.toolSettings?.videoGeneration?.seconds ?? '',
										)
									: undefined;
								return {
									state: {
										...current,
										generations: [
											{
												id: randomUUID(),
												kind: video ? 'videos' : 'images',
												prompt: String(args.prompt ?? ''),
												model: config.model,
												connectionId: config.connectionId,
												createdAt: Date.now(),
												status: 'completed',
												parameters: {
													...(size ? { size } : {}),
													...(seconds ? { seconds } : {}),
													...(!video && state.toolSettings?.imageGeneration.quality
														? { quality: state.toolSettings.imageGeneration.quality }
														: {}),
													...(!video && args.transparent_background
														? { background: 'transparent' }
														: {}),
												},
												assets,
												...(result.moderationWarnings?.length
													? { moderationWarnings: result.moderationWarnings }
													: {}),
											},
											...current.generations,
										],
									},
									value: undefined,
								};
							});
						return result;
					},
				} satisfies AgentChatOptions);
				await checkpoint();
				await this.mutateThread(threadId, (thread) => {
					const next = {
						...thread,
						updatedAt: Date.now(),
						messages: thread.messages.map((message) =>
							message.id === assistantId ? { ...message, completedAt: Date.now() } : message,
						),
					};
					delete next.codeQueueDelivery;
					return { thread: next, value: undefined };
				});
				if (
					!result.yieldedForInput ||
					!(await this.state()).threads.find((item) => item.id === threadId)?.queuedMessages?.length
				)
					break;
				thread = await beginSegment();
			}
			succeeded = true;
		} catch (error) {
			await checkpoint().catch(() => {});
			if (assistantId)
				await this.mutateThread(threadId, (thread) => {
					const text = error instanceof Error ? error.message : String(error);
					const next: Thread = {
						...thread,
						updatedAt: Date.now(),
						messages: thread.messages.map((message) =>
							message.id === assistantId
								? {
										...message,
										completedAt: Date.now(),
										...(signal.aborted ? { interrupted: true } : { error: text }),
									}
								: message,
						),
					};
					const failure = createCodeQueueFailure(
						assistantId,
						delivered,
						signal.aborted ? 'Delivery was stopped before this input completed.' : text,
					);
					if (failure && threadKind(thread, this.cachedState?.projects ?? []) === 'code')
						next.codeQueueFailures = addCodeQueueFailure(
							next.codeQueueFailures,
							failure,
							next.messages,
						);
					delete next.codeQueueDelivery;
					return { thread: next, value: undefined };
				}).catch(() => {});
		} finally {
			if (updateTimer) clearTimeout(updateTimer);
			this.options.agent.cancel(active.runId);
			for (const [id, question] of this.questions)
				if (question.runId === active.runId) this.questions.delete(id);
			await this.mutateThread(threadId, (thread) => {
				if (!thread.goal) return { thread, value: undefined };
				let goal = accountGoal(thread.goal, 0, Date.now() - started, false, true);
				if (signal.aborted && goal.status === 'active') goal = { ...goal, status: 'paused' };
				else if (!succeeded || (automatic && !usedTools)) goal = { ...goal, awaitingResume: true };
				return { thread: { ...thread, goal }, value: undefined };
			}).catch(() => {});
			if (this.runs.get(threadId) === active) this.runs.delete(threadId);
			this.publish();
		}
		const thread = (await this.state()).threads.find((item) => item.id === threadId);
		if (!thread || !succeeded || signal.aborted || this.closed || this.stopped.has(threadId))
			return;
		await this.options.completed?.(thread);
		if (thread.queuedMessages?.length) void this.dispatch(threadId);
		else if (
			latestComposerMode(thread.messages) !== 'plan' &&
			shouldContinueGoal(thread.goal, {
				succeeded,
				interrupted: false,
				queued: false,
				automatic,
				usedTools,
			})
		)
			void this.dispatch(threadId, true);
	}
	private request: NonNullable<AgentChatOptions['request']> = async (
		connection,
		input,
		signal,
		onChunk = () => {},
	) => {
		signal?.throwIfAborted();
		const response = await this.options.request(
			{
				...input,
				id: randomUUID(),
				workspaceId: 'local',
				connectionId: connection.id,
				providerCaller: input.providerCaller ?? { surface: 'chat' },
				...(connection.providerAdapter ? { providerAdapterRequired: true } : {}),
				baseUrl: connection.baseUrl,
				apiKey: connection.apiKey,
			},
			onChunk,
			signal,
		);
		signal?.throwIfAborted();
		if (response.status < 200 || response.status >= 300)
			throw new Error(`API ${response.status}: ${response.body.slice(0, 2000)}`);
		return response;
	};
}
