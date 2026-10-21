import { memo, useMemo, useState } from 'react';
import { ChevronRight, File } from 'lucide-react';
import type { ToolCallRecord } from '../agent-types';
import { editedFileTotals, type EditedFileChange } from '../lib/edited-files';
import { editedFileActivityChanges, editedFileActivityCount } from '../lib/message-activity';
import ToolActivityIcon from './ActivityIcon';
import { toolErrorMessage } from './ToolActivityDetails';
import './edited-files-activity.css';

function LineCounts({ added, removed }: { added?: number; removed?: number }) {
	if (!added && !removed) return null;
	return (
		<span
			className="edited-files-counts"
			aria-label={[added ? `${added} lines added` : '', removed ? `${removed} lines removed` : '']
				.filter(Boolean)
				.join(', ')}
		>
			{!!added && <span className="edited-lines-added">+{added}</span>}
			{!!removed && <span className="edited-lines-removed">-{removed}</span>}
		</span>
	);
}

const actions = { add: 'Added', update: 'Modified', delete: 'Deleted', move: 'Renamed' };

function FileRow({ file }: { file: EditedFileChange }) {
	const [expanded, setExpanded] = useState(false);
	const path = file.previousPath ? `${file.previousPath} → ${file.path}` : file.path;
	const row = (
		<>
			<File size={14} aria-hidden="true" />
			<span className="edited-file-path" title={path}>
				{path}
			</span>
			<span className="edited-file-action">{actions[file.kind]}</span>
			<LineCounts added={file.addedLines} removed={file.removedLines} />
		</>
	);
	if (!file.diff.length)
		return (
			<div className="edited-file-row" data-file-path={file.path}>
				{row}
				{file.removedLines === undefined && file.kind === 'delete' && (
					<span className="edited-file-note">Line count unavailable</span>
				)}
				{!!file.omittedDiffLines && (
					<span className="edited-file-note">Diff preview unavailable</span>
				)}
			</div>
		);
	return (
		<details
			className="edited-file-detail"
			data-file-path={file.path}
			onToggle={(event) => setExpanded(event.currentTarget.open)}
		>
			<summary className="edited-file-row" aria-label={`Changes to ${path}`}>
				{row}
				<ChevronRight className="edited-files-chevron" size={12} aria-hidden="true" />
			</summary>
			{expanded && (
				<>
					<pre
						className="edited-file-diff"
						tabIndex={0}
						aria-label={`Patch preview for ${file.path}`}
					>
						<code>
							{file.diff.map((line, index) => (
								<span className={`edited-diff-line edited-diff-${line.kind}`} key={index}>
									{line.text}
									{'\n'}
								</span>
							))}
						</code>
					</pre>
					{!!file.omittedDiffLines && (
						<p className="edited-file-note">
							Diff preview shortened · {file.omittedDiffLines} more lines.
						</p>
					)}
				</>
			)}
		</details>
	);
}

/** Readable patch details are available with Debug off; raw tool JSON remains separate. */
export default memo(function EditedFilesActivity({
	call,
	label,
	active = false,
	status,
}: {
	call: ToolCallRecord;
	args: Record<string, unknown>;
	label: string;
	active?: boolean;
	status?: string;
}) {
	const [expanded, setExpanded] = useState(false);
	const files = useMemo(
		() => editedFileActivityChanges(call),
		[call.arguments, call.result, call.status],
	);
	const fileCount = useMemo(
		() => editedFileActivityCount([call]),
		[call.arguments, call.result, call.status],
	);
	const totals = useMemo(() => editedFileTotals(files), [files]);
	const failed = call.status === 'failed' || call.status === 'denied' || !!call.result?.isError;
	const error = toolErrorMessage(call);
	const applied = call.status === 'completed' && !failed;
	const baseLabel = failed ? 'Could not edit files' : label;
	const title =
		fileCount !== undefined
			? baseLabel.replace(
					/\b(?:\d+ )?files?\b/,
					`${fileCount} ${fileCount === 1 ? 'file' : 'files'}`,
				)
			: baseLabel.replace(/\b\d+ files?\b/, 'files');
	const summary = (
		<>
			{!!files.length && <ToolActivityIcon call={call} />}
			<span className={`edited-files-label${active ? ' activity-shimmer' : ''}`}>{title}</span>
			{!!files.length && <LineCounts added={totals.added} removed={totals.removed} />}
			{status && !title.toLowerCase().includes(status.toLowerCase()) && <small>{status}</small>}
		</>
	);
	if (!files.length)
		return (
			<div className="edited-files-unavailable">
				<div className="tool-status-line">{summary}</div>
				{error && <p className="tool-error-message">{error}</p>}
				{!active && (
					<p className="edited-file-note">File details are unavailable for this patch.</p>
				)}
			</div>
		);
	return (
		<details
			className="edited-files-activity"
			onToggle={(event) => setExpanded(event.currentTarget.open)}
		>
			<summary>
				{summary}
				<ChevronRight className="edited-files-chevron" size={13} aria-hidden="true" />
			</summary>
			{expanded && (
				<div className="edited-files-list">
					{error && <p className="tool-error-message">{error}</p>}
					{!applied && (
						<p className="edited-file-note">
							Proposed changes{failed ? ' · patch did not complete' : ''}
						</p>
					)}
					{files.map((file, index) => (
						<FileRow file={file} key={`${file.path}:${index}`} />
					))}
				</div>
			)}
		</details>
	);
});
