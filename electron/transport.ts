import type { WireRequest, WireResponse } from '../src/types';
import { createUtf8Decoder, decodeUtf8 } from '../src/lib/stream-decoder';
import { REQUEST_TIMEOUT_MS, requestDispatcher, type RequestOptions } from './request-policy';

const MAX_RESPONSE_BYTES = 256 * 1024 * 1024;
const MAX_STREAM_BYTES = 16 * 1024 * 1024;
const NETWORK_ERROR_CODES = new Set([
	'EACCES',
	'EPERM',
	'EHOSTUNREACH',
	'ENETUNREACH',
	'ECONNREFUSED',
	'ECONNRESET',
	'ETIMEDOUT',
	'ENOTFOUND',
	'EAI_AGAIN',
	'UND_ERR_CONNECT_TIMEOUT',
	'UND_ERR_HEADERS_TIMEOUT',
	'UND_ERR_BODY_TIMEOUT',
	'UND_ERR_SOCKET',
	'CERT_HAS_EXPIRED',
	'DEPTH_ZERO_SELF_SIGNED_CERT',
	'SELF_SIGNED_CERT_IN_CHAIN',
	'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
	'ERR_TLS_CERT_ALTNAME_INVALID',
]);

function connectionError(error: unknown, url: URL): Error {
	const codes = new Set<string>();
	const pending: unknown[] = [error];
	const visited = new Set<unknown>();
	// Node fetch nests errno inside cause; dual-stack attempts may use AggregateError.
	// Include only known codes, never underlying messages that may contain secrets.
	while (pending.length && visited.size < 20) {
		const item = pending.shift();
		if (!item || typeof item !== 'object' || visited.has(item)) continue;
		visited.add(item);
		const detail = item as { code?: unknown; cause?: unknown; errors?: unknown };
		if (typeof detail.code === 'string' && NETWORK_ERROR_CODES.has(detail.code))
			codes.add(detail.code);
		pending.push(detail.cause);
		if (Array.isArray(detail.errors)) pending.push(...detail.errors.slice(0, 20));
	}
	let guidance = 'Check the API address and network connection.';
	if (codes.has('ECONNREFUSED'))
		guidance = 'The server refused the connection. Check that the API is running on this port.';
	if (
		process.platform === 'darwin' &&
		['EACCES', 'EPERM', 'EHOSTUNREACH', 'ENETUNREACH'].some((code) => codes.has(code))
	)
		guidance +=
			' For a local server, macOS Local Network permission may also be blocking access. Check FreeLM in System Settings → Privacy & Security → Local Network.';
	return new Error(
		`Could not reach ${url.origin}${codes.size ? ` (${[...codes].join(', ')})` : ''}. ${guidance}`,
	);
}

/** Join an API-relative path without dropping proxy prefixes or duplicating /v1. */
export function apiUrl(baseUrl: string, path: string): URL {
	const url = new URL(baseUrl.trim());
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
		throw new Error('Use an HTTP or HTTPS API URL without embedded credentials.');
	}
	if (!path.startsWith('/') || path.startsWith('//') || /[\\?#]/.test(path)) {
		throw new Error('Invalid API path.');
	}
	const segments = path.split('/').map((segment) => decodeURIComponent(segment));
	if (segments.some((segment) => segment === '..' || segment === '.' || /[\\/]/.test(segment))) {
		throw new Error('Invalid API path.');
	}
	let prefix = url.pathname.replace(/\/+$/, '');
	// Accept either a host URL or an already versioned/proxied OpenAI base URL.
	if (!prefix) prefix = '/v1';
	url.pathname = `${prefix}${path}`;
	url.hash = '';
	return url;
}

/** Main-process HTTP transport: credentials never leave the configured origin. */
export async function performRequest(
	request: WireRequest,
	onChunk: (text: string) => void,
	signal?: AbortSignal,
): Promise<WireResponse> {
	if (request.providerAdapterRequired) throw new Error('This execution path does not support provider adapters.');
	const url = apiUrl(request.baseUrl, request.path);
	if (!['GET', 'POST'].includes(request.method)) throw new Error('Unsupported HTTP method.');
	const headers: Record<string, string> = {};
	if (request.apiKey.trim()) headers.Authorization = `Bearer ${request.apiKey.trim()}`;
	let body: BodyInit | undefined;
	if (request.form) {
		const form = new FormData();
		for (const field of request.form) {
			if (field.file) {
				form.append(
					field.name,
					new Blob([Buffer.from(field.file.base64, 'base64')], {
						type: field.file.type || 'application/octet-stream',
					}),
					field.file.name,
				);
			} else if (field.value !== undefined) form.append(field.name, field.value);
		}
		body = form;
	} else if (request.body) {
		headers['Content-Type'] = 'application/json';
		body = JSON.stringify(request.body);
	}
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
	let response: Response;
	try {
		const options: RequestOptions = {
			method: request.method,
			headers,
			body,
			signal: requestSignal,
			dispatcher: requestDispatcher,
			// Never forward bearer credentials to redirect targets; use the final base URL in settings.
			redirect: 'error',
		};
		response = await fetch(url, options);
	} catch (error) {
		if (requestSignal.aborted) throw requestSignal.reason;
		throw connectionError(error, url);
	}
	const contentType = response.headers.get('content-type') || 'application/octet-stream';
	const streaming = response.ok && request.stream && /text\/event-stream/i.test(contentType);
	const maxBytes = streaming ? MAX_STREAM_BYTES : MAX_RESPONSE_BYTES;
	if (Number(response.headers.get('content-length')) > maxBytes) {
		await response.body?.cancel();
		throw new Error(`The API response exceeds the ${maxBytes / 1024 / 1024} MB prototype limit.`);
	}
	const reader = response.body?.getReader();
	const chunks: Uint8Array[] = [];
	const decoder = createUtf8Decoder();
	let bytes = 0;
	let characters = 0;
	try {
		if (reader) {
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				bytes += value.byteLength;
				if (bytes > maxBytes)
					throw new Error(
						`The API response exceeds the ${maxBytes / 1024 / 1024} MB prototype limit.`,
					);
				if (streaming) {
					const text = decoder.push(value);
					if (text) {
						characters += text.length;
						onChunk(text);
					}
				} else chunks.push(value);
			}
			if (streaming) {
				const tail = decoder.finish();
				if (tail) {
					characters += tail.length;
					onChunk(tail);
				}
			}
		}
	} catch (error) {
		await reader?.cancel().catch(() => {});
		throw error;
	} finally {
		reader?.releaseLock();
	}
	if (streaming)
		return {
			status: response.status,
			contentType,
			body: '',
			encoding: 'text',
			stream: { bytes, characters },
		};
	const data = Buffer.concat(chunks);
	const text = /(?:json|text\/|xml|javascript)/i.test(contentType) || !response.ok;
	return {
		status: response.status,
		contentType,
		body: text ? decodeUtf8(data) : data.toString('base64'),
		encoding: text ? 'text' : 'base64',
	};
}
