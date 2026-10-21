import { userFacingError } from '../lib/user-facing-error';
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type CSSProperties,
	type PointerEvent as ReactPointerEvent,
	type ReactNode,
} from 'react';
import {
	ArrowDownToLine,
	ArrowRight,
	AudioLines,
	Bell,
	Bot,
	Braces,
	Check,
	CheckCircle2,
	Circle,
	Clock3,
	Copy,
	FileCode2,
	FileInput,
	FlaskConical,
	Database,
	FolderOpen,
	GitBranch,
	Image,
	Layers3,
	List,
	LoaderCircle,
	Maximize2,
	MessageSquare,
	Minus,
	MousePointer2,
	PanelRightClose,
	PanelRightOpen,
	Pause,
	Play,
	Plus,
	Redo2,
	Repeat2,
	RotateCcw,
	Search,
	Settings2,
	SlidersHorizontal,
	Square,
	Trash2,
	Undo2,
	Video,
	Workflow,
	Wrench,
	X,
	Zap,
	type LucideIcon,
} from 'lucide-react';
import type { Connection, ModelKind, Project } from '../types';
import type {
	WorkflowCommand,
	WorkflowDataType,
	WorkflowDefinition,
	WorkflowEdge,
	WorkflowNode,
	WorkflowNodeRun,
	WorkflowNodeType,
	WorkflowRun,
	WorkflowSnapshot,
} from '../workflow-types';
import {
	compatibleWorkflowPorts,
	createWorkflow,
	createWorkflowNode,
	WORKFLOW_CATALOG,
	WORKFLOW_NODE_MAP,
	WORKFLOW_PORT_COLORS,
	WORKFLOW_TEMPLATES,
	workflowId,
	type WorkflowField,
} from '../lib/workflow-catalog';
import { createResearchWorkflows } from '../lib/workflow-research';
import Select from './Select';
import Switch from './Switch';
import { SettingsGroup, SettingsRow } from './SettingsList';
import {
	WorkflowProjectHome,
	WorkflowProjectView,
	WorkflowRequestComposer,
	WorkflowRequestSettings,
} from './WorkflowProjectView';
import { normalizeWorkflowInputs } from '../lib/workflow-inputs';
import './workflows.css';

const icons: Record<WorkflowNodeType, LucideIcon> = {
	entry: Play,
	schedule: Clock3,
	event: Zap,
	text: MessageSquare,
	agent: Bot,
	image: Image,
	video: Video,
	audio: AudioLines,
	transcribe: AudioLines,
	tool: Wrench,
	code: FileCode2,
	thread: MessageSquare,
	condition: GitBranch,
	foreach: List,
	join: Layers3,
	repeat: Repeat2,
	loop: RotateCcw,
	wait: Pause,
	subworkflow: Workflow,
	value: Braces,
	context: FolderOpen,
	transform: SlidersHorizontal,
	'media-transform': Image,
	state: Layers3,
	collection: Database,
	output: ArrowDownToLine,
	save: FolderOpen,
	notify: Bell,
};
const emptySnapshot: WorkflowSnapshot = { version: 1, hostId: 'local', workflows: [], runs: [] };
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
const stringify = (value: unknown) =>
	typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? '');
const activeRun = (run?: WorkflowRun) =>
	!!run && ['queued', 'running', 'waiting'].includes(run.status);
const nodeHeight = (node: WorkflowNode) =>
	109 +
	Math.max(
		WORKFLOW_NODE_MAP[node.type].inputs.length,
		WORKFLOW_NODE_MAP[node.type].outputs.length,
	) *
		27;
const modelKind = (type: WorkflowNodeType): ModelKind =>
	type === 'image'
		? 'images'
		: type === 'video'
			? 'videos'
			: type === 'audio'
				? 'speech'
				: type === 'transcribe'
					? 'transcription'
					: 'chat';
const modelTypes: WorkflowNodeType[] = ['text', 'agent', 'image', 'video', 'audio', 'transcribe'];
const defaultThinking = (connection: Connection | undefined, modelId: string) => {
	const model = connection?.catalog?.find((item) => item.id === modelId);
	return (
		model?.thinkingModes.find((item) => item.id === model.defaultThinkingMode)?.id ??
		model?.thinkingModes[0]?.id ??
		''
	);
};
const style = (values: Record<string, string | number>) => values as CSSProperties;

