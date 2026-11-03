import { useState } from 'react';
import Button from './Button';
import SearchField from './SearchField';
import Select from './Select';
import FilePicker from './FilePicker';
import { SettingsGroup, SettingsRow } from './SettingsList';
import { userFacingError } from '../lib/user-facing-error';
import {
	approvedMarketplaceBytes,
	marketplaceFileBase64,
	marketplaceRequest,
	type MarketplaceEntry,
	type MarketplaceKind,
} from '../lib/marketplace-client';
import './marketplace.css';

export default function Marketplace({
	type,
	onReviewPackage,
	disabled = false,
}: {
	type: MarketplaceKind;
	onReviewPackage: (bytes: Uint8Array, revalidate?: () => Promise<void>) => Promise<void>;
	disabled?: boolean;
}) {
	const [connected, setConnected] = useState(false),
		[busy, setBusy] = useState(false);
	const [items, setItems] = useState<MarketplaceEntry[]>([]),
		[selected, setSelected] = useState<MarketplaceEntry | null>(null);
	const [view, setView] = useState<'catalog' | 'developer'>('catalog');
	const [query, setQuery] = useState(''),
		[capability, setCapability] = useState('');
	const [token, setToken] = useState(''),
		[provenance, setProvenance] = useState(''),
		[license, setLicense] = useState('MIT');
	const [file, setFile] = useState<File | null>(null),
		[error, setError] = useState(''),
		[notice, setNotice] = useState('');
	async function perform(action: () => Promise<void>) {
		setBusy(true);
		setError('');
		setNotice('');
		try {
			await action();
		} catch (e) {
			setError(userFacingError(e));
			setSelected(null);
		} finally {
			setBusy(false);
		}
	}
	async function refresh(next = view) {
		await perform(async () => {
			const data = await marketplaceRequest<{ items: MarketplaceEntry[] }>(
				next === 'catalog' ? `catalog?type=${type}` : 'submissions',
				next === 'developer' ? token : '',
			);
			setItems(
				data.items.filter(
					(item) => item.type === type && (next !== 'catalog' || item.status === 'approved'),
				),
			);
			setConnected(true);
			setView(next);
			setSelected(null);
		});
	}
	const visible = items.filter(
		(item) =>
			`${item.name || item.filename || 'Submitted package'} ${item.packageId} ${item.description}`
				.toLowerCase()
				.includes(query.toLowerCase()) &&
			(!capability || item.capabilities.includes(capability)),
	);
	return (
		<section
			className="marketplace-panel"
			aria-label={`${type === 'plugin' ? 'Plugin' : 'Workflow node'} marketplace`}
			aria-busy={busy}
		>
			<header>
				<span className="marketplace-eyebrow">LOCAL REVIEW DEMO</span>
				<h2>{type === 'plugin' ? 'Plugin Marketplace' : 'Workflow Node Marketplace'}</h2>
				<p>Explore extensions. Understand their access. Choose what to install.</p>
			</header>
			<p className="marketplace-disclosure">
				Local review uses a proposed policy, not production approval or a guarantee of safety.
				Packages require static checks and a manual reviewer. Installing never grants service
				permissions.
			</p>
			{error && (
				<p role="alert" className="marketplace-error">
					{error} Check that the local service is running and retry.
				</p>
			)}
			{notice && <p role="status">{notice}</p>}
			{!connected ? (
				<SettingsGroup title="Local marketplace">
					<SettingsRow
						label="Connect to local marketplace"
						description="Connects only to 127.0.0.1:4324 after you choose to continue."
					>
						<Button disabled={busy} onClick={() => void refresh()}>
							Connect
						</Button>
					</SettingsRow>
				</SettingsGroup>
			) : (
				<>
					<div className="marketplace-actions">
						<Button
							aria-pressed={view === 'catalog'}
							disabled={busy}
							onClick={() => void refresh('catalog')}
						>
							Catalog
						</Button>
						<Button
							aria-pressed={view === 'developer'}
							disabled={busy}
							onClick={() => {
								setView('developer');
								setItems([]);
								setSelected(null);
							}}
						>
							Developer submissions
						</Button>
						<Button disabled={busy} onClick={() => void refresh()}>
							Refresh
						</Button>
						<Button
							disabled={busy}
							onClick={() => {
								setConnected(false);
								setToken('');
								setItems([]);
								setSelected(null);
							}}
						>
							Disconnect
						</Button>
					</div>
					{view === 'developer' && (
						<form
							className="marketplace-form"
							onSubmit={(event) => {
								event.preventDefault();
								void perform(async () => {
									if (!file || !token.trim())
										throw new Error('Choose a package and enter your local developer credential.');
									const { item } = await marketplaceRequest<{ item: MarketplaceEntry }>(
										'submissions',
										token,
										{
											type,
											filename: file.name,
											packageBase64: await marketplaceFileBase64(file, type),
											license,
											provenance,
										},
									);
									setItems((previous) => [item, ...previous.filter((old) => old.id !== item.id)]);
									setSelected(item);
									setNotice(
										'Submitted to quarantine. A reviewer must approve this version before it appears in the catalog.',
									);
								});
							}}
						>
							<h3>Submit a version for review</h3>
							<p>
								Use an isolated local developer credential. It stays in memory until you disconnect
								or close this marketplace. Uploaded source is not executed during review.
							</p>
							<label>
								Developer credential
								<input
									type="password"
									autoComplete="off"
									value={token}
									onChange={(e) => setToken(e.target.value)}
								/>
							</label>
							<Button disabled={busy || !token} onClick={() => void refresh('developer')}>
								Load my submissions
							</Button>
							<FilePicker
								label="Marketplace source package"
								buttonLabel="Choose package…"
								accept={type === 'node' ? '.freelm-node,.json' : '.freelm-plugin,.zip'}
								disabled={busy}
								onFile={async (file) => setFile(file)}
							/>
							<span>{file?.name || 'No package chosen'}</span>
							<label>
								License
								<input required value={license} onChange={(e) => setLicense(e.target.value)} />
							</label>
							<label>
								Source provenance
								<input
									required
									placeholder="Source URL or synthetic fixture description"
									value={provenance}
									onChange={(e) => setProvenance(e.target.value)}
								/>
							</label>
							<Button variant="primary" type="submit" disabled={busy || !token || !file}>
								{busy ? 'Working…' : 'Submit for review'}
							</Button>
						</form>
					)}
					<div className="marketplace-filters">
						<SearchField
							label="Search marketplace"
							placeholder="Search name or description"
							value={query}
							onValueChange={setQuery}
						/>
						<Select
							aria-label="Filter by capability"
							value={capability}
							onChange={setCapability}
							options={[
								{ value: '', label: 'All capabilities' },
								...[...new Set(items.flatMap((item) => item.capabilities))]
									.sort()
									.map((value) => ({ value, label: value })),
							]}
						/>
					</div>
					<div className="marketplace-results">
						<div className="marketplace-entries">
							{visible.length === 0 ? (
								<p>
									{busy
										? 'Loading…'
										: view === 'catalog'
											? 'No approved versions match. Try a different search or refresh after a reviewer approves a submission.'
											: 'No submissions loaded. Enter your credential and choose Load my submissions.'}
								</p>
							) : (
								visible.map((item) => (
									<button
										className="marketplace-entry"
										key={item.id}
										aria-pressed={selected?.id === item.id}
										disabled={busy}
										onClick={() => setSelected(item)}
									>
										<strong>{item.name || item.filename || 'Submitted package'}</strong>
										<span>
											{item.version || 'Awaiting metadata'} · {item.publisher}
										</span>
										<span>{item.description}</span>
										<span className="marketplace-status">
											{item.status.replaceAll('_', ' ')} · {item.trust?.label || 'Unreviewed'}
										</span>
									</button>
								))
							)}
						</div>
						{selected && (
							<article className="marketplace-detail">
								<h3>{selected.name || selected.filename || 'Submitted package'}</h3>
								<p>
									{selected.packageId} · Version {selected.version || 'Awaiting metadata'}
								</p>
								<p>{selected.description}</p>
								<dl>
									<dt>Status</dt>
									<dd>{selected.status.replaceAll('_', ' ')}</dd>
									<dt>Capabilities</dt>
									<dd>{selected.capabilities.join(', ') || 'None declared'}</dd>
									<dt>Permissions requested</dt>
									<dd>
										<pre>{JSON.stringify(selected.permissions, null, 2)}</pre>
									</dd>
									<dt>License / provenance</dt>
									<dd>
										{selected.license} · {selected.provenance}
									</dd>
									<dt>SHA-256</dt>
									<dd className="marketplace-digest">{selected.sha256}</dd>
									<dt>Review policy</dt>
									<dd>{selected.review?.policyVersion || 'Awaiting review'}</dd>
								</dl>
								<h4>Review findings</h4>
								{selected.findings?.length ? (
									<ul>
										{selected.findings.map((finding, i) => (
											<li key={i}>
												{finding.severity}: {finding.message}
											</li>
										))}
									</ul>
								) : (
									<p>No findings recorded. This is not a safety guarantee.</p>
								)}
								{selected.review?.reason && <p>{selected.review.reason}</p>}
								<details>
									<summary>Package manifest</summary>
									<pre>{JSON.stringify(selected.manifest, null, 2)}</pre>
								</details>
								{view === 'catalog' && (
									<>
										<p>
											Review the manifest and requested access before continuing. Revoked versions
											cannot be downloaded. Already installed copies are not automatically removed,
											and offline revocation cannot be checked.
										</p>
										<Button
											disabled={busy || disabled || selected.status !== 'approved'}
											onClick={() =>
												void perform(async () => {
													await onReviewPackage(
														await approvedMarketplaceBytes(selected),
														async () => {
															await approvedMarketplaceBytes(selected);
														},
													);
													setNotice(
														type === 'plugin'
															? 'Package opened for installation review.'
															: 'Node installed. Service permissions remain unchanged.',
													);
												})
											}
										>
											{type === 'plugin' ? 'Review installation…' : 'Install reviewed node'}
										</Button>
									</>
								)}
							</article>
						)}
					</div>
				</>
			)}
		</section>
	);
}
