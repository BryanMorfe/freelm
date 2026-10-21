import { userFacingError } from '../lib/user-facing-error';
import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import {
	ArrowUp,
	LoaderCircle,
	Pause,
	Play,
	Plus,
	RotateCcw,
	Settings2,
	Square,
	Trash2,
	Video,
	X,
} from 'lucide-react';
import type { Attachment, Connection, Generation, MediaAsset } from '../types';
import { beginActivity } from '../lib/activities';
import { createVideo, downloadVideo, getVideo, type VideoJob, type VideoOptions } from '../lib/api';
import { assertModelSupports, defaultModel, getModelDefinition } from '../lib/catalog';
import { resolveVideoAsset } from '../lib/video-assets';
import { DEFAULT_VIDEO_SIZE, normalizeVideoResolution } from '../lib/video-resolution';
import { currentWorkspaceId } from '../lib/workspace';
import ChatModelPicker from './ChatModelPicker';
import VideoViewer from './VideoViewer';
import ModerationNotice from './ModerationNotice';
import './image-playground.css';
import './video-playground.css';

interface Props {
	mode?: 'images' | 'videos' | 'audio';
	blocked?: boolean;
	moderationWarning?: string;
	connection: Connection;
	generations: Generation[];
	onAdd: (generation: Generation) => void;
	onPrepareGeneration?: (generation: Generation, signal: AbortSignal) => Promise<void>;
	onUpdate: (id: string, patch: Partial<Generation>) => void;
	onDelete: (id: string) => void;
	onSettings: () => void;
}
interface Selection {
	generationId: string;
	assetIndex: number;
}
interface GalleryVideo {
	generation: Generation;
	asset: MediaAsset;
	assetIndex: number;
}
interface GalleryCell {
	generation: Generation;
	asset?: MediaAsset;
	assetIndex: number;
}
interface Operation {
	id: string;
	controller: AbortController;
	connection: Connection;
	remoteId?: string;
	failedAtProvider?: boolean;
	moderationWarnings?: string[];
}
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function message(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
function ensureRunning(signal: AbortSignal) {
	if (signal.aborted) throw new DOMException('Request stopped.', 'AbortError');
}
function waitForPoll(signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(new DOMException('Checking paused.', 'AbortError'));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(new DOMException('Checking paused.', 'AbortError'));
		};
		const timer = window.setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, 4000);
		signal.addEventListener('abort', onAbort, { once: true });
	});
}
function readReference(file: File): Promise<Attachment> {
	if (!file.type.startsWith('image/')) return Promise.reject(new Error('Choose an image file.'));
	if (file.size > MAX_IMAGE_BYTES)
		return Promise.reject(new Error(`“${file.name}” exceeds the 20 MB image limit.`));
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
		reader.onload = () =>
			resolve({ name: file.name, type: file.type, dataUrl: String(reader.result) });
		reader.readAsDataURL(file);
	});
}
function savedRequest(generation: Generation): VideoOptions {
	return {
		model: generation.model,
		prompt: generation.prompt,
		size: String(generation.parameters?.size || '') || undefined,
		seconds: String(generation.parameters?.seconds || '') || undefined,
	};
}
function hasSavedReference(generation: Generation) {
	return !!(generation.parameters?.input_reference || generation.parameters?.reference);
}

