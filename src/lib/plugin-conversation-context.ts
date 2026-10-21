import type { Message, Thread } from '../types';

/** Only the visible conversation branch and final, completed exchanges leave the host. */
export function pluginConversationContext(
	thread: Thread | undefined,
	limit: number,
	running: boolean,
) {
	if (!Number.isInteger(limit) || limit < 1 || limit > 20)
		throw new Error('Request between 1 and 20 conversation exchanges.');
	if (thread?.temporary) throw new Error('Plugins cannot read temporary conversations.');
	const turns: {
		messages: { id: string; role: 'user' | 'assistant'; text: string; createdAt: number }[];
	}[] = [];
	let pending: Message[] = [];
	for (const [index, message] of (thread?.messages ?? []).entries()) {
		if (message.role === 'user') {
			pending.push(message);
			continue;
		}
		if (!pending.length) continue;
		const active = running && index === (thread?.messages.length ?? 0) - 1;
		if (!active && !message.error && !message.interrupted && message.content.trim()) {
			turns.push({
				messages: [...pending, message].map(({ id, role, content, createdAt }) => ({
					id,
					role,
					text: content,
					createdAt,
				})),
			});
		}
		pending = [];
	}
	const selected = turns.slice(-limit);
	let remaining = 64_000;
	let truncated = false;
	// Budget newest text first, retaining exchange order and the user's prompt.
	for (let i = selected.length - 1; i >= 0; i--) {
		for (const message of selected[i].messages) {
			const max = Math.min(remaining, 16_000);
			if (message.text.length > max) {
				message.text = message.text.slice(0, max);
				truncated = true;
			}
			remaining -= message.text.length;
		}
	}
	return {
		revision: selected
			.map((turn) =>
				turn.messages.map((message) => `${message.id}:${message.text.length}`).join(','),
			)
			.join('|'),
		turns: selected,
		truncated,
		omissions: [
			'System instructions, memories, reasoning, tool results, attachments, and inactive branches are not included.',
		],
	};
}
