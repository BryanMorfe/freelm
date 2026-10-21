import { createRequire } from 'node:module';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

export interface DecodedWebImage {
	dataUrl: string;
	width: number;
	height: number;
}

/** Validate dimensions before native decoding to bound decompression allocations. */
export function webImageDimensions(bytes: Buffer, mime: string): { width: number; height: number } {
	let width = 0;
	let height = 0;
	if (
		mime === 'image/png' &&
		bytes.length >= 24 &&
		bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
		bytes.toString('ascii', 12, 16) === 'IHDR'
	) {
		width = bytes.readUInt32BE(16);
		height = bytes.readUInt32BE(20);
	} else if (mime === 'image/jpeg' && bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
		let index = 2;
		while (index + 4 <= bytes.length) {
			if (bytes[index++] !== 0xff) break;
			while (index < bytes.length && bytes[index] === 0xff) index++;
			const marker = bytes[index++];
			if (marker === 0xd9 || marker === 0xda) break;
			if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
			if (index + 2 > bytes.length) break;
			const length = bytes.readUInt16BE(index);
			if (length < 2 || index + length > bytes.length) break;
			if (
				[0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
					marker,
				) &&
				length >= 7
			) {
				height = bytes.readUInt16BE(index + 3);
				width = bytes.readUInt16BE(index + 5);
				break;
			}
			index += length;
		}
	} else if (
		mime === 'image/webp' &&
		bytes.length >= 30 &&
		bytes.toString('ascii', 0, 4) === 'RIFF' &&
		bytes.toString('ascii', 8, 12) === 'WEBP'
	) {
		const format = bytes.toString('ascii', 12, 16);
		if (format === 'VP8X') {
			width = bytes.readUIntLE(24, 3) + 1;
			height = bytes.readUIntLE(27, 3) + 1;
		} else if (format === 'VP8L' && bytes[20] === 0x2f) {
			const bits = bytes.readUInt32LE(21);
			width = (bits & 0x3fff) + 1;
			height = ((bits >>> 14) & 0x3fff) + 1;
		} else if (
			format === 'VP8 ' &&
			bytes[23] === 0x9d &&
			bytes[24] === 0x01 &&
			bytes[25] === 0x2a
		) {
			width = bytes.readUInt16LE(26) & 0x3fff;
			height = bytes.readUInt16LE(28) & 0x3fff;
		}
	}
	if (!width || !height)
		throw new Error('The image bytes do not match a supported PNG, JPEG or WebP image.');
	if (width > 8000 || height > 8000 || width * height > 16_000_000)
		throw new Error('This image exceeds the 16 megapixel inspection limit.');
	return { width, height };
}

const decoderScript = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const { createCanvas, loadImage } = require(workerData.canvasModule);
  const image = await loadImage(Buffer.from(workerData.bytes));
  if (!image.width || !image.height || image.width > 8000 || image.height > 8000 || image.width * image.height > 16000000) throw new Error('Image dimensions exceed the inspection limit.');
  const scale = Math.min(1, workerData.edge / Math.max(image.width, image.height));
  const canvas = createCanvas(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
  const context = canvas.getContext('2d');
  if (workerData.preview) { context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height); }
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const encoded = await canvas.encode('jpeg', workerData.preview ? 75 : 90);
  if (encoded.length > workerData.maxOutput) throw new Error('The decoded image exceeds the output size limit.');
  parentPort.postMessage({ result: { dataUrl: 'data:image/jpeg;base64,' + encoded.toString('base64'), width: image.width, height: image.height } });
})().catch(error => parentPort.postMessage({ error: error instanceof Error ? error.message : 'Image decoding failed.' }));
`;

/** Decoding and resizing do not block Electron's main event loop. */
export function decodeWebImage(
	bytes: Buffer,
	mime: string,
	signal: AbortSignal,
	preview = false,
): Promise<DecodedWebImage> {
	if (signal.aborted) return Promise.reject(new Error('Image inspection was cancelled.'));
	if (!bytes.length || bytes.length > 8 * 1024 * 1024)
		return Promise.reject(new Error('Web images must be no larger than 8 MiB.'));
	webImageDimensions(bytes, mime);
	const base =
		typeof __dirname === 'string'
			? path.join(__dirname, '..', 'package.json')
			: path.join(process.cwd(), 'package.json');
	const require = createRequire(base);
	const canvasModule = require
		.resolve('@napi-rs/canvas')
		.replace(/\.asar(?=[\\/])/g, '.asar.unpacked');
	return new Promise((resolve, reject) => {
		const worker = new Worker(decoderScript, {
			eval: true,
			workerData: {
				bytes,
				canvasModule,
				preview,
				edge: preview ? 256 : 1600,
				maxOutput: preview ? 100_000 : 3 * 1024 * 1024,
			},
			resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
		});
		let settled = false;
		const finish = (error?: Error, result?: DecodedWebImage) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal.removeEventListener('abort', abort);
			void worker.terminate().catch(() => {});
			if (error) reject(error);
			else resolve(result!);
		};
		const abort = () => finish(new Error('Image inspection was cancelled.'));
		const timer = setTimeout(
			() => finish(new Error('Image decoding timed out.')),
			preview ? 2500 : 15_000,
		);
		signal.addEventListener('abort', abort, { once: true });
		worker.once('message', (message: { result?: DecodedWebImage; error?: string }) => {
			if (message.result) finish(undefined, message.result);
			else finish(new Error(message.error ?? 'Image decoding failed.'));
		});
		worker.once('error', (error) => finish(error));
		worker.once('exit', (code) => {
			if (!settled) finish(new Error(`Image decoding stopped (${code}).`));
		});
	});
}
