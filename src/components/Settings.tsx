import ConnectionFields from './ConnectionFields';
import { assertConnection } from '../lib/connection-validation';
import MobilePairingSettings from './MobilePairingSettings';
import BotSoundSettings from './BotSoundSettings';
import { defaultBotResponseSound } from '../notification-types';
import { userFacingError } from '../lib/user-facing-error';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
	ArrowLeft,
	Check,
	ChevronRight,
	LoaderCircle,
	Monitor,
	Moon,
	Plus,
	Server,
	Sun,
	Trash2,
} from 'lucide-react';
import type {
	AppState,
	CodeCompactionSettings,
	Connection,
	ConversationKind,
	ThinkingMode,
} from '../types';
import type { ToolSettings as ToolSettingsValue } from '../agent-types';
import type { ChatMemorySettings } from '../memory-types';
import type { ModerationSettings as ModerationValues } from '../moderation-types';
import { moderationSettings, validModerationSettings } from '../lib/moderation';
import {
	MAX_CUSTOM_INSTRUCTIONS,
	type PersonalizationSettings as PersonalizationValues,
} from '../personalization-types';
import { defaultPersonalization } from '../lib/personalization';
import { listModels } from '../lib/api';
import { newConnection, downloadText } from '../lib/state';
import {
	assertModelCatalog,
	assertThinkingPresets,
	defaultThinkingPresets,
	assertModelSupports,
} from '../lib/catalog';
import ModelCatalogEditor from './ModelCatalogEditor';
import ThinkingPresetsEditor from './ThinkingPresetsEditor';
import Instances from './Instances';
import ToolSettings, { assertToolSettingsValues } from './ToolSettings';
import Select from './Select';
import AppearanceAccentSettings from './AppearanceAccentSettings';
import { normalizeAccentColor, normalizeAppearance } from '../lib/appearance';
import SearchSettings from './SearchSettings';
import DictationSettings from './DictationSettings';
import CodeSettings from './CodeSettings';
import ModerationSettings from './ModerationSettings';
import {
	defaultCodeCompactionSettings,
	validateCodeCompactionSettings,
} from '../lib/code-compaction';
import { persistentWorkspace } from '../lib/temporary-chats';
import Switch from './Switch';
import MemorySettings, { type MemoryMutation } from './MemorySettings';
import PersonalizationSettings from './PersonalizationSettings';
import SystemPromptView, {
	type BuildSystemPrompt,
	type LastSentSystemPrompt,
} from './SystemPromptView';
import { defaultToolSettings } from '../lib/tool-settings';
import { SettingsGroup, SettingsRow } from './SettingsList';
import PluginSettings from './PluginSettings';
import SchedulerSettings from './SchedulerSettings';
import './settings.css';

export type SettingsSection =
	| 'chat'
	| 'code'
	| 'schedules'
	| 'archived'
	| 'configuration'
	| 'personalization'
	| 'system'
	| 'memories'
	| 'moderation'
	| 'appearance'
	| 'iphone'
	| 'connections'
	| 'search'
	| 'tools'
	| 'remote'
	| 'plugins'
	| 'mcp'
	| 'skills';
