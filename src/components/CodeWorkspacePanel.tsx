import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { File, FileDiff, FolderOpen, Globe, Maximize2, Minimize2, Plus, X } from 'lucide-react';
import type { Attachment, Thread } from '../types';
import type { SurfaceExecute, SurfaceSearch } from './CodeFilePanel';
const WorkspaceFiles = lazy(() =>
	import('./CodeFilePanel').then((module) => ({ default: module.WorkspaceFiles })),
);
import type { useCodeWorkspaceTabs } from './useCodeWorkspaceTabs';
import './code-workspace-panel.css';

const CodeFilePanel = lazy(() => import('./CodeFilePanel'));
const CodeChangesPanel = lazy(() => import('./CodeChangesPanel'));
const CodeBrowserPanel = lazy(() => import('./CodeBrowserPanel'));

export default function CodeWorkspacePanel({
	tabs,
	workspaceId,
	projectId,
	thread,
	visible,
	prepare,
	onAttach,
}: {
	tabs: ReturnType<typeof useCodeWorkspaceTabs>;
	workspaceId: string;
	projectId?: string;
	thread?: Thread;
	visible: boolean;
	prepare: () => Promise<void>;
	onAttach: (text: string, files: Attachment[]) => void;
}) {
	const [menu, setMenu] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);
	const prepareRef = useRef(prepare);
	prepareRef.current = prepare;
	const execute = useCallback<SurfaceExecute>(
		async (request) => {
			if (!window.desktop?.codeSurface)
				throw new Error('Workspace files require an updated FreeLM desktop host.');
			await prepareRef.current();
			let path = request.path;
			if (path && !path.startsWith('/')) {
				const roots = await window.desktop.codeSurface({
					action: 'list',
					workspaceId,
					projectId,
					threadId: thread?.id,
				});
				if (roots.kind !== 'list' || !roots.roots.length)
					throw new Error('Choose a workspace directory to open this file.');
				path = `${roots.roots[0].path}/${path}`;
			}
			return window.desktop.codeSurface({
				...request,
				...(path ? { path } : {}),
				workspaceId,
				projectId,
				threadId: thread?.id,
			});
		},
		[workspaceId, projectId, thread?.id],
	);
	const search = useCallback<SurfaceSearch>(
		async (query) => {
			if (!window.desktop?.composerDiscover)
				throw new Error('Update the desktop host to search workspace files.');
			await prepareRef.current();
			return window.desktop.composerDiscover({
				workspaceId,
				projectId,
				threadId: thread?.id,
				conversationKind: 'code',
				kind: 'files',
				query,
			});
		},
		[workspaceId, projectId, thread?.id],
	);
	useEffect(() => {
		if (!menu) return;
		const outside = (e: PointerEvent) => {
			if (e.target instanceof Node && !menuRef.current?.contains(e.target)) setMenu(false);
		};
		const escape = (e: KeyboardEvent) => {
			if (e.key === 'Escape') setMenu(false);
		};
		document.addEventListener('pointerdown', outside);
		document.addEventListener('keydown', escape);
		return () => {
			document.removeEventListener('pointerdown', outside);
			document.removeEventListener('keydown', escape);
		};
	}, [menu]);
	return (
		<section
			className="code-workspace-panel"
			role="region"
			aria-label="Code workspace tabs"
			hidden={!visible}
		>
			<header className="code-workspace-tabbar">
				<div className="code-workspace-tabs" role="tablist" aria-label="Workspace tabs">
					{tabs.tabs.map((tab) => {
						const Icon =
							tab.kind === 'browser'
								? Globe
								: tab.kind === 'changes'
									? FileDiff
									: tab.kind === 'files'
										? FolderOpen
										: File;
						return (
							<div
								key={tab.id}
								className={`code-workspace-tab${tabs.active === tab.id ? ' selected' : ''}`}
							>
								<button
									role="tab"
									aria-selected={tabs.active === tab.id}
									aria-controls={`workspace-tab-${tab.id}`}
									onClick={() => tabs.select(tab.id)}
									title={tab.path || tab.title}
								>
									<Icon size={14} />
									<span>{tab.title}</span>
								</button>
								<button
									className="icon-button"
									aria-label={`Close ${tab.title} tab`}
									onClick={() => {
										if (tab.kind === 'browser') {
											void import('./CodeBrowserPanel').then((module) =>
												module.forgetCodeBrowserTab(tab.id),
											);
											void window.desktop
												?.codeBrowser?.({ action: 'close', tabId: tab.id })
												.catch(() => {});
										}
										tabs.close(tab.id);
									}}
								>
									<X size={13} />
								</button>
							</div>
						);
					})}
				</div>
				<div className="code-workspace-add" ref={menuRef}>
					<button
						className="icon-button"
						aria-label="New workspace tab"
						aria-expanded={menu}
						onClick={() => setMenu((v) => !v)}
					>
						<Plus size={16} />
					</button>
					{menu && (
						<div className="code-workspace-menu" role="menu">
							{(['files', 'browser', 'changes'] as const).map((kind) => (
								<button
									role="menuitem"
									key={kind}
									disabled={tabs.tabs.length >= 12}
									onClick={() => {
										tabs.add(kind);
										setMenu(false);
									}}
								>
									{kind === 'files' ? (
										<FolderOpen size={16} />
									) : kind === 'browser' ? (
										<Globe size={16} />
									) : (
										<FileDiff size={16} />
									)}
									{kind === 'files' ? 'Files' : kind === 'browser' ? 'Browser' : 'Changes'}
								</button>
							))}
							<button
								role="menuitem"
								disabled={tabs.tabs.length >= 12}
								onClick={() => {
									tabs.add('browser');
									tabs.setExpanded(true);
									setMenu(false);
								}}
							>
								<Maximize2 size={16} />
								New tab in full screen
							</button>
							{tabs.tabs.length >= 12 && <p>Close a tab to open another (12 maximum).</p>}
						</div>
					)}
				</div>
				<button
					className="icon-button"
					aria-label={tabs.expanded ? 'Restore split view' : 'Expand workspace tabs'}
					onClick={() => tabs.setExpanded(!tabs.expanded)}
				>
					{tabs.expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
				</button>
			</header>
			{tabs.notice && (
				<p className="code-surface-notice" role="status">
					{tabs.notice}
				</p>
			)}
			<div className="code-workspace-tab-content">
				{tabs.tabs.map((tab) => (
					<div
						key={tab.id}
						id={`workspace-tab-${tab.id}`}
						role="tabpanel"
						aria-label={tab.title}
						hidden={tabs.active !== tab.id}
					>
						<Suspense fallback={<p className="code-surface-notice">Opening…</p>}>
							{tab.kind === 'files' ? (
								<WorkspaceFiles
									search={search}
									execute={execute}
									onOpen={(path) => tabs.actions.openFile(path)}
								/>
							) : tab.kind === 'file' ? (
								<CodeFilePanel path={tab.path!} line={tab.line} search={search} execute={execute} />
							) : tab.kind === 'changes' ? (
								<CodeChangesPanel
									execute={execute}
									calls={tab.threadId === thread?.id ? tab.calls : undefined}
									thread={thread}
								/>
							) : (
								<CodeBrowserPanel
									tabId={tab.id}
									scope={tabs.scope}
									active={visible && tabs.active === tab.id}
									suspended={menu}
									initialUrl={tab.url}
									onLocation={(url) => tabs.setBrowserUrl(tab.id, url)}
									onTitle={(title) => tabs.rename(tab.id, title)}
									onAttach={onAttach}
								/>
							)}
						</Suspense>
					</div>
				))}
			</div>
		</section>
	);
}