function VideoThumbnail({
	video,
	workspaceId,
	onRatio,
}: {
	video: GalleryVideo;
	workspaceId: string;
	onRatio: (ratio: number) => void;
}) {
	const identity = `${workspaceId}:${video.generation.connectionId}:${video.generation.id}:${video.assetIndex}`;
	const [resolved, setResolved] = useState({ identity: '', assetUrl: '', url: '' });
	const [failed, setFailed] = useState(false);
	const container = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const pending = new AbortController();
		let started = false;
		setResolved({ identity, assetUrl: video.asset.url, url: '' });
		setFailed(false);
		const load = () => {
			if (started) return;
			started = true;
			if (/^data:video\//i.test(video.asset.url)) {
				setResolved({ identity, assetUrl: video.asset.url, url: video.asset.url });
				return;
			}
			void resolveVideoAsset(
				video.asset,
				workspaceId,
				video.generation.connectionId,
				pending.signal,
			)
				.then((source) => {
					if (!pending.signal.aborted)
						setResolved({ identity, assetUrl: video.asset.url, url: source.dataUrl });
				})
				.catch(() => {
					if (!pending.signal.aborted) setFailed(true);
				});
		};
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) {
					load();
					observer.disconnect();
				}
			},
			{ rootMargin: '120px' },
		);
		if (container.current) observer.observe(container.current);
		return () => {
			pending.abort();
			observer.disconnect();
		};
	}, [identity, video.asset.url]);
	const source =
		resolved.identity === identity && resolved.assetUrl === video.asset.url ? resolved.url : '';
	const size = String(video.generation.parameters?.size || '').match(/^(\d+)x(\d+)$/);
	return (
		<div className="image-gallery-preview video-gallery-preview" ref={container}>
			{source && !failed ? (
				<>
					<video
						className="video-gallery-video"
						src={source}
						muted
						playsInline
						preload="metadata"
						onLoadedMetadata={(event) => {
							const element = event.currentTarget;
							if (element.videoWidth && element.videoHeight)
								onRatio(element.videoWidth / element.videoHeight);
						}}
						onError={() => setFailed(true)}
					/>
					<span className="video-gallery-play" aria-hidden="true">
						<Play size={22} fill="currentColor" />
					</span>
				</>
			) : (
				<div
					className="image-gallery-placeholder video-gallery-placeholder"
					style={size ? { aspectRatio: `${size[1]} / ${size[2]}` } : undefined}
				>
					<Video size={27} strokeWidth={1.4} />
					<span>{failed ? 'Open video to retry' : 'Loading video…'}</span>
				</div>
			)}
		</div>
	);
}

