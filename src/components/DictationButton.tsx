import { userFacingError } from '../lib/user-facing-error';
import { useEffect, useRef, useState } from 'react';
import { ArrowUp, LoaderCircle, Mic, Square, X } from 'lucide-react';
import type { Connection, DictationSettings } from '../types';
import { transcribeAudio } from '../lib/api';
import DictationWaveform from './DictationWaveform';
import './dictation.css';

type Intent = 'insert' | 'send';
type Status = 'idle' | 'requesting' | 'recording' | 'transcribing';
interface Props {
	settings?: DictationSettings;
	connection?: Connection;
	scope: string;
	disabled?: boolean;
	canSend?: boolean;
	onActiveChange?: (active: boolean) => void;
	onTranscript: (text: string, intent: Intent) => void | Promise<void>;
	onConfigure: () => void;
}
type Origin = {
	scope: string;
	enabled?: boolean;
	model?: string;
	connectionId?: string;
	apiConnectionId?: string;
	endpoint?: string;
	apiKey?: string;
};
type Recording = {
	id: number;
	origin: Origin;
	controller: AbortController;
	intent: Intent;
	stopping: boolean;
	stream?: MediaStream;
	recorder?: MediaRecorder;
	timer?: ReturnType<typeof setTimeout>;
};

export default function DictationButton({
	settings,
	connection,
	scope,
	disabled,
	canSend = true,
	onActiveChange,
	onTranscript,
	onConfigure,
}: Props) {
	const [status, setStatus] = useState<Status>('idle');
	const [error, setError] = useState('');
	const [notice, setNotice] = useState(false);
	const phase = useRef<Status>('idle');
	const sequence = useRef(0);
	const operation = useRef<Recording | undefined>(undefined);
	const callbacks = useRef({ onActiveChange, onTranscript, onConfigure });
	callbacks.current = { onActiveChange, onTranscript, onConfigure };
	const context = useRef<Origin>({ scope });
	// Updating during render closes the gap before effect cleanup on navigation.
	context.current = {
		scope,
		enabled: settings?.enabled,
		model: settings?.model,
		connectionId: settings?.connectionId,
		apiConnectionId: connection?.id,
		endpoint: connection?.baseUrl,
		apiKey: connection?.apiKey,
	};
	const configured = !!(
		settings?.enabled &&
		settings.model.trim() &&
		connection &&
		settings.connectionId === connection.id
	);
	function current(recording: Recording) {
		const latest = context.current;
		return (
			operation.current === recording &&
			sequence.current === recording.id &&
			!recording.controller.signal.aborted &&
			recording.origin.scope === latest.scope &&
			recording.origin.enabled === latest.enabled &&
			recording.origin.model === latest.model &&
			recording.origin.connectionId === latest.connectionId &&
			recording.origin.apiConnectionId === latest.apiConnectionId &&
			recording.origin.endpoint === latest.endpoint &&
			recording.origin.apiKey === latest.apiKey
		);
	}
	function changeStatus(next: Status, update = true) {
		phase.current = next;
		if (update) setStatus(next);
		callbacks.current.onActiveChange?.(next !== 'idle');
	}
	function releaseCapture(recording: Recording) {
		clearTimeout(recording.timer);
		recording.stream?.getTracks().forEach((track) => track.stop());
	}
	function cancel(update = true) {
		sequence.current++;
		const recording = operation.current;
		operation.current = undefined;
		if (recording) {
			recording.controller.abort();
			try {
				if (recording.recorder && recording.recorder.state !== 'inactive')
					recording.recorder.stop();
			} catch {}
			releaseCapture(recording);
		}
		changeStatus('idle', update);
	}
	useEffect(() => {
		changeStatus('idle');
		setError('');
		setNotice(false);
		return () => cancel(false);
	}, [
		scope,
		settings?.enabled,
		settings?.connectionId,
		settings?.model,
		connection?.id,
		connection?.baseUrl,
		connection?.apiKey,
	]);
	function finish(intent: Intent, recording = operation.current) {
		if (
			!recording ||
			!current(recording) ||
			phase.current !== 'recording' ||
			recording.stopping ||
			!recording.recorder ||
			recording.recorder.state === 'inactive'
		)
			return;
		if (intent === 'send' && !canSend) return;
		recording.intent = intent;
		recording.stopping = true;
		changeStatus('transcribing');
		try {
			recording.recorder.stop();
		} catch {
			cancel();
			setError('Microphone recording failed. Please try again.');
		}
	}
	async function start() {
		if (disabled || phase.current !== 'idle' || operation.current) return;
		if (!configured) {
			setError('');
			setNotice(true);
			return;
		}
		if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
			setError('Microphone recording is unavailable in this environment.');
			return;
		}
		setError('');
		setNotice(false);
		const recording: Recording = {
			id: ++sequence.current,
			origin: { ...context.current },
			controller: new AbortController(),
			intent: 'insert',
			stopping: false,
		};
		operation.current = recording;
		changeStatus('requesting');
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			if (!current(recording)) {
				stream.getTracks().forEach((track) => track.stop());
				return;
			}
			recording.stream = stream;
			const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((type) =>
				MediaRecorder.isTypeSupported(type),
			);
			const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
			recording.recorder = recorder;
			const chunks: BlobPart[] = [];
			let bytes = 0;
			recorder.ondataavailable = (event) => {
				if (!current(recording)) return;
				if (event.data.size) {
					chunks.push(event.data);
					bytes += event.data.size;
				}
				if (bytes > 24 * 1024 * 1024 && !recording.stopping) finish('insert', recording);
			};
			recorder.onerror = () => {
				if (!current(recording)) return;
				cancel();
				setError('Microphone recording failed. Please try again.');
			};
			recorder.onstop = async () => {
				releaseCapture(recording);
				if (!current(recording)) return;
				recording.stopping = true;
				changeStatus('transcribing');
				try {
					const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
					if (!blob.size) throw new Error('No audio was recorded. Try recording again.');
					if (blob.size > 25 * 1024 * 1024)
						throw new Error('The recording is too large. Please record a shorter message.');
					const dataUrl = await new Promise<string>((resolve, reject) => {
						const reader = new FileReader();
						reader.onload = () => resolve(String(reader.result));
						reader.onerror = () =>
							reject(new Error('Could not read the recording. Try recording again.'));
						reader.readAsDataURL(blob);
					});
					if (!current(recording)) return;
					const text = await transcribeAudio(
						connection!,
						{
							model: settings!.model,
							audio: {
								name: `Dictation.${blob.type.includes('mp4') ? 'm4a' : 'webm'}`,
								type: blob.type,
								dataUrl,
							},
						},
						recording.controller.signal,
					);
					if (!current(recording)) return;
					if (!text.trim()) throw new Error('No speech was transcribed. Try recording again.');
					await callbacks.current.onTranscript(text.trim(), recording.intent);
				} catch (cause) {
					if (current(recording))
						setError(
							cause instanceof Error ? cause.message : 'Transcription failed. Try recording again.',
						);
				} finally {
					chunks.length = 0;
					if (current(recording)) {
						operation.current = undefined;
						changeStatus('idle');
					}
				}
			};
			recorder.start(1000);
			recording.timer = setTimeout(() => finish('insert', recording), 10 * 60_000);
			changeStatus('recording');
		} catch (cause) {
			if (!current(recording)) return;
			cancel();
			setError(
				cause instanceof DOMException && cause.name === 'NotAllowedError'
					? 'Microphone access was denied. Allow microphone access in system settings, then try again.'
					: cause instanceof DOMException && cause.name === 'NotFoundError'
						? 'No microphone was found. Connect a microphone, then try again.'
						: cause instanceof Error
							? cause.message
							: 'Microphone recording failed. Please try again.',
			);
		}
	}
	const active = status !== 'idle';
	return (
		<div className="dictation-control" data-active={active}>
			{active ? (
				<div
					className="dictation-session"
					role="group"
					aria-label="Dictation controls"
					data-status={status}
				>
					<button
						type="button"
						className="icon-button dictation-cancel"
						aria-label="Cancel dictation"
						title="Cancel dictation"
						onClick={() => cancel()}
					>
						<X size={18} />
					</button>
					<div className="dictation-status-area">
						{status === 'recording' && operation.current?.stream ? (
							<>
								<span className="dictation-sr-only" role="status">
									Recording
								</span>
								<DictationWaveform stream={operation.current.stream} />
							</>
						) : (
							<span className="dictation-status" role="status">
								<LoaderCircle size={17} className="spin" />
								{status === 'requesting' ? 'Waiting for microphone…' : 'Transcribing…'}
							</span>
						)}
					</div>
					{status === 'recording' && (
						<div className="dictation-finish-actions">
							<button
								type="button"
								className="icon-button dictation-insert"
								aria-label="Stop dictation"
								title="Stop recording and insert transcription"
								onClick={() => finish('insert')}
							>
								<Square size={15} fill="currentColor" />
							</button>
							<button
								type="button"
								className="dictation-send"
								aria-label="Transcribe and send"
								title="Transcribe and send message"
								disabled={!canSend}
								onClick={() => finish('send')}
							>
								<ArrowUp size={18} />
							</button>
						</div>
					)}
				</div>
			) : (
				<button
					type="button"
					className="icon-button dictation-button"
					disabled={disabled}
					aria-label={configured ? 'Start dictation' : 'Configure dictation'}
					title={configured ? 'Dictate a message' : 'Set up dictation'}
					onClick={() => void start()}
				>
					<Mic size={17} />
				</button>
			)}
			{notice && (
				<div
					className="dictation-notice"
					role="status"
					onKeyDown={(event) => {
						if (event.key === 'Escape') setNotice(false);
					}}
				>
					<button
						type="button"
						className="icon-button dictation-notice-close"
						aria-label="Dismiss dictation notice"
						onClick={() => setNotice(false)}
					>
						<X size={15} />
					</button>
					<p>
						Dictation needs a transcription model. Choose a model and enable dictation in Chat
						settings.
					</p>
					<button
						type="button"
						className="secondary-button"
						onClick={() => {
							setNotice(false);
							callbacks.current.onConfigure();
						}}
					>
						Open dictation settings
					</button>
				</div>
			)}
			{error && (
				<div className="dictation-notice dictation-error" role="alert">
					<p>{userFacingError(error)}</p>
					<button
						type="button"
						className="secondary-button"
						disabled={disabled}
						onClick={() => void start()}
					>
						Try dictation again
					</button>
				</div>
			)}
		</div>
	);
}
