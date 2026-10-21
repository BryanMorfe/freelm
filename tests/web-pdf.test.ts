import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { build } from 'esbuild';
import { loadImage } from '@napi-rs/canvas';
import { PdfProcessor, pdfWorkerPath } from '../electron/tools/pdf';
import { webPdfFixture } from './fixtures/web-pdf';

const workerPath = path.resolve('dist-electron/web-pdf-worker.mjs');
const processors: PdfProcessor[] = [];
beforeAll(async () => {
	await build({
		entryPoints: ['electron/web-pdf-worker.ts'],
		outfile: workerPath,
		bundle: true,
		platform: 'node',
		format: 'esm',
		target: 'node22',
		external: ['pdfjs-dist', '@napi-rs/canvas'],
		logLevel: 'silent',
	});
});
afterEach(() => {
	for (const processor of processors.splice(0)) processor.close();
});
function processor(timeoutMs?: number) {
	const value = new PdfProcessor({ workerPath, timeoutMs });
	processors.push(value);
	return value;
}
const signal = () => new AbortController().signal;
const url = 'https://example.com/document.pdf';

describe('PDF extraction and screenshots in actual isolated workers', () => {
	it('locates packaged workers beside unpacked ESM and native dependencies', () => {
		expect(
			pdfWorkerPath('/Applications/FreeLM.app/Contents/Resources/app.asar/dist-electron'),
		).toBe(
			'/Applications/FreeLM.app/Contents/Resources/app.asar.unpacked/dist-electron/web-pdf-worker.mjs',
		);
		expect(
			pdfWorkerPath('/Applications/FreeLM.app/Contents/Resources/app.asar.unpacked/dist-electron'),
		).toBe(
			'/Applications/FreeLM.app/Contents/Resources/app.asar.unpacked/dist-electron/web-pdf-worker.mjs',
		);
		expect(pdfWorkerPath(path.resolve('dist-electron'))).toBe(workerPath);
	});
	it('returns separate ordered page text and safe annotation links, without executing document scripts', async () => {
		const input = webPdfFixture({
			javascript: true,
			links: [
				'https://example.com/source',
				'file:///private/secret',
				'javascript:alert(1)',
				'https://user:password@example.com/',
			],
		});
		const original = input.slice();
		const document = await processor().read(input, url, signal());
		expect(document.title).toBe('FreeLM PDF fixture');
		expect(document.pages).toHaveLength(2);
		expect(document.pages[0].lines.join(' ')).toContain(
			'First PDF page, with searchable evidence.',
		);
		expect(document.pages[1].lines.join(' ')).toContain('Second page, with independent text.');
		expect(document.pages[0].links).toEqual([
			{ title: 'example.com', url: 'https://example.com/source' },
		]);
		expect(document.pages[1].links).toHaveLength(1);
		expect(input).toEqual(original);
		expect((globalThis as Record<string, unknown>).PDF_SCRIPT_EXECUTED).toBeUndefined();
	});

	it('renders distinct zero-based pages as valid PNG images within the size limits', async () => {
		const runtime = processor();
		const input = webPdfFixture();
		const first = await runtime.screenshot(input, url, 0, signal());
		const second = await runtime.screenshot(input, url, 1, signal());
		expect(first.name).toBe('document-page-1.png');
		expect(second.name).toBe('document-page-2.png');
		expect(first.dataUrl).toMatch(/^data:image\/png;base64,/);
		expect(first.dataUrl).not.toBe(second.dataUrl);
		const image = await loadImage(Buffer.from(first.dataUrl.split(',')[1], 'base64'));
		expect(image.width).toBe(600);
		expect(image.height).toBe(360);
		expect(Buffer.from(first.dataUrl.split(',')[1], 'base64').byteLength).toBeLessThan(
			8 * 1024 * 1024,
		);
	});

	it('scales an oversized PDF page down before allocating its screenshot canvas', async () => {
		const result = await processor().screenshot(
			webPdfFixture({ text: ['Large page'], width: 10000, height: 6000 }),
			url,
			0,
			signal(),
		);
		const image = await loadImage(Buffer.from(result.dataUrl.split(',')[1], 'base64'));
		expect(image.width).toBe(2000);
		expect(image.height).toBe(1200);
		expect(image.width * image.height).toBeLessThanOrEqual(4_000_000);
	});

	it('bounds extracted text and reports truncation while preserving page metadata', async () => {
		const document = await processor().read(
			webPdfFixture({ text: ['x'.repeat(125000)], width: 1_000_000 }),
			url,
			signal(),
		);
		expect(document.truncated).toBe(true);
		expect(document.pages).toHaveLength(1);
		expect(document.pages[0].lines.join('').length).toBeLessThanOrEqual(120000);
	});

	it('bounds aggregate document text and links, including oversized annotation URLs', async () => {
		const document = await processor().read(
			webPdfFixture({
				text: Array(10).fill('x'.repeat(110000)),
				width: 1_000_000,
				links: Array.from({ length: 30 }, (_, index) => `https://example.com/link-${index}`).concat(
					`https://example.com/${'x'.repeat(3000)}`,
				),
			}),
			url,
			signal(),
		);
		expect(document.pages).toHaveLength(10);
		expect(document.truncated).toBe(true);
		expect(
			document.pages.reduce((total, page) => total + page.lines.join('').length, 0),
		).toBeLessThanOrEqual(1_000_000);
		expect(
			document.pages.reduce((total, page) => total + page.links.length, 0),
		).toBeLessThanOrEqual(200);
		expect(
			document.pages.flatMap((page) => page.links).every((link) => link.url.length <= 2048),
		).toBe(true);
	});

	it('rejects too many pages, oversized inputs, malformed PDFs, and nonexistent page indices', async () => {
		const runtime = processor();
		await expect(
			runtime.read(webPdfFixture({ text: Array(501).fill('Page') }), url, signal()),
		).rejects.toThrow('more than 500 pages');
		await expect(runtime.read(new Uint8Array(32 * 1024 * 1024 + 1), url, signal())).rejects.toThrow(
			'32 MiB',
		);
		await expect(
			runtime.read(new Uint8Array(Buffer.from('not a PDF')), url, signal()),
		).rejects.toThrow(/PDF/i);
		await expect(runtime.screenshot(webPdfFixture(), url, 2, signal())).rejects.toThrow(
			'has 2 pages',
		);
		await expect(runtime.screenshot(webPdfFixture(), url, -1, signal())).rejects.toThrow(
			'page numbers',
		);
		await expect(runtime.screenshot(webPdfFixture(), url, 0.5, signal())).rejects.toThrow(
			'page numbers',
		);
	});

	it('leaves the main event loop responsive while PDF extraction runs', async () => {
		let heartbeats = 0;
		const interval = setInterval(() => {
			heartbeats++;
		}, 5);
		try {
			await processor().read(
				webPdfFixture({ text: Array(30).fill('Searchable PDF worker evidence.') }),
				url,
				signal(),
			);
			expect(heartbeats).toBeGreaterThan(2);
		} finally {
			clearInterval(interval);
		}
	});

	it('terminates a cancelled worker and allows a subsequent fresh document operation', async () => {
		const runtime = processor();
		const controller = new AbortController();
		const pending = runtime.read(webPdfFixture(), url, controller.signal);
		controller.abort();
		await expect(pending).rejects.toThrow('cancelled');
		expect((await runtime.read(webPdfFixture(), url, signal())).pages).toHaveLength(2);
	});

	it('terminates timed out work and aborts work when the processor closes', async () => {
		await expect(processor(1).read(webPdfFixture(), url, signal())).rejects.toThrow('timed out');
		const runtime = processor();
		const pending = runtime.read(webPdfFixture(), url, signal());
		runtime.close();
		await expect(pending).rejects.toThrow('cancelled');
		await expect(runtime.read(webPdfFixture(), url, signal())).rejects.toThrow('cancelled');
	});
});
