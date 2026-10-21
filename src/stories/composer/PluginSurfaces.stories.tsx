import type { Meta, StoryObj } from '@storybook/react-vite';
import { PluginSurfacePreview } from './PluginSurfacePreview';
const meta = {
	title: 'Composer/Plugin surfaces',
	component: PluginSurfacePreview,
	args: { narrow: false, showPlaceholder: true, showDrawer: true },
	parameters: {
		docs: {
			description: {
				component:
					'General owned composer contributions, using the real Chat editor and drawer. Tab accepts the placeholder through a revision-checked command. Attach adds a text attachment through the normal draft pipeline. No inference, filesystem, or profile access.',
			},
		},
	},
} satisfies Meta<typeof PluginSurfacePreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const PlaceholderAndDrawer: Story = {};
export const Narrow: Story = { args: { narrow: true } };
export const DrawerOnly: Story = { args: { showPlaceholder: false } };
export const PlaceholderOnly: Story = { args: { showDrawer: false } };