export interface WorkflowsWorkspaceOptions {
	projects?: Project[];
	projectId?: string;
	selectedBindingId?: string;
	onSelectBinding?: (bindingId?: string) => void;
	onSelectProject?: (projectId?: string) => void;
}
export function useWorkflowsWorkspace(
	enabled: boolean,
	connections: Connection[],
	options: WorkflowsWorkspaceOptions = {},
) {
	const [snapshot, setSnapshot] = useState<WorkflowSnapshot>(emptySnapshot);
	const [selectedId, setSelectedId] = useState<string>();
	const [localBindingId, setLocalBindingId] = useState<string>();
	const [localProjectId, setLocalProjectId] = useState<string>();
	const [editingBinding, setEditingBinding] = useState(false);
	const [showAddProject, setShowAddProject] = useState(false);
	const [editorGeneration, setEditorGeneration] = useState(0);
	const bindingId = options.onSelectBinding ? options.selectedBindingId : localBindingId;
	const projectId = options.onSelectProject ? options.projectId : localProjectId;
	const projects = options.projects ?? snapshot.projects ?? [];
	const bindings = snapshot.bindings ?? [];
	const selectedBinding = bindings.find((item) => item.id === bindingId);
	const project = projects.find((item) => item.id === (selectedBinding?.projectId ?? projectId));
	const openBinding = useCallback(
		(id?: string) => {
			setEditingBinding(false);
			setSelectedId(undefined);
			setLocalBindingId(id);
			options.onSelectBinding?.(id);
		},
		[options.onSelectBinding],
	);
	const openProject = useCallback(
		(id: string) => {
			setLocalProjectId(id);
			openBinding(undefined);
			options.onSelectProject?.(id);
		},
		[openBinding, options.onSelectProject],
	);
	useEffect(() => {
		setEditingBinding(false);
	}, [bindingId]);
	const openLibrary = () => {
		setLocalProjectId(undefined);
		openBinding(undefined);
		options.onSelectProject?.(undefined);
	};
	const [search, setSearch] = useState('');
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState('');
	const [saving, setSaving] = useState(false);
	const [busy, setBusy] = useState(false);
	const pending = useRef(
		new Map<
			string,
			{
				workflow: WorkflowDefinition;
				bindingId?: string;
				expectedRevision?: number;
				timer?: ReturnType<typeof setTimeout>;
			}
		>(),
	);
	const commandQueue = useRef<Promise<void>>(Promise.resolve());
	const activeSave = useRef<Promise<void> | null>(null);
	const reading = useRef(false);
	const readScope = useRef<{ bindingId?: string; projectId?: string }>({});
	readScope.current = bindingId ? { bindingId } : projectId ? { projectId } : {};
	const readAgain = useRef(false);
	const snapshotGeneration = useRef(0);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			for (const draft of pending.current.values()) clearTimeout(draft.timer);
		};
	}, []);
	const apply = useCallback((next: WorkflowSnapshot) => {
		if (!mounted.current) return;
		setSnapshot((previous) => ({
			...next,
			tools: next.tools ?? previous.tools,
			skills: next.skills ?? previous.skills,
			connections: next.connections ?? previous.connections,
			bindings: next.bindings?.map((binding) => ({
				...binding,
				workflowSnapshot:
					pending.current.get(`binding:${binding.id}`)?.workflow ?? binding.workflowSnapshot,
			})),
			workflows: next.workflows.map(
				(workflow) => pending.current.get(workflow.id)?.workflow ?? workflow,
			),
		}));
	}, []);
	const command = useCallback(
		(value: WorkflowCommand): Promise<WorkflowSnapshot> => {
			let result: WorkflowSnapshot = emptySnapshot;
			const work = commandQueue.current
				.catch(() => {})
				.then(async () => {
					if (!window.desktop?.workflowCommand)
						throw new Error('Open the updated FreeLM desktop app to run workflows.');
					snapshotGeneration.current++;
					result = await window.desktop.workflowCommand(value);
					snapshotGeneration.current++;
					apply(result);
				});
			// Keep ordering separate from each operation's result. A surfaced failure
			// must not reject every later command.
			commandQueue.current = work.catch(() => {});
			return work.then(() => result);
		},
		[apply],
	);
	const flushDrafts = useCallback(
		async function flush(): Promise<void> {
			// A dependent action must observe an in-flight save's actual outcome,
			// even though the command sequencing barrier always settles.
			if (activeSave.current) {
				await activeSave.current;
				return flush();
			}
			const work = (async () => {
				const drafts = [...pending.current.values()];
				for (const draft of drafts) clearTimeout(draft.timer);
				pending.current.clear();
				if (drafts.length) setSaving(true);
				let savedCount = 0;
				try {
					for (const draft of drafts) {
						const result = await command(
							draft.bindingId
								? {
										type: 'update-binding',
										bindingId: draft.bindingId,
										workflow: draft.workflow,
										name: draft.workflow.name,
										expectedRevision: draft.expectedRevision,
									}
								: { type: 'save', workflow: draft.workflow },
						);
						if (draft.bindingId) {
							const next = pending.current.get(`binding:${draft.bindingId}`);
							const saved = result.bindings?.find((binding) => binding.id === draft.bindingId);
							if (next && saved && next.expectedRevision === draft.expectedRevision)
								next.expectedRevision = saved.revision;
						}
						savedCount++;
					}
					await commandQueue.current;
					if (drafts.length) setError('');
				} catch (failure) {
					for (const draft of drafts.slice(savedCount)) {
						const key = draft.bindingId ? `binding:${draft.bindingId}` : draft.workflow.id;
						if (!pending.current.has(key))
							pending.current.set(key, {
								workflow: draft.workflow,
								bindingId: draft.bindingId,
								expectedRevision: draft.expectedRevision,
							});
					}
					setSnapshot((previous) => ({
						...previous,
						bindings: previous.bindings?.map((binding) => ({
							...binding,
							workflowSnapshot:
								pending.current.get(`binding:${binding.id}`)?.workflow ?? binding.workflowSnapshot,
						})),
						workflows: previous.workflows.map(
							(workflow) => pending.current.get(workflow.id)?.workflow ?? workflow,
						),
					}));
					setError(`Changes could not be saved: ${errorMessage(failure)}`);
					throw failure;
				} finally {
					if (mounted.current) setSaving(pending.current.size > 0);
				}
			})();
			activeSave.current = work;
			try {
				await work;
			} finally {
				if (activeSave.current === work) activeSave.current = null;
			}
		},
		[command],
	);
	const change = useCallback(
		(workflow: WorkflowDefinition) => {
			setSaving(true);
			const previous = pending.current.get(workflow.id);
			if (previous) clearTimeout(previous.timer);
			pending.current.set(workflow.id, {
				workflow,
				timer: setTimeout(() => {
					void flushDrafts().catch(() => {});
				}, 550),
			});
			setSnapshot((old) => ({
				...old,
				workflows: old.workflows.map((item) => (item.id === workflow.id ? workflow : item)),
			}));
		},
		[flushDrafts],
	);
	const changeProjectWorkflow = useCallback(
		(workflow: WorkflowDefinition) => {
			if (!bindingId) return;
			setSaving(true);
			const key = `binding:${bindingId}`;
			const previous = pending.current.get(key);
			clearTimeout(previous?.timer);
			pending.current.set(key, {
				workflow,
				bindingId,
				expectedRevision: previous?.expectedRevision ?? selectedBinding?.revision,
				timer: setTimeout(() => {
					void flushDrafts().catch(() => {});
				}, 550),
			});
			setSnapshot((previous) => ({
				...previous,
				bindings: previous.bindings?.map((binding) =>
					binding.id === bindingId ? { ...binding, workflowSnapshot: workflow } : binding,
				),
			}));
		},
		[bindingId, selectedBinding?.revision, flushDrafts],
	);
	const refresh = useCallback(async () => {
		if (reading.current) {
			readAgain.current = true;
			return;
		}
		if (!window.desktop?.workflowSnapshot) {
			setError('Open the updated FreeLM desktop app to edit and run workflows.');
			setLoading(false);
			return;
		}
		reading.current = true;
		try {
			do {
				readAgain.current = false;
				const generation = snapshotGeneration.current;
				const scope = readScope.current;
				const next = await window.desktop.workflowSnapshot(scope);
				if (
					generation === snapshotGeneration.current &&
					scope.bindingId === readScope.current.bindingId &&
					scope.projectId === readScope.current.projectId
				)
					apply(next);
				else readAgain.current = true;
			} while (readAgain.current && mounted.current);
		} catch (failure) {
			setError(errorMessage(failure));
		} finally {
			reading.current = false;
			if (mounted.current) setLoading(false);
		}
	}, [apply]);
	useEffect(() => {
		if (!enabled) return;
		setLoading(true);
		void refresh();
		let eventTimer: ReturnType<typeof setTimeout> | undefined;
		const unsubscribe = window.desktop?.onWorkflowsChanged?.(() => {
			if (eventTimer) return;
			eventTimer = setTimeout(() => {
				eventTimer = undefined;
				void refresh();
			}, 100);
		});
		const timer = setInterval(() => {
			if (document.visibilityState !== 'hidden') void refresh();
		}, 2000);
		return () => {
			clearInterval(timer);
			clearTimeout(eventTimer);
			unsubscribe?.();
		};
	}, [enabled, refresh, bindingId, projectId]);
	const act = useCallback(
		async (value: WorkflowCommand) => {
			setBusy(true);
			setError('');
			try {
				await flushDrafts();
				return await command(value);
			} catch (failure) {
				setError(errorMessage(failure));
				return undefined;
			} finally {
				setBusy(false);
			}
		},
		[command, flushDrafts],
	);
	const hostConnections = snapshot.connections ?? connections;
	const create = useCallback(
		async (template = 'blank') => {
			if (template === 'research-team' || template === 'co-scientist') {
				try {
					const catalog = await act({ type: 'catalog' });
					if (!catalog) return;
					const tools = (catalog.tools ?? [])
						.filter((tool) => tool.name === 'web.run')
						.map((tool) => tool.name);
					const bundle = createResearchWorkflows(hostConnections, { kind: template, tools });
					for (const workflow of bundle.workflows) {
						if (!(await act({ type: 'save', workflow }))) return;
					}
					setSelectedId(bundle.primaryId);
				} catch (failure) {
					setError(errorMessage(failure));
				}
				return;
			}
			const workflow = createWorkflow(template);
			for (const node of workflow.nodes)
				if (modelTypes.includes(node.type) && hostConnections[0]) {
					node.config.connectionId = hostConnections[0].id;
					node.config.model = hostConnections[0].models[modelKind(node.type)];
					node.config.thinkingMode = defaultThinking(hostConnections[0], String(node.config.model));
				}
			const result = await act({ type: 'save', workflow });
			if (result) setSelectedId(workflow.id);
		},
		[act, hostConnections],
	);
	const addToProject = useCallback(
		async (workflowId: string, targetProjectId: string) => {
			const result = await act({ type: 'attach', workflowId, projectId: targetProjectId });
			if (!result) return;
			const binding = result.bindings?.find(
				(item) => item.workflowId === workflowId && item.projectId === targetProjectId,
			);
			if (binding) {
				setLocalProjectId(targetProjectId);
				options.onSelectProject?.(targetProjectId);
				openBinding(binding.id);
				setShowAddProject(false);
			}
		},
		[act, openBinding, options.onSelectProject],
	);
	const selected =
		editingBinding && selectedBinding
			? selectedBinding.workflowSnapshot
			: snapshot.workflows.find((item) => item.id === selectedId);
	const filtered = snapshot.workflows.filter((item) =>
		item.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
	);
	const panel = (
		<div className="sidebar-panel workflows-sidebar">
			<div className="sidebar-panel-header">
				<h2>Workflows</h2>
				<button
					className="workflow-icon-button"
					title="New workflow"
					aria-label="New workflow"
					onClick={() => void create()}
					disabled={busy}
				>
					<Plus size={18} />
				</button>
			</div>
			<label className="workflow-search">
				<Search size={15} />
				<input
					aria-label="Search workflows"
					placeholder="Search"
					value={search}
					onChange={(event) => setSearch(event.target.value)}
				/>
			</label>
			<div className="workflow-sidebar-heading">
				Your workflows <span>{snapshot.workflows.length}</span>
			</div>
			<div className="workflow-list">
				{loading && !snapshot.workflows.length ? (
					<div className="workflow-empty-note">Loading workflows…</div>
				) : (
					filtered.map((workflow) => (
						<button
							key={workflow.id}
							className={`workflow-list-item${selectedId === workflow.id ? ' active' : ''}`}
							onClick={() => {
								openLibrary();
								setSelectedId(workflow.id);
							}}
							aria-current={selectedId === workflow.id ? 'page' : undefined}
						>
							<Workflow size={17} />
							<div>
								<strong>{workflow.name}</strong>
								<small>
									{workflow.nodes.length} nodes · {workflow.enabled ? 'Triggers enabled' : 'Manual'}
								</small>
							</div>
						</button>
					))
				)}
				{!loading && !filtered.length && (
					<div className="workflow-empty-note">
						{search
							? 'No matching workflows.'
							: 'Build a reusable flow for your ideas, models, and tools.'}
					</div>
				)}
			</div>
			<button
				className="workflow-sidebar-footer"
				onClick={() => {
					openLibrary();
					setSelectedId(undefined);
				}}
			>
				<Layers3 size={14} /> Browse templates
			</button>
		</div>
	);
	const content = (
		<div className="workflows-workspace">
			{error && (
				<div className="workflow-error" role="alert">
					<span>{userFacingError(error)}</span>
					{bindingId && pending.current.has(`binding:${bindingId}`) && (
						<button
							className="workflow-button"
							onClick={() => {
								const key = `binding:${bindingId}`;
								clearTimeout(pending.current.get(key)?.timer);
								pending.current.delete(key);
								setSaving(pending.current.size > 0);
								void window.desktop
									?.workflowSnapshot?.({ bindingId })
									.then((next) => {
										apply(next);
										setEditorGeneration((value) => value + 1);
										setError('');
									})
									.catch((failure) => setError(errorMessage(failure)));
							}}
						>
							Reload saved version
						</button>
					)}
					<button
						className="workflow-icon-button"
						aria-label="Dismiss workflow error"
						onClick={() => setError('')}
					>
						<X size={15} />
					</button>
				</div>
			)}
			{selectedBinding && !editingBinding ? (
				<WorkflowProjectView
					key={selectedBinding.id}
					binding={selectedBinding}
					project={project}
					runs={snapshot.runs}
					connections={hostConnections}
					busy={busy}
					onCommand={act}
					onEdit={() => setEditingBinding(true)}
					onBack={() => openProject(selectedBinding.projectId)}
				/>
			) : projectId && !selected && !editingBinding ? (
				<WorkflowProjectHome
					project={project}
					bindings={bindings.filter((item) => item.projectId === projectId)}
					workflows={snapshot.workflows}
					busy={busy}
					onOpen={openBinding}
					onAttach={(workflowId) => addToProject(workflowId, projectId)}
					onLibrary={openLibrary}
				/>
			) : selected ? (
				<>
					{editingBinding && selectedBinding ? (
						<div className="workflow-binding-banner">
							<button className="workflow-button" onClick={() => setEditingBinding(false)}>
								Back to {project?.name || 'project'} workflow
							</button>
							<span>
								Editing this project’s workflow. The library and other projects stay unchanged.
							</span>
						</div>
					) : (
						<div className="workflow-binding-banner">
							<span>Reusable workflow library</span>
							<button
								className="workflow-button"
								aria-expanded={showAddProject}
								onClick={() => setShowAddProject(!showAddProject)}
							>
								<Plus size={14} /> Add to project
							</button>
						</div>
					)}
					{showAddProject && (
						<div className="workflow-add-project" aria-label="Add workflow to project">
							<Select
								aria-label="Choose project for workflow"
								value=""
								placeholder="Choose a project"
								options={projects
									.filter(
										(item) =>
											!bindings.some(
												(binding) =>
													binding.projectId === item.id && binding.workflowId === selected.id,
											),
									)
									.map((item) => ({ value: item.id, label: item.name }))}
								onChange={(id) => void addToProject(selected.id, id)}
								disabled={busy}
							/>
							{!projects.length && (
								<span>Create a project in Chat or Code to add this workflow.</span>
							)}
						</div>
					)}
					<WorkflowEditor
						key={`${editingBinding ? selectedBinding?.id : selected.id}:${editorGeneration}`}
						bindingId={editingBinding ? selectedBinding?.id : undefined}
						initial={selected}
						snapshot={
							editingBinding && selectedBinding
								? {
										...snapshot,
										workflows: [
											...snapshot.workflows.filter(
												(workflow) => !selectedBinding.dependencySnapshots[workflow.id],
											),
											...Object.values(selectedBinding.dependencySnapshots),
										],
									}
								: snapshot
						}
						connections={hostConnections}
						saving={saving}
						busy={busy}
						onChange={editingBinding ? changeProjectWorkflow : change}
						onCommand={(value) =>
							act(
								editingBinding && selectedBinding && value.type === 'run'
									? { ...value, bindingId: selectedBinding.id }
									: value,
							)
						}
						onCatalog={() =>
							void command({
								type: 'catalog',
								workflowId: selected.id,
								bindingId: editingBinding ? selectedBinding?.id : undefined,
							}).catch((failure) => setError(errorMessage(failure)))
						}
						onDelete={async () => {
							const result = await act(
								editingBinding && selectedBinding
									? { type: 'detach', bindingId: selectedBinding.id }
									: { type: 'delete', id: selected.id },
							);
							if (result) {
								if (editingBinding && selectedBinding) openProject(selectedBinding.projectId);
								else setSelectedId(undefined);
							}
						}}
					/>
				</>
			) : (
				<div className="workflow-empty">
					<Workflow size={39} strokeWidth={1.25} />
					<h1>Build a workflow</h1>
					<p>
						Connect your models, tools, and ideas. Start with a template or make a workflow your
						own.
					</p>
					<button className="workflow-button primary" onClick={() => void create()} disabled={busy}>
						<Plus size={15} /> New workflow
					</button>
					<div className="workflow-templates">
						{WORKFLOW_TEMPLATES.map((template) => {
							const Icon =
								template.icon === 'image'
									? Image
									: template.icon === 'agent'
										? Bot
										: template.icon === 'review'
											? CheckCircle2
											: template.icon === 'research'
												? FlaskConical
												: Braces;
							return (
								<button
									key={template.id}
									className="workflow-template"
									onClick={() => void create(template.id)}
									disabled={busy}
								>
									<Icon size={20} className="workflow-template-icon" />
									<strong>{template.name}</strong>
									<small>{template.description}</small>
								</button>
							);
						})}
					</div>
				</div>
			)}
		</div>
	);
	return {
		title:
			selectedBinding?.name ||
			selectedBinding?.workflowSnapshot.name ||
			selected?.name ||
			(projectId ? `${project?.name || 'Project'} workflows` : 'Workflows'),
		panel,
		content,
		flushDrafts,
		bindings,
		openBinding,
		openProject,
		addToProject,
	};
}

