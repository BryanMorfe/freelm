import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import EditedFilesActivity from '../src/components/EditedFilesActivity';
import type { ToolCallRecord } from '../src/agent-types';
import { toolActivityLabel } from '../src/lib/message-activity';

const patch =
	'*** Begin Patch\n*** Update File: src/<safe>.ts\n@@\n-before\n+after\n*** Add File: docs/notes.md\n+note\n*** End Patch';
function render(status: ToolCallRecord['status'] = 'completed', value = patch, isError = false) {
	return renderToStaticMarkup(
		createElement(EditedFilesActivity, {
			call: {
				id: 'patch',
				name: 'apply_patch',
				status,
				startedAt: 1,
				arguments: JSON.stringify({ patch: value }),
				result: { content: [{ type: 'text', text: '{"PRIVATE_DEBUG_JSON":true}' }], isError },
			},
			args: { patch: value },
			label: status === 'running' ? 'Editing 2 files' : 'Edited 2 files',
			active: status === 'running',
		}),
	);
}
function renderCall(call: ToolCallRecord, label: string) {
	return renderToStaticMarkup(
		createElement(EditedFilesActivity, {
			call,
			args: {},
			label,
			active: call.status === 'running',
		}),
	);
}
describe('edited file summary presentation', () => {
	it('has a real collapsed disclosure with file/line totals and lazy list/diff rendering', () => {
		const html = render();
		expect(html).toContain('<details class="edited-files-activity">');
		expect(html).toContain('Edited 2 files');
		expect(html).toContain('>+2</span>');
		expect(html).toContain('>-1</span>');
		expect(html).not.toContain('edited-files-list');
		expect(html).not.toContain('PRIVATE_DEBUG_JSON');
		expect(html).not.toContain('Tool details');
	});
	it('uses active shimmer and names the proposed file count', () => {
		const html = render('running');
		expect(html).toContain('Editing 2 files');
		expect(html).toContain('activity-shimmer');
	});
	it.each(['failed', 'denied'] as const)('never claims files were applied after %s', (status) => {
		const html = render(status);
		expect(html).toContain('Could not edit 2 files');
		expect(html).not.toContain('Edited 2 files');
	});
	it('treats a completed error result as failure, and malformed args have no empty toggle', () => {
		expect(render('completed', patch, true)).toContain('Could not edit 2 files');
		const html = render('failed', 'invalid');
		expect(html).not.toContain('<details');
		expect(html).toContain('File details are unavailable');
	});
	it('corrects an undersized incoming label using every actual path in a freeform patch', () => {
		const current: ToolCallRecord = {
			id: 'freeform',
			name: 'apply_patch',
			arguments: patch,
			status: 'completed',
			startedAt: 1,
		};
		const html = renderCall(current, 'Edited 1 file');
		expect(html).toContain('Edited 2 files');
		expect(html).not.toContain('Edited 1 file');
		expect(html).toContain('<details class="edited-files-activity">');
		expect(renderCall({ ...current, status: 'running' }, 'Editing 1 file')).toContain(
			'Editing 2 files',
		);
	});
	it('counts unique confirmed paths rather than repeated file records or a stale label', () => {
		const current: ToolCallRecord = {
			id: 'confirmed',
			name: 'apply_patch',
			arguments: '{}',
			status: 'completed',
			startedAt: 1,
			result: {
				content: [],
				fileChanges: [
					{ kind: 'update', path: 'src/one.ts' },
					{ kind: 'update', path: './src/one.ts' },
					{ kind: 'add', path: 'src/two.ts' },
				],
			},
		};
		const html = renderCall(current, 'Edited 1 file');
		expect(html).toContain('Edited 2 files');
		expect(html).not.toContain('Edited 3 files');
	});
	it('does not retain an incoming numeric count when no file evidence exists', () => {
		const html = renderCall(
			{ id: 'unknown', name: 'apply_patch', arguments: '{', status: 'completed', startedAt: 1 },
			'Edited 1 file',
		);
		expect(html).toContain('Edited files');
		expect(html).not.toContain('Edited 1 file');
		expect(html).not.toContain('<details');
	});
	it('shares cached patch evidence with lifecycle labels across subsequent renders', () => {
		const current: ToolCallRecord = {
			id: 'cached',
			name: 'apply_patch',
			arguments: JSON.stringify({ patch }),
			status: 'completed',
			startedAt: 1,
		};
		const parse = vi.spyOn(JSON, 'parse');
		try {
			expect(toolActivityLabel(current)).toBe('Edited 2 files');
			for (let update = 0; update < 3; update++)
				expect(renderCall(current, 'Edited 1 file')).toContain('Edited 2 files');
			expect(parse.mock.calls.filter(([text]) => text === current.arguments)).toHaveLength(1);
		} finally {
			parse.mockRestore();
		}
	});
});
