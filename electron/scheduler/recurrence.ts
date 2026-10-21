import type { SchedulerSchedule } from '../../src/scheduler-types';

export const dateValue = (value: unknown): number =>
	typeof value === 'number' ? value : Date.parse(String(value ?? ''));
export function validateSchedule(schedule: SchedulerSchedule): void {
	if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule))
		throw new Error('Invalid schedule settings.');
	if (schedule.missed !== undefined && !['skip', 'once'].includes(schedule.missed))
		throw new Error('Invalid missed-schedule policy.');
	if (schedule.overlap !== undefined && !['skip', 'queue'].includes(schedule.overlap))
		throw new Error('Invalid overlapping-schedule policy.');
	if (
		schedule.timezone !== undefined &&
		(typeof schedule.timezone !== 'string' || schedule.timezone.length > 100)
	)
		throw new Error('Invalid schedule timezone.');
	if (!['once', 'interval', 'daily', 'weekly'].includes(schedule.kind))
		throw new Error('Choose a schedule frequency.');
	if (schedule.kind === 'once' && !Number.isFinite(dateValue(schedule.at)))
		throw new Error('Schedule requires a valid date and time.');
	if (
		schedule.kind === 'interval' &&
		!(
			typeof schedule.intervalMinutes === 'number' &&
			Number.isFinite(schedule.intervalMinutes) &&
			schedule.intervalMinutes >= 1 &&
			schedule.intervalMinutes <= 525600
		)
	)
		throw new Error('Schedule interval must be between 1 minute and 1 year.');
	if (schedule.kind === 'daily' || schedule.kind === 'weekly') {
		if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time ?? ''))
			throw new Error('Schedule time must use HH:MM.');
		try {
			new Intl.DateTimeFormat('en-US', { timeZone: schedule.timezone || 'UTC' }).format();
		} catch {
			throw new Error('Schedule timezone is invalid.');
		}
		if (
			schedule.kind === 'weekly' &&
			(!Array.isArray(schedule.weekdays) ||
				!schedule.weekdays.length ||
				schedule.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6))
		)
			throw new Error('Weekly schedules require weekdays from Sunday (0) to Saturday (6).');
	}
}
/** Calendar schedules follow wall time in the selected zone, including daylight saving changes. */
export function nextScheduleAt(schedule: SchedulerSchedule, after: number): number | undefined {
	validateSchedule(schedule);
	if (schedule.kind === 'once') {
		const at = dateValue(schedule.at);
		return at > after ? at : undefined;
	}
	if (schedule.kind === 'interval') {
		const step = Number(schedule.intervalMinutes) * 60_000;
		const anchor = Number.isFinite(dateValue(schedule.at)) ? dateValue(schedule.at) : after;
		return anchor > after ? anchor : anchor + (Math.floor((after - anchor) / step) + 1) * step;
	}
	const formatter = new Intl.DateTimeFormat('en-US', {
		timeZone: schedule.timezone || 'UTC',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		weekday: 'short',
		hourCycle: 'h23',
	});
	const afterParts = Object.fromEntries(
		formatter.formatToParts(after).map((part) => [part.type, part.value]),
	);
	const dayAlreadyPassed = `${afterParts.hour}:${afterParts.minute}` >= schedule.time!;
	const [hour, minute] = schedule.time!.split(':').map(Number);
	const localMidnight = Date.UTC(
		Number(afterParts.year),
		Number(afterParts.month) - 1,
		Number(afterParts.day),
	);
	const asUTC = (parts: Record<string, string>) =>
		Date.UTC(
			Number(parts.year),
			Number(parts.month) - 1,
			Number(parts.day),
			Number(parts.hour),
			Number(parts.minute),
		);
	// Probe the offsets on either side of each local date. This finds both DST offsets
	// in a few Intl calls instead of blocking the host while scanning thousands of minutes.
	for (let day = dayAlreadyPassed ? 1 : 0; day < 10; day++) {
		const localDate = localMidnight + day * 86_400_000;
		if (schedule.kind === 'weekly' && !schedule.weekdays!.includes(new Date(localDate).getUTCDay()))
			continue;
		const wallTime = localDate + hour * 3_600_000 + minute * 60_000;
		const offsets = new Set<number>();
		for (const shift of [-86_400_000, 0, 86_400_000]) {
			const probe = wallTime + shift;
			const parts = Object.fromEntries(
				formatter.formatToParts(probe).map((part) => [part.type, part.value]),
			);
			offsets.add(asUTC(parts) - probe);
		}
		for (const candidate of [...offsets].map((offset) => wallTime - offset).sort((a, b) => a - b)) {
			if (candidate <= after) continue;
			const parts = Object.fromEntries(
				formatter.formatToParts(candidate).map((part) => [part.type, part.value]),
			);
			if (asUTC(parts) === wallTime) return candidate;
		}
	}
	throw new Error('Could not calculate the next schedule occurrence.');
}
