import { userFacingError } from '../lib/user-facing-error';
import {
	forwardRef,
	memo,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import {
	AlertCircle,
	ArrowUp,
	Copy,
	Info,
	Lightbulb,
	MoreHorizontal,
	Pencil,
	Reply,
	RotateCcw,
	Square,
	Trash2,
	X,
} from 'lucide-react';
import type { BotConversation, BotMention, BotMessage, BotReactionEmoji } from '../bot-types';
import {
	formatBotMentionText,
	resolveBotMentions,
	validBotMentionSpans,
} from '../lib/bot-mentions';
import { copyToClipboard } from '../lib/clipboard';
import { BOT_REACTIONS as REACTIONS } from '../lib/bots';
import { userMessageDateLabel, assistantMessageTime } from '../lib/message-dates';
import {
	nextBotMessageAppearances,
	type BotMessageAppearanceSnapshot,
} from '../lib/bot-message-appearance';
import BotAvatar from './BotAvatar';
import BotJobs, { type BotJobItem, type BotJobAction } from './BotJobs';
import BotMessageBody from './BotMessageBody';
import MessageMarkdown from './MessageMarkdown';
import type { BotContact } from './bots-ui-types';
import './bots.css';

type Action = Promise<void> | void;
export interface BotsWorkspaceProps {
	conversation?: BotConversation;
	contacts: BotContact[];
	hostName: string;
	jobs?: BotJobItem[];
	onJobAction?: (job: BotJobItem, action: BotJobAction) => Action;
	loading?: boolean;
	error?: string;
	onSend: (content: string, replyTo?: string, mentions?: BotMention[]) => Action;
	onDraftChange: (content: string, mentions?: BotMention[]) => void;
	onReact: (message: BotMessage, emoji: BotReactionEmoji | null) => Action;
	onEdit: (message: BotMessage, content: string, mentions?: BotMention[]) => Action;
	onStop?: () => Action;
	onGroupReplyLimitChange?: (limit: number) => Action;
	onUnsend: (message: BotMessage) => Action;
	onRetry: (message: BotMessage) => Action;
	onCreateBot: () => void;
	onNewGroup: () => void;
	onEditBot: (contact: BotContact) => void;
}

function messageReadAt(message: BotMessage, participants: BotConversation['participants']) {
	if (message.role !== 'user' || participants.length === 0) return undefined;
	let latest = 0;
	for (const participant of participants) {
		const receipt = message.readBy?.find(
			(value) =>
				value.hostId === participant.hostId &&
				value.botId === participant.botId &&
				Number.isFinite(value.readAt) &&
				value.readAt > 0,
		);
		if (!receipt) return undefined;
		latest = Math.max(latest, receipt.readAt);
	}
	return latest;
}

export default function BotsWorkspace(p: BotsWorkspaceProps) {
	const [draft, setDraft] = useState(p.conversation?.draft || '');
	const [draftMentions, setDraftMentions] = useState<BotMention[]>(
		p.conversation?.draftMentions || [],
	);
	const [stopping, setStopping] = useState(false);
	const [profileOpen, setProfileOpen] = useState(false);
	const [reply, setReply] = useState<BotMessage>();
	const [error, setError] = useState('');
	const [submitting, setSubmitting] = useState(false);
	const composer = useRef<HTMLTextAreaElement>(null);
	const scroller = useRef<HTMLDivElement>(null);
	const header = useRef<HTMLElement>(null);
	const previousAppearances = useRef<BotMessageAppearanceSnapshot>(undefined);
	const following = useRef(true);
	const current = useRef(p.conversation?.id);
	const draftRef = useRef(draft);
	draftRef.current = draft;
	const participants =
		p.conversation?.participants
			.map((participant) =>
				p.contacts.find(
					(contact) =>
						contact.host.id === participant.hostId && contact.bot.id === participant.botId,
				),
			)
			.filter((contact): contact is BotContact => !!contact) || [];
	const visibleMessages =
		p.conversation?.messages.filter(
			(message) =>
				!(message.role === 'bot' && message.status === 'completed' && !message.content.trim()) &&
				!(message.role === 'bot' && message.status === 'pending' && message.activity !== 'writing'),
		) || [];
	const primary = participants[0];
	const group = (p.conversation?.participants.length || 0) > 1;
	const busy = !!p.conversation?.messages.some((message) => message.status === 'pending');
	const mentionRoster = useMemo(
		() =>
			(p.conversation?.participants || []).flatMap((participant) => {
				const contact = p.contacts.find(
					(item) => item.host.id === participant.hostId && item.bot.id === participant.botId,
				);
				return contact
					? [
							{
								...participant,
								name: contact.bot.name,
								address: contact.bot.address,
								hostName: contact.host.name,
							},
						]
					: [];
			}),
		[p.contacts, p.conversation?.participants],
	);
	const title = group
		? p.conversation?.title || participants.map(({ bot }) => bot.name).join(', ')
		: primary?.bot.name || 'Bot conversation';
	function contactName(contact: BotContact) {
		return group && participants.filter(({ bot }) => bot.name === contact.bot.name).length > 1
			? `${contact.bot.name} · ${contact.host.name}`
			: contact.bot.name;
	}
	const thinkingBots = participants.filter((contact) =>
		p.conversation?.messages.some(
			(message) =>
				message.role === 'bot' &&
				message.status === 'pending' &&
				(message.activity === 'thinking' || message.activity === undefined) &&
				message.author?.hostId === contact.host.id &&
				message.author.botId === contact.bot.id,
		),
	);
	const thinkingNames = thinkingBots.map(contactName).join(', ');
	useEffect(() => {
		if (current.current !== p.conversation?.id) {
			current.current = p.conversation?.id;
			setDraft(p.conversation?.draft || '');
			setDraftMentions(p.conversation?.draftMentions || []);
			setReply(undefined);
			setError('');
			setProfileOpen(false);
			following.current = true;
		}
	}, [p.conversation?.id, p.conversation?.draft]);
	useLayoutEffect(() => {
		const element = composer.current;
		if (!element) return;
		element.style.height = 'auto';
		element.style.height = `${Math.min(600, element.scrollHeight)}px`;
	}, [draft]);
	useLayoutEffect(() => {
		const element = header.current;
		const container = element?.parentElement;
		if (!element || !container) return;
		let previousHeight = 0;
		const measure = () => {
			const height = element.getBoundingClientRect().height;
			if (height === previousHeight) return;
			previousHeight = height;
			container.style.setProperty('--bots-header-height', `${height}px`);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [p.conversation?.id]);
	useLayoutEffect(() => {
		const { snapshot, entering } = nextBotMessageAppearances(
			previousAppearances.current,
			p.conversation?.id,
			p.conversation?.messages || [],
			p.loading,
		);
		previousAppearances.current = snapshot;
		if (!entering.size || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
		for (const entry of scroller.current?.querySelectorAll<HTMLElement>('[data-bot-message-id]') ||
			[]) {
			if (!entering.has(entry.dataset.botMessageId || '')) continue;
			const bubble = entry.querySelector<HTMLElement>('.bot-message-bubble-wrap');
			bubble?.animate?.(
				[
					{ opacity: 0, transform: 'translateY(8px) scale(.98)' },
					{ opacity: 1, transform: 'none' },
				],
				{ duration: 240, easing: 'cubic-bezier(.22,.7,.25,1)' },
			);
		}
	}, [p.conversation?.id, p.conversation?.messages, p.loading]);
	useLayoutEffect(() => {
		const element = scroller.current;
		if (element && following.current) element.scrollTop = element.scrollHeight;
	}, [p.conversation?.id, p.conversation?.messages]);
	function changeDraft(value: string, mentions: BotMention[] = []) {
		setDraft(value);
		setDraftMentions(mentions);
		p.onDraftChange(value, mentions);
	}
	async function stop() {
		if (!p.onStop || stopping) return;
		setStopping(true);
		try {
			await run(p.onStop);
		} finally {
			setStopping(false);
		}
	}
	async function run(action: () => Action) {
		try {
			setError('');
			await action();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}
	async function send() {
		const submittedDraft = draft;
		const conversationId = p.conversation?.id;
		const text = draft.trim();
		if (!text || submitting) return;
		setSubmitting(true);
		setError('');
		try {
			const leading = submittedDraft.length - submittedDraft.trimStart().length;
			const mentions = resolveBotMentions(
				text,
				mentionRoster,
				draftMentions.map((item) => ({
					...item,
					start: item.start - leading,
					end: item.end - leading,
				})),
			);
			await p.onSend(text, reply?.id, mentions);
			if (current.current === conversationId && draftRef.current === submittedDraft)
				changeDraft('');
			if (current.current === conversationId) setReply(undefined);
			following.current = true;
			composer.current?.focus();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSubmitting(false);
		}
	}
	if (!p.conversation)
		return (
			<section className="bots-workspace" aria-label="Bots">
				<div className="bots-conversation">
					<div className="bots-empty">
						<BotAvatar name="" size={68} />
						<h2>A familiar face. A new conversation.</h2>
						<p>
							Create a bot with its own name and personality. Message it here, or bring a few bots
							together in a group.
						</p>
						<div className="bots-empty-actions">
							<button className="primary-button" onClick={p.onCreateBot}>
								Create a bot
							</button>
							{p.contacts.length > 1 && (
								<button className="secondary-button" onClick={p.onNewGroup}>
									New group
								</button>
							)}
						</div>
						{p.loading && <p role="status">Loading bots…</p>}
						{p.error && (
							<p className="danger" role="alert">
								{userFacingError(p.error)}
							</p>
						)}
					</div>
				</div>
			</section>
		);
	return (
		<section className="bots-workspace" aria-label="Bot conversation">
			<div className="bots-conversation">
				<header ref={header} className="bots-conversation-header">
					<button
						className="bots-header-avatar"
						onClick={() => setProfileOpen((value) => !value)}
						aria-label="Bot profile"
						aria-expanded={profileOpen}
					>
						<BotAvatar name={title} color={primary?.bot.color} size={39} group={group} />
					</button>
					<div className="bots-header-name">
						<button
							className="bots-header-title"
							onClick={() => setProfileOpen((value) => !value)}
							aria-label="Bot details"
							aria-expanded={profileOpen}
						>
							<strong>{title}</strong>
						</button>
						{thinkingBots.length > 0 && (
							<div
								className="bots-thinking"
								role="status"
								aria-label={`${thinkingNames} ${thinkingBots.length === 1 ? 'is' : 'are'} thinking`}
							>
								<span className="bots-thinking-light" aria-hidden="true">
									<Lightbulb size={14} />
								</span>
								<span>{group ? `${thinkingNames} · Thinking` : 'Thinking'}</span>
							</div>
						)}
					</div>
					<span className="bots-header-address">
						{group
							? `${p.conversation.participants.length} bots · ${p.hostName}`
							: `${primary?.bot.address || 'Bot unavailable'} · ${primary?.host.name || p.hostName}`}
					</span>
					{group && busy && p.onStop && (
						<button
							className="bots-header-stop"
							onClick={() => void stop()}
							disabled={stopping}
							aria-label="Stop group replies"
						>
							<Square size={12} fill="currentColor" /> Stop
						</button>
					)}
					<button
						className="icon-button bots-header-info"
						aria-label="Show conversation details"
						onClick={() => setProfileOpen((value) => !value)}
					>
						<Info size={18} />
					</button>
				</header>
				<div
					ref={scroller}
					className="bots-messages"
					role="log"
					aria-label="Bot messages"
					aria-live="polite"
					aria-relevant="additions text"
					onScroll={(event) => {
						const node = event.currentTarget;
						following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100;
					}}
				>
					<div className="bots-message-column">
						{visibleMessages.length === 0 && (
							<div className="bots-date-divider">
								Send a message to get to know {group ? 'your bots' : title}.
							</div>
						)}
						{visibleMessages.map((message, index, all) => {
							const previous = all[index - 1];
							const showDate = !previous || message.createdAt - previous.createdAt >= 20 * 60_000;
							const author =
								message.author &&
								p.contacts.find(
									(contact) =>
										contact.host.id === message.author?.hostId &&
										contact.bot.id === message.author.botId,
								);
							const consecutive =
								!showDate &&
								previous?.role === message.role &&
								previous.author?.botId === message.author?.botId &&
								previous.author?.hostId === message.author?.hostId;
							const quoted =
								message.role === 'user' && message.replyTo
									? all.find((item) => item.id === message.replyTo && item.status !== 'unsent')
									: undefined;
							return (
								<div key={message.id} data-bot-message-id={message.id}>
									{showDate && (
										<div className="bots-date-divider">
											{userMessageDateLabel(message.createdAt)}
										</div>
									)}
									<BotMessageBubble
										message={message}
										readAt={messageReadAt(message, p.conversation!.participants)}
										authorName={author && contactName(author)}
										showName={group && message.role === 'bot' && !consecutive}
										consecutive={consecutive}
										replyText={quoted?.content}
										onReply={() => {
											setReply(message);
											composer.current?.focus();
										}}
										onReact={(emoji) => run(() => p.onReact(message, emoji))}
										mentionRoster={group ? mentionRoster : []}
										onEdit={(content, mentions) => p.onEdit(message, content, mentions)}
										onUnsend={() => run(() => p.onUnsend(message))}
										onRetry={() => run(() => p.onRetry(message))}
									/>
								</div>
							);
						})}
					</div>
				</div>
				<div className="bots-composer-area">
					<BotJobs jobs={p.jobs ?? []} onAction={p.onJobAction} />
					{group && p.conversation.groupReplyState?.paused && (
						<div className="bots-group-paused" role="status">
							{p.conversation.groupReplyState.paused === 'limit'
								? 'Automatic reply limit reached.'
								: 'Group replies stopped.'}{' '}
							Send a message to continue.
						</div>
					)}
					{(error || p.error) && (
						<div className="bots-inline-error" role="alert">
							<AlertCircle size={16} />
							<span>{userFacingError(error || p.error)}</span>
						</div>
					)}
					{reply && (
						<div className="bots-reply-banner">
							<Reply size={14} />
							<span>{reply.content}</span>
							<button
								className="icon-button"
								aria-label="Cancel reply"
								onClick={() => setReply(undefined)}
							>
								<X size={14} />
							</button>
						</div>
					)}
					<form
						className="bots-composer"
						onSubmit={(event) => {
							event.preventDefault();
							void send();
						}}
					>
						<BotMentionInput
							ref={composer}
							label="Message your bot"
							placeholder="Message"
							value={draft}
							mentions={draftMentions}
							roster={group ? mentionRoster : []}
							onChange={changeDraft}
							onSubmit={() => void send()}
						/>
						{busy && !draft.trim() && p.onStop ? (
							<button
								className="bots-send"
								type="button"
								aria-label="Stop reply"
								title="Stop this reply; background jobs and delegated tasks continue"
								disabled={stopping}
								onClick={() => void stop()}
							>
								<Square size={12} fill="currentColor" />
							</button>
						) : (
							<button
								className="bots-send"
								type="submit"
								aria-label="Send message"
								disabled={!draft.trim() || submitting}
							>
								<ArrowUp size={19} strokeWidth={2.5} />
							</button>
						)}
					</form>
				</div>
			</div>
			{profileOpen && (
				<aside className="bots-profile-panel" aria-label="Conversation details">
					<header>
						<h3>{group ? 'Group details' : 'Bot details'}</h3>
						<button
							className="icon-button"
							aria-label="Close conversation details"
							onClick={() => setProfileOpen(false)}
						>
							<X size={17} />
						</button>
					</header>
					<BotAvatar name={title} color={primary?.bot.color} size={70} group={group} />
					<h2>{title}</h2>
					<p className="bots-profile-address">
						{group ? `${p.conversation.participants.length} bots` : primary?.bot.address}
					</p>
					{group && p.onGroupReplyLimitChange && (
						<GroupReplyLimit
							key={p.conversation.id}
							value={p.conversation.groupReplyLimit ?? 12}
							onSave={(limit) => p.onGroupReplyLimitChange!(limit)}
						/>
					)}
					{group
						? participants.map((contact) => (
								<button
									className="bots-profile-participant"
									key={`${contact.host.id}:${contact.bot.id}`}
									onClick={() => p.onEditBot(contact)}
								>
									<BotAvatar name={contact.bot.name} color={contact.bot.color} size={32} />
									<span>
										<strong>{contact.bot.name}</strong>
										<small>
											{contact.bot.address} · {contact.host.name}
										</small>
									</span>
								</button>
							))
						: primary && (
								<>
									<div className="bots-profile-field">
										<h3>Identity</h3>
										<p>
											{primary.bot.identity || 'A helpful companion with a personality of its own.'}
										</p>
									</div>
									<div className="bots-profile-field">
										<h3>Learned personality</h3>
										<p>
											{primary.bot.learnedPersonality ||
												'Your bot will get to know you as you talk.'}
										</p>
									</div>
									<div className="bots-profile-field">
										<h3>Persistent memory</h3>
										<p>
											{primary.bot.memoryEnabled === false ? 'Off' : 'On'} ·{' '}
											{primary.bot.memories?.length || 0} saved memories
										</p>
									</div>
									<div className="bots-profile-field">
										<h3>Home</h3>
										<p>{primary.host.name}</p>
									</div>
									<div className="bots-profile-field">
										<h3>Model</h3>
										<p>{primary.bot.model || 'Choose a model to start chatting.'}</p>
									</div>
									<button className="secondary-button" onClick={() => p.onEditBot(primary)}>
										Customize bot
									</button>
								</>
							)}
					<BotJobs jobs={p.jobs ?? []} history onAction={p.onJobAction} />
					<div className="bots-profile-field">
						<h3>Conversation storage</h3>
						<p>Stored on {p.hostName}.</p>
					</div>
				</aside>
			)}
		</section>
	);
}

const BotMessageBubble = memo(function BotMessageBubble({
	message,
	readAt,
	authorName,
	showName,
	consecutive,
	replyText,
	mentionRoster,
	onReply,
	onReact,
	onEdit,
	onUnsend,
	onRetry,
}: {
	message: BotMessage;
	readAt?: number;
	authorName?: string;
	showName: boolean;
	consecutive: boolean;
	replyText?: string;
	mentionRoster: MentionRoster;
	onReply: () => void;
	onReact: (emoji: BotReactionEmoji | null) => Action;
	onEdit: (content: string, mentions?: BotMention[]) => Action;
	onUnsend: () => Action;
	onRetry: () => Action;
}) {
	const [menu, setMenu] = useState<{ left: number; top: number }>();
	const [editing, setEditing] = useState(false);
	const [edited, setEdited] = useState(message.content);
	const [editedMentions, setEditedMentions] = useState<BotMention[]>(message.mentions || []);
	const [saving, setSaving] = useState(false);
	const [copyError, setCopyError] = useState('');
	const menuRef = useRef<HTMLDivElement>(null);
	const own = message.role === 'user';
	const reactions = REACTIONS.map((emoji) => ({
		emoji,
		values: message.reactions.filter((reaction) => reaction.emoji === emoji),
	})).filter((group) => group.values.length);
	useEffect(() => {
		if (!menu) return;
		menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
		const close = () => setMenu(undefined);
		window.addEventListener('resize', close);
		window.addEventListener('scroll', close, true);
		return () => {
			window.removeEventListener('resize', close);
			window.removeEventListener('scroll', close, true);
		};
	}, [menu]);
	function openMenu(x: number, y: number) {
		setMenu({
			left: Math.max(8, Math.min(window.innerWidth - 232, x)),
			top: Math.max(8, Math.min(window.innerHeight - (own ? 238 : 160), y)),
		});
	}
	if (message.status === 'unsent')
		return (
			<div className={`bot-message-row${own ? ' own' : ''}`}>
				<span className="bot-message-tombstone">
					{own ? 'You unsent a message' : 'Message removed'}
				</span>
			</div>
		);
	return (
		<div
			className={`bot-message-row${own ? ' own' : ''}${consecutive ? ' consecutive' : ''}${reactions.length ? ' has-reactions' : ''}`}
		>
			{showName && <div className="bot-message-name">{authorName || 'Bot'}</div>}
			<div
				className="bot-message-bubble-wrap"
				onContextMenu={(event) => {
					if (message.status === 'pending') return;
					event.preventDefault();
					openMenu(event.clientX, event.clientY);
				}}
			>
				{message.status === 'pending' && message.activity === 'writing' ? (
					<div className="bot-typing" role="status" aria-label={`${authorName || 'Bot'} is typing`}>
						<span />
						<span />
						<span />
					</div>
				) : (
					<div className="bot-message-bubble">
						{replyText && <span className="bot-message-reply">{replyText}</span>}
						{editing ? (
							<div className="bots-edit-message">
								<BotMentionInput
									autoFocus
									label="Edit message"
									value={edited}
									mentions={editedMentions}
									roster={mentionRoster}
									onChange={(value, mentions) => {
										setEdited(value);
										setEditedMentions(mentions);
									}}
								/>
								<div>
									<button disabled={saving} onClick={() => setEditing(false)}>
										Cancel edit
									</button>
									<button
										disabled={saving || !edited.trim()}
										onClick={async () => {
											setSaving(true);
											try {
												setCopyError('');
												const leading = edited.length - edited.trimStart().length;
												await onEdit(
													edited.trim(),
													resolveBotMentions(
														edited.trim(),
														mentionRoster,
														editedMentions.map((item) => ({
															...item,
															start: item.start - leading,
															end: item.end - leading,
														})),
													),
												);
												setEditing(false);
											} catch (cause) {
												setCopyError(cause instanceof Error ? cause.message : String(cause));
											} finally {
												setSaving(false);
											}
										}}
									>
										Save edit
									</button>
								</div>
							</div>
						) : message.role === 'bot' ? (
							<BotMessageBody
								text={
									formatBotMentionText(message.content, message.mentions) ||
									(message.status === 'failed' ? 'Couldn’t reply.' : '')
								}
							/>
						) : (
							<MessageMarkdown
								text={
									formatBotMentionText(message.content, message.mentions) ||
									(message.status === 'failed' ? 'Couldn’t reply.' : '')
								}
							/>
						)}
					</div>
				)}
				{reactions.length > 0 && (
					<div className="bot-message-reactions">
						{reactions.map(({ emoji, values }) => (
							<button
								className={`bot-reaction${values.some((reaction) => reaction.actorId === 'user') ? ' selected' : ''}`}
								key={emoji}
								title={values
									.map((reaction) => (reaction.actorId === 'user' ? 'You' : 'Bot'))
									.join(', ')}
								aria-label={`${emoji} reaction, ${values.length}`}
								onClick={() =>
									void onReact(
										values.some((reaction) => reaction.actorId === 'user') ? null : emoji,
									)
								}
							>
								{emoji}
								{values.length > 1 && <small>{values.length}</small>}
							</button>
						))}
					</div>
				)}
				{message.status !== 'pending' && !editing && (
					<div className={`bot-message-actions${menu ? ' open' : ''}`}>
						<button
							className="icon-button"
							aria-label={`Message actions: ${message.content.slice(0, 40)}`}
							title="Message actions"
							onClick={(event) => {
								const bounds = event.currentTarget.getBoundingClientRect();
								openMenu(own ? bounds.right - 224 : bounds.left, bounds.bottom + 6);
							}}
						>
							<MoreHorizontal size={16} />
						</button>
						<button
							className="icon-button"
							aria-label={`Reply to ${own ? 'your message' : authorName || 'bot'}`}
							title="Reply"
							onClick={onReply}
						>
							<Reply size={15} />
						</button>
					</div>
				)}
			</div>
			{message.status === 'failed' ? (
				<div className="bot-message-meta error">
					<AlertCircle size={12} />
					<span>{userFacingError(message.error, 'Message could not be sent.')}</span>
					<button
						className="icon-button"
						aria-label="Retry bot response"
						title="Retry"
						onClick={() => void onRetry()}
					>
						<RotateCcw size={13} />
					</button>
				</div>
			) : (
				message.status !== 'pending' && (
					<div className="bot-message-meta">
						{!own && (
							<time dateTime={new Date(message.createdAt).toISOString()}>
								{assistantMessageTime(message.createdAt)}
							</time>
						)}
						{message.editedAt && <span>Edited</span>}
						{own &&
							(readAt ? (
								<span>
									Read{' '}
									<time dateTime={new Date(readAt).toISOString()}>
										{assistantMessageTime(readAt)}
									</time>
								</span>
							) : (
								<span>Delivered</span>
							))}
					</div>
				)
			)}
			{copyError && (
				<span className="bot-message-meta error" role="alert">
					{userFacingError(copyError)}
				</span>
			)}
			{menu &&
				createPortal(
					<>
						<button
							className="menu-dismiss"
							aria-label="Close message actions"
							style={{ zIndex: 119 }}
							onClick={() => setMenu(undefined)}
						/>
						<div
							ref={menuRef}
							className="bots-message-menu"
							role="menu"
							aria-label="Message actions"
							style={menu}
							onKeyDown={(event) => {
								if (event.key === 'Escape' || event.key === 'Tab') {
									setMenu(undefined);
									if (event.key === 'Escape') event.stopPropagation();
									return;
								}
								if (
									['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(
										event.key,
									)
								) {
									event.preventDefault();
									const items = [
										...event.currentTarget.querySelectorAll<HTMLButtonElement>('button'),
									];
									const current = items.indexOf(document.activeElement as HTMLButtonElement);
									const next =
										event.key === 'Home'
											? 0
											: event.key === 'End'
												? items.length - 1
												: (current +
														(event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1) +
														items.length) %
													items.length;
									items[next]?.focus();
								}
							}}
						>
							<div className="bots-reaction-picker">
								{REACTIONS.map((emoji) => (
									<button
										key={emoji}
										role="menuitem"
										aria-label={`React ${emoji}`}
										onClick={() => {
											void onReact(emoji);
											setMenu(undefined);
										}}
									>
										{emoji}
									</button>
								))}
							</div>
							<button
								role="menuitem"
								onClick={() => {
									onReply();
									setMenu(undefined);
								}}
							>
								<Reply size={15} />
								Reply
							</button>
							<button
								role="menuitem"
								onClick={() => {
									void copyToClipboard(message.content)
										.then(() => setCopyError(''))
										.catch(() => setCopyError('Could not copy this message.'));
									setMenu(undefined);
								}}
							>
								<Copy size={15} />
								Copy
							</button>
							{own && (
								<>
									<button
										role="menuitem"
										onClick={() => {
											setEdited(message.content);
											setEditedMentions(message.mentions || []);
											setEditing(true);
											setMenu(undefined);
										}}
									>
										<Pencil size={15} />
										Edit
									</button>
									<button
										role="menuitem"
										className="danger"
										onClick={() => {
											void onUnsend();
											setMenu(undefined);
										}}
									>
										<Trash2 size={15} />
										Unsend
									</button>
								</>
							)}
						</div>
					</>,
					document.body,
				)}
		</div>
	);
});

type MentionRoster = {
	hostId: string;
	botId: string;
	name: string;
	address: string;
	hostName: string;
}[];

/** Keep UTF-16 offsets aligned with textarea selections when text is inserted or removed. */
function moveMentionSpans(before: string, after: string, mentions: BotMention[]) {
	let start = 0;
	while (start < before.length && start < after.length && before[start] === after[start]) start++;
	let oldEnd = before.length;
	let newEnd = after.length;
	while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
		oldEnd--;
		newEnd--;
	}
	const shift = newEnd - oldEnd;
	return mentions.flatMap((mention) => {
		if (mention.end <= start) return [mention];
		if (mention.start >= oldEnd)
			return [{ ...mention, start: mention.start + shift, end: mention.end + shift }];
		return [];
	});
}

const BotMentionInput = forwardRef<
	HTMLTextAreaElement,
	{
		value: string;
		mentions: BotMention[];
		roster: MentionRoster;
		label: string;
		placeholder?: string;
		autoFocus?: boolean;
		onChange: (value: string, mentions: BotMention[]) => void;
		onSubmit?: () => void;
	}
>(function BotMentionInput(
	{ value, mentions, roster, label, placeholder, autoFocus, onChange, onSubmit },
	forwardedRef,
) {
	const textarea = useRef<HTMLTextAreaElement | null>(null);
	const [query, setQuery] = useState<{ start: number; end: number; text: string }>();
	const [selected, setSelected] = useState(0);
	const nextCaret = useRef<number | undefined>(undefined);
	const listId = useId();
	const options = query
		? roster
				.filter((contact) =>
					`${contact.name} ${contact.address} ${contact.hostName}`
						.toLocaleLowerCase()
						.includes(query.text.toLocaleLowerCase()),
				)
				.slice(0, 20)
		: [];
	const open = !!query && options.length > 0;
	const active = Math.min(selected, Math.max(0, options.length - 1));
	useLayoutEffect(() => {
		if (nextCaret.current === undefined) return;
		textarea.current?.focus();
		textarea.current?.setSelectionRange(nextCaret.current, nextCaret.current);
		nextCaret.current = undefined;
	}, [value]);
	useEffect(() => {
		if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
	}, [open, active, listId]);
	function findQuery(text: string, caret: number) {
		if (!roster.length) return;
		const preceding = text.slice(0, caret);
		const match = /(?:^|[\s(])@([^@\n]{0,100})$/.exec(preceding);
		if (!match) {
			setQuery(undefined);
			return;
		}
		const start = caret - match[1].length - 1;
		const probe = text.slice(0, start) + '@mention' + text.slice(caret);
		if (
			!validBotMentionSpans(probe, [
				{
					hostId: roster[0].hostId,
					botId: roster[0].botId,
					start,
					end: start + 8,
					label: 'mention',
				},
			])
		) {
			setQuery(undefined);
			return;
		}
		if (mentions.some((mention) => mention.start === start && mention.end < caret)) {
			setQuery(undefined);
			return;
		}
		setQuery({ start, end: caret, text: match[1] });
		setSelected(0);
	}
	function choose(contact: MentionRoster[number]) {
		if (!query) return;
		const duplicate =
			roster.filter((other) => other.name.toLocaleLowerCase() === contact.name.toLocaleLowerCase())
				.length > 1;
		const mentionLabel = duplicate ? `${contact.name} · ${contact.hostName}` : contact.name;
		const insertion = `@${mentionLabel}`;
		const content = value.slice(0, query.start) + insertion + ' ' + value.slice(query.end);
		const existing = moveMentionSpans(value, content, mentions);
		const explicit: BotMention = {
			hostId: contact.hostId,
			botId: contact.botId,
			start: query.start,
			end: query.start + insertion.length,
			label: mentionLabel,
		};
		nextCaret.current = query.start + insertion.length + 1;
		onChange(content, resolveBotMentions(content, roster, [...existing, explicit]));
		setQuery(undefined);
	}
	function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
		if (event.nativeEvent.isComposing) return;
		if (open) {
			if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				event.preventDefault();
				setSelected(
					(active + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length,
				);
				return;
			}
			if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
				event.preventDefault();
				choose(options[active]);
				return;
			}
			if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				setQuery(undefined);
				return;
			}
		}
		if (event.key === 'Enter' && !event.shiftKey && onSubmit) {
			event.preventDefault();
			onSubmit();
		}
	}
	return (
		<div className="bots-mention-input">
			<textarea
				ref={(element) => {
					textarea.current = element;
					if (typeof forwardedRef === 'function') forwardedRef(element);
					else if (forwardedRef) forwardedRef.current = element;
				}}
				rows={1}
				autoFocus={autoFocus}
				aria-label={label}
				role={roster.length ? 'combobox' : undefined}
				aria-autocomplete={roster.length ? 'list' : undefined}
				aria-expanded={roster.length ? open : undefined}
				aria-controls={open ? listId : undefined}
				aria-activedescendant={open ? `${listId}-${active}` : undefined}
				placeholder={placeholder}
				value={value}
				onChange={(event) => {
					const text = event.currentTarget.value;
					onChange(text, resolveBotMentions(text, roster, moveMentionSpans(value, text, mentions)));
					findQuery(text, event.currentTarget.selectionStart);
				}}
				onClick={(event) =>
					findQuery(event.currentTarget.value, event.currentTarget.selectionStart)
				}
				onBlur={() => setQuery(undefined)}
				onKeyDown={keyDown}
			/>
			{open && (
				<div className="bots-mention-picker" role="listbox" aria-label="Mention a bot" id={listId}>
					{options.map((contact, index) => (
						<button
							type="button"
							role="option"
							id={`${listId}-${index}`}
							key={`${contact.hostId}:${contact.botId}`}
							aria-selected={active === index}
							tabIndex={-1}
							onPointerDown={(event) => event.preventDefault()}
							onClick={() => choose(contact)}
						>
							<strong>{contact.name}</strong>
							<span>
								{contact.address} · {contact.hostName}
							</span>
						</button>
					))}
				</div>
			)}
		</div>
	);
});

function GroupReplyLimit({ value, onSave }: { value: number; onSave: (value: number) => Action }) {
	const [draft, setDraft] = useState(String(value));
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState('');
	const labelId = useId();
	useEffect(() => setDraft(String(value)), [value]);
	async function save() {
		const next = Number(draft);
		if (!Number.isInteger(next) || next < 1 || next > 100) {
			setError('Choose a whole number from 1 to 100.');
			return;
		}
		setError('');
		if (next === value || saving) return;
		setSaving(true);
		try {
			await onSave(next);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSaving(false);
		}
	}
	return (
		<div className="bots-profile-field bots-group-limit">
			<label htmlFor={labelId}>Automatic replies</label>
			<input
				id={labelId}
				type="number"
				min={1}
				max={100}
				step={1}
				value={draft}
				disabled={saving}
				onChange={(event) => setDraft(event.target.value)}
				onBlur={() => void save()}
				onKeyDown={(event) => {
					if (event.key === 'Enter') {
						event.preventDefault();
						void save();
					}
				}}
				aria-describedby={`${labelId}-help`}
				aria-invalid={!!error}
			/>
			<p id={`${labelId}-help`}>
				Maximum bot-to-bot follow-ups per message. Send a new message to continue after the limit.
			</p>
			{error && (
				<p className="danger" role="alert">
					{userFacingError(error)}
				</p>
			)}
		</div>
	);
}
