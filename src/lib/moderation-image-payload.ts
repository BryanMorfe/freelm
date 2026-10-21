// Only the copy sent to the evaluator is recompressed. PNG scanlines and every
// non-IDAT chunk remain unchanged; callers keep the original asset for display.
const MAX_PNG_BYTES = 32 * 1024 * 1024;
const MAX_SCANLINE_BYTES = 128 * 1024 * 1024;
const MIN_BASE64_LENGTH = 1024 * 1024;
const WORK_SLICE = 64 * 1024;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
	let value = index;
	for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
	return value >>> 0;
});

class PayloadError extends Error {}

function fail(message: string): never {
	throw new PayloadError(message);
}

function checkAbort(signal?: AbortSignal) {
	signal?.throwIfAborted();
}

async function yieldWork(signal?: AbortSignal) {
	checkAbort(signal);
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	checkAbort(signal);
}

async function crc32(bytes: Uint8Array, start: number, end: number, signal?: AbortSignal) {
	let crc = 0xffffffff;
	for (let offset = start; offset < end; offset += WORK_SLICE) {
		checkAbort(signal);
		const until = Math.min(offset + WORK_SLICE, end);
		for (let index = offset; index < until; index++)
			crc = CRC_TABLE[(crc ^ bytes[index]) & 255] ^ (crc >>> 8);
		if (offset + WORK_SLICE < end) await yieldWork(signal);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

async function decodeBase64(value: string, signal?: AbortSignal) {
	if (value.length % 4 || !value.length)
		fail('The PNG moderation payload has invalid base64 encoding.');
	const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
	const size = (value.length / 4) * 3 - padding;
	if (size > MAX_PNG_BYTES)
		fail('The PNG moderation payload exceeds the 32 MiB encoded image limit.');
	const bytes = new Uint8Array(size);
	let target = 0;
	for (let offset = 0; offset < value.length; offset += WORK_SLICE) {
		checkAbort(signal);
		const chunk = value.slice(offset, offset + WORK_SLICE);
		const last = offset + WORK_SLICE >= value.length;
		if (!(last ? /^[A-Za-z0-9+/]*={0,2}$/ : /^[A-Za-z0-9+/]+$/).test(chunk))
			fail('The PNG moderation payload has invalid base64 encoding.');
		let decoded: string;
		try {
			decoded = atob(chunk);
		} catch {
			fail('The PNG moderation payload has invalid base64 encoding.');
		}
		for (let index = 0; index < decoded.length; index++)
			bytes[target++] = decoded.charCodeAt(index);
		if (offset + WORK_SLICE < value.length) await yieldWork(signal);
	}
	if (target !== size) fail('The PNG moderation payload has invalid base64 encoding.');
	return bytes;
}

async function encodeBase64(bytes: Uint8Array, signal?: AbortSignal) {
	const parts: string[] = [];
	// Multiples of three keep intermediate base64 pieces unpadded.
	const slice = 48 * 1024;
	for (let offset = 0; offset < bytes.length; offset += slice) {
		checkAbort(signal);
		parts.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + slice))));
		if (offset + slice < bytes.length) await yieldWork(signal);
	}
	return parts.join('');
}

interface PngChunk {
	start: number;
	length: number;
	type: string;
}

function scanlineSize(view: DataView, dataStart: number) {
	const width = view.getUint32(dataStart);
	const height = view.getUint32(dataStart + 4);
	const depth = view.getUint8(dataStart + 8);
	const color = view.getUint8(dataStart + 9);
	const interlace = view.getUint8(dataStart + 12);
	const depths: Record<number, readonly number[]> = {
		0: [1, 2, 4, 8, 16],
		2: [8, 16],
		3: [1, 2, 4, 8],
		4: [8, 16],
		6: [8, 16],
	};
	const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
	if (
		!width ||
		!height ||
		width > 0x7fffffff ||
		height > 0x7fffffff ||
		!depths[color]?.includes(depth) ||
		view.getUint8(dataStart + 10) !== 0 ||
		view.getUint8(dataStart + 11) !== 0 ||
		interlace > 1
	)
		fail('The PNG moderation payload has an invalid image header.');
	const passes = interlace
		? [
				[0, 0, 8, 8],
				[4, 0, 8, 8],
				[0, 4, 4, 8],
				[2, 0, 4, 4],
				[0, 2, 2, 4],
				[1, 0, 2, 2],
				[0, 1, 1, 2],
			]
		: [[0, 0, 1, 1]];
	let total = 0;
	for (const [left, top, stepX, stepY] of passes) {
		const passWidth = Math.max(0, Math.ceil((width - left) / stepX));
		const passHeight = Math.max(0, Math.ceil((height - top) / stepY));
		if (!passWidth || !passHeight) continue;
		const row = 1 + Math.ceil((passWidth * channels[color] * depth) / 8);
		if (row > MAX_SCANLINE_BYTES || passHeight > Math.floor((MAX_SCANLINE_BYTES - total) / row))
			fail('The PNG moderation payload exceeds the 128 MiB decoded image limit.');
		total += row * passHeight;
	}
	return { size: total, color };
}

