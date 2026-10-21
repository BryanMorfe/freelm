import type { Meta, StoryObj } from '@storybook/react-vite';
import CodeBlock from '../../components/CodeBlock';

const meta = {
	title: 'Conversation/Code blocks',
	component: CodeBlock,
	parameters: {
		docs: {
			description: {
				component:
					'Actual src/components/CodeBlock.tsx with production syntax highlighting and horizontal scrolling. Copy code writes only the displayed fixture text to your clipboard.',
			},
		},
	},
	decorators: [
		(Story) => (
			<div className="message assistant" style={{ width: 'min(760px, 100%)' }}>
				<Story />
			</div>
		),
	],
	args: {
		language: 'typescript',
		text: 'type Theme = "light" | "dark";\n\nexport function applyTheme(theme: Theme) {\n  document.documentElement.dataset.theme = theme;\n}',
	},
	argTypes: { text: { control: 'text' }, language: { control: 'text' } },
} satisfies Meta<typeof CodeBlock>;
export default meta;
type Story = StoryObj<typeof meta>;
export const TypeScript: Story = {};
export const Shell: Story = {
	args: {
		language: 'bash',
		text: '# Display-only sample: this command is never executed\nnpm run storybook\n',
	},
};
export const PlainText: Story = {
	args: {
		language: undefined,
		text: 'Preview ready.\nSource changes update the catalog automatically.',
	},
};
export const LongLine: Story = {
	args: {
		language: 'json',
		text: JSON.stringify({
			title: 'Long lines stay inside the code block',
			description: 'Horizontal scrolling should remain inside this component. '.repeat(12),
			enabled: true,
		}),
	},
};
