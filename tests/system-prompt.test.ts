import { describe, expect, it } from 'vitest';
import { initialState } from '../src/lib/state';
import { defaultPersonalization } from '../src/lib/personalization';
import { buildSystemPrompt, chatPromptCatalog, promptApiTools } from '../src/lib/system-prompt';
import { defaultToolSettings } from '../src/lib/tool-settings';
import { CODE_BEHAVIOR_INSTRUCTIONS } from '../src/lib/code-behavior';
import { CODE_PLAN_INSTRUCTIONS } from '../src/lib/code-plan';
import type { AppState, Thread } from '../src/types';

function fixture(): { state: AppState; thread: Thread } {
	const state = initialState();
	state.personalization = defaultPersonalization();
	state.personalization.chat.customInstructions = 'CHAT_STYLE: speak plainly.';
	state.personalization.code.customInstructions = 'CODE_STYLE: explain verification.';
	state.systemPrompt = 'LEGACY_WORKSPACE: preserve this instruction.';
	state.projects = [
		{ id: 'a', name: 'Project A', kind: 'chat', instructions: 'PROJECT_A_RULE', createdAt: 1 },
		{
			id: 'b',
			name: 'Project B',
			kind: 'chat',
			instructions: 'FOREIGN_PROJECT_RULE',
			createdAt: 1,
		},
	];
	state.savedMemories = [
		{
			id: 'global',
			content: 'WORKSPACE_MEMORY',
			createdAt: 1,
			updatedAt: 1,
			revision: 1,
			source: 'user',
		},
		{
			id: 'project',
			projectId: 'a',
			content: 'PROJECT_A_MEMORY',
			createdAt: 1,
			updatedAt: 1,
			revision: 1,
			source: 'user',
		},
		{
			id: 'foreign',
			projectId: 'b',
			content: 'FOREIGN_MEMORY',
			createdAt: 1,
			updatedAt: 1,
			revision: 1,
			source: 'user',
		},
	];
	const thread: Thread = {
		id: 'current',
		kind: 'chat',
		projectId: 'a',
		title: 'Current',
		connectionId: state.activeConnectionId,
		model: 'text-model',
		createdAt: 1,
		updatedAt: 1,
		messages: [],
	};
	state.threads = [thread];
	return { state, thread };
}

