import type {
	AppState,
	Connection,
	ModelDefinition,
	Project,
	ThinkingMode,
	Thread,
} from '../../types';

// Deliberately synthetic: these stories never load a profile or contact a provider.
export const thinkingModes: ThinkingMode[] = [
	{
		id: 'low',
		name: 'Low',
		parameters: { responses: { reasoning: { effort: 'low' } }, chat: { reasoning_effort: 'low' } },
	},
	{
		id: 'high',
		name: 'High',
		parameters: {
			responses: { reasoning: { effort: 'high' } },
			chat: { reasoning_effort: 'high' },
		},
	},
];

export const modelCatalog: ModelDefinition[] = [
	{
		id: 'example-chat',
		name: 'Example reasoning model',
		enabled: true,
		tasks: ['chat'],
		inputModalities: ['text', 'image'],
		outputModalities: ['text'],
		thinkingModes,
		defaultThinkingMode: 'high',
		contextWindow: 128000,
	},
	{
		id: 'example-chat-disabled',
		name: 'Disabled text model',
		enabled: false,
		tasks: ['chat'],
		inputModalities: ['text'],
		outputModalities: ['text'],
		thinkingModes,
	},
	{
		id: 'example-image',
		name: 'Example image model',
		enabled: true,
		tasks: ['images'],
		inputModalities: ['text', 'image'],
		outputModalities: ['image'],
		thinkingModes: [],
		defaultImagePreset: '2k',
		imagePresets: [
			{
				id: '2k',
				name: '2K · recommended',
				defaultAspectRatio: 'square',
				aspectRatios: [
					{ id: 'square', name: '1:1', width: 2048, height: 2048 },
					{ id: 'landscape', name: '4:3', width: 2400, height: 1792 },
					{ id: 'portrait', name: '3:4', width: 1792, height: 2400 },
					{ id: 'wide', name: '16:9', width: 2752, height: 1536 },
				],
			},
		],
	},
	{
		id: 'example-video',
		name: 'Example video model',
		enabled: true,
		tasks: ['videos'],
		inputModalities: ['text', 'image'],
		outputModalities: ['video'],
		thinkingModes: [],
	},
	{
		id: 'example-speech',
		name: 'Example speech model',
		enabled: true,
		tasks: ['speech'],
		inputModalities: ['text'],
		outputModalities: ['audio'],
		thinkingModes: [],
	},
	{
		id: 'example-transcription',
		name: 'Example transcription model',
		enabled: true,
		tasks: ['transcription'],
		inputModalities: ['audio'],
		outputModalities: ['text'],
		thinkingModes: [],
	},
];

export const connection: Connection = {
	id: 'storybook-local',
	name: 'Local API',
	baseUrl: 'https://example.invalid/v1',
	apiKey: '',
	chatApi: 'responses',
	models: {
		chat: 'example-chat',
		images: 'example-image',
		videos: 'example-video',
		speech: 'example-speech',
		transcription: 'example-transcription',
	},
	discoveredModels: ['example-unconfigured'],
	catalog: modelCatalog,
};

export const connections: Connection[] = [
	connection,
	{ ...connection, id: 'storybook-remote', name: 'Remote workstation' },
];

const timestamp = Date.UTC(2026, 9, 10, 12);
const projects: Project[] = [
	{
		id: 'chat-research',
		kind: 'chat',
		name: 'Ideas and research',
		instructions: '',
		createdAt: timestamp,
	},
	{ id: 'chat-travel', kind: 'chat', name: 'Travel plans', instructions: '', createdAt: timestamp },
	{
		id: 'code-mosaic',
		kind: 'code',
		name: 'Mosaic',
		instructions: '',
		directories: ['/example/projects/mosaic'],
		createdAt: timestamp,
	},
	{
		id: 'code-curves',
		kind: 'code',
		name: 'Curves',
		instructions: '',
		directories: ['/example/projects/curves'],
		createdAt: timestamp,
	},
];

function thread(
	id: string,
	title: string,
	kind: 'chat' | 'code',
	projectId?: string,
	pinned = false,
): Thread {
	return {
		id,
		title,
		kind,
		projectId,
		pinned,
		connectionId: connection.id,
		model: 'example-chat',
		thinkingMode: 'high',
		messages: [],
		createdAt: timestamp,
		updatedAt: timestamp,
	};
}

export function sidebarFixture(empty = false): AppState {
	return {
		version: 1,
		connections,
		activeConnectionId: connection.id,
		projects: empty ? [] : projects,
		threads: empty
			? []
			: [
					thread(
						'chat-selected',
						'A guide to observing the night sky',
						'chat',
						'chat-research',
						true,
					),
					thread(
						'chat-running',
						'Compare approaches to a long, detailed research question',
						'chat',
						'chat-research',
					),
					thread('chat-travel-plan', 'A weekend by the coast', 'chat', 'chat-travel'),
					thread('chat-recent', 'Learning a new language', 'chat'),
					thread('chat-recent-two', 'Ideas for a rainy afternoon', 'chat'),
					thread('code-selected', 'Build a visual notebook', 'code', 'code-mosaic', true),
					thread(
						'code-running',
						'Refine the board layout and keyboard navigation',
						'code',
						'code-mosaic',
					),
					thread('code-curves-task', 'Improve image export', 'code', 'code-curves'),
					thread('code-recent', 'Explore a small command-line tool', 'code'),
				],
		generations: [],
		theme: 'dark',
	};
}
