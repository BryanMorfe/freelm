import {
	createModerationVideoFrameReader,
	moderationVideoTimestamps,
	type ModerationVideoFrameExtractor,
} from '../src/lib/moderation-video-frames';

// Electron retains sessions for the process lifetime. Reuse one isolated, nonpersistent
// partition instead of leaking a new session for each generated video.
const DECODER_PARTITION = `video-moderation-${crypto.randomUUID()}`;

/** Chromium ships with FreeLM on macOS/Linux; no system ffmpeg or renderer access is required. */
export const extractDesktopModerationVideoFrames: ModerationVideoFrameExtractor = async function* (
	video,
	signal,
) {
	signal?.throwIfAborted();
	const { app, BrowserWindow } = await import('electron');
	await app.whenReady();
	signal?.throwIfAborted();
	const window = new BrowserWindow({
		show: false,
		width: 32,
		height: 32,
		webPreferences: {
			sandbox: true,
			nodeIntegration: false,
			contextIsolation: true,
			webSecurity: true,
			backgroundThrottling: false,
			partition: DECODER_PARTITION,
		},
	});
	// This decoder cannot access provider URLs, cookies, the filesystem, or application bridges.
	const session = window.webContents.session;
	session.setPermissionCheckHandler(() => false);
	session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
	session.webRequest.onBeforeRequest(
		{ urls: ['http://*/*', 'https://*/*', 'file://*/*', 'ws://*/*', 'wss://*/*'] },
		(_details, callback) => callback({ cancel: true }),
	);
	window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
	window.webContents.on('will-navigate', (event) => event.preventDefault());
	const dispose = () => {
		if (!window.isDestroyed()) window.destroy();
	};
	signal?.addEventListener('abort', dispose, { once: true });
	try {
		await window.loadURL(
			'data:text/html;charset=utf-8,' +
				encodeURIComponent(
					"<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; media-src data:; script-src 'none'; connect-src 'none'\"><title>Video moderation decoder</title>",
				),
		);
		signal?.throwIfAborted();
		const duration: unknown = await window.webContents.executeJavaScript(
			`(async () => { window.__freelmVideoReader = await (${createModerationVideoFrameReader.toString()})(${JSON.stringify(video)}); return window.__freelmVideoReader.duration; })()`,
		);
		if (typeof duration !== 'number') throw new Error('The video decoder returned no duration.');
		for (const timestamp of moderationVideoTimestamps(duration)) {
			signal?.throwIfAborted();
			const image: unknown = await window.webContents.executeJavaScript(
				`window.__freelmVideoReader.frame(${timestamp})`,
			);
			signal?.throwIfAborted();
			if (typeof image !== 'string') throw new Error('The video decoder returned no image.');
			yield { timestamp, image };
		}
	} finally {
		signal?.removeEventListener('abort', dispose);
		dispose();
	}
};
