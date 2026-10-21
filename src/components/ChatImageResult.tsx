import { userFacingError } from '../lib/user-facing-error';
import { useMemo, useState, type CSSProperties } from 'react';
import { ImageOff } from 'lucide-react';
import type { ToolCallRecord } from '../agent-types';
import type { Attachment, MediaAsset } from '../types';
import ImageViewer from './ImageViewer';
import ModerationNotice from './ModerationNotice';
import './chat-image-result.css';

type ResultImage = Extract<
	NonNullable<ToolCallRecord['result']>['content'][number],
	{ type: 'image' }
>;
const noop = () => {};

function imageRatio(size: unknown) {
	const match = typeof size === 'string' && /^(\d+)x(\d+)$/i.exec(size);
	if (!match) return 1;
	const ratio = Number(match[1]) / Number(match[2]);
	return Number.isFinite(ratio) && ratio > 0 ? Math.max(0.25, Math.min(4, ratio)) : 1;
}

function ImagePlaceholder({
	label,
	ratio,
	animate = true,
}: {
	label: string;
	ratio: number;
	animate?: boolean;
}) {
	return (
		<div
			className={`chat-image-placeholder${animate ? ' is-creating' : ''}`}
			style={{ aspectRatio: ratio }}
			role="status"
			aria-label={label}
		>
			<div className="chat-image-dots" aria-hidden="true" />
			<span className={animate ? 'activity-shimmer' : undefined}>{label}</span>
		</div>
	);
}

function ResultImageButton({
	image,
	ratio,
	onOpen,
	index,
	total,
}: {
	image: ResultImage;
	ratio: number;
	onOpen: () => void;
	index: number;
	total: number;
}) {
	const [loaded, setLoaded] = useState(false);
	const [failed, setFailed] = useState(false);
	const [retry, setRetry] = useState(0);
	if (failed)
		return (
			<div className="chat-image-load-error" role="alert">
				<ImageOff size={20} />
				<span>This image could not be displayed.</span>
				<button
					className="secondary-button"
					onClick={() => {
						setFailed(false);
						setLoaded(false);
						setRetry(retry + 1);
					}}
				>
					Retry image
				</button>
			</div>
		);
	return (
		<div className="chat-image-result-item" style={loaded ? undefined : { aspectRatio: ratio }}>
			{!loaded && <ImagePlaceholder label="Loading image…" ratio={ratio} />}
			<button
				type="button"
				className="chat-image-open"
				onClick={onOpen}
				disabled={!loaded}
				aria-label={`Open generated image${total > 1 ? ` ${index + 1}` : ''}`}
				title="Open generated image"
				style={!loaded ? { position: 'absolute', inset: 0, opacity: 0 } : undefined}
			>
				<img
					key={retry}
					src={image.dataUrl}
					alt={image.name || 'Generated image'}
					decoding="async"
					onLoad={() => setLoaded(true)}
					onError={() => setFailed(true)}
				/>
			</button>
		</div>
	);
}

export default function ChatImageResult({
	call,
	args,
	live,
}: {
	call: ToolCallRecord;
	args: Record<string, unknown>;
	live: boolean;
}) {
	const [selected, setSelected] = useState<number | null>(null);
	const images = useMemo(
		() => call.result?.content.filter((item) => item.type === 'image') || [],
		[call.result],
	);
	const failed = call.status === 'failed' || call.status === 'denied' || !!call.result?.isError;
	const active = !failed && live && (call.status === 'running' || call.status === 'approval');
	const ratio = imageRatio(args.size);
	const image = selected === null ? undefined : images[selected];
	const source = useMemo<Attachment | null>(
		() =>
			image
				? {
						name: image.name || 'freelm-image.png',
						type: /^data:([^;,]+)/.exec(image.dataUrl)?.[1] || 'image/png',
						dataUrl: image.dataUrl,
					}
				: null,
		[image],
	);
	const asset = useMemo<MediaAsset | null>(
		() => (source ? { name: source.name, mimeType: source.type, url: source.dataUrl } : null),
		[source],
	);
	const outputText =
		failed || !images.length
			? call.result?.content
					.filter((item) => item.type === 'text')
					.map((item) => item.text)
					.join('\n')
			: '';
	const emptyLabel =
		call.status === 'running'
			? 'Image generation stopped.'
			: call.status === 'denied'
				? 'Image generation was not approved.'
				: failed
					? 'Image generation failed.'
					: 'No image was returned.';
	return (
		<div
			className="chat-image-result"
			data-tool-id={call.id}
			data-tool-status={call.status}
			style={{ '--chat-image-ratio': ratio } as CSSProperties}
		>
			{active && (
				<ImagePlaceholder
					label={call.status === 'approval' ? 'Waiting for approval' : 'Creating image…'}
					ratio={ratio}
					animate={call.status === 'running'}
				/>
			)}
			{!!images.length && (
				<div className="tool-images chat-generated-images">
					{images.map((item, index) => (
						<ResultImageButton
							key={`${call.id}-${index}`}
							image={item}
							ratio={ratio}
							index={index}
							total={images.length}
							onOpen={() => setSelected(index)}
						/>
					))}
				</div>
			)}
			{!active && (failed || !images.length) && (
				<div className="chat-image-status" role={failed ? 'alert' : 'status'}>
					<ImageOff size={18} />
					<span>{failed ? userFacingError(outputText, emptyLabel) : outputText || emptyLabel}</span>
				</div>
			)}
			<ModerationNotice warnings={call.result?.moderationWarnings} />
			{source && asset && selected !== null && (
				<ImageViewer
					readOnly
					moderationWarnings={call.result?.moderationWarnings}
					asset={asset}
					selectionKey={`${call.id}-${selected}`}
					source={source}
					loading={false}
					prompt={typeof args.prompt === 'string' ? args.prompt : ''}
					modelLabel=""
					modelPicker={null}
					busy={false}
					index={selected}
					total={images.length}
					onClose={() => setSelected(null)}
					onPrevious={() => setSelected(Math.max(0, selected - 1))}
					onNext={() => setSelected(Math.min(images.length - 1, selected + 1))}
					onRetryLoad={noop}
					onEdit={noop}
					onStop={noop}
				/>
			)}
		</div>
	);
}
