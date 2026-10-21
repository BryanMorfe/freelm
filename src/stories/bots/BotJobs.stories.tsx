import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import BotJobs, { type BotJobItem } from '../../components/BotJobs';
const now = Date.now();
const fixture: BotJobItem[] = [
	{
		id: 'send',
		title: 'Send the research summary',
		status: 'awaiting_approval',
		toolName: 'plugin_mail_send',
		args: {
			to: 'team@example.test',
			subject: 'Research summary',
			body: 'The benchmark comparison is ready.',
		},
	},
	{
		id: 'search',
		title: 'Search the research archive',
		status: 'running',
		toolName: 'plugin_archive_search',
		args: { query: 'local inference latency' },
	},
	{
		id: 'unknown',
		title: 'Save the report',
		status: 'outcome_unknown',
		toolName: 'plugin_reports_save',
		args: { name: 'Research report' },
		error: 'The service disconnected before confirming the result.',
	},
	{ id: 'done', title: 'Read project notes', status: 'succeeded', toolName: 'bot_history_read' },
].map((job) => ({
	...job,
	status: job.status as BotJobItem['status'],
	botId: 'nova',
	conversationId: 'research',
	sourceHostId: 'mac',
	createdAt: now,
	updatedAt: now,
	ownerTargetId: 'local',
	ownerName: 'This Mac',
	botName: 'Nova',
	connected: true,
}));
function Demo({ history = false, narrow = false }: { history?: boolean; narrow?: boolean }) {
	const [jobs, setJobs] = useState(fixture);
	return (
		<div
			className="bots-composer-area"
			style={{ width: narrow ? 340 : 720, padding: 16, maxWidth: '100%' }}
		>
			<BotJobs
				jobs={jobs}
				history={history}
				onAction={(job, action) =>
					setJobs((current) =>
						current.map((item) =>
							item.id === job.id
								? { ...item, status: action === 'job-approve' ? 'running' : 'cancelled' }
								: item,
						),
					)
				}
			/>
		</div>
	);
}
const meta = {
	title: 'Bots/Background work',
	component: Demo,
	parameters: { layout: 'centered' },
} satisfies Meta<typeof Demo>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Active: Story = {};
export const History: Story = { args: { history: true } };
export const Narrow: Story = { args: { narrow: true } };
