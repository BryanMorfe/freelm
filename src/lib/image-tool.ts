import type { ConversationKind, Connection } from '../types';
import type { ToolDefinition, ToolSettings } from '../agent-types';
import { getModelDefinition } from './catalog';
import { chatImageTools } from './conversation-tools';
import { imageTool } from './interaction-tools';

type ImageConfig = ToolSettings['imageGeneration'];

/** Per-call dimensions are protocol values, never connection or model configuration. */
export function resolveImageToolSize(value: unknown, defaultSize: string): string | undefined {
	// Preserve existing provider-specific saved defaults; model overrides use the documented form.
	if (value === undefined) return defaultSize.trim() || undefined;
	if (typeof value !== 'string' || value.length > 128)
		throw new Error('Image size must be auto or WIDTHxHEIGHT in pixels.');
	const size = value.trim().toLowerCase();
	if (size === 'auto') return 'auto';
	const match = /^(\d+)\s*x\s*(\d+)$/.exec(size);
	if (!match) throw new Error('Image size must be auto or WIDTHxHEIGHT in pixels.');
	const width = Number(match[1]);
	const height = Number(match[2]);
	if (![width, height].every((dimension) => Number.isSafeInteger(dimension) && dimension > 0))
		throw new Error('Image size width and height must be positive safe whole numbers.');
	return `${width}x${height}`;
}

/** Only selected image-model metadata is exposed; no connection secrets or filesystem context. */
export function imageToolGuidance(connection: Connection | undefined, config: ImageConfig): string {
	const model = connection && getModelDefinition(connection, config.model);
	const quality = config.quality.trim();
	const presets = (model?.imagePresets || []).filter(
		(preset) => !preset.quality || preset.quality === quality,
	);
	const preferred = presets.find((preset) => preset.id === model?.defaultImagePreset) || presets[0];
	const ordered = preferred ? [preferred, ...presets.filter((preset) => preset !== preferred)] : [];
	const lines = [
		`Selected image model: ${model ? `${model.name} (${model.id})` : config.model.trim() || 'Not selected'}.`,
		'Provide size as WIDTHxHEIGHT in pixels, or auto. A per-call size overrides the saved default.',
		config.size.trim()
			? `Omit size to use the saved default: ${config.size.trim()}.`
			: 'Omit size to use the provider default.',
		quality
			? `API quality is fixed to ${quality} in Settings; size does not change quality.`
			: 'API quality uses the provider default; size does not change quality.',
		'Choose square for icons or balanced compositions, portrait for posters or phone layouts, and landscape for wide scenes or banners. Follow the user’s requested orientation. For edits, preserve the reference aspect ratio unless the user asks to change it.',
	];
	if (!ordered.length) {
		lines.push(
			'No aspect ratio/resolution recommendations are configured for this model and quality. Use auto or omit size unless the user requests explicit dimensions; do not invent supported resolutions.',
		);
		return lines.join('\n');
	}
	lines.push(
		'For image edits, honor requested output dimensions first. If no dimensions were requested and no saved default is set, explicitly pass size using a configured recommendation from the preferred group that best matches the reference aspect ratio. Omitting size or using auto can select a lower-resolution provider edit default. Keep the reference orientation unless the user requests a different composition. Model-context previews can be smaller than the original; do not use preview dimensions as the desired output size. Size remains optional, and an explicit user request for auto is valid.',
		'Configured size recommendations (choose an exact size from the appropriate group; these are editable recommendations, not a complete provider allowlist):',
	);
	// Bound prompt metadata while keeping the preferred group first and every line complete.
	for (const preset of ordered.slice(0, 8)) {
		lines.push(`${preset.name}${preset === preferred ? ' (preferred)' : ''}:`);
		for (const ratio of preset.aspectRatios.slice(0, 32)) {
			const line = `  ${ratio.name}: ${ratio.width}x${ratio.height}${ratio.id === preset.defaultAspectRatio ? ' (default aspect ratio)' : ''}`;
			if (lines.join('\n').length + line.length > 12000) return lines.join('\n');
			lines.push(line);
		}
	}
	return lines.join('\n');
}

export function configuredImageTool(
	connection: Connection | undefined,
	config: ImageConfig,
	kind: ConversationKind,
): ToolDefinition {
	const tool = structuredClone(imageTool);
	const guidance = imageToolGuidance(connection, config);
	const properties = tool.parameters.properties as Record<string, Record<string, unknown>>;
	properties.size.description = guidance;
	tool.description += `\n${guidance.split('\n')[0]} Consult the size parameter for model-specific resolution guidance.`;
	return kind === 'chat' ? chatImageTools([tool])[0] : tool;
}
