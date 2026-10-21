import { userFacingError } from '../lib/user-facing-error';
import { useEffect, useRef, useState } from 'react';
import { ExternalLink, LoaderCircle, Plus, RefreshCw, Trash2, Upload } from 'lucide-react';
import type { BotProfile } from '../bot-types';
import type { Connection } from '../types';
import type {
	PluginAccess,
	PluginAccount,
	PluginBridge,
	PluginCommand,
	PluginManifest,
	PluginPackagePreview,
	PluginSnapshot,
} from '../plugin-types';
import { SettingsGroup, SettingsRow } from './SettingsList';
import Switch from './Switch';
import {
	PLUGIN_LIMITS,
	PLUGIN_CAPABILITY_LABELS,
	validatePluginManifest,
} from '../lib/plugin-manifest';
import PluginNativeSettings from './PluginNativeSettings';
import './plugin-settings.css';

type BotChoice = Pick<BotProfile, 'id' | 'name' | 'address'>;
interface Props {
	readOnly?: boolean;
	workspaceName?: string;
	/** Isolated previews can supply a bridge without changing the desktop global. */
	bridge?: PluginBridge;
	bots?: BotChoice[];
	connections?: Connection[];
	workspaceId?: string;
}

function ManifestReview({ manifest }: { manifest: PluginManifest }) {
	return (
		<dl className="plugin-manifest-review">
			<dt>Name</dt>
			<dd>{manifest.name}</dd>
			<dt>Author</dt>
			<dd>{manifest.author || 'Not supplied'}</dd>
			<dt>Plugin ID</dt>
			<dd>{manifest.id}</dd>
			<dt>Version</dt>
			<dd>{manifest.version}</dd>
			{manifest.manifestVersion === 1 ? (
				<>
					<dt>MCP service</dt>
					<dd>{manifest.mcp.url}</dd>
				</>
			) : (
				<>
					<dt>Runtime</dt>
					<dd>FreeLM Plugin SDK v{manifest.runtime.apiVersion}</dd>
					<dt>Network access</dt>
					<dd>
						{manifest.permissions.network.length ? manifest.permissions.network.join(', ') : 'None'}
					</dd>
					<dt>Storage</dt>
					<dd>{manifest.permissions.storage ? 'Private storage for each account' : 'None'}</dd>
					<dt>Tools</dt>
					<dd>
						{manifest.contributes.tools.length
							? manifest.contributes.tools
									.map((tool) => `${tool.name} — ${tool.description}`)
									.join(' · ')
							: 'None'}
					</dd>
					<dt>Tabs</dt>
					<dd>
						{manifest.contributes.tabs.length
							? manifest.contributes.tabs.map((tab) => tab.title).join(', ')
							: 'None'}
					</dd>
					<dt>UI actions</dt>
					<dd>
						{manifest.contributes.actions.length ? manifest.contributes.actions.join(', ') : 'None'}
					</dd>
					{manifest.runtime.apiVersion === 2 && (
						<>
							<dt>Surface access</dt>
							<dd>
								{manifest.contributes.activation?.surfaces
									.map((surface) => (surface === 'home.chat' ? 'Chat' : 'Code'))
									.join(', ') || 'None'}
							</dd>
							<dt>Capabilities</dt>
							<dd>
								{manifest.permissions.capabilities?.length ? (
									<ul className="plugin-capability-list">
										{manifest.permissions.capabilities.map((capability) => (
											<li key={capability}>{PLUGIN_CAPABILITY_LABELS[capability]}</li>
										))}
									</ul>
								) : (
									'None'
								)}
							</dd>
						</>
					)}
				</>
			)}
			<dt>Authentication</dt>
			<dd>{manifest.auth.type === 'oauth2' ? 'OAuth 2.0' : 'No sign-in required'}</dd>
			{manifest.auth.type === 'oauth2' && (
				<>
					{manifest.auth.apiOrigin && (
						<>
							<dt>Authenticated API</dt>
							<dd>{manifest.auth.apiOrigin}</dd>
						</>
					)}
					<dt>Client ID</dt>
					<dd>{manifest.auth.clientId}</dd>
					<dt>Sign-in URL</dt>
					<dd>{manifest.auth.authorizationUrl}</dd>
					<dt>Token URL</dt>
					<dd>{manifest.auth.tokenUrl}</dd>
					<dt>Requested scopes</dt>
					<dd>{manifest.auth.scopes.length ? manifest.auth.scopes.join(', ') : 'None'}</dd>
					{manifest.auth.resource && (
						<>
							<dt>Resource</dt>
							<dd>{manifest.auth.resource}</dd>
						</>
					)}
					{manifest.auth.revocationUrl && (
						<>
							<dt>Revocation URL</dt>
							<dd>{manifest.auth.revocationUrl}</dd>
						</>
					)}
				</>
			)}
		</dl>
	);
}

