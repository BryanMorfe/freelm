import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadVideoAsset } from '../electron/image-assets';
import { resolveVideoAsset } from '../src/lib/video-assets';

const bytes = Buffer.from([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109]);
const body = bytes.toString('base64');
const asset = {
	name: 'clip.mp4',
	mimeType: 'video/mp4',
	url: 'https://cdn.example.test/clip?signature=private',
};
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('video asset loading', () => {
	it('recognizes binary MP4 without sending provider credentials or following redirects', async () => {
		const fetch = vi.fn(
			async () => new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }),
		);
		vi.stubGlobal('fetch', fetch);
		expect(await downloadVideoAsset(asset.url)).toEqual({
			status: 200,
			contentType: 'video/mp4',
			encoding: 'base64',
			body,
		});
		expect(fetch).toHaveBeenCalledWith(asset.url, {
			redirect: 'error',
			signal: expect.any(AbortSignal),
		});
	});
	it('recognizes binary WebM and rejects non-video payloads', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2]))),
		);
		expect(await downloadVideoAsset(asset.url)).toMatchObject({ contentType: 'video/webm' });
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response('<html>Not media</html>', { headers: { 'content-type': 'text/html' } }),
			),
		);
		await expect(downloadVideoAsset(asset.url)).rejects.toThrow('supported video');
	});
	it('rejects unsafe URLs before a request', async () => {
		const fetch = vi.fn();
		vi.stubGlobal('fetch', fetch);
		for (const url of ['file:///private/clip.mp4', 'https://user:secret@cdn.example.test/clip'])
			await expect(downloadVideoAsset(url)).rejects.toThrow();
		expect(fetch).not.toHaveBeenCalled();
	});
	it('bounds declared and streamed URL downloads', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () => new Response('', { headers: { 'content-length': String(33 * 1024 * 1024) } }),
			),
		);
		await expect(downloadVideoAsset(asset.url)).rejects.toThrow('32 MB');
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(new Uint8Array(33 * 1024 * 1024));
								controller.close();
							},
						}),
					),
			),
		);
		await expect(downloadVideoAsset(asset.url)).rejects.toThrow('32 MB');
	});
	it('uses embedded saved video without fetching', async () => {
		const fetch = vi.fn();
		vi.stubGlobal('fetch', fetch);
		const embedded = { ...asset, url: `data:video/mp4;base64,${body}` };
		expect(await resolveVideoAsset(embedded, 'remote', 'provider')).toMatchObject({
			dataUrl: embedded.url,
			type: 'video/mp4',
		});
		expect(fetch).not.toHaveBeenCalled();
	});
	it.each(['local', 'remote'])(
		'loads %s URL through its owning workspace connection',
		async (workspace) => {
			const instanceAsset = vi.fn(async () => ({
				status: 200,
				contentType: 'video/mp4',
				encoding: 'base64',
				body,
			}));
			const fetch = vi.fn();
			vi.stubGlobal('fetch', fetch);
			vi.stubGlobal('window', { desktop: { instanceAsset } });
			expect(await resolveVideoAsset(asset, workspace, 'original-provider')).toMatchObject({
				dataUrl: `data:video/mp4;base64,${body}`,
			});
			expect(instanceAsset).toHaveBeenCalledWith(
				workspace,
				'original-provider',
				asset.url,
				'video',
			);
			expect(fetch).not.toHaveBeenCalled();
		},
	);
	it('cancels promptly and consumes late native failures', async () => {
		let reject!: (error: Error) => void;
		vi.stubGlobal('window', {
			desktop: {
				instanceAsset: () =>
					new Promise((_resolve, fail) => {
						reject = fail;
					}),
			},
		});
		const controller = new AbortController();
		const pending = resolveVideoAsset(asset, 'remote', 'provider', controller.signal);
		const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
		controller.abort();
		await assertion;
		reject(new Error('Late failure'));
		await Promise.resolve();
	});
	it('rejects host HTTP errors and non-video content', async () => {
		const instanceAsset = vi.fn(async () => ({
			status: 403,
			contentType: 'text/html',
			encoding: 'text',
			body: 'private',
		}));
		vi.stubGlobal('window', { desktop: { instanceAsset } });
		await expect(resolveVideoAsset(asset, 'remote', 'provider')).rejects.toThrow('HTTP 403');
		instanceAsset.mockResolvedValue({
			status: 200,
			contentType: 'text/html',
			encoding: 'base64',
			body,
		});
		await expect(resolveVideoAsset(asset, 'remote', 'provider')).rejects.toThrow('supported video');
	});
});
