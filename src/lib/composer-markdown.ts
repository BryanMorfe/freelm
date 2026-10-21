import { syntaxTree } from '@codemirror/language';
import {
	EditorSelection,
	StateField,
	type EditorState,
	type Extension,
	type Range,
	type Line,
} from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';

const MAX_PRESENTATION_LENGTH = 120_000;
const MAX_DECORATIONS = 6_000;
const MAX_MATH_LENGTH = 2_000;
const MAX_MATH_WIDGETS = 40;
const MAX_CACHED_HTML = 1_048_576;
const MAX_FORMULA_HTML = 98_304;

interface SourceRange {
	from: number;
	to: number;
}
export interface ComposerMathRange extends SourceRange {
	contentFrom: number;
	contentTo: number;
	expression: string;
	display: boolean;
}

function escaped(text: string, position: number) {
	let slashes = 0;
	for (let index = position - 1; index >= 0 && text[index] === '\\'; index--) slashes++;
	return slashes % 2 === 1;
}

/** Bounded delimiter scanning. Exclusions are syntax-tree code ranges, not heuristic fences. */
export function scanComposerMath(
	text: string,
	excluded: readonly SourceRange[] = [],
): ComposerMathRange[] {
	if (text.length > MAX_PRESENTATION_LENGTH) return [];
	const ranges: ComposerMathRange[] = [];
	const blocks = [...excluded].sort((a, b) => a.from - b.from);
	let exclusion = 0;
	let inspected = 0;
	for (let from = 0; from < text.length && ranges.length < MAX_MATH_WIDGETS; from++) {
		while (exclusion < blocks.length && blocks[exclusion].to <= from) exclusion++;
		if (blocks[exclusion] && blocks[exclusion].from <= from) {
			from = blocks[exclusion].to - 1;
			continue;
		}
		let opener = '',
			closer = '',
			display = false;
		if (text.startsWith('$$', from)) {
			opener = closer = '$$';
			display = true;
		} else if (text[from] === '$' && text[from + 1] !== '$' && !/\s/.test(text[from + 1] || ' '))
			opener = closer = '$';
		else if (text.startsWith('\\(', from)) {
			opener = '\\(';
			closer = '\\)';
		} else if (text.startsWith('\\[', from)) {
			opener = '\\[';
			closer = '\\]';
			display = true;
		}
		if (!opener || escaped(text, from)) continue;
		const contentFrom = from + opener.length;
		const limit = Math.min(
			text.length,
			contentFrom + MAX_MATH_LENGTH + closer.length,
			blocks[exclusion]?.from ?? text.length,
		);
		let end = -1;
		for (let at = contentFrom; at < limit; at++) {
			if (++inspected > MAX_PRESENTATION_LENGTH * 2) return ranges;
			if (!display && closer === '$' && text[at] === '\n') break;
			if (!text.startsWith(closer, at) || escaped(text, at)) continue;
			if (
				closer === '$' &&
				(text[at - 1] === '$' ||
					text[at + 1] === '$' ||
					/\d/.test(text[at + 1] || '') ||
					/\s/.test(text[at - 1] || ' '))
			)
				break;
			end = at;
			break;
		}
		if (end < contentFrom || end - contentFrom > MAX_MATH_LENGTH) continue;
		const expression = text.slice(contentFrom, end);
		if (!expression.trim()) {
			from = end + closer.length - 1;
			continue;
		}
		ranges.push({
			from,
			to: end + closer.length,
			contentFrom,
			contentTo: end,
			expression,
			display,
		});
		from = end + closer.length - 1;
	}
	return ranges;
}

function codeRanges(state: EditorState): SourceRange[] {
	const ranges: SourceRange[] = [];
	syntaxTree(state).iterate({
		enter(node) {
			if (['FencedCode', 'CodeBlock', 'InlineCode', 'HTMLBlock'].includes(node.name)) {
				ranges.push({ from: node.from, to: node.to });
				return false;
			}
		},
	});
	return ranges;
}