export interface SettingsValues {
	connections: Connection[];
	activeConnectionId: string;
	theme: AppState['theme'];
	appearance: NonNullable<AppState['appearance']>;
	debugMode: boolean;
	dictation: import('../types').DictationSettings;
	backgroundNotifications: boolean;
	botResponseSound?: import('../notification-types').BotResponseSound;
	codeCompaction?: CodeCompactionSettings;
	memorySettings: ChatMemorySettings;
	personalization?: PersonalizationValues;
	moderation?: ModerationValues;
	systemPrompt: string;
	thinkingPresets: ThinkingMode[];
	toolSettings: ToolSettingsValue;
}
interface Props {
	state: AppState;
	secureStorage: boolean;
	secureStorageChecked?: boolean;
	storageLocation: string;
	remote?: boolean;
	activeWorkspaceId: string;
	workspaceName: string;
	initialSection?: SettingsSection;
	exitRequest?: number;
	sectionRequest?: number;
	onExitCancel?: () => void;
	onSelectWorkspace: (id: string) => Promise<void>;
	onSave: (
		values: Omit<SettingsValues, 'toolSettings'> & { toolSettings?: ToolSettingsValue },
	) => Promise<void>;
	onClose: () => void;
	onOpenPlugins?: () => void;
	onWelcome?: () => void;
	onRestoreThread?: (id: string) => void;
	onMemoryChange?: (mutation: MemoryMutation) => Promise<void>;
	onClearMemorySummaries?: () => Promise<void>;
	memorySupported?: boolean;
	personalizationSupported?: boolean;
	codeCompactionSupported?: boolean;
	moderationSupported?: boolean;
	activeKind?: ConversationKind;
	activeThreadId?: string;
	activeProjectId?: string;
	onBuildSystemPrompt?: BuildSystemPrompt;
	lastSentSystemPrompt?: LastSentSystemPrompt;
}
const sections = [
	{ id: 'configuration', name: 'Configuration' },
	{ id: 'personalization', name: 'Personalization' },
	{ id: 'chat', name: 'Chat' },
	{ id: 'code', name: 'Code' },
	{ id: 'schedules', name: 'Scheduled tasks' },
	{ id: 'archived', name: 'Archived chats' },
	{ id: 'system', name: 'System' },
	{ id: 'memories', name: 'Memories' },
	{ id: 'moderation', name: 'Moderation' },
	{ id: 'appearance', name: 'Appearance' },
	{ id: 'connections', name: 'Connections' },
    { id: 'iphone', name: 'iPhone Bots' },
	{ id: 'search', name: 'Search' },
	{ id: 'tools', name: 'Tools' },
] as const;
const integrationSections = [
	{ id: 'plugins', name: 'Plugins' },
	{ id: 'remote', name: 'Remote FreeLM' },
	{ id: 'mcp', name: 'MCP servers' },
	{ id: 'skills', name: 'Skills' },
] as const;
const descriptions: Record<SettingsSection, string> = {
	chat: 'Configure dictation and completion notifications for Chat.',
	code: 'Configure how Code manages context during longer tasks.',
	schedules: 'Manage reminders and scheduled work for your bots and Code tasks.',
	archived: 'Restore conversations you have archived.',
	configuration:
		'Discover or add a model, then choose Standard mode or the thinking values it supports.',
	personalization: 'Customize how Chat and Code communicate with you.',
	system: 'Inspect the instructions FreeLM sends and add workspace guidance.',
	memories: 'Choose what Chat remembers and manage your saved details.',
	moderation: 'Choose the policy and evaluators for image and video generation.',
	appearance: 'Choose the appearance of your workspace.',
	connections: 'Connect your workspace to the APIs you use.',
    iphone: 'Connect one iPhone securely to Bots on this Mac.',
	plugins: 'Connect services and manage account access for Chat, Code, and Bots.',
	remote: 'Open another computer’s FreeLM workspace and run requests there.',
	search: 'Choose a search service and the engines used for web browsing.',
	tools: 'Configure Chat Python, Code tools, and image and video generation.',
	mcp: 'Discover tools for Code tasks from the Model Context Protocol servers you connect.',
	skills: 'Give Code tasks reusable instructions from local skill folders.',
};
function valuesFor(
	state: AppState,
	memorySupported: boolean,
	personalizationSupported: boolean,
	codeCompactionSupported: boolean,
	moderationSupported: boolean,
): SettingsValues {
	return structuredClone({
		connections: state.connections,
		activeConnectionId: state.activeConnectionId,
		theme: state.theme,
		appearance: normalizeAppearance(state.appearance),
		debugMode: state.debugMode ?? false,
		dictation: state.dictation ?? { enabled: false, connectionId: '', model: '' },
		backgroundNotifications: state.backgroundNotifications ?? true,
		botResponseSound: state.botResponseSound ?? defaultBotResponseSound,
		...(codeCompactionSupported
			? { codeCompaction: state.codeCompaction ?? defaultCodeCompactionSettings() }
			: {}),
		memorySettings: memorySupported
			? (state.memorySettings ?? { savedMemories: true, referenceHistory: true })
			: { savedMemories: false, referenceHistory: false },
		...(personalizationSupported
			? { personalization: state.personalization ?? defaultPersonalization() }
			: {}),
		...(moderationSupported ? { moderation: moderationSettings(state.moderation) } : {}),
		systemPrompt: state.systemPrompt ?? '',
		thinkingPresets: state.thinkingPresets ?? defaultThinkingPresets(),
		toolSettings: state.toolSettings ?? defaultToolSettings(),
	});
}

