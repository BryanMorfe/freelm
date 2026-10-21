import { randomUUID } from 'node:crypto';
import { stat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { Readable } from 'node:stream';
import type { WorkflowRun } from '../../src/workflow-types';
import { WorkflowAssets, isWorkflowAsset } from './assets';

/** Media-only capabilities: a page cannot turn a guessed URL into a filesystem read. */
export class WorkflowPreviews {
	private readonly entries = new Map<string, { path: string; mime: string; workspace: string }>();
	constructor(private readonly assets: WorkflowAssets) {}
	async create(run: WorkflowRun, filename: string, workspace: string): Promise<string> {
		let mime = '';
		let count = 0;
		function visit(value: unknown, depth = 0) {
			if (depth > 30 || ++count > 10000 || !value || typeof value !== 'object') return;
			if (isWorkflowAsset(value) && value.path === filename) mime = value.mimeType;
			for (const item of Object.values(value)) visit(item, depth + 1);
		}
		visit(run.outputs);
		for (const node of Object.values(run.nodes)) visit(node.output);
		if (
			!/^(image\/(png|jpeg|webp|gif|avif)|video\/(mp4|webm)|audio\/(mpeg|wav|mp4|ogg|flac|webm))$/.test(
				mime,
			)
		)
			throw new Error('This run has no previewable media at that path.');
		const path = await this.assets.resolve(filename, workspace);
		const info = await stat(path);
		if (!info.isFile() || info.size > 256 * 1024 * 1024)
			throw new Error('Workflow preview exceeds the media limit.');
		for (const [url, entry] of this.entries)
			if (entry.path === path && entry.mime === mime) return url;
		while (this.entries.size >= 512) this.entries.delete(this.entries.keys().next().value!);
		const url = `freelm-workflow://asset/${randomUUID()}`;
		this.entries.set(url, { path, mime, workspace });
		return url;
	}
	resolve(url: string) {
		return this.entries.get(url);
	}
	async respond(request: Request): Promise<Response> {
		const entry = this.entries.get(request.url);
		if (!entry || !['GET', 'HEAD'].includes(request.method))
			return new Response('Not found', { status: 404 });
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			// Resolve on every request, and keep a descriptor for streaming. A path replaced
			// by a symlink after the preview was issued must never redirect this read.
			const filename = await this.assets.resolve(entry.path, entry.workspace);
			handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
			const info = await handle.stat();
			if (!info.isFile() || info.size > 256 * 1024 * 1024)
				throw new Error('Unsupported media file.');
			const headers = new Headers({
				'Content-Type': entry.mime,
				'Accept-Ranges': 'bytes',
				'Cache-Control': 'no-store',
				'X-Content-Type-Options': 'nosniff',
				'Content-Security-Policy': "default-src 'none'; sandbox",
			});
			let start = 0,
				end = info.size - 1,
				status = 200;
			const range = request.headers.get('range');
			if (range) {
				const match = /^bytes=(\d*)-(\d*)$/.exec(range);
				if (!match || (!match[1] && !match[2])) {
					await handle.close();
					handle = undefined;
					return new Response(null, {
						status: 416,
						headers: { 'Content-Range': `bytes */${info.size}` },
					});
				}
				if (!match[1]) start = Math.max(0, info.size - Number(match[2]));
				else {
					start = Number(match[1]);
					if (match[2]) end = Math.min(end, Number(match[2]));
				}
				if (
					!Number.isSafeInteger(start) ||
					!Number.isSafeInteger(end) ||
					start < 0 ||
					start > end
				) {
					await handle.close();
					handle = undefined;
					return new Response(null, {
						status: 416,
						headers: { 'Content-Range': `bytes */${info.size}` },
					});
				}
				status = 206;
				headers.set('Content-Range', `bytes ${start}-${end}/${info.size}`);
			}
			headers.set('Content-Length', String(Math.max(0, end - start + 1)));
			if (request.method === 'HEAD' || !info.size) {
				await handle.close();
				handle = undefined;
				return new Response(null, { status, headers });
			}
			const stream = handle.createReadStream({
				start,
				end,
				autoClose: true,
				signal: request.signal,
			});
			handle = undefined;
			return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
				status,
				headers,
			});
		} catch {
			await handle?.close().catch(() => {});
			return new Response('Media unavailable', { status: 404 });
		}
	}
	clear() {
		this.entries.clear();
	}
}
