import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers, highlightActiveLine, keymap } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { tags } from '@lezer/highlight';
import {
	ChevronDown,
	ChevronRight,
	File,
	Folder,
	FolderOpen,
	RefreshCw,
	Search,
	X,
} from 'lucide-react';
import type {
	CodeSurfaceFileResult,
	CodeSurfaceListResult,
	CodeSurfaceRequest,
	CodeSurfaceResult,
	CodeSurfacePreviewResult,
} from '../code-surface-types';
import MessageMarkdown from './MessageMarkdown';
import { useCodeSurfaceActions } from './code-surface-context';
import { userFacingError } from '../lib/user-facing-error';
import './CodeHtmlPreview.css';

export type SurfaceSearch = (
	query: string,
) => Promise<import('../composer-types').ComposerDiscoveryResult>;
export type SurfaceExecute = (
	request: Omit<CodeSurfaceRequest, 'workspaceId' | 'threadId' | 'projectId'>,
) => Promise<CodeSurfaceResult>;
const sourceHighlight = HighlightStyle.define([
	{ tag: [tags.keyword, tags.modifier], color: 'var(--code-keyword)' },
	{ tag: [tags.string, tags.inserted], color: 'var(--code-string)' },
	{ tag: [tags.number, tags.bool, tags.null], color: 'var(--code-number)' },
	{ tag: [tags.typeName, tags.className], color: 'var(--code-type)' },
	{ tag: tags.comment, color: 'var(--muted)', fontStyle: 'italic' },
]);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function HtmlPreview({
	path,
	execute,
	reload,
}: {
	path: string;
	execute: SurfaceExecute;
	reload: number;
}) {
	const [preview, setPreview] = useState<CodeSurfacePreviewResult>();
	const [error, setError] = useState('');
	useEffect(() => {
		let active = true;
		setPreview(undefined);
		setError('');
		void execute({ action: 'preview', path })
			.then((result) => {
				if (!active) return;
				if (result.kind !== 'preview' || !result.url?.startsWith('freelm-code-preview://view/'))
					throw new Error(
						'HTML preview requires the updated FreeLM desktop app. You can still view the Source.',
					);
				setPreview(result);
			})
			.catch((error) => {
				if (active) setError(errorText(error));
			});
		return () => {
			active = false;
		};
	}, [path, execute, reload]);
	if (error)
		return (
			<p className="code-surface-error" role="alert">
				{userFacingError(error)}
			</p>
		);
	if (!preview) return <p className="code-surface-notice">Preparing preview…</p>;
	return (
		<div className="code-html-preview">
			<iframe
				title={`Preview of ${path.split('/').pop()}`}
				src={preview.url}
				sandbox="allow-scripts"
				referrerPolicy="no-referrer"
			/>
			<details className="code-html-preview-notices">
				<summary>
					{preview.notices.length
						? 'Some resources need a development server'
						: 'About this preview'}
				</summary>
				<p>
					This isolated preview runs local HTML, CSS, and scripts. Network requests, persistent
					storage, and module imports may require a development server; open its HTTP address in
					Browser.
				</p>
				{preview.notices.map((notice) => (
					<p key={notice}>{notice}</p>
				))}
			</details>
		</div>
	);
}

