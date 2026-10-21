import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronUp, FilePenLine, X } from 'lucide-react';
import type { ToolCallRecord } from '../agent-types';
import {
	aggregateFileEdits,
	type FileEditSummary as FileEditRecord,
} from '../lib/file-edit-summary';
import { editedFileTotals } from '../lib/edited-files';
import './file-edit-summary.css';
import { useCodeSurfaceActions } from './code-surface-context';

function LineCounts({ added, removed }: { added?: number; removed?: number }) {
	return (
		<span
			className="file-edit-counts"
			aria-label={[
				added === undefined ? 'Added line count unavailable' : `${added} lines added`,
				removed === undefined ? 'Removed line count unavailable' : `${removed} lines removed`,
			].join(', ')}
		>
			{added !== undefined && <span className="file-edit-added">+{added}</span>}
			{removed !== undefined && <span className="file-edit-removed">-{removed}</span>}
		</span>
	);
}

function FileName({ path }: { path: string }) {
	const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return (
		<span className="file-edit-name" title={path}>
			{separator >= 0 && (
				<span className="file-edit-directory">{path.slice(0, separator + 1)}</span>
			)}
			<span>{path.slice(separator + 1)}</span>
		</span>
	);
}

/** Patch excerpts use preview row numbers because apply_patch has no reliable file-line offsets. */
export function DiffPreview({ file }: { file: FileEditRecord }) {
	return (
		<div
			className="file-edit-preview-scroll"
			tabIndex={0}
			aria-label={`Diff contents for ${file.path}`}
		>
			<div className="file-edit-preview-note">Patch excerpts · preview line numbers</div>
			{file.previewSections.map((section, sectionIndex) => (
				<div className="file-edit-preview-section" key={`${section.callId}-${sectionIndex}`}>
					{file.previewSections.length > 1 && (
						<div className="file-edit-preview-section-title">Patch {sectionIndex + 1}</div>
					)}
					{section.previousPath && (
						<div className="file-edit-preview-note">
							{section.previousPath} → {section.path}
						</div>
					)}
					{section.diff.length ? (
						<div className="file-edit-diff-lines">
							{section.diff.map((line, index) => (
								<div className={`file-edit-diff-line file-edit-diff-${line.kind}`} key={index}>
									<span className="file-edit-line-number" aria-hidden="true">
										{index + 1}
									</span>
									<code>{line.text}</code>
								</div>
							))}
						</div>
					) : (
						<p className="file-edit-preview-note">
							{section.omittedDiffLines
								? `Diff preview omitted · ${section.omittedDiffLines} lines.`
								: 'Diff preview unavailable for this recorded change.'}
						</p>
					)}
					{!!section.diff.length && !!section.omittedDiffLines && (
						<div className="file-edit-preview-note">
							Preview shortened · {section.omittedDiffLines} more lines.
						</div>
					)}
				</div>
			))}
			{!file.previewSections.length && (
				<p className="file-edit-preview-note">Diff preview unavailable for this recorded change.</p>
			)}
			{!!file.omittedPreviewSections && (
				<div className="file-edit-preview-note">
					{file.omittedPreviewSections} earlier patches omitted from this preview.
				</div>
			)}
		</div>
	);
}

