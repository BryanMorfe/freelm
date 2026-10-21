import { describe, expect, it } from 'vitest';
import type { ToolCallRecord, ToolFileChange } from '../src/agent-types';
import { aggregateFileEdits } from '../src/lib/file-edit-summary';

function call(id: string, patch?: string, overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
	return {
		id,
		name: 'apply_patch',
		arguments: JSON.stringify({ patch }),
		status: 'completed',
		startedAt: 1,
		...overrides,
	};
}
function patch(body: string) {
	return `*** Begin Patch\n${body}\n*** End Patch`;
}
function update(path: string, before = 'before', after = 'after') {
	return patch(`*** Update File: ${path}\n@@\n-${before}\n+${after}`);
}
function metadata(id: string, changes: ToolFileChange[], name = 'apply_patch') {
	return call(id, undefined, { name, result: { content: [], fileChanges: changes } });
}

describe('completed response file edit summaries', () => {
	it('aggregates repeated edits once per path with cumulative counts and chronological previews', () => {
		const files = aggregateFileEdits([
			call('first', update('src/app.ts')),
			call('second', patch('*** Update File: ./src/./app.ts\n@@\n-old\n+new\n+extra')),
			call('third', patch('*** Add File: docs/notes.md\n+note')),
		]);
		expect(files).toHaveLength(2);
		expect(files[0]).toMatchObject({
			path: './src/./app.ts',
			kind: 'update',
			addedLines: 3,
			removedLines: 2,
			editCount: 2,
		});
		expect(files[0].previewSections.map((section) => section.callId)).toEqual(['first', 'second']);
		expect(files[0].previewSections[0].diff.map((line) => line.text)).toEqual([
			'@@',
			'-before',
			'+after',
		]);
		expect(files[1]).toMatchObject({
			path: 'docs/notes.md',
			kind: 'add',
			addedLines: 1,
			removedLines: 0,
			editCount: 1,
		});
	});
	it('follows move chains and keeps a subsequently recreated source path separate', () => {
		const files = aggregateFileEdits([
			call('edit', update('a.ts')),
			call('move-a', patch('*** Update File: a.ts\n*** Move to: b.ts\n@@\n-before\n+after')),
			call('move-b', patch('*** Update File: b.ts\n*** Move to: c.ts\n@@\n-before\n+after')),
			call('edit-c', update('c.ts')),
			call('new-a', patch('*** Add File: a.ts\n+different file')),
		]);
		expect(files).toHaveLength(2);
		expect(files[0]).toMatchObject({
			path: 'c.ts',
			previousPath: 'a.ts',
			kind: 'move',
			addedLines: 4,
			removedLines: 4,
			editCount: 4,
		});
		expect(files[0].previewSections.map((section) => section.path)).toEqual([
			'a.ts',
			'b.ts',
			'c.ts',
			'c.ts',
		]);
		expect(files[1]).toMatchObject({
			path: 'a.ts',
			kind: 'add',
			addedLines: 1,
			removedLines: 0,
			editCount: 1,
		});
	});
	it('deduplicates a reused destination while preserving all prior successful edits', () => {
		const files = aggregateFileEdits([
			metadata('delete-b', [{ kind: 'delete', path: 'b.ts', addedLines: 0, removedLines: 10 }]),
			call('edit-a', update('a.ts')),
			call('move', patch('*** Update File: a.ts\n*** Move to: b.ts\n@@\n-before\n+after')),
		]);
		expect(files).toHaveLength(1);
		expect(files[0]).toMatchObject({
			path: 'b.ts',
			previousPath: 'a.ts',
			kind: 'move',
			addedLines: 2,
			removedLines: 12,
			editCount: 3,
		});
		expect(files[0].previewSections.map((section) => section.callId)).toEqual([
			'delete-b',
			'edit-a',
			'move',
		]);
	});
	it.each(['running', 'approval', 'failed', 'denied'] as const)(
		'excludes %s patch proposals even if they contain metadata',
		(status) => {
			expect(
				aggregateFileEdits([
					call('proposal', update('never-edited.ts'), {
						status,
						result: {
							content: [],
							fileChanges: [
								{ kind: 'update', path: 'never-edited.ts', addedLines: 100, removedLines: 100 },
							],
						},
					}),
				]),
			).toEqual([]);
		},
	);
	it('excludes completed error results and unconfirmed command writes', () => {
		expect(
			aggregateFileEdits([
				call('error', update('bad.ts'), { result: { isError: true, content: [] } }),
				call('command', update('command.ts'), {
					name: 'exec_command',
					result: { content: [{ type: 'text', text: 'Applied patch:\nM invented.ts' }] },
				}),
			]),
		).toEqual([]);
	});
	it('uses successful host metadata from any tool without treating its arguments or text as a patch', () => {
		const files = aggregateFileEdits([
			metadata(
				'other-tool',
				[{ kind: 'delete', path: '/project/old.txt', addedLines: 0, removedLines: 40 }],
				'mcp_edit',
			),
			call('invalid', update('invented.ts'), {
				name: 'exec_command',
				result: {
					content: [{ type: 'text', text: 'Applied patch:\nM invented.ts' }],
					fileChanges: [{ kind: 'update', path: 'invalid.ts', addedLines: -1 }],
				},
			}),
		]);
		expect(files).toHaveLength(1);
		expect(files[0]).toMatchObject({
			path: '/project/old.txt',
			kind: 'delete',
			addedLines: 0,
			removedLines: 40,
		});
		expect(files[0].previewSections[0]).toMatchObject({ diff: [], omittedDiffLines: 0 });
	});
	it('recovers legacy successful patches and applied paths without inventing unknown counts', () => {
		const files = aggregateFileEdits([
			call('legacy-patch', patch('*** Delete File: obsolete.txt')),
			call('legacy-output', undefined, {
				arguments: 'invalid JSON',
				result: { content: [{ type: 'text', text: 'Applied patch:\nM old.ts\nD absent.txt' }] },
			}),
			call('later', update('old.ts')),
			call('malformed', '*** Begin Patch\n*** Update File: bad.ts\n@@\n*** End Patch'),
		]);
		expect(files.map((file) => file.path)).toEqual(['obsolete.txt', 'old.ts', 'absent.txt']);
		expect(files[0].addedLines).toBe(0);
		expect(files[0].removedLines).toBeUndefined();
		expect(files[1]).toMatchObject({ editCount: 2 });
		expect(files[1].addedLines).toBeUndefined();
		expect(files[1].removedLines).toBeUndefined();
	});
	it('preserves unknown dimensions and does not expose unsafe numeric totals', () => {
		const files = aggregateFileEdits([
			metadata('first', [
				{ kind: 'update', path: 'binary.bin', addedLines: 2 },
				{ kind: 'update', path: 'huge.txt', addedLines: Number.MAX_SAFE_INTEGER, removedLines: 0 },
			]),
			metadata('second', [
				{ kind: 'update', path: 'binary.bin', addedLines: 3, removedLines: 1 },
				{ kind: 'update', path: 'huge.txt', addedLines: 1, removedLines: 0 },
			]),
		]);
		expect(files[0].addedLines).toBe(5);
		expect(files[0].removedLines).toBeUndefined();
		expect(files[1].addedLines).toBeUndefined();
		expect(files[1].removedLines).toBe(0);
	});
	it('bounds recent preview sections and line previews while counting every successful edit', () => {
		const large = patch(
			`*** Update File: large.ts\n@@\n-old\n${Array.from({ length: 1000 }, (_, index) => `+line ${index}`).join('\n')}`,
		);
		const files = aggregateFileEdits(
			Array.from({ length: 12 }, (_, index) => call(String(index), large)),
		);
		expect(files[0]).toMatchObject({
			editCount: 12,
			addedLines: 12000,
			removedLines: 12,
			omittedPreviewSections: 4,
		});
		expect(files[0].previewSections.map((section) => section.callId)).toEqual([
			'4',
			'5',
			'6',
			'7',
			'8',
			'9',
			'10',
			'11',
		]);
		expect(files[0].previewSections[0].diff).toHaveLength(200);
		expect(files[0].previewSections[0].omittedDiffLines).toBe(802);
	});
	it('bounds aggregate preview text across many files without dropping their counts', () => {
		const calls = Array.from({ length: 30 }, (_, index) =>
			call(
				String(index),
				patch(
					`*** Add File: file-${index}.txt\n${Array.from({ length: 250 }, () => `+${'x'.repeat(150)}`).join('\n')}`,
				),
			),
		);
		const files = aggregateFileEdits(calls);
		expect(files).toHaveLength(30);
		expect(files.reduce((sum, file) => sum + file.addedLines!, 0)).toBe(7500);
		const sections = files.flatMap((file) => file.previewSections);
		expect(sections.flatMap((section) => section.diff).length).toBeLessThanOrEqual(5000);
		expect(
			sections.reduce(
				(sum, section) => sum + section.diff.reduce((length, line) => length + line.text.length, 0),
				0,
			),
		).toBeLessThanOrEqual(500000);
		expect(sections.reduce((sum, section) => sum + section.omittedDiffLines, 0)).toBeGreaterThan(0);
	});
	it('does not mutate persisted arguments, metadata, or tool results', () => {
		const calls = [
			call('patch', update('a.ts')),
			metadata('confirmed', [
				{ kind: 'move', path: 'b.ts', previousPath: 'a.ts', addedLines: 4, removedLines: 2 },
			]),
		];
		const before = JSON.stringify(calls);
		const files = aggregateFileEdits(calls);
		files[0].previewSections[0].diff[0].text = 'changed preview';
		files[0].path = 'changed summary';
		expect(JSON.stringify(calls)).toBe(before);
		expect(aggregateFileEdits(calls)[0].path).toBe('b.ts');
	});
});
