import { userFacingError } from '../lib/user-facing-error';
import { useCallback, useMemo, useState, type FormEvent } from 'react';
import type { Project, Thread } from '../types';
import type { ChatMemorySettings, SavedMemory } from '../memory-types';
import { MAX_MEMORY_CONTENT, MAX_SAVED_MEMORIES } from '../memory-types';
import { projectKind, threadKind } from '../lib/conversation-kind';
import Select from './Select';
import Switch from './Switch';
import { SettingsGroup, SettingsRow } from './SettingsList';
import './memory-settings.css';

export type MemoryMutation =
	| { kind: 'create'; content: string; projectId?: string }
	| { kind: 'update'; id: string; content: string; revision: number }
	| { kind: 'delete'; id: string; revision: number };

interface Props {
	memorySupported?: boolean;
	value: ChatMemorySettings;
	memories: readonly SavedMemory[];
	projects: readonly Project[];
	threads: readonly Thread[];
	onChange: (value: ChatMemorySettings) => void;
	onMemoryChange?: (mutation: MemoryMutation) => Promise<void>;
	onClearMemorySummaries?: () => Promise<void>;
	onEditingChange?: (editing: boolean) => void;
	onBusyChange?: (busy: boolean) => void;
}
interface Draft {
	id?: string;
	revision?: number;
	content: string;
	projectId: string;
}
const MAX_CONTENT = MAX_MEMORY_CONTENT;
const MAX_MEMORIES = MAX_SAVED_MEMORIES;

