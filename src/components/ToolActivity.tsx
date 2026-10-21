import { memo, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, X } from 'lucide-react';
import type { ToolCallRecord } from '../agent-types';
import MessageMarkdown from './MessageMarkdown';
import ChatImageResult from './ChatImageResult';
import ChatVideoResult from './ChatVideoResult';
import { isVideoFile } from '../lib/generated-video';
import ModerationNotice from './ModerationNotice';
import ToolActivityIcon from './ActivityIcon';
import ActivityLabel, { activityCommand } from './ActivityLabel';
import EditedFilesActivity from './EditedFilesActivity';
import ApprovalDeniedActivity from './ApprovalDeniedActivity';
import { approvalDenial } from '../lib/approval-denial';
import { toolActivityDetails } from './ToolActivityDetails';
import './tool-activity.css';
import { isFileEditingCall, toolActivityLabel, toolActivityLabels } from '../lib/message-activity';

function argumentsFor(call: ToolCallRecord): Record<string, unknown> {
	if (isFileEditingCall(call) && call.arguments.startsWith('*** Begin Patch'))
		return { patch: call.arguments };
	try {
		const parsed: unknown = JSON.parse(call.arguments);
		if (
			isFileEditingCall(call) &&
			typeof parsed === 'string' &&
			parsed.startsWith('*** Begin Patch')
		)
			return { patch: parsed };
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
			return parsed as Record<string, unknown>;
	} catch {
		/* Partial arguments remain in details. */
	}
	return {};
}

function ToolDebugDetails({
	call,
	args,
	output,
}: {
	call: ToolCallRecord;
	args: Record<string, unknown>;
	output: string;
}) {
	return (
		<details className="tool-debug-details">
			<summary>
				<span>Tool details</span>
				<ChevronRight className="tool-chevron" size={12} />
			</summary>
			<div className="tool-debug-label">Arguments</div>
			<pre className="tool-arguments">
				{Object.keys(args).length ? JSON.stringify(args, null, 2) : call.arguments}
			</pre>
			<div className="tool-debug-label">Result · {call.status}</div>
			<pre className="tool-output">{output || '(No text returned.)'}</pre>
		</details>
	);
}

