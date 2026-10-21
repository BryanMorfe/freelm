import { composerVisibleText } from '../lib/composer-mention-codec';
import { memo, useId, useState } from 'react';
import {
	AlertCircle,
	CornerDownRight,
	FileText,
	ListEnd,
	MoreHorizontal,
	RotateCcw,
	Trash2,
} from 'lucide-react';
import type { CodeQueueFailure, Message, QueuedCodeMessage } from '../types';
import { sourceImagePreview } from '../lib/conversation-sources';
import { userFacingError } from '../lib/user-facing-error';
import Select from './Select';
import './code-message-queue.css';

const actions = [
	{ value: 'edit', label: 'Edit message' },
	{ value: 'delete', label: 'Delete message' },
];

interface Props {
	messages: QueuedCodeMessage[];
	failures?: (CodeQueueFailure & { messages: Message[] })[];
	running: boolean;
	editingId?: string;
	disabled?: boolean;
	onEdit: (id: string) => void;
	onRemove: (id: string) => void;
	onSteer: (id: string) => void;
	onRetry?: (failureId: string) => void;
}

const FailedQueueRow = memo(function FailedQueueRow({
	failure,
	disabled,
	onRetry,
}: {
	failure: CodeQueueFailure & { messages: Message[] };
	disabled: boolean;
	onRetry?: Props['onRetry'];
}) {
	const [expanded, setExpanded] = useState(false);
	const previewId = useId();
	const first = failure.messages[0];
	const preview =
		composerVisibleText(first?.content || '').trim() ||
		first?.attachments?.[0]?.name ||
		'Queued follow-up';
	return (
		<div
			className="code-message-queue-failure-row"
			role="group"
			aria-label="Failed queued messages"
		>
			<div className="code-message-queue-line">
				<AlertCircle size={16} className="code-message-queue-error-icon" aria-hidden="true" />
				<button
					type="button"
					className="code-message-queue-preview"
					aria-label={
						expanded ? 'Collapse failed queued messages' : 'Expand failed queued messages'
					}
					aria-expanded={expanded}
					aria-controls={previewId}
					onClick={() => setExpanded((value) => !value)}
				>
					<span>{preview}</span>
				</button>
				<button
					type="button"
					className="code-message-queue-steer"
					aria-label="Retry queued messages"
					disabled={disabled || !onRetry}
					onClick={() => onRetry?.(failure.id)}
				>
					<RotateCcw size={15} aria-hidden="true" />
					<span>Retry</span>
				</button>
			</div>
			<p className="code-message-queue-failure-hint">
				Queued follow-up failed. Retry continues from saved progress.
			</p>
			<p className="code-message-queue-error">{userFacingError(failure.error)}</p>
			{expanded && (
				<div id={previewId} className="code-message-queue-expanded">
					{failure.messages.map((message) => (
						<div key={message.id}>
							{message.replyTo && <blockquote>{message.replyTo.text}</blockquote>}
							{message.content && <p>{composerVisibleText(message.content)}</p>}
							{message.attachments?.length ? (
								<div className="code-message-queue-files">
									{message.attachments.map((attachment, index) => (
										<span key={index} title={attachment.name}>
											<FileText size={13} aria-hidden="true" />
											{attachment.name}
										</span>
									))}
								</div>
							) : null}
						</div>
					))}
					<p>{userFacingError(failure.error)}</p>
				</div>
			)}
		</div>
	);
});

const QueueRow = memo(function QueueRow({
	message,
	running,
	editingId,
	disabled = false,
	onEdit,
	onRemove,
	onSteer,
}: Omit<Props, 'messages'> & { message: QueuedCodeMessage }) {
	const [expanded, setExpanded] = useState(false);
	const previewId = useId();
	const firstAttachment = message.attachments?.[0];
	const image = firstAttachment && sourceImagePreview(firstAttachment);
	const preview =
		composerVisibleText(message.content).trim() || firstAttachment?.name || 'Attached message';
	const editing = editingId === message.id;
	const editDisabled = disabled || !!editingId;
	const menuActions = editDisabled
		? actions.map((action) => ({ ...action, disabled: action.value === 'edit' }))
		: actions;
	return (
		<div className={`code-message-queue-row${editing ? ' is-editing' : ''}`}>
			<div className="code-message-queue-line">
				<ListEnd size={16} className="code-message-queue-icon" aria-hidden="true" />
				<button
					type="button"
					className="code-message-queue-preview"
					aria-label={expanded ? 'Collapse queued message' : 'Expand queued message'}
					aria-expanded={expanded}
					aria-controls={previewId}
					onClick={() => setExpanded((open) => !open)}
				>
					{firstAttachment &&
						(image ? (
							<img
								className="code-message-queue-thumbnail"
								src={image}
								alt={firstAttachment.name}
							/>
						) : (
							<FileText size={17} aria-label={firstAttachment.name} />
						))}
					<span>{preview}</span>
				</button>
				{editing ? (
					<span className="code-message-queue-editing">Editing message</span>
				) : running ? (
					<span className="code-message-queue-steer" title="Sends at next tool boundary">
						<CornerDownRight size={15} aria-hidden="true" />
						<span>Queued</span>
					</span>
				) : (
					<button
						type="button"
						className="code-message-queue-steer"
						title="Send message"
						aria-label="Send queued message"
						disabled={editDisabled}
						onClick={() => onSteer(message.id)}
					>
						<CornerDownRight size={15} aria-hidden="true" />
						<span>Send</span>
					</button>
				)}
				<button
					type="button"
					className="code-message-queue-remove"
					aria-label="Remove queued message"
					title="Remove queued message"
					disabled={disabled}
					onClick={() => onRemove(message.id)}
				>
					<Trash2 size={15} aria-hidden="true" />
				</button>
				<Select
					className="code-message-queue-actions"
					aria-label="Queued message actions"
					value=""
					placeholder=""
					showChevron={false}
					leadingIcon={<MoreHorizontal size={17} aria-hidden="true" />}
					options={menuActions}
					disabled={disabled}
					onChange={(action) => {
						if (action === 'edit' && !editDisabled) onEdit(message.id);
						else if (action === 'delete') onRemove(message.id);
					}}
				/>
			</div>
			{expanded && (
				<div id={previewId} className="code-message-queue-expanded">
					{message.replyTo && <blockquote>{message.replyTo.text}</blockquote>}
					{message.content && <p>{composerVisibleText(message.content)}</p>}
					{message.attachments?.length ? (
						<div className="code-message-queue-files">
							{message.attachments.map((attachment, index) => (
								<span key={index} title={attachment.name}>
									<FileText size={13} aria-hidden="true" />
									{attachment.name}
								</span>
							))}
						</div>
					) : null}
				</div>
			)}
		</div>
	);
});

/** Pending follow-ups share the compact drawer above the Code composer. */
export default function CodeMessageQueue({ messages, failures = [], ...props }: Props) {
	if (!messages.length && !failures.length) return null;
	return (
		<div className="code-message-queue" aria-label="Queued messages">
			{failures.map((failure) => (
				<FailedQueueRow
					key={failure.id}
					failure={failure}
					disabled={!!props.disabled || props.running || !!props.editingId}
					onRetry={props.onRetry}
				/>
			))}
			{messages.map((message) => (
				<QueueRow key={message.id} message={message} {...props} />
			))}
		</div>
	);
}
