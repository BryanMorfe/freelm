import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import WorkingStatus from '../../components/WorkingStatus';

const meta = {
	title: 'Conversation/Working status',
	component: WorkingStatus,
	parameters: {
		docs: {
			description: {
				component:
					'Actual src/components/WorkingStatus.tsx and working-status.css. Thinking has the production shimmer. The Code section header runs its own live timer. Refresh the story to restart the clock.',
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
	args: { header: false },
	argTypes: { header: { control: 'boolean' }, startedAt: { control: false } },
	render: function Render(args) {
		const [startedAt] = useState(() => Date.now() - 8_000);
		return <WorkingStatus {...args} startedAt={startedAt} />;
	},
} satisfies Meta<typeof WorkingStatus>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Thinking: Story = {};
export const CodeTimer: Story = { args: { header: true } };
