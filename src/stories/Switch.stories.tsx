import type { Meta, StoryObj } from '@storybook/react-vite';
import { useArgs } from 'storybook/preview-api';
import Switch from '../components/Switch';

const meta = {
	title: 'Controls/Switch',
	component: Switch,
	parameters: {
		docs: {
			description: {
				component:
					'Source: src/components/Switch.tsx · Styles: src/components/controls.css. Toggle in the canvas or change checked in Controls.',
			},
		},
	},
	args: { checked: false, 'aria-label': 'Enable notifications', onChange: () => {} },
	argTypes: { onChange: { control: false } },
	render: function Render(args) {
		const [, updateArgs] = useArgs();
		return <Switch {...args} onChange={(checked) => updateArgs({ checked })} />;
	},
} satisfies Meta<typeof Switch>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Off: Story = {};
export const On: Story = { args: { checked: true } };
export const DisabledOff: Story = { args: { disabled: true } };
export const DisabledOn: Story = { args: { disabled: true, checked: true } };
