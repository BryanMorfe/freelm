import http, { type Server, type RequestOptions } from 'node:http';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebRuntime, extractWebPage, publicPageUrl, publicWebAddress } from '../electron/tools/web';
import { PdfProcessor } from '../electron/tools/pdf';
import type { ToolHostRequest, ToolResult } from '../src/agent-types';

const text = (result: ToolResult) =>
	result.content
		.filter((item) => item.type === 'text')
		.map((item) => item.text)
		.join('\n');
const parsed = (result: ToolResult) => JSON.parse(text(result));
const request = (
	args: Record<string, unknown>,
	overrides: Partial<ToolHostRequest> = {},
): ToolHostRequest => ({
	workspaceId: 'local',
	threadId: 'chat-one',
	runId: 'run-one',
	name: 'web.run',
	arguments: args,
	...overrides,
});

describe('public page URL validation', () => {
	it('blocks private, reserved, mapped and obfuscated addresses', () => {
		for (const address of [
			'0.0.0.0',
			'10.1.2.3',
			'127.0.0.1',
			'169.254.169.254',
			'172.16.2.1',
			'192.168.0.1',
			'100.64.1.1',
			'198.19.0.1',
			'192.0.2.1',
			'203.0.113.1',
			'224.0.0.1',
			'::1',
			'::',
			'fc00::1',
			'fe80::1',
			'::ffff:127.0.0.1',
			'::ffff:7f00:1',
			'::ffff:a00:1',
			'2001:db8::1',
			'2002:7f00:1::1',
		])
			expect(publicWebAddress(address), address).toBe(false);
		for (const url of [
			'http://localhost',
			'http://foo.localhost.',
			'http://printer.local',
			'http://127.1',
			'http://2130706433',
			'http://0x7f000001',
			'http://[::ffff:127.0.0.1]',
			'file:///etc/passwd',
			'https://user:pass@example.com',
		])
			expect(() => publicPageUrl(url), url).toThrow();
	});
	it('allows ordinary public IPv4 and IPv6 pages', () => {
		for (const address of [
			'8.8.8.8',
			'1.1.1.1',
			'192.0.78.13',
			'2606:4700:4700::1111',
			'2001:4860:4860::8888',
			'::ffff:8.8.8.8',
		])
			expect(publicWebAddress(address), address).toBe(true);
		expect(publicPageUrl('https://example.com/page#part').href).toBe('https://example.com/page');
	});
});

describe('parsed readable web pages', () => {
	it('decodes entities and handles malformed markup, main content, relative links and hidden elements', () => {
		const page = extractWebPage(
			'<title>A &amp; B</title><base href="/docs/"><body><nav>Navigation</nav><main><h1>Café 😀</h1><p>First &lt;tag&gt; <b>bold</b><p>Second <a href="next?q=1&amp;x=2">read me</a><script>secret()</script><div hidden>hidden</div><a href="javascript:alert(1)">bad</a><a href="http://127.0.0.1">local</a></main><footer>Copyright</footer>',
			new URL('https://public.example/start'),
			true,
		);
		expect(page.title).toBe('A & B');
		expect(page.lines.join('\n')).toContain('Café 😀');
		expect(page.lines.join('\n')).toContain('First <tag> bold');
		expect(page.lines.join('\n')).not.toMatch(/Navigation|secret|hidden|Copyright/);
		expect(page.links).toEqual([
			{ id: 1, title: 'read me', url: 'https://public.example/docs/next?q=1&x=2' },
		]);
	});
	it('keeps lines stable and marks bounded content', () => {
		const page = extractWebPage(
			'first\nsecond\n' + 'x'.repeat(130_000),
			new URL('https://public.example'),
			false,
		);
		expect(page.lines.slice(0, 2)).toEqual(['first', 'second']);
		expect(page.truncated).toBe(true);
		expect(page.lines.join('').length).toBeLessThanOrEqual(120_000);
	});
});

