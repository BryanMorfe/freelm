import type { Meta, StoryObj } from '@storybook/react-vite';
import ModerationNotice from '../../components/ModerationNotice';

const meta = {
	title: 'Media/Moderation notice',
	component: ModerationNotice,
	args: {
		warnings: [
			'Image moderation is enabled, but no evaluator is configured. Configure an image evaluator in Settings → Moderation.',
		],
	},
	parameters: {
		docs: {
			description: {
				component:
					'Actual non-blocking moderation notice. Edit src/components/ModerationNotice.tsx and src/components/moderation-notice.css. These are display fixtures and never evaluate or generate media.',
			},
		},
	},
	decorators: [
		(Story) => (
			<div style={{ maxWidth: 680 }}>
				<Story />
			</div>
		),
	],
} satisfies Meta<typeof ModerationNotice>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Warning: Story = {};
export const MultipleWarnings: Story = {
	args: {
		warnings: [
			'Input moderation could not be applied to this preview.',
			'Output moderation requires an image-capable evaluator. Configure one in Settings → Moderation.',
		],
	},
};
export const NoWarnings: Story = { args: { warnings: [] } };
export const Narrow: Story = {
	decorators: [
		(Story) => (
			<div style={{ width: 280, maxWidth: '100%' }}>
				<Story />
			</div>
		),
	],
};
