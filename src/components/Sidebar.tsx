import PanelHeader from './PanelHeader';
import { IconButton } from './Button';
import {
	LoaderCircle,
	ChevronDown,
	Folder,
	FolderOpen,
	FolderPlus,
	MessageCircleDashed,
	MoreHorizontal,
	Pin,
	Plus,
	Search,
	SquarePen,
	Puzzle,
	Mail,
	Notebook,
	LayoutDashboard,
	Workflow,
} from 'lucide-react';
import type { AppState, ConversationKind, Project, Thread, WorkspaceMode } from '../types';
import {
	memo,
	useCallback,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from 'react';
import { projectKind, threadKind } from '../lib/conversation-kind';
import Select from './Select';
import SidebarActionMenu from './SidebarActionMenu';
import NavigationIcon from './NavigationIcon';
import type { PluginTabChoice } from './usePluginTabs';
import './instances.css';
import './sidebar-running.css';

interface Props {
	/** Workspace-specific content inside the shared navigation rail. */
	panel?: ReactNode;
	pluginTabs?: PluginTabChoice[];
	activePluginTab?: string;
	onPluginTab?: (key: string) => void;
	state: AppState;
	mode: WorkspaceMode;
	collapsed: boolean;
	conversationKind?: ConversationKind;
	settingsOpen?: boolean;
	workflowApprovalCount?: number;
	projectWorkflows?: import('../workflow-types').WorkflowBindingSummary[];
	activeWorkflowBindingId?: string;
	onProjectWorkflow?: (bindingId: string, projectId: string) => void;
	onAddProjectWorkflow?: (projectId: string) => void;
	readOnly?: boolean;
	runningThread?: string | null;
	runningThreads?: ReadonlySet<string>;
	threadId: string | null;
	projectId: string | null;
	onMode: (m: WorkspaceMode) => void;
	onThread: (id: string) => void;
	onNewChat: () => void;
	onTemporaryChat?: () => void;
	onProject: (id: string | null) => void;
	onNewProject: () => void;
	onNewProjectChat?: (project: Project) => void;
	onMoveThread?: (threadId: string, projectId: string | undefined) => void;
	onEditProject: (p: Project) => void;
	onThreadAction: (thread: Thread, action: ThreadAction) => void;
	onSettings: () => void;
	onSearch: () => void;
	workspaceName?: string;
	remote?: boolean;
	onInstances?: () => void;
}

type ThreadAction = 'rename' | 'delete' | 'pin' | 'move' | 'archive';
function canMoveThread(thread: Thread | undefined, props: Props): boolean {
	return (
		!!thread &&
		!props.readOnly &&
		!props.runningThreads?.has(thread.id) &&
		thread.id !== props.runningThread &&
		!!props.onMoveThread &&
		!(threadKind(thread, props.state.projects) === 'code' && thread.messages.length > 0)
	);
}
const SidebarThreadRow = memo(function SidebarThreadRow({
	id,
	title,
	pinned,
	active,
	running,
	menuOpen,
	noun,
	onThread,
	onMenu,
	onAction,
	onDrag,
	draggable,
	canMove,
}: {
	id: string;
	title: string;
	pinned: boolean;
	active: boolean;
	running: boolean;
	menuOpen: boolean;
	noun: 'chat' | 'task';
	onThread: (id: string) => void;
	onMenu: (id: string | null) => void;
	onAction: (id: string, action: ThreadAction) => void;
	onDrag: (id: string | null) => void;
	draggable: boolean;
	canMove: boolean;
}) {
	const trigger = useRef<HTMLButtonElement>(null);
	const closeMenu = useCallback(() => {
		onMenu(null);
		trigger.current?.focus({ preventScroll: true });
	}, [onMenu]);
	return (
		<div
			className={`thread-row ${active ? 'active' : ''} ${menuOpen ? 'menu-open' : ''}`}
			draggable={draggable}
			onContextMenu={(event) => {
				event.preventDefault();
				onMenu(id);
			}}
			onDragStart={(event) => {
				if (!draggable) {
					event.preventDefault();
					return;
				}
				event.dataTransfer.setData('application/x-freelm-thread', id);
				event.dataTransfer.effectAllowed = 'move';
				onDrag(id);
				onMenu(null);
			}}
			onDragEnd={() => onDrag(null)}
		>
			<button
				className="thread-select"
				title={title}
				aria-current={active ? 'page' : undefined}
				onClick={() => onThread(id)}
			>
				{running ? (
					<LoaderCircle size={12} className="spin" aria-label="Responding" />
				) : (
					pinned && <Pin size={12} aria-hidden="true" />
				)}
				<span>{title}</span>
			</button>
			<button
				ref={trigger}
				className="icon-button row-menu"
				aria-label={`Actions for ${title}`}
				title={`Actions for ${title}`}
				aria-haspopup="menu"
				aria-expanded={menuOpen}
				onClick={() => onMenu(menuOpen ? null : id)}
			>
				<MoreHorizontal size={16} aria-hidden="true" />
			</button>
			{menuOpen && (
				<SidebarActionMenu
					anchor={trigger}
					label={`Actions for ${title}`}
					dismissLabel="Close thread actions"
					onClose={closeMenu}
				>
					{(['pin', 'rename', 'move', 'archive', 'delete'] as const).map((action) => (
						<button
							className={action === 'delete' ? 'danger' : ''}
							key={action}
							role="menuitem"
							tabIndex={-1}
							disabled={action === 'move' && !canMove}
							onClick={() => {
								closeMenu();
								onAction(id, action);
							}}
						>
							{action === 'pin'
								? pinned
									? `Unpin ${noun}`
									: `Pin ${noun}`
								: action === 'rename'
									? 'Rename'
									: action === 'move'
										? 'Move to project'
										: action === 'archive'
											? `Archive ${noun}`
											: `Delete ${noun}`}
						</button>
					))}
				</SidebarActionMenu>
			)}
		</div>
	);
});

function SidebarProjectAdd({
	project,
	noun,
	menuOpen,
	onMenu,
	onNew,
	onAddWorkflow,
}: {
	project: Project;
	noun: 'chat' | 'task';
	menuOpen: boolean;
	onMenu: (id: string | null) => void;
	onNew: () => void;
	onAddWorkflow?: () => void;
}) {
	const trigger = useRef<HTMLButtonElement>(null);
	const label = onAddWorkflow ? `Add to ${project.name}` : `New ${noun} in ${project.name}`;
	const closeMenu = useCallback(() => {
		onMenu(null);
		trigger.current?.focus({ preventScroll: true });
	}, [onMenu]);
	return (
		<>
			<button
				ref={trigger}
				className="project-new-chat icon-button small"
				aria-label={label}
				title={label}
				aria-haspopup={onAddWorkflow ? 'menu' : undefined}
				aria-expanded={onAddWorkflow ? menuOpen : undefined}
				onClick={() => {
					if (onAddWorkflow) onMenu(menuOpen ? null : `project:${project.id}`);
					else onNew();
				}}
			>
				<Plus size={15} aria-hidden="true" />
			</button>
			{menuOpen && onAddWorkflow && (
				<SidebarActionMenu
					anchor={trigger}
					label={label}
					dismissLabel="Close project actions"
					onClose={closeMenu}
				>
					<button
						role="menuitem"
						tabIndex={-1}
						onClick={() => {
							closeMenu();
							onNew();
						}}
					>
						New task
					</button>
					<button
						role="menuitem"
						tabIndex={-1}
						onClick={() => {
							closeMenu();
							onAddWorkflow();
						}}
					>
						Add workflow
					</button>
				</SidebarActionMenu>
			)}
		</>
	);
}

export default function Sidebar(p: Props) {
	const [menu, setMenu] = useState<string | null>(null);
	const [collapsedProjects, setCollapsedProjects] = useState<ReadonlySet<string>>(() => new Set());
	const [projectsExpanded, setProjectsExpanded] = useState(true);
	const [recentsExpanded, setRecentsExpanded] = useState(true);
	const [allProjects, setAllProjects] = useState(false);
	const [dropTarget, setDropTarget] = useState<string | null>(null);
	const draggedThread = useRef<string | null>(null);
	const kind = p.mode === 'chat' || p.mode === 'code' ? p.mode : p.conversationKind || 'chat';
	const isCode = kind === 'code';
	const noun = isCode ? 'task' : 'chat';
	const projects = useMemo(
		() => p.state.projects.filter((project) => projectKind(project) === kind),
		[p.state.projects, kind],
	);
	const activeProjectId = projects.some((project) => project.id === p.projectId)
		? p.projectId
		: null;
	const running = p.state.threads.filter(
		(thread) =>
			!thread.archivedAt && (p.runningThreads?.has(thread.id) ?? thread.id === p.runningThread),
	);
	const runningProjects = new Set(running.map((thread) => thread.projectId));
	const visibleProjects = allProjects
		? projects
		: projects.filter(
				(project, index) =>
					index < 5 || project.id === activeProjectId || runningProjects.has(project.id),
			);
	function canDrop(event: React.DragEvent) {
		const id = event.dataTransfer.getData('application/x-freelm-thread') || draggedThread.current;
		return (
			event.dataTransfer.types.includes('application/x-freelm-thread') &&
			canMoveThread(
				p.state.threads.find((thread) => thread.id === id),
				p,
			)
		);
	}
	function dropThread(event: React.DragEvent, projectId?: string) {
		if (!canDrop(event)) return;
		event.preventDefault();
		const id = event.dataTransfer.getData('application/x-freelm-thread') || draggedThread.current;
		draggedThread.current = null;
		setDropTarget(null);
		if (id) p.onMoveThread?.(id, projectId);
	}
	// Rows use display-only props; actions always consult the latest committed thread.
	const handlers = useRef(p);
	useLayoutEffect(() => {
		handlers.current = p;
	});
	useLayoutEffect(() => {
		if (activeProjectId) setProjectsExpanded(true);
	}, [activeProjectId]);
	useLayoutEffect(() => {
		if (!activeProjectId) return;
		setCollapsedProjects((current) => {
			if (!current.has(activeProjectId)) return current;
			const next = new Set(current);
			next.delete(activeProjectId);
			return next;
		});
	}, [activeProjectId, p.threadId]);
	const selectThread = useCallback((id: string) => {
		setMenu(null);
		handlers.current.onThread(id);
	}, []);
	const actOnThread = useCallback((id: string, action: ThreadAction) => {
		const latest = handlers.current;
		const thread = latest.state.threads.find((item) => item.id === id);
		if (thread && (action !== 'move' || canMoveThread(thread, latest)))
			latest.onThreadAction(thread, action);
	}, []);
	const dragThread = useCallback((id: string | null) => {
		draggedThread.current = id;
		if (!id) setDropTarget(null);
	}, []);
	const groupedThreads = useMemo(() => {
		const groups = new Map<string, Thread[]>();
		for (const project of projects) groups.set(project.id, []);
		const recent: Thread[] = [];
		const threads = p.state.threads
			.filter(
				(thread) =>
					!thread.archivedAt && !thread.temporary && threadKind(thread, p.state.projects) === kind,
			)
			.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt);
		for (const thread of threads) {
			const group = thread.projectId ? groups.get(thread.projectId) : undefined;
			if (group) group.push(thread);
			else recent.push(thread);
		}
		return { groups, recent };
	}, [p.state.threads, p.state.projects, projects, kind]);
	function renderThread(thread: Thread) {
		const movable = canMoveThread(thread, p);
		return (
			<SidebarThreadRow
				key={thread.id}
				id={thread.id}
				title={thread.title}
				pinned={!!thread.pinned}
				active={p.threadId === thread.id && p.mode === kind}
				running={p.runningThreads?.has(thread.id) ?? thread.id === p.runningThread}
				noun={noun}
				menuOpen={menu === thread.id}
				onThread={selectThread}
				onMenu={setMenu}
				onAction={actOnThread}
				onDrag={dragThread}
				draggable={movable}
				canMove={movable}
			/>
		);
	}
	return (
		<aside
			className={`sidebar ${p.collapsed ? 'collapsed' : ''} ${p.settingsOpen ? 'settings-rail' : ''}`}
			aria-label="Workspace navigation"
		>
			<div className="navigation-rail">
				<nav className="rail-nav" aria-label="Workspaces">
					<button
						className={`rail-button ${!p.settingsOpen && !p.activePluginTab && p.mode === kind ? 'active' : ''}`}
						aria-label="Home"
						title="Home"
						aria-current={
							!p.settingsOpen && !p.activePluginTab && p.mode === kind ? 'page' : undefined
						}
						onClick={() => {
							setMenu(null);
							p.onMode(kind);
						}}
					>
						<NavigationIcon
							destination="home"
							selected={!p.settingsOpen && !p.activePluginTab && p.mode === kind}
						/>
					</button>
					{(
						[
							['bots', 'Bots'],
							['workflows', 'Workflows'],
							['images', 'Images'],
							['videos', 'Video'],
							['audio', 'Audio'],
							['plugins', 'Plugins'],
						] as const
					).map(([key, label]) => (
						<button
							key={key}
							className={`rail-button ${!p.settingsOpen && !p.activePluginTab && p.mode === key ? 'active' : ''}`}
							aria-label={label}
							title={
								key === 'workflows' && p.workflowApprovalCount
									? `${label} · Approval needed`
									: label
							}
							aria-current={
								!p.settingsOpen && !p.activePluginTab && p.mode === key ? 'page' : undefined
							}
							onClick={() => {
								setMenu(null);
								p.onMode(key);
							}}
						>
							<NavigationIcon
								destination={key}
								selected={!p.settingsOpen && !p.activePluginTab && p.mode === key}
							/>
							{key === 'workflows' && !!p.workflowApprovalCount && (
								<span className="workflow-approval-dot" aria-label="Workflow approval needed" />
							)}
						</button>
					))}
					{p.pluginTabs?.map((choice) => {
						const Icon =
							choice.tab.icon === 'mail'
								? Mail
								: choice.tab.icon === 'notebook'
									? Notebook
									: choice.tab.icon === 'layout'
										? LayoutDashboard
										: Puzzle;
						const selected = !p.settingsOpen && p.activePluginTab === choice.key;
						return (
							<button
								key={choice.key}
								className={`rail-button plugin-rail-button ${selected ? 'active' : ''}`}
								aria-current={selected ? 'page' : undefined}
								aria-label={`${choice.tab.title} · ${choice.plugin.manifest.name}`}
								title={`${choice.tab.title} · ${choice.plugin.manifest.name}`}
								onClick={() => p.onPluginTab?.(choice.key)}
							>
								<Icon
									size={20}
									aria-hidden="true"
									fill={selected ? 'currentColor' : 'none'}
									fillOpacity={selected ? 0.2 : 1}
								/>
							</button>
						);
					})}
				</nav>
				<div className="rail-bottom">
					<button
						className={`rail-button settings-button ${p.settingsOpen ? 'active' : ''}`}
						aria-current={p.settingsOpen ? 'page' : undefined}
						onClick={p.onSettings}
						aria-label="Personal workspace settings"
						title="Settings"
					>
						<NavigationIcon destination="settings" selected={!!p.settingsOpen} />
					</button>
				</div>
			</div>
			{!p.collapsed &&
				(p.panel ?? (
					<div className="sidebar-panel">
						<PanelHeader
							actions={
								<IconButton
									label={isCode ? 'Search tasks' : 'Search chats'}
									icon={Search}
									onClick={p.onSearch}
								/>
							}
						>
							<Select
								className="sidebar-mode-picker"
								aria-label="Conversation mode"
								value={kind}
								options={[
									{ value: 'chat', label: 'Chat', description: 'Learn, explore, and chat' },
									{ value: 'code', label: 'Code', description: 'Work, build, and debug' },
								]}
								onChange={(next) => {
									setMenu(null);
									p.onMode(next as ConversationKind);
								}}
							/>
						</PanelHeader>
						<nav className="primary-nav" aria-label="Conversation actions">
							<button onClick={p.onNewChat} title={isCode ? 'New task' : 'New chat'}>
								<SquarePen size={17} aria-hidden="true" />
								<span>{isCode ? 'New task' : 'New chat'}</span>
							</button>
							{!isCode && p.onTemporaryChat && (
								<button
									onClick={p.onTemporaryChat}
									title="Temporary chats stay out of history and memory"
								>
									<MessageCircleDashed size={17} aria-hidden="true" />
									<span>Temporary chat</span>
								</button>
							)}
						</nav>
						<div className="sidebar-scroll">
							{running.length > 0 && (
								<section
									className="sidebar-section running-section"
									aria-label="Running conversations"
								>
									<div className="section-heading">
										<span className="section-label">Running</span>
									</div>
									{running.map((item) => (
										<button
											key={item.id}
											className={`sidebar-running-thread${p.threadId === item.id && p.mode === threadKind(item, p.state.projects) ? ' active' : ''}`}
											aria-label={`Open running ${threadKind(item, p.state.projects) === 'code' ? 'task' : 'chat'}: ${item.title}`}
											title={`Open running ${threadKind(item, p.state.projects) === 'code' ? 'task' : 'chat'}: ${item.title}`}
											onClick={() => selectThread(item.id)}
										>
											<LoaderCircle size={14} className="spin" aria-hidden="true" />
											<span>{item.title}</span>
											<small>
												{threadKind(item, p.state.projects) === 'code' ? 'Code' : 'Chat'}
											</small>
										</button>
									))}
								</section>
							)}
							<div className="sidebar-section projects-section">
								<div className="section-heading">
									<button
										className="sidebar-section-toggle section-label"
										type="button"
										aria-expanded={projectsExpanded}
										aria-controls="sidebar-projects"
										onClick={() => {
											setMenu(null);
											setDropTarget(null);
											setProjectsExpanded((expanded) => !expanded);
										}}
									>
										<span>Projects</span>
										<ChevronDown size={14} aria-hidden="true" />
									</button>
									<button
										className="icon-button small"
										onClick={p.onNewProject}
										aria-label="New project"
										title="New project"
									>
										<Plus size={15} aria-hidden="true" />
									</button>
								</div>
								<nav
									id="sidebar-projects"
									className="sidebar-section-content"
									hidden={!projectsExpanded}
									aria-label={isCode ? 'Code projects' : 'Chat projects'}
								>
									{visibleProjects.map((project) => {
										const expanded = !collapsedProjects.has(project.id);
										const expandProject = () =>
											setCollapsedProjects((current) => {
												if (!current.has(project.id)) return current;
												const next = new Set(current);
												next.delete(project.id);
												return next;
											});
										return (
											<div className="project-group" key={project.id}>
												<div
													className={`project-row ${activeProjectId === project.id ? 'active' : ''} ${dropTarget === project.id ? 'is-drop-target' : ''}`}
													onDragOver={(event) => {
														if (!canDrop(event)) return;
														event.preventDefault();
														event.dataTransfer.dropEffect = 'move';
														setDropTarget(project.id);
													}}
													onDragLeave={(event) => {
														if (!event.currentTarget.contains(event.relatedTarget as Node | null))
															setDropTarget(null);
													}}
													onDrop={(event) => dropThread(event, project.id)}
												>
													<button
														id={`project-label-${project.id}`}
														className={`project-select ${activeProjectId === project.id ? 'active' : ''}`}
														title={project.name}
														aria-current={activeProjectId === project.id ? 'page' : undefined}
														aria-expanded={expanded}
														aria-controls={`project-threads-${project.id}`}
														onClick={() => {
															setCollapsedProjects((current) => {
																const next = new Set(current);
																if (next.has(project.id)) next.delete(project.id);
																else next.add(project.id);
																return next;
															});
														}}
													>
														{expanded ? (
															<FolderOpen size={16} aria-hidden="true" />
														) : (
															<Folder size={16} aria-hidden="true" />
														)}
														<span>{project.name}</span>
													</button>
													<SidebarProjectAdd
														project={project}
														noun={noun}
														menuOpen={menu === `project:${project.id}`}
														onMenu={setMenu}
														onNew={() => {
															expandProject();
															if (p.onNewProjectChat) p.onNewProjectChat(project);
															else p.onProject(project.id);
														}}
														onAddWorkflow={
															kind === 'code' && !p.remote && p.onAddProjectWorkflow
																? () => {
																		expandProject();
																		p.onAddProjectWorkflow?.(project.id);
																	}
																: undefined
														}
													/>
													<button
														className="row-menu icon-button"
														aria-label={`Edit project ${project.name}`}
														title={`Edit project ${project.name}`}
														onClick={() => p.onEditProject(project)}
													>
														<MoreHorizontal size={15} aria-hidden="true" />
													</button>
												</div>
												<div
													className="project-threads"
													id={`project-threads-${project.id}`}
													aria-labelledby={`project-label-${project.id}`}
													hidden={!expanded}
												>
													{expanded && groupedThreads.groups.get(project.id)?.map(renderThread)}
													{expanded &&
														p.projectWorkflows
															?.filter((binding) => binding.projectId === project.id)
															.map((binding) => (
																<button
																	key={binding.id}
																	className={`project-workflow-row${p.activeWorkflowBindingId === binding.id ? ' active' : ''}`}
																	title={binding.name}
																	aria-current={
																		p.activeWorkflowBindingId === binding.id ? 'page' : undefined
																	}
																	onClick={() => p.onProjectWorkflow?.(binding.id, project.id)}
																>
																	<Workflow size={14} aria-hidden="true" />
																	<span>{binding.name}</span>
																</button>
															))}
												</div>
											</div>
										);
									})}
									{(allProjects || visibleProjects.length < projects.length) &&
										projects.length > 5 && (
											<button
												className="sidebar-show-more"
												onClick={() => setAllProjects((show) => !show)}
											>
												{allProjects ? 'Show fewer projects' : 'Show more projects'}
											</button>
										)}
									{!projects.length && (
										<button className="muted" onClick={p.onNewProject}>
											<FolderPlus size={16} aria-hidden="true" />
											<span>Create a project</span>
										</button>
									)}
								</nav>
							</div>
							<div
								className={`sidebar-section history-section ${dropTarget === 'recents' ? 'is-drop-target' : ''}`}
								onDragOver={(event) => {
									if (!canDrop(event)) return;
									event.preventDefault();
									setDropTarget('recents');
								}}
								onDragLeave={() => setDropTarget(null)}
								onDrop={(event) => dropThread(event)}
							>
								<div className="section-heading">
									<button
										className="sidebar-section-toggle section-label"
										type="button"
										aria-expanded={recentsExpanded}
										aria-controls="sidebar-recents"
										onClick={() => {
											setMenu(null);
											setDropTarget(null);
											setRecentsExpanded((expanded) => !expanded);
										}}
									>
										<span>Recents</span>
										<ChevronDown size={14} aria-hidden="true" />
									</button>
								</div>
								<div
									id="sidebar-recents"
									className="history-list sidebar-section-content"
									hidden={!recentsExpanded}
								>
									{groupedThreads.recent.length ? (
										groupedThreads.recent.map(renderThread)
									) : (
										<p className="empty-history">
											{isCode
												? 'Your recent tasks will appear here.'
												: 'Your recent chats will appear here.'}
										</p>
									)}
								</div>
							</div>
						</div>
					</div>
				))}
		</aside>
	);
}
