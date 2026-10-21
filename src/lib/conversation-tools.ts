import type { ToolDefinition } from '../agent-types';
import { isMemoryTool } from './memory-tools';

/** Remove local-file parameters from the image capability offered in Chat. */
export function chatImageTools(tools: readonly ToolDefinition[]): ToolDefinition[] {
	return tools
		.filter((tool) => tool.name === 'image_gen.imagegen')
		.map((tool) => {
			const parameters = structuredClone(tool.parameters);
			const properties = parameters.properties as Record<string, unknown> | undefined;
			if (properties) delete properties.referenced_image_paths;
			if (Array.isArray(parameters.required))
				parameters.required = parameters.required.filter(
					(value) => value !== 'referenced_image_paths',
				);
			return {
				...tool,
				description:
					'Generate or edit an image using the configured API image model. Optional size accepts WIDTHxHEIGHT in pixels or auto for both generation and edits. For edits use uploaded images through num_last_images_to_include, and consult the size parameter for configured resolution recommendations; use an explicit recommended size when recommendations are available and no saved default or user-requested size is specified. Chat has no access to local file paths.',
				parameters,
			};
		});
}

export function assertChatImageCall(name: string, args: Record<string, unknown>): void {
	if (name !== 'image_gen.imagegen')
		throw new Error('Commands, local files, MCP, and skills are available only in Code.');
	if (Object.hasOwn(args, 'referenced_image_paths'))
		throw new Error(
			'Chat cannot read local file paths. Attach reference images to this conversation.',
		);
}

/** Video references in Chat can only come from images attached to the conversation. */
export function chatVideoTools(tools: readonly ToolDefinition[]): ToolDefinition[] {
	return tools
		.filter((tool) => tool.name === 'video_gen.videogen')
		.map((tool) => {
			const parameters = structuredClone(tool.parameters);
			const properties = parameters.properties as Record<string, unknown> | undefined;
			if (properties) delete properties.referenced_image_paths;
			if (Array.isArray(parameters.required))
				parameters.required = parameters.required.filter(
					(value) => value !== 'referenced_image_paths',
				);
			return {
				...tool,
				description:
					'Generate a video using the configured video API. Optionally animate the most recent attached image with num_last_images_to_include: 1. Chat cannot read local files. The tool waits for the provider job, applies configured moderation, and returns a playable video. Generation may take hours; do not repeat a pending call. Consult size and seconds for model-specific defaults.',
				parameters,
			};
		});
}

export function assertChatVideoCall(name: string, args: Record<string, unknown>): void {
	if (name !== 'video_gen.videogen')
		throw new Error('Commands, local files, MCP, and skills are available only in Code.');
	if (Object.hasOwn(args, 'referenced_image_paths'))
		throw new Error(
			'Chat cannot read local file paths. Attach a reference image to this conversation.',
		);
}

/** Chat can use configured content APIs and web browsing without host filesystem access. */
export function machineIndependentTools(tools: readonly ToolDefinition[]): ToolDefinition[] {
	return tools.flatMap((tool) => {
		// Plugin catalogs are host-filtered by explicit account/tool grants. This never admits raw MCP.
		if (tool.source === 'plugin') return [{ ...tool }];
		if (
			(tool.name === 'web.run' ||
				tool.name === 'image.view' ||
				tool.name === 'python.exec' ||
				isMemoryTool(tool.name)) &&
			tool.source === 'builtin'
		)
			return [{ ...tool }];
		return [...chatImageTools([tool]), ...chatVideoTools([tool])];
	});
}

export function assertChatToolCall(name: string, args: Record<string, unknown>): void {
	if (name === 'web.run' || name === 'image.view' || name === 'python.exec' || isMemoryTool(name))
		return;
	if (name === 'video_gen.videogen') return assertChatVideoCall(name, args);
	assertChatImageCall(name, args);
}
