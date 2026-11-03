import WelcomeOnboarding from './components/WelcomeOnboarding';
import { onboardingSeen, finishOnboarding, isUnconfiguredWorkspace } from './lib/onboarding-preferences';
import { playBotResponseSound } from './lib/bot-response-sound';
import { notificationWorkspace } from './lib/notification-navigation';
import type { NotificationDestination } from './notification-types';
import { userFacingError } from './lib/user-facing-error';
import { ChatSteeringInbox } from './lib/chat-steering';
import { useWorkflowsWorkspace } from './components/WorkflowsFeature';
import { useProjectWorkflows } from './lib/use-project-workflows';
import CodeWorkspacePanel, { CodeWorkspaceResize } from './components/CodeWorkspacePanel';
import { useCodeWorkspaceTabs } from './components/useCodeWorkspaceTabs';
import { CodeSurfaceContext } from './components/code-surface-context';
import { composerVisibleText } from './lib/composer-mention-codec';
import type { ComposerContext } from './composer-types';
import { composerGoal, latestComposerMode } from './lib/composer-context';
import { codePlanToolDenial } from './lib/code-plan';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Folder, LoaderCircle, MessageCircle, Search, X, Server, RefreshCw } from 'lucide-react';
import type {
	AppState,
	Attachment,
	ChatDraft,
	Connection,
	ConversationKind,
	Generation,
	Message,
	Project,
	QueuedCodeMessage,
	ReplyReference,
	Thread,
	WorkspaceMode,
} from './types';
import { initialState, conversationInput, recoverState, downloadText } from './lib/state';
import { loadNavigationPreferences, saveNavigationPreferences } from './lib/navigation-preferences';
import { resolveAppearance } from './lib/appearance';
import WorkspaceSplash from './components/WorkspaceSplash';
import {
	acceptWorkspaceSnapshot,
	getStorageInfo,
	loadState,
	saveState,
	onWorkspaceRebased,
	refreshHostWorkspace,
	workspaceSupportsMemory,
	workspaceSupportsPersonalization,
	workspaceSupportsCodeCompaction,
	workspaceSupportsModeration,
} from './lib/storage';
import { setBrowserMediaModerationContext } from './lib/api';
import { moderationConfigurationWarning } from './lib/moderation';
import { activateWorkspace } from './lib/workspace';
import { beginActivity, settleActivities } from './lib/activities';
import type { WorkspaceSnapshot } from './remote-types';
import { persistentWorkspace } from './lib/temporary-chats';
import {
	conversationNodes,
	selectConversationPath,
	selectMessageVersion,
	forkConversation,
} from './lib/conversation-tree';
import { streamAgentChat } from './lib/agent';
import {
	addQueuedCodeMessage,
	drainQueuedCodeMessages,
	editQueuedCodeMessage,
	pruneCommittedCodeQueue,
	removeQueuedCodeMessage,
	createCodeQueueFailure,
	addCodeQueueFailure,
	pruneCodeQueueFailures,
} from './lib/code-queue';
import { latestStreamUpdates } from './lib/stream-updates';
import { generateThreadTitle } from './lib/thread-title';
import { memorySettings, threadMemoryRevision, visibleSavedMemories } from './lib/memories';
import { ChatSummaryQueue, refreshChatSummaries } from './lib/memory-summary';
import {
	applyMemoryMutation,
	chatMemoryTools,
	executeMemoryTool,
	isMemoryTool,
	type MemoryMutation,
} from './lib/memory-tools';
import { suggestedProjectDirectoryName, validProjectDirectories } from './lib/project-directories';
import { projectKind, threadKind } from './lib/conversation-kind';
import { assertChatToolCall } from './lib/conversation-tools';
import { resolveImageToolSize } from './lib/image-tool';
import { resolveVideoToolSeconds, resolveVideoToolSize } from './lib/video-tool';
import { selectMediaToolReferences } from './lib/media-tool-references';
import { configuredWebBrowsing } from './lib/web-tools';
import { mergeWorkspaceState } from './lib/workspace-merge';
import type { HostTaskSnapshot } from './bot-task-types';
import { rollbackThreadMutation } from './lib/thread-mutation';
import type {
	CodePermissionMode,
	PromptContextSection,
	ToolApproval,
	ToolCatalog,
	ToolResult,
} from './agent-types';
import {
	codePermissionInstructions,
	defaultToolSettings,
	normalizeCodePermissionMode,
} from './lib/tool-settings';
import { buildSystemPrompt, chatPromptCatalog, promptApiTools } from './lib/system-prompt';
import type { BuildSystemPrompt, LastSentSystemPrompt } from './components/SystemPromptView';
import { textResult, userQuestions } from './lib/interaction-tools';
import { ToolPrompts, type PendingQuestions } from './components/ToolPrompts';
import {
	ComputerAuthorization,
	ComputerPreview,
	useComputerSessions,
} from './components/ComputerUse';
import { InlineToolApprovals } from './components/InlineToolApprovals';
import CodeGoalControls from './components/CodeGoalControls';
import {
	accountGoal,
	executeGoalTool,
	goalTools,
	isGoalTool,
	shouldContinueGoal,
	type CodeGoal,
} from './lib/code-goals';
import { codeContextTools } from './lib/code-context-tools';
import {
	codeTaskTools,
	executeCodeTaskTool,
	isCodeTaskTool,
	type CodeTaskStatus,
} from './lib/code-task-tools';

interface ConversationLocation {
	threadId: string | null;
	projectId: string | null;
	connectionId: string;
	model: string;
	thinkingMode: string;
	temporaryChat: boolean;
	codeDraftScope: string;
	chatDraftKey: number;
	permissionMode?: CodePermissionMode;
	goal?: CodeGoal;
}
interface WorkspaceConversationLocations {
	kind: ConversationKind;
	locations: Partial<Record<ConversationKind, ConversationLocation>>;
}

interface OwnedQuestions extends PendingQuestions {
	runId: string;
	workspaceId: string;
	threadId: string;
	draftAnswers: Record<string, string>;
}
import {
	defaultModel,
	defaultThinkingMode,
	getModelDefinition,
	modelSupports,
	resolveThinkingMode,
} from './lib/catalog';
import Sidebar from './components/Sidebar';
import PluginWorkspace from './components/PluginWorkspace';
import PluginSettings from './components/PluginSettings';
import { usePluginTabs } from './components/usePluginTabs';
import { usePluginSurfaceHost } from './components/usePluginSurfaceHost';
import WorkspaceTitlebar from './components/WorkspaceTitlebar';
import ConversationSources from './components/ConversationSources';
import { collectConversationSources } from './lib/conversation-sources';
import { collectTaskOutputs } from './lib/task-outputs';
import Chat from './components/Chat';
import Settings, { type SettingsSection } from './components/Settings';
import { MediaPlayground } from './components/MediaPlayground';
import { ImagePlayground } from './components/ImagePlayground';
import { VideoPlayground } from './components/VideoPlayground';
import { useBotsWorkspace } from './components/BotsFeature';
import './components/instances.css';
import './components/workspace.css';

type Dialog =
	| { kind: 'project'; project?: Project; conversationKind: ConversationKind }
	| { kind: 'rename'; thread: Thread }
	| { kind: 'delete'; thread: Thread }
	| { kind: 'move'; thread: Thread }
	| { kind: 'search' }
	| null;
