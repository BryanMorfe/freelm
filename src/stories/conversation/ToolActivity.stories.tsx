import type { Meta, StoryObj } from '@storybook/react-vite';
import ToolActivity from '../../components/ToolActivity';
import { commandCall, patchCall, searchCall, timestamp } from './fixtures';

const meta = {
	title: 'Conversation/Tool activity',
	component: ToolActivity,
	parameters: {
		docs: {
			description: {
				component:
					'Actual src/components/ToolActivity.tsx and tool-activity.css. All calls are synthetic records: expanding a row only reveals local display data. Toggle live and debugMode to inspect shimmer and diagnostic states.',
			},
		},
	},
	decorators: [
		(Story) => (
			<div style={{ width: 'min(760px, 100%)' }}>
				<Story />
			</div>
		),
	],
	args: { live: false, debugMode: false },
	argTypes: { live: { control: 'boolean' }, debugMode: { control: 'boolean' } },
} satisfies Meta<typeof ToolActivity>;
export default meta;
type Story = StoryObj<typeof meta>;

export const RunningCommand: Story = {
	args: {
		live: true,
		calls: [commandCall('running', 'npm run test -- --reporter=verbose', 'running')],
	},
};
export const CompletedCommand: Story = {
	args: { calls: [commandCall('complete', 'npm run test -- --reporter=verbose')] },
};
export const FailedCommand: Story = {
	args: { calls: [commandCall('failed', 'npm run test -- navigation', 'failed')] },
};
export const LongMultilineCommand: Story = {
	args: {
		calls: [
			commandCall(
				'long',
				'rg --files src/components src/lib tests/e2e --glob "*.tsx" --glob "*.ts" --glob "!**/fixtures/**"\nnpm run test -- --reporter=verbose --include="tests/navigation.test.ts"',
			),
		],
	},
};
export const Searching: Story = {
	args: {
		live: true,
		calls: [{ ...searchCall, status: 'running', result: undefined, completedAt: undefined }],
	},
};
export const Searched: Story = { args: { calls: [searchCall] } };
export const EditedFiles: Story = {
	args: { calls: [patchCall('edit', ['src/components/Navigation.tsx', 'src/styles/theme.css'])] },
};
export const EditingFiles: Story = {
	args: {
		live: true,
		calls: [
			{
				...patchCall('editing', ['src/components/Navigation.tsx']),
				status: 'running',
				result: undefined,
				completedAt: undefined,
			},
		],
	},
};
export const WaitingForApproval: Story = {
	args: { live: true, calls: [commandCall('approval', 'npm install example-package', 'approval')] },
};
export const ApprovalDenied: Story = {
	args: {
		calls: [
			{
				...commandCall('denied', 'rm -rf /workspace/archive', 'denied'),
				result: {
					content: [{ type: 'text', text: 'Approval denied.' }],
					isError: true,
					approvalDenied: {
						reason: 'Deleting this directory requires your explicit approval.',
						effectiveDirectory: '/workspace/example',
						permissionMode: 'auto-review',
					},
				},
			},
		],
	},
};
export const Plan: Story = {
	args: {
		calls: [
			{
				id: 'plan',
				name: 'update_plan',
				status: 'completed',
				startedAt: timestamp,
				completedAt: timestamp + 1000,
				arguments: JSON.stringify({
					plan: [
						{ step: 'Inspect the existing layout', status: 'completed' },
						{ step: 'Adjust spacing and labels', status: 'in_progress' },
						{ step: 'Verify keyboard navigation', status: 'pending' },
					],
				}),
				result: { content: [{ type: 'text', text: 'Plan updated.' }] },
			},
		],
	},
};
