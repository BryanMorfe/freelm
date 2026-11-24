import { isIP } from 'node:net';
import type { WireResponse } from '../src/types';
import { validateAssetUrl } from './instance-client';
import { inspectAvif } from '../src/lib/avif';
import { publicWebAddress } from './tools/web';

const MAX_ASSET_BYTES = 32 * 1024 * 1024;

function isMetadataHost(hostname: string): boolean {
	const ip = hostname.replace(/^\[|\]$/g, '').toLowerCase();
	if (ip === '169.254.169.254' || ip === 'fd00:ec2::254') return true;
	if (isIP(ip) === 4) {
		const [a, b] = ip.split('.').map(Number);
		return a === 169 && b === 254;
	}
	if (isIP(ip) === 6) return ip.startsWith('fe80:') || ip.includes('::ffff:169.254.');
	return false;
}

/**
 * Guard against SSRF to cloud metadata or unrelated loopback/LAN hosts.
 * Same-origin media from a configured local/LAN provider remains allowed.
 */
export function assertSafeMediaAssetUrl(value: string, connectionBaseUrl?: string): URL {
	validateAssetUrl(value);
	const url = new URL(value);
	const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
	if (!host || isMetadataHost(host)) {
		throw new Error('This media URL points to a blocked network address.');
	}
	let sameConnectionOrigin = false;
	if (connectionBaseUrl) {
		try {
			sameConnectionOrigin = new URL(connectionBaseUrl).origin === url.origin;
		} catch {
			sameConnectionOrigin = false;
		}
	}
	if (!sameConnectionOrigin) {
		if (
			host === 'localhost' ||
			host.endsWith('.localhost') ||
			host.endsWith('.local') ||
			(isIP(host) !== 0 && !publicWebAddress(host))
		) {
			throw new Error('Remote media URLs cannot point to local or private network addresses.');
		}
	}
	return url;
}

export function detectSupportedMediaContentType(
	bytes: Buffer,
	rawContentType: string | null,
	kind?: 'image' | 'video',
): string | undefined {
	const contentType = (rawContentType || '').split(';')[0].trim().toLowerCase();
	const allowImage = !kind || kind === 'image';
	const allowVideo = !kind || kind === 'video';
	if (allowImage && /^image\/[a-z0-9.+-]+$/.test(contentType)) return contentType;
	if (allowVideo && /^video\/[a-z0-9.+-]+$/.test(contentType)) return contentType;
	if (allowVideo) {
		if (bytes.length >= 8 && bytes.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4';
		if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])))
			return 'video/webm';
	}
	if (allowImage) {
		if (
			bytes.length >= 8 &&
			bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
		)
			return 'image/png';
		if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
			return 'image/jpeg';
		if (
			bytes.length >= 12 &&
			bytes.toString('ascii', 0, 4) === 'RIFF' &&
			bytes.toString('ascii', 8, 12) === 'WEBP'
		)
			return 'image/webp';
		if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return 'image/gif';
		if (inspectAvif(bytes)) return 'image/avif';
	}
	return undefined;
}

export function downloadImageAsset(
	value: string,
	signal?: AbortSignal,
	connectionBaseUrl?: string,
): Promise<WireResponse> {
	return downloadMediaAsset(value, 'image', signal, connectionBaseUrl);
}

export function downloadVideoAsset(
	value: string,
	signal?: AbortSignal,
	connectionBaseUrl?: string,
): Promise<WireResponse> {
	return downloadMediaAsset(value, 'video', signal, connectionBaseUrl);
}

/** Resolve provider/CDN media without renderer CORS limits or provider credentials. */
async function downloadMediaAsset(
	value: string,
	kind: 'image' | 'video',
	signal?: AbortSignal,
	connectionBaseUrl?: string,
): Promise<WireResponse> {
	assertSafeMediaAssetUrl(value, connectionBaseUrl);
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
	const contentType = detectSupportedMediaContentType(
		bytes,
		response.headers.get('content-type'),
		kind,
	);
	if (!contentType) throw new Error(`The server did not return a supported ${kind}.`);
	return {
		status: response.status,
		contentType,
		encoding: 'base64',
		body: bytes.toString('base64'),
	};
}
