import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	extractBrowserModerationVideoFrames,
	moderationVideoTimestamps,
} from '../src/lib/moderation-video-frames';

afterEach(() => vi.unstubAllGlobals());

function decoderFixture() {
	const draws: number[] = [];
	class Video extends EventTarget {
		src = '';
		duration = 3.25;
		videoWidth = 64;
		videoHeight = 48;
		readyState = 2;
		position = 0;
		hang = false;
		failed = false;
		get currentTime() {
			return this.position;
		}
		set currentTime(value: number) {
			this.position = value;
			if (!this.hang)
				queueMicrotask(() => this.dispatchEvent(new Event(this.failed ? 'error' : 'seeked')));
		}
		pause = vi.fn();
		removeAttribute() {
			this.src = '';
		}
		load() {
			if (this.src && !this.hang) queueMicrotask(() => this.dispatchEvent(new Event('loadeddata')));
		}
	}
	const video = new Video();
	const canvas = {
		width: 0,
		height: 0,
		getContext: () => ({ drawImage: () => draws.push(video.currentTime) }),
		toDataURL: () => `data:image/png;base64,${btoa(`frame-${video.currentTime}`)}`,
	};
	vi.stubGlobal('document', { createElement: (tag: string) => (tag === 'video' ? video : canvas) });
	return { video, canvas, draws };
}

describe('video moderation sampling', () => {
	it.each([
		[0.1, [0]],
		[1, [0]],
		[1.01, [0, 1]],
		[3.25, [0, 1, 2, 3]],
		[15, Array.from({ length: 15 }, (_, i) => i)],
	])(
		'samples every second of a %s second clip without seeking past the end',
		(duration, frames) => {
			expect([...moderationVideoTimestamps(duration as number)]).toEqual(frames);
		},
	);
	it.each([0, -1, NaN, Infinity, 86401])(
		'rejects invalid duration %s instead of accepting partial coverage',
		(duration) => {
			expect(() => [...moderationVideoTimestamps(duration)]).toThrow(/finite, nonempty/);
		},
	);
	it('browser fallback seeks sequentially and frees its canvas/video when iteration stops early', async () => {
		const { video, canvas, draws } = decoderFixture();
		const frames = extractBrowserModerationVideoFrames('data:video/mp4;base64,AAAA');
		const seen: number[] = [];
		for await (const frame of frames) {
			seen.push(frame.timestamp);
			if (frame.timestamp === 1) break;
		}
		expect(seen).toEqual([0, 1]);
		expect(draws).toEqual([0, 1]);
		expect(video.pause).toHaveBeenCalledOnce();
		expect(video.src).toBe('');
		expect(canvas.width).toBe(0);
	});
	it('browser fallback aborts a pending seek and disposes the decoder', async () => {
		const { video } = decoderFixture();
		const controller = new AbortController();
		const frames = extractBrowserModerationVideoFrames(
			'data:video/mp4;base64,AAAA',
			controller.signal,
		)[Symbol.asyncIterator]();
		await frames.next();
		video.hang = true;
		const next = frames.next();
		controller.abort(new DOMException('Stopped', 'AbortError'));
		await expect(next).rejects.toThrow('Stopped');
		expect(video.pause).toHaveBeenCalledOnce();
		expect(video.src).toBe('');
	});
	it('browser fallback propagates a decoder error instead of accepting the preceding frames', async () => {
		const { video } = decoderFixture();
		const frames = extractBrowserModerationVideoFrames('data:video/mp4;base64,AAAA')[
			Symbol.asyncIterator
		]();
		await frames.next();
		video.failed = true;
		await expect(frames.next()).rejects.toThrow('could not be decoded');
		expect(video.pause).toHaveBeenCalledOnce();
	});
});
