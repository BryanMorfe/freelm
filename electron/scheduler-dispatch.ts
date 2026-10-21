import type {
	SchedulerJob,
	SchedulerOccurrence,
	SchedulerDispatchResult,
} from '../src/scheduler-types';
import { SchedulerUnavailableError } from './scheduler/service';

interface Destination {
	botId: string;
	conversationId: string;
	userMessageId: string;
	occurrenceId: string;
}
interface SchedulerDispatchOptions {
	codeReady(): boolean;
	codeThread(
		threadId: string,
	): Promise<{ kind: string; archivedAt?: number; temporary?: boolean } | undefined>;
	sendCode(
		threadId: string,
		prompt: string,
		operationId: string,
		signal?: AbortSignal,
	): Promise<unknown>;
	remindBot(input: Destination & { message: string }): Promise<unknown>;
	wakeBot(input: Destination & { prompt: string }): Promise<unknown>;
	notify(title: string, body: string): void;
}
/** Destination adapters own idempotent admission. The scheduler never claims an admitted task finished. */
export function createSchedulerDispatcher(options: SchedulerDispatchOptions) {
	return async (
		job: SchedulerJob,
		occurrence: SchedulerOccurrence,
		signal?: AbortSignal,
	): Promise<SchedulerDispatchResult> => {
		signal?.throwIfAborted();
		const target = job.target;
		if (target.kind === 'reminder') {
			const delivery = target.destination
				? ((await options.remindBot({
						...target.destination,
						occurrenceId: occurrence.id,
						message: target.message,
					})) as { delivered?: boolean })
				: undefined;
			// The durable occurrence/mailbox is the inbox; an OS toast is best effort.
			try {
				if (delivery?.delivered !== false) options.notify(job.title, target.message);
			} catch {
				/* Notification permissions do not lose a reminder. */
			}
			return {
				status: 'delivered',
				message: target.destination
					? 'Reminder delivered to the bot conversation and reminder history.'
					: 'Reminder delivered to reminder history.',
				reference: target.destination?.conversationId,
			};
		}
		if (target.kind === 'bot') {
			await options.wakeBot({ ...target, occurrenceId: occurrence.id });
			return {
				status: 'admitted',
				message: 'Queued for the bot. Its reply will appear in the conversation.',
				reference: target.conversationId,
			};
		}
		const thread = await options.codeThread(target.threadId);
		if (!thread || thread.kind !== 'code' || thread.archivedAt || thread.temporary)
			throw new Error(
				'The destination Code task is missing, archived, temporary, or no longer a Code task.',
			);
		if (!options.codeReady())
			throw new SchedulerUnavailableError(
				'Waiting for this computer’s workspace to be open in FreeLM.',
			);
		let result: unknown;
		try {
			result = await options.sendCode(
				target.threadId,
				target.prompt,
				`schedule:${occurrence.id}`,
				signal,
			);
		} catch (error) {
			if (signal?.aborted) throw error;
			// Delivery can race renderer readiness. Reusing the operation identity prevents duplicate prompts.
			throw new SchedulerUnavailableError(
				error instanceof Error ? error.message : 'Code delivery is temporarily unavailable.',
			);
		}
		const delivery = result as {
			promptSaved?: boolean;
			delivery?: { status?: string; error?: string };
		};
		if (!delivery?.promptSaved)
			throw new SchedulerUnavailableError(
				delivery?.delivery?.error ?? 'The prompt is waiting for Code to accept it.',
			);
		return {
			status: 'admitted',
			message: ['started', 'queued'].includes(delivery.delivery?.status ?? '')
				? 'Prompt saved and queued in Code. This is not a completion receipt.'
				: 'Prompt saved in the Code queue. Open that task to resume or retry delivery. This is not a completion receipt.',
			reference: target.threadId,
		};
	};
}
