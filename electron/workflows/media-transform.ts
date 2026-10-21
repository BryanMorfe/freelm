import { createRequire } from 'node:module';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { webImageDimensions } from '../tools/web-image';

const source = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const { createCanvas, loadImage } = require(workerData.canvasModule);
  const image = await loadImage(Buffer.from(workerData.bytes));
  const { width, height, x, y, crop, format } = workerData;
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  if (format === 'jpeg') { context.fillStyle = '#fff'; context.fillRect(0, 0, width, height); }
  if (crop) context.drawImage(image, x, y, width, height, 0, 0, width, height);
  else context.drawImage(image, 0, 0, width, height);
  const output = await canvas.encode(format);
  if (output.length > 32 * 1024 * 1024) throw new Error('Image output exceeds 32 MiB.');
  parentPort.postMessage({ bytes: output });
})().catch(error => parentPort.postMessage({ error: error.message }));`;

/** Bounded native decoder worker: no renderer and no shell commands. */
export async function transformWorkflowImage(
	bytes: Buffer,
	mime: string,
	config: Record<string, unknown>,
	signal: AbortSignal,
): Promise<{ bytes: Buffer; mime: string; extension: string }> {
	const dimensions = webImageDimensions(bytes, mime);
	const operation = config.operation ?? 'resize';
	if (!['resize', 'crop', 'convert'].includes(String(operation)))
		throw new Error('Image operation must be resize, crop, or convert.');
	const dimension = (name: string, fallback: number, min = 1) => {
		const value = config[name] ?? fallback;
		if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > 8000)
			throw new Error(`${name} must be an integer from ${min} to 8000.`);
		return value;
	};
	const width = operation === 'convert' ? dimensions.width : dimension('width', dimensions.width);
	const height =
		operation === 'convert'
			? dimensions.height
			: dimension('height', Math.round((dimensions.height * width) / dimensions.width));
	const x = dimension('x', 0, 0),
		y = dimension('y', 0, 0);
	if (width * height > 16_000_000) throw new Error('Image output exceeds 16 megapixels.');
	if (operation === 'crop' && (x + width > dimensions.width || y + height > dimensions.height))
		throw new Error('Crop extends outside the source image.');
	const format = config.format === 'jpg' ? 'jpeg' : (config.format ?? 'png');
	if (!['png', 'jpeg', 'webp'].includes(String(format)))
		throw new Error('Image output format must be png, jpeg, or webp.');
	signal.throwIfAborted();
	const require = createRequire(
		typeof __dirname === 'string'
			? path.join(__dirname, '..', 'package.json')
			: path.join(process.cwd(), 'package.json'),
	);
	const canvasModule = require
		.resolve('@napi-rs/canvas')
		.replace(/\.asar(?=[\\/])/g, '.asar.unpacked');
	const output = await new Promise<Buffer>((resolve, reject) => {
		const worker = new Worker(source, {
			eval: true,
			workerData: { bytes, canvasModule, width, height, x, y, crop: operation === 'crop', format },
			resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 4 },
		});
		let settled = false;
		const finish = (error?: Error, result?: Buffer) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal.removeEventListener('abort', abort);
			void worker.terminate();
			if (error) reject(error);
			else resolve(result!);
		};
		const abort = () => finish(new DOMException('Image transform cancelled.', 'AbortError'));
		const timer = setTimeout(() => finish(new Error('Image transform timed out.')), 30_000);
		signal.addEventListener('abort', abort, { once: true });
		worker.once('message', (message) =>
			message.bytes
				? finish(undefined, Buffer.from(message.bytes))
				: finish(new Error(message.error ?? 'Image transform failed.')),
		);
		worker.once('error', (error) => finish(error));
		worker.once('exit', (code) => {
			if (!settled) finish(new Error(`Image transform stopped (${code}).`));
		});
	});
	return { bytes: output, mime: `image/${format}`, extension: String(format) };
}
