import { userFacingError } from '../lib/user-facing-error';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppState, ConversationKind } from '../types';
import type { PromptContextSection, ToolDefinition } from '../agent-types';
import { projectKind, threadKind } from '../lib/conversation-kind';
import { copyToClipboard } from '../lib/clipboard';
import { formatPromptContext } from '../lib/prompt-context';
import Select from './Select';
import { SettingsGroup, SettingsRow } from './SettingsList';
import './personalization-settings.css';

export interface SystemPromptBuildRequest {
	state: AppState;
	kind: ConversationKind;
	threadId?: string;
	projectId?: string;
	connectionId?: string;
	model?: string;
	refresh?: boolean;
}
export interface SystemPromptBuildResult {
	text: string;
	context?: PromptContextSection[];
	tools: ToolDefinition[];
	apiTools?: Record<string, unknown>[];
	warnings: string[];
}
export type BuildSystemPrompt = (
	request: SystemPromptBuildRequest,
	signal: AbortSignal,
) => Promise<SystemPromptBuildResult>;
export interface LastSentSystemPrompt {
	threadId: string;
	kind: ConversationKind;
	text: string;
	context?: PromptContextSection[];
	tools: ToolDefinition[];
	apiTools?: Record<string, unknown>[];
	sentAt: number;
	connectionId: string;
	model: string;
}
interface Props {
	state: AppState;
	visible: boolean;
	draft: boolean;
	activeKind?: ConversationKind;
	activeThreadId?: string;
	activeProjectId?: string;
	onBuild?: BuildSystemPrompt;
	lastSentSystemPrompt?: LastSentSystemPrompt;
}
const promptModes = [
	{ value: 'chat', label: 'Chat' },
	{ value: 'code', label: 'Code' },
];
function copyablePrompt(prompt: { text: string; context?: PromptContextSection[] }): string {
	const context = formatPromptContext(prompt.context ?? []);
	return context
		? `System instructions\n\n${prompt.text}\n\nUser-role context\n\n${context}`
		: prompt.text;
}
function PromptContext({
	context,
	last = false,
}: {
	context?: PromptContextSection[];
	last?: boolean;
}) {
	const text = formatPromptContext(context ?? []);
	if (!text) return null;
	return (
		<SettingsRow
			label={last ? 'Last sent user-role context' : 'User-role context'}
			layout="stacked"
			description="Project instructions, repository guidance, and saved memory are sent with their source labels as user-role context, separate from application instructions."
		>
			<pre
				className="system-prompt-output"
				aria-label={`${last ? 'Last sent' : 'Generated'} user-role context`}
			>
				{text}
			</pre>
		</SettingsRow>
	);
}
function ToolSchemas({
	tools,
	apiTools,
	last = false,
}: {
	tools: ToolDefinition[];
	apiTools?: Record<string, unknown>[];
	last?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const wire = apiTools !== undefined;
	const schemas = useMemo(
		() =>
			open
				? JSON.stringify(
						apiTools ??
							tools.map((tool) => ({
								name: tool.name,
								description: tool.description,
								parameters: tool.parameters,
								deferred: tool.deferred,
							})),
						null,
						2,
					)
				: '',
		[open, apiTools, tools],
	);
	const label = `${last ? 'Last sent ' : ''}${wire ? 'API tool definitions' : 'tool catalog'}`;
	return (
		<details
			className="system-prompt-tools"
			onToggle={(event) => setOpen(event.currentTarget.open)}
		>
			<summary>
				{label} ({(apiTools ?? tools).length})
			</summary>
			{open && (
				<>
					<p className="settings-help">
						{wire
							? 'These are the complete tool definitions in the API request’s tools field, separate from the system prompt text.'
							: 'This is the available tool catalog. It is not an exact snapshot of the API request’s tools field.'}
					</p>
					<pre aria-label={label}>{schemas}</pre>
				</>
			)}
		</details>
	);
}
export default function SystemPromptView({
	state,
	visible,
	draft,
	activeKind = 'chat',
	activeThreadId,
	activeProjectId,
	onBuild,
	lastSentSystemPrompt,
}: Props) {
	const [kind, setKind] = useState<ConversationKind>(activeKind);
	const [selectedThreadId, setSelectedThreadId] = useState(activeThreadId ?? '');
	const [selectedProjectId, setSelectedProjectId] = useState(activeProjectId ?? '');
	const [refresh, setRefresh] = useState(0);
	const lastRefresh = useRef(0);
	const [result, setResult] = useState<SystemPromptBuildResult | null>(null);
	const [error, setError] = useState('');
	const [loading, setLoading] = useState(false);
	const [copyStatus, setCopyStatus] = useState('');
	const threads = useMemo(
		() => state.threads.filter((thread) => threadKind(thread, state.projects) === kind),
		[state.threads, state.projects, kind],
	);
	const thread = threads.find((thread) => thread.id === selectedThreadId);
	const projects = useMemo(
		() => state.projects.filter((project) => projectKind(project) === kind),
		[state.projects, kind],
	);
	const projectId =
		thread?.projectId ?? projects.find((project) => project.id === selectedProjectId)?.id;
	const lastSent =
		lastSentSystemPrompt?.kind === kind && lastSentSystemPrompt.threadId === thread?.id
			? lastSentSystemPrompt
			: undefined;
	const connectionId = thread?.connectionId ?? state.activeConnectionId;
	const connection = state.connections.find((connection) => connection.id === connectionId);
	const model = thread?.model || connection?.models.chat || '';
	const request = useMemo<SystemPromptBuildRequest>(
		() => ({ state, kind, threadId: thread?.id, projectId, connectionId, model }),
		[state, kind, thread?.id, projectId, connectionId, model],
	);
	useEffect(() => {
		if (!visible || !onBuild) return;
		const controller = new AbortController();
		setLoading(true);
		setResult(null);
		setError('');
		setCopyStatus('');
		// Coalesce typing and streamed workspace updates before catalog discovery.
		const timer = window.setTimeout(() => {
			const reload = refresh !== lastRefresh.current;
			lastRefresh.current = refresh;
			void Promise.resolve()
				.then(() =>
					onBuild({ ...request, ...(reload ? { refresh: true } : {}) }, controller.signal),
				)
				.then((next) => {
					if (!controller.signal.aborted) setResult(next);
				})
				.catch((failure) => {
					if (!controller.signal.aborted)
						setError(
							failure instanceof Error ? failure.message : 'Could not build the system prompt.',
						);
				})
				.finally(() => {
					if (!controller.signal.aborted) setLoading(false);
				});
		}, 250);
		return () => {
			window.clearTimeout(timer);
			controller.abort();
		};
	}, [visible, onBuild, request, refresh]);
	async function copy(text: string, label = 'Prompt') {
		try {
			await copyToClipboard(text);
			setCopyStatus(`${label} copied.`);
		} catch {
			setCopyStatus('Could not copy the prompt. Select the text to copy it.');
		}
	}
	return (
		<div className="system-prompt-view">
			<SettingsGroup
				title="Full generated system prompt"
				description={
					<>
						Inspect the instructions FreeLM builds for a conversation, including personalization,
						memory and tool guidance. Source-labelled user-role context and API tool definitions are
						shown separately below. Copying a prompt includes its user-role context.
					</>
				}
			>
				<SettingsRow label="Mode" htmlFor="system-prompt-mode">
					<Select
						id="system-prompt-mode"
						aria-label="Prompt mode"
						value={kind}
						options={promptModes}
						onChange={(mode) => {
							setKind(mode as ConversationKind);
							setSelectedThreadId('');
							setSelectedProjectId('');
						}}
					/>
				</SettingsRow>
				<SettingsRow label="Conversation" htmlFor="system-prompt-conversation">
					<Select
						id="system-prompt-conversation"
						aria-label="Prompt conversation"
						value={thread?.id ?? ''}
						onChange={setSelectedThreadId}
						options={[
							{ value: '', label: `New ${kind === 'chat' ? 'Chat' : 'Code'} conversation` },
							...threads.map((thread) => ({ value: thread.id, label: thread.title })),
						]}
					/>
				</SettingsRow>
				{!thread && (
					<SettingsRow label="Project" htmlFor="system-prompt-project">
						<Select
							id="system-prompt-project"
							aria-label="Prompt project"
							value={projectId ?? ''}
							onChange={setSelectedProjectId}
							options={[
								{ value: '', label: 'Outside projects' },
								...projects.map((project) => ({ value: project.id, label: project.name })),
							]}
						/>
					</SettingsRow>
				)}
				<SettingsRow
					label="Prompt preview"
					layout="stacked"
					className="system-prompt-preview-row"
					description={
						<>
							{connection?.name ?? 'No API connection'}
							{model ? ` · ${model}` : ' · No model selected'}
						</>
					}
				>
					<p className="system-prompt-state" role="status">
						{draft
							? 'Draft preview — save settings to apply these instructions.'
							: 'Preview from saved settings.'}
					</p>
					<div className="system-prompt-actions">
						<button
							type="button"
							className="secondary-button"
							disabled={!onBuild}
							onClick={() => setRefresh((value) => value + 1)}
						>
							Refresh prompt
						</button>
						<button
							type="button"
							className="secondary-button"
							disabled={!result || loading}
							onClick={() => result && void copy(copyablePrompt(result))}
						>
							Copy prompt
						</button>
					</div>
					{!onBuild && (
						<p className="settings-help">Prompt preview is unavailable in this workspace.</p>
					)}
					{loading && (
						<p className="settings-help" role="status">
							Building prompt…
						</p>
					)}
					{error && (
						<p className="error-note" role="alert">
							Could not build the full prompt: {userFacingError(error)} No complete preview is
							available.
						</p>
					)}
					{result && (
						<>
							{result.warnings.length > 0 && (
								<div className="system-prompt-warnings" role="note">
									{result.warnings.map((warning, index) => (
										<p key={index}>{warning}</p>
									))}
								</div>
							)}
							<pre className="system-prompt-output" aria-label="Generated system prompt">
								{result.text || '(No system instructions)'}
							</pre>
						</>
					)}
					{copyStatus && (
						<p className="settings-help" role="status">
							{copyStatus}
						</p>
					)}
				</SettingsRow>
				{result && <PromptContext context={result.context} />}
				{result && (
					<SettingsRow layout="stacked">
						<ToolSchemas tools={result.tools} apiTools={result.apiTools} />
					</SettingsRow>
				)}
			</SettingsGroup>
			<SettingsGroup
				title="Last sent system prompt"
				description={
					lastSent ? (
						<>
							Exact FreeLM instructions from the last request sent in this app session, at{' '}
							{new Date(lastSent.sentAt).toLocaleString()} · {lastSent.model}. This snapshot does
							not change when you edit settings.
						</>
					) : undefined
				}
				actions={
					lastSent ? (
						<button
							type="button"
							className="secondary-button system-prompt-copy-last"
							onClick={() => void copy(copyablePrompt(lastSent), 'Last sent prompt')}
						>
							Copy last sent prompt
						</button>
					) : undefined
				}
			>
				{lastSent ? (
					<>
						<SettingsRow layout="stacked">
							<pre className="system-prompt-output" aria-label="Last sent system prompt">
								{lastSent.text || '(No system instructions)'}
							</pre>
						</SettingsRow>
						<PromptContext context={lastSent.context} last />
						<SettingsRow layout="stacked">
							<ToolSchemas tools={lastSent.tools} apiTools={lastSent.apiTools} last />
						</SettingsRow>
					</>
				) : (
					<SettingsRow layout="stacked">
						<p className="settings-help">
							No sent prompt snapshot is available for this conversation in this app session.
						</p>
					</SettingsRow>
				)}
			</SettingsGroup>
		</div>
	);
}