/** Enter continues an open display expression, but never treats code/currency as math. */
export function inComposerDisplayMath(
	state: EditorState,
	position = state.selection.main.head,
): boolean {
	if (state.doc.length > MAX_PRESENTATION_LENGTH) return false;
	const text = state.doc.toString();
	const code = codeRanges(state);
	if (code.some((range) => position >= range.from && position < range.to)) return false;
	const complete = scanComposerMath(text, code);
	if (complete.some((range) => range.display && position > range.from && position < range.to))
		return true;
	const excluded = [...code, ...complete].sort((a, b) => a.from - b.from);
	let exclusion = 0;
	let closing: '$$' | '\\]' | undefined;
	for (let at = 0; at < position; at++) {
		while (exclusion < excluded.length && excluded[exclusion].to <= at) exclusion++;
		if (excluded[exclusion] && excluded[exclusion].from <= at) {
			closing = undefined;
			at = excluded[exclusion].to - 1;
			continue;
		}
		if (closing && text.startsWith(closing, at) && !escaped(text, at)) {
			at++;
			closing = undefined;
		} else if (!closing && text.startsWith('$$', at) && !escaped(text, at)) {
			at++;
			closing = '$$';
		} else if (!closing && text.startsWith('\\[', at) && !escaped(text, at)) {
			at++;
			closing = '\\]';
		}
	}
	return Boolean(closing);
}

function selectionTouches(state: EditorState, from: number, to: number, boundaries = false) {
	return state.selection.ranges.some((range) =>
		range.empty
			? boundaries
				? range.head >= from && range.head <= to
				: range.head > from && range.head < to
			: range.from < to && range.to > from,
	);
}

type Katex = typeof import('katex');
let katex: Promise<Katex> | undefined;
const htmlCache = new Map<string, string>();
let cachedBytes = 0;
const pendingHtml = new Map<string, Promise<string | undefined>>();
const renderJobs: (() => void)[] = [];
let scheduled = false;

function queueRender(job: () => void) {
	renderJobs.push(job);
	if (scheduled) return;
	scheduled = true;
	const next = () => {
		renderJobs.shift()?.();
		if (renderJobs.length) schedule(next);
		else scheduled = false;
	};
	schedule(next);
}
function schedule(run: () => void) {
	if (typeof window !== 'undefined' && 'requestIdleCallback' in window)
		window.requestIdleCallback(run, { timeout: 120 });
	else setTimeout(run, 16);
}
function formulaKey(expression: string, display: boolean) {
	return `${display ? 'display' : 'inline'}:${expression}`;
}
function renderFormula(expression: string, display: boolean): Promise<string | undefined> {
	const key = formulaKey(expression, display);
	if (htmlCache.has(key)) return Promise.resolve(htmlCache.get(key));
	if (pendingHtml.has(key)) return pendingHtml.get(key)!;
	if (pendingHtml.size >= 80) return Promise.resolve(undefined);
	katex ??= Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(
		([module]) => module,
	);
	const promise = katex
		.then(
			(module) =>
				new Promise<string | undefined>((resolve) =>
					queueRender(() => {
						try {
							const html = module.renderToString(expression, {
								displayMode: display,
								trust: false,
								strict: false,
								throwOnError: false,
								maxExpand: 200,
								maxSize: 20,
							});
							if (html.length > MAX_FORMULA_HTML) {
								resolve(undefined);
								return;
							}
							while (htmlCache.size >= 100 || cachedBytes + html.length > MAX_CACHED_HTML) {
								const oldest = htmlCache.keys().next().value;
								if (oldest === undefined) break;
								cachedBytes -= htmlCache.get(oldest)!.length;
								htmlCache.delete(oldest);
							}
							htmlCache.set(key, html);
							cachedBytes += html.length;
							resolve(html);
						} catch {
							resolve(undefined);
						}
					}),
				),
		)
		.catch(() => undefined)
		.finally(() => pendingHtml.delete(key));
	pendingHtml.set(key, promise);
	return promise;
}