describe('request system prompt assembly', () => {
	it('keeps Code working behavior independent of personalization, project and host-tool availability', () => {
		const { state, thread } = fixture();
		state.personalization!.code.personality = 'quirky';
		state.personalization!.code.responseLength = 'less';
		const before = structuredClone(state);
		const code = buildSystemPrompt({ state, kind: 'code', thread });
		const chat = buildSystemPrompt({ state, kind: 'chat', thread });
		expect(code.text.split(CODE_BEHAVIOR_INSTRUCTIONS)).toHaveLength(2);
		expect(code.text).toContain('Personality: Quirky.');
		expect(code.text).toContain('CODE_STYLE');
		expect(code.text).not.toContain('PROJECT_A_RULE');
		expect(code.context).toContainEqual({
			id: 'project:a',
			source: 'Project instructions (Project A)',
			text: 'PROJECT_A_RULE',
		});
		expect(code.text).toContain('LEGACY_WORKSPACE');
		expect(code.tools).toEqual([]);
		expect(chat.text).not.toContain(CODE_BEHAVIOR_INSTRUCTIONS);
		expect(chat.text).not.toContain('Task ownership and user control');
		expect(state).toEqual(before);
	});

	it('retains explicit Plan-mode restrictions alongside the mode-aware Code behavior layer', () => {
		const { state, thread } = fixture();
		thread.messages = [
			{
				id: 'plan-request',
				role: 'user',
				content: 'Implement a task runner.',
				createdAt: 1,
				composer: { mode: 'plan' },
			},
		];
		const plan = buildSystemPrompt({ state, kind: 'code', thread });
		expect(plan.text).toContain(CODE_BEHAVIOR_INSTRUCTIONS);
		expect(plan.text).toContain('Active mode instructions, especially Plan mode, take precedence');
		expect(plan.text).toContain(CODE_PLAN_INSTRUCTIONS);
		expect(plan.text.indexOf(CODE_PLAN_INSTRUCTIONS)).toBeGreaterThan(
			plan.text.indexOf(CODE_BEHAVIOR_INSTRUCTIONS),
		);
		thread.messages.push({
			id: 'implement-request',
			role: 'user',
			content: 'Implement the plan.',
			createdAt: 2,
		});
		const implementation = buildSystemPrompt({ state, kind: 'code', thread });
		expect(implementation.text).not.toContain(CODE_PLAN_INSTRUCTIONS);
		expect(implementation.text).toContain(CODE_BEHAVIOR_INSTRUCTIONS);
	});

	it('keeps existing instructions and scoped memory alongside Chat personalization without Code or foreign data', () => {
		const { state, thread } = fixture();
		const built = buildSystemPrompt({ state, kind: 'chat', thread });
		for (const text of [
			'AI assistant in FreeLM',
			'CHAT_STYLE',
			'LEGACY_WORKSPACE',
			'PROJECT_A_RULE',
			'WORKSPACE_MEMORY',
			'PROJECT_A_MEMORY',
		])
			expect(built.text).toContain(text);
		for (const text of ['CODE_STYLE', 'FOREIGN_PROJECT_RULE', 'FOREIGN_MEMORY'])
			expect(built.text).not.toContain(text);
		expect(built.tools).toHaveLength(7);
		expect(state.personalization!.code.customInstructions).toBe(
			'CODE_STYLE: explain verification.',
		);
	});

	it('keeps Code persona and actual catalog guidance without any memory tools/context', () => {
		const { state, thread } = fixture();
		const built = buildSystemPrompt({
			state,
			kind: 'code',
			thread: { ...thread, projectId: undefined },
			catalog: {
				tools: [
					{
						name: 'exec_command',
						source: 'builtin',
						description: 'Run commands.',
						parameters: { type: 'object' },
					},
				],
				instructions: 'HOST_DIRECTORY: /tmp/project',
				warnings: ['MCP server unavailable'],
			},
		});
		expect(built.text).toContain('CODE_STYLE');
		expect(built.text).toContain('HOST_DIRECTORY');
		expect(built.text).toContain('MCP server unavailable');
		for (const text of ['CHAT_STYLE', 'WORKSPACE_MEMORY', 'Memory guidance', 'PROJECT_A_RULE'])
			expect(built.text).not.toContain(text);
		expect(built.tools.map((tool) => tool.name)).toEqual(['exec_command']);
	});

	it('compiles a complete image capability preview without exposing connection secrets or initializing host tools', () => {
		const { state, thread } = fixture();
		state.connections[0].apiKey = 'SECRET_API_KEY';
		state.toolSettings = defaultToolSettings();
		state.toolSettings.imageGeneration = {
			enabled: true,
			connectionId: state.activeConnectionId,
			model: 'image-model',
			size: '2048x2048',
			quality: 'high',
		};
		const catalog = chatPromptCatalog(state);
		const built = buildSystemPrompt({ state, kind: 'chat', thread, catalog });
		expect(built.text).toContain('Selected image model: image-model');
		expect(built.text).toContain('2048x2048');
		expect(built.text).toContain('API quality is fixed to high');
		expect(JSON.stringify(built)).not.toContain('SECRET_API_KEY');
		expect(built.tools.map((tool) => tool.name)).toContain('image_gen.imagegen');
	});

	it.each(['responses', 'chat/completions'] as const)(
		'keeps optional image-edit size and configured recommendations in the %s request',
		(api) => {
			const { state, thread } = fixture();
			const connection = state.connections[0];
			connection.apiKey = 'SECRET_IMAGE_CONNECTION_KEY';
			connection.catalog = [
				{
					id: 'configured-image-editor',
					name: 'Configured image editor',
					enabled: true,
					tasks: ['images'],
					inputModalities: ['text', 'image'],
					outputModalities: ['image'],
					thinkingModes: [],
					imagePresets: [
						{
							id: 'native',
							name: 'Native 2K',
							aspectRatios: [{ id: 'portrait', name: '3:4', width: 1792, height: 2400 }],
						},
					],
				},
			];
			state.toolSettings = defaultToolSettings();
			state.toolSettings.imageGeneration = {
				enabled: true,
				connectionId: connection.id,
				model: 'configured-image-editor',
				size: '',
				quality: '',
			};
			const built = buildSystemPrompt({ state, kind: 'chat', thread });
			const image = built.tools.find((tool) => tool.name === 'image_gen.imagegen')!;
			const offered = promptApiTools([image], api)[0];
			const definition = (api === 'responses' ? offered : offered.function) as {
				description: string;
				parameters: typeof image.parameters;
			};
			expect(definition.description).toMatch(/optional.*size/i);
			expect(definition.parameters).toEqual(image.parameters);
			expect(definition.parameters.required).toEqual(['prompt']);
			expect(definition.parameters.properties).toHaveProperty('size');
			expect(definition.parameters.properties).toHaveProperty('num_last_images_to_include');
			expect(definition.parameters.properties).not.toHaveProperty('referenced_image_paths');
			for (const guidance of ['Configured image editor', '3:4: 1792x2400']) {
				expect(built.text).toContain(guidance);
				expect(JSON.stringify(definition.parameters)).toContain(guidance);
			}
			expect(JSON.stringify({ built, offered })).not.toContain(connection.apiKey);
		},
	);

	it('does not reintroduce disabled memory or unknown local Chat capabilities through a broader host catalog', () => {
		const { state, thread } = fixture();
		state.memorySettings = { savedMemories: false, referenceHistory: false };
		const built = buildSystemPrompt({
			state,
			kind: 'chat',
			thread,
			catalog: {
				tools: [
					{ name: 'exec_command', source: 'builtin', description: 'Run commands', parameters: {} },
					{
						name: 'memory.read',
						source: 'builtin',
						description: 'Untrusted replacement',
						parameters: {},
					},
				],
				instructions: 'LOCAL_SECRET_DIRECTORY',
				warnings: ['LOCAL_SECRET_WARNING'],
			},
		});
		expect(built.tools).toEqual([]);
		for (const text of ['WORKSPACE_MEMORY', 'Memory guidance', 'LOCAL_SECRET'])
			expect(built.text).not.toContain(text);
	});

	it('shows API names and protocol wrappers rather than deferred tool schemas as initially offered functions', () => {
		const { state, thread } = fixture();
		const tools = buildSystemPrompt({ state, kind: 'chat', thread }).tools;
		const deferred = { ...tools[0], name: 'mcp_deferred', deferred: true };
		const responses = promptApiTools([...tools, deferred], 'responses');
		const chat = promptApiTools([...tools, deferred], 'chat/completions');
		expect(responses).toHaveLength(7);
		expect(chat).toHaveLength(7);
		expect(responses[0]).toMatchObject({
			type: 'function',
			strict: false,
			name: expect.not.stringContaining('.'),
		});
		expect(chat[0]).toEqual({
			type: 'function',
			function: Object.fromEntries(Object.entries(responses[0]).filter(([key]) => key !== 'type')),
		});
	});
});

describe('video tool prompt preview', () => {
	it('offers configured video generation in Chat without exposing local file access or secrets', () => {
		const { state, thread } = fixture();
		state.connections[0].apiKey = 'SECRET_VIDEO_KEY';
		state.toolSettings = defaultToolSettings();
		state.toolSettings.videoGeneration = {
			enabled: true,
			connectionId: state.activeConnectionId,
			model: 'movie-model',
			size: '1920x1088',
			seconds: '15',
		};
		const built = buildSystemPrompt({
			state,
			kind: 'chat',
			thread,
			catalog: chatPromptCatalog(state),
		});
		const tool = built.tools.find((tool) => tool.name === 'video_gen.videogen');
		expect(tool).toBeDefined();
		expect(JSON.stringify(tool)).toContain('1920x1088');
		expect(JSON.stringify(tool)).not.toContain('referenced_image_paths');
		expect(JSON.stringify(built)).not.toContain('SECRET_VIDEO_KEY');
		expect(built.text).toContain('do not duplicate a pending call');
		expect(built.text).toContain('play or download');
	});
});
