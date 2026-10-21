import { describe, expect, it } from 'vitest';
import { assertModelCatalog } from '../src/lib/catalog';
import { recommendedImagePresets } from '../src/lib/image-presets';
import { recoverState, initialState } from '../src/lib/state';
import { validateState } from '../electron/validation';
import type { ImageQualityPreset, ModelDefinition } from '../src/types';

function imageModel(): ModelDefinition {
	return {
		id: 'qwen-image-2.1',
		name: 'Qwen Image 2.1',
		enabled: true,
		tasks: ['images'],
		inputModalities: ['text', 'image'],
		outputModalities: ['image'],
		thinkingModes: [],
		imagePresets: recommendedImagePresets('qwen-image-2.1'),
		defaultImagePreset: 'native-2k',
	};
}

describe('image quality and aspect ratio catalog', () => {
	it('preserves complete per-model presets across JSON, recovery, and desktop validation', () => {
		const state = initialState();
		const model = imageModel();
		model.imagePresets!.push({
			id: 'print',
			name: 'Print quality',
			quality: 'provider-print',
			aspectRatios: [{ id: 'poster', name: 'Poster', width: 4096, height: 6144 }],
			defaultAspectRatio: 'poster',
		});
		model.defaultImagePreset = 'print';
		state.connections[0].catalog = [model];
		const restored = recoverState(JSON.parse(JSON.stringify(state)));
		validateState(restored);
		expect(restored.connections[0].catalog).toEqual([model]);
	});

	it('keeps older catalogs valid and presets opt-in for unknown models', () => {
		const model = imageModel();
		delete model.imagePresets;
		delete model.defaultImagePreset;
		expect(() => assertModelCatalog([model])).not.toThrow();
		expect(recommendedImagePresets('my-provider-custom-model')).toEqual([]);
	});

	it.each([
		[
			'zero dimension',
			(preset: ImageQualityPreset) => {
				preset.aspectRatios[0].width = 0;
			},
			'positive whole',
		],
		[
			'fractional dimension',
			(preset: ImageQualityPreset) => {
				preset.aspectRatios[0].height = 512.5;
			},
			'positive whole',
		],
		[
			'nonfinite dimension',
			(preset: ImageQualityPreset) => {
				preset.aspectRatios[0].height = Infinity;
			},
			'positive whole',
		],
		[
			'empty ratios',
			(preset: ImageQualityPreset) => {
				preset.aspectRatios = [];
			},
			'between 1 and 64',
		],
		[
			'duplicate ratio ID',
			(preset: ImageQualityPreset) => {
				preset.aspectRatios.push({ ...preset.aspectRatios[0] });
			},
			'appears more than once',
		],
		[
			'unknown default ratio',
			(preset: ImageQualityPreset) => {
				preset.defaultAspectRatio = 'absent';
			},
			'default aspect ratio',
		],
		[
			'blank API quality',
			(preset: ImageQualityPreset) => {
				preset.quality = ' ';
			},
			'API quality',
		],
	] as const)('rejects %s at the catalog boundary', (_name, change, expected) => {
		const model = imageModel();
		change(model.imagePresets![0]);
		expect(() => assertModelCatalog([model])).toThrow(expected);
	});

	it('rejects duplicate profiles, dangling model defaults, and image presets on chat-only models', () => {
		const model = imageModel();
		model.imagePresets!.push(structuredClone(model.imagePresets![0]));
		expect(() => assertModelCatalog([model])).toThrow('appears more than once');
		model.imagePresets!.pop();
		model.defaultImagePreset = 'deleted-profile';
		expect(() => assertModelCatalog([model])).toThrow('default image preset');
		delete model.defaultImagePreset;
		model.tasks = ['chat'];
		model.outputModalities = ['text'];
		expect(() => assertModelCatalog([model])).toThrow('require the images task');
	});

	it('offers independent editable suggestions without inventing API quality values', () => {
		for (const id of ['qwen-image-2.1', 'qwen-image', 'qwen-image-edit', 'krea2-turbo']) {
			const presets = recommendedImagePresets(id);
			assertModelCatalog([
				{ ...imageModel(), id, imagePresets: presets, defaultImagePreset: presets[0].id },
			]);
			expect(
				presets.every(
					(profile) => profile.quality === undefined && profile.aspectRatios.length === 7,
				),
			).toBe(true);
			const before = structuredClone(presets);
			presets[0].aspectRatios[0].width = 111;
			expect(recommendedImagePresets(id)).toEqual(before);
		}
		expect(recommendedImagePresets('Qwen/Qwen-Image-2512')).toEqual(
			recommendedImagePresets('qwen-image'),
		);
		expect(
			recommendedImagePresets('qwen-image-2.1')[0].aspectRatios.find(
				(ratio) => ratio.id === '16:9',
			),
		).toMatchObject({ width: 2752, height: 1536 });
	});
});
