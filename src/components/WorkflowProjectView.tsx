import { userFacingError } from '../lib/user-facing-error';
import { useRef, useState, type FormEvent } from 'react';
import {
	ArrowLeft,
	ArrowUp,
	Check,
	ChevronDown,
	Clock3,
	FolderOpen,
	LoaderCircle,
	Play,
	Plus,
	RotateCcw,
	Settings2,
	Square,
	Workflow,
	X,
} from 'lucide-react';
import type { Connection, Project } from '../types';
import type {
	WorkflowCommand,
	WorkflowDefinition,
	WorkflowProjectBinding,
	WorkflowRun,
	WorkflowSnapshot,
} from '../workflow-types';
import { normalizeWorkflowInputs } from '../lib/workflow-inputs';
import Select from './Select';
import Switch from './Switch';
import MessageMarkdown from './MessageMarkdown';
import { SettingsGroup, SettingsRow } from './SettingsList';

type Command = (command: WorkflowCommand) => Promise<WorkflowSnapshot | undefined>;
const active = (run?: WorkflowRun) =>
	!!run && ['queued', 'running', 'waiting'].includes(run.status);
const requestContract = (workflow: WorkflowDefinition) =>
	workflow.request ?? {
		prompt: {
			key: 'prompt',
			label: 'Request',
			placeholder: 'What would you like this workflow to do?',
		},
	};
const label = (value: string) =>
	value
		.replace(/([a-z])([A-Z])/g, '$1 $2')
		.replaceAll('_', ' ')
		.replace(/^./, (letter) => letter.toUpperCase());

export function WorkflowRequestComposer({
	workflow,
	defaults,
	busy,
	submitLabel = 'Run workflow',
	onSubmit,
}: {
	workflow: WorkflowDefinition;
	defaults?: Record<string, unknown>;
	busy?: boolean;
	submitLabel?: string;
	onSubmit: (inputs: Record<string, unknown>, requestId: string) => Promise<boolean>;
}) {
	const contract = requestContract(workflow);
	const [values, setValues] = useState<Record<string, unknown>>(() => ({
		...Object.fromEntries((contract.fields ?? []).map((field) => [field.key, field.defaultValue])),
		...defaults,
	}));
	const [error, setError] = useState('');
	const submitting = useRef(false);
	const submission = useRef<{ serialized: string; id: string } | undefined>(undefined);
	const set = (key: string, value: unknown) =>
		setValues((previous) => ({ ...previous, [key]: value }));
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (submitting.current) return;
		submitting.current = true;
		setError('');
		try {
			const inputs = normalizeWorkflowInputs(workflow, values, defaults);
			const serialized = JSON.stringify(inputs);
			if (submission.current?.serialized !== serialized)
				submission.current = { serialized, id: crypto.randomUUID() };
			if (await onSubmit(inputs, submission.current.id)) {
				set(contract.prompt.key, '');
				submission.current = undefined;
			}
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			submitting.current = false;
		}
	};
	return (
		<form className="workflow-request-form" onSubmit={(event) => void submit(event)}>
			<label className="workflow-request-label" htmlFor={`workflow-request-${workflow.id}`}>
				{contract.prompt.label || 'Request'}
			</label>
			<div className="workflow-request-composer">
				<textarea
					id={`workflow-request-${workflow.id}`}
					aria-label="Workflow request"
					placeholder={contract.prompt.placeholder || 'What would you like this workflow to do?'}
					value={String(values[contract.prompt.key] ?? '')}
					onChange={(event) => set(contract.prompt.key, event.target.value)}
					rows={4}
					required={contract.prompt.required}
				/>
				<div className="workflow-request-actions">
					<span>Starts a new run</span>
					<button className="workflow-button primary" type="submit" disabled={busy}>
						<ArrowUp size={16} />
						{submitLabel}
					</button>
				</div>
			</div>
			{!!contract.fields?.length && (
				<div className="workflow-request-fields">
					{contract.fields.map((field) => (
						<label key={field.key} className="workflow-request-field">
							<span>
								{field.label}
								{field.required ? ' *' : ''}
							</span>
							{field.type === 'boolean' ? (
								<Switch
									aria-label={field.label}
									checked={values[field.key] === true}
									onChange={(checked) => set(field.key, checked)}
								/>
							) : field.type === 'object' ? (
								<WorkflowObjectInput
									label={field.label}
									value={values[field.key]}
									onChange={(value) => set(field.key, value)}
								/>
							) : field.type === 'list' ? (
								<textarea
									aria-label={field.label}
									rows={3}
									placeholder="One item per line"
									value={
										Array.isArray(values[field.key])
											? (values[field.key] as unknown[]).join('\n')
											: String(values[field.key] ?? '')
									}
									required={field.required}
									onChange={(event) =>
										set(
											field.key,
											event.target.value
												.split('\n')
												.map((item) => item.trim())
												.filter(Boolean),
										)
									}
								/>
							) : (
								<input
									aria-label={field.label}
									type={field.type === 'number' ? 'number' : 'text'}
									step="any"
									required={field.required}
									value={String(values[field.key] ?? '')}
									onChange={(event) =>
										set(
											field.key,
											field.type === 'number'
												? event.target.value === ''
													? undefined
													: Number(event.target.value)
												: event.target.value,
										)
									}
								/>
							)}
						</label>
					))}
				</div>
			)}
			{error && (
				<p className="workflow-help workflow-request-error" role="alert">
					{userFacingError(error)}
				</p>
			)}
		</form>
	);
}

