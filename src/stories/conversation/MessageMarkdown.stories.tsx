import type { Meta, StoryObj } from '@storybook/react-vite';
import MessageMarkdown from '../../components/MessageMarkdown';
import { searchCall } from './fixtures';

const meta = {
	title: 'Conversation/Markdown',
	component: MessageMarkdown,
	parameters: {
		docs: {
			description: {
				component:
					'Actual src/components/MessageMarkdown.tsx with app message styles, math rendering, citations, and CodeBlock. Edit text in Controls for immediate Markdown feedback. Citation links point to reserved example domains; nothing is fetched automatically.',
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
	argTypes: { text: { control: 'text' } },
} satisfies Meta<typeof MessageMarkdown>;
export default meta;
type Story = StoryObj<typeof meta>;
export const RichText: Story = {
	args: {
		text: '## A compact workspace\n\nUse **shared components** to keep settings consistent. _Secondary text_ explains behavior without competing with labels.\n\n> Edit the source file and the preview updates immediately.\n\n- Preserve keyboard access\n- Reflow at narrow widths\n- Keep meaningful focus indicators\n\n| State | Appearance |\n| --- | --- |\n| Active | Shimmer |\n| Completed | Secondary |\n| Failed | Error |\n\nInline `code` stays distinct from ordinary text.',
	},
};
export const Mathematics: Story = {
	args: {
		text: 'The quadratic formula is $x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$.\n\nFor a normal distribution:\n\n$$\nf(x) = \\frac{1}{\\sigma\\sqrt{2\\pi}} e^{-\\frac{(x-\\mu)^2}{2\\sigma^2}}\n$$\n\nBoth inline and display notation use the production renderer.',
	},
};
export const CodeAndProse: Story = {
	args: {
		text: 'Use a shared spacing token:\n\n```typescript\ninterface SettingsRow {\n  title: string;\n  description?: string;\n  disabled?: boolean;\n}\n\nconst row: SettingsRow = {\n  title: "Appearance",\n  description: "Choose how FreeLM looks.",\n};\n```\n\nThe copy button uses the app’s clipboard implementation.',
	},
};
export const Citations: Story = {
	args: {
		text: 'Navigation should support keyboard use and clear focus states. [Accessible navigation](https://example.com/accessibility)\n\nKeep layout predictable across window sizes. [Desktop interface design](https://example.org/design)',
		sources: searchCall.result?.research?.sources,
	},
};
