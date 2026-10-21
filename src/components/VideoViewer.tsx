import { userFacingError } from '../lib/user-facing-error';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import {
	ChevronLeft,
	ChevronRight,
	Download,
	Expand,
	LoaderCircle,
	RotateCcw,
	VideoOff,
	X,
} from 'lucide-react';
import type { Attachment, MediaAsset } from '../types';
import ModerationNotice from './ModerationNotice';
import { resolveVideoAsset } from '../lib/video-assets';
import './video-viewer.css';

export interface VideoViewerProps {
	asset: MediaAsset;
	selectionKey: string;
	workspaceId: string;
	connectionId: string;
	prompt: string;
	modelLabel: string;
	moderationWarnings?: string[];
	index: number;
	total: number;
	onClose: () => void;
	onPrevious: () => void;
	onNext: () => void;
	onReuse: () => void;
}
interface LoadedVideo {
	identity: string;
	url: string;
	name: string;
	source: Attachment | null;
	error: string;
}
const focusableSelector = 'button:not([disabled]), a[href], video[controls], [tabindex="0"]';

function playbackError(video: HTMLVideoElement): string {
	switch (video.error?.code) {
		case MediaError.MEDIA_ERR_NETWORK:
			return 'The video could not be loaded for playback. Try loading it again.';
		case MediaError.MEDIA_ERR_DECODE:
			return 'This video could not be decoded. Try loading it again, or download it to open in another player.';
		default:
			return 'This video cannot be played here. Its format or codec may be unsupported. You can download it to open in another player.';
	}
}
function durationLabel(duration: number): string {
	if (!Number.isFinite(duration) || duration < 0) return '';
	const minutes = Math.floor(duration / 60);
	return `${minutes}:${String(Math.floor(duration % 60)).padStart(2, '0')}`;
}

