import { describe, expect, it } from 'vitest';
import type { ToolSettings } from '../src/agent-types';
import type { Connection, ModelDefinition } from '../src/types';
import { configuredImageTool, imageToolGuidance } from '../src/lib/image-tool';
import { machineIndependentTools } from '../src/lib/conversation-tools';

const model: ModelDefinition = {
	id: 'image-edit-model',
	name: 'Configured image editor',
	enabled: true,
	tasks: ['images'],
	inputModalities: ['text', 'image'],
	outputModalities: ['image'],
	thinkingModes: [],
	defaultImagePreset: 'native',
	imagePresets: [
		{
			id: 'native',
			name: 'Native resolution',
			defaultAspectRatio: 'square',
			aspectRatios: [
				{ id: 'square', name: '1:1', width: 2048, height: 2048 },
				{ id: 'portrait', name: '3:4', width: 1792, height: 2400 },
				{ id: 'wide', name: '16:9', width: 2752, height: 1536 },
			],
		},
	],
};

function fixture(): { connection: Connection; config: ToolSettings['imageGeneration'] } {
	return {
		connection: {
			id: 'images',
			name: 'Image API',
			baseUrl: 'https://images.invalid/v1',
			apiKey: 'PRIVATE_IMAGE_API_KEY',
			chatApi: 'responses',
			models: { chat: '', images: model.id, videos: '', speech: '', transcription: '' },
			discoveredModels: [model.id],
			catalog: [structuredClone(model)],
		},
		config: { enabled: true, connectionId: 'images', model: model.id, size: '', quality: '' },
	};
}

describe('image edit size guidance', () => {
	it.each(['chat', 'code'] as const)(
		'keeps %s size optional while offering configured dimensions for edits',
		(kind) => {
			const { connection, config } = fixture();
			const tool = configuredImageTool(connection, config, kind);
			const properties = tool.parameters.properties as Record<string, unknown>;
			expect(properties.size).toMatchObject({ type: 'string', maxLength: 128 });
			expect(tool.parameters.required).toEqual(['prompt']);
			const guidance = (properties.size as { description: string }).description;
			expect(guidance).toMatch(/edits, honor requested output dimensions first/i);
			expect(guidance).toMatch(
				/no saved default.*explicitly pass size.*preferred group.*reference aspect ratio/i,
			);
			expect(guidance).toMatch(/lower-resolution provider edit default/i);
			expect(guidance).toMatch(/do not use preview dimensions as the desired output size/i);
			expect(guidance).toMatch(/explicit user request for auto is valid/i);
			for (const dimensions of ['2048x2048', '1792x2400', '2752x1536'])
				expect(JSON.stringify(properties.size)).toContain(dimensions);
			expect(JSON.stringify(tool)).not.toContain(connection.apiKey);
			if (kind === 'chat') {
				expect(properties).not.toHaveProperty('referenced_image_paths');
				expect(properties).toHaveProperty('num_last_images_to_include');
			} else expect(properties).toHaveProperty('referenced_image_paths');
		},
	);

	it('retains size and recommendations when an already-configured Chat tool is filtered again', () => {
		const { connection, config } = fixture();
		const tool = configuredImageTool(connection, config, 'chat');
		const filtered = machineIndependentTools([tool])[0];
		expect(filtered.parameters).toEqual(tool.parameters);
		expect(filtered.parameters.required).not.toContain('size');
		expect(filtered.description).toMatch(/optional.*size/i);
		expect(JSON.stringify(filtered.parameters)).toContain('1792x2400');
		expect(filtered.parameters.properties).not.toHaveProperty('referenced_image_paths');
	});

	it('does not invent dimensions for an unknown model', () => {
		const { connection, config } = fixture();
		config.model = 'custom-editor-without-presets';
		const guidance = imageToolGuidance(connection, config);
		expect(guidance).toContain('No aspect ratio/resolution recommendations');
		expect(guidance).toContain('Use auto or omit size');
		expect(guidance).toContain('do not invent supported resolutions');
		expect(guidance).not.toContain('1792x2400');
		expect(guidance).not.toContain('explicitly pass size');
	});

	it('treats presets from an incompatible API quality as unavailable', () => {
		const { connection, config } = fixture();
		connection.catalog![0].imagePresets![0].quality = 'high';
		config.quality = 'low';
		const guidance = imageToolGuidance(connection, config);
		expect(guidance).toContain('API quality is fixed to low');
		expect(guidance).toContain('Use auto or omit size');
		expect(guidance).not.toContain('Native resolution');
		expect(guidance).not.toContain('2752x1536');
		expect(guidance).not.toContain('explicitly pass size');
	});

	it('preserves a saved provider-specific size and keeps per-call overrides available', () => {
		const { connection, config } = fixture();
		config.size = 'provider-high-resolution';
		const guidance = imageToolGuidance(connection, config);
		expect(guidance).toContain('saved default: provider-high-resolution');
		expect(guidance).toMatch(/per-call size overrides the saved default/i);
		expect(guidance).toContain('auto');
	});
});