export function VideoPlayground({
	blocked = false,
	moderationWarning,
	connection,
	generations,
	onAdd,
	onPrepareGeneration,
	onUpdate,
	onDelete,
	onSettings,
}: Props) {
	const workspaceId = currentWorkspaceId();
	const fallbackModel = defaultModel(connection, 'videos');
	const [model, setModel] = useState(fallbackModel);
	const [prompt, setPrompt] = useState('');
	const [size, setSize] = useState(DEFAULT_VIDEO_SIZE);
	const [seconds, setSeconds] = useState('4');
	const [reference, setReference] = useState<Attachment>();
	const [uploading, setUploading] = useState(false);
	const [settings, setSettings] = useState(false);
	const [error, setError] = useState('');
	const [activeId, setActiveId] = useState<string | null>(null);
	const [selection, setSelection] = useState<Selection | null>(null);
	const [columnCount, setColumnCount] = useState(4);
	const [aspectRatios, setAspectRatios] = useState<Record<string, number>>({});
	const galleryContainer = useRef<HTMLDivElement>(null);
	const composerInput = useRef<HTMLTextAreaElement>(null);
	const settingsContainer = useRef<HTMLDivElement>(null);
	const uploadInput = useRef<HTMLInputElement>(null);
	const operation = useRef<Operation | null>(null);
	const retryRequests = useRef(new Map<string, VideoOptions>());
	const mounted = useRef(true);
	const navigation = useRef(0);
	const uploadToken = useRef(0);
	const previousConnection = useRef(connection.id);
	const lastFocused = useRef<HTMLElement | null>(null);
	const history = generations
		.filter((generation) => generation.kind === 'videos')
		.sort((a, b) => b.createdAt - a.createdAt);
	const gallery = history.flatMap((generation) =>
		generation.assets.map((asset, assetIndex) => ({ generation, asset, assetIndex })),
	);
	const selectedIndex = gallery.findIndex(
		(item) =>
			item.generation.id === selection?.generationId && item.assetIndex === selection.assetIndex,
	);
	const selected = gallery[selectedIndex];
	const active = activeId !== null;
	const activeGeneration = history.find((generation) => generation.id === activeId);
	const hasRemoteJob = !!activeGeneration?.remoteId;
	const definition = getModelDefinition(connection, model.trim());
	const acceptsReference = !definition || definition.inputModalities.includes('image');
	let capabilityError = '';
	try {
		assertModelSupports(connection, model.trim(), 'videos', reference ? ['image'] : []);
	} catch (cause) {
		capabilityError = message(cause);
	}
	const columns: GalleryCell[][] = Array.from({ length: columnCount }, () => []);
	const heights = Array.from({ length: columnCount }, () => 0);
	for (const generation of history) {
		const cells: GalleryCell[] = generation.assets.length
			? generation.assets.map((asset, assetIndex) => ({ generation, asset, assetIndex }))
			: [{ generation, assetIndex: 0 }];
		for (const cell of cells) {
			const dimensions = String(generation.parameters?.size || '').match(/^(\d+)x(\d+)$/);
			const ratio =
				aspectRatios[`${generation.id}:${cell.assetIndex}`] ||
				(dimensions && Number(dimensions[2])
					? Number(dimensions[1]) / Number(dimensions[2])
					: 16 / 9);
			const shortest = heights.indexOf(Math.min(...heights));
			columns[shortest].push(cell);
			heights[shortest] += (cell.asset ? 1 / ratio : 1) + 0.055;
		}
	}

	useEffect(() => {
		mounted.current = true;
		const stop = () => {
			navigation.current++;
			operation.current?.controller.abort();
			uploadToken.current++;
		};
		const removePrepareClose = window.desktop?.onPrepareClose(stop);
		window.addEventListener('freelm:workspace-changing', stop);
		return () => {
			mounted.current = false;
			stop();
			removePrepareClose?.();
			window.removeEventListener('freelm:workspace-changing', stop);
		};
	}, []);
	useEffect(() => setModel(fallbackModel), [connection.id, fallbackModel]);
	useEffect(() => {
		if (previousConnection.current === connection.id) return;
		previousConnection.current = connection.id;
		navigation.current++;
		operation.current?.controller.abort();
		uploadToken.current++;
		setUploading(false);
		setReference(undefined);
		setSize(DEFAULT_VIDEO_SIZE);
		setSeconds('4');
		setError('');
	}, [connection.id]);
	useEffect(() => {
		if (!settings) return;
		const outside = (event: PointerEvent) => {
			if (!settingsContainer.current?.contains(event.target as Node)) setSettings(false);
		};
		const escape = (event: KeyboardEvent) => {
			if (event.key === 'Escape') setSettings(false);
		};
		document.addEventListener('pointerdown', outside);
		document.addEventListener('keydown', escape);
		return () => {
			document.removeEventListener('pointerdown', outside);
			document.removeEventListener('keydown', escape);
		};
	}, [settings]);
	useEffect(() => {
		const element = galleryContainer.current;
		if (!element) return;
		const measure = () => {
			const width = element.clientWidth;
			setColumnCount(width >= 1000 ? 4 : width >= 740 ? 3 : 2);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [history.length > 0]);

	function chooseVideo(item: GalleryVideo, preserveFocus = false) {
		navigation.current++;
		if (!selection && !preserveFocus) lastFocused.current = document.activeElement as HTMLElement;
		setSelection({ generationId: item.generation.id, assetIndex: item.assetIndex });
		setSettings(false);
	}
	function closeViewer() {
		navigation.current++;
		setSelection(null);
		requestAnimationFrame(() =>
			lastFocused.current?.isConnected
				? lastFocused.current.focus()
				: composerInput.current?.focus(),
		);
	}
	function navigateVideo(direction: number) {
		const next = gallery[selectedIndex + direction];
		if (next) chooseVideo(next, true);
	}
	function reuse(generation: Generation) {
		navigation.current++;
		setSelection(null);
		setPrompt(generation.prompt);
		setSize(normalizeVideoResolution(String(generation.parameters?.size || '')));
		setSeconds(String(generation.parameters?.seconds || ''));
		setReference(undefined);
		if (generation.connectionId === connection.id) setModel(generation.model);
		setError(
			hasSavedReference(generation)
				? 'Reattach the original reference image before generating this video again.'
				: generation.connectionId !== connection.id
					? 'This video used another API connection. Choose a model for the current connection.'
					: '',
		);
		requestAnimationFrame(() => composerInput.current?.focus());
	}
	function selectModel(id: string) {
		setModel(id);
		setSize(DEFAULT_VIDEO_SIZE);
		setSeconds('4');
	}
	async function upload(event: ChangeEvent<HTMLInputElement>) {
		const file = event.target.files?.[0];
		event.target.value = '';
		if (!file || uploading || operation.current || blocked) return;
		const token = ++uploadToken.current;
		setUploading(true);
		try {
			assertModelSupports(connection, model.trim(), 'videos', ['image']);
			const next = await readReference(file);
			if (!mounted.current || token !== uploadToken.current) return;
			setReference(next);
			setError('');
		} catch (cause) {
			if (mounted.current && token === uploadToken.current) setError(message(cause));
		} finally {
			if (mounted.current && token === uploadToken.current) setUploading(false);
		}
	}

	async function acceptJob(op: Operation, job: VideoJob) {
		const signal = op.controller.signal;
		ensureRunning(signal);
		op.remoteId = job.id;
		const progress =
			typeof job.progress === 'number' && Number.isFinite(job.progress)
				? Math.min(100, Math.max(0, job.progress))
				: undefined;
		onUpdate(op.id, { remoteId: job.id, progress });
		const status = job.status.toLowerCase();
		if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) {
			op.failedAtProvider = true;
			throw new Error(
				typeof job.error === 'string' ? job.error : job.error?.message || `Video job ${status}.`,
			);
		}
		if (!['completed', 'succeeded', 'success'].includes(status)) return null;
		const asset = await downloadVideo(op.connection, job.id, signal, (warnings) =>
			recordModerationWarnings(op, warnings),
		);
		ensureRunning(signal);
		return asset;
	}
	function recordModerationWarnings(op: Operation, warnings: string[]) {
		op.moderationWarnings = [...new Set([...(op.moderationWarnings ?? []), ...warnings])];
		onUpdate(op.id, { moderationWarnings: op.moderationWarnings });
	}
	async function poll(op: Operation) {
		const signal = op.controller.signal;
		// Video jobs can take hours. Let the provider report a terminal status;
		// individual requests still have transport deadlines and remain abortable.
		while (true) {
			ensureRunning(signal);
			const job = await getVideo(op.connection, op.remoteId!, signal);
			ensureRunning(signal);
			const asset = await acceptJob(op, job);
			ensureRunning(signal);
			if (asset) return asset;
			await waitForPoll(signal);
			ensureRunning(signal);
		}
	}
	async function run(generation: Generation, input?: VideoOptions, onStarted?: () => void) {
		if (blocked || operation.current) return;
		if (generation.connectionId !== connection.id) {
			setError('Switch to this video’s original API connection before retrying or resuming.');
			return;
		}
		try {
			if (!connection.baseUrl.trim())
				throw new Error('Set an API base URL in Settings before generating.');
			if (input) {
				if (!input.model.trim()) throw new Error('Choose a video model before generating.');
				if (!input.prompt.trim()) throw new Error('Describe the video you want to create.');
				assertModelSupports(connection, input.model, 'videos', input.reference ? ['image'] : []);
			} else if (!generation.remoteId) throw new Error('This video has no saved job to resume.');
		} catch (cause) {
			setError(message(cause));
			return;
		}
		const snapshot = input ? structuredClone(input) : undefined;
		const pending = {
			...generation,
			status: 'pending' as const,
			error: undefined,
			...(input ? { moderationWarnings: undefined } : {}),
		};
		const op: Operation = {
			id: generation.id,
			controller: new AbortController(),
			connection: structuredClone(connection),
			remoteId: input ? undefined : generation.remoteId,
			moderationWarnings: pending.moderationWarnings,
		};
		operation.current = op;
		const finishActivity = beginActivity();
		const revision = navigation.current;
		setActiveId(op.id);
		setError('');
		if (snapshot) {
			retryRequests.current.set(op.id, snapshot);
			onAdd(pending);
		} else onUpdate(op.id, { status: 'pending', error: undefined });
		onStarted?.();
		try {
			await onPrepareGeneration?.(pending, op.controller.signal);
			ensureRunning(op.controller.signal);
			let asset: MediaAsset | null = null;
			if (snapshot) {
				const job = await createVideo(op.connection, snapshot, op.controller.signal, (warnings) =>
					recordModerationWarnings(op, warnings),
				);
				ensureRunning(op.controller.signal);
				asset = await acceptJob(op, job);
				ensureRunning(op.controller.signal);
			}
			if (!asset) {
				asset = await poll(op);
				ensureRunning(op.controller.signal);
			}
			if (asset) {
				onUpdate(op.id, { status: 'completed', progress: 100, assets: [asset], error: undefined });
				retryRequests.current.delete(op.id);
				if (mounted.current && revision === navigation.current) {
					lastFocused.current = composerInput.current;
					setSelection({ generationId: op.id, assetIndex: 0 });
					setSettings(false);
				}
			}
		} catch (cause) {
			if (op.controller.signal.aborted) {
				onUpdate(
					op.id,
					op.remoteId
						? {
								status: 'pending',
								remoteId: op.remoteId,
								error: 'Checking paused. The provider may still be processing this video.',
							}
						: { status: 'cancelled', error: 'Request stopped.' },
				);
			} else {
				const text = message(cause);
				const resumable = !!op.remoteId && !op.failedAtProvider;
				const detail = resumable
					? `Checking paused: ${text} Resume checking to finish this video.`
					: text;
				onUpdate(op.id, {
					status: resumable ? 'pending' : 'failed',
					error: detail,
				});
				if (mounted.current) setError(detail);
			}
		} finally {
			if (operation.current === op) {
				operation.current = null;
				if (mounted.current) setActiveId(null);
			}
			finishActivity();
		}
	}
	function generate(input: VideoOptions, onStarted?: () => void) {
		const request = { ...input, size: normalizeVideoResolution(input.size || '') || undefined };
		const generation: Generation = {
			id: crypto.randomUUID(),
			kind: 'videos',
			prompt: request.prompt,
			model: request.model,
			connectionId: connection.id,
			createdAt: Date.now(),
			status: 'pending',
			assets: [],
			parameters: {
				size: request.size || '',
				seconds: request.seconds || '',
				...(request.reference ? { input_reference: request.reference.name || 'attached' } : {}),
			},
		};
		void run(generation, request, onStarted);
	}
	function submit(event?: FormEvent) {
		event?.preventDefault();
		if (uploading || capabilityError) return;
		const nextSize = normalizeVideoResolution(size);
		setSize(nextSize);
		generate(
			{
				model: model.trim(),
				prompt: prompt.trim(),
				size: nextSize || undefined,
				seconds: seconds.trim() || undefined,
				reference,
			},
			() => {
				setPrompt('');
				setReference(undefined);
				setSettings(false);
			},
		);
	}
	function retry(generation: Generation) {
		if (blocked || operation.current) return;
		if (generation.connectionId !== connection.id) {
			setError('Switch to this video’s original API connection before retrying.');
			return;
		}
		const cached = retryRequests.current.get(generation.id);
		if (!cached && hasSavedReference(generation)) {
			reuse(generation);
			return;
		}
		generate(cached || savedRequest(generation));
	}
	function removeGeneration(id: string) {
		if (operation.current?.id === id) return;
		retryRequests.current.delete(id);
		if (selection?.generationId === id) closeViewer();
		onDelete(id);
	}

	return (
		<section className="image-playground video-playground" aria-label="Videos playground">
			<header className="image-workspace-header">
				<h1>Videos</h1>
				<button className="image-provider" onClick={onSettings}>
					{connection.name}
				</button>
			</header>
			<div className="image-workspace-scroll">
				<div className="image-landing-compose">
					<form className="image-composer video-composer" onSubmit={submit}>
						{reference && (
							<div className="image-reference-list">
								<div className="image-reference">
									<img src={reference.dataUrl} alt={reference.name} />
									<button
										type="button"
										aria-label={`Remove ${reference.name}`}
										onClick={() => setReference(undefined)}
									>
										<X size={13} />
									</button>
								</div>
							</div>
						)}
						<textarea
							ref={composerInput}
							aria-label="Generation prompt"
							value={prompt}
							onChange={(event) => setPrompt(event.target.value)}
							placeholder={
								reference ? 'Describe how this image should move…' : 'Describe a new video…'
							}
							rows={2}
							onKeyDown={(event) => {
								if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
									event.preventDefault();
									submit();
								}
							}}
						/>
						<div className="image-composer-toolbar">
							<div className="image-composer-tools">
								<button
									type="button"
									className="image-icon-button"
									aria-label="Add reference image"
									title={
										acceptsReference
											? 'Add reference image'
											: 'This model does not accept a reference image'
									}
									disabled={blocked || uploading || !acceptsReference || active}
									onClick={() => uploadInput.current?.click()}
								>
									{uploading ? <LoaderCircle className="spin" size={18} /> : <Plus size={21} />}
								</button>
								<div className="image-settings-anchor" ref={settingsContainer}>
									<button
										type="button"
										className="image-icon-button"
										aria-label="Video settings"
										title="Video settings"
										aria-expanded={settings}
										onClick={() => setSettings(!settings)}
									>
										<Settings2 size={17} />
									</button>
									{settings && (
										<div
											className="image-options"
											role="region"
											aria-label="Video generation settings"
										>
											<div className="image-options-heading">
												<strong>Video settings</strong>
												<button
													type="button"
													className="image-icon-button"
													aria-label="Close video settings"
													onClick={() => setSettings(false)}
												>
													<X size={15} />
												</button>
											</div>
											{definition && (
												<div className="image-model-capabilities" aria-label="Model capabilities">
													<strong>{definition.name}</strong>
													<span>
														{definition.inputModalities.join(', ')} →{' '}
														{definition.outputModalities.join(', ')}
													</span>
												</div>
											)}
											<label>
												Duration (seconds)
												<input
													inputMode="decimal"
													value={seconds}
													onChange={(event) => setSeconds(event.target.value)}
													placeholder="Provider default"
												/>
											</label>
											<label>
												Size
												<input
													value={size}
													onChange={(event) => setSize(event.target.value)}
													onBlur={(event) =>
														setSize(normalizeVideoResolution(event.currentTarget.value))
													}
													onKeyDown={(event) => {
														if (event.key === 'Enter') {
															event.preventDefault();
															setSize(normalizeVideoResolution(event.currentTarget.value));
														}
													}}
													placeholder="Provider default"
													list="video-size-options"
												/>
											</label>
											<datalist id="video-size-options">
												{['1280x736', '736x1280', '1792x1024', '1024x1792'].map((value) => (
													<option value={value} key={value} />
												))}
											</datalist>
											<p className="image-options-note">
												Width and height snap to the nearest multiple of 32. Leave blank to use your
												provider’s defaults.
											</p>
										</div>
									)}
								</div>
							</div>
							<div className="image-composer-actions">
								<ChatModelPicker
									task="videos"
									connection={connection}
									model={model}
									thinkingMode=""
									onThinkingMode={() => {}}
									disabled={active || blocked}
									onSelect={selectModel}
									onSettings={onSettings}
								/>
								{active ? (
									<button
										key="stop"
										type="button"
										className="image-send-button"
										aria-label={hasRemoteJob ? 'Pause checking' : 'Stop request'}
										title={hasRemoteJob ? 'Pause checking' : 'Stop request'}
										onClick={(event) => {
											event.preventDefault();
											operation.current?.controller.abort();
										}}
									>
										{hasRemoteJob ? (
											<Pause size={17} fill="currentColor" />
										) : (
											<Square size={16} fill="currentColor" />
										)}
									</button>
								) : (
									<button
										key="send"
										type="submit"
										className="image-send-button"
										aria-label="Generate video"
										disabled={blocked || uploading || !prompt.trim() || !!capabilityError}
									>
										<ArrowUp size={20} />
									</button>
								)}
							</div>
						</div>
					</form>
					<ModerationNotice warnings={moderationWarning ? [moderationWarning] : undefined} />
					{(error || capabilityError) && (
						<div className="image-compose-error" role="alert">
							<span>{userFacingError(error || capabilityError)}</span>
							{error && (
								<button
									className="image-icon-button"
									aria-label="Dismiss error"
									onClick={() => setError('')}
								>
									<X size={15} />
								</button>
							)}
						</div>
					)}
				</div>
				{history.length ? (
					<div
						className="image-gallery video-gallery"
						aria-label="Your videos"
						ref={galleryContainer}
						style={{ gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))` }}
					>
						{columns.map((column, columnIndex) => (
							<div className="image-gallery-column" key={columnIndex}>
								{column.map(({ generation, asset, assetIndex }) => {
									if (asset) {
										const item = { generation, asset, assetIndex };
										return (
											<article
												className="image-gallery-card video-gallery-card"
												key={`${generation.id}:${assetIndex}`}
											>
												<button
													className="image-gallery-open"
													aria-label={`Open ${generation.prompt}${assetIndex ? ` (${assetIndex + 1})` : ''}`}
													onClick={() => chooseVideo(item)}
												>
													<VideoThumbnail
														video={item}
														workspaceId={workspaceId}
														onRatio={(ratio) =>
															setAspectRatios((current) =>
																current[`${generation.id}:${assetIndex}`] === ratio
																	? current
																	: { ...current, [`${generation.id}:${assetIndex}`]: ratio },
															)
														}
													/>
													<span className="image-gallery-caption">{generation.prompt}</span>
												</button>
												<button
													className="image-gallery-delete"
													aria-label={`Delete ${generation.prompt} from history`}
													title="Delete creation"
													onClick={() => removeGeneration(generation.id)}
												>
													<Trash2 size={15} />
												</button>
											</article>
										);
									}
									const running = generation.id === activeId;
									const resumable = generation.status === 'pending' && !!generation.remoteId;
									const foreign = generation.connectionId !== connection.id;
									return (
										<article
											className="image-gallery-card image-job-card video-gallery-card"
											key={generation.id}
										>
											<div role={generation.status === 'failed' ? 'alert' : 'status'}>
												{running ? (
													<LoaderCircle className="spin" size={26} />
												) : (
													<Video size={26} strokeWidth={1.5} />
												)}
												<strong>
													{running
														? 'Creating your video…'
														: generation.status === 'failed'
															? 'Could not create video'
															: resumable
																? 'Checking paused'
																: generation.status === 'pending'
																	? 'Request interrupted'
																	: 'Request stopped'}
												</strong>
												<p>{generation.prompt}</p>
												{typeof generation.progress === 'number' && (
													<div className="video-job-progress">
														<progress
															aria-label="Video generation progress"
															max={100}
															value={generation.progress}
														/>
														<span>{Math.round(generation.progress)}%</span>
													</div>
												)}
												{generation.error && <span>{userFacingError(generation.error)}</span>}
												{foreign && (
													<span>
														Switch to this video’s original API connection to retry or resume.
													</span>
												)}
											</div>
											{running ? (
												<button
													className="image-job-action"
													onClick={() => operation.current?.controller.abort()}
												>
													{generation.remoteId ? <Pause size={13} /> : <Square size={13} />}
													{generation.remoteId ? 'Pause checking' : 'Stop request'}
												</button>
											) : (
												<button
													className="image-job-action"
													disabled={blocked || active || foreign}
													onClick={() => (resumable ? void run(generation) : retry(generation))}
												>
													{resumable ? <Play size={13} /> : <RotateCcw size={13} />}
													{resumable ? 'Resume checking' : 'Retry generation'}
												</button>
											)}
											{!running && (
												<button
													className="image-gallery-delete"
													aria-label={`Delete ${generation.prompt} from history`}
													onClick={() => removeGeneration(generation.id)}
												>
													<Trash2 size={15} />
												</button>
											)}
										</article>
									);
								})}
							</div>
						))}
					</div>
				) : (
					<div className="image-empty-state">
						<Video size={38} strokeWidth={1.15} />
						<h2>Your imagination, in motion.</h2>
						<p>
							Describe a video or add a reference to get started.
							<br />
							Your creations will appear here.
						</p>
					</div>
				)}
			</div>
			<input
				ref={uploadInput}
				className="video-upload-input"
				type="file"
				accept="image/*"
				hidden
				onChange={(event) => void upload(event)}
			/>
			{selected && (
				<VideoViewer
					asset={selected.asset}
					selectionKey={`${selected.generation.id}:${selected.assetIndex}`}
					workspaceId={workspaceId}
					connectionId={selected.generation.connectionId}
					prompt={selected.generation.prompt}
					moderationWarnings={selected.generation.moderationWarnings}
					modelLabel={
						(selected.generation.connectionId === connection.id &&
							getModelDefinition(connection, selected.generation.model)?.name) ||
						selected.generation.model
					}
					index={selectedIndex}
					total={gallery.length}
					onClose={closeViewer}
					onPrevious={() => navigateVideo(-1)}
					onNext={() => navigateVideo(1)}
					onReuse={() => reuse(selected.generation)}
				/>
			)}
		</section>
	);
}