class MathWidget extends WidgetType {
	constructor(readonly formula: ComposerMathRange) {
		super();
	}
	eq(other: MathWidget) {
		return (
			this.formula.from === other.formula.from &&
			this.formula.to === other.formula.to &&
			this.formula.expression === other.formula.expression &&
			this.formula.display === other.formula.display
		);
	}
	toDOM(view: EditorView) {
		const dom = view.dom.ownerDocument.createElement('span');
		dom.className = `cm-composer-math${this.formula.display ? ' cm-composer-math-display' : ''}`;
		dom.setAttribute('role', 'math');
		dom.setAttribute('aria-label', `Edit equation: ${this.formula.expression}`);
		dom.title = 'Edit equation';
		dom.contentEditable = 'false';
		dom.dataset.composerSourceFrom = String(this.formula.from);
		dom.dataset.composerSourceTo = String(this.formula.to);
		const edit = (event: MouseEvent) => {
			event.preventDefault();
			view.dispatch({
				selection: EditorSelection.single(this.formula.contentFrom, this.formula.contentTo),
				scrollIntoView: true,
			});
			view.focus();
		};
		dom.addEventListener('mousedown', edit);
		const cached = htmlCache.get(formulaKey(this.formula.expression, this.formula.display));
		if (cached) dom.innerHTML = cached;
		else {
			dom.textContent = this.formula.expression;
			dom.classList.add('cm-composer-math-loading');
			void renderFormula(this.formula.expression, this.formula.display).then((html) => {
				if (!dom.isConnected) return;
				if (html) dom.innerHTML = html;
				dom.classList.remove('cm-composer-math-loading');
				view.requestMeasure();
			});
		}
		return dom;
	}
	get estimatedHeight() {
		return this.formula.display ? 48 : 22;
	}
}

class FenceWidget extends WidgetType {
	constructor(
		readonly label: string,
		readonly position: number,
		readonly opening: boolean,
	) {
		super();
	}
	eq(other: FenceWidget) {
		return (
			this.label === other.label &&
			this.position === other.position &&
			this.opening === other.opening
		);
	}
	toDOM(view: EditorView) {
		const dom = view.dom.ownerDocument.createElement('div');
		dom.className = this.opening ? 'cm-composer-code-header' : 'cm-composer-code-footer';
		dom.contentEditable = 'false';
		dom.textContent = this.opening ? this.label : '\u200b';
		dom.addEventListener('mousedown', (event) => {
			event.preventDefault();
			view.dispatch({ selection: { anchor: this.position }, scrollIntoView: true });
			view.focus();
		});
		return dom;
	}
	get estimatedHeight() {
		return this.opening ? 29 : 8;
	}
}

const inlineClasses: Record<string, string> = {
	InlineCode: 'cm-composer-inline-code',
	StrongEmphasis: 'cm-composer-strong',
	Emphasis: 'cm-composer-em',
	Strikethrough: 'cm-composer-strike',
	Link: 'cm-composer-link',
};

