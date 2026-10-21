import { describe, expect, it } from 'vitest';
import { EditorState, Transaction } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { history, redo, undo, isolateHistory } from '@codemirror/commands';
import { EditorView, type DecorationSet } from '@codemirror/view';
import {
	composerMentionPresentation,
	composerReferences,
	composerTrigger,
	composerVisibleText,
	createComposerMention,
	scanComposerMentions,
} from '../src/lib/composer-mentions';

function state(doc: string, cursor = doc.length) {
	return EditorState.create({
		doc,
		selection: { anchor: cursor },
		extensions: [markdown({ base: markdownLanguage }), history(), composerMentionPresentation()],
	});
}
const skill = {
	kind: 'skill' as const,
	id: 'skill:/configured/app-design/SKILL.md',
	label: 'App Design',
	path: '/configured/app-design/SKILL.md',
};

describe('Code composer intentional completion tokens', () => {
	it('supports leading modes and skill mentions inside prose', () => {
		expect(composerTrigger(state('/goal'))).toEqual({
			from: 0,
			to: 5,
			prefix: '/',
			query: 'goal',
			commands: true,
		});
		expect(composerTrigger(state('Help with /app-des'))).toMatchObject({
			prefix: '/',
			query: 'app-des',
			commands: false,
		});
		expect(composerTrigger(state('Read @docs/tools'))).toMatchObject({
			prefix: '@',
			query: 'docs/tools',
		});
		expect(composerTrigger(state('@'))).toMatchObject({ prefix: '@', query: '' });
	});
	it('does not hijack URLs, emails, paths, code, equations or selections', () => {
		for (const doc of [
			'https://example.com/path',
			'me@example.com',
			'/usr/local/bin',
			'value=/plan',
			'`/goal`',
			'```bash\n/goal',
			'    /goal',
			'$x /goal$',
			'$x /go',
			'$$\nx /go',
			'\\(x /go',
			'[name](https://a/@abc)',
		])
			expect(composerTrigger(state(doc)), doc).toBeUndefined();
		expect(
			composerTrigger(
				state('before /goal after', 9).update({ selection: { anchor: 7, head: 11 } }).state,
			),
		).toBeUndefined();
	});
	it('recognizes a later token and ignores a cursor inside an existing mention', () => {
		const reference = createComposerMention(skill);
		expect(composerTrigger(state(reference.token, 20))).toBeUndefined();
		expect(composerTrigger(state(`${reference.token} and @docs/`))).toMatchObject({
			prefix: '@',
			query: 'docs/',
		});
	});
	it('bounds document and token scans', () => {
		expect(composerTrigger(state('x'.repeat(120001) + ' /go'))).toBeUndefined();
		expect(composerTrigger(state('@' + 'x'.repeat(257)))).toBeUndefined();
	});
});

describe('identity preserving inline composer references', () => {
	it('round trips path and ID independently of a display name, with safe Markdown labels', () => {
		const reference = createComposerMention({
			...skill,
			label: 'App [Design] \\ A',
			path: '/one/space & (test)/SKILL.md',
		});
		expect(scanComposerMentions(reference.token)[0].reference).toMatchObject({
			id: skill.id,
			label: 'App [Design] \\ A',
			path: '/one/space & (test)/SKILL.md',
		});
		expect(composerVisibleText(`Use ${reference.token} now`)).toBe('Use App [Design] \\ A now');
	});
	it('preserves malformed tokens as literal text rather than trusting pasted metadata', () => {
		for (const value of [
			'[bad](freelm-skill:bad)',
			'[bad](freelm-skill:%7B%22id%22%3A1%7D)',
			'[bad](freelm-file:' +
				encodeURIComponent(JSON.stringify({ id: 'x', label: 'x', path: 'a\u0000b' })) +
				')',
		]) {
			expect(scanComposerMentions(value)).toEqual([]);
			expect(composerVisibleText(value)).toBe(value);
		}
	});
	it('deduplicates identical references, retains different paths with identical titles, and excludes code', () => {
		const one = createComposerMention({
			kind: 'file',
			id: 'one',
			label: 'route.ts',
			path: '/one/route.ts',
		});
		const two = createComposerMention({
			kind: 'file',
			id: 'two',
			label: 'route.ts',
			path: '/two/route.ts',
		});
		expect(
			composerReferences(
				state(
					`${one.token} ${one.token} ${two.token}\n\n\`\`\`text\n${createComposerMention(skill).token}\n\`\`\``,
				),
			),
		).toEqual([one, two]);
	});
	it('counts repeated mentions once without dropping a later distinct reference', () => {
		const reference = createComposerMention(skill);
		const file = createComposerMention({
			kind: 'file',
			id: 'later',
			label: 'tools.md',
			path: '/later/tools.md',
		});
		const source = Array(35).fill(reference.token).join(' ') + ' ' + file.token;
		expect(composerReferences(state(source))).toEqual([reference, file]);
		expect(composerVisibleText(source)).not.toContain('freelm-');
	});
	it('mentions remain atomic and identities survive deletion and undo/redo without another discovery request', () => {
		const reference = createComposerMention(skill);
		let editor = state('Use ');
		editor = editor.update({
			changes: { from: 4, insert: reference.token },
			selection: { anchor: 4 + reference.token.length },
			annotations: [Transaction.userEvent.of('input.complete'), isolateHistory.of('full')],
		}).state;
		expect(composerReferences(editor)).toEqual([reference]);
		const sets = editor.facet(EditorView.decorations) as readonly DecorationSet[];
		const widgetRanges: [number, number][] = [];
		for (const set of sets)
			set.between(0, editor.doc.length, (from, to) => {
				widgetRanges.push([from, to]);
			});
		expect(widgetRanges).toEqual([[4, 4 + reference.token.length]]);
		const atomic = editor.facet(EditorView.atomicRanges);
		expect(atomic).toHaveLength(1);
		// Deletion of the exact selected widget is a single history transaction.
		editor = editor.update({
			changes: { from: 4, to: editor.doc.length },
			annotations: Transaction.userEvent.of('delete.backward'),
		}).state;
		expect(composerReferences(editor)).toEqual([]);
		expect(
			undo({
				state: editor,
				dispatch: (tr) => {
					editor = tr.state;
				},
			}),
		).toBe(true);
		expect(composerReferences(editor)).toEqual([reference]);
		expect(
			redo({
				state: editor,
				dispatch: (tr) => {
					editor = tr.state;
				},
			}),
		).toBe(true);
		expect(composerReferences(editor)).toEqual([]);
	});
});
