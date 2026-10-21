import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import MarkdownComposer from '../../components/MarkdownComposer';
import type { ComposerContext } from '../../composer-types';
import { discoverFixture } from './fixtures';

interface EditorPreviewProps {
	value: string;
	placeholder: string;
	code: boolean;
	busy: boolean;
	disabled: boolean;
}

function EditorPreview({ value: initialValue, ...args }: EditorPreviewProps) {
	const [value, setValue] = useState(initialValue);
	const [context, setContext] = useState<ComposerContext>({});
	const [notice, setNotice] = useState('');
	useEffect(() => {
		setValue(initialValue);
		setContext({});
		setNotice('');
	}, [initialValue]);
	return (
		<div style={{ width: 'min(760px, 100%)', paddingTop: args.code ? 250 : 0 }}>
			<div className="composer">
				<MarkdownComposer
					{...args}
					value={value}
					context={context}
					onContextChange={setContext}
					discover={discoverFixture}
					onChange={setValue}
					onBlur={() => {}}
					onSubmit={() => {
						if (!value.trim()) return;
						setNotice(`Preview ${args.busy ? 'queued' : 'sent'}: ${value}`);
						setValue('');
					}}
					onRestorePrevious={() => {
						setValue('Restore the previous prompt and preserve my formatting.');
						return true;
					}}
					onFiles={(files) =>
						setNotice(`Preview received ${files.length} file(s); nothing is uploaded.`)
					}
					onRequestFiles={() =>
						setNotice(
							'The real app opens a file picker here. This preview never reads local files.',
						)
					}
					onLargePaste={(text) =>
						setNotice(
							`Large paste captured: ${text.length.toLocaleString()} characters. Nothing was saved.`,
						)
					}
					onError={setNotice}
				/>
			</div>
			{context.mode && <p style={{ color: 'var(--muted)' }}>Selected mode: {context.mode}</p>}
			{notice && (
				<p
					role="status"
					style={{ color: 'var(--muted)', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}
				>
					{notice}
				</p>
			)}
		</div>
	);
}

const meta = {
	title: 'Composer/Markdown editor',
	component: EditorPreview,
	parameters: {
		docs: {
			description: {
				component:
					'Actual src/components/MarkdownComposer.tsx, inside the app’s .composer shell. Edit src/components/markdown-composer.css or src/styles.css for live changes. Enter sends only to local preview state; Shift+Enter inserts a newline. In Code, type / for commands and skills, or @ for local fixture suggestions. Arrow Up restores a preview prompt when empty.',
			},
		},
	},
	args: { value: '', placeholder: 'Ask anything', code: false, busy: false, disabled: false },
	argTypes: {
		value: { control: 'text' },
		placeholder: { control: 'text' },
		code: { control: 'boolean' },
		busy: { control: 'boolean' },
		disabled: { control: 'boolean' },
	},
} satisfies Meta<typeof EditorPreview>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};
export const Typing: Story = {
	args: { value: 'Can you help me refine the spacing in our settings?' },
};
export const Mathematics: Story = {
	args: {
		value:
			'Explain why $e^{i\\pi}+1=0$.\n\nThen derive:\n\n$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$\n\nKeep the explanation concise.',
	},
};
export const MarkdownAndCode: Story = {
	args: {
		value:
			'## Review this function\n\nPlease check the **empty state** and _keyboard interaction_.\n\n```typescript\nfunction greet(name: string) {\n  return `Hello, ${name}`;\n}\n```\n\n- Preserve existing behavior\n- Explain the changes',
	},
};
export const LongDraft: Story = {
	args: {
		value: Array.from(
			{ length: 18 },
			(_, index) =>
				`${index + 1}. Design a useful notebook screen with clear typography, accessible controls, and keyboard shortcuts. Keep its layout responsive without shrinking primary text.`,
		).join('\n\n'),
	},
};
export const CodeCommandsAndMentions: Story = {
	args: { code: true, placeholder: 'Type / or @ to explore suggestions' },
};
export const WorkingStillEditable: Story = {
	args: { code: true, busy: true, value: 'One more thing: check keyboard focus after saving.' },
};
export const Disabled: Story = {
	args: { disabled: true, value: 'This input is temporarily disabled.' },
};
