import { userFacingError } from '../lib/user-facing-error';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Download, FileText, Image, X } from 'lucide-react';
import type { TaskOutput, TaskOutputsData } from '../lib/task-outputs';
import type { TaskOutputReadResult, TaskOutputStatusResult } from '../task-output-types';
import { outputDisplayPath, visibleTaskOutputs } from '../lib/task-output-status';
import { copyToClipboard } from '../lib/clipboard';
import './task-outputs.css';
import { useCodeSurfaceActions } from './code-surface-context';

/** Only metadata is refreshed; file contents remain behind the user's preview action. */
function useAvailableOutputs(
	data: TaskOutputsData,
	workspaceId: string,
	threadId?: string,
	workspaceRoot?: string,
	prepareRead?: () => Promise<void>,
) {
	const scope = `${workspaceId}\0${threadId || ''}\0${workspaceRoot || ''}`;
	const key = useMemo(
		() =>
			`${workspaceId}\0${threadId || ''}\0${workspaceRoot || ''}\0${data.items
				.filter((item) => item.kind === 'local-file')
				.map((item) => `${item.id}\0${item.path}`)
				.join('\0')}`,
		[data.items, workspaceId, threadId, workspaceRoot],
	);
	const paths = useMemo(
		() =>
			new Map(
				data.items
					.filter((item) => item.kind === 'local-file')
					.map((item) => [item.id, item.path] as const),
			),
		[key],
	);
	const hasLocalFiles = data.items.some((item) => item.kind === 'local-file');
	const [snapshot, setSnapshot] = useState<{
		key: string;
		scope: string;
		paths: Map<string, string | undefined>;
		result?: TaskOutputStatusResult;
		error?: string;
	}>();
	useEffect(() => {
		if (!hasLocalFiles) return;
		const status = window.desktop?.taskOutputStatus;
		if (!threadId || !status) {
			setSnapshot({
				key,
				scope,
				paths,
				error: 'Update FreeLM on the execution host to check which output files still exist.',
			});
			return;
		}
		let active = true,
			busy = false,
			needsCommit = true;
		const refresh = async () => {
			if (!active || busy) return;
			busy = true;
			try {
				if (needsCommit) {
					await prepareRead?.();
					needsCommit = false;
				}
				if (!active) return;
				const result = await status(workspaceId, threadId);
				if (result.threadId !== threadId)
					throw new Error('The host returned output information for another task.');
				if (active) setSnapshot({ key, scope, paths, result });
			} catch (reason) {
				if (active)
					setSnapshot({
						key,
						scope,
						paths,
						error: `Could not verify output files: ${reason instanceof Error ? reason.message : 'Host unavailable.'}`,
					});
			} finally {
				busy = false;
			}
		};
		const initial = window.setTimeout(() => {
			void refresh();
		}, 180);
		const interval = window.setInterval(() => {
			if (!document.hidden) void refresh();
		}, 5_000);
		const focus = () => {
			void refresh();
		};
		window.addEventListener('focus', focus);
		return () => {
			active = false;
			window.clearTimeout(initial);
			window.clearInterval(interval);
			window.removeEventListener('focus', focus);
		};
	}, [key, scope, paths, hasLocalFiles, prepareRead, workspaceId, threadId]);
	const current = snapshot?.scope === scope ? snapshot : undefined;
	const checked = useMemo(() => {
		if (!current?.result || current.key === key) return current?.result;
		// Creating another output should not interrupt previews of unchanged files.
		return {
			...current.result,
			files: current.result.files.filter(
				(item) => paths.has(item.id) && paths.get(item.id) === current.paths.get(item.id),
			),
		};
	}, [current, key, paths]);
	return {
		data: useMemo(() => visibleTaskOutputs(data, checked), [data, checked]),
		pending: hasLocalFiles && (!current || current.key !== key),
		error: current?.key === key ? current.error : undefined,
	};
}

