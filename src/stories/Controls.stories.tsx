import type { Meta, StoryObj } from '@storybook/react-vite';
import { useArgs } from 'storybook/preview-api';
import Select from '../components/Select';

const options = [
	{ value: 'chat', label: 'Chat', description: 'Learn, explore, and chat' },
	{ value: 'code', label: 'Code', description: 'Work, build, and debug' },
	{
		value: 'images',
		label: 'Images',
		description: 'Create and edit images',
		separatorBefore: true,
	},
	{ value: 'video', label: 'Video', description: 'No video model configured', disabled: true },
];

const meta = {
	title: 'Controls/Select',
	component: Select,
	parameters: {
		docs: {
			description: {
				component:
					'Source: src/components/Select.tsx · Styles: src/components/controls.css. Menus use the real body portal and keyboard interaction.',
			},
		},
	},
	args: { value: 'chat', options, 'aria-label': 'Workspace', onChange: () => {} },
	argTypes: { onChange: { control: false }, leadingIcon: { control: false } },
	render: function Render(args) {
		const [, updateArgs] = useArgs();
		return (
			<div style={{ width: 'min(100%, 320px)', minHeight: 300 }}>
				<Select {...args} onChange={(value) => updateArgs({ value })} />
			</div>
		);
	},
} satisfies Meta<typeof Select>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Interactive: Story = {};
export const Placeholder: Story = { args: { value: '', placeholder: 'Choose a workspace' } };
export const Disabled: Story = { args: { disabled: true } };
export const LongLabels: Story = {
	args: {
		options: [
			{
				value: 'chat',
				label: 'An unusually long workspace name to check truncation',
				description:
					'A long secondary description which should wrap without shrinking the main label or pushing the chevron outside the control.',
			},
			...options.slice(1),
		],
	},
};
