import { userFacingError } from '../lib/user-facing-error';
import Select from './Select';
import { useEffect, useState, type ReactNode } from 'react';
import { SettingsGroup, SettingsRow } from './SettingsList';
import {
	ArrowRight,
	Check,
	Copy,
	Eye,
	EyeOff,
	Laptop,
	LoaderCircle,
	LockKeyhole,
	Pencil,
	Plus,
	Server,
	Trash2,
	Unplug,
	X,
} from 'lucide-react';
import type { InstanceOverview, RemoteInstance, RemoteInstanceInput } from '../remote-types';
import { copyToClipboard } from '../lib/clipboard';
import './instances.css';

interface Props {
	activeWorkspaceId: string;
	onSelect: (id: string) => Promise<void>;
	onClose: () => void;
	onChanged?: () => void;
	embedded?: boolean;
	onBusyChange?: (busy: boolean) => void;
}

const defaultPort = 4319;
const newRemote = (): RemoteInstanceInput => ({
	name: '',
	transport: 'ssh',
	sshHost: '',
	port: defaultPort,
	url: '',
	token: '',
});

/** The workspace switcher keeps its compact modal; Settings uses the shared inset lists. */
function InstanceGroup({
	embedded,
	title,
	id,
	actions,
	children,
}: {
	embedded: boolean;
	title: string;
	id: string;
	actions?: ReactNode;
	children: ReactNode;
}) {
	if (embedded)
		return (
			<SettingsGroup title={title} id={id} actions={actions}>
				{children}
			</SettingsGroup>
		);
	return (
		<section className="instance-section" aria-labelledby={id}>
			<div className="instance-section-heading">
				<span className="section-label" id={id}>
					{title}
				</span>
				{actions}
			</div>
			{children}
		</section>
	);
}
function InstanceField({
	embedded,
	label,
	children,
	description,
	layout = 'inline',
}: {
	embedded: boolean;
	label: ReactNode;
	children: ReactNode;
	description?: ReactNode;
	layout?: 'inline' | 'stacked';
}) {
	return embedded ? (
		<SettingsRow
			label={label}
			description={description}
			layout={layout}
			className="instance-setting-row"
		>
			{children}
		</SettingsRow>
	) : (
		<label>
			{label}
			{children}
			{description && <span className="field-hint">{description}</span>}
		</label>
	);
}

