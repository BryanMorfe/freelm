import { userFacingError } from '../lib/user-facing-error';
import Select from './Select';
import {
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type FormEvent,
	type PointerEvent,
	type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
	ArrowUp,
	ChevronLeft,
	ChevronRight,
	Download,
	Eraser,
	Expand,
	ImageOff,
	LoaderCircle,
	Scissors,
	Square,
	X,
} from 'lucide-react';
import type { Attachment, MediaAsset } from '../types';
import ModerationNotice from './ModerationNotice';
import './image-viewer.css';

export interface ImageViewerProps {
	asset: MediaAsset;
	selectionKey?: string;
	readOnly?: boolean;
	source: Attachment | null;
	loading: boolean;
	error?: string;
	requestError?: string;
	moderationWarnings?: string[];
	prompt: string;
	modelLabel: string;
	modelPicker: ReactNode;
	busy: boolean;
	blocked?: boolean;
	capabilityError?: string;
	index: number;
	total: number;
	onClose: () => void;
	onPrevious: () => void;
	onNext: () => void;
	onRetryLoad: () => void;
	onEdit: (prompt: string, options?: { mask?: Attachment; size?: string }) => void;
	onStop: () => void;
}

interface Selection {
	x: number;
	y: number;
	width: number;
	height: number;
}
const portalSelector = '[data-image-viewer-portal], .chat-model-popover, .select-popup';
const focusableSelector =
	'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]';
const clamp = (value: number) => Math.max(0, Math.min(1, value));

