import { deflateSync, inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	collectModerationImageReferences,
	isImageEditRequest,
} from '../src/lib/moderation-image-references';
import * as payload from '../src/lib/moderation-image-payload';
import type { WireFile, WireRequest, WireResponse } from '../src/types';

const PNG =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const AVIF = readFileSync(new URL('./fixtures/reference.avif', import.meta.url)).toString('base64');
const INLINE = `data:image/png;base64,${PNG}`;
const FILE: WireFile = { name: 'reference.png', type: 'image/png', base64: PNG };
const request = (overrides: Partial<WireRequest> = {}): WireRequest => ({
	id: 'reference-check',
	baseUrl: 'https://provider.invalid/v1',
	apiKey: 'private-provider-key',
	path: '/images/edits',
	method: 'POST',
	form: [{ name: 'image', file: FILE }],
	...overrides,
});
const download = vi.fn<
	(url: string, signal?: AbortSignal, kind?: 'image' | 'video') => Promise<WireResponse>
>(async () => ({ status: 200, contentType: 'image/png', body: PNG, encoding: 'base64' }));

function pngChunk(type: string, data: Buffer): Buffer {
	const result = Buffer.alloc(data.length + 12);
	result.writeUInt32BE(data.length);
	result.write(type, 4, 'ascii');
	data.copy(result, 8);
	let crc = 0xffffffff;
	for (const byte of result.subarray(4, data.length + 8)) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
	}
	result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, data.length + 8);
	return result;
}

function largePng(): { bytes: Buffer; scanlines: Buffer } {
	const width = 1024;
	const height = 512;
	const scanlines = Buffer.alloc((width * 4 + 1) * height);
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++) {
			const offset = y * (width * 4 + 1) + x * 4 + 1;
			scanlines[offset] = x % 256;
			scanlines[offset + 1] = y % 256;
			scanlines[offset + 2] = 41;
			scanlines[offset + 3] = x % 2 ? 255 : 0;
		}
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 6;
	return {
		scanlines,
		bytes: Buffer.concat([
			Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'),
			pngChunk('IHDR', header),
			pngChunk('tEXt', Buffer.from('Author\0Reference moderation fixture')),
			pngChunk('IDAT', deflateSync(scanlines, { level: 0 })),
			pngChunk('IEND', Buffer.alloc(0)),
		]),
	};
}

function pngChunks(bytes: Buffer): { type: string; data: Buffer }[] {
	const chunks: { type: string; data: Buffer }[] = [];
	for (let offset = 8; offset < bytes.length;) {
		const size = bytes.readUInt32BE(offset);
		chunks.push({
			type: bytes.toString('ascii', offset + 4, offset + 8),
			data: bytes.subarray(offset + 8, offset + 8 + size),
		});
		offset += size + 12;
	}
	return chunks;
}

function animatedPng(): string {
	const png = Buffer.from(PNG, 'base64');
	const control = Buffer.alloc(8);
	control.writeUInt32BE(2);
	return Buffer.concat([png.subarray(0, 33), pngChunk('acTL', control), png.subarray(33)]).toString(
		'base64',
	);
}

function webp(chunkType: string, contents: Buffer): string {
	const chunk = Buffer.alloc(8 + contents.length + (contents.length % 2));
	chunk.write(chunkType, 0, 'ascii');
	chunk.writeUInt32LE(contents.length, 4);
	contents.copy(chunk, 8);
	const header = Buffer.alloc(12);
	header.write('RIFF', 0, 'ascii');
	header.writeUInt32LE(chunk.length + 4, 4);
	header.write('WEBP', 8, 'ascii');
	return Buffer.concat([header, chunk]).toString('base64');
}

afterEach(() => {
	vi.restoreAllMocks();
	download.mockClear();
});

