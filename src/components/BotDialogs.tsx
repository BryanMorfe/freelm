import { userFacingError } from '../lib/user-facing-error';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, Search, X } from 'lucide-react';
import type { BotMemory, BotParticipant, BotProfile, BotProfileInput } from '../bot-types';
import type { Connection } from '../types';
import { botAddress, MAX_BOT_MEMORY_CONTENT } from '../lib/bots';
import {
	availableThinkingModes,
	defaultModel,
	defaultThinkingMode,
	listModelChoices,
} from '../lib/catalog';
import BotAvatar, { BOT_COLORS } from './BotAvatar';
import Select, { type SelectOption } from './Select';
import Switch from './Switch';
import { SettingsGroup, SettingsRow } from './SettingsList';
import type { BotContact } from './bots-ui-types';
import { botContactKey } from './bots-ui-types';
import './bots.css';

export interface BotProfileHost {
	targetId: string;
	name: string;
	connections: Connection[];
	memorySupported?: boolean;
}
export interface BotProfileDialogProps {
	profile?: BotProfile;
	hosts: BotProfileHost[];
	hostId: string;
	onSave: (profile: BotProfileInput, targetId: string) => Promise<void> | void;
	onUpdateMemory?: (memoryId: string, content: string) => Promise<void> | void;
	onDeleteMemory?: (memoryId: string) => Promise<void> | void;
	onClose: () => void;
}

