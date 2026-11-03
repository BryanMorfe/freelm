import PanelHeader from './PanelHeader';
import { IconButton } from './Button';
import SearchField from './SearchField';
import { userFacingError } from '../lib/user-facing-error';
import { useMemo, useState } from 'react';
import { LoaderCircle, Monitor, Plus, SquarePen } from 'lucide-react';
import type { BotConversation } from '../bot-types';
import type { BotContact } from './bots-ui-types';
import BotAvatar from './BotAvatar';
import Select, { type SelectOption } from './Select';
import './bots.css';

export interface BotsSidebarProps {
	contacts: BotContact[];
	conversations: BotConversation[];
	selectedConversationId?: string;
	hostName: string;
	hostId?: string;
	hostOptions?: SelectOption[];
	loading?: boolean;
	error?: string;
	onHostChange?: (id: string) => void;
	onSelectConversation: (id: string) => void;
	onSelectBot: (contact: BotContact) => void;
	onCreateBot: () => void;
	onNewGroup: () => void;
}

export default function BotsSidebar(p: BotsSidebarProps) {
	const [search, setSearch] = useState('');
	const query = search.toLocaleLowerCase().trim();
	const conversations = useMemo(
		() => [...p.conversations].sort((a, b) => b.updatedAt - a.updatedAt),
		[p.conversations],
	);
	const groups = conversations.filter(
		(item) =>
			item.participants.length > 1 && (!query || item.title.toLocaleLowerCase().includes(query)),
	);
	const contacts = p.contacts.filter(
		({ bot, host }) =>
			!query || `${bot.name} ${bot.address} ${host.name}`.toLocaleLowerCase().includes(query),
	);
	return (
		<div className="sidebar-panel bots-sidebar">
			<PanelHeader
				title="Bots"
				actions={
					<>
						<IconButton
							label="New bot group"
							title="New group"
							icon={SquarePen}
							onClick={p.onNewGroup}
						/>
						<IconButton label="Create bot" icon={Plus} onClick={p.onCreateBot} />
					</>
				}
			></PanelHeader>
			<SearchField
				className="bots-search"
				label="Search bots"
				placeholder="Search"
				value={search}
				onValueChange={setSearch}
			/>
			<div className="sidebar-scroll">
				<div className="bots-list-heading">
					<span>Your bots</span>
					{p.loading && <LoaderCircle size={13} className="spin" aria-label="Loading bots" />}
				</div>
				{contacts.map((contact) => {
					const { bot, host } = contact;
					const conversation = conversations.find(
						(item) =>
							item.participants.length === 1 &&
							item.participants[0].hostId === host.id &&
							item.participants[0].botId === bot.id,
					);
					const last = conversation?.messages
						.filter((message) => message.status !== 'unsent')
						.at(-1);
					const unread =
						last?.role === 'bot' &&
						last.status === 'completed' &&
						last.updatedAt > (conversation?.readAt ?? 0);
					return (
						<button
							key={`${host.id}:${bot.id}`}
							title={`${bot.address} · ${host.name}${bot.enabled ? '' : ' · Disabled'}`}
							className={`bot-inbox-row${!bot.enabled ? ' bot-disabled' : ''}${conversation?.id === p.selectedConversationId ? ' active' : ''}`}
							aria-current={conversation?.id === p.selectedConversationId ? 'page' : undefined}
							onClick={() => p.onSelectBot(contact)}
						>
							<BotAvatar name={bot.name} color={bot.color} />
							<span className="bot-inbox-copy">
								<span className="bot-inbox-line">
									<strong>{bot.name}</strong>
									{last && (
										<time dateTime={new Date(last.createdAt).toISOString()}>
											{shortTime(last.createdAt)}
										</time>
									)}
								</span>
								<small>
									{last?.status === 'pending'
										? last.activity === 'writing'
											? 'Typing…'
											: last.activity === 'queued'
												? 'Queued'
												: 'Thinking…'
										: last?.content ||
											(last?.role === 'bot' && last.status === 'completed'
												? 'Reacted to a message'
												: bot.address)}
								</small>
								<small className="bot-inbox-host">
									{host.name}
									{!bot.enabled && ' · Disabled'}
								</small>
							</span>
							{unread && <span className="bot-unread" aria-label="Unread messages" />}
						</button>
					);
				})}
				{!contacts.length && !p.loading && (
					<p className="bots-list-empty">
						{query ? 'No matching bots.' : 'Create a bot to start a conversation.'}
					</p>
				)}
				{groups.length > 0 && (
					<>
						<div className="bots-list-heading">
							<span>Groups</span>
						</div>
						{groups.map((conversation) => {
							const last = conversation.messages
								.filter((message) => message.status !== 'unsent')
								.at(-1);
							return (
								<button
									key={conversation.id}
									className={`bot-inbox-row${conversation.id === p.selectedConversationId ? ' active' : ''}`}
									aria-current={conversation.id === p.selectedConversationId ? 'page' : undefined}
									onClick={() => p.onSelectConversation(conversation.id)}
								>
									<BotAvatar name={conversation.title} color="#66899b" group />
									<span className="bot-inbox-copy">
										<span className="bot-inbox-line">
											<strong>{conversation.title || 'Group conversation'}</strong>
											{last && <time>{shortTime(last.createdAt)}</time>}
										</span>
										<small>{last?.content || `${conversation.participants.length} bots`}</small>
									</span>
								</button>
							);
						})}
					</>
				)}
				{p.error && (
					<p className="bots-list-empty danger" role="alert">
						{userFacingError(p.error)}
					</p>
				)}
			</div>
			<div className="bots-host-label">
				<Monitor size={13} />
				{p.hostOptions && p.onHostChange ? (
					<Select
						className="bots-host-select"
						aria-label="Create bots on"
						value={p.hostId || ''}
						options={p.hostOptions}
						onChange={p.onHostChange}
					/>
				) : (
					p.hostName
				)}
			</div>
		</div>
	);
}
function shortTime(value: number) {
	const date = new Date(value);
	return date.toDateString() === new Date().toDateString()
		? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
		: date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
