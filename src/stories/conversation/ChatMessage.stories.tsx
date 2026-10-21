import { useState, type ComponentProps } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import ChatMessage from '../../components/ChatMessage';
import {
	assistantMessage,
	commandCall,
	historyCalls,
	historyParts,
	searchCall,
	timestamp,
} from './fixtures';

function InteractiveMessage(args: ComponentProps<typeof ChatMessage>) {
	const [message, setMessage] = useState(args.message);
	const [notice, setNotice] = useState('');
	const [version, setVersion] = useState(args.versions?.index ?? 0);
	return (
		<>
			<ChatMessage
				{...args}
				message={message}
				onEdit={
					message.role === 'user'
						? (content, attachments) => {
								setMessage({ ...message, content, attachments });
								setNotice('Edited locally in this preview.');
							}
						: undefined
				}
				onRetry={
					message.role === 'assistant'
						? () => {
								setNotice('Regeneration requested (preview only).');
							}
						: undefined
				}
				onBranch={
					message.role === 'assistant'
						? () => setNotice('Branch requested (preview only).')
						: undefined
				}
				onReply={
					message.role === 'assistant' ? (text) => setNotice(`Reply selection: ${text}`) : undefined
				}
				versions={args.versions ? { ...args.versions, index: version } : undefined}
				onSelectVersion={
					args.versions
						? (direction) =>
								setVersion((current) =>
									Math.max(0, Math.min(args.versions!.count - 1, current + direction)),
								)
						: undefined
				}
			/>
			{notice && (
				<p
					role="status"
					style={{ color: 'var(--muted)', fontSize: 'var(--font-size-ui)', marginTop: 20 }}
				>
					{notice}
				</p>
			)}
		</>
	);
}

const meta = {
	title: 'Conversation/Messages',
	component: ChatMessage,
	parameters: {
		docs: {
			description: {
				component:
					'Actual src/components/ChatMessage.tsx. Hover to see actions; user edits and version navigation stay local to the preview. Branch, regenerate, and reply display a local status. Nothing calls a model or changes your history. Select assistant text to inspect the reply action.',
			},
		},
	},
	decorators: [
		(Story) => (
			<div className="messages" style={{ width: 'min(760px, 100%)', margin: 0 }}>
				<Story />
			</div>
		),
	],
	args: {
		message: assistantMessage,
		modelName: 'Example model',
		modelId: 'example-model',
		live: false,
		retryDisabled: false,
		conversationKind: 'chat',
		timeZone: 'America/New_York',
		debugMode: false,
	},
	argTypes: {
		onRetry: { control: false },
		onEdit: { control: false },
		onBranch: { control: false },
		onReply: { control: false },
		onSelectVersion: { control: false },
		conversationKind: { control: 'radio', options: ['chat', 'code'] },
	},
	render: (args) => (
		<InteractiveMessage
			key={JSON.stringify(args.message) + String(args.live) + String(args.versions?.count)}
			{...args}
		/>
	),
} satisfies Meta<typeof ChatMessage>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Assistant: Story = {};
export const User: Story = {
	args: {
		message: {
			id: 'example-user',
			role: 'user',
			content: 'Tighten the navigation spacing and keep the labels readable at narrow widths.',
			createdAt: timestamp,
		},
	},
};
export const UserWithAttachment: Story = {
	args: {
		message: {
			id: 'example-user-attachment',
			role: 'user',
			content: 'Please review these notes.',
			createdAt: timestamp,
			attachments: [
				{
					name: 'design-notes.txt',
					type: 'text/plain',
					dataUrl: 'data:text/plain;base64,VXNlIHNoYXJlZCBzcGFjaW5nIHRva2Vucy4=',
				},
			],
		},
	},
};
export const Versions: Story = { args: { versions: { index: 0, count: 3 } } };
export const Thinking: Story = {
	args: {
		live: true,
		message: {
			...assistantMessage,
			content: '',
			phase: 'working',
			completedAt: undefined,
			activityFinishedAt: undefined,
		},
	},
};
export const StreamingAnswer: Story = {
	args: {
		live: true,
		message: {
			...assistantMessage,
			content:
				'The navigation now uses shared spacing tokens. I also checked the keyboard focus order and',
			phase: 'responding',
			completedAt: undefined,
		},
	},
};
export const FailedResponse: Story = {
	args: {
		message: {
			...assistantMessage,
			content: '',
			error: 'The connection closed before the response completed. You can retry this message.',
		},
	},
};
export const CodeWorking: Story = {
	args: {
		live: true,
		conversationKind: 'code',
		message: {
			...assistantMessage,
			content: '',
			phase: 'tools',
			completedAt: undefined,
			activityFinishedAt: undefined,
			toolCalls: historyCalls,
			activity: historyParts,
		},
	},
};
const doneCalls = historyCalls.map((call) =>
	call.id === 'test' ? commandCall('test', 'npm run test -- navigation') : call,
);
export const CodeCompleted: Story = {
	args: {
		conversationKind: 'code',
		message: {
			...assistantMessage,
			toolCalls: doneCalls,
			activity: [...historyParts, { type: 'text', id: 'final', text: assistantMessage.content }],
		},
	},
};
export const ResearchAnswer: Story = {
	args: {
		message: {
			...assistantMessage,
			content:
				'The examples emphasize visible focus and predictable navigation. [Accessible navigation](https://example.com/accessibility)',
			toolCalls: [searchCall],
			activity: [
				{ type: 'tool', id: 'research-tool', toolCallId: searchCall.id },
				{
					type: 'text',
					id: 'research-final',
					text: 'The examples emphasize visible focus and predictable navigation. [Accessible navigation](https://example.com/accessibility)',
				},
			],
		},
	},
};
