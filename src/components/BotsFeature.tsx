import type { Attachment } from '../types';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
	BotCommand,
	BotCommandResult,
	BotConversation,
	BotMessage,
	BotMention,
	BotParticipant,
	BotProfileInput,
	BotSnapshot,
} from '../bot-types';
import type { BotContact } from './bots-ui-types';
import BotsSidebar from './BotsSidebar';
import BotsWorkspace, { type BotsWorkspaceProps } from './BotsWorkspace';
import type { BotJobItem, BotJobAction } from './BotJobs';
import { BotProfileDialog, BotGroupDialog } from './BotDialogs';

interface HostEntry {
	targetId: string;
	name: string;
	instanceId?: string;
	connected: boolean;
	snapshot?: BotSnapshot;
	error?: string;
}
type Editor =
	| { kind: 'profile'; targetId: string; contact?: BotContact }
	| { kind: 'group'; targetId: string }
	| null;
const conversationKey = (host: string, id: string) => JSON.stringify([host, id]);
const messageError = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Routing is independent of the open Chat/Code workspace. A bot always runs on its owning host. */
export function useBotsWorkspace(
	enabled: boolean,
	dictation: Pick<
		BotsWorkspaceProps,
		'dictation' | 'dictationConnection' | 'onDictationSettings'
	> = {},
) {
	const [hosts, setHosts] = useState<HostEntry[]>([]);
	const hostsRef = useRef(hosts);
	hostsRef.current = hosts;
	const [targetId, setTargetId] = useState('local');
	const [conversationId, setConversationId] = useState<string>();
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState('');
	const [editor, setEditor] = useState<Editor>(null);
	const polling = useRef<Promise<void> | null>(null);
	const hostRequests = useRef(new Set<string>());
	const mounted = useRef(true);
	const draftWrites = useRef(
		new Map<
			string,
			{
				timer: ReturnType<typeof setTimeout>;
				targetId: string;
				conversationId: string;
				content: string;
				mentions?: BotMention[];
				saving?: Promise<void>;
			}
		>(),
	);
	const pendingSends = useRef(
		new Map<
			string,
			{
				id: string;
				content: string;
				replyTo?: string;
				mentions?: BotMention[];
				attachments?: Attachment[];
			}
		>(),
	);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const applySnapshot = useCallback((target: string, snapshot: BotSnapshot) => {
		if (!mounted.current) return;
		setHosts((previous) =>
			previous.map((host) =>
				host.targetId === target
					? {
							...host,
							snapshot:
								!host.snapshot || snapshot.revision >= host.snapshot.revision
									? snapshot
									: host.snapshot,
							error: undefined,
						}
					: host,
			),
		);
	}, []);
	const refresh = useCallback(async () => {
		if (polling.current) return polling.current;
		const bridge = window.desktop;
		if (!bridge?.botsSnapshot || !bridge.instanceStatus) {
			setError('Open the updated FreeLM desktop app to create and message bots.');
			setLoading(false);
			return;
		}
		const work = async () => {
			try {
				const overview = await bridge.instanceStatus();
				const targets: HostEntry[] = [
					{
						targetId: 'local',
						name: 'This computer',
						instanceId: overview.host.instanceId,
						connected: true,
					},
					...overview.instances
						.filter(
							(host, index, all) =>
								!host.instanceId ||
								all.findIndex((item) => item.instanceId === host.instanceId) === index,
						)
						.map((host) => ({
							targetId: host.id,
							name: host.name,
							instanceId: host.instanceId,
							connected: host.connected,
						})),
				];
				if (!mounted.current) return;
				setHosts((previous) =>
					targets.map((host) => ({
						...previous.find((item) => item.targetId === host.targetId),
						...host,
						instanceId:
							host.instanceId ||
							previous.find((item) => item.targetId === host.targetId)?.snapshot?.host.id,
					})),
				);
				void Promise.all(
					targets.map(async (target) => {
						if (hostRequests.current.has(target.targetId)) return;
						hostRequests.current.add(target.targetId);
						let host: HostEntry = {
							...target,
							error: target.connected ? undefined : 'This computer is disconnected.',
						};
						if (target.connected) {
							try {
								const snapshot = await bridge.botsSnapshot!(target.targetId);
								host = { ...target, instanceId: snapshot.host.id, snapshot };
							} catch (failure) {
								host.error = messageError(failure);
							}
						}
						hostRequests.current.delete(target.targetId);
						if (!mounted.current) return;
						// A slow/offline remote never holds up another host's delivered replies.
						setHosts((previous) =>
							previous.map((old) => {
								if (old.targetId !== host.targetId) return old;
								if (old.connected !== target.connected) return old;
								if (
									old.connected === host.connected &&
									old.name === host.name &&
									old.instanceId === host.instanceId &&
									old.error === host.error &&
									(!host.snapshot ||
										(host.snapshot.revision <= (old.snapshot?.revision ?? -1) &&
											JSON.stringify(host.snapshot.connections) ===
												JSON.stringify(old.snapshot?.connections)))
								)
									return old;
								return {
									...host,
									snapshot:
										old.snapshot && host.snapshot && old.snapshot.revision > host.snapshot.revision
											? { ...old.snapshot, connections: host.snapshot.connections }
											: (host.snapshot ?? old.snapshot),
								};
							}),
						);
						if (target.targetId === 'local') setLoading(false);
					}),
				);
			} catch (failure) {
				if (mounted.current) setError(messageError(failure));
			} finally {
				if (mounted.current) setLoading(false);
			}
		};
		const next = work().finally(() => {
			polling.current = null;
		});
		polling.current = next;
		return next;
	}, []);
	useEffect(() => {
		if (!enabled) {
			setEditor(null);
			return;
		}
		setLoading(!hostsRef.current.length);
		void refresh();
		const timer = setInterval(() => {
			if (document.visibilityState !== 'hidden') void refresh();
		}, 2000);
		const focus = () => void refresh();
		window.addEventListener('focus', focus);
		return () => {
			clearInterval(timer);
			window.removeEventListener('focus', focus);
		};
	}, [enabled, refresh]);
	useEffect(() => {
		const bridge = window.desktop;
		if (!enabled || !bridge?.onBotsChanged || !bridge.botsSnapshot) return;
		let disposed = false;
		let reading = false;
		let dirty = false;
		const changed = async () => {
			dirty = true;
			if (reading) return;
			reading = true;
			try {
				// A second phase can arrive during a chunked snapshot read. Keep the trailing refresh.
				while (dirty && !disposed) {
					dirty = false;
					const snapshot = await bridge.botsSnapshot!('local');
					if (!disposed) applySnapshot('local', snapshot);
				}
			} catch {
				if (!disposed) void refresh();
			} finally {
				reading = false;
			}
		};
		const unsubscribe = bridge.onBotsChanged(() => void changed());
		return () => {
			disposed = true;
			unsubscribe();
		};
	}, [enabled, applySnapshot, refresh]);
	const command = useCallback(
		async (target: string, value: BotCommand): Promise<BotCommandResult> => {
			if (!window.desktop?.botsCommand)
				throw new Error('Bots require the updated FreeLM desktop app.');
			try {
				const result = await window.desktop.botsCommand(target, value);
				applySnapshot(target, result.snapshot);
				if (mounted.current) setError('');
				return result;
			} catch (failure) {
				if (mounted.current) setError(messageError(failure));
				throw failure;
			}
		},
		[applySnapshot],
	);
	const flushDraft = useCallback(
		async (target: string, id: string) => {
			const key = `${target}:${id}`;
			const pending = draftWrites.current.get(key);
			if (!pending) return;
			if (pending.saving) return pending.saving;
			clearTimeout(pending.timer);
			pending.saving = command(target, {
				type: 'update-conversation',
				conversationId: id,
				draft: pending.content,
				draftMentions: pending.mentions,
			})
				.then(() => {
					if (draftWrites.current.get(key) === pending) draftWrites.current.delete(key);
				})
				.finally(() => {
					pending.saving = undefined;
				});
			await pending.saving;
		},
		[command],
	);
	useEffect(
		() => () => {
			for (const pending of draftWrites.current.values()) {
				clearTimeout(pending.timer);
				void window.desktop
					?.botsCommand?.(pending.targetId, {
						type: 'update-conversation',
						conversationId: pending.conversationId,
						draft: pending.content,
						draftMentions: pending.mentions,
					})
					.catch(() => {});
			}
			draftWrites.current.clear();
		},
		[],
	);
	const flushDrafts = useCallback(async () => {
		await Promise.all(
			[...draftWrites.current.values()].map((pending) =>
				flushDraft(pending.targetId, pending.conversationId),
			),
		);
	}, [flushDraft]);
	const current = hosts.find((host) => host.targetId === targetId);
	const conversations = hosts.flatMap((host) =>
		(host.snapshot?.conversations ?? []).map((item) => ({
			...item,
			id: conversationKey(host.targetId, item.id),
		})),
	);
	const conversation = current?.snapshot?.conversations.find((item) => item.id === conversationId);
	const jobs: BotJobItem[] =
		conversation && current?.snapshot
			? hosts
					.flatMap((host) =>
						(host.snapshot?.jobs ?? [])
							.filter(
								(job) =>
									job.sourceHostId === current.snapshot!.host.id &&
									job.conversationId === conversation.id,
							)
							.map((job) => ({
								...job,
								ownerTargetId: host.targetId,
								ownerName: host.name,
								botName: host.snapshot?.bots.find((bot) => bot.id === job.botId)?.name,
								connected: host.connected,
							})),
					)
					.sort((a, b) => b.createdAt - a.createdAt)
			: [];
	const onJobAction = async (job: BotJobItem, action: BotJobAction) => {
		const owner = hostsRef.current.find((host) => host.targetId === job.ownerTargetId);
		const live = owner?.snapshot?.jobs?.find(
			(item) =>
				item.id === job.id &&
				item.sourceHostId === current?.snapshot?.host.id &&
				item.conversationId === conversation?.id,
		);
		if (!owner?.connected || !live)
			throw new Error('This job is no longer available on its owning computer.');
		await command(owner.targetId, {
			type: action,
			conversationId: live.conversationId,
			jobId: live.id,
		});
	};
	const lastRead = useRef('');
 const [foreground, setForeground] = useState(() => document.hasFocus());
 useEffect(() => {
  const update = () => setForeground(document.hasFocus() && document.visibilityState === 'visible');
  window.addEventListener('focus', update);
  window.addEventListener('blur', update);
  document.addEventListener('visibilitychange', update);
  return () => {
   window.removeEventListener('focus', update);
   window.removeEventListener('blur', update);
   document.removeEventListener('visibilitychange', update);
  };
 }, []);
	useEffect(() => {
		if (!enabled || !foreground || !current?.connected || !conversation || !document.hasFocus() || document.visibilityState === 'hidden')
			return;
		const latest = conversation.messages
			.filter((message) => message.role === 'bot' && message.status === 'completed')
			.at(-1);
		if (!latest || latest.updatedAt <= conversation.readAt) return;
		const key = `${targetId}:${conversation.id}:${latest.id}:${latest.updatedAt}`;
		if (lastRead.current === key) return;
		lastRead.current = key;
		void command(targetId, {
			type: 'update-conversation',
			conversationId: conversation.id,
			readAt: latest.updatedAt,
		}).catch(() => {
			lastRead.current = '';
		});
	}, [enabled, foreground, current?.connected, conversation, targetId, command]);
	const contacts: BotContact[] = hosts.flatMap((host) =>
		(host.snapshot?.bots ?? []).map((bot) => ({ bot, host: host.snapshot!.host })),
	);
	const connectedContacts = contacts.filter((contact) =>
		hosts.some((host) => host.connected && !host.error && host.instanceId === contact.host.id),
	);
	const configurationHosts = hosts
		.filter((host) => host.connected && host.snapshot && !host.error)
		.map((host) => ({
			targetId: host.targetId,
			name: host.name,
			connections: host.snapshot!.connections,
			memorySupported: host.snapshot!.memorySupported !== false,
		}));
	const hostName = current?.name || 'This computer';
	const onSelectConversation = (id: string) => {
		const owner = hostsRef.current.find((host) =>
			host.snapshot?.conversations.some((item) => conversationKey(host.targetId, item.id) === id),
		);
		if (!owner) return;
		const originalId = owner.snapshot!.conversations.find(
			(item) => conversationKey(owner.targetId, item.id) === id,
		)!.id;
		if (conversation) void flushDraft(targetId, conversation.id).catch(() => {});
		setTargetId(owner.targetId);
		setConversationId(originalId);
		setError('');
		if (owner.connected)
			void command(owner.targetId, {
				type: 'update-conversation',
				conversationId: originalId,
				readAt: Date.now(),
			}).catch(() => {});
	};
	const onSelectBot = async (contact: BotContact) => {
		const owner = hostsRef.current.find((host) => host.instanceId === contact.host.id);
		if (!owner) return;
		if (!contact.bot.enabled) {
			setEditor({ kind: 'profile', targetId: owner.targetId, contact });
			return;
		}
		const existing = owner.snapshot?.conversations.find(
			(item) =>
				item.participants.length === 1 &&
				item.participants[0].botId === contact.bot.id &&
				item.participants[0].hostId === contact.host.id,
		);
		if (existing) {
			onSelectConversation(conversationKey(owner.targetId, existing.id));
			return;
		}
		if (!owner.connected) {
			setError('Reconnect this bot’s home computer to message it.');
			return;
		}
		try {
			const result = await command(owner.targetId, {
				type: 'create-conversation',
				id: crypto.randomUUID(),
				participants: [{ hostId: contact.host.id, botId: contact.bot.id }],
				title: contact.bot.name,
			});
			setTargetId(owner.targetId);
			setConversationId(result.conversationId);
		} catch {
			/* The shared error remains visible. */
		}
	};
	const onSend = async (
		content: string,
		replyTo?: string,
		mentions?: BotMention[],
		attachments?: Attachment[],
	) => {
		if (!conversation) throw new Error('Choose a bot before sending.');
		await flushDraft(targetId, conversation.id);
		const key = `${targetId}:${conversation.id}`;
		const previous = pendingSends.current.get(key);
		const pending =
			previous?.content === content &&
			previous.replyTo === replyTo &&
			JSON.stringify(previous.mentions) === JSON.stringify(mentions) &&
			JSON.stringify(previous.attachments) === JSON.stringify(attachments)
				? previous
				: { content, replyTo, mentions, attachments, id: crypto.randomUUID() };
		pendingSends.current.set(key, pending);
		await command(targetId, {
			type: 'send',
			conversationId: conversation.id,
			messageId: pending.id,
			attachments,
			content,
			replyTo,
			mentions,
		});
		pendingSends.current.delete(key);
	};
	const onDraftChange = (content: string, mentions?: BotMention[]) => {
		if (!conversation) return;
		const key = `${targetId}:${conversation.id}`;
		const old = draftWrites.current.get(key);
		if (old) clearTimeout(old.timer);
		draftWrites.current.set(key, {
			targetId,
			conversationId: conversation.id,
			content,
			mentions,
			timer: setTimeout(() => {
				void flushDraft(targetId, conversation.id).catch(() => {});
			}, 500),
		});
	};
	const editBot = (contact: BotContact) => {
		const host = hostsRef.current.find((item) => item.instanceId === contact.host.id);
		if (host) setEditor({ kind: 'profile', targetId: host.targetId, contact });
	};
	const createBot = () =>
		setEditor({ kind: 'profile', targetId: current?.connected ? targetId : 'local' });
	const newGroup = () => setEditor({ kind: 'group', targetId: 'local' });
	const mutateMessage = async (value: BotCommand) => {
		await command(targetId, value);
	};
	const saveProfile = async (profile: BotProfileInput, host: string) => {
		const editing = editor?.kind === 'profile' && !!editor.contact;
		const result = await command(
			host,
			editor?.kind === 'profile' && editor.contact
				? { type: 'update-bot', botId: editor.contact.bot.id, changes: profile }
				: { type: 'create-bot', id: crypto.randomUUID(), profile },
		);
		setEditor(null);
		if (!editing && result.botId) {
			const created = result.snapshot.bots.find((bot) => bot.id === result.botId);
			if (created) {
				const chat = await command(host, {
					type: 'create-conversation',
					id: crypto.randomUUID(),
					participants: [{ hostId: result.snapshot.host.id, botId: created.id }],
					title: created.name,
				});
				setTargetId(host);
				setConversationId(chat.conversationId);
			}
		}
	};
	const createGroup = async (participants: BotParticipant[], title: string, host: string) => {
		const result = await command(host, {
			type: 'create-conversation',
			id: crypto.randomUUID(),
			participants,
			title,
		});
		setTargetId(host);
		setConversationId(result.conversationId);
		setEditor(null);
	};
	return {
		openNotification: async (target: string, id: string) => {
			await flushDrafts();
			const snapshot = await window.desktop?.botsSnapshot?.(target);
			if (!snapshot?.conversations.some((c) => c.id === id))
				throw new Error('This Bot conversation is no longer available.');
			setHosts((previous) => [
				...previous.filter((h) => h.targetId !== target),
				{
					targetId: target,
					name: snapshot.host.name,
					instanceId: snapshot.host.id,
					connected: true,
					snapshot,
				},
			]);
			setTargetId(target);
			setConversationId(id);
			setEditor(null);
			setError('');
		},
		flushDrafts,
		title: conversation?.title || 'Bots',
		panel: (
			<BotsSidebar
				contacts={contacts}
				conversations={conversations}
				selectedConversationId={
					conversationId ? conversationKey(targetId, conversationId) : undefined
				}
				hostName={hostName}
				hostId={targetId}
				hostOptions={hosts.map((host) => ({
					value: host.targetId,
					label: host.name,
					description: host.connected ? undefined : 'Disconnected',
				}))}
				loading={loading}
				error={current?.error}
				onHostChange={(id) => {
					setTargetId(id);
					setConversationId(undefined);
					setError('');
				}}
				onSelectConversation={onSelectConversation}
				onSelectBot={(contact) => void onSelectBot(contact)}
				onCreateBot={createBot}
				onNewGroup={newGroup}
			/>
		),
		content: (
			<>
				<BotsWorkspace
					{...dictation}
					key={targetId}
					conversation={conversation}
					jobs={jobs}
					onJobAction={onJobAction}
					contacts={contacts}
					hostName={hostName}
					loading={loading}
					error={error || current?.error}
					onSend={onSend}
					onDraftChange={onDraftChange}
					onStop={() =>
						conversation
							? mutateMessage({ type: 'stop', conversationId: conversation.id })
							: undefined
					}
					onGroupReplyLimitChange={(groupReplyLimit) =>
						conversation
							? mutateMessage({
									type: 'update-conversation',
									conversationId: conversation.id,
									groupReplyLimit,
								})
							: undefined
					}
					onReact={(message: BotMessage, emoji) =>
						conversation
							? mutateMessage({
									type: 'react',
									conversationId: conversation.id,
									messageId: message.id,
									emoji,
								})
							: undefined
					}
					onEdit={(message: BotMessage, content, mentions) =>
						conversation
							? mutateMessage({
									type: 'edit',
									conversationId: conversation.id,
									messageId: message.id,
									content,
									mentions,
									expectedUpdatedAt: message.updatedAt,
								})
							: undefined
					}
					onUnsend={(message: BotMessage) =>
						conversation
							? mutateMessage({
									type: 'unsend',
									conversationId: conversation.id,
									messageId: message.id,
									expectedUpdatedAt: message.updatedAt,
								})
							: undefined
					}
					onRetry={(message: BotMessage) =>
						conversation
							? mutateMessage({
									type: 'retry',
									conversationId: conversation.id,
									messageId: message.id,
								})
							: undefined
					}
					onCreateBot={createBot}
					onNewGroup={newGroup}
					onEditBot={editBot}
				/>
				{editor?.kind === 'profile' && (
					<BotProfileDialog
						profile={
							contacts.find(
								(contact) =>
									contact.host.id === editor.contact?.host.id &&
									contact.bot.id === editor.contact.bot.id,
							)?.bot || editor.contact?.bot
						}
						hosts={configurationHosts}
						hostId={editor.targetId}
						onSave={saveProfile}
						onUpdateMemory={
							editor.contact
								? async (memoryId, content) => {
										await command(editor.targetId, {
											type: 'update-memory',
											botId: editor.contact!.bot.id,
											memoryId,
											content,
										});
									}
								: undefined
						}
						onDeleteMemory={
							editor.contact
								? async (memoryId) => {
										await command(editor.targetId, {
											type: 'delete-memory',
											botId: editor.contact!.bot.id,
											memoryId,
										});
									}
								: undefined
						}
						onClose={() => setEditor(null)}
					/>
				)}
				{editor?.kind === 'group' && (
					<BotGroupDialog
						contacts={connectedContacts}
						hosts={configurationHosts.map((host) => ({ value: host.targetId, label: host.name }))}
						hostId={editor.targetId}
						onCreate={createGroup}
						onClose={() => setEditor(null)}
					/>
				)}
			</>
		),
	};
}
