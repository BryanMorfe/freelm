import { describe, expect, it } from 'vitest';
import { editedFileChanges, editedFileTotals, parseEditedFiles } from '../src/lib/edited-files';
import type { ToolCallRecord } from '../src/agent-types';

const patch = `*** Begin Patch
*** Update File: src/app.ts
@@
 context
-before
-old
+after
+new
+extra
*** Add File: docs/notes.md
+note
*** Update File: old-name.ts
*** Move to: src/new-name.ts
@@
-old name
+new name
*** Delete File: obsolete.txt
*** End Patch`;
function call(value: Partial<ToolCallRecord> = {}): ToolCallRecord {
	return {
		id: 'patch',
		name: 'apply_patch',
		arguments: JSON.stringify({ patch }),
		status: 'completed',
		startedAt: 1,
		...value,
	};
}
describe('edited file evidence', () => {
	it('parses hunks/additions/moves without inventing deleted-file line counts', () => {
		const files = parseEditedFiles(patch.replaceAll('\n', '\r\n'));
		expect(
			files.map(({ kind, path, previousPath, addedLines, removedLines }) => ({
				kind,
				path,
				previousPath,
				addedLines,
				removedLines,
			})),
		).toEqual([
			{
				kind: 'update',
				path: 'src/app.ts',
				previousPath: undefined,
				addedLines: 3,
				removedLines: 2,
			},
			{
				kind: 'add',
				path: 'docs/notes.md',
				previousPath: undefined,
				addedLines: 1,
				removedLines: 0,
			},
			{
				kind: 'move',
				path: 'src/new-name.ts',
				previousPath: 'old-name.ts',
				addedLines: 1,
				removedLines: 1,
			},
			{
				kind: 'delete',
				path: 'obsolete.txt',
				previousPath: undefined,
				addedLines: 0,
				removedLines: undefined,
			},
		]);
		expect(files[0].diff.map((line) => line.kind)).toEqual([
			'hunk',
			'context',
			'removed',
			'removed',
			'added',
			'added',
			'added',
		]);
		expect(editedFileTotals(files)).toEqual({ added: 5, removed: undefined });
	});
	it('uses successful host metadata for actual deleted-line counts and resolved paths', () => {
		const files = editedFileChanges(
			call({
				result: {
					content: [],
					fileChanges: [
						{ kind: 'update', path: 'src/app.ts', addedLines: 3, removedLines: 2 },
						{ kind: 'add', path: 'docs/notes.md', addedLines: 1, removedLines: 0 },
						{
							kind: 'move',
							path: 'src/new-name.ts',
							previousPath: 'old-name.ts',
							addedLines: 1,
							removedLines: 1,
						},
						{ kind: 'delete', path: 'obsolete.txt', addedLines: 0, removedLines: 7 },
					],
				},
			}),
			patch,
		);
		expect(editedFileTotals(files)).toEqual({ added: 5, removed: 10 });
		expect(files[0].diff).toEqual(parseEditedFiles(patch)[0].diff);
	});
	it('keeps failed/denied calls as authored proposals instead of claiming host changes', () => {
		const failed = call({
			status: 'failed',
			result: {
				isError: true,
				content: [],
				fileChanges: [{ kind: 'delete', path: 'never-changed.txt', removedLines: 1000 }],
			},
		});
		expect(editedFileChanges(failed, patch)).toEqual(parseEditedFiles(patch));
		expect(editedFileChanges({ ...failed, status: 'denied' }, 'invalid')).toEqual([]);
	});
	it('recovers legacy applied paths with unavailable counts when original arguments are missing', () => {
		const files = editedFileChanges(
			call({
				result: {
					content: [{ type: 'text', text: 'Applied patch:\nM path/<name>.ts\nD old.txt' }],
				},
			}),
			undefined,
		);
		expect(files.map((file) => file.path)).toEqual(['path/<name>.ts', 'old.txt']);
		expect(editedFileTotals(files)).toEqual({ added: undefined, removed: undefined });
	});
	it.each([
		'garbage',
		'*** Begin Patch\n*** Update File: empty.ts\n@@\n*** End Patch',
		'*** Begin Patch\n*** Add File: file.ts\nnot-prefixed\n*** End Patch',
		'*** Begin Patch\n*** Delete File: file.ts',
		'*** Begin Patch\n*** Delete File: file.ts\n*** End Patch\nextra',
	])('rejects malformed/incomplete patch evidence %#', (value) => {
		expect(parseEditedFiles(value)).toEqual([]);
	});
	it('counts the full patch while bounding the rendered diff preview', () => {
		const files = parseEditedFiles(
			`*** Begin Patch\n*** Add File: large.txt\n${Array.from({ length: 2000 }, (_, index) => `+line ${index}`).join('\n')}\n*** End Patch`,
		);
		expect(files[0].addedLines).toBe(2000);
		expect(files[0].diff).toHaveLength(500);
		expect(files[0].omittedDiffLines).toBe(1500);
	});
	it('keeps each total unknown if its cross-file sum exceeds safe integer precision', () => {
		const files = [
			{
				kind: 'update' as const,
				path: 'a.ts',
				addedLines: Number.MAX_SAFE_INTEGER,
				removedLines: 4,
			},
			{
				kind: 'update' as const,
				path: 'b.ts',
				addedLines: Number.MAX_SAFE_INTEGER,
				removedLines: 5,
			},
		];
		expect(editedFileTotals(files)).toEqual({ added: undefined, removed: 9 });
		expect(
			editedFileTotals(
				files.map((file) => ({ ...file, addedLines: 1, removedLines: Number.MAX_SAFE_INTEGER })),
			),
		).toEqual({ added: 2, removed: undefined });
	});
});