export default function Settings({
	state,
	secureStorage,
	secureStorageChecked = true,
	storageLocation,
	remote = false,
	activeWorkspaceId,
	workspaceName,
	initialSection = 'configuration',
	exitRequest = 0,
	sectionRequest = 0,
	onExitCancel,
	onSelectWorkspace,
	onSave,
	onClose,
	onOpenPlugins,
	onWelcome,
	onRestoreThread,
	onMemoryChange,
	onClearMemorySummaries,
	memorySupported = true,
	personalizationSupported = true,
	codeCompactionSupported = true,
	moderationSupported = true,
	activeKind = 'chat',
	activeThreadId,
	activeProjectId,
	onBuildSystemPrompt,
	lastSentSystemPrompt,
}: Props) {
	const [values, setValues] = useState(() =>
		valuesFor(
			state,
			memorySupported,
			personalizationSupported,
			codeCompactionSupported,
			moderationSupported,
		),
	);
	const baseline = useRef(JSON.stringify(values));
	const [section, setSection] = useState(initialSection);
	const [busy, setBusy] = useState(false);
	const [saving, setSaving] = useState(false);
	const [instanceBusy, setInstanceBusy] = useState(false);
	const [notice, setNotice] = useState('');
	const [error, setError] = useState('');
	const [saved, setSaved] = useState(false);
	const [catalogEditing, setCatalogEditing] = useState(false);
	const [presetsEditing, setPresetsEditing] = useState(false);
	const [memoryEditing, setMemoryEditing] = useState(false);
	const [leaving, setLeaving] = useState(false);
	const content = useRef<HTMLDivElement>(null);
	const discovery = useRef<AbortController | null>(null);
	const lastExitRequest = useRef(exitRequest);
	const lastSectionRequest = useRef({ section: initialSection, request: sectionRequest });
	const connection = values.connections.find((c) => c.id === values.activeConnectionId)!;
	const dirty = baseline.current !== JSON.stringify(values);
	const pending = dirty || catalogEditing || presetsEditing || memoryEditing;
	const working = busy || instanceBusy || saving;
	const invalidAccent =
		values.appearance.accent === 'custom' && !normalizeAccentColor(values.appearance.customAccent);
	const previewState = useMemo(() => ({ ...state, ...values }), [state, values]);
	const title = [...sections, ...integrationSections].find((s) => s.id === section)!.name;
	useEffect(() => () => discovery.current?.abort(), []);

	function update(patch: Partial<SettingsValues>) {
		setValues((value) => ({ ...value, ...patch }));
		setError('');
		setSaved(false);
	}
	function updateConnection(patch: Partial<Connection>) {
		if (remote) return;
		setValues((value) => ({
			...value,
			connections: value.connections.map((c) =>
				c.id === value.activeConnectionId ? { ...c, ...patch } : c,
			),
		}));
		setError('');
		setSaved(false);
	}
	function selectConnection(id: string) {
		if (catalogEditing) {
			setError('Apply or cancel your model changes before switching connections.');
			return;
		}
		update({ activeConnectionId: id });
		setNotice('');
	}
	function back() {
		if (working) {
			onExitCancel?.();
			return;
		}
		if (pending) setLeaving(true);
		else onClose();
	}
	useEffect(() => {
		if (lastExitRequest.current === exitRequest) return;
		lastExitRequest.current = exitRequest;
		back();
	}, [exitRequest]);
	useEffect(() => {
		const escape = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				back();
			}
		};
		window.addEventListener('keydown', escape);
		return () => window.removeEventListener('keydown', escape);
	});
	function navigate(next: SettingsSection) {
		setSection(next);
		if (leaving) onExitCancel?.();
		setLeaving(false);
		content.current?.scrollTo(0, 0);
	}
	useEffect(() => {
		if (
			lastSectionRequest.current.section === initialSection &&
			lastSectionRequest.current.request === sectionRequest
		)
			return;
		lastSectionRequest.current = { section: initialSection, request: sectionRequest };
		if (!working) navigate(initialSection);
	}, [initialSection, sectionRequest]);
	async function discover() {
		if (connection.providerAdapter) return;
		const controller = new AbortController();
		discovery.current = controller;
		setBusy(true);
		setError('');
		setNotice('');
		try {
			const models = await listModels(connection, controller.signal);
			updateConnection({ discoveredModels: models });
			setNotice(
				models.length
					? `Found ${models.length} ${models.length === 1 ? 'model' : 'models'}. Configure any model below.`
					: 'Connected. No models listed; add a model by its API ID.',
			);
		} catch (e) {
			if (controller.signal.aborted) setNotice('Model discovery cancelled.');
			else setError(e instanceof Error ? e.message : String(e));
		} finally {
			discovery.current = null;
			setBusy(false);
		}
	}
	async function save(close = false) {
		if (working) return;
		if (catalogEditing || presetsEditing || memoryEditing) {
			setError(
				memoryEditing
					? 'Save or cancel the memory being edited before saving settings.'
					: 'Apply or cancel the model or thinking option being edited before saving settings.',
			);
			return;
		}
		try {
			for (const c of values.connections) assertConnection(c);
			assertThinkingPresets(values.thinkingPresets);
			if (codeCompactionSupported && values.codeCompaction)
				validateCodeCompactionSettings(values.codeCompaction);
			if (values.moderation && !validModerationSettings(values.moderation))
				throw new Error('Check your moderation settings.');
			if (values.dictation.enabled) {
				const selected = values.connections.find(
					(item) => item.id === values.dictation.connectionId,
				);
				if (!selected || !values.dictation.model.trim())
					throw new Error('Choose a transcription model before enabling dictation.');
				assertModelSupports(selected, values.dictation.model, 'transcription');
			}
			if (!remote) assertToolSettingsValues(values.toolSettings, values.connections);
			if (values.systemPrompt.length > 100_000)
				throw new Error('Keep the system prompt under 100,000 characters.');
			if (
				values.personalization &&
				(['chat', 'code'] as const).some(
					(kind) =>
						values.personalization![kind].customInstructions.length > MAX_CUSTOM_INSTRUCTIONS,
				)
			)
				throw new Error('Keep custom instructions under 10,000 characters for each mode.');
			const next = {
				...values,
				appearance: normalizeAppearance(values.appearance),
				toolSettings: remote ? (state.toolSettings ?? defaultToolSettings()) : values.toolSettings,
				connections: remote
					? state.connections
					: values.connections.map((c) => ({
							...c,
							name: c.name.trim(),
							baseUrl: c.baseUrl.trim().replace(/\/+$/, ''),
							apiKey: c.apiKey.trim(),
						})),
			};
			setSaving(true);
			// Preserve the host's exact configuration, including an absent field in older workspaces.
			await onSave(remote ? { ...next, toolSettings: state.toolSettings } : next);
			setValues(next);
			baseline.current = JSON.stringify(next);
			setSaved(true);
			setError('');
			setLeaving(false);
			if (close) onClose();
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Check your settings.');
		} finally {
			setSaving(false);
		}
	}

	return (
		<section className="settings-page" aria-label="Settings">
			<aside className="settings-sidebar">
				<button className="settings-back" onClick={back} disabled={working}>
					<ArrowLeft size={17} /> Back to workspace
				</button>
				<h1>Settings</h1>
				<nav aria-label="Settings options">
					<h2>Personal</h2>
					{sections.map(({ id, name }) => (
						<button
							key={id}
							aria-current={section === id ? 'page' : undefined}
							disabled={working}
							onClick={() => navigate(id)}
						>
							<span>{name}</span>
						</button>
					))}
					<h2>Integrations</h2>
					{integrationSections.map(({ id, name }) => (
						<button
							key={id}
							aria-current={section === id ? 'page' : undefined}
							disabled={working}
							onClick={() => navigate(id)}
						>
							<span>{name}</span>
						</button>
					))}
				</nav>
				<div className="settings-workspace">
					<span className="settings-workspace-dot" />
					<span>{workspaceName}</span>
				</div>
			</aside>
			<div className="settings-main">
				<div className="settings-scroll" ref={content} inert={saving}>
					<div className="settings-content">
						<header className="settings-page-heading">
							<h2>{title}</h2>
							<p>{descriptions[section]}</p>
						</header>
						<div hidden={section !== 'configuration'} className="settings-section-content">
							<SettingsGroup
								title="Model discovery"
								actions={
									<button
										className="secondary-button compact"
										disabled={working || catalogEditing}
										onClick={() => navigate('connections')}
									>
										Edit connection
									</button>
								}
							>
								<SettingsRow
									label="API connection"
									description="Choose the API whose models you want to discover and configure."
								>
									<Select
										aria-label="API connection"
										value={connection.id}
										disabled={busy || catalogEditing}
										onChange={selectConnection}
										options={values.connections.map((c) => ({ value: c.id, label: c.name }))}
									/>
								</SettingsRow>
								<SettingsRow
									label="Discover available models"
									description={connection.providerAdapter ? "Provider adapters use manual model IDs. Add models in the catalog below." : "Load the model catalog from this API connection."}
								>
									{!remote && (
										<button
											className="secondary-button"
											onClick={() => void discover()}
											disabled={busy || catalogEditing || !!connection.providerAdapter}
										>
											{busy ? <LoaderCircle size={15} className="spin" /> : <Server size={15} />}
											{busy ? 'Discovering…' : 'Discover models'}
										</button>
									)}
									{busy && (
										<button className="secondary-button" onClick={() => discovery.current?.abort()}>
											Cancel discovery
										</button>
									)}
								</SettingsRow>
							</SettingsGroup>
							{remote && (
								<p className="remote-settings-note">
									These model configurations belong to {workspaceName}. Edit them in Settings on
									that computer.
								</p>
							)}
							{notice && (
								<div className="success-note" role="status">
									<Check size={16} />
									{notice}
								</div>
							)}
							<ModelCatalogEditor
								key={connection.id}
								catalog={connection.catalog ?? []}
								discoveredModels={connection.discoveredModels}
								modelIds={Object.values(connection.models)}
								models={connection.models}
								chatApi={connection.chatApi}
								onDefaultsChange={(models) => updateConnection({ models })}
								thinkingPresets={values.thinkingPresets}
								readOnly={remote}
								onChange={(catalog) => updateConnection({ catalog })}
								onEditingChange={setCatalogEditing}
							/>
							<ThinkingPresetsEditor
								presets={values.thinkingPresets}
								onChange={(thinkingPresets) => update({ thinkingPresets })}
								onEditingChange={setPresetsEditing}
							/>
						</div>
						<div hidden={section !== 'personalization'} className="settings-section-content">
							<PersonalizationSettings
								value={values.personalization ?? defaultPersonalization()}
								supported={personalizationSupported}
								initialKind={activeKind}
								onChange={(personalization) => update({ personalization })}
							/>
						</div>
						<div hidden={section !== 'system'} className="settings-section-content">
							<SettingsGroup title="Workspace instructions">
								<SettingsRow
									label="Additional workspace instructions"
									className="settings-prompt-label"
									description="Included in both Chat and Code alongside each mode’s personalization and any project instructions. Leave empty to add no extra workspace instructions."
									layout="stacked"
								>
									<textarea
										aria-label="System prompt"
										rows={5}
										maxLength={100_000}
										placeholder="How would you like your models to respond?"
										value={values.systemPrompt}
										onChange={(e) => update({ systemPrompt: e.target.value })}
									/>
								</SettingsRow>
							</SettingsGroup>
							<SystemPromptView
								state={previewState}
								visible={section === 'system'}
								draft={dirty}
								activeKind={activeKind}
								activeThreadId={activeThreadId}
								activeProjectId={activeProjectId}
								onBuild={onBuildSystemPrompt}
								lastSentSystemPrompt={lastSentSystemPrompt}
							/>
							<SettingsGroup
								title="Workspace data"
								footer={
									remote
										? 'Saved on the host computer'
										: `Saved locally · ${storageLocation || 'This device'}`
								}
							>
								<SettingsRow
									label="Take a copy of your workspace"
									description="Chats, Code tasks, projects, and generated media. API keys are excluded."
								>
									<button
										className="secondary-button"
										onClick={() =>
											downloadText(
												'freelm-workspace.json',
												JSON.stringify(
													{
														...persistentWorkspace(state),
														connections: state.connections.map((c) => ({ ...c, apiKey: '' })),
													},
													null,
													2,
												),
												'application/json',
											)
										}
									>
										Export workspace
									</button>
								</SettingsRow>
							</SettingsGroup>
						</div>
						<div hidden={section !== 'memories'} className="settings-section-content">
							<MemorySettings
								memorySupported={memorySupported}
								value={values.memorySettings}
								memories={state.savedMemories ?? []}
								projects={state.projects}
								threads={state.threads}
								onChange={(memorySettings) => update({ memorySettings })}
								onMemoryChange={onMemoryChange}
								onClearMemorySummaries={onClearMemorySummaries}
								onEditingChange={setMemoryEditing}
								onBusyChange={setInstanceBusy}
							/>
						</div>
						<div hidden={section !== 'chat'} className="settings-section-content">
							<DictationSettings
								settings={values.dictation}
								connections={values.connections}
								onChange={(dictation) => update({ dictation })}
							/>
							<SettingsGroup title="Notifications">
								<SettingsRow
									label="Background notifications"
									description="Notify when Chat, Code, Bots or workflows finish while FreeLM is in the background."
								>
									<Switch
										checked={values.backgroundNotifications}
										onChange={(backgroundNotifications) => update({ backgroundNotifications })}
										aria-label="Background notifications"
									/>
								</SettingsRow>
								<BotSoundSettings
									value={values.botResponseSound}
									onChange={(botResponseSound) => update({ botResponseSound })}
									disabled={!values.backgroundNotifications}
								/>
							</SettingsGroup>
						</div>
						<div hidden={section !== 'moderation'} className="settings-section-content">
							<ModerationSettings
								settings={moderationSettings(values.moderation)}
								connections={values.connections}
								supported={moderationSupported}
								onChange={(moderation) => update({ moderation })}
							/>
						</div>
						<div hidden={section !== 'code'} className="settings-section-content">
							<CodeSettings
								value={values.codeCompaction ?? defaultCodeCompactionSettings()}
								supported={codeCompactionSupported}
								model={connection.catalog?.find((model) => model.id === connection.models.chat)}
								onChange={(codeCompaction) => update({ codeCompaction })}
							/>
						</div>
						<div hidden={section !== 'archived'} className="settings-section-content">
							<SettingsGroup title="Archived conversations">
								{state.threads.filter((thread) => thread.archivedAt && !thread.temporary).length ===
								0 ? (
									<SettingsRow description="No archived conversations." />
								) : (
									state.threads
										.filter((thread) => thread.archivedAt && !thread.temporary)
										.sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))
										.map((thread) => (
											<SettingsRow
												key={thread.id}
												label={thread.title}
												description={
													<>
														{new Date(thread.archivedAt!).toLocaleDateString()} ·{' '}
														{thread.kind === 'code' ? 'Code' : 'Chat'}
													</>
												}
											>
												<button
													className="secondary-button"
													onClick={() => onRestoreThread?.(thread.id)}
												>
													Restore
												</button>
											</SettingsRow>
										))
								)}
							</SettingsGroup>
						</div>
						<div hidden={section !== 'appearance'} className="settings-section-content">
							<SettingsGroup
								title="Theme"
								footer="System follows your operating system’s appearance."
							>
								<SettingsRow layout="stacked">
									<div className="settings-theme-options" role="radiogroup" aria-label="Appearance">
										{(
											[
												{ id: 'light', name: 'Light', icon: Sun },
												{ id: 'dark', name: 'Dark', icon: Moon },
												{ id: 'system', name: 'System', icon: Monitor },
											] as const
										).map(({ id, name, icon: Icon }) => (
											<button
												key={id}
												role="radio"
												aria-checked={values.theme === id}
												onClick={() => update({ theme: id })}
											>
												<span className={`theme-preview theme-preview-${id}`} aria-hidden="true">
													{id === 'system' ? (
														(['light', 'dark'] as const).map((half) => (
															<span className={`theme-system-half theme-system-${half}`} key={half}>
																<i />
																<span>
																	<b />
																	<b />
																	<b />
																</span>
															</span>
														))
													) : (
														<>
															<i />
															<span>
																<b />
																<b />
																<b />
															</span>
														</>
													)}
												</span>
												<span className="theme-option-name">
													<Icon size={16} />
													{name}
													{values.theme === id && <Check size={15} />}
												</span>
											</button>
										))}
									</div>
								</SettingsRow>
							</SettingsGroup>
							<AppearanceAccentSettings
								appearance={values.appearance}
								theme={values.theme}
								disabled={working}
								onChange={(appearance) => update({ appearance })}
							/>
							<SettingsGroup title="Conversation details">
								<SettingsRow
									label="Debug mode"
									description="Show raw tool arguments and results in conversation history."
								>
									<Switch
										aria-label="Debug mode"
										checked={values.debugMode}
										onChange={(debugMode) => update({ debugMode })}
									/>
								</SettingsRow>
							</SettingsGroup>
						</div>
						<div hidden={section !== 'iphone'} className="settings-section-content">
                            {section === 'iphone' && (remote ? <p>Open Settings on the owning Mac to pair an iPhone.</p> : <MobilePairingSettings />)}
                        </div>
                        <div hidden={section !== 'connections'} className="settings-section-content">
							<SettingsGroup
								title="Your API connections"
 footer={onWelcome ? <button className="secondary-button" onClick={onWelcome}>Welcome & setup</button> : undefined}
								actions={
									!remote && (
										<button
											className="secondary-button compact"
											onClick={() => {
												if (catalogEditing) {
													setError(
														'Apply or cancel your model changes before adding a connection.',
													);
													return;
												}
												const next = newConnection();
												next.name = 'New connection';
												update({
													connections: [...values.connections, next],
													activeConnectionId: next.id,
												});
												setNotice('');
											}}
										>
											<Plus size={15} />
											Add connection
										</button>
									)
								}
							>
								{remote && (
									<p className="remote-settings-note">
										API connections are managed on {workspaceName}. Credentials stay on that
										computer.
									</p>
								)}
								<div className="settings-api-list" aria-label="API connections">
									{values.connections.map((c) => (
										<button
											key={c.id}
											aria-pressed={c.id === connection.id}
											onClick={() => selectConnection(c.id)}
										>
											<Server size={18} />
											<span>
												<strong>{c.name}</strong>
												<small>{c.baseUrl}</small>
											</span>
											<ChevronRight size={16} />
										</button>
									))}
								</div>
							</SettingsGroup>
							<SettingsGroup title="Connection details">