function AccountPermissions({
	account,
	bots,
	busy,
	onAccess,
}: {
	account: PluginAccount;
	bots: BotChoice[];
	busy: boolean;
	onAccess: (access: PluginAccess) => void;
}) {
	function toggleList(key: 'botIds' | 'tools', value: string, checked: boolean) {
		onAccess({
			...account.access,
			[key]: checked
				? [...new Set([...account.access[key], value])]
				: account.access[key].filter((item) => item !== value),
		});
	}
	return (
		<details className="plugin-permissions">
			<summary>
				Access and tools <span>{account.access.tools.length} allowed</span>
			</summary>
			<div className="plugin-permissions-content">
				<p className="plugin-access-notice">
					Enabling a tool authorizes its execution, including writes, without a separate prompt for
					each call. Enable only the tools and assistants you trust. Retrieved content is sent to
					the selected model provider.
				</p>
				<SettingsGroup title="Assistants">
					<SettingsRow label="Chat">
						<Switch
							aria-label={`Allow Chat for ${account.label}`}
							checked={account.access.chat}
							disabled={busy}
							onChange={(chat) => onAccess({ ...account.access, chat })}
						/>
					</SettingsRow>
					<SettingsRow label="Code">
						<Switch
							aria-label={`Allow Code for ${account.label}`}
							checked={account.access.code}
							disabled={busy}
							onChange={(code) => onAccess({ ...account.access, code })}
						/>
					</SettingsRow>
					{bots.map((bot) => (
						<SettingsRow key={bot.id} label={bot.name} description={bot.address}>
							<Switch
								aria-label={`Allow ${bot.name} for ${account.label}`}
								checked={account.access.botIds.includes(bot.id)}
								disabled={busy}
								onChange={(checked) => toggleList('botIds', bot.id, checked)}
							/>
						</SettingsRow>
					))}
					{!bots.length && (
						<SettingsRow description="Create a bot on this computer to grant it account access." />
					)}
					<SettingsRow
						label="Connected FreeLM clients"
						description="Let authorized remote clients use the enabled tools through this host. Credentials remain on this computer."
					>
						<Switch
							aria-label={`Allow remote clients for ${account.label}`}
							checked={account.access.allowRemote}
							disabled={busy}
							onChange={(allowRemote) => onAccess({ ...account.access, allowRemote })}
						/>
					</SettingsRow>
				</SettingsGroup>
				<SettingsGroup
					title="Allowed tools"
					description="Every tool starts off. Read-only labels are plugin-provided hints, not verified guarantees."
				>
					{account.tools.length ? (
						account.tools.map((tool) => (
							<SettingsRow
								key={tool.name}
								label={tool.name}
								description={
									<>
										{tool.description}
										{tool.description ? ' · ' : ''}
										{tool.readOnly ? 'Read-only hint' : 'May change data'}
									</>
								}
							>
								<Switch
									aria-label={`Allow tool ${tool.name} for ${account.label}`}
									checked={account.access.tools.includes(tool.name)}
									disabled={busy}
									onChange={(checked) => toggleList('tools', tool.name, checked)}
								/>
							</SettingsRow>
						))
					) : (
						<SettingsRow description="Discover tools after connecting this account." />
					)}
				</SettingsGroup>
			</div>
		</details>
	);
}

