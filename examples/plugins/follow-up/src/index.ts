import { definePlugin, type ModelSelection, type Registration } from '@freelm/plugin-sdk';

/** All follow-up policy lives in this package, using general SDK primitives. */
export default definePlugin({
	async activate(context) {
		let epoch = 0;
		let disposed = false;
		let controller: AbortController | undefined;
		let draftRevision: number | undefined;
		let contributions: Registration[] = [];

		function clear() {
			epoch++;
			controller?.abort();
			controller = undefined;
			for (const contribution of contributions.reverse()) contribution.dispose();
			contributions = [];
		}

		async function refresh() {
			clear();
			const generation = epoch;
			const job = new AbortController();
			controller = job;
			try {
				const state = await context.composer.getState();
				if (
					disposed ||
					generation !== epoch ||
					!state.empty ||
					!state.editable ||
					state.working ||
					state.running ||
					state.queueEditing ||
					state.hasQueuedMessages ||
					state.awaitingInput ||
					!state.hasCompletedTurn
				)
					return;
				draftRevision = state.revision;
				const settings = await context.settings.get<{
					model: ModelSelection;
					recentTurns: number;
					instructions: string;
					maxOutputTokens: number;
				}>();
				const snapshot = await context.conversation.getTurns({
					limit: settings.values.recentTurns,
				});
				if (disposed || generation !== epoch || !snapshot.turns.length) return;
				const result = await context.inference.generateText({
					model: settings.values.model,
					system: settings.values.instructions,
					messages: [{ role: 'user', content: JSON.stringify(snapshot.turns) }],
					snapshotId: snapshot.snapshotId,
					maxOutputTokens: settings.values.maxOutputTokens,
					signal: job.signal,
				});
				if (disposed || generation !== epoch || job.signal.aborted) return;
				const current = await context.composer.getState();
				if (
					disposed ||
					generation !== epoch ||
					current.revision !== state.revision ||
					!current.empty ||
					!current.editable ||
					current.working ||
					current.running ||
					current.queueEditing ||
					current.hasQueuedMessages ||
					current.awaitingInput
				)
					return;
				const text = result.text.trim();
				if (!text || text.length > 2000) return;
				const accept = context.commands.register({
					id: 'accept-follow-up',
					title: 'Use follow-up prompt',
					action: { type: 'composer.setText', text, expectedRevision: state.revision },
				});
				contributions.push(accept);
				await accept.ready;
				if (disposed || generation !== epoch) return;
				const placeholder = context.composer.setPlaceholder(text, {
					id: 'follow-up',
					expectedRevision: state.revision,
					acceptCommand: accept.id,
					hint: 'Tab to use',
				});
				contributions.push(placeholder);
				await placeholder.ready;
				if (disposed || generation !== epoch) return;
				const binding = context.keybindings.register({
					id: 'accept-follow-up',
					key: 'Tab',
					command: accept.id,
					when: { composerFocused: true, composerEmpty: true, contributionVisible: placeholder.id },
				});
				contributions.push(binding);
				await binding.ready;
				if (disposed || generation !== epoch) return;
				const dismiss = context.commands.register({
					id: 'dismiss-follow-up',
					title: 'Dismiss follow-up prompt',
					run: () => clear(),
				});
				contributions.push(dismiss);
				await dismiss.ready;
				if (disposed || generation !== epoch) return;
				const escape = context.keybindings.register({
					id: 'dismiss-follow-up',
					key: 'Escape',
					command: dismiss.id,
					when: { composerFocused: true, contributionVisible: placeholder.id },
				});
				contributions.push(escape);
				await escape.ready;
			} catch (error) {
				if (disposed || job.signal.aborted || generation !== epoch || context.signal.aborted)
					return;
				clear();
				await context.reportError(error instanceof Error ? error.message : String(error));
			}
		}

		const subscriptions = [
			context.composer.onDidChange(async () => {
				const state = await context.composer.getState();
				if (
					state.revision !== draftRevision ||
					!state.empty ||
					state.working ||
					state.running ||
					state.hasQueuedMessages ||
					state.awaitingInput ||
					!state.editable
				)
					clear();
			}),
			context.conversation.onDidChange(() => clear()),
			context.conversation.onDidCompleteTurn(() => refresh()),
			context.events.on('composer.stateChanged', async () => {
				const state = await context.composer.getState();
				if (
					state.working ||
					state.running ||
					state.hasQueuedMessages ||
					state.awaitingInput ||
					!state.editable
				)
					clear();
			}),
		];
		await Promise.all(subscriptions.map((subscription) => subscription.ready));
		await refresh();
		return () => {
			disposed = true;
			clear();
			for (const subscription of subscriptions) subscription.dispose();
		};
	},
});