<ConnectionFields connection={connection} updateConnection={updateConnection} remote={remote} secureStorage={secureStorage} secureStorageChecked={secureStorageChecked} />
								<SettingsRow
									label="Models for this connection"
									description="Discover available models or add an API model ID, then configure a mode before using it in Chat, Code or Bots."
								>
									<button
										className="secondary-button"
										disabled={working}
										onClick={() => navigate('configuration')}
									>
										Configure models
									</button>
								</SettingsRow>
								{!remote && values.connections.length > 1 && (
									<SettingsRow>
										<button
											className="settings-remove-connection"
											onClick={() => {
												if (catalogEditing) {
													setError(
														'Apply or cancel your model changes before removing a connection.',
													);
													return;
												}
												const connections = values.connections.filter(
													(c) => c.id !== connection.id,
												);
												update({ connections, activeConnectionId: connections[0].id });
												setNotice('');
											}}
										>
											<Trash2 size={15} />
											Remove connection
										</button>
									</SettingsRow>
								)}
							</SettingsGroup>
						</div>
						{section === 'search' && (
							<div className="settings-section-content">
								<SearchSettings
									value={values.toolSettings.webBrowsing}
									savedValue={state.toolSettings?.webBrowsing}
									readOnly={remote}
									workspaceName={workspaceName}
									onChange={(webBrowsing) =>
										update({ toolSettings: { ...values.toolSettings, webBrowsing } })
									}
									onBusyChange={setInstanceBusy}
								/>
							</div>
						)}
						{(section === 'tools' || section === 'mcp' || section === 'skills') && (
							<div className="settings-section-content">
								<ToolSettings
									key={section}
									page={section}
									value={values.toolSettings}
									connections={values.connections}
									activeConnectionId={values.activeConnectionId}
									readOnly={remote}
									workspaceName={workspaceName}
									onChange={(toolSettings) => update({ toolSettings })}
									onBusyChange={setInstanceBusy}
									onSearchSettings={() => navigate('search')}
									onModelSettings={(id) => {
										selectConnection(id);
										navigate('configuration');
									}}
								/>
							</div>
						)}
						{section === 'schedules' && (
							<div className="settings-section-content">
								<SchedulerSettings remote={remote} threads={state.threads} />
							</div>
						)}
						{section === 'plugins' && (
							<div className="settings-section-content">
								{onOpenPlugins ? (
									<SettingsGroup title="Plugin library">
										<SettingsRow
											label="Plugins"
											description="Browse examples, install plugins, and manage their accounts and permissions."
										>
											<button className="secondary-button" onClick={onOpenPlugins}>
												Open Plugins
											</button>
										</SettingsRow>
									</SettingsGroup>
								) : (
									<PluginSettings
										readOnly={remote}
										workspaceName={workspaceName}
										connections={state.connections}
										workspaceId={activeWorkspaceId ?? 'local'}
									/>
								)}
							</div>
						)}
						{section === 'remote' && (
							<div className="settings-section-content">
								{pending && (
									<p className="settings-help">
										Save or discard your settings changes before opening another workspace.
									</p>
								)}
								<fieldset className="settings-integration" disabled={pending}>
									<Instances
										embedded
										activeWorkspaceId={activeWorkspaceId}
										onSelect={onSelectWorkspace}
										onClose={onClose}
										onBusyChange={setInstanceBusy}
									/>
								</fieldset>
							</div>
						)}
					</div>
				</div>
				<footer className="settings-page-footer">
					{error && (
						<div className="error-note" role="alert">
							{userFacingError(error)}
						</div>
					)}
					{leaving ? (
						<div className="settings-leave-prompt" role="alert">
							<span>You have unsaved settings changes.</span>
							<div>
								<button
									className="secondary-button"
									disabled={working}
									onClick={() => {
										onExitCancel?.();
										setLeaving(false);
									}}
								>
									Keep editing
								</button>
								<button className="secondary-button" disabled={working} onClick={onClose}>
									Discard changes
								</button>
								<button
									className="primary-button"
									disabled={working || invalidAccent}
									onClick={() => save(true)}
								>
									Save and go back
								</button>
							</div>
						</div>
					) : (
						<div className="settings-save-row">
							<span role="status">
								{pending
									? 'Unsaved changes'
									: section === 'schedules'
										? remote
											? 'Manage schedules on their owning computer.'
											: 'Schedule changes are saved immediately on this computer.'
										: section === 'plugins'
											? remote
												? 'Manage plugins on their owning computer.'
												: 'Plugin changes are saved immediately on this computer.'
											: saved
												? 'Settings saved'
												: 'Changes are saved to this workspace.'}
							</span>
							{(!['plugins', 'schedules'].includes(section) || pending) && (
								<button
									className="primary-button"
									onClick={() => save()}
									disabled={working || invalidAccent}
								>
									Save settings
								</button>
							)}
						</div>
					)}
				</footer>
			</div>
		</section>
	);
}