describe('contextual image reference collection', () => {
	it.each(['image/avif', 'application/octet-stream'])(
		'preserves static AVIF references with %s MIME',
		async (type) => {
			const wire = request({
				form: [{ name: 'image', file: { name: 'reference.avif', type, base64: AVIF } }],
			});
			const original = structuredClone(wire);
			expect(await collectModerationImageReferences(wire, download)).toEqual([
				`data:image/avif;base64,${AVIF}`,
			]);
			expect(wire).toEqual(original);
			expect(download).not.toHaveBeenCalled();
		},
	);

	it('preserves embedded AVIF data URLs', async () => {
		const image = `data:image/avif;base64,${AVIF}`;
		expect(
			await collectModerationImageReferences(
				request({ form: undefined, body: { image } }),
				download,
			),
		).toEqual([image]);
	});

	it('collects all multipart references in order and leaves original files and mask untouched', async () => {
		const wire = request({
			form: [
				{ name: 'prompt', value: 'Keep the subject clothed; change the background.' },
				{ name: 'image[]', file: FILE },
				{ name: 'mask', file: { ...FILE, name: 'mask.png' } },
				{ name: 'image[]', file: { ...FILE, name: 'another-person.png' } },
			],
		});
		const before = structuredClone(wire);
		expect(await collectModerationImageReferences(wire, download)).toEqual([INLINE, INLINE]);
		expect(wire).toEqual(before);
		expect(download).not.toHaveBeenCalled();
	});

	it.each([
		'image',
		'image[]',
		'images',
		'images[]',
		'image_url',
		'image_urls',
		'input_image',
		'input_images',
		'input_reference',
		'input_references',
		'reference',
		'references',
		'reference_image',
		'reference_images',
	])('recognizes and inspects embedded JSON %s references on generation routes', async (field) => {
		const wire = request({
			path: '/images/generations',
			form: undefined,
			body: { prompt: 'An edit', [field]: INLINE },
		});
		expect(isImageEditRequest(wire)).toBe(true);
		expect(await collectModerationImageReferences(wire, download)).toEqual([INLINE]);
	});

	it.each([
		{ image_url: INLINE },
		{ type: 'input_image', image_url: INLINE },
		{ type: 'image_url', image_url: { url: INLINE, detail: 'high' } },
		{ url: INLINE },
		{ dataUrl: INLINE },
		{ base64: PNG, type: 'image/png' },
		{ b64_json: PNG, mimeType: 'image/png' },
	])('supports a bounded explicit embedded image representation: %j', async (image) => {
		expect(
			await collectModerationImageReferences(
				request({ form: undefined, body: { images: [image] } }),
				download,
			),
		).toEqual([INLINE]);
	});

	it('does not mistake generation controls or masks for depicted references', async () => {
		const wire = request({
			path: '/images/generations',
			form: undefined,
			body: {
				prompt: 'A vase',
				model: 'image-model',
				image_size: '1024x1024',
				output_format: 'png',
				quality: 'high',
				n: 1,
				mask: INLINE,
			},
		});
		expect(isImageEditRequest(wire)).toBe(false);
		expect(await collectModerationImageReferences(wire, download)).toEqual([]);
	});

	it.each(['/images/edits', '/v1/images/edits/', '/images/%65dits'])(
		'requires references on %s',
		async (path) => {
			const wire = request({ path, form: undefined, body: { prompt: 'An edit' } });
			expect(isImageEditRequest(wire)).toBe(true);
			await expect(collectModerationImageReferences(wire, download)).rejects.toThrow(
				'must provide inspectable reference images',
			);
		},
	);

	it.each([
		{ form: [{ name: 'unexpected', file: FILE }] },
		{ form: [{ name: 'image', file: FILE, value: INLINE }] },
		{ form: [{ name: 'image', value: '' }] },
		{ form: [{ name: 'image', file: { name: 'bad.png', type: 'image/png' } }] },
		{ form: undefined, body: { init_image: INLINE } },
		{ form: undefined, body: { images: [] } },
		{ form: undefined, body: { images: [null] } },
		{ form: undefined, body: { images: [{ url: INLINE, image_url: INLINE }] } },
		{ form: undefined, body: { images: [{ url: INLINE, secret_second_image: INLINE }] } },
		{ form: undefined, body: { images: [{ base64: PNG, type: 13 }] } },
	])('fails closed for unsupported or incomplete reference shapes', async (shape) => {
		await expect(
			collectModerationImageReferences(request(shape as Partial<WireRequest>), download),
		).rejects.toThrow('could not inspect the reference images');
		expect(download).not.toHaveBeenCalled();
	});

	it.each([
		'https://media.invalid/person.png',
		'http://media.invalid/person.png',
		'https://user:password@media.invalid/person.png',
		'https://media.invalid/person.png#frame',
		'file:///Users/private/person.png',
		'/Users/private/person.png',
	])(
		'never downloads or forwards credentials for mutable or invalid reference URL %s',
		async (url) => {
			await expect(
				collectModerationImageReferences(
					request({ form: undefined, body: { image: url } }),
					download,
				),
			).rejects.toThrow('Image input moderation could not inspect');
			expect(download).not.toHaveBeenCalled();
		},
	);

	it('gives a clear attach instruction for a mutable remote reference', async () => {
		await expect(
			collectModerationImageReferences(
				request({ form: undefined, body: { image: 'https://media.invalid/person.png' } }),
				download,
			),
		).rejects.toThrow('Download and attach');
	});

	it.each(['', '!!!!', PNG.slice(0, -1), `${PNG.slice(0, 4)}=${PNG.slice(5)}`])(
		'rejects malformed embedded base64',
		async (base64) => {
			await expect(
				collectModerationImageReferences(
					request({ form: [{ name: 'image', file: { ...FILE, base64 } }] }),
					download,
				),
			).rejects.toThrow('Image input moderation could not inspect');
		},
	);

	it.each([
		`data:image/png,${PNG}`,
		`data:text/plain;base64,${PNG}`,
		`data:image/jpeg;base64,${PNG}`,
	])('rejects malformed or mismatched image dataURL %s', async (value) => {
		await expect(
			collectModerationImageReferences(request({ form: [{ name: 'image', value }] }), download),
		).rejects.toThrow('Image input moderation could not inspect');
	});

	it('detects actual MIME for octet-stream uploads and preserves small reference bytes', async () => {
		expect(
			await collectModerationImageReferences(
				request({ form: [{ name: 'image', file: { ...FILE, type: 'application/octet-stream' } }] }),
				download,
			),
		).toEqual([INLINE]);
	});

	it.each([
		{ type: 'image/jpeg', base64: PNG },
		{ type: 'image/gif', base64: Buffer.from('GIF89aFAKE', 'ascii').toString('base64') },
		{
			type: 'image/avif',
			base64: Buffer.from('\x00\x00\x00\x18ftypavifFAKE', 'latin1').toString('base64'),
		},
		{ type: 'image/svg+xml', base64: Buffer.from('<svg/>').toString('base64') },
		{ type: 'image/png', base64: animatedPng() },
		{ type: 'image/webp', base64: webp('ANIM', Buffer.alloc(6)) },
		{ type: 'image/webp', base64: webp('VP8X', Buffer.from([2, 0, 0, 0, 0, 0, 0, 0, 0, 0])) },
	])('blocks mismatched, unsupported, or animated references', async (image) => {
		await expect(
			collectModerationImageReferences(
				request({ form: [{ name: 'image', file: { name: 'person', ...image } }] }),
				download,
			),
		).rejects.toThrow('Image input moderation could not inspect');
	});

	it('bounds reference count before preparing or decoding anything', async () => {
		const prepare = vi.spyOn(payload, 'moderateImagePayload');
		await expect(
			collectModerationImageReferences(
				request({ form: undefined, body: { images: Array.from({ length: 17 }, () => INLINE) } }),
				download,
			),
		).rejects.toThrow('at most 16 reference images');
		expect(prepare).not.toHaveBeenCalled();
	});

	it('bounds each encoded reference before allocation or normalization', async () => {
		const prepare = vi.spyOn(payload, 'moderateImagePayload');
		const base64 = 'A'.repeat(Math.ceil((32 * 1024 * 1024) / 3) * 4 + 4);
		await expect(
			collectModerationImageReferences(
				request({ form: [{ name: 'image', file: { ...FILE, base64 } }] }),
				download,
			),
		).rejects.toThrow('32 MiB');
		expect(prepare).not.toHaveBeenCalled();
	});

	it('enforces a batch limit even when each reference is individually within bounds', async () => {
		const bytes = Buffer.alloc(22 * 1024 * 1024);
		bytes[0] = 255;
		bytes[1] = 216;
		bytes[2] = 255;
		const file = { name: 'large.jpg', type: 'image/jpeg', base64: bytes.toString('base64') };
		await expect(
			collectModerationImageReferences(
				request({ form: Array.from({ length: 3 }, () => ({ name: 'image[]', file })) }),
				download,
			),
		).rejects.toThrow('64 MiB batch');
	}, 15000);

	it('losslessly normalizes a large evaluator copy while keeping the generator payload intact', async () => {
		const { bytes, scanlines } = largePng();
		const original = bytes.toString('base64');
		const wire = request({ form: [{ name: 'image', file: { ...FILE, base64: original } }] });
		const [copy] = await collectModerationImageReferences(wire, download);
		expect(copy.length).toBeLessThan(original.length);
		const originalChunks = pngChunks(bytes);
		const copyChunks = pngChunks(Buffer.from(copy.slice(copy.indexOf(',') + 1), 'base64'));
		expect(
			inflateSync(
				Buffer.concat(
					copyChunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data),
				),
			),
		).toEqual(scanlines);
		expect(copyChunks.filter((chunk) => chunk.type !== 'IDAT')).toEqual(
			originalChunks.filter((chunk) => chunk.type !== 'IDAT'),
		);
		expect(wire.form?.[0].file?.base64).toBe(original);
	});

	it('preserves an already-aborted caller signal without normalization', async () => {
		const controller = new AbortController();
		const reason = new Error('Caller cancelled this edit.');
		controller.abort(reason);
		await expect(
			collectModerationImageReferences(request(), download, controller.signal),
		).rejects.toBe(reason);
	});

	it('honors cancellation during lossless reference preparation', async () => {
		const controller = new AbortController();
		const reason = new Error('Cancel while preparing references.');
		vi.spyOn(payload, 'moderateImagePayload').mockImplementation(async () => {
			controller.abort(reason);
			return INLINE;
		});
		await expect(
			collectModerationImageReferences(request(), download, controller.signal),
		).rejects.toBe(reason);
	});
});
