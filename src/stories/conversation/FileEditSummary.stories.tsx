import type { Meta, StoryObj } from '@storybook/react-vite';
import FileEditSummary from '../../components/FileEditSummary';
import { patchCall } from './fixtures';

const paths = [
	'src/components/Navigation.tsx',
	'src/styles/theme.css',
	'src/styles/layout.css',
	'src/lib/navigation.ts',
	'tests/navigation.test.ts',
	'tests/e2e/navigation.spec.ts',
	'docs/ACCESSIBILITY.md',
	'src/components/settings/AppearanceSettings.tsx',
];
const meta = {
	title: 'Summaries/Edited files',
	component: FileEditSummary,
	parameters: {
		docs: {
			description: {
				component:
					'Actual src/components/FileEditSummary.tsx and file-edit-summary.css. Hover or click any filename to open its diff preview. Five files are shown in full; more than five initially shows three with an expansion footer. No file operations occur.',
			},
		},
	},
	decorators: [
		(Story) => (
			<div style={{ width: 'min(760px, 100%)', paddingBlock: 80 }}>
				<Story />
			</div>
		),
	],
} satisfies Meta<typeof FileEditSummary>;
export default meta;
type Story = StoryObj<typeof meta>;
export const OneFile: Story = { args: { calls: [patchCall('one', paths.slice(0, 1))] } };
export const FiveFiles: Story = { args: { calls: [patchCall('five', paths.slice(0, 5))] } };
export const ManyFiles: Story = { args: { calls: [patchCall('many', paths)] } };
export const RepeatedEdits: Story = {
	args: { calls: [patchCall('first', paths.slice(0, 2)), patchCall('second', paths.slice(0, 1))] },
};
export const LongPaths: Story = {
	args: {
		calls: [
			patchCall('long', [
				'src/components/settings/personalization/controls/VeryLongComponentNameWithAdditionalDescriptiveWords.tsx',
			]),
		],
	},
};
export const NoEdits: Story = {
	args: { calls: [] },
	parameters: {
		docs: {
			description: { story: 'The real component renders nothing when no successful edits exist.' },
		},
	},
};