export function CodeWorkspaceResize({
	onChange,
	value,
}: {
	onChange: (value: number) => void;
	value: number;
}) {
	return (
		<div
			className="code-workspace-resize"
			role="separator"
			aria-label="Resize workspace tabs"
			aria-orientation="vertical"
			aria-valuemin={30}
			aria-valuemax={75}
			aria-valuenow={Math.round(value)}
			tabIndex={0}
			onKeyDown={(e) => {
				if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
					e.preventDefault();
					onChange(Math.max(30, Math.min(75, value + (e.key === 'ArrowLeft' ? 2 : -2))));
				}
			}}
			onPointerDown={(e) => {
				const target = e.currentTarget;
				target.setPointerCapture(e.pointerId);
				const bounds = target.parentElement!.getBoundingClientRect();
				const move = (event: PointerEvent) =>
					onChange(
						Math.max(30, Math.min(75, ((bounds.right - event.clientX) / bounds.width) * 100)),
					);
				const end = () => {
					target.removeEventListener('pointermove', move);
					target.removeEventListener('pointerup', end);
					target.removeEventListener('lostpointercapture', end);
					document.body.classList.remove('resizing-workspace');
				};
				document.body.classList.add('resizing-workspace');
				target.addEventListener('pointermove', move);
				target.addEventListener('pointerup', end);
				target.addEventListener('lostpointercapture', end);
			}}
		/>
	);
}
