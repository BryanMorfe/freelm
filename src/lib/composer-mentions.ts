import { EditorState, StateField, type Extension } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import type { ComposerReference } from '../composer-types';
import { scanComposerMath, inComposerDisplayMath } from './composer-markdown';

const MAX_DOCUMENT = 120_000;
import { scanComposerMentions, type ComposerMentionRange } from './composer-mention-codec';
export {
	createComposerMention,
	composerVisibleText,
	scanComposerMentions,
} from './composer-mention-codec';

function excludedRanges(state: EditorState) {
	const ranges: { from: number; to: number }[] = [];
	syntaxTree(state).iterate({
		enter(node) {
			if (['FencedCode', 'CodeBlock', 'InlineCode', 'HTMLBlock', 'HTMLTag'].includes(node.name)) {
				ranges.push({ from: node.from, to: node.to });
				return false;
			}
		},
	});
	return ranges;
}

export function composerReferences(state: EditorState): ComposerReference[] {
	const excluded = excludedRanges(state);
	const seen = new Set<string>();
	return scanComposerMentions(state.doc.toString())
		.filter((range) => {
			if (excluded.some((other) => range.from < other.to && range.to > other.from)) return false;
			const key = range.reference.token;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.map((range) => range.reference);
}

export interface ComposerTrigger {
	from: number;
	to: number;
	prefix: '/' | '@';
	query: string;
	commands: boolean;
}

/** Only intentional prose tokens complete: never URLs, email, code or equations. */
export function composerTrigger(state: EditorState): ComposerTrigger | undefined {
	const selection = state.selection.main;
	if (!selection.empty || state.selection.ranges.length !== 1 || state.doc.length > MAX_DOCUMENT)
		return;
	const position = selection.head;
	const line = state.doc.lineAt(position);
	const before = state.doc.sliceString(line.from, position);
	const match = /(?:^|[\s([{:])([/@])([^\s\[\](){},;]{0,256})$/.exec(before);
	if (!match) return;
	const from = position - match[2].length - 1;
	const excluded = excludedRanges(state);
	if (excluded.some((range) => position > range.from && position <= range.to)) return;
	const text = state.doc.toString();
	if (scanComposerMentions(text).some((range) => from >= range.from && from < range.to)) return;
	if (
		scanComposerMath(text, excluded).some(
			(range) => position > range.from && position <= range.to,
		) ||
		inComposerDisplayMath(state)
	)
		return;
	// An unfinished inline expression must remain literal while the user writes it.
	const mathPrefix = before.slice(0, from - line.from);
	if ((mathPrefix.match(/(?<!\\)\$/g)?.length ?? 0) % 2 || /\\\([^)]*$/.test(mathPrefix)) return;
	if (match[1] === '/' && (match[2].includes('/') || match[2].includes(':'))) return;
	if (match[1] === '@' && match[2].includes('@')) return;
	return {
		from,
		to: position,
		prefix: match[1] as '/' | '@',
		query: match[2],
		commands: !state.doc.sliceString(0, from).trim(),
	};
}

class MentionWidget extends WidgetType {
	constructor(readonly reference: ComposerReference) {
		super();
	}
	eq(other: MentionWidget) {
		return other.reference.token === this.reference.token;
	}
	toDOM(view: EditorView) {
		const element = view.dom.ownerDocument.createElement('span');
		element.className = `cm-composer-mention cm-composer-mention-${this.reference.kind}`;
		element.contentEditable = 'false';
		element.title = this.reference.path;
		element.setAttribute('aria-label', `${this.reference.kind}: ${this.reference.label}`);
		const icon = view.dom.ownerDocument.createElement('span');
		icon.className = 'cm-composer-mention-icon';
		icon.setAttribute('aria-hidden', 'true');
		icon.textContent =
			this.reference.kind === 'skill' ? '✦' : this.reference.kind === 'folder' ? '▱' : '@';
		if (this.reference.kind === 'app' && this.reference.icon) {
			const image = view.dom.ownerDocument.createElement('img');
			image.src = this.reference.icon;
			image.alt = '';
			image.width = 16;
			image.height = 16;
			icon.replaceChildren(image);
		}
		element.append(icon, view.dom.ownerDocument.createTextNode(this.reference.label));
		return element;
	}
}

function mentionDecorations(state: EditorState): DecorationSet {
	const excluded = excludedRanges(state);
	return Decoration.set(
		scanComposerMentions(state.doc.toString())
			.filter((range) => !excluded.some((other) => range.from < other.to && range.to > other.from))
			.map((range) =>
				Decoration.replace({ widget: new MentionWidget(range.reference), inclusive: false }).range(
					range.from,
					range.to,
				),
			),
		true,
	);
}

const mentionField = StateField.define<DecorationSet>({
	create: mentionDecorations,
	update(value, transaction) {
		return transaction.docChanged ||
			syntaxTree(transaction.startState) !== syntaxTree(transaction.state)
			? mentionDecorations(transaction.state)
			: value;
	},
	provide: (field) => [
		EditorView.decorations.from(field),
		EditorView.atomicRanges.of((view) => view.state.field(field)),
	],
});

export function composerMentionPresentation(): Extension {
	return mentionField;
}
