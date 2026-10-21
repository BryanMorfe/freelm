import { userFacingError } from '../lib/user-facing-error';
import { memo, useMemo, useState } from 'react';
import { Download, Video } from 'lucide-react';
import type { ToolCallRecord } from '../agent-types';
import { isVideoFile } from '../lib/generated-video';
import ModerationNotice from './ModerationNotice';
import './chat-video-result.css';

export default memo(function ChatVideoResult({
	call,
	live,
}: {
	call: ToolCallRecord;
	live: boolean;
}) {
	const videos = useMemo(() => call.result?.content.filter(isVideoFile) || [], [call.result]);
	const [playbackError, setPlaybackError] = useState(false);
	const failed = call.status === 'failed' || call.status === 'denied' || !!call.result?.isError;
	const active = !failed && live && ['running', 'approval'].includes(call.status);
	const error = failed
		? call.result?.content
				.filter((part) => part.type === 'text')
				.map((part) => part.text)
				.join('\n')
		: '';
	return (
		<div className="chat-video-result" data-tool-id={call.id} data-tool-status={call.status}>
			{active && (
				<div className="chat-video-placeholder" role="status">
					<Video size={24} aria-hidden="true" />
					<span className={call.status === 'running' ? 'activity-shimmer' : undefined}>
						{call.status === 'approval' ? 'Waiting for approval' : 'Creating video…'}
					</span>
				</div>
			)}
			{!failed &&
				videos.map((video, index) => (
					<div className="chat-video-item" key={`${call.id}-${index}`}>
						<video
							controls
							playsInline
							preload="metadata"
							src={video.dataUrl}
							aria-label={`Generated video${videos.length > 1 ? ` ${index + 1}` : ''}`}
							onError={() => setPlaybackError(true)}
						/>
						<a className="chat-video-download" href={video.dataUrl} download={video.name}>
							<Download size={16} aria-hidden="true" /> Download video
						</a>
					</div>
				))}
			{playbackError && (
				<p role="alert">This video could not be played here. You can still download it.</p>
			)}
			{!active && (failed || !videos.length) && (
				<p className={failed ? 'chat-video-error' : undefined} role={failed ? 'alert' : 'status'}>
					{(error && userFacingError(error)) ||
						(call.status === 'running' ? 'Video generation stopped.' : 'No video was returned.')}
				</p>
			)}
			<ModerationNotice warnings={call.result?.moderationWarnings} />
		</div>
	);
});
