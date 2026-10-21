import type { Connection, QueuedCodeMessage } from '../../types';
import type { CodeGoal } from '../../lib/code-goals';
import type { ComposerDiscoveryResult } from '../../composer-types';

export const fixtureTime = Date.UTC(2026, 9, 10, 16);

/** Story-only data: no user profile, network connection, or tool bridge is loaded. */
export const composerConnection: Connection = {
	id: 'storybook-local',
	name: 'Component preview',
	baseUrl: 'https://preview.invalid/v1',
	apiKey: '',
	chatApi: 'responses',
	models: {
		chat: 'qwen-chat',
		images: 'qwen-image',
		videos: 'video-model',
		speech: '',
		transcription: '',
	},
	discoveredModels: ['qwen-chat', 'small-chat', 'unconfigured-chat', 'qwen-image', 'video-model'],
	catalog: [
		{
			id: 'qwen-chat',
			name: 'Qwen 3.8 27B',
			enabled: true,
			tasks: ['chat'],
			inputModalities: ['text', 'image'],
			outputModalities: ['text'],
			thinkingModes: ['low', 'medium', 'high', 'max'].map((id) => ({
				id,
				name: id[0].toUpperCase() + id.slice(1),
				parameters: { responses: { reasoning: { effort: id } } },
			})),
			defaultThinkingMode: 'medium',
		},
		{
			id: 'small-chat',
			name: 'Small model · fast responses',
			enabled: true,
			tasks: ['chat'],
			inputModalities: ['text'],
			outputModalities: ['text'],
			thinkingModes: [
				{ id: 'low', name: 'Low', parameters: { responses: { reasoning: { effort: 'low' } } } },
			],
			defaultThinkingMode: 'low',
		},
		{
			id: 'unconfigured-chat',
			name: 'Model needing configuration',
			enabled: true,
			tasks: ['chat'],
			inputModalities: ['text'],
			outputModalities: ['text'],
			thinkingModes: [],
		},
		{
			id: 'qwen-image',
			name: 'Qwen Image 2.1',
			enabled: true,
			tasks: ['images'],
			inputModalities: ['text', 'image'],
			outputModalities: ['image'],
			thinkingModes: [],
		},
		{
			id: 'video-model',
			name: 'Video model',
			enabled: true,
			tasks: ['videos'],
			inputModalities: ['text', 'image'],
			outputModalities: ['video'],
			thinkingModes: [],
		},
	],
};

export const goalFixture: CodeGoal = {
	id: 'preview-goal',
	objective: 'Build a cross-platform visual notebook with import and export',
	status: 'active',
	createdAt: fixtureTime,
	updatedAt: fixtureTime,
	usedTokens: 12640,
	tokenBudget: 64000,
	elapsedMs: 184000,
	turns: 3,
};

export const queuedFixtures: QueuedCodeMessage[] = [
	{
		id: 'queue-first',
		createdAt: fixtureTime,
		content:
			'Keep the existing keyboard shortcuts, and make the import flow work on Linux and macOS. Add clear empty and loading states.',
	},
	{
		id: 'queue-second',
		createdAt: fixtureTime + 1,
		content: 'Also verify the narrow window layout before you finish.',
		replyTo: { messageId: 'preview-response', text: 'I will start with the board layout.' },
		attachments: [
			{
				name: 'layout-notes.md',
				type: 'text/markdown',
				dataUrl: 'data:text/markdown,Preview%20notes',
			},
		],
	},
];

export async function discoverFixture({
	kind,
	query,
}: {
	kind: 'files' | 'skills' | 'apps';
	query: string;
}): Promise<ComposerDiscoveryResult> {
	const items: ComposerDiscoveryResult['items'] =
		kind === 'files'
			? [
					{
						kind: 'file',
						id: 'app',
						label: 'App.tsx',
						path: 'src/App.tsx',
						description: 'Application entry point',
					},
					{
						kind: 'file',
						id: 'styles',
						label: 'styles.css',
						path: 'src/styles.css',
						description: 'Shared application styles',
					},
					{
						kind: 'folder',
						id: 'components',
						label: 'components',
						path: 'src/components',
						description: 'Workspace folder',
					},
				]
			: kind === 'skills'
				? [
						{
							kind: 'skill',
							id: 'frontend-testing',
							label: 'frontend-testing',
							path: '/preview/skills/frontend-testing/SKILL.md',
							description: 'Check layout and interactions in the browser',
						},
						{
							kind: 'skill',
							id: 'writing',
							label: 'writing',
							path: '/preview/skills/writing/SKILL.md',
							description: 'Edit clear documentation',
						},
					]
				: [
						{
							kind: 'app',
							id: 'preview.browser',
							label: 'Browser',
							path: 'preview.browser',
							description: 'Preview app; no application is launched',
						},
					];
	return {
		items: items.filter((item) =>
			`${item.label} ${item.path}`.toLowerCase().includes(query.toLowerCase()),
		),
	};
}
