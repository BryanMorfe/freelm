import { userFacingError } from '../lib/user-facing-error';
import { useEffect, useMemo, useRef, useState } from 'react';
import { LoaderCircle, Puzzle, RefreshCw } from 'lucide-react';
import type { PluginAccount, PluginBridge } from '../plugin-types';
import type { PluginTabChoice } from './usePluginTabs';
import Select from './Select';
import './plugin-workspace.css';

const protocol = 'freelm-plugin-ui-v1';
interface Props {
	choice: PluginTabChoice;
	accounts: PluginAccount[];
	onSettings: () => void;
	bridge?: Pick<PluginBridge, 'pluginTabContent' | 'pluginInvokeAction'>;
}

function PluginFrame({
	html,
	url,
	nonce,
	choice,
	accountId,
	bridge,
	theme,
}: {
	html: string;
	url?: string;
	nonce: string;
	choice: PluginTabChoice;
	accountId: string;
	bridge: NonNullable<Props['bridge']>;
	theme: string;
}) {
	const frame = useRef<HTMLIFrameElement>(null);
	const source = useMemo(
		() =>
			html
				.replaceAll('__FREELM_PLUGIN_CHANNEL__', nonce)
				.replaceAll('__FREELM_PLUGIN_THEME__', theme),
		[html, nonce, theme],
	);
	useEffect(() => {
		let current = true;
		const pending = new Set<string>();
		const receive = (event: MessageEvent) => {
			const target = frame.current?.contentWindow;
			if (!target || event.source !== target || !event.data || typeof event.data !== 'object')
				return;
			const message = event.data;
			if (
				message.protocol !== protocol ||
				message.nonce !== nonce ||
				typeof message.id !== 'string' ||
				message.id.length > 128 ||
				!message.id
			)
				return;
			const reply = (payload: { result: unknown } | { error: string }) => {
				if (current && target === frame.current?.contentWindow)
					target.postMessage({ protocol, nonce, id: message.id, ...payload }, '*');
			};
			if (pending.has(message.id)) return;
			if (pending.size >= 16) {
				reply({ error: 'Too many pending plugin actions.' });
				return;
			}
			if (
				typeof message.action !== 'string' ||
				!choice.plugin.manifest.contributes.actions.includes(message.action)
			) {
				reply({ error: 'This action was not declared by this plugin.' });
				return;
			}
			let args: Record<string, unknown>;
			try {
				if (
					message.args === null ||
					typeof message.args !== 'object' ||
					Array.isArray(message.args)
				)
					throw new Error();
				const encoded = JSON.stringify(message.args);
				if (encoded.length > 64_000) throw new Error();
				args = JSON.parse(encoded);
			} catch {
				reply({ error: 'Plugin action arguments must be a JSON object smaller than 64 KB.' });
				return;
			}
			pending.add(message.id);
			void bridge.pluginInvokeAction!(
				choice.plugin.manifest.id,
				choice.tab.id,
				accountId,
				message.action,
				args,
			)
				.then((result) => reply({ result }))
				.catch((failure) =>
					reply({
						error: failure instanceof Error ? failure.message : 'The plugin action failed.',
					}),
				)
				.finally(() => pending.delete(message.id));
		};
		window.addEventListener('message', receive);
		return () => {
			current = false;
			window.removeEventListener('message', receive);
		};
	}, [nonce, bridge, choice, accountId]);
	return (
		<iframe
			ref={frame}
			title={`${choice.plugin.manifest.name}: ${choice.tab.title}`}
			className="plugin-workspace-frame"
			sandbox="allow-scripts"
			referrerPolicy="no-referrer"
			src={url}
			srcDoc={url ? undefined : source}
		/>
	);
}