export default function App() {
	const [initialNavigation] = useState(loadNavigationPreferences);
	const [state, setState] = useState<AppState>(initialState);
	const [toolApprovals, setToolApprovals] = useState<ToolApproval[]>([]);
	const approvalRuns = useRef(new Map<string, { workspaceId: string; threadId: string }>());
	const [toolQuestions, setToolQuestions] = useState<OwnedQuestions[]>([]);
	const toolQuestionsRef = useRef(toolQuestions);
	toolQuestionsRef.current = toolQuestions;
	useEffect(
		() =>
			window.desktop?.onToolApproval?.((approval) => {
				setToolApprovals((items) =>
					approval.cancelled
						? items.filter((item) => item.id !== approval.id)
						: [...items.filter((item) => item.id !== approval.id), approval],
				);
			}),
		[],
	);
	const [loaded, setLoaded] = useState(false);
 const [welcomeOpen, setWelcomeOpen] = useState(false);
 const welcomeChecked = useRef(false);
 useEffect(() => {
  if (!loaded || welcomeChecked.current) return;
  welcomeChecked.current = true;
  if (!onboardingSeen() && isUnconfiguredWorkspace(state)) setWelcomeOpen(true);
 }, [loaded, state]);

	const [fatal, setFatal] = useState('');
	const [storageError, setStorageError] = useState('');
	const [storageInfo, setStorageInfo] = useState<{
		secure: boolean;
		location: string;
		checked?: boolean;
	}>({ secure: false, location: '', checked: false });
	const [workspaceId, setWorkspaceId] = useState('local');
	const memorySupported = workspaceSupportsMemory(workspaceId);
	const personalizationSupported = workspaceSupportsPersonalization(workspaceId);
	const codeCompactionSupported = workspaceSupportsCodeCompaction(workspaceId);
	const moderationSupported = workspaceSupportsModeration(workspaceId);
	const [workspaceName, setWorkspaceName] = useState('This computer');
	const [codeWorkspaces, setCodeWorkspaces] = useState<{ id: string; name: string }[]>([
		{ id: 'local', name: 'This computer' },
	]);
	const workspaceRef = useRef('local');
	const [switching, setSwitching] = useState(false);
	const transitioning = useRef(false);
	const [reloadConfirm, setReloadConfirm] = useState(false);
	const [reloadTargetId, setReloadTargetId] = useState('local');
	const [workspaceError, setWorkspaceError] = useState('');
	const [notificationError, setNotificationError] = useState('');
	const [backupLocation, setBackupLocation] = useState('');
	const [mode, setMode] = useState<WorkspaceMode>(initialNavigation.mode);
	const pluginTabs = usePluginTabs(loaded && workspaceId === 'local' && !switching);
	const [activeConversationKind, setActiveConversationKind] = useState<ConversationKind>(
		initialNavigation.conversationKind,
	);
	useEffect(() => {
		if (!loaded || switching) return;
		saveNavigationPreferences({ mode, conversationKind: activeConversationKind });
	}, [loaded, switching, mode, activeConversationKind]);
	const [threadId, setThreadId] = useState<string | null>(null);
	const [projectId, setProjectId] = useState<string | null>(null);
	const [model, setModel] = useState('');
	const [thinkingMode, setThinkingMode] = useState('');
	const [newCodePermissionMode, setNewCodePermissionMode] = useState<CodePermissionMode>();
	const [settings, setSettings] = useState(false);
	const [workflowProjectId, setWorkflowProjectId] = useState<string>();
	const [workflowBindingId, setWorkflowBindingId] = useState<string>();
	const projectWorkflows = useProjectWorkflows(loaded && workspaceId === 'local' && !switching);
	const botsWorkspace = useBotsWorkspace(
		loaded && mode === 'bots' && !settings && !pluginTabs.active,
		{
			dictation: state.dictation,
			dictationConnection: state.connections.find((item) => item.id === state.dictation?.connectionId),
			onDictationSettings: () => openSettings('chat'),
		},
	);
	const workflowsWorkspace = useWorkflowsWorkspace(
		loaded && mode === 'workflows' && !settings && !pluginTabs.active,
		workspaceId === 'local' ? state.connections : [],
		{
			projects:
				workspaceId === 'local'
					? state.projects.filter((project) => projectKind(project) === 'code')
					: [],
			projectId: workflowProjectId,
			selectedBindingId: workflowBindingId,
			onSelectBinding: setWorkflowBindingId,
			onSelectProject: setWorkflowProjectId,
		},
	);
	const [settingsSection, setSettingsSection] = useState<SettingsSection>('configuration');
	const [settingsSectionRequest, setSettingsSectionRequest] = useState(0);
	const [settingsExitRequest, setSettingsExitRequest] = useState(0);
	const [chatDraftKey, setChatDraftKey] = useState(0);
	// Choosing the context of an unsent Code task must not replace its draft.
	const [codeDraftScope, setCodeDraftScope] = useState('new:code:general');
	const afterSettings = useRef<(() => void) | null>(null);
	const [sidebar, setSidebar] = useState(() => window.innerWidth > 700);
	const [pluginSidebar, setPluginSidebar] = useState<HTMLDivElement | null>(null);
	const computerSessions = useComputerSessions();
	const [pinnedSummaryVisible, setPinnedSummaryVisible] = useState(() => {
		try {
			return localStorage.getItem('freelm-pinned-summary-visible') !== 'false';
		} catch {
			return true;
		}
	});
	const [dialog, setDialogState] = useState<Dialog>(null);
	const dialogRef = useRef<Dialog>(null);
	const setDialog = useCallback((next: Dialog) => {
		dialogRef.current = next;
		setDialogState(next);
	}, []);
	const [dialogName, setDialogName] = useState('');
	const [dialogInstructions, setDialogInstructions] = useState('');
	const [dialogDirectories, setDialogDirectories] = useState('');
	const [projectError, setProjectError] = useState('');
	const [projectSaving, setProjectSaving] = useState(false);
	const projectSavingRef = useRef(false);
	function closeDialog() {
		if (!projectSavingRef.current) setDialog(null);
	}
	const [query, setQuery] = useState('');
	const [runningThreads, setRunningThreads] = useState<ReadonlySet<string>>(() => new Set());
	const runningThread = threadId && runningThreads.has(threadId) ? threadId : null;
	const controllers = useRef(new Map<string, AbortController>());
	const chatInputs = useRef(new Map<string, ChatSteeringInbox>());
	// The queue ref is read at model/tool boundaries before React has to paint it.
	const codeQueues = useRef(new Map<string, QueuedCodeMessage[]>());
	const pendingQueueWrites = useRef(new Set<string>());
	const continuationEpochs = useRef(new Map<string, number>());
	const editingCodeQueues = useRef(new Map<string, string>());
	const titleControllers = useRef(new Map<string, AbortController>());
	const [temporaryChat, setTemporaryChat] = useState(false);
	const summaryQueue = useRef(new ChatSummaryQueue());
	const memoryWrites = useRef(Promise.resolve());
	const codeStateWrites = useRef(Promise.resolve());
	const [newCodeGoal, setNewCodeGoal] = useState<CodeGoal>();
	// Navigation belongs to this window and host, not to synced conversation data.
	const conversationLocations = useRef(new Map<string, WorkspaceConversationLocations>());
	useEffect(() => {
		if (!loaded || switching || (mode !== 'chat' && mode !== 'code')) return;
		const saved = conversationLocations.current.get(workspaceId) ?? { kind: mode, locations: {} };
		saved.kind = mode;
		saved.locations[mode] = {
			threadId,
			projectId,
			connectionId: state.activeConnectionId,
			model,
			thinkingMode,
			temporaryChat,
			codeDraftScope,
			chatDraftKey,
			permissionMode: mode === 'code' ? newCodePermissionMode : undefined,
			goal: mode === 'code' ? newCodeGoal : undefined,
		};
		conversationLocations.current.set(workspaceId, saved);
	}, [
		loaded,
		switching,
		workspaceId,
		mode,
		threadId,
		projectId,
		state.activeConnectionId,
		model,
		thinkingMode,
		temporaryChat,
		codeDraftScope,
		chatDraftKey,
		newCodePermissionMode,
		newCodeGoal,
	]);
	const [lastSentPrompt, setLastSentPrompt] = useState<
		(LastSentSystemPrompt & { workspaceId: string }) | undefined
	>();
	const previewCatalogs = useRef(new Map<string, ToolCatalog>());
	useEffect(() => {
		if (!settings) previewCatalogs.current.clear();
	}, [settings, workspaceId]);
	useEffect(() => {
		if (mode !== 'code' || !window.desktop?.instanceStatus) return;
		let active = true;
		void window.desktop
			.instanceStatus()
			.then((overview) => {
				if (active)
					setCodeWorkspaces([
						{ id: 'local', name: 'This computer' },
						...overview.instances.map(({ id, name }) => ({ id, name })),
					]);
			})
			.catch(() => {});
		return () => {
			active = false;
		};
	}, [mode, workspaceId, settings]);
	useEffect(() => {
		const stop = () => {
			for (const ctl of titleControllers.current.values()) ctl.abort();
			summaryQueue.current.stop();
		};
		window.addEventListener('freelm:workspace-changing', stop);
		return () => {
			stop();
			window.removeEventListener('freelm:workspace-changing', stop);
		};
	}, []);
	const stateRef = useRef(state);
	stateRef.current = state;
	useEffect(() => {
		setBrowserMediaModerationContext(() => ({
			connections: stateRef.current.connections,
			moderation: stateRef.current.moderation,
		}));
		return () => setBrowserMediaModerationContext();
	}, []);
	const saveQueue = useRef(Promise.resolve());
	const connection =
		state.connections.find((c) => c.id === state.activeConnectionId) || state.connections[0];
	const selectedThinkingMode = thinkingMode || defaultThinkingMode(connection, model) || '';
	const thread = state.threads.find((t) => t.id === threadId);
	const pluginSurface = usePluginSurfaceHost({
		enabled:
			loaded &&
			!switching &&
			!storageError &&
			!settings &&
			!pluginTabs.active &&
			(mode === 'chat' || mode === 'code') &&
			!temporaryChat &&
			!thread?.temporary,
		workspaceId,
		composerId: `${workspaceId}:${activeConversationKind}:${threadId ?? projectId ?? 'new'}:${chatDraftKey}`,
		mode: activeConversationKind,
		thread,
		running: !!runningThread,
		theme: state.theme,
		model:
			connection && model && selectedThinkingMode
				? {
						hostId: workspaceId,
						connectionId: connection.id,
						modelId: model,
						thinkingModeId: selectedThinkingMode,
					}
				: undefined,
	});
	const outputRoot = thread?.projectId
		? state.projects.find((p) => p.id === thread.projectId)?.directories?.[0]
		: state.toolSettings?.workspaceRoot;
	const taskOutputs = useMemo(
		() => collectTaskOutputs(thread ?? { id: '', messages: [] }, { workspaceRoot: outputRoot }),
		[thread?.id, thread?.messages, thread?.messageHistory, outputRoot],
	);
	const prepareOutputRead = useCallback(async () => {
		const commit = saveQueue.current
			.catch(() => {})
			.then(async () => {
				if (workspaceRef.current !== workspaceId || transitioning.current)
					throw new Error('The workspace changed. Open the output again in its task.');
				await saveState(stateRef.current, workspaceId);
			});
		saveQueue.current = commit;
		await commit;
	}, [workspaceId]);
	const conversationSources = useMemo(
		() => collectConversationSources(thread?.messages),
		[thread?.messages],
	);
	const pinnedSummaryAvailable =
		!!thread?.messages.some((message) => message.role === 'user') &&
		thread.messages.some((message) => message.role === 'assistant');
	const surfaceScope = JSON.stringify([workspaceId, thread?.projectId || projectId || 'default']);
	const workspaceTabs = useCodeWorkspaceTabs(surfaceScope, threadId || undefined);
	const surfaceVisible = mode === 'code' && !settings && !pluginTabs.active && workspaceTabs.open;
	const [summaryWithTabs, setSummaryWithTabs] = useState(false);
	const [surfaceWidth, setSurfaceWidth] = useState(55);
	const [surfaceInsertion, setSurfaceInsertion] = useState<{
		id: string;
		scope: string;
		text: string;
		attachments: Attachment[];
	}>();
	const surfaceDraftScope = `${workspaceId}:${activeConversationKind}:${threadId || projectId || 'new'}`;
	const surfaceDraftScopeRef = useRef(surfaceDraftScope);
	surfaceDraftScopeRef.current = surfaceDraftScope;
	const sourcesOpen =
		pinnedSummaryAvailable && pinnedSummaryVisible && (!surfaceVisible || summaryWithTabs);
	useEffect(() => {
		setSummaryWithTabs(false);
	}, [surfaceScope, workspaceTabs.open]);
	const computerPanelOpen =
		workspaceId === 'local' &&
		activeConversationKind === 'code' &&
		computerSessions.some(
			(session) => session.threadId === threadId && session.status === 'active',
		);
	const project = state.projects.find((p) => p.id === projectId);
	const workflowProject = state.projects.find((p) => p.id === workflowProjectId);
	const visibleToolApprovals = toolApprovals.filter((approval) => {
		const run = approvalRuns.current.get(approval.runId);
		return (
			run?.workspaceId === workspaceId &&
			run.threadId === threadId &&
			approval.threadId === threadId
		);
	});
	const toolApprovalsRef = useRef(toolApprovals);
	toolApprovalsRef.current = toolApprovals;
	const hostTasks = useRef<HostTaskSnapshot>({ runs: [], questions: [] });
	useEffect(
		() =>
			onWorkspaceRebased((targetId, previous, next) => {
				if (targetId !== workspaceRef.current || transitioning.current) return;
				// Preparation may reject an overlapping edit. Storage must keep its old
				// baseline and block autosave until an explicit reload resolves it.
				const merged = mergeWorkspaceState(previous, stateRef.current, next);
				return () => {
					stateRef.current = merged;
					setState(merged);
					for (const [id] of codeQueues.current) {
						const thread = merged.threads.find((item) => item.id === id);
						if (thread) codeQueues.current.set(id, thread.queuedMessages ?? []);
					}
				};
			}),
		[],
	);
	useEffect(() => {
		const bridge = window.desktop;
		if (!loaded || !bridge?.hostTasksSnapshot) return;
		let disposed = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let running = false;
		let dirty = false;
		const sync = async () => {
			if (running || disposed) {
				dirty = true;
				return;
			}
			running = true;
			try {
				const snapshot = await bridge.hostTasksSnapshot!();
				if (disposed) return;
				const previousIds = new Set(
					hostTasks.current.runs.filter((run) => run.owner === 'host').map((run) => run.runId),
				);
				hostTasks.current = snapshot;
				for (const run of snapshot.runs) {
					if (run.owner === 'host') {
						approvalRuns.current.set(run.runId, { workspaceId: 'local', threadId: run.threadId });
						previousIds.delete(run.runId);
					} else if (run.cancelled) controllers.current.get(run.threadId)?.abort();
				}
				for (const id of previousIds) approvalRuns.current.delete(id);
				setToolQuestions((items) =>
					!snapshot.questions.length && !items.some((item) => item.runId.startsWith('host:'))
						? items
						: [
								...items.filter((item) => !item.runId.startsWith('host:')),
								...snapshot.questions.map((question) => ({
									...question,
									runId: `host:${question.runId}`,
									workspaceId: 'local',
									draftAnswers:
										items.find(
											(item) => item.id === question.id && item.runId === `host:${question.runId}`,
										)?.draftAnswers ?? {},
									answer: (answers: Record<string, { answers: string[] }>) => {
										void bridge
											.hostTaskAnswer?.(question.id, answers)
											.catch((error) => setStorageError(String(error)));
									},
								})),
							],
				);
				if (workspaceRef.current === 'local' && !transitioning.current) {
					setRunningThreads((current) => {
						const next = new Set([
							...controllers.current.keys(),
							...snapshot.runs.filter((run) => run.owner === 'host').map((run) => run.threadId),
						]);
						return current.size === next.size && [...current].every((id) => next.has(id))
							? current
							: next;
					});
					await refreshHostWorkspace(snapshot.workspaceRevision);
				}
			} catch (error) {
				if (!disposed) setStorageError(error instanceof Error ? error.message : String(error));
			} finally {
				running = false;
				if (dirty && !disposed) {
					dirty = false;
					timer = setTimeout(() => {
						timer = undefined;
						void sync();
					}, 100);
				}
			}
		};
		const schedule = () => {
			if (!timer)
				timer = setTimeout(() => {
					timer = undefined;
					void sync();
				}, 100);
		};
		const remove = bridge.onHostTasksChanged?.(schedule);
		void sync();
		return () => {
			disposed = true;
			remove?.();
			if (timer) clearTimeout(timer);
		};
	}, [loaded, workspaceId]);

	const draftScope =
		threadId ??
		(activeConversationKind === 'code'
			? codeDraftScope
			: `new:chat:${temporaryChat ? 'temporary' : (projectId ?? 'general')}`);
	const buildPromptPreview = useCallback<BuildSystemPrompt>(
		async (request, signal) => {
			if (signal.aborted || workspaceRef.current !== workspaceId)
				throw new DOMException('Cancelled', 'AbortError');
			const sourceThread = request.state.threads.find((item) => item.id === request.threadId);
			if (sourceThread && threadKind(sourceThread, request.state.projects) !== request.kind)
				throw new Error('Choose a conversation from the selected mode.');
			const scope = sourceThread ?? { id: '__new_prompt_preview__', projectId: request.projectId };
			const previewTools = request.state.toolSettings ?? defaultToolSettings();
			let catalog: ToolCatalog | undefined;
			let selectedContext: string | undefined;
			if (request.kind === 'chat') {
				catalog = chatPromptCatalog(request.state);
				if (window.desktop?.pluginSnapshot && window.desktop.toolCatalog) {
					// The preview uses draft content settings, but plugin account grants are host-owned.
					const previewRun = `prompt-preview-${crypto.randomUUID()}`;
					const cancel = () => {
						void window.desktop!.toolCancel(previewRun).catch(() => {});
					};
					signal.addEventListener('abort', cancel, { once: true });
					try {
						const host = await window.desktop.toolCatalog(
							workspaceId,
							previewRun,
							sourceThread?.id ?? previewRun,
							!sourceThread || sourceThread.temporary === true,
						);
						if (signal.aborted || workspaceRef.current !== workspaceId)
							throw new DOMException('Cancelled', 'AbortError');
						catalog.tools.push(...host.tools.filter((tool) => tool.source === 'plugin'));
					} finally {
						signal.removeEventListener('abort', cancel);
						await window.desktop.toolCancel(previewRun).catch(() => {});
					}
				}
			} else if (previewTools.enabled) {
				if (!sourceThread)
					throw new Error(
						'Choose an existing Code task to include its host tools and directories.',
					);
				if (
					JSON.stringify(previewTools) !==
					JSON.stringify(stateRef.current.toolSettings ?? defaultToolSettings())
				)
					throw new Error('Save your Code tool settings before loading host tool guidance.');
				const imageConnectionId = previewTools.imageGeneration.connectionId;
				if (
					previewTools.imageGeneration.enabled &&
					JSON.stringify(
						request.state.connections.find((c) => c.id === imageConnectionId)?.catalog,
					) !==
						JSON.stringify(
							stateRef.current.connections.find((c) => c.id === imageConnectionId)?.catalog,
						)
				)
					throw new Error('Save your image model configuration before loading Code tool guidance.');
				const videoConnectionId = previewTools.videoGeneration?.connectionId;
				if (
					previewTools.videoGeneration?.enabled &&
					JSON.stringify(
						request.state.connections.find((c) => c.id === videoConnectionId)?.catalog,
					) !==
						JSON.stringify(
							stateRef.current.connections.find((c) => c.id === videoConnectionId)?.catalog,
						)
				)
					throw new Error('Save your video model configuration before loading Code tool guidance.');
				if (!window.desktop?.toolCatalog)
					throw new Error('Host tool guidance requires the FreeLM desktop app.');
				const cacheKey = JSON.stringify([
					workspaceId,
					sourceThread.id,
					sourceThread.projectId,
					sourceThread.permissionMode,
					sourceThread.connectionId,
					sourceThread.model,
					sourceThread.thinkingMode,
					[...sourceThread.messages].reverse().find((message) => message.role === 'user')?.composer,
					request.state.projects.find((p) => p.id === sourceThread.projectId)?.directories,
					request.state.toolSettings,
					request.state.connections.map((c) => [c.id, c.catalog]),
				]);
				catalog = !request.refresh ? previewCatalogs.current.get(cacheKey) : undefined;
				if (!catalog) {
					const previewRun = `prompt-preview-${crypto.randomUUID()}`;
					const cancel = () => {
						void window.desktop!.toolCancel(previewRun).catch(() => {});
					};
					signal.addEventListener('abort', cancel, { once: true });
					try {
						catalog = await window.desktop.toolCatalog(workspaceId, previewRun, sourceThread.id);
						if (signal.aborted || workspaceRef.current !== workspaceId)
							throw new DOMException('Cancelled', 'AbortError');
						previewCatalogs.current.set(cacheKey, catalog);
						if (previewCatalogs.current.size > 32)
							previewCatalogs.current.delete(previewCatalogs.current.keys().next().value!);
					} finally {
						signal.removeEventListener('abort', cancel);
						await window.desktop.toolCancel(previewRun).catch(() => {});
					}
				}
			}
			if (request.kind === 'code' && sourceThread && catalog && window.desktop?.composerResolve) {
				const selected = [...sourceThread.messages]
					.reverse()
					.find((message) => message.role === 'user');
				if (selected?.composer?.references?.length) {
					const resolved = await window.desktop.composerResolve(
						workspaceId,
						sourceThread.id,
						selected.id,
					);
					if (signal.aborted || workspaceRef.current !== workspaceId)
						throw new DOMException('Cancelled', 'AbortError');
					selectedContext = [resolved.instructions, ...(resolved.warnings || [])]
						.filter(Boolean)
						.join('\n\n');
				}
			}
			const built = buildSystemPrompt({
				state: request.state,
				kind: request.kind,
				thread: scope,
				catalog,
				selectedContext,
				memorySupported: memorySupported && !sourceThread?.temporary,
			});
			const selectedConnection =
				request.state.connections.find((c) => c.id === request.connectionId) ??
				request.state.connections.find((c) => c.id === request.state.activeConnectionId);
			return {
				...built,
				apiTools: promptApiTools(built.tools, selectedConnection?.chatApi ?? 'responses'),
			};
		},
		[workspaceId, memorySupported],
	);
	useEffect(() => {
		let active = true;
		loadState()
			.then(async (saved) => {
				const tasks = await window.desktop?.hostTasksSnapshot?.();
				if (!active) return;
				const next = saved
					? recoverState(saved, { activeThreadIds: tasks?.runs.map((run) => run.threadId) })
					: initialState();
				setState(next);
				resetModel(
					next.connections.find((c) => c.id === next.activeConnectionId) || next.connections[0],
				);
				setLoaded(true);
			})
			.catch((e) => {
				if (active)
					setFatal(`Could not open your workspace: ${e instanceof Error ? e.message : String(e)}`);
			});
		// Storage metadata must not gate opening conversations. OS credential
		// services can wait for user interaction independently of workspace loading.
		getStorageInfo()
			.then((info) => {
				if (active && workspaceRef.current === 'local') setStorageInfo(info);
			})
			.catch((error) => {
				if (active && workspaceRef.current === 'local')
					setStorageError(
						`Could not check secure credential storage: ${error instanceof Error ? error.message : String(error)}`,
					);
			});
		return () => {
			active = false;
		};
	}, []);
	useEffect(() => {
		if (!loaded || switching) return;
		const timer = setTimeout(
			() => {
				if (transitioning.current) return;
				saveQueue.current = saveQueue.current
					.catch(() => {})
					.then(() =>
						saveState(workspaceRef.current === workspaceId ? stateRef.current : state, workspaceId),
					)
					.then(() => setStorageError(''))
					.catch((e) =>
						setStorageError(
							`Changes could not be saved: ${e instanceof Error ? e.message : String(e)}`,
						),
					);
			},
			runningThreads.size ? 1000 : 350,
		);
		return () => clearTimeout(timer);
	}, [state, loaded, workspaceId, switching, runningThreads]);
	useEffect(() => {
		const media = window.matchMedia('(prefers-color-scheme: dark)');
		const apply = () => {
			const theme = state.theme === 'system' ? (media.matches ? 'dark' : 'light') : state.theme;
			const root = document.documentElement;
			root.dataset.theme = theme;
			const colors = resolveAppearance(state.appearance, theme);
			root.style.setProperty('--user-bubble', colors.bubble);
			root.style.setProperty('--on-user-bubble', colors.bubbleText);
			root.style.setProperty('--primary', colors.primary);
			root.style.setProperty('--on-primary', colors.onPrimary);
		};
		apply();
		media.addEventListener('change', apply);
		return () => media.removeEventListener('change', apply);
	}, [state.theme, state.appearance]);
	useEffect(() => {
		const flush = async () => {
			window.dispatchEvent(new Event('freelm:flush-drafts'));
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			if (loaded && !transitioning.current)
				void saveState(stateRef.current, workspaceId).catch(() => {});
		};
		window.addEventListener('pagehide', flush);
		return () => window.removeEventListener('pagehide', flush);
	}, [loaded, workspaceId]);
	useEffect(
		() =>
			window.desktop?.onPrepareClose(async () => {
				if (transitioning.current) {
					setWorkspaceError(
						'Wait for the workspace to finish opening, then close the window again.',
					);
					return;
				}
				window.dispatchEvent(new Event('freelm:flush-drafts'));
				for (const ctl of controllers.current.values()) ctl.abort();
				window.dispatchEvent(new Event('freelm:workspace-changing'));
				try {
					await botsWorkspace.flushDrafts();
					await workflowsWorkspace.flushDrafts();
					if (loaded) {
						await settleActivities();
						await new Promise<void>((resolve) => setTimeout(resolve, 0));
						await saveQueue.current.catch(() => {});
						if (transitioning.current)
							throw new Error('A workspace is opening. Wait for it to finish before closing.');
						await saveState(stateRef.current, workspaceRef.current);
					}
					await window.desktop?.completeClose();
				} catch (e) {
					setStorageError(
						`Could not save before closing: ${e instanceof Error ? e.message : String(e)}. Retry closing after resolving the storage issue.`,
					);
				}
			}),
		[loaded, workspaceId, botsWorkspace.flushDrafts, workflowsWorkspace.flushDrafts],
	);
	const performNotificationRoute = useRef<(destination: NotificationDestination) => Promise<void>>(
		async () => {},
	);
	performNotificationRoute.current = async (destination) => {
		if (!window.desktop || transitioning.current)
			throw new Error(
				'Wait for the workspace to finish opening, then open the notification again.',
			);
		const target = notificationWorkspace(destination, await window.desktop.instanceStatus());
		await botsWorkspace.flushDrafts();
		await workflowsWorkspace.flushDrafts();
		if (workspaceRef.current !== target) await switchWorkspace(target);
		if (destination.kind === 'thread') {
			if (!stateRef.current.threads.some((t) => t.id === destination.entityId))
				throw new Error('This conversation is no longer available.');
			selectThread(destination.entityId);
		} else if (destination.kind === 'bot') {
			await botsWorkspace.openNotification(target, destination.entityId);
			setMode('bots');
		} else {
			await workflowsWorkspace.openNotification(destination.runId);
			setMode('workflows');
		}
		pluginTabs.setActiveKey(null);
		setSettings(false);
		setNotificationError('');
	};
	const notificationRoute = useRef<(destination: NotificationDestination) => Promise<void>>(
		async () => {},
	);
	notificationRoute.current = async (destination) => {
		if (settings) {
			leaveSettings(() => {
				void performNotificationRoute
					.current(destination)
					.catch((error) => setNotificationError(userFacingError(error)));
			});
			return;
		}
		await performNotificationRoute.current(destination);
	};
	useEffect(() => {
		if (!loaded) return;
		let mounted = true;
		let queue = Promise.resolve();
		const open = (destination: NotificationDestination) => {
			queue = queue
				.then(async () => {
					if (mounted) await notificationRoute.current(destination);
				})
				.catch((error) => {
					if (mounted) setNotificationError(userFacingError(error));
				});
		};
		const remove = window.desktop?.onNotificationOpen?.(open);
		void window.desktop
			?.notificationReady?.()
			.then((destination) => {
				if (destination && mounted) open(destination);
			})
			.catch(() => {});
		const removeSound = window.desktop?.onBotResponseSound?.((volume, kind) => {
			// Drop a stale cue after an app switch; never reroute or replay it.
			if ((kind === 'message') !== (document.hasFocus() && document.visibilityState === 'visible')) return;
			void playBotResponseSound(volume, kind).catch(() => {});
		});
		return () => {
			mounted = false;
			remove?.();
			removeSound?.();
		};
	}, [loaded]);
	useEffect(() =>
		window.desktop?.onOpenThread?.((id) => {
			if (stateRef.current.threads.some((item) => item.id === id)) {
				setSettings(false);
				selectThread(id);
			}
		}),
	);
	useEffect(() => {
		if (!loaded) return;
		let active = true;
		const show = async () => {
			if (await window.desktop?.schedulerTakeNavigation?.()) {
				if (active) openSettings('schedules');
			}
		};
		const unsubscribe = window.desktop?.onOpenScheduler?.(() => void show());
		void show();
		return () => {
			active = false;
			unsubscribe?.();
		};
	}, [loaded]);
	useEffect(() => {
		function keys(e: KeyboardEvent) {
			if (settings || projectSavingRef.current) return;
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
				e.preventDefault();
				setQuery('');
				setDialog({ kind: 'search' });
			}
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
				e.preventDefault();
				newChat(activeConversationKind, null, e.shiftKey);
			}
			if (e.key === 'Escape') {
				setDialog(null);
				setReloadConfirm(false);
			}
		}
		window.addEventListener('keydown', keys);
		return () => window.removeEventListener('keydown', keys);
	});
	useEffect(() => {
		const showSettings = () => openSettings();
		const startChat = () => {
			if (!settings) newChat();
		};
		window.addEventListener('freelm:new-chat', startChat);
		window.addEventListener('freelm:settings', showSettings);
		return () => {
			window.removeEventListener('freelm:new-chat', startChat);
			window.removeEventListener('freelm:settings', showSettings);
		};
	});
	useEffect(() => {
		if (!dialog && !reloadConfirm) return;
		const previous = document.activeElement as HTMLElement | null;
		const timer = setTimeout(() => {
			document.querySelector<HTMLElement>('[role="dialog"] input, [role="dialog"] button')?.focus();
		}, 30);
		const trap = (e: KeyboardEvent) => {
			if (e.key !== 'Tab') return;
			const nodes = Array.from(
				document.querySelectorAll<HTMLElement>(
					'[role="dialog"] button:not(:disabled), [role="dialog"] input, [role="dialog"] textarea, [role="dialog"] select, [role="dialog"] a',
				),
			).filter((n) => n.offsetParent !== null);
			const first = nodes[0],
				last = nodes.at(-1);
			if (e.shiftKey && document.activeElement === first) {
				e.preventDefault();
				last?.focus();
			} else if (!e.shiftKey && document.activeElement === last) {
				e.preventDefault();
				first?.focus();
			}
		};
		window.addEventListener('keydown', trap);
		return () => {
			clearTimeout(timer);
			window.removeEventListener('keydown', trap);
			previous?.focus();
		};
	}, [dialog, reloadConfirm]);
	function openSettings(section: SettingsSection = 'configuration') {
		pluginTabs.setActiveKey(null);
		setDialog(null);
		setSettingsSection(section);
		setSettingsSectionRequest((request) => request + 1);
		setSettings(true);
	}
	function installWorkspace(id: string, name: string, next: AppState) {
		pluginTabs.setActiveKey(null);
		codeQueues.current.clear();
		editingCodeQueues.current.clear();
		workspaceRef.current = id;
		stateRef.current = next;
		activateWorkspace(id);
		setWorkspaceId(id);
		setWorkspaceName(name);
		setNewCodePermissionMode(undefined);
		setTemporaryChat(false);
		setCodeDraftScope('new:code:general');
		setState(
			recoverState(next, {
				codeCompactionSupported: workspaceSupportsCodeCompaction(id),
				activeThreadIds: id === 'local' ? hostTasks.current.runs.map((run) => run.threadId) : [],
			}),
		);
		setRunningThreads(new Set());
		restoreConversation(conversationLocations.current.get(id)?.kind ?? 'chat', next, id);
		setSettings(false);
		setDialog(null);
		setStorageError('');
		setWorkspaceError('');
	}
	async function switchWorkspace(id: string, discard = false) {
		if (transitioning.current) throw new Error('A workspace is already opening.');
		transitioning.current = true;
		setSwitching(true);
		setWorkspaceError('');
		window.dispatchEvent(new Event('freelm:flush-drafts'));
		for (const ctl of controllers.current.values()) ctl.abort();
		window.dispatchEvent(new Event('freelm:workspace-changing'));
		const previousId = workspaceRef.current;
		let outgoingSaved = discard;
		try {
			await settleActivities();
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			await saveQueue.current.catch(() => {});
			if (!discard) await saveState(stateRef.current, previousId);
			outgoingSaved = true;
			let next: AppState | null;
			let incomingSnapshot: WorkspaceSnapshot | undefined;
			let name = 'This computer';
			if (id === 'local') {
				if (window.desktop) {
					incomingSnapshot = await window.desktop.workspaceLoad('local');
					next = incomingSnapshot.state;
				} else next = await loadState('local');
			} else {
				if (!window.desktop) throw new Error('Remote workspaces require the desktop app.');
				incomingSnapshot = await window.desktop.instanceOpen(id);
				const overview = await window.desktop.instanceStatus();
				name = overview.instances.find((instance) => instance.id === id)?.name || 'Remote instance';
				next = incomingSnapshot.state;
			}
			if (!next)
				throw new Error('This instance has no workspace yet. Open FreeLM on that machine first.');
			if (discard) {
				if (window.desktop)
					setBackupLocation(
						await window.desktop.workspaceBackup(persistentWorkspace(stateRef.current)),
					);
				else
					downloadText(
						`freelm-unsaved-${Date.now()}.json`,
						JSON.stringify(
							{
								...persistentWorkspace(stateRef.current),
								connections: stateRef.current.connections.map((c) => ({ ...c, apiKey: '' })),
							},
							null,
							2,
						),
						'application/json',
					);
			}
			const info = await getStorageInfo(id);
			// Advance the save revision only when the matching state is ready to install.
			if (incomingSnapshot) acceptWorkspaceSnapshot(id, incomingSnapshot);
			installWorkspace(id, name, next);
			setStorageInfo(info);
			setReloadConfirm(false);
			if (previousId !== 'local' && previousId !== id)
				await window.desktop?.instanceDisconnect(previousId).catch(() => {});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			setWorkspaceError(message);
			if (!outgoingSaved && id !== previousId) {
				setReloadTargetId(id);
				setSettings(false);
				setReloadConfirm(true);
			}
			if (message.includes('WORKSPACE_CONFLICT'))
				setStorageError(
					'This workspace changed on another client. Export your unsaved changes and reload the latest version.',
				);
			throw error;
		} finally {
			transitioning.current = false;
			setSwitching(false);
		}
	}
	function resetModel(nextConnection: Connection) {
		const nextModel = defaultModel(nextConnection, 'chat');
		setModel(nextModel);
		setThinkingMode(defaultThinkingMode(nextConnection, nextModel) || '');
	}
	function selectModel(nextModel: string, nextConnection = connection) {
		if (transitioning.current || storageError) return;
		const nextThinking = defaultThinkingMode(nextConnection, nextModel) || '';
		setModel(nextModel);
		setThinkingMode(nextThinking);
		if (thread)
			updateThread(thread.id, (t) => ({
				...t,
				connectionId: nextConnection.id,
				model: nextModel,
				thinkingMode: nextThinking || undefined,
				// Keep old response labels accurate when changing the model on a legacy chat.
				messages: t.messages.map((m) =>
					m.role === 'assistant' && !m.model
						? { ...m, model: t.model, thinkingMode: t.thinkingMode }
						: m,
				),
			}));
	}
	function selectConnection(id: string) {
		if (transitioning.current || storageError) return;
		const nextConnection = state.connections.find((item) => item.id === id);
		if (!nextConnection) return;
		setState((current) => ({ ...current, activeConnectionId: id }));
		selectModel(defaultModel(nextConnection, 'chat'), nextConnection);
	}
	function selectThinkingMode(value: string) {
		if (transitioning.current || storageError) return;
		const selected = resolveThinkingMode(connection, model, value).id;
		setThinkingMode(selected);
		if (thread)
			updateThread(thread.id, (t) => ({
				...t,
				thinkingMode: selected,
				messages: t.messages.map((m) =>
					m.role === 'assistant' && !m.model
						? { ...m, model: t.model, thinkingMode: t.thinkingMode }
						: m,
				),
			}));
	}
	async function selectPermissionMode(value: CodePermissionMode) {
		if (workspaceId !== 'local' || transitioning.current || storageError) return;
		if (!thread) {
			setNewCodePermissionMode(value);
			return;
		}
		const targetId = thread.id;
		const previousMode = thread.permissionMode;
		const targetWorkspace = workspaceRef.current;
		updateThread(targetId, (item) => ({ ...item, permissionMode: value, updatedAt: Date.now() }));
		// Release a pending Ask only after the host can observe the new policy.
		await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
		if (workspaceRef.current !== targetWorkspace || transitioning.current) return;
		let persisted = false;
		let persistedMode: CodePermissionMode | undefined;
		const save = saveQueue.current
			.catch(() => {})
			.then(async () => {
				if (workspaceRef.current !== targetWorkspace || transitioning.current) return;
				const snapshot = stateRef.current;
				const target = snapshot.threads.find((item) => item.id === targetId);
				if (!target) return;
				const savedMode = normalizeCodePermissionMode(
					target.permissionMode ?? snapshot.toolSettings?.approvalMode,
				);
				await saveState(snapshot, targetWorkspace);
				persistedMode = savedMode;
				persisted = true;
			});
		saveQueue.current = save;
		try {
			await save;
		} catch (error) {
			if (workspaceRef.current === targetWorkspace) {
				updateThread(targetId, (item) =>
					item.permissionMode === value ? { ...item, permissionMode: previousMode } : item,
				);
				setStorageError(
					`Changes could not be saved: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			return;
		}
		if (!persisted || workspaceRef.current !== targetWorkspace || transitioning.current) return;
		const selected = stateRef.current.threads.find((item) => item.id === targetId);
		if (!selected) return;
		const currentMode = normalizeCodePermissionMode(
			selected.permissionMode ?? stateRef.current.toolSettings?.approvalMode,
		);
		if (currentMode !== persistedMode) return;
		const stale = toolApprovalsRef.current.filter(
			(approval) =>
				approval.threadId === targetId &&
				approvalRuns.current.get(approval.runId)?.workspaceId === targetWorkspace &&
				normalizeCodePermissionMode(approval.permissionMode) !== currentMode,
		);
		for (const approval of stale) {
			setToolApprovals((items) => items.filter((item) => item.id !== approval.id));
			void window.desktop?.toolApprove(approval.id, false).catch(() => {});
		}
	}
	function newChat(
		kind: ConversationKind = activeConversationKind,
		selectedProjectId: string | null = null,
		temporary = false,
	) {
		pluginTabs.setActiveKey(null);
		setNewCodePermissionMode(undefined);
		setTemporaryChat(temporary && kind === 'chat');
		setChatDraftKey((key) => key + 1);
		setThreadId(null);
		setMode(kind);
		setActiveConversationKind(kind);
		const selectedProject = state.projects.find((item) => item.id === selectedProjectId);
		if (kind === 'code')
			setCodeDraftScope(
				`new:code:${selectedProject && projectKind(selectedProject) === kind ? selectedProject.id : 'general'}`,
			);
		setProjectId(
			!temporary && selectedProject && projectKind(selectedProject) === kind
				? selectedProject.id
				: null,
		);
		resetModel(connection);
		setDialog(null);
	}
	function leaveSettings(action: () => void) {
		if (!settings) return action();
		afterSettings.current = action;
		setSettingsExitRequest((request) => request + 1);
	}
	function moveThread(id: string, destination?: string) {
		const current = stateRef.current;
		const item = current.threads.find((thread) => thread.id === id);
		if (!item || workspaceRef.current !== 'local' || controllers.current.has(id)) return;
		if (threadKind(item, current.projects) === 'code' && item.messages.length) return;
		const target = destination
			? current.projects.find((project) => project.id === destination)
			: undefined;
		if (destination && (!target || projectKind(target) !== threadKind(item, current.projects)))
			return;
		updateThread(id, (thread) => ({ ...thread, projectId: destination, updatedAt: Date.now() }));
		if (threadId === id) setProjectId(destination || null);
		setDialog(null);
	}
	function selectMode(nextMode: WorkspaceMode) {
		if (nextMode === 'workflows') {
			setWorkflowProjectId(undefined);
			setWorkflowBindingId(undefined);
		}
		pluginTabs.setActiveKey(null);
		if (nextMode === 'chat' || nextMode === 'code') {
			if (mode !== nextMode) {
				window.dispatchEvent(new Event('freelm:flush-drafts'));
				restoreConversation(nextMode);
			}
		}
		setMode(nextMode);
		setDialog(null);
	}
	function restoreConversation(
		kind: ConversationKind,
		snapshot = stateRef.current,
		hostId = workspaceRef.current,
	) {
		const saved = conversationLocations.current.get(hostId)?.locations[kind];
		const target = snapshot.threads.find(
			(item) =>
				item.id === saved?.threadId &&
				!item.archivedAt &&
				threadKind(item, snapshot.projects) === kind,
		);
		// A removed/archived thread must not reopen or masquerade as a new draft.
		const draft = !saved?.threadId ? saved : undefined;
		const destination = snapshot.projects.find(
			(item) => item.id === (target?.projectId ?? draft?.projectId) && projectKind(item) === kind,
		);
		const nextConnection =
			snapshot.connections.find(
				(item) => item.id === (target?.connectionId ?? draft?.connectionId),
			) ??
			snapshot.connections.find((item) => item.id === snapshot.activeConnectionId) ??
			snapshot.connections[0];
		const nextModel = target?.model ?? draft?.model ?? defaultModel(nextConnection, 'chat');
		setThreadId(target?.id ?? null);
		setProjectId(destination?.id ?? null);
		setModel(nextModel);
		setThinkingMode(
			target?.thinkingMode ??
				draft?.thinkingMode ??
				defaultThinkingMode(nextConnection, nextModel) ??
				'',
		);
		setTemporaryChat(kind === 'chat' && (target?.temporary ?? draft?.temporaryChat ?? false));
		setCodeDraftScope(draft?.codeDraftScope ?? 'new:code:general');
		if (saved) setChatDraftKey(saved.chatDraftKey);
		setNewCodePermissionMode(draft?.permissionMode);
		setNewCodeGoal(draft?.goal);
		setActiveConversationKind(kind);
		setMode(kind);
		setState((current) =>
			!nextConnection || current.activeConnectionId === nextConnection.id
				? current
				: { ...current, activeConnectionId: nextConnection.id },
		);
	}
	function selectThread(id: string) {
		pluginTabs.setActiveKey(null);
		const t = stateRef.current.threads.find((t) => t.id === id);
		if (!t) return;
		setNewCodePermissionMode(undefined);
		setTemporaryChat(t.temporary === true);
		setThreadId(id);
		setProjectId(t.projectId || null);
		setModel(t.model);
		const nextConnection =
			stateRef.current.connections.find((c) => c.id === t.connectionId) || connection;
		setThinkingMode(t.thinkingMode || defaultThinkingMode(nextConnection, t.model) || '');
		const kind = threadKind(t, stateRef.current.projects);
		setMode(kind);
		setActiveConversationKind(kind);
		if (stateRef.current.connections.some((c) => c.id === t.connectionId))
			setState((s) => ({ ...s, activeConnectionId: t.connectionId }));
		setDialog(null);
	}
	function updateThread(id: string, update: (t: Thread) => Thread) {
		setState((s) => ({ ...s, threads: s.threads.map((t) => (t.id === id ? update(t) : t)) }));
	}
	function stopTask(id: string) {
		continuationEpochs.current.set(id, (continuationEpochs.current.get(id) ?? 0) + 1);
		controllers.current.get(id)?.abort();
		if (workspaceRef.current === 'local') void window.desktop?.hostTaskStop?.(id).catch(() => {});
	}
	function steerChat(content: string, attachments: Attachment[], replyTo?: ReplyReference) {
		const target = stateRef.current.threads.find((item) => item.id === threadId);
		const inbox = target && chatInputs.current.get(target.id);
		if (!target || !inbox || controllers.current.get(target.id)?.signal.aborted)
			throw new Error('This response is finishing. Send your message again when it stops.');
		const message: Message = { id: crypto.randomUUID(), role: 'user', content, attachments,
			replyTo, createdAt: Date.now(), parentId: target.messages.at(-1)?.id ?? null };
		const snapshot = { ...stateRef.current, threads: stateRef.current.threads.map(item =>
			item.id === target.id ? { ...item, messages: [...item.messages, message], updatedAt: message.createdAt } : item) };
		stateRef.current = snapshot;
		setState(snapshot);
		const workspace = workspaceRef.current;
		const saved = saveQueue.current.catch(() => {}).then(() => saveState(
			workspaceRef.current === workspace ? stateRef.current : snapshot, workspace));
		saveQueue.current = saved;
		inbox.ready = saved;
		inbox.push(message);
		// The message is already in history. A persistence failure must not duplicate it in the draft.
		void saved.catch(error => setStorageError(`Changes could not be saved: ${String(error)}`));
	}
	function taskStatus(id: string): CodeTaskStatus {
		const hosted =
			workspaceRef.current === 'local' &&
			hostTasks.current.runs.find((run) => run.threadId === id && run.owner === 'host');
		if (hosted) return hosted.status;
		const item = stateRef.current.threads.find((thread) => thread.id === id);
		const last = item?.messages.at(-1);
		if (toolQuestionsRef.current.some((q) => q.threadId === id)) return 'waiting_for_input';
		if (toolApprovalsRef.current.some((a) => a.threadId === id)) return 'waiting_for_approval';
		if (controllers.current.has(id)) return 'working';
		if (item?.queuedMessages?.length) return 'queued';
		if (last?.error || last?.interrupted) return 'error';
		return last?.role === 'assistant' ? 'completed' : 'idle';
	}
	function codeQueue(id: string): QueuedCodeMessage[] {
		const source = stateRef.current.threads.find((t) => t.id === id);
		return pruneCommittedCodeQueue(
			codeQueues.current.get(id) ?? source?.queuedMessages,
			source ? conversationNodes(source) : [],
		);
	}
	function replaceCodeQueue(id: string, messages: QueuedCodeMessage[]) {
		codeQueues.current.set(id, messages);
		updateThread(id, (t) => ({ ...t, queuedMessages: messages, updatedAt: Date.now() }));
	}
	function enqueueCodeMessage(
		content: string,
		attachments: Attachment[],
		replyTo?: ReplyReference,
		composer?: ComposerContext,
	) {
		const source = threadId ? stateRef.current.threads.find((t) => t.id === threadId) : undefined;
		if (
			!source ||
			threadKind(source, stateRef.current.projects) !== 'code' ||
			transitioning.current ||
			storageError ||
			settings
		)
			throw new Error('Wait for this task to finish opening before queueing a message.');
		replaceCodeQueue(
			source.id,
			addQueuedCodeMessage(
				codeQueue(source.id),
				{
					id: crypto.randomUUID(),
					content,
					attachments,
					replyTo,
					composer,
					createdAt: Date.now(),
				},
				source.messages,
			),
		);
	}
	function steerCodeQueue(messageId: string) {
		if (
			!thread ||
			transitioning.current ||
			storageError ||
			settings ||
			editingCodeQueues.current.has(thread.id)
		)
			return;
		if (controllers.current.has(thread.id)) return; // Already scheduled for the next safe boundary.
		const queue = codeQueue(thread.id);
		const index = queue.findIndex((m) => m.id === messageId);
		if (index >= 0)
			void runChat('', [], { target: thread, queued: queue.slice(0, index + 1).map((m) => m.id) });
	}
	function retryCodeQueue(failureId: string) {
		if (
			!thread ||
			controllers.current.has(thread.id) ||
			transitioning.current ||
			storageError ||
			settings
		)
			return;
		void runChat('', [], { target: thread, queueRetry: failureId });
	}
	function updateDraft(scope: string, draft: ChatDraft) {
		setState((current) => {
			const drafts = { ...current.chatDrafts };
			const keepMode =
				!!draft.composer?.mode ||
				!!draft.composer?.references?.length ||
				(draft.composer !== undefined &&
					latestComposerMode(
						current.threads.find((thread) => thread.id === scope)?.messages || [],
					) === 'plan');
			if (!draft.content && !draft.attachments.length && !draft.replyTo && !keepMode)
				delete drafts[scope];
			else drafts[scope] = draft;
			return { ...current, chatDrafts: drafts };
		});
	}
	function branchThread(messageId: string) {
		if (!thread || controllers.current.has(thread.id)) return;
		if (thread.messages.find((message) => message.id === messageId)?.role !== 'assistant') return;
		const branch = forkConversation(thread, messageId);
		setState((current) => ({ ...current, threads: [branch, ...current.threads] }));
		setThreadId(branch.id);
		setTemporaryChat(branch.temporary === true);
	}
	function archiveThread(id: string) {
		stopTask(id);
		updateThread(id, (item) => ({ ...item, archivedAt: Date.now() }));
		if (threadId === id) newChat();
	}
	async function changeMemory(
		mutation: MemoryMutation,
		source: 'user' | 'model',
		sourceThread?: Thread,
		signal?: AbortSignal,
	) {
		const targetWorkspace = workspaceRef.current;
		let result: ReturnType<typeof applyMemoryMutation> | undefined;
		const write = memoryWrites.current
			.catch(() => {})
			.then(async () => {
				if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
				if (!workspaceSupportsMemory(targetWorkspace))
					throw new Error('Update this remote FreeLM instance to enable Chat memory.');
				if (transitioning.current || workspaceRef.current !== targetWorkspace)
					throw new Error('Wait for the workspace to finish opening before changing memories.');
				const current = stateRef.current;
				if (sourceThread) {
					const liveThread = current.threads.find((t) => t.id === sourceThread.id);
					if (
						!liveThread ||
						threadKind(liveThread, current.projects) !== 'chat' ||
						liveThread.projectId !== sourceThread.projectId ||
						!memorySettings(current).savedMemories
					)
						throw new Error('The Chat memory scope changed. Send another message to continue.');
					if (
						mutation.kind === 'create'
							? mutation.projectId !== liveThread.projectId
							: !visibleSavedMemories(current, liveThread).some((note) => note.id === mutation.id)
					)
						throw new Error('Memory not found in this Chat scope.');
				}
				result = applyMemoryMutation(current, mutation, {
					source,
					...(sourceThread ? { sourceThreadId: sourceThread.id } : {}),
				});
				if (result.state === current) return;
				const next = result.state;
				stateRef.current = next;
				setState((state) => ({ ...state, savedMemories: next.savedMemories }));
				const save = saveQueue.current.catch(() => {}).then(() => saveState(next, targetWorkspace));
				saveQueue.current = save;
				try {
					await save;
					if (workspaceRef.current === targetWorkspace) setStorageError('');
				} catch (error) {
					if (workspaceRef.current === targetWorkspace) {
						if (stateRef.current.savedMemories === next.savedMemories)
							stateRef.current = { ...stateRef.current, savedMemories: current.savedMemories };
						setState((state) =>
							state.savedMemories === next.savedMemories
								? { ...state, savedMemories: current.savedMemories }
								: state,
						);
						setStorageError(
							`Memory changes could not be saved: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
					throw error;
				}
			});
		memoryWrites.current = write;
		await write;
		return { memory: result?.memory, deleted: result?.deleted };
	}
	async function mutateCodeState<T>(
		targetWorkspace: string,
		update: (latest: AppState) => { state: AppState; value: T },
	): Promise<T> {
		let value: T;
		const write = codeStateWrites.current
			.catch(() => {})
			.then(async () => {
				if (workspaceRef.current !== targetWorkspace || transitioning.current)
					throw new Error('The Code workspace changed.');
				await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
				const previous = stateRef.current;
				const result = update(previous);
				value = result.value;
				if (result.state === previous) return;
				const changedQueues = result.state.threads.filter(
					(item) =>
						item.queuedMessages !==
						previous.threads.find((old) => old.id === item.id)?.queuedMessages,
				);
				for (const item of changedQueues) {
					// Visible in the drawer immediately; execution waits for durable storage.
					pendingQueueWrites.current.add(item.id);
					codeQueues.current.set(item.id, item.queuedMessages ?? []);
				}
				stateRef.current = result.state;
				setState(result.state);
				const save = saveQueue.current
					.catch(() => {})
					.then(() => saveState(stateRef.current, targetWorkspace));
				saveQueue.current = save;
				try {
					await save;
				} catch (error) {
					if (workspaceRef.current === targetWorkspace) {
						const restored = rollbackThreadMutation(stateRef.current, previous, result.state);
						stateRef.current = restored;
						setState(restored);
						for (const item of changedQueues)
							codeQueues.current.set(
								item.id,
								restored.threads.find((thread) => thread.id === item.id)?.queuedMessages ?? [],
							);
						setStorageError(
							`Changes could not be saved: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
					throw error;
				} finally {
					for (const item of changedQueues) pendingQueueWrites.current.delete(item.id);
				}
			});
		codeStateWrites.current = write;
		await write;
		return value!;
	}
	async function dispatchCodeTask(
		targetId: string,
		goalContinuation = false,
	): Promise<{ status: 'started' | 'queued' | 'unavailable'; error?: string }> {
		const target = stateRef.current.threads.find((item) => item.id === targetId);
		if (
			!target ||
			threadKind(target, stateRef.current.projects) !== 'code' ||
			target.archivedAt ||
			transitioning.current ||
			storageError ||
			!stateRef.current.toolSettings?.enabled
		)
			return {
				status: 'unavailable',
				error: 'This Code task cannot run until its workspace, model and tools are available.',
			};
		if (controllers.current.has(targetId) || pendingQueueWrites.current.has(targetId))
			return { status: 'queued' };
		const targetConnection = stateRef.current.connections.find(
			(item) => item.id === target.connectionId,
		);
		try {
			if (!targetConnection) throw new Error('The task API connection is unavailable.');
			resolveThinkingMode(targetConnection, target.model, target.thinkingMode);
		} catch (error) {
			return {
				status: 'unavailable',
				error: error instanceof Error ? error.message : String(error),
			};
		}
		const queue = target.queuedMessages ?? [];
		if (!goalContinuation && !queue.length)
			return { status: 'unavailable', error: 'There is no queued input to deliver.' };
		if (goalContinuation && (target.goal?.status !== 'active' || target.goal.awaitingResume))
			return { status: 'unavailable', error: 'Resume the goal before continuing.' };
		void runChat('', [], {
			target,
			background: true,
			...(queue.length ? { queued: queue.map((item) => item.id) } : { autoContinue: true }),
		});
		return { status: 'started' };
	}
	async function dispatchBotTask(
		targetId: string,
	): Promise<{ status: 'started' | 'queued' | 'unavailable'; error?: string }> {
		if (workspaceRef.current === 'local' && window.desktop?.hostTaskDispatch) {
			await saveQueue.current.catch(() => {});
			await saveState(stateRef.current, 'local');
			return window.desktop.hostTaskDispatch(targetId);
		}
		const target = stateRef.current.threads.find((item) => item.id === targetId);
		if (
			!target ||
			target.archivedAt !== undefined ||
			target.temporary ||
			transitioning.current ||
			storageError
		)
			return {
				status: 'unavailable',
				error: 'This conversation cannot run in its current workspace state.',
			};
		if (threadKind(target, stateRef.current.projects) === 'code') return dispatchCodeTask(targetId);
		if (controllers.current.has(targetId) || pendingQueueWrites.current.has(targetId))
			return { status: 'queued' };
		try {
			const selected = stateRef.current.connections.find((item) => item.id === target.connectionId);
			if (!selected) throw new Error('The conversation API connection is unavailable.');
			resolveThinkingMode(selected, target.model, target.thinkingMode);
		} catch (error) {
			return {
				status: 'unavailable',
				error: error instanceof Error ? error.message : String(error),
			};
		}
		if (!target.queuedMessages?.length)
			return { status: 'unavailable', error: 'There is no queued input to deliver.' };
		void runChat('', [], {
			target,
			background: true,
			queued: target.queuedMessages.map((message) => message.id),
		});
		return { status: 'started' };
	}
	async function changeCodeGoal(value?: CodeGoal) {
		if (!threadId) {
			setNewCodeGoal(value);
			return;
		}
		const targetId = threadId;
		const targetWorkspace = workspaceRef.current;
		if (!value || value.status === 'paused') stopTask(targetId);
		try {
			await mutateCodeState(targetWorkspace, (latest) => ({
				state: {
					...latest,
					threads: latest.threads.map((item) =>
						item.id === targetId ? { ...item, goal: value, updatedAt: Date.now() } : item,
					),
				},
				value: undefined,
			}));
			if (value?.status === 'active' && !value.awaitingResume && !controllers.current.has(targetId))
				await dispatchCodeTask(targetId, true);
		} catch (error) {
			setStorageError(error instanceof Error ? error.message : String(error));
		}
	}
	async function runChat(
		content: string,
		attachments: Attachment[],
		operation?: {
			regenerate?: string;
			edit?: string;
			target?: Thread;
			queued?: string[];
			queueRetry?: string;
			background?: boolean;
			autoContinue?: boolean;
		},
		replyTo?: ReplyReference,
		composer?: ComposerContext,
	) {
		const sourceThread =
			operation?.target ??
			(threadId ? stateRef.current.threads.find((item) => item.id === threadId) : undefined);
		const initialConnection = sourceThread
			? stateRef.current.connections.find((item) => item.id === sourceThread.connectionId)
			: connection;
		const initialModel = sourceThread?.model ?? model;
		if (
			(sourceThread &&
				(controllers.current.has(sourceThread.id) ||
					pendingQueueWrites.current.has(sourceThread.id))) ||
			!initialConnection ||
			!initialModel.trim() ||
			transitioning.current ||
			storageError
		)
			return;
		const thread = sourceThread;
		let segmentConnection = initialConnection;
		let segmentModel = initialModel.trim();
		// The composer validates this too; keep direct/regenerate calls from bypassing it.
		let requestThinkingMode: string;
		try {
			requestThinkingMode = resolveThinkingMode(
				initialConnection,
				initialModel,
				sourceThread?.thinkingMode ?? selectedThinkingMode,
			).id;
		} catch {
			return;
		}
		if (thread) titleControllers.current.get(thread.id)?.abort();
		summaryQueue.current.stop();
		const finishActivity = beginActivity();
		const requestWorkspace = workspaceRef.current;
		const kind = thread ? threadKind(thread, state.projects) : activeConversationKind;
		const useHostTools =
			kind === 'code'
				? (state.toolSettings ?? defaultToolSettings()).enabled
				: !!window.desktop?.pluginSnapshot ||
					!!state.toolSettings?.imageGeneration.enabled ||
					!!state.toolSettings?.videoGeneration?.enabled ||
					configuredWebBrowsing(state.toolSettings) ||
					!!state.toolSettings?.pythonExecution?.enabled;
		const isTemporary = kind === 'chat' && (thread?.temporary ?? temporaryChat);
		const memoryTools =
			kind === 'chat' && memorySupported && !isTemporary ? chatMemoryTools(state) : [];
		const ctl = new AbortController();
		const now = Date.now(),
			id = thread?.id || crypto.randomUUID();
		const continuationEpoch = continuationEpochs.current.get(id) ?? 0;
		let assistantId = crypto.randomUUID();
		const nodes = thread ? conversationNodes(thread) : [];
		const nodeMap = new Map(nodes.map((message) => [message.id, message]));
		// Keep the active path order even when nodes also contain older branches.
		let base = thread ? thread.messages.map((message) => nodeMap.get(message.id)!) : [];
		const previousFailures =
			kind === 'code' ? pruneCodeQueueFailures(thread?.codeQueueFailures, base) : [];
		const retryFailure = operation?.queueRetry
			? previousFailures.find((failure) => failure.id === operation.queueRetry)
			: undefined;
		if (operation?.queueRetry && !retryFailure) {
			finishActivity();
			return;
		}
		// A retry continues the committed transcript, including completed tool results.
		// Keep only references to queued user messages; do not append those inputs again.
		let deliveryMessageIds =
			operation?.regenerate || operation?.edit
				? []
				: [
						...new Set(
							(retryFailure ? [retryFailure] : previousFailures).flatMap(
								(failure) => failure.messageIds,
							),
						),
					];
		if (operation?.regenerate) {
			const index = base.findIndex(
				(message) => message.id === operation.regenerate && message.role === 'assistant',
			);
			if (index < 0) {
				finishActivity();
				return;
			}
			base = base.slice(0, index);
		} else {
			let parentId = base.at(-1)?.id ?? null;
			if (operation?.edit) {
				const index = base.findIndex(
					(message) => message.id === operation.edit && message.role === 'user',
				);
				if (index < 0) {
					finishActivity();
					return;
				}
				parentId = base[index].parentId ?? null;
				replyTo = base[index].replyTo;
				composer = base[index].composer
					? {
							...base[index].composer,
							references: base[index].composer?.references?.filter((reference) =>
								content.includes(reference.token),
							),
						}
					: undefined;
				base = base.slice(0, index);
			}
			if (
				(kind === 'code' || operation?.queued) &&
				!operation?.edit &&
				!operation?.queueRetry &&
				thread
			) {
				const { drained, remaining } = drainQueuedCodeMessages(
					codeQueue(id),
					operation?.queued,
					base,
				);
				codeQueues.current.set(id, remaining);
				deliveryMessageIds = [
					...new Set([...deliveryMessageIds, ...drained.map((message) => message.id)]),
				];
				for (const queued of drained) {
					base.push({ ...queued, role: 'user', parentId });
					parentId = queued.id;
				}
			}
			if (!operation?.queued && !operation?.queueRetry && !operation?.autoContinue)
				base = [
					...base,
					{
						id: crypto.randomUUID(),
						parentId,
						role: 'user',
						content,
						attachments,
						replyTo,
						...(kind === 'code' ? { composer } : {}),
						createdAt: now,
					},
				];
		}
		let acceptedGoal = thread?.goal ?? newCodeGoal;
		let goalSetupError: Error | undefined;
		if (kind === 'code') {
			try {
				acceptedGoal = composerGoal(
					acceptedGoal,
					operation?.edit || operation?.regenerate
						? []
						: base.filter((message) => message.role === 'user' && !nodeMap.has(message.id)),
				);
			} catch (error) {
				goalSetupError = error instanceof Error ? error : new Error(String(error));
			}
		}
		const runId = crypto.randomUUID();
		if (requestWorkspace === 'local' && !isTemporary && window.desktop?.hostTaskClaim) {
			try {
				if (!(await window.desktop.hostTaskClaim(id, runId))) {
					finishActivity();
					return;
				}
			} catch (error) {
				setStorageError(error instanceof Error ? error.message : String(error));
				finishActivity();
				return;
			}
		}
		controllers.current.set(id, ctl);
		const chatInput = kind === 'chat' ? new ChatSteeringInbox() : undefined;
		if (chatInput) chatInputs.current.set(id, chatInput);
		let pending: Message = {
			id: assistantId,
			role: 'assistant',
			parentId: base.at(-1)?.id ?? null,
			content: '',
			model: initialModel.trim(),
			thinkingMode: requestThinkingMode,
			createdAt: now,
			phase: 'working',
		};
		let next: Thread = {
			...thread,
			id,
			kind,
			title: thread?.title || composerVisibleText(content).slice(0, 60) || 'Image conversation',
			titleSource: thread ? thread.titleSource : 'pending',
			projectId: thread ? thread.projectId : projectId || undefined,
			connectionId: initialConnection.id,
			model: initialModel.trim(),
			...(kind === 'code' ? { goal: acceptedGoal } : {}),
			thinkingMode: requestThinkingMode,
			...(kind === 'code'
				? {
						permissionMode: normalizeCodePermissionMode(
							thread?.permissionMode ?? newCodePermissionMode ?? state.toolSettings?.approvalMode,
						),
					}
				: {}),
			createdAt: thread?.createdAt || now,
			updatedAt: now,
			messages: [...base, pending],
			pinned: thread?.pinned,
			temporary: isTemporary,
			...(kind === 'code' || operation?.queued ? { queuedMessages: codeQueue(id) } : {}),
			archivedAt: undefined,
		};
		const submittedGoal = next.goal;
		if (thread) next = selectConversationPath(thread, assistantId, [...base, pending]);
		next = {
			...next,
			kind,
			model: initialModel.trim(),
			thinkingMode: requestThinkingMode,
			connectionId: initialConnection.id,
			temporary: isTemporary,
			archivedAt: undefined,
			...(kind === 'code' || operation?.queued ? { queuedMessages: codeQueue(id) } : {}),
			...(kind === 'code' ? { goal: submittedGoal } : {}),
		};
		if (kind === 'code') {
			next.codeQueueFailures = pruneCodeQueueFailures(previousFailures, base).filter(
				(failure) =>
					!failure.messageIds.some((messageId) => deliveryMessageIds.includes(messageId)),
			);
			if (deliveryMessageIds.length)
				next.codeQueueDelivery = { assistantId, messageIds: deliveryMessageIds, startedAt: now };
			else delete next.codeQueueDelivery;
		}
		setState((s) => ({
			...s,
			threads: thread ? s.threads.map((t) => (t.id === id ? next : t)) : [next, ...s.threads],
		}));
		if (!operation)
			updateDraft(draftScope, {
				content: '',
				attachments: [],
				...(kind === 'code' && composer?.mode === 'plan'
					? { composer: { mode: 'plan' as const } }
					: {}),
				updatedAt: now,
			});
		if (!operation?.background) setThreadId(id);
		if (!thread && kind === 'code') setNewCodeGoal(undefined);
		setRunningThreads((current) => new Set([...current, id]));
		// Paint the outgoing message and Working state before capturing a save or starting tools.
		await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
		let output = '';
		let usedTools = false;
		let succeeded = false;
		let finalSaveSucceeded = false;
		let live: Partial<Message> = { phase: 'working' };
		const updates = latestStreamUpdates<Partial<Message>>((value) => {
			if (workspaceRef.current !== requestWorkspace) return;
			const updateId = assistantId;
			updateThread(id, (t) => ({
				...t,
				messages: t.messages.map((m) => (m.id === updateId ? { ...m, ...value } : m)),
			}));
		});
		const publish = (patch: Partial<Message>) => {
			live = { ...live, ...patch };
			updates.push(live);
		};
		approvalRuns.current.set(runId, { workspaceId: requestWorkspace, threadId: id });
		const rememberPrompt = (
			text: string,
			apiTools: Record<string, unknown>[],
			tools: ToolCatalog['tools'] = [],
			context?: PromptContextSection[],
		) => {
			if (ctl.signal.aborted || workspaceRef.current !== requestWorkspace) return;
			setLastSentPrompt({
				workspaceId: requestWorkspace,
				threadId: id,
				kind,
				text,
				tools,
				apiTools,
				context,
				sentAt: Date.now(),
				connectionId: segmentConnection.id,
				model: segmentModel,
			});
		};
		const cancelTools = () => {
			void window.desktop?.toolCancel?.(runId);
		};
		ctl.signal.addEventListener('abort', cancelTools, { once: true });
		try {
			if (window.desktop) {
				const initialSnapshot = {
					...stateRef.current,
					threads: thread
						? stateRef.current.threads.map((t) => (t.id === id ? next : t))
						: [next, ...stateRef.current.threads.filter((t) => t.id !== id)],
				};
				const initialSave = saveQueue.current
					.catch(() => {})
					.then(() =>
						saveState(
							workspaceRef.current === requestWorkspace ? stateRef.current : initialSnapshot,
							requestWorkspace,
						),
					);
				saveQueue.current = initialSave;
				// Host execution and remote revision checks need the persisted chat first.
				if (useHostTools || requestWorkspace !== 'local' || deliveryMessageIds.length)
					await initialSave;
				else
					void initialSave.catch((error) => {
						if (workspaceRef.current === requestWorkspace)
							setStorageError(
								`Changes could not be saved: ${error instanceof Error ? error.message : String(error)}`,
							);
					});
			}
			if (ctl.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
			if (goalSetupError) throw goalSetupError;
			{
				if (useHostTools && !window.desktop?.toolCatalog)
					throw new Error('Tools require the FreeLM desktop app.');
				const hostCatalog = useHostTools
					? await window.desktop!.toolCatalog(requestWorkspace, runId, id, isTemporary, true)
					: { tools: [], instructions: '', warnings: [] };
				const catalog = {
					...hostCatalog,
					tools: [
						...hostCatalog.tools.filter((tool) => !isMemoryTool(tool.name)),
						...memoryTools,
						...(kind === 'code' && useHostTools && hostCatalog.codeCapabilities === 1
							? [...goalTools, ...codeContextTools, ...codeTaskTools]
							: []),
					],
				};
				if (ctl.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
				if (
					kind === 'code' &&
					latestComposerMode(base) === 'plan' &&
					hostCatalog.codePlanMode !== 1
				)
					throw new Error(
						'Plan mode requires an updated FreeLM execution host with read-only planning support.',
					);
				async function resolveMentions(messages: Message[]) {
					const selected = [...messages].reverse().find((message) => message.role === 'user');
					if (kind !== 'code' || !selected?.composer?.references?.length) return '';
					if (!window.desktop?.composerResolve)
						throw new Error('Update FreeLM to use workspace and skill mentions.');
					const resolved = await window.desktop.composerResolve(requestWorkspace, id, selected.id);
					if (ctl.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
					return [resolved.instructions, ...(resolved.warnings || [])].filter(Boolean).join('\n');
				}
				let mentionInstructions = await resolveMentions(base);
				const recentImages = base
					.flatMap((m) => [
						...(m.attachments || []).filter((a) => a.type.startsWith('image/')),
						...(m.toolCalls || []).flatMap((c) =>
							(c.result?.content || []).flatMap((p) =>
								p.type === 'image' && p.purpose !== 'computer'
									? [
											{
												name: p.name || 'tool-image.png',
												type: p.dataUrl.slice(5, p.dataUrl.indexOf(';')),
												dataUrl: p.dataUrl,
											},
										]
									: [],
							),
						),
					])
					.slice(-5);
				let prompt = buildSystemPrompt({
					state: {
						...state,
						threads: stateRef.current.threads,
						savedMemories: stateRef.current.savedMemories,
					},
					kind,
					thread: next,
					catalog,
					selectedContext: mentionInstructions,
					memorySupported: memorySupported && !isTemporary,
				});
				let segmentTools = prompt.tools;
				for (;;) {
					const result = await streamAgentChat({
						connection: segmentConnection,
						model: segmentModel,
						compaction: true,
						contextControls: kind === 'code',
						onUsage:
							kind === 'code'
								? (usage) => {
										const goal = stateRef.current.threads.find((item) => item.id === id)?.goal;
										if (
											!goal ||
											goal.status !== 'active' ||
											workspaceRef.current !== requestWorkspace
										)
											return;
										const accounted = accountGoal(goal, usage.tokens, 0, usage.estimated);
										const latest = {
											...stateRef.current,
											threads: stateRef.current.threads.map((item) =>
												item.id === id ? { ...item, goal: accounted } : item,
											),
										};
										stateRef.current = latest;
										setState(latest);
									}
								: undefined,
						compactionSettings: kind === 'code' ? stateRef.current.codeCompaction : undefined,
						history: conversationInput(
							base.map((message) =>
								kind === 'code' && message.error && message.agentTranscript?.items.length
									? { ...message, error: undefined }
									: message,
							),
						),
						thinkingMode: requestThinkingMode,
						signal: ctl.signal,
						inputSignal: chatInput?.signal,
						instructions: prompt.text,
						context: prompt.context,
						tools: segmentTools,
						shouldYieldForInput:
							kind === 'code'
								? () =>
										workspaceRef.current === requestWorkspace &&
										((!editingCodeQueues.current.has(id) &&
											!pendingQueueWrites.current.has(id) &&
											codeQueue(id).length > 0) ||
											stateRef.current.threads.find((item) => item.id === id)?.goal?.status ===
												'budget_limited')
								: chatInput ? () => chatInput.pending : undefined,
						onRequest: (request) =>
							rememberPrompt(request.instructions, request.tools, prompt.tools, request.context),
						execute: async (name, args, callId): Promise<ToolResult> => {
							if (kind === 'code' && latestComposerMode(base) === 'plan') {
								const denial = codePlanToolDenial(name, args);
								if (denial) throw new Error(denial);
							}
							if (
								kind === 'chat' &&
								!catalog.tools.some((tool) => tool.name === name && tool.source === 'plugin')
							)
								assertChatToolCall(name, args);
							if (ctl.signal.aborted || workspaceRef.current !== requestWorkspace)
								throw new DOMException('Cancelled', 'AbortError');
							const authorizeCodeAction = async (action: Record<string, unknown>) => {
								const approval = await window.desktop!.toolExecute({
									workspaceId: requestWorkspace,
									runId,
									threadId: id,
									name: 'code_task_authorize',
									arguments: action,
								});
								return !approval.isError;
							};
							if (kind === 'code' && isGoalTool(name))
								return executeGoalTool(name, args, {
									load: () => stateRef.current.threads.find((item) => item.id === id)?.goal,
									write: (goal) =>
										mutateCodeState(requestWorkspace, (latest) => ({
											state: {
												...latest,
												threads: latest.threads.map((item) =>
													item.id === id ? { ...item, goal, updatedAt: Date.now() } : item,
												),
											},
											value: undefined,
										})),
									authorize: (message) => authorizeCodeAction({ action: name, message }),
								});
							if (kind === 'code' && isCodeTaskTool(name))
								return executeCodeTaskTool(name, args, {
									currentThreadId: id,
									operationId: `${requestWorkspace}:${id}:${runId}:${callId}`,
									loadState: async () => {
										if (workspaceRef.current !== requestWorkspace)
											throw new Error('The Code workspace changed.');
										return stateRef.current;
									},
									mutate: (update) => mutateCodeState(requestWorkspace, update),
									authorize: (action) => authorizeCodeAction({ ...action }),
									dispatch: (targetId) => dispatchCodeTask(targetId),
									statuses: async (ids) =>
										Object.fromEntries(ids.map((id) => [id, taskStatus(id)])),
									cancel: async (ids) => {
										for (const targetId of ids) stopTask(targetId);
									},
									signal: ctl.signal,
								});
							if (kind === 'chat' && isMemoryTool(name))
								return executeMemoryTool(name, args, {
									getState: () => stateRef.current,
									thread: next,
									signal: ctl.signal,
									write: (mutation) => changeMemory(mutation, 'model', next, ctl.signal),
								});
							if (name === 'request_user_input') {
								const questions = userQuestions(args);
								return new Promise((resolve, reject) => {
									const abort = () => {
										setToolQuestions((items) =>
											items.filter((q) => q.id !== callId || q.runId !== runId),
										);
										reject(new DOMException('Cancelled', 'AbortError'));
									};
									ctl.signal.addEventListener('abort', abort, { once: true });
									setToolQuestions((items) => [
										...items,
										{
											id: callId,
											runId,
											workspaceId: requestWorkspace,
											threadId: id,
											draftAnswers: {},
											questions,
											answer: (answers) => {
												ctl.signal.removeEventListener('abort', abort);
												setToolQuestions((pending) =>
													pending.filter((q) => q.id !== callId || q.runId !== runId),
												);
												resolve(textResult({ answers }));
											},
										},
									]);
								});
							}
							const result = await window.desktop!.toolExecute({
								workspaceId: requestWorkspace,
								runId,
								threadId: id,
								name,
								arguments: args,
								...selectMediaToolReferences(name, args, recentImages),
							});
							if (ctl.signal.aborted || workspaceRef.current !== requestWorkspace)
								throw new DOMException('Cancelled', 'AbortError');
							const images = result.content.flatMap((p) =>
								p.type === 'image' && p.purpose !== 'computer'
									? [
											{
												name: p.name || 'tool-image.png',
												type: p.dataUrl.slice(5, p.dataUrl.indexOf(';')),
												dataUrl: p.dataUrl,
											},
										]
									: [],
							);
							recentImages.push(...images);
							if (
								name === 'image_gen.imagegen' &&
								images.length &&
								!result.isError &&
								!isTemporary
							) {
								const imageConfig = state.toolSettings!.imageGeneration;
								const definition = catalog.tools.find((tool) => tool.name === name);
								const properties = definition?.parameters.properties as
									Record<string, unknown> | undefined;
								const size = resolveImageToolSize(
									properties?.size ? args.size : undefined,
									imageConfig.size,
								);
								addGeneration({
									id: crypto.randomUUID(),
									kind: 'images',
									prompt: String(args.prompt || ''),
									model: imageConfig.model,
									connectionId: imageConfig.connectionId,
									createdAt: Date.now(),
									status: 'completed',
									parameters: {
										...(size ? { size } : {}),
										...(imageConfig.quality ? { quality: imageConfig.quality } : {}),
										...(args.transparent_background ? { background: 'transparent' } : {}),
									},
									assets: images.map((a) => ({ url: a.dataUrl, mimeType: a.type, name: a.name })),
								});
							}
							if (name === 'video_gen.videogen' && !result.isError && !isTemporary) {
								const assets = result.content.flatMap((part) =>
									part.type === 'file' && part.mimeType.startsWith('video/')
										? [{ url: part.dataUrl, mimeType: part.mimeType, name: part.name }]
										: [],
								);
								const videoConfig = state.toolSettings?.videoGeneration;
								if (assets.length && videoConfig) {
									const size = resolveVideoToolSize(args.size, videoConfig.size);
									const seconds = resolveVideoToolSeconds(args.seconds, videoConfig.seconds);
									addGeneration({
										id: crypto.randomUUID(),
										kind: 'videos',
										prompt: String(args.prompt || ''),
										model: videoConfig.model,
										connectionId: videoConfig.connectionId,
										createdAt: Date.now(),
										status: 'completed',
										progress: 100,
										parameters: { ...(size ? { size } : {}), ...(seconds ? { seconds } : {}) },
										assets,
										...(result.moderationWarnings?.length
											? { moderationWarnings: result.moderationWarnings }
											: {}),
									});
								}
							}
							return result;
						},
						onUpdate: (update) => {
							if (workspaceRef.current !== requestWorkspace) return;
							output = update.content;
							usedTools ||= update.toolCalls.length > 0;
							publish({
								content: update.content,
								toolCalls: update.toolCalls,
								agentTranscript: update.transcript,
								activity: update.activity,
								phase: update.phase,
								activityFinishedAt: update.activityFinishedAt,
							});
						},
					});
					updates.flush();
					if (!result.yieldedForInput) {
						if (chatInput) chatInputs.current.delete(id);
						break;
					}
					if (ctl.signal.aborted || workspaceRef.current !== requestWorkspace)
						throw new DOMException('Cancelled', 'AbortError');
					if (chatInput) {
						for (;;) {
							const ready = chatInput.ready;
							await ready;
							if (ready === chatInput.ready) break;
						}
						if (ctl.signal.aborted || workspaceRef.current !== requestWorkspace)
							throw new DOMException('Cancelled', 'AbortError');
						const incoming = chatInput.take();
						base = [...base, { ...pending, ...live, completedAt: Date.now() }];
						for (const message of incoming) {
							base.push({ ...message, parentId: base.at(-1)?.id ?? null });
							recentImages.push(...(message.attachments ?? []).filter(a => a.type.startsWith('image/')));
						}
						assistantId = crypto.randomUUID();
						pending = { ...pending, id: assistantId, parentId: base.at(-1)?.id ?? null, createdAt: Date.now() };
						live = { phase: 'working' };
						output = '';
						usedTools = false;
						updateThread(id, item => selectConversationPath(item, assistantId, [...base, pending]));
						prompt = buildSystemPrompt({ state: stateRef.current, kind, thread: { ...next, messages: base },
							catalog, memorySupported: memorySupported && !isTemporary });
						segmentTools = [...new Map([...segmentTools, ...(result.continuationTools ?? [])].map(tool => [tool.name, tool])).values()];
						continue;
					}
					await codeStateWrites.current;
					if (ctl.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
					const selectedState = stateRef.current;
					const selectedThread = selectedState.threads.find((item) => item.id === id);
					const selectedConnection = selectedState.connections.find(
						(item) => item.id === selectedThread?.connectionId,
					);
					if (!selectedThread || !selectedConnection)
						throw new Error('The selected Code model connection is no longer available.');
					const nextThinkingMode = resolveThinkingMode(
						selectedConnection,
						selectedThread.model,
						selectedThread.thinkingMode,
					).id;
					// A complete transcript segment owns every issued call and real result.
					// Commit the queued inputs before continuing with the same execution run.
					const { drained, remaining } = drainQueuedCodeMessages(codeQueue(id), undefined, base);
					if (!drained.length) break;
					codeQueues.current.set(id, remaining);
					const completed: Message = { ...pending, ...live, completedAt: Date.now() };
					segmentConnection = selectedConnection;
					segmentModel = selectedThread.model.trim();
					requestThinkingMode = nextThinkingMode;
					base = [...base, completed];
					for (const queued of drained) {
						base.push({ ...queued, role: 'user', parentId: base.at(-1)?.id ?? null });
						recentImages.push(
							...(queued.attachments || []).filter((a) => a.type.startsWith('image/')),
						);
					}
					acceptedGoal = selectedThread.goal;
					goalSetupError = undefined;
					try {
						acceptedGoal = composerGoal(acceptedGoal, drained);
					} catch (error) {
						goalSetupError = error instanceof Error ? error : new Error(String(error));
					}
					assistantId = crypto.randomUUID();
					deliveryMessageIds = drained.map((message) => message.id);
					pending = {
						...pending,
						id: assistantId,
						parentId: base.at(-1)?.id ?? null,
						createdAt: Date.now(),
						model: segmentModel,
						thinkingMode: requestThinkingMode,
					};
					live = { phase: 'working' };
					output = '';
					usedTools = false;
					updateThread(id, (t) => ({
						...selectConversationPath(t, assistantId, [...base, pending]),
						queuedMessages: remaining,
						goal: acceptedGoal,
						codeQueueDelivery: {
							assistantId,
							messageIds: deliveryMessageIds,
							startedAt: Date.now(),
						},
						updatedAt: Date.now(),
					}));
					const selectedCatalog = {
						...catalog,
						instructions: catalog.instructions.replace(
							/^Code permission mode:.*$/m,
							codePermissionInstructions(
								selectedThread.permissionMode ?? selectedState.toolSettings?.approvalMode,
							),
						),
					};
					await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
					if (ctl.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
					const checkpoint = stateRef.current;
					const commit = saveQueue.current
						.catch(() => {})
						.then(() => saveState(checkpoint, requestWorkspace));
					saveQueue.current = commit;
					await commit;
					if (goalSetupError) throw goalSetupError;
					if (latestComposerMode(base) === 'plan' && hostCatalog.codePlanMode !== 1)
						throw new Error('Plan mode requires an updated FreeLM execution host.');
					mentionInstructions = await resolveMentions(base);
					prompt = buildSystemPrompt({
						state: selectedState,
						kind,
						thread: {
							...selectedThread,
							messages: base,
							goal: stateRef.current.threads.find((item) => item.id === id)?.goal,
						},
						catalog: selectedCatalog,
						selectedContext: mentionInstructions,
						memorySupported: false,
					});
					segmentTools = [
						...new Map(
							[...segmentTools, ...prompt.tools, ...(result.continuationTools || [])].map(
								(tool) => [tool.name, tool],
							),
						).values(),
					];
				}
			}
			if (!output.trim() && !usedTools)
				throw new Error(
					'The provider returned no text. Check the selected model and chat endpoint.',
				);
			succeeded = true;
		} catch (e) {
			updates.flush();
			if (workspaceRef.current !== requestWorkspace) return;
			updateThread(id, (t) => {
				const failed = {
					...t,
					messages: t.messages.map((m) =>
						m.id === assistantId
							? {
									...m,
									...(ctl.signal.aborted
										? { interrupted: true }
										: { error: e instanceof Error ? e.message : String(e) }),
								}
							: m,
					),
				};
				if (kind === 'code' && deliveryMessageIds.length) {
					const failure = createCodeQueueFailure(
						assistantId,
						failed.messages.filter((m) => deliveryMessageIds.includes(m.id)),
						ctl.signal.aborted
							? 'Delivery was stopped before the queued message completed.'
							: e instanceof Error
								? e.message
								: String(e),
					);
					if (failure)
						failed.codeQueueFailures = addCodeQueueFailure(
							failed.codeQueueFailures,
							failure,
							failed.messages,
						);
				}
				delete failed.codeQueueDelivery;
				return failed;
			});
		} finally {
			updates.flush();
			if (chatInputs.current.get(id) === chatInput) chatInputs.current.delete(id);
			if (kind === 'code' && workspaceRef.current === requestWorkspace)
				updateThread(id, (item) => {
					if (!item.goal) return item;
					let goal = accountGoal(item.goal, 0, Date.now() - now, false, true);
					if (ctl.signal.aborted && goal.status === 'active') goal = { ...goal, status: 'paused' };
					else if (!succeeded || (operation?.autoContinue && !usedTools))
						goal = { ...goal, awaitingResume: true };
					return { ...item, goal };
				});
			if (workspaceRef.current === requestWorkspace)
				updateThread(id, (t) => {
					const finished = {
						...t,
						updatedAt: Date.now(),
						messages: t.messages.map((m) =>
							m.id === assistantId ? { ...m, completedAt: Date.now() } : m,
						),
					};
					delete finished.codeQueueDelivery;
					return finished;
				});
			ctl.signal.removeEventListener('abort', cancelTools);
			await window.desktop?.toolCancel?.(runId).catch(() => {});
			approvalRuns.current.delete(runId);
			setToolApprovals((items) => items.filter((item) => item.runId !== runId));
			if (kind === 'code')
				setToolQuestions((items) => items.filter((question) => question.runId !== runId));
			if (controllers.current.get(id) === ctl) controllers.current.delete(id);
			if (workspaceRef.current === requestWorkspace)
				setRunningThreads((current) => {
					const next = new Set(current);
					next.delete(id);
					return next;
				});
			finalSaveSucceeded = isTemporary;
			if (workspaceRef.current === requestWorkspace) {
				const checkpoint = stateRef.current;
				saveQueue.current = saveQueue.current
					.catch(() => {})
					.then(() =>
						saveState(
							workspaceRef.current === requestWorkspace ? stateRef.current : checkpoint,
							requestWorkspace,
						),
					)
					.then(() => {
						finalSaveSucceeded = true;
					})
					.catch((error) => {
						if (workspaceRef.current === requestWorkspace)
							setStorageError(
								`Changes could not be saved: ${error instanceof Error ? error.message : String(error)}`,
							);
					});
				await saveQueue.current;
			}
			// Keep ownership until the final context is durable. A failed save must not
			// hand queued work to a host runner that would read an unfinished answer.
			if (finalSaveSucceeded) {
				if (requestWorkspace === 'local' && !isTemporary)
					await window.desktop?.hostTaskRelease?.(id, runId).catch(() => {});
				else if (requestWorkspace !== 'local')
					await window.desktop?.toolRelease?.(runId).catch(() => {});
			}
			if (!finalSaveSucceeded) succeeded = false;
			finishActivity();
		}
		// Chat follow-ups wait for the current answer; Code also consumes them at tool boundaries.
		if (finalSaveSucceeded && !ctl.signal.aborted && workspaceRef.current === requestWorkspace) {
			await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
			if (stateRef.current.threads.find((item) => item.id === id)?.queuedMessages?.length) {
				await codeStateWrites.current.catch(() => {});
				await saveQueue.current.catch(() => {});
				setTimeout(() => {
					if (
						workspaceRef.current === requestWorkspace &&
						continuationEpoch === (continuationEpochs.current.get(id) ?? 0)
					)
						void dispatchBotTask(id);
				}, 0);
			}
		}
		if (kind === 'code' && workspaceRef.current === requestWorkspace) {
			await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
			const finished = stateRef.current.threads.find((item) => item.id === id);
			if (
				latestComposerMode(finished?.messages || []) !== 'plan' &&
				shouldContinueGoal(finished?.goal, {
					succeeded,
					interrupted: ctl.signal.aborted,
					queued: !!finished?.queuedMessages?.length,
					automatic: !!operation?.autoContinue,
					usedTools,
				})
			) {
				await codeStateWrites.current.catch(() => {});
				await saveQueue.current.catch(() => {});
				setTimeout(() => {
					if (
						workspaceRef.current === requestWorkspace &&
						continuationEpoch === (continuationEpochs.current.get(id) ?? 0)
					)
						void dispatchCodeTask(id, true);
				}, 0);
			}
		}
		if (succeeded && !isTemporary && !ctl.signal.aborted) {
			void window.desktop
				?.workflowThreadCompleted?.({
					threadId: id,
					title: next.title,
					workspaceId: requestWorkspace,
				})
				.catch(() => {});
		}
		if (
			succeeded &&
			!ctl.signal.aborted &&
			workspaceRef.current === requestWorkspace &&
			stateRef.current.backgroundNotifications !== false
		) {
			void window.desktop
				?.notifyCompletion?.({
					threadId: id,
					workspaceId: requestWorkspace,
					runId: assistantId,
					title: isTemporary
						? 'Temporary chat'
						: (stateRef.current.threads.find((item) => item.id === id)?.title ?? next.title),
				})
				.catch(() => {});
		}
		if (
			succeeded &&
			!isTemporary &&
			!ctl.signal.aborted &&
			!transitioning.current &&
			next.titleSource === 'pending' &&
			workspaceRef.current === requestWorkspace
		) {
			const titleCtl = new AbortController();
			titleControllers.current.set(id, titleCtl);
			void generateThreadTitle({
				providerCaller: kind,
				connection: segmentConnection,
				model: segmentModel,
				question: composerVisibleText(base.find((m) => m.role === 'user')?.content || content),
				answer: output,
				thinkingMode: requestThinkingMode,
				signal: titleCtl.signal,
			})
				.then((title) => {
					if (!title || titleCtl.signal.aborted || workspaceRef.current !== requestWorkspace)
						return;
					updateThread(id, (t) =>
						t.titleSource === 'pending' ? { ...t, title, titleSource: 'generated' } : t,
					);
				})
				.catch(() => {
					/* Keep the provisional title if the provider cannot create one. */
				})
				.finally(() => {
					if (titleControllers.current.get(id) === titleCtl) titleControllers.current.delete(id);
				});
		}
		if (
			succeeded &&
			kind === 'chat' &&
			!isTemporary &&
			memorySupported &&
			!ctl.signal.aborted &&
			workspaceRef.current === requestWorkspace
		) {
			summaryQueue.current.schedule(async (signal) => {
				if (
					transitioning.current ||
					controllers.current.size > 0 ||
					workspaceRef.current !== requestWorkspace
				)
					return;
				const finishSummaryActivity = beginActivity();
				try {
					await refreshChatSummaries({
						threadId: id,
						getState: () => stateRef.current,
						signal,
						apply: (summaryThreadId, summary, scope) => {
							if (signal.aborted || workspaceRef.current !== requestWorkspace) return;
							updateThread(summaryThreadId, (item) =>
								!signal.aborted &&
								workspaceRef.current === requestWorkspace &&
								item.projectId === scope &&
								memorySettings(stateRef.current).referenceHistory &&
								threadMemoryRevision(item) === summary.sourceRevision
									? { ...item, memorySummary: summary }
									: item,
							);
						},
					});
				} finally {
					finishSummaryActivity();
				}
			});
		}
	}
	function openProject(p?: Project) {
		setDialogName(p?.name || '');
		setDialogInstructions(p?.instructions || '');
		setDialogDirectories((p?.directories || []).join('\n'));
		setProjectError('');
		setDialog({
			kind: 'project',
			project: p,
			conversationKind: p ? projectKind(p) : activeConversationKind,
		});
	}
	async function saveProject() {
		if (
			!dialogName.trim() ||
			dialog?.kind !== 'project' ||
			projectSavingRef.current ||
			transitioning.current
		)
			return;
		const requestDialog = dialog;
		const targetWorkspace = workspaceRef.current;
		const kind = dialog.conversationKind;
		let directories = [
			...new Set(
				dialogDirectories
					.split(/\r?\n/)
					.map((line) => line.trim())
					.filter(Boolean),
			),
		];
		if (kind === 'code' && workspaceId === 'local' && !validProjectDirectories(directories)) {
			setProjectError(
				'Use up to 32 folders with distinct absolute paths, one per line, or leave blank to create a project folder.',
			);
			return;
		}
		projectSavingRef.current = true;
		const finishActivity = beginActivity();
		setProjectError('');
		try {
			if (kind === 'code' && targetWorkspace === 'local' && !directories.length) {
				if (!window.desktop?.projectCreateDirectory)
					throw new Error(
						'Automatic project folders require the updated FreeLM desktop app. Choose an existing folder or update FreeLM.',
					);
				setProjectSaving(true);
				directories = [await window.desktop.projectCreateDirectory(dialogName.trim())];
				if (!validProjectDirectories(directories))
					throw new Error('FreeLM returned an invalid project folder. Please try again.');
			}
			if (
				workspaceRef.current !== targetWorkspace ||
				transitioning.current ||
				dialogRef.current !== requestDialog
			)
				return;
			const p: Project = {
				id: dialog.project?.id || crypto.randomUUID(),
				kind,
				name: dialogName.trim(),
				instructions: dialogInstructions.trim(),
				createdAt: dialog.project?.createdAt || Date.now(),
				...(kind === 'code' && workspaceId === 'local'
					? { directories }
					: kind === 'code' && dialog.project?.directories
						? { directories: dialog.project.directories }
						: {}),
			};
			for (const item of stateRef.current.threads) if (item.projectId === p.id) stopTask(item.id);
			setState((s) => ({
				...s,
				projects: dialog.project
					? s.projects.map((x) => (x.id === p.id ? p : x))
					: [...s.projects, p],
			}));
			if (!dialog.project || thread?.projectId !== p.id) newChat(kind, null);
			setProjectId(p.id);
			setMode(kind);
			setActiveConversationKind(kind);
			setDialog(null);
		} catch (error) {
			if (workspaceRef.current === targetWorkspace && dialogRef.current === requestDialog)
				setProjectError(error instanceof Error ? error.message : String(error));
		} finally {
			projectSavingRef.current = false;
			setProjectSaving(false);
			finishActivity();
		}
	}
	function addGeneration(g: Generation) {
		setState((s) => ({ ...s, generations: [g, ...s.generations] }));
	}
	async function prepareGeneration(generation: Generation, signal: AbortSignal) {
		const target = workspaceRef.current;
		const ensureCurrent = () => {
			if (signal.aborted || transitioning.current || workspaceRef.current !== target)
				throw new DOMException('Request cancelled.', 'AbortError');
		};
		ensureCurrent();
		if (generation.kind === 'images' || generation.kind === 'videos') {
			if (!workspaceSupportsModeration(target))
				throw new Error('Update FreeLM on the remote computer before generating media.');
		}
		if (!window.desktop) return;
		try {
			await saveQueue.current.catch(() => {});
			ensureCurrent();
			await saveState(
				{
					...stateRef.current,
					generations: [
						generation,
						...stateRef.current.generations.filter((item) => item.id !== generation.id),
					],
				},
				target,
			);
			ensureCurrent();
		} catch (error) {
			if (!signal.aborted && workspaceRef.current === target)
				setStorageError(
					`Changes could not be saved: ${error instanceof Error ? error.message : String(error)}`,
				);
			throw error;
		}
	}
	const Playground =
		mode === 'images' ? ImagePlayground : mode === 'videos' ? VideoPlayground : MediaPlayground;
	if (fatal)
		return (
			<div className="loading-screen">
				<h2>Workspace unavailable</h2>
				<p>{fatal}</p>
				<button className="secondary-button" onClick={() => location.reload()}>
					Try again
				</button>
			</div>
		);
	if (!loaded) return <WorkspaceSplash />;
	return (
		<div
			className={`app-shell ${sidebar ? '' : 'sidebar-hidden'} ${settings ? 'settings-open' : ''} ${window.desktop?.platform === 'darwin' ? 'mac-app' : ''}`}
			inert={switching}
		>
			{
				<WorkspaceTitlebar
					title={
						settings
							? 'Settings'
							: mode === 'plugins' && !pluginTabs.active
								? 'Plugins'
								: pluginTabs.active
									? pluginTabs.active.tab.title
									: mode === 'chat' || mode === 'code'
										? temporaryChat || thread?.temporary
											? 'Temporary chat'
											: thread?.title ||
												project?.name ||
												(mode === 'code' ? 'New task' : 'New chat')
										: mode === 'images'
											? 'Images'
											: mode === 'videos'
												? 'Video'
												: mode === 'bots'
													? botsWorkspace.title
													: mode === 'workflows'
														? workflowsWorkspace.title
														: 'Audio'
					}
					thread={!pluginTabs.active && (mode === 'chat' || mode === 'code') ? thread : undefined}
					projectName={
						!pluginTabs.active && (mode === 'chat' || mode === 'code') ? project?.name : undefined
					}
					kind={activeConversationKind}
					conversation={!settings && !pluginTabs.active && (mode === 'chat' || mode === 'code')}
					settingsOpen={settings}
					panelOpen={sidebar}
					workspaceTabsOpen={surfaceVisible}
					workspaceTabCount={workspaceTabs.tabs.length}
					onToggleWorkspaceTabs={() => {
						if (!workspaceTabs.open) setSummaryWithTabs(false);
						workspaceTabs.toggle();
					}}
					pinnedSummaryAvailable={!pluginTabs.active && pinnedSummaryAvailable}
					pinnedSummaryOpen={sourcesOpen}
					busy={!!runningThread || switching || !!storageError}
					connection={connection}
					connections={state.connections}
					onTogglePanel={() => setSidebar((open) => !open)}
					onTogglePinnedSummary={() => {
						const visible = !sourcesOpen;
						if (surfaceVisible) setSummaryWithTabs(visible);
						setPinnedSummaryVisible(visible);
						try {
							localStorage.setItem('freelm-pinned-summary-visible', String(visible));
						} catch {
							// The panel still toggles when local preference storage is unavailable.
						}
					}}
					onNewChat={() => newChat()}
					onSearch={() => {
						setQuery('');
						setDialog({ kind: 'search' });
					}}
					onConnection={selectConnection}
				/>
			}
			{
				<Sidebar
					panel={
						pluginTabs.active ? (
							<div className="sidebar-panel plugin-tab-panel">
								<h2>Plugins</h2>
								{pluginTabs.tabs.map((choice) => (
									<button
										key={choice.key}
										aria-current={choice.key === pluginTabs.active?.key ? 'page' : undefined}
										onClick={() => pluginTabs.setActiveKey(choice.key)}
									>
										{choice.tab.title}
										<span>{choice.plugin.manifest.name}</span>
									</button>
								))}
								<button onClick={() => leaveSettings(() => selectMode('plugins'))}>
									Manage plugins
								</button>
							</div>
						) : mode === 'plugins' ? (
							<div
								className="sidebar-panel"
								role="region"
								aria-label="Plugin navigation"
								ref={setPluginSidebar}
							/>
						) : mode === 'bots' ? (
							botsWorkspace.panel
						) : mode === 'workflows' && !workflowProjectId ? (
							workflowsWorkspace.panel
						) : undefined
					}
					pluginTabs={pluginTabs.tabs}
					activePluginTab={pluginTabs.active?.key}
					onPluginTab={(key) =>
						leaveSettings(() => {
							pluginTabs.setActiveKey(key);
							setDialog(null);
						})
					}
					collapsed={settings || !sidebar}
					settingsOpen={settings}
					readOnly={workspaceId !== 'local'}
					runningThread={runningThread}
					runningThreads={runningThreads}
					workspaceName={workspaceName}
					remote={workspaceId !== 'local'}
					onInstances={() => openSettings('remote')}
					state={state}
					mode={mode}
					workflowApprovalCount={
						toolApprovals.filter((item) => item.runId.startsWith('workflow-')).length
					}
					projectWorkflows={projectWorkflows}
					activeWorkflowBindingId={mode === 'workflows' ? workflowBindingId : undefined}
					onProjectWorkflow={
						workspaceId !== 'local'
							? undefined
							: (bindingId, selectedProjectId) =>
									leaveSettings(() => {
										pluginTabs.setActiveKey(null);
										setThreadId(null);
										setProjectId(selectedProjectId);
										setWorkflowProjectId(selectedProjectId);
										setWorkflowBindingId(bindingId);
										setMode('workflows');
									})
					}
					onAddProjectWorkflow={
						workspaceId !== 'local'
							? undefined
							: (selectedProjectId) =>
									leaveSettings(() => {
										pluginTabs.setActiveKey(null);
										setThreadId(null);
										setProjectId(selectedProjectId);
										workflowsWorkspace.openProject(selectedProjectId);
										setMode('workflows');
									})
					}
					threadId={mode === 'workflows' ? null : threadId}
					projectId={mode === 'workflows' ? (workflowProjectId ?? null) : projectId}
					conversationKind={
						mode === 'workflows' && workflowProject
							? projectKind(workflowProject)
							: activeConversationKind
					}
					onMode={(next) => leaveSettings(() => selectMode(next))}
					onThread={selectThread}
					onNewChat={() => newChat()}
					onTemporaryChat={() => newChat('chat', null, true)}
					onProject={(id) => {
						const selected = state.projects.find((item) => item.id === id);
						newChat(selected ? projectKind(selected) : activeConversationKind, id);
					}}
					onNewProject={() => openProject()}
					onNewProjectChat={(project) => newChat(projectKind(project), project.id)}
					onMoveThread={moveThread}
					onEditProject={openProject}
					onThreadAction={(t, action) => {
						if (action === 'archive') archiveThread(t.id);
						else if (action === 'pin') updateThread(t.id, (t) => ({ ...t, pinned: !t.pinned }));
						else {
							setDialogName(t.title);
							setDialog({ kind: action, thread: t });
						}
					}}
					onSettings={() => openSettings()}
					onSearch={() => {
						setQuery('');
						setDialog({ kind: 'search' });
					}}
				/>
			}
			<main
				style={{ display: settings ? 'none' : undefined }}
				className={`main-workspace ${workspaceId !== 'local' && mode !== 'bots' && mode !== 'workflows' ? 'has-instance-bar' : ''}`}
			>
				<InlineToolApprovals
					approvals={toolApprovals.filter((item) => item.runId.startsWith('workflow-'))}
					debugMode={state.debugMode === true}
					onApprove={(id, approved, remember) => {
						setToolApprovals((items) => items.filter((item) => item.id !== id));
						void window.desktop?.toolApprove(id, approved, remember);
					}}
				/>
				{workspaceId !== 'local' && mode !== 'bots' && mode !== 'workflows' && (
					<div className="instance-context-bar">
						<Server size={14} />
						<button onClick={() => openSettings('remote')}>{workspaceName}</button>
						<span>Remote workspace · requests run on the host</span>
						<button
							aria-label="Refresh remote workspace"
							onClick={() => void switchWorkspace(workspaceId).catch(() => {})}
						>
							<RefreshCw size={14} />
							Refresh
						</button>
					</div>
				)}
				{notificationError && (
					<div className="storage-error" role="alert">
						<span>{notificationError}</span>
						<button onClick={() => setNotificationError('')}>Dismiss notification error</button>
					</div>
				)}
				{(storageError || workspaceError) && (
					<div className="storage-error" role="alert">
						{userFacingError(storageError || workspaceError)}
						<button
							onClick={() =>
								void saveState(state, workspaceId)
									.then(() => setStorageError(''))
									.catch(() => {})
							}
						>
							Retry save
						</button>
						<button
							onClick={() => {
								setReloadTargetId(workspaceId);
								setReloadConfirm(true);
							}}
						>
							Reload latest
						</button>
					</div>
				)}
				{backupLocation && !storageError && !workspaceError && (
					<div className="backup-notice" role="status">
						<span>
							Recovery copy saved: <code>{backupLocation}</code>
						</span>
						<button
							className="icon-button"
							aria-label="Dismiss backup notice"
							onClick={() => setBackupLocation('')}
						>
							<X size={15} />
						</button>
					</div>
				)}
				{pluginTabs.active ? (
					<PluginWorkspace
						key={pluginTabs.active.key}
						choice={pluginTabs.active}
						accounts={pluginTabs.accounts}
						onSettings={() => selectMode('plugins')}
					/>
				) : mode === 'plugins' ? (
					<PluginSettings
						sidebarContainer={pluginSidebar}
						storefront
						readOnly={workspaceId !== 'local'}
						workspaceName={workspaceName}
						connections={state.connections}
						workspaceId={workspaceId}
					/>
				) : mode === 'bots' ? (
					botsWorkspace.content
				) : mode === 'workflows' ? (
					<div className="workflow-host-surface">{workflowsWorkspace.content}</div>
				) : mode === 'chat' || mode === 'code' ? (
					<CodeSurfaceContext.Provider
						value={activeConversationKind === 'code' ? workspaceTabs.actions : undefined}
					>
						<div
							className={`conversation-layout${sourcesOpen || computerPanelOpen ? ' sources-open' : ''}${surfaceVisible ? ' code-tabs-open' : ''}${surfaceVisible && workspaceTabs.expanded ? ' code-tabs-expanded' : ''}`}
							style={{ '--code-tabs-width': `${surfaceWidth}%` } as React.CSSProperties}
						>
							<Chat
								pluginSurface={pluginSurface}
								onComposerInsertionConsumed={(id) =>
									setSurfaceInsertion((value) => (value?.id === id ? undefined : value))
								}
								composerInsertion={
									surfaceInsertion?.scope === surfaceDraftScope ? surfaceInsertion : undefined
								}
								goalControls={
									activeConversationKind === 'code' && (thread?.goal ?? newCodeGoal) ? (
										<CodeGoalControls
											goal={thread?.goal ?? newCodeGoal}
											onChange={(value) => {
												void changeCodeGoal(value);
											}}
										/>
									) : undefined
								}
								debugMode={state.debugMode === true}
								key={`${workspaceId}:${activeConversationKind}`}
								draftKey={chatDraftKey}
								conversationKind={activeConversationKind}
								thread={thread}
								project={project}
								connection={connection}
								model={model}
								thinkingMode={selectedThinkingMode}
								onThinkingMode={selectThinkingMode}
								busy={!!runningThread || switching || !!storageError || settings}
								runningHere={!!threadId && runningThread === threadId}
								canSteer={activeConversationKind === 'chat' && !!threadId && chatInputs.current.has(threadId) && !switching && !storageError && !settings}
								canQueue={
									activeConversationKind === 'code' &&
									!!runningThread &&
									!switching &&
									!storageError &&
									!settings
								}
								onQueueEdit={(id, content, attachments, replyTo, composer) => {
									if (thread && composer?.mode === 'goal')
										composerGoal(thread.goal, [
											...codeQueue(thread.id).filter((message) => message.id !== id),
											{ content, composer },
										]);
									if (thread && !transitioning.current && !storageError)
										replaceCodeQueue(
											thread.id,
											editQueuedCodeMessage(codeQueue(thread.id), id, {
												content,
												attachments,
												replyTo,
												composer,
											}),
										);
								}}
								onQueueRemove={(id) => {
									if (thread && !transitioning.current && !storageError)
										replaceCodeQueue(thread.id, removeQueuedCodeMessage(codeQueue(thread.id), id));
								}}
								onQueueSteer={steerCodeQueue}
								onQueueRetry={retryCodeQueue}
								interactionPending={
									activeConversationKind === 'code' &&
									toolQuestions.some(
										(question) =>
											question.workspaceId === workspaceId && question.threadId === threadId,
									)
								}
								interactionPrompt={toolQuestions.map((question) => (
									<ToolPrompts
										key={`${question.runId}:${question.id}`}
										questions={question}
										active={
											activeConversationKind === 'code' &&
											question.workspaceId === workspaceId &&
											question.threadId === threadId
										}
										answers={question.draftAnswers}
										onAnswersChange={(draftAnswers) =>
											setToolQuestions((items) =>
												items.map((item) =>
													item.id === question.id && item.runId === question.runId
														? { ...item, draftAnswers }
														: item,
												),
											)
										}
									/>
								))}
								onQueueEditing={(id) => {
									if (!thread) return;
									if (id) editingCodeQueues.current.set(thread.id, id);
									else editingCodeQueues.current.delete(thread.id);
								}}
								onModel={selectModel}
								onComposerDiscover={
									activeConversationKind === 'code'
										? (query) => {
												if (!window.desktop?.composerDiscover)
													return Promise.resolve({
														items: [],
														warnings: [
															'Workspace mentions require the updated FreeLM desktop app.',
														],
													});
												return window.desktop.composerDiscover({
													...query,
													conversationKind: 'code',
													workspaceId,
													threadId: thread?.id,
													projectId: thread?.projectId ?? project?.id,
												});
											}
										: undefined
								}
								onSend={(content, attachments, replyTo, composer) => {
									if (activeConversationKind === 'code' && composer?.mode === 'goal') {
										composerGoal(thread?.goal ?? newCodeGoal, [
											...(thread ? codeQueue(thread.id) : []),
											{ content, composer },
										]);
									}
									if (
										threadId &&
										controllers.current.has(threadId) &&
										activeConversationKind === 'code'
									)
										enqueueCodeMessage(content, attachments, replyTo, composer);
									else if (threadId && controllers.current.has(threadId) && activeConversationKind === 'chat')
										steerChat(content, attachments, replyTo);
									else void runChat(content, attachments, undefined, replyTo, composer);
								}}
								onStop={() => {
									if (threadId) stopTask(threadId);
								}}
								onRetry={() => {
									const last = thread?.messages
										.slice()
										.reverse()
										.find((message) => message.role === 'assistant');
									if (last) void runChat('', [], { regenerate: last.id });
								}}
								onEditMessage={(id, content, attachments) =>
									runChat(content, attachments, { edit: id })
								}
								onRegenerate={(id) => runChat('', [], { regenerate: id })}
								onBranch={(id) => branchThread(id)}
								onSelectVersion={(id, direction) => {
									if (thread && !controllers.current.has(thread.id))
										updateThread(thread.id, (item) => selectMessageVersion(item, id, direction));
								}}
								draftScope={draftScope}
								draft={state.chatDrafts?.[draftScope]}
								onDraftChange={(draft) => updateDraft(draftScope, draft)}
								dictation={state.dictation}
								dictationConnection={state.connections.find(
									(item) => item.id === state.dictation?.connectionId,
								)}
								onDictationSettings={() => openSettings('chat')}
								toolsEnabled={
									activeConversationKind === 'code' &&
									(state.toolSettings ?? defaultToolSettings()).enabled
								}
								permissionMode={normalizeCodePermissionMode(
									thread?.permissionMode ??
										newCodePermissionMode ??
										state.toolSettings?.approvalMode,
								)}
								permissionReadOnly={workspaceId !== 'local'}
								onPermissionMode={(value) => {
									void selectPermissionMode(value);
								}}
								workspaceId={workspaceId}
								workspaceName={workspaceName}
								workspaceOptions={codeWorkspaces}
								onWorkspaceChange={(id) => {
									if (id !== workspaceId)
										void switchWorkspace(id)
											.then(() => {
												setMode('code');
												setActiveConversationKind('code');
												setNewCodePermissionMode(undefined);
											})
											.catch(() => {});
								}}
								onToolsSettings={() => openSettings('tools')}
								onSettings={() => openSettings()}
								onSetupConnection={() => openSettings('connections')}
								projects={state.projects}
								onEditProject={openProject}
								onNewProject={() => openProject()}
								projectReadOnly={
									activeConversationKind === 'code'
										? !!thread?.messages.length
										: workspaceId !== 'local' && !!thread
								}
								onMove={(id) => {
									if (activeConversationKind === 'code' && thread?.messages.length) return;
									if (thread) moveThread(thread.id, id);
									else setProjectId(id || null);
								}}
								computerApprovalPending={visibleToolApprovals.some(
									(approval) => !!approval.computer,
								)}
								approvalPrompt={
									activeConversationKind === 'code' && visibleToolApprovals.length ? (
										<>
											{visibleToolApprovals
												.filter((approval) => approval.computer)
												.map((approval) => (
													<ComputerAuthorization
														key={approval.id}
														approval={approval}
														onApprove={(id, approved) => {
															setToolApprovals((items) => items.filter((item) => item.id !== id));
															void window.desktop?.toolApprove(id, approved);
														}}
													/>
												))}
											<InlineToolApprovals
												approvals={visibleToolApprovals.filter((approval) => !approval.computer)}
												debugMode={state.debugMode === true}
												onApprove={(id, approved, remember) => {
													setToolApprovals((items) => items.filter((item) => item.id !== id));
													void window.desktop?.toolApprove(id, approved, remember);
												}}
											/>
										</>
									) : undefined
								}
							/>
							{surfaceVisible && (
								<CodeWorkspaceResize value={surfaceWidth} onChange={setSurfaceWidth} />
							)}
							{activeConversationKind === 'code' && (
								<CodeWorkspacePanel
									key={surfaceScope}
									tabs={workspaceTabs}
									workspaceId={workspaceId}
									projectId={thread?.projectId || projectId || undefined}
									thread={thread}
									visible={surfaceVisible}
									prepare={prepareOutputRead}
									onAttach={(text, attachments) => {
										if (surfaceDraftScopeRef.current !== surfaceDraftScope)
											throw new Error(
												'The active task changed. Add the annotations again in the intended task.',
											);
										workspaceTabs.setExpanded(false);
										setSurfaceInsertion({
											id: crypto.randomUUID(),
											scope: surfaceDraftScope,
											text,
											attachments,
										});
									}}
								/>
							)}
							{(sourcesOpen || computerPanelOpen) && (
								<aside
									id="pinned-summary-panel"
									className="conversation-inspector"
									aria-label="Pinned summary"
								>
									{workspaceId === 'local' && activeConversationKind === 'code' && (
										<ComputerPreview
											onStop={(session) => stopTask(session.threadId)}
											sessions={computerSessions.filter((session) => session.threadId === threadId)}
										/>
									)}
									{sourcesOpen && (
										<ConversationSources
											key={`${workspaceId}:${threadId}`}
											thread={thread}
											data={conversationSources}
											outputs={taskOutputs}
											workspaceId={workspaceId}
											prepareOutputRead={prepareOutputRead}
											outputRoot={outputRoot}
										/>
									)}
								</aside>
							)}
						</div>
					</CodeSurfaceContext.Provider>
				) : (
					<Playground
						key={workspaceId}
						blocked={switching || !!storageError}
						mode={mode}
						connection={connection}
						generations={state.generations}
						moderationWarning={
							mode === 'images' || mode === 'videos'
								? moderationConfigurationWarning(
										state.moderation,
										mode === 'images' ? 'image' : 'video',
										state.connections,
									)
								: undefined
						}
						onAdd={(generation) => {
							if (workspaceRef.current === workspaceId) addGeneration(generation);
						}}
						onPrepareGeneration={prepareGeneration}
						onUpdate={(id, patch) =>
							workspaceRef.current === workspaceId &&
							setState((s) => ({
								...s,
								generations: s.generations.map((g) => (g.id === id ? { ...g, ...patch } : g)),
							}))
						}
						onDelete={(id) =>
							setState((s) => ({ ...s, generations: s.generations.filter((g) => g.id !== id) }))
						}
						onSettings={() => openSettings()}
					/>
				)}
				{switching && (
					<div className="workspace-switching" role="status">
						<LoaderCircle className="spin" size={22} />
						<span>Opening workspace…</span>
					</div>
				)}
			</main>
			{reloadConfirm && (
				<div className="modal-backdrop">
					<section
						className="dialog"
						role="dialog"
						aria-modal="true"
						aria-labelledby="reload-title"
					>
						<header className="modal-header">
							<h2 id="reload-title">
								{reloadTargetId === workspaceId
									? 'Reload this workspace?'
									: 'Keep a copy and switch?'}
							</h2>
							<button
								className="icon-button"
								aria-label="Close reload dialog"
								onClick={() => setReloadConfirm(false)}
							>
								<X size={18} />
							</button>
						</header>
						<div className="dialog-body">
							<p>
								Your current changes will be saved without API keys in this computer’s FreeLM
								recovery folder before continuing.{' '}
								{reloadTargetId === workspaceId
									? 'The latest saved workspace will then replace this view.'
									: 'You can then leave this workspace with your unsaved copy preserved.'}
							</p>
							<footer className="dialog-footer">
								<button className="secondary-button" onClick={() => setReloadConfirm(false)}>
									Cancel
								</button>
								<button
									className="primary-button"
									disabled={switching}
									onClick={() => void switchWorkspace(reloadTargetId, true).catch(() => {})}
								>
									{reloadTargetId === workspaceId ? 'Back up and reload' : 'Back up and switch'}
								</button>
							</footer>
						</div>
					</section>
				</div>
			)}
			{settings && (
				<Settings
     onWelcome={workspaceId === 'local' ? () => leaveSettings(() => setWelcomeOpen(true)) : undefined}
					key={workspaceId}
					initialSection={settingsSection}
					onOpenPlugins={() => leaveSettings(() => selectMode('plugins'))}
					sectionRequest={settingsSectionRequest}
					onExitCancel={() => {
						afterSettings.current = null;
					}}
					exitRequest={settingsExitRequest}
					activeWorkspaceId={workspaceId}
					workspaceName={workspaceName}
					onSelectWorkspace={(id) => switchWorkspace(id)}
					remote={workspaceId !== 'local'}
					state={state}
					secureStorage={storageInfo.secure}
					secureStorageChecked={storageInfo.checked}
					storageLocation={storageInfo.location}
					memorySupported={memorySupported}
					personalizationSupported={personalizationSupported}
					codeCompactionSupported={codeCompactionSupported}
					moderationSupported={moderationSupported}
					activeKind={activeConversationKind}
					activeThreadId={threadId ?? undefined}
					activeProjectId={projectId ?? undefined}
					onBuildSystemPrompt={buildPromptPreview}
					lastSentSystemPrompt={
						lastSentPrompt?.workspaceId === workspaceId ? lastSentPrompt : undefined
					}
					onMemoryChange={
						memorySupported
							? async (mutation) => {
									await changeMemory(mutation, 'user');
								}
							: undefined
					}
					onClearMemorySummaries={
						memorySupported
							? async () => {
									const targetWorkspace = workspaceRef.current;
									if (transitioning.current)
										throw new Error('Wait for the workspace to finish opening.');
									summaryQueue.current.stop();
									const previous = stateRef.current;
									const next = {
										...stateRef.current,
										threads: stateRef.current.threads.map((item) => {
											if (!item.memorySummary) return item;
											const { memorySummary: _summary, ...rest } = item;
											return rest;
										}),
									};
									stateRef.current = next;
									setState(next);
									const save = saveQueue.current
										.catch(() => {})
										.then(() => saveState(next, targetWorkspace));
									saveQueue.current = save;
									try {
										await save;
										setStorageError('');
									} catch (error) {
										if (workspaceRef.current === targetWorkspace) {
											const restore = (state: AppState): AppState => ({
												...state,
												threads: state.threads.map((item) => {
													const old = previous.threads.find((thread) => thread.id === item.id);
													return !item.memorySummary &&
														old?.memorySummary &&
														item.messages === old.messages &&
														item.projectId === old.projectId
														? { ...item, memorySummary: old.memorySummary }
														: item;
												}),
											});
											stateRef.current = restore(stateRef.current);
											setState(restore);
											setStorageError(
												`Summary changes could not be saved: ${error instanceof Error ? error.message : String(error)}`,
											);
										}
										throw error;
									}
								}
							: undefined
					}
					onRestoreThread={(id) => updateThread(id, (item) => ({ ...item, archivedAt: undefined }))}
					onClose={() => {
						setSettings(false);
						const action = afterSettings.current;
						afterSettings.current = null;
						action?.();
					}}
					onSave={async (values) => {
						const { connections, activeConnectionId } = values;
						const next = { ...stateRef.current, ...values };
						if (!memorySettings(next).referenceHistory) summaryQueue.current.stop();
						stateRef.current = next;
						setState(next);
						const nextConnection = connections.find((c) => c.id === activeConnectionId)!;
						if (
							activeConnectionId !== connection.id ||
							!modelSupports(nextConnection, model, 'chat')
						) {
							selectModel(defaultModel(nextConnection, 'chat'), nextConnection);
						}
						// Preserve an explicit thinking selection. If removed, the composer asks the user
						// to choose again instead of silently sending different reasoning parameters.
						await saveQueue.current.catch(() => {});
						await saveState(stateRef.current, workspaceRef.current);
						setStorageError('');
						const savedWorkspaceId = workspaceRef.current;
						void getStorageInfo(savedWorkspaceId)
							.then((info) => {
								if (workspaceRef.current === savedWorkspaceId) setStorageInfo(info);
							})
							.catch(() => {});
					}}
				/>
			)}

   <WelcomeOnboarding open={welcomeOpen && workspaceId === 'local'}
    secureStorage={storageInfo.secure} secureStorageChecked={storageInfo.checked}
    thinkingPresets={state.thinkingPresets}
    onClose={() => {finishOnboarding(); setWelcomeOpen(false);}}
    onSave={async (draft) => {
     if (workspaceRef.current !== 'local') throw new Error('Return to this computer to finish setup.');
     await saveQueue.current.catch(() => {});
     if (workspaceRef.current !== 'local') throw new Error('Return to this computer to finish setup.');
     const withConnection = (current: AppState): AppState => ({
      ...current,
      connections: isUnconfiguredWorkspace(current) ? [draft] : [...current.connections.filter(c => c.id !== draft.id), draft],
      activeConnectionId: draft.id,
     });
     await saveState(withConnection(stateRef.current), 'local');
     // Background task updates may arrive while storage is saving. Keep their state.
     if (workspaceRef.current !== 'local') return;
     const next = withConnection(stateRef.current);
     stateRef.current = next;
     setState(next);
     selectModel(defaultModel(draft, 'chat'), draft);
    }} />
			{dialog && (
				<div className="modal-backdrop" onClick={closeDialog}>
					<section
						className={`dialog ${dialog.kind === 'search' ? 'search-dialog' : ''}`}
						role="dialog"
						aria-modal="true"
						aria-labelledby="dialog-title"
						onClick={(e) => e.stopPropagation()}
					>
						<header className="modal-header">
							<h2 id="dialog-title">
								{dialog.kind === 'project'
									? dialog.project
										? 'Edit project'
										: 'Create a project'
									: dialog.kind === 'rename'
										? threadKind(dialog.thread, state.projects) === 'code'
											? 'Rename task'
											: 'Rename chat'
										: dialog.kind === 'delete'
											? threadKind(dialog.thread, state.projects) === 'code'
												? 'Delete task?'
												: 'Delete chat?'
											: dialog.kind === 'move'
												? 'Move to project'
												: activeConversationKind === 'code'
													? 'Search tasks'
													: 'Search chats'}
							</h2>
							<button
								className="icon-button"
								aria-label="Close dialog"
								disabled={projectSaving}
								onClick={closeDialog}
							>
								<X size={19} />
							</button>
						</header>
						{dialog.kind === 'move' ? (
							<div className="dialog-body move-project-list">
								<button onClick={() => moveThread(dialog.thread.id)}>
									<MessageCircle size={16} /> No project
								</button>
								{state.projects
									.filter(
										(project) => projectKind(project) === threadKind(dialog.thread, state.projects),
									)
									.map((project) => (
										<button
											key={project.id}
											onClick={() => moveThread(dialog.thread.id, project.id)}
										>
											<Folder size={16} /> {project.name}
										</button>
									))}
							</div>
						) : dialog.kind === 'search' ? (
							<>
								<div className="search-field">
									<Search size={18} />
									<input
										aria-label="Search conversations"
										placeholder="Search titles and messages…"
										value={query}
										onChange={(e) => setQuery(e.target.value)}
									/>
								</div>
								<div className="search-results">
									{state.threads
										.filter((item) => threadKind(item, state.projects) === activeConversationKind)
										.filter(
											(t) =>
												!query.trim() ||
												`${t.title} ${t.messages.map((m) => m.content).join(' ')}`
													.toLowerCase()
													.includes(query.trim().toLowerCase()),
										)
										.sort((a, b) => b.updatedAt - a.updatedAt)
										.map((t) => (
											<button key={t.id} onClick={() => selectThread(t.id)}>
												<MessageCircle size={18} />
												<span>
													<strong>{t.title}</strong>
													<small>
														{t.messages.at(-1)?.content.slice(0, 100) || 'No response yet'}
													</small>
												</span>
											</button>
										))}
									{!state.threads.length && <p>No conversations yet. Start a new chat to begin.</p>}
								</div>
							</>
						) : (
							<div className="dialog-body">
								{dialog.kind === 'delete' ? (
									<p>“{dialog.thread.title}” will be permanently removed from this device.</p>
								) : (
									<label>
										{dialog.kind === 'project'
											? 'Project name'
											: threadKind(dialog.thread, state.projects) === 'code'
												? 'Task name'
												: 'Chat name'}
										<input
											disabled={projectSaving}
											aria-label={
												dialog.kind === 'project'
													? 'Project name'
													: threadKind(dialog.thread, state.projects) === 'code'
														? 'Task name'
														: 'Chat name'
											}
											value={dialogName}
											onChange={(e) => setDialogName(e.target.value)}
											onKeyDown={(e) => {
												if (e.key === 'Enter') {
													if (dialog.kind === 'project') saveProject();
													else {
														updateThread(dialog.thread.id, (t) => ({
															...t,
															title: dialogName.trim() || t.title,
															titleSource: 'manual',
														}));
														setDialog(null);
													}
												}
											}}
											placeholder={
												dialog.kind === 'project'
													? 'e.g. Weekend ideas'
													: threadKind(dialog.thread, state.projects) === 'code'
														? 'Task title'
														: 'Chat title'
											}
										/>
									</label>
								)}
								{dialog.kind === 'project' && (
									<>
										<p className="field-hint">
											{dialog.conversationKind === 'code' ? 'Code project' : 'Chat project'}
										</p>
										{dialog.conversationKind === 'code' && (
											<>
												<label>
													Directories <span className="optional">optional</span>
													<textarea
														aria-label="Project directories"
														disabled={projectSaving}
														rows={3}
														value={dialogDirectories}
														readOnly={workspaceId !== 'local'}
														placeholder="Leave blank to create a project folder"
														onChange={(event) => {
															setDialogDirectories(event.target.value);
															setProjectError('');
														}}
													/>
												</label>
												{workspaceId === 'local' && window.desktop?.toolPickDirectory && (
													<button
														className="secondary-button"
														disabled={projectSaving}
														onClick={() => {
															void window
																.desktop!.toolPickDirectory()
																.then((folder) => {
																	if (folder) {
																		setDialogDirectories((value) =>
																			[
																				...new Set([
																					...value.split(/\r?\n/).filter(Boolean),
																					folder,
																				]),
																			].join('\n'),
																		);
																		setProjectError('');
																	}
																})
																.catch((error) =>
																	setProjectError(
																		error instanceof Error ? error.message : String(error),
																	),
																);
														}}
													>
														<Folder size={14} /> Add folder
													</button>
												)}
												<p className="field-hint">
													{workspaceId === 'local'
														? `Leave blank to create ~/Documents/FreeLM/${suggestedProjectDirectoryName(dialogName || 'ProjectName')}. Otherwise, use one absolute path per line. The first folder is the working directory.`
														: 'Directory bindings are managed on the host computer. Projects need host folders before filesystem tools are available.'}
												</p>
											</>
										)}
										{projectError && (
											<p className="error-note" role="alert">
												{userFacingError(projectError)}
											</p>
										)}
										<label>
											Instructions <span className="optional">optional</span>
											<textarea
												aria-label="Project instructions"
												disabled={projectSaving}
												rows={4}
												value={dialogInstructions}
												onChange={(e) => setDialogInstructions(e.target.value)}
												placeholder={
													dialog.conversationKind === 'code'
														? 'What should the model know for every task in this project?'
														: 'What should the model know for every chat in this project?'
												}
											/>
										</label>
										<p className="field-hint">
											{dialog.conversationKind === 'code' ? (
												<>
													<Folder size={14} /> Project folders apply to execution and file tools
													when those tools are enabled.
												</>
											) : (
												'Project instructions apply to every conversation. Chat does not run tools on your computer.'
											)}
										</p>
									</>
								)}
								<footer className="dialog-footer">
									{dialog.kind === 'project' && dialog.project && (
										<button
											className="text-button danger"
											disabled={
												projectSaving ||
												(workspaceId !== 'local' &&
													(!!dialog.project.directories?.length ||
														state.threads.some((item) => item.projectId === dialog.project!.id)))
											}
											title={
												workspaceId !== 'local'
													? 'Remove projects containing host folders or chats on the host computer.'
													: undefined
											}
											onClick={() => {
												const id = dialog.project!.id;
												for (const item of stateRef.current.threads)
													if (item.projectId === id) stopTask(item.id);
												setState((s) => ({
													...s,
													projects: s.projects.filter((p) => p.id !== id),
													threads: s.threads.map((t) =>
														t.projectId === id ? { ...t, projectId: undefined } : t,
													),
												}));
												if (projectId === id) setProjectId(null);
												setDialog(null);
											}}
										>
											Remove project
										</button>
									)}
									<button
										className="secondary-button"
										disabled={projectSaving}
										onClick={closeDialog}
									>
										Cancel
									</button>
									<button
										className={`primary-button ${dialog.kind === 'delete' ? 'destructive' : ''}`}
										disabled={projectSaving || (dialog.kind !== 'delete' && !dialogName.trim())}
										onClick={() => {
											if (dialog.kind === 'project') saveProject();
											else if (dialog.kind === 'rename') {
												updateThread(dialog.thread.id, (t) => ({
													...t,
													title: dialogName.trim(),
													titleSource: 'manual',
												}));
												setDialog(null);
											} else if (dialog.kind === 'delete') {
												stopTask(dialog.thread.id);
												setState((s) => ({
													...s,
													threads: s.threads.filter((t) => t.id !== dialog.thread.id),
												}));
												if (threadId === dialog.thread.id) newChat();
												setDialog(null);
											}
										}}
									>
										{projectSaving
											? 'Creating folder…'
											: dialog.kind === 'project'
												? dialog.project
													? 'Save project'
													: 'Create project'
												: dialog.kind === 'delete'
													? 'Delete'
													: 'Save'}
									</button>
								</footer>
							</div>
						)}
					</section>
				</div>
			)}
		</div>
	);
}
