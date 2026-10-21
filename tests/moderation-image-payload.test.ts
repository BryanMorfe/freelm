import { deflateSync, inflateSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { moderateImagePayload } from '../src/lib/moderation-image-payload';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
	let value = index;
	for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
	return value >>> 0;
});

function checksum(bytes: Uint8Array) {
	let crc = 0xffffffff;
	for (const byte of bytes) crc = TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer) {
	const out = Buffer.alloc(data.length + 12);
	out.writeUInt32BE(data.length);
	out.write(type, 4, 4, 'ascii');
	data.copy(out, 8);
	out.writeUInt32BE(checksum(out.subarray(4, out.length - 4)), out.length - 4);
	return out;
}

type FixtureOptions = {
	width?: number;
	height?: number;
	depth?: number;
	color?: number;
	interlace?: number;
	raw?: Buffer;
	compressed?: Buffer;
	level?: number;
	padding?: boolean;
	split?: boolean;
};

function rgba(width: number, height: number) {
	const row = width * 4 + 1;
	const bytes = Buffer.alloc(row * height);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const offset = y * row + 1 + x * 4;
			bytes[offset] = x % 256;
			bytes[offset + 1] = y % 256;
			bytes[offset + 2] = 37;
			bytes[offset + 3] = x % 2 ? 255 : 0;
		}
	}
	return bytes;
}

function fixture(options: FixtureOptions = {}) {
	const { width = 1024, height = 512, depth = 8, color = 6, interlace = 0 } = options;
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width);
	header.writeUInt32BE(height, 4);
	header[8] = depth;
	header[9] = color;
	header[12] = interlace;
	const raw = options.raw ?? rgba(width, height);
	const compressed = options.compressed ?? deflateSync(raw, { level: options.level ?? 0 });
	const gamma = Buffer.alloc(4);
	gamma.writeUInt32BE(45455);
	const resolution = Buffer.alloc(9);
	resolution.writeUInt32BE(3780);
	resolution.writeUInt32BE(3780, 4);
	resolution[8] = 1;
	const metadata = [
		chunk('gAMA', gamma),
		chunk('sRGB', Buffer.from([0])),
		chunk('pHYs', resolution),
		chunk(
			'tEXt',
			Buffer.from('Description\0Full resolution, alternating transparent and opaque pixels.'),
		),
	];
	if (options.padding)
		metadata.push(chunk('tEXt', Buffer.from(`Padding\0${'x'.repeat(800 * 1024)}`)));
	const middle = Math.floor(compressed.length / 2);
	const idats = options.split
		? [
				chunk('IDAT', compressed.subarray(0, middle)),
				chunk('IDAT', Buffer.alloc(0)),
				chunk('IDAT', compressed.subarray(middle)),
			]
		: [chunk('IDAT', compressed)];
	const png = Buffer.concat([
		SIGNATURE,
		chunk('IHDR', header),
		...metadata,
		...idats,
		chunk('tEXt', Buffer.from('Comment\0Metadata after the image data is retained too.')),
		chunk('IEND', Buffer.alloc(0)),
	]);
	return { png, raw, url: `data:image/png;base64,${png.toString('base64')}` };
}

function readChunks(png: Buffer) {
	const chunks: { type: string; bytes: Buffer; data: Buffer }[] = [];
	for (let offset = 8; offset < png.length;) {
		const length = png.readUInt32BE(offset);
		chunks.push({
			type: png.toString('ascii', offset + 4, offset + 8),
			bytes: png.subarray(offset, offset + 12 + length),
			data: png.subarray(offset + 8, offset + 8 + length),
		});
		offset += 12 + length;
	}
	return chunks;
}

function pngFrom(url: string) {
	return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
}

