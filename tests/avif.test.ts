import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AVIF_HEADER_BYTES, inspectAvif, requireStaticAvif } from '../src/lib/avif';

const AVIF = readFileSync(new URL('./fixtures/reference.avif', import.meta.url));
const validate = (bytes: Buffer, signal?: AbortSignal) =>
	requireStaticAvif(
		(offset, length) => bytes.subarray(offset, offset + length),
		bytes.length,
		signal,
	);

function box(type: string, payload: Buffer, extended = false): Buffer {
	const result = Buffer.alloc(payload.length + (extended ? 16 : 8));
	result.writeUInt32BE(extended ? 1 : result.length);
	result.write(type, 4, 'ascii');
	if (extended) result.writeBigUInt64BE(BigInt(result.length), 8);
	payload.copy(result, extended ? 16 : 8);
	return result;
}

describe('AVIF container recognition', () => {
	it('recognizes a real static AVIF and an AVIF compatible brand under a mif1 major brand', async () => {
		for (const major of ['avif', 'mif1']) {
			const bytes = Buffer.from(AVIF);
			bytes.write(major, 8, 'ascii');
			expect(inspectAvif(bytes)).toEqual({ animated: false });
			await expect(validate(bytes)).resolves.toBeUndefined();
		}
	});

	it('accepts extended box lengths and an mdat that extends to EOF', async () => {
		const firstLength = AVIF.readUInt32BE(0);
		const extended = Buffer.concat([
			box('ftyp', AVIF.subarray(8, firstLength), true),
			AVIF.subarray(firstLength),
		]);
		expect(inspectAvif(extended)).toEqual({ animated: false });
		await expect(validate(extended)).resolves.toBeUndefined();
		const toEnd = Buffer.from(AVIF);
		for (let offset = firstLength; offset < toEnd.length;) {
			const size = toEnd.readUInt32BE(offset);
			if (toEnd.toString('ascii', offset + 4, offset + 8) === 'mdat')
				toEnd.writeUInt32BE(0, offset);
			offset += size;
		}
		await expect(validate(toEnd)).resolves.toBeUndefined();
	});

	it('only reads actual major and compatible brands, never minor_version or arbitrary payload text', () => {
		const nonAvif = Buffer.from(AVIF);
		nonAvif.write('heic', 8, 'ascii');
		nonAvif.write('avif', 12, 'ascii');
		nonAvif.write('heic', 16, 'ascii');
		expect(inspectAvif(nonAvif)).toBeUndefined();
		expect(inspectAvif(Buffer.from('Some avif data'))).toBeUndefined();
	});

	it.each(['avis', 'msf1'])('identifies and refuses the %s sequence brand', async (brand) => {
		const bytes = Buffer.from(AVIF);
		bytes.write(brand, 20, 'ascii');
		expect(inspectAvif(bytes)).toEqual({ animated: true });
		await expect(validate(bytes)).rejects.toThrow('animated');
	});

	it('rejects movie tracks even if a file only advertises a still-image brand', async () => {
		await expect(validate(Buffer.concat([AVIF, box('moov', Buffer.alloc(0))]))).rejects.toThrow(
			'animated',
		);
	});

	it('accepts AVIF idat image storage without requiring a top-level mdat', async () => {
		const ftyp = AVIF.subarray(0, AVIF.readUInt32BE(0));
		const metaSize = AVIF.readUInt32BE(ftyp.length);
		const oldMeta = AVIF.subarray(ftyp.length + 8, ftyp.length + metaSize);
		const imagePayload = AVIF.subarray(ftyp.length + metaSize + 8);
		const bytes = Buffer.concat([
			ftyp,
			box('meta', Buffer.concat([oldMeta, box('idat', imagePayload)])),
		]);
		await expect(validate(bytes)).resolves.toBeUndefined();
	});

	it.each([
		Buffer.from('\x00\x00\x00\x18ftypavifFAKE', 'latin1'),
		AVIF.subarray(0, 20),
		AVIF.subarray(0, AVIF.length - 1),
		Buffer.concat([AVIF, Buffer.from([1, 2, 3])]),
		Buffer.concat([
			AVIF.subarray(0, 32),
			box('meta', Buffer.alloc(4)),
			box('mdat', Buffer.from([1])),
		]),
		Buffer.concat([AVIF.subarray(0, 32), box('free', Buffer.alloc(0))]),
	])('rejects fake, truncated, or incomplete container data', async (bytes) => {
		await expect(validate(bytes)).rejects.toThrow(/AVIF reference/);
	});

	it('checks nested metadata bounds as well as top-level sizes', async () => {
		const malformed = Buffer.from(AVIF);
		malformed.writeUInt32BE(malformed.length, 44); // First meta child overruns its parent.
		await expect(validate(malformed)).rejects.toThrow('truncated');
	});

	it('bounds brand parsing and rejects unsafe 64-bit lengths', async () => {
		const oversized = box(
			'ftyp',
			Buffer.concat([Buffer.from('avif\0\0\0\0'), Buffer.alloc(AVIF_HEADER_BYTES)]),
		);
		expect(inspectAvif(oversized)).toBeUndefined();
		const unsafe = box('ftyp', Buffer.from('avif\0\0\0\0'), true);
		unsafe.writeBigUInt64BE(2n ** 63n, 8);
		expect(inspectAvif(unsafe)).toBeUndefined();
		await expect(validate(unsafe)).rejects.toThrow('invalid');
	});

	it('honors cancellation before inspecting any bytes', async () => {
		const signal = AbortSignal.abort(new Error('Cancelled image inspection'));
		await expect(validate(AVIF, signal)).rejects.toThrow('Cancelled image inspection');
	});
});
