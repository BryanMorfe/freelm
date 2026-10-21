import type { ImageQualityPreset } from '../types';

const ratios = ['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16'];

function preset(id: string, name: string, sizes: [number, number][]): ImageQualityPreset {
	return {
		id,
		name,
		defaultAspectRatio: '1:1',
		aspectRatios: sizes.map(([width, height], index) => ({
			id: ratios[index],
			name: ratios[index],
			width,
			height,
		})),
	};
}

/** Editable suggestions, applied explicitly per connection. Sources and derivations: docs/image-presets.md. */
export function recommendedImagePresets(modelId: string): ImageQualityPreset[] {
	const id = modelId.trim().toLowerCase().split('/').pop();
	if (id === 'qwen-image-2.1')
		return [
			preset('native-2k', '2K · recommended', [
				[2048, 2048],
				[2400, 1792],
				[1792, 2400],
				[2528, 1696],
				[1696, 2528],
				[2752, 1536],
				[1536, 2752],
			]),
		];
	if (id === 'qwen-image' || id === 'qwen-image-2512')
		return [
			preset('native', 'Recommended', [
				[1328, 1328],
				[1472, 1104],
				[1104, 1472],
				[1584, 1056],
				[1056, 1584],
				[1664, 928],
				[928, 1664],
			]),
		];
	if (id && /^qwen-image-edit(?:-2509|-2511)?$/.test(id))
		return [
			preset('pipeline-1mp', '~1 MP · derived', [
				[1024, 1024],
				[1184, 896],
				[896, 1184],
				[1248, 832],
				[832, 1248],
				[1376, 768],
				[768, 1376],
			]),
		];
	if (id === 'krea2-turbo' || id === 'krea-2-turbo')
		return [
			preset('long-edge-1k', '1K · derived ratios', [
				[1024, 1024],
				[1024, 768],
				[768, 1024],
				[1024, 688],
				[688, 1024],
				[1024, 576],
				[576, 1024],
			]),
			preset('long-edge-2k', '2K · derived ratios', [
				[2048, 2048],
				[2048, 1536],
				[1536, 2048],
				[2048, 1360],
				[1360, 2048],
				[2048, 1152],
				[1152, 2048],
			]),
		];
	return [];
}
