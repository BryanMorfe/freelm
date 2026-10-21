import { memo, useMemo } from 'react';
import { ChevronRight } from 'lucide-react';
import type { ChatActivityPart, ToolCallRecord } from '../agent-types';
import { groupActivityHistory } from '../lib/message-activity';
import ToolActivityIcon from './ActivityIcon';
import MessageMarkdown from './MessageMarkdown';
import { ToolCallActivity } from './ToolActivity';
import './activity-history.css';

/** Completed neighbors group in place while active rows and assistant prose retain their order. */
export default memo(function ActivityHistory({
	parts,
	callsById,
	labels,
	debugMode,
	live = false,
}: {
	parts: readonly ChatActivityPart[];
	callsById: ReadonlyMap<string, ToolCallRecord>;
	labels: ReadonlyMap<string, string>;
	debugMode: boolean;
	live?: boolean;
}) {
	const entries = useMemo(
		() => groupActivityHistory(parts, callsById, labels),
		[parts, callsById, labels],
	);
	const toolRow = (part: Extract<ChatActivityPart, { type: 'tool' }>) => {
		const call = callsById.get(part.toolCallId);
		if (!call) return null;
		const active = live && (call.status === 'running' || call.status === 'approval');
		// Image generation already has its own visible progress beside the assets.
		if (active && ['image_gen.imagegen', 'video_gen.videogen'].includes(call.name)) return null;
		return (
			<div
				key={part.id}
				data-activity-id={part.id}
				role={active ? 'status' : undefined}
				aria-live={active ? 'polite' : undefined}
				className={
					call.name === 'send_message_to_user_async'
						? 'thought-assistant-message'
						: 'thought-tool-message'
				}
			>
				<ToolCallActivity
					call={call}
					label={labels.get(call.id)}
					live={live}
					hideImages
					debugMode={debugMode}
				/>
			</div>
		);
	};
	return entries.map((entry) => {
		if (entry.type === 'group') {
			const call = callsById.get(entry.parts[0].toolCallId)!;
			return (
				<details className="activity-history-group" key={entry.id}>
					<summary>
						<ToolActivityIcon call={call} />
						<span>{entry.label}</span>
						<ChevronRight className="activity-history-chevron" size={13} aria-hidden="true" />
					</summary>
					<div className="activity-history-entries">{entry.parts.map(toolRow)}</div>
				</details>
			);
		}
		return entry.part.type === 'tool' ? (
			toolRow(entry.part)
		) : (
			<div
				className={live ? 'message-timeline-text' : 'thought-assistant-message'}
				key={entry.part.id}
				data-activity-id={entry.part.id}
			>
				<MessageMarkdown text={entry.part.text} />
			</div>
		);
	});
});