export function WorkspaceFiles({
	execute,
	onOpen,
	initialPath,
	compact = false,
	search,
}: {
	search?: SurfaceSearch;
	execute: SurfaceExecute;
	onOpen: (path: string) => void;
	initialPath?: string;
	compact?: boolean;
}) {
	const [directory, setDirectory] = useState(initialPath);
	const [data, setData] = useState<CodeSurfaceListResult>();
	const [query, setQuery] = useState('');
	const [error, setError] = useState('');
	const [loading, setLoading] = useState(false);
	const [refresh, setRefresh] = useState(0);
	const [searchResults, setSearchResults] = useState<CodeSurfaceListResult['entries']>();
	useEffect(() => {
		if (!search || !query.trim()) {
			setSearchResults(undefined);
			return;
		}
		let active = true;
		const timer = setTimeout(() => {
			void search(query)
				.then((result) => {
					if (active) {
						setSearchResults(
							result.items
								.filter((item) => item.kind === 'file' || item.kind === 'folder')
								.map((item) => ({
									name: item.label,
									path: item.path,
									kind: item.kind === 'folder' ? 'directory' : 'file',
								})),
						);
						setError('');
					}
				})
				.catch((e) => {
					if (active) setError(errorText(e));
				});
		}, 180);
		return () => {
			active = false;
			clearTimeout(timer);
		};
	}, [query, search]);
	useEffect(() => {
		let active = true;
		setLoading(true);
		setError('');
		void execute({ action: 'list', path: directory })
			.then((result) => {
				if (active && result.kind === 'list') {
					setData(result);
					if (
						!directory &&
						result.roots.length === 1 &&
						result.entries.length === 1 &&
						result.entries[0].path === result.roots[0].path
					)
						setDirectory(result.roots[0].path);
				}
			})
			.catch((e) => {
				if (active) setError(errorText(e));
			})
			.finally(() => {
				if (active) setLoading(false);
			});
		return () => {
			active = false;
		};
	}, [directory, execute, refresh]);
	const entries =
		searchResults ||
		(data?.entries || []).filter((item) => item.name.toLowerCase().includes(query.toLowerCase()));
	return (
		<section className={`workspace-files${compact ? ' compact' : ''}`} aria-label="Workspace files">
			<header className="code-surface-toolbar">
				<button onClick={() => setDirectory(undefined)}>
					<Folder size={15} /> Workspace
				</button>
				<button
					className="icon-button"
					aria-label="Refresh files"
					onClick={() => setRefresh((n) => n + 1)}
				>
					<RefreshCw size={15} />
				</button>
			</header>
			{directory && (
				<div className="code-surface-breadcrumb">
					<button
						onClick={() => {
							const root = data?.roots.find((root) => directory === root.path);
							setDirectory(
								root ? undefined : directory.slice(0, directory.lastIndexOf('/')) || '/',
							);
						}}
					>
						..
					</button>
					<span title={directory}>{directory}</span>
				</div>
			)}
			<label className="code-surface-search">
				<Search size={15} />
				<input
					aria-label="Find files"
					placeholder={search ? 'Find files in workspace' : 'Filter files in this folder'}
					value={query}
					onChange={(e) => setQuery(e.target.value)}
				/>
			</label>
			{error && (
				<p role="alert" className="code-surface-error">
					{userFacingError(error)}
				</p>
			)}
			{loading ? (
				<p className="code-surface-notice">Loading files…</p>
			) : (
				<div className="workspace-file-list">
					{entries.map((entry) => (
						<button
							key={entry.path}
							title={entry.path}
							onClick={() => {
								setQuery('');
								entry.kind === 'directory' ? setDirectory(entry.path) : onOpen(entry.path);
							}}
						>
							{entry.kind === 'directory' ? <Folder size={16} /> : <File size={16} />}
							<span>{entry.name}</span>
							{entry.kind === 'directory' && <ChevronRight size={13} />}
						</button>
					))}
					{!entries.length && !error && (
						<p className="code-surface-notice">
							{query
								? 'No matching files.'
								: 'No files here. Choose a project with a workspace directory.'}
						</p>
					)}
				</div>
			)}
			{data?.truncated && (
				<p className="code-surface-notice">
					More files were omitted. Open a subfolder to narrow the list.
				</p>
			)}
			{data?.notices.map((note) => (
				<p key={note} className="code-surface-notice">
					{note}
				</p>
			))}
		</section>
	);
}

function SourceEditor({
	content,
	name,
	line,
	find,
}: {
	content: string;
	name: string;
	line?: number;
	find: string;
}) {
	const host = useRef<HTMLDivElement>(null);
	const editor = useRef<EditorView | undefined>(undefined);
	useEffect(() => {
		if (!host.current) return;
		const language = /\.(tsx?|jsx?|mjs|cjs)$/i.test(name)
			? javascript({ typescript: /\.tsx?$/.test(name), jsx: /\.[jt]sx$/.test(name) })
			: /\.py$/i.test(name)
				? python()
				: /\.(md|markdown)$/i.test(name)
					? markdown()
					: [];
		const view = new EditorView({
			parent: host.current,
			state: EditorState.create({
				doc: content,
				extensions: [
					lineNumbers(),
					highlightActiveLine(),
					keymap.of(defaultKeymap),
					language,
					syntaxHighlighting(sourceHighlight),
					EditorState.readOnly.of(true),
					EditorView.editable.of(false),
					EditorView.contentAttributes.of({ 'aria-label': `Source of ${name}`, tabindex: '0' }),
					EditorView.theme({
						'&': { height: '100%', color: 'var(--text)', backgroundColor: 'var(--bg)' },
						'.cm-scroller': {
							overflow: 'auto',
							fontFamily: 'var(--font-mono, monospace)',
							fontSize: '13px',
							lineHeight: '1.6',
						},
						'.cm-gutters': { backgroundColor: 'var(--bg)', color: 'var(--muted)', border: 'none' },
						'.cm-activeLine,.cm-activeLineGutter': { backgroundColor: 'var(--hover)' },
						'.cm-content': { padding: '12px 0' },
						'&.cm-focused': { outline: 'none' },
						'.cm-selectionBackground': { backgroundColor: '#4b82ca50 !important' },
					}),
				],
			}),
		});
		editor.current = view;
		return () => {
			editor.current = undefined;
			view.destroy();
		};
	}, [content, name]);
	useEffect(() => {
		const view = editor.current;
		if (!view) return;
		const target = find
			? content.toLowerCase().indexOf(find.toLowerCase())
			: line
				? view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines)).from
				: -1;
		if (target >= 0)
			view.dispatch({
				selection: { anchor: target, head: target + (find.length || 0) },
				effects: EditorView.scrollIntoView(target, { y: 'center' }),
			});
	}, [line, find, content]);
	return <div className="code-file-source" ref={host} />;
}

