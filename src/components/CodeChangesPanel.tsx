import { userFacingError } from '../lib/user-facing-error';
import { useEffect, useMemo, useState } from 'react';
import { FileDiff, RefreshCw } from 'lucide-react';
import type { ToolCallRecord } from '../agent-types';
import type { Thread } from '../types';
import { aggregateFileEdits } from '../lib/file-edit-summary';
import type { SurfaceExecute } from './CodeFilePanel';
import { DiffPreview } from './FileEditSummary';
import Select from './Select';

export default function CodeChangesPanel({
	execute,
	calls,
	thread,
}: {
	execute: SurfaceExecute;
	calls?: readonly ToolCallRecord[];
	thread?: Thread;
}) {
	const [review, setReview] = useState('last-turn');
	const [diff, setDiff] = useState('');
	const [error, setError] = useState('');
	const [notice, setNotice] = useState('');
	const [loading, setLoading] = useState(false);
	const [refresh, setRefresh] = useState(0);
	const lastCalls =
		calls ||
		[...(thread?.messages || [])]
			.reverse()
			.find((message) => message.role === 'assistant' && message.toolCalls?.length)?.toolCalls;
	const files = useMemo(() => aggregateFileEdits(lastCalls || []), [lastCalls]);
	useEffect(() => {
		if (review === 'last-turn') return;
		let active = true;
		setLoading(true);
		setError('');
		setDiff('');
		setNotice('');
		void execute({ action: 'diff', review: review as 'uncommitted' | 'unstaged' | 'staged' })
			.then((result) => {
				if (!active || result.kind !== 'diff') return;
				setDiff(result.diff);
				setNotice(
					[
						...result.notices,
						...(result.truncated ? ['Diff shortened for this large change.'] : []),
					].join(' '),
				);
			})
			.catch((e) => {
				if (active) setError(e instanceof Error ? e.message : String(e));
			})
			.finally(() => {
				if (active) setLoading(false);
			});
		return () => {
			active = false;
		};
	}, [review, refresh, execute]);
	return (
		<section className="code-changes-panel" aria-label="Changes review">
			<header className="code-surface-toolbar">
				<FileDiff size={16} />
				<Select
					aria-label="Review changes"
					value={review}
					onChange={setReview}
					options={[
						{ value: 'last-turn', label: 'Last turn' },
						{ value: 'uncommitted', label: 'Uncommitted' },
						{ value: 'unstaged', label: 'Unstaged' },
						{ value: 'staged', label: 'Staged' },
					]}
				/>
				<button
					className="icon-button"
					aria-label="Refresh changes"
					onClick={() => setRefresh((v) => v + 1)}
				>
					<RefreshCw size={15} />
				</button>
			</header>
			<div className="code-changes-content">
				{review === 'last-turn' ? (
					files.length ? (
						files.map((file) => (
							<details className="code-change-file" open key={file.path}>
								<summary>
									<span>{file.path}</span>
									<span className="file-edit-counts">
										<span className="file-edit-added">+{file.addedLines ?? '?'}</span>
										<span className="file-edit-removed">-{file.removedLines ?? '?'}</span>
									</span>
								</summary>
								<DiffPreview file={file} />
							</details>
						))
					) : (
						<p className="code-surface-notice">
							No recorded file edits in the last assistant turn.
						</p>
					)
				) : loading ? (
					<p className="code-surface-notice">Loading changes…</p>
				) : error ? (
					<p className="code-surface-error" role="alert">
						{userFacingError(error)}
					</p>
				) : diff ? (
					<pre className="code-git-diff" aria-label="Git diff">
						{diff.split('\n').map((line, i) => (
							<div
								key={i}
								className={
									line.startsWith('+')
										? 'added'
										: line.startsWith('-')
											? 'removed'
											: line.startsWith('@@') || line.startsWith('diff ')
												? 'heading'
												: ''
								}
							>
								{line || ' '}
							</div>
						))}
					</pre>
				) : (
					<p className="code-surface-notice">No {review} changes.</p>
				)}
				{notice && <p className="code-surface-notice">{notice}</p>}
			</div>
		</section>
	);
}