function artifactPreview(output: TaskOutput): TaskOutputReadResult {
	const result: TaskOutputReadResult = {
		id: output.id,
		name: output.title,
		path: output.path || '',
		mimeType: output.mimeType,
	};
	const data = output.dataUrl;
	if (!data || !/^data:[\w.+/-]+;base64,/.test(data.slice(0, 150)))
		return { ...result, unavailable: 'This output is unavailable.' };
	result.downloadUrl = data;
	if (/^image\/(png|jpeg|jpg|webp|gif|avif)$/i.test(output.mimeType || '')) {
		result.preview = { kind: 'image', dataUrl: data };
	} else if (/^(text\/|application\/json$)/i.test(output.mimeType || '')) {
		// Decode a small prefix only. Large artifacts remain downloadable without blocking the UI.
		const encoded = data.slice(data.indexOf(',') + 1, data.indexOf(',') + 1 + 349_528);
		try {
			const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
			result.preview = {
				kind: 'text',
				text: new TextDecoder().decode(bytes),
				truncated: data.length - data.indexOf(',') - 1 > encoded.length,
			};
		} catch {
			// A missing text preview does not prevent downloading the original file.
		}
	}
	return result;
}

function OutputViewer({
	output,
	workspaceId,
	threadId,
	prepareRead,
	onClose,
}: {
	output: TaskOutput;
	workspaceId: string;
	threadId?: string;
	prepareRead?: () => Promise<void>;
	onClose: () => void;
}) {
	const [result, setResult] = useState<TaskOutputReadResult>();
	const [error, setError] = useState('');
	const [copied, setCopied] = useState(false);
	const dialog = useRef<HTMLElement>(null);
	const closeButton = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		let active = true;
		setResult(undefined);
		setError('');
		setCopied(false);
		if (output.kind !== 'local-file') setResult(artifactPreview(output));
		else if (!threadId || !window.desktop?.taskOutputRead)
			setError('File previews require a desktop instance with Outputs support.');
		else {
			const read = window.desktop.taskOutputRead;
			void (async () => {
				// Tool results can be visible before the normal streaming save debounce fires.
				// Commit that evidence before the host resolves the selected output identifier.
				await prepareRead?.();
				if (!active) return;
				const value = await read(workspaceId, threadId, output.id);
				if (active) setResult(value);
			})().catch((reason: unknown) => {
				if (active)
					setError(reason instanceof Error ? reason.message : 'Unable to read this output.');
			});
		}
		return () => {
			active = false;
		};
	}, [output.id, output.path, output.dataUrl, workspaceId, threadId, prepareRead]);
	useEffect(() => {
		const previousFocus =
			document.activeElement instanceof HTMLElement ? document.activeElement : null;
		closeButton.current?.focus();
		const keydown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				event.preventDefault();
				onClose();
			}
			if (event.key !== 'Tab') return;
			const focusable = dialog.current?.querySelectorAll<HTMLElement>('button, a[href]');
			if (!focusable?.length) return;
			const first = focusable[0],
				last = focusable[focusable.length - 1];
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first.focus();
			}
		};
		document.addEventListener('keydown', keydown);
		return () => {
			document.removeEventListener('keydown', keydown);
			if (previousFocus?.isConnected) previousFocus.focus();
		};
	}, [onClose]);
	return createPortal(
		<div
			className="task-output-backdrop"
			onClick={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<section
				ref={dialog}
				className="task-output-viewer"
				role="dialog"
				aria-modal="true"
				aria-label={`Output: ${output.title}`}
			>
				<header className="task-output-viewer-header">
					<div>
						<h2>{output.title}</h2>
						{output.path && <p title={output.path}>{output.path}</p>}
					</div>
					<button
						ref={closeButton}
						className="icon-button"
						aria-label="Close output preview"
						onClick={onClose}
					>
						<X size={18} />
					</button>
				</header>
				<div className="task-output-viewer-body">
					{!result && !error && <p role="status">Loading preview…</p>}
					{error && <p role="alert">{userFacingError(error)}</p>}
					{result?.unavailable && <p role="status">{result.unavailable}</p>}
					{result?.preview?.kind === 'text' && (
						<>
							<pre>{result.preview.text}</pre>
							{result.preview.truncated && (
								<p className="task-output-note">
									Preview truncated. Download the file for its full contents.
								</p>
							)}
						</>
					)}
					{result?.preview?.kind === 'image' && (
						<img src={result.preview.dataUrl} alt={output.title} />
					)}
					{result && !result.preview && !result.unavailable && (
						<p>Download this file to view it.</p>
					)}
				</div>
				<footer className="task-output-viewer-footer">
					{output.path && (
						<button
							onClick={() => {
								void copyToClipboard(output.path!).then(
									() => setCopied(true),
									() => setError('Unable to copy the file path.'),
								);
							}}
						>
							<Copy size={15} />
							{copied ? 'Copied' : 'Copy path'}
						</button>
					)}
					{result?.downloadUrl && (
						<a href={result.downloadUrl} download={result.name}>
							<Download size={15} />
							Download
						</a>
					)}
				</footer>
			</section>
		</div>,
		document.body,
	);
}