interface EditorProps {
	bindingId?: string;
	initial: WorkflowDefinition;
	snapshot: WorkflowSnapshot;
	connections: Connection[];
	saving: boolean;
	busy: boolean;
	onChange: (workflow: WorkflowDefinition) => void;
	onCommand: (command: WorkflowCommand) => Promise<WorkflowSnapshot | undefined>;
	onCatalog: () => void;
	onDelete: () => Promise<void>;
}
interface PendingConnection {
	nodeId: string;
	portId: string;
	type: WorkflowDataType;
}
function WorkflowEditor(p: EditorProps) {
	const [draft, setDraft] = useState(p.initial);
	const current = useRef(draft);
	current.current = draft;
	const [selectedNode, setSelectedNode] = useState<string>();
	const [selectedEdge, setSelectedEdge] = useState<string>();
	const [palette, setPalette] = useState(false);
	const [paletteSearch, setPaletteSearch] = useState('');
	const [inspector, setInspector] = useState(true);
	const [view, setView] = useState(p.initial.viewport ?? { x: 0, y: 0, zoom: 1 });
	const viewRef = useRef(view);
	viewRef.current = view;
	const [pendingConnection, setPendingConnection] = useState<PendingConnection>();
	const wireDrag = useRef<{ x: number; y: number; moved: boolean } | undefined>(undefined);
	const [pointer, setPointer] = useState({ x: 0, y: 0 });
	const [notice, setNotice] = useState('');

	const [showRunInput, setShowRunInput] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [selectedRunId, setSelectedRunId] = useState('');
	const [historyVersion, setHistoryVersion] = useState(0);
	const undoStack = useRef<WorkflowDefinition[]>([]);
	const redoStack = useRef<WorkflowDefinition[]>([]);
	const canvas = useRef<HTMLDivElement>(null);
	const interaction = useRef<
		| {
				kind: 'pan' | 'node';
				pointerId: number;
				x: number;
				y: number;
				origin: { x: number; y: number };
				nodeId?: string;
				before?: WorkflowDefinition;
				moved?: boolean;
		  }
		| undefined
	>(undefined);
	const runs = p.snapshot.runs
		.filter(
			(run) =>
				run.workflowId === draft.id &&
				(p.bindingId ? run.bindingId === p.bindingId : !run.bindingId) &&
				!run.parentRunId,
		)
		.sort((a, b) => b.createdAt - a.createdAt);
	const run = runs.find((item) => item.id === selectedRunId) ?? runs[0];
	const running = activeRun(runs[0]);
	const waitingNodes = Object.values(run?.nodes ?? {}).filter((item) => item.status === 'waiting');
	const canApprove = waitingNodes.some((item) =>
		run?.workflowSnapshot.nodes.some(
			(node) =>
				node.id === item.nodeId &&
				node.type === 'wait' &&
				(node.config.mode ?? 'human') === 'human',
		),
	);
	const node = draft.nodes.find((item) => item.id === selectedNode);
	const edge = draft.edges.find((item) => item.id === selectedEdge);
	const commit = useCallback(
		(next: WorkflowDefinition, record = true) => {
			if (record) {
				undoStack.current.push(current.current);
				if (undoStack.current.length > 80) undoStack.current.shift();
				redoStack.current = [];
				setHistoryVersion((version) => version + 1);
			}
			const updated = { ...next, updatedAt: Date.now() };
			current.current = updated;
			setDraft(updated);
			p.onChange(updated);
		},
		[p.onChange],
	);
	const updateNode = (next: WorkflowNode) =>
		commit({
			...current.current,
			nodes: current.current.nodes.map((item) => (item.id === next.id ? next : item)),
		});
	const undo = useCallback(() => {
		const previous = undoStack.current.pop();
		if (previous) {
			redoStack.current.push(current.current);
			commit(previous, false);
			setHistoryVersion((version) => version + 1);
		}
	}, [commit]);
	const redo = useCallback(() => {
		const next = redoStack.current.pop();
		if (next) {
			undoStack.current.push(current.current);
			commit(next, false);
			setHistoryVersion((version) => version + 1);
		}
	}, [commit]);
	const removeSelected = useCallback(() => {
		if (selectedNode) {
			commit({
				...current.current,
				nodes: current.current.nodes.filter((item) => item.id !== selectedNode),
				edges: current.current.edges.filter(
					(item) => item.source !== selectedNode && item.target !== selectedNode,
				),
			});
			setSelectedNode(undefined);
		} else if (selectedEdge) {
			commit({
				...current.current,
				edges: current.current.edges.filter((item) => item.id !== selectedEdge),
			});
			setSelectedEdge(undefined);
		}
	}, [commit, selectedNode, selectedEdge]);
	useEffect(() => {
		const key = (event: KeyboardEvent) => {
			const target = event.target as HTMLElement;
			if (target.closest('input,textarea,[contenteditable="true"],[role="combobox"]')) return;
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
				event.preventDefault();
				event.shiftKey ? redo() : undo();
			}
			if (event.key === 'Delete' || event.key === 'Backspace') {
				event.preventDefault();
				removeSelected();
			}
			if (event.key === 'Escape') {
				setPendingConnection(undefined);
				setPalette(false);
				setSelectedEdge(undefined);
			}
		};
		window.addEventListener('keydown', key);
		return () => window.removeEventListener('keydown', key);
	}, [redo, undo, removeSelected]);
	const toWorld = (clientX: number, clientY: number) => {
		const rect = canvas.current!.getBoundingClientRect();
		return {
			x: (clientX - rect.left - viewRef.current.x) / viewRef.current.zoom,
			y: (clientY - rect.top - viewRef.current.y) / viewRef.current.zoom,
		};
	};
	const fit = useCallback(() => {
		if (!canvas.current || !current.current.nodes.length) return;
		const nodes = current.current.nodes;
		const minX = Math.min(...nodes.map((item) => item.position.x)),
			minY = Math.min(...nodes.map((item) => item.position.y));
		const maxX = Math.max(...nodes.map((item) => item.position.x + 224)),
			maxY = Math.max(...nodes.map((item) => item.position.y + nodeHeight(item)));
		const rect = canvas.current.getBoundingClientRect();
		const zoom = Math.min(
			1,
			Math.max(
				0.3,
				Math.min((rect.width - 100) / (maxX - minX), (rect.height - 120) / (maxY - minY)),
			),
		);
		setView({
			x: (rect.width - (maxX - minX) * zoom) / 2 - minX * zoom,
			y: (rect.height - (maxY - minY) * zoom) / 2 - minY * zoom,
			zoom,
		});
	}, []);
	useEffect(() => {
		const initialView = p.initial.viewport;
		if (!initialView || (initialView.x === 0 && initialView.y === 0 && initialView.zoom === 1))
			requestAnimationFrame(fit);
	}, [fit]);
	useEffect(() => {
		const timer = setTimeout(() => {
			const previous = current.current.viewport;
			if (previous?.x === view.x && previous?.y === view.y && previous?.zoom === view.zoom) return;
			commit({ ...current.current, viewport: view }, false);
		}, 300);
		return () => clearTimeout(timer);
	}, [view, commit]);
	const zoomBy = (factor: number) => {
		if (!canvas.current) return;
		const rect = canvas.current.getBoundingClientRect();
		const old = viewRef.current;
		const zoom = Math.min(1.75, Math.max(0.3, old.zoom * factor));
		const center = { x: rect.width / 2, y: rect.height / 2 };
		setView({
			x: center.x - ((center.x - old.x) * zoom) / old.zoom,
			y: center.y - ((center.y - old.y) * zoom) / old.zoom,
			zoom,
		});
	};
	useEffect(() => {
		const element = canvas.current;
		if (!element) return;
		const wheel = (event: WheelEvent) => {
			event.preventDefault();
			const old = viewRef.current;
			if (event.ctrlKey || event.metaKey) {
				const rect = element.getBoundingClientRect();
				const zoom = Math.min(1.75, Math.max(0.3, old.zoom * Math.exp(-event.deltaY * 0.005)));
				const x = event.clientX - rect.left,
					y = event.clientY - rect.top;
				setView({
					x: x - ((x - old.x) * zoom) / old.zoom,
					y: y - ((y - old.y) * zoom) / old.zoom,
					zoom,
				});
			} else setView({ ...old, x: old.x - event.deltaX, y: old.y - event.deltaY });
		};
		element.addEventListener('wheel', wheel, { passive: false });
		return () => element.removeEventListener('wheel', wheel);
	}, []);
	function startPan(event: ReactPointerEvent) {
		if (event.button !== 0 && event.button !== 1) return;
		if (
			(event.target as HTMLElement).closest(
				'button,.workflow-node,.workflow-canvas-controls,.workflow-palette,.workflow-edges',
			)
		)
			return;
		event.preventDefault();
		setSelectedNode(undefined);
		setSelectedEdge(undefined);
		interaction.current = {
			kind: 'pan',
			pointerId: event.pointerId,
			x: event.clientX,
			y: event.clientY,
			origin: { x: view.x, y: view.y },
		};
		canvas.current?.setPointerCapture(event.pointerId);
	}
	function startNode(event: ReactPointerEvent, item: WorkflowNode) {
		if (event.button !== 0) return;
		event.stopPropagation();
		event.preventDefault();
		setSelectedNode(item.id);
		setSelectedEdge(undefined);
		interaction.current = {
			kind: 'node',
			pointerId: event.pointerId,
			x: event.clientX,
			y: event.clientY,
			origin: item.position,
			nodeId: item.id,
			before: current.current,
		};
		canvas.current?.setPointerCapture(event.pointerId);
	}
	function movePointer(event: ReactPointerEvent) {
		if (pendingConnection) setPointer(toWorld(event.clientX, event.clientY));
		if (
			wireDrag.current &&
			Math.abs(event.clientX - wireDrag.current.x) + Math.abs(event.clientY - wireDrag.current.y) >
				5
		)
			wireDrag.current.moved = true;
		const drag = interaction.current;
		if (!drag) return;
		const dx = event.clientX - drag.x,
			dy = event.clientY - drag.y;
		if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
		if (drag.kind === 'pan')
			setView({ ...viewRef.current, x: drag.origin.x + dx, y: drag.origin.y + dy });
		else {
			const next = {
				...current.current,
				nodes: current.current.nodes.map((item) =>
					item.id === drag.nodeId
						? {
								...item,
								position: {
									x: Math.round((drag.origin.x + dx / viewRef.current.zoom) / 8) * 8,
									y: Math.round((drag.origin.y + dy / viewRef.current.zoom) / 8) * 8,
								},
							}
						: item,
				),
			};
			current.current = next;
			setDraft(next);
		}
	}
	function endPointer(event: ReactPointerEvent) {
		if (wireDrag.current) {
			const moved = wireDrag.current.moved;
			wireDrag.current = undefined;
			if (canvas.current?.hasPointerCapture(event.pointerId))
				canvas.current.releasePointerCapture(event.pointerId);
			if (moved) {
				const target = document
					.elementFromPoint(event.clientX, event.clientY)
					?.closest<HTMLElement>('[data-workflow-input]');
				const targetNode = current.current.nodes.find(
					(item) => item.id === target?.dataset.workflowNode,
				);
				const targetPort =
					targetNode &&
					WORKFLOW_NODE_MAP[targetNode.type].inputs.find(
						(item) => item.id === target?.dataset.workflowInput,
					);
				if (targetNode && targetPort) connect(targetNode, targetPort.id, targetPort.type);
				else setPendingConnection(undefined);
			}
			return;
		}
		const drag = interaction.current;
		interaction.current = undefined;
		if (canvas.current?.hasPointerCapture(event.pointerId))
			canvas.current.releasePointerCapture(event.pointerId);
		if (drag?.kind === 'node' && drag.moved) {
			undoStack.current.push(drag.before!);
			redoStack.current = [];
			setHistoryVersion((version) => version + 1);
			commit(current.current, false);
		}
	}
	function addNode(type: WorkflowNodeType, dropPosition?: { x: number; y: number }) {
		const rect = canvas.current!.getBoundingClientRect();
		const item = createWorkflowNode(
			type,
			dropPosition ?? {
				x: Math.round(((rect.width / 2 - view.x) / view.zoom - 112) / 8) * 8,
				y: Math.round(((rect.height / 2 - view.y) / view.zoom - 80) / 8) * 8,
			},
		);
		if (modelTypes.includes(type) && p.connections[0]) {
			item.config.connectionId = p.connections[0].id;
			item.config.model = p.connections[0].models[modelKind(type)];
			item.config.thinkingMode = defaultThinking(p.connections[0], String(item.config.model));
		}
		commit({ ...current.current, nodes: [...current.current.nodes, item] });
		setSelectedNode(item.id);
		setSelectedEdge(undefined);
		setPalette(false);
		setPaletteSearch('');
		setInspector(true);
	}
	function connect(target: WorkflowNode, targetPort: string, targetType: WorkflowDataType) {
		if (!pendingConnection) {
			setNotice('Choose an output port, then an input port to connect nodes.');
			return;
		}
		if (pendingConnection.nodeId === target.id) {
			setNotice('Connect to a different node.');
			return;
		}
		if (!compatibleWorkflowPorts(pendingConnection.type, targetType)) {
			setNotice(`A ${pendingConnection.type} output cannot connect to a ${targetType} input.`);
			return;
		}
		const source = pendingConnection.nodeId;
		// A visual cycle cannot be scheduled. Repetition belongs in bounded loop nodes.
		const reachable = (id: string, seen = new Set<string>()): boolean => {
			if (id === source) return true;
			if (seen.has(id)) return false;
			seen.add(id);
			return current.current.edges
				.filter((item) => item.source === id)
				.some((item) => reachable(item.target, seen));
		};
		if (reachable(target.id)) {
			setNotice('This connection creates a cycle. Use Repeat or For each for a loop.');
			return;
		}
		const next: WorkflowEdge = {
			id: workflowId(),
			source,
			sourceHandle: pendingConnection.portId,
			target: target.id,
			targetHandle: targetPort,
		};
		commit({
			...current.current,
			edges: [
				...current.current.edges.filter(
					(item) => !(item.target === target.id && (item.targetHandle || 'input') === targetPort),
				),
				next,
			],
		});
		setPendingConnection(undefined);
		setNotice('');
	}
	const portPoint = (item: WorkflowNode, id: string | undefined, output: boolean) => {
		const ports = WORKFLOW_NODE_MAP[item.type][output ? 'outputs' : 'inputs'];
		const index = Math.max(
			0,
			ports.findIndex((port) => port.id === (id || (output ? 'value' : 'input'))),
		);
		return { x: item.position.x + (output ? 224 : 0), y: item.position.y + 112 + index * 27 };
	};
	const bezier = (a: { x: number; y: number }, b: { x: number; y: number }) => {
		const distance = Math.max(70, Math.abs(b.x - a.x) * 0.45);
		return `M ${a.x} ${a.y} C ${a.x + distance} ${a.y}, ${b.x - distance} ${b.y}, ${b.x} ${b.y}`;
	};
	const nodesById = useMemo(
		() => new Map(draft.nodes.map((item) => [item.id, item])),
		[draft.nodes],
	);
	const paletteItems = WORKFLOW_CATALOG.filter((item) =>
		`${item.title} ${item.description} ${item.category}`
			.toLocaleLowerCase()
			.includes(paletteSearch.toLocaleLowerCase()),
	);
	const pendingSource = pendingConnection && nodesById.get(pendingConnection.nodeId);
	const categories = ['Triggers', 'AI & media', 'Actions', 'Flow control', 'Data'];
	void historyVersion;
	return (
		<>
			<div className="workflow-toolbar">
				<div className="workflow-title">
					<input
						aria-label="Workflow name"
						value={draft.name}
						onChange={(event) => commit({ ...draft, name: event.target.value })}
						onBlur={() => {
							if (!draft.name.trim()) commit({ ...draft, name: 'Untitled workflow' });
						}}
					/>
					<small>
						{p.saving ? 'Saving…' : 'Saved on this computer'} · {draft.nodes.length} nodes
					</small>
				</div>
				<div className="workflow-toolbar-group">
					<IconButton
						label="Undo"
						icon={Undo2}
						disabled={!undoStack.current.length}
						onClick={undo}
					/>
					<IconButton
						label="Redo"
						icon={Redo2}
						disabled={!redoStack.current.length}
						onClick={redo}
					/>
					<div className="workflow-toolbar-separator" />
					<button
						className="workflow-button"
						onClick={() => setPalette(!palette)}
						aria-expanded={palette}
					>
						<Plus size={15} /> Add node
					</button>
					<IconButton
						label="Workflow settings"
						icon={Settings2}
						onClick={() => {
							setSelectedNode(undefined);
							setSelectedEdge(undefined);
							setInspector(true);
						}}
					/>
					<IconButton
						label={inspector ? 'Hide inspector' : 'Show inspector'}
						icon={inspector ? PanelRightClose : PanelRightOpen}
						onClick={() => setInspector(!inspector)}
					/>
					<div className="workflow-toolbar-separator" />
					<IconButton
						label="Run inputs"
						icon={SlidersHorizontal}
						onClick={() => setShowRunInput(!showRunInput)}
					/>
					{running ? (
						<button
							className="workflow-button"
							onClick={() => void p.onCommand({ type: 'cancel', runId: runs[0].id })}
							disabled={p.busy}
						>
							<Square size={13} /> Cancel run
						</button>
					) : (
						<button
							className="workflow-button primary"
							onClick={() => {
								const invalid =
									canvas.current?.parentElement?.querySelector<HTMLElement>(
										'[aria-invalid="true"]',
									);
								if (invalid) {
									invalid.focus();
									setNotice('Fix invalid JSON in the inspector before running.');
									return;
								}
								if (draft.request || draft.nodes.some((node) => node.type === 'entry')) {
									setShowRunInput(true);
									return;
								}
								setSelectedRunId('');
								void p.onCommand({
									type: 'run',
									id: draft.id,
									inputs: normalizeWorkflowInputs(draft, {}),
								});
							}}
							disabled={p.busy || !draft.nodes.length}
						>
							<Play size={14} fill="currentColor" /> Run workflow
						</button>
					)}
				</div>
			</div>
			{showRunInput && (
				<div className="workflow-editor-request">
					<button
						className="workflow-icon-button"
						aria-label="Close run inputs"
						onClick={() => setShowRunInput(false)}
					>
						<X size={15} />
					</button>
					<WorkflowRequestComposer
						workflow={draft}
						busy={p.busy}
						onSubmit={async (inputs, requestId) => {
							const result = await p.onCommand({ type: 'run', id: draft.id, inputs, requestId });
							if (result) {
								setSelectedRunId('');
								setShowRunInput(false);
							}
							return !!result;
						}}
					/>
				</div>
			)}
			{run && (
				<div className="workflow-run-bar">
					<RunIcon status={run.status} />
					<span>
						{run.status === 'waiting'
							? waitingNodes[0]?.waitReason || 'Waiting for the next step'
							: run.status === 'completed'
								? 'Run completed'
								: run.status === 'failed'
									? run.error || 'Run failed'
									: run.status === 'running'
										? 'Running workflow'
										: run.status.charAt(0).toUpperCase() + run.status.slice(1)}
					</span>
					<small>
						{Object.values(run.nodes).filter((item) => item.status === 'completed').length}/
						{draft.nodes.length} completed
					</small>
					{run.status === 'waiting' && canApprove && (
						<button
							className="workflow-button"
							onClick={() => void p.onCommand({ type: 'resume', runId: run.id })}
							disabled={p.busy}
						>
							<Play size={13} /> Approve & continue
						</button>
					)}
					{['failed', 'cancelled', 'interrupted'].includes(run.status) && (
						<button
							className="workflow-button"
							onClick={() => void p.onCommand({ type: 'retry', runId: run.id })}
							disabled={p.busy}
						>
							<RotateCcw size={13} /> Retry
						</button>
					)}
				</div>
			)}
			{notice && (
				<div className="workflow-run-bar" role="status">
					<span>{notice}</span>
					<IconButton label="Dismiss connection message" icon={X} onClick={() => setNotice('')} />
				</div>
			)}
			<div className="workflow-body">
				<div
					ref={canvas}
					className={`workflow-canvas${pendingConnection ? ' connecting' : ''}`}
					role="application"
					aria-label="Workflow canvas"
					onDragOver={(event) => {
						if (event.dataTransfer.types.includes('application/freelm-node')) {
							event.preventDefault();
							event.dataTransfer.dropEffect = 'copy';
						}
					}}
					onDrop={(event) => {
						const type = event.dataTransfer.getData('application/freelm-node') as WorkflowNodeType;
						if (!WORKFLOW_NODE_MAP[type]) return;
						event.preventDefault();
						const point = toWorld(event.clientX, event.clientY);
						addNode(type, {
							x: Math.round((point.x - 112) / 8) * 8,
							y: Math.round((point.y - 24) / 8) * 8,
						});
					}}
					tabIndex={0}
					onPointerDown={startPan}
					onPointerMove={movePointer}
					onPointerUp={endPointer}
					onPointerCancel={endPointer}
					onDoubleClick={(event) => {
						if (!(event.target as HTMLElement).closest('.workflow-node,button')) {
							setPalette(true);
							setPaletteSearch('');
						}
					}}
					style={{
						backgroundImage:
							'radial-gradient(circle, color-mix(in srgb, var(--muted) 24%, transparent) 1px, transparent 1px)',
						backgroundSize: `${24 * view.zoom}px ${24 * view.zoom}px`,
						backgroundPosition: `${view.x}px ${view.y}px`,
					}}
				>
					<div className="workflow-canvas-count">
						<Workflow size={13} /> {draft.nodes.length} nodes · {draft.edges.length} connections
					</div>
					<div
						className="workflow-graph"
						style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}
					>
						<svg className="workflow-edges" aria-label="Connections">
							{draft.edges.map((item) => {
								const source = nodesById.get(item.source),
									target = nodesById.get(item.target);
								if (!source || !target) return null;
								const path = bezier(
									portPoint(source, item.sourceHandle, true),
									portPoint(target, item.targetHandle, false),
								);
								const type =
									WORKFLOW_NODE_MAP[source.type].outputs.find(
										(port) => port.id === item.sourceHandle,
									)?.type ?? 'any';
								return (
									<g
										key={item.id}
										role="button"
										tabIndex={0}
										aria-label={`Connection from ${source.label} to ${target.label}`}
										onPointerDown={(event) => event.stopPropagation()}
										onKeyDown={(event) => {
											if (event.key === 'Enter' || event.key === ' ') {
												event.preventDefault();
												setSelectedEdge(item.id);
												setSelectedNode(undefined);
												setInspector(true);
											}
										}}
										onClick={(event) => {
											event.stopPropagation();
											setSelectedEdge(item.id);
											setSelectedNode(undefined);
											setInspector(true);
										}}
									>
										<path d={path} className="workflow-edge-hit" />
										<path
											d={path}
											className={`workflow-edge${selectedEdge === item.id ? ' selected' : ''}`}
											style={style({ '--port-color': WORKFLOW_PORT_COLORS[type] })}
										/>
									</g>
								);
							})}
							{pendingSource && (
								<path
									className="workflow-pending-edge"
									d={bezier(portPoint(pendingSource, pendingConnection!.portId, true), pointer)}
								/>
							)}
						</svg>
						{draft.nodes.map((item) => {
							const definition = WORKFLOW_NODE_MAP[item.type];
							const Icon = icons[item.type];
							const state = run?.nodes[item.id];
							return (
								<div
									key={item.id}
									className={`workflow-node${selectedNode === item.id ? ' selected' : ''}${state ? ` ${state.status}` : ''}`}
									style={{ left: item.position.x, top: item.position.y }}
									data-node-id={item.id}
									data-node-type={item.type}
									onClick={(event) => {
										event.stopPropagation();
										setSelectedNode(item.id);
										setSelectedEdge(undefined);
									}}
								>
									<div
										className="workflow-node-header"
										onPointerDown={(event) => startNode(event, item)}
									>
										<div
											className="workflow-node-symbol"
											style={style({ '--node-color': definition.color })}
										>
											<Icon size={15} />
										</div>
										<strong>{item.label}</strong>
										<div className="workflow-node-state" title={state?.status ?? 'Not run'}>
											{state ? <RunIcon status={state.status} /> : <Circle size={10} />}
										</div>
									</div>
									<div className="workflow-node-summary">{nodeSummary(item)}</div>
									<div className="workflow-node-ports">
										<div>
											{definition.inputs.map((port) => (
												<button
													key={port.id}
													className={`workflow-port${draft.edges.some((link) => link.target === item.id && (link.targetHandle || 'input') === port.id) ? ' connected' : ''}`}
													style={style({ '--port-color': WORKFLOW_PORT_COLORS[port.type] })}
													aria-label={`Connect ${item.label} ${port.label} input`}
													title={`${port.label} · ${port.type} input`}
													data-workflow-input={port.id}
													data-workflow-node={item.id}
													onClick={(event) => {
														event.stopPropagation();
														connect(item, port.id, port.type);
													}}
												>
													<i />
													<span>{port.label}</span>
												</button>
											))}
										</div>
										<div>
											{definition.outputs.map((port) => (
												<button
													key={port.id}
													className={`workflow-port output${draft.edges.some((link) => link.source === item.id && (link.sourceHandle || 'value') === port.id) ? ' connected' : ''}${pendingConnection?.nodeId === item.id && pendingConnection.portId === port.id ? ' pending' : ''}`}
													style={style({ '--port-color': WORKFLOW_PORT_COLORS[port.type] })}
													aria-label={`Connect ${item.label} ${port.label} output`}
													title={`${port.label} · ${port.type} output`}
													onPointerDown={(event) => {
														event.preventDefault();
														event.stopPropagation();
														wireDrag.current = { x: event.clientX, y: event.clientY, moved: false };
														setPendingConnection({
															nodeId: item.id,
															portId: port.id,
															type: port.type,
														});
														setPointer(portPoint(item, port.id, true));
														setNotice('');
														canvas.current?.setPointerCapture(event.pointerId);
													}}
													onClick={(event) => {
														event.stopPropagation();
														if (event.detail > 0) return;
														setPendingConnection({
															nodeId: item.id,
															portId: port.id,
															type: port.type,
														});
														setPointer(portPoint(item, port.id, true));
														setNotice('');
													}}
												>
													<i />
													<span>{port.label}</span>
												</button>
											))}
										</div>
									</div>
									{state?.waitReason && ['running', 'waiting'].includes(state.status) ? (
										<div className="workflow-node-result">{state.waitReason}</div>
									) : state?.error ? (
										<div className="workflow-node-result">{userFacingError(state.error)}</div>
									) : (
										state?.output && (
											<div className="workflow-node-result">{outputSummary(state.output)}</div>
										)
									)}
								</div>
							);
						})}
					</div>
					<div className="workflow-canvas-controls">
						<IconButton label="Zoom out" icon={Minus} onClick={() => zoomBy(1 / 1.2)} />
						<span className="workflow-zoom-label">{Math.round(view.zoom * 100)}%</span>
						<IconButton label="Zoom in" icon={Plus} onClick={() => zoomBy(1.2)} />
						<div className="workflow-toolbar-separator" />
						<IconButton label="Fit workflow" icon={Maximize2} onClick={fit} />
					</div>
					<div className="workflow-canvas-hint">
						{pendingConnection
							? 'Choose an input · Esc to cancel'
							: 'Drag to pan · ⌘ / Ctrl + scroll to zoom'}
					</div>
					{draft.nodes.length > 0 && <Minimap nodes={draft.nodes} selected={selectedNode} />}
					{palette && (
						<div className="workflow-palette">
							<div className="workflow-palette-header">
								<strong>Add a node</strong>
								<IconButton label="Close node palette" icon={X} onClick={() => setPalette(false)} />
							</div>
							<label className="workflow-search">
								<Search size={14} />
								<input
									aria-label="Search nodes"
									autoFocus
									placeholder="Search nodes…"
									value={paletteSearch}
									onChange={(event) => setPaletteSearch(event.target.value)}
								/>
							</label>
							<div className="workflow-palette-list">
								{categories.map((category) => {
									const entries = paletteItems.filter((item) => item.category === category);
									return entries.length ? (
										<div key={category}>
											<h3 className="workflow-palette-group">{category}</h3>
											{entries.map((item) => {
												const Icon = icons[item.type];
												return (
													<button
														className="workflow-palette-item"
														draggable
														onDragStart={(event) => {
															event.dataTransfer.setData('application/freelm-node', item.type);
															event.dataTransfer.effectAllowed = 'copy';
														}}
														key={item.type}
														onClick={() => addNode(item.type)}
													>
														<div
															className="workflow-node-symbol"
															style={style({ '--node-color': item.color })}
														>
															<Icon size={15} />
														</div>
														<div>
															<strong>{item.title}</strong>
															<small>{item.description}</small>
														</div>
													</button>
												);
											})}
										</div>
									) : null;
								})}
								{!paletteItems.length && (
									<div className="workflow-empty-note">No matching nodes.</div>
								)}
							</div>
						</div>
					)}
				</div>
				{inspector && (
					<aside className="workflow-inspector" aria-label="Workflow inspector">
						{node ? (
							<NodeInspector
								node={node}
								state={run?.nodes[node.id]}
								runId={run?.id}
								workflow={draft}
								snapshot={p.snapshot}
								connections={p.connections}
								onChange={updateNode}
								onWorkflowChange={commit}
								onCatalog={p.onCatalog}
								onDuplicate={() => {
									const copy = {
										...structuredClone(node),
										id: workflowId(),
										label: `${node.label} copy`,
										position: { x: node.position.x + 40, y: node.position.y + 55 },
									};
									commit({ ...draft, nodes: [...draft.nodes, copy] });
									setSelectedNode(copy.id);
								}}
								onDelete={removeSelected}
								onClose={() => setInspector(false)}
							/>
						) : edge ? (
							<>
								<div className="workflow-inspector-header">
									<GitBranch size={18} />
									<div>
										<strong>Connection</strong>
										<small>Data passes between these nodes</small>
									</div>
								</div>
								<div className="workflow-inspector-scroll">
									<SettingsGroup title="Route">
										<SettingsRow
											label="From"
											description={`${nodesById.get(edge.source)?.label} · ${edge.sourceHandle || 'value'}`}
										/>
										<SettingsRow
											label="To"
											description={`${nodesById.get(edge.target)?.label} · ${edge.targetHandle || 'input'}`}
										/>
									</SettingsGroup>
									<button className="workflow-button danger" onClick={removeSelected}>
										<Trash2 size={14} /> Disconnect
									</button>
								</div>
							</>
						) : (
							<>
								<div className="workflow-inspector-header">
									<Workflow size={19} />
									<div>
										<strong>Workflow</strong>
										<small>Settings and run history</small>
									</div>
									<IconButton
										label="Close inspector"
										icon={X}
										onClick={() => setInspector(false)}
									/>
								</div>
								<div className="workflow-inspector-scroll">
									<SettingsGroup title="Details">
										<SettingsRow label="Description" layout="stacked">
											<textarea
												aria-label="Workflow description"
												placeholder="What does this workflow do?"
												value={draft.description ?? ''}
												onChange={(event) => commit({ ...draft, description: event.target.value })}
												rows={3}
											/>
										</SettingsRow>
										{!p.bindingId && (
											<SettingsRow
												label="Automatic triggers"
												description="Enable schedule and event triggers."
											>
												<Switch
													aria-label="Automatic triggers"
													checked={draft.enabled}
													onChange={(enabled) => commit({ ...draft, enabled })}
												/>
											</SettingsRow>
										)}
										{p.bindingId && (
											<SettingsRow
												label="Project runs"
												description="Start this workflow from its request composer or ask your Code agent to run it. Automatic triggers currently belong to library workflows."
											/>
										)}
										{!p.bindingId && (
											<SettingsRow
												label="Working directory"
												layout="stacked"
												description="Used by tools, code, and file operations."
											>
												<input
													aria-label="Workflow working directory"
													value={draft.settings?.workspaceRoot ?? ''}
													placeholder="/path/to/project"
													onChange={(event) =>
														commit({
															...draft,
															settings: { ...draft.settings, workspaceRoot: event.target.value },
														})
													}
												/>
											</SettingsRow>
										)}
									</SettingsGroup>
									<WorkflowRequestSettings workflow={draft} onChange={commit} />
									<SettingsGroup title="Execution">
										<SettingsRow
											label="Concurrent steps"
											description="Independent branches can run in parallel."
											layout="stacked"
										>
											<input
												type="number"
												min={1}
												max={16}
												aria-label="Concurrent steps"
												value={draft.settings?.concurrency ?? 2}
												onChange={(event) =>
													commit({
														...draft,
														settings: {
															...draft.settings,
															concurrency: Math.max(
																1,
																Math.min(16, Number(event.target.value) || 2),
															),
														},
													})
												}
											/>
										</SettingsRow>
									</SettingsGroup>
									<SettingsGroup title="Run history">
										{runs.length ? (
											runs.slice(0, 12).map((item) => (
												<SettingsRow
													key={item.id}
													label={
														<button
															onClick={() => setSelectedRunId(item.id)}
															style={{ padding: 0, textAlign: 'left' }}
														>
															{item.status.charAt(0).toUpperCase() + item.status.slice(1)}
														</button>
													}
													description={new Date(item.createdAt).toLocaleString()}
												>
													<RunIcon status={item.status} />
												</SettingsRow>
											))
										) : (
											<div className="workflow-help">
												Run this workflow to see progress and inspect each node’s output.
											</div>
										)}
									</SettingsGroup>
									<p className="workflow-help">
										Select a node to edit its inputs. Click an output port, then an input port to
										connect them. Select a connection to remove it.
									</p>
								</div>
								<div className="workflow-inspector-actions">
									{confirmDelete ? (
										<>
											<button className="workflow-button" onClick={() => setConfirmDelete(false)}>
												Keep workflow
											</button>
											<button
												className="workflow-button danger"
												onClick={() => void p.onDelete()}
												disabled={p.busy}
											>
												{p.bindingId ? 'Remove from project' : 'Delete workflow'}
											</button>
										</>
									) : (
										<>
											{!p.bindingId && (
												<button
													className="workflow-button"
													onClick={() => {
														const copy = {
															...structuredClone(draft),
															id: workflowId(),
															name: `${draft.name} copy`,
															createdAt: Date.now(),
															updatedAt: Date.now(),
														};
														void p.onCommand({ type: 'save', workflow: copy });
													}}
												>
													<Copy size={14} /> Duplicate
												</button>
											)}
											<IconButton
												label={p.bindingId ? 'Remove from project' : 'Delete workflow'}
												icon={Trash2}
												onClick={() => setConfirmDelete(true)}
											/>
										</>
									)}
								</div>
							</>
						)}
					</aside>
				)}
			</div>
		</>
	);
}

