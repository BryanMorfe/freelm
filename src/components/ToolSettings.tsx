import { userFacingError } from '../lib/user-facing-error';
import { useId, useState } from 'react';
import { BookOpen, FolderOpen, LoaderCircle, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { ComputerUseSettings } from './ComputerUse';
import type {
	MCPServerConfig,
	ToolCatalog,
	ToolSettings as ToolSettingsValue,
} from '../agent-types';
import type { Connection } from '../types';
import { defaultModel } from '../lib/catalog';
import { imageToolGuidance } from '../lib/image-tool';
import { DEFAULT_VIDEO_SIZE, normalizeVideoResolution } from '../lib/video-resolution';
import { resolveVideoToolSeconds, resolveVideoToolSize } from '../lib/video-tool';
import { searxngSearchUrl } from '../lib/web-tools';
import { normalizedSearchSettings } from '../lib/search-settings';
import { defaultToolSettings, normalizeCodePermissionMode } from '../lib/tool-settings';
import ChatModelPicker from './ChatModelPicker';
import Select from './Select';
import Switch from './Switch';
import PythonSettings from './PythonSettings';
import { SettingsGroup, SettingsRow } from './SettingsList';
import './tool-settings.css';

export type ToolSettingsPage = 'tools' | 'mcp' | 'skills';
interface Props {
	page: ToolSettingsPage;
	value: ToolSettingsValue;
	connections: Connection[];
	activeConnectionId: string;
	readOnly: boolean;
	workspaceName: string;
	onChange: (value: ToolSettingsValue) => void;
	onBusyChange: (busy: boolean) => void;
	onModelSettings: (connectionId: string) => void;
	onSearchSettings: () => void;
}

function isAbsolutePath(candidate: string): boolean {
	return (
		candidate.startsWith('/') ||
		/^[a-zA-Z]:[\\/]/.test(candidate) ||
		candidate.startsWith('\\\\')
	);
}

/** Catch configuration errors before leaving the settings page. Host validation is authoritative. */
export function assertToolSettingsValues(value: ToolSettingsValue, connections: Connection[]) {
	if (value.workspaceRoot.trim() && !isAbsolutePath(value.workspaceRoot))
		throw new Error('Use an absolute working directory path in Tools.');
	if (!['ask', 'auto-review', 'full-access', 'trusted'].includes(value.approvalMode))
		throw new Error('Choose a Code permission mode in Tools.');
	if (value.imageGeneration.enabled) {
		if (!connections.some((connection) => connection.id === value.imageGeneration.connectionId))
			throw new Error('Choose an API connection for image generation in Tools.');
		if (!value.imageGeneration.model.trim())
			throw new Error('Choose an image generation model in Tools.');
	}
	if (value.videoGeneration?.enabled) {
		if (!connections.some((connection) => connection.id === value.videoGeneration?.connectionId))
			throw new Error('Choose an API connection for video generation in Tools.');
		if (!value.videoGeneration.model.trim())
			throw new Error('Choose a video generation model in Tools.');
		resolveVideoToolSize(undefined, value.videoGeneration.size);
		resolveVideoToolSeconds(undefined, value.videoGeneration.seconds);
	}
	if (value.webBrowsing?.enabled) {
		const search = normalizedSearchSettings(value.webBrowsing);
		if (search.mode === 'external') searxngSearchUrl(search.searxngUrl);
		else if (!search.engines.length)
			throw new Error('Choose at least one search engine in Search.');
	}
	for (const server of value.mcpServers) {
		if (!server.name.trim()) throw new Error('Give each MCP server a name.');
		if (!server.enabled) continue;
		if (server.transport === 'stdio' && !server.command?.trim())
			throw new Error(`Enter a command for the MCP server “${server.name}”.`);
		if (server.transport === 'http') {
			let url: URL;
			try {
				url = new URL(server.url || '');
			} catch {
				throw new Error(`Enter an HTTP or HTTPS URL for the MCP server “${server.name}”.`);
			}
			if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
				throw new Error(
					`Use an HTTP or HTTPS URL without embedded credentials or a fragment for “${server.name}”.`,
				);
			if (server.bearerTokenEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(server.bearerTokenEnv))
				throw new Error(
					`Use an environment variable name for the bearer token of “${server.name}”.`,
				);
		}
	}
	for (const directory of value.skillDirectories) {
		if (!isAbsolutePath(directory))
			throw new Error('Use an absolute path for each skill directory, or remove the empty entry.');
	}
}

export default function ToolSettings({
	page,
	value,
	connections,
	activeConnectionId,
	readOnly,
	workspaceName,
	onChange,
	onBusyChange,
	onModelSettings,
	onSearchSettings,
}: Props) {
	const [busy, setBusy] = useState(false);
	const [catalog, setCatalog] = useState<ToolCatalog | null>(null);
	const [error, setError] = useState('');
	const listId = useId();
	const desktop = window.desktop;
	const canInspect = Boolean(desktop?.toolInspect) && !readOnly;
	const image = value.imageGeneration;
	const imageConnection = connections.find((connection) => connection.id === image.connectionId);
	const fallbackConnection =
		connections.find((connection) => connection.id === activeConnectionId) || connections[0];
	const imageDefaultConnection = imageConnection ?? fallbackConnection;
	const video = value.videoGeneration ?? defaultToolSettings().videoGeneration!;
	const videoConnection = connections.find((connection) => connection.id === video.connectionId);
	const videoDefaultConnection = videoConnection ?? fallbackConnection;

	function change(patch: Partial<ToolSettingsValue>) {
		if (readOnly) return;
		onChange({ ...value, ...patch });
		setError('');
		setCatalog(null);
	}
	function updateServer(id: string, patch: Partial<MCPServerConfig>) {
		change({
			mcpServers: value.mcpServers.map((server) =>
				server.id === id ? { ...server, ...patch } : server,
			),
		});
	}
	function setWorking(next: boolean) {
		setBusy(next);
		onBusyChange(next);
	}
	async function browse(index?: number) {
		if (!desktop?.toolPickDirectory || readOnly) return;
		setWorking(true);
		setError('');
		try {
			const directory = await desktop.toolPickDirectory();
			if (directory !== null) {
				if (index === undefined) change({ workspaceRoot: directory });
				else
					change({
						skillDirectories: value.skillDirectories.map((path, i) =>
							i === index ? directory : path,
						),
					});
			}
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setWorking(false);
		}
	}
	async function inspect() {
		if (!desktop?.toolInspect || readOnly) return;
		setWorking(true);
		setError('');
		try {
			// Discovering skills must not start unrelated MCP processes.
			const settings = page === 'skills' ? { ...value, mcpServers: [] } : value;
			setCatalog(await desktop.toolInspect(settings));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setWorking(false);
		}
	}
	const matchingTools =
		catalog?.tools.filter((tool) => page !== 'mcp' || tool.source === 'mcp') ?? [];

	return (
		<div className="tool-settings">
			{readOnly ? (
				<p className="remote-settings-note">
					These tools belong to {workspaceName}. Configure them in Settings on that computer.
				</p>
			) : !desktop?.toolInspect ? (
				<p className="settings-help tool-settings-notice">
					Tool execution, discovery, and directory browsing are available in the desktop app. You
					can save your configuration here.
				</p>
			) : null}
			<fieldset className="tool-settings-fields" disabled={readOnly || busy}>
				<div className="tool-settings-fields-list">
					{page === 'tools' && (
						<>
							<SettingsGroup title="Code tools">
								<SettingsRow
									label="Enable tools in Code"
									description="Enabled by default for new profiles. Turn off to use Code without work tools. Chat Python, image and video generation, and web browsing have their own switches."
								>
									<Switch
										aria-label="Enable tools in Code"
										checked={value.enabled}
										onChange={(enabled) => change({ enabled })}
									/>
								</SettingsRow>
								<SettingsRow
									label="Allow connected FreeLM clients to use these tools"
									description="Controls work tools in remote Code tasks. Chat Python, image and video generation, and web browsing use their own switches."
								>
									<Switch
										aria-label="Allow connected FreeLM clients to use these tools"
										checked={value.allowRemote ?? false}
										onChange={(allowRemote) => change({ allowRemote })}
									/>
								</SettingsRow>
							</SettingsGroup>
							<SettingsGroup
								title="Code execution"
								footer="Approval gates whether an action runs. Commands use your account’s full access to files and the network, with no operating-system sandbox. Project folders are the focus of the task. Full access skips approval prompts."
							>
								<SettingsRow
									label="Run commands"
									description="Run shell commands and interact with processes on this computer."
								>
									<Switch
										aria-label="Run commands"
										checked={value.commandExecution}
										onChange={(commandExecution) => change({ commandExecution })}
									/>
								</SettingsRow>
								<SettingsRow
									label="Default working directory"
									layout="stacked"
									description="Used by Code tasks outside a project. Leave blank to start in the host’s home directory. Projects use their chosen folders, or a folder FreeLM creates in ~/Documents/FreeLM."
								>
									<div className="tool-settings-path">
										<input
											aria-label="Default working directory"
											value={value.workspaceRoot}
											placeholder="/absolute/path/to/your/workspace"
											onChange={(event) => change({ workspaceRoot: event.target.value })}
										/>
										<button
											className="secondary-button"
											type="button"
											disabled={!desktop?.toolPickDirectory}
											onClick={() => void browse()}
										>
											<FolderOpen size={15} />
											Browse
										</button>
									</div>
								</SettingsRow>
								<SettingsRow
									label="Default Code permissions"
									description="New Code tasks start with this mode. Change a task’s permissions in its composer. Approve for me uses a separate reviewer on the task’s selected API and model; failed or unclear reviews do not allow the action."
								>
									<Select
										aria-label="Tool approval"
										value={normalizeCodePermissionMode(value.approvalMode)}
										onChange={(approvalMode) =>
											change({ approvalMode: approvalMode as ToolSettingsValue['approvalMode'] })
										}
										options={[
											{ value: 'ask', label: 'Ask for approval' },
											{ value: 'auto-review', label: 'Approve for me' },
											{ value: 'full-access', label: 'Full access' },
										]}
									/>
								</SettingsRow>
							</SettingsGroup>
							<ComputerUseSettings
								enabled={value.computerUse?.enabled === true}
								onChange={(enabled) => change({ computerUse: { enabled } })}
							/>
							<SettingsGroup title="Web browsing">
								<SettingsRow
									label="Search and browsing"
									description="Manage web browsing and search engines in Search settings."
								>
									<button type="button" className="secondary-button" onClick={onSearchSettings}>
										Open Search settings
									</button>
								</SettingsRow>
							</SettingsGroup>
							<PythonSettings value={value} onChange={onChange} readOnly={readOnly} />
							<SettingsGroup
								title="Image generation"
								footer="Default image size is a fallback. The model can choose a size for each request. Edit per-model image presets in Configuration → Models."
							>
								<SettingsRow
									label="Generate images in Chat and Code"
									description="Chat uses your image API and uploaded images. Code can also reference project files."
								>
									<Switch
										aria-label="Generate images in Chat and Code"
										checked={image.enabled}
										onChange={(enabled) =>
											change({
												imageGeneration: {
													...image,
													enabled,
													connectionId: imageDefaultConnection?.id || '',
													model:
														image.model ||
														(imageDefaultConnection
															? defaultModel(imageDefaultConnection, 'images')
															: ''),
												},
											})
										}
									/>
								</SettingsRow>
								<SettingsRow label="Image API connection">
									<Select
										aria-label="Image API connection"
										value={image.connectionId}
										onChange={(connectionId) => {
											const connection = connections.find(
												(candidate) => candidate.id === connectionId,
											);
											change({
												imageGeneration: {
													...image,
													connectionId,
													model: connection ? defaultModel(connection, 'images') : '',
												},
											});
										}}
										options={[
											{ value: '', label: 'Choose a connection' },
											...connections.map((connection) => ({
												value: connection.id,
												label: connection.name,
											})),
										]}
									/>
								</SettingsRow>
								{imageConnection && (
									<SettingsRow
										label="Image model"
										description="Search your catalog or enter a custom model ID."
										className="tool-settings-model"
									>
										<ChatModelPicker
											task="images"
											connection={imageConnection}
											model={image.model}
											thinkingMode=""
											onThinkingMode={() => {}}
											disabled={readOnly || busy}
											onSelect={(model) => change({ imageGeneration: { ...image, model } })}
											onSettings={() => onModelSettings(imageConnection.id)}
										/>
									</SettingsRow>
								)}
								<SettingsRow label="Default image size">
									<input
										aria-label="Default image size"
										value={image.size}
										placeholder="Provider default"
										onChange={(event) =>
											change({ imageGeneration: { ...image, size: event.target.value } })
										}
									/>
								</SettingsRow>
								<SettingsRow label="Default image quality">
									<input
										aria-label="Default image quality"
										value={image.quality}
										placeholder="Provider default"
										onChange={(event) =>
											change({ imageGeneration: { ...image, quality: event.target.value } })
										}
									/>
								</SettingsRow>
								{imageConnection && image.model.trim() && (
									<SettingsRow layout="stacked">
										<details className="settings-help">
											<summary>Image size guidance</summary>
											<p>Shared with the model when it uses the image tool:</p>
											<div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
												{imageToolGuidance(imageConnection, image)}
											</div>
										</details>
									</SettingsRow>
								)}
							</SettingsGroup>
							<SettingsGroup
								title="Video generation"
								footer={`The model can choose a size and duration for each request. A blank size uses the playground default, ${DEFAULT_VIDEO_SIZE}; a blank duration uses your video provider’s default.`}
							>
								<SettingsRow
									label="Generate videos in Chat and Code"
									description="Create videos using your selected video model. Chat can use uploaded images; Code can also reference project files."
								>
									<Switch
										aria-label="Generate videos in Chat and Code"
										checked={video.enabled}
										onChange={(enabled) =>
											change({
												videoGeneration: {
													...video,
													enabled,
													connectionId: videoDefaultConnection?.id || '',
													model:
														video.model ||
														(videoDefaultConnection
															? defaultModel(videoDefaultConnection, 'videos')
															: ''),
												},
											})
										}
									/>
								</SettingsRow>
								<SettingsRow label="Video API connection">
									<Select
										aria-label="Video API connection"
										value={video.connectionId}
										onChange={(connectionId) => {
											const connection = connections.find(
												(candidate) => candidate.id === connectionId,
											);
											change({
												videoGeneration: {
													...video,
													connectionId,
													model: connection ? defaultModel(connection, 'videos') : '',
												},
											});
										}}
										options={[
											{ value: '', label: 'Choose a connection' },
											...connections.map((connection) => ({
												value: connection.id,
												label: connection.name,
											})),
										]}
									/>
								</SettingsRow>
								{videoConnection && (
									<SettingsRow
										label="Video model"
										description="Search your catalog or enter a custom model ID."
										className="tool-settings-model"
									>
										<ChatModelPicker
											task="videos"
											connection={videoConnection}
											model={video.model}
											thinkingMode=""
											onThinkingMode={() => {}}
											disabled={readOnly || busy}
											onSelect={(model) => change({ videoGeneration: { ...video, model } })}
											onSettings={() => onModelSettings(videoConnection.id)}
										/>
									</SettingsRow>
								)}
								<SettingsRow
									label="Default video size"
									description="Width × height in pixels. Dimensions snap to the nearest multiple of 32."
								>
									<input
										aria-label="Default video size"
										onBlur={(event) =>
											change({
												videoGeneration: {
													...video,
													size: normalizeVideoResolution(event.currentTarget.value),
												},
											})
										}
										value={video.size}
										placeholder={DEFAULT_VIDEO_SIZE}
										onChange={(event) =>
											change({ videoGeneration: { ...video, size: event.target.value } })
										}
									/>
								</SettingsRow>
								<SettingsRow label="Default video duration (seconds)">
									<input
										aria-label="Default video duration (seconds)"
										inputMode="numeric"
										value={video.seconds}
										placeholder="Provider default"
										onChange={(event) =>
											change({ videoGeneration: { ...video, seconds: event.target.value } })
										}
									/>
								</SettingsRow>
							</SettingsGroup>
						</>
					)}
					{page === 'mcp' && (
						<>
							<SettingsGroup
								title="Your MCP servers"
								description="Connect local command-line servers or remote Streamable HTTP servers. Discovery starts enabled local servers and connects to enabled remote servers using the configuration below."
								actions={
									<button
										className="secondary-button compact"
										type="button"
										onClick={() =>
											change({
												mcpServers: [
													...value.mcpServers,
													{
														id: crypto.randomUUID(),
														name: 'New MCP server',
														enabled: false,
														transport: 'stdio',
														command: '',
														args: [],
													},
												],
											})
										}
									>
										<Plus size={15} />
										Add MCP server
									</button>
								}
							>
								<SettingsRow
									label="Tool discovery"
									description={
										value.mcpServers.length === 0
											? 'No MCP servers added yet.'
											: `${value.mcpServers.length} ${value.mcpServers.length === 1 ? 'server' : 'servers'} configured.`
									}
								>
									<button
										type="button"
										className="secondary-button tool-settings-discover"
										disabled={!canInspect || busy}
										onClick={() => void inspect()}
									>
										{busy ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}
										{busy ? 'Discovering…' : 'Discover MCP tools'}
									</button>
								</SettingsRow>
							</SettingsGroup>
							{value.mcpServers.map((server, index) => (
								<section
									key={server.id}
									className="tool-settings-server"
									aria-label={`MCP server ${index + 1}`}
								>
									<SettingsGroup
										title={server.name || `MCP server ${index + 1}`}
										actions={
											<button
												className="tool-settings-remove"
												type="button"
												aria-label={`Remove MCP server ${server.name}`}
												onClick={() =>
													change({
														mcpServers: value.mcpServers.filter(
															(candidate) => candidate.id !== server.id,
														),
													})
												}
											>
												<Trash2 size={15} />
												Remove
											</button>
										}
									>
										<SettingsRow label="Enabled">
											<Switch
												aria-label={`Enable MCP server ${server.name || index + 1}`}
												checked={server.enabled}
												onChange={(enabled) => updateServer(server.id, { enabled })}
											/>
										</SettingsRow>
										<SettingsRow label="Server name">
											<input
												aria-label="Server name"
												value={server.name}
												onChange={(event) => updateServer(server.id, { name: event.target.value })}
											/>
										</SettingsRow>
										<SettingsRow label="Transport">
											<Select
												aria-label="Transport"
												value={server.transport}
												onChange={(transport) =>
													updateServer(server.id, {
														transport: transport as MCPServerConfig['transport'],
													})
												}
												options={[
													{ value: 'stdio', label: 'Local command (stdio)' },
													{ value: 'http', label: 'Remote HTTP' },
												]}
											/>
										</SettingsRow>
										{server.transport === 'stdio' ? (
											<>
												<SettingsRow label="Command" layout="stacked">
													<input
														aria-label="Command"
														value={server.command || ''}
														placeholder="/absolute/path/to/mcp-server"
														onChange={(event) =>
															updateServer(server.id, { command: event.target.value })
														}
													/>
												</SettingsRow>
												<SettingsRow
													label="Arguments"
													layout="stacked"
													description="One argument per line. The command is launched directly, without a shell."
												>
													<textarea
														aria-label="Arguments"
														rows={3}
														value={(server.args || []).join('\n')}
														placeholder={'--directory\n/path/to/project'}
														onChange={(event) =>
															updateServer(server.id, { args: event.target.value.split('\n') })
														}
														onBlur={() =>
															updateServer(server.id, {
																args: server.args?.filter((argument) => argument !== ''),
															})
														}
													/>
												</SettingsRow>
												<SettingsRow description="The server uses the host’s environment. Keep credentials in environment variables rather than command arguments." />
											</>
										) : (
											<>
												<SettingsRow label="Server URL" layout="stacked">
													<input
														aria-label="Server URL"
														type="url"
														value={server.url || ''}
														placeholder="https://example.com/mcp"
														onChange={(event) =>
															updateServer(server.id, { url: event.target.value })
														}
													/>
												</SettingsRow>
												<SettingsRow
													label={
														<>
															Bearer token environment variable{' '}
															<span className="optional">optional</span>
														</>
													}
													layout="stacked"
													description="Enter a variable name. FreeLM reads its value from the host environment."
												>
													<input
														aria-label="Bearer token environment variable"
														value={server.bearerTokenEnv || ''}
														autoComplete="off"
														spellCheck={false}
														placeholder="MY_MCP_API_TOKEN"
														onChange={(event) =>
															updateServer(server.id, { bearerTokenEnv: event.target.value })
														}
													/>
												</SettingsRow>
											</>
										)}
									</SettingsGroup>
								</section>
							))}
						</>
					)}
					{page === 'skills' && (
						<SettingsGroup
							title="Skill directories"
							description="Add a folder containing SKILL.md, or a directory with skill folders inside. FreeLM discovers names and descriptions, then loads instructions when the model selects a skill."
							actions={
								<button
									className="secondary-button compact"
									type="button"
									onClick={() => change({ skillDirectories: [...value.skillDirectories, ''] })}
								>
									<Plus size={15} />
									Add directory
								</button>
							}
						>
							{value.skillDirectories.length === 0 && (
								<SettingsRow description="No skill directories added yet." />
							)}
							{value.skillDirectories.map((directory, index) => (
								<SettingsRow label={`Skill directory ${index + 1}`} layout="stacked" key={index}>
									<div className="tool-settings-path">
										<input
											aria-label={`Skill directory ${index + 1}`}
											value={directory}
											placeholder="/absolute/path/to/skills"
											onChange={(event) =>
												change({
													skillDirectories: value.skillDirectories.map((path, i) =>
														i === index ? event.target.value : path,
													),
												})
											}
										/>
										<button
											type="button"
											className="secondary-button"
											aria-label={`Browse skill directory ${index + 1}`}
											disabled={!desktop?.toolPickDirectory}
											onClick={() => void browse(index)}
										>
											<FolderOpen size={15} />
											Browse
										</button>
										<button
											type="button"
											className="tool-settings-remove"
											aria-label={`Remove skill directory ${index + 1}`}
											onClick={() =>
												change({
													skillDirectories: value.skillDirectories.filter((_, i) => i !== index),
												})
											}
										>
											<Trash2 size={16} />
										</button>
									</div>
								</SettingsRow>
							))}
							<SettingsRow
								label="Skill discovery"
								description="Read the configured directories to find available skills."
							>
								<button
									type="button"
									className="secondary-button tool-settings-discover"
									disabled={!canInspect || busy}
									onClick={() => void inspect()}
								>
									{busy ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}
									{busy ? 'Discovering…' : 'Discover skills'}
								</button>
							</SettingsRow>
						</SettingsGroup>
					)}
				</div>
			</fieldset>
			{error && (
				<div className="error-note" role="alert">
					{userFacingError(error)}
				</div>
			)}
			{catalog && (
				<section
					className="tool-settings-results"
					aria-label="Discovery results"
					aria-live="polite"
				>
					<SettingsGroup
						title={
							page === 'mcp'
								? `${matchingTools.length} ${matchingTools.length === 1 ? 'tool' : 'tools'} discovered`
								: 'Available skills'
						}
						footer={
							<span id={listId}>
								Discovery uses your current edits. Save settings to use this configuration in chat.
							</span>
						}
					>
						{catalog.warnings.map((warning, index) => (
							<SettingsRow
								key={`warning-${index}`}
								description={<span className="tool-settings-warning">{warning}</span>}
							/>
						))}
						{page === 'mcp' ? (
							matchingTools.map((tool) => (
								<SettingsRow
									key={tool.name}
									label={tool.displayName || tool.name}
									description={tool.description}
									layout="stacked"
								>
									<code>{tool.name}</code>
									<details>
										<summary>Parameters</summary>
										<pre>{JSON.stringify(tool.parameters, null, 2)}</pre>
									</details>
								</SettingsRow>
							))
						) : catalog.skills?.length ? (
							catalog.skills.map((skill) => (
								<SettingsRow
									key={skill.path}
									label={
										<>
											<BookOpen size={15} />
											{skill.name}
										</>
									}
									description={skill.description}
									layout="stacked"
								>
									<code>{skill.path}</code>
								</SettingsRow>
							))
						) : (
							<SettingsRow description="No skills discovered in the configured directories." />
						)}
					</SettingsGroup>
				</section>
			)}
		</div>
	);
}
