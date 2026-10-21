import { createHash } from 'node:crypto';
import Ajv from 'ajv';
import {
	schedulerTools,
	type SchedulerToolContext,
	type SchedulerToolProvider,
} from '../src/lib/scheduler-tools';
import type {
	SchedulerJob,
	SchedulerTarget,
	SchedulerOrigin,
	SchedulerOccurrence,
} from '../src/scheduler-types';
import { textResult } from '../src/lib/interaction-tools';
import { SchedulerService } from './scheduler/service';

const ajv = new Ajv({ strict: false });
const validators = new Map(schedulerTools.map((tool) => [tool.name, ajv.compile(tool.parameters)]));
const identity = (origin: SchedulerOrigin) =>
	origin.kind === 'code'
		? `code:${origin.threadId}`
		: `bot:${origin.botId}:${origin.conversationId}`;
const owns = (job: SchedulerJob, origin: SchedulerOrigin) =>
	!!job.origin && identity(job.origin) === identity(origin);
const occurrenceSummary = ({ jobSnapshot: _snapshot, ...item }: SchedulerOccurrence) => item;
function jobSummary(job: SchedulerJob) {
	const content = job.target.kind === 'reminder' ? job.target.message : job.target.prompt;
	const target =
		job.target.kind === 'reminder'
			? { ...job.target, message: content.slice(0, 2000) }
			: { ...job.target, prompt: content.slice(0, 2000) };
	return { ...job, target, textTruncated: content.length > 2000 };
}
function explicitTime(value: unknown): number {
	if (
		typeof value !== 'string' ||
		!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ||
		!Number.isFinite(Date.parse(value))
	)
		throw new Error('Use an ISO 8601 timestamp with an explicit UTC offset.');
	return Date.parse(value);
}
function scheduleInput(value: Record<string, unknown>) {
	if (value.at !== undefined) explicitTime(value.at);
	return {
		missed: 'once' as const,
		overlap: 'skip' as const,
		timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		...value,
	} as SchedulerJob['schedule'];
}
export class SchedulerToolService implements SchedulerToolProvider {
	constructor(private scheduler: SchedulerService) {}
	async execute(name: string, args: Record<string, unknown>, context: SchedulerToolContext) {
		context.signal.throwIfAborted();
		if (!validators.get(name)?.(args)) throw new Error('Invalid scheduler tool arguments.');
		const snapshot = this.scheduler.snapshot();
		const jobs = snapshot.jobs.filter((job) => owns(job, context.origin));
		if (name === 'scheduler.list') {
			const offset = Number(args.offset ?? 0),
				limit = Number(args.limit ?? 20);
			const items = jobs.slice(offset, offset + limit);
			return textResult({
				currentTime: new Date().toISOString(),
				timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
				jobs: items.map(jobSummary),
				occurrences: snapshot.occurrences
					.filter((item) => items.some((job) => job.id === item.jobId))
					.slice(0, 50)
					.map(occurrenceSummary),
				total: jobs.length,
				nextOffset: offset + limit < jobs.length ? offset + limit : null,
			});
		}
		if (name === 'scheduler.create') {
			const origin = context.origin,
				content = String(args.text);
			const target: SchedulerTarget =
				args.action === 'reminder'
					? {
							kind: 'reminder',
							message: content,
							...(origin.kind === 'bot'
								? {
										destination: {
											botId: origin.botId,
											conversationId: origin.conversationId,
											userMessageId: origin.userMessageId,
										},
									}
								: {}),
						}
					: origin.kind === 'code'
						? { kind: 'code', threadId: origin.threadId, prompt: content }
						: {
								kind: 'bot',
								botId: origin.botId,
								conversationId: origin.conversationId,
								userMessageId: origin.userMessageId,
								prompt: content,
							};
			const idempotencyKey = createHash('sha256')
				.update(`${identity(origin)}:${String(args.idempotencyKey)}`)
				.digest('hex');
			const result = await this.scheduler.command({
				type: 'create',
				job: {
					title: String(args.title),
					schedule: scheduleInput(args.schedule as Record<string, unknown>),
					target,
					origin,
				},
				idempotencyKey,
			});
			return textResult({
				job: result.jobs.find((job) => job.id === result.jobId),
				execution:
					'Runs on this computer while FreeLM is running. Task admission is not task completion.',
			});
		}
		const occurrence = ['scheduler.retry', 'scheduler.snooze'].includes(name)
			? snapshot.occurrences.find((item) => item.id === args.occurrenceId)
			: undefined;
		if (['scheduler.retry', 'scheduler.snooze'].includes(name) && !occurrence)
			throw new Error('Scheduled occurrence not found.');
		if (name === 'scheduler.snooze' && occurrence?.jobId !== args.id)
			throw new Error('This occurrence belongs to a different schedule.');
		const job = jobs.find((item) => item.id === (occurrence?.jobId ?? args.id));
		if (!job) throw new Error('This schedule does not belong to the current conversation.');
		let result;
		if (name === 'scheduler.update') {
			let target =
				args.text === undefined
					? undefined
					: job.target.kind === 'reminder'
						? { ...job.target, message: String(args.text) }
						: { ...job.target, prompt: String(args.text) };
			// Keep the creation origin, but attribute revised future work to the latest authorizing turn.
			if (
				context.origin.kind === 'bot' &&
				(args.text !== undefined || args.schedule !== undefined)
			) {
				const current = target ?? job.target;
				if (current.kind === 'bot')
					target = { ...current, userMessageId: context.origin.userMessageId };
				else if (current.kind === 'reminder' && current.destination)
					target = {
						...current,
						destination: { ...current.destination, userMessageId: context.origin.userMessageId },
					};
			}
			result = await this.scheduler.command({
				type: 'update',
				id: job.id,
				patch: {
					...(args.title !== undefined ? { title: String(args.title) } : {}),
					...(args.schedule !== undefined
						? { schedule: scheduleInput(args.schedule as Record<string, unknown>) }
						: {}),
					...(target ? { target } : {}),
				},
			});
		} else if (name === 'scheduler.snooze')
			result = await this.scheduler.command({
				type: 'snooze',
				id: job.id,
				until: explicitTime(args.until),
				occurrenceId: occurrence!.id,
			});
		else if (name === 'scheduler.retry')
			result = await this.scheduler.command({ type: 'retry', occurrenceId: occurrence!.id });
		else
			result = await this.scheduler.command({
				type: name.slice('scheduler.'.length).replace('_', '-') as
					'pause' | 'resume' | 'delete' | 'run-now',
				id: job.id,
			});
		return textResult({
			job: result.jobs.find((item) => item.id === job.id) ?? null,
			occurrences: result.occurrences
				.filter((item) => item.jobId === job.id)
				.slice(0, 10)
				.map(occurrenceSummary),
		});
	}
}
