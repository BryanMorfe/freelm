import type { Message } from '../types';

const DAY_MS = 24 * 60 * 60 * 1000;
const USER_SEPARATOR_GAP_MS = 20 * 60 * 1000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface MessageDateOptions {
	/** Defaults to the viewer's local time zone. */
	timeZone?: string;
}
interface UserMessageDateOptions extends MessageDateOptions {
	/** One clock snapshot can be supplied for an entire conversation render. */
	now?: number;
}
interface CalendarTime {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
}

const zonedFormatters = new Map<string, Intl.DateTimeFormat>();

function calendarTime(timestamp: number, timeZone?: string): CalendarTime | undefined {
	if (!Number.isFinite(timestamp)) return;
	const date = new Date(timestamp);
	if (!Number.isFinite(date.getTime())) return;
	if (!timeZone) {
		return {
			year: date.getFullYear(),
			month: date.getMonth() + 1,
			day: date.getDate(),
			hour: date.getHours(),
			minute: date.getMinutes(),
		};
	}
	try {
		let formatter = zonedFormatters.get(timeZone);
		if (!formatter) {
			formatter = new Intl.DateTimeFormat('en-US', {
				timeZone,
				calendar: 'gregory',
				numberingSystem: 'latn',
				year: 'numeric',
				month: 'numeric',
				day: 'numeric',
				hour: 'numeric',
				minute: 'numeric',
				hourCycle: 'h23',
			});
			if (zonedFormatters.size >= 16) zonedFormatters.clear();
			zonedFormatters.set(timeZone, formatter);
		}
		const parts = formatter.formatToParts(date);
		const value = (type: Intl.DateTimeFormatPartTypes) =>
			Number(parts.find((part) => part.type === type)?.value);
		return {
			year: value('year'),
			month: value('month'),
			day: value('day'),
			hour: value('hour'),
			minute: value('minute'),
		};
	} catch {
		return;
	}
}

function calendarDate(value: CalendarTime): Date {
	// Use calendar fields rather than elapsed hours: a local day can have 23 or 25 hours.
	const date = new Date(0);
	date.setUTCFullYear(value.year, value.month - 1, value.day);
	return date;
}

function timeLabel(value: CalendarTime): string {
	return `${value.hour % 12 || 12}:${String(value.minute).padStart(2, '0')} ${value.hour < 12 ? 'AM' : 'PM'}`;
}

/** The message's original timestamp stays stable while its contents stream. */
export function assistantMessageTime(createdAt: number, options: MessageDateOptions = {}): string {
	const value = calendarTime(createdAt, options.timeZone);
	return value ? timeLabel(value) : '';
}

export function userMessageDateLabel(
	createdAt: number,
	options: UserMessageDateOptions = {},
): string {
	const value = calendarTime(createdAt, options.timeZone);
	const now = calendarTime(options.now ?? Date.now(), options.timeZone);
	if (!value || !now) return '';
	const date = calendarDate(value);
	const daysAgo = (calendarDate(now).getTime() - date.getTime()) / DAY_MS;
	const time = timeLabel(value);
	if (daysAgo === 0) return `Today ${time}`;
	if (daysAgo === 1) return `Yesterday ${time}`;
	if (daysAgo >= 2 && daysAgo < 7) return `${WEEKDAYS[date.getUTCDay()]} ${time}`;
	const monthDay = `${MONTHS[value.month - 1]} ${value.day}`;
	if (value.year !== now.year) return `${monthDay}, ${value.year} at ${time}`;
	return `${WEEKDAYS[date.getUTCDay()].slice(0, 3)}, ${monthDay} at ${time}`;
}

/** Only user messages start groups; assistant and tool activity do not reset the gap. */
export function userMessageSeparators(
	messages: readonly Pick<Message, 'id' | 'role' | 'createdAt'>[],
	options: UserMessageDateOptions = {},
): Map<string, string> {
	const result = new Map<string, string>();
	const snapshot = { ...options, now: options.now ?? Date.now() };
	let previousUserTimestamp: number | undefined;
	for (const message of messages) {
		if (message.role !== 'user') continue;
		const valid =
			Number.isFinite(message.createdAt) && Number.isFinite(new Date(message.createdAt).getTime());
		if (
			valid &&
			(previousUserTimestamp === undefined ||
				message.createdAt - previousUserTimestamp >= USER_SEPARATOR_GAP_MS)
		) {
			const label = userMessageDateLabel(message.createdAt, snapshot);
			if (label) result.set(message.id, label);
		}
		if (valid) {
			previousUserTimestamp = message.createdAt;
		}
	}
	return result;
}
