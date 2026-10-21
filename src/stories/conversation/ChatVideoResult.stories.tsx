import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ToolCallRecord } from '../../agent-types';
import ChatVideoResult from '../../components/ChatVideoResult';
import videoDataUrl from '../../../tests/fixtures/moderation-samples.mp4?inline';
import { timestamp } from './fixtures';

// A 3.25-second, 3.8 KB local color fixture. Stories never run inference or moderation.
const completed: ToolCallRecord = {
	id: 'storybook-video',
	name: 'video_gen.videogen',
	arguments: JSON.stringify({ prompt: 'A short color sequence.', seconds: 3.25, size: '64x48' }),
	status: 'completed',
	startedAt: timestamp,
	completedAt: timestamp + 10_000,
	result: {
		content: [
			{ type: 'text', text: 'Generated a short color sequence.' },
			{
				type: 'file',
				dataUrl: videoDataUrl,
				name: 'storybook-color-sequence.mp4',
				mimeType: 'video/mp4',
			},
		],
	},
};

const meta = {
	title: 'Media/Chat video result',
	component: ChatVideoResult,
	args: { call: completed, live: false },
	argTypes: { live: { control: 'boolean' } },
	parameters: {
		docs: {
			description: {
				component:
					'Actual src/components/ChatVideoResult.tsx and chat-video-result.css. Uses a tiny local MP4 fixture with working playback and download. Switch the shared Theme toolbar between light and dark. No provider calls, generated media, or saved conversations are involved.',
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
} satisfies Meta<typeof ChatVideoResult>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Pending: Story = {
	args: {
		live: true,
		call: { ...completed, status: 'running', completedAt: undefined, result: undefined },
	},
};

export const WaitingForApproval: Story = {
	args: {
		live: true,
		call: { ...completed, status: 'approval', completedAt: undefined, result: undefined },
	},
};

export const Completed: Story = {};

export const Failed: Story = {
	args: {
		call: {
			...completed,
			status: 'failed',
			result: {
				isError: true,
				content: [
					{
						type: 'text',
						text: 'Video output blocked by high moderation: graphic gore. No generated media was released.',
					},
				],
			},
		},
	},
};

export const ModerationWarning: Story = {
	args: {
		call: {
			...completed,
			result: {
				...completed.result!,
				moderationWarnings: [
					'Video moderation is enabled, but its evaluator is missing, unavailable, incompatible, or has no usable thinking value. Generation proceeds without video moderation. Review Settings → Moderation.',
				],
			},
		},
	},
};

export const Narrow: Story = {
	decorators: [
		(Story) => (
			<div style={{ width: 280, maxWidth: '100%' }}>
				<Story />
			</div>
		),
	],
};
