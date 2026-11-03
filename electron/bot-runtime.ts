import {
	BotExecutionStore,
	type BotExecutionAction,
	type BotExecutionJob,
} from './bot-execution-store';
import type { BotJobView, BotReplyRequest } from '../src/bot-types';

export interface BotJobContext {
	input: BotReplyRequest;
	remote: boolean;
	sourceHostId: string;
	kind: 'plugin' | 'task' | 'group';
	approved?: boolean;
	/** Transient launch provenance, not saved authority. */
	recovered?: boolean;
}
export class BotJobPreflightError extends Error {}
export interface BotRuntimeOptions {
	store: BotExecutionStore;
	execute: (
		action: BotExecutionAction,
		context: BotJobContext,
		signal: AbortSignal,
	) => Promise<unknown>;
	notify: (job: BotExecutionJob, context: BotJobContext) => Promise<boolean>;
	onError?: (error: unknown) => void;
}
/** Long work belongs to the host, not to a reply's cancellation signal. */
export class BotRuntime {
	private active = new Map<string, { controller: AbortController; work: Promise<void> }>();
	private closed = false;
	private admitted = new Set<string>();
	constructor(private readonly options: BotRuntimeOptions) {}
	async start() {
		await this.options.store.initialize();
		for (const job of await this.options.store.listJobs()) {
			if (job.status === 'pending') this.launch(job.id, true);
		}
		await this.retryNotifications();
	}
	async retryNotifications() {
		for (const job of await this.options.store.listJobs({ notificationDelivered: false })) {
			if (!['succeeded', 'failed', 'outcome_unknown', 'cancelled'].includes(job.status)) continue;
			try {
				await this.notify(job);
			} catch (error) {
				this.options.onError?.(error);
			}
		}
	}
	async admit(action: BotExecutionAction, context: BotJobContext, approval: boolean) {
		if (approval && !action.approvalGrantedAt && action.status === 'pending')
			await this.options.store.awaitActionApproval(action.id);
		const existed = (await this.options.store.listJobs({ runId: action.runId })).some(
			(job) => job.actionId === action.id,
		);
		const job = await this.options.store.createJob(action.id, { context });
		if (!existed) this.admitted.add(job.id);
		if (job.status === 'pending') this.launch(job.id);
		return {
			jobId: job.id,
			status: job.status,
			...(job.status === 'awaiting_approval'
				? {
						notice: 'Waiting for the user to approve this exact action in the conversation drawer.',
					}
				: {
						notice:
							'Running in the background. Completion will wake you; you may keep talking or use bot_silence.',
					}),
		};
	}
	launch(id: string, recovered = false) {
		if (this.closed || this.active.has(id)) return;
		const controller = new AbortController();
		const work = Promise.resolve()
			.then(async () => {
				let job = await this.options.store.getJob(id);
				if (!job || job.status !== 'pending' || this.closed) return;
				const action = await this.options.store.getAction(job.actionId);
				if (!action) return;
				job = await this.options.store.startJob(id);
				try {
					const result = await this.options.execute(
						action,
						{
							...(job.context as BotJobContext),
							recovered: recovered || !this.admitted.has(job.id),
						},
						controller.signal,
					);
					controller.signal.throwIfAborted();
					job = await this.options.store.succeedJob(id, result);
				} catch (error) {
					if (this.closed) return; // Preserve running state for conservative startup recovery.
					const current = await this.options.store.getJob(id);
					if (current?.status !== 'running') return;
					job = await this.options.store.failJob(
						id,
						error,
						error instanceof BotJobPreflightError ? { outcomeUnknown: false } : {},
					);
				}
				await this.notify(job);
			})
			.catch((error) => this.options.onError?.(error))
			.finally(() => this.active.delete(id));
		this.active.set(id, { controller, work });
	}
	private async notify(job: BotExecutionJob) {
		if (this.closed || job.notificationDelivered) return;
		if (await this.options.notify(job, job.context as BotJobContext))
			await this.options.store.markJobNotified(job.id);
	}
	async command(type: 'job-approve' | 'job-deny' | 'job-cancel', id: string) {
		const job = await this.options.store.getJob(id);
		if (!job) throw new Error('This job no longer exists.');
		if (type === 'job-approve') {
			if (job.status !== 'awaiting_approval') throw new Error('This job is not awaiting approval.');
			await this.options.store.approveAction(job.actionId);
			this.launch(id);
		} else {
			this.active.get(id)?.controller.abort(new Error('The user stopped this background job.'));
			const cancelled = await this.options.store.cancelJob(id);
			await this.notify(cancelled);
		}
	}
	async cancelWhere(matches: (context: BotJobContext) => boolean) {
		for (const job of await this.options.store.listJobs())
			if (
				['pending', 'running', 'awaiting_approval'].includes(job.status) &&
				matches(job.context as BotJobContext)
			)
				await this.command('job-cancel', job.id);
	}
	async views(): Promise<BotJobView[]> {
		const jobs = await this.options.store.listJobs(),
			actions = await this.options.store.listActions();
		const byId = new Map(actions.map((action) => [action.id, action]));
		return jobs.slice(-1000).flatMap((job) => {
			const action = byId.get(job.actionId),
				context = job.context as BotJobContext;
			if (!action || !context?.input || !context.sourceHostId) return [];
			return [
				{
					id: job.id,
					botId: context.input.botId,
					conversationId: context.input.conversationId,
					sourceHostId: context.sourceHostId,
					userMessageId: context.input.userMessageId,
					toolName: action.toolName,
					title: action.toolName.replaceAll('_', ' '),
					status: job.status,
					args:
						JSON.stringify(action.args).length <= 64000
							? (action.args as Record<string, unknown>)
							: { notice: 'Large read-only arguments omitted from this preview.' },
					...(job.error ? { error: job.error.slice(0, 2000) } : {}),
					createdAt: job.createdAt,
					updatedAt: job.updatedAt,
				},
			];
		});
	}
	async idle() {
		while (this.active.size) await Promise.all([...this.active.values()].map((item) => item.work));
	}
	async close(): Promise<void> {
		this.closed = true;
		for (const item of this.active.values()) item.controller.abort(new Error('FreeLM is closing.'));
		// Do not make an uncooperative plugin block application exit. Unfinished work
		// remains journaled as running and is reconciled conservatively on startup.
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			this.idle(),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, 1000);
			}),
		]);
		if (timer) clearTimeout(timer);
		await this.options.store.initialize();
	}
}

