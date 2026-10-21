import type { Attachment, MediaAsset } from '../types';

const MAX_VIDEO_BYTES = 32 * 1024 * 1024;
const cancelled = () => new DOMException('Video loading cancelled.', 'AbortError');

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(cancelled());
	return new Promise((resolve, reject) => {
		const abort = () => reject(cancelled());
		signal.addEventListener('abort', abort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
	});
}

/** Resolve on demand; downloaded videos are transient, never copied into saved history. */
export async function resolveVideoAsset(
	asset: MediaAsset,
	workspaceId: string,
	connectionId: string,
	signal?: AbortSignal,
): Promise<Attachment> {
	if (signal?.aborted) throw cancelled();
	const embedded = /^data:(video\/[a-z0-9.+-]+);base64,/i.exec(asset.url);
	if (embedded) return { name: asset.name, type: embedded[1], dataUrl: asset.url };
	const url = new URL(asset.url);
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
		throw new Error('Use an HTTP or HTTPS video URL without embedded credentials.');
	if (window.desktop) {
		const result = await abortable(
			window.desktop.instanceAsset(workspaceId, connectionId, url.href, 'video'),
			signal,
		);
		if (signal?.aborted) throw cancelled();
		if (result.status < 200 || result.status >= 300)
			throw new Error(`Could not load this video (HTTP ${result.status}).`);
		const type = result.contentType.split(';')[0].trim().toLowerCase();
		if (result.encoding !== 'base64' || !/^video\/[a-z0-9.+-]+$/.test(type) || !result.body)
			throw new Error('The API did not return a supported video.');
		if (result.body.length > Math.ceil(MAX_VIDEO_BYTES / 3) * 4)
			throw new Error('The video exceeds the 32 MB download limit.');
		return { name: asset.name, type, dataUrl: `data:${type};base64,${result.body}` };
	}
	if (workspaceId !== 'local')
		throw new Error('Open the desktop app to load videos from this host.');
	const response = await fetch(url, { signal, redirect: 'error', credentials: 'omit' });
	if (!response.ok) throw new Error(`Could not load this video (HTTP ${response.status}).`);
	if (Number(response.headers.get('content-length')) > MAX_VIDEO_BYTES) {
		await response.body?.cancel();
		throw new Error('The video exceeds the 32 MB download limit.');
	}
	const chunks: Uint8Array[] = [];
	let length = 0;
	const reader = response.body?.getReader();
	try {
		if (reader)
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				length += value.byteLength;
				if (length > MAX_VIDEO_BYTES)
					throw new Error('The video exceeds the 32 MB download limit.');
				chunks.push(value);
			}
	} catch (error) {
		await reader?.cancel().catch(() => {});
		throw error;
	} finally {
		reader?.releaseLock();
	}
	const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || '';
	if (!/^video\/[a-z0-9.+-]+$/.test(type) || !length)
		throw new Error('The API did not return a supported video.');
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	let binary = '';
	for (let index = 0; index < bytes.length; index += 32768)
		binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
	return { name: asset.name, type, dataUrl: `data:${type};base64,${btoa(binary)}` };
}