function WorkflowObjectInput({
	label: name,
	value,
	onChange,
}: {
	label: string;
	value: unknown;
	onChange: (value: Record<string, unknown>) => void;
}) {
	const [rows, setRows] = useState(() =>
		Object.entries(value && typeof value === 'object' && !Array.isArray(value) ? value : {}).map(
			([key, item]) => ({
				key,
				value: typeof item === 'string' ? item : (JSON.stringify(item) ?? ''),
				original: item as unknown,
				edited: false,
			}),
		),
	);
	const update = (next: typeof rows) => {
		setRows(next);
		onChange(
			Object.fromEntries(
				next
					.filter((row) => row.key.trim())
					.map((row) => [row.key.trim(), row.edited ? row.value : row.original]),
			),
		);
	};
	return (
		<div className="workflow-object-input">
			{rows.map((row, index) => (
				<div key={index}>
					<input
						aria-label={`${name} field ${index + 1}`}
						placeholder="Name"
						value={row.key}
						onChange={(event) =>
							update(
								rows.map((item, position) =>
									position === index ? { ...item, key: event.target.value } : item,
								),
							)
						}
					/>
					<input
						aria-label={`${name} value ${index + 1}`}
						placeholder="Value"
						value={row.value}
						onChange={(event) =>
							update(
								rows.map((item, position) =>
									position === index ? { ...item, value: event.target.value, edited: true } : item,
								),
							)
						}
					/>
					<button
						type="button"
						className="workflow-icon-button"
						aria-label={`Remove ${name} field ${index + 1}`}
						onClick={() => update(rows.filter((_, position) => position !== index))}
					>
						<X size={14} />
					</button>
				</div>
			))}
			<button
				type="button"
				className="workflow-button"
				onClick={() => update([...rows, { key: '', value: '', original: '', edited: true }])}
			>
				<Plus size={14} /> Add field
			</button>
		</div>
	);
}

