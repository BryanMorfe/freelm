import type { Meta, StoryObj } from '@storybook/react-vite';
import ConversationSources from '../../components/ConversationSources';
import type { ConversationSourcesData } from '../../lib/conversation-sources';
import type { TaskOutputsData } from '../../lib/task-outputs';
import { timestamp } from './fixtures';

const idle = { searches: 0, opens: 0, finds: 0, views: 0, failedCalls: 0 };
const emptySources: ConversationSourcesData = {
	items: [],
	web: idle,
	images: idle,
	hasSources: false,
	truncated: false,
};
const sources: ConversationSourcesData = {
	...emptySources,
	hasSources: true,
	items: [
		{
			id: 'notes',
			kind: 'upload',
			title: 'design-notes.txt',
			attachment: {
				name: 'design-notes.txt',
				type: 'text/plain',
				dataUrl: 'data:text/plain;base64,VXNlIHNoYXJlZCBzcGFjaW5nIHRva2Vucy4=',
			},
			provided: true,
			searched: 0,
			opened: 0,
			viewed: 0,
			read: true,
		},
		{
			id: 'source-one',
			kind: 'web',
			title: 'Accessible navigation',
			url: 'https://example.com/accessible-navigation',
			provided: false,
			searched: 1,
			opened: 1,
			viewed: 0,
			read: true,
		},
		{
			id: 'source-two',
			kind: 'web',
			title:
				'A long source title that demonstrates wrapping and path truncation within a compact pinned summary',
			url: 'https://example.org/design/patterns/a-long-path-for-demonstrating-horizontal-truncation',
			provided: false,
			searched: 1,
			opened: 0,
			viewed: 0,
			read: false,
		},
	],
};
const emptyOutputs: TaskOutputsData = {
	items: [],
	hasOutputs: false,
	truncated: false,
	notices: [],
};
const outputs: TaskOutputsData = {
	...emptyOutputs,
	hasOutputs: true,
	items: [
		'design-notes.txt',
		'theme-tokens.json',
		'navigation-report.txt',
		'spacing-report.txt',
		'keyboard-checks.txt',
		'summary.txt',
		'implementation-notes.txt',
	].map((title, index) => ({
		id: `artifact-${index}`,
		kind: 'file',
		title,
		path: `preview/reports/${title}`,
		mimeType: 'text/plain',
		dataUrl: 'data:text/plain;base64,VGhpcyBpcyBhIHN5bnRoZXRpYyBTdG9yeWJvb2sgcHJldmlldy4=',
		messageId: 'example-assistant',
		callId: 'example-call',
		toolName: 'example_tool',
		createdAt: timestamp,
	})),
};

const meta = {
	title: 'Summaries/Sources and outputs',
	component: ConversationSources,
	parameters: {
		docs: {
			description: {
				component:
					'Actual src/components/ConversationSources.tsx and TaskOutputs.tsx with their production styles. These are embedded, synthetic text artifacts, so previews need no filesystem or desktop access. Click an output to open the real viewer; expand the uploaded notes to read them. Source links use reserved example domains.',
			},
		},
	},
	decorators: [
		(Story) => (
			<div
				style={{
					width: 'min(330px, 100%)',
					background: 'var(--panel)',
					borderRadius: 18,
					paddingTop: 10,
				}}
			>
				<Story />
			</div>
		),
	],
	args: { data: sources, outputs: emptyOutputs },
	argTypes: {
		prepareOutputRead: { control: false },
		thread: { control: false },
		workspaceId: { control: false },
		outputRoot: { control: false },
	},
} satisfies Meta<typeof ConversationSources>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Sources: Story = {};
export const Empty: Story = { args: { data: emptySources } };
export const SourcesAndOutputs: Story = {
	args: { outputs: { ...outputs, items: outputs.items.slice(0, 3) } },
};
export const OutputsOnly: Story = {
	args: { data: emptySources, outputs: { ...outputs, items: outputs.items.slice(0, 3) } },
};
export const ManyOutputs: Story = { args: { outputs } };
export const SearchWithoutResults: Story = {
	args: {
		data: {
			...emptySources,
			web: { ...idle, searches: 2, failedCalls: 1 },
			images: { ...idle, searches: 1 },
			hasSources: true,
		},
	},
};
