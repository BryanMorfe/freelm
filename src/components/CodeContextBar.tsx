import { useMemo } from 'react';
import { FolderOpen, Monitor, X } from 'lucide-react';
import type { Project } from '../types';
import { projectKind } from '../lib/conversation-kind';
import Select, { type SelectOption } from './Select';

export interface CodeWorkspaceOption {
	id: string;
	name: string;
}
const NEW_PROJECT = '__new_code_project__';
const EDIT_PROJECT = '__edit_code_project__';

/** Choose project context and execution host when starting a new Code task. */
export default function CodeContextBar({
	project,
	projects,
	onProjectChange,
	onNewProject,
	onEditProject,
	projectReadOnly = false,
	workspaceId = 'local',
	workspaceName = 'This computer',
	workspaceOptions,
	onWorkspaceChange,
	disabled = false,
}: {
	project?: Project;
	projects: Project[];
	onProjectChange: (id: string | undefined) => void;
	onNewProject?: () => void;
	onEditProject?: (project: Project) => void;
	projectReadOnly?: boolean;
	workspaceId?: string;
	workspaceName?: string;
	workspaceOptions?: CodeWorkspaceOption[];
	onWorkspaceChange?: (id: string) => void;
	disabled?: boolean;
}) {
	const projectOptions = useMemo<SelectOption[]>(() => {
		const choices = projects.filter((candidate) => projectKind(candidate) === 'code');
		if (project && !choices.some((candidate) => candidate.id === project.id))
			choices.unshift(project);
		const actions: SelectOption[] = [];
		if (onNewProject && !projectReadOnly)
			actions.push({
				value: NEW_PROJECT,
				label: 'New project…',
				description: 'Choose a folder for a new Code project.',
			});
		if (project && onEditProject && !projectReadOnly)
			actions.push({
				value: EDIT_PROJECT,
				label: 'Edit project…',
				description: 'Change this project’s folders and instructions.',
			});
		if (actions.length && choices.length) actions[0].separatorBefore = true;
		return [
			...choices.map((candidate) => ({
				value: candidate.id,
				label: candidate.name,
				description: candidate.directories?.join(', ') || 'No folder assigned',
			})),
			...actions,
		];
	}, [projects, project, onNewProject, onEditProject, projectReadOnly]);
	const hostOptions = useMemo<SelectOption[]>(() => {
		const choices = workspaceOptions?.length
			? workspaceOptions
			: [{ id: workspaceId, name: workspaceName }];
		const selected = choices.some((candidate) => candidate.id === workspaceId)
			? choices
			: [{ id: workspaceId, name: workspaceName }, ...choices];
		return selected.map((host) => ({ value: host.id, label: host.name }));
	}, [workspaceOptions, workspaceId, workspaceName]);
	const projectTitle = project
		? [project.name, ...(project.directories || [])].join('\n')
		: 'Choose a Code project';
	return (
		<div className="code-context-bar" aria-label="Code workspace context">
			<div
				className={`code-context-project ${projectReadOnly ? 'is-static' : project ? 'is-selected' : ''}`.trim()}
				title={projectTitle}
				aria-label={projectReadOnly ? 'Code project' : undefined}
			>
				{projectReadOnly ? (
					<>
						<FolderOpen size={15} aria-hidden="true" />
						<span className="code-context-project-name">
							{project?.name || 'Outside a project'}
						</span>
					</>
				) : (
					<Select
						className="code-context-trigger"
						aria-label="Code project"
						value={project?.id || ''}
						placeholder="Choose project"
						options={projectOptions}
						showChevron={false}
						leadingIcon={<FolderOpen size={15} aria-hidden="true" />}
						onChange={(next) => {
							if (next === NEW_PROJECT) onNewProject?.();
							else if (next === EDIT_PROJECT && project) onEditProject?.(project);
							else onProjectChange(next);
						}}
						disabled={disabled}
						title={projectTitle}
					/>
				)}
				{project && !projectReadOnly && (
					<button
						type="button"
						className="code-context-clear"
						aria-label="Clear project"
						title="Work without a project"
						disabled={disabled}
						onClick={() => onProjectChange(undefined)}
					>
						<X size={13} aria-hidden="true" />
					</button>
				)}
			</div>
			<div className="code-context-host">
				<Monitor size={15} aria-hidden="true" />
				<Select
					className="code-context-trigger"
					aria-label="Code execution host"
					value={workspaceId}
					options={hostOptions}
					onChange={(next) => onWorkspaceChange?.(next)}
					disabled={disabled || !onWorkspaceChange || hostOptions.length < 2}
					title={`Tools run on ${workspaceName}`}
				/>
			</div>
		</div>
	);
}