export default function CodeFilePanel({
	path,
	line,
	execute,
	search,
}: {
	path: string;
	line?: number;
	execute: SurfaceExecute;
	search?: SurfaceSearch;
}) {
	const [result, setResult] = useState<CodeSurfaceFileResult>();
	const [error, setError] = useState('');
	const [source, setSource] = useState(!!line);
	const [explorer, setExplorer] = useState(false);
	const [find, setFind] = useState('');
	const [finding, setFinding] = useState(false);
	const [reload, setReload] = useState(0);
	const actions = useCodeSurfaceActions();
	useEffect(() => {
		let active = true;
		setResult(undefined);
		setError('');
		void execute({ action: 'read', path })
			.then((value) => {
				if (active && value.kind === 'file') setResult(value);
			})
			.catch((e) => {
				if (active) setError(errorText(e));
			});
		return () => {
			active = false;
		};
	}, [path, execute, reload]);
	useEffect(() => {
		setSource(!!line);
		setFinding(false);
		setFind('');
	}, [line, path]);
	const isMarkdown = /\.(md|markdown)$/i.test(result?.name || path);
	const isHtml = /\.html?$/i.test(result?.name || path);
	const crumbs = useMemo(
		() => (result?.path || path).split('/').filter(Boolean),
		[path, result?.path],
	);
	return (
		<div className="code-file-panel">
			<header className="code-surface-toolbar">
				<div className="code-file-path" title={result?.path || path}>
					{crumbs.map((part, index) => (
						<span key={index}>
							{index > 0 && <ChevronRight size={12} />}
							{part}
						</span>
					))}
				</div>
				<button
					className="icon-button"
					aria-label="Find in file"
					onClick={() => {
						setFinding((v) => !v);
						setSource(true);
					}}
				>
					<Search size={15} />
				</button>
				{(isMarkdown || isHtml) && (
					<div className="code-file-view-switch" aria-label="File view">
						<button aria-pressed={!source} onClick={() => setSource(false)}>
							Preview
						</button>
						<button aria-pressed={source} onClick={() => setSource(true)}>
							Source
						</button>
					</div>
				)}
				<button
					className="icon-button"
					aria-label="Toggle file explorer"
					aria-pressed={explorer}
					onClick={() => setExplorer((v) => !v)}
				>
					{explorer ? <FolderOpen size={16} /> : <Folder size={16} />}
				</button>
				<button
					className="icon-button"
					aria-label="Reload file"
					onClick={() => setReload((v) => v + 1)}
				>
					<RefreshCw size={15} />
				</button>
			</header>
			{finding && (
				<label className="code-surface-search">
					<Search size={15} />
					<input
						autoFocus
						aria-label="Find in file"
						value={find}
						placeholder="Find in file"
						onChange={(e) => setFind(e.target.value)}
					/>
					<span>
						{find && result?.content
							? result.content.toLowerCase().split(find.toLowerCase()).length - 1
							: ''}
					</span>
					<button
						className="icon-button"
						aria-label="Close file search"
						onClick={() => {
							setFinding(false);
							setFind('');
						}}
					>
						<X size={14} />
					</button>
				</label>
			)}
			<div className={`code-file-body${explorer ? ' with-explorer' : ''}`}>
				<div className="code-file-content">
					{error ? (
						<p className="code-surface-error" role="alert">
							{userFacingError(error)}
						</p>
					) : !result ? (
						<p className="code-surface-notice">Opening file…</p>
					) : result.image ? (
						<div className="code-file-image">
							<img src={result.image.dataUrl} alt={result.name} />
						</div>
					) : result.content !== undefined ? (
						isHtml && !source ? (
							<HtmlPreview path={path} execute={execute} reload={reload} />
						) : isMarkdown && !source ? (
							<div className="code-file-markdown">
								<MessageMarkdown text={result.content} />
							</div>
						) : (
							<SourceEditor content={result.content} name={result.name} line={line} find={find} />
						)
					) : (
						<p className="code-surface-notice">
							{result.unavailable || 'Preview is unavailable for this file type.'}
						</p>
					)}
					{result?.truncated && (
						<p className="code-surface-notice">Preview shortened for this large file.</p>
					)}
				</div>
				{explorer && (
					<WorkspaceFiles
						compact
						search={search}
						execute={execute}
						onOpen={(path) => actions?.openFile(path)}
					/>
				)}
			</div>
		</div>
	);
}
