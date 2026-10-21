import { userFacingError } from '../lib/user-facing-error';
import Select from './Select';
import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import {
	ArrowUp,
	AudioLines,
	Check,
	ChevronDown,
	Copy,
	Download,
	History,
	ImagePlus,
	Image as ImageIcon,
	LoaderCircle,
	Mic,
	Plus,
	RotateCcw,
	Settings2,
	Square,
	Trash2,
	Upload,
	Video,
	WandSparkles,
	X,
} from 'lucide-react';
import type { Attachment, Connection, Generation, MediaAsset } from '../types';
import { beginActivity } from '../lib/activities';
import { copyToClipboard } from '../lib/clipboard';
import {
	assertModelSupports,
	defaultModel,
	getModelDefinition,
	listModelChoices,
} from '../lib/catalog';
import {
	createVideo,
	downloadVideo,
	generateImages,
	generateSpeech,
	getVideo,
	transcribeAudio,
} from '../lib/api';
import './media.css';
import { currentWorkspaceId } from '../lib/workspace';
import {
	loadNavigationPreferences,
	saveNavigationPreferences,
} from '../lib/navigation-preferences';
import RemoteImageAsset, { requiresHostImage } from './RemoteImageAsset';

interface Props {
	blocked?: boolean;
	moderationWarning?: string;
	mode: 'images' | 'videos' | 'audio';
	connection: Connection;
	generations: Generation[];
	onAdd: (generation: Generation) => void;
	onPrepareGeneration?: (generation: Generation, signal: AbortSignal) => Promise<void>;
	onUpdate: (id: string, patch: Partial<Generation>) => void;
	onDelete: (id: string) => void;
	onSettings: () => void;
}

interface Operation {
	id: string;
	controller: AbortController;
	remoteId?: string;
	video: boolean;
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_AUDIO_VIDEO_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_REFERENCES = 16;

const suggestions = {
	images: [
		'A quiet cabin beside a misty lake, shot on film',
		'An editorial portrait in warm afternoon light',
		'A tiny botanical world inside a glass sphere',
	],
	videos: [
		'A slow cinematic flight over a sunlit coastline',
		'Rain falling on a neon-lit street at night',
		'A flower opening in a gentle time-lapse',
	],
	speech: [
		'Welcome to a little space for your next big idea.',
		'Take a breath. There is no need to rush this moment.',
		'The best stories begin with a simple question.',
	],
};

function readAttachment(file: File): Promise<Attachment> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
		reader.onload = () =>
			resolve({
				name: file.name,
				type: file.type || 'application/octet-stream',
				dataUrl: String(reader.result),
			});
		reader.readAsDataURL(file);
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function waitForPoll(signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(new DOMException('Cancelled', 'AbortError'));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(new DOMException('Cancelled', 'AbortError'));
		};
		const timer = window.setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, 4000);
		signal.addEventListener('abort', onAbort, { once: true });
	});
}

function AssetPreview({ asset, kind }: { asset: MediaAsset; kind: Generation['kind'] }) {
	if (kind === 'images')
		return (
			<img
				src={asset.url}
				alt={asset.name || 'Generated image'}
				className="media-generated-image"
			/>
		);
	if (kind === 'videos')
		return (
			<video
				src={asset.url}
				controls
				playsInline
				preload="metadata"
				className="media-generated-video"
			/>
		);
	if (asset.mimeType === 'audio/pcm' || asset.name.endsWith('.pcm'))
		return (
			<div className="media-audio-result media-raw-audio">
				<AudioLines size={30} strokeWidth={1.5} />
				<p>Your PCM audio is ready.</p>
				<span>Download to play this raw audio format in an audio editor.</span>
			</div>
		);
	return (
		<div className="media-audio-result">
			<div className="media-waveform" aria-hidden="true">
				{Array.from({ length: 36 }, (_, i) => (
					<span key={i} style={{ height: `${16 + Math.sin(i * 1.7) ** 2 * 45}px` }} />
				))}
			</div>
			<audio src={asset.url} controls preload="metadata" />
		</div>
	);
}

