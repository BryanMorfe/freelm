import { describe, expect, it } from 'vitest';
import { EditorState, Transaction } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { inComposerCode, openComposerCode } from '../src/lib/composer-code';

function editor(doc: string) {
	return EditorState.create({
		doc,
		selection: { anchor: doc.length },
		extensions: [markdown(), openComposerCode],
	});
}

describe('composer code input', () => {
	it('opens a real fenced Markdown block and places typing inside it', () => {
		const state = editor('``');
		const next = state.update({
			changes: { from: 2, insert: '`' },
			selection: { anchor: 3 },
			annotations: Transaction.userEvent.of('input.type'),
		}).state;
		expect(next.doc.toString()).toBe('```\n\n```\n');
		expect(next.selection.main.head).toBe(4);
		expect(inComposerCode(next)).toBe(true);
	});
	it('preserves pasted fences and literal backticks inside code', () => {
		const state = editor('');
		const next = state.update({
			changes: { from: 0, insert: '```' },
			annotations: Transaction.userEvent.of('input.paste'),
		}).state;
		expect(next.doc.toString()).toBe('```');
		const code = editor('```python\nprint("``");');
		expect(
			code
				.update({
					changes: { from: code.doc.length, insert: '`' },
					annotations: Transaction.userEvent.of('input.type'),
				})
				.state.doc.toString(),
		).toBe('```python\nprint("``");`');
	});
	it('does not expand escaped, inline or IME-composing fence text', () => {
		for (const source of ['prefix ``', '\\``', '    ``']) {
			const state = editor(source);
			expect(
				state
					.update({
						changes: { from: source.length, insert: '`' },
						selection: { anchor: source.length + 1 },
						annotations: Transaction.userEvent.of('input.type'),
					})
					.state.doc.toString(),
			).toBe(source + '`');
		}
		const state = editor('``');
		expect(
			state
				.update({
					changes: { from: 2, insert: '`' },
					selection: { anchor: 3 },
					annotations: Transaction.userEvent.of('input.type.compose'),
				})
				.state.doc.toString(),
		).toBe('```');
	});
	it('distinguishes a code body from the prose after its closing fence', () => {
		const state = editor('```python\nif x > 5:\n    print(x)\n```\nExplain this');
		expect(inComposerCode(state, state.doc.line(3).from + 4)).toBe(true);
		expect(inComposerCode(state, state.doc.line(5).from + 2)).toBe(false);
	});
});
