import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { Compartment, EditorState, Prec, Transaction } from '@codemirror/state';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import {
	defaultKeymap,
	history,
	historyKeymap,
	indentWithTab,
	insertNewlineAndIndent,
	isolateHistory,
} from '@codemirror/commands';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import {
	markdown,
	markdownLanguage as gfmMarkdownLanguage,
	insertNewlineContinueMarkup,
} from '@codemirror/lang-markdown';
import { javascriptLanguage, typescriptLanguage } from '@codemirror/lang-javascript';
import { pythonLanguage } from '@codemirror/lang-python';
import { htmlToMarkdown, LARGE_PASTE_THRESHOLD } from '../lib/composer-content';
import { inComposerCode, openComposerCode } from '../lib/composer-code';
import { composerMarkdownPresentation, inComposerDisplayMath } from '../lib/composer-markdown';
import { File, Folder, Sparkles, Flag, ListTodo, Paperclip, Monitor } from 'lucide-react';
import type {
	ComposerContext,
	ComposerDiscoveryResult,
	ComposerSuggestion,
} from '../composer-types';
import {
	composerMentionPresentation,
	composerReferences,
	composerTrigger,
	createComposerMention,
	type ComposerTrigger,
} from '../lib/composer-mentions';
import {
	COMPOSER_REFERENCE_LIMIT,
	COMPOSER_MENTION_DOCUMENT_LIMIT,
	scanComposerMentions,
} from '../lib/composer-mention-codec';
import type { PluginEditorEdit } from '../lib/plugin-surface-controller';
import './markdown-composer.css';

export interface MarkdownComposerHandle {
	focus: () => void;
	clear: () => void;
	insertText: (text: string, spaced?: boolean) => void;
	appendText: (text: string) => void;
	getSelection: () => { from: number; to: number; text: string };
	applyEdit: (edit: PluginEditorEdit) => void;
}
interface Props {
	value: string;
	onChange: (value: string) => void;
	onBlur: () => void;
	onSubmit: () => void;
	onRestorePrevious: () => boolean;
	onFiles: (files: FileList) => void;
	onLargePaste: (text: string) => void;
	onError: (message: string) => void;
	placeholder: string;
	disabled?: boolean;
	busy?: boolean;
	code?: boolean;
	context?: ComposerContext;
	onContextChange?: (context: ComposerContext) => void;
	discover?: (request: {
		kind: 'files' | 'skills' | 'apps';
		query: string;
	}) => Promise<ComposerDiscoveryResult>;
	onRequestFiles?: () => void;
	onPluginKey?: (key: string) => boolean;
	onFocusChange?: (focused: boolean) => void;
	onSelectionChange?: () => void;
}

type CompletionAction = 'files' | 'skills' | 'apps' | 'goal' | 'plan' | 'attach';
interface CompletionRow {
	label: string;
	description?: string;
	item?: ComposerSuggestion;
	action?: CompletionAction;
}
interface CompletionMenu {
	trigger: ComposerTrigger;
	rows: CompletionRow[];
	selected: number;
	loading?: boolean;
	warning?: string;
	kind?: 'files' | 'skills' | 'apps';
}
const completionIcons = {
	app: Monitor,
	apps: Monitor,
	file: File,
	folder: Folder,
	skill: Sparkles,
	files: Folder,
	skills: Sparkles,
	goal: Flag,
	plan: ListTodo,
	attach: Paperclip,
};

const markdownLanguage = markdown({
	base: gfmMarkdownLanguage,
	addKeymap: false,
	completeHTMLTags: false,
	pasteURLAsLink: false,
	codeLanguages: (info) => {
		const language = info.toLowerCase().split(/\s/)[0];
		if (['js', 'javascript', 'jsx'].includes(language)) return javascriptLanguage;
		if (['ts', 'typescript', 'tsx'].includes(language)) return typescriptLanguage;
		if (['py', 'python'].includes(language)) return pythonLanguage;
		return null;
	},
});

const composerHighlight = HighlightStyle.define([
	{ tag: tags.keyword, class: 'hljs-keyword' },
	{ tag: [tags.string, tags.regexp], class: 'hljs-string' },
	{ tag: [tags.number, tags.bool, tags.typeName], class: 'hljs-number' },
	{ tag: tags.comment, class: 'hljs-comment' },
	{ tag: [tags.function(tags.variableName), tags.propertyName], class: 'hljs-title' },
]);

