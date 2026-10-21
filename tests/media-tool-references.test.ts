import { describe, expect, it } from 'vitest';
import type { Attachment } from '../src/types';
import { selectMediaToolReferences } from '../src/lib/media-tool-references';

const avif: Attachment = {
	name: 'earlier.avif',
	type: 'image/avif',
	dataUrl: 'data:image/avif;base64,YXZpZg==',
};
const png: Attachment = {
	name: 'latest.png',
	type: 'image/png',
	dataUrl: 'data:image/png;base64,cG5n',
};
const invalid: Attachment = {
	name: 'invalid.png',
	type: 'image/png',
	dataUrl: 'invalid image data',
};
const mediaTools = ['image_gen.imagegen', 'video_gen.videogen'];

describe('media tool reference selection', () => {
	it.each(mediaTools)('%s does not send history images for text-only generation', (name) => {
		expect(selectMediaToolReferences(name, { prompt: 'A wooded valley' }, [avif, invalid])).toEqual(
			{},
		);
	});
	it.each(mediaTools)('%s sends only the requested latest image unchanged', (name) => {
		const history = [avif, invalid, png];
		const selected = selectMediaToolReferences(name, { num_last_images_to_include: 1 }, history);
		expect(selected.recentImages).toEqual([png]);
		expect(selected.recentImages?.[0]).toBe(png);
		expect(history).toEqual([avif, invalid, png]);
	});
	it('selects multiple image references in chronological order', () => {
		const history = [invalid, png, avif];
		expect(
			selectMediaToolReferences('image_gen.imagegen', { num_last_images_to_include: 2 }, history),
		).toEqual({ recentImages: [png, avif] });
	});
	it.each(mediaTools)(
		'%s never substitutes an older image for an invalid selected reference',
		(name) => {
			expect(
				selectMediaToolReferences(name, { num_last_images_to_include: 1 }, [png, invalid]),
			).toEqual({ recentImages: [invalid] });
		},
	);
	it.each(mediaTools)('%s preserves AVIF references for host/provider validation', (name) => {
		expect(selectMediaToolReferences(name, { num_last_images_to_include: 1 }, [png, avif])).toEqual(
			{
				recentImages: [avif],
			},
		);
	});
	it.each(mediaTools)('%s leaves unavailable references missing for the host to report', (name) => {
		expect(selectMediaToolReferences(name, { num_last_images_to_include: 1 }, [])).toEqual({
			recentImages: [],
		});
	});
	it('does not pad an undersized image reference selection', () => {
		expect(
			selectMediaToolReferences('image_gen.imagegen', { num_last_images_to_include: 3 }, [png]),
		).toEqual({ recentImages: [png] });
	});
	it.each(mediaTools)(
		'%s does not send history for file paths or conflicting reference arguments',
		(name) => {
			for (const referenced_image_paths of [['/workspace/reference.png'], [], 'invalid', null]) {
				for (const count of [undefined, 1]) {
					expect(
						selectMediaToolReferences(
							name,
							{ referenced_image_paths, num_last_images_to_include: count },
							[invalid, avif],
						),
					).toEqual({});
				}
			}
		},
	);
	it.each(mediaTools)(
		'%s leaves invalid count arguments untouched for the host to reject',
		(name) => {
			for (const count of [0, -1, 6, 1.5, NaN, Infinity, 'invalid', {}]) {
				const args = { num_last_images_to_include: count };
				expect(selectMediaToolReferences(name, args, [invalid, avif])).toEqual({});
				expect(args.num_last_images_to_include).toBe(count);
			}
		},
	);
	it('keeps image count coercion compatible with the host without coercing video counts', () => {
		expect(
			selectMediaToolReferences('image_gen.imagegen', { num_last_images_to_include: '1' }, [png]),
		).toEqual({ recentImages: [png] });
		expect(
			selectMediaToolReferences('video_gen.videogen', { num_last_images_to_include: '1' }, [png]),
		).toEqual({});
		expect(
			selectMediaToolReferences('video_gen.videogen', { num_last_images_to_include: 2 }, [
				png,
				avif,
			]),
		).toEqual({});
	});
	it('does not attach media history to unrelated tool calls', () => {
		expect(
			selectMediaToolReferences('web.run', { num_last_images_to_include: 1 }, [avif, invalid]),
		).toEqual({});
	});
});