function expectLossless(original: Buffer, output: Buffer) {
	const before = readChunks(original);
	const after = readChunks(output);
	expect(after.map((value) => value.type)).toEqual(before.map((value) => value.type));
	for (let index = 0; index < before.length; index++) {
		if (before[index].type !== 'IDAT')
			expect(Buffer.compare(after[index].bytes, before[index].bytes)).toBe(0);
		expect(after[index].bytes.readUInt32BE(after[index].bytes.length - 4)).toBe(
			checksum(after[index].bytes.subarray(4, after[index].bytes.length - 4)),
		);
	}
	const inflate = (values: typeof before) =>
		inflateSync(
			Buffer.concat(values.filter((value) => value.type === 'IDAT').map((value) => value.data)),
		);
	expect(Buffer.compare(inflate(after), inflate(before))).toBe(0);
}

afterEach(() => vi.unstubAllGlobals());

describe('lossless moderation image payload preparation', () => {
	it('shrinks stored-deflate PNG data while preserving full-resolution RGBA scanlines, metadata, and IDAT positions', async () => {
		const original = fixture({ split: true });
		const snapshot = Buffer.from(original.png);
		const result = await moderateImagePayload(original.url);
		const png = pngFrom(result);
		expect(png.length).toBeLessThan(original.png.length / 4);
		expectLossless(original.png, png);
		expect(Buffer.compare(snapshot, original.png)).toBe(0);
		const header = readChunks(png)[0].data;
		expect([header.readUInt32BE(0), header.readUInt32BE(4), header[8], header[9]]).toEqual([
			1024, 512, 8, 6,
		]);
	});

	it('preserves 16-bit grayscale samples without interpreting or converting the color data', async () => {
		const width = 31;
		const height = 17;
		const raw = Buffer.alloc((width * 2 + 1) * height);
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++)
				raw.writeUInt16BE((x * 1987 + y * 3) % 65536, y * (width * 2 + 1) + 1 + x * 2);
		}
		const original = fixture({ width, height, depth: 16, color: 0, raw, padding: true });
		const result = pngFrom(await moderateImagePayload(original.url));
		expect(result.length).toBeLessThan(original.png.length);
		expectLossless(original.png, result);
	});

	it('preserves Adam7 scanline layout and interlacing', async () => {
		const width = 256;
		const height = 128;
		const passes = [
			[0, 0, 8, 8],
			[4, 0, 8, 8],
			[0, 4, 4, 8],
			[2, 0, 4, 4],
			[0, 2, 2, 4],
			[1, 0, 2, 2],
			[0, 1, 1, 2],
		];
		const rawSize = passes.reduce((total, [left, top, stepX, stepY]) => {
			const passWidth = Math.max(0, Math.ceil((width - left) / stepX));
			const passHeight = Math.max(0, Math.ceil((height - top) / stepY));
			return total + (passWidth && passHeight ? (passWidth * 4 + 1) * passHeight : 0);
		}, 0);
		const original = fixture({
			width,
			height,
			raw: Buffer.alloc(rawSize),
			interlace: 1,
			padding: true,
		});
		const output = pngFrom(await moderateImagePayload(original.url));
		expect(output.length).toBeLessThan(original.png.length);
		expectLossless(original.png, output);
		expect(readChunks(output)[0].data[12]).toBe(1);
	});

	it('keeps an already compact PNG exactly unchanged when deflate gives no gain', async () => {
		const original = fixture({
			width: 64,
			height: 64,
			raw: Buffer.alloc((64 * 4 + 1) * 64),
			level: 9,
			padding: true,
		});
		expect(await moderateImagePayload(original.url)).toBe(original.url);
	});

	it('leaves small PNGs, other image formats, and ordinary URLs untouched', async () => {
		const small = fixture({ width: 1, height: 1 });
		for (const value of [
			small.url,
			'data:image/jpeg;base64,AAAA',
			'data:image/webp;base64,AAAA',
			'https://example.test/image.png',
		])
			expect(await moderateImagePayload(value)).toBe(value);
	});

	it('retains the original if native streaming deflate is unavailable', async () => {
		const original = fixture();
		vi.stubGlobal('CompressionStream', undefined);
		expect(await moderateImagePayload(original.url)).toBe(original.url);
		vi.stubGlobal(
			'CompressionStream',
			class {
				constructor() {
					throw new Error('unsupported format');
				}
			},
		);
		expect(await moderateImagePayload(original.url)).toBe(original.url);
	});

	it('rejects encoded PNG input beyond its bound before allocating or inflating it', async () => {
		const tooLarge = `data:image/png;base64,${'A'.repeat((Math.floor((32 * 1024 * 1024) / 3) + 1) * 4)}`;
		await expect(moderateImagePayload(tooLarge)).rejects.toThrow('32 MiB encoded image limit');
	});

	it('rejects impossible geometry before inflating a decoded image beyond 128 MiB', async () => {
		const oversized = fixture({ width: 8192, height: 4096, raw: Buffer.alloc(1), padding: true });
		await expect(moderateImagePayload(oversized.url)).rejects.toThrow(
			'128 MiB decoded image limit',
		);
	});

	it('rejects a compressed expansion that exceeds the scanline geometry instead of accepting a zip bomb', async () => {
		const bomb = fixture({
			width: 1,
			height: 1,
			raw: Buffer.alloc(1024 * 1024),
			level: 9,
			padding: true,
		});
		await expect(moderateImagePayload(bomb.url)).rejects.toThrow('invalid decoded image data');
	});

	it('fails closed for malformed signatures, checksums, and chunk bounds in large PNG payloads', async () => {
		const original = fixture();
		const badSignature = Buffer.from(original.png);
		badSignature[0] = 0;
		const badChecksum = Buffer.from(original.png);
		badChecksum[32] ^= 1;
		const truncated = original.png.subarray(0, original.png.length - 1);
		for (const [bytes, message] of [
			[badSignature, 'signature'],
			[badChecksum, 'checksum'],
			[truncated, 'truncated'],
		] as const) {
			const url = `data:image/png;base64,${bytes.toString('base64')}`;
			await expect(moderateImagePayload(url)).rejects.toThrow(message);
		}
	});

	it('surfaces a bounded safe error when the PNG zlib stream cannot be decoded', async () => {
		const original = fixture({
			width: 1,
			height: 1,
			compressed: Buffer.from('not a zlib stream'),
			padding: true,
		});
		await expect(moderateImagePayload(original.url)).rejects.toThrow(
			'could not be decoded and recompressed',
		);
	});

	it('fails closed when valid zlib data contains fewer scanlines than the PNG header declares', async () => {
		const original = fixture({ width: 64, height: 64, raw: Buffer.alloc(1), padding: true });
		await expect(moderateImagePayload(original.url)).rejects.toThrow('invalid decoded image data');
	});

	it('rejects invalid base64 without including any image bytes in the diagnostic', async () => {
		const value = `data:image/png;base64,${'!'.repeat(1024 * 1024 + 4)}`;
		await expect(moderateImagePayload(value)).rejects.toThrow('invalid base64 encoding');
	});

	it('preserves an existing cancellation reason and cancels in-flight preparation', async () => {
		const preaborted = new AbortController();
		const beforeReason = new Error('Cancelled before preparing the image');
		preaborted.abort(beforeReason);
		await expect(
			moderateImagePayload('https://example.test/image.png', preaborted.signal),
		).rejects.toBe(beforeReason);
		const controller = new AbortController();
		const reason = new Error('Cancelled during image preparation');
		const pending = moderateImagePayload(fixture().url, controller.signal);
		setTimeout(() => controller.abort(reason), 0);
		await expect(pending).rejects.toBe(reason);
	});

	it('lets other work run while decoding, checksumming, and recompressing a large image', async () => {
		let ticks = 0;
		const interval = setInterval(() => ticks++, 0);
		try {
			await moderateImagePayload(fixture().url);
			expect(ticks).toBeGreaterThan(3);
		} finally {
			clearInterval(interval);
		}
	});
});
