/** Only these visual samples are classified; audio and content between samples are not inspected. */
export interface ModerationVideoFrame {
	timestamp: number;
	image: string;
}
export type ModerationVideoFrameExtractor = (
	video: string,
	signal?: AbortSignal,
) => AsyncIterable<ModerationVideoFrame>;

/** Include the initial frame and every integer second before the end, including short clips. */
export function* moderationVideoTimestamps(duration: number): Generator<number> {
	if (!Number.isFinite(duration) || duration <= 0 || duration > 24 * 60 * 60)
		throw new Error('Video moderation requires a finite, nonempty video no longer than 24 hours.');
	for (let timestamp = 0; timestamp < duration; timestamp++) yield timestamp;
}

export interface ModerationVideoFrameReader {
	duration: number;
	frame(timestamp: number): Promise<string>;
	dispose(): void;
}

/**
 * Self-contained so Electron can run this same decoder inside a disposable sandboxed renderer.
 * No network URLs are accepted, and only one decoded frame is retained at a time.
 */
export async function createModerationVideoFrameReader(
	videoData: string,
	signal?: AbortSignal,
): Promise<ModerationVideoFrameReader> {
	if (!/^data:video\/(?:mp4|webm);base64,[A-Za-z0-9+/]*={0,2}$/.test(videoData))
		throw new Error('Video frame extraction requires an inline MP4 or WebM snapshot.');
	signal?.throwIfAborted();
	const video = document.createElement('video');
	video.preload = 'auto';
	video.muted = true;
	video.playsInline = true;
	const canvas = document.createElement('canvas');
	const context = canvas.getContext('2d');
	if (!context) throw new Error('The video frame decoder could not create a canvas.');
	let disposed = false;
	const dispose = () => {
		if (disposed) return;
		disposed = true;
		video.pause();
		video.removeAttribute('src');
		video.load();
		canvas.width = canvas.height = 0;
	};
	function waitFor(event: 'loadeddata' | 'seeked', start: () => void): Promise<void> {
		return new Promise((resolve, reject) => {
			const cleanup = () => {
				clearTimeout(timer);
				video.removeEventListener(event, ready);
				video.removeEventListener('error', failure);
				signal?.removeEventListener('abort', cancel);
			};
			const ready = () => {
				cleanup();
				resolve();
			};
			const failure = () => {
				cleanup();
				reject(new Error('The video codec or container could not be decoded for moderation.'));
			};
			const cancel = () => {
				cleanup();
				reject(signal?.reason ?? new DOMException('Video moderation cancelled.', 'AbortError'));
			};
			const timer = setTimeout(() => {
				cleanup();
				reject(new Error('Video frame decoding timed out.'));
			}, 30_000);
			video.addEventListener(event, ready, { once: true });
			video.addEventListener('error', failure, { once: true });
			signal?.addEventListener('abort', cancel, { once: true });
			try {
				signal?.throwIfAborted();
				if (disposed) throw new Error('The video frame decoder has been closed.');
				start();
			} catch (error) {
				cleanup();
				reject(error);
			}
		});
	}
	try {
		await waitFor('loadeddata', () => {
			video.src = videoData;
			video.load();
		});
		const duration = video.duration;
		if (!Number.isFinite(duration) || duration <= 0 || duration > 24 * 60 * 60)
			throw new Error(
				'Video moderation requires a finite, nonempty video no longer than 24 hours.',
			);
		if (
			!video.videoWidth ||
			!video.videoHeight ||
			video.videoWidth * video.videoHeight > 32 * 1024 * 1024
		)
			throw new Error('Video dimensions exceed the 32 megapixel frame decoding limit.');
		canvas.width = video.videoWidth;
		canvas.height = video.videoHeight;
		return {
			duration,
			async frame(timestamp) {
				signal?.throwIfAborted();
				if (disposed) throw new Error('The video frame decoder has been closed.');
				if (!Number.isInteger(timestamp) || timestamp < 0 || timestamp >= duration)
					throw new Error('The requested video frame is outside the sampled duration.');
				if (video.currentTime !== timestamp)
					await waitFor('seeked', () => {
						video.currentTime = timestamp;
					});
				signal?.throwIfAborted();
				if (video.readyState < 2 || Math.abs(video.currentTime - timestamp) > 0.01)
					throw new Error('The requested video frame was not decoded completely.');
				context!.drawImage(video, 0, 0, canvas.width, canvas.height);
				const image = canvas.toDataURL('image/png');
				if (
					!image.startsWith('data:image/png;base64,') ||
					image.length > Math.ceil((32 * 1024 * 1024) / 3) * 4 + 32
				)
					throw new Error('The decoded video frame exceeds the 32 MiB image limit.');
				return image;
			},
			dispose,
		};
	} catch (error) {
		dispose();
		throw error;
	}
}

export const extractBrowserModerationVideoFrames: ModerationVideoFrameExtractor = async function* (
	video,
	signal,
) {
	const reader = await createModerationVideoFrameReader(video, signal);
	try {
		for (const timestamp of moderationVideoTimestamps(reader.duration)) {
			signal?.throwIfAborted();
			yield { timestamp, image: await reader.frame(timestamp) };
		}
	} finally {
		reader.dispose();
	}
};
