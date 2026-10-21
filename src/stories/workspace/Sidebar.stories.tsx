import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import Sidebar from '../../components/Sidebar';
import type { ConversationKind, WorkspaceMode } from '../../types';
import { sidebarFixture } from './fixtures';

function SidebarExample({
	initialKind = 'code',
	collapsed = false,
	empty = false,
	remote = false,
	readOnly = false,
}: {
	initialKind?: ConversationKind;
	collapsed?: boolean;
	empty?: boolean;
	remote?: boolean;
	readOnly?: boolean;
}) {
	const [state, setState] = useState(() => sidebarFixture(empty));
	const [mode, setMode] = useState<WorkspaceMode>(initialKind);
	const [kind, setKind] = useState(initialKind);
	const [threadId, setThreadId] = useState<string | null>(empty ? null : `${initialKind}-selected`);
	const [projectId, setProjectId] = useState<string | null>(
		empty ? null : initialKind === 'code' ? 'code-mosaic' : 'chat-research',
	);
	const [notice, setNotice] = useState(
		'Select a workspace, expand Projects or Recents, or open a thread menu. Actions affect these fixtures only.',
	);
	return (
		<div
			className={`app-shell ${collapsed ? 'sidebar-hidden' : ''}`}
			style={{
				width: 840,
				maxWidth: '100%',
				height: 650,
				minHeight: 450,
				borderRadius: 12,
				overflow: 'hidden',
				gridTemplateRows: '0 minmax(0, 1fr)',
			}}
		>
			<Sidebar
				state={state}
				mode={mode}
				conversationKind={kind}
				collapsed={collapsed}
				readOnly={readOnly}
				threadId={threadId}
				projectId={projectId}
				runningThreads={new Set(['chat-running', 'code-running'])}
				onMode={(next) => {
					setMode(next);
					if (next === 'chat' || next === 'code') {
						setKind(next);
						setProjectId(null);
						setThreadId(null);
					}
					setNotice(`Selected ${next}.`);
				}}
				onThread={(id) => {
					setThreadId(id);
					setProjectId(state.threads.find((thread) => thread.id === id)?.projectId ?? null);
					setMode(kind);
					setNotice(`Selected ${state.threads.find((thread) => thread.id === id)?.title}.`);
				}}
				onNewChat={() => {
					setThreadId(null);
					setNotice(`New ${kind === 'code' ? 'task' : 'chat'} selected.`);
				}}
				onTemporaryChat={() => {
					setThreadId(null);
					setNotice('Temporary chat selected.');
				}}
				onProject={setProjectId}
				onNewProject={() =>
					setNotice('New project action selected. This gallery does not create directories.')
				}
				onNewProjectChat={(project) => {
					setProjectId(project.id);
					setThreadId(null);
					setNotice(`New conversation in ${project.name}.`);
				}}
				onAddProjectWorkflow={(id) => {
					setProjectId(id);
					setNotice(
						`Add workflow to ${state.projects.find((project) => project.id === id)?.name}.`,
					);
				}}
				onEditProject={(project) => setNotice(`Edit project: ${project.name}.`)}
				onMoveThread={(id, project) => {
					setState((current) => ({
						...current,
						threads: current.threads.map((thread) =>
							thread.id === id ? { ...thread, projectId: project } : thread,
						),
					}));
					setNotice('Moved the preview thread.');
				}}
				onThreadAction={(thread, action) => {
					setNotice(`${action} selected for ${thread.title}.`);
					if (action === 'pin')
						setState((current) => ({
							...current,
							threads: current.threads.map((item) =>
								item.id === thread.id ? { ...item, pinned: !item.pinned } : item,
							),
						}));
					if (action === 'archive' || action === 'delete')
						setState((current) => ({
							...current,
							threads: current.threads.filter((item) => item.id !== thread.id),
						}));
				}}
				onSettings={() => setNotice('Settings selected.')}
				onSearch={() => setNotice('Search selected.')}
				remote={remote}
				workspaceName={remote ? 'Example workstation' : 'This computer'}
				onInstances={() => setNotice('Instance selector selected.')}
			/>
			<div style={{ gridColumn: 2, gridRow: 2, padding: 28, background: 'var(--bg)', minWidth: 0 }}>
				<p style={{ color: 'var(--muted)', lineHeight: 1.6 }} role="status">
					{notice}
				</p>
			</div>
		</div>
	);
}

const meta = {
	title: 'Navigation/Sidebar',
	component: SidebarExample,
	args: { initialKind: 'code', collapsed: false, empty: false, remote: false, readOnly: false },
	argTypes: { initialKind: { control: 'select', options: ['chat', 'code'] } },
	parameters: {
		docs: {
			description: {
				component:
					'Actual application navigation, project sections and add menus, recent conversations, thread action menus, running indicators, and rail icons. Edit src/components/Sidebar.tsx and src/components/sidebar.css; shared rules also live in src/styles.css. Preview callbacks update synthetic state only.',
			},
		},
	},
	render: (args) => <SidebarExample key={`${args.initialKind}-${args.empty}`} {...args} />,
} satisfies Meta<typeof SidebarExample>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Code: Story = {};
export const Chat: Story = { args: { initialKind: 'chat' } };
export const CollapsedRail: Story = { args: { collapsed: true } };
export const Empty: Story = { args: { empty: true } };
export const RemoteReadOnly: Story = { args: { remote: true, readOnly: true } };