export default function PluginSettings({
	readOnly = false,
	workspaceName = 'Remote workspace',
	bridge: suppliedBridge,
	bots: suppliedBots,
	connections = [],
	workspaceId = 'local',
}: Props) {
	const desktop = window.desktop as (Partial<PluginBridge> & typeof window.desktop) | undefined;
	const bridge =
		suppliedBridge ||
		(desktop?.pluginSnapshot && desktop.pluginCommand && desktop.pluginCancelConnect
			? (desktop as PluginBridge)
			: undefined);
	const [snapshot, setSnapshot] = useState<PluginSnapshot>({ plugins: [], accounts: [] });
	const [bots, setBots] = useState<BotChoice[]>(suppliedBots || []);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [connecting, setConnecting] = useState(false);
	const [error, setError] = useState('');
	const [notice, setNotice] = useState('');
	const [importing, setImporting] = useState(false);
	const [manifestText, setManifestText] = useState('');
	const [review, setReview] = useState<PluginManifest | null>(null);
	const [packagePreview, setPackagePreview] = useState<PluginPackagePreview | null>(null);
	const [packageProgress, setPackageProgress] = useState('');
	const [newAccount, setNewAccount] = useState<string | null>(null);
	const [label, setLabel] = useState('');
	const [removing, setRemoving] = useState<string | null>(null);
	const fileInput = useRef<HTMLInputElement>(null);
	const zipInput = useRef<HTMLInputElement>(null);
	const inFlight = useRef(false);

	useEffect(() => {
		if (readOnly || !bridge) {
			setLoading(false);
			return;
		}
		let current = true;
		setLoading(true);
		bridge
			.pluginSnapshot()
			.then((next) => {
				if (current) setSnapshot(next);
			})
			.catch((failure) => {
				if (current) setError(String(failure instanceof Error ? failure.message : failure));
			})
			.finally(() => {
				if (current) setLoading(false);
			});
		if (!suppliedBots && desktop?.botsSnapshot)
			desktop
				.botsSnapshot('local')
				.then((next) => {
					if (current) setBots(next.bots);
				})
				.catch(() => {
					if (current) setError('Could not load local bots. Reopen Plugins to try again.');
				});
		return () => {
			current = false;
		};
	}, [bridge, readOnly, suppliedBots]);

	async function run(command: PluginCommand, message: string) {
		if (!bridge || readOnly || loading || inFlight.current) return false;
		inFlight.current = true;
		setBusy(true);
		setConnecting(command.type === 'connect');
		setError('');
		setNotice('');
		try {
			setSnapshot(await bridge.pluginCommand(command));
			window.dispatchEvent(new Event('freelm:plugins-changed'));
			setNotice(message);
			return true;
		} catch (failure) {
			try {
				setSnapshot(await bridge.pluginSnapshot());
			} catch {
				/* Keep the last known state. */
			}
			setError(
				failure instanceof Error ? failure.message : 'The plugin request could not complete.',
			);
			return false;
		} finally {
			inFlight.current = false;
			setBusy(false);
			setConnecting(false);
		}
	}
	async function preparePackage(file: File) {
		if (!bridge?.pluginPreparePackage || inFlight.current || readOnly) return;
		if (file.size > 8 * 1024 * 1024) {
			setError('Plugin ZIP packages must be 8 MiB or smaller.');
			return;
		}
		inFlight.current = true;
		setBusy(true);
		setError('');
		setPackageProgress('Inspecting plugin package…');
		try {
			const preview = await bridge.pluginPreparePackage(
				Array.from(new Uint8Array(await file.arrayBuffer())),
			);
			setPackagePreview(preview);
			setReview(preview.manifest);
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : 'Could not inspect this package.');
		} finally {
			inFlight.current = false;
			setBusy(false);
			setPackageProgress('');
		}
	}
	async function installPackage() {
		if (!bridge?.pluginInstallPackage || !packagePreview || inFlight.current || readOnly)
			return false;
		inFlight.current = true;
		setBusy(true);
		setError('');
		setPackageProgress('Compiling and installing plugin…');
		try {
			setSnapshot(await bridge.pluginInstallPackage(packagePreview.reviewId));
			window.dispatchEvent(new Event('freelm:plugins-changed'));
			setNotice(
				packagePreview.manifest.contributes.activation &&
					packagePreview.manifest.auth.type === 'none'
					? 'Plugin installed. Enable it to use its reviewed capabilities in Chat and Code. No account is required.'
					: 'Plugin installed. Enable it and connect an account to use its tabs and tools.',
			);
			return true;
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : 'Could not install this package.');
			return false;
		} finally {
			inFlight.current = false;
			setBusy(false);
			setPackageProgress('');
		}
	}
	async function connect(pluginId: string, accountId?: string, accountLabel = label) {
		if (
			await run(
				{
					type: 'connect',
					pluginId,
					label: accountLabel.trim(),
					...(accountId ? { accountId } : {}),
				},
				'Account connected. Choose which assistants and tools can use it.',
			)
		) {
			setNewAccount(null);
			setLabel('');
		}
	}

	if (readOnly)
		return (
			<SettingsGroup title="Plugins on this computer">
				<SettingsRow
					description={`Plugin accounts belong to their host. Open this computer’s workspace to manage them. To configure ${workspaceName}, open Settings on that host.`}
				/>
			</SettingsGroup>
		);
	if (!bridge)
		return (
			<SettingsGroup title="Desktop app required">
				<SettingsRow description="Install and manage plugins in the FreeLM desktop app. Accounts and credentials are stored on their owning computer." />
			</SettingsGroup>
		);
	return (
		<div className="plugin-settings">
			<div className="plugin-settings-intro">
				<p>
					Add capabilities to FreeLM and choose which surfaces and assistants can use them. Changes
					save immediately on this computer.
				</p>
				<button
					className="secondary-button compact"
					disabled={busy || loading}
					onClick={() => {
						setImporting(true);
						setReview(null);
						setPackagePreview(null);
						setError('');
					}}
				>
					<Plus size={14} /> Install plugin
				</button>
			</div>
			<p className="settings-help">
				Install a ZIP package with its own tools, tabs, and composer extensions, or a JSON manifest
				for an existing MCP service. Review the plugin’s network access and account permissions
				before installing.
			</p>

			{error && (
				<div className="error-note" role="alert">
					{userFacingError(error)}
				</div>
			)}
			{notice && (
				<p className="plugin-settings-notice" role="status">
					{notice}
				</p>
			)}
			{packageProgress && (
				<div className="plugin-connect-progress" role="status">
					<LoaderCircle size={16} className="spin" />
					<span>{packageProgress}</span>
				</div>
			)}
			{connecting && (
				<div className="plugin-connect-progress" role="status">
					<LoaderCircle size={16} className="spin" />
					<span>Complete sign-in in your browser.</span>
					<button
						className="secondary-button compact"
						onClick={() =>
							void bridge.pluginCancelConnect().catch((failure) => setError(String(failure)))
						}
					>
						Cancel sign-in
					</button>
				</div>
			)}
			{importing && (
				<SettingsGroup
					title={review ? 'Review plugin' : 'Import plugin'}
					footer="Install only plugins you trust. Review the data access above. Enabling a surface extension authorizes its declared capabilities on enabled surfaces, including background inference when declared. Tools start disabled separately."
				>
					<SettingsRow
						layout="stacked"
						label={review ? review.description : 'Manifest JSON'}
						htmlFor={review ? undefined : 'plugin-manifest-json'}
					>
						{review ? (
							<>
								<ManifestReview manifest={review} />
								{packagePreview && (
									<p className="settings-help">
										Package contains {packagePreview.files} files ·{' '}
										{(packagePreview.bytes / 1024).toFixed(1)} KB unpacked.
									</p>
								)}
							</>
						) : (
							<>
								{bridge.pluginPreparePackage && bridge.pluginInstallPackage && (
									<>
										<div className="plugin-settings-actions">
											<button
												className="secondary-button compact"
												disabled={busy}
												onClick={() => zipInput.current?.click()}
											>
												<Upload size={14} /> Choose ZIP package
											</button>
											<span className="settings-help">Up to 8 MiB</span>
										</div>
										<input
											ref={zipInput}
											type="file"
											accept=".zip,.freelm-plugin,application/zip"
											className="plugin-manifest-file"
											aria-label="Choose plugin ZIP"
											onChange={(event) => {
												const file = event.target.files?.[0];
												event.target.value = '';
												if (file) void preparePackage(file);
											}}
										/>
									</>
								)}
								<textarea
									id="plugin-manifest-json"
									rows={8}
									value={manifestText}
									disabled={busy}
									spellCheck={false}
									placeholder={'{ "manifestVersion": 1, … }'}
									onChange={(event) => setManifestText(event.target.value)}
								/>
								<input
									ref={fileInput}
									type="file"
									accept=".json,application/json"
									className="plugin-manifest-file"
									aria-label="Choose plugin manifest"
									onChange={async (event) => {
										const file = event.target.files?.[0];
										event.target.value = '';
										if (!file) return;
										if (file.size > PLUGIN_LIMITS.manifestBytes) {
											setError('Plugin manifests must be 64 KB or smaller.');
											return;
										}
										try {
											setManifestText(await file.text());
											setError('');
										} catch {
											setError('Could not read this manifest.');
										}
									}}
								/>
							</>
						)}
						<div className="plugin-settings-actions">
							{!review && (
								<button
									className="secondary-button compact"
									disabled={busy}
									onClick={() => fileInput.current?.click()}
								>
									<Upload size={14} /> Choose file
								</button>
							)}
							<button
								className="secondary-button compact"
								disabled={busy}
								onClick={() => {
									if (review) {
										setReview(null);
										setPackagePreview(null);
									} else setImporting(false);
								}}
							>
								{review ? 'Back' : 'Cancel'}
							</button>
							<button
								className="primary-button compact"
								disabled={busy || (!review && !manifestText.trim())}
								onClick={async () => {
									if (!review) {
										try {
											const manifest = validatePluginManifest(JSON.parse(manifestText));
											if (manifest.manifestVersion !== 1)
												throw new Error(
													'Local plugins must be installed as a ZIP package, including their source files.',
												);
											setPackagePreview(null);
											setReview(manifest);
											setError('');
										} catch (failure) {
											setError(
												failure instanceof Error ? failure.message : 'Invalid manifest JSON.',
											);
										}
										return;
									}
									if (
										packagePreview
											? await installPackage()
											: await run(
													{ type: 'install', manifest: review },
													'Plugin installed. Enable it and add an account to discover its tools.',
												)
									) {
										setImporting(false);
										setReview(null);
										setManifestText('');
										setPackagePreview(null);
									}
								}}
							>
								{review
									? snapshot.plugins.some((plugin) => plugin.manifest.id === review.id)
										? 'Update plugin'
										: 'Install reviewed plugin'
									: 'Review manifest'}
							</button>
						</div>
					</SettingsRow>
					{review && snapshot.plugins.some((plugin) => plugin.manifest.id === review.id) && (
						<SettingsRow description="This replaces the installed plugin. Updated source or changed permissions may require reconnecting accounts and reviewing access." />
					)}
				</SettingsGroup>
			)}
			{loading ? (
				<p role="status">Loading plugins…</p>
			) : (
				snapshot.plugins.length === 0 && (
					<SettingsGroup title="Installed plugins">
						<SettingsRow
							label="No plugins installed"
							description="Install a ZIP package or service manifest to get started."
						/>
					</SettingsGroup>
				)
			)}
			{snapshot.plugins.map((plugin) => {
				const accounts = snapshot.accounts.filter(
					(account) => account.pluginId === plugin.manifest.id,
				);
				const activation =
					plugin.manifest.manifestVersion === 2
						? plugin.manifest.contributes.activation
						: undefined;
				const needsAccount =
					plugin.manifest.auth.type !== 'none' ||
					!activation ||
					(plugin.manifest.manifestVersion === 2 &&
						(plugin.manifest.contributes.tools.length > 0 ||
							plugin.manifest.contributes.tabs.length > 0));
				return (
					<section
						className="plugin-settings-entry"
						key={plugin.manifest.id}
						aria-label={plugin.manifest.name}
					>
						<SettingsGroup title={plugin.manifest.name} description={plugin.manifest.description}>
							<SettingsRow
								label="Enabled"
								description={`${plugin.manifest.author || 'Author not supplied'} · ${plugin.manifest.version}`}
							>
								<Switch
									aria-label={`Enable ${plugin.manifest.name}`}
									checked={plugin.enabled}
									disabled={busy}
									onChange={(enabled) =>
										void run(
											{ type: 'enable', pluginId: plugin.manifest.id, enabled },
											enabled ? 'Plugin enabled.' : 'Plugin disabled.',
										)
									}
								/>
							</SettingsRow>
							{activation && (
								<>
									{activation.surfaces.map((surface) => {
										const mode = surface === 'home.chat' ? 'chat' : 'code';
										return (
											<SettingsRow
												key={surface}
												label={`Enable in ${mode === 'chat' ? 'Chat' : 'Code'}`}
												description="Uses the capabilities reviewed at installation. Inference sends authorized text to your selected model provider."
											>
												<Switch
													aria-label={`Enable ${plugin.manifest.name} in ${mode === 'chat' ? 'Chat' : 'Code'}`}
													checked={plugin.surfaceAccess?.[mode] ?? true}
													disabled={busy}
													onChange={(enabled) =>
														void run(
															{
																type: 'surface-access',
																pluginId: plugin.manifest.id,
																surfaceAccess: {
																	chat:
																		plugin.surfaceAccess?.chat ??
																		activation.surfaces.includes('home.chat'),
																	code:
																		plugin.surfaceAccess?.code ??
																		activation.surfaces.includes('home.code'),
																	[mode]: enabled,
																},
															},
															'Surface access updated.',
														)
													}
												/>
											</SettingsRow>
										);
									})}
									{!needsAccount && (
										<SettingsRow description="No account or sign-in is required for this extension." />
									)}
								</>
							)}
							{plugin.runtimeError && (
								<SettingsRow layout="stacked">
									<p className="error-note" role="alert">
										{userFacingError(plugin.runtimeError)}
									</p>
								</SettingsRow>
							)}
							<SettingsRow layout="stacked">
								<details className="plugin-manifest-details">
									<summary>
										{plugin.manifest.manifestVersion === 2
											? 'Capabilities and authorization'
											: 'Service and authorization'}
									</summary>
									<ManifestReview manifest={plugin.manifest} />
								</details>
							</SettingsRow>
							{accounts.map((account) => (
								<SettingsRow key={account.id} layout="stacked" className="plugin-account-row">
									<div className="plugin-account-heading">
										<div>
											<h4>{account.label}</h4>
											<span>
												{account.status === 'connected' ? 'Connected' : 'Reconnect required'}
											</span>
										</div>
										<div className="plugin-settings-actions">
											<button
												className="secondary-button compact"
												disabled={busy || !plugin.enabled}
												onClick={() => void connect(plugin.manifest.id, account.id, account.label)}
											>
												<ExternalLink size={14} /> Reconnect
											</button>
											<button
												className="secondary-button compact"
												disabled={busy}
												onClick={() =>
													void run(
														{ type: 'disconnect', accountId: account.id },
														'Account disconnected from FreeLM. Review the service’s authorized applications to revoke any remaining grant.',
													)
												}
											>
												Disconnect
											</button>
										</div>
									</div>
									{account.error && (
										<p className="error-note" role="alert">
											{userFacingError(account.error)}
										</p>
									)}
									<div className="plugin-account-discovery">
										<button
											className="secondary-button compact"
											disabled={busy || !plugin.enabled || account.status !== 'connected'}
											onClick={() =>
												void run(
													{ type: 'discover', accountId: account.id },
													'Tools refreshed. Newly discovered tools remain off.',
												)
											}
										>
											<RefreshCw size={14} /> Discover tools
										</button>
										<span>
											{account.tools.length} {account.tools.length === 1 ? 'tool' : 'tools'}{' '}
											available
										</span>
									</div>
									<AccountPermissions
										account={account}
										bots={bots}
										busy={busy}
										onAccess={(access) =>
											void run(
												{ type: 'access', accountId: account.id, access },
												'Account access updated.',
											)
										}
									/>
								</SettingsRow>
							))}
							<SettingsRow layout="stacked">
								{newAccount === plugin.manifest.id ? (
									<form
										className="plugin-add-account"
										aria-label={`Add account to ${plugin.manifest.name}`}
										onSubmit={(event) => {
											event.preventDefault();
											if (label.trim()) void connect(plugin.manifest.id);
										}}
									>
										<label htmlFor={`plugin-account-${plugin.manifest.id}`}>Account label</label>
										<input
											id={`plugin-account-${plugin.manifest.id}`}
											placeholder="Personal or work"
											value={label}
											maxLength={100}
											disabled={busy}
											onChange={(event) => setLabel(event.target.value)}
										/>
										<p className="settings-help">
											This is a label you choose, not a verified email address.
										</p>
										<div className="plugin-settings-actions">
											<button
												type="button"
												className="secondary-button compact"
												disabled={busy}
												onClick={() => setNewAccount(null)}
											>
												Cancel
											</button>
											<button className="primary-button compact" disabled={busy || !label.trim()}>
												{plugin.manifest.auth.type === 'oauth2' ? 'Sign in' : 'Connect account'}
											</button>
										</div>
									</form>
								) : (
									<div className="plugin-settings-actions">
										{needsAccount && (
											<button
												className="secondary-button compact"
												disabled={busy || !plugin.enabled}
												onClick={() => {
													setNewAccount(plugin.manifest.id);
													setLabel('');
												}}
											>
												<Plus size={14} /> Add account
											</button>
										)}
										<button
											className="secondary-button compact"
											disabled={busy}
											onClick={() => setRemoving(plugin.manifest.id)}
										>
											<Trash2 size={14} /> Remove plugin
										</button>
									</div>
								)}
								{removing === plugin.manifest.id && (
									<div className="plugin-remove-confirm" role="alert">
										<p>Remove {plugin.manifest.name} and disconnect its accounts from FreeLM?</p>
										<div className="plugin-settings-actions">
											<button
												className="secondary-button compact"
												disabled={busy}
												onClick={() => setRemoving(null)}
											>
												Keep plugin
											</button>
											<button
												className="secondary-button compact danger"
												disabled={busy}
												onClick={async () => {
													if (
														await run(
															{ type: 'remove', pluginId: plugin.manifest.id },
															'Plugin removed.',
														)
													)
														setRemoving(null);
												}}
											>
												Remove and disconnect
											</button>
										</div>
									</div>
								)}
							</SettingsRow>
						</SettingsGroup>
						<PluginNativeSettings
							plugin={plugin}
							busy={busy}
							connections={connections}
							workspaceId={workspaceId}
							onChange={(values) =>
								void run(
									{ type: 'settings', pluginId: plugin.manifest.id, values },
									'Plugin settings saved.',
								)
							}
						/>
					</section>
				);
			})}
		</div>
	);
}
