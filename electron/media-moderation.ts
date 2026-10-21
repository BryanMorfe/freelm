import {
	MediaModerationGuard as PortableMediaModerationGuard,
	type ModerationAssetDownloader,
	type ModerationRequestExecutor,
	type ModerationState,
} from '../src/lib/media-moderation-guard';
import { downloadImageAsset, downloadVideoAsset } from './image-assets';
import { extractDesktopModerationVideoFrames } from './moderation-video-frames';
import type { ModerationVideoFrameExtractor } from '../src/lib/moderation-video-frames';
import { performRequest } from './transport';

export type {
	ModerationAssetDownloader,
	ModerationRequestExecutor,
	ModerationState,
} from '../src/lib/media-moderation-guard';
export class MediaModerationGuard extends PortableMediaModerationGuard {
	constructor(
		loadState: () => Promise<ModerationState>,
		execute: ModerationRequestExecutor = performRequest,
		download: ModerationAssetDownloader = (url, signal, kind) =>
			kind === 'video' ? downloadVideoAsset(url, signal) : downloadImageAsset(url, signal),
		extractFrames: ModerationVideoFrameExtractor = extractDesktopModerationVideoFrames,
	) {
		super(loadState, execute, download, extractFrames);
	}
}
