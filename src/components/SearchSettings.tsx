import { userFacingError } from '../lib/user-facing-error';
import { useEffect, useId, useRef, useState } from 'react';
import { LoaderCircle, Play, RefreshCw, Square } from 'lucide-react';
import type { SearchServiceStatus, ToolSettings, WebServiceInfo } from '../agent-types';
import { normalizedSearchSettings } from '../lib/search-settings';
import { searxngSearchUrl } from '../lib/web-tools';
import Switch from './Switch';
import { SettingsGroup, SettingsRow } from './SettingsList';
import './search-settings.css';

type WebSettings = ToolSettings['webBrowsing'];
interface Props {
	value: WebSettings;
	savedValue: WebSettings;
	readOnly: boolean;
	workspaceName: string;
	onChange: (value: NonNullable<WebSettings>) => void;
	onBusyChange: (busy: boolean) => void;
}
const phaseLabels: Record<SearchServiceStatus['phase'], string> = {
	stopped: 'Stopped',
	starting: 'Starting…',
	running: 'Running',
	stopping: 'Stopping…',
	error: 'Could not run search',
	unavailable: 'Unavailable',
};

function EngineDetails({ engines }: { engines: WebServiceInfo['engines'] }) {
	return (
		<details className="search-engine-details">
			<summary>Search engine details</summary>
			<ul>
				{engines.map((engine) => (
					<li key={engine.name}>
						<strong>{engine.name}</strong>
						<p>{engine.enabled ? 'Enabled by default' : 'Disabled by default'}</p>
						<p>Categories: {engine.categories.join(', ') || 'None reported'}</p>
						<p>
							Paging: {engine.paging ? 'yes' : 'no'} · Time range:{' '}
							{engine.timeRangeSupport ? 'yes' : 'no'} · SafeSearch:{' '}
							{engine.safeSearch ? 'yes' : 'no'}
						</p>
					</li>
				))}
			</ul>
		</details>
	);
}

