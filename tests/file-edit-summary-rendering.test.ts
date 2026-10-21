import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ToolCallRecord } from '../src/agent-types';
import FileEditSummary from '../src/components/FileEditSummary';

function patchCall(id: string, path: string, patchBody = '+new'): ToolCallRecord {
	return {
		id,
		name: 'apply_patch',
		status: 'completed',
		startedAt: 1,
		arguments: JSON.stringify({
			patch: `*** Begin Patch\n*** Add File: ${path}\n${patchBody}\n*** End Patch`,
		}),
		result: { content: [{ type: 'text', text: 'PRIVATE_TOOL_JSON_RESULT' }] },
	};
}
function render(calls?: ToolCallRecord[]) {
	return renderToStaticMarkup(createElement(FileEditSummary, { calls }));
}

describe('finished response file edit summary', () => {
	it.each(['running', 'approval', 'failed', 'denied'] as const)(
		'does not claim %s proposals as edited files',
		(status) => expect(render([{ ...patchCall('not-applied', 'src/app.ts'), status }])).toBe(''),
	);
	it('omits an empty summary and unsuccessful completed tool results', () => {
		expect(render()).toBe('');
		expect(render([])).toBe('');
		expect(
			render([{ ...patchCall('failed', 'src/app.ts'), result: { isError: true, content: [] } }]),
		).toBe('');
	});
	it.each([
		{ count: 5, visible: 5, hidden: 0 },
		{ count: 6, visible: 3, hidden: 3 },
		{ count: 14, visible: 3, hidden: 11 },
	])('shows $visible of $count files without rendering diffs', ({ count, visible, hidden }) => {
		const html = render(
			Array.from({ length: count }, (_, index) =>
				patchCall(`patch-${index}`, `src/file-${index}.ts`),
			),
		);
		expect(html).toContain('class="file-edit-summary" aria-label="Edited files"');
		expect(html).toContain(`Edited ${count} files`);
		expect(html.match(/class="file-edit-summary-row"/g)).toHaveLength(visible);
		if (hidden) expect(html).toContain(`Show ${hidden} more files`);
		else expect(html).not.toContain('file-edit-summary-more');
		expect(html).toContain('aria-expanded="false"');
		expect(html).not.toContain(`src/file-${visible}.ts`);
		expect(html).not.toContain('file-edit-preview');
		expect(html).not.toContain('PRIVATE_TOOL_JSON_RESULT');
		expect(html).not.toContain('Undo');
		expect(html).not.toContain('View changes');
	});
	it('deduplicates repeated edits while showing aggregate header and per-file counts', () => {
		const update: ToolCallRecord = {
			...patchCall('second', 'src/app.ts'),
			arguments: JSON.stringify({
				patch:
					'*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+next\n+extra\n*** End Patch',
			}),
		};
		const html = render([patchCall('first', 'src/app.ts'), update]);
		expect(html).toContain('Edited 1 file');
		expect(html.match(/class="file-edit-summary-row"/g)).toHaveLength(1);
		expect(html.match(/class="file-edit-added">\+3/g)).toHaveLength(2);
		expect(html.match(/class="file-edit-removed">-1/g)).toHaveLength(2);
		expect(html).toContain('class="file-edit-directory">src/');
		expect(html).toContain('<span>app.ts</span>');
	});
	it('renders escaped filenames and keeps patch contents lazy even when they contain markup', () => {
		const html = render([
			patchCall('unsafe', 'src/<app>.tsx', '+<script>PRIVATE_DIFF_MARKER</script>'),
		]);
		expect(html).toContain('src/&lt;app&gt;.tsx');
		expect(html).not.toContain('<app>');
		expect(html).not.toContain('PRIVATE_DIFF_MARKER');
		expect(html).not.toContain('<script>');
	});
	it('shows host-confirmed edits from another tool while preserving unavailable counts', () => {
		const html = render([
			{
				...patchCall('recorded', 'ignored.ts'),
				name: 'exec_command',
				result: { content: [], fileChanges: [{ kind: 'delete', path: 'old.txt' }] },
			},
		]);
		expect(html).toContain('Edited 1 file');
		expect(html).toContain('data-file-path="old.txt"');
		expect(html).toContain('line count unavailable');
		expect(html).not.toContain('>+0<');
		expect(html).not.toContain('>-0<');
	});
});