function BotDialog({
	title,
	children,
	footer,
	onClose,
}: {
	title: string;
	children: ReactNode;
	footer: ReactNode;
	onClose: () => void;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const close = useRef(onClose);
	close.current = onClose;
	useEffect(() => {
		const previous = document.activeElement as HTMLElement | null;
		(
			ref.current?.querySelector<HTMLElement>('input, textarea') ||
			ref.current?.querySelector<HTMLElement>('button')
		)?.focus();
		return () => {
			if (previous?.isConnected) previous.focus();
		};
	}, []);
	return createPortal(
		<div
			className="modal-backdrop bots-dialog-backdrop"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div
				ref={ref}
				className="dialog bots-dialog settings-page"
				role="dialog"
				aria-modal="true"
				aria-label={title}
				onKeyDown={(event) => {
					if (event.key === 'Escape') {
						event.stopPropagation();
						close.current();
					}
					if (event.key !== 'Tab') return;
					const elements = [
						...event.currentTarget.querySelectorAll<HTMLElement>(
							'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
						),
					].filter((item) => item.getClientRects().length);
					const first = elements[0],
						last = elements.at(-1);
					if (event.shiftKey && document.activeElement === first) {
						event.preventDefault();
						last?.focus();
					} else if (!event.shiftKey && document.activeElement === last) {
						event.preventDefault();
						first?.focus();
					}
				}}
			>
				<header className="modal-header">
					<h2>{title}</h2>
					<button
						className="icon-button"
						onClick={onClose}
						aria-label={`Close ${title.toLocaleLowerCase()}`}
					>
						<X size={18} />
					</button>
				</header>
				<div className="dialog-body">{children}</div>
				<footer className="modal-footer">{footer}</footer>
			</div>
		</div>,
		document.body,
	);
}

export function BotProfileDialog(p: BotProfileDialogProps) {
	const firstHost = p.hosts.find((host) => host.targetId === p.hostId) || p.hosts[0];
	const initialConnection =
		firstHost?.connections.find((connection) => connection.id === p.profile?.connectionId) ||
		firstHost?.connections[0];
	const initialModel =
		p.profile?.model || (initialConnection ? defaultModel(initialConnection, 'chat') : '');
	const [targetId, setTargetId] = useState(firstHost?.targetId || p.hostId);
	const [name, setName] = useState(p.profile?.name || '');
	const [address, setAddress] = useState(p.profile?.address || '');
	const [color, setColor] = useState(p.profile?.color || BOT_COLORS[0]);
	const [identity, setIdentity] = useState(p.profile?.identity || '');
	const [learnedPersonality, setLearnedPersonality] = useState(p.profile?.learnedPersonality || '');
	const [connectionId, setConnectionId] = useState(initialConnection?.id || '');
	const [model, setModel] = useState(initialModel);
	const [thinkingMode, setThinkingMode] = useState(
		p.profile?.thinkingMode ||
			(initialConnection ? defaultThinkingMode(initialConnection, initialModel) : undefined),
	);
	const [enabled, setEnabled] = useState(p.profile?.enabled ?? true);
	const [historyAccess, setHistoryAccess] = useState(p.profile?.historyAccess ?? true);
	const [personalityLearning, setPersonalityLearning] = useState(
		p.profile?.personalityLearning ?? true,
	);
	const [memoryEnabled, setMemoryEnabled] = useState(p.profile?.memoryEnabled ?? true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState('');
	const host = p.hosts.find((item) => item.targetId === targetId);
	const memorySupported = host?.memorySupported !== false;
	const connection = host?.connections.find((item) => item.id === connectionId);
	const models = connection ? listModelChoices(connection, 'chat') : [];
	const modes = connection ? availableThinkingModes(connection, model) : [];
	function chooseConnection(next?: Connection) {
		setConnectionId(next?.id || '');
		const nextModel = next ? defaultModel(next, 'chat') : '';
		setModel(nextModel);
		setThinkingMode(next ? defaultThinkingMode(next, nextModel) : undefined);
	}
	async function save() {
		setSaving(true);
		setError('');
		try {
			await p.onSave(
				{
					name: name.trim(),
					address: address.trim() || botAddress(name),
					color,
					identity: identity.trim(),
					learnedPersonality: learnedPersonality.trim(),
					connectionId,
					model,
					thinkingMode,
					enabled,
					historyAccess,
					personalityLearning,
					...(memorySupported ? { memoryEnabled } : {}),
				},
				targetId,
			);
			p.onClose();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSaving(false);
		}
	}
	return (
		<BotDialog
			title={p.profile ? 'Customize bot' : 'Create a bot'}
			onClose={() => {
				if (!saving) p.onClose();
			}}
			footer={
				<>
					<button className="secondary-button" disabled={saving} onClick={p.onClose}>
						Cancel
					</button>
					<button
						className="primary-button"
						disabled={saving || !name.trim()}
						onClick={() => void save()}
					>
						{saving ? 'Saving…' : p.profile ? 'Save bot' : 'Create bot'}
					</button>
				</>
			}
		>
			<div className="bots-dialog-avatar">
				<BotAvatar name={name} color={color} size={62} />
				<div className="bots-dialog-colors" aria-label="Bot color">
					{BOT_COLORS.map((value, index) => (
						<button
							key={value}
							style={{ background: value }}
							aria-label={`Color ${['green', 'blue', 'purple', 'pink', 'gold', 'slate'][index]}`}
							aria-pressed={color === value}
							onClick={() => setColor(value)}
						>
							{color === value && <Check size={14} />}
						</button>
					))}
				</div>
			</div>
			<label>
				Name
				<input
					autoComplete="off"
					aria-label="Name"
					value={name}
					onChange={(event) => setName(event.target.value)}
					placeholder="Fred"
					maxLength={80}
				/>
			</label>
			<label>
				Address
				<input
					autoComplete="off"
					aria-label="Address"
					value={address}
					onChange={(event) => setAddress(event.target.value)}
					placeholder={botAddress(name || 'fred')}
				/>
			</label>
			<label>
				Identity
				<textarea
					aria-label="Identity"
					value={identity}
					onChange={(event) => setIdentity(event.target.value)}
					placeholder="A curious, thoughtful companion who helps me see things from a fresh perspective."
				/>
			</label>
			<SettingsGroup title="Home and model">
				<SettingsRow label="Home" description="This host stores your bot and runs its model.">
					<Select
						aria-label="Bot home"
						value={targetId}
						options={p.hosts.map((item) => ({ value: item.targetId, label: item.name }))}
						disabled={!!p.profile}
						onChange={(value) => {
							setTargetId(value);
							chooseConnection(p.hosts.find((item) => item.targetId === value)?.connections[0]);
						}}
					/>
				</SettingsRow>
				<SettingsRow label="Connection">
					<Select
						aria-label="Connection"
						value={connectionId}
						options={(host?.connections || []).map((item) => ({
							value: item.id,
							label: item.name,
						}))}
						placeholder="No connections"
						onChange={(value) =>
							chooseConnection(host?.connections.find((item) => item.id === value))
						}
					/>
				</SettingsRow>
				<SettingsRow label="Model">
					<Select
						aria-label="Model"
						value={model}
						options={models.map((item) => ({ value: item.id, label: item.name }))}
						placeholder="Select model"
						onChange={(value) => {
							setModel(value);
							setThinkingMode(connection ? defaultThinkingMode(connection, value) : undefined);
						}}
					/>
				</SettingsRow>
				<SettingsRow label="Thinking mode">
					<Select
						aria-label="Thinking mode"
						value={thinkingMode || ''}
						options={modes.map((item) => ({ value: item.id, label: item.name }))}
						placeholder="Configure model thinking"
						onChange={setThinkingMode}
					/>
				</SettingsRow>
			</SettingsGroup>
			{(!connection || !model || !thinkingMode) && (
				<p className="bots-dialog-help">
					You can create your bot now. Choose a model and thinking mode before messaging it.
				</p>
			)}
			<SettingsGroup title="Personality and context">
				<SettingsRow
					label="Chat and Code threads"
					description="Find, read, create, and follow up on threads on this computer and connected hosts. Existing task permissions still apply."
				>
					<Switch
						aria-label="Chat and Code threads"
						checked={historyAccess}
						onChange={setHistoryAccess}
					/>
				</SettingsRow>
				<SettingsRow
					label="Personality learning"
					description="Let this bot remember preferences and develop its personality."
				>
					<Switch
						aria-label="Personality learning"
						checked={personalityLearning}
						onChange={setPersonalityLearning}
					/>
				</SettingsRow>
				<SettingsRow
					label="Persistent memory"
					description={
						memorySupported
							? 'Remember useful facts, decisions, and experiences across direct messages and groups. Separate from personality learning.'
							: 'Update FreeLM on this bot’s home computer to enable persistent memory.'
					}
				>
					<Switch
						aria-label="Persistent memory"
						checked={memorySupported && memoryEnabled}
						disabled={!memorySupported}
						onChange={setMemoryEnabled}
					/>
				</SettingsRow>
				{p.profile && (
					<>
						<SettingsRow label="Enabled">
							<Switch aria-label="Bot enabled" checked={enabled} onChange={setEnabled} />
						</SettingsRow>
						<SettingsRow label="Learned personality" layout="stacked">
							<textarea
								aria-label="Learned personality"
								value={learnedPersonality}
								onChange={(event) => setLearnedPersonality(event.target.value)}
								placeholder="Your bot’s learned preferences will appear here."
							/>
						</SettingsRow>
					</>
				)}
			</SettingsGroup>
			{p.profile && memorySupported && (
				<BotMemoryList
					memories={p.profile.memories || []}
					error={p.profile.memoryError}
					onUpdate={p.onUpdateMemory}
					onDelete={p.onDeleteMemory}
				/>
			)}
			{error && (
				<p className="danger" role="alert">
					{userFacingError(error)}
				</p>
			)}
		</BotDialog>
	);
}

function BotMemoryList({
	memories,
	error,
	onUpdate,
	onDelete,
}: {
	memories: BotMemory[];
	error?: string;
	onUpdate?: BotProfileDialogProps['onUpdateMemory'];
	onDelete?: BotProfileDialogProps['onDeleteMemory'];
}) {
	const [query, setQuery] = useState('');
	const [visible, setVisible] = useState(12);
	const filter = query.trim().toLocaleLowerCase();
	const matches = memories
		.filter((memory) =>
			`${memory.content} ${memory.kind} ${memory.source.title}`
				.toLocaleLowerCase()
				.includes(filter),
		)
		.sort((left, right) => right.updatedAt - left.updatedAt);
	return (
		<SettingsGroup
			title="Saved memories"
			description="Stored on this bot’s home computer and available in future conversations. Edits and deletions save immediately."
		>
			{error && (
				<p className="bots-memory-status danger" role="alert">
					{userFacingError(error)}
				</p>
			)}
			{(memories.length > 5 || query) && (
				<SettingsRow layout="stacked">
					<input
						type="search"
						aria-label="Search saved bot memories"
						placeholder="Search memories"
						value={query}
						onChange={(event) => {
							setQuery(event.target.value);
							setVisible(12);
						}}
					/>
				</SettingsRow>
			)}
			{matches.length === 0 ? (
				<p className="bots-memory-status">
					{memories.length
						? 'No matching memories.'
						: 'Useful knowledge from your conversations will appear here.'}
				</p>
			) : (
				matches
					.slice(0, visible)
					.map((memory) => (
						<BotMemoryRow key={memory.id} memory={memory} onUpdate={onUpdate} onDelete={onDelete} />
					))
			)}
			{matches.length > visible && (
				<button className="bots-memory-more" onClick={() => setVisible((count) => count + 12)}>
					Show more memories ({matches.length - visible})
				</button>
			)}
		</SettingsGroup>
	);
}

function BotMemoryRow({
	memory,
	onUpdate,
	onDelete,
}: {
	memory: BotMemory;
	onUpdate?: BotProfileDialogProps['onUpdateMemory'];
	onDelete?: BotProfileDialogProps['onDeleteMemory'];
}) {
	const [editing, setEditing] = useState(false);
	const [content, setContent] = useState(memory.content);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	async function mutate(remove: boolean) {
		setBusy(true);
		setError('');
		try {
			if (remove) await onDelete?.(memory.id);
			else await onUpdate?.(memory.id, content.trim());
			setEditing(false);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}
	return (
		<div className="bots-memory-row" role="group" aria-label={`Saved memory: ${memory.key}`}>
			<div className="bots-memory-source">
				<span>{memory.kind.charAt(0).toUpperCase() + memory.kind.slice(1)}</span>
				<span aria-hidden="true"> · </span>
				<span>
					{memory.source.title ||
						(memory.source.group ? 'Group conversation' : 'Direct conversation')}
				</span>
				{memory.source.group && <span> · Group</span>}
			</div>
			{editing ? (
				<textarea
					aria-label={`Edit memory: ${memory.key}`}
					value={content}
					maxLength={MAX_BOT_MEMORY_CONTENT}
					disabled={busy}
					onChange={(event) => setContent(event.target.value)}
				/>
			) : (
				<p>{memory.content}</p>
			)}
			{error && (
				<p className="danger" role="alert">
					{userFacingError(error)}
				</p>
			)}
			<div className="bots-memory-actions">
				{editing ? (
					<>
						<button className="secondary-button" disabled={busy} onClick={() => setEditing(false)}>
							Cancel
						</button>
						<button
							className="secondary-button"
							disabled={busy || !content.trim()}
							onClick={() => void mutate(false)}
						>
							{busy ? 'Saving…' : 'Save memory'}
						</button>
					</>
				) : (
					<>
						{onUpdate && (
							<button
								className="secondary-button"
								disabled={busy}
								onClick={() => {
									setContent(memory.content);
									setEditing(true);
									setError('');
								}}
							>
								Edit
							</button>
						)}
						{onDelete && (
							<button
								className="secondary-button danger"
								disabled={busy}
								onClick={() => void mutate(true)}
							>
								{busy ? 'Deleting…' : 'Delete'}
							</button>
						)}
					</>
				)}
			</div>
		</div>
	);
}

export interface BotGroupDialogProps {
	contacts: BotContact[];
	hosts: SelectOption[];
	hostId: string;
	onCreate: (
		participants: BotParticipant[],
		title: string,
		targetId: string,
	) => Promise<void> | void;
	onClose: () => void;
}
export function BotGroupDialog(p: BotGroupDialogProps) {
	const [title, setTitle] = useState('');
	const [hostId, setHostId] = useState(p.hostId);
	const [search, setSearch] = useState('');
	const [selected, setSelected] = useState<Set<string>>(() => new Set());
	const [error, setError] = useState('');
	const [saving, setSaving] = useState(false);
	const contacts = p.contacts.filter(
		({ bot, host }) =>
			bot.enabled &&
			`${bot.name} ${bot.address} ${host.name}`
				.toLocaleLowerCase()
				.includes(search.toLocaleLowerCase()),
	);
	async function create() {
		setSaving(true);
		setError('');
		try {
			await p.onCreate(
				p.contacts
					.filter((contact) => selected.has(botContactKey(contact)))
					.map((contact) => ({ hostId: contact.host.id, botId: contact.bot.id })),
				title.trim(),
				hostId,
			);
			p.onClose();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSaving(false);
		}
	}
	return (
		<BotDialog
			title="New group"
			onClose={() => {
				if (!saving) p.onClose();
			}}
			footer={
				<>
					<button className="secondary-button" disabled={saving} onClick={p.onClose}>
						Cancel
					</button>
					<button
						className="primary-button"
						disabled={saving || selected.size < 2}
						onClick={() => void create()}
					>
						{saving ? 'Creating…' : 'Create group'}
					</button>
				</>
			}
		>
			<label>
				Group name
				<input
					aria-label="Group name"
					placeholder="The brainstorm room"
					value={title}
					onChange={(event) => setTitle(event.target.value)}
					maxLength={100}
				/>
			</label>
			<label>
				Group host
				<Select aria-label="Group host" value={hostId} options={p.hosts} onChange={setHostId} />
			</label>
			<p className="bots-dialog-help">
				Choose at least two bots. Each bot keeps its identity on its own host; this host stores the
				group conversation.
			</p>
			<label className="bots-search">
				<Search size={15} />
				<input
					aria-label="Search bot addresses"
					placeholder="Name or fred@freelm"
					value={search}
					onChange={(event) => setSearch(event.target.value)}
				/>
			</label>
			<div className="bots-group-list">
				{contacts.map((contact) => {
					const key = botContactKey(contact);
					const checked = selected.has(key);
					return (
						<button
							className="bots-group-option"
							key={key}
							aria-pressed={checked}
							onClick={() =>
								setSelected((current) => {
									const next = new Set(current);
									if (next.has(key)) next.delete(key);
									else next.add(key);
									return next;
								})
							}
						>
							<BotAvatar name={contact.bot.name} color={contact.bot.color} size={34} />
							<span>
								<strong>{contact.bot.name}</strong>
								<small>
									{contact.bot.address} · {contact.host.name}
								</small>
							</span>
							<span className="bots-group-checkbox">{checked && <Check size={13} />}</span>
						</button>
					);
				})}
				{!contacts.length && (
					<p className="bots-dialog-help">No matching bots on connected hosts.</p>
				)}
			</div>
			{error && (
				<p className="danger" role="alert">
					{userFacingError(error)}
				</p>
			)}
		</BotDialog>
	);
}
