import type { Meta, StoryObj } from '@storybook/react-vite';
import ActivityHistory from '../../components/ActivityHistory';
import { toolActivityLabels } from '../../lib/message-activity';
import { commandCall, historyCalls, historyParts } from './fixtures';

const meta = {
	title: 'Conversation/Activity history',
	component: ActivityHistory,
	parameters: {
		docs: {
			description: {
				component:
					'Actual src/components/ActivityHistory.tsx and activity-history.css. Neighboring completed calls group by category, assistant prose separates groups, and running/failed calls keep their own rows. Expand grouped rows and commands to inspect the real UI.',
			},
		},
	},
	decorators: [
		(Story) => (
			<div className="thought-history" style={{ width: 'min(760px, 100%)' }}>
				<Story />
			</div>
		),
	],
	args: {
		live: true,
		debugMode: false,
		parts: historyParts,
		callsById: new Map(historyCalls.map((call) => [call.id, call])),
		labels: toolActivityLabels(historyCalls),
	},
	argTypes: {
		callsById: { control: false },
		labels: { control: false },
		parts: { control: false },
	},
} satisfies Meta<typeof ActivityHistory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const InterleavedAndRunning: Story = {};
const completed = historyCalls.map((call) =>
	call.id === 'test' ? commandCall('test', 'npm run test -- navigation') : call,
);
export const CompletedAndGrouped: Story = {
	args: {
		live: false,
		callsById: new Map(completed.map((call) => [call.id, call])),
		labels: toolActivityLabels(completed, true),
	},
};
const failed = historyCalls.map((call) =>
	call.id === 'test' ? commandCall('test', 'npm run test -- navigation', 'failed') : call,
);
export const WithFailure: Story = {
	args: {
		live: false,
		callsById: new Map(failed.map((call) => [call.id, call])),
		labels: toolActivityLabels(failed, true),
	},
};
