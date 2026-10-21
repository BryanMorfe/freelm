import http, { type Server } from 'node:http';
import { createCanvas } from '@napi-rs/canvas';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolHostRequest, ToolResult } from '../src/agent-types';
import { WebRuntime } from '../electron/tools/web';
import { webImageDimensions } from '../electron/tools/web-image';
import { imageViewTool, webInstructions } from '../src/lib/web-tools';

const plain = (result: ToolResult) =>
	result.content
		.filter((item) => item.type === 'text')
		.map((item) => item.text)
		.join('\n');

describe('selective public web image inspection', () => {
	let server: Server;
	let runtime: WebRuntime;
	let port: number;
	let requests: string[];
	let png: Buffer;
	const execute = (
		name: string,
		args: Record<string, unknown>,
		runId = 'one',
		threadId = 'chat',
	) => {
		const request: ToolHostRequest = {
			workspaceId: 'local',
			runId,
			threadId,
			name,
			arguments: args,
		};
		return runtime.execute(
			request,
			{ enabled: true, searxngUrl: `http://127.0.0.1:${port}` },
			new AbortController().signal,
		);
	};
	beforeEach(async () => {
		requests = [];
		const canvas = createCanvas(12, 8);
		canvas.getContext('2d').fillRect(0, 0, 12, 8);
		png = canvas.toBuffer('image/png');
		server = http.createServer((req, res) => {
			const url = new URL(req.url!, 'http://fixture');
			if (url.pathname === '/config') {
				res.setHeader('Content-Type', 'application/json');
				res.end(
					JSON.stringify({
						categories: ['images'],
						engines: [{ name: 'images', enabled: true, categories: ['images'] }],
					}),
				);
			} else if (url.pathname === '/search') {
				res.setHeader('Content-Type', 'application/json');
				res.end(
					JSON.stringify({
						results: [
							{
								title: 'First photo',
								url: 'http://public.example/publisher',
								img_src: 'http://public.example/image-one',
								thumbnail_src: 'http://public.example/thumb-one',
								resolution: '12x8',
							},
							{
								title: 'Second photo',
								url: 'http://public.example/publisher',
								img_src: 'http://public.example/image-two',
								thumbnail_src: 'http://public.example/thumb-two',
							},
						],
						unresponsive_engines: [['google images', 'CAPTCHA']],
					}),
				);
			} else if (url.pathname === '/private-redirect') {
				res.writeHead(302, { Location: 'http://127.0.0.1/secret' }).end();
			} else if (url.pathname === '/dns-redirect') {
				res.writeHead(302, { Location: 'http://private.example/secret' }).end();
			} else if (url.pathname === '/html') {
				res.setHeader('Content-Type', 'text/html');
				res.end('<h1>Not image pixels</h1>');
			} else if (url.pathname === '/svg') {
				res.setHeader('Content-Type', 'image/svg+xml');
				res.end('<svg></svg>');
			} else if (url.pathname === '/huge') {
				res
					.writeHead(200, {
						'Content-Type': 'image/png',
						'Content-Length': String(9 * 1024 * 1024),
					})
					.end();
			} else if (url.pathname === '/fake') {
				res.setHeader('Content-Type', 'image/png');
				res.end('Not a PNG');
			} else {
				res.setHeader('Content-Type', 'image/png');
				res.end(png);
			}
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		port = (server.address() as { port: number }).port;
		runtime = new WebRuntime({
			resolve: async (host) => [
				{ address: host === 'private.example' ? '10.0.0.1' : '8.8.8.8', family: 4 },
			],
			request: (url, options, callback) => {
				requests.push(url.pathname);
				return http.request(
					new URL(`${url.pathname}${url.search}`, `http://127.0.0.1:${port}`),
					{ ...options, lookup: undefined },
					callback,
				);
			},
		});
	});
	afterEach(async () => {
		runtime.close();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	it('search retains image metadata and diagnostics without downloading thumbnails or originals', async () => {
		const result = await execute('web.run', { image_query: [{ q: 'landscapes' }] });
		expect(result.isError).toBeUndefined();
		expect(result.content.every((part) => part.type === 'text')).toBe(true);
		expect(plain(result)).toContain('CAPTCHA');
		expect(plain(result)).not.toContain('data:image/');
		expect(requests).not.toContain('/image-one');
		expect(requests).not.toContain('/image-two');
		expect(result.research?.images).toHaveLength(2);
		expect(result.research?.images?.every((image) => !image.previewDataUrl)).toBe(true);
		expect(requests).not.toContain('/thumb-one');
		expect(requests).not.toContain('/thumb-two');
		expect(new Set(result.research?.images?.map((image) => image.id)).size).toBe(2);
	});
	it('views only the selected result and reuses its stable source ID', async () => {
		const search = await execute('web.run', { image_query: [{ q: 'landscapes' }] });
		const selected = search.research!.images![1];
		const result = await execute('image.view', { target: selected.id });
		expect(result.isError).toBeUndefined();
		expect(requests.filter((path) => path === '/image-two')).toHaveLength(1);
		expect(requests).not.toContain('/image-one');
		expect(result.content.filter((part) => part.type === 'image')).toHaveLength(1);
		expect(result.research?.images?.[0]).toMatchObject({
			id: selected.id,
			viewed: true,
			width: 12,
			height: 8,
		});
	});
	it('supports direct URLs but denies private, credentialed and non-HTTP targets before download', async () => {
		const direct = await execute('image.view', { target: 'http://public.example/image-one' });
		expect(direct.content.some((part) => part.type === 'image')).toBe(true);
		for (const target of [
			'http://127.1/secret',
			'http://private.example/secret',
			'https://user:pass@public.example/image',
			'file:///tmp/image.png',
			'data:image/png;base64,AA==',
		]) {
			const count = requests.length;
			expect((await execute('image.view', { target })).isError).toBe(true);
			expect(requests).toHaveLength(count);
		}
	});
	it('rechecks redirect destinations and rejects MIME mismatches and oversized downloads', async () => {
		for (const path of ['private-redirect', 'dns-redirect', 'html', 'svg', 'fake', 'huge']) {
			const result = await execute('image.view', { target: `http://public.example/${path}` });
			expect(result.isError, path).toBe(true);
			expect(
				result.content.some((part) => part.type === 'image'),
				path,
			).toBe(false);
		}
		expect(requests).not.toContain('/secret');
	});
	it('references cannot cross runs or conversation owners', async () => {
		const search = await execute('web.run', { image_query: [{ q: 'landscapes' }] });
		const id = search.research!.images![0].id;
		expect((await execute('image.view', { target: id }, 'other')).isError).toBe(true);
		expect((await execute('image.view', { target: id }, 'one', 'different-chat')).isError).toBe(
			true,
		);
		expect(requests).not.toContain('/image-one');
	});
	it('bounds decoded pixels before invoking the native codec', () => {
		expect(webImageDimensions(png, 'image/png')).toEqual({ width: 12, height: 8 });
		const huge = Buffer.from(png);
		huge.writeUInt32BE(8001, 16);
		expect(() => webImageDimensions(huge, 'image/png')).toThrow('megapixel');
		expect(() => webImageDimensions(png, 'image/jpeg')).toThrow('do not match');
	});
	it('publishes a selective inspection tool with explicit untrusted-content guidance', () => {
		expect(imageViewTool.name).toBe('image.view');
		expect(imageViewTool.parameters.required).toEqual(['target']);
		expect(webInstructions).toContain('never every search result automatically');
	});
});
