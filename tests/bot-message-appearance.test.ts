import { describe, expect, it } from 'vitest';
import type { BotMessage } from '../src/bot-types';
import { nextBotMessageAppearances } from '../src/lib/bot-message-appearance';

const message = (id: string, createdAt: number, changes: Partial<BotMessage> = {}): BotMessage => ({
	id,
	role: 'bot',
	content: 'Hello!',
	status: 'completed',
	createdAt,
	updatedAt: createdAt,
	reactions: [],
	...changes,
});

describe('bot bubble entrances', () => {
	it('does not animate existing history on open, refresh, reactions, edits, or a conversation switch', () => {
		const first = message('one', 100);
		let next = nextBotMessageAppearances(undefined, 'conversation', [first]);
		expect([...next.entering]).toEqual([]);
		for (const updated of [
			{ ...first },
			{ ...first, content: 'Edited hello', editedAt: 200 },
			{ ...first, reactions: [{ actorId: 'user', emoji: '👍' as const, createdAt: 200 }] },
		]) {
			next = nextBotMessageAppearances(next.snapshot, 'conversation', [updated]);
			expect([...next.entering]).toEqual([]);
		}
		next = nextBotMessageAppearances(next.snapshot, 'other', [message('other', 300)]);
		expect([...next.entering]).toEqual([]);
	});

	it('animates a newly sent user message and a bot reply arriving without a pending placeholder', () => {
		const first = message('one', 100);
		const baseline = nextBotMessageAppearances(undefined, 'conversation', [first]);
		const next = nextBotMessageAppearances(baseline.snapshot, 'conversation', [
			first,
			message('two', 200, { role: 'user' }),
			message('three', 300),
		]);
		expect([...next.entering]).toEqual(['two', 'three']);
	});

	it('animates a typing bubble and then its completed reply, but never hidden thinking phases', () => {
		const pending = message('reply', 100, { status: 'pending', activity: 'thinking', content: '' });
		let next = nextBotMessageAppearances(undefined, 'conversation', [pending]);
		expect([...next.entering]).toEqual([]);
		next = nextBotMessageAppearances(next.snapshot, 'conversation', [
			{ ...pending, activity: 'writing' },
		]);
		expect([...next.entering]).toEqual(['reply']);
		next = nextBotMessageAppearances(next.snapshot, 'conversation', [message('reply', 100)]);
		expect([...next.entering]).toEqual(['reply']);
		next = nextBotMessageAppearances(next.snapshot, 'conversation', [message('reply', 100)]);
		expect([...next.entering]).toEqual([]);
	});

	it('handles a direct thinking-to-completed transition without requiring typing first', () => {
		const pending = message('reply', 100, { status: 'pending', activity: 'thinking', content: '' });
		const baseline = nextBotMessageAppearances(undefined, 'conversation', [pending]);
		const next = nextBotMessageAppearances(baseline.snapshot, 'conversation', [
			message('reply', 100),
		]);
		expect([...next.entering]).toEqual(['reply']);
	});

	it('does not animate older history backfill or loading snapshots', () => {
		const recent = message('recent', 500);
		const baseline = nextBotMessageAppearances(undefined, 'conversation', [recent]);
		const backfill = nextBotMessageAppearances(baseline.snapshot, 'conversation', [
			message('old', 100),
			recent,
		]);
		expect([...backfill.entering]).toEqual([]);
		const loading = nextBotMessageAppearances(
			backfill.snapshot,
			'conversation',
			[recent, message('loaded', 600)],
			true,
		);
		expect([...loading.entering]).toEqual([]);
		const loaded = nextBotMessageAppearances(loading.snapshot, 'conversation', [
			recent,
			message('loaded', 600),
		]);
		expect([...loaded.entering]).toEqual([]);
	});
});