/** Lifecycle controls operate saved host settings; discovery never writes configuration. */
export default function SearchSettings({
	value,
	savedValue,
	readOnly,
	workspaceName,
	onChange,
	onBusyChange,
}: Props) {
	const web = normalizedSearchSettings(value);
	const saved = normalizedSearchSettings(savedValue);
	const desktop = window.desktop;
	const native = Boolean(desktop?.searchStatus && desktop.searchStart && desktop.searchStop);
	const [status, setStatus] = useState<SearchServiceStatus | null>(null);
	const [service, setService] = useState<WebServiceInfo | null>(null);
	const [discovering, setDiscovering] = useState(false);
	const [actions, setActions] = useState(0);
	const [error, setError] = useState('');
	const mounted = useRef(false);
	const generation = useRef(0);
	const discoveryRequest = useRef(0);
	const actionCount = useRef(0);
	const actionRequest = useRef(0);
	const busyCallback = useRef(onBusyChange);
	busyCallback.current = onBusyChange;
	const urlId = useId();
	const urlErrorId = useId();
	const builtin = web.mode === 'builtin';
	const changed = JSON.stringify(web) !== JSON.stringify(saved);
	let urlError = '';
	if (!builtin && web.searxngUrl.trim()) {
		try {
			searxngSearchUrl(web.searxngUrl);
		} catch (cause) {
			urlError = cause instanceof Error ? cause.message : String(cause);
		}
	}
	useEffect(() => {
		mounted.current = true;
		generation.current++;
		if (!readOnly && desktop?.searchStatus) {
			const observed = generation.current;
			const unsubscribe = desktop.onSearchStatus?.((next) => {
				generation.current++;
				if (mounted.current) setStatus(next);
			});
			void desktop.searchStatus().then(
				(next) => {
					if (mounted.current && observed === generation.current) setStatus(next);
				},
				(cause) => {
					if (mounted.current && observed === generation.current)
						setError(cause instanceof Error ? cause.message : String(cause));
				},
			);
			return () => {
				mounted.current = false;
				generation.current++;
				discoveryRequest.current++;
				unsubscribe?.();
				busyCallback.current(false);
			};
		}
		return () => {
			mounted.current = false;
			generation.current++;
			discoveryRequest.current++;
			busyCallback.current(false);
		};
	}, [desktop, readOnly]);
	useEffect(() => {
		discoveryRequest.current++;
		setService(null);
		setDiscovering(false);
		setError('');
	}, [web.searxngUrl, web.mode]);

	function change(patch: Partial<NonNullable<WebSettings>>) {
		if (readOnly) return;
		onChange({ ...web, ...patch });
		setError('');
	}
	async function discover() {
		if (readOnly || discovering || !desktop?.toolWebDiscover) return;
		const request = ++discoveryRequest.current;
		setDiscovering(true);
		setService(null);
		setError('');
		try {
			const result = await desktop.toolWebDiscover(web.searxngUrl.trim());
			if (mounted.current && discoveryRequest.current === request) setService(result);
		} catch (cause) {
			if (mounted.current && discoveryRequest.current === request)
				setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (mounted.current && discoveryRequest.current === request) setDiscovering(false);
		}
	}
	async function lifecycle(action: 'start' | 'stop') {
		if (readOnly || !native || (action === 'start' && changed)) return;
		const request = ++actionRequest.current;
		actionCount.current++;
		setActions(actionCount.current);
		busyCallback.current(true);
		setError('');
		const observed = generation.current;
		try {
			const result = await (action === 'start' ? desktop!.searchStart!() : desktop!.searchStop!());
			// Events may already describe a newer transition than this request's result.
			if (mounted.current && observed === generation.current) setStatus(result);
		} catch (cause) {
			if (mounted.current && request === actionRequest.current)
				setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			actionCount.current--;
			if (mounted.current) {
				setActions(actionCount.current);
				busyCallback.current(actionCount.current > 0);
			}
		}
	}
	function toggleEngine(name: string, enabled: boolean) {
		const names = new Set(web.engines);
		if (enabled) names.add(name);
		else names.delete(name);
		change({ engines: [...names] });
	}
	const phase = status?.phase;
	const transitioning = phase === 'starting' || phase === 'stopping';
	const canStop = !readOnly && native && (phase === 'running' || phase === 'starting');
	const canStart =
		!readOnly &&
		native &&
		Boolean(status) &&
		web.enabled &&
		!changed &&
		actions === 0 &&
		phase !== 'running' &&
		!transitioning &&
		phase !== 'unavailable';
	const engines = status?.engines ?? [];
	const selected = new Set(web.engines);
	const groups = [
		{
			name: 'Text search',
			engines: engines.filter((engine) => !engine.categories.includes('images')),
		},
		{
			name: 'Image search',
			engines: engines.filter((engine) => engine.categories.includes('images')),
		},
	];
	return (
		<section className="search-settings tool-settings" aria-label="Web browsing">
			{readOnly && (
				<p className="remote-settings-note">
					Search belongs to {workspaceName}. Configure it in Settings on that computer.
				</p>
			)}
			<fieldset className="tool-settings-fields" disabled={readOnly || actions > 0}>
				<SettingsGroup title="Search preferences">
					<SettingsRow
						label="Browse the web in Chat and Code"
						description="Search text and images, and read web pages and PDFs during conversations."
					>
						<Switch
							aria-label="Browse the web in Chat and Code"
							checked={web.enabled}
							disabled={!web.enabled && !builtin && (!web.searxngUrl.trim() || Boolean(urlError))}
							onChange={(enabled) => change({ enabled })}
						/>
					</SettingsRow>
					<SettingsRow
						label="Search service"
						description={
							builtin
								? 'Run SearXNG on this computer. No separate installation.'
								: 'Use a SearXNG service you already run.'
						}
					>
						<div className="search-service-options" role="radiogroup" aria-label="Search service">
							{[
								{ value: 'builtin', title: 'Built-in' },
								{ value: 'external', title: 'External' },
							].map((option) => (
								<button
									key={option.value}
									type="button"
									role="radio"
									aria-label={option.title}
									aria-checked={web.mode === option.value}
									onClick={() => change({ mode: option.value as 'builtin' | 'external' })}
								>
									{option.title}
								</button>
							))}
						</div>
					</SettingsRow>
					{builtin ? (
						<SettingsRow
							label="Start search with FreeLM"
							description="Start the built-in service when FreeLM opens and browsing is enabled."
						>
							<Switch
								aria-label="Start search with FreeLM"
								checked={web.autoStart}
								onChange={(autoStart) => change({ autoStart })}
							/>
						</SettingsRow>
					) : (
						<SettingsRow
							label="SearXNG service URL"
							layout="stacked"
							description={
								<span id={urlId}>
									Enter the base URL or /search endpoint. Enable JSON results in the service’s
									search.formats configuration. Requests run on the selected FreeLM host.
								</span>
							}
						>
							<input
								type="url"
								aria-label="SearXNG service URL"
								aria-describedby={`${urlId}${urlError ? ` ${urlErrorId}` : ''}`}
								aria-invalid={Boolean(urlError)}
								value={web.searxngUrl}
								placeholder="http://localhost:8080"
								spellCheck={false}
								onChange={(event) => change({ searxngUrl: event.target.value })}
							/>
							{urlError && (
								<p className="error-note" id={urlErrorId}>
									{userFacingError(urlError)}
								</p>
							)}
						</SettingsRow>
					)}
				</SettingsGroup>
			</fieldset>
			{builtin ? (
				<>
					<SettingsGroup
						title="Built-in search service"
						className="search-service-status"
						footer={
							changed
								? 'Save your search changes before starting. Saved engine changes restart a running service.'
								: !web.enabled
									? 'Enable browsing and save settings to start search.'
									: undefined
						}
					>
						<SettingsRow
							label={
								<span className="search-status-heading">
									<span className={`search-status-dot ${phase === 'running' ? 'running' : ''}`} />
									<span role="status">
										{readOnly
											? 'Managed on the remote host'
											: !native
												? 'Desktop app required'
												: status
													? phaseLabels[status.phase]
													: 'Checking service…'}
									</span>
								</span>
							}
							description={
								<>
									{status?.version && <span>SearXNG {status.version}</span>}
									{!readOnly && !native && (
										<p>
											The built-in search service is available in the desktop app. You can save your
											configuration here.
										</p>
									)}
									{status?.message && (
										<p
											role={phase === 'error' || phase === 'unavailable' ? 'alert' : undefined}
											className={
												phase === 'error' || phase === 'unavailable' ? 'error-note' : undefined
											}
										>
											{status.message}
										</p>
									)}
									{phase === 'running' && status?.url && <p>Listening on {status.url}</p>}
								</>
							}
						>
							<div className="search-service-actions">
								<button
									className="primary-button"
									type="button"
									disabled={!canStart}
									onClick={() => void lifecycle('start')}
								>
									<Play size={14} />
									Start search
								</button>
								<button
									className="secondary-button"
									type="button"
									disabled={!canStop}
									onClick={() => void lifecycle('stop')}
								>
									<Square size={13} />
									Stop search
								</button>
							</div>
						</SettingsRow>
						{status?.logExcerpt && (
							<SettingsRow layout="stacked">
								<details className="search-service-logs">
									<summary>Service logs</summary>
									<pre>{status.logExcerpt}</pre>
								</details>
							</SettingsRow>
						)}
					</SettingsGroup>
					{engines.length > 0 && (
						<fieldset
							className="search-engine-groups"
							disabled={readOnly || actions > 0 || transitioning}
						>
							<legend>Search engines</legend>
							<p className="settings-help">
								Choose the engines used by the built-in service. Changes apply when you save
								settings.
							</p>
							{groups.map(
								(group) =>
									group.engines.length > 0 && (
										<SettingsGroup title={group.name} key={group.name}>
											{group.engines.map((engine) => (
												<SettingsRow
													label={<strong>{engine.name}</strong>}
													className="search-engine-row"
													key={engine.name}
													description={`${engine.paging ? 'Pagination' : 'Single page'}${engine.timeRangeSupport ? ' · Date hints' : ''}`}
												>
													<Switch
														aria-label={`Enable ${engine.name}`}
														checked={selected.has(engine.name)}
														disabled={selected.has(engine.name) && selected.size === 1}
														onChange={(enabled) => toggleEngine(engine.name, enabled)}
													/>
												</SettingsRow>
											))}
										</SettingsGroup>
									),
							)}
						</fieldset>
					)}
				</>
			) : (
				<SettingsGroup title="External search engines" className="tool-settings-results">
					<SettingsRow
						label="Engine discovery"
						description="Inspect the engines supported by your SearXNG service."
					>
						<button
							className="secondary-button tool-settings-discover"
							type="button"
							disabled={
								readOnly ||
								discovering ||
								!desktop?.toolWebDiscover ||
								!web.searxngUrl.trim() ||
								Boolean(urlError)
							}
							onClick={() => void discover()}
						>
							{discovering ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
							{discovering ? 'Discovering search engines…' : 'Discover search engines'}
						</button>
					</SettingsRow>
					{service && (
						<SettingsRow
							label={
								<span role="status">
									{service.engines.length} search engines discovered
									{service.version ? ` · SearXNG ${service.version}` : ''}
								</span>
							}
							layout="stacked"
						>
							<p>
								{service.health === 'ok'
									? 'Service health check passed.'
									: 'Service health check unavailable.'}{' '}
								Engine discovery does not guarantee that every engine can return search results.
							</p>
							{service.categories.length > 0 && <p>Categories: {service.categories.join(', ')}</p>}
							{service.notices.map((notice, index) => (
								<p key={index}>{notice}</p>
							))}
							<p>
								The model can choose a discovered engine, including engines disabled by default.
								Configure external engine defaults on the service itself.
							</p>
							<EngineDetails engines={service.engines} />
						</SettingsRow>
					)}
				</SettingsGroup>
			)}
			{error && (
				<p className="error-note" role="alert">
					{userFacingError(error)}
				</p>
			)}
		</section>
	);
}