export default forwardRef<MarkdownComposerHandle, Props>(function MarkdownComposer(props, ref) {
	const parent = useRef<HTMLDivElement>(null);
	const editor = useRef<EditorView | null>(null);
	const resetEditor = useRef<((value: string) => void) | null>(null);
	const callbacks = useRef(props);
	callbacks.current = props;
	const editable = useRef(new Compartment());
	const attributes = useRef(new Compartment());
	const hint = useRef(new Compartment());
	const [menu, setMenuState] = useState<CompletionMenu>();
	const menuRef = useRef<CompletionMenu | undefined>(undefined);
	const context = useRef<ComposerContext>(props.context ?? {});
	const completionEpoch = useRef(0);
	const completionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const dismissed = useRef('');
	const submenu = useRef<{ from: number; kind: 'files' | 'skills' | 'apps' } | undefined>(
		undefined,
	);
	useLayoutEffect(() => {
		context.current = props.context ?? {};
	}, [props.context]);
	function setMenu(next?: CompletionMenu) {
		menuRef.current = next;
		setMenuState(next);
	}
	function updateContext(next: ComposerContext) {
		context.current = next;
		callbacks.current.onContextChange?.(next);
	}
	function closeCompletion() {
		completionEpoch.current++;
		clearTimeout(completionTimer.current);
		setMenu(undefined);
	}
	function refreshCompletion(view: EditorView, force = false) {
		clearTimeout(completionTimer.current);
		const epoch = ++completionEpoch.current;
		if (
			!callbacks.current.code ||
			callbacks.current.disabled ||
			view.composing ||
			view.compositionStarted ||
			!view.hasFocus
		) {
			setMenu(undefined);
			return;
		}
		const trigger = composerTrigger(view.state);
		const key = trigger ? `${trigger.from}:${trigger.to}:${trigger.prefix}:${trigger.query}` : '';
		if (!trigger || (!force && dismissed.current === key)) {
			setMenu(undefined);
			return;
		}
		if (submenu.current?.from !== trigger.from || trigger.prefix !== '@')
			submenu.current = undefined;
		const kind =
			submenu.current?.kind ?? (trigger.prefix === '@' && trigger.query ? 'files' : undefined);
		const query = trigger.query.toLowerCase();
		const rows: CompletionRow[] = [];
		if (trigger.prefix === '@' && !trigger.query && !kind) {
			rows.push(
				{
					label: 'Files and folders',
					description: 'Mention something in this workspace',
					action: 'files',
				},
				{ label: 'Skills', description: 'Use a configured skill', action: 'skills' },
				{ label: 'Apps', description: 'Use an app on this computer', action: 'apps' },
			);
		}
		if (!kind && (trigger.prefix === '@' || trigger.commands)) {
			if (!query || 'goal'.startsWith(query))
				rows.push({ label: 'Goal', description: 'Set a goal to keep pursuing', action: 'goal' });
			if (!query || 'plan'.startsWith(query))
				rows.push({
					label: 'Plan mode',
					description: 'Create a plan before making changes',
					action: 'plan',
				});
		}
		if (trigger.prefix === '@' && !trigger.query && !kind && callbacks.current.onRequestFiles)
			rows.push({ label: 'Attach files', description: 'Add an attachment', action: 'attach' });
		const requestKind = trigger.prefix === '/' ? 'skills' : kind;
		setMenu({
			trigger,
			rows,
			selected: 0,
			kind,
			loading: Boolean(requestKind && callbacks.current.discover),
		});
		if (!requestKind) return;
		if (!callbacks.current.discover) {
			setMenu({ trigger, rows, selected: 0, kind, warning: 'Workspace discovery is unavailable.' });
			return;
		}
		completionTimer.current = setTimeout(async () => {
			try {
				const result = await callbacks.current.discover!({
					kind: requestKind,
					query: trigger.query,
				});
				if (epoch !== completionEpoch.current || !view.hasFocus || callbacks.current.disabled)
					return;
				const items = result.items.slice(0, 16).map((item) => ({
					label: item.label,
					description: item.description || item.path,
					item,
				}));
				setMenu({
					trigger,
					rows: [...rows, ...items],
					selected: 0,
					kind,
					warning: result.warnings?.join(' '),
				});
			} catch (cause) {
				if (epoch !== completionEpoch.current) return;
				setMenu({
					trigger,
					rows,
					selected: 0,
					kind,
					warning: cause instanceof Error ? cause.message : 'Workspace discovery failed.',
				});
			}
		}, 120);
	}
	function chooseCompletion(row: CompletionRow) {
		const view = editor.current,
			current = menuRef.current;
		if (!view || !current || callbacks.current.disabled) return;
		if (row.action === 'files' || row.action === 'skills' || row.action === 'apps') {
			submenu.current = { from: current.trigger.from, kind: row.action };
			view.focus();
			refreshCompletion(view, true);
			return;
		}
		let insert = '';
		if (row.item) {
			const reference = createComposerMention(row.item);
			const references = composerReferences(view.state);
			if (
				references.length >= COMPOSER_REFERENCE_LIMIT &&
				!references.some((item) => item.token === reference.token)
			) {
				callbacks.current.onError(
					`You can mention up to ${COMPOSER_REFERENCE_LIMIT} files and skills in one message.`,
				);
				closeCompletion();
				return;
			}
			insert = `${reference.token} `;
		} else if (row.action === 'goal' || row.action === 'plan')
			updateContext({ ...context.current, mode: row.action });
		closeCompletion();
		submenu.current = undefined;
		view.dispatch({
			changes: { from: current.trigger.from, to: current.trigger.to, insert },
			selection: { anchor: current.trigger.from + insert.length },
			annotations: [Transaction.userEvent.of('input.complete'), isolateHistory.of('full')],
			scrollIntoView: true,
		});
		view.focus();
		if (row.action === 'attach') callbacks.current.onRequestFiles?.();
	}
	function navigateCompletion(offset: number) {
		const current = menuRef.current;
		if (!current || !current.rows.length) return false;
		const selected = (current.selected + offset + current.rows.length) % current.rows.length;
		setMenu({ ...current, selected });
		requestAnimationFrame(() =>
			parent.current
				?.querySelector(`[data-completion-index="${selected}"]`)
				?.scrollIntoView({ block: 'nearest' }),
		);
		return true;
	}
	function acceptCompletion(view: EditorView) {
		if (view.composing || view.compositionStarted) return false;
		const current = menuRef.current;
		if (!current) return false;
		if (current.rows[current.selected]) chooseCompletion(current.rows[current.selected]);
		// A loading or empty picker must never unexpectedly send the unfinished token.
		return true;
	}
	function insertText(text: string, spaced = false) {
		const view = editor.current;
		if (!view || callbacks.current.disabled) return;
		if (spaced) {
			const { from, to } = view.state.selection.main;
			const before = view.state.doc.sliceString(Math.max(0, from - 1), from);
			const after = view.state.doc.sliceString(to, to + 1);
			text = `${before && !/\s/.test(before) ? ' ' : ''}${text}${after && !/[\s.,!?;:)]/.test(after) ? ' ' : ''}`;
		}
		view.dispatch({
			...view.state.replaceSelection(text),
			annotations: Transaction.userEvent.of('input.paste'),
			scrollIntoView: true,
		});
		view.focus();
	}
	useImperativeHandle(
		ref,
		() => ({
			focus: () => editor.current?.focus(),
			clear: () => resetEditor.current?.(''),
			getSelection: () => {
				const view = editor.current;
				if (!view) return { from: 0, to: 0, text: '' };
				const { from, to } = view.state.selection.main;
				return { from, to, text: view.state.sliceDoc(from, to) };
			},
			applyEdit: (edit) => {
				const view = editor.current;
				if (!view || callbacks.current.disabled) throw new Error('The composer is not editable.');
				view.dispatch({
					changes: edit.changes,
					selection: edit.selection,
					annotations: [Transaction.userEvent.of('input.plugin'), isolateHistory.of('full')],
					scrollIntoView: true,
				});
			},
			insertText,
			appendText: (text: string) => {
				const view = editor.current;
				if (!view || callbacks.current.disabled) return;
				const end = view.state.doc.length;
				view.dispatch({
					changes: { from: end, insert: text },
					selection: { anchor: end + text.length },
					annotations: Transaction.userEvent.of('input.paste'),
					scrollIntoView: true,
				});
				view.focus();
			},
		}),
		[],
	);
	useLayoutEffect(() => {
		if (!parent.current) return;
		const createState = (value: string) =>
			EditorState.create({
				doc: value,
				selection: { anchor: value.length },
				extensions: [
					markdownLanguage,
					history(),
					openComposerCode,
					composerMarkdownPresentation(),
					composerMentionPresentation(),
					syntaxHighlighting(composerHighlight),
					EditorView.lineWrapping,
					editable.current.of(EditorView.editable.of(!callbacks.current.disabled)),
					attributes.current.of(
						EditorView.contentAttributes.of({
							role: 'textbox',
							'aria-label': 'Message',
							'aria-multiline': 'true',
							'aria-busy': String(!!callbacks.current.busy),
							'aria-disabled': String(!!callbacks.current.disabled),
							spellcheck: 'true',
						}),
					),
					hint.current.of(placeholder(callbacks.current.placeholder)),
					Prec.highest(
						EditorView.domEventHandlers({
							keydown: (event, view) =>
								event.key === 'Enter' &&
								(event.isComposing || event.keyCode === 229 || view.compositionStarted),
						}),
					),
					Prec.high(
						keymap.of([
							{ key: 'ArrowDown', run: () => navigateCompletion(1) },
							{ key: 'ArrowUp', run: () => navigateCompletion(-1) },
							{ key: 'Enter', run: acceptCompletion },
							{ key: 'Tab', run: acceptCompletion },
							{
								key: 'Escape',
								run: () => {
									const current = menuRef.current;
									if (!current) return false;
									dismissed.current = `${current.trigger.from}:${current.trigger.to}:${current.trigger.prefix}:${current.trigger.query}`;
									closeCompletion();
									return true;
								},
							},
						]),
					),
					// Mention completion has higher precedence. Extensions only receive a
					// matching command key, never the user's raw keystroke stream.
					keymap.of(
						[
							'Tab',
							'Escape',
							...'abcdefghijklmnopqrstuvwxyz'
								.split('')
								.flatMap((key) => [
									`Mod-${key}`,
									`Mod-Shift-${key}`,
									`Alt-${key}`,
									`Alt-Shift-${key}`,
								]),
						].map((key) => ({
							key,
							run: (view: EditorView) =>
								!view.composing &&
								!view.compositionStarted &&
								!callbacks.current.disabled &&
								!!callbacks.current.onPluginKey?.(key),
						})),
					),
					keymap.of([
						{
							key: 'Mod-Enter',
							run: (view) => {
								if (view.composing || view.compositionStarted) return false;
								callbacks.current.onSubmit();
								return true;
							},
						},
						{
							key: 'Enter',
							run: (view) => {
								if (view.composing || view.compositionStarted) return false;
								if (inComposerCode(view.state) || inComposerDisplayMath(view.state))
									return insertNewlineAndIndent(view);
								callbacks.current.onSubmit();
								return true;
							},
						},
						{
							key: 'Shift-Enter',
							run: (view) => insertNewlineContinueMarkup(view) || insertNewlineAndIndent(view),
						},
						{
							key: 'ArrowUp',
							run: (view) =>
								!view.state.doc.length &&
								!view.composing &&
								!view.compositionStarted &&
								callbacks.current.onRestorePrevious(),
						},
						{
							...indentWithTab,
							run: (view) => inComposerCode(view.state) && indentWithTab.run!(view),
							shift: (view) => inComposerCode(view.state) && indentWithTab.shift!(view),
						},
						...historyKeymap,
						...defaultKeymap,
					]),
					EditorView.domEventHandlers({
						blur: () => {
							closeCompletion();
							callbacks.current.onFocusChange?.(false);
							callbacks.current.onBlur();
							return false;
						},
						focus: (_event, view) => {
							callbacks.current.onFocusChange?.(true);
							refreshCompletion(view);
							return false;
						},
						paste: (event) => {
							if (callbacks.current.disabled) return true;
							const data = event.clipboardData;
							if (!data) return false;
							if (data.files.length) {
								callbacks.current.onFiles(data.files);
								return true;
							}
							const plain = data.getData('text/plain');
							const html = data.getData('text/html');
							if (!plain && !html) return false;
							try {
								const text = inComposerCode(view.state)
									? plain || htmlToMarkdown(html)
									: html
										? htmlToMarkdown(html) || plain
										: plain;
								if (text.length > LARGE_PASTE_THRESHOLD) callbacks.current.onLargePaste(text);
								else if (
									callbacks.current.code &&
									new Set(
										[
											...composerReferences(view.state),
											...scanComposerMentions(text).map((range) => range.reference),
										].map((reference) => reference.token),
									).size > COMPOSER_REFERENCE_LIMIT
								) {
									callbacks.current.onError(
										`You can mention up to ${COMPOSER_REFERENCE_LIMIT} files and skills in one message.`,
									);
									return true;
								} else insertText(text);
								callbacks.current.onError('');
							} catch (cause) {
								callbacks.current.onError(cause instanceof Error ? cause.message : String(cause));
							}
							return true;
						},
					}),
					EditorView.updateListener.of((update) => {
						if (update.docChanged) {
							if (callbacks.current.code) {
								if (
									update.state.doc.length > COMPOSER_MENTION_DOCUMENT_LIMIT &&
									context.current.references?.length
								)
									callbacks.current.onError(
										'This draft is too long to process mentions. Shorten it or attach the text as a file.',
									);
								else {
									const references = composerReferences(update.state);
									if (
										JSON.stringify(references) !== JSON.stringify(context.current.references ?? [])
									)
										updateContext({ ...context.current, references });
								}
							}
							callbacks.current.onChange(update.state.doc.toString());
						}
						if (update.selectionSet) callbacks.current.onSelectionChange?.();
						if (update.docChanged || update.selectionSet) refreshCompletion(update.view);
					}),
				],
			});
		const view = new EditorView({
			parent: parent.current,
			state: createState(callbacks.current.value),
		});
		editor.current = view;
		resetEditor.current = (value) => {
			closeCompletion();
			submenu.current = undefined;
			dismissed.current = '';
			view.setState(createState(value));
		};
		return () => {
			clearTimeout(completionTimer.current);
			completionEpoch.current++;
			view.destroy();
			editor.current = null;
			resetEditor.current = null;
		};
	}, []);
	useLayoutEffect(() => {
		const view = editor.current;
		if (!view) return;
		// Externally restored/replaced drafts start their own history. Editing,
		// paste, dictation, and quotes dispatch transactions in this view instead.
		// Never let Undo resurrect a previous conversation's draft after navigation.
		if (view.state.doc.toString() !== props.value) resetEditor.current?.(props.value);
	}, [props.value]);
	useLayoutEffect(() => {
		if (!props.code || props.disabled) closeCompletion();
		editor.current?.dispatch({
			effects: [
				editable.current.reconfigure(EditorView.editable.of(!props.disabled)),
				attributes.current.reconfigure(
					EditorView.contentAttributes.of({
						role: 'textbox',
						'aria-label': 'Message',
						'aria-multiline': 'true',
						'aria-busy': String(!!props.busy),
						'aria-disabled': String(!!props.disabled),
						spellcheck: 'true',
					}),
				),
				hint.current.reconfigure(placeholder(props.placeholder)),
			],
		});
	}, [props.disabled, props.busy, props.placeholder, props.code]);
	return (
		<div className="markdown-composer-shell">
			{menu && (
				<div className="composer-completions" role="listbox" aria-label="Composer suggestions">
					<div className="composer-completions-heading">
						{menu.kind === 'apps'
							? 'Computer Use'
							: menu.kind === 'files'
								? submenu.current?.kind === 'files'
									? 'Files and folders'
									: 'Suggestions'
								: menu.kind === 'skills' || menu.trigger.prefix === '/'
									? 'Commands and skills'
									: 'Add'}
					</div>
					<div className="composer-completions-items">
						{menu.rows.map((row, index) => {
							const Icon = completionIcons[row.item?.kind ?? row.action ?? 'file'];
							return (
								<button
									type="button"
									role="option"
									aria-selected={index === menu.selected}
									className={`composer-completion${index === menu.selected ? ' selected' : ''}`}
									data-completion-index={index}
									key={`${row.action ?? row.item?.id}:${index}`}
									onMouseDown={(event) => event.preventDefault()}
									onClick={() => chooseCompletion(row)}
									onMouseEnter={() => setMenu({ ...menu, selected: index })}
								>
									{row.item?.icon ? (
										<img className="composer-app-icon" src={row.item.icon} alt="" />
									) : (
										<Icon size={17} aria-hidden="true" />
									)}
									<span className="composer-completion-copy">
										<span className="composer-completion-label">{row.label}</span>
										{row.description && (
											<span className="composer-completion-description">{row.description}</span>
										)}
									</span>
								</button>
							);
						})}
					</div>
					{menu.loading && (
						<div className="composer-completion-status" role="status">
							Finding matches…
						</div>
					)}
					{!menu.loading && !menu.rows.length && !menu.warning && (
						<div className="composer-completion-status" role="status">
							No matches
						</div>
					)}
					{menu.warning && (
						<div className="composer-completion-status" role="status">
							{userFacingError(menu.warning)}
						</div>
					)}
				</div>
			)}
			<div className="markdown-composer" ref={parent} />
		</div>
	);
});
import { userFacingError } from '../lib/user-facing-error';