function NodeInspector({
	onWorkflowChange,
	node,
	state,
	runId,
	workflow,
	snapshot,
	connections,
	onChange,
	onCatalog,
	onDuplicate,
	onDelete,
	onClose,
}: {
	node: WorkflowNode;
	state?: WorkflowNodeRun;
	runId?: string;
	workflow: WorkflowDefinition;
	snapshot: WorkflowSnapshot;
	connections: Connection[];
	onChange: (node: WorkflowNode) => void;
	onWorkflowChange: (workflow: WorkflowDefinition) => void;
	onCatalog: () => void;
	onDuplicate: () => void;
	onDelete: () => void;
	onClose: () => void;
}) {
	const definition = WORKFLOW_NODE_MAP[node.type];
	const Icon = icons[node.type];
	const [search, setSearch] = useState('');
	useEffect(() => {
		if (node.type === 'tool' || node.type === 'agent') onCatalog();
	}, [node.id, node.type]);
	const config = (key: string, value: unknown) =>
		onChange({ ...node, config: { ...node.config, [key]: value } });
	const connection = connections.find((item) => item.id === node.config.connectionId);
	const kind = modelKind(node.type);
	const models =
		connection?.catalog?.filter((item) => item.enabled && item.tasks.includes(kind)) ?? [];
	const modelOptions = models.map((item) => ({ value: item.id, label: item.name || item.id }));
	for (const id of [
		String(node.config.model || ''),
		connection?.models[kind] ?? '',
		...(connection?.discoveredModels ?? []),
	])
		if (id && !modelOptions.some((item) => item.value === id))
			modelOptions.push({ value: id, label: id });
	const model = models.find((item) => item.id === node.config.model);
	const tools = snapshot.tools ?? [];
	const skills = snapshot.skills ?? [];
	const selectedTools = Array.isArray(node.config.tools) ? (node.config.tools as string[]) : [];
	const selectedSkills = Array.isArray(node.config.skills) ? (node.config.skills as string[]) : [];
	const toggle = (key: 'tools' | 'skills', id: string, checked: boolean) => {
		const existing = key === 'tools' ? selectedTools : selectedSkills;
		config(key, checked ? [...existing, id] : existing.filter((item) => item !== id));
	};
	const tool = tools.find((item) => item.name === node.config.tool);
	const fields = definition.fields.filter((field) => {
		if (
			['text', 'agent'].includes(node.type) &&
			['schema', 'validationRetries'].includes(field.key)
		)
			return node.config.responseFormat === 'json';
		if (node.type === 'loop') {
			if (field.key === 'stopPath') return node.config.stopOperator !== 'never';
			if (field.key === 'stopValue')
				return !['truthy', 'empty', 'never'].includes(String(node.config.stopOperator));
		}
		if (node.type === 'collection') {
			const operation = String(node.config.operation);
			if (field.key === 'recordId') return ['get', 'upsert', 'delete'].includes(operation);
			if (field.key === 'value') return ['upsert', 'append'].includes(operation);
			if (field.key === 'expectedRevision') return ['upsert', 'delete'].includes(operation);
			if (['filter', 'query', 'limit', 'offset'].includes(field.key)) return operation === 'list';
		}
		if (node.type === 'wait') {
			if (field.key === 'durationMs') return node.config.mode === 'duration';
			if (field.key === 'until') return node.config.mode === 'until';
			if (field.key === 'message') return node.config.mode === 'human';
		}
		if (node.type === 'context') {
			if (field.key === 'path') return node.config.source === 'run';
			if (field.key === 'paths') return node.config.source === 'files';
			if (field.key === 'threadId') return node.config.source === 'thread';
		}
		if (node.type === 'transform') {
			if (field.key === 'template') return node.config.operation === 'template';
			if (field.key === 'path') return node.config.operation === 'get';
			if (field.key === 'separator')
				return ['split', 'join'].includes(String(node.config.operation));
			if (field.key === 'keys') return node.config.operation === 'pick';
		}
		if (node.type === 'media-transform') {
			if (['x', 'y'].includes(field.key)) return node.config.operation === 'crop';
			if (['width', 'height'].includes(field.key)) return node.config.operation !== 'convert';
		}
		if (node.type === 'condition' && field.key === 'compare')
			return node.config.operator !== 'truthy';
		if (node.type === 'thread') {
			if (field.key === 'kind') return node.config.action === 'create';
			if (field.key === 'title') return ['create', 'rename'].includes(String(node.config.action));
			if (field.key === 'prompt') return ['create', 'send'].includes(String(node.config.action));
			if (field.key === 'threadId') return node.config.action !== 'create';
		}
		if (node.type === 'schedule') {
			if (field.key === 'intervalMinutes') return node.config.kind === 'interval';
			if (field.key === 'at') return node.config.kind === 'once';
			if (field.key === 'time') return ['daily', 'weekly'].includes(String(node.config.kind));
			if (field.key === 'weekdays') return node.config.kind === 'weekly';
		}
		return true;
	});
	return (
		<>
			<div className="workflow-inspector-header">
				<div className="workflow-node-symbol" style={style({ '--node-color': definition.color })}>
					<Icon size={17} />
				</div>
				<div>
					<strong>{definition.title}</strong>
					<small>{definition.category}</small>
				</div>
				<IconButton label="Close inspector" icon={X} onClick={onClose} />
			</div>
			<div className="workflow-inspector-scroll">
				<p className="workflow-inspector-description">{definition.description}</p>
				<SettingsGroup title="Node">
					<SettingsRow label="Name" layout="stacked">
						<input
							aria-label="Node name"
							value={node.label}
							onChange={(event) => onChange({ ...node, label: event.target.value })}
						/>
					</SettingsRow>
				</SettingsGroup>
				{node.type === 'entry' && (
					<WorkflowRequestSettings workflow={workflow} onChange={onWorkflowChange} />
				)}
				{modelTypes.includes(node.type) && (
					<SettingsGroup title="Model">
						<SettingsRow label="Connection" layout="stacked">
							<Select
								aria-label="Model connection"
								value={String(node.config.connectionId || '')}
								placeholder="Choose a connection"
								options={connections.map((item) => ({ value: item.id, label: item.name }))}
								onChange={(id) => {
									const next = connections.find((item) => item.id === id);
									onChange({
										...node,
										config: {
											...node.config,
											connectionId: id,
											model: next?.models[kind] || '',
											thinkingMode: defaultThinking(next, next?.models[kind] || ''),
										},
									});
								}}
							/>
						</SettingsRow>
						<SettingsRow label="Model" layout="stacked">
							{modelOptions.length ? (
								<Select
									aria-label="Workflow model"
									value={String(node.config.model || '')}
									placeholder="Choose a model"
									options={modelOptions}
									onChange={(id) =>
										onChange({
											...node,
											config: {
												...node.config,
												model: id,
												thinkingMode: defaultThinking(connection, id),
											},
										})
									}
								/>
							) : (
								<input
									aria-label="Workflow model"
									placeholder="Model ID"
									value={String(node.config.model || '')}
									onChange={(event) => config('model', event.target.value)}
								/>
							)}
						</SettingsRow>
						{!!model?.thinkingModes.length && (
							<SettingsRow label="Thinking" layout="stacked">
								<Select
									aria-label="Workflow thinking mode"
									value={
										model.thinkingModes.some((item) => item.id === node.config.thinkingMode)
											? String(node.config.thinkingMode)
											: defaultThinking(connection, String(node.config.model))
									}
									options={[
										...model.thinkingModes.map((item) => ({ value: item.id, label: item.name })),
									]}
									onChange={(value) => config('thinkingMode', value)}
								/>
							</SettingsRow>
						)}
						{!connections.length && (
							<div className="workflow-help">
								Add an API connection in Settings to use this node.
							</div>
						)}
					</SettingsGroup>
				)}
				{node.type === 'tool' && (
					<SettingsGroup
						title="Tool"
						actions={
							<IconButton label="Refresh tool catalog" icon={RotateCcw} onClick={onCatalog} />
						}
					>
						<SettingsRow label="Tool" layout="stacked">
							<Select
								aria-label="Workflow tool"
								value={String(node.config.tool || '')}
								placeholder="Choose a tool"
								options={tools.map((item) => ({
									value: item.name,
									label: item.displayName || item.name,
									description: `${item.source} · ${item.description.slice(0, 110)}`,
								}))}
								onChange={(value) => config('tool', value)}
							/>
							{!tools.length && (
								<div className="workflow-help">
									No tools found. Refresh after connecting MCP servers or installing plugins.
								</div>
							)}
						</SettingsRow>
						{tool && (
							<>
								<SettingsRow label="Description" description={tool.description} />
								<SettingsRow label="Input schema" layout="stacked">
									<pre>{JSON.stringify(tool.parameters, null, 2)}</pre>
								</SettingsRow>
							</>
						)}
					</SettingsGroup>
				)}
				{fields.length > 0 && (
					<SettingsGroup title={node.type === 'entry' ? 'Input' : 'Configuration'}>
						{fields.map((field) => (
							<ConfigField
								key={`${node.id}:${field.key}`}
								field={
									field.key === 'workflowId'
										? {
												...field,
												options: snapshot.workflows
													.filter((item) => item.id !== workflow.id)
													.map((item) => ({ value: item.id, label: item.name })),
											}
										: field
								}
								value={node.config[field.key]}
								onChange={(value) => config(field.key, value)}
							/>
						))}
					</SettingsGroup>
				)}
				{node.type === 'agent' && (
					<SettingsGroup
						title="Tools & skills"
						description="Only the selected capabilities are available to this agent."
						actions={
							<IconButton label="Refresh tools and skills" icon={RotateCcw} onClick={onCatalog} />
						}
					>
						<SettingsRow layout="stacked">
							<label className="workflow-search">
								<Search size={14} />
								<input
									aria-label="Search tools and skills"
									placeholder="Filter capabilities…"
									value={search}
									onChange={(event) => setSearch(event.target.value)}
								/>
							</label>
						</SettingsRow>
						<SettingsRow label={`Tools (${selectedTools.length})`} layout="stacked">
							<div className="workflow-tool-list">
								{tools
									.filter((item) =>
										`${item.name} ${item.displayName ?? ''} ${item.description}`
											.toLowerCase()
											.includes(search.toLowerCase()),
									)
									.map((item) => (
										<label key={item.name} className="workflow-check">
											<input
												type="checkbox"
												checked={selectedTools.includes(item.name)}
												onChange={(event) => toggle('tools', item.name, event.target.checked)}
											/>
											<span>
												{item.displayName || item.name}
												<small>
													{item.source} · {item.description.slice(0, 90)}
												</small>
											</span>
										</label>
									))}
								{!tools.length && <div className="workflow-help">No available tools.</div>}
							</div>
						</SettingsRow>
						<SettingsRow label={`Skills (${selectedSkills.length})`} layout="stacked">
							<div className="workflow-tool-list">
								{skills
									.filter((item) =>
										`${item.name} ${item.description}`.toLowerCase().includes(search.toLowerCase()),
									)
									.map((item) => {
										const id = item.id || item.path;
										return (
											<label key={id} className="workflow-check">
												<input
													type="checkbox"
													checked={selectedSkills.includes(id)}
													onChange={(event) => toggle('skills', id, event.target.checked)}
												/>
												<span>
													{item.name}
													<small>{item.description.slice(0, 100)}</small>
												</span>
											</label>
										);
									})}
								{!skills.length && <div className="workflow-help">No installed skills.</div>}
							</div>
						</SettingsRow>
					</SettingsGroup>
				)}
				<SettingsGroup title="Connections">
					{definition.inputs.map((port) => {
						const link = workflow.edges.find(
							(item) => item.target === node.id && (item.targetHandle || 'input') === port.id,
						);
						const source = workflow.nodes.find((item) => item.id === link?.source);
						return (
							<SettingsRow
								key={port.id}
								label={port.label}
								description={
									source ? `${source.label} → ${port.label}` : `${port.type} · Not connected`
								}
							/>
						);
					})}
					{!definition.inputs.length && (
						<div className="workflow-help">This node starts a branch of the workflow.</div>
					)}
					{definition.outputs.map((port) => (
						<SettingsRow
							key={`out:${port.id}`}
							label={`${port.label} output`}
							description={`${port.type} · ${workflow.edges.filter((item) => item.source === node.id && (item.sourceHandle || 'value') === port.id).length} connections`}
						/>
					))}
				</SettingsGroup>
				{state && (
					<SettingsGroup title="Last execution">
						<SettingsRow
							label="Status"
							description={
								(['running', 'waiting'].includes(state.status) ? state.waitReason : undefined) ||
								(state.finishedAt || state.startedAt
									? new Date(state.finishedAt || state.startedAt!).toLocaleString()
									: undefined)
							}
						>
							<RunIcon status={state.status} />
						</SettingsRow>
						{state.error && (
							<SettingsRow label="Error" description={userFacingError(state.error)} />
						)}
						{node.type === 'loop' && (
							<LoopExecution state={state} maximum={Number(node.config.maxIterations || 3)} />
						)}
						{state.output && (
							<SettingsRow
								label={node.type === 'collection' ? 'Records' : 'Output'}
								layout="stacked"
							>
								{node.type === 'collection' ? (
									<CollectionPreview output={state.output} />
								) : (
									<OutputPreview output={state.output} runId={runId} />
								)}
							</SettingsRow>
						)}
						{state.inputs && (
							<SettingsRow label="Resolved inputs" layout="stacked">
								<pre>{stringify(state.inputs)}</pre>
							</SettingsRow>
						)}
					</SettingsGroup>
				)}
			</div>
			<div className="workflow-inspector-actions">
				<button className="workflow-button" onClick={onDuplicate}>
					<Copy size={14} /> Duplicate
				</button>
				<button className="workflow-button danger" onClick={onDelete}>
					<Trash2 size={14} /> Delete node
				</button>
			</div>
		</>
	);
}

