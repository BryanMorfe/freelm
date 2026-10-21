import { describe, expect, it, vi } from 'vitest';
import {
	assistantMessageTime,
	userMessageDateLabel,
	userMessageSeparators,
} from '../src/lib/message-dates';
import type { Message } from '../src/types';

const utc = { timeZone: 'UTC' };
const timestamp = (value: string) => Date.parse(value);
const message = (id: string, createdAt: number, role: Message['role'] = 'user') => ({
	id,
	createdAt,
	role,
});

describe('message time labels', () => {
	it.each([
		['2026-05-15T00:00:00Z', '12:00 AM'],
		['2026-05-15T00:03:00Z', '12:03 AM'],
		['2026-05-15T11:59:00Z', '11:59 AM'],
		['2026-05-15T12:00:00Z', '12:00 PM'],
		['2026-05-15T20:20:00Z', '8:20 PM'],
	])('formats %s as %s', (value, expected) => {
		expect(assistantMessageTime(timestamp(value), utc)).toBe(expected);
	});
	it('uses the viewer time zone rather than the timestamp offset', () => {
		expect(
			assistantMessageTime(timestamp('2026-05-15T20:20:00Z'), {
				timeZone: 'America/New_York',
			}),
		).toBe('4:20 PM');
	});
	it('defaults to the local calendar and clock', () => {
		expect(assistantMessageTime(new Date(2026, 4, 15, 20, 20).getTime())).toBe('8:20 PM');
	});
});

describe('user message date labels', () => {
	const now = timestamp('2026-05-20T21:00:00Z');
	it.each([
		['2026-05-20T16:41:00Z', 'Today 4:41 PM'],
		['2026-05-19T06:02:00Z', 'Yesterday 6:02 AM'],
		['2026-05-18T21:22:00Z', 'Monday 9:22 PM'],
		['2026-05-14T03:21:00Z', 'Thursday 3:21 AM'],
		['2026-05-13T03:21:00Z', 'Wed, May 13 at 3:21 AM'],
		['2026-05-01T20:20:00Z', 'Fri, May 1 at 8:20 PM'],
		['2025-05-15T09:02:00Z', 'May 15, 2025 at 9:02 AM'],
	])('formats %s as %s', (value, expected) => {
		expect(userMessageDateLabel(timestamp(value), { ...utc, now })).toBe(expected);
	});
	it('changes from Today to Yesterday at local midnight', () => {
		const timeZone = 'America/New_York';
		const createdAt = timestamp('2026-05-20T03:59:00Z');
		expect(
			userMessageDateLabel(createdAt, { timeZone, now: timestamp('2026-05-20T03:59:59Z') }),
		).toBe('Today 11:59 PM');
		expect(
			userMessageDateLabel(createdAt, { timeZone, now: timestamp('2026-05-20T04:00:00Z') }),
		).toBe('Yesterday 11:59 PM');
	});
	it.each([
		['2026-03-08T23:00:00-04:00', '2026-03-09T01:00:00-04:00', 'Yesterday 11:00 PM'],
		['2026-03-07T23:00:00-05:00', '2026-03-09T01:00:00-04:00', 'Saturday 11:00 PM'],
		['2026-11-01T00:30:00-04:00', '2026-11-02T00:15:00-05:00', 'Yesterday 12:30 AM'],
	])('uses calendar days across DST: %s', (createdAt, current, expected) => {
		expect(
			userMessageDateLabel(timestamp(createdAt), {
				timeZone: 'America/New_York',
				now: timestamp(current),
			}),
		).toBe(expected);
	});
	it('uses relative labels across the year boundary before absolute dates need a year', () => {
		const options = { ...utc, now: timestamp('2026-01-01T12:00:00Z') };
		expect(userMessageDateLabel(timestamp('2025-12-31T20:20:00Z'), options)).toBe(
			'Yesterday 8:20 PM',
		);
		expect(userMessageDateLabel(timestamp('2025-12-26T20:20:00Z'), options)).toBe('Friday 8:20 PM');
		expect(userMessageDateLabel(timestamp('2025-12-25T20:20:00Z'), options)).toBe(
			'Dec 25, 2025 at 8:20 PM',
		);
	});
	it('keeps same-year future dates absolute', () => {
		expect(userMessageDateLabel(timestamp('2026-05-22T03:21:00Z'), { ...utc, now })).toBe(
			'Fri, May 22 at 3:21 AM',
		);
	});
	it.each([NaN, Infinity, -Infinity, 9e20])('omits invalid dates %s', (createdAt) => {
		expect(assistantMessageTime(createdAt, utc)).toBe('');
		expect(userMessageDateLabel(createdAt, { ...utc, now })).toBe('');
	});
	it('omits dates when the comparison clock or explicit time zone is invalid', () => {
		expect(userMessageDateLabel(now, { ...utc, now: NaN })).toBe('');
		expect(userMessageDateLabel(now, { now, timeZone: 'Unknown/TimeZone' })).toBe('');
		expect(assistantMessageTime(now, { timeZone: 'Unknown/TimeZone' })).toBe('');
	});
});

