import path from 'node:path';
import { Worker } from 'node:worker_threads';

export interface PdfPage {
	lines: string[];
	links: { title: string; url: string }[];
}
export interface PdfDocument {
	title: string;
	pages: PdfPage[];
	truncated?: boolean;
}
export interface PdfScreenshot {
	dataUrl: string;
	name: string;
}
interface Options {
	/** Injected only by isolated tests; production uses the adjacent built worker. */
	workerPath?: string;
	timeoutMs?: number;
}
interface Job {
	worker: Worker;
	stop: () => void;
}
const INPUT_LIMIT = 32 * 1024 * 1024;
const aborted = () => new DOMException('PDF processing cancelled.', 'AbortError');

/** ESM workers and native Canvas dependencies live outside Electron's ASAR archive. */
export function pdfWorkerPath(directory: string): string {
	return path.join(directory.replace(/\.asar(?=[\\/])/g, '.asar.unpacked'), 'web-pdf-worker.mjs');
}

/** Parsing and rasterization never run on the Electron main event loop. */
export class PdfProcessor {
	private readonly workerPath: string;
	private readonly timeoutMs: number;
	private jobs = new Set<Job>();
	private closed = false;
	constructor(options: Options = {}) {
		this.workerPath =
			options.workerPath ??
			pdfWorkerPath(
				typeof __dirname === 'string' ? __dirname : path.join(process.cwd(), 'dist-electron'),
			);
		this.timeoutMs = options.timeoutMs ?? 45_000;
	}
	read(bytes: Uint8Array, url: string, signal: AbortSignal): Promise<PdfDocument> {
		return this.execute('read', bytes, url, signal);
	}
	screenshot(
		bytes: Uint8Array,
		url: string,
		pageno: number,
		signal: AbortSignal,
	): Promise<PdfScreenshot> {
		if (!Number.isInteger(pageno) || pageno < 0 || pageno >= 500)
			return Promise.reject(new Error('PDF page numbers must be integers from 0 through 499.'));
		return this.execute('screenshot', bytes, url, signal, pageno);
	}
	close(): void {
		this.closed = true;
		for (const job of [...this.jobs]) job.stop();
	}
	private async execute<T>(
		operation: 'read' | 'screenshot',
		bytes: Uint8Array,
		url: string,
		signal: AbortSignal,
		pageno?: number,
	): Promise<T> {
		if (signal.aborted || this.closed) throw aborted();
		if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > INPUT_LIMIT)
			throw new Error('PDFs must contain data and be no larger than 32 MiB.');
		if (this.jobs.size >= 2)
			throw new Error('Too many PDF operations are active. Try one document at a time.');
		return await new Promise<T>((resolve, reject) => {
			const worker = new Worker(this.workerPath, {
				workerData: { operation, bytes, url, pageno },
				resourceLimits: {
					maxOldGenerationSizeMb: 128,
					maxYoungGenerationSizeMb: 32,
					stackSizeMb: 8,
				},
			});
			let settled = false;
			const finish = (error?: Error, result?: T) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal.removeEventListener('abort', stop);
				this.jobs.delete(job);
				void worker.terminate().catch(() => {});
				if (error) reject(error);
				else resolve(result!);
			};
			const stop = () => finish(aborted());
			const job: Job = { worker, stop };
			this.jobs.add(job);
			const timer = setTimeout(
				() => finish(new Error('PDF processing timed out. Try a smaller document.')),
				this.timeoutMs,
			);
			timer.unref();
			signal.addEventListener('abort', stop, { once: true });
			worker.once('message', (message: { result?: T; error?: string }) => {
				if (signal.aborted || this.closed) return stop();
				if (typeof message?.error === 'string') finish(new Error(message.error));
				else if (message && Object.hasOwn(message, 'result')) finish(undefined, message.result);
				else finish(new Error('PDF processing returned an invalid result.'));
			});
			worker.once('error', (error) => finish(new Error(`PDF processing failed: ${error.message}`)));
			worker.once('exit', (code) => {
				if (!settled) finish(new Error(`PDF processing stopped unexpectedly (${code}).`));
			});
			if (signal.aborted) stop();
		});
	}
}