function ConfigField({
	field,
	value,
	onChange,
}: {
	field: WorkflowField;
	value: unknown;
	onChange: (value: unknown) => void;
}) {
	let control: ReactNode;
	if (field.kind === 'json')
		control = <JsonField label={field.label} value={value} onChange={onChange} />;
	else if (field.kind === 'select')
		control = (
			<Select
				aria-label={field.label}
				value={String(value ?? '')}
				options={field.options ?? []}
				placeholder={`Choose ${field.label.toLowerCase()}`}
				onChange={onChange}
			/>
		);
	else if (field.kind === 'boolean')
		control = <Switch aria-label={field.label} checked={!!value} onChange={onChange} />;
	else if (field.kind === 'textarea' || field.kind === 'lines')
		control = (
			<textarea
				aria-label={field.label}
				rows={field.key === 'code' ? 8 : 3}
				placeholder={field.placeholder}
				value={
					field.kind === 'lines' && Array.isArray(value) ? value.join('\n') : String(value ?? '')
				}
				onChange={(event) =>
					onChange(field.kind === 'lines' ? event.target.value.split('\n') : event.target.value)
				}
				spellCheck={field.key !== 'code'}
				style={field.key === 'code' ? { fontFamily: 'monospace', fontSize: 12 } : undefined}
			/>
		);
	else
		control = (
			<input
				type={field.kind === 'number' ? 'number' : 'text'}
				aria-label={field.label}
				placeholder={field.placeholder}
				value={String(value ?? '')}
				min={field.min}
				max={field.max}
				step={field.step ?? 'any'}
				onChange={(event) =>
					onChange(
						field.kind === 'number'
							? event.target.value === ''
								? undefined
								: Number(event.target.value)
							: event.target.value,
					)
				}
			/>
		);
	return (
		<SettingsRow
			label={field.label}
			description={field.description}
			layout={field.kind === 'boolean' ? 'inline' : 'stacked'}
		>
			{control}
		</SettingsRow>
	);
}
function JsonField({
	label,
	value,
	onChange,
}: {
	label: string;
	value: unknown;
	onChange: (value: unknown) => void;
}) {
	const serialized = value === undefined ? '' : JSON.stringify(value, null, 2);
	const [text, setText] = useState(serialized);
	const [error, setError] = useState('');
	const focused = useRef(false);
	useEffect(() => {
		if (!focused.current) setText(serialized);
	}, [serialized]);
	return (
		<>
			<textarea
				aria-label={label}
				aria-invalid={!!error}
				value={text}
				rows={3}
				spellCheck={false}
				style={{ fontFamily: 'monospace', fontSize: 12 }}
				onFocus={() => {
					focused.current = true;
				}}
				onBlur={() => {
					focused.current = false;
				}}
				onChange={(event) => {
					const next = event.target.value;
					setText(next);
					try {
						onChange(next.trim() ? JSON.parse(next) : undefined);
						setError('');
					} catch {
						setError('Enter valid JSON. Text values need quotation marks.');
					}
				}}
			/>
			{error && (
				<div className="workflow-help" role="alert" style={{ color: 'var(--danger)' }}>
					{userFacingError(error)}
				</div>
			)}
		</>
	);
}
function IconButton({
	label,
	icon: Icon,
	onClick,
	disabled,
}: {
	label: string;
	icon: LucideIcon;
	onClick: () => void;
	disabled?: boolean;
}) {
	return (
		<button
			className="workflow-icon-button"
			title={label}
			aria-label={label}
			onClick={onClick}
			disabled={disabled}
		>
			<Icon size={16} />
		</button>
	);
}
function RunIcon({ status }: { status: string }) {
	return status === 'running' || status === 'queued' ? (
		<LoaderCircle size={14} className="workflow-spin" />
	) : status === 'completed' ? (
		<Check size={14} />
	) : status === 'failed' ? (
		<X size={14} />
	) : status === 'waiting' ? (
		<Pause size={14} />
	) : status === 'cancelled' || status === 'interrupted' ? (
		<Square size={12} />
	) : (
		<Circle size={10} />
	);
}
function nodeSummary(node: WorkflowNode) {
	if (modelTypes.includes(node.type)) return String(node.config.model || 'Choose a model');
	if (node.type === 'value') return stringify(node.config.value).slice(0, 90);
	if (node.type === 'tool') return String(node.config.tool || 'Choose a tool');
	if (node.type === 'transform')
		return node.config.operation === 'template'
			? String(node.config.template || '')
			: String(node.config.operation);
	if (node.type === 'code') return String(node.config.language || 'javascript');
	if (node.type === 'condition')
		return String(node.config.operator || 'truthy').replaceAll('-', ' ');
	if (node.type === 'wait')
		return node.config.mode === 'human'
			? 'Pause for your approval'
			: node.config.mode === 'duration'
				? `Wait ${Number(node.config.durationMs || 0) / 1000} seconds`
				: String(node.config.until || 'Choose a date and time');
	if (node.type === 'schedule') return `Every ${node.config.intervalMinutes || 60} minutes`;
	if (node.type === 'event') return String(node.config.name || 'Choose an event');
	if (node.type === 'loop') return `Up to ${node.config.maxIterations || 3} feedback rounds`;
	if (node.type === 'collection')
		return `${String(node.config.operation || 'list')} · ${String(node.config.name || 'records')}`;
	if (node.type === 'output') return String(node.config.name || 'Workflow result');
	return WORKFLOW_NODE_MAP[node.type].description;
}
function outputSummary(output: Record<string, unknown>) {
	const value = output.text ?? output.value ?? output;
	return stringify(value).slice(0, 160);
}
function LoopExecution({ state, maximum }: { state: WorkflowNodeRun; maximum: number }) {
	const progress = state.loop;
	if (!progress) return null;
	return (
		<SettingsRow label="Feedback rounds" layout="stacked">
			<div className="workflow-loop-progress" role="status">
				<span>
					{progress.iterations} of {maximum} rounds completed
				</span>
				{state.status === 'completed' && (
					<span className="workflow-help">
						{progress.stopped ? 'Stop condition met' : 'Maximum rounds reached'}
					</span>
				)}
			</div>
			<div className="workflow-records">
				{progress.items.map((item, index) => (
					<details key={index} className="workflow-record">
						<summary>Round {index + 1}</summary>
						<pre>{stringify(item)}</pre>
					</details>
				))}
			</div>
		</SettingsRow>
	);
}
function CollectionPreview({ output }: { output: Record<string, unknown> }) {
	const [visibleCount, setVisibleCount] = useState(25);
	const records = (
		Array.isArray(output.records) ? output.records : output.record ? [output.record] : []
	) as Record<string, unknown>[];
	return (
		<div className="workflow-records">
			<div className="workflow-help">
				{records.length} record{records.length === 1 ? '' : 's'} returned
				{typeof output.count === 'number' && output.count !== records.length
					? ` · ${output.count} total matches`
					: ''}
			</div>
			{records.slice(0, visibleCount).map((record, index) => (
				<details key={String(record.id || index)} className="workflow-record">
					<summary>
						<span>{String(record.id || `Record ${index + 1}`)}</span>
						{typeof record.revision === 'number' && <small>Revision {record.revision}</small>}
					</summary>
					<pre>{stringify(record.data)}</pre>
					<details className="workflow-record-metadata">
						<summary>Record metadata</summary>
						<pre>
							{stringify(
								Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'data')),
							)}
						</pre>
					</details>
				</details>
			))}
			{records.length > visibleCount && (
				<button className="workflow-button" onClick={() => setVisibleCount((count) => count + 25)}>
					Show {Math.min(25, records.length - visibleCount)} more records
				</button>
			)}
			<details className="workflow-record">
				<summary>Full result</summary>
				<pre>{stringify(output)}</pre>
			</details>
		</div>
	);
}
function OutputPreview({ output, runId }: { output: Record<string, unknown>; runId?: string }) {
	const values = Object.values(output).flat();
	const preview = values.find(
		(item) =>
			item &&
			typeof item === 'object' &&
			('url' in item || 'dataUrl' in item || ('path' in item && 'kind' in item)),
	) as
		{ url?: string; dataUrl?: string; path?: string; kind?: string; mimeType?: string } | undefined;
	const [assetUrl, setAssetUrl] = useState('');
	const [assetError, setAssetError] = useState('');
	const path = preview?.path;
	useEffect(() => {
		let disposed = false;
		setAssetUrl('');
		setAssetError('');
		if (path && runId && window.desktop?.workflowAsset)
			void window.desktop
				.workflowAsset(runId, path)
				.then((url) => {
					if (!disposed) setAssetUrl(url);
				})
				.catch((error) => {
					if (!disposed) setAssetError(errorMessage(error));
				});
		return () => {
			disposed = true;
		};
	}, [path, runId]);
	const url = assetUrl || preview?.dataUrl || preview?.url;
	return (
		<>
			{url &&
				/^(data:|blob:|https?:|freelm[^:]*:)/.test(url) &&
				(preview?.kind === 'video' || preview?.mimeType?.startsWith('video/') ? (
					<video src={url} controls />
				) : preview?.kind === 'audio' || preview?.mimeType?.startsWith('audio/') ? (
					<audio src={url} controls />
				) : preview?.kind === 'image' || preview?.mimeType?.startsWith('image/') ? (
					<img src={url} alt="Workflow output" />
				) : (
					<a href={url} download>
						Download output
					</a>
				))}
			{assetError && (
				<div className="workflow-help">Preview unavailable: {userFacingError(assetError)}</div>
			)}
			<pre>{stringify(output)}</pre>
		</>
	);
}

function Minimap({ nodes, selected }: { nodes: WorkflowNode[]; selected?: string }) {
	const minX = Math.min(...nodes.map((item) => item.position.x)) - 60,
		minY = Math.min(...nodes.map((item) => item.position.y)) - 60;
	const width = Math.max(...nodes.map((item) => item.position.x + 224)) - minX + 60,
		height = Math.max(...nodes.map((item) => item.position.y + nodeHeight(item))) - minY + 60;
	return (
		<svg
			className="workflow-minimap"
			viewBox={`${minX} ${minY} ${width} ${height}`}
			aria-hidden="true"
		>
			{nodes.map((item) => (
				<rect
					key={item.id}
					className={item.id === selected ? 'selected' : ''}
					x={item.position.x}
					y={item.position.y}
					width={224}
					height={nodeHeight(item)}
					rx={12}
				/>
			))}
		</svg>
	);
}