export default memo(function TaskOutputs({
	data: recordedData,
	workspaceId = 'local',
	threadId,
	prepareRead,
	workspaceRoot,
	emptyContent,
}: {
	data: TaskOutputsData;
	workspaceId?: string;
	threadId?: string;
	prepareRead?: () => Promise<void>;
	workspaceRoot?: string;
	/** Replace the empty section only after file checks finish; keep status and discovery issues visible. */
	emptyContent?: ReactNode;
}) {
	const surface = useCodeSurfaceActions();
	const { data, pending, error } = useAvailableOutputs(
		recordedData,
		workspaceId,
		threadId,
		workspaceRoot,
		prepareRead,
	);
	const [expanded, setExpanded] = useState(false);
	const [selectedId, setSelectedId] = useState<string>();
	const closePreview = useCallback(() => setSelectedId(undefined), []);
	const selected = data.items.find((item) => item.id === selectedId);
	useEffect(() => {
		if (selectedId && !selected) setSelectedId(undefined);
	}, [selectedId, selected]);
	const items = expanded || data.items.length <= 5 ? data.items : data.items.slice(0, 3);
	if (
		emptyContent !== undefined &&
		!data.items.length &&
		!pending &&
		!error &&
		!data.truncated &&
		!data.notices.length
	)
		return emptyContent;
	return (
		<section className="task-outputs-section" aria-label="Outputs">
			<header className="conversation-sources-header">
				<h2>Outputs</h2>
			</header>
			{data.items.length ? (
				<ul className="task-outputs-list" aria-label="Files created in this task">
					{items.map((item) => {
						const Icon =
							item.kind === 'image' || item.mimeType?.startsWith('image/') ? Image : FileText;
						return (
							<li key={item.id}>
								<button
									className="task-output-row"
									onClick={() => {
										if (
											surface &&
											window.desktop?.codeSurface &&
											item.kind === 'local-file' &&
											item.path
										)
											surface.openFile(item.path);
										else setSelectedId(item.id);
									}}
									aria-label={`Open output ${item.title}`}
								>
									<Icon size={16} aria-hidden="true" />
									<span className="conversation-source-description">
										<span className="conversation-source-title" title={item.title}>
											{item.title}
										</span>
										{item.path && (
											<span className="conversation-source-path" title={item.path}>
												{outputDisplayPath(item, workspaceRoot)}
											</span>
										)}
									</span>
								</button>
							</li>
						);
					})}
				</ul>
			) : (
				<p className="conversation-sources-empty" role={pending || error ? 'status' : undefined}>
					{pending
						? 'Checking output files…'
						: error
							? userFacingError(error)
							: 'Files created in this task appear here.'}
				</p>
			)}
			{data.items.length > 0 && (pending || error) && (
				<p className="task-output-note" role="status">
					{pending ? 'Checking output files…' : userFacingError(error)}
				</p>
			)}
			{data.items.length > 5 && (
				<button className="task-outputs-expand" onClick={() => setExpanded(!expanded)}>
					{expanded ? 'Show less' : `View all ${data.items.length} outputs`}
				</button>
			)}
			{data.truncated && (
				<p className="conversation-sources-empty">
					Additional outputs were omitted to keep this panel responsive.
				</p>
			)}
			{data.notices.length > 0 && (
				<details className="task-output-notices">
					<summary>Output discovery details</summary>
					{data.notices.map((notice, index) => (
						<p key={index} className="task-output-note">
							{notice}
						</p>
					))}
				</details>
			)}
			{selected && (
				<OutputViewer
					key={selected.id}
					output={selected}
					workspaceId={workspaceId}
					threadId={threadId}
					prepareRead={prepareRead}
					onClose={closePreview}
				/>
			)}
		</section>
	);
});