async function parsePng(bytes: Uint8Array, signal?: AbortSignal) {
	if (!PNG_SIGNATURE.every((byte, index) => bytes[index] === byte))
		fail('The PNG moderation payload has an invalid PNG signature.');
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const chunks: PngChunk[] = [];
	let offset = 8;
	let expectedSize = 0;
	let color = 0;
	let palette = false;
	let idatSize = 0;
	let idatEnded = false;
	let ended = false;
	while (offset < bytes.length) {
		checkAbort(signal);
		if (bytes.length - offset < 12) fail('The PNG moderation payload has a truncated PNG chunk.');
		const length = view.getUint32(offset);
		if (length > bytes.length - offset - 12)
			fail('The PNG moderation payload has a truncated PNG chunk.');
		const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
		if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type))
			fail('The PNG moderation payload has an invalid PNG chunk type.');
		if (
			(await crc32(bytes, offset + 4, offset + 8 + length, signal)) !==
			view.getUint32(offset + 8 + length)
		)
			fail('The PNG moderation payload has an invalid PNG chunk checksum.');
		if (!chunks.length) {
			if (type !== 'IHDR' || length !== 13)
				fail('The PNG moderation payload is missing its image header.');
			const info = scanlineSize(view, offset + 8);
			expectedSize = info.size;
			color = info.color;
		} else if (type === 'IHDR') {
			fail('The PNG moderation payload has duplicate image headers.');
		}
		if (type === 'PLTE') {
			if (
				palette ||
				idatSize ||
				!length ||
				length % 3 ||
				length > 768 ||
				color === 0 ||
				color === 4
			)
				fail('The PNG moderation payload has an invalid color palette.');
			palette = true;
		}
		if (type === 'IDAT') {
			if (idatEnded || (color === 3 && !palette))
				fail('The PNG moderation payload has an invalid image data layout.');
			idatSize += length;
		} else if (chunks.at(-1)?.type === 'IDAT') {
			idatEnded = true;
		}
		chunks.push({ start: offset, length, type });
		offset += 12 + length;
		if (type === 'IEND') {
			if (length || idatSize < 6 || offset !== bytes.length)
				fail('The PNG moderation payload has an invalid PNG ending.');
			ended = true;
			break;
		}
		// A many-small-chunk input must also relinquish the main thread.
		if (chunks.length % 128 === 0) await yieldWork(signal);
		if (chunks.length > 65536) fail('The PNG moderation payload has too many PNG chunks.');
	}
	if (!ended) fail('The PNG moderation payload is missing its PNG ending.');
	return { chunks, expectedSize, idatSize };
}

