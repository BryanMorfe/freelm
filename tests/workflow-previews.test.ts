import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkflowPreviews } from '../electron/workflows/previews';
import { WorkflowAssets } from '../electron/workflows/assets';
import type { WorkflowRun } from '../src/workflow-types';

describe('workflow media preview capabilities', () => {
	it('only serves media referenced by a run within its workspace or managed artifacts', async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), 'workflow-previews-'));
		try {
			const workspace = path.join(directory, 'workspace');
			await mkdir(workspace);
			const assets = new WorkflowAssets(path.join(directory, 'artifacts'));
			const previews = new WorkflowPreviews(assets);
			const media = await assets.store(
				Buffer.from('fixture'),
				'image/png',
				'preview.png',
				new AbortController().signal,
			);
			const run = { nodes: { image: { output: { images: [media] } } } } as unknown as WorkflowRun;
			const url = await previews.create(run, media.path, workspace);
			expect(url).toMatch(/^freelm-workflow:\/\/asset\/[a-f0-9-]+$/);
			expect(previews.resolve(url)?.path).toBe(media.path);
			const response = await previews.respond(
				new Request(url, { headers: { range: 'bytes=1-3' } }),
			);
			expect(response.status).toBe(206);
			expect(response.headers.get('content-range')).toBe('bytes 1-3/7');
			expect(await response.text()).toBe('ixt');
			expect(
				(await previews.respond(new Request(url, { headers: { range: 'bytes=99-100' } }))).status,
			).toBe(416);
			expect(await previews.create(run, media.path, workspace)).toBe(url);
			expect(previews.resolve('freelm-workflow://asset/guess')).toBeUndefined();
			await expect(
				previews.create(run, path.join(workspace, 'unknown.png'), workspace),
			).rejects.toThrow('no previewable media');
			const outside = path.join(directory, 'outside.png');
			await writeFile(outside, 'private');
			const outsideRun = {
				nodes: { image: { output: { ...media, path: outside } } },
			} as unknown as WorkflowRun;
			await expect(previews.create(outsideRun, outside, workspace)).rejects.toThrow();
			const linked = path.join(workspace, 'link.png');
			await symlink(outside, linked);
			const linkedRun = {
				nodes: { image: { output: { ...media, path: linked } } },
			} as unknown as WorkflowRun;
			await expect(previews.create(linkedRun, linked, workspace)).rejects.toThrow();
			const activeRun = {
				nodes: { image: { output: { ...media, mimeType: 'image/svg+xml' } } },
			} as unknown as WorkflowRun;
			await expect(previews.create(activeRun, media.path, workspace)).rejects.toThrow(
				'no previewable media',
			);
			await rm(media.path);
			await symlink(outside, media.path);
			expect((await previews.respond(new Request(url))).status).toBe(404);
			previews.clear();
			expect(previews.resolve(url)).toBeUndefined();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
