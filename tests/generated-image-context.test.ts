import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	generatedImageContext,
	GENERATED_IMAGE_CONTEXT_MAX_CHARS,
	GENERATED_IMAGE_CONTEXT_MAX_EDGE,
} from '../src/lib/generated-image-context';

let sequence = 0;
const source = (size = 2 * 1024 * 1024) =>
	`data:image/png;base64,${String.fromCharCode(65 + sequence++).repeat(size)}`;

function renderer(
	options: {
		width?: number;
		height?: number;
		decode?: 'ok' | 'fail' | 'wait';
		bytes?: (width: number, height: number, quality: number) => number;
		webp?: boolean;
	} = {},
) {
	const dimensions: { width: number; height: number; quality: number }[] = [];
	const images: FakeImage[] = [];
	class FakeImage {
		naturalWidth = options.width || 2048;
		naturalHeight = options.height || 4096;
		onload: (() => void) | null = null;
		onerror: (() => void) | null = null;
		value = '';
		constructor() {
			images.push(this);
		}
		set src(value: string) {
			this.value = value;
			if (value && options.decode !== 'wait')
				queueMicrotask(() => (options.decode === 'fail' ? this.onerror?.() : this.onload?.()));
		}
		get src() {
			return this.value;
		}
	}
	const context = { fillStyle: '', clearRect: vi.fn(), fillRect: vi.fn(), drawImage: vi.fn() };
	const canvas = {
		width: 0,
		height: 0,
		getContext: () => context,
		toBlob(callback: (blob: Blob) => void, type: string, quality: number) {
			dimensions.push({ width: this.width, height: this.height, quality });
			const bytes = options.bytes?.(this.width, this.height, quality) ?? 200000;
			queueMicrotask(() =>
				callback(
					new Blob([new Uint8Array(bytes)], {
						type: options.webp === false && type === 'image/webp' ? 'image/png' : type,
					}),
				),
			);
		},
	};
	vi.stubGlobal('Image', FakeImage);
	vi.stubGlobal('document', { createElement: () => canvas });
	return { images, dimensions, context, canvas };
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('generated image vision preview', () => {
	it('preserves aspect ratio and bounds dimensions and encoded transport bytes', async () => {
		const { dimensions, context, canvas, images } = renderer();
		const preview = await generatedImageContext(source());
		expect(preview).toMatch(/^data:image\/webp;base64,/);
		expect(preview!.length).toBeLessThanOrEqual(GENERATED_IMAGE_CONTEXT_MAX_CHARS);
		expect(dimensions[0]).toEqual({
			width: 768,
			height: GENERATED_IMAGE_CONTEXT_MAX_EDGE,
			quality: 0.85,
		});
		expect(context.clearRect).toHaveBeenCalledWith(0, 0, 768, 1536);
		expect(context.fillRect).not.toHaveBeenCalled();
		expect(canvas.width).toBe(0);
		expect(canvas.height).toBe(0);
		expect(images[0].src).toBe('');
	});

	it('uses a defined white matte JPEG fallback when WebP encoding is unavailable', async () => {
		const { context } = renderer({ webp: false });
		const preview = await generatedImageContext(source());
		expect(preview).toMatch(/^data:image\/jpeg;base64,/);
		expect(context.fillStyle).toBe('#fff');
		expect(context.fillRect).toHaveBeenCalledWith(0, 0, 768, 1536);
	});

	it('reduces quality then dimensions until a noisy preview fits the byte budget', async () => {
		const { dimensions } = renderer({
			bytes: (width, height, quality) => Math.ceil(width * height * quality * 3),
		});
		const preview = await generatedImageContext(source());
		expect(preview!.length).toBeLessThanOrEqual(GENERATED_IMAGE_CONTEXT_MAX_CHARS);
		expect(dimensions.slice(0, 3).map((item) => item.quality)).toEqual([0.85, 0.7, 0.55]);
		expect(dimensions.at(-1)!.height).toBeLessThan(1536);
		for (const item of dimensions) expect(item.height / item.width).toBe(2);
	});

	it('resizes large dimensions even when the original compresses into a small data URL, and caches successful previews', async () => {
		const { dimensions, images } = renderer({ width: 3000, height: 2000 });
		const original = source(1000);
		const first = await generatedImageContext(original);
		expect(first).not.toBe(original);
		expect(dimensions[0]).toMatchObject({ width: 1536, height: 1024 });
		expect(await generatedImageContext(original)).toBe(first);
		expect(images).toHaveLength(1);
	});

	it('returns an explicit unavailable result on decode failure rather than the oversized original', async () => {
		const { dimensions } = renderer({ decode: 'fail' });
		expect(await generatedImageContext(source())).toBeUndefined();
		expect(dimensions).toHaveLength(0);
		expect(await generatedImageContext('https://example.test/image.png')).toBeUndefined();
	});

	it('cancels decoding and releases the image without uploading a fallback original', async () => {
		const { images } = renderer({ decode: 'wait' });
		const controller = new AbortController();
		const pending = generatedImageContext(source(), controller.signal);
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
		expect(images[0].src).toBe('');
		expect(images[0].onload).toBeNull();
		expect(images[0].onerror).toBeNull();
	});
});