async function recompress(
	bytes: Uint8Array<ArrayBuffer>,
	chunks: PngChunk[],
	expectedSize: number,
	idatSize: number,
	decompressor: DecompressionStream,
	compressor: CompressionStream,
	signal?: AbortSignal,
) {
	const idats = chunks.filter((chunk) => chunk.type === 'IDAT');
	let chunkIndex = 0;
	let chunkOffset = 0;
	const source = new ReadableStream<BufferSource>({
		pull(controller) {
			checkAbort(signal);
			while (chunkIndex < idats.length && chunkOffset === idats[chunkIndex].length) {
				chunkIndex++;
				chunkOffset = 0;
			}
			if (chunkIndex === idats.length) return controller.close();
			const chunk = idats[chunkIndex];
			const amount = Math.min(WORK_SLICE, chunk.length - chunkOffset);
			controller.enqueue(
				bytes.subarray(chunk.start + 8 + chunkOffset, chunk.start + 8 + chunkOffset + amount),
			);
			chunkOffset += amount;
		},
	});
	let expanded = 0;
	const limiter = new TransformStream<Uint8Array<ArrayBuffer>, BufferSource>({
		transform(value, controller) {
			checkAbort(signal);
			expanded += value.byteLength;
			if (expanded > MAX_SCANLINE_BYTES)
				fail('The PNG moderation payload exceeds the 128 MiB decoded image limit.');
			if (expanded > expectedSize)
				fail('The PNG moderation payload has invalid decoded image data.');
			controller.enqueue(value);
		},
		flush() {
			if (expanded !== expectedSize)
				fail('The PNG moderation payload has invalid decoded image data.');
		},
	});
	let compressedSize = 0;
	let compressedChunks: Uint8Array[] | undefined = [];
	await source
		.pipeThrough(decompressor)
		.pipeThrough(limiter)
		.pipeThrough(compressor)
		.pipeTo(
			new WritableStream<Uint8Array>({
				write(value) {
					checkAbort(signal);
					compressedSize += value.byteLength;
					// Continue checking the zlib stream after a no-gain result, without
					// retaining more output than the encoded input budget permits.
					if (compressedSize >= idatSize) compressedChunks = undefined;
					else compressedChunks?.push(value);
				},
			}),
			{ signal },
		);
	if (!compressedChunks) return undefined;
	const compressed = new Uint8Array(compressedSize);
	let offset = 0;
	for (const chunk of compressedChunks) {
		compressed.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return compressed;
}

async function replaceIdat(
	bytes: Uint8Array,
	chunks: PngChunk[],
	compressed: Uint8Array,
	idatSize: number,
	signal?: AbortSignal,
) {
	const output = new Uint8Array(bytes.length - idatSize + compressed.length);
	output.set(bytes.subarray(0, 8));
	const view = new DataView(output.buffer);
	let target = 8;
	let originalConsumed = 0;
	let compressedConsumed = 0;
	for (const chunk of chunks) {
		checkAbort(signal);
		if (chunk.type !== 'IDAT') {
			output.set(bytes.subarray(chunk.start, chunk.start + 12 + chunk.length), target);
			target += 12 + chunk.length;
			continue;
		}
		// Retain the original IDAT count and positions, including empty chunks.
		originalConsumed += chunk.length;
		const next =
			originalConsumed === idatSize
				? compressed.length
				: Math.floor((originalConsumed / idatSize) * compressed.length);
		const length = next - compressedConsumed;
		view.setUint32(target, length);
		output.set(bytes.subarray(chunk.start + 4, chunk.start + 8), target + 4);
		output.set(compressed.subarray(compressedConsumed, next), target + 8);
		view.setUint32(
			target + 8 + length,
			await crc32(output, target + 4, target + 8 + length, signal),
		);
		target += 12 + length;
		compressedConsumed = next;
	}
	return output;
}

/** Losslessly shrink a large PNG copy for moderation; never alter its displayed asset. */
export async function moderateImagePayload(dataUrl: string, signal?: AbortSignal): Promise<string> {
	checkAbort(signal);
	const prefix = /^data:image\/(?:png|x-png|apng);base64,/i.exec(dataUrl)?.[0];
	if (!prefix) return dataUrl;
	const base64 = dataUrl.slice(prefix.length);
	if (base64.length <= MIN_BASE64_LENGTH) return dataUrl;
	if (
		typeof CompressionStream !== 'function' ||
		typeof DecompressionStream !== 'function' ||
		typeof atob !== 'function' ||
		typeof btoa !== 'function'
	)
		return dataUrl;
	let decompressor: DecompressionStream;
	let compressor: CompressionStream;
	try {
		decompressor = new DecompressionStream('deflate');
		compressor = new CompressionStream('deflate');
	} catch {
		// Some browser versions expose the constructors without deflate support.
		return dataUrl;
	}
	try {
		const bytes = await decodeBase64(base64, signal);
		const { chunks, expectedSize, idatSize } = await parsePng(bytes, signal);
		const compressed = await recompress(
			bytes,
			chunks,
			expectedSize,
			idatSize,
			decompressor,
			compressor,
			signal,
		);
		checkAbort(signal);
		if (!compressed) return dataUrl;
		const output = await replaceIdat(bytes, chunks, compressed, idatSize, signal);
		return prefix + (await encodeBase64(output, signal));
	} catch (error) {
		checkAbort(signal);
		if (error instanceof PayloadError) throw error;
		fail('The PNG moderation payload could not be decoded and recompressed.');
	}
}