export default function ImageViewer(p: ImageViewerProps) {
	const [draft, setDraft] = useState('');
	const [zoom, setZoom] = useState('fit');
	const [fullscreen, setFullscreen] = useState(false);
	const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
	const [viewport, setViewport] = useState({ width: 800, height: 500 });
	const [erase, setErase] = useState(false);
	const [selection, setSelection] = useState<Selection | null>(null);
	const [resize, setResize] = useState(false);
	const [width, setWidth] = useState('');
	const [height, setHeight] = useState('');
	const [localError, setLocalError] = useState('');
	const [previewError, setPreviewError] = useState(false);
	const dialog = useRef<HTMLDivElement>(null);
	const close = useRef<HTMLButtonElement>(null);
	const fullscreenDialog = useRef<HTMLDivElement>(null);
	const fullscreenClose = useRef<HTMLButtonElement>(null);
	const fullscreenOpen = useRef<HTMLButtonElement>(null);
	const fullscreenTrigger = useRef<HTMLButtonElement | null>(null);
	const wasFullscreen = useRef(false);
	const canvasViewport = useRef<HTMLDivElement>(null);
	const image = useRef<HTMLImageElement>(null);
	const overlay = useRef<HTMLDivElement>(null);
	const composer = useRef<HTMLTextAreaElement>(null);
	const dragStart = useRef<{ x: number; y: number; pointerId: number } | null>(null);
	const latest = useRef(p);
	latest.current = p;
	const imageError =
		p.error || (previewError ? 'This image could not be displayed. Try loading it again.' : '');
	const fullscreenVisible = fullscreen && !!p.source && !p.loading && !imageError;
	const unavailable =
		p.readOnly ||
		p.busy ||
		p.blocked ||
		p.loading ||
		!p.source ||
		!dimensions.width ||
		!!imageError ||
		!!p.capabilityError;
	const fit = dimensions.width
		? Math.min(
				Math.max(1, Math.floor(viewport.width) - 48) / dimensions.width,
				Math.max(1, Math.floor(viewport.height) - 32) / dimensions.height,
			)
		: 1;
	const scale = zoom === 'fit' ? fit : Number(zoom) / 100;
	const renderedWidth = dimensions.width * scale;
	const renderedHeight = dimensions.height * scale;

	useEffect(() => {
		const previous = document.activeElement as HTMLElement | null;
		const overflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		close.current?.focus();
		function keydown(event: KeyboardEvent) {
			if (event.defaultPrevented) return;
			const expanded = fullscreenDialog.current;
			const activeDialog = expanded || dialog.current;
			// Nested model-picker portals own Escape and keyboard navigation while open.
			const nested = expanded ? null : document.querySelector<HTMLElement>(portalSelector);
			if (event.key === 'Escape') {
				if (nested) return;
				event.preventDefault();
				if (expanded) setFullscreen(false);
				else latest.current.onClose();
				return;
			}
			if (event.key === 'Tab') {
				const elements = [
					...Array.from(activeDialog?.querySelectorAll<HTMLElement>(focusableSelector) || []),
					...Array.from(nested?.querySelectorAll<HTMLElement>(focusableSelector) || []),
				].filter(
					(element) =>
						element.getClientRects().length && element.getAttribute('aria-hidden') !== 'true',
				);
				const first = elements[0],
					last = elements.at(-1);
				if (!first) {
					event.preventDefault();
					activeDialog?.focus();
					return;
				}
				if (
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
		}
		function focusin(event: FocusEvent) {
			const target = event.target as HTMLElement | null;
			if (fullscreenDialog.current) {
				if (target && !fullscreenDialog.current.contains(target)) fullscreenClose.current?.focus();
				return;
			}
			if (target && !dialog.current?.contains(target) && !target.closest(portalSelector))
				close.current?.focus();
		}
		document.addEventListener('keydown', keydown);
		document.addEventListener('focusin', focusin);
		return () => {
			document.removeEventListener('keydown', keydown);
			document.removeEventListener('focusin', focusin);
			document.body.style.overflow = overflow;
			if (previous?.isConnected) previous.focus();
		};
	}, []);

	useLayoutEffect(() => {
		if (fullscreenVisible) fullscreenClose.current?.focus({ preventScroll: true });
		else if (wasFullscreen.current) {
			const trigger = fullscreenTrigger.current;
			(trigger?.isConnected && !trigger.disabled
				? trigger
				: fullscreenOpen.current || close.current
			)?.focus({
				preventScroll: true,
			});
		}
		wasFullscreen.current = fullscreenVisible;
	}, [fullscreenVisible]);

	useLayoutEffect(() => {
		const element = canvasViewport.current;
		if (!element) return;
		// Keep fractional CSS dimensions at non-default display scaling. Rounded
		// client sizes can make a fitted image overflow and toggle its scrollbars.
		const observer = new ResizeObserver(([entry]) => {
			if (!entry) return;
			const { width, height } = entry.contentRect;
			setViewport((previous) =>
				previous.width === width && previous.height === height ? previous : { width, height },
			);
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	useLayoutEffect(() => {
		setDraft('');
		setZoom('fit');
		setFullscreen(false);
		setDimensions({ width: 0, height: 0 });
		setErase(false);
		setSelection(null);
		setResize(false);
		setWidth('');
		setHeight('');
		setLocalError('');
		setPreviewError(false);
		dragStart.current = null;
		canvasViewport.current?.scrollTo({ top: 0, left: 0 });
	}, [p.selectionKey ?? p.asset.url]);

	function openFullscreen(trigger: HTMLButtonElement) {
		fullscreenTrigger.current = trigger;
		setFullscreen(true);
	}

	function point(event: PointerEvent<HTMLDivElement>) {
		const bounds = event.currentTarget.getBoundingClientRect();
		return {
			x: clamp((event.clientX - bounds.left) / bounds.width),
			y: clamp((event.clientY - bounds.top) / bounds.height),
		};
	}
	function moveSelection(event: PointerEvent<HTMLDivElement>) {
		const start = dragStart.current;
		if (!start || start.pointerId !== event.pointerId) return;
		const end = point(event);
		setSelection({
			x: Math.min(start.x, end.x),
			y: Math.min(start.y, end.y),
			width: Math.abs(end.x - start.x),
			height: Math.abs(end.y - start.y),
		});
	}
	function submit(event?: FormEvent) {
		event?.preventDefault();
		if (unavailable || !draft.trim()) return;
		setLocalError('');
		try {
			const options: { mask?: Attachment; size?: string } = {
				size: `${dimensions.width}x${dimensions.height}`,
			};
			if (resize) {
				const w = Number(width),
					h = Number(height);
				if (![w, h].every((value) => Number.isInteger(value) && value > 0 && value <= 8192))
					throw new Error(
						'Enter a width and height from 1 to 8192 pixels. Supported sizes depend on your model.',
					);
				options.size = `${w}x${h}`;
			}
			if (erase) {
				if (
					!selection ||
					selection.width * dimensions.width < 1 ||
					selection.height * dimensions.height < 1
				)
					throw new Error('Select an area on the image to erase first.');
				const maskCanvas = document.createElement('canvas');
				maskCanvas.width = dimensions.width;
				maskCanvas.height = dimensions.height;
				const context = maskCanvas.getContext('2d');
				if (!context) throw new Error('Could not create the selection mask.');
				context.fillStyle = '#000';
				context.fillRect(0, 0, dimensions.width, dimensions.height);
				const x = Math.floor(selection.x * dimensions.width),
					y = Math.floor(selection.y * dimensions.height);
				const right = Math.ceil((selection.x + selection.width) * dimensions.width),
					bottom = Math.ceil((selection.y + selection.height) * dimensions.height);
				context.clearRect(x, y, right - x, bottom - y);
				options.mask = {
					name: 'selection-mask.png',
					type: 'image/png',
					dataUrl: maskCanvas.toDataURL('image/png'),
				};
			}
			p.onEdit(draft.trim(), options);
		} catch (error) {
			setLocalError(
				error instanceof Error ? error.message : 'The image edit could not be prepared.',
			);
		}
	}

	return createPortal(
		<>
			<div
				className={`image-viewer ${p.readOnly ? 'image-viewer-readonly' : ''} ${window.desktop?.platform === 'darwin' ? 'image-viewer-mac' : ''}`}
				role="dialog"
				aria-modal="true"
				aria-label="Image viewer"
				aria-hidden={fullscreenVisible || undefined}
				inert={fullscreenVisible}
				ref={dialog}
				tabIndex={-1}
			>
				<header className="image-viewer-header">
					<div className="image-viewer-navigation">
						{(!p.readOnly || p.total > 1) && (
							<>
								<button
									className="image-viewer-icon"
									aria-label="Previous image"
									title="Previous image"
									disabled={p.index <= 0 || p.busy}
									onClick={p.onPrevious}
								>
									<ChevronLeft size={20} />
								</button>
								<span>
									{p.index + 1} <span>/ {p.total}</span>
								</span>
								<button
									className="image-viewer-icon"
									aria-label="Next image"
									title="Next image"
									disabled={p.index >= p.total - 1 || p.busy}
									onClick={p.onNext}
								>
									<ChevronRight size={20} />
								</button>
							</>
						)}
					</div>
					<div className="image-viewer-actions">
						<Select
							aria-label="Image zoom"
							value={zoom}
							onChange={setZoom}
							disabled={!dimensions.width}
							options={[
								{ value: 'fit', label: 'Fit' },
								...[50, 100, 150, 200].map((value) => ({
									value: String(value),
									label: `${value}%`,
								})),
							]}
						/>
						{p.readOnly && (
							<button
								type="button"
								className="image-viewer-icon"
								aria-label="Full screen"
								title="Full screen"
								disabled={!p.source || p.loading || !dimensions.width || !!imageError}
								onClick={(event) => openFullscreen(event.currentTarget)}
							>
								<Expand size={19} />
							</button>
						)}
						{p.source && !imageError ? (
							<a
								className="image-viewer-icon"
								href={p.source.dataUrl}
								download={p.asset.name}
								aria-label="Download image"
								title="Download image"
							>
								<Download size={19} />
							</a>
						) : (
							<button className="image-viewer-icon" aria-label="Download image" disabled>
								<Download size={19} />
							</button>
						)}
						<button
							className="image-viewer-icon"
							aria-label="Close image viewer"
							title="Close"
							onClick={p.onClose}
							ref={close}
						>
							<X size={22} />
						</button>
					</div>
				</header>
				<div className="image-viewer-canvas" ref={canvasViewport}>
					{p.loading || !p.source || imageError ? (
						<div className="image-viewer-status" role={imageError ? 'alert' : 'status'}>
							{imageError ? <ImageOff size={28} /> : <LoaderCircle size={28} className="spin" />}
							<p>{imageError ? userFacingError(imageError) : 'Loading image…'}</p>
							{imageError && (
								<button
									className="secondary-button"
									onClick={() => {
										setPreviewError(false);
										p.onRetryLoad();
									}}
								>
									Retry image
								</button>
							)}
						</div>
					) : (
						<div className="image-viewer-stage">
							<div
								className="image-viewer-image"
								style={
									dimensions.width ? { width: renderedWidth, height: renderedHeight } : undefined
								}
							>
								<img
									ref={image}
									key={p.selectionKey ?? p.asset.url}
									src={p.source.dataUrl}
									alt={p.asset.name || 'Generated image'}
									className="media-generated-image"
									draggable={false}
									onLoad={(event) => {
										const element = event.currentTarget;
										setDimensions({ width: element.naturalWidth, height: element.naturalHeight });
										setWidth(String(element.naturalWidth));
										setHeight(String(element.naturalHeight));
									}}
									onError={() => setPreviewError(true)}
								/>
								{(p.readOnly || !erase) && dimensions.width > 0 && (
									<button
										type="button"
										className="image-viewer-expand"
										aria-label="View image full screen"
										title="View image full screen"
										ref={fullscreenOpen}
										onClick={(event) => openFullscreen(event.currentTarget)}
									/>
								)}
								{!p.readOnly && erase && dimensions.width > 0 && (
									<div
										ref={overlay}
										className="image-erase-overlay"
										role="group"
										aria-label="Image erase selection"
										aria-describedby="image-erase-help"
										tabIndex={unavailable ? -1 : 0}
										onPointerDown={(event) => {
											if (unavailable || event.button !== 0) return;
											event.preventDefault();
											const start = point(event);
											dragStart.current = { ...start, pointerId: event.pointerId };
											setSelection({ ...start, width: 0, height: 0 });
											event.currentTarget.setPointerCapture(event.pointerId);
											event.currentTarget.focus();
										}}
										onPointerMove={moveSelection}
										onPointerUp={(event) => {
											moveSelection(event);
											dragStart.current = null;
											if (event.currentTarget.hasPointerCapture(event.pointerId))
												event.currentTarget.releasePointerCapture(event.pointerId);
										}}
										onPointerCancel={() => {
											dragStart.current = null;
										}}
										onKeyDown={(event) => {
											if (unavailable) return;
											if (event.key === 'Enter' || event.key === ' ') {
												event.preventDefault();
												setSelection((old) => old || { x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
											} else if (
												['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
											) {
												event.preventDefault();
												const step = 0.01;
												const horizontal =
													event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
												const vertical =
													event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
												const resizing = event.shiftKey;
												setSelection((old) => {
													const rect = old || { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };
													if (resizing)
														return {
															...rect,
															width: Math.min(
																1 - rect.x,
																Math.max(1 / dimensions.width, rect.width + horizontal),
															),
															height: Math.min(
																1 - rect.y,
																Math.max(1 / dimensions.height, rect.height + vertical),
															),
														};
													return {
														...rect,
														x: Math.min(
															1 - rect.width,
															Math.max(
																0,
																rect.x +
																	(event.key === 'ArrowLeft'
																		? -step
																		: event.key === 'ArrowRight'
																			? step
																			: 0),
															),
														),
														y: Math.min(
															1 - rect.height,
															Math.max(
																0,
																rect.y +
																	(event.key === 'ArrowUp'
																		? -step
																		: event.key === 'ArrowDown'
																			? step
																			: 0),
															),
														),
													};
												});
											}
										}}
									>
										{selection && (
											<div
												className="image-erase-selection"
												style={{
													left: `${selection.x * 100}%`,
													top: `${selection.y * 100}%`,
													width: `${selection.width * 100}%`,
													height: `${selection.height * 100}%`,
												}}
											/>
										)}
									</div>
								)}
							</div>
						</div>
					)}
				</div>
				<ModerationNotice warnings={p.moderationWarnings} />
				{!p.readOnly && (
					<>
						<div className="image-viewer-original">
							<span>Original prompt</span>
							<p>{p.prompt || 'No prompt saved for this image.'}</p>
						</div>
						<div className="image-viewer-bottom">
							<div className="image-viewer-tools">
								<button
									disabled={unavailable}
									onClick={() => {
										setErase(false);
										setSelection(null);
										setResize(false);
										setLocalError('');
										setDraft(
											'Remove the background, preserving the subject and fine edges. Use a transparent background if supported.',
										);
										composer.current?.focus();
									}}
								>
									<Scissors size={15} /> Remove background
								</button>
								<button
									disabled={unavailable}
									aria-pressed={erase}
									onClick={() => {
										const next = !erase;
										setErase(next);
										setResize(false);
										setSelection(null);
										setLocalError('');
										if (next) {
											setDraft(
												'Remove the contents of the selected area and naturally fill it to match the surrounding image.',
											);
											requestAnimationFrame(() => overlay.current?.focus());
										}
									}}
								>
									<Eraser size={15} /> Erase
								</button>
								<button
									disabled={unavailable}
									aria-pressed={resize}
									onClick={() => {
										const next = !resize;
										setResize(next);
										setErase(false);
										setSelection(null);
										setLocalError('');
										if (next) {
											setDraft('Resize this image, preserving its content and visual style.');
											composer.current?.focus();
										}
									}}
								>
									<Expand size={15} /> Resize
								</button>
							</div>
							{erase && (
								<p className="image-viewer-hint" id="image-erase-help">
									Drag over the area to erase. Keyboard: Enter selects the center; arrows move,
									Shift + arrows resize.
								</p>
							)}
							{resize && (
								<div className="image-viewer-resize">
									<label>
										Width
										<input
											type="number"
											min={1}
											max={8192}
											step={1}
											value={width}
											disabled={unavailable}
											onChange={(event) => setWidth(event.target.value)}
										/>
									</label>
									<span>×</span>
									<label>
										Height
										<input
											type="number"
											min={1}
											max={8192}
											step={1}
											value={height}
											disabled={unavailable}
											onChange={(event) => setHeight(event.target.value)}
										/>
									</label>
									<span>px · sent with your edit</span>
								</div>
							)}
							<form className="image-viewer-composer" onSubmit={submit}>
								<textarea
									ref={composer}
									rows={1}
									placeholder="Describe edits…"
									aria-label="Describe image edits"
									value={draft}
									disabled={unavailable}
									onChange={(event) => setDraft(event.target.value)}
									onKeyDown={(event) => {
										if (
											event.key === 'Enter' &&
											!event.shiftKey &&
											!event.nativeEvent.isComposing
										) {
											event.preventDefault();
											submit();
										}
									}}
								/>
								<div className="image-viewer-composer-footer">
									<span className="image-viewer-edit-note">Edit this image</span>
									<div className="image-viewer-compose-actions">
										<div className="image-viewer-model-picker" title={p.modelLabel}>
											{p.modelPicker}
										</div>
										{p.busy ? (
											<button
												key="stop"
												type="button"
												className="image-viewer-send"
												aria-label="Stop image edit"
												title="Stop image edit"
												onClick={(event) => {
													event.preventDefault();
													p.onStop();
												}}
											>
												<Square size={14} fill="currentColor" />
											</button>
										) : (
											<button
												key="send"
												type="submit"
												className="image-viewer-send"
												aria-label="Edit image"
												title="Edit image"
												disabled={unavailable || !draft.trim()}
											>
												<ArrowUp size={19} />
											</button>
										)}
									</div>
								</div>
							</form>
							{(localError || p.requestError || p.capabilityError) && (
								<p className="image-viewer-error" role="alert">
									{userFacingError(localError || p.requestError || p.capabilityError)}
								</p>
							)}
							{p.busy && (
								<p className="image-viewer-hint" role="status">
									<LoaderCircle size={13} className="spin" /> Creating a new version. Your original
									stays in your images.
								</p>
							)}
						</div>
					</>
				)}
			</div>
			{fullscreenVisible && p.source && (
				<div
					className="image-fullscreen"
					role="dialog"
					aria-modal="true"
					aria-label="Full screen image"
					ref={fullscreenDialog}
					tabIndex={-1}
					onClick={(event) => {
						if (event.target === event.currentTarget) setFullscreen(false);
					}}
				>
					<img
						className="image-fullscreen-backdrop"
						src={p.source.dataUrl}
						alt=""
						aria-hidden="true"
						draggable={false}
					/>
					<img
						className="image-fullscreen-image"
						style={{
							width: dimensions.height
								? `min(100cqw, ${(dimensions.width / dimensions.height) * 100}cqh)`
								: undefined,
						}}
						src={p.source.dataUrl}
						alt={p.asset.name || 'Generated image'}
						draggable={false}
						onError={() => setPreviewError(true)}
					/>
					<button
						type="button"
						className="image-fullscreen-close"
						aria-label="Close full screen image"
						title="Close full screen image (Esc)"
						ref={fullscreenClose}
						onClick={() => setFullscreen(false)}
					>
						<X size={24} />
					</button>
				</div>
			)}
		</>,
		document.body,
	);
}