export function WorkflowProjectHome({
	project,
	bindings,
	workflows,
	busy,
	onOpen,
	onAttach,
	onLibrary,
}: {
	project?: Project;
	bindings: WorkflowProjectBinding[];
	workflows: WorkflowDefinition[];
	busy: boolean;
	onOpen: (id: string) => void;
	onAttach: (workflowId: string) => Promise<void>;
	onLibrary: () => void;
}) {
	const available = workflows.filter(
		(workflow) => !bindings.some((binding) => binding.workflowId === workflow.id),
	);
	return (
		<div className="workflow-project-home">
			<div className="workflow-project-heading">
				<FolderOpen size={22} />
				<div>
					<small>{project?.name || 'Project'}</small>
					<h1>Workflows</h1>
				</div>
			</div>
			<p>
				Bring a reusable workflow into this project. Each request gets its own progress and results.
			</p>
			{!!bindings.length && (
				<section aria-label="Project workflows">
					<h2>Added to this project</h2>
					<div className="workflow-project-cards">
						{bindings.map((binding) => (
							<button
								key={binding.id}
								className="workflow-project-card"
								onClick={() => onOpen(binding.id)}
							>
								<Workflow size={20} />
								<strong>{binding.name || binding.workflowSnapshot.name}</strong>
								<span>{binding.workflowSnapshot.description || 'Open requests and results'}</span>
							</button>
						))}
					</div>
				</section>
			)}
			<section aria-label="Available workflows">
				<div className="workflow-project-section-title">
					<h2>Add from your library</h2>
					<button className="workflow-button" onClick={onLibrary}>
						<Plus size={14} /> Create workflow
					</button>
				</div>
				{available.length ? (
					<div className="workflow-project-cards">
						{available.map((workflow) => (
							<div key={workflow.id} className="workflow-project-card">
								<Workflow size={20} />
								<strong>{workflow.name}</strong>
								<span>{workflow.description || `${workflow.nodes.length} steps`}</span>
								<button
									className="workflow-button"
									onClick={() => void onAttach(workflow.id)}
									disabled={busy}
								>
									<Plus size={14} /> Add {workflow.name}
								</button>
							</div>
						))}
					</div>
				) : (
					<p className="workflow-help">
						{workflows.length
							? 'All library workflows have been added to this project.'
							: 'Create a workflow or choose a template from the library to get started.'}
					</p>
				)}
			</section>
		</div>
	);
}

