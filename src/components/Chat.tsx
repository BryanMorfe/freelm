import { motionScrollBehavior } from '../lib/motion';
import {
	Fragment,
	lazy,
	Suspense,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from 'react';
import {
	ArrowDown,
	ArrowUp,
	Check,
	FileText,
	Flag,
	ListTodo,
	Image,
	Lightbulb,
	LoaderCircle,
	Plus,
	Sparkles,
	Square,
	X,
} from 'lucide-react';
import type { ComposerContext, ComposerDiscoveryResult } from '../composer-types';
import { latestComposerMode } from '../lib/composer-context';
import type { CodePermissionMode } from '../agent-types';
import type {
	Attachment,
	ChatDraft,
	Connection,
	ConversationKind,
	DictationSettings,
	Project,
	ReplyReference,
	Thread,
} from '../types';
import { assertModelSupports, getModelDefinition, thinkingParameters } from '../lib/catalog';
import { projectKind } from '../lib/conversation-kind';
import { userMessageSeparators } from '../lib/message-dates';
import { conversationNodes, conversationVersionInfo } from '../lib/conversation-tree';
import { pruneCodeQueueFailures } from '../lib/code-queue';
import { textAttachment } from '../lib/composer-content';
import { userFacingError } from '../lib/user-facing-error';
import ChatModelPicker from './ChatModelPicker';
import ChatMessage from './ChatMessage';
import DictationButton from './DictationButton';
import ReplyReferencePreview from './ReplyReferencePreview';
import CodeContextBar, { type CodeWorkspaceOption } from './CodeContextBar';
import CodePermissionPicker from './CodePermissionPicker';
import CodeMessageQueue from './CodeMessageQueue';
import ComposerDrawer from './ComposerDrawer';
import ComposerToolbar from './ComposerToolbar';
import type { MarkdownComposerHandle } from './MarkdownComposer';
import type { PluginSurfaceController } from '../lib/plugin-surface-controller';
import { usePluginSurfaces } from './usePluginSurfaces';
import { PluginComposerDrawer, PluginPlaceholderAction } from './PluginComposerContributions';
import './conversation-workspaces.css';

const MarkdownComposer = lazy(() => import('./MarkdownComposer'));

const chatSuggestions = [
	[
		Lightbulb,
		'Explore an idea',
		'Help me think through an idea. Ask me a few thoughtful questions to get started.',
	],
	[Sparkles, 'Make a plan', 'Help me turn a goal into a realistic plan. Ask about the goal first.'],
	[Image, 'Find inspiration', 'Help me brainstorm a creative direction for my next project.'],
] as const;

interface Props {
	pluginSurface?: PluginSurfaceController;
	composerInsertion?: { id: string; text: string; attachments: Attachment[] };
	onComposerInsertionConsumed?: (id: string) => void;
	goalControls?: ReactNode;
	onComposerDiscover?: (request: {
		kind: 'files' | 'skills' | 'apps';
		query: string;
	}) => Promise<ComposerDiscoveryResult>;
	approvalPrompt?: ReactNode;
	computerApprovalPending?: boolean;
	interactionPrompt?: ReactNode;
	interactionPending?: boolean;
	permissionMode?: CodePermissionMode;
	onPermissionMode?: (value: CodePermissionMode) => void;
	permissionReadOnly?: boolean;
	workspaceId?: string;
	workspaceName?: string;
	workspaceOptions?: CodeWorkspaceOption[];
	onWorkspaceChange?: (id: string) => void;
	draftScope?: string;
	draft?: ChatDraft;
	onDraftChange?: (draft: ChatDraft) => void;
	onEditMessage?: (id: string, content: string, attachments: Attachment[]) => void | Promise<void>;
	onRegenerate?: (id: string) => void;
	onBranch?: (id: string) => void;
	onSelectVersion?: (id: string, direction: -1 | 1) => void;
	dictation?: DictationSettings;
	dictationConnection?: Connection;
	onDictationSettings?: () => void;
	draftKey?: number;
	conversationKind?: ConversationKind;
	debugMode?: boolean;
	thread?: Thread;
	project?: Project;
	projectReadOnly?: boolean;
	connection: Connection;
	model: string;
	thinkingMode: string;
	onThinkingMode: (value: string) => void;
	busy: boolean;
	runningHere: boolean;
	canQueue?: boolean;
	canSteer?: boolean;
	onQueueEdit?: (
		id: string,
		content: string,
		attachments: Attachment[],
		replyTo?: ReplyReference,
		composer?: ComposerContext,
	) => void;
	onQueueRemove?: (id: string) => void;
	onQueueSteer?: (id: string) => void;
	onQueueRetry?: (failureId: string) => void;
	onQueueEditing?: (id?: string) => void;
	onModel: (v: string) => void;
	onSend: (
		content: string,
		attachments: Attachment[],
		replyTo?: ReplyReference,
		composer?: ComposerContext,
	) => void | Promise<void>;
	onStop: () => void;
	onRetry: () => void;
	onSettings: () => void;
	onSetupConnection?: () => void;
	toolsEnabled?: boolean;
	onToolsSettings?: () => void;
	onEditProject?: (project: Project) => void;
	onNewProject?: () => void;
	onMove: (projectId: string | undefined) => void;
	projects: Project[];
}
export default function Chat(p: Props) {
	const kind = p.conversationKind || 'chat';
	const isCode = kind === 'code';
	const desktopTools =
		typeof window !== 'undefined' && typeof window.desktop?.toolExecute === 'function';
	const currentProjectId = p.thread?.projectId || p.project?.id || '';
	const currentProject = p.project || p.projects.find((project) => project.id === currentProjectId);
	const otherKindProject =
		currentProject && projectKind(currentProject) !== kind ? currentProject : undefined;
	const [draft, setDraftState] = useState(p.draft?.content || '');
	const [attachments, setAttachmentState] = useState<Attachment[]>(p.draft?.attachments || []);
	const [replyTo, setReplyTo] = useState<ReplyReference | undefined>(p.draft?.replyTo);
	const initialComposer = (): ComposerContext | undefined =>
		p.draft
			? p.draft.composer
			: isCode && latestComposerMode(p.thread?.messages || []) === 'plan'
				? { mode: 'plan' }
				: undefined;
	const [composerContext, setComposerContext] = useState<ComposerContext | undefined>(
		initialComposer,
	);
	const [editingQueueId, setEditingQueueId] = useState<string>();
	const hasDraft = !!draft.trim() || attachments.length > 0;
	const showStop = p.runningHere && !editingQueueId && (!hasDraft || (!isCode && !p.canSteer));
	const queueEdit = useRef<
		| {
				id: string;
				scope: string;
				previous: ChatDraft;
				onDraftChange: Props['onDraftChange'];
				onQueueEditing: Props['onQueueEditing'];
		  }
		| undefined
	>(undefined);
	const draftValue = useRef({
		content: p.draft?.content || '',
		attachments: p.draft?.attachments || [],
		replyTo: p.draft?.replyTo,
		composer: initialComposer(),
	});
	const draftScope = p.draftScope || `${kind}:${p.thread?.id || p.project?.id || 'new'}`;
	const activeScope = useRef(draftScope);
	activeScope.current = draftScope;
	useEffect(
		() => () => {
			const edit = queueEdit.current;
			if (edit?.scope !== draftScope) return;
			queueEdit.current = undefined;
			clearTimeout(draftSave.current.timer);
			draftSave.current = {};
			edit.onQueueEditing?.();
			edit.onDraftChange?.({ ...edit.previous, updatedAt: Date.now() });
		},
		[draftScope],
	);
	const dictationScope = `${draftScope}:${p.draftKey || 0}`;
	const activeDictationScope = useRef(dictationScope);
	activeDictationScope.current = dictationScope;
	const draftSave = useRef<{
		timer?: ReturnType<typeof setTimeout>;
		value?: ChatDraft;
		save?: Props['onDraftChange'];
	}>({});
	function flushDraft() {
		const pending = draftSave.current;
		clearTimeout(pending.timer);
		draftSave.current = {};
		if (pending.value) pending.save?.(pending.value);
	}
	useEffect(() => {
		window.addEventListener('freelm:flush-drafts', flushDraft);
		window.addEventListener('pagehide', flushDraft);
		window.addEventListener('beforeunload', flushDraft);
		return () => {
			window.removeEventListener('freelm:flush-drafts', flushDraft);
			window.removeEventListener('pagehide', flushDraft);
			window.removeEventListener('beforeunload', flushDraft);
		};
	}, []);
	useEffect(() => () => flushDraft(), [draftScope]);
	function updateDraft(
		content: string,
		files = draftValue.current.attachments,
		immediate = false,
		reference = draftValue.current.replyTo,
		composer = draftValue.current.composer,
	) {
		draftValue.current = { content, attachments: files, replyTo: reference, composer };
		p.pluginSurface?.notifyDraftChanged();
		setDraftState(content);
		setAttachmentState(files);
		setReplyTo(reference);
		setComposerContext(composer);
		clearTimeout(draftSave.current.timer);
		draftSave.current = {
			value: { content, attachments: files, replyTo: reference, composer, updatedAt: Date.now() },
			save: p.onDraftChange,
		};
		if (immediate) flushDraft();
		else draftSave.current.timer = setTimeout(flushDraft, 150);
	}
	function setDraft(value: string | ((content: string) => string)) {
		updateDraft(typeof value === 'function' ? value(draftValue.current.content) : value);
	}
	function setAttachments(value: Attachment[] | ((files: Attachment[]) => Attachment[])) {
		updateDraft(
			draftValue.current.content,
			typeof value === 'function' ? value(draftValue.current.attachments) : value,
		);
	}
	const lastInsertion = useRef<string | undefined>(undefined);
	useEffect(() => {
		const insertion = p.composerInsertion;
		if (!insertion || insertion.id === lastInsertion.current) return;
		lastInsertion.current = insertion.id;
		const current = draftValue.current;
		updateDraft(
			[current.content, insertion.text].filter(Boolean).join('\n\n'),
			[...current.attachments, ...insertion.attachments],
			true,
		);
		pendingComposerFocus.current = draftScope;
		p.onComposerInsertionConsumed?.(insertion.id);
	}, [p.composerInsertion?.id]);
	const [attachError, setAttachError] = useState('');
	const [submitting, setSubmitting] = useState(false);
	const [dictationSession, setDictationSession] = useState<string>();
	const dictationSessionRef = useRef<string | undefined>(undefined);
	const submissionScope = useRef<string | undefined>(undefined);
	const dictating = !isCode && dictationSession === dictationScope;
	const [showJump, setShowJump] = useState(false);
	const [dateNow, setDateNow] = useState(Date.now);
	const [timeZone, setTimeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
	const messageDates = useMemo(
		() => userMessageSeparators(p.thread?.messages || [], { now: dateNow, timeZone }),
		[p.thread?.messages, dateNow, timeZone],
	);
	const messageVersions = useMemo(
		() =>
			p.thread
				? conversationVersionInfo(p.thread)
				: new Map<string, { index: number; count: number }>(),
		[p.thread?.messages, p.thread?.messageHistory],
	);
	const viewport = useRef<HTMLDivElement>(null);
	const messageList = useRef<HTMLDivElement>(null);
	const composerEditor = useRef<MarkdownComposerHandle>(null);
	const composerFocused = useRef(false);
	const pendingAttachments = useRef(0);
	const pendingComposerFocus = useRef<string | undefined>(undefined);
	useLayoutEffect(() => {
		if (submitting || pendingComposerFocus.current !== draftScope) return;
		pendingComposerFocus.current = undefined;
		composerEditor.current?.focus();
	});
	const fileInput = useRef<HTMLInputElement>(null);
	const follow = useRef(true);
	const revealSend = useRef<{ previous?: string } | undefined>(undefined);
	const lastUserId = p.thread?.messages.slice().reverse().find(message => message.role === 'user')?.id;
	const hasMessages = !!p.thread?.messages.length;
	useLayoutEffect(() => {
		if (!revealSend.current || lastUserId === revealSend.current.previous) return;
		follow.current = true;
		const scroll = viewport.current;
		if (scroll) scroll.scrollTop = scroll.scrollHeight;
		setShowJump(false);
		const frame = requestAnimationFrame(() => {
			if (scroll) scroll.scrollTop = scroll.scrollHeight;
			revealSend.current = undefined;
		});
		return () => cancelAnimationFrame(frame);
	}, [lastUserId]);
	const approvalPending = isCode && !!p.approvalPrompt;
	const queueFailures = useMemo(() => {
		if (!p.thread?.codeQueueFailures?.length) return [];
		const failures = pruneCodeQueueFailures(p.thread.codeQueueFailures, p.thread.messages);
		if (!failures.length) return [];
		const nodes = new Map(conversationNodes(p.thread).map((message) => [message.id, message]));
		return failures.map((failure) => ({
			...failure,
			messages: failure.messageIds.flatMap((id) => {
				const message = nodes.get(id);
				return message?.role === 'user' ? [message] : [];
			}),
		}));
	}, [p.thread?.codeQueueFailures, p.thread?.messages, p.thread?.messageHistory]);
	useEffect(() => {
		let timer: number;
		const refreshDates = () => {
			const now = Date.now();
			setDateNow(now);
			setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
			const midnight = new Date(now);
			midnight.setHours(24, 0, 0, 0);
			window.clearTimeout(timer);
			timer = window.setTimeout(refreshDates, midnight.getTime() - now + 50);
		};
		const onVisibility = () => {
			if (document.visibilityState === 'visible') refreshDates();
		};
		refreshDates();
		window.addEventListener('focus', refreshDates);
		document.addEventListener('visibilitychange', onVisibility);
		return () => {
			window.clearTimeout(timer);
			window.removeEventListener('focus', refreshDates);
			document.removeEventListener('visibilitychange', onVisibility);
		};
	}, []);
	let modelError = '';
	if (p.model) {
		try {
			const hasImages =
				attachments.some((attachment) => attachment.type.startsWith('image/')) ||
				p.thread?.messages.some((m) => m.attachments?.some((a) => a.type.startsWith('image/')));
			assertModelSupports(p.connection, p.model, 'chat', hasImages ? ['image'] : []);
			thinkingParameters(p.connection, p.model, p.thinkingMode);
		} catch (error) {
			modelError = error instanceof Error ? error.message : String(error);
		}
	}
	useLayoutEffect(() => {
		const value = {
			content: p.draft?.content || '',
			attachments: p.draft?.attachments || [],
			replyTo: p.draft?.replyTo,
			composer: initialComposer(),
		};
		draftValue.current = value;
		pendingAttachments.current = 0;
		p.pluginSurface?.notifyDraftChanged();
		setDraftState(value.content);
		setAttachmentState(value.attachments);
		setReplyTo(value.replyTo);
		setComposerContext(value.composer);
		setAttachError('');
		setSubmitting(false);
		pendingComposerFocus.current = undefined;
		setEditingQueueId(undefined);
		setDictationSession(undefined);
		dictationSessionRef.current = undefined;
		submissionScope.current = undefined;
		follow.current = true;
	}, [draftScope, p.draftKey]);
	// Once the request is owned by the thread, keep its next draft editable while
	// streaming. The thread's busy flag still prevents a second concurrent send.
	useEffect(() => {
		if (p.runningHere) setSubmitting(false);
	}, [p.runningHere]);
	useEffect(() => {
		const scroll = viewport.current;
		const messages = messageList.current;
		if (!scroll || !messages) return;
		let frame = 0;
		const followLatest = () => {
			if (!follow.current) return;
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				if (follow.current) scroll.scrollTop = scroll.scrollHeight;
			});
		};
		const observer = new ResizeObserver(followLatest);
		observer.observe(messages);
		observer.observe(scroll);
		followLatest();
		return () => {
			observer.disconnect();
			cancelAnimationFrame(frame);
		};
	}, [p.thread?.id, hasMessages]);
	const pluginPresentation = usePluginSurfaces(p.pluginSurface, {
		state: () => {
			const current = draftValue.current;
			const hasContext = !!(
				current.composer?.references?.length || current.composer?.mode === 'goal'
			);
			const last = p.thread?.messages.at(-1);
			const awaitingInput = approvalPending || p.interactionPending === true;
			const working = p.runningHere || submitting || awaitingInput;
			return {
				empty:
					!current.content.length &&
					!current.attachments.length &&
					!current.replyTo &&
					!hasContext &&
					!pendingAttachments.current &&
					!editingQueueId,
				editable: !submitting && !p.computerApprovalPending,
				focused: composerFocused.current,
				working,
				running: p.runningHere,
				hasAttachments: current.attachments.length > 0,
				hasReply: !!current.replyTo,
				hasContext,
				pendingAttachments: pendingAttachments.current > 0,
				queueEditing: !!editingQueueId,
				hasQueuedMessages: !!p.thread?.queuedMessages?.length,
				awaitingInput,
				hasCompletedTurn:
					!!last &&
					last.role === 'assistant' &&
					!p.runningHere &&
					(!!last.completedAt || !!last.content.trim()) &&
					!last.error &&
					!last.interrupted,
			};
		},
		readDraft: () => ({
			text: draftValue.current.content,
			attachments: draftValue.current.attachments.map(({ name, type }) => ({ name, type })),
		}),
		getSelection: () => composerEditor.current?.getSelection() ?? { from: 0, to: 0, text: '' },
		applyEdit: (edit) => {
			if (!composerEditor.current) throw new Error('The editor is still loading.');
			composerEditor.current.applyEdit(edit);
		},
		readAttachments: () => draftValue.current.attachments,
		removeAttachment: (index) => setAttachments((files) => files.filter((_, i) => i !== index)),
		addAttachment: (attachment) => {
			if (
				!attachment ||
				typeof attachment.name !== 'string' ||
				!attachment.name ||
				attachment.name.length > 255 ||
				typeof attachment.type !== 'string' ||
				typeof attachment.dataUrl !== 'string'
			)
				throw new Error('Invalid attachment.');
			if (draftValue.current.attachments.length >= 6)
				throw new Error('Remove an attachment before adding more.');
			const image = attachment.type.startsWith('image/');
			if (!image && attachment.type !== 'text/plain')
				throw new Error('Chat attachments must be images or plain text.');
			const prefixes = image
				? [`data:${attachment.type};base64,`]
				: ['data:text/plain;charset=utf-8;base64,', 'data:text/plain;base64,'];
			const prefix = prefixes.find((value) => attachment.dataUrl.startsWith(value));
			if (!prefix) throw new Error('Invalid attachment data.');
			const encoded = attachment.dataUrl.slice(prefix.length);
			if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0)
				throw new Error('Invalid attachment encoding.');
			const size =
				(encoded.length * 3) / 4 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
			if (size > (image ? 20 * 1024 * 1024 : 200_000))
				throw new Error(
					image
						? 'Choose images smaller than 20 MB.'
						: 'Text attachments must be smaller than 200 KB.',
				);
			if (image && p.model) assertModelSupports(p.connection, p.model, 'chat', ['image']);
			setAttachments((files) => [...files, attachment]);
		},
	});
	async function attach(files: FileList | null) {
		if (!files) return;
		const scope = draftScope;
		pendingAttachments.current++;
		p.pluginSurface?.notifyDraftChanged();
		setAttachError('');
		try {
			const next: Attachment[] = [];
			for (const file of Array.from(files)) {
				if (file.size > 20 * 1024 * 1024) throw new Error('Choose files smaller than 20 MB.');
				if (
					/^(audio|video)\//.test(file.type) ||
					/\.(mp3|mp4|wav|m4a|webm|ogg|flac|mov|mpeg)$/i.test(file.name)
				)
					throw new Error(
						'Audio and video chat attachments are not supported yet. Use the audio or video playground.',
					);
				if (!file.type.startsWith('image/')) {
					if (file.size > 200000) throw new Error('Text attachments must be smaller than 200 KB.');
					const content = await file.text();
					next.push(textAttachment(content, file.name));
					continue;
				}
				if (p.model) assertModelSupports(p.connection, p.model, 'chat', ['image']);
				const dataUrl = await new Promise<string>((resolve, reject) => {
					const r = new FileReader();
					r.onload = () => resolve(String(r.result));
					r.onerror = () => reject(new Error('Could not read the file.'));
					r.readAsDataURL(file);
				});
				next.push({ name: file.name, type: file.type, dataUrl });
			}
			if (activeScope.current === scope) setAttachments((a) => [...a, ...next].slice(0, 6));
		} catch (e) {
			if (activeScope.current === scope) setAttachError(e instanceof Error ? e.message : String(e));
		} finally {
			if (activeScope.current === scope) {
				pendingAttachments.current = Math.max(0, pendingAttachments.current - 1);
				p.pluginSurface?.notifyStateChanged();
			}
			if (fileInput.current) fileInput.current.value = '';
		}
	}
	function replyToSelection(messageId: string, text: string) {
		if (!text.trim()) return;
		if (text.length > 100_000) {
			setAttachError('Select a shorter passage to reply to.');
			return;
		}
		updateDraft(draftValue.current.content, draftValue.current.attachments, true, {
			messageId,
			text,
		});
		composerEditor.current?.focus();
	}
	async function submit(fromDictation = false) {
		const { content: draft, attachments, replyTo: reference, composer } = draftValue.current;
		if (
			submissionScope.current === draftScope ||
			submitting ||
			(p.busy && !p.canQueue && !p.canSteer) ||
			modelError ||
			(!fromDictation && dictationSessionRef.current === dictationScope) ||
			(!draft.trim() && !attachments.length)
		)
			return;
		if (!p.model.trim()) {
			p.onSettings();
			return;
		}
		const content = draft.trim()
			? draft
			: attachments.some((attachment) => attachment.type.startsWith('image/'))
				? 'Describe this image.'
				: 'Read the attached text.';
		const files = attachments;
		const scope = draftScope;
		if (editingQueueId && queueEdit.current) {
			try {
				p.onQueueEdit?.(editingQueueId, content, files, reference, composer);
			} catch (error) {
				setAttachError(error instanceof Error ? error.message : String(error));
				return;
			}
			finishQueueEdit();
			return;
		}
		submissionScope.current = scope;
		if (!(isCode && p.busy)) revealSend.current = { previous: lastUserId };
		setSubmitting(true);
		// Dictation can insert and send in one React batch, leaving the value prop
		// unchanged. Clear the editor and its history explicitly on accepted sends.
		composerEditor.current?.clear();
		draftValue.current.replyTo = undefined;
		draftValue.current.composer =
			isCode && composer?.mode === 'plan' ? { mode: 'plan' } : undefined;
		updateDraft('', [], true);
		follow.current = true;
		try {
			await p.onSend(content, files, reference, isCode ? composer : undefined);
		} catch (cause) {
			revealSend.current = undefined;
			if (activeScope.current === scope) {
				if (
					!draftValue.current.content &&
					!draftValue.current.attachments.length &&
					!draftValue.current.replyTo
				)
					updateDraft(content, files, false, reference, composer);
				setAttachError(cause instanceof Error ? cause.message : String(cause));
			}
		} finally {
			if (activeScope.current === scope) {
				submissionScope.current = undefined;
				// Focus after the editor's next commit restores its editable state.
				pendingComposerFocus.current = scope;
				setSubmitting(false);
			}
		}
	}
	function editQueuedMessage(id: string) {
		const queued = p.thread?.queuedMessages?.find((message) => message.id === id);
		if (!queued || queueEdit.current) return;
		flushDraft();
		queueEdit.current = {
			id,
			scope: draftScope,
			previous: { ...draftValue.current, updatedAt: Date.now() },
			onDraftChange: p.onDraftChange,
			onQueueEditing: p.onQueueEditing,
		};
		p.onQueueEditing?.(id);
		setEditingQueueId(id);
		updateDraft(queued.content, queued.attachments || [], true, queued.replyTo, queued.composer);
		composerEditor.current?.focus();
	}
	function finishQueueEdit() {
		const edit = queueEdit.current;
		if (!edit) return;
		queueEdit.current = undefined;
		setEditingQueueId(undefined);
		edit.onQueueEditing?.();
		updateDraft(
			edit.previous.content,
			edit.previous.attachments,
			true,
			edit.previous.replyTo,
			edit.previous.composer,
		);
		composerEditor.current?.focus();
	}
	return (
		<div
			className={`chat-workspace ${isCode ? 'code-workspace' : ''} ${!hasMessages ? 'is-empty' : ''}`}
			data-conversation-kind={kind}
		>
			<div
				className="chat-scroll"
				ref={viewport}
				onScroll={() => {
					if (revealSend.current) return;
					const v = viewport.current!;
					follow.current = v.scrollHeight - v.scrollTop - v.clientHeight < 100;
					setShowJump(!follow.current);
				}}
			>
				{!hasMessages ? (
					<div className="welcome">
						{!isCode && (
							<div className="welcome-mark">
								<Sparkles size={25} strokeWidth={1.4} />
							</div>
						)}
						<h1>
							{currentProject && !otherKindProject
								? isCode
									? `What should we work on in ${currentProject.name}?`
									: `How can I help with ${currentProject.name}?`
								: isCode
									? 'What should we work on?'
									: 'What’s on your mind?'}
						</h1>
						{!isCode && <p>A little curiosity can go a long way.</p>}
					</div>
				) : (
					<div className="messages" ref={messageList}>
						{p.thread!.messages.map((message, index) => {
							const last = index === p.thread!.messages.length - 1;
							const modelId = message.model || p.thread?.model || '';
							const dateLabel = messageDates.get(message.id);
							return (
								<Fragment key={message.id}>
									{dateLabel && (
										<div className="message-date">
											<time dateTime={new Date(message.createdAt).toISOString()}>{dateLabel}</time>
										</div>
									)}
									<ChatMessage
										message={message}
										timeZone={timeZone}
										conversationKind={kind}
										debugMode={p.debugMode}
										modelId={modelId}
										modelName={
											getModelDefinition(p.connection, modelId)?.name || modelId || 'Assistant'
										}
										live={last && p.runningHere}
										retryDisabled={p.busy || !!modelError}
										onRetry={
											message.role === 'assistant'
												? p.onRegenerate
													? () => p.onRegenerate?.(message.id)
													: last
														? p.onRetry
														: undefined
												: undefined
										}
										onEdit={
											p.onEditMessage
												? (content, files) => p.onEditMessage?.(message.id, content, files)
												: undefined
										}
										onBranch={
											message.role === 'assistant' && p.onBranch
												? () => p.onBranch?.(message.id)
												: undefined
										}
										onReply={(text) => replyToSelection(message.id, text)}
										versions={messageVersions.get(message.id)}
										onSelectVersion={
											p.onSelectVersion
												? (direction) => p.onSelectVersion?.(message.id, direction)
												: undefined
										}
									/>
									{isCode &&
										last &&
										message.role === 'assistant' &&
										message.completedAt !== undefined &&
										!message.error &&
										!message.interrupted &&
										!p.runningHere &&
										latestComposerMode(p.thread!.messages.slice(0, index)) === 'plan' &&
										message.content.trim() && (
											<div className="code-plan-action">
												<button
													type="button"
													disabled={p.busy || !!modelError}
													onClick={() => {
														updateDraft(
															draftValue.current.content,
															draftValue.current.attachments,
															true,
															draftValue.current.replyTo,
															{ ...composerContext, mode: undefined },
														);
														void p.onSend('Implement the plan above.', [], undefined, {});
													}}
												>
													Implement plan
													<ArrowUp size={15} />
												</button>
											</div>
										)}
								</Fragment>
							);
						})}
					</div>
				)}
			</div>
			{showJump && hasMessages && (
				<button
					className="jump-button icon-button"
					aria-label="Scroll to latest"
					onClick={() => {
						follow.current = true;
						viewport.current?.scrollTo({
							top: viewport.current.scrollHeight,
							behavior: motionScrollBehavior(),
						});
					}}
				>
					<ArrowDown size={18} />
				</button>
			)}
			<div className="composer-area">
				{!p.model && !hasMessages && (
					<button className="connection-prompt" onClick={p.onSetupConnection ?? p.onSettings}>
						<span className="status-dot" />
						<span>Connect an API to get started</span>
						<span>
							Set up <ArrowUp size={13} />
						</span>
					</button>
				)}
				{approvalPending && <div className="composer composer-approval">{p.approvalPrompt}</div>}
				{p.interactionPrompt}
				<ComposerDrawer>
					{p.goalControls}
					{pluginPresentation.drawer.length > 0 && (
						<PluginComposerDrawer controller={p.pluginSurface} items={pluginPresentation.drawer} />
					)}
					{isCode && (!!p.thread?.queuedMessages?.length || !!queueFailures.length) && (
						<CodeMessageQueue
							messages={p.thread?.queuedMessages || []}
							failures={queueFailures}
							running={p.runningHere}
							editingId={editingQueueId}
							disabled={p.busy && !p.canQueue}
							onEdit={editQueuedMessage}
							onRemove={(id) => p.onQueueRemove?.(id)}
							onSteer={(id) => p.onQueueSteer?.(id)}
							onRetry={p.onQueueRetry}
						/>
					)}
					{isCode && !hasMessages && !approvalPending && (
						<CodeContextBar
							project={otherKindProject ? undefined : currentProject}
							projects={p.projects}
							onProjectChange={p.onMove}
							onNewProject={p.onNewProject}
							onEditProject={p.onEditProject}
							projectReadOnly={p.projectReadOnly || hasMessages}
							workspaceId={p.workspaceId}
							workspaceName={p.workspaceName}
							workspaceOptions={p.workspaceOptions}
							onWorkspaceChange={p.onWorkspaceChange}
							disabled={p.busy || submitting}
						/>
					)}
				</ComposerDrawer>
				<div
					className="composer"
					hidden={p.computerApprovalPending}
					onDragOver={(e) => e.preventDefault()}
					onDrop={(e) => {
						e.preventDefault();
						void attach(e.dataTransfer.files);
					}}
				>
					{editingQueueId && (
						<div className="queue-edit-notice">
							<span>Editing queued message</span>
							<button
								className="icon-button"
								aria-label="Cancel queued message edit"
								onClick={finishQueueEdit}
							>
								<X size={15} />
							</button>
						</div>
					)}
					{replyTo && (
						<ReplyReferencePreview
							reference={replyTo}
							onRemove={() => {
								draftValue.current.replyTo = undefined;
								updateDraft(draftValue.current.content, draftValue.current.attachments, true);
								composerEditor.current?.focus();
							}}
						/>
					)}
					{attachments.length > 0 && (
						<div className="attachment-preview">
							{attachments.map((a, i) => (
								<div key={`${a.name}-${i}`}>
									{a.type.startsWith('image/') ? (
										<img src={a.dataUrl} alt={a.name} />
									) : (
										<div className="attachment-document">
											<FileText size={18} />
											<span>{a.name}</span>
										</div>
									)}
									<button
										className="icon-button"
										aria-label={`Remove ${a.name}`}
										onClick={() => setAttachments((as) => as.filter((_, j) => i !== j))}
									>
										<X size={12} />
									</button>
								</div>
							))}
						</div>
					)}
					<Suspense fallback={<div className="composer-editor-loading" aria-hidden="true" />}>
						<MarkdownComposer
							key={`${draftScope}:${p.draftKey || 0}`}
							ref={composerEditor}
							value={draft}
							code={isCode}
							context={composerContext}
							onContextChange={(composer) =>
								updateDraft(
									draftValue.current.content,
									draftValue.current.attachments,
									false,
									draftValue.current.replyTo,
									composer,
								)
							}
							discover={p.onComposerDiscover}
							onRequestFiles={() => fileInput.current?.click()}
							disabled={submitting}
							busy={(p.busy && !p.canQueue && !p.canSteer) || submitting}
							onChange={setDraft}
							onBlur={flushDraft}
							onPluginKey={(key) => p.pluginSurface?.handleKey(key) ?? false}
							onFocusChange={(focused) => {
								composerFocused.current = focused;
								p.pluginSurface?.notifyStateChanged();
							}}
							onSelectionChange={() => p.pluginSurface?.notifySelectionChanged()}
							onSubmit={() => void submit()}
							onRestorePrevious={() => {
								if (attachments.length || replyTo) return false;
								const previous = p.thread?.messages
									.slice()
									.reverse()
									.find((message) => message.role === 'user');
								if (!previous) return false;
								draftValue.current.replyTo = previous.replyTo;
								updateDraft(
									previous.content,
									previous.attachments || [],
									false,
									previous.replyTo,
									previous.composer,
								);
								return true;
							}}
							onFiles={(files) => void attach(files)}
							onLargePaste={(text) => {
								if (draftValue.current.attachments.length >= 6)
									throw new Error('Remove an attachment before adding more.');
								setAttachments((files) => [...files, textAttachment(text)]);
							}}
							onError={setAttachError}
							placeholder={
								pluginPresentation.placeholder?.text ||
								(isCode
									? composerContext?.mode === 'plan'
										? 'Describe your task to generate a plan…'
										: composerContext?.mode === 'goal'
											? 'Describe the goal to keep pursuing…'
											: 'Describe a task, ask about your code, or plan a change'
									: 'Ask anything')
							}
						/>
					</Suspense>
					<PluginPlaceholderAction
						controller={p.pluginSurface}
						placeholder={pluginPresentation.placeholder}
					/>
					<ComposerToolbar dictating={dictating}>
						<div className="composer-tools">
							<input
								hidden
								ref={fileInput}
								type="file"
								accept="image/*,text/*,.md,.json,.csv,.py,.ts,.js,.swift,.rs,.yaml,.yml"
								multiple
								onChange={(e) => void attach(e.target.files)}
							/>
							<button
								className="icon-button composer-attach"
								title="Attach an image or text file"
								aria-label="Attach files"
								disabled={submitting}
								onClick={() => fileInput.current?.click()}
							>
								<Plus size={19} />
							</button>
							{isCode && (
								<CodePermissionPicker
									value={p.permissionMode}
									onChange={p.onPermissionMode}
									readOnly={p.permissionReadOnly}
									disabled={!desktopTools}
								/>
							)}
							{isCode && composerContext?.mode && (
								<button
									className="composer-mode-chip"
									type="button"
									aria-label={`Turn off ${composerContext.mode === 'plan' ? 'Plan' : 'Goal'} mode`}
									title={
										composerContext.mode === 'plan'
											? 'Create a plan'
											: 'Set a goal to keep pursuing'
									}
									onClick={() => {
										updateDraft(
											draftValue.current.content,
											draftValue.current.attachments,
											true,
											draftValue.current.replyTo,
											{ ...composerContext, mode: undefined },
										);
										composerEditor.current?.focus();
									}}
								>
									{composerContext.mode === 'plan' ? <ListTodo size={15} /> : <Flag size={15} />}
									<span>{composerContext.mode === 'plan' ? 'Plan' : 'Goal'}</span>
									<X size={12} />
								</button>
							)}
						</div>
						<div className="composer-actions">
							{!dictating && (
								<ChatModelPicker
									key={p.connection.id}
									connection={p.connection}
									model={p.model}
									thinkingMode={p.thinkingMode}
									onThinkingMode={p.onThinkingMode}
									disabled={false}
									onSelect={(model) => {
										p.onModel(model);
										composerEditor.current?.focus();
									}}
									onSettings={p.onSettings}
								/>
							)}
							{!isCode && (
								<DictationButton
									settings={p.dictation}
									connection={p.dictationConnection}
									scope={dictationScope}
									disabled={submitting}
									canSend={(!p.busy || !!p.canSteer) && !submitting && !modelError && !!p.model.trim()}
									onActiveChange={(active) => {
										if (activeDictationScope.current !== dictationScope) return;
										const session = active ? dictationScope : undefined;
										dictationSessionRef.current = session;
										setDictationSession(session);
									}}
									onConfigure={p.onDictationSettings || p.onSettings}
									onTranscript={(text, intent) => {
										if (activeDictationScope.current !== dictationScope) return;
										if (text) {
											if (composerEditor.current) composerEditor.current.insertText(text, true);
											else
												setDraft(
													(content) =>
														`${content}${content && !/\s$/.test(content) ? ' ' : ''}${text}`,
												);
											if (intent === 'send') void submit(true);
										}
									}}
								/>
							)}
							{!dictating &&
								(showStop ? (
									<button className="send-button" onClick={p.onStop} aria-label="Stop response">
										<Square size={15} fill="currentColor" />
									</button>
								) : (
									<button
										className={`send-button${editingQueueId ? ' queue-send-button' : ''}`}
										onClick={() => void submit()}
										disabled={(p.busy && !p.canQueue && !p.canSteer) || submitting || !!modelError || !hasDraft}
										aria-label={editingQueueId ? 'Save queued message' : 'Send message'}
										title={editingQueueId ? 'Save queued message' : 'Send message'}
									>
										{editingQueueId ? (
											<Check size={18} />
										) : (!isCode && p.busy && !p.canSteer) || submitting ? (
											<LoaderCircle size={18} className="spin" />
										) : (
											<ArrowUp size={18} />
										)}
									</button>
								))}
						</div>
					</ComposerToolbar>
				</div>
				{!approvalPending && modelError && (
					<div className="error-note" role="alert">
						{userFacingError(modelError)}
					</div>
				)}
				{!approvalPending && attachError && (
					<div className="error-note" role="alert">
						{userFacingError(attachError)}
					</div>
				)}
				{!approvalPending && isCode && desktopTools && !p.toolsEnabled && p.onToolsSettings && (
					<div className="code-tools-guidance">
						<span>Code tools are disabled.</span>{' '}
						<button onClick={p.onToolsSettings} disabled={p.busy}>
							Configure tools
						</button>
					</div>
				)}
				{!hasMessages && !isCode && (
					<div className="suggestions">
						{chatSuggestions.map(([Icon, label, prompt]) => {
							const I = Icon as typeof Lightbulb;
							return (
								<button
									key={String(label)}
									onClick={() => {
										setDraft(String(prompt));
										composerEditor.current?.focus();
									}}
								>
									<I size={15} />
									{String(label)}
								</button>
							);
						})}
					</div>
				)}
				<p className="composer-footnote">
					{isCode && !desktopTools
						? 'You can discuss code here. Running tools requires the desktop app.'
						: p.model
							? 'AI can make mistakes. Check important information.'
							: 'Your conversations stay on this device.'}
				</p>
			</div>
		</div>
	);
}
