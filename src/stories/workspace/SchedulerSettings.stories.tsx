import { useMemo } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import SchedulerSettings from '../../components/SchedulerSettings';
import type { SchedulerBridge, SchedulerJob, SchedulerSnapshot } from '../../scheduler-types';

function previewBridge(empty: boolean): SchedulerBridge {
	const now = Date.now();
	const reminder: SchedulerJob = {
		id: 'reminder',
		hostId: 'preview',
		title: 'Take a break',
		target: { kind: 'reminder', message: 'Stretch your legs and get some water.' },
		schedule: { kind: 'interval', intervalMinutes: 60, missed: 'once' },
		enabled: true,
		createdAt: now,
		updatedAt: now,
		nextRunAt: now + 3600_000,
	};
	const bot: SchedulerJob = {
		id: 'bot',
		hostId: 'preview',
		title: 'Morning brief',
		target: {
			kind: 'bot',
			botId: 'nova',
			conversationId: 'preview',
			userMessageId: 'preview',
			prompt: 'Review my active tasks and let me know what needs my attention.',
		},
		schedule: { kind: 'daily', time: '09:00', timezone: 'America/New_York' },
		enabled: true,
		createdAt: now,
		updatedAt: now,
		nextRunAt: now + 86_400_000,
	};
	const code: SchedulerJob = {
		id: 'code',
		hostId: 'preview',
		title: 'Check the nightly build',
		target: {
			kind: 'code',
			threadId: 'build',
			prompt: 'Check the latest build report and notify me if it failed.',
		},
		schedule: { kind: 'daily', time: '06:00', timezone: 'America/New_York' },
		enabled: false,
		createdAt: now,
		updatedAt: now,
	};
	const snapshot: SchedulerSnapshot = {
		jobs: empty ? [] : [reminder, bot, code],
		occurrences: empty
			? []
			: [
					{
						id: 'reminder-delivered',
						jobId: reminder.id,
						hostId: 'preview',
						scheduledAt: now - 60_000,
						kind: 'scheduled',
						status: 'delivered',
						attempts: 1,
						createdAt: now - 60_000,
						updatedAt: now - 60_000,
						jobSnapshot: reminder,
					},
					{
						id: 'code-waiting',
						jobId: code.id,
						hostId: 'preview',
						scheduledAt: now - 120_000,
						kind: 'scheduled',
						status: 'waiting',
						attempts: 1,
						createdAt: now - 120_000,
						updatedAt: now - 120_000,
						jobSnapshot: code,
						error: 'Open the local workspace to continue.',
					},
				],
	};
	const listeners = new Set<() => void>();
	return {
		schedulerSnapshot: async () => structuredClone(snapshot),
		onSchedulerChanged: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		schedulerCommand: async (command) => {
			const job =
				'id' in command ? snapshot.jobs.find((value) => value.id === command.id) : undefined;
			const occurrence =
				'occurrenceId' in command
					? snapshot.occurrences.find((value) => value.id === command.occurrenceId)
					: undefined;
			const now = Date.now();
			if (command.type === 'create')
				snapshot.jobs.unshift({
					...command.job,
					id: crypto.randomUUID(),
					hostId: 'preview',
					enabled: true,
					createdAt: now,
					updatedAt: now,
					nextRunAt:
						command.job.schedule.kind === 'once'
							? new Date(command.job.schedule.at!).getTime()
							: now + 3600_000,
				});
			if (job) {
				if (command.type === 'update') Object.assign(job, command.patch, { updatedAt: now });
				if (command.type === 'pause') job.enabled = false;
				if (command.type === 'resume') job.enabled = true;
				if (command.type === 'delete')
					snapshot.jobs = snapshot.jobs.filter((value) => value.id !== job.id);
				if (command.type === 'run-now' || command.type === 'snooze')
					snapshot.occurrences.unshift({
						id: crypto.randomUUID(),
						jobId: job.id,
						hostId: 'preview',
						scheduledAt: command.type === 'snooze' ? command.until : now,
						kind: 'manual',
						status:
							command.type === 'snooze'
								? 'pending'
								: job.target.kind === 'reminder'
									? 'delivered'
									: 'admitted',
						attempts: 1,
						createdAt: now,
						updatedAt: now,
						jobSnapshot: structuredClone(job),
					});
			}
			if (occurrence) {
				if (command.type === 'dismiss' || command.type === 'snooze')
					occurrence.status = 'dismissed';
				if (command.type === 'retry') {
					occurrence.status = 'admitted';
					delete occurrence.error;
				}
			}
			return structuredClone(snapshot);
		},
	};
}

function Preview({
	empty = false,
	narrow = false,
	remote = false,
}: {
	empty?: boolean;
	narrow?: boolean;
	remote?: boolean;
}) {
	const bridge = useMemo(() => previewBridge(empty), [empty]);
	return (
		<div
			className="settings-page"
			style={{ display: 'block', height: 'auto', width: narrow ? 340 : 840, maxWidth: '100%' }}
		>
			<div className="settings-section-content">
				<SchedulerSettings
					bridge={bridge}
					remote={remote}
					threads={[{ id: 'build', title: 'Mosaic nightly build' }]}
				/>
			</div>
		</div>
	);
}

const meta = {
	title: 'Settings/Scheduled tasks',
	component: Preview,
	args: { empty: false, narrow: false, remote: false },
	parameters: {
		docs: {
			description: {
				component:
					'Production reminder and task controls with isolated preview data. Actions only change this story; no schedules, models, or desktop notifications run. Use the theme toolbar to compare light and dark.',
			},
		},
	},
} satisfies Meta<typeof Preview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Interactive: Story = {};
export const Empty: Story = { args: { empty: true } };
export const Narrow: Story = { args: { narrow: true } };
export const Remote: Story = { args: { remote: true } };
