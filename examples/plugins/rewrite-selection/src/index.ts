import { definePlugin } from '@freelm/plugin-sdk';

export default definePlugin({
	async activate(context) {
		const rewrite = context.commands.register({
			id: 'uppercase-selection',
			title: 'Uppercase selection',
			async run() {
				const draft = await context.composer.readDraft();
				const from = Math.min(draft.selection.anchor, draft.selection.head);
				const to = Math.max(draft.selection.anchor, draft.selection.head);
				if (from === to) return;
				await context.composer.applyEdit({
					expectedRevision: draft.revision,
					changes: [{ from, to, insert: draft.text.slice(from, to).toLocaleUpperCase() }],
				});
			},
		});
		await rewrite.ready;
		const item = context.composer.drawer.addItem({
			id: 'selection-tools',
			title: 'Selected text tools',
			description: 'Select text in your draft, then choose an action.',
			icon: 'text-cursor-input',
			actions: [{ title: 'Uppercase selection', command: rewrite.id }],
		});
		await item.ready;
		return () => {
			item.dispose();
			rewrite.dispose();
		};
	},
});
