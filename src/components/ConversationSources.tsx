import { memo, useId, useMemo, useState } from 'react';
import { FileText, Globe, Image, Search } from 'lucide-react';
import type { Attachment, Thread } from '../types';
import {
	collectConversationSources,
	sourceImagePreview,
	sourceProvenance,
	type ConversationSource,
	type ConversationSourceActivity,
	type ConversationSourcesData,
} from '../lib/conversation-sources';
import { decodeAttachmentText } from '../lib/text-attachments';
import { collectTaskOutputs, type TaskOutputsData } from '../lib/task-outputs';
import TaskOutputs from './TaskOutputs';
import WorkspaceLink from './WorkspaceLink';
import './conversation-sources.css';

function UploadPreview({ attachment }: { attachment: Attachment }) {
	const preview = useMemo(() => {
		const image = sourceImagePreview(attachment);
		if (image) return { image };
		if (attachment.dataUrl.length > 3_000_000) return {};
		try {
			const text = decodeAttachmentText(attachment);
			return text === undefined
				? {}
				: { text: text.slice(0, 12_000), truncated: text.length > 12_000 };
		} catch {
			return {};
		}
	}, [attachment]);
	if (preview.image)
		return <img className="conversation-source-image" src={preview.image} alt={attachment.name} />;
	if (preview.text !== undefined)
		return (
			<div className="conversation-source-text">
				<pre>{preview.text}</pre>
				{preview.truncated && <small>Preview truncated</small>}
			</div>
		);
	return (
		<p className="conversation-source-unavailable">Preview unavailable for this attachment.</p>
	);
}

function SourceText({ source }: { source: ConversationSource }) {
	return (
		<div className="conversation-source-description">
			<span className="conversation-source-title" title={source.title}>
				{source.title}
			</span>
			{source.url && (
				<WorkspaceLink
					className="conversation-source-url"
					href={source.url}
					target="_blank"
					rel="noreferrer"
					title={source.url}
				>
					{source.url}
				</WorkspaceLink>
			)}
			{source.path && (
				<span className="conversation-source-path" title={source.path}>
					{source.path}
				</span>
			)}
			<div className="conversation-source-provenance">
				{sourceProvenance(source).map((label) => (
					<span key={label}>{label}</span>
				))}
			</div>
		</div>
	);
}

const SourceRow = memo(function SourceRow({ source }: { source: ConversationSource }) {
	const [open, setOpen] = useState(false);
	const Icon =
		source.kind === 'upload'
			? source.attachment?.type.startsWith('image/')
				? Image
				: FileText
			: source.kind === 'web'
				? Globe
				: Image;
	if (source.kind === 'upload' && source.attachment) {
		const previewable =
			!!sourceImagePreview(source.attachment) ||
			/^text\//.test(source.attachment.type) ||
			source.attachment.type === 'application/json';
		if (previewable)
			return (
				<li className="conversation-source-row">
					<details
						className="conversation-source-upload"
						onToggle={(event) => setOpen(event.currentTarget.open)}
					>
						<summary>
							<Icon size={16} aria-hidden="true" />
							<SourceText source={source} />
						</summary>
						{open && <UploadPreview attachment={source.attachment} />}
					</details>
				</li>
			);
	}
	return (
		<li className="conversation-source-row">
			<Icon size={16} aria-hidden="true" />
			<SourceText source={source} />
		</li>
	);
});

function ActivitySource({
	kind,
	activity,
}: {
	kind: 'web' | 'images';
	activity: ConversationSourceActivity;
}) {
	if (!Object.values(activity).some((count) => count > 0)) return null;
	return (
		<div className="conversation-source-activity">
			{kind === 'web' ? (
				<Search size={16} aria-hidden="true" />
			) : (
				<Image size={16} aria-hidden="true" />
			)}
			<div className="conversation-source-description">
				<span className="conversation-source-title">
					{kind === 'web' ? 'Web search' : 'Image search'}
				</span>
				<div className="conversation-source-provenance">
					{activity.searches > 0 && (
						<span>
							Searched {activity.searches} {activity.searches === 1 ? 'time' : 'times'}
						</span>
					)}
					{activity.opens > 0 && (
						<span>
							Opened {activity.opens} {activity.opens === 1 ? 'time' : 'times'}
						</span>
					)}
					{activity.finds > 0 && (
						<span>
							Searched within pages {activity.finds} {activity.finds === 1 ? 'time' : 'times'}
						</span>
					)}
					{activity.views > 0 && (
						<span>
							Viewed {activity.views} {activity.views === 1 ? 'image' : 'images'}
						</span>
					)}
					{activity.failedCalls > 0 && (
						<span>
							{activity.failedCalls} {activity.failedCalls === 1 ? 'call' : 'calls'} failed
						</span>
					)}
				</div>
			</div>
		</div>
	);
}

const emptySummary = (
	<div className="conversation-summary-empty">
		<header className="conversation-sources-header">
			<h2>Outputs &amp; sources</h2>
		</header>
		<p className="conversation-sources-empty">Created files and referenced sources appear here.</p>
	</div>
);

/** The pinned summary shows task outputs above the conversation's sources. */
export default memo(function ConversationSources({
	thread,
	data,
	outputs,
	workspaceId,
	prepareOutputRead,
	outputRoot,
}: {
	thread?: Thread;
	data?: ConversationSourcesData;
	outputs?: TaskOutputsData;
	workspaceId?: string;
	prepareOutputRead?: () => Promise<void>;
	outputRoot?: string;
}) {
	const sources = useMemo(
		() => data ?? collectConversationSources(thread?.messages),
		[data, thread?.messages],
	);
	const taskOutputs = useMemo(
		() => outputs ?? collectTaskOutputs(thread ?? { id: '', messages: [] }),
		[outputs, thread],
	);
	const hasSourceContent = sources.hasSources || sources.truncated;
	const listId = useId();
	const [expandedScope, setExpandedScope] = useState<string>();
	const scope = `${workspaceId ?? ''}:${thread?.id ?? ''}`;
	const expanded = expandedScope === scope;
	const visibleSources = expanded ? sources.items : sources.items.slice(0, 10);
	return (
		<section className="conversation-sources" aria-label="Pinned summary">
			<div className="conversation-sources-body">
				<TaskOutputs
					data={taskOutputs}
					workspaceId={workspaceId}
					threadId={thread?.id}
					prepareRead={prepareOutputRead}
					workspaceRoot={outputRoot}
					emptyContent={hasSourceContent ? null : emptySummary}
				/>
				{hasSourceContent && (
					<section className="conversation-sources-section" aria-label="Sources">
						<header className="conversation-sources-header conversation-sources-section-header">
							<h2>Sources</h2>
						</header>
						{sources.items.length > 0 && (
							<ul id={listId} className="conversation-sources-list" aria-label="Sources in this conversation">
								{visibleSources.map((source) => (
									<SourceRow key={source.id} source={source} />
								))}
							</ul>
						)}
						{sources.items.length > 10 && (
							<button type="button" className="conversation-sources-toggle"
								aria-expanded={expanded} aria-controls={listId}
								onClick={() => setExpandedScope(expanded ? undefined : scope)}>
								{expanded ? 'See less' : `See more (${sources.items.length - 10})`}
							</button>
						)}
						<ActivitySource kind="web" activity={sources.web} />
						<ActivitySource kind="images" activity={sources.images} />
						{sources.truncated && (
							<p className="conversation-sources-empty">
								Additional sources were omitted to keep this panel responsive.
							</p>
						)}
					</section>
				)}
			</div>
		</section>
	);
});