export function WorkflowProjectView({
	binding,
	project,
	runs,
	connections,
	busy,
	onCommand,
	onEdit,
	onBack,
}: {
	binding: WorkflowProjectBinding;
	project?: Project;
	runs: WorkflowRun[];
	connections: Connection[];
	busy: boolean;
	onCommand: Command;
	onEdit: () => void;
	onBack: () => void;
}) {
	const [selectedRunId, setSelectedRunId] = useState<string>();
	const [showSettings, setShowSettings] = useState(false);
	const history = runs
		.filter((run) => run.bindingId === binding.id && !run.parentRunId)
		.sort((a, b) => b.createdAt - a.createdAt);
	const selected =
		history.find((run) => run.id === selectedRunId) ??
		(selectedRunId === 'new' ? undefined : history[0]);
	const workflow = binding.workflowSnapshot;
	const requestKey = requestContract(workflow).prompt.key;
	return (
		<div className="workflow-project-view">
			<header className="workflow-project-header">
				<button
					className="workflow-icon-button"
					aria-label="Project workflows"
					title="Project workflows"
					onClick={onBack}
				>
					<ArrowLeft size={18} />
				</button>
				<div>
					<small>{project?.name || 'Project'}</small>
					<h1>{binding.name || workflow.name}</h1>
				</div>
				<button
					className="workflow-button"
					aria-expanded={showSettings}
					onClick={() => setShowSettings(!showSettings)}
				>
					<Settings2 size={15} /> Configuration
				</button>
				<button className="workflow-button" onClick={onEdit}>
					Edit workflow
				</button>
			</header>
			<div className="workflow-project-body">
				<main className="workflow-project-main">
					{showSettings && (
						<WorkflowBindingSettings
							binding={binding}
							project={project}
							connections={connections}
							busy={busy}
							onCommand={onCommand}
						/>
					)}
					<div className="workflow-project-introduction">
						{workflow.description && <p>{workflow.description}</p>}
						<small>
							<FolderOpen size={13} /> {project?.directories?.join(' · ') || 'Project context'} ·
							Version {workflow.revision || 1}
						</small>
					</div>
					<WorkflowRequestComposer
						key={binding.id}
						workflow={workflow}
						defaults={binding.defaultInputs}
						busy={busy}
						onSubmit={async (inputs, requestId) => {
							const result = await onCommand({
								type: 'run',
								id: binding.workflowId,
								bindingId: binding.id,
								inputs,
								requestId,
							});
							if (!result) return false;
							const run = result.runs
								.filter((item) => item.bindingId === binding.id && !item.parentRunId)
								.sort((a, b) => b.createdAt - a.createdAt)[0];
							setSelectedRunId(run?.id);
							return true;
						}}
					/>
					{selected ? (
						<WorkflowRunResult run={selected} allRuns={runs} busy={busy} onCommand={onCommand} />
					) : (
						<div className="workflow-project-no-runs">
							<Workflow size={24} />
							<p>Your results will appear here.</p>
							<small>
								Requests and results stay within this project. Each run keeps its own history.
							</small>
						</div>
					)}
				</main>
				<aside className="workflow-investigations" aria-label="Run history">
					<div className="workflow-project-section-title">
						<h2>History</h2>
						<button
							className="workflow-icon-button"
							aria-label="New run"
							title="New run"
							onClick={() => {
								setSelectedRunId('new');
								document
									.querySelector<HTMLTextAreaElement>('.workflow-request-composer textarea')
									?.focus();
							}}
						>
							<Plus size={16} />
						</button>
					</div>
					{history.length ? (
						history.map((run) => (
							<button
								className={`workflow-investigation${selected?.id === run.id ? ' active' : ''}`}
								key={run.id}
								aria-pressed={selected?.id === run.id}
								onClick={() => setSelectedRunId(run.id)}
							>
								<strong>
									{String(run.inputs[requestKey] || run.inputs.prompt || 'Workflow run')}
								</strong>
								<span>
									<WorkflowRunIcon status={run.status} />
									{label(run.status)} ·{' '}
									{new Date(run.createdAt).toLocaleDateString(undefined, {
										month: 'short',
										day: 'numeric',
									})}
								</span>
							</button>
						))
					) : (
						<p className="workflow-help">No runs yet.</p>
					)}
				</aside>
			</div>
		</div>
	);
}

