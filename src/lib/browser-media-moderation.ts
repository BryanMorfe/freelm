import { extractBrowserModerationVideoFrames } from './moderation-video-frames';
import type { AppState, WireRequest, WireResponse } from '../types';
import type { ModerationMediaKind } from '../moderation-types';
import { MediaModerationGuard, type ModerationRequestExecutor } from './media-moderation-guard';

export type BrowserMediaModerationContext = Pick<AppState, 'connections' | 'moderation'>;
type ContextLoader = () => BrowserMediaModerationContext | Promise<BrowserMediaModerationContext>;
let loadContext: ContextLoader | undefined;
let guard: MediaModerationGuard | undefined;
let guardExecutor: ModerationRequestExecutor | undefined;

/** The App registers its live selected-workspace state; API utility tests have no App context. */
export function setBrowserMediaModerationContext(loader?: ContextLoader): void {
	loadContext = loader;
	guard = undefined;
	guardExecutor = undefined;
}

const cancelled = () => new DOMException('Media moderation cancelled.', 'AbortError');
const MAX_ASSET_BYTES = 32 * 1024 * 1024;
function encodeBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += 32768)
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
	return btoa(binary);
}

/** Generated-media URLs are downloaded without API credentials, cookies, or redirects. */
export async function downloadBrowserModerationAsset(
	input: string,
	signal?: AbortSignal,
	kind?: ModerationMediaKind,
): Promise<WireResponse> {
	if (signal?.aborted) throw cancelled();
	const url = new URL(input);
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
		throw new Error('Generated media must use an HTTP(S) URL without embedded credentials.');
	url.hash = '';
	let response: Response;
	try {
		response = await fetch(url.href, {
			method: 'GET',
			credentials: 'omit',
			redirect: 'error',
			signal,
		});
	} catch (error) {
		if (signal?.aborted) throw cancelled();
		if (error instanceof TypeError)
			throw new Error(
				'Could not retrieve generated media for moderation. Browser preview requires media URL CORS support; use the desktop app if the provider does not allow browser downloads.',
			);
		throw error;
	}
	const contentType = response.headers.get('content-type') || 'application/octet-stream';
	if (
		response.ok &&
		kind &&
		!contentType.toLowerCase().startsWith(`${kind}/`) &&
		!/^application\/octet-stream(?:;|$)/i.test(contentType)
	) {
		await response.body?.cancel().catch(() => {});
		throw new Error(`Generated ${kind} URL returned an unsupported content type.`);
	}
	const declared = Number(response.headers.get('content-length'));
	const reader = response.body?.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		if (declared > MAX_ASSET_BYTES)
			throw new Error('Generated media exceeds the 32 MiB moderation limit.');
		if (reader) {
			for (;;) {
				if (signal?.aborted) throw cancelled();
				const { done, value } = await reader.read();
				if (done) break;
				length += value.byteLength;
				if (length > MAX_ASSET_BYTES)
					throw new Error('Generated media exceeds the 32 MiB moderation limit.');
				chunks.push(value);
			}
		}
	} catch (error) {
		await reader?.cancel().catch(() => {});
		throw error;
	} finally {
		reader?.releaseLock();
	}
	if (signal?.aborted) throw cancelled();
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	return {
		status: response.status,
		contentType,
		body: response.ok ? encodeBase64(bytes) : new TextDecoder().decode(bytes),
		encoding: response.ok ? 'base64' : 'text',
	};
}

/** Called only without a desktop bridge. The desktop host performs its own guard exactly once. */
export async function moderatedBrowserRequest(
	request: WireRequest,
	onChunk: (text: string) => void,
	signal: AbortSignal | undefined,
	execute: ModerationRequestExecutor,
): Promise<WireResponse> {
	// Without an App registration this is a low-level utility, not the actual preview UI.
	// Preserve standalone transport helper tests; registered Apps default to enabled/low.
	if (!loadContext) return await execute(request, onChunk, signal);
	if (!guard || guardExecutor !== execute) {
		guardExecutor = execute;
		guard = new MediaModerationGuard(
			async () => {
				if (!loadContext) throw new Error('Media moderation workspace is no longer available.');
				return await loadContext();
			},
			execute,
			downloadBrowserModerationAsset,
			extractBrowserModerationVideoFrames,
		);
	}
	return await guard.request(request, onChunk, signal);
}
