import Marketplace from './Marketplace';
import PanelHeader from './PanelHeader';
import { IconButton } from './Button';
import SearchField from './SearchField';
import { createPortal } from 'react-dom';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
	ChevronLeft,
	ChevronRight,
	Grid2X2,
	Download,
	MessageCircle,
	Notebook,
	Paperclip,
	Plus,
	Puzzle,
	Search,
	TextSelect,
} from 'lucide-react';
import type { PluginManifest, PluginSnapshot } from '../plugin-types';
import { pluginCatalog } from '../lib/plugin-catalog';
import './plugin-browser.css';

export function PluginIcon({ id }: { id: string }) {
	const icons = {
		'dev.freelm.notebook': [Notebook, 'purple'],
		'dev.freelm.follow-up': [MessageCircle, 'green'],
		'dev.freelm.rewrite-selection': [TextSelect, 'orange'],
		'dev.freelm.attachment-drawer': [Paperclip, 'blue'],
	} as const;
	const [Icon, color] = icons[id as keyof typeof icons] ?? [Puzzle, 'neutral'];
	return (
		<span className={`plugin-browser-icon is-${color}`}>
			<Icon size={25} aria-hidden="true" />
		</span>
	);
}

export default function PluginBrowser({
	enabled,
	sidebarContainer,
	snapshot,
	selectedId,
	onSelect,
	importing,
	onImport,
	onReview,
	onReviewPackage,
	busy,
	loading,
	canInstall,
	children,
}: {
	enabled: boolean;
	sidebarContainer?: HTMLElement | null;
	snapshot: PluginSnapshot;
	selectedId: string | null;
	onSelect: (id: string | null) => void;
	importing: boolean;
	onImport: () => void;
	onReview: (id: string) => void;
	onReviewPackage: (bytes: Uint8Array, revalidate?: () => Promise<void>) => Promise<void>;
	busy: boolean;
	loading: boolean;
	canInstall: boolean;
	children: ReactNode;
}) {
	const [view, setView] = useState<'browse' | 'installed' | 'marketplace'>('browse');
	const [query, setQuery] = useState('');
	const [searchOpen, setSearchOpen] = useState(false);
	const searchButton = useRef<HTMLButtonElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const heading = useRef<HTMLHeadingElement>(null);
	const previous = useRef({ selectedId, importing, view });
	const entries = useRef(new Map<string, HTMLButtonElement>());
	const installed = snapshot.plugins.find((plugin) => plugin.manifest.id === selectedId);
	const example = pluginCatalog.find((plugin) => plugin.id === selectedId);
	const selected = installed?.manifest ?? example;
	const search = query.trim().toLocaleLowerCase();
	const matches = (manifest: PluginManifest) =>
		[manifest.name, manifest.description, manifest.author, manifest.id].some((value) =>
			value?.toLocaleLowerCase().includes(search),
		);
	useEffect(() => {
		const before = previous.current;
		const returning = !selectedId && !importing && before.selectedId;
		const entry = returning ? entries.current.get(returning) : undefined;
		if (entry) {
			// Return keyboard users to the item they opened, retaining the search.
			entry.focus();
		} else {
			content.current?.scrollTo(0, 0);
			if (
				before.selectedId !== selectedId ||
				before.importing !== importing ||
				before.view !== view
			)
				heading.current?.focus({ preventScroll: true });
		}
		previous.current = { selectedId, importing, view };
	}, [selectedId, importing, view]);
	if (!enabled) return <div className="plugin-settings">{children}</div>;
	function navigate(next: typeof view) {
		setView(next);
		onSelect(null);
	}
	function rows(manifests: PluginManifest[]) {
		return (
			<div className="plugin-browser-list">
				{manifests.map((manifest) => {
					const present = snapshot.plugins.some((plugin) => plugin.manifest.id === manifest.id);
					return (
						<button
							key={manifest.id}
							className="plugin-browser-item"
							ref={(element) => {
								if (element) entries.current.set(manifest.id, element);
								else entries.current.delete(manifest.id);
							}}
							onClick={() => onSelect(manifest.id)}
							aria-label={`View ${manifest.name}`}
						>
							<PluginIcon id={manifest.id} />
							<span className="plugin-browser-item-copy">
								<strong>{manifest.name}</strong>
								<span>
									{manifest.author || 'Author not supplied'} · {manifest.version}
								</span>
								<span>{manifest.description}</span>
								{present && <span className="plugin-browser-mobile-status">Installed</span>}
							</span>
							<span className={`plugin-browser-item-action${present ? ' is-installed' : ''}`}>
								{present ? 'Installed' : 'View'}
							</span>
							<ChevronRight className="plugin-browser-item-chevron" size={16} aria-hidden="true" />
						</button>
					);
				})}
			</div>
		);
	}
	const examples = pluginCatalog.filter(matches);
	const ownPlugins = snapshot.plugins.map((plugin) => plugin.manifest).filter(matches);
	const extraPlugins = ownPlugins.filter(
		(plugin) => !pluginCatalog.some((example) => example.id === plugin.id),
	);
	const empty =
		view === 'installed'
			? ownPlugins.length === 0
			: examples.length === 0 && extraPlugins.length === 0;
	return (
		<>
			{sidebarContainer &&
				createPortal(
					<>
						<PanelHeader
							title="Plugins"
							actions={
								<IconButton
									label="Search plugins"
									icon={Search}
									aria-expanded={searchOpen}
									ref={searchButton}
									disabled={busy || importing}
									onClick={() => {
										setSearchOpen(!searchOpen);
										if (searchOpen) setQuery('');
									}}
								/>
							}
						></PanelHeader>
						{searchOpen && (
							<SearchField
								className="sidebar-panel-search"
								autoFocus
								label="Find plugins"
								placeholder="Search plugins"
								value={query}
								disabled={busy || importing}
								onValueChange={(value) => {
									setQuery(value);
									onSelect(null);
								}}
								onKeyDown={(event) => {
									if (event.key === 'Escape') {
										event.stopPropagation();
										setSearchOpen(false);
										setQuery('');
										searchButton.current?.focus();
									}
								}}
							/>
						)}
						<nav className="primary-nav" aria-label="Plugin library">
							<button
								className={view === 'marketplace' ? 'active' : undefined}
								aria-current={view === 'marketplace' ? 'page' : undefined}
								disabled={busy || importing}
								onClick={() => navigate('marketplace')}
							>
								<Grid2X2 size={17} aria-hidden="true" />
								<span>Marketplace</span>
							</button>
							<button
								className={view === 'browse' ? 'active' : undefined}
								aria-current={view === 'browse' ? 'page' : undefined}
								disabled={busy || importing}
								onClick={() => navigate('browse')}
							>
								<Grid2X2 size={17} aria-hidden="true" />
								<span>Browse</span>
							</button>
							<button
								className={view === 'installed' ? 'active' : undefined}
								aria-current={view === 'installed' ? 'page' : undefined}
								disabled={busy || importing}
								onClick={() => navigate('installed')}
							>
								<Download size={17} aria-hidden="true" />
								<span>Installed</span>
							</button>
						</nav>
						<div className="sidebar-scroll">
							{snapshot.plugins.length > 0 && (
								<section className="sidebar-section" aria-label="Installed shortcuts">
									<div className="section-heading">
										<span className="section-label">Installed</span>
									</div>
									{snapshot.plugins.map((plugin) => (
										<div
											key={plugin.manifest.id}
											className={`thread-row${selectedId === plugin.manifest.id ? ' active' : ''}`}
										>
											<button
												className="thread-select"
												aria-current={selectedId === plugin.manifest.id ? 'page' : undefined}
												disabled={busy || importing}
												onClick={() => {
													setView('installed');
													setQuery('');
													onSelect(plugin.manifest.id);
												}}
											>
												<Puzzle size={15} aria-hidden="true" />
												<span>{plugin.manifest.name}</span>
											</button>
										</div>
									))}
								</section>
							)}
						</div>
					</>,
					sidebarContainer,
				)}
			<section className="plugin-browser" aria-label="Plugins">
				<div className="plugin-browser-content" ref={content}>
					<div className="plugin-browser-column">
						{view === 'marketplace' && !importing ? (
							<Marketplace
								type="plugin"
								disabled={!canInstall || busy}
								onReviewPackage={onReviewPackage}
							/>
						) : (
							<>
								{selected && !importing && (
									<button
										className="plugin-browser-back"
										disabled={busy}
										onClick={() => onSelect(null)}
									>
										<ChevronLeft size={16} aria-hidden="true" />
										{view === 'browse' ? 'Browse' : 'Installed'}
									</button>
								)}
								<header className="plugin-browser-header">
									{selected && !importing && <PluginIcon id={selected.id} />}
									<div>
										<h1 ref={heading} tabIndex={-1}>
											{importing
												? 'Install plugin'
												: (selected?.name ??
													(view === 'installed' ? 'Installed plugins' : 'Plugins'))}
										</h1>
										<p>
											{importing
												? 'Review a package or service manifest before installing.'
												: selected
													? selected.author || 'Author not supplied'
													: 'Tools and extensions for your workspace.'}
										</p>
									</div>
									<div className="plugin-browser-header-actions">
										{selected && !importing ? (
											installed ? (
												<span className="plugin-browser-installed" role="status">
													Installed
												</span>
											) : (
												<button
													className="primary-button compact"
													disabled={busy || !canInstall}
													onClick={() => onReview(selected.id)}
												>
													Review install
												</button>
											)
										) : (
											!importing && (
												<button
													className="secondary-button compact"
													disabled={busy || loading || !canInstall}
													onClick={onImport}
												>
													<Plus size={15} aria-hidden="true" />
													Install plugin
												</button>
											)
										)}
									</div>
								</header>
								{selected && !importing && (
									<p className="plugin-browser-description">{selected.description}</p>
								)}
								<div className="plugin-settings">{children}</div>
								{!selected && !importing && !loading && (
									<>
										{empty ? (
											<div className="plugin-browser-empty">
												<Puzzle size={30} aria-hidden="true" />
												<h2>{search ? 'No matching plugins' : 'No plugins installed'}</h2>
												<p>
													{search
														? 'Try a different name, author, or description.'
														: 'Browse the included examples or install a package from a developer you trust.'}
												</p>
												<button
													className="secondary-button"
													onClick={() => {
														setQuery('');
														navigate('browse');
													}}
												>
													{search ? 'Clear search' : 'Browse examples'}
												</button>
											</div>
										) : (
											<>
												{view === 'browse' && examples.length > 0 && (
													<section
														className="plugin-browser-collection"
														aria-label="Included examples"
													>
														<h2>Included examples</h2>
														<p>
															Examples from the FreeLM project. Review permissions before
															installing.
														</p>
														{rows(examples)}
													</section>
												)}
												{(view === 'installed' || extraPlugins.length > 0) && (
													<section
														className="plugin-browser-collection"
														aria-label="Installed plugins"
													>
														<h2>Installed plugins</h2>
														<p>Manage the plugins and accounts on this computer.</p>
														{rows(view === 'installed' ? ownPlugins : extraPlugins)}
													</section>
												)}
											</>
										)}
										<p className="plugin-browser-footer">
											Install a ZIP package or service manifest from a developer you trust.
										</p>
									</>
								)}
							</>
						)}
					</div>
				</div>
			</section>
		</>
	);
}
