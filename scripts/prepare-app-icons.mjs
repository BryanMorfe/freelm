import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const branding = path.join(root, 'resources/branding');
const source = await readFile(path.join(branding, 'logo-app.svg'), 'utf8');
const viewBox = source.match(/<svg\b[^>]*\bviewBox="([^"]+)"/)?.[1].trim().split(/[\s,]+/).map(Number);
if (!viewBox || viewBox.length !== 4 || viewBox.some(value => !Number.isFinite(value))
	|| viewBox[2] <= 0 || viewBox[2] !== viewBox[3])
	throw new Error('The app icon SVG must have a square viewBox.');

await mkdir(path.join(branding, 'png'), { recursive: true });
async function png(size) {
	// Set the SVG viewport before decoding so every output is rasterized from
	// vectors at its actual target resolution, including the 4096px export.
	const sizedSource = source.replace(/<svg\b[^>]*>/, tag => tag
		.replace(/\s(?:width|height)="[^"]*"/g, '')
		.replace('<svg', `<svg width="${size}" height="${size}"`));
	const image = await loadImage(Buffer.from(sizedSource));
	if (image.width !== size || image.height !== size)
		throw new Error(`The SVG did not render at the requested ${size}px resolution.`);
	const canvas = createCanvas(size, size);
	const context = canvas.getContext('2d');
	context.drawImage(image, 0, 0);
	const pixels = context.getImageData(0, 0, size, size).data;
	for (let offset = 3; offset < pixels.length; offset += 4) {
		if (pixels[offset] !== 255)
			throw new Error(`The ${size}px app icon must have an opaque, full-bleed background.`);
	}
	return Buffer.from(await canvas.encode('png'));
}

const images = new Map();
for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
	const image = await png(size);
	const decoded = await loadImage(image);
	if (decoded.width !== size || decoded.height !== size)
		throw new Error(`The ${size}px icon did not encode with the expected dimensions.`);
	images.set(size, image);
	await writeFile(path.join(branding, 'png', `${size}x${size}.png`), image);
}
await writeFile(path.join(branding, 'icon.png'), images.get(1024));
await writeFile(path.join(branding, 'logo-app.png'), await png(4096));
await writeFile(path.join(root, 'public/favicon.png'), images.get(64));

// Embed the verified PNGs directly. Some versions of Electron Builder's icon
// converter corrupt intermediate sizes while resizing a single source image.
const icnsChunks = [
	['icp4', 16], ['icp5', 32], ['icp6', 64],
	['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024],
	['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512],
].map(([type, size]) => {
	const image = images.get(size);
	const header = Buffer.alloc(8);
	header.write(type, 0, 4, 'ascii');
	header.writeUInt32BE(header.length + image.length, 4);
	return Buffer.concat([header, image]);
});
const icnsHeader = Buffer.alloc(8);
icnsHeader.write('icns', 0, 4, 'ascii');
icnsHeader.writeUInt32BE(icnsHeader.length + icnsChunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
await writeFile(path.join(branding, 'icon.icns'), Buffer.concat([icnsHeader, ...icnsChunks]));

const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const icoHeader = Buffer.alloc(6 + 16 * icoSizes.length);
icoHeader.writeUInt16LE(1, 2); // ICO image type.
icoHeader.writeUInt16LE(icoSizes.length, 4);
let imageOffset = icoHeader.length;
for (const [index, size] of icoSizes.entries()) {
	const image = images.get(size);
	const entryOffset = 6 + 16 * index;
	icoHeader.writeUInt8(size === 256 ? 0 : size, entryOffset);
	icoHeader.writeUInt8(size === 256 ? 0 : size, entryOffset + 1);
	icoHeader.writeUInt16LE(1, entryOffset + 4); // Color planes.
	icoHeader.writeUInt16LE(32, entryOffset + 6); // RGBA bits per pixel.
	icoHeader.writeUInt32LE(image.length, entryOffset + 8);
	icoHeader.writeUInt32LE(imageOffset, entryOffset + 12);
	imageOffset += image.length;
}
await writeFile(path.join(branding, 'icon.ico'), Buffer.concat([icoHeader, ...icoSizes.map(size => images.get(size))]));
console.log('Prepared vector-rendered FreeLM PNG sizes, 4096px export, macOS ICNS, Windows ICO, and browser favicon.');
