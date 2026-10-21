import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { PluginManifest } from '../../src/plugin-types';

type OAuth = Extract<PluginManifest['auth'], { type: 'oauth2' }>;
export interface PluginTokens {
	accessToken: string;
	refreshToken?: string;
	expiresAt?: number;
}
export class PluginFailure extends Error {
	constructor(
		message: string,
		readonly unauthorized = false,
	) {
		super(message);
		this.name = 'PluginError';
	}
}
export function safePluginError(error: unknown): string {
	return error instanceof PluginFailure
		? error.message
		: 'Plugin request failed. Check the service connection and try again. No credentials were exposed.';
}
/** No redirect can carry a bearer token, authorization code, or refresh token to another origin. */
export function guardedFetch(
	baseFetch: typeof fetch,
	allowedUrl: string,
	signal: AbortSignal,
	maxBytes = 12 * 1024 * 1024,
): typeof fetch {
	return async (input, init) => {
		const requested = input instanceof Request ? input.url : String(input);
		if (new URL(requested).href !== new URL(allowedUrl).href)
			throw new PluginFailure('Plugin attempted a request outside its configured endpoint.');
		const requestSignal = input instanceof Request ? input.signal : undefined;
		const abort = AbortSignal.any([
			signal,
			...(init?.signal ? [init.signal] : []),
			...(requestSignal ? [requestSignal] : []),
		]);
		abort.throwIfAborted();
		const response = await baseFetch(input, {
			...init,
			redirect: 'manual',
			credentials: 'omit',
			signal: abort,
		});
		if (response.status >= 300 && response.status < 400) {
			await response.body?.cancel().catch(() => {});
			throw new PluginFailure(
				'Plugin endpoint redirected the request. Update its manifest to the final endpoint before reconnecting.',
			);
		}
		if (Number(response.headers.get('content-length') || 0) > maxBytes) {
			await response.body?.cancel().catch(() => {});
			throw new PluginFailure('Plugin response exceeded its size limit.');
		}
		if (!response.body) return response;
		let bytes = 0;
		const body = response.body.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					bytes += chunk.byteLength;
					if (bytes > maxBytes) throw new PluginFailure('Plugin response exceeded its size limit.');
					controller.enqueue(chunk);
				},
			}),
		);
		return new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	};
}
export function validateTokens(value: unknown): PluginTokens {
	if (!value || typeof value !== 'object')
		throw new PluginFailure(
			'Stored plugin credentials are unavailable. Reconnect this account.',
			true,
		);
	const token = value as Partial<PluginTokens>;
	if (
		typeof token.accessToken !== 'string' ||
		!token.accessToken ||
		token.accessToken.length > 16_384 ||
		/[\s\u0000-\u001f\u007f]/.test(token.accessToken) ||
		(token.refreshToken !== undefined &&
			(typeof token.refreshToken !== 'string' ||
				!token.refreshToken ||
				token.refreshToken.length > 16_384 ||
				/[\u0000-\u001f\u007f]/.test(token.refreshToken))) ||
		(token.expiresAt !== undefined &&
			(typeof token.expiresAt !== 'number' ||
				!Number.isFinite(token.expiresAt) ||
				token.expiresAt < 0))
	)
		throw new PluginFailure('Stored plugin credentials are invalid. Reconnect this account.', true);
	return {
		accessToken: token.accessToken,
		...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
		...(token.expiresAt !== undefined ? { expiresAt: token.expiresAt } : {}),
	};
}
async function exchange(
	auth: OAuth,
	fields: Record<string, string>,
	fetcher: typeof fetch,
	signal: AbortSignal,
): Promise<PluginTokens> {
	const response = await guardedFetch(
		fetcher,
		auth.tokenUrl,
		signal,
		128_000,
	)(auth.tokenUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
		body: new URLSearchParams({
			...fields,
			client_id: auth.clientId,
			...(auth.resource ? { resource: auth.resource } : {}),
		}),
	});
	if (!response.ok) {
		await response.body?.cancel().catch(() => {});
		throw new PluginFailure(
			'Plugin authorization could not be renewed or completed. Reconnect this account.',
			true,
		);
	}
	if (!response.headers.get('content-type')?.toLowerCase().includes('application/json'))
		throw new PluginFailure('Plugin authorization returned an unsupported response.');
	const value = (await response.json()) as Record<string, unknown>;
	if (typeof value.token_type !== 'string' || value.token_type.toLowerCase() !== 'bearer')
		throw new PluginFailure('Plugin authorization must return a Bearer token.');
	if (value.resource !== undefined && value.resource !== auth.resource)
		throw new PluginFailure('Plugin authorization returned credentials for a different resource.');
	if (
		typeof value.scope === 'string' &&
		value.scope
			.split(/\s+/)
			.filter(Boolean)
			.some((scope) => !auth.scopes.includes(scope))
	)
		throw new PluginFailure(
			'Plugin authorization returned permissions outside the requested scopes.',
		);
	const expires = value.expires_in;
	if (
		expires !== undefined &&
		(typeof expires !== 'number' ||
			!Number.isFinite(expires) ||
			expires <= 0 ||
			expires > 365 * 24 * 3600)
	)
		throw new PluginFailure('Plugin authorization returned an invalid token expiry.');
	return validateTokens({
		accessToken: value.access_token,
		refreshToken: value.refresh_token,
		...(expires !== undefined ? { expiresAt: Date.now() + (expires as number) * 1000 } : {}),
	});
}
export async function connectOAuth(
	auth: OAuth,
	fetcher: typeof fetch,
	openExternal: (url: string) => Promise<void>,
	signal: AbortSignal,
): Promise<PluginTokens> {
	const verifier = randomBytes(48).toString('base64url');
	const state = randomBytes(32).toString('base64url');
	const callbackPath = '/oauth/callback';
	let resolveCode!: (code: string) => void;
	let rejectCode!: (error: Error) => void;
	const codePromise = new Promise<string>((resolve, reject) => {
		resolveCode = resolve;
		rejectCode = reject;
	});
	// Browser launch may itself fail; keep a rejection handler installed while setting up.
	void codePromise.catch(() => {});
	let callbackOrigin = '';
	const server = createServer((request, response) => {
		response.setHeader('Content-Type', 'text/plain; charset=utf-8');
		response.setHeader('Cache-Control', 'no-store');
		response.setHeader('Content-Security-Policy', "default-src 'none'");
		if (
			request.method !== 'GET' ||
			(request.url?.length ?? 0) > 8192 ||
			request.headers.host !== new URL(callbackOrigin).host
		) {
			response.writeHead(400).end('Invalid authorization callback.');
			return;
		}
		const url = new URL(request.url || '/', callbackOrigin);
		const incoming = url.searchParams.get('state') || '';
		const incomingBytes = Buffer.from(incoming);
		const stateBytes = Buffer.from(state);
		const matches =
			incomingBytes.length === stateBytes.length && timingSafeEqual(incomingBytes, stateBytes);
		if (
			url.pathname !== callbackPath ||
			!matches ||
			url.searchParams.getAll('state').length !== 1
		) {
			response.writeHead(400).end('Invalid authorization callback.');
			return;
		}
		if (url.searchParams.has('error')) {
			response.end('Authorization was declined. You can return to FreeLM.');
			rejectCode(new PluginFailure('Plugin authorization was declined.'));
			return;
		}
		const code = url.searchParams.get('code');
		if (!code || code.length > 4096 || url.searchParams.getAll('code').length !== 1) {
			response.writeHead(400).end('Missing authorization code.');
			return;
		}
		response.end(
			'Authorization received. Return to FreeLM to finish connecting. You can close this tab.',
		);
		resolveCode(code);
	});
	server.requestTimeout = 10_000;
	server.headersTimeout = 10_000;
	const abort = () =>
		rejectCode(new PluginFailure('Plugin connection was cancelled or timed out.'));
	signal.addEventListener('abort', abort, { once: true });
	try {
		signal.throwIfAborted();
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', () => {
				server.removeListener('error', reject);
				resolve();
			});
		});
		const address = server.address();
		if (!address || typeof address === 'string')
			throw new PluginFailure('Could not open a local authorization callback.');
		callbackOrigin = `http://127.0.0.1:${address.port}`;
		const redirectUri = `${callbackOrigin}${callbackPath}`;
		const url = new URL(auth.authorizationUrl);
		url.search = new URLSearchParams({
			response_type: 'code',
			client_id: auth.clientId,
			redirect_uri: redirectUri,
			state,
			code_challenge: createHash('sha256').update(verifier).digest('base64url'),
			code_challenge_method: 'S256',
			scope: auth.scopes.join(' '),
			...(auth.resource ? { resource: auth.resource } : {}),
		}).toString();
		signal.throwIfAborted();
		// Cancellation must also finish promptly if the OS browser launcher stalls.
		const code = await Promise.race([openExternal(url.href).then(() => codePromise), codePromise]);
		signal.throwIfAborted();
		return await exchange(
			auth,
			{
				grant_type: 'authorization_code',
				code,
				redirect_uri: redirectUri,
				code_verifier: verifier,
			},
			fetcher,
			signal,
		);
	} finally {
		signal.removeEventListener('abort', abort);
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}
export async function refreshOAuth(
	auth: OAuth,
	previous: PluginTokens,
	fetcher: typeof fetch,
	signal: AbortSignal,
): Promise<PluginTokens> {
	if (!previous.refreshToken)
		throw new PluginFailure('Plugin authorization expired. Reconnect this account.', true);
	const tokens = await exchange(
		auth,
		{ grant_type: 'refresh_token', refresh_token: previous.refreshToken },
		fetcher,
		signal,
	);
	return { ...tokens, refreshToken: tokens.refreshToken || previous.refreshToken };
}
export async function revokeOAuth(
	auth: OAuth,
	tokens: PluginTokens,
	fetcher: typeof fetch,
	signal: AbortSignal,
): Promise<void> {
	if (!auth.revocationUrl) return;
	const response = await guardedFetch(
		fetcher,
		auth.revocationUrl,
		signal,
		128_000,
	)(auth.revocationUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: auth.clientId,
			token: tokens.refreshToken || tokens.accessToken,
			token_type_hint: tokens.refreshToken ? 'refresh_token' : 'access_token',
		}),
	});
	await response.body?.cancel().catch(() => {});
}