export const ToolCallActivity = memo(
	function ToolCallActivity({
		call,
		label,
		live = false,
		assetsOnly = false,
		hideImages = false,
		debugMode = false,
	}: {
		call: ToolCallRecord;
		label?: string;
		live?: boolean;
		assetsOnly?: boolean;
		hideImages?: boolean;
		debugMode?: boolean;
	}) {
		const [preview, setPreview] = useState<string | null>(null);
		useEffect(() => {
			if (!preview) return;
			const key = (event: KeyboardEvent) => {
				if (event.key === 'Escape') setPreview(null);
			};
			window.addEventListener('keydown', key);
			return () => window.removeEventListener('keydown', key);
		}, [preview]);
		const args = useMemo(() => argumentsFor(call), [call.arguments]);
		const output = useMemo(
			() => ({
				text:
					debugMode || call.name === 'send_message_to_user_async'
						? call.result?.content
								.filter((item) => item.type === 'text')
								.map((item) => item.text)
								.join('\n') || ''
						: '',
				images:
					call.result?.content
						.filter((item) => item.type === 'image')
						.filter((item) => item.purpose !== 'computer') || [],
			}),
			[call.result, call.name, debugMode],
		);
		const failed = call.status === 'failed' || call.status === 'denied' || !!call.result?.isError;
		const active = !failed && live && (call.status === 'running' || call.status === 'approval');
		const activityState = failed ? 'failed' : active ? 'active' : 'completed';
		const denial = approvalDenial(call);
		const reviewError = call.result?.isError ? call.result.approvalReviewError : undefined;
		if (denial || reviewError) {
			if (assetsOnly) return null;
			return (
				<div
					className="tool-call"
					data-tool-id={call.id}
					data-tool-status={denial ? 'denied' : 'failed'}
					data-activity-state="failed"
					data-tool-name={call.name}
				>
					<ApprovalDeniedActivity
						call={call}
						args={args}
						denial={(denial || reviewError)!}
						reviewFailed={!denial && !!reviewError}
					/>
					{debugMode && <ToolDebugDetails call={call} args={args} output={output.text} />}
				</div>
			);
		}
		if (call.name === 'image_gen.imagegen' && !hideImages)
			return <ChatImageResult call={call} args={args} live={live} />;
		if (
			!hideImages &&
			(call.name === 'video_gen.videogen' || call.result?.content.some(isVideoFile))
		)
			return <ChatVideoResult call={call} live={live} />;
		if (call.name === 'send_message_to_user_async' && !failed) {
			const message = typeof args.message === 'string' ? args.message : output.text;
			return (
				<div
					className="tool-call tool-message"
					data-tool-id={call.id}
					data-tool-status={call.status}
					data-activity-state={activityState}
				>
					{active && (
						<div className="tool-status-line">
							<ToolActivityIcon call={call} />
							<span className="tool-message-status activity-shimmer">Sharing update…</span>
						</div>
					)}
					{message && <MessageMarkdown text={message} />}
					{debugMode && <ToolDebugDetails call={call} args={args} output={output.text} />}
				</div>
			);
		}
		const name = label ?? toolActivityLabel(call);
		const details = toolActivityDetails(call, args);
		const hasDetails = !!activityCommand(call, name) || !!details;
		const status =
			!failed && call.status === 'running' && !live
				? 'Stopped'
				: !failed && call.status === 'approval'
					? 'Waiting for approval'
					: '';
		return (
			<div
				className="tool-call"
				data-tool-id={call.id}
				data-tool-status={call.status}
				data-activity-state={activityState}
				data-tool-name={call.name}
			>
				{!assetsOnly && (
					<>
						{isFileEditingCall(call) ? (
							<EditedFilesActivity
								call={call}
								args={args}
								label={name}
								active={active}
								status={status}
							/>
						) : (
							<div className="tool-status-line">
								{hasDetails && <ToolActivityIcon call={call} />}
								<ActivityLabel
									call={call}
									label={name}
									active={active}
									detailKind={details?.kind}
									details={details?.content}
								/>
								{status && <small>{status}</small>}
							</div>
						)}
						{debugMode && <ToolDebugDetails call={call} args={args} output={output.text} />}
					</>
				)}
				{!hideImages && <ModerationNotice warnings={call.result?.moderationWarnings} />}
				{!hideImages && !!output.images.length && (
					<div className="tool-images">
						{output.images.map((image, index) => (
							<div key={index}>
								<button
									onClick={() => setPreview(image.dataUrl)}
									title={
										call.name === 'web.run' ||
										call.name === 'image.view' ||
										call.name === 'view_image'
											? 'Open image'
											: 'Open generated image'
									}
								>
									<img src={image.dataUrl} alt={image.name || 'Tool image'} />
								</button>
							</div>
						))}
					</div>
				)}
				{preview &&
					createPortal(
						<div
							className="tool-image-fullscreen"
							role="dialog"
							aria-modal="true"
							aria-label="Image preview"
							onClick={() => setPreview(null)}
						>
							<button
								className="icon-button"
								aria-label="Close image preview"
								onClick={() => setPreview(null)}
								autoFocus
							>
								<X />
							</button>
							<img
								src={preview}
								alt="Full size tool image"
								onClick={(event) => event.stopPropagation()}
							/>
						</div>,
						document.body,
					)}
			</div>
		);
	},
	(previous, next) =>
		previous.live === next.live &&
		previous.assetsOnly === next.assetsOnly &&
		previous.hideImages === next.hideImages &&
		previous.debugMode === next.debugMode &&
		previous.label === next.label &&
		(previous.call === next.call ||
			(previous.call.id === next.call.id &&
				previous.call.name === next.call.name &&
				previous.call.arguments === next.call.arguments &&
				previous.call.status === next.call.status &&
				previous.call.result === next.call.result)),
);

export default memo(function ToolActivity({
	calls,
	live = false,
	debugMode = false,
}: {
	calls: ToolCallRecord[];
	live?: boolean;
	debugMode?: boolean;
}) {
	const labels = useMemo(() => toolActivityLabels(calls, !live), [calls, live]);
	return (
		<div className="tool-activity" aria-label="Tool activity">
			{calls.map((call) => (
				<ToolCallActivity
					key={call.id}
					call={call}
					label={labels.get(call.id)}
					live={live}
					debugMode={debugMode}
				/>
			))}
		</div>
	);
});
