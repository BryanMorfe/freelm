/** Generated originals stay in FreeLM; only these bounded previews enter model context. */
export const GENERATED_IMAGE_CONTEXT_MAX_CHARS = 1024 * 1024;
export const GENERATED_IMAGE_CONTEXT_MAX_EDGE = 1536;
const CACHE_ENTRIES = 4;
const cache = new Map<string, string>();
const cancelled = () => new DOMException('Image preview cancelled.', 'AbortError');

function remember(source: string, preview: string): string {
	cache.set(source, preview);
	if (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
	return preview;
}

function checkAbort(signal?: AbortSignal): void {
	if (signal?.aborted) throw cancelled();
}

function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
	checkAbort(signal);
	if (!signal) return operation;
	return new Promise((resolve, reject) => {
		const abort = () => reject(cancelled());
		signal.addEventListener('abort', abort, { once: true });
		operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
	});
}

function loadImage(image: HTMLImageElement, dataUrl: string, signal?: AbortSignal): Promise<void> {
	checkAbort(signal);
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			clearTimeout(timeout);
			image.onload = image.onerror = null;
			signal?.removeEventListener('abort', abort);
		};
		const abort = () => {
			cleanup();
			image.src = '';
			reject(cancelled());
		};
		const timeout = setTimeout(() => {
			cleanup();
			image.src = '';
			reject(new Error('Generated image preview decoding timed out.'));
		}, 10000);
		image.onload = () => {
			cleanup();
			resolve();
		};
		image.onerror = () => {
			cleanup();
			reject(new Error('Generated image preview could not be decoded.'));
		};
		signal?.addEventListener('abort', abort, { once: true });
		image.src = dataUrl;
	});
}

function encode(
	canvas: HTMLCanvasElement,
	quality: number,
	type: string,
): Promise<Blob | undefined> {
	return new Promise((resolve) => {
		canvas.toBlob((blob) => resolve(blob?.type === type ? blob : undefined), type, quality);
	});
}

/** Undefined explicitly means the original is available, but no valid bounded preview was possible. */
export async function generatedImageContext(
	dataUrl: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	checkAbort(signal);
	if (!/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) return undefined;
	const cached = cache.get(dataUrl);
	if (cached) {
		cache.delete(dataUrl);
		cache.set(dataUrl, cached);
		return cached;
	}
	if (typeof Image !== 'function' || typeof document === 'undefined')
		return dataUrl.length <= GENERATED_IMAGE_CONTEXT_MAX_CHARS ? dataUrl : undefined;
	const image = new Image();
	let canvas: HTMLCanvasElement | undefined;
	try {
		await loadImage(image, dataUrl, signal);
		checkAbort(signal);
		if (
			!Number.isSafeInteger(image.naturalWidth) ||
			!Number.isSafeInteger(image.naturalHeight) ||
			image.naturalWidth <= 0 ||
			image.naturalHeight <= 0
		)
			return undefined;
		if (
			dataUrl.length <= GENERATED_IMAGE_CONTEXT_MAX_CHARS &&
			Math.max(image.naturalWidth, image.naturalHeight) <= GENERATED_IMAGE_CONTEXT_MAX_EDGE
		)
			return remember(dataUrl, dataUrl);
		canvas = document.createElement('canvas');
		const context = canvas.getContext('2d');
		if (!context) return undefined;
		let edge = GENERATED_IMAGE_CONTEXT_MAX_EDGE;
		let format = 'image/webp';
		for (let attempt = 0; attempt < 8; attempt++, edge = Math.floor(edge * 0.75)) {
			checkAbort(signal);
			const scale = Math.min(1, edge / Math.max(image.naturalWidth, image.naturalHeight));
			canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
			canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
			context.clearRect(0, 0, canvas.width, canvas.height);
			if (format === 'image/jpeg') {
				context.fillStyle = '#fff';
				context.fillRect(0, 0, canvas.width, canvas.height);
			}
			context.drawImage(image, 0, 0, canvas.width, canvas.height);
			for (const quality of [0.85, 0.7, 0.55]) {
				let blob = await abortable(encode(canvas, quality, format), signal);
				if (!blob && format === 'image/webp') {
					// Older runtimes may lack WebP encoding. Its JPEG fallback uses a white matte.
					format = 'image/jpeg';
					context.fillStyle = '#fff';
					context.fillRect(0, 0, canvas.width, canvas.height);
					context.drawImage(image, 0, 0, canvas.width, canvas.height);
					blob = await abortable(encode(canvas, quality, format), signal);
				}
				checkAbort(signal);
				if (!blob) return undefined;
				if (Math.ceil(blob.size / 3) * 4 + 23 > GENERATED_IMAGE_CONTEXT_MAX_CHARS) continue;
				const bytes = new Uint8Array(await abortable(blob.arrayBuffer(), signal));
				checkAbort(signal);
				let binary = '';
				for (let offset = 0; offset < bytes.length; offset += 32768)
					binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
				const preview = `data:${format};base64,${btoa(binary)}`;
				if (preview.length > GENERATED_IMAGE_CONTEXT_MAX_CHARS) continue;
				return remember(dataUrl, preview);
			}
		}
		return undefined;
	} catch (error) {
		checkAbort(signal);
		if (error instanceof Error && error.name === 'AbortError') throw error;
		return undefined;
	} finally {
		image.onload = image.onerror = null;
		image.src = '';
		if (canvas) canvas.width = canvas.height = 0;
	}
}