const empty = { type: 'object', properties: {}, required: [], additionalProperties: false };
export const botRuntimeTools = [
	{
		name: 'bot_send_message',
		description:
			'Send a concise text message immediately without ending your turn. For a new human work request, use this first to acknowledge your intended next step before investigation or other work tools, then continue working. Also use for meaningful progress or blockers. Do not claim success before results, expose private reasoning, or repeat a delivered message. Simple replies and quiet notifications need no preliminary acknowledgment.',
		parameters: {
			type: 'object',
			properties: { text: { type: 'string', maxLength: 32000 }, attachmentRefs: { type: 'array', maxItems: 6, items: { type: 'string' }, description: 'Optional bot-attachment references from this conversation or thread-asset references from authorized task reads on this computer with current thread access. Delivers stored files including generated media without opening them. Never paths or URLs.' } },
			required: ['text'],
			additionalProperties: false,
		},
		strict: true,
	},
	{
		name: 'bot_jobs_list',
		description: 'List your background jobs for this conversation. Quick status check.',
		parameters: empty,
		strict: true,
	},
	...['get', 'cancel'].map((action) => ({
		name: `bot_jobs_${action}`,
		description:
			action === 'get'
				? 'Read a background job status and its saved result.'
				: 'Stop a background job. This does not stop delegated threads; use threads_stop for those.',
		parameters: {
			type: 'object',
			properties: { jobId: { type: 'string' } },
			required: ['jobId'],
			additionalProperties: false,
		},
		strict: true,
	})),
];