export default function PluginWorkspace({
	choice,
	accounts,
	onSettings,
	bridge = window.desktop,
}: Props) {
	const available = accounts.filter(
		(account) => account.pluginId === choice.plugin.manifest.id && account.status === 'connected',
	);
	const [selected, setSelected] = useState('');
	const accountId =
		available.find((account) => account.id === selected)?.id || available[0]?.id || '';
	const [viewDocument, setViewDocument] = useState<{
		html: string;
		url?: string;
		nonce: string;
		viewKey: string;
	} | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState('');
	const [revision, setRevision] = useState(0);
	const [theme, setTheme] = useState<'light' | 'dark'>(() =>
		window.document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
	);
	const viewKey = `${choice.key}:${choice.plugin.package?.hash}:${accountId}:${theme}:${revision}`;
	useEffect(() => {
		const refreshTheme = () =>
			setTheme(window.document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
		refreshTheme();
		const observer = new MutationObserver(refreshTheme);
		observer.observe(window.document.documentElement, {
			attributes: true,
			attributeFilter: ['data-theme'],
		});
		return () => observer.disconnect();
	}, []);
	useEffect(() => {
		let current = true;
		setViewDocument(null);
		setError('');
		setLoading(true);
		if (!bridge?.pluginTabContent || !bridge.pluginInvokeAction) {
			setError('Plugin tabs require the updated FreeLM desktop app.');
			setLoading(false);
			return;
		}
		if (!accountId) {
			setLoading(false);
			return;
		}
		const nonce = crypto.randomUUID();
		bridge
			.pluginTabContent(choice.plugin.manifest.id, choice.tab.id, { nonce, theme })
			.then((content) => {
				if (current) setViewDocument({ ...content, nonce, viewKey });
			})
			.catch((failure) => {
				if (current)
					setError(failure instanceof Error ? failure.message : 'Could not open this plugin.');
			})
			.finally(() => {
				if (current) setLoading(false);
			});
		return () => {
			current = false;
		};
	}, [
		bridge,
		choice.plugin.manifest.id,
		choice.plugin.package?.hash,
		choice.tab.id,
		accountId,
		theme,
		revision,
		viewKey,
	]);
	return (
		<section className="plugin-workspace" aria-label={`${choice.plugin.manifest.name} plugin`}>
			<header className="plugin-workspace-toolbar">
				<div>
					<h1>{choice.tab.title}</h1>
					<span>{choice.plugin.manifest.name}</span>
				</div>
				<div className="plugin-workspace-actions">
					{available.length > 0 && (
						<Select
							aria-label="Plugin account"
							value={accountId}
							onChange={setSelected}
							options={available.map((account) => ({ value: account.id, label: account.label }))}
						/>
					)}
					<button
						className="icon-button"
						title="Reload plugin"
						aria-label="Reload plugin"
						onClick={() => setRevision((value) => value + 1)}
						disabled={loading}
					>
						<RefreshCw size={16} />
					</button>
					<button className="secondary-button compact" onClick={onSettings}>
						Manage plugin
					</button>
				</div>
			</header>
			{loading || (viewDocument !== null && viewDocument.viewKey !== viewKey) ? (
				<div className="plugin-workspace-placeholder" role="status">
					<LoaderCircle size={22} className="spin" />
					Opening plugin…
				</div>
			) : error ? (
				<div className="plugin-workspace-placeholder" role="alert">
					<p>{userFacingError(error)}</p>
					<button className="secondary-button" onClick={() => setRevision((value) => value + 1)}>
						Try again
					</button>
				</div>
			) : !accountId ? (
				<div className="plugin-workspace-placeholder">
					<Puzzle size={28} />
					<h2>Connect an account to get started</h2>
					<p>Add a labeled account for {choice.plugin.manifest.name} in Settings → Plugins.</p>
					<button className="primary-button" onClick={onSettings}>
						Open plugin settings
					</button>
				</div>
			) : (
				viewDocument &&
				bridge?.pluginInvokeAction && (
					<PluginFrame
						key={viewDocument.nonce}
						html={viewDocument.html}
						url={viewDocument.url}
						nonce={viewDocument.nonce}
						choice={choice}
						accountId={accountId}
						bridge={bridge}
						theme={theme}
					/>
				)
			)}
		</section>
	);
}