function WorkflowRunIcon({ status }: { status: string }) {
	return ['queued', 'running'].includes(status) ? (
		<LoaderCircle size={14} className="workflow-spin" />
	) : status === 'completed' ? (
		<Check size={14} />
	) : status === 'failed' ? (
		<X size={14} />
	) : (
		<Clock3 size={14} />
	);
}
function WorkflowRunResult({
	allRuns,
	run,
	busy,
	onCommand,
}: {
	run: WorkflowRun;
	allRuns: WorkflowRun[];
	busy: boolean;
	onCommand: Command;
}) {
	const completed = Object.values(run.nodes).filter((node) => node.status === 'completed').length;
	const descendants = allRuns.filter(
		(item) => item.id !== run.id && item.rootRunId === (run.rootRunId || run.id),
	);
	const approvals = [run, ...descendants].flatMap((item) =>
		item.workflowSnapshot.nodes
			.filter(
				(node) =>
					node.type === 'wait' &&
					(node.config.mode ?? 'human') === 'human' &&
					item.nodes[node.id]?.status === 'waiting',
			)
			.map((node) => ({ run: item, node })),
	);

	const request = requestContract(run.workflowSnapshot);
	return (
		<section className="workflow-project-result" aria-label="Run results">
			<div className="workflow-project-result-header">
				<WorkflowRunIcon status={run.status} />
				<h2>{run.status === 'completed' ? 'Run completed' : label(run.status)}</h2>
				<span>
					{completed} / {run.workflowSnapshot.nodes.length} completed
				</span>
				{active(run) && (
					<button
						className="workflow-button"
						onClick={() => void onCommand({ type: 'cancel', runId: run.id })}
						disabled={busy}
					>
						<Square size={13} /> Cancel run
					</button>
				)}
				{['failed', 'interrupted', 'cancelled'].includes(run.status) && (
					<button
						className="workflow-button"
						onClick={() => void onCommand({ type: 'retry', runId: run.id })}
						disabled={busy}
					>
						<RotateCcw size={14} /> Retry
					</button>
				)}
			</div>
			{run.inputs[request.prompt.key] != null && (
				<p className="workflow-result-request">{String(run.inputs[request.prompt.key])}</p>
			)}
			{run.error && (
				<p role="alert" className="workflow-request-error">
					{userFacingError(run.error)}
				</p>
			)}
			{approvals.map(({ run: waitingRun, node }) => (
				<div key={`${waitingRun.id}:${node.id}`} className="workflow-run-approval">
					<span>
						{waitingRun.workflowName}:{' '}
						{waitingRun.nodes[node.id].waitReason || 'This step needs your approval.'}
					</span>
					<button
						className="workflow-button"
						onClick={() =>
							void onCommand({ type: 'resume', runId: waitingRun.id, nodeId: node.id })
						}
						disabled={busy}
					>
						<Play size={13} /> Approve & continue
					</button>
				</div>
			))}
			{run.outputs &&
				Object.entries(run.outputs).map(([name, value]) => (
					<div key={name} className="workflow-result-output">
						<h3>{label(name)}</h3>
						<WorkflowValue value={value} />
					</div>
				))}
			<details className="workflow-run-steps" open={active(run)}>
				<summary>
					Steps <ChevronDown size={14} />
				</summary>
				{run.workflowSnapshot.nodes.map((node) => {
					const state = run.nodes[node.id];
					return (
						<details key={node.id} className={`workflow-run-step ${state?.status || 'pending'}`}>
							<summary>
								<WorkflowRunIcon status={state?.status || 'pending'} />
								<span>{node.label}</span>
								<small>{label(state?.status || 'pending')}</small>
							</summary>
							{state?.error && (
								<p className="workflow-request-error">{userFacingError(state.error)}</p>
							)}
							{state?.output ? (
								<WorkflowValue value={state.output} />
							) : (
								<p className="workflow-help">{state?.waitReason || 'No result yet.'}</p>
							)}
							{!!state?.childRunIds?.length && (
								<p className="workflow-help">
									{state.childRunIds.length} child run{state.childRunIds.length === 1 ? '' : 's'}
								</p>
							)}
						</details>
					);
				})}
			</details>
			{!!descendants.length && (
				<details className="workflow-run-steps">
					<summary>
						Child runs <span>{descendants.length}</span>
					</summary>
					{descendants.map((child) => (
						<WorkflowChildRun key={child.id} run={child} />
					))}
				</details>
			)}
		</section>
	);
}
function WorkflowChildRun({ run }: { run: WorkflowRun }) {
	const [expanded, setExpanded] = useState(false);
	return (
		<details
			className="workflow-run-step"
			onToggle={(event) => setExpanded(event.currentTarget.open)}
		>
			<summary>
				<WorkflowRunIcon status={run.status} />
				<span>{run.workflowName}</span>
				<small>{label(run.status)}</small>
			</summary>
			{expanded && (
				<>
					<p className="workflow-help">
						{Object.values(run.nodes).filter((node) => node.status === 'completed').length} /{' '}
						{run.workflowSnapshot.nodes.length} steps completed
					</p>
					{run.error && <p className="workflow-request-error">{userFacingError(run.error)}</p>}
					{run.outputs && <WorkflowValue value={run.outputs} />}
				</>
			)}
		</details>
	);
}
function WorkflowValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
	if (typeof value === 'string')
		return (
			<div className="message-markdown workflow-result-markdown">
				<MessageMarkdown text={value} />
			</div>
		);
	if (value == null || typeof value !== 'object') return <p>{String(value ?? '—')}</p>;
	if (depth > 5) return <pre>{JSON.stringify(value, null, 2)}</pre>;
	if (Array.isArray(value))
		return (
			<div className="workflow-result-items">
				{value.length ? (
					value.slice(0, 100).map((item, index) => (
						<div key={index}>
							<WorkflowValue value={item} depth={depth + 1} />
						</div>
					))
				) : (
					<p className="workflow-help">No items.</p>
				)}
				{value.length > 100 && (
					<p className="workflow-help">Showing 100 of {value.length} items.</p>
				)}
			</div>
		);
	return (
		<dl className="workflow-result-properties">
			{Object.entries(value).map(([key, item]) => (
				<div key={key}>
					<dt>{label(key)}</dt>
					<dd>
						<WorkflowValue value={item} depth={depth + 1} />
					</dd>
				</div>
			))}
		</dl>
	);
}

