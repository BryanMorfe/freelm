import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { InlineToolApprovals } from '../../components/InlineToolApprovals';
import type { ToolApproval } from '../../agent-types';

const commandApproval: ToolApproval = {
	id: 'preview-command',
	runId: 'preview-run',
	name: 'exec_command',
	arguments: { cmd: 'npm run test -- --run', workdir: '/preview/notebook' },
	message: 'Run the notebook unit tests before continuing.',
	effectiveDirectory: '/preview/notebook',
	rememberLabel: 'Allow for this task',
};
const editApproval: ToolApproval = {
	id: 'preview-edit',
	runId: 'preview-run',
	name: 'apply_patch',
	arguments: {
		patch:
			'*** Begin Patch\n*** Update File: src/styles.css\n@@\n-.board { gap: 24px; }\n+.board { gap: 16px; }\n*** End Patch',
	},
	message: 'Adjust the spacing between notebook cards.',
	effectiveDirectory: '/preview/notebook',
};
function ApprovalPreview({
	variant,
	debugMode,
	stoppable,
}: {
	variant: 'command' | 'edit' | 'multiple';
	debugMode: boolean;
	stoppable: boolean;
}) {
	const initial =
		variant === 'multiple'
			? [commandApproval, editApproval]
			: [variant === 'edit' ? editApproval : commandApproval];
	const [approvals, setApprovals] = useState(initial);
	const [notice, setNotice] = useState('');
	useEffect(() => {
		setApprovals(
			variant === 'multiple'
				? [commandApproval, editApproval]
				: [variant === 'edit' ? editApproval : commandApproval],
		);
		setNotice('');
	}, [variant]);
	return (
		<div style={{ width: 'min(760px, 100%)' }}>
			<InlineToolApprovals
				approvals={approvals}
				debugMode={debugMode}
				onApprove={(id, approved, remember) => {
					setApprovals((previous) => previous.filter((item) => item.id !== id));
					setNotice(
						`${approved ? 'Allowed' : 'Declined'}${remember ? ' for this preview task' : ''}. No tool ran.`,
					);
				}}
				onStop={
					stoppable
						? () => {
								setApprovals([]);
								setNotice('Preview stopped.');
							}
						: undefined
				}
			/>
			{notice && (
				<p role="status" style={{ color: 'var(--muted)' }}>
					{notice}
				</p>
			)}
		</div>
	);
}
const meta = {
	title: 'Composer/Tool approvals',
	component: ApprovalPreview,
	parameters: {
		docs: {
			description: {
				component:
					'Actual src/components/InlineToolApprovals.tsx and inline-tool-approvals.css. Expand proposed edits, inspect debug arguments, and exercise approval/decline/stop controls. Fixtures contain inert example commands and paths; no process, file operation, backend, or actual permission change is invoked.',
			},
		},
	},
	args: { variant: 'command', debugMode: false, stoppable: true },
	argTypes: { variant: { control: 'select', options: ['command', 'edit', 'multiple'] } },
} satisfies Meta<typeof ApprovalPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Command: Story = {};
export const FileEdit: Story = { args: { variant: 'edit' } };
export const MultipleApprovals: Story = { args: { variant: 'multiple' } };
export const DebugArguments: Story = { args: { debugMode: true } };