function presentation(state: EditorState): DecorationSet {
	if (state.doc.length > MAX_PRESENTATION_LENGTH) return Decoration.none;
	const nodes: SyntaxNode[] = [],
		excluded: SourceRange[] = [];
	let limited = false;
	const tree = syntaxTree(state);
	tree.iterate({
		enter(ref) {
			if (nodes.length >= MAX_DECORATIONS) {
				limited = true;
				return false;
			}
			const node = ref.node;
			nodes.push(node);
			if (['FencedCode', 'CodeBlock', 'InlineCode', 'HTMLBlock'].includes(node.name)) {
				excluded.push({ from: node.from, to: node.to });
				return false;
			}
		},
	});
	// If exclusions are incomplete, leave the source literal rather than rendering
	// a dollar expression inside an unseen code region.
	if (limited) return Decoration.none;
	const math = scanComposerMath(state.doc.sliceString(0, tree.length), excluded);
	const decorations: Range<Decoration>[] = [];
	for (const formula of math) {
		if (selectionTouches(state, formula.from, formula.to)) continue;
		const first = state.doc.lineAt(formula.from),
			last = state.doc.lineAt(formula.to);
		const standalone =
			formula.display &&
			!state.doc.sliceString(first.from, formula.from).trim() &&
			!state.doc.sliceString(formula.to, last.to).trim();
		decorations.push(
			Decoration.replace({
				widget: new MathWidget(formula),
				block: standalone,
				inclusive: false,
			}).range(formula.from, formula.to),
		);
	}
	for (const node of nodes) {
		if (decorations.length >= MAX_DECORATIONS) break;
		if (
			math.some((formula) => node.from < formula.to && node.to > formula.from) &&
			node.name !== 'Document' &&
			node.name !== 'Paragraph'
		)
			continue;
		if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
			const first = state.doc.lineAt(node.from),
				last = state.doc.lineAt(node.to);
			const markers = node.getChildren('CodeMark');
			const closing =
				markers.length > 1 ? state.doc.lineAt(markers[markers.length - 1].from) : undefined;
			const firstBody = node.name === 'FencedCode' ? first.number + 1 : first.number;
			for (
				let number = firstBody;
				number <= (closing ? closing.number - 1 : last.number) &&
				decorations.length < MAX_DECORATIONS;
				number++
			)
				decorations.push(
					Decoration.line({ class: 'cm-composer-code-line' }).range(state.doc.line(number).from),
				);
			if (node.name !== 'FencedCode') continue;
			const info = node.getChild('CodeInfo');
			const language = info ? state.doc.sliceString(info.from, info.to).trim().slice(0, 40) : '';
			const fenceLines: { line: Line; opening: boolean }[] = [{ line: first, opening: true }];
			if (closing) fenceLines.push({ line: closing, opening: false });
			for (const { line, opening } of fenceLines) {
				decorations.push(
					Decoration.line({
						class: `cm-composer-fence-line cm-composer-code-${opening ? 'start' : 'end'}`,
					}).range(line.from),
				);
				if (line.to > line.from && !selectionTouches(state, line.from, line.to, true))
					decorations.push(
						Decoration.replace({
							widget: new FenceWidget(
								language || 'Code',
								line.from + Math.min(1, line.length),
								opening,
							),
							block: true,
							// Boundaries reveal the editable fence, so the inactive block
							// can cover the line without leaving empty inline buffer rows.
							inclusive: true,
						}).range(line.from, line.to),
					);
			}
		} else if (inlineClasses[node.name]) {
			decorations.push(
				Decoration.mark({ class: inlineClasses[node.name] }).range(node.from, node.to),
			);
			// Completing a code span should render it immediately, even while the
			// caret is just past its closing delimiter. Moving inside reveals source.
			if (!selectionTouches(state, node.from, node.to, node.name !== 'InlineCode'))
				for (let child = node.firstChild; child; child = child.nextSibling)
					if (['CodeMark', 'EmphasisMark', 'StrikethroughMark'].includes(child.name))
						decorations.push(Decoration.replace({}).range(child.from, child.to));
		} else if (/^ATXHeading[1-6]$/.test(node.name)) {
			decorations.push(
				Decoration.line({
					class: `cm-composer-heading cm-composer-heading-${node.name.slice(-1)}`,
				}).range(state.doc.lineAt(node.from).from),
			);
			const mark = node.getChild('HeaderMark');
			if (mark && !selectionTouches(state, node.from, node.to, true))
				decorations.push(Decoration.replace({}).range(mark.from, mark.to));
		} else if (node.name === 'Blockquote') {
			for (
				let number = state.doc.lineAt(node.from).number;
				number <= state.doc.lineAt(node.to).number && decorations.length < MAX_DECORATIONS;
				number++
			)
				decorations.push(
					Decoration.line({ class: 'cm-composer-quote-line' }).range(state.doc.line(number).from),
				);
		} else if (node.name === 'QuoteMark' && !selectionTouches(state, node.from, node.to, true)) {
			// The quote border already carries this structure. Keep markers editable
			// when the caret reaches their prefix, without showing them in the prose.
			decorations.push(Decoration.replace({}).range(node.from, node.to));
		}
	}
	return Decoration.set(decorations, true);
}

const presentationField = StateField.define<DecorationSet>({
	create: presentation,
	update(value, transaction) {
		return transaction.docChanged ||
			transaction.selection ||
			syntaxTree(transaction.startState) !== syntaxTree(transaction.state)
			? presentation(transaction.state)
			: value;
	},
	// Direct fields may replace line breaks and insert block widgets. ViewPlugin
	// decorations cannot do that because its viewport was computed before them.
	provide: (field) => EditorView.decorations.from(field),
});

/** Install alongside markdown(). Decorations never change the canonical source. */
export function composerMarkdownPresentation(): Extension {
	return presentationField;
}