function WorkflowBindingSettings({
	binding,
	project,
	connections,
	busy,
	onCommand,
}: {
	binding: WorkflowProjectBinding;
	project?: Project;
	connections: Connection[];
	busy: boolean;
	onCommand: Command;
}) {
	const [settings, setSettings] = useState(binding.settings ?? {});
	const [saved, setSaved] = useState(false);
	const connection = connections.find((item) => item.id === settings.connectionId);
	const models =
		connection?.catalog?.filter((model) => model.enabled && model.tasks.includes('chat')) ?? [];
	const model = models.find((item) => item.id === settings.model);
	const change = (next: typeof settings) => {
		setSettings(next);
		setSaved(false);
	};
	return (
		<div className="workflow-binding-settings">
			<SettingsGroup
				title="Project configuration"
				description="Model overrides apply to text and agent steps in this project. The library workflow keeps its original configuration."
			>
				<SettingsRow
					label="Project"
					description={
						project?.instructions ||
						'The project supplies its working directories and instructions.'
					}
				>
					<span>{project?.name || binding.projectId}</span>
				</SettingsRow>
				<SettingsRow label="Connection">
					<Select
						aria-label="Project workflow connection"
						value={settings.connectionId || ''}
						options={[
							{ value: '', label: 'Use workflow models' },
							...connections.map((item) => ({ value: item.id, label: item.name })),
						]}
						onChange={(connectionId) => {
							const next = connections.find((item) => item.id === connectionId);
							const chosen = next?.catalog?.find((item) => item.id === next.models.chat);
							change({
								...settings,
								connectionId: connectionId || undefined,
								model: next?.models.chat,
								thinkingMode: chosen?.defaultThinkingMode || chosen?.thinkingModes[0]?.id,
							});
						}}
					/>
				</SettingsRow>
				{connection && (
					<SettingsRow label="Model">
						<Select
							aria-label="Project workflow model"
							value={settings.model || ''}
							options={models.map((item) => ({ value: item.id, label: item.name || item.id }))}
							onChange={(id) => {
								const chosen = models.find((item) => item.id === id);
								change({
									...settings,
									model: id,
									thinkingMode: chosen?.defaultThinkingMode || chosen?.thinkingModes[0]?.id,
								});
							}}
						/>
					</SettingsRow>
				)}
				{!!model?.thinkingModes.length && (
					<SettingsRow label="Thinking">
						<Select
							aria-label="Project workflow thinking"
							value={settings.thinkingMode || ''}
							options={model.thinkingModes.map((item) => ({ value: item.id, label: item.name }))}
							onChange={(thinkingMode) => change({ ...settings, thinkingMode })}
						/>
					</SettingsRow>
				)}
				<SettingsRow label="Tool permissions">
					<Select
						aria-label="Project workflow permissions"
						value={settings.permissionMode || 'ask'}
						options={[
							{ value: 'ask', label: 'Ask for approval' },
							{ value: 'auto-review', label: 'Approve for me' },
							{ value: 'full-access', label: 'Full access' },
						]}
						onChange={(value) =>
							change({ ...settings, permissionMode: value as typeof settings.permissionMode })
						}
					/>
				</SettingsRow>
			</SettingsGroup>
			<div className="workflow-binding-settings-actions">
				<small>{saved ? 'Configuration saved' : 'Pinned workflow version stays unchanged'}</small>
				<button
					className="workflow-button"
					disabled={busy}
					onClick={() =>
						void onCommand({ type: 'update-binding', bindingId: binding.id, settings }).then(
							(result) => setSaved(!!result),
						)
					}
				>
					Save configuration
				</button>
			</div>
		</div>
	);
}