describe('user message grouping', () => {
	const start = timestamp('2026-05-20T12:00:00Z');
	const options = { ...utc, now: timestamp('2026-05-20T21:00:00Z') };
	it('labels the first user even when an assistant precedes it', () => {
		expect([
			...userMessageSeparators([message('a', start, 'assistant'), message('u', start)], options),
		]).toEqual([['u', 'Today 12:00 PM']]);
	});
	it.each([
		[20 * 60 * 1000 - 1, false],
		[20 * 60 * 1000, true],
	])('starts a new group at %s ms only when it reaches 20 minutes', (gap, expected) => {
		const result = userMessageSeparators(
			[message('first', start), message('next', start + gap)],
			options,
		);
		expect(result.has('next')).toBe(expected);
	});
	it('compares consecutive users and ignores assistant activity between them', () => {
		const result = userMessageSeparators(
			[
				message('first', start),
				message('assistant', start + 19 * 60 * 1000, 'assistant'),
				message('next', start + 20 * 60 * 1000),
				message('third', start + 39 * 60 * 1000),
				message('fourth', start + 59 * 60 * 1000),
			],
			options,
		);
		expect([...result.keys()]).toEqual(['first', 'next', 'fourth']);
	});
	it('does not treat a new calendar day alone as a 20-minute break', () => {
		const result = userMessageSeparators(
			[
				message('first', timestamp('2026-05-19T23:55:00Z')),
				message('next', timestamp('2026-05-20T00:05:00Z')),
			],
			options,
		);
		expect([...result.values()]).toEqual(['Yesterday 11:55 PM']);
	});
	it('omits a regressed clock entry, then compares with the immediately previous valid user', () => {
		const result = userMessageSeparators(
			[
				message('first', start),
				message('regressed', start - 60 * 60 * 1000),
				message('caught-up', start + 60 * 1000),
				message('next', start + 20 * 60 * 1000),
			],
			options,
		);
		expect([...result.keys()]).toEqual(['first', 'caught-up']);
	});
	it('omits malformed dates and keeps the previous valid user timestamp', () => {
		const result = userMessageSeparators(
			[
				message('first', start),
				message('invalid', NaN),
				message('unknown-gap', start + 60 * 60 * 1000),
				message('next', start + 80 * 60 * 1000),
			],
			options,
		);
		expect([...result.keys()]).toEqual(['first', 'unknown-gap', 'next']);
	});
	it('labels the first valid user timestamp if earlier dates are malformed', () => {
		const result = userMessageSeparators(
			[message('invalid', NaN), message('first-valid', start)],
			options,
		);
		expect([...result]).toEqual([['first-valid', 'Today 12:00 PM']]);
	});
	it('takes one clock snapshot for the conversation rather than polling per message', () => {
		const clock = vi.spyOn(Date, 'now').mockReturnValue(options.now);
		try {
			const result = userMessageSeparators(
				[message('first', start), message('next', start + 20 * 60 * 1000)],
				utc,
			);
			expect(result.size).toBe(2);
			expect(clock).toHaveBeenCalledTimes(1);
		} finally {
			clock.mockRestore();
		}
	});
	it('does not mutate the conversation and returns no labels for an empty thread', () => {
		const messages = Object.freeze([Object.freeze(message('first', start))]);
		expect(userMessageSeparators(messages, options).size).toBe(1);
		expect(userMessageSeparators([], options).size).toBe(0);
	});
});
