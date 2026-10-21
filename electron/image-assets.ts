import type { WireResponse } from '../src/types';
import { validateAssetUrl } from './instance-client';
import { inspectAvif } from '../src/lib/avif';

const MAX_ASSET_BYTES = 32 * 1024 * 1024;

export function downloadImageAsset(value: string, signal?: AbortSignal): Promise<WireResponse> {
	return downloadMediaAsset(value, 'image', signal);
}

export function downloadVideoAsset(value: string, signal?: AbortSignal): Promise<WireResponse> {
	return downloadMediaAsset(value, 'video', signal);
}

/** Resolve provider/CDN media without renderer CORS limits or provider credentials. */
async function downloadMediaAsset(
	value: string,
	kind: 'image' | 'video',
	signal?: AbortSignal,
): Promise<WireResponse> {
	validateAssetUrl(value);
	const timeout = AbortSignal.timeout(120_000);
	const response = await fetch(value, {
		redirect: 'error',
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`Could not load this ${kind} (HTTP ${response.status}).`);
	}
	if (Number(response.headers.get('content-length')) > MAX_ASSET_BYTES) {
		await response.body?.cancel();
		throw new Error(`The ${kind} exceeds the 32 MB download limit.`);
	}
	const chunks: Uint8Array[] = [];
	let length = 0;
	const reader = response.body?.getReader();
	try {
		if (reader)
			while (true) {
				const { value: chunk, done } = await reader.read();
				if (done) break;
				length += chunk.byteLength;
				if (length > MAX_ASSET_BYTES)
					throw new Error(`The ${kind} exceeds the 32 MB download limit.`);
				chunks.push(chunk);
			}
	} catch (error) {
		await reader?.cancel().catch(() => {});
		throw error;
	} finally {
		reader?.releaseLock();
	}
	if (!length) throw new Error(`The ${kind} was empty.`);
	const bytes = Buffer.concat(chunks);
	let contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
	if (!(kind === 'image' ? /^image\/[a-z0-9.+-]+$/ : /^video\/[a-z0-9.+-]+$/).test(contentType)) {
		if (kind === 'video') {
			if (bytes.toString('ascii', 4, 8) === 'ftyp') contentType = 'video/mp4';
			else if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])))
				contentType = 'video/webm';
			else throw new Error('The server did not return a supported video.');
		} else {
			if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
				contentType = 'image/png';
			else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) contentType = 'image/jpeg';
			else if (
				bytes.toString('ascii', 0, 4) === 'RIFF' &&
				bytes.toString('ascii', 8, 12) === 'WEBP'
			)
				contentType = 'image/webp';
			else if (/^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) contentType = 'image/gif';
			else if (inspectAvif(bytes)) contentType = 'image/avif';
			else throw new Error('The server did not return a supported image.');
		}
	}
	return {
		status: response.status,
		contentType,
		encoding: 'base64',
		body: bytes.toString('base64'),
	};
}
