import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiUrl, performRequest } from '../electron/transport';
import type { WireRequest } from '../src/types';

const request: WireRequest = {
	id: 'test',
	baseUrl: 'http://127.0.0.1:9999/v1',
	apiKey: 'secret-test',
	path: '/responses',
	method: 'POST',
	body: { model: 'local', stream: true },
	stream: true,
};
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('main-process transport boundaries', () => {
	it('adds v1 to a host URL and preserves explicit proxy prefixes and queries', () => {
		expect(apiUrl('http://localhost:8000', '/models').toString()).toBe(
			'http://localhost:8000/v1/models',
		);
		expect(apiUrl('https://example.test/gateway/v1/?tenant=a#fragment', '/models').toString()).toBe(
			'https://example.test/gateway/v1/models?tenant=a',
		);
	});

	it.each(['file:///etc/passwd', 'ftp://example.test', 'https://user:pass@example.test'])(
		'rejects unsupported or credential-bearing base URL %s',
		(url) => {
			expect(() => apiUrl(url, '/models')).toThrow();
		},
	);

	it.each([
		'https://evil.test',
		'//evil.test',
		'/foo/../models',
		'/foo/%2e%2e/models',
		'/foo/%2fmodels',
		'/models?api_key=secret',
		'/foo\\bar',
	])('rejects unsafe request path %s', (path) => {
		expect(() => apiUrl(request.baseUrl, path)).toThrow();
	});

	it('streams UTF-8 chunks without corrupting text and refuses redirects', async () => {
		const bytes = new TextEncoder().encode('data: {"delta":"你好 😀 �"}\n\n');
		const mockFetch = vi.fn(
			async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
							controller.close();
						},
					}),
					{ headers: { 'content-type': 'text/event-stream' } },
				),
		);
		vi.stubGlobal('fetch', mockFetch);
		const chunks: string[] = [];
		expect(await performRequest(request, (text) => chunks.push(text))).toMatchObject({
			status: 200,
			body: '',
			encoding: 'text',
			stream: { bytes: bytes.length, characters: 'data: {"delta":"你好 😀 �"}\n\n'.length },
		});
		expect(chunks.join('')).toBe('data: {"delta":"你好 😀 �"}\n\n');
		expect(mockFetch.mock.calls[0]).toMatchObject([
			expect.any(URL),
			{
				redirect: 'error',
				headers: { Authorization: 'Bearer secret-test', 'Content-Type': 'application/json' },
			},
		]);
	});

	it('returns JSON errors rather than forwarding them as SSE', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response('{"error":{"message":"Unauthorized"}}', {
						status: 401,
						headers: { 'content-type': 'application/json' },
					}),
			),
		);
		const onChunk = vi.fn();
		expect(await performRequest(request, onChunk)).toMatchObject({
			status: 401,
			encoding: 'text',
			body: '{"error":{"message":"Unauthorized"}}',
		});
		expect(onChunk).not.toHaveBeenCalled();
	});

	it('rejects malformed stream bytes, preserves earlier chunks and cancels the reader safely', async () => {
		const cancel = vi.fn();
		const prefix = 'data: {"delta":"Already received"}\n\n';
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(new TextEncoder().encode(prefix));
								controller.enqueue(new Uint8Array([0xc3, 0x28]));
							},
							cancel,
						}),
						{ headers: { 'content-type': 'text/event-stream' } },
					),
			),
		);
		const chunks: string[] = [];
		const error = await performRequest(request, (text) => chunks.push(text)).catch(
			(error: Error) => error,
		);
		expect(error).toMatchObject({ name: 'ResponseDecodingError', kind: 'invalid-utf8' });
		expect((error as Error).message).toContain('invalid UTF-8');
		expect((error as Error).message).not.toContain('Already received');
		expect((error as Error).cause).toBeUndefined();
		expect(chunks).toEqual([prefix]);
		expect(cancel).toHaveBeenCalledOnce();
	});

	it('rejects a stream ending in a partial multi-byte character instead of inserting a replacement', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(new TextEncoder().encode('data: secret-response\n\n'));
								controller.enqueue(new Uint8Array([0xf0, 0x9f, 0x98]));
								controller.close();
							},
						}),
						{ headers: { 'content-type': 'text/event-stream' } },
					),
			),
		);
		const chunks: string[] = [];
		const error = await performRequest(request, (text) => chunks.push(text)).catch(
			(error: Error) => error,
		);
		expect(error).toMatchObject({ name: 'ResponseDecodingError', kind: 'incomplete-utf8' });
		expect((error as Error).message).toContain('incomplete UTF-8 character');
		expect((error as Error).message).not.toContain('secret-response');
		expect(chunks.join('')).not.toContain('�');
	});

	it.each([
		['malformed JSON response', 'application/json', 200, [0xff], 'invalid-utf8'],
		['truncated text response', 'text/plain', 200, [0xe2, 0x82], 'incomplete-utf8'],
		['malformed HTTP error', 'application/octet-stream', 502, [0xc0, 0xaf], 'invalid-utf8'],
	] as const)(
		'rejects invalid UTF-8 in a buffered %s without exposing its contents',
		async (_label, contentType, status, tail, kind) => {
			const body = Buffer.concat([Buffer.from('secret-buffered-response'), Buffer.from(tail)]);
			vi.stubGlobal(
				'fetch',
				vi.fn(async () => new Response(body, { status, headers: { 'content-type': contentType } })),
			);
			const error = await performRequest({ ...request, stream: false }, () => {}).catch(
				(error: Error) => error,
			);
			expect(error).toMatchObject({ name: 'ResponseDecodingError', kind });
			expect((error as Error).message).not.toContain('secret-buffered-response');
		},
	);

	it('constructs multipart uploads without overriding their boundary', async () => {
		const mockFetch = vi.fn(
			async (_url: string | URL | Request, _init?: RequestInit) =>
				new Response('{"text":"hi"}', { headers: { 'content-type': 'application/json' } }),
		);
		vi.stubGlobal('fetch', mockFetch);
		await performRequest(
			{
				...request,
				path: '/audio/transcriptions',
				body: undefined,
				form: [
					{ name: 'model', value: 'local' },
					{
						name: 'file',
						file: {
							name: 'recording.wav',
							type: 'audio/wav',
							base64: Buffer.from('audio').toString('base64'),
						},
					},
				],
			},
			() => {},
		);
		const init = mockFetch.mock.calls[0][1] as RequestInit;
		expect(init.headers).not.toHaveProperty('Content-Type');
		const form = init.body as FormData;
		expect(form.get('model')).toBe('local');
		const file = form.get('file') as File;
		expect(file.name).toBe('recording.wav');
		expect(file.type).toBe('audio/wav');
		expect(await file.text()).toBe('audio');
	});

	it('encodes binary media exactly for IPC', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(new Uint8Array([0, 255, 128, 12]), {
						headers: { 'content-type': 'audio/mpeg' },
					}),
			),
		);
		expect(
			await performRequest({ ...request, stream: false, path: '/audio/speech' }, () => {}),
		).toMatchObject({ encoding: 'base64', contentType: 'audio/mpeg', body: 'AP+ADA==' });
	});

	it('rejects oversized declared payloads before buffering them', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response('large', {
						headers: { 'content-type': 'audio/mpeg', 'content-length': String(300 * 1024 * 1024) },
					}),
			),
		);
		await expect(performRequest({ ...request, stream: false }, () => {})).rejects.toThrow('256 MB');
	});

	it('passes caller cancellation into fetch', async () => {
		const controller = new AbortController();
		const mockFetch = vi.fn(async (_url, init: RequestInit) => {
			await new Promise((_, reject) =>
				init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }),
			);
			return new Response('');
		});
		vi.stubGlobal('fetch', mockFetch);
		const pending = performRequest(request, () => {}, controller.signal);
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
	});

	it('reports safe origin and nested errno without exposing request secrets or raw errors', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockRejectedValue(
				new TypeError('fetch failed for secret-test', {
					cause: Object.assign(new Error('token=secret-query, body=secret-prompt'), {
						code: 'ECONNREFUSED',
					}),
				}),
			),
		);
		const error = await performRequest(
			{
				...request,
				baseUrl: 'http://192.168.0.221:8090/private-prefix/v1?token=secret-query',
				body: { input: 'secret-prompt' },
			},
			() => {},
		).catch((error: Error) => error);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe(
			'Could not reach http://192.168.0.221:8090 (ECONNREFUSED). The server refused the connection. Check that the API is running on this port.',
		);
		expect(JSON.stringify(error)).not.toContain('secret-');
		expect((error as Error).cause).toBeUndefined();
	});

	it.each(['darwin', 'linux'])(
		'reports aggregate network causes with platform-specific guidance on %s',
		async (platform) => {
			vi.spyOn(process, 'platform', 'get').mockReturnValue(platform as NodeJS.Platform);
			vi.stubGlobal(
				'fetch',
				vi.fn().mockRejectedValue(
					new TypeError('fetch failed', {
						cause: new AggregateError([
							{ code: 'EHOSTUNREACH' },
							{ code: 'ENETUNREACH' },
							{ code: 'EHOSTUNREACH' },
							{ code: 'secret-code' },
						]),
					}),
				),
			);
			const error = (await performRequest(request, () => {}).catch((error) => error)) as Error;
			expect(error.message).toContain('(EHOSTUNREACH, ENETUNREACH)');
			expect(error.message).not.toContain('secret-code');
			if (platform === 'darwin') {
				expect(error.message).toContain('permission may also be blocking access');
				expect(error.message).toContain('System Settings → Privacy & Security → Local Network');
			} else expect(error.message).not.toContain('macOS');
		},
	);

	it('keeps the thirty-minute cold-start deadline and preserves timeout errors', async () => {
		const timeout = new AbortController();
		const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url, init: RequestInit) => {
				await new Promise((_, reject) =>
					init.signal?.addEventListener('abort', () => reject(new TypeError('fetch failed')), {
						once: true,
					}),
				);
				return new Response('');
			}),
		);
		const pending = performRequest(request, () => {});
		const reason = new DOMException('Timed out waiting for the API.', 'TimeoutError');
		timeout.abort(reason);
		await expect(pending).rejects.toBe(reason);
		expect(timeoutSpy).toHaveBeenCalledWith(1_800_000);
	});
});

it('never sends an adapter request through the built-in transport', async () => {
 const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
 await expect(performRequest({ ...request, providerAdapterRequired: true }, () => {})).rejects.toThrow('does not support provider adapters');
 expect(fetcher).not.toHaveBeenCalled();
});