export default function Instances({
	activeWorkspaceId,
	onSelect,
	onClose,
	onChanged,
	embedded = false,
	onBusyChange,
}: Props) {
	const desktop = window.desktop;
	const localName = desktop?.platform === 'darwin' ? 'This Mac' : 'This computer';
	const [overview, setOverview] = useState<InstanceOverview | null>(null);
	const [loading, setLoading] = useState(Boolean(desktop));
	const [busy, setBusy] = useState('');
	const [error, setError] = useState('');
	const [hostName, setHostName] = useState(localName);
	const [hostPort, setHostPort] = useState(String(defaultPort));
	const [editing, setEditing] = useState<RemoteInstanceInput | null>(null);
	const [showToken, setShowToken] = useState(false);
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		onBusyChange?.(Boolean(busy));
		return () => onBusyChange?.(false);
	}, [busy, onBusyChange]);

	useEffect(() => {
		if (!desktop) return;
		let cancelled = false;
		desktop
			.instanceStatus()
			.then((value) => {
				if (cancelled) return;
				setOverview(value);
				setHostName(value.host.name || localName);
				setHostPort(String(value.host.port || defaultPort));
			})
			.catch((e: unknown) => {
				if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load instances.');
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [desktop, localName]);

	async function perform(key: string, action: () => Promise<void>) {
		if (busy) return;
		setBusy(key);
		setError('');
		try {
			await action();
		} catch (e) {
			setError(e instanceof Error ? e.message : 'The connection could not be completed.');
		} finally {
			setBusy('');
		}
	}

	async function refresh() {
		if (!desktop) return;
		setOverview(await desktop.instanceStatus());
		onChanged?.();
	}

	async function openWorkspace(id: string) {
		await perform(`open:${id}`, async () => {
			await onSelect(id);
			onClose();
		});
	}

	function edit(instance: RemoteInstance) {
		setEditing({
			id: instance.id,
			name: instance.name,
			transport: instance.transport,
			sshHost: instance.sshHost || '',
			port: instance.port || defaultPort,
			url: instance.url || '',
			token: '',
		});
		setError('');
	}

	async function connect(event: React.FormEvent) {
		event.preventDefault();
		if (!desktop || !editing) return;
		await perform('connect', async () => {
			const input = {
				...editing,
				name: editing.name.trim(),
				sshHost: editing.sshHost?.trim(),
				url: editing.url?.trim(),
				token: editing.token?.trim() || undefined,
			};
			if (!input.name) throw new Error('Give this instance a name.');
			if (!input.id && !input.token)
				throw new Error('Paste the access token shown on the host computer.');
			if (input.transport === 'ssh') {
				if (!input.sshHost) throw new Error('Enter an SSH host or a configured SSH alias.');
				if (!Number.isInteger(input.port) || Number(input.port) < 1 || Number(input.port) > 65535)
					throw new Error('Enter a FreeLM host port from 1 to 65535.');
			} else {
				let url: URL;
				try {
					url = new URL(input.url || '');
				} catch {
					throw new Error('Enter the instance’s HTTPS URL or a local tunnel URL.');
				}
				const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
				if (
					url.username ||
					url.password ||
					url.search ||
					url.hash ||
					!(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))
				)
					throw new Error(
						'Use HTTPS, or HTTP on localhost through a tunnel. URLs cannot contain credentials, query parameters, or fragments.',
					);
			}
			const { instance } = await desktop.instanceConnect(input);
			setEditing(null);
			await refresh();
			await onSelect(instance.id);
			onClose();
		});
	}

	const host = overview?.host;
	return (
		<div
			className={embedded ? 'instances-embedded' : 'modal-backdrop'}
			onClick={() => {
				if (!embedded && !busy) onClose();
			}}
		>
			<section
				className={embedded ? 'instances-panel' : 'instances-modal'}
				role={embedded ? undefined : 'dialog'}
				aria-modal={embedded ? undefined : true}
				aria-labelledby={embedded ? undefined : 'instances-title'}
				aria-label={embedded ? 'Remote FreeLM workspaces' : undefined}
				onClick={(event) => event.stopPropagation()}
			>
				{!embedded && (
					<header className="modal-header">
						<h2 id="instances-title">Instances</h2>
						<button
							className="icon-button"
							aria-label="Close instances"
							onClick={onClose}
							disabled={Boolean(busy)}
						>
							<X size={20} />
						</button>
					</header>
				)}
				<div className="instances-body">
					<p className="instances-intro">
						Your workspace, on any of your computers. Open its chats, projects, and playgrounds
						while requests run through its API connections.
					</p>
					{!desktop ? (
						embedded ? (
							<SettingsGroup title="Remote workspaces">
								<SettingsRow
									label="Available in the desktop app"
									description="Open FreeLM on macOS or Linux to share this workspace or connect to another computer."
								>
									<Laptop size={24} />
								</SettingsRow>
							</SettingsGroup>
						) : (
							<div className="instance-empty">
								<Laptop size={24} />
								<h3>Available in the desktop app</h3>
								<p>
									Open FreeLM on macOS or Linux to share this workspace or connect to another
									computer.
								</p>
							</div>
						)
					) : loading ? (
						<div className="instance-loading" role="status">
							<LoaderCircle size={18} className="spin" /> Loading instances…
						</div>
					) : overview ? (
						<>
							<InstanceGroup
								embedded={embedded}
								title="Local workspace"
								id="local-instance-section-title"
							>
								<div className="instance-card">
									<div className="instance-row">
										<div className="instance-icon">
											<Laptop size={20} />
										</div>
										<div className="instance-details">
											<h3 id="local-instance-title">{localName}</h3>
											<p>{host?.running ? 'Sharing through SSH' : 'Private to this computer'}</p>
										</div>
										{activeWorkspaceId === 'local' ? (
											<span className="instance-active">
												<Check size={13} /> Current
											</span>
										) : (
											<button
												className="secondary-button compact"
												disabled={Boolean(busy)}
												onClick={() => void openWorkspace('local')}
											>
												{busy === 'open:local' ? (
													<LoaderCircle className="spin" size={14} />
												) : (
													<ArrowRight size={14} />
												)}{' '}
												Open
											</button>
										)}
									</div>
									<div className="instance-host-settings">
										<p className="instance-subtext">
											Sharing always applies to this computer’s local workspace.
										</p>
										{host?.running ? (
											<>
												<div className="instance-sharing-heading">
													<span className="instance-sharing-status">
														<span /> Sharing as {host.name}
													</span>
													<button
														className="secondary-button compact"
														disabled={Boolean(busy)}
														onClick={() =>
															void perform('stop', async () => {
																await desktop.hostStop();
																setShowToken(false);
																setCopied(false);
																await refresh();
															})
														}
													>
														{busy === 'stop' && <LoaderCircle size={14} className="spin" />} Stop
														sharing
													</button>
												</div>
												<div className="instance-instructions">
													<LockKeyhole size={16} />
													<p>
														On the other computer, open{' '}
														<strong>Settings → Remote FreeLM → Add instance</strong> and choose{' '}
														<strong>SSH</strong>. Enter this computer’s SSH host, FreeLM host port{' '}
														<strong>{host.port}</strong>, and the access token below. FreeLM
														securely tunnels to <code>127.0.0.1:{host.port}</code>.
													</p>
												</div>
												{host.token ? (
													<div className="instance-token">
														<label htmlFor="instance-host-token">Access token</label>
														<div className="instance-token-control">
															<input
																id="instance-host-token"
																type={showToken ? 'text' : 'password'}
																value={host.token}
																readOnly
																autoComplete="off"
																spellCheck={false}
															/>
															<button
																className="icon-button"
																aria-label={showToken ? 'Hide access token' : 'Show access token'}
																onClick={() => setShowToken((value) => !value)}
															>
																{showToken ? <EyeOff size={16} /> : <Eye size={16} />}
															</button>
															<button
																className="secondary-button compact"
																onClick={() =>
																	void perform('copy', async () => {
																		await copyToClipboard(host.token!);
																		setCopied(true);
																	})
																}
																disabled={Boolean(busy)}
															>
																{copied ? <Check size={14} /> : <Copy size={14} />}
																{copied ? 'Copied' : 'Copy'}
															</button>
														</div>
													</div>
												) : (
													<p className="field-hint">
														Restart sharing to create a new access token.
													</p>
												)}
												<p className="field-hint">
													Anyone with SSH access and this token can use this workspace and its API
													connections. Stopping sharing invalidates the token and disconnects
													clients. Keep FreeLM running.
												</p>
											</>
										) : (
											<form
												className="instance-host-form"
												onSubmit={(event) => {
													event.preventDefault();
													void perform('start', async () => {
														const port = Number(hostPort);
														if (!hostName.trim())
															throw new Error('Give this computer a sharing name.');
														if (!Number.isInteger(port) || port < 1 || port > 65535)
															throw new Error('Enter a host port from 1 to 65535.');
														const started = await desktop.hostStart({
															name: hostName.trim(),
															port,
														});
														setOverview((value) => (value ? { ...value, host: started } : value));
														setShowToken(false);
														setCopied(false);
														onChanged?.();
													});
												}}
											>
												<InstanceField embedded={embedded} label="Sharing name">
													<input
														aria-label="Sharing name"
														value={hostName}
														onChange={(event) => setHostName(event.target.value)}
														required
														maxLength={100}
														disabled={Boolean(busy)}
													/>
												</InstanceField>
												<InstanceField embedded={embedded} label="Host port">
													<input
														aria-label="Local FreeLM host port"
														type="number"
														value={hostPort}
														onChange={(event) => setHostPort(event.target.value)}
														min={1}
														max={65535}
														required
														disabled={Boolean(busy)}
													/>
												</InstanceField>
												<button className="secondary-button" type="submit" disabled={Boolean(busy)}>
													{busy === 'start' ? (
														<LoaderCircle size={15} className="spin" />
													) : (
														<LockKeyhole size={15} />
													)}{' '}
													Start sharing
												</button>
												<p className="field-hint">
													Listens on 127.0.0.1 only. Connect securely through SSH using your
													existing SSH keys and trusted host configuration.
												</p>
											</form>
										)}
									</div>
								</div>
							</InstanceGroup>
							<InstanceGroup
								embedded={embedded}
								title="Remote workspaces"
								id="remote-instances-title"
								actions={
									<button
										className="secondary-button compact"
										disabled={Boolean(busy)}
										onClick={() => {
											setEditing(newRemote());
											setError('');
										}}
									>
										<Plus size={14} /> Add instance
									</button>
								}
							>
								{!overview.instances.length && !editing && (
									<div className="instance-empty compact-empty">
										<Server size={22} />
										<p>Connect to FreeLM running on another Mac or Linux computer.</p>
									</div>
								)}
								<div className="instance-list">
									{overview.instances.map((instance) => {
										const active = activeWorkspaceId === instance.id;
										return (
											<div
												key={instance.id}
												className={`instance-card instance-row ${active ? 'current-instance' : ''}`}
											>
												<div className="instance-icon">
													<Server size={19} />
												</div>
												<div className="instance-details">
													<h3>{instance.name}</h3>
													<p>
														{instance.transport === 'ssh' ? instance.sshHost : instance.url}{' '}
														<span>· {instance.connected ? 'Connected' : 'Disconnected'}</span>
													</p>
												</div>
												<div className="instance-actions">
													{active ? (
														<span className="instance-active">
															<Check size={13} /> Current
														</span>
													) : (
														<>
															<button
																className="secondary-button compact"
																disabled={Boolean(busy)}
																onClick={() => void openWorkspace(instance.id)}
															>
																{busy === `open:${instance.id}` ? (
																	<LoaderCircle size={14} className="spin" />
																) : (
																	<ArrowRight size={14} />
																)}
																{instance.connected ? 'Open' : 'Connect'}
															</button>
															<button
																className="icon-button"
																aria-label={`Edit ${instance.name}`}
																disabled={Boolean(busy)}
																onClick={() => edit(instance)}
															>
																<Pencil size={14} />
															</button>
															{instance.connected && (
																<button
																	className="icon-button"
																	aria-label={`Disconnect ${instance.name}`}
																	disabled={Boolean(busy)}
																	onClick={() =>
																		void perform(`disconnect:${instance.id}`, async () => {
																			await desktop.instanceDisconnect(instance.id);
																			await refresh();
																		})
																	}
																>
																	<Unplug size={15} />
																</button>
															)}
															<button
																className="icon-button danger"
																aria-label={`Remove ${instance.name}`}
																disabled={Boolean(busy)}
																onClick={() =>
																	void perform(`remove:${instance.id}`, async () => {
																		await desktop.instanceRemove(instance.id);
																		if (editing?.id === instance.id) setEditing(null);
																		await refresh();
																	})
																}
															>
																<Trash2 size={14} />
															</button>
														</>
													)}
												</div>
											</div>
										);
									})}
								</div>
								{editing && (
									<form className="instance-edit-form" onSubmit={(event) => void connect(event)}>
										<div className="instance-section-heading">
											<h3>{editing.id ? 'Edit instance' : 'Connect an instance'}</h3>
											<button
												type="button"
												className="icon-button"
												aria-label="Cancel instance edit"
												disabled={Boolean(busy)}
												onClick={() => setEditing(null)}
											>
												<X size={17} />
											</button>
										</div>
										<InstanceField embedded={embedded} label="Instance name">
											<input
												aria-label="Instance name"
												value={editing.name}
												onChange={(event) => setEditing({ ...editing, name: event.target.value })}
												placeholder="My Linux workstation"
												required
												maxLength={100}
												disabled={Boolean(busy)}
											/>
										</InstanceField>
										<InstanceField embedded={embedded} label="Connection method">
											<Select
												aria-label="Connection method"
												value={editing.transport}
												onChange={(transport) =>
													setEditing({
														...editing,
														transport: transport as 'ssh' | 'direct',
													})
												}
												disabled={Boolean(busy)}
												options={[
													{ value: 'ssh', label: 'SSH (recommended)' },
													{ value: 'direct', label: 'Direct URL' },
												]}
											/>
										</InstanceField>
										{editing.transport === 'ssh' ? (
											<div className="instance-ssh-fields">
												<InstanceField
													embedded={embedded}
													label="SSH host"
													description="Uses your SSH keys and ~/.ssh/config. Verify the host and key access in your terminal first."
													layout="stacked"
												>
													<input
														aria-label="SSH host"
														value={editing.sshHost || ''}
														onChange={(event) =>
															setEditing({ ...editing, sshHost: event.target.value })
														}
														placeholder="user@hostname or SSH alias"
														required
														disabled={Boolean(busy)}
														autoComplete="off"
														spellCheck={false}
													/>
												</InstanceField>
												<InstanceField
													embedded={embedded}
													label="FreeLM host port"
													description="The port shown by FreeLM on the host, not the SSH port."
												>
													<input
														aria-label="FreeLM host port"
														type="number"
														value={editing.port ?? defaultPort}
														onChange={(event) =>
															setEditing({
																...editing,
																port:
																	event.target.value === ''
																		? undefined
																		: Number(event.target.value),
															})
														}
														min={1}
														max={65535}
														required
														disabled={Boolean(busy)}
													/>
												</InstanceField>
											</div>
										) : (
											<InstanceField
												embedded={embedded}
												label="Instance URL"
												description="Use an HTTPS proxy you control, or a manually tunneled loopback URL such as http://127.0.0.1:4319."
												layout="stacked"
											>
												<input
													aria-label="Instance URL"
													type="url"
													value={editing.url || ''}
													onChange={(event) => setEditing({ ...editing, url: event.target.value })}
													placeholder="https://freelm.example.com"
													required
													disabled={Boolean(busy)}
													autoComplete="off"
													spellCheck={false}
												/>
											</InstanceField>
										)}
										<InstanceField embedded={embedded} label="Access token" layout="stacked">
											{editing.id && (
												<span className="optional">leave blank to keep saved token</span>
											)}
											<input
												aria-label="Access token"
												type="password"
												value={editing.token || ''}
												onChange={(event) => setEditing({ ...editing, token: event.target.value })}
												placeholder={
													editing.id ? 'Keep saved token' : 'Paste the token from the host'
												}
												required={!editing.id}
												disabled={Boolean(busy)}
												autoComplete="off"
												spellCheck={false}
											/>
										</InstanceField>
										<div className="instance-form-footer">
											<p className="field-hint">
												Provider API keys stay on the host. Your local chats remain in this
												computer’s workspace.
											</p>
											<button className="primary-button" type="submit" disabled={Boolean(busy)}>
												{busy === 'connect' ? (
													<LoaderCircle size={15} className="spin" />
												) : (
													<ArrowRight size={15} />
												)}
												{busy === 'connect' ? 'Connecting…' : 'Connect and open'}
											</button>
										</div>
									</form>
								)}
							</InstanceGroup>
							<p className="instance-footer-note">
								<LockKeyhole size={13} /> Remote access includes chats, projects, and generation.
								Bash and computer-use tools are not available yet.
							</p>
						</>
					) : null}
					{error && (
						<div className="error-note" role="alert">
							{userFacingError(error)}
						</div>
					)}
				</div>
			</section>
		</div>
	);
}