export function MediaPlayground({
	blocked = false,
	mode,
	connection,
	generations,
	onAdd,
	onPrepareGeneration,
	onUpdate,
	onDelete,
	onSettings,
}: Props) {
	const workspaceId = currentWorkspaceId();
	const [audioMode, setAudioModeState] = useState<'speech' | 'transcription'>(
		() => loadNavigationPreferences().audioMode,
	);
	function setAudioMode(next: 'speech' | 'transcription') {
		setAudioModeState(next);
		saveNavigationPreferences({ audioMode: next });
	}
	const [imagePrompt, setImagePrompt] = useState('');
	const [videoPrompt, setVideoPrompt] = useState('');
	const [speechInput, setSpeechInput] = useState('');
	const imageDefault = defaultModel(connection, 'images');
	const videoDefault = defaultModel(connection, 'videos');
	const speechDefault = defaultModel(connection, 'speech');
	const transcriptionDefault = defaultModel(connection, 'transcription');
	const [imageModel, setImageModel] = useState(imageDefault);
	const [videoModel, setVideoModel] = useState(videoDefault);
	const [speechModel, setSpeechModel] = useState(speechDefault);
	const [transcriptionModel, setTranscriptionModel] = useState(transcriptionDefault);
	const [imageSize, setImageSize] = useState('1024x1024');
	const [imageQuality, setImageQuality] = useState('');
	const [imageCount, setImageCount] = useState(1);
	const [references, setReferences] = useState<Attachment[]>([]);
	const [mask, setMask] = useState<Attachment | undefined>();
	const [videoReference, setVideoReference] = useState<Attachment | undefined>();
	const [videoSize, setVideoSize] = useState('1280x720');
	const [seconds, setSeconds] = useState('4');
	const [voice, setVoice] = useState('alloy');
	const [format, setFormat] = useState('mp3');
	const [speed, setSpeed] = useState(1);
	const [speechInstructions, setSpeechInstructions] = useState('');
	const [audioFile, setAudioFile] = useState<Attachment | undefined>();
	const [language, setLanguage] = useState('');
	const [transcriptionPrompt, setTranscriptionPrompt] = useState('');
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [activeId, setActiveId] = useState<string | null>(null);
	const [error, setError] = useState('');
	const [showSettings, setShowSettings] = useState(true);
	const [showHistory, setShowHistory] = useState(true);
	const [recording, setRecording] = useState(false);
	const [copied, setCopied] = useState(false);
	const operation = useRef<Operation | null>(null);
	const recorder = useRef<MediaRecorder | null>(null);
	const microphone = useRef<MediaStream | null>(null);
	const microphoneRequest = useRef(0);
	const microphonePending = useRef(false);
	const uploadPending = useRef(false);
	const currentView = useRef({ mode, audioMode, connectionId: connection.id });
	currentView.current = { mode, audioMode, connectionId: connection.id };
	const mounted = useRef(true);
	const uploadRef = useRef<HTMLInputElement>(null);
	const maskRef = useRef<HTMLInputElement>(null);
	const promptRef = useRef<HTMLTextAreaElement>(null);
	const copyTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	useEffect(() => {
		mounted.current = true;
		const stopForTransition = () => {
			operation.current?.controller.abort();
			microphoneRequest.current += 1;
			microphonePending.current = false;
			if (recorder.current?.state === 'recording') recorder.current.stop();
			microphone.current?.getTracks().forEach((track) => track.stop());
		};
		const removePrepareClose = window.desktop?.onPrepareClose(stopForTransition);
		window.addEventListener('freelm:workspace-changing', stopForTransition);
		return () => {
			window.removeEventListener('freelm:workspace-changing', stopForTransition);
			removePrepareClose?.();
			mounted.current = false;
			microphoneRequest.current += 1;
			operation.current?.controller.abort();
			if (recorder.current?.state === 'recording') recorder.current.stop();
			microphone.current?.getTracks().forEach((track) => track.stop());
			clearTimeout(copyTimeout.current);
		};
	}, []);

	useEffect(() => {
		setImageModel(imageDefault);
		setVideoModel(videoDefault);
		setSpeechModel(speechDefault);
		setTranscriptionModel(transcriptionDefault);
	}, [connection.id, imageDefault, videoDefault, speechDefault, transcriptionDefault]);

	useEffect(() => {
		setSelectedId(null);
		setError('');
		return () => {
			operation.current?.controller.abort();
		};
	}, [mode, connection.id]);

	useEffect(() => {
		if (
			(mode !== 'audio' || audioMode !== 'transcription') &&
			recorder.current?.state === 'recording'
		)
			recorder.current.stop();
		return () => {
			microphoneRequest.current += 1;
			microphonePending.current = false;
			if (recorder.current?.state === 'recording') recorder.current.stop();
		};
	}, [mode, audioMode, connection.id]);

	const kind = mode === 'audio' ? audioMode : mode;
	const model =
		kind === 'images'
			? imageModel
			: kind === 'videos'
				? videoModel
				: kind === 'speech'
					? speechModel
					: transcriptionModel;
	const setModel =
		kind === 'images'
			? setImageModel
			: kind === 'videos'
				? setVideoModel
				: kind === 'speech'
					? setSpeechModel
					: setTranscriptionModel;
	const prompt =
		kind === 'images'
			? imagePrompt
			: kind === 'videos'
				? videoPrompt
				: kind === 'speech'
					? speechInput
					: transcriptionPrompt;
	const setPrompt =
		kind === 'images'
			? setImagePrompt
			: kind === 'videos'
				? setVideoPrompt
				: kind === 'speech'
					? setSpeechInput
					: setTranscriptionPrompt;
	const history = generations
		.filter(
			(g) =>
				g.connectionId === connection.id &&
				(mode === 'audio' ? g.kind === 'speech' || g.kind === 'transcription' : g.kind === mode),
		)
		.sort((a, b) => b.createdAt - a.createdAt);
	const selected = history.find((g) => g.id === selectedId);
	const active = activeId !== null;
	const selectedActive = selected?.id === activeId;
	const TitleIcon = mode === 'images' ? ImageIcon : mode === 'videos' ? Video : AudioLines;
	const title = mode === 'images' ? 'Images' : mode === 'videos' ? 'Videos' : 'Audio';
	const modelDefinition = getModelDefinition(connection, model.trim());
	const modelChoices = listModelChoices(connection, kind);
	const acceptsReferences = !modelDefinition || modelDefinition.inputModalities.includes('image');
	let capabilityError = '';
	if (model.trim()) {
		try {
			assertModelSupports(
				connection,
				model.trim(),
				kind,
				(kind === 'images' && (references.length > 0 || mask)) ||
					(kind === 'videos' && videoReference)
					? ['image']
					: kind === 'transcription' && transcriptionPrompt.trim()
						? ['text']
						: [],
			);
		} catch (cause) {
			capabilityError = errorMessage(cause);
		}
	}

	async function pollVideo(id: string, remoteId: string, signal: AbortSignal) {
		const started = Date.now();
		while (!signal.aborted) {
			const job = await getVideo(connection, remoteId, signal);
			const status = job.status.toLowerCase();
			onUpdate(id, { remoteId: job.id || remoteId, progress: job.progress });
			if (['completed', 'succeeded', 'success'].includes(status)) {
				const asset = await downloadVideo(connection, remoteId, signal);
				onUpdate(id, { status: 'completed', progress: 100, assets: [asset], error: undefined });
				return;
			}
			if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) {
				throw new Error(
					typeof job.error === 'string' ? job.error : job.error?.message || `Video job ${status}.`,
				);
			}
			if (Date.now() - started > 20 * 60 * 1000) {
				onUpdate(id, {
					status: 'pending',
					error: 'This job is taking a while. Resume checking whenever you are ready.',
				});
				return;
			}
			await waitForPoll(signal);
		}
		throw new DOMException('Cancelled', 'AbortError');
	}

	async function execute(generation: Generation, resume = false) {
		if (blocked || operation.current) return;
		const finishActivity = beginActivity();
		const op: Operation = {
			id: generation.id,
			controller: new AbortController(),
			video: generation.kind === 'videos',
			remoteId: generation.remoteId,
		};
		operation.current = op;
		setActiveId(op.id);
		setSelectedId(op.id);
		setError('');
		const signal = op.controller.signal;
		try {
			await onPrepareGeneration?.(
				resume ? { ...generation, status: 'pending', error: undefined } : generation,
				signal,
			);
			if (signal.aborted) throw new DOMException('Request cancelled.', 'AbortError');
			if (resume && generation.remoteId) {
				onUpdate(op.id, { status: 'pending', error: undefined });
				await pollVideo(op.id, generation.remoteId, signal);
			} else if (generation.kind === 'images') {
				const assets = await generateImages(
					connection,
					{
						model: imageModel.trim(),
						prompt: imagePrompt.trim(),
						size: imageSize.trim() || undefined,
						quality: imageQuality.trim() || undefined,
						n: imageCount,
						images: references.length ? references : undefined,
						mask,
					},
					signal,
				);
				if (!assets.length)
					throw new Error(
						'The API returned no images. Check that this model supports image generation.',
					);
				onUpdate(op.id, { status: 'completed', assets });
			} else if (generation.kind === 'videos') {
				const job = await createVideo(
					connection,
					{
						model: videoModel.trim(),
						prompt: videoPrompt.trim(),
						size: videoSize.trim() || undefined,
						seconds: seconds || undefined,
						reference: videoReference,
					},
					signal,
				);
				if (!job.id) throw new Error('The API did not return a video job ID.');
				op.remoteId = job.id;
				onUpdate(op.id, { remoteId: job.id, progress: job.progress });
				if (['failed', 'error', 'cancelled', 'canceled'].includes(job.status.toLowerCase())) {
					throw new Error(
						typeof job.error === 'string'
							? job.error
							: job.error?.message || `Video job ${job.status}.`,
					);
				}
				if (['completed', 'succeeded', 'success'].includes(job.status.toLowerCase())) {
					const asset = await downloadVideo(connection, job.id, signal);
					onUpdate(op.id, { status: 'completed', progress: 100, assets: [asset] });
				} else await pollVideo(op.id, job.id, signal);
			} else if (generation.kind === 'speech') {
				const asset = await generateSpeech(
					connection,
					{
						model: speechModel.trim(),
						input: speechInput.trim(),
						voice: voice.trim(),
						format,
						speed,
						instructions: speechInstructions.trim() || undefined,
					},
					signal,
				);
				onUpdate(op.id, { status: 'completed', assets: [asset] });
			} else {
				if (!audioFile) throw new Error('Choose an audio file first.');
				const text = await transcribeAudio(
					connection,
					{
						model: transcriptionModel.trim(),
						audio: audioFile,
						language: language.trim() || undefined,
						prompt: transcriptionPrompt.trim() || undefined,
					},
					signal,
				);
				onUpdate(op.id, { status: 'completed', text });
			}
		} catch (cause) {
			if (signal.aborted) {
				onUpdate(
					op.id,
					op.video && op.remoteId
						? {
								status: 'pending',
								remoteId: op.remoteId,
								error: 'Checking paused. The provider may still be processing this video.',
							}
						: { status: 'cancelled', error: 'Request stopped.' },
				);
			} else {
				const message = errorMessage(cause);
				onUpdate(op.id, { status: 'failed', error: message });
			}
		} finally {
			if (operation.current === op) operation.current = null;
			if (mounted.current) setActiveId(null);
			finishActivity();
		}
	}

	function submit(event?: FormEvent) {
		if (blocked) {
			event?.preventDefault();
			return;
		}
		event?.preventDefault();
		if (active || recording) return;
		if (capabilityError) {
			setShowSettings(true);
			return;
		}
		if (!connection.baseUrl.trim()) {
			setError('Set an API base URL in Connections before generating.');
			return;
		}
		if (!model.trim()) {
			setError('Enter a model name in the settings panel.');
			setShowSettings(true);
			return;
		}
		if (kind === 'transcription' ? !audioFile : !prompt.trim()) {
			setError(
				kind === 'transcription'
					? 'Upload or record audio to transcribe.'
					: 'Add a prompt to get started.',
			);
			return;
		}
		if (kind === 'speech' && !voice.trim()) {
			setError('Enter a voice name.');
			return;
		}
		const parameters: Record<string, string | number> =
			kind === 'images'
				? {
						size: imageSize,
						quality: imageQuality,
						n: imageCount,
						operation: references.length ? 'edit' : 'generate',
					}
				: kind === 'videos'
					? { size: videoSize, seconds }
					: kind === 'speech'
						? { voice, format, speed, instructions: speechInstructions }
						: { language, context: transcriptionPrompt, filename: audioFile?.name || '' };
		const generation: Generation = {
			id: crypto.randomUUID(),
			kind,
			prompt: kind === 'transcription' ? audioFile!.name : prompt.trim(),
			model: model.trim(),
			connectionId: connection.id,
			createdAt: Date.now(),
			status: 'pending',
			assets: [],
			parameters,
		};
		onAdd(generation);
		void execute(generation);
	}

	async function upload(event: ChangeEvent<HTMLInputElement>, isMask = false) {
		const files = Array.from(event.target.files || []);
		event.target.value = '';
		if (!files.length) return;
		if (uploadPending.current) {
			setError('Please wait for the current files to finish loading.');
			return;
		}
		const maximumBytes = mode === 'images' || isMask ? MAX_IMAGE_BYTES : MAX_AUDIO_VIDEO_BYTES;
		const oversized = files.find((file) => file.size > maximumBytes);
		if (oversized) {
			setError(
				`“${oversized.name}” is too large. The limit is ${maximumBytes / 1024 / 1024} MB per file.`,
			);
			return;
		}
		if (mode === 'images' && !isMask && references.length + files.length > MAX_IMAGE_REFERENCES) {
			setError(
				`You can add up to ${MAX_IMAGE_REFERENCES} reference images. Remove an image before adding more.`,
			);
			return;
		}
		const sourceView = `${mode}:${audioMode}:${connection.id}`;
		uploadPending.current = true;
		try {
			const attachments = await Promise.all(files.map(readAttachment));
			const view = currentView.current;
			if (!mounted.current || sourceView !== `${view.mode}:${view.audioMode}:${view.connectionId}`)
				return;
			if (isMask) setMask(attachments[0]);
			else if (mode === 'images') setReferences((previous) => [...previous, ...attachments]);
			else if (mode === 'videos') setVideoReference(attachments[0]);
			else setAudioFile(attachments[0]);
			setError('');
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			uploadPending.current = false;
		}
	}

	async function toggleRecording() {
		if (recorder.current?.state === 'recording') {
			recorder.current.stop();
			return;
		}
		if (microphonePending.current || mode !== 'audio' || audioMode !== 'transcription') return;
		if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
			setError('Microphone recording is unavailable here. Upload an audio file instead.');
			return;
		}
		const requestId = ++microphoneRequest.current;
		microphonePending.current = true;
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			const view = currentView.current;
			if (
				!mounted.current ||
				requestId !== microphoneRequest.current ||
				view.mode !== 'audio' ||
				view.audioMode !== 'transcription' ||
				view.connectionId !== connection.id
			) {
				stream.getTracks().forEach((track) => track.stop());
				return;
			}
			microphone.current = stream;
			const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((type) =>
				MediaRecorder.isTypeSupported(type),
			);
			const next = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
			const chunks: BlobPart[] = [];
			next.ondataavailable = (event) => {
				if (event.data.size) chunks.push(event.data);
			};
			next.onstop = () => {
				stream.getTracks().forEach((track) => track.stop());
				if (!mounted.current) return;
				setRecording(false);
				const type = next.mimeType || 'audio/webm';
				const file = new File(
					chunks,
					`Recording-${new Date().toISOString().replaceAll(':', '-')}.${type.includes('mp4') ? 'm4a' : 'webm'}`,
					{ type },
				);
				void readAttachment(file)
					.then(setAudioFile)
					.catch((cause) => setError(errorMessage(cause)));
			};
			next.onerror = () => {
				stream.getTracks().forEach((track) => track.stop());
				setRecording(false);
				setError('Microphone recording failed. Try uploading an audio file.');
			};
			recorder.current = next;
			next.start();
			setRecording(true);
			setError('');
		} catch (cause) {
			if (requestId === microphoneRequest.current) {
				microphone.current?.getTracks().forEach((track) => track.stop());
				if (mounted.current) setError(`Could not access the microphone: ${userFacingError(cause)}`);
			}
		} finally {
			if (requestId === microphoneRequest.current) microphonePending.current = false;
		}
	}

	function openGeneration(generation: Generation) {
		setSelectedId(generation.id);
		setError('');
		const p = generation.parameters || {};
		if (generation.kind === 'images') {
			setImagePrompt(generation.prompt);
			setImageModel(generation.model);
			setImageSize(String(p.size ?? ''));
			setImageQuality(String(p.quality ?? ''));
			setImageCount(Number(p.n) || 1);
			setReferences([]);
			setMask(undefined);
		} else if (generation.kind === 'videos') {
			setVideoPrompt(generation.prompt);
			setVideoModel(generation.model);
			setVideoSize(String(p.size ?? ''));
			setSeconds(String(p.seconds ?? ''));
			setVideoReference(undefined);
		} else if (generation.kind === 'speech') {
			setAudioMode('speech');
			setSpeechInput(generation.prompt);
			setSpeechModel(generation.model);
			setVoice(String(p.voice ?? 'alloy'));
			setFormat(String(p.format ?? 'mp3'));
			setSpeed(Number(p.speed) || 1);
			setSpeechInstructions(String(p.instructions ?? ''));
		} else {
			setAudioMode('transcription');
			setTranscriptionModel(generation.model);
			setLanguage(String(p.language ?? ''));
			setTranscriptionPrompt(String(p.context ?? ''));
			setAudioFile(undefined);
		}
	}

	function newGeneration() {
		setSelectedId(null);
		setError('');
		setPrompt('');
		if (mode === 'images') {
			setReferences([]);
			setMask(undefined);
		}
		if (mode === 'videos') setVideoReference(undefined);
		if (kind === 'transcription') setAudioFile(undefined);
		promptRef.current?.focus();
	}

	async function copyText(text: string) {
		try {
			await copyToClipboard(text);
			setCopied(true);
			clearTimeout(copyTimeout.current);
			copyTimeout.current = setTimeout(() => setCopied(false), 2000);
		} catch {
			setError('Could not copy to clipboard. Select the transcript text to copy it manually.');
		}
	}

	const inputFiles =
		mode === 'images'
			? references
			: mode === 'videos'
				? videoReference
					? [videoReference]
					: []
				: audioFile
					? [audioFile]
					: [];
	const actionLabel =
		kind === 'images'
			? references.length
				? 'Edit image'
				: 'Generate image'
			: kind === 'videos'
				? 'Generate video'
				: kind === 'speech'
					? 'Generate speech'
					: 'Transcribe';

	return (
		<section className="media-workspace" aria-label={`${title} playground`}>
			<header className="media-header">
				<div className="media-header-title">
					<TitleIcon size={20} strokeWidth={1.65} />
					<h1>{title}</h1>
					<span className="media-playground-label">Playground</span>
				</div>
				<div className="media-header-actions">
					<button
						className="media-connection"
						onClick={onSettings}
						title="Configure API connection"
					>
						<span className="media-connection-dot" />
						{connection.name}
						<ChevronDown size={13} />
					</button>
					<button
						className={`media-icon-button ${showHistory ? 'is-selected' : ''}`}
						onClick={() => setShowHistory(!showHistory)}
						aria-label="Toggle generation history"
						title="History"
					>
						<History size={17} />
					</button>
					<button
						className={`media-icon-button ${showSettings ? 'is-selected' : ''}`}
						onClick={() => setShowSettings(!showSettings)}
						aria-label="Toggle generation settings"
						title="Generation settings"
					>
						<Settings2 size={17} />
					</button>
				</div>
			</header>

			{mode === 'audio' && (
				<div className="media-audio-tabs" role="tablist" aria-label="Audio task">
					<button
						role="tab"
						aria-selected={audioMode === 'speech'}
						onClick={() => {
							setAudioMode('speech');
							setSelectedId(null);
							setError('');
						}}
					>
						<AudioLines size={16} />
						Text to speech
					</button>
					<button
						role="tab"
						aria-selected={audioMode === 'transcription'}
						onClick={() => {
							setAudioMode('transcription');
							setSelectedId(null);
							setError('');
						}}
					>
						<Mic size={16} />
						Transcription
					</button>
				</div>
			)}

			<div className={`media-body ${showSettings ? 'has-settings' : ''}`}>
				<div className="media-main">
					<div className={`media-canvas ${selected ? 'has-result' : ''}`}>
						{selected ? (
							<div className="media-result">
								<div className="media-result-heading">
									<span>{selected.kind === 'transcription' ? 'Transcript' : 'Your creation'}</span>
									<button className="media-text-button" onClick={newGeneration}>
										<Plus size={15} />
										New
									</button>
								</div>
								{selected.status === 'completed' ? (
									<>
										{selected.assets.length > 0 && (
											<div
												className={`media-assets ${selected.assets.length > 1 ? 'multiple' : ''}`}
											>
												{selected.assets.map((asset, index) =>
													selected.kind === 'images' &&
													requiresHostImage(workspaceId, asset.url) ? (
														<RemoteImageAsset
															key={`${workspaceId}:${selected.id}:${index}:${asset.url}`}
															asset={asset}
															workspaceId={workspaceId}
															connectionId={selected.connectionId}
														/>
													) : (
														<div className="media-asset" key={`${selected.id}-${index}`}>
															<AssetPreview asset={asset} kind={selected.kind} />
															<a
																className="media-download"
																href={asset.url}
																download={asset.name}
																target={/^(data:|blob:)/.test(asset.url) ? undefined : '_blank'}
																rel="noreferrer"
																aria-label={`Download ${asset.name}`}
																title="Download"
															>
																<Download size={16} />
															</a>
														</div>
													),
												)}
											</div>
										)}
										{selected.text !== undefined && (
											<div className="media-transcript">
												<p>{selected.text || 'No speech was detected.'}</p>
												<div className="media-transcript-actions">
													<button
														className="media-text-button"
														onClick={() => void copyText(selected.text!)}
													>
														{copied ? <Check size={15} /> : <Copy size={15} />}
														{copied ? 'Copied' : 'Copy text'}
													</button>
													<a
														className="media-text-button"
														href={`data:text/plain;charset=utf-8,${encodeURIComponent(selected.text)}`}
														download="transcript.txt"
													>
														<Download size={15} />
														Download
													</a>
												</div>
											</div>
										)}
										<div className="media-result-caption">
											<p>{selected.prompt}</p>
											<span>
												{getModelDefinition(connection, selected.model)?.name || selected.model} ·{' '}
												{new Date(selected.createdAt).toLocaleString(undefined, {
													month: 'short',
													day: 'numeric',
													hour: 'numeric',
													minute: '2-digit',
												})}
											</span>
										</div>
									</>
								) : (
									<div className="media-job-state" aria-live="polite">
										{selectedActive ? (
											<LoaderCircle className="media-spin" size={30} strokeWidth={1.5} />
										) : (
											<TitleIcon size={30} strokeWidth={1.5} />
										)}
										<h2>
											{selectedActive
												? selected.kind === 'videos'
													? 'Bringing your scene to life'
													: selected.kind === 'images'
														? 'Creating your image'
														: selected.kind === 'speech'
															? 'Finding your voice'
															: 'Listening to your audio'
												: selected.status === 'failed'
													? 'Something went wrong'
													: selected.status === 'cancelled'
														? 'Request stopped'
														: 'Video job saved'}
										</h2>
										<p>
											{selectedActive
												? selected.kind === 'videos'
													? 'This can take a few minutes. Your job is saved as it progresses.'
													: 'Your API is processing this request.'
												: (selected.error && userFacingError(selected.error)) ||
													(selected.remoteId
														? 'Resume checking to get the latest result from your provider.'
														: 'This request was interrupted. Submit it again to retry.')}
										</p>
										{selected.kind === 'videos' && selected.progress !== undefined && (
											<div className="media-progress">
												<progress max={100} value={Math.max(0, Math.min(100, selected.progress))} />
												<span>{Math.round(selected.progress)}%</span>
											</div>
										)}
										{selectedActive ? (
											<button
												className="media-secondary-button"
												onClick={() => operation.current?.controller.abort()}
											>
												<Square size={13} />
												{selected.kind === 'videos' ? 'Pause checking' : 'Stop request'}
											</button>
										) : (
											selected.remoteId && (
												<button
													className="media-secondary-button"
													disabled={blocked || active}
													onClick={() => void execute(selected, true)}
												>
													<RotateCcw size={15} />
													Resume checking
												</button>
											)
										)}
										{selected.remoteId && <small>Job {selected.remoteId}</small>}
									</div>
								)}
							</div>
						) : (
							<div className="media-empty">
								<div className="media-empty-symbol">
									<TitleIcon size={35} strokeWidth={1.2} />
								</div>
								<h2>
									{kind === 'images'
										? 'What will you imagine?'
										: kind === 'videos'
											? 'Give your ideas motion.'
											: kind === 'speech'
												? 'Bring your words to life.'
												: 'Every word, captured.'}
								</h2>
								<p>
									{kind === 'images'
										? 'Create something new, or add an image to make it your own.'
										: kind === 'videos'
											? 'Turn a moment in your imagination into a moving picture.'
											: kind === 'speech'
												? 'Natural voices. Your words. A little more expression.'
												: 'Upload an audio file or record a thought to turn it into text.'}
								</p>
								{kind === 'transcription' ? (
									<div className="media-upload-zone">
										<button
											className="media-secondary-button"
											onClick={() => uploadRef.current?.click()}
										>
											<Upload size={16} />
											Choose audio file
										</button>
										<span>Audio or video with spoken words</span>
										<button
											className={`media-text-button ${recording ? 'is-recording' : ''}`}
											onClick={() => void toggleRecording()}
										>
											{recording ? <Square size={14} /> : <Mic size={15} />}
											{recording ? 'Stop recording' : 'Record with microphone'}
										</button>
									</div>
								) : (
									<div className="media-suggestions">
										{suggestions[kind].map((suggestion) => (
											<button
												key={suggestion}
												onClick={() => {
													setPrompt(suggestion);
													promptRef.current?.focus();
												}}
											>
												<WandSparkles size={14} />
												<span>{suggestion}</span>
											</button>
										))}
									</div>
								)}
							</div>
						)}
					</div>

					<div className="media-compose-area">
						{capabilityError && (
							<div className="media-form-error media-capability-error" role="alert">
								<span>{userFacingError(capabilityError)}</span>
								<button className="media-text-button" onClick={() => setShowSettings(true)}>
									Choose model
								</button>
							</div>
						)}
						{error && (
							<div className="media-form-error" role="alert">
								<span>{userFacingError(error)}</span>
								<button
									className="media-icon-button"
									onClick={() => setError('')}
									aria-label="Dismiss error"
								>
									<X size={15} />
								</button>
							</div>
						)}
						{active && !selectedActive && (
							<button className="media-active-banner" onClick={() => setSelectedId(activeId)}>
								<LoaderCircle size={14} className="media-spin" />A request is running · View
								progress
							</button>
						)}
						<form className="media-composer" onSubmit={submit}>
							{inputFiles.length > 0 && (
								<div className="media-attached-files">
									{inputFiles.map((file, index) => (
										<div className="media-attached-file" key={`${file.name}-${index}`}>
											{file.type.startsWith('image/') ? (
												<img src={file.dataUrl} alt="Reference" />
											) : (
												<AudioLines size={19} />
											)}
											<span title={file.name}>{file.name}</span>
											<button
												type="button"
												aria-label={`Remove ${file.name}`}
												onClick={() => {
													if (mode === 'images') {
														setReferences((current) => current.filter((_, i) => i !== index));
														if (references.length === 1) setMask(undefined);
													} else if (mode === 'videos') setVideoReference(undefined);
													else setAudioFile(undefined);
												}}
											>
												<X size={13} />
											</button>
										</div>
									))}
								</div>
							)}
							{mask && mode === 'images' && (
								<div className="media-mask-chip">
									Mask: {mask.name}
									<button type="button" aria-label="Remove mask" onClick={() => setMask(undefined)}>
										<X size={12} />
									</button>
								</div>
							)}
							{kind === 'transcription' && audioFile && (
								<audio
									className="media-input-audio"
									src={audioFile.dataUrl}
									controls
									preload="metadata"
								/>
							)}
							<textarea
								ref={promptRef}
								value={prompt}
								onChange={(event) => setPrompt(event.target.value)}
								rows={kind === 'speech' ? 3 : 2}
								placeholder={
									kind === 'images'
										? references.length
											? 'Describe the changes you want to make…'
											: 'Describe an image…'
										: kind === 'videos'
											? 'Describe your scene, motion, and style…'
											: kind === 'speech'
												? 'Write something to say…'
												: 'Add context or vocabulary to help transcription (optional)…'
								}
								aria-label={
									kind === 'speech'
										? 'Text to speak'
										: kind === 'transcription'
											? 'Transcription context'
											: 'Generation prompt'
								}
								onKeyDown={(event) => {
									if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
										event.preventDefault();
										submit();
									}
								}}
							/>
							<div className="media-composer-footer">
								<div className="media-composer-tools">
									{kind !== 'speech' && (
										<button
											type="button"
											className="media-tool-button"
											onClick={() => uploadRef.current?.click()}
											disabled={kind !== 'transcription' && !acceptsReferences}
											title={
												kind === 'transcription'
													? 'Upload audio'
													: acceptsReferences
														? 'Add reference image'
														: 'This model does not accept reference images'
											}
										>
											<Plus size={18} />
											<span>{kind === 'transcription' ? 'Audio' : 'Reference'}</span>
										</button>
									)}
									{kind === 'images' && references.length > 0 && (
										<button
											type="button"
											className="media-tool-button"
											onClick={() => maskRef.current?.click()}
											disabled={!acceptsReferences}
										>
											<ImagePlus size={16} />
											<span>Mask</span>
										</button>
									)}
									{kind === 'transcription' && (
										<button
											type="button"
											className={`media-icon-button ${recording ? 'is-recording' : ''}`}
											onClick={() => void toggleRecording()}
											aria-label={recording ? 'Stop recording' : 'Record audio'}
										>
											{recording ? <Square size={16} /> : <Mic size={17} />}
										</button>
									)}
									<span className="media-current-model" title={model}>
										{modelDefinition?.name || model || 'Choose a model'}
									</span>
								</div>
								<button
									type="submit"
									className="media-generate-button"
									disabled={
										blocked ||
										Boolean(capabilityError) ||
										active ||
										recording ||
										(kind === 'transcription' ? !audioFile : !prompt.trim())
									}
								>
									<span>{actionLabel}</span>
									{active ? (
										<LoaderCircle size={16} className="media-spin" />
									) : (
										<ArrowUp size={17} />
									)}
								</button>
							</div>
						</form>
						<div className="media-composer-note">
							{kind === 'images' && references.length
								? 'Edits use your reference images. A mask is optional.'
								: kind === 'videos'
									? 'Video generation runs on your provider. Pausing only stops local checks.'
									: kind === 'transcription'
										? 'Your audio is sent to the selected API for transcription.'
										: `Generated with your ${connection.name} connection.`}
						</div>
					</div>

					{showHistory && history.length > 0 && (
						<div className="media-history">
							<div className="media-history-heading">
								<span>
									Recent creations <span>{history.length}</span>
								</span>
								<button className="media-text-button" onClick={newGeneration}>
									<Plus size={14} />
									New
								</button>
							</div>
							<div className="media-history-items">
								{history.map((generation) => (
									<div
										className={`media-history-item ${selectedId === generation.id ? 'is-current' : ''}`}
										key={generation.id}
									>
										<button
											className="media-history-open"
											onClick={() => openGeneration(generation)}
											aria-label={`Open ${generation.prompt}`}
										>
											<div className="media-history-thumb">
												{generation.kind === 'images' &&
												generation.assets[0] &&
												!requiresHostImage(workspaceId, generation.assets[0].url) ? (
													<img src={generation.assets[0].url} alt="" loading="lazy" />
												) : generation.id === activeId ? (
													<LoaderCircle size={19} className="media-spin" />
												) : generation.kind === 'videos' ? (
													<Video size={19} />
												) : generation.kind === 'images' ? (
													<ImageIcon size={19} />
												) : (
													<AudioLines size={19} />
												)}
											</div>
											<span className="media-history-description">
												<strong>{generation.prompt}</strong>
												<small>
													{generation.id === activeId
														? 'Generating…'
														: generation.status === 'pending'
															? 'Paused · resume available'
															: generation.status === 'completed'
																? generation.kind === 'transcription'
																	? 'Transcription'
																	: getModelDefinition(connection, generation.model)?.name ||
																		generation.model
																: generation.status === 'failed'
																	? 'Failed'
																	: 'Stopped'}
												</small>
											</span>
										</button>
										<button
											className="media-history-delete"
											disabled={generation.id === activeId}
											title="Delete from history"
											aria-label={`Delete ${generation.prompt} from history`}
											onClick={() => {
												onDelete(generation.id);
												if (selectedId === generation.id) setSelectedId(null);
											}}
										>
											<Trash2 size={13} />
										</button>
									</div>
								))}
							</div>
						</div>
					)}
				</div>

				{showSettings && (
					<aside className="media-settings" aria-label="Generation settings">
						<div className="media-settings-heading">
							<span>Settings</span>
							<Settings2 size={15} />
						</div>
						<label className="media-field">
							Model
							<input
								list={`media-models-${kind}`}
								value={model}
								onChange={(event) => setModel(event.target.value)}
								placeholder="Enter a model ID"
								spellCheck={false}
							/>
						</label>
						<datalist id={`media-models-${kind}`}>
							{modelChoices.map((choice) => (
								<option key={choice.id} value={choice.id} label={choice.name} />
							))}
						</datalist>
						{modelDefinition ? (
							<div className="media-model-capabilities" aria-label="Model capabilities">
								<strong>{modelDefinition.name}</strong>
								<dl>
									<dt>Input</dt>
									<dd>{modelDefinition.inputModalities.join(', ') || 'None configured'}</dd>
									<dt>Output</dt>
									<dd>{modelDefinition.outputModalities.join(', ') || 'None configured'}</dd>
								</dl>
							</div>
						) : (
							<p className="media-field-note">
								Use any model supported by your API. Add it to your catalog to set its capabilities.
							</p>
						)}
						<div className="media-settings-divider" />
						{kind === 'images' && (
							<>
								<label className="media-field">
									Size
									<input
										list="media-image-sizes"
										value={imageSize}
										onChange={(event) => setImageSize(event.target.value)}
										placeholder="Provider default"
									/>
									<span className="media-control-hint">Width × height in pixels, or auto</span>
								</label>
								<datalist id="media-image-sizes">
									<option value="auto" />
									<option value="1024x1024" />
									<option value="1536x1024" />
									<option value="1024x1536" />
									<option value="1792x1024" />
									<option value="1024x1792" />
								</datalist>
								<label className="media-field">
									Quality
									<input
										list="media-image-qualities"
										value={imageQuality}
										onChange={(event) => setImageQuality(event.target.value)}
										placeholder="Provider default"
									/>
								</label>
								<datalist id="media-image-qualities">
									<option value="auto" />
									<option value="low" />
									<option value="medium" />
									<option value="high" />
									<option value="standard" />
									<option value="hd" />
								</datalist>
								<label className="media-field">
									Number of images
									<Select
										aria-label="Number of images"
										value={String(imageCount)}
										onChange={(next) => setImageCount(Number(next))}
										options={[1, 2, 3, 4, 6, 8, 10].map((count) => ({
											value: String(count),
											label: `${count} ${count === 1 ? 'image' : 'images'}`,
										}))}
									/>
								</label>
								<div className="media-settings-tip">
									<ImagePlus size={17} />
									<p>
										Add a reference image to switch to editing. Add a transparent PNG mask to choose
										the area to change.
									</p>
								</div>
							</>
						)}
						{kind === 'videos' && (
							<>
								<label className="media-field">
									Resolution
									<input
										list="media-video-sizes"
										value={videoSize}
										onChange={(event) => setVideoSize(event.target.value)}
										placeholder="Provider default"
									/>
								</label>
								<datalist id="media-video-sizes">
									<option value="1280x720" />
									<option value="720x1280" />
									<option value="1792x1024" />
									<option value="1024x1792" />
								</datalist>
								<label className="media-field">
									Duration
									<input
										type="number"
										min="1"
										step="1"
										value={seconds}
										onChange={(event) => setSeconds(event.target.value)}
										placeholder="Provider default"
									/>
									<span className="media-control-hint">Seconds</span>
								</label>
								<div className="media-settings-tip">
									<Video size={17} />
									<p>
										Available resolutions and durations depend on your model. An optional reference
										image can guide the first frame.
									</p>
								</div>
							</>
						)}
						{kind === 'speech' && (
							<>
								<label className="media-field">
									Voice
									<input
										list="media-voices"
										value={voice}
										onChange={(event) => setVoice(event.target.value)}
										placeholder="Enter a voice ID"
									/>
								</label>
								<datalist id="media-voices">
									{[
										'alloy',
										'ash',
										'ballad',
										'coral',
										'echo',
										'fable',
										'nova',
										'onyx',
										'sage',
										'shimmer',
										'verse',
									].map((value) => (
										<option key={value} value={value} />
									))}
								</datalist>
								<label className="media-field">
									Format
									<Select
										aria-label="Format"
										value={format}
										onChange={setFormat}
										options={['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'].map((value) => ({
											value,
											label: value.toUpperCase(),
										}))}
									/>
								</label>
								<label className="media-field">
									Speed{' '}
									<span className="media-range-value">{speed.toFixed(2).replace(/0$/, '')}×</span>
									<input
										type="range"
										min="0.25"
										max="4"
										step="0.05"
										value={speed}
										onChange={(event) => setSpeed(Number(event.target.value))}
									/>
								</label>
								<label className="media-field">
									Voice instructions
									<textarea
										rows={3}
										value={speechInstructions}
										onChange={(event) => setSpeechInstructions(event.target.value)}
										placeholder="e.g. Warm and conversational"
									/>
									<span className="media-control-hint">Optional, when supported by your model</span>
								</label>
							</>
						)}
						{kind === 'transcription' && (
							<>
								<label className="media-field">
									Language
									<input
										value={language}
										onChange={(event) => setLanguage(event.target.value)}
										placeholder="Auto-detect"
									/>
									<span className="media-control-hint">
										Optional language code, such as en or es
									</span>
								</label>
								<div className="media-settings-tip">
									<Mic size={17} />
									<p>
										Upload audio or video, or record using your microphone. Add names or specialist
										terms as context for better results.
									</p>
								</div>
							</>
						)}
						<div className="media-provider-footnote">
							<span>API connection</span>
							<button onClick={onSettings}>
								{connection.name}
								<ChevronDown size={12} />
							</button>
						</div>
					</aside>
				)}
			</div>
			<input
				className="media-file-input"
				ref={uploadRef}
				type="file"
				accept={mode === 'audio' ? 'audio/*,video/*' : 'image/*'}
				multiple={mode === 'images'}
				onChange={(event) => void upload(event)}
				aria-label={mode === 'audio' ? 'Upload audio file' : 'Upload reference image'}
			/>
			<input
				className="media-file-input"
				ref={maskRef}
				type="file"
				accept="image/png"
				onChange={(event) => void upload(event, true)}
				aria-label="Upload image mask"
			/>
		</section>
	);
}