export default function VideoViewer(p: VideoViewerProps) {
	const [loaded, setLoaded] = useState<LoadedVideo | null>(null);
	const [retry, setRetry] = useState(0);
	const [playError, setPlayError] = useState('');
	const [dimensions, setDimensions] = useState({ width: 0, height: 0, duration: 0 });
	const [fullscreen, setFullscreen] = useState(false);
	const [poster, setPoster] = useState('');
	const dialog = useRef<HTMLDivElement>(null);
	const player = useRef<HTMLVideoElement | null>(null);
	const close = useRef<HTMLButtonElement>(null);
	const expand = useRef<HTMLButtonElement>(null);
	const fullscreenClose = useRef<HTMLButtonElement>(null);
	const wasFullscreen = useRef(false);
	const latest = useRef(p);
	latest.current = p;
	const identity = JSON.stringify([p.workspaceId, p.connectionId, p.selectionKey, retry]);
	const current =
		loaded?.identity === identity && loaded.url === p.asset.url && loaded.name === p.asset.name
			? loaded
			: null;
	const source = current?.source ?? null;
	const loading = !current;
	const error = current?.error || (current ? playError : '');
	const fullscreenVisible = fullscreen && !!source && !error;
	const aspectRatio =
		dimensions.width > 0 && dimensions.height > 0 ? dimensions.width / dimensions.height : 16 / 9;

	// Keep one media element across presentation changes. Dispose it explicitly on
	// navigation and close so detached players never continue producing audio.
	const attachPlayer = useCallback((element: HTMLVideoElement | null) => {
		const previous = player.current;
		if (previous && previous !== element) {
			previous.pause();
			// StrictMode briefly detaches and reattaches the same ref without
			// recreating the element. Release its source only after a real removal.
			queueMicrotask(() => {
				if (player.current !== previous && !previous.isConnected) {
					previous.removeAttribute('src');
					previous.load();
				}
			});
		}
		player.current = element;
	}, []);
	function closeViewer() {
		player.current?.pause();
		latest.current.onClose();
	}
	function capturePoster() {
		const video = player.current;
		if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return '';
		try {
			const canvas = document.createElement('canvas');
			const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
			canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
			canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
			const context = canvas.getContext('2d');
			if (!context) return '';
			context.drawImage(video, 0, 0, canvas.width, canvas.height);
			return canvas.toDataURL('image/jpeg', 0.7);
		} catch {
			// Some codecs or cross-origin sources cannot be drawn; the dark backdrop remains.
			return '';
		}
	}
	function enterFullscreen() {
		if (!source || error || !dimensions.width) return;
		setPoster(capturePoster());
		setFullscreen(true);
	}
	function doubleClickVideo(event: MouseEvent<HTMLVideoElement>) {
		const video = event.currentTarget;
		const bounds = video.getBoundingClientRect();
		// Native control events are retargeted to the video element. Leave the
		// controls' lower strip alone, including when the page is display-scaled.
		const displayScale = video.clientHeight ? bounds.height / video.clientHeight : 1;
		if (event.clientY >= bounds.bottom - 56 * displayScale) return;
		event.preventDefault();
		if (!fullscreenVisible) enterFullscreen();
	}

	useEffect(() => {
		const pending = new AbortController();
		setLoaded(null);
		setPlayError('');
		setFullscreen(false);
		setPoster('');
		setDimensions({ width: 0, height: 0, duration: 0 });
		void resolveVideoAsset(p.asset, p.workspaceId, p.connectionId, pending.signal)
			.then((attachment) => {
				if (!pending.signal.aborted)
					setLoaded({
						identity,
						url: p.asset.url,
						name: p.asset.name,
						source: attachment,
						error: '',
					});
			})
			.catch((failure: unknown) => {
				if (!pending.signal.aborted)
					setLoaded({
						identity,
						url: p.asset.url,
						name: p.asset.name,
						source: null,
						error: failure instanceof Error ? failure.message : 'Could not load this video.',
					});
			});
		return () => pending.abort();
	}, [identity, p.asset.url, p.asset.name, p.workspaceId, p.connectionId]);

	useEffect(() => {
		const previous = document.activeElement as HTMLElement | null;
		const overflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		close.current?.focus();
		function keydown(event: KeyboardEvent) {
			if (event.defaultPrevented) return;
			if (event.key === 'Escape') {
				event.preventDefault();
				if (fullscreenClose.current) setFullscreen(false);
				else closeViewer();
				return;
			}
			if (event.key !== 'Tab') return;
			const elements = Array.from(
				dialog.current?.querySelectorAll<HTMLElement>(focusableSelector) || [],
			).filter((element) => element.getClientRects().length && !element.closest('[inert]'));
			const first = elements[0],
				last = elements.at(-1);
			if (!first) {
				event.preventDefault();
				dialog.current?.focus();
			} else if (
				event.shiftKey &&
				(document.activeElement === first ||
					!elements.includes(document.activeElement as HTMLElement))
			) {
				event.preventDefault();
				last?.focus();
			} else if (
				!event.shiftKey &&
				(document.activeElement === last ||
					!elements.includes(document.activeElement as HTMLElement))
			) {
				event.preventDefault();
				first.focus();
			}
		}
		function focusin(event: FocusEvent) {
			if (event.target instanceof Node && !dialog.current?.contains(event.target))
				(fullscreenClose.current || close.current)?.focus();
		}
		document.addEventListener('keydown', keydown);
		document.addEventListener('focusin', focusin);
		return () => {
			document.removeEventListener('keydown', keydown);
			document.removeEventListener('focusin', focusin);
			document.body.style.overflow = overflow;
			if (previous?.isConnected) previous.focus({ preventScroll: true });
		};
	}, []);

	useLayoutEffect(() => {
		if (fullscreenVisible) fullscreenClose.current?.focus({ preventScroll: true });
		else if (wasFullscreen.current)
			(expand.current || close.current)?.focus({ preventScroll: true });
		wasFullscreen.current = fullscreenVisible;
	}, [fullscreenVisible]);

	return createPortal(
		<div
			className={`video-viewer ${window.desktop?.platform === 'darwin' ? 'video-viewer-mac' : ''} ${fullscreenVisible ? 'video-viewer-fullscreen' : ''}`}
			role="dialog"
			aria-modal="true"
			aria-label={fullscreenVisible ? 'Full screen video' : 'Video viewer'}
			ref={dialog}
			tabIndex={-1}
		>
			<header
				className="video-viewer-header"
				inert={fullscreenVisible}
				aria-hidden={fullscreenVisible || undefined}
			>
				<div className="video-viewer-navigation">
					<button
						className="video-viewer-icon"
						aria-label="Previous video"
						title="Previous video"
						disabled={p.index <= 0}
						onClick={() => {
							player.current?.pause();
							p.onPrevious();
						}}
					>
						<ChevronLeft size={20} />
					</button>
					<span>
						{p.index + 1} <span>/ {p.total}</span>
					</span>
					<button
						className="video-viewer-icon"
						aria-label="Next video"
						title="Next video"
						disabled={p.index >= p.total - 1}
						onClick={() => {
							player.current?.pause();
							p.onNext();
						}}
					>
						<ChevronRight size={20} />
					</button>
				</div>
				<div className="video-viewer-actions">
					{source ? (
						<a
							className="video-viewer-icon"
							href={source.dataUrl}
							download={p.asset.name}
							aria-label="Download video"
							title="Download video"
						>
							<Download size={19} />
						</a>
					) : (
						<button className="video-viewer-icon" aria-label="Download video" disabled>
							<Download size={19} />
						</button>
					)}
					<button
						className="video-viewer-icon"
						aria-label="View video full screen"
						title="View video full screen"
						disabled={!source || !!error || !dimensions.width}
						ref={expand}
						onClick={enterFullscreen}
					>
						<Expand size={19} />
					</button>
					<button
						className="video-viewer-icon"
						aria-label="Close video viewer"
						title="Close"
						ref={close}
						onClick={closeViewer}
					>
						<X size={22} />
					</button>
				</div>
			</header>
			<div
				className="video-viewer-canvas"
				onClick={(event) => {
					if (fullscreenVisible && event.target === event.currentTarget) setFullscreen(false);
				}}
			>
				{fullscreenVisible && poster && (
					<img
						className="video-viewer-backdrop"
						src={poster}
						alt=""
						aria-hidden="true"
						draggable={false}
					/>
				)}
				{loading || error ? (
					<div className="video-viewer-status" role={error ? 'alert' : 'status'}>
						{error ? <VideoOff size={28} /> : <LoaderCircle size={28} className="spin" />}
						<p>{error ? userFacingError(error) : 'Loading video…'}</p>
						{error && (
							<button className="secondary-button" onClick={() => setRetry((value) => value + 1)}>
								Retry video
							</button>
						)}
					</div>
				) : source ? (
					<video
						className="video-viewer-player"
						key={identity}
						ref={attachPlayer}
						src={source.dataUrl}
						controls
						controlsList="nofullscreen noremoteplayback"
						disablePictureInPicture
						playsInline
						preload="auto"
						aria-label={p.asset.name || 'Generated video'}
						style={{ width: `min(100cqw, ${aspectRatio * 100}cqh)` }}
						onDoubleClick={doubleClickVideo}
						onLoadedMetadata={(event) => {
							const video = event.currentTarget;
							setDimensions({
								width: video.videoWidth,
								height: video.videoHeight,
								duration: video.duration,
							});
						}}
						onLoadedData={() => {
							if (fullscreenVisible) setPoster(capturePoster());
						}}
						onError={(event) => {
							if (player.current !== event.currentTarget) return;
							setPlayError(playbackError(event.currentTarget));
							setFullscreen(false);
						}}
					/>
				) : null}
			</div>
			<div
				className="video-viewer-details"
				inert={fullscreenVisible}
				aria-hidden={fullscreenVisible || undefined}
			>
				<div className="video-viewer-metadata">
					<span>{p.modelLabel}</span>
					{source && dimensions.width > 0 && (
						<span>
							{dimensions.width} × {dimensions.height}
							{durationLabel(dimensions.duration) ? ` · ${durationLabel(dimensions.duration)}` : ''}
						</span>
					)}
				</div>
				<span className="video-viewer-prompt-label">Original prompt</span>
				<p>{p.prompt || 'No prompt saved for this video.'}</p>
				<ModerationNotice warnings={p.moderationWarnings} />
				<button
					className="secondary-button compact"
					onClick={() => {
						player.current?.pause();
						p.onReuse();
					}}
				>
					<RotateCcw size={14} /> Reuse prompt
				</button>
			</div>
			{fullscreenVisible && (
				<button
					type="button"
					className="video-viewer-fullscreen-close"
					aria-label="Close full screen video"
					title="Close full screen video (Esc)"
					ref={fullscreenClose}
					onClick={() => setFullscreen(false)}
				>
					<X size={24} />
				</button>
			)}
		</div>,
		document.body,
	);
}
