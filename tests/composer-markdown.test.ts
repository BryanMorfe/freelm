import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState, Transaction } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { history, redo, undo } from '@codemirror/commands';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import {
	composerMarkdownPresentation,
	inComposerDisplayMath,
	scanComposerMath,
} from '../src/lib/composer-markdown';

function state(doc: string, cursor = doc.length) {
	return EditorState.create({
		doc,
		selection: { anchor: cursor },
		extensions: [markdown({ base: markdownLanguage }), history(), composerMarkdownPresentation()],
	});
}
function decorations(editor: EditorState) {
	const ranges: { from: number; to: number; value: Decoration }[] = [];
	for (const set of editor.facet(EditorView.decorations)) {
		expect(typeof set).not.toBe('function'); // Vertical changes must be provided directly.
		(set as DecorationSet).between(0, editor.doc.length, (from, to, value) => {
			ranges.push({ from, to, value });
		});
	}
	return ranges;
}
const widgets = (editor: EditorState) =>
	decorations(editor).filter((range) => range.value.spec.widget?.formula);
const hiddenSource = (editor: EditorState) =>
	decorations(editor)
		.filter((range) => !range.value.spec.class && !range.value.spec.widget && range.from < range.to)
		.map((range) => editor.doc.sliceString(range.from, range.to));

describe('composer math delimiters', () => {
	it('recognizes inline/display and conventional delimiters without changing their source', () => {
		const source = String.raw`A $x^2$ then $$y=mx+b$$ then \(a+b\) and \[\frac{1}{2}\].`;
		const ranges = scanComposerMath(source);
		expect(ranges.map((range) => [range.expression, range.display])).toEqual([
			['x^2', false],
			['y=mx+b', true],
			['a+b', false],
			[String.raw`\frac{1}{2}`, true],
		]);
		for (const range of ranges)
			expect(source.slice(range.contentFrom, range.contentTo)).toBe(range.expression);
		expect(state(source).doc.toString()).toBe(source);
	});
	it('leaves escaped dollars, currency, blank delimiters, and incomplete inline math literal', () => {
		expect(
			scanComposerMath(
				String.raw`Cost \$5.00 or $10.00 and $20.00 today. $ $ $$$$ and $unfinished`,
			),
		).toEqual([]);
		expect(scanComposerMath('$x\\$y$')).toMatchObject([{ expression: 'x\\$y' }]);
	});
	it('does not interpret equations in fenced, indented, or inline code', () => {
		const editor = state(
			'```python\nvalue="$raw$"\n```\n\n    $indented$\n\n`$inline$` and $real$',
		);
		expect(widgets(editor).map((range) => range.value.spec.widget.formula.expression)).toEqual([
			'real',
		]);
	});
	it('bounds oversized expressions, large pasted documents, and numerous formulas', () => {
		expect(scanComposerMath('$' + 'x'.repeat(2001) + '$')).toEqual([]);
		expect(scanComposerMath('a'.repeat(120001) + '$x$')).toEqual([]);
		expect(scanComposerMath(Array(100).fill('$x$').join(' '))).toHaveLength(40);
	});
});