export default function MemorySettings({
	memorySupported = true,
	value,
	memories,
	projects,
	threads,
	onChange,
	onMemoryChange,
	onClearMemorySummaries,
	onEditingChange,
	onBusyChange,
}: Props) {
	const [query, setQuery] = useState('');
	const [draft, setDraft] = useState<Draft | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const [notice, setNotice] = useState('');
	const chatProjects = useMemo(
		() => projects.filter((project) => projectKind(project) === 'chat'),
		[projects],
	);
	const scopeName = useCallback(
		(projectId?: string) =>
			projectId
				? chatProjects.find((project) => project.id === projectId)?.name || 'Unavailable project'
				: 'Workspace',
		[chatProjects],
	);
	const shown = useMemo(() => {
		const search = query.trim().toLocaleLowerCase();
		return memories
			.filter((memory) =>
				`${memory.content} ${scopeName(memory.projectId)}`.toLocaleLowerCase().includes(search),
			)
			.sort((a, b) => b.updatedAt - a.updatedAt);
	}, [memories, query, scopeName]);
	const summaryCount = useMemo(
		() =>
			threads.filter((thread) => thread.memorySummary && threadKind(thread, projects) === 'chat')
				.length,
		[threads, projects],
	);
	const latest = draft?.id ? memories.find((memory) => memory.id === draft.id) : undefined;
	const stale = !!draft?.id && (!latest || latest.revision !== draft.revision);
	const canManage = memorySupported && !!onMemoryChange;

	function edit(memory?: SavedMemory) {
		setDraft({
			id: memory?.id,
			revision: memory?.revision,
			content: memory?.content || '',
			projectId: memory?.projectId || '',
		});
		setError('');
		setNotice('');
		onEditingChange?.(true);
	}
	function cancel() {
		setDraft(null);
		setError('');
		onEditingChange?.(false);
	}
	async function perform(operation: () => Promise<void>, message: string) {
		if (busy) return;
		setBusy(true);
		onBusyChange?.(true);
		setError('');
		setNotice('');
		try {
			await operation();
			setNotice(message);
			return true;
		} catch (error) {
			setError(error instanceof Error ? error.message : 'Could not save your memory changes.');
			return false;
		} finally {
			setBusy(false);
			onBusyChange?.(false);
		}
	}
	async function save(event: FormEvent) {
		event.preventDefault();
		if (!draft || !onMemoryChange || busy || stale) return;
		const content = draft.content.trim();
		if (!content || content.length > MAX_CONTENT) {
			setError('Write a memory between 1 and 4,000 characters.');
			return;
		}
		if (!draft.id && memories.length >= MAX_MEMORIES) {
			setError('You have 256 saved memories. Delete one before adding another.');
			return;
		}
		const mutation: MemoryMutation = draft.id
			? { kind: 'update', id: draft.id, content, revision: draft.revision! }
			: { kind: 'create', content, ...(draft.projectId ? { projectId: draft.projectId } : {}) };
		if (
			await perform(() => onMemoryChange(mutation), draft.id ? 'Memory updated.' : 'Memory added.')
		) {
			setDraft(null);
			onEditingChange?.(false);
		}
	}

	return (
		<div className="memory-settings">
			{!memorySupported && (
				<p className="remote-settings-note">
					Update this remote FreeLM instance to enable Chat memory.
				</p>
			)}
			<SettingsGroup
				title="Memory preferences"
				description={
					<>
						Memory is used in Chat. Code tasks do not use it. Workspace memories can guide any Chat;
						project memories stay within their Chat project. Chat history stays within the same
						project, or within conversations outside projects.
					</>
				}
			>
				<SettingsRow
					label="Use saved memories"
					htmlFor="memory-settings-saved"
					description={
						<>Let Chat use details you or your models have saved. You can manage them below.</>
					}
				>
					<Switch
						id="memory-settings-saved"
						aria-label="Use saved memories"
						checked={value.savedMemories}
						disabled={busy || !memorySupported}
						onChange={(savedMemories) => onChange({ ...value, savedMemories })}
					/>
				</SettingsRow>
				<SettingsRow
					label="Reference chat history"
					htmlFor="memory-settings-history"
					description={
						<>Let Chat use relevant context from earlier conversations in the same Chat scope.</>
					}
				>
					<Switch
						id="memory-settings-history"
						aria-label="Reference chat history"
						checked={value.referenceHistory}
						disabled={busy || !memorySupported}
						onChange={(referenceHistory) => onChange({ ...value, referenceHistory })}
					/>
				</SettingsRow>
			</SettingsGroup>
			<SettingsGroup
				title="Saved memories"
				description={`${memories.length} of ${MAX_MEMORIES} memories`}
				actions={
					<button
						type="button"
						className="secondary-button"
						disabled={!canManage || busy || !!draft || memories.length >= MAX_MEMORIES}
						onClick={() => edit()}
					>
						Add memory
					</button>
				}
			>
				{memorySupported && !canManage && (
					<SettingsRow layout="stacked">
						<p className="settings-help">Memory management is unavailable in this workspace.</p>
					</SettingsRow>
				)}
				<SettingsRow
					label="Search memories"
					htmlFor="memory-settings-search"
					layout="stacked"
					className="memory-search"
				>
					<input
						id="memory-settings-search"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="Search by content or project"
					/>
				</SettingsRow>
				{draft && (
					<SettingsRow layout="stacked" className="memory-editor-row">
						<form
							className="memory-editor"
							aria-label={draft.id ? 'Edit memory' : 'Add memory'}
							onSubmit={save}
						>
							<SettingsRow label="Memory" htmlFor="memory-settings-content" layout="stacked">
								<textarea
									id="memory-settings-content"
									autoFocus
									maxLength={MAX_CONTENT}
									value={draft.content}
									disabled={busy}
									onChange={(event) => setDraft({ ...draft, content: event.target.value })}
									placeholder="What should Chat remember?"
								/>
							</SettingsRow>
							<div className="memory-editor-details">
								{draft.id ? (
									<p className="settings-help">Scope: {scopeName(draft.projectId || undefined)}</p>
								) : (
									<label>
										Memory scope
										<Select
											aria-label="Memory scope"
											value={draft.projectId}
											disabled={busy}
											onChange={(projectId) => setDraft({ ...draft, projectId })}
											options={[
												{ value: '', label: 'Workspace' },
												...chatProjects.map((project) => ({
													value: project.id,
													label: project.name,
												})),
											]}
										/>
									</label>
								)}
								<span className="settings-help">
									{draft.content.length.toLocaleString()} / 4,000 characters
								</span>
							</div>
							{stale && (
								<p className="error-note" role="alert">
									This memory changed while you were editing. Cancel and reopen it to use the latest
									version.
								</p>
							)}
							<div className="memory-editor-actions">
								<button type="button" className="secondary-button" disabled={busy} onClick={cancel}>
									Cancel memory changes
								</button>
								<button
									type="submit"
									className="primary-button"
									disabled={busy || stale || !draft.content.trim()}
								>
									{busy ? 'Saving…' : 'Save memory'}
								</button>
							</div>
						</form>
					</SettingsRow>
				)}
				{error && (
					<SettingsRow layout="stacked">
						<p className="error-note" role="alert">
							{userFacingError(error)}
						</p>
					</SettingsRow>
				)}
				{notice && (
					<SettingsRow layout="stacked">
						<p className="settings-help" role="status">
							{notice}
						</p>
					</SettingsRow>
				)}
				<SettingsRow layout="stacked" className="memory-list-row">
					<div className="memory-list" aria-label="Saved memories">
						{shown.map((memory, index) => (
							<article className="memory-note" key={memory.id} aria-label={`Memory ${index + 1}`}>
								<div className="memory-note-meta">
									<span>{scopeName(memory.projectId)}</span>
									<span>{memory.source === 'model' ? 'Saved by Chat' : 'Saved by you'}</span>
								</div>
								<p className="memory-note-content">{memory.content}</p>
								<div className="memory-note-actions">
									<button
										type="button"
										className="secondary-button"
										aria-label="Edit memory"
										disabled={!canManage || busy || !!draft}
										onClick={() => edit(memory)}
									>
										Edit
									</button>
									<button
										type="button"
										className="secondary-button memory-delete"
										aria-label="Delete memory"
										disabled={!canManage || busy || !!draft}
										onClick={() =>
											void perform(
												() =>
													onMemoryChange!({
														kind: 'delete',
														id: memory.id,
														revision: memory.revision,
													}),
												'Memory deleted.',
											)
										}
									>
										Delete
									</button>
								</div>
							</article>
						))}
						{!shown.length && (
							<p className="settings-help">
								{memories.length
									? 'No memories match your search.'
									: 'No saved memories yet. Add a detail you want Chat to remember.'}
							</p>
						)}
					</div>
				</SettingsRow>
			</SettingsGroup>
			{memorySupported && onClearMemorySummaries && summaryCount > 0 && (
				<SettingsGroup title="Chat history">
					<SettingsRow
						label="Chat history summaries"
						description={
							<>
								{summaryCount} cached {summaryCount === 1 ? 'summary' : 'summaries'}. Your chats and
								saved memories remain when you clear this cache.
							</>
						}
					>
						<button
							type="button"
							className="secondary-button"
							disabled={busy || !!draft}
							onClick={() =>
								void perform(onClearMemorySummaries, 'Chat history summaries cleared.')
							}
						>
							Clear summaries
						</button>
					</SettingsRow>
				</SettingsGroup>
			)}
		</div>
	);
}
