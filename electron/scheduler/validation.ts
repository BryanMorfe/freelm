import type {
	SchedulerCommand,
	SchedulerDispatchResult,
	SchedulerJobInput,
	SchedulerOrigin,
	SchedulerSchedule,
	SchedulerTarget,
} from '../../src/scheduler-types';
import { dateValue, validateSchedule } from './recurrence';

const record = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === 'object' && !Array.isArray(value);
function fields(
	value: unknown,
	allowed: string[],
	label: string,
): asserts value is Record<string, unknown> {
	if (!record(value) || Object.keys(value).some((key) => !allowed.includes(key)))
		throw new Error(`Invalid ${label} fields.`);
}
export function schedulerText(
	value: unknown,
	label: string,
	maximum = 200,
): asserts value is string {
	if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\0'))
		throw new Error(`${label} must be nonempty text of at most ${maximum} characters.`);
}
function destination(value: unknown): void {
	fields(value, ['botId', 'conversationId', 'userMessageId'], 'bot destination');
	for (const name of ['botId', 'conversationId', 'userMessageId']) schedulerText(value[name], name);
}
export function validateSchedulerTarget(value: unknown): asserts value is SchedulerTarget {
	if (!record(value)) throw new Error('Invalid scheduled destination.');
	if (value.kind === 'reminder') {
		fields(value, ['kind', 'message', 'destination'], 'reminder');
		schedulerText(value.message, 'Reminder message', 16_000);
		if (value.destination !== undefined) destination(value.destination);
	} else if (value.kind === 'bot') {
		fields(value, ['kind', 'botId', 'conversationId', 'userMessageId', 'prompt'], 'bot task');
		destination({
			botId: value.botId,
			conversationId: value.conversationId,
			userMessageId: value.userMessageId,
		});
		schedulerText(value.prompt, 'Scheduled prompt', 32_000);
	} else if (value.kind === 'code') {
		fields(value, ['kind', 'threadId', 'prompt'], 'Code task');
		schedulerText(value.threadId, 'Code thread ID');
		schedulerText(value.prompt, 'Scheduled prompt', 32_000);
	} else throw new Error('Choose a reminder, bot, or Code destination.');
}
export function validateSchedulerOrigin(value: unknown): asserts value is SchedulerOrigin {
	if (!record(value)) throw new Error('Invalid schedule origin.');
	if (value.kind === 'code') {
		fields(value, ['kind', 'threadId'], 'Code origin');
		schedulerText(value.threadId, 'Code thread ID');
	} else if (value.kind === 'bot') {
		fields(value, ['kind', 'botId', 'conversationId', 'userMessageId'], 'bot origin');
		destination({
			botId: value.botId,
			conversationId: value.conversationId,
			userMessageId: value.userMessageId,
		});
	} else throw new Error('Invalid schedule origin.');
}
export function validateSchedulerSchedule(value: unknown): asserts value is SchedulerSchedule {
	fields(
		value,
		['kind', 'at', 'intervalMinutes', 'time', 'timezone', 'weekdays', 'missed', 'overlap'],
		'schedule',
	);
	validateSchedule(value as unknown as SchedulerSchedule);
	if (value.at !== undefined && !Number.isFinite(new Date(dateValue(value.at)).getTime()))
		throw new Error('Schedule requires a valid date and time.');
	if (value.timezone !== undefined) {
		try {
			new Intl.DateTimeFormat('en-US', { timeZone: String(value.timezone) }).format();
		} catch {
			throw new Error('Schedule timezone is invalid.');
		}
	}
}
export function validateSchedulerInput(value: unknown): asserts value is SchedulerJobInput {
	fields(value, ['title', 'schedule', 'target', 'origin'], 'scheduled task');
	schedulerText(value.title, 'Task title');
	validateSchedulerSchedule(value.schedule);
	validateSchedulerTarget(value.target);
	if (value.origin !== undefined) validateSchedulerOrigin(value.origin);
}
export function validateSchedulerCommand(value: unknown): asserts value is SchedulerCommand {
	if (!record(value)) throw new Error('Invalid scheduler command.');
	switch (value.type) {
		case 'create':
			fields(value, ['type', 'job', 'idempotencyKey'], 'create command');
			validateSchedulerInput(value.job);
			break;
		case 'update':
			fields(value, ['type', 'id', 'patch'], 'update command');
			fields(value.patch, ['title', 'schedule', 'target'], 'schedule update');
			if (!Object.keys(value.patch).length) throw new Error('Provide a schedule change.');
			if (value.patch.title !== undefined) schedulerText(value.patch.title, 'Task title');
			if (value.patch.schedule !== undefined) validateSchedulerSchedule(value.patch.schedule);
			if (value.patch.target !== undefined) validateSchedulerTarget(value.patch.target);
			break;
		case 'pause':
		case 'resume':
		case 'delete':
			fields(value, ['type', 'id'], 'scheduler command');
			break;
		case 'run-now':
			fields(value, ['type', 'id', 'idempotencyKey'], 'run command');
			break;
		case 'snooze':
			fields(value, ['type', 'id', 'until', 'occurrenceId'], 'snooze command');
			if (typeof value.until !== 'number' || !Number.isFinite(new Date(value.until).getTime()))
				throw new Error('Choose a valid snooze time.');
			if (value.occurrenceId !== undefined) schedulerText(value.occurrenceId, 'Occurrence ID');
			break;
		case 'retry':
		case 'dismiss':
			fields(value, ['type', 'occurrenceId'], 'occurrence command');
			schedulerText(value.occurrenceId, 'Occurrence ID');
			return;
		default:
			throw new Error('Unknown scheduler command.');
	}
	if (value.type !== 'create') schedulerText(value.id, 'Schedule ID');
	if (value.idempotencyKey !== undefined) schedulerText(value.idempotencyKey, 'Idempotency key');
}
export function validateSchedulerResult(value: unknown): asserts value is SchedulerDispatchResult {
	fields(value, ['status', 'message', 'reference'], 'scheduler dispatch result');
	if (value.status !== 'delivered' && value.status !== 'admitted')
		throw new Error('The destination did not confirm delivery or admission.');
	if (value.message !== undefined) schedulerText(value.message, 'Delivery message', 2000);
	if (value.reference !== undefined) schedulerText(value.reference, 'Delivery reference', 1000);
}
