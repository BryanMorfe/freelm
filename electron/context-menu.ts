import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron';

/** Native editing actions follow Chromium's actual selection and edit permissions. */
export function textContextMenu(params: ContextMenuParams): MenuItemConstructorOptions[] {
	if (params.isEditable) {
		return [
			{ role: 'undo', enabled: params.editFlags.canUndo },
			{ role: 'redo', enabled: params.editFlags.canRedo },
			{ type: 'separator' },
			{ role: 'cut', enabled: params.editFlags.canCut },
			{ role: 'copy', enabled: params.editFlags.canCopy },
			{ role: 'paste', enabled: params.editFlags.canPaste },
			{ type: 'separator' },
			{ role: 'selectAll', enabled: params.editFlags.canSelectAll },
		];
	}
	if (params.selectionText)
		return [
			{ role: 'copy', enabled: params.editFlags.canCopy },
			{ type: 'separator' },
			{ role: 'selectAll' },
		];
	return [];
}