export function WorkflowRequestSettings({
	workflow,
	onChange,
}: {
	workflow: WorkflowDefinition;
	onChange: (workflow: WorkflowDefinition) => void;
}) {
	const request = requestContract(workflow);
	const update = (next: typeof request) => onChange({ ...workflow, request: next });
	return (
		<SettingsGroup
			title="Request composer"
			description="These inputs are shown when someone runs this workflow."
		>
			<SettingsRow label="Prompt label" layout="stacked">
				<input
					aria-label="Request prompt label"
					value={request.prompt.label || ''}
					placeholder="Request"
					onChange={(event) =>
						update({ ...request, prompt: { ...request.prompt, label: event.target.value } })
					}
				/>
			</SettingsRow>
			<SettingsRow label="Placeholder" layout="stacked">
				<input
					aria-label="Request placeholder"
					value={request.prompt.placeholder || ''}
					placeholder="What would you like to investigate?"
					onChange={(event) =>
						update({ ...request, prompt: { ...request.prompt, placeholder: event.target.value } })
					}
				/>
			</SettingsRow>
			<SettingsRow
				label="Input name"
				layout="stacked"
				description="Available to nodes as run.inputs.<name>."
			>
				<input
					aria-label="Request input name"
					value={request.prompt.key}
					onChange={(event) =>
						update({ ...request, prompt: { ...request.prompt, key: event.target.value } })
					}
				/>
			</SettingsRow>
			<SettingsRow label="Require a request">
				<Switch
					aria-label="Require a request"
					checked={request.prompt.required === true}
					onChange={(required) => update({ ...request, prompt: { ...request.prompt, required } })}
				/>
			</SettingsRow>
			{request.fields?.map((field, index) => (
				<SettingsRow key={index} label={`Additional input ${index + 1}`} layout="stacked">
					<input
						aria-label={`Input ${index + 1} label`}
						placeholder="Label"
						value={field.label}
						onChange={(event) =>
							update({
								...request,
								fields: request.fields!.map((item, position) =>
									position === index ? { ...item, label: event.target.value } : item,
								),
							})
						}
					/>
					<input
						aria-label={`Input ${index + 1} name`}
						placeholder="Input name"
						value={field.key}
						onChange={(event) =>
							update({
								...request,
								fields: request.fields!.map((item, position) =>
									position === index ? { ...item, key: event.target.value } : item,
								),
							})
						}
					/>
					<Select
						aria-label={`Input ${index + 1} type`}
						value={field.type}
						options={['text', 'number', 'boolean', 'list', 'object'].map((type) => ({
							value: type,
							label: label(type),
						}))}
						onChange={(type) =>
							update({
								...request,
								fields: request.fields!.map((item, position) =>
									position === index ? { ...item, type: type as typeof field.type } : item,
								),
							})
						}
					/>
					<button
						className="workflow-button"
						onClick={() =>
							update({
								...request,
								fields: request.fields!.filter((_, position) => position !== index),
							})
						}
					>
						Remove input
					</button>
				</SettingsRow>
			))}
			<SettingsRow>
				<button
					className="workflow-button"
					onClick={() =>
						update({
							...request,
							fields: [
								...(request.fields || []),
								{
									key: `input${(request.fields?.length || 0) + 1}`,
									label: 'Additional input',
									type: 'text',
								},
							],
						})
					}
				>
					<Plus size={14} /> Add input
				</button>
			</SettingsRow>
		</SettingsGroup>
	);
}
