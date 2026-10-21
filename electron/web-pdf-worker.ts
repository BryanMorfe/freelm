import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import path from 'node:path';
import { getDocument, AnnotationMode, VerbosityLevel } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Canvas, SKRSContext2D } from '@napi-rs/canvas';
import type { PDFDocumentProxy, TextItem } from 'pdfjs-dist/types/src/display/api';
import type { PdfDocument, PdfPage, PdfScreenshot } from './tools/pdf';

const INPUT_LIMIT = 32 * 1024 * 1024;
const MAX_PAGES = 500;
const MAX_DOCUMENT_CHARS = 1_000_000;
const MAX_PAGE_CHARS = 120_000;
const MAX_LINKS = 200;
const MAX_EDGE = 2000;
const MAX_PIXELS = 4_000_000;
const MAX_PNG_BYTES = 8 * 1024 * 1024;
const require = createRequire(import.meta.url);
const pdfRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
function fallbackTitle(url: string): string {
	try {
		return (
			decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '').slice(0, 300) ||
			'PDF document'
		);
	} catch {
		return 'PDF document';
	}
}
function textLines(
	items: TextItem[],
	budget: number,
): { lines: string[]; characters: number; truncated: boolean } {
	let text = '';
	let previousY: number | undefined;
	let truncated = false;
	for (const item of items) {
		if (typeof item.str !== 'string') continue;
		const y = item.transform?.[5];
		if (
			text &&
			previousY !== undefined &&
			typeof y === 'number' &&
			Math.abs(y - previousY) > 2 &&
			!text.endsWith('\n')
		)
			text += '\n';
		const remaining = budget - text.length;
		if (remaining <= 0) {
			truncated = true;
			break;
		}
		text += item.str.slice(0, remaining);
		if (item.str.length > remaining) {
			truncated = true;
			break;
		}
		text += item.hasEOL ? '\n' : ' ';
		previousY = y;
	}
	const lines = text.split(/\r?\n/).flatMap((line) => {
		const normalized = line.replace(/[\t\u00a0 ]+/g, ' ').trim();
		return normalized.match(/.{1,160}(?:\s|$)|.{1,160}/gu)?.map((part) => part.trim()) ?? [];
	});
	return { lines, characters: text.length, truncated };
}
async function read(document: PDFDocumentProxy, url: string): Promise<PdfDocument> {
	let title = fallbackTitle(url);
	try {
		const metadata = await document.getMetadata();
		const candidate = (metadata.info as { Title?: unknown }).Title;
		if (typeof candidate === 'string' && candidate.trim())
			title = candidate.replace(/\s+/g, ' ').trim().slice(0, 300);
	} catch {
		/* Metadata is optional; page extraction can still succeed. */
	}
	const pages: PdfPage[] = [];
	let remaining = MAX_DOCUMENT_CHARS;
	let truncated = false;
	let linksRemaining = MAX_LINKS;
	for (let index = 0; index < document.numPages; index++) {
		const page = await document.getPage(index + 1);
		try {
			const content = await page.getTextContent();
			const extracted = textLines(
				content.items.filter((item): item is TextItem => 'str' in item),
				Math.min(MAX_PAGE_CHARS, Math.max(0, remaining)),
			);
			remaining -= extracted.characters;
			truncated ||= extracted.truncated;
			const links: PdfPage['links'] = [];
			for (const annotation of await page.getAnnotations({ intent: 'display' })) {
				if (linksRemaining <= 0) {
					truncated = true;
					break;
				}
				if (typeof annotation.url !== 'string') continue;
				try {
					const target = new URL(annotation.url);
					if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password)
						continue;
					if (target.href.length > 2048) {
						truncated = true;
						continue;
					}
					if (links.some((link) => link.url === target.href)) continue;
					const description = annotation.contentsObj?.str;
					links.push({
						title:
							typeof description === 'string' && description.trim()
								? description.trim().slice(0, 300)
								: target.hostname,
						url: target.href,
					});
					linksRemaining--;
				} catch {
					/* Unsupported annotation actions are not browse links. */
				}
			}
			pages.push({ lines: extracted.lines, links });
		} finally {
			page.cleanup();
		}
	}
	return { title, pages, ...(truncated ? { truncated: true } : {}) };
}
async function screenshot(
	document: PDFDocumentProxy,
	url: string,
	pageno: number,
): Promise<PdfScreenshot> {
	if (!Number.isInteger(pageno) || pageno < 0 || pageno >= document.numPages)
		throw new Error(
			`This PDF has ${document.numPages} pages. Use a page number from 0 through ${document.numPages - 1}.`,
		);
	const page = await document.getPage(pageno + 1);
	const initial = page.getViewport({ scale: 1 });
	if (
		!Number.isFinite(initial.width) ||
		!Number.isFinite(initial.height) ||
		initial.width <= 0 ||
		initial.height <= 0
	)
		throw new Error('The PDF page has invalid dimensions.');
	const scale = Math.min(
		2,
		MAX_EDGE / Math.max(initial.width, initial.height),
		Math.sqrt(MAX_PIXELS / (initial.width * initial.height)),
	);
	const viewport = page.getViewport({ scale });
	const width = Math.max(1, Math.floor(viewport.width));
	const height = Math.max(1, Math.floor(viewport.height));
	const factory = document.canvasFactory as {
		create(width: number, height: number): { canvas: Canvas; context: SKRSContext2D };
		destroy(target: { canvas: Canvas; context: SKRSContext2D }): void;
	};
	const target = factory.create(width, height);
	try {
		await page.render({
			canvas: target.canvas as unknown as HTMLCanvasElement,
			canvasContext: target.context as unknown as CanvasRenderingContext2D,
			viewport,
			annotationMode: AnnotationMode.DISABLE,
			background: 'rgb(255,255,255)',
		}).promise;
		const png: Buffer = await target.canvas.encode('png');
		if (png.byteLength > MAX_PNG_BYTES)
			throw new Error('The PDF screenshot exceeded the 8 MiB image limit.');
		return {
			dataUrl: `data:image/png;base64,${png.toString('base64')}`,
			name: `${
				fallbackTitle(url)
					.replace(/\.pdf$/i, '')
					.replace(/[^\p{L}\p{N}._-]/gu, '_')
					.slice(0, 100) || 'document'
			}-page-${pageno + 1}.png`,
		};
	} finally {
		factory.destroy(target);
		page.cleanup();
	}
}
async function processDocument(): Promise<PdfDocument | PdfScreenshot> {
	const { operation, bytes, url, pageno } = workerData;
	if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > INPUT_LIMIT)
		throw new Error('PDFs must contain data and be no larger than 32 MiB.');
	// PDF.js 6 no longer generates JavaScript via eval. Retain this explicit
	// defense for compatibility with PDF.js versions exposing the option.
	const options = {
		data: bytes,
		isEvalSupported: false,
		enableXfa: false,
		useWorkerFetch: false,
		disableAutoFetch: true,
		disableStream: true,
		maxImageSize: 16_000_000,
		canvasMaxAreaInBytes: 64 * 1024 * 1024,
		standardFontDataUrl: path.join(pdfRoot, 'standard_fonts') + path.sep,
		cMapUrl: path.join(pdfRoot, 'cmaps') + path.sep,
		cMapPacked: true,
		wasmUrl: path.join(pdfRoot, 'wasm') + path.sep,
		verbosity: VerbosityLevel.ERRORS,
	};
	const task = getDocument(options);
	try {
		const document = await task.promise;
		if (document.numPages > MAX_PAGES)
			throw new Error('This PDF has more than 500 pages. Choose a smaller document.');
		if (operation === 'read') return await read(document, url);
		if (operation === 'screenshot') return await screenshot(document, url, pageno);
		throw new Error('Unsupported PDF operation.');
	} finally {
		await task.destroy();
	}
}
try {
	parentPort?.postMessage({ result: await processDocument() });
} catch (error) {
	parentPort?.postMessage({
		error: error instanceof Error ? error.message : 'PDF processing failed.',
	});
} finally {
	parentPort?.close();
}