describe('SearXNG and read-only web runtime', () => {
	let server: Server;
	let port: number;
	let runtime: WebRuntime;
	let resolve: ReturnType<typeof vi.fn>;
	let observed: { url: string; options: RequestOptions }[];
	let healthBody: string;
	let healthContentType: string;
	let retryAttempts: number;
	const config = () => ({ enabled: true, searxngUrl: `http://127.0.0.1:${port}/proxy/` });
	const execute = (
		args: Record<string, unknown>,
		overrides: Partial<ToolHostRequest> = {},
		signal = new AbortController().signal,
	) => runtime.execute(request(args, overrides), config(), signal);
	beforeEach(async () => {
		observed = [];
		healthBody = 'OK';
		healthContentType = 'text/plain';
		retryAttempts = 0;
		server = http.createServer((req, res) => {
			const url = new URL(req.url ?? '/', 'http://fixture');
			if (url.pathname === '/proxy/config') {
				res.setHeader('Content-Type', 'application/json');
				res.end(
					JSON.stringify({
						version: 'fixture-1',
						categories: ['general', 'web', 'images'],
						engines: [
							{
								name: 'bing',
								enabled: true,
								categories: ['general', 'web'],
								paging: false,
								time_range_support: false,
								safesearch: false,
							},
							{
								name: 'google',
								enabled: false,
								categories: ['general', 'web'],
								paging: true,
								time_range_support: true,
								safesearch: true,
							},
							{
								name: 'brave',
								enabled: true,
								categories: ['general', 'web'],
								paging: true,
								time_range_support: true,
								safesearch: true,
							},
							{
								name: 'bing images',
								enabled: true,
								categories: ['images', 'web'],
								paging: true,
								time_range_support: true,
								safesearch: true,
							},
						],
					}),
				);
				return;
			}
			if (url.pathname === '/proxy/healthz') {
				res.setHeader('Content-Type', healthContentType);
				res.end(healthBody);
				return;
			}
			if (url.pathname === '/proxy/search') {
				if (url.searchParams.get('q') === 'retry-once') {
					res.setHeader('Content-Type', 'application/json');
					if (++retryAttempts === 1) {
						res.writeHead(503);
						res.end(JSON.stringify({ error: 'Temporary unavailability' }));
						return;
					}
					res.end(
						JSON.stringify({
							results: [{ title: 'Recovered source', url: 'http://public.example/recovered' }],
							unresponsive_engines: [],
						}),
					);
					return;
				}
				if (url.searchParams.get('q') === 'retry-cancel') {
					retryAttempts++;
					res.writeHead(503, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: 'Temporary unavailability' }));
					return;
				}
				if (url.searchParams.get('q') === 'error-json') {
					res.writeHead(400, { 'Content-Type': 'application/json' });
					res.end(
						JSON.stringify({ error: 'Invalid engine configuration supplied by the service.' }),
					);
					return;
				}
				if (url.searchParams.get('q') === 'missing-title') {
					res.setHeader('Content-Type', 'application/json');
					res.end(
						JSON.stringify({
							results: [
								{ url: 'http://public.example/no-title' },
								{ title: '   ', url: 'http://public.example/empty-title' },
								{ title: 'Citable', url: 'http://public.example/citable' },
							],
						}),
					);
					return;
				}
				if (url.searchParams.get('q') === '界'.repeat(1000)) {
					res.setHeader('Content-Type', 'application/json');
					res.end(JSON.stringify({ results: [], unresponsive_engines: [['google', 'CAPTCHA']] }));
					return;
				}
				if (url.searchParams.get('q') === '403') {
					res.writeHead(403).end();
					return;
				}
				if (url.searchParams.get('q') === 'html') {
					res.setHeader('Content-Type', 'text/html');
					res.end('<h1>SearXNG</h1>');
					return;
				}
				if (url.searchParams.get('q') === 'invalid') {
					res.setHeader('Content-Type', 'application/json');
					res.end('{"unexpected":[]}');
					return;
				}
				res.setHeader('Content-Type', 'application/json; charset=utf-8');
				if (url.searchParams.get('q') === 'native') {
					res.end(
						JSON.stringify({
							query: 'native effective',
							results: Array.from({ length: 30 }, (_, index) => ({
								title: `Result ${index}`,
								url: `http://public.example/native/${index}`,
								content: 'A fact',
								publishedDate: '2026-09-30T23:59:59Z',
								engine: 'bing',
								engines: ['bing', 'brave'],
							})),
							unresponsive_engines: [
								['google', 'CAPTCHA'],
								['yahoo', 'timeout'],
							],
							suggestions: ['suggestion'],
							corrections: ['correction'],
							answers: ['answer'],
							number_of_results: 1000000,
						}),
					);
					return;
				}
				if (url.searchParams.get('q') === 'dates') {
					res.end(
						JSON.stringify({
							results: [
								{
									title: 'First inclusive',
									url: 'http://public.example/start',
									publishedDate: '2026-09-01T00:00:00Z',
								},
								{
									title: 'Last inclusive',
									url: 'http://public.example/end',
									publishedDate: '2026-09-30T23:59:59.999Z',
								},
								{
									title: 'Old',
									url: 'http://public.example/old',
									publishedDate: '2026-08-31T23:59:59Z',
								},
								{ title: 'Unknown', url: 'http://public.example/unknown' },
								{
									title: 'Invalid',
									url: 'http://public.example/invalid',
									publishedDate: '2026-02-31',
								},
								{
									title: 'Later',
									url: 'http://public.example/later',
									publishedDate: '2026-10-01T00:00:00Z',
								},
							],
						}),
					);
					return;
				}
				if (url.searchParams.get('q') === 'recency') {
					res.end(
						JSON.stringify({
							results: [
								{
									title: 'Recent',
									url: 'http://public.example/recent',
									publishedDate: new Date(Date.now() - 86_400_000).toISOString(),
								},
								{
									title: 'Old',
									url: 'http://public.example/old',
									publishedDate: new Date(Date.now() - 60 * 86_400_000).toISOString(),
								},
								{ title: 'Unknown', url: 'http://public.example/unknown' },
							],
						}),
					);
					return;
				}
				if (url.searchParams.get('engines')?.includes('images')) {
					res.end(
						JSON.stringify({
							results: [
								{
									title: 'Photograph',
									url: 'http://public.example/photo-source',
									img_src: 'https://images.example/full.jpg',
									thumbnail_src: 'https://images.example/thumb.jpg',
									engines: ['bing images'],
								},
							],
							unresponsive_engines: [],
						}),
					);
					return;
				}
				res.end(
					JSON.stringify({
						results: [
							{
								title: 'Café &amp; docs',
								url: 'http://public.example/article',
								content: '<b>A source</b> 😀',
								publishedDate: '2026-09-30',
							},
							{ title: 'Other', url: 'http://other.example/page', content: 'Other source' },
							{ title: 'Private', url: 'http://127.0.0.1/secret' },
						],
						unresponsive_engines: [['engine', 'timeout']],
					}),
				);
				return;
			}
			if (url.pathname === '/redirect') {
				res.writeHead(302, { Location: '/article' }).end();
				return;
			}
			if (url.pathname === '/private-redirect') {
				res.writeHead(302, { Location: 'http://127.0.0.1/secret' }).end();
				return;
			}
			if (url.pathname === '/dns-redirect') {
				res.writeHead(302, { Location: 'http://private.example/secret' }).end();
				return;
			}
			if (url.pathname === '/loop') {
				res.writeHead(302, { Location: '/loop' }).end();
				return;
			}
			if (url.pathname === '/slow') {
				return;
			}
			if (url.pathname === '/binary') {
				res.setHeader('Content-Type', 'application/octet-stream');
				res.end('%PDF');
				return;
			}
			if (url.pathname === '/fixture.pdf') {
				res.setHeader('Content-Type', 'application/pdf');
				res.end('%PDF-1.4 fixture');
				return;
			}
			if (url.pathname === '/huge.pdf') {
				res.setHeader('Content-Type', 'application/pdf');
				res.setHeader('Content-Length', 33 * 1024 * 1024);
				res.end('x');
				return;
			}
			if (url.pathname === '/service-redirect/search') {
				res.writeHead(302, { Location: 'http://external.example/search' }).end();
				return;
			}
			if (url.pathname === '/invalid-utf8') {
				res.setHeader('Content-Type', 'text/plain; charset=utf-8');
				res.end(Buffer.from([0xff, 0xfe]));
				return;
			}
			if (url.pathname === '/compressed') {
				res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Encoding': 'gzip' });
				res.end(gzipSync('héllo\n😀'));
				return;
			}
			if (url.pathname === '/expanded') {
				res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Encoding': 'gzip' });
				res.end(gzipSync('x'.repeat(2 * 1024 * 1024 + 1)));
				return;
			}
			if (url.pathname === '/large') {
				res.setHeader('Content-Type', 'text/plain');
				res.setHeader('Content-Length', 5 * 1024 * 1024);
				res.end('x');
				return;
			}
			if (url.pathname === '/long') {
				res.setHeader('Content-Type', 'text/html');
				res.end(
					`<main>${('<p>' + '日本語😀'.repeat(500) + '</p>').repeat(20)}${'<a href="/long-link?'.concat('x'.repeat(1200), '">A link</a>').repeat(5)}</main>`,
				);
				return;
			}
			if (url.pathname === '/deep') {
				res.setHeader('Content-Type', 'text/html');
				res.end('<main>' + '<div>'.repeat(1000) + 'text' + '</div>'.repeat(1000) + '</main>');
				return;
			}
			res.setHeader('Content-Type', 'text/html; charset=utf-8');
			res.end(
				'<title>Fixture document</title><main><h1>Heading 😀</h1><p>A fact from Café.</p><p>Another fact.</p><a href="/next">Next source</a><a href="http://private.example/secret">Private DNS link</a></main>',
			);
		});
		await new Promise<void>((done, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', done);
		});
		port = (server.address() as { port: number }).port;
		resolve = vi.fn(async (hostname: string) => [
			{ address: hostname === 'private.example' ? '10.0.0.1' : '8.8.8.8', family: 4 },
		]);
		runtime = new WebRuntime({
			resolve,
			request: (url, options, callback) => {
				observed.push({ url: url.href, options });
				// Preserve production request options for assertions, but route the fixture to the loopback server.
				return http.request(
					new URL(`${url.pathname}${url.search}`, `http://127.0.0.1:${port}`),
					{ ...options, lookup: undefined, headers: options.headers },
					callback,
				);
			},
		});
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		runtime?.close();
		server.closeAllConnections();
		await new Promise<void>((done) => server.close(() => done()));
	});

	it('searches with JSON through a private configured service and returns bounded source metadata', async () => {
		const result = parsed(await execute({ search_query: [{ q: 'weather' }] }));
		expect(result.results[0].results).toHaveLength(2);
		expect(result.results[0].results[0]).toMatchObject({
			title: 'Café & docs',
			snippet: 'A source 😀',
			published_date: '2026-09-30',
		});
		expect(result.results[0].warning).toContain('incomplete');
		const url = new URL(observed[0].url);
		expect(url.pathname).toBe('/proxy/search');
		expect(url.searchParams.get('q')).toBe('weather');
		expect(url.searchParams.get('format')).toBe('json');
		expect(observed[0].options.headers).not.toHaveProperty('Authorization');
		expect(observed[0].options.headers).not.toHaveProperty('Cookie');
	});
	it('adds domain operators and enforces returned domain filtering', async () => {
		const result = parsed(
			await execute({ search_query: [{ q: 'docs', domains: ['public.example'] }] }),
		);
		expect(new URL(observed[0].url).searchParams.get('q')).toBe('docs (site:public.example)');
		expect(result.results[0].results).toHaveLength(1);
	});
	it('opens search references, returns numbered lines and links, finds text, and clicks relative links', async () => {
		const search = parsed(await execute({ search_query: [{ q: 'docs' }] }));
		const ref = search.results[0].results[0].ref_id;
		const opened = parsed(await execute({ open: [{ ref_id: ref }] })).results[0];
		expect(opened.content).toContain('L1: Heading 😀');
		expect(opened.links[0]).toMatchObject({ id: 1, url: 'http://public.example/next' });
		const matches = parsed(await execute({ find: [{ ref_id: opened.ref_id, pattern: 'CAFÉ' }] }))
			.results[0];
		expect(matches.matches).toEqual([{ lineno: 2, text: 'A fact from Café.' }]);
		const clicked = parsed(await execute({ click: [{ ref_id: opened.ref_id, id: 1 }] })).results[0];
		expect(clicked.url).toBe('http://public.example/next');
		const later = parsed(await execute({ open: [{ ref_id: opened.ref_id, lineno: 3 }] }))
			.results[0];
		expect(later.content).toMatch(/^L3:/);
	});
	it('pins vetted DNS resolution into connection lookup and does not resolve twice', async () => {
		resolve
			.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
			.mockResolvedValue([{ address: '10.0.0.1', family: 4 }]);
		const result = await execute({ open: [{ ref_id: 'http://public.example/article' }] });
		expect(result.isError).toBeUndefined();
		expect(resolve).toHaveBeenCalledTimes(1);
		const pinned = observed[0].options.lookup as Function;
		const callback = vi.fn();
		pinned('public.example', { all: false }, callback);
		expect(callback).toHaveBeenCalledWith(null, '8.8.8.8', 4);
		pinned('public.example', { all: true }, callback);
		expect(callback).toHaveBeenLastCalledWith(null, [{ address: '8.8.8.8', family: 4 }]);
	});
	it('allows relative public redirects while rejecting private and DNS-private redirect targets', async () => {
		const result = parsed(await execute({ open: [{ ref_id: 'http://public.example/redirect' }] }))
			.results[0];
		expect(result.url).toBe('http://public.example/article');
		for (const path of ['private-redirect', 'dns-redirect']) {
			const result = await execute({ open: [{ ref_id: `http://public.example/${path}` }] });
			expect(result.isError).toBe(true);
			expect(text(result)).toMatch(/private network|Local and private/);
		}
		expect(observed.some((item) => new URL(item.url).pathname === '/secret')).toBe(false);
	});
	it('rejects any DNS answer set containing a private address', async () => {
		resolve.mockResolvedValue([
			{ address: '8.8.8.8', family: 4 },
			{ address: '127.0.0.1', family: 4 },
		]);
		expect((await execute({ open: [{ ref_id: 'http://public.example/article' }] })).isError).toBe(
			true,
		);
		expect(observed).toHaveLength(0);
	});
	it('isolates refs across runs and conversations and clears them at cancellation', async () => {
		const ref = parsed(await execute({ open: [{ ref_id: 'http://public.example/article' }] }))
			.results[0].ref_id;
		const foreign = await execute({ open: [{ ref_id: ref }] }, { runId: 'other-run' });
		expect(foreign.isError).toBe(true);
		expect(text(foreign)).toContain('Unknown or expired');
		expect(
			text(await execute({ open: [{ ref_id: ref }] }, { threadId: 'foreign-chat' })),
		).toContain('do not belong');
		runtime.cancel('run-one');
		expect(text(await execute({ open: [{ ref_id: ref }] }))).toContain('Unknown or expired');
		const fresh = parsed(await execute({ open: [{ ref_id: 'http://public.example/article' }] }))
			.results[0].ref_id;
		expect(fresh).not.toBe(ref);
		runtime.close();
		expect(text(await execute({ search_query: [{ q: 'docs' }] }))).toContain('runtime has closed');
	});
	it('aborts active requests and pending DNS work without caching results', async () => {
		const controller = new AbortController();
		const pending = execute(
			{ open: [{ ref_id: 'http://public.example/slow' }] },
			{},
			controller.signal,
		);
		await vi.waitFor(() => expect(observed).toHaveLength(1));
		controller.abort();
		expect((await pending).isError).toBe(true);
		resolve.mockImplementation(() => new Promise(() => {}));
		const pendingDns = execute({ open: [{ ref_id: 'http://pending.example/page' }] });
		runtime.cancel('run-one');
		expect(text(await pendingDns)).toContain('cancelled');
	});
	it('limits argument batches and rejects unknown fields before network access', async () => {
		for (const args of [
			{},
			{ open: Array(5).fill({ ref_id: 'http://public.example' }) },
			{
				open: Array(4).fill({ ref_id: 'http://public.example' }),
				search_query: Array(4).fill({ q: 'x' }),
				find: [{ ref_id: 'x', pattern: 'x' }],
			},
			{ search_query: [{ q: 'x', authorization: 'secret' }] },
			{ search_query: [{ q: 'x', domains: ['example.com OR site:private'] }] },
			{ open: [{ ref_id: 'http://public.example', lineno: -1 }] },
		])
			expect((await execute(args)).isError).toBe(true);
		expect(observed).toHaveLength(0);
	});
	it('exposes actionable SearXNG JSON errors and rejects malformed search data', async () => {
		for (const query of ['403', 'html']) {
			const result = await execute({ search_query: [{ q: query }] });
			expect(result.isError).toBe(true);
			expect(text(result)).toContain('search.formats');
		}
		expect(text(await execute({ search_query: [{ q: 'invalid' }] }))).toContain('results array');
	});
	it('decodes compressed Unicode, reports decoding errors, and bounds compressed/plain downloads', async () => {
		expect(
			text(await execute({ open: [{ ref_id: 'http://public.example/compressed' }] })),
		).toContain('héllo');
		expect(
			text(await execute({ open: [{ ref_id: 'http://public.example/compressed' }] })),
		).toContain('😀');
		for (const [path, message] of [
			['invalid-utf8', 'could not be decoded'],
			['expanded', '2 MiB'],
			['large', '4 MiB'],
			['binary', 'not HTML, plain text, or a PDF'],
			['loop', 'redirected too many'],
		]) {
			const result = await execute({ open: [{ ref_id: `http://public.example/${path}` }] });
			expect(result.isError, path).toBe(true);
			expect(text(result), path).toContain(message);
		}
	});
	it('keeps aggregate tool output inside the byte budget even with multibyte page text', async () => {
		let heartbeats = 0;
		const heartbeat = setInterval(() => heartbeats++, 1);
		const result = await execute({
			open: [
				{ ref_id: 'http://public.example/long?a' },
				{ ref_id: 'http://public.example/long?b' },
				{ ref_id: 'http://public.example/long?c' },
				{ ref_id: 'http://public.example/long?d' },
			],
			response_length: 'long',
		});
		clearInterval(heartbeat);
		expect(result.isError).toBeUndefined();
		expect(heartbeats).toBeGreaterThan(0);
		expect(Buffer.byteLength(text(result), 'utf8')).toBeLessThanOrEqual(48 * 1024);
		expect(parsed(result).truncated).toBe(true);
	});
	it('rejects pathological nesting without recursive traversal or an uncaught exception', async () => {
		const result = await execute({ open: [{ ref_id: 'http://public.example/deep' }] });
		expect(result.isError).toBe(true);
		expect(text(result)).toContain('too much nested or complex HTML');
	});
	it('discovers version, capabilities and health without confusing it with upstream success', async () => {
		const info = await runtime.discover(config().searxngUrl, new AbortController().signal);
		expect(info).toMatchObject({
			serviceUrl: `http://127.0.0.1:${port}/proxy`,
			version: 'fixture-1',
			categories: ['general', 'web', 'images'],
			health: 'ok',
		});
		expect(info.engines.find((engine) => engine.name === 'google')).toMatchObject({
			enabled: false,
			paging: true,
			timeRangeSupport: true,
		});
		expect(info.notices.join(' ')).toContain('do not verify');
		expect(observed.map((item) => new URL(item.url).pathname)).toEqual([
			'/proxy/config',
			'/proxy/healthz',
		]);
	});
	it('does not treat a proxy HTML HTTP 200 page as the expected health response', async () => {
		healthBody = '<html><h1>Proxy login</h1></html>';
		healthContentType = 'text/html';
		const info = await runtime.discover(config().searxngUrl, new AbortController().signal);
		expect(info.health).toBe('unavailable');
		expect(info.notices.join(' ')).toContain('plain-text OK');
		expect(info.engines).toHaveLength(4);
	});
	it('maps native fields, accepts explicit disabled engines and preserves exact partial-engine diagnostics', async () => {
		const result = parsed(
			await execute({
				search_query: [
					{
						q: 'native',
						engines: ['google', 'bing'],
						page: 2,
						limit: 20,
						language: 'en-US',
						time_range: 'month',
						safesearch: 1,
						timeout_limit: 8.5,
					},
				],
			}),
		).results[0];
		const url = new URL(observed.at(-1)!.url);
		expect(url.searchParams.get('engines')).toBe('google,bing');
		expect(url.searchParams.has('categories')).toBe(false);
		expect(url.searchParams.get('pageno')).toBe('2');
		expect(url.searchParams.has('page')).toBe(false);
		expect(url.searchParams.has('limit')).toBe(false);
		for (const [key, value] of [
			['language', 'en-US'],
			['time_range', 'month'],
			['safesearch', '1'],
			['timeout_limit', '8.5'],
		])
			expect(url.searchParams.get(key)).toBe(value);
		expect(result.results).toHaveLength(20);
		expect(result.unresponsive_engines).toEqual([
			['google', 'CAPTCHA'],
			['yahoo', 'timeout'],
		]);
		expect(result.results[0]).toMatchObject({ engine: 'bing', engines: ['bing', 'brave'] });
		expect(result).toMatchObject({
			effective_query: 'native effective',
			suggestions: ['suggestion'],
			corrections: ['correction'],
			answers: ['answer'],
		});
		expect(result).not.toHaveProperty('has_more');
		expect(result).not.toHaveProperty('number_of_results');
		expect(result.notices.join(' ')).toContain('do not advertise paging');
	});
	it('uses general by default without config and validates requested engine/category names against cached discovery', async () => {
		await execute({ search_query: [{ q: 'docs' }] });
		expect(observed).toHaveLength(1);
		expect(new URL(observed[0].url).searchParams.get('categories')).toBe('general');
		for (let index = 0; index < 2; index++)
			await execute({ search_query: [{ q: 'docs', engines: ['google'] }] });
		expect(observed.filter((item) => new URL(item.url).pathname === '/proxy/config')).toHaveLength(
			1,
		);
		const count = observed.length;
		expect(text(await execute({ search_query: [{ q: 'docs', engines: ['invented'] }] }))).toContain(
			'Configured engines: bing, google, brave, bing images',
		);
		expect(
			text(await execute({ search_query: [{ q: 'docs', categories: ['science'] }] })),
		).toContain('Available categories: general, web, images');
		expect(observed).toHaveLength(count);
	});
	it('refreshes capability validation after the five-minute cache expires and rejects external service redirects', async () => {
		await execute({ search_query: [{ q: 'docs', engines: ['bing'] }] });
		const now = Date.now();
		vi.spyOn(Date, 'now').mockReturnValue(now + 301_000);
		await execute({ search_query: [{ q: 'docs', engines: ['bing'] }] });
		expect(observed.filter((item) => new URL(item.url).pathname === '/proxy/config')).toHaveLength(
			2,
		);
		const redirected = await runtime.execute(
			request({ search_query: [{ q: 'docs' }] }, { runId: 'redirected-service' }),
			{ enabled: true, searxngUrl: `http://127.0.0.1:${port}/service-redirect` },
			new AbortController().signal,
		);
		expect(redirected.isError).toBe(true);
		expect(text(redirected)).toContain('redirected to another origin');
		expect(observed.some((item) => item.url.includes('external.example'))).toBe(false);
	});
	it('preserves additive categories when explicitly requested and chooses only supported time engines automatically', async () => {
		const union = parsed(
			await execute({
				search_query: [{ q: 'docs', categories: ['general', 'web'], engines: ['google'] }],
			}),
		).results[0];
		const first = new URL(observed.at(-1)!.url);
		expect(first.searchParams.get('categories')).toBe('general,web');
		expect(first.searchParams.get('engines')).toBe('google');
		expect(union.notices.join(' ')).toContain('additively');
		await execute({ search_query: [{ q: 'docs', time_range: 'week' }] });
		const second = new URL(observed.at(-1)!.url);
		expect(second.searchParams.get('engines')).toBe('brave');
		expect(second.searchParams.has('categories')).toBe(false);
		const capabilities = parsed(
			await execute({
				search_query: [
					{
						q: 'docs',
						engines: ['brave'],
						categories: ['general'],
						page: 2,
						time_range: 'week',
						safesearch: 1,
					},
				],
			}),
		).results[0];
		expect(capabilities.notices.join(' ')).toContain('time-range support: bing');
		expect(capabilities.notices.join(' ')).toContain('paging: bing');
		expect(capabilities.notices.join(' ')).toContain('do not advertise safe-search support');
		expect(
			capabilities.config_available_engines.find(
				(engine: { name: string }) => engine.name === 'bing',
			),
		).toHaveProperty('safesearch', false);
	});
	it('enforces blocked domains after native operators instead of trusting search engine site hints', async () => {
		const result = parsed(
			await execute({ search_query: [{ q: 'docs', blocked_domains: ['other.example'] }] }),
		).results[0];
		expect(new URL(observed.at(-1)!.url).searchParams.get('q')).toBe('docs -site:other.example');
		expect(result.results.map((source: { url: string }) => source.url)).toEqual([
			'http://public.example/article',
		]);
	});
	it('filters inclusive provider-date boundaries strictly and excludes unknown and malformed dates with notices', async () => {
		const result = parsed(
			await execute({
				search_query: [{ q: 'dates', start_date: '2026-09-01', end_date: '2026-09-30' }],
			}),
		).results[0];
		expect(result.results.map((source: { title: string }) => source.title)).toEqual([
			'First inclusive',
			'Last inclusive',
		]);
		expect(result.notices.join(' ')).toContain('2 inspected results with missing or invalid');
		expect(result.notices.join(' ')).toContain('not independently verified');
		expect(result.notices.join(' ')).toContain('arXiv');
		const recent = parsed(await execute({ search_query: [{ q: 'recency', recency: 7 }] }))
			.results[0];
		expect(recent.results.map((source: { title: string }) => source.title)).toEqual(['Recent']);
		expect(new URL(observed.at(-1)!.url).searchParams.has('recency')).toBe(false);
	});
	it('returns image metadata without fetching thumbnails or full raster URLs', async () => {
		const result = parsed(await execute({ image_query: [{ q: 'bridge' }] })).results[0];
		const search = new URL(
			observed.find((request) => new URL(request.url).pathname === '/proxy/search')!.url,
		);
		expect(search.searchParams.get('engines')).toBe('bing images');
		expect(search.searchParams.has('categories')).toBe(false);
		expect(result.results[0]).toMatchObject({
			img_src: 'https://images.example/full.jpg',
			thumbnail_src: 'https://images.example/thumb.jpg',
			url: 'http://public.example/photo-source',
			engines: ['bing images'],
		});
		expect(observed.every((item) => !item.url.includes('images.example/full.jpg'))).toBe(true);
		expect(observed.some((item) => item.url.includes('images.example/thumb.jpg'))).toBe(false);
		expect(text(await execute({ image_query: [{ q: 'bridge', engines: ['google'] }] }))).toContain(
			'does not advertise image search',
		);
	});
	it('rejects invalid native fields, ranges and contradictory calendar dates before any network access', async () => {
		for (const args of [
			{ page: 0 },
			{ page: 11 },
			{ limit: 21 },
			{ safesearch: 3 },
			{ timeout_limit: 13 },
			{ timeout_limit: Infinity },
			{ time_range: 'decade' },
			{ recency: -1 },
			{ start_date: '2026-02-31' },
			{ start_date: '2026-10-01', end_date: '2026-09-01' },
			{ engines: ['bing,google'] },
			{ language: 'en&secret=1' },
		])
			expect((await execute({ search_query: [{ q: 'x', ...args }] })).isError).toBe(true);
		expect(observed).toHaveLength(0);
	});
	it('opens PDF pages, finds matches with page indexes, follows PDF links, and returns screenshot image content', async () => {
		const read = vi.spyOn(PdfProcessor.prototype, 'read').mockResolvedValue({
			title: 'PDF fixture',
			pages: [
				{
					lines: ['First page text'],
					links: [
						{ title: 'External', url: 'http://public.example/article' },
						{ title: 'Local', url: 'http://127.0.0.1/secret' },
					],
				},
				{ lines: ['Second page café'], links: [] },
			],
		});
		const screenshot = vi
			.spyOn(PdfProcessor.prototype, 'screenshot')
			.mockResolvedValue({ dataUrl: 'data:image/png;base64,iVBORw0KGgo=', name: 'page-2.png' });
		const opened = parsed(
			await execute({ open: [{ ref_id: 'http://public.example/fixture.pdf', pageno: 1 }] }),
		).results[0];
		expect(opened).toMatchObject({ pdf: true, pageno: 1, total_pages: 2 });
		expect(opened.content).toContain('L1: Second page café');
		expect(read).toHaveBeenCalledTimes(1);
		const found = parsed(await execute({ find: [{ ref_id: opened.ref_id, pattern: 'café' }] }))
			.results[0];
		expect(found.matches).toEqual([{ pageno: 1, lineno: 1, text: 'Second page café' }]);
		const first = parsed(await execute({ open: [{ ref_id: opened.ref_id, pageno: 0 }] }))
			.results[0];
		expect(first.links).toEqual([
			{ id: 1, title: 'External', url: 'http://public.example/article' },
		]);
		expect(
			parsed(await execute({ click: [{ ref_id: opened.ref_id, id: 1 }] })).results[0].url,
		).toBe('http://public.example/article');
		const image = await execute({ screenshot: [{ ref_id: opened.ref_id, pageno: 1 }] });
		expect(image.content.find((item) => item.type === 'image')).toMatchObject({
			dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
			name: 'page-2.png',
		});
		expect(screenshot).toHaveBeenCalledWith(
			expect.any(Uint8Array),
			'http://public.example/fixture.pdf',
			1,
			expect.any(AbortSignal),
		);
	});
	it('caps PDF downloads and per-run retention, clears cache on cancellation, and rejects invalid page indexes', async () => {
		const read = vi
			.spyOn(PdfProcessor.prototype, 'read')
			.mockResolvedValue({ title: 'PDF fixture', pages: [{ lines: ['Text'], links: [] }] });
		expect(text(await execute({ open: [{ ref_id: 'http://public.example/huge.pdf' }] }))).toContain(
			'32 MiB',
		);
		for (const id of ['a', 'b', 'c', 'a'])
			await execute({ open: [{ ref_id: `http://public.example/fixture.pdf?${id}` }] });
		expect(read).toHaveBeenCalledTimes(4);
		expect(
			text(await execute({ open: [{ ref_id: 'http://public.example/fixture.pdf?a', pageno: 2 }] })),
		).toContain('zero-based');
		runtime.cancel('run-one');
		await execute({ open: [{ ref_id: 'http://public.example/fixture.pdf?a' }] });
		expect(read).toHaveBeenCalledTimes(5);
		expect(
			text(await execute({ screenshot: [{ ref_id: 'http://public.example/article', pageno: 0 }] })),
		).toContain('PDF documents only');
	});
	it('guarantees the aggregate UTF-8 budget with eight empty-result Unicode queries while retaining CAPTCHA diagnostics', async () => {
		const q = '界'.repeat(1000);
		const result = await execute({
			search_query: Array.from({ length: 4 }, () => ({ q })),
			image_query: Array.from({ length: 4 }, () => ({ q })),
		});
		expect(result.isError).toBeUndefined();
		expect(Buffer.byteLength(text(result), 'utf8')).toBeLessThanOrEqual(48 * 1024);
		const output = parsed(result);
		expect(output.truncated).toBe(true);
		expect(output.results).toHaveLength(8);
		for (const operation of output.results)
			expect(operation.unresponsive_engines).toEqual([['google', 'CAPTCHA']]);
	});
	it('reports bounded native JSON status errors and only keeps usable citation titles', async () => {
		const error = await execute({ search_query: [{ q: 'error-json' }] });
		expect(error.isError).toBe(true);
		expect(text(error)).toContain('HTTP 400');
		expect(text(error)).toContain('Invalid engine configuration');
		const result = parsed(await execute({ search_query: [{ q: 'missing-title' }] })).results[0];
		expect(result.results.map((source: { title: string }) => source.title)).toEqual(['Citable']);
	});
	it('retries one transient service failure with a bounded backoff while preserving the exact native query', async () => {
		const start = Date.now();
		const result = parsed(await execute({ search_query: [{ q: 'retry-once' }] })).results[0];
		expect(result.results[0].title).toBe('Recovered source');
		expect(retryAttempts).toBe(2);
		expect(Date.now() - start).toBeGreaterThanOrEqual(240);
		expect(observed[0].url).toBe(observed[1].url);
	});
	it('cancels retry backoff promptly and never retries permanent status or invalid JSON failures', async () => {
		const controller = new AbortController();
		const pending = execute({ search_query: [{ q: 'retry-cancel' }] }, {}, controller.signal);
		await vi.waitFor(() => expect(retryAttempts).toBe(1));
		controller.abort();
		expect((await pending).isError).toBe(true);
		expect(retryAttempts).toBe(1);
		for (const q of ['error-json', '403', 'html']) {
			const count = observed.length;
			expect((await execute({ search_query: [{ q }] })).isError).toBe(true);
			expect(observed.length - count).toBe(1);
		}
		const count = observed.length;
		await execute({ search_query: [{ q: 'native' }] });
		expect(observed.length - count).toBe(1);
	});
});
