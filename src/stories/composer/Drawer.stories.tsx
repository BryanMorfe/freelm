import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import ComposerDrawer from '../../components/ComposerDrawer';
import CodeGoalControls from '../../components/CodeGoalControls';
import CodeMessageQueue from '../../components/CodeMessageQueue';
import MarkdownComposer from '../../components/MarkdownComposer';
import type { CodeGoal } from '../../lib/code-goals';
import type { QueuedCodeMessage } from '../../types';
import { fixtureTime, goalFixture, queuedFixtures } from './fixtures';

interface DrawerPreviewProps {
	goalState: 'none' | 'create' | CodeGoal['status'];
	queueCount: number;
	running: boolean;
	failed: boolean;
	estimatedUsage: boolean;
	awaitingResume: boolean;
}
function DrawerPreview(args: DrawerPreviewProps) {
	const [goal, setGoal] = useState<CodeGoal>();
	const [messages, setMessages] = useState<QueuedCodeMessage[]>([]);
	const [failed, setFailed] = useState(args.failed);
	const [editingId, setEditingId] = useState<string>();
	const [draft, setDraft] = useState('');
	const [notice, setNotice] = useState('');
	useEffect(() => {
		setGoal(
			args.goalState === 'none' || args.goalState === 'create'
				? undefined
				: {
						...goalFixture,
						status: args.goalState,
						estimatedUsage: args.estimatedUsage,
						awaitingResume: args.awaitingResume,
						usedTokens: args.goalState === 'budget_limited' ? 64000 : goalFixture.usedTokens,
					},
		);
	}, [args.goalState, args.estimatedUsage, args.awaitingResume]);
	useEffect(() => {
		setMessages(queuedFixtures.slice(0, args.queueCount));
		setEditingId(undefined);
		setDraft('');
	}, [args.queueCount]);
	useEffect(() => setFailed(args.failed), [args.failed]);
	function submit() {
		if (!draft.trim()) return;
		if (editingId) {
			setMessages((previous) =>
				previous.map((item) => (item.id === editingId ? { ...item, content: draft } : item)),
			);
			setEditingId(undefined);
			setNotice('Queued message updated in this preview.');
		} else {
			setMessages((previous) => [
				...previous,
				{ id: crypto.randomUUID(), content: draft, createdAt: fixtureTime },
			]);
			setNotice('Message added to the preview queue.');
		}
		setDraft('');
	}
	return (
		<div style={{ width: 'min(760px, 100%)' }}>
			<ComposerDrawer>
				{args.goalState !== 'none' && <CodeGoalControls goal={goal} onChange={setGoal} />}
				<CodeMessageQueue
					messages={messages}
					running={args.running}
					editingId={editingId}
					failures={
						failed
							? [
									{
										id: 'preview-failure',
										assistantId: 'preview-answer',
										messageIds: ['preview-message'],
										error: 'The connection closed before the queued follow-up was delivered.',
										failedAt: fixtureTime,
										messages: [
											{
												id: 'preview-message',
												role: 'user',
												content: 'Keep the export available while the board is loading.',
												createdAt: fixtureTime,
											},
										],
									},
								]
							: []
					}
					onEdit={(id) => {
						setEditingId(id);
						setDraft(messages.find((item) => item.id === id)?.content || '');
					}}
					onRemove={(id) => {
						setMessages((previous) => previous.filter((item) => item.id !== id));
						if (editingId === id) {
							setEditingId(undefined);
							setDraft('');
						}
					}}
					onSteer={(id) => {
						setMessages((previous) => previous.filter((item) => item.id !== id));
						setNotice('Queued message sent in this preview only.');
					}}
					onRetry={() => {
						setFailed(false);
						setNotice('Retry acknowledged in this preview. No provider request was made.');
					}}
				/>
			</ComposerDrawer>
			<div className="composer">
				<MarkdownComposer
					value={draft}
					onChange={setDraft}
					placeholder={
						editingId ? 'Edit queued message' : 'Type a follow-up and press Enter to queue it'
					}
					onSubmit={submit}
					onBlur={() => {}}
					onRestorePrevious={() => false}
					onFiles={() => {}}
					onLargePaste={(text) => setNotice(`Preview received ${text.length} characters.`)}
					onError={setNotice}
				/>
			</div>
			{notice && (
				<p role="status" style={{ color: 'var(--muted)' }}>
					{notice}
				</p>
			)}
		</div>
	);
}
const meta = {
	title: 'Composer/Task drawer',
	component: DrawerPreview,
	parameters: {
		docs: {
			description: {
				component:
					'Actual src/components/ComposerDrawer.tsx, CodeGoalControls.tsx, CodeMessageQueue.tsx, and MarkdownComposer.tsx. Goals and queued follow-ups stack using the production drawer CSS. Pause/resume, budget edits, queue expansion, edit/delete/send, and retry update only local preview state. Type and press Enter to exercise a growing queue.',
			},
		},
	},
	args: {
		goalState: 'active',
		queueCount: 2,
		running: true,
		failed: false,
		estimatedUsage: false,
		awaitingResume: false,
	},
	argTypes: {
		goalState: {
			control: 'select',
			options: ['none', 'create', 'active', 'paused', 'complete', 'blocked', 'budget_limited'],
		},
		queueCount: { control: { type: 'range', min: 0, max: 2, step: 1 } },
	},
} satisfies Meta<typeof DrawerPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const GoalAndQueue: Story = {};
export const ActiveGoal: Story = { args: { queueCount: 0 } };
export const AddGoal: Story = { args: { goalState: 'create', queueCount: 0 } };
export const PausedGoal: Story = { args: { goalState: 'paused', queueCount: 0, running: false } };
export const BudgetReached: Story = {
	args: { goalState: 'budget_limited', queueCount: 0, running: false },
};
export const AwaitingResume: Story = {
	args: { awaitingResume: true, estimatedUsage: true, queueCount: 0, running: false },
};
export const QueuedWhileRunning: Story = { args: { goalState: 'none' } };
export const ReadyToSend: Story = { args: { goalState: 'none', running: false } };
export const DeliveryFailed: Story = {
	args: { goalState: 'none', queueCount: 0, failed: true, running: false },
};
export const ExpandedQueue: Story = {
	args: { goalState: 'none', queueCount: 1 },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole('button', { name: 'Expand queued message' }));
		await expect(canvas.getByRole('button', { name: 'Collapse queued message' })).toHaveAttribute(
			'aria-expanded',
			'true',
		);
	},
};
