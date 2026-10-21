import { userFacingError } from '../lib/user-facing-error';
import Select from './Select';
import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import {
	ArrowUp,
	Image as ImageIcon,
	LoaderCircle,
	Plus,
	RotateCcw,
	Settings2,
	Square,
	Trash2,
	X,
} from 'lucide-react';
import type { Attachment, Connection, Generation, MediaAsset } from '../types';
import { beginActivity } from '../lib/activities';
import { generateImages, type ImageOptions } from '../lib/api';
import {
	assertModelSupports,
	defaultModel,
	getModelDefinition,
	modelSupports,
} from '../lib/catalog';
import { resolveImageAsset } from '../lib/image-assets';
import { currentWorkspaceId } from '../lib/workspace';
import ChatModelPicker from './ChatModelPicker';
import ImageViewer from './ImageViewer';
import ImageGalleryCaption from './ImageGalleryCaption';
import ModerationNotice from './ModerationNotice';
import './image-playground.css';

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
interface ImageRequest extends ImageOptions {
	source?: Selection;
	imagePreset?: string;
	aspectRatio?: string;
}
interface ImageSettings {
	scope: string;
	presetId: string;
	aspectRatioId: string;
	customSize: string;
	customQuality: string;
}
interface GalleryImage {
	generation: Generation;
	asset: MediaAsset;
	assetIndex: number;
}
interface GalleryCell {
	generation: Generation;
	asset?: MediaAsset;
	assetIndex: number;
}
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_REFERENCES = 16;
function settingsScope(connection: Connection, model: string) {
	const definition = getModelDefinition(connection, model.trim());
	return JSON.stringify([
		connection.id,
		model.trim(),
		definition?.defaultImagePreset,
		definition?.imagePresets,
	]);
}
function defaultImageSettings(connection: Connection, model: string): ImageSettings {
	const definition = getModelDefinition(connection, model.trim());
	const preset =
		definition?.imagePresets?.find((item) => item.id === definition.defaultImagePreset) ||
		definition?.imagePresets?.[0];
	const ratio =
		preset?.aspectRatios.find((item) => item.id === preset.defaultAspectRatio) ||
		preset?.aspectRatios[0];
	return {
		scope: settingsScope(connection, model),
		presetId: preset?.id || '',
		aspectRatioId: ratio?.id || '',
		customSize: '',
		customQuality: '',
	};
}
function message(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
function readImage(file: File): Promise<Attachment> {
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

function ImageThumbnail({
	image,
	workspaceId,
	onRatio,
}: {
	image: GalleryImage;
	workspaceId: string;
	onRatio: (ratio: number) => void;
}) {
	const remote = workspaceId !== 'local' && /^https?:/i.test(image.asset.url);
	const [source, setSource] = useState(remote ? '' : image.asset.url);
	const [failed, setFailed] = useState(false);
	const container = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const controller = new AbortController();
		let started = false;
		setSource(remote ? '' : image.asset.url);
		setFailed(false);
		const load = () => {
			if (started || !remote) return;
			started = true;
			void resolveImageAsset(
				image.asset,
				workspaceId,
				image.generation.connectionId,
				controller.signal,
			)
				.then((result) => {
					if (!controller.signal.aborted) setSource(result.dataUrl);
				})
				.catch(() => {
					if (!controller.signal.aborted) setFailed(true);
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
			controller.abort();
			observer.disconnect();
		};
	}, [remote, image.asset.url, image.generation.connectionId, workspaceId]);
	const size = String(image.generation.parameters?.size || '').match(/^(\d+)x(\d+)$/);
	return (
		<div className="image-gallery-preview" ref={container}>
			{source && !failed ? (
				<img
					className="image-gallery-image"
					src={source}
					alt={image.generation.prompt}
					loading="lazy"
					onLoad={(event) => {
						const img = event.currentTarget;
						if (img.naturalWidth && img.naturalHeight)
							onRatio(img.naturalWidth / img.naturalHeight);
					}}
					onError={() => setFailed(true)}
				/>
			) : (
				<div
					className="image-gallery-placeholder"
					style={size ? { aspectRatio: `${size[1]} / ${size[2]}` } : undefined}
				>
					<ImageIcon size={27} strokeWidth={1.4} />
					<span>{failed ? 'Open image to retry' : 'Loading image…'}</span>
				</div>
			)}
		</div>
	);
}

export function ImagePlayground({
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
	const fallbackModel = defaultModel(connection, 'images');
	const [model, setModel] = useState(fallbackModel);
	const [prompt, setPrompt] = useState('');
	const [storedSettings, setStoredSettings] = useState(() =>
		defaultImageSettings(connection, fallbackModel),
	);
	const [count, setCount] = useState(1);
	const [references, setReferences] = useState<Attachment[]>([]);
	const [mask, setMask] = useState<Attachment>();
	const [settings, setSettings] = useState(false);
	const [error, setError] = useState('');
	const [viewError, setViewError] = useState('');
	const [uploading, setUploading] = useState(false);
	const [activeId, setActiveId] = useState<string | null>(null);
	const [selection, setSelection] = useState<Selection | null>(null);
	const [source, setSource] = useState<Attachment | null>(null);
	const [sourceKey, setSourceKey] = useState('');
	const [sourceError, setSourceError] = useState('');
	const [sourceLoading, setSourceLoading] = useState(false);
	const [sourceAttempt, setSourceAttempt] = useState(0);
	const [columnCount, setColumnCount] = useState(4);
	const [aspectRatios, setAspectRatios] = useState<Record<string, number>>({});
	const galleryContainer = useRef<HTMLDivElement>(null);
	const controller = useRef<AbortController | null>(null);
	const sourceController = useRef<AbortController | null>(null);
	const uploadInput = useRef<HTMLInputElement>(null);
	const maskInput = useRef<HTMLInputElement>(null);
	const composerInput = useRef<HTMLTextAreaElement>(null);
	const settingsContainer = useRef<HTMLDivElement>(null);
	const mounted = useRef(true);
	const navigation = useRef(0);
	const uploadToken = useRef(0);
	const previousConnection = useRef(connection.id);
	const retryRequests = useRef(new Map<string, ImageRequest>());
	const lastFocused = useRef<HTMLElement | null>(null);
	const history = generations
		.filter((item) => item.kind === 'images')
		.sort((a, b) => b.createdAt - a.createdAt);
	const gallery = history.flatMap((generation) =>
		generation.assets.map((asset, assetIndex) => ({ generation, asset, assetIndex })),
	);
	const selectedIndex = gallery.findIndex(
		(item) =>
			item.generation.id === selection?.generationId && item.assetIndex === selection.assetIndex,
	);
	const selected = gallery[selectedIndex];
	const selectedUrl = selected?.asset.url;
	const selectedConnectionId = selected?.generation.connectionId;
	const selectedIdentity = selection ? `${selection.generationId}:${selection.assetIndex}` : '';
	const currentSource = sourceKey === selectedIdentity ? source : null;
	const columns: GalleryCell[][] = Array.from({ length: columnCount }, () => []);
	const columnHeights = Array.from({ length: columnCount }, () => 0);
	for (const generation of history) {
		const cells: GalleryCell[] = generation.assets.length
			? generation.assets.map((asset, assetIndex) => ({ generation, asset, assetIndex }))
			: [{ generation, assetIndex: 0 }];
		for (const cell of cells) {
			const dimensions = String(generation.parameters?.size || '').match(/^(\d+)x(\d+)$/);
			const ratio =
				aspectRatios[`${generation.id}:${cell.assetIndex}`] ||
				(dimensions && Number(dimensions[2]) ? Number(dimensions[1]) / Number(dimensions[2]) : 1);
			const shortest = columnHeights.indexOf(Math.min(...columnHeights));
			columns[shortest].push(cell);
			columnHeights[shortest] += (cell.asset ? 1 / ratio : 1) + 0.055;
		}
	}
	const active = activeId !== null;
	const definition = getModelDefinition(connection, model.trim());
	const scope = settingsScope(connection, model);
	const imageSettings =
		storedSettings.scope === scope ? storedSettings : defaultImageSettings(connection, model);
	const presets = definition?.imagePresets || [];
	const imagePreset = presets.find((item) => item.id === imageSettings.presetId);
	const aspectRatio = imagePreset?.aspectRatios.find(
		(item) => item.id === imageSettings.aspectRatioId,
	);
	const size = aspectRatio
		? `${aspectRatio.width}x${aspectRatio.height}`
		: imageSettings.customSize;
	const quality = imagePreset ? imagePreset.quality || '' : imageSettings.customQuality;
	const acceptsReferences = !definition || definition.inputModalities.includes('image');
	function capability(editing: boolean) {
		try {
			assertModelSupports(connection, model.trim(), 'images', editing ? ['image'] : []);
			return '';
		} catch (cause) {
			return message(cause);
		}
	}
	const capabilityError = capability(references.length > 0 || !!mask);
	const editCapabilityError = capability(true);

	useEffect(() => {
		mounted.current = true;
		const stop = () => {
			controller.current?.abort();
			sourceController.current?.abort();
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
	useEffect(() => {
		setModel(fallbackModel);
	}, [connection.id, fallbackModel]);
	useEffect(() => {
		setStoredSettings((current) =>
			current.scope === scope ? current : defaultImageSettings(connection, model),
		);
	}, [scope]);
	useEffect(() => {
		if (previousConnection.current === connection.id) return;
		previousConnection.current = connection.id;
		controller.current?.abort();
		uploadToken.current++;
		setUploading(false);
		setError('');
		setViewError('');
	}, [connection.id]);
	useEffect(() => {
		if (!settings) return;
		const outside = (event: PointerEvent) => {
			if (event.target instanceof Element && event.target.closest('.select-popup')) return;
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
	useEffect(() => {
		const pending = new AbortController();
		sourceController.current = pending;
		setSourceKey(selectedIdentity);
		setSource(null);
		setSourceError('');
		if (!selectedUrl || !selectedConnectionId) {
			setSourceLoading(false);
			return;
		}
		setSourceLoading(true);
		void resolveImageAsset(selected.asset, workspaceId, selectedConnectionId, pending.signal)
			.then((attachment) => {
				if (!pending.signal.aborted) setSource(attachment);
			})
			.catch((cause) => {
				if (!pending.signal.aborted) setSourceError(message(cause));
			})
			.finally(() => {
				if (!pending.signal.aborted) setSourceLoading(false);
			});
		return () => pending.abort();
	}, [selectedUrl, selectedConnectionId, selectedIdentity, workspaceId, sourceAttempt]);

	function chooseImage(item: GalleryImage, { restoreFocus = false, preserveModel = false } = {}) {
		navigation.current++;
		if (!selection && !restoreFocus) lastFocused.current = document.activeElement as HTMLElement;
		setSelection({ generationId: item.generation.id, assetIndex: item.assetIndex });
		setSettings(false);
		setViewError('');
		if (
			!preserveModel &&
			item.generation.connectionId === connection.id &&
			modelSupports(connection, item.generation.model, 'images', ['image'])
		)
			setModel(item.generation.model);
	}
	function closeViewer() {
		navigation.current++;
		setSelection(null);
		setViewError('');
		requestAnimationFrame(() =>
			lastFocused.current?.isConnected
				? lastFocused.current.focus()
				: composerInput.current?.focus(),
		);
	}
	function navigateImage(direction: number) {
		const next = gallery[selectedIndex + direction];
		if (next) chooseImage(next, { restoreFocus: true });
	}
	function openSettings() {
		if (selection) closeViewer();
		onSettings();
	}
	function choosePreset(id: string) {
		const preset = presets.find((item) => item.id === id);
		const ratio =
			preset?.aspectRatios.find((item) => item.id === preset.defaultAspectRatio) ||
			preset?.aspectRatios[0];
		setStoredSettings({
			scope,
			presetId: preset?.id || '',
			aspectRatioId: ratio?.id || '',
			customSize: '',
			customQuality: '',
		});
	}
	function restoreSettings(generation: Generation) {
		const nextModel = generation.connectionId === connection.id ? generation.model : model;
		const next = defaultImageSettings(connection, nextModel);
		if (generation.connectionId !== connection.id) {
			setStoredSettings(next);
			return;
		}
		setModel(nextModel);
		const parameters = generation.parameters || {};
		const available = getModelDefinition(connection, nextModel)?.imagePresets || [];
		const preset = available.find((item) => item.id === parameters.imagePreset);
		const ratio = preset?.aspectRatios.find((item) => item.id === parameters.aspectRatio);
		const savedSize = String(parameters.size || '');
		const savedQuality = String(parameters.quality || '');
		if (
			preset &&
			ratio &&
			savedSize === `${ratio.width}x${ratio.height}` &&
			savedQuality === (preset.quality || '')
		) {
			setStoredSettings({ ...next, presetId: preset.id, aspectRatioId: ratio.id });
		} else {
			setStoredSettings({
				...next,
				presetId: '',
				aspectRatioId: '',
				customSize: savedSize,
				customQuality: savedQuality,
			});
		}
	}
	function picker() {
		return (
			<ChatModelPicker
				task="images"
				connection={connection}
				model={model}
				thinkingMode=""
				onThinkingMode={() => {}}
				disabled={active}
				onSelect={setModel}
				onSettings={openSettings}
			/>
		);
	}

	async function execute(input: ImageRequest, onStarted?: () => void) {
		if (blocked || controller.current) return;
		try {
			if (!connection.baseUrl.trim())
				throw new Error('Set an API base URL in Settings before generating.');
			assertModelSupports(connection, input.model, 'images', input.images?.length ? ['image'] : []);
			if (!input.prompt.trim())
				throw new Error('Describe an image or the changes you want to make.');
		} catch (cause) {
			if (selection) setViewError(message(cause));
			else setError(message(cause));
			return;
		}
		const generation: Generation = {
			id: crypto.randomUUID(),
			kind: 'images',
			prompt: input.prompt,
			model: input.model,
			connectionId: connection.id,
			createdAt: Date.now(),
			status: 'pending',
			assets: [],
			parameters: {
				size: input.size || '',
				quality: input.quality || '',
				n: input.n || 1,
				operation: input.images?.length ? 'edit' : 'generate',
				...(input.imagePreset ? { imagePreset: input.imagePreset } : {}),
				...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
				...(input.source
					? {
							sourceGenerationId: input.source.generationId,
							sourceAssetIndex: input.source.assetIndex,
						}
					: {}),
			},
		};
		const abort = new AbortController();
		controller.current = abort;
		const finishActivity = beginActivity();
		const revision = navigation.current;
		retryRequests.current.set(generation.id, input);
		setActiveId(generation.id);
		setError('');
		setViewError('');
		onAdd(generation);
		onStarted?.();
		try {
			await onPrepareGeneration?.(generation, abort.signal);
			if (abort.signal.aborted) throw new DOMException('Request stopped.', 'AbortError');
			const { source: _, imagePreset: _preset, aspectRatio: _ratio, ...options } = input;
			const assets = await generateImages(
				connection,
				options,
				abort.signal,
				(moderationWarnings) => {
					onUpdate(generation.id, { moderationWarnings });
				},
			);
			if (abort.signal.aborted) throw new DOMException('Request stopped.', 'AbortError');
			onUpdate(generation.id, { status: 'completed', assets, error: undefined });
			retryRequests.current.delete(generation.id);
			if (mounted.current && revision === navigation.current) {
				setSelection({ generationId: generation.id, assetIndex: 0 });
				setSettings(false);
			}
		} catch (cause) {
			const text = abort.signal.aborted ? 'Request stopped.' : message(cause);
			onUpdate(generation.id, {
				status: abort.signal.aborted ? 'cancelled' : 'failed',
				error: text,
			});
			if (mounted.current && !abort.signal.aborted) {
				setError(text);
				if (selection) setViewError(text);
			}
		} finally {
			if (controller.current === abort) controller.current = null;
			if (mounted.current) setActiveId(null);
			finishActivity();
		}
	}
	function submit(event?: FormEvent) {
		event?.preventDefault();
		if (uploading || capabilityError) return;
		void execute(
			{
				model: model.trim(),
				prompt: prompt.trim(),
				size: size.trim() || undefined,
				quality: quality.trim() || undefined,
				imagePreset: imagePreset?.id,
				aspectRatio: aspectRatio?.id,
				n: count,
				images: references.length ? references : undefined,
				mask,
			},
			() => {
				setPrompt('');
				setReferences([]);
				setMask(undefined);
			},
		);
	}
	function editImage(editPrompt: string, options?: { mask?: Attachment; size?: string }) {
		if (!currentSource || !selection || editCapabilityError) return;
		void execute({
			model: model.trim(),
			prompt: editPrompt.trim(),
			size:
				options?.size || String(selected?.generation.parameters?.size || '').trim() || undefined,
			quality: quality.trim() || undefined,
			n: 1,
			images: [currentSource],
			mask: options?.mask,
			source: selection,
		});
	}
	async function upload(event: ChangeEvent<HTMLInputElement>, isMask = false) {
		const files = Array.from(event.target.files || []);
		event.target.value = '';
		if (!files.length || uploading) return;
		if (!isMask && references.length + files.length > MAX_REFERENCES) {
			setError('You can attach up to 16 reference images.');
			return;
		}
		const token = ++uploadToken.current;
		setUploading(true);
		try {
			assertModelSupports(connection, model.trim(), 'images', ['image']);
			const images = await Promise.all(files.map(readImage));
			if (!mounted.current || uploadToken.current !== token) return;
			if (isMask) setMask(images[0]);
			else setReferences((current) => [...current, ...images]);
			setError('');
		} catch (cause) {
			if (mounted.current && uploadToken.current === token) setError(message(cause));
		} finally {
			if (mounted.current && uploadToken.current === token) setUploading(false);
		}
	}
	async function retry(generation: Generation) {
		if (blocked || active) return;
		restoreSettings(generation);
		const cached = retryRequests.current.get(generation.id);
		if (cached && generation.connectionId === connection.id) {
			void execute(cached);
			return;
		}
		setPrompt(generation.prompt);
		setCount(Number(generation.parameters?.n) || 1);
		setReferences([]);
		setMask(undefined);
		const parentId = generation.parameters?.sourceGenerationId;
		const parent = history.find((item) => item.id === parentId);
		const assetIndex = Number(generation.parameters?.sourceAssetIndex) || 0;
		if (generation.parameters?.operation === 'edit') {
			if (parent?.assets[assetIndex]) {
				chooseImage(
					{ generation: parent, asset: parent.assets[assetIndex], assetIndex },
					{ preserveModel: true },
				);
				setViewError('Your previous edit was interrupted. Describe the edit again to retry.');
			} else {
				setError('Reattach the reference images and any mask, then send to retry this edit.');
				composerInput.current?.focus();
			}
			return;
		}
		setError('Your prompt is ready. Send it to try again.');
		composerInput.current?.focus();
	}
	function removeGeneration(id: string) {
		retryRequests.current.delete(id);
		if (selection?.generationId === id) closeViewer();
		onDelete(id);
	}

	return (
		<section className="image-playground" aria-label="Images playground">
			<header className="image-workspace-header">
				<h1>Images</h1>
				<button className="image-provider" onClick={onSettings}>
					{connection.name}
				</button>
			</header>
			<div className="image-workspace-scroll">
				<div className="image-landing-compose">
					<form className="image-composer" onSubmit={submit}>
						{!!references.length && (
							<div className="image-reference-list">
								{references.map((reference, index) => (
									<div className="image-reference" key={`${reference.name}-${index}`}>
										<img src={reference.dataUrl} alt={reference.name} />
										<button
											type="button"
											aria-label={`Remove ${reference.name}`}
											onClick={() => {
												setReferences((current) => current.filter((_, i) => i !== index));
												if (references.length === 1) setMask(undefined);
											}}
										>
											<X size={13} />
										</button>
									</div>
								))}
							</div>
						)}
						{mask && (
							<div className="image-mask-note">
								Mask: {mask.name}
								<button type="button" aria-label="Remove mask" onClick={() => setMask(undefined)}>
									<X size={13} />
								</button>
							</div>
						)}
						<textarea
							ref={composerInput}
							aria-label="Generation prompt"
							value={prompt}
							onChange={(event) => setPrompt(event.target.value)}
							placeholder={
								references.length
									? 'Describe the changes you want to make…'
									: 'Describe a new image…'
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
									aria-label="Add reference images"
									title={
										acceptsReferences
											? 'Add reference images'
											: 'This model does not accept reference images'
									}
									disabled={uploading || !acceptsReferences || active}
									onClick={() => uploadInput.current?.click()}
								>
									{uploading ? <LoaderCircle className="spin" size={18} /> : <Plus size={21} />}
								</button>
								<div className="image-settings-anchor" ref={settingsContainer}>
									<button
										type="button"
										className="image-icon-button"
										aria-label="Image settings"
										title="Image settings"
										aria-expanded={settings}
										onClick={() => setSettings(!settings)}
									>
										<Settings2 size={17} />
									</button>
									{settings && (
										<div
											className="image-options"
											role="region"
											aria-label="Image generation settings"
										>
											<div className="image-options-heading">
												<strong>Image settings</strong>
												<button
													type="button"
													className="image-icon-button"
													aria-label="Close image settings"
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
												Quality
												<Select
													aria-label="Quality"
													value={imageSettings.presetId}
													onChange={choosePreset}
													options={[
														...presets.map((preset) => ({ value: preset.id, label: preset.name })),
														{ value: '', label: 'Custom / provider settings' },
													]}
												/>
											</label>
											{imagePreset ? (
												<>
													<label>
														Aspect ratio
														<Select
															aria-label="Aspect ratio"
															value={imageSettings.aspectRatioId}
															onChange={(aspectRatioId) =>
																setStoredSettings({
																	...imageSettings,
																	aspectRatioId,
																})
															}
															options={imagePreset.aspectRatios.map((ratio) => ({
																value: ratio.id,
																label: `${ratio.name} · ${ratio.width} × ${ratio.height}`,
															}))}
														/>
													</label>
													{aspectRatio && (
														<div className="image-resolution">
															<span>Resolution</span>
															<output aria-label="Resolution">
																{aspectRatio.width} × {aspectRatio.height} px
															</output>
														</div>
													)}
												</>
											) : (
												<>
													<label>
														Size
														<input
															value={imageSettings.customSize}
															onChange={(event) =>
																setStoredSettings({
																	...imageSettings,
																	customSize: event.target.value,
																})
															}
															placeholder="Provider default"
														/>
													</label>
													<label>
														API quality
														<input
															value={imageSettings.customQuality}
															onChange={(event) =>
																setStoredSettings({
																	...imageSettings,
																	customQuality: event.target.value,
																})
															}
															placeholder="Provider default"
														/>
													</label>
													<p className="image-options-note">
														Leave blank to use your provider’s defaults.
													</p>
												</>
											)}
											<label>
												Number of images
												<Select
													aria-label="Number of images"
													value={String(count)}
													onChange={(next) => setCount(Number(next))}
													options={[1, 2, 3, 4, 6, 8, 10].map((value) => ({
														value: String(value),
														label: String(value),
													}))}
												/>
											</label>
											{!!references.length && (
												<button
													type="button"
													className="secondary-button image-mask-upload"
													disabled={uploading || !acceptsReferences || active}
													onClick={() => maskInput.current?.click()}
												>
													{mask ? 'Replace image mask' : 'Add image mask'}
												</button>
											)}
										</div>
									)}
								</div>
							</div>
							<div className="image-composer-actions">
								{picker()}
								{active ? (
									<button
										key="stop"
										type="button"
										className="image-send-button"
										aria-label="Stop request"
										onClick={(event) => {
											event.preventDefault();
											controller.current?.abort();
										}}
									>
										<Square size={16} fill="currentColor" />
									</button>
								) : (
									<button
										key="send"
										type="submit"
										className="image-send-button"
										aria-label={references.length ? 'Edit image' : 'Generate image'}
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
						className="image-gallery"
						aria-label="Your images"
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
												className="image-gallery-card"
												key={`${generation.id}:${assetIndex}`}
											>
												<button
													className="image-gallery-open"
													aria-label={`Open ${generation.prompt}${assetIndex ? ` (${assetIndex + 1})` : ''}`}
													onClick={() => chooseImage(item)}
												>
													<ImageThumbnail
														image={item}
														workspaceId={workspaceId}
														onRatio={(ratio) =>
															setAspectRatios((current) =>
																current[`${generation.id}:${assetIndex}`] === ratio
																	? current
																	: { ...current, [`${generation.id}:${assetIndex}`]: ratio },
															)
														}
													/>
													<ImageGalleryCaption prompt={generation.prompt} />
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
									return (
										<article className="image-gallery-card image-job-card" key={generation.id}>
											<div role={generation.status === 'failed' ? 'alert' : 'status'}>
												{generation.id === activeId ? (
													<LoaderCircle className="spin" size={26} />
												) : (
													<ImageIcon size={26} strokeWidth={1.5} />
												)}
												<strong>
													{generation.id === activeId
														? 'Creating your image…'
														: generation.status === 'failed'
															? 'Could not create image'
															: generation.status === 'pending'
																? 'Request interrupted'
																: 'Request stopped'}
												</strong>
												<p>{generation.prompt}</p>
												{generation.error && <span>{userFacingError(generation.error)}</span>}
											</div>
											{generation.id === activeId ? (
												<button
													className="image-job-action"
													onClick={() => controller.current?.abort()}
												>
													<Square size={13} /> Stop generation
												</button>
											) : (
												<button
													className="image-job-action"
													disabled={blocked || active}
													onClick={() => void retry(generation)}
												>
													<RotateCcw size={13} /> Retry generation
												</button>
											)}
											{generation.id !== activeId && (
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
						<ImageIcon size={38} strokeWidth={1.15} />
						<h2>Your imagination, in view.</h2>
						<p>
							Describe an image or add a reference to get started.
							<br />
							Your creations will appear here.
						</p>
					</div>
				)}
			</div>
			<input
				ref={uploadInput}
				className="image-upload-input"
				type="file"
				accept="image/*"
				multiple
				hidden
				onChange={(event) => void upload(event)}
			/>
			<input
				ref={maskInput}
				className="image-mask-input"
				type="file"
				accept="image/png"
				hidden
				onChange={(event) => void upload(event, true)}
			/>
			{selected && (
				<ImageViewer
					selectionKey={selectedIdentity}
					asset={selected.asset}
					source={currentSource}
					loading={sourceKey !== selectedIdentity || sourceLoading}
					error={sourceKey === selectedIdentity ? sourceError : ''}
					requestError={viewError}
					moderationWarnings={selected.generation.moderationWarnings}
					prompt={selected.generation.prompt}
					modelLabel={
						getModelDefinition(connection, selected.generation.model)?.name ||
						selected.generation.model
					}
					modelPicker={picker()}
					busy={active}
					blocked={blocked}
					capabilityError={editCapabilityError}
					index={selectedIndex}
					total={gallery.length}
					onClose={closeViewer}
					onPrevious={() => navigateImage(-1)}
					onNext={() => navigateImage(1)}
					onRetryLoad={() => setSourceAttempt((value) => value + 1)}
					onEdit={editImage}
					onStop={() => controller.current?.abort()}
				/>
			)}
		</section>
	);
}
