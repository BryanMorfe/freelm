// AVIF's FileTypeBox comes first and may identify AVIF through a compatible brand.
// https://aomediacodec.github.io/av1-avif/#brands
export const AVIF_HEADER_BYTES = 4096;
const MAX_BOXES = 65536;

type ReadBytes = (offset: number, length: number) => Uint8Array;

function uint32(bytes: Uint8Array, offset = 0): number {
	return (
		bytes[offset] * 2 ** 24 +
		(bytes[offset + 1] << 16) +
		(bytes[offset + 2] << 8) +
		bytes[offset + 3]
	);
}

function fourCC(bytes: Uint8Array, offset = 0): string {
	return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

function boxAt(read: ReadBytes, offset: number, end: number) {
	if (end - offset < 8) throw new Error('An AVIF reference has truncated image data.');
	const bytes = read(offset, Math.min(16, end - offset));
	if (bytes.length < Math.min(16, end - offset))
		throw new Error('An AVIF reference has truncated image data.');
	const shortSize = uint32(bytes);
	const header = shortSize === 1 ? 16 : 8;
	if (bytes.length < header) throw new Error('An AVIF reference has truncated image data.');
	const size =
		shortSize === 1 ? uint32(bytes, 8) * 2 ** 32 + uint32(bytes, 12) : shortSize || end - offset;
	if (!Number.isSafeInteger(size) || size < header || size > end - offset)
		throw new Error('An AVIF reference has invalid or truncated image data.');
	return { type: fourCC(bytes, 4), payload: offset + header, end: offset + size, size };
}

/** MIME sniff only, not a decoder. Pass the full bytes or their first AVIF_HEADER_BYTES. */
export function inspectAvif(bytes: Uint8Array): { animated: boolean } | undefined {
	try {
		const prefix = bytes.subarray(0, AVIF_HEADER_BYTES);
		if (prefix.length < 16 || uint32(prefix) === 0) return;
		const box = boxAt(
			(offset, length) => prefix.subarray(offset, offset + length),
			0,
			prefix.length,
		);
		if (box.type !== 'ftyp' || box.end - box.payload < 8 || (box.end - box.payload) % 4) return;
		const brands = [fourCC(prefix, box.payload)];
		// The word after major_brand is minor_version, not another brand.
		for (let offset = box.payload + 8; offset < box.end; offset += 4)
			brands.push(fourCC(prefix, offset));
		if (!brands.includes('avif') && !brands.includes('avis')) return;
		return { animated: brands.includes('avis') || brands.includes('msf1') };
	} catch {
		return undefined;
	}
}

/** Check container bounds and reject timed sequences without decoding or copying the AV1 payload. */
export async function requireStaticAvif(
	read: ReadBytes,
	byteLength: number,
	signal?: AbortSignal,
): Promise<void> {
	signal?.throwIfAborted();
	const format = inspectAvif(read(0, Math.min(AVIF_HEADER_BYTES, byteLength)));
	if (!format) throw new Error('An AVIF reference has invalid image data.');
	const animated = () => {
		throw new Error(
			'Convert animated image references to static PNG, JPEG, WebP, or AVIF before editing.',
		);
	};
	if (format.animated) animated();
	let boxes = 0;
	let metadata = false;
	let imageData = false;
	const visit = async (start: number, end: number, parent: 'file' | 'meta' | 'iprp' | 'ipco') => {
		const children = new Set<string>();
		for (let offset = start; offset < end;) {
			signal?.throwIfAborted();
			if (++boxes > MAX_BOXES) throw new Error('An AVIF reference contains too many image boxes.');
			const box = boxAt(read, offset, end);
			if (box.type === 'moov' || box.type === 'trak') animated();
			if (box.type === 'ftyp' && (parent !== 'file' || offset !== 0))
				throw new Error('An AVIF reference has an unexpected file type box.');
			children.add(box.type);
			if (parent === 'file' && box.type === 'meta') {
				if (
					metadata ||
					box.end - box.payload < 4 ||
					read(box.payload, 4).some((byte) => byte !== 0)
				)
					throw new Error('An AVIF reference has invalid image metadata.');
				metadata = true;
				await visit(box.payload + 4, box.end, 'meta');
			} else if (
				(parent === 'meta' && box.type === 'iprp') ||
				(parent === 'iprp' && box.type === 'ipco')
			) {
				await visit(box.payload, box.end, box.type);
			} else if (
				(parent === 'file' && box.type === 'mdat') ||
				(parent === 'meta' && box.type === 'idat')
			) {
				imageData ||= box.end > box.payload;
			}
			offset = box.end;
			if (boxes % 128 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
		}
		if (
			parent === 'meta' &&
			['hdlr', 'pitm', 'iloc', 'iinf', 'iprp'].some((type) => !children.has(type))
		)
			throw new Error('An AVIF reference is missing required image metadata.');
	};
	await visit(0, byteLength, 'file');
	if (!metadata || !imageData) throw new Error('An AVIF reference is missing its image data.');
	signal?.throwIfAborted();
}
