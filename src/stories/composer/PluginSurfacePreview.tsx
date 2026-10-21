import { useEffect, useState } from 'react';
import Chat from '../../components/Chat';
import { PluginSurfaceController } from '../../lib/plugin-surface-controller';
import { textAttachment } from '../../lib/composer-content';
import { composerConnection } from './fixtures';

export function PluginSurfacePreview({
	narrow = false,
	showPlaceholder = true,
	showDrawer = true,
	onReady,
}: {
	narrow?: boolean;
	showPlaceholder?: boolean;
	showDrawer?: boolean;
	onReady?: (controller: PluginSurfaceController) => void;
}) {
	const [controller] = useState(() => new PluginSurfaceController());
	useEffect(() => {
		controller.addOwner('preview-plugin');
		const revision = controller.getState().revision;
		if (showPlaceholder) {
			controller.execute('preview-plugin', 'composer.setPlaceholder', {
				id: 'preview-hint',
				text: 'What should I work on next?',
				hint: 'Tab to use this text',
				acceptCommand: 'accept',
				expectedRevision: revision,
			});
			controller.execute('preview-plugin', 'commands.register', {
				id: 'accept',
				title: 'Use text',
				action: {
					type: 'composer.setText',
					text: 'What should I work on next?',
					expectedRevision: revision,
				},
			});
			controller.execute('preview-plugin', 'keybindings.register', {
				id: 'accept-key',
				key: 'Tab',
				command: 'accept',
				when: { composerFocused: true, composerEmpty: true, contributionVisible: 'preview-hint' },
			});
		}
		if (showDrawer) {
			controller.execute('preview-plugin', 'commands.register', {
				id: 'attach',
				title: 'Attach report',
			});
			controller.execute('preview-plugin', 'composer.drawer.addItem', {
				id: 'report',
				title: 'Reference report',
				description: 'Created by a plugin. Attach it when ready.',
				icon: 'file-text',
				dismissible: true,
				actions: [{ title: 'Attach', command: 'attach' }],
			});
		}
		const stop = controller.onCommand((owner, id) => {
			if (id === 'attach')
				controller.execute(owner, 'composer.attachments.add', {
					expectedRevision: controller.getState().revision,
					attachment: textAttachment(
						'A report created independently by a plugin.',
						'reference.txt',
					),
				});
		});
		onReady?.(controller);
		return () => {
			stop();
			controller.removeOwner('preview-plugin');
		};
	}, [controller, showPlaceholder, showDrawer, onReady]);
	return (
		<div style={{ width: narrow ? 400 : 800, maxWidth: '100%', height: 610 }}>
			<Chat
				pluginSurface={controller}
				connection={composerConnection}
				model="qwen-chat"
				thinkingMode="medium"
				conversationKind="code"
				draftScope="plugin-preview"
				onThinkingMode={() => {}}
				onModel={() => {}}
				busy={false}
				interactionPrompt={[]}
				interactionPending={false}
				runningHere={false}
				onSend={() => {}}
				onStop={() => {}}
				onRetry={() => {}}
				onSettings={() => {}}
				onMove={() => {}}
				projects={[]}
				thread={{
					id: 'plugin-preview',
					kind: 'code',
					title: 'Plugin extension preview',
					connectionId: composerConnection.id,
					model: 'qwen-chat',
					thinkingMode: 'medium',
					createdAt: 1,
					updatedAt: 2,
					messages: [
						{ id: 'user', role: 'user', content: 'Review this implementation.', createdAt: 1 },
						{
							id: 'assistant',
							role: 'assistant',
							content: 'The implementation is ready for review.',
							createdAt: 2,
							completedAt: 3,
						},
					],
				}}
			/>
		</div>
	);
}
