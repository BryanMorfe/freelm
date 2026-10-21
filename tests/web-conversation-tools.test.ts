import { describe, expect, it } from 'vitest';
import { imageTool } from '../src/lib/interaction-tools';
import { webTool } from '../src/lib/web-tools';
import { assertChatToolCall, machineIndependentTools } from '../src/lib/conversation-tools';
import type { ToolDefinition } from '../src/agent-types';

describe('Chat web capability filtering', () => {
	it('allows built-in web browsing alongside images and removes all local work capabilities', () => {
		const localTools: ToolDefinition[] = [
			'exec_command',
			'write_stdin',
			'apply_patch',
			'view_image',
			'skills.read',
			'tool_search',
			'mcp.tool',
		].map((name) => ({
			name,
			source: name === 'mcp.tool' ? 'mcp' : 'builtin',
			description: 'Machine work',
			parameters: { type: 'object' },
		}));
		const catalog = [imageTool, webTool, ...localTools, { ...webTool, source: 'mcp' as const }];
		const selected = machineIndependentTools(catalog);
		expect(selected.map((tool) => tool.name)).toEqual(['image_gen.imagegen', 'web.run']);
		expect(
			selected.find((tool) => tool.name === 'image_gen.imagegen')!.parameters.properties,
		).not.toHaveProperty('referenced_image_paths');
		expect(imageTool.parameters.properties).toHaveProperty('referenced_image_paths');
		expect(selected.find((tool) => tool.name === 'web.run')!.parameters).toEqual(
			webTool.parameters,
		);
	});

	it('permits browsing requests while enforcing the Chat boundary for injected calls', () => {
		expect(() =>
			assertChatToolCall('web.run', { search_query: [{ q: 'a question' }] }),
		).not.toThrow();
		expect(() =>
			assertChatToolCall('web.run', { open: [{ ref_id: 'https://example.com/' }] }),
		).not.toThrow();
		expect(() => assertChatToolCall('image_gen.imagegen', { prompt: 'A drawing' })).not.toThrow();
		expect(() =>
			assertChatToolCall('image_gen.imagegen', {
				prompt: 'Private files',
				referenced_image_paths: ['/private/file.png'],
			}),
		).toThrow('Chat cannot read local file paths');
		for (const name of [
			'exec_command',
			'write_stdin',
			'apply_patch',
			'view_image',
			'skills.read',
			'tool_search',
			'mcp.tool',
		]) {
			expect(() => assertChatToolCall(name, {})).toThrow('available only in Code');
		}
	});
});