/** A finished Code reply exposes successful file edits without opening its entire tool history. */
export default memo(function FileEditSummary({ calls }: { calls?: readonly ToolCallRecord[] }) {
	const surface = useCodeSurfaceActions();
	const files = useMemo(() => aggregateFileEdits(calls || []), [calls]);
	const totals = useMemo(() => editedFileTotals(files), [files]);
	const [expanded, setExpanded] = useState(false);
	const [preview, setPreview] = useState<{ path: string; pinned: boolean } | null>(null);
	const [position, setPosition] = useState<{
		left: number;
		top: number;
		width: number;
		maxHeight: number;
	} | null>(null);
	const anchor = useRef<HTMLButtonElement | null>(null);
	const popup = useRef<HTMLDivElement | null>(null);
	const suppressFocus = useRef<HTMLButtonElement | null>(null);
	const pointer = useRef<{ x: number; y: number } | null>(null);
	const dismissedPointer = useRef<{ x: number; y: number } | null>(null);
	const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const previewRef = useRef(preview);
	previewRef.current = preview;
	const previewId = useId();
	const selected = preview && files.find((file) => file.path === preview.path);

	function clearClose() {
		if (closeTimer.current !== undefined) clearTimeout(closeTimer.current);
		closeTimer.current = undefined;
	}
	function close(restoreFocus = false) {
		clearClose();
		// Removing the overlay can uncover another row beneath a stationary pointer.
		dismissedPointer.current = pointer.current;
		setPreview(null);
		if (restoreFocus && anchor.current?.isConnected) {
			suppressFocus.current = anchor.current;
			anchor.current.focus({ preventScroll: true });
		}
	}
	function show(path: string, node: HTMLButtonElement, pinned = false) {
		clearClose();
		if (!pinned && previewRef.current?.pinned) return;
		anchor.current = node;
		setPreview((current) =>
			current?.path === path && current.pinned === pinned ? current : { path, pinned },
		);
	}
	function trackPointer(event: { clientX: number; clientY: number }) {
		pointer.current = { x: event.clientX, y: event.clientY };
	}
	function hover(
		path: string,
		node: HTMLButtonElement,
		event: { clientX: number; clientY: number },
	) {
		trackPointer(event);
		const dismissed = dismissedPointer.current;
		if (
			dismissed &&
			Math.abs(event.clientX - dismissed.x) <= 1 &&
			Math.abs(event.clientY - dismissed.y) <= 1
		)
			return;
		dismissedPointer.current = null;
		show(path, node);
	}
	function scheduleClose() {
		clearClose();
		if (previewRef.current?.pinned) return;
		closeTimer.current = setTimeout(() => setPreview(null), 180);
	}
	useEffect(() => () => clearClose(), []);
	useLayoutEffect(() => {
		if (!preview || !selected) return;
		function place() {
			if (!anchor.current || !popup.current) return;
			const bounds = anchor.current.getBoundingClientRect();
			const popupBounds = popup.current.getBoundingClientRect();
			const scale = popup.current.offsetWidth ? popupBounds.width / popup.current.offsetWidth : 1;
			const viewportWidth = innerWidth / scale;
			const viewportHeight = innerHeight / scale;
			const gutter = 12;
			const width = Math.max(1, Math.min(680, viewportWidth - gutter * 2));
			const maxHeight = Math.max(1, Math.min(480, viewportHeight - gutter * 2));
			popup.current.style.width = `${width}px`;
			popup.current.style.maxHeight = `${maxHeight}px`;
			const height = Math.min(popup.current.offsetHeight, maxHeight);
			const top = bounds.top / scale;
			const bottom = bounds.bottom / scale;
			const above = top - gutter;
			const below = viewportHeight - bottom - gutter;
			const desiredTop = above >= height + 8 || above > below ? top - height - 8 : bottom + 8;
			const next = {
				left: Math.max(gutter, Math.min(bounds.left / scale, viewportWidth - width - gutter)),
				top: Math.max(gutter, Math.min(desiredTop, viewportHeight - height - gutter)),
				width,
				maxHeight,
			};
			setPosition((current) =>
				current &&
				Object.entries(next).every(([key, value]) => current[key as keyof typeof current] === value)
					? current
					: next,
			);
		}
		place();
		const reposition = (event: Event) => {
			if (event.target instanceof Node && popup.current?.contains(event.target)) return;
			place();
		};
		window.addEventListener('resize', place);
		window.addEventListener('scroll', reposition, true);
		return () => {
			window.removeEventListener('resize', place);
			window.removeEventListener('scroll', reposition, true);
		};
	}, [preview, selected]);
	useEffect(() => {
		if (!preview || !selected) return;
		if (preview.pinned) popup.current?.focus({ preventScroll: true });
		const outside = (event: PointerEvent) => {
			const target = event.target;
			if (
				target instanceof Node &&
				!anchor.current?.contains(target) &&
				!popup.current?.contains(target)
			) {
				trackPointer(event);
				close();
			}
		};
		const escape = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			event.preventDefault();
			close(preview.pinned);
		};
		document.addEventListener('pointerdown', outside);
		window.addEventListener('keydown', escape);
		return () => {
			document.removeEventListener('pointerdown', outside);
			window.removeEventListener('keydown', escape);
		};
	}, [preview, selected]);

	if (!files.length) return null;
	const shown = expanded || files.length <= 5 ? files : files.slice(0, 3);
	return (
		<section className="file-edit-summary" aria-label="Edited files">
			<div className="file-edit-summary-header">
				<div className="file-edit-summary-icon">
					<FilePenLine size={20} aria-hidden="true" />
				</div>
				<div className="file-edit-summary-heading">
					<div className="file-edit-summary-title">
						Edited {files.length} {files.length === 1 ? 'file' : 'files'}
					</div>
					<LineCounts added={totals.added} removed={totals.removed} />
				</div>
				{surface && (
					<button
						className="secondary-button file-edit-review-button"
						onClick={() => surface.openChanges(calls)}
					>
						View changes
					</button>
				)}
			</div>
			<div className="file-edit-summary-list">
				{shown.map((file) => (
					<button
						className="file-edit-summary-row"
						data-file-path={file.path}
						key={file.path}
						type="button"
						aria-label={`Show changes to ${file.path}`}
						aria-expanded={preview?.path === file.path}
						aria-controls={preview?.path === file.path ? previewId : undefined}
						onMouseEnter={(event) => hover(file.path, event.currentTarget, event)}
						onMouseMove={(event) => {
							if (dismissedPointer.current) hover(file.path, event.currentTarget, event);
							else trackPointer(event);
						}}
						onMouseLeave={scheduleClose}
						onFocus={(event) => {
							if (suppressFocus.current === event.currentTarget) {
								suppressFocus.current = null;
								return;
							}
							dismissedPointer.current = null;
							show(file.path, event.currentTarget);
						}}
						onBlur={(event) => {
							if (!(
								event.relatedTarget instanceof Node && popup.current?.contains(event.relatedTarget)
							))
								scheduleClose();
						}}
						onClick={(event) => {
							dismissedPointer.current = null;
							preview?.path === file.path && preview.pinned
								? close()
								: show(file.path, event.currentTarget, true);
						}}
					>
						<FileName path={file.path} />
						<LineCounts added={file.addedLines} removed={file.removedLines} />
					</button>
				))}
			</div>
			{files.length > 5 && (
				<button
					className="file-edit-summary-more"
					type="button"
					aria-expanded={expanded}
					onClick={() => {
						close();
						setExpanded((value) => !value);
					}}
				>
					{expanded ? 'Show less' : `Show ${files.length - 3} more files`}
					{expanded ? (
						<ChevronUp size={14} aria-hidden="true" />
					) : (
						<ChevronDown size={14} aria-hidden="true" />
					)}
				</button>
			)}
			{selected &&
				preview &&
				createPortal(
					<div
						className="file-edit-preview"
						id={previewId}
						ref={popup}
						role="dialog"
						aria-label={`Diff for ${selected.path}`}
						tabIndex={-1}
						style={position || { visibility: 'hidden', left: 0, top: 0, width: 680 }}
						onMouseEnter={(event) => {
							trackPointer(event);
							clearClose();
						}}
						onMouseMove={trackPointer}
						onMouseLeave={scheduleClose}
						onFocus={clearClose}
						onBlur={(event) => {
							if (!(
								event.relatedTarget instanceof Node &&
								event.currentTarget.contains(event.relatedTarget)
							))
								scheduleClose();
						}}
						onContextMenu={(event) => event.stopPropagation()}
					>
						<div className="file-edit-preview-header">
							<FileName path={selected.path} />
							<LineCounts added={selected.addedLines} removed={selected.removedLines} />
							<button
								type="button"
								className="icon-button"
								aria-label="Close diff preview"
								onClick={() => close(true)}
							>
								<X size={15} />
							</button>
						</div>
						<DiffPreview file={selected} />
					</div>,
					document.body,
				)}
		</section>
	);
});
