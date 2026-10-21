import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { downloadImageAsset } from '../electron/image-assets';
import { resolveImageAsset } from '../src/lib/image-assets';

const png =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6pAAAAABJRU5ErkJggg==';
const asset = {
	name: 'generated.png',
	mimeType: 'image/png',
	url: 'https://cdn.example.test/image.png?signature=private',
};
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('image asset transport', () => {
	it.each(['image/avif', 'application/octet-stream', ''])(
		'preserves AVIF bytes for downloads with content type %s',
		async (contentType) => {
			const bytes = readFileSync(new URL('./fixtures/reference.avif', import.meta.url));
			// Compatible brands identify AVIF even when the major brand is mif1.
			bytes.write('mif1', 8, 'ascii');
			vi.stubGlobal(
				'fetch',
				vi.fn(
					async () =>
						new Response(bytes, {
							headers: contentType ? { 'content-type': contentType } : {},
						}),
				),
			);
			expect(await downloadImageAsset(asset.url)).toEqual({
				status: 200,
				contentType: 'image/avif',
				encoding: 'base64',
				body: bytes.toString('base64'),
			});
		},
	);
	it('loads signed CDN images without credentials or redirects and detects octet-stream PNGs', async () => {
		const fetch = vi.fn(
			async () =>
				new Response(Buffer.from(png, 'base64'), {
					headers: { 'content-type': 'application/octet-stream' },
				}),
		);
		vi.stubGlobal('fetch', fetch);
		expect(await downloadImageAsset(asset.url)).toEqual({
			status: 200,
			contentType: 'image/png',
			encoding: 'base64',
			body: png,
		});
		expect(fetch).toHaveBeenCalledWith(asset.url, {
			redirect: 'error',
			signal: expect.any(AbortSignal),
		});
	});
	it.each(['file:///private/image.png', 'https://user:secret@cdn.example.test/image.png'])(
		'rejects unsafe image URL %s before fetching',
		async (url) => {
			const fetch = vi.fn();
			vi.stubGlobal('fetch', fetch);
			await expect(downloadImageAsset(url)).rejects.toThrow();
			expect(fetch).not.toHaveBeenCalled();
		},
	);
	it('does not report HTML as an image or expose signed URLs in HTTP errors', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response('<html>secret</html>', { headers: { 'content-type': 'text/html' } }),
			),
		);
		await expect(downloadImageAsset(asset.url)).rejects.toThrow('supported image');
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('private-token', { status: 403 })),
		);
		await expect(downloadImageAsset(asset.url)).rejects.toThrow(
			'Could not load this image (HTTP 403).',
		);
	});
	it('bounds declared and streamed image sizes', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () => new Response('', { headers: { 'content-length': String(33 * 1024 * 1024) } }),
			),
		);
		await expect(downloadImageAsset(asset.url)).rejects.toThrow('32 MB');
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
		await expect(downloadImageAsset(asset.url)).rejects.toThrow('32 MB');
	});
});

describe('selected image resolution', () => {
	it('uses embedded pixels directly without a network request', async () => {
		const fetch = vi.fn();
		vi.stubGlobal('fetch', fetch);
		const embedded = { ...asset, url: `data:image/png;base64,${png}` };
		expect(await resolveImageAsset(embedded, 'local', 'provider')).toEqual({
			name: asset.name,
			type: 'image/png',
			dataUrl: embedded.url,
		});
		expect(fetch).not.toHaveBeenCalled();
	});
	it.each(['local', 'remote'])(
		'resolves %s image URLs through the owning workspace, not browser fetch',
		async (workspace) => {
			const instanceAsset = vi.fn(async () => ({
				status: 200,
				contentType: 'image/png',
				encoding: 'base64',
				body: png,
			}));
			const fetch = vi.fn();
			vi.stubGlobal('fetch', fetch);
			vi.stubGlobal('window', { desktop: { instanceAsset } });
			expect(await resolveImageAsset(asset, workspace, 'original-provider')).toMatchObject({
				dataUrl: `data:image/png;base64,${png}`,
			});
			expect(instanceAsset).toHaveBeenCalledWith(workspace, 'original-provider', asset.url);
			expect(fetch).not.toHaveBeenCalled();
		},
	);
	it('rejects canceled viewer loads promptly while consuming a later desktop rejection', async () => {
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
		const pending = resolveImageAsset(asset, 'remote', 'provider', controller.signal);
		const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
		controller.abort();
		await assertion;
		reject(new Error('Late host failure'));
		await Promise.resolve();
	});
	it('rejects bad host payloads and empty media', async () => {
		vi.stubGlobal('window', {
			desktop: {
				instanceAsset: async () => ({
					status: 200,
					contentType: 'text/html',
					encoding: 'base64',
					body: png,
				}),
			},
		});
		await expect(resolveImageAsset(asset, 'remote', 'provider')).rejects.toThrow('supported image');
	});
});
