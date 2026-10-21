import { definePlugin } from '@freelm/plugin-sdk';

export default definePlugin({
	async activate(context) {
		const attach = context.commands.register({
			id: 'attach-report',
			title: 'Attach report',
			async run(invocation) {
				const settings = await context.settings.get<{ report: string }>();
				const report = await context.assets.create({
					name: 'report.txt',
					mimeType: 'text/plain',
					text: settings.values.report,
				});
				await context.composer.attachments.add(report, {
					expectedRevision: invocation.composerRevision,
				});
			},
		});
		await attach.ready;
		const item = context.composer.drawer.addItem({
			id: 'report',
			title: 'Prepared report',
			description: 'Ready to attach to your next message',
			icon: 'file-text',
			actions: [{ title: 'Attach', command: attach.id }],
			dismissible: true,
		});
		await item.ready;
		return () => {
			item.dispose();
			attach.dispose();
		};
	},
});
