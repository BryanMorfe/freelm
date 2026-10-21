import { EditorState, Transaction } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';

export function inComposerCode(state: EditorState, position = state.selection.main.head) {
	for (let node = syntaxTree(state).resolveInner(position, -1); node; node = node.parent!) {
		if (node.name === 'FencedCode' || node.name === 'CodeBlock') return true;
	}
	return false;
}

/** Open an editable block on the third backtick, keeping real fences in Markdown. */
export const openComposerCode = EditorState.transactionFilter.of((transaction) => {
	if (
		!transaction.docChanged ||
		!transaction.isUserEvent('input.type') ||
		transaction.isUserEvent('input.type.compose') ||
		transaction.newSelection.ranges.length !== 1 ||
		!transaction.newSelection.main.empty ||
		inComposerCode(transaction.startState)
	)
		return transaction;
	const position = transaction.newSelection.main.head;
	const line = transaction.newDoc.lineAt(position);
	if (position !== line.to || !/^ {0,3}(```|~~~)$/.test(line.text)) return transaction;
	const fence = line.text.trim();
	return [
		transaction,
		{
			changes: { from: line.to, insert: `\n\n${fence}\n` },
			selection: { anchor: line.to + 1 },
			sequential: true,
			annotations: Transaction.userEvent.of('input.type'),
		},
	];
});
