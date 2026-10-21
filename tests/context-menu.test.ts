import { describe, expect, it } from 'vitest';
import type { ContextMenuParams } from 'electron';
import { textContextMenu } from '../electron/context-menu';

function selection(overrides: Partial<ContextMenuParams> = {}): ContextMenuParams {
	return {
		isEditable: false,
		selectionText: '',
		editFlags: {
			canUndo: false,
			canRedo: false,
			canCut: false,
			canCopy: false,
			canPaste: false,
			canSelectAll: false,
		},
		...overrides,
	} as ContextMenuParams;
}

describe('native text context actions', () => {
	it('offers copy for a genuine non-editable selection and leaves custom menus alone otherwise', () => {
		expect(textContextMenu(selection())).toEqual([]);
		const items = textContextMenu(
			selection({
				selectionText: 'Selected answer',
				editFlags: { canCopy: true } as ContextMenuParams['editFlags'],
			}),
		);
		expect(items.map((item) => item.role || item.type)).toEqual(['copy', 'separator', 'selectAll']);
		expect(items[0].enabled).toBe(true);
	});
	it('keeps paste and undo available in an empty editor without enabling selection actions', () => {
		const items = textContextMenu(
			selection({
				isEditable: true,
				editFlags: {
					canUndo: true,
					canRedo: false,
					canCut: false,
					canCopy: false,
					canPaste: true,
					canSelectAll: false,
					canDelete: false,
					canEditRichly: false,
				},
			}),
		);
		const enabled = items.filter((item) => item.role && item.enabled).map((item) => item.role);
		expect(enabled).toEqual(['undo', 'paste']);
		expect(items.find((item) => item.role === 'cut')?.enabled).toBe(false);
	});
});
