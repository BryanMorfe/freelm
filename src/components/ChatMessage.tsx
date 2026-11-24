import { composerVisibleText } from '../lib/composer-mention-codec';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
	Check,
	ChevronLeft,
	ChevronRight,
	Copy,
	FileText,
	GitBranch,
	Minimize2,
	Pencil,
	RefreshCw,
	Reply,
} from 'lucide-react';
import type { Attachment, ConversationKind, Message } from '../types';
import { copyToClipboard } from '../lib/clipboard';
import { userFacingError } from '../lib/user-facing-error';
import { assistantMessageTime } from '../lib/message-dates';
import { ToolCallActivity } from './ToolActivity';
import MessageMarkdown from './MessageMarkdown';
import WorkingStatus from './WorkingStatus';
import ActivityHistory from './ActivityHistory';
import FileEditSummary from './FileEditSummary';
import { collectResearchResults } from '../lib/research';
import ResearchResults from './ResearchResults';
import ReplyReferencePreview from './ReplyReferencePreview';
import {
	activityDuration,
	formatActivityDuration,
	splitMessageActivity,
	toolActivityLabels,
} from '../lib/message-activity';
import './chat-activity.css';
import { isVideoFile } from '../lib/generated-video';

function CopyButton({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	return (
		<button
			className="icon-button"
			aria-label={copied ? 'Copied' : 'Copy'}
			title="Copy"
			onClick={async () => {
				try {
					await copyToClipboard(text);
					setCopied(true);
					clearTimeout(timer.current);
					timer.current = setTimeout(() => setCopied(false), 1800);
				} catch {
					setCopied(false);
				}
			}}
		>
			{copied ? <Check size={15} /> : <Copy size={15} />}
		</button>
	);
}

const MessageBody = memo(function MessageBody({
	message,
	live,
	kind,
	debugMode,
}: {
	message: Message;
	live: boolean;
	kind: ConversationKind;
	debugMode: boolean;
}) {
	const presentation = useMemo(() => splitMessageActivity(message), [message]);
	const research = useMemo(() => collectResearchResults(message.toolCalls), [message.toolCalls]);
	const toolLabels = useMemo(
		() => toolActivityLabels(message.toolCalls || [], !live),
		[message.toolCalls, live],
	);
	const files = useMemo(
		() =>
			message.toolCalls?.flatMap((call) =>
				call.status === 'completed'
					? call.result?.content.filter(
							(content) => content.type === 'file' && !isVideoFile(content),
						) || []
					: [],
			) || [],
		[message.toolCalls],
	);
	const [expanded, setExpanded] = useState(false);
	const { intermediate, finalText, callsById, imageCalls, hasActivity } = presentation;
	const compacted = !!message.agentTranscript?.context;
	const hasHistory = intermediate.length > 0 || compacted;
	const duration = activityDuration(
		kind === 'code' && typeof message.completedAt === 'number'
			? { ...message, activityFinishedAt: message.completedAt }
			: message,
	);
	if (message.role !== 'assistant') return <MessageMarkdown text={message.content} defer={live} />;
	const working =
		live &&
		!message.error &&
		(message.phase === 'working' ||
			(!message.phase && !message.content && !message.toolCalls?.length));
	const compacting = live && !message.error && message.phase === 'compacting';
	const codeRunActive = kind === 'code' && live && !message.error;
	const startedAt =
		(message as Message & { activityStartedAt?: number }).activityStartedAt ?? message.createdAt;
	const historyId = `thought-${message.id}`;
	const showActivity = !live && hasActivity && (kind === 'code' || duration >= 1_000);
	const showHistory = showActivity && hasHistory && expanded;
	const summaryClass = `thought-summary${kind === 'code' ? ' worked-section-header' : ''}`;
	return (
		<div className="message-timeline">
			{codeRunActive && <WorkingStatus startedAt={startedAt} header />}
			{showActivity && (
				<div className="thought-activity">
					{hasHistory ? (
						<button
							type="button"
							className={summaryClass}
							aria-expanded={expanded}
							aria-controls={historyId}
							onClick={() => setExpanded((value) => !value)}
						>
							<span>{`${kind === 'code' ? 'Worked' : 'Thought'} for ${formatActivityDuration(duration)}`}</span>
							<ChevronRight size={14} aria-hidden="true" />
						</button>
					) : (
						<div className={`${summaryClass} thought-summary-static`}>
							<span>{`${kind === 'code' ? 'Worked' : 'Thought'} for ${formatActivityDuration(duration)}`}</span>
						</div>
					)}
					{hasHistory && (
						<div id={historyId} hidden={!expanded}>
							{expanded && (
								<div className="thought-history" role="group" aria-label="Response activity">
									<ActivityHistory
										parts={intermediate}
										callsById={callsById}
										labels={toolLabels}
										debugMode={debugMode}
									/>
									{compacted && (
										<div className="thought-reasoning">
											<Minimize2 size={15} aria-hidden="true" />
											Compacted conversation context
										</div>
									)}
								</div>
							)}
						</div>
					)}
				</div>
			)}
			{live && (
				<div className="message-live-text">
					<ActivityHistory
						parts={intermediate}
						callsById={callsById}
						labels={toolLabels}
						debugMode={debugMode}
						live
					/>
				</div>
			)}
			{showHistory && (finalText || imageCalls.length > 0 || files.length > 0) && (
				<hr className="thought-output-divider" />
			)}
			{imageCalls.map((call) => (
				<ToolCallActivity key={call.id} call={call} live={live} assetsOnly />
			))}
			{files.length > 0 && (
				<div className="message-attachments">
					{files.map((file, index) =>
						file.type === 'file' &&
						/^data:[\w.+/-]+(?:;[^,]*)?;base64,[A-Za-z0-9+/=\s]+$/.test(file.dataUrl) ? (
							<a
								className="attachment-document"
								key={`${file.name}-${index}`}
								href={file.dataUrl}
								download={file.name}
							>
								<FileText size={18} />
								<span>{file.name}</span>
							</a>
						) : null,
					)}
				</div>
			)}
			{finalText && (
				<div className="message-final" data-reply-scope="assistant-final">
					<MessageMarkdown text={finalText} sources={research.sources} defer={live} />
				</div>
			)}
			<ResearchResults results={research} />
			{kind === 'code' && !live && <FileEditSummary calls={message.toolCalls} />}
			{working && <WorkingStatus />}
			{compacting && (
				<div
					className="working-status"
					role="status"
					aria-label="Compacting conversation"
					aria-live="polite"
				>
					<Minimize2 size={15} aria-hidden="true" />
					<span className="activity-shimmer">Compacting context</span>
				</div>
			)}
		</div>
	);
});

/** Only the visible final answer is quoteable, including selections made with the keyboard. */
function finalReplySelection(article: HTMLElement | null) {
	const current = window.getSelection();
	const scope = article?.querySelector<HTMLElement>(
		'[data-reply-scope="assistant-final"] > .message-content',
	);
	if (!scope || current?.rangeCount !== 1 || !current.toString().trim()) return null;
	const range = current.getRangeAt(0);
	if (
		!scope.contains(current.anchorNode) ||
		!scope.contains(current.focusNode) ||
		!scope.contains(range.startContainer) ||
		!scope.contains(range.endContainer)
	)
		return null;
	for (const element of scope.querySelectorAll(
		'button, input, textarea, select, [contenteditable="true"], [role="tooltip"]',
	))
		if (range.intersectsNode(element)) return null;
	return { text: current.toString(), range, scope };
}

interface Props {
	conversationKind?: ConversationKind;
	debugMode?: boolean;
	message: Message;
	timeZone?: string;
	modelName: string;
	modelId: string;
	live: boolean;
	retryDisabled: boolean;
	onRetry?: () => void;
	onRetryMessage?: (id: string) => void;
	onEdit?: (content: string, attachments: Attachment[]) => void | Promise<void>;
	onEditMessage?: (id: string, content: string, attachments: Attachment[]) => void | Promise<void>;
	onBranch?: () => void;
	onBranchMessage?: (id: string) => void;
	onReply?: (text: string) => void;
	onReplyMessage?: (id: string, text: string) => void;
	versions?: { index: number; count: number };
	onSelectVersion?: (direction: -1 | 1) => void;
	onSelectMessageVersion?: (id: string, direction: -1 | 1) => void;
}

export default memo(function ChatMessage({
	message,
	timeZone,
	live,
	retryDisabled,
	onRetry,
	onRetryMessage,
	onEdit,
	onEditMessage,
	onBranch,
	onBranchMessage,
	onReply,
	onReplyMessage,
	versions,
	onSelectVersion,
	onSelectMessageVersion,
	conversationKind = 'chat',
	debugMode = false,
}: Props) {
	const assistant = message.role === 'assistant';
	const time = useMemo(
		() => (assistant ? assistantMessageTime(message.createdAt, { timeZone }) : ''),
		[assistant, message.createdAt, timeZone],
	);
	const [context, setContext] = useState<{
		left: number;
		top: number;
		replyText?: string;
	} | null>(null);
	const [selection, setSelection] = useState<{ left: number; top: number } | null>(null);
	const [editing, setEditing] = useState(false);
	const [editContent, setEditContent] = useState(message.content);
	const [editError, setEditError] = useState('');
	const [editPending, setEditPending] = useState(false);
	const article = useRef<HTMLElement>(null);
	const canRetry = !!(onRetry || onRetryMessage);
	const canEdit = !!(onEdit || onEditMessage);
	const canBranch = !!(onBranch || onBranchMessage);
	const canReply = !!(onReply || onReplyMessage);
	const canSelectVersion = !!(onSelectVersion || onSelectMessageVersion);
	const replyAllowed = assistant && canReply && !editing;
	function selectedReply() {
		const current = replyAllowed ? finalReplySelection(article.current) : null;
		if (!current) {
			setSelection(null);
			return;
		}
		const rect = current.range.getBoundingClientRect();
		setSelection({
			left: Math.max(8, Math.min(rect.left, window.innerWidth - 180)),
			top: Math.max(8, Math.min(rect.top - 42, window.innerHeight - 48)),
		});
	}
	useEffect(() => {
		if (!selection) return;
		const close = (event: Event) => {
			if (!(event.target as Element)?.closest?.('.message-selection-reply')) setSelection(null);
		};
		const key = (event: KeyboardEvent) => {
			if (event.key === 'Escape') setSelection(null);
		};
		document.addEventListener('pointerdown', close);
		document.addEventListener('keydown', key);
		window.addEventListener('scroll', close, true);
		return () => {
			document.removeEventListener('pointerdown', close);
			document.removeEventListener('keydown', key);
			window.removeEventListener('scroll', close, true);
		};
	}, [selection]);
	const contextMenu = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		if (context) contextMenu.current?.querySelector<HTMLButtonElement>('button')?.focus();
	}, [context]);
	useEffect(() => {
		if (!context) return;
		const close = (event: Event) => {
			if (!contextMenu.current?.contains(event.target as Node)) setContext(null);
		};
		const keys = (event: KeyboardEvent) => {
			if (event.key === 'Escape' || event.key === 'Tab') setContext(null);
		};
		document.addEventListener('pointerdown', close);
		document.addEventListener('keydown', keys);
		window.addEventListener('scroll', close, true);
		window.addEventListener('resize', close);
		return () => {
			document.removeEventListener('pointerdown', close);
			document.removeEventListener('keydown', keys);
			window.removeEventListener('scroll', close, true);
			window.removeEventListener('resize', close);
		};
	}, [context]);
	const copyText = useMemo(
		() => (assistant ? splitMessageActivity(message).finalText : composerVisibleText(message.content)),
		[assistant, message],
	);
	return (
		<article
			ref={article}
			className={`message ${message.role}`}
			data-message-id={message.id}
			onPointerUp={(event) => {
				if (event.button === 0) selectedReply();
			}}
			onKeyUp={(event) => {
				if (event.shiftKey) selectedReply();
			}}
			onContextMenu={(event) => {
				const selectedText = window.getSelection()?.toString();
				const selected = replyAllowed ? finalReplySelection(article.current) : null;
				if (
					!copyText ||
					(selectedText && !selected) ||
					(selected && !selected.scope.contains(event.target as Node)) ||
					(event.target as Element).closest('a, button, input, textarea')
				)
					return;
				event.preventDefault();
				setSelection(null);
				setContext({
					left: Math.max(8, Math.min(event.clientX, window.innerWidth - 188)),
					top: Math.max(8, Math.min(event.clientY, window.innerHeight - (selected ? 100 : 60))),
					...(selected ? { replyText: selected.text } : {}),
				});
			}}
		>
			{replyAllowed &&
				selection &&
				createPortal(
					<button
						type="button"
						className="message-selection-reply"
						style={{ left: selection.left, top: selection.top }}
						onPointerDown={(event) => event.preventDefault()}
						onClick={() => {
							const current = finalReplySelection(article.current);
							if (current) {
								if (onReplyMessage) onReplyMessage(message.id, current.text);
								else onReply?.(current.text);
							}
							window.getSelection()?.removeAllRanges();
							setSelection(null);
						}}
					>
						<Reply size={15} /> Reply to selection
					</button>,
					document.body,
				)}
			{context &&
				createPortal(
					<div
						className="message-context-menu"
						ref={contextMenu}
						role="menu"
						aria-label="Message actions"
						style={{ left: context.left, top: context.top }}
						onKeyDown={(event) => {
							if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
							event.preventDefault();
							const items = Array.from(
								event.currentTarget.querySelectorAll<HTMLButtonElement>('button'),
							);
							const current = items.indexOf(document.activeElement as HTMLButtonElement);
							const next =
								event.key === 'Home'
									? 0
									: event.key === 'End'
										? items.length - 1
										: (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) %
											items.length;
							items[next]?.focus();
						}}
					>
						<button
							role="menuitem"
							onClick={() => {
								void copyToClipboard(context.replyText || copyText).catch(() => {});
								setContext(null);
							}}
						>
							<Copy size={15} /> {context.replyText ? 'Copy selection' : 'Copy message'}
						</button>
						{replyAllowed && context.replyText && (
							<button
								role="menuitem"
								onClick={() => {
									if (onReplyMessage) onReplyMessage(message.id, context.replyText!);
									else onReply?.(context.replyText!);
									window.getSelection()?.removeAllRanges();
									setContext(null);
								}}
							>
								<Reply size={15} /> Reply to selection
							</button>
						)}
					</div>,
					document.body,
				)}
			{message.replyTo && <ReplyReferencePreview reference={message.replyTo} />}
			{!!message.attachments?.length && (
				<div className="message-attachments">
					{message.attachments.map((attachment, index) =>
						attachment.type.startsWith('image/') ? (
							<img
								key={`${attachment.name}-${index}`}
								src={attachment.dataUrl}
								alt={attachment.name}
							/>
						) : (
							<a
								key={`${attachment.name}-${index}`}
								className="attachment-document"
								href={attachment.dataUrl}
								download={attachment.name}
							>
								<FileText size={18} />
								<span>{attachment.name}</span>
							</a>
						),
					)}
				</div>
			)}
			{editing ? (
				<form
					className="message-edit"
					onSubmit={async (event) => {
						event.preventDefault();
						if ((!editContent.trim() && !message.attachments?.length) || !canEdit || editPending)
							return;
						setEditPending(true);
						setEditError('');
						try {
							if (onEditMessage)
								await onEditMessage(message.id, editContent.trim(), message.attachments || []);
							else await onEdit?.(editContent.trim(), message.attachments || []);
							setEditing(false);
						} catch (cause) {
							setEditError(cause instanceof Error ? cause.message : String(cause));
						} finally {
							setEditPending(false);
						}
					}}
				>
					<textarea
						autoFocus
						aria-label="Edit message"
						value={editContent}
						onChange={(event) => setEditContent(event.target.value)}
						disabled={editPending}
						onKeyDown={(event) => {
							if (event.key === 'Escape') setEditing(false);
						}}
					/>
					<div className="message-edit-actions">
						<button
							type="button"
							className="secondary-button"
							disabled={editPending}
							onClick={() => setEditing(false)}
						>
							Cancel
						</button>
						<button
							type="submit"
							className="primary-button"
							disabled={
								editPending ||
								retryDisabled ||
								(!editContent.trim() && !message.attachments?.length)
							}
						>
							Save and send
						</button>
					</div>
					{editError && (
						<div className="error-note" role="alert">
							{userFacingError(editError)}
						</div>
					)}
				</form>
			) : !assistant ? (
				message.content.trim() ? (
					<div className="message-bubble">
						<MessageBody
							message={message}
							live={live}
							kind={conversationKind}
							debugMode={debugMode}
						/>
					</div>
				) : null
			) : (
				<MessageBody message={message} live={live} kind={conversationKind} debugMode={debugMode} />
			)}
			{message.error && (
				<div className="error-note" role="alert">
					{userFacingError(message.error)}
				</div>
			)}
			{message.interrupted && <div className="interrupted">Response stopped.</div>}
			{!live &&
				!editing &&
				(message.content ||
					message.error ||
					!!message.toolCalls?.length ||
					!!message.attachments?.length) &&
				(assistant || canEdit || (versions?.count || 0) > 1) && (
					<div className="message-footer">
						<div className="message-actions">
							{copyText && <CopyButton text={copyText} />}
							{!assistant && canEdit && (
								<button
									type="button"
									className="icon-button"
									aria-label="Edit message"
									title="Edit message"
									disabled={retryDisabled}
									onClick={() => {
										setEditContent(message.content);
										setEditError('');
										setEditing(true);
									}}
								>
									<Pencil size={15} />
								</button>
							)}
							{canRetry && (
								<button
									className="icon-button"
									aria-label="Regenerate response"
									disabled={retryDisabled}
									onClick={() => {
										if (onRetryMessage) onRetryMessage(message.id);
										else onRetry?.();
									}}
								>
									<RefreshCw size={15} />
								</button>
							)}
							{assistant && canBranch && (
								<button
									type="button"
									className="icon-button"
									aria-label="Branch conversation"
									title="Branch conversation from here"
									disabled={retryDisabled}
									onClick={() => {
										if (onBranchMessage) onBranchMessage(message.id);
										else onBranch?.();
									}}
								>
									<GitBranch size={15} />
								</button>
							)}
							{versions && versions.count > 1 && canSelectVersion && (
								<div className="message-versions" aria-label="Message versions">
									<button
										type="button"
										className="icon-button"
										aria-label="Previous response version"
										disabled={retryDisabled || versions.index === 0}
										onClick={() => {
											if (onSelectMessageVersion) onSelectMessageVersion(message.id, -1);
											else onSelectVersion?.(-1);
										}}
									>
										<ChevronLeft size={14} />
									</button>
									<span aria-live="polite">
										{versions.index + 1} / {versions.count}
									</span>
									<button
										type="button"
										className="icon-button"
										aria-label="Next response version"
										disabled={retryDisabled || versions.index + 1 >= versions.count}
										onClick={() => {
											if (onSelectMessageVersion) onSelectMessageVersion(message.id, 1);
											else onSelectVersion?.(1);
										}}
									>
										<ChevronRight size={14} />
									</button>
								</div>
							)}
						</div>
						{assistant && time && (
							<time className="message-time" dateTime={new Date(message.createdAt).toISOString()}>
								{time}
							</time>
						)}
					</div>
				)}
		</article>
	);
});