describe('Markdown presentation preserves the editable source', () => {
	it('replaces inactive math and reveals it for selections, then restores the widget on moving out', () => {
		let editor = state('before $x+1$ after');
		expect(widgets(editor)).toHaveLength(1);
		editor = editor.update({ selection: EditorSelection.single(8, 11) }).state;
		expect(widgets(editor)).toHaveLength(0);
		expect(editor.doc.toString()).toBe('before $x+1$ after');
		editor = editor.update({ selection: { anchor: editor.doc.length } }).state;
		expect(widgets(editor)).toHaveLength(1);
	});
	it('provides standalone multiline equations as block replacements from a StateField', () => {
		const editor = state('before\n$$\na+b\n$$\nafter');
		const rendered = widgets(editor);
		expect(rendered).toHaveLength(1);
		expect(rendered[0].value.spec.block).toBe(true);
		expect(editor.doc.toString()).toContain('$$\na+b\n$$');
	});
	it('styles code as editable lines and hides only inactive fence markers', () => {
		const doc = '```python\nif x > 5:\n    print(x)\n```\nafter';
		let editor = state(doc, doc.indexOf('print'));
		const styled = decorations(editor);
		expect(
			styled.filter((range) => range.value.spec.class === 'cm-composer-code-line'),
		).toHaveLength(2);
		expect(styled.filter((range) => range.value.spec.widget?.label)).toHaveLength(2);
		expect(
			styled
				.filter((range) => range.value.spec.widget?.label)
				.every((range) => range.value.spec.block && range.value.spec.inclusive),
		).toBe(true);
		expect(editor.doc.toString()).toBe(doc);
		editor = editor.update({ selection: { anchor: 2 } }).state;
		expect(decorations(editor).filter((range) => range.value.spec.widget?.label)).toHaveLength(1);
		for (const line of [editor.doc.line(1), editor.doc.line(4)]) {
			for (const anchor of [line.from, line.to]) {
				const selected = editor.update({ selection: { anchor } }).state;
				expect(
					decorations(selected).filter(
						(range) => range.value.spec.widget?.label && range.from === line.from,
					),
				).toHaveLength(0);
				expect(selected.doc.toString()).toBe(doc);
			}
		}
	});
	it('retains code styling for an unfinished fence while the body is typed', () => {
		const editor = state('```\nif x > 5:\n    print(x)');
		expect(
			decorations(editor).filter((range) => range.value.spec.class === 'cm-composer-code-line'),
		).toHaveLength(2);
	});
	it('styles bold/italic/inline code while keeping their Markdown markers recoverable', () => {
		let editor = state('**bold** *emphasis* `code` after');
		expect(
			decorations(editor)
				.map((range) => range.value.spec.class)
				.filter(Boolean),
		).toEqual(['cm-composer-strong', 'cm-composer-em', 'cm-composer-inline-code']);
		editor = editor.update({ selection: { anchor: 4 } }).state;
		expect(editor.doc.toString()).toBe('**bold** *emphasis* `code` after');
		expect(
			decorations(editor).filter(
				(range) =>
					range.from === 0 &&
					range.to === 2 &&
					range.value.spec.widget === undefined &&
					range.value.spec.class === undefined,
			),
		).toHaveLength(0);
	});
	it('hides completed inline backticks immediately and keeps completion in normal undo history', () => {
		let editor = state('`code');
		expect(hiddenSource(editor)).toEqual([]);
		editor = editor.update({
			changes: { from: editor.doc.length, insert: '`' },
			selection: { anchor: 6 },
			annotations: Transaction.userEvent.of('input.type'),
		}).state;
		expect(hiddenSource(editor)).toEqual(['`', '`']);
		expect(editor.doc.toString()).toBe('`code`');
		expect(editor.selection.main.head).toBe(6);
		expect(undo({ state: editor, dispatch: (transaction) => (editor = transaction.state) })).toBe(
			true,
		);
		expect(editor.doc.toString()).toBe('`code');
		expect(hiddenSource(editor)).toEqual([]);
		expect(redo({ state: editor, dispatch: (transaction) => (editor = transaction.state) })).toBe(
			true,
		);
		expect(editor.doc.toString()).toBe('`code`');
		expect(hiddenSource(editor)).toEqual(['`', '`']);
	});
	it('reveals inline code when editing its interior, including multi-backtick spans', () => {
		let editor = state('``one ` two``');
		expect(hiddenSource(editor)).toEqual(['``', '``']);
		editor = editor.update({ selection: { anchor: 5 } }).state;
		expect(hiddenSource(editor)).toEqual([]);
		editor = editor.update({ selection: EditorSelection.single(2, 7) }).state;
		expect(hiddenSource(editor)).toEqual([]);
		editor = editor.update({ selection: { anchor: editor.doc.length } }).state;
		expect(hiddenSource(editor)).toEqual(['``', '``']);
		expect(editor.doc.toString()).toBe('``one ` two``');
	});
	it('uses quote borders without literal markers while editing prose', () => {
		const source = '> first line\n> second line\n>> nested line';
		let editor = state(source);
		expect(hiddenSource(editor)).toEqual(['>', '>', '>', '>']);
		expect(
			decorations(editor).filter((range) => range.value.spec.class === 'cm-composer-quote-line'),
		).not.toHaveLength(0);
		editor = editor.update({ selection: { anchor: 4 } }).state;
		expect(hiddenSource(editor)).toEqual(['>', '>', '>', '>']);
		editor = editor.update({ selection: EditorSelection.single(2, 6) }).state;
		expect(hiddenSource(editor)).toEqual(['>', '>', '>', '>']);
		expect(editor.doc.toString()).toBe(source);
	});
	it('reveals quote prefixes when selecting their marker, then hides them on returning to prose', () => {
		let editor = state('> editable quote', 0);
		expect(hiddenSource(editor)).toEqual([]);
		editor = editor.update({ selection: EditorSelection.single(0, 1) }).state;
		expect(hiddenSource(editor)).toEqual([]);
		editor = editor.update({ selection: { anchor: 2 } }).state;
		expect(hiddenSource(editor)).toEqual(['>']);
		editor = editor.update({ changes: { from: 2, insert: 'still ' } }).state;
		expect(editor.doc.toString()).toBe('> still editable quote');
		expect(hiddenSource(editor)).toEqual(['>']);
	});
	it('does not hide literal greater-than characters in code or escaped prose', () => {
		const source = '``> inline``\n\n```text\n> fenced\n```\n\n\\> literal';
		expect(hiddenSource(state(source))).not.toContain('>');
	});
});

describe('display math Enter context', () => {
	it('recognizes open and completed display expressions only while their source is being edited', () => {
		expect(inComposerDisplayMath(state('$$'))).toBe(true);
		expect(inComposerDisplayMath(state('$$\nx+1'))).toBe(true);
		expect(inComposerDisplayMath(state(String.raw`\[x+1`))).toBe(true);
		expect(inComposerDisplayMath(state('$$x+1$$', 4))).toBe(true);
		expect(inComposerDisplayMath(state('$$x+1$$'))).toBe(false);
	});
	it('ignores escaped openers, code, inline equations, and currency', () => {
		for (const source of [String.raw`\$$`, '```\n$$', '`$$`', '$x+1$', 'Cost $5 or $10'])
			expect(inComposerDisplayMath(state(source))).toBe(false);
	});
});
