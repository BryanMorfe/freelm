/** A schedule belongs to the FreeLM host that owns its destination and data. */
export interface SchedulerSchedule {
	kind: 'once' | 'interval' | 'daily' | 'weekly';
	at?: string | number;
	intervalMinutes?: number;
	time?: string;
	timezone?: string;
	weekdays?: number[];
	missed?: 'skip' | 'once';
	overlap?: 'skip' | 'queue';
}

export interface SchedulerBotDestination {
	botId: string;
	conversationId: string;
	userMessageId: string;
}

export type SchedulerTarget =
	| { kind: 'reminder'; message: string; destination?: SchedulerBotDestination }
	| ({ kind: 'bot'; prompt: string } & SchedulerBotDestination)
	| { kind: 'code'; threadId: string; prompt: string };

export type SchedulerOrigin =
	{ kind: 'code'; threadId: string } | ({ kind: 'bot' } & SchedulerBotDestination);

export interface SchedulerJobInput {
	title: string;
	schedule: SchedulerSchedule;
	target: SchedulerTarget;
	/** Supplied by the host tool bridge, not by a model's scheduling arguments. */
	origin?: SchedulerOrigin;
}

export interface SchedulerJob extends SchedulerJobInput {
	id: string;
	hostId: string;
	enabled: boolean;
	createdAt: number;
	updatedAt: number;
	nextRunAt?: number;
	lastRunAt?: number;
	lastError?: string;
}

/** Admission means the destination accepted work, not that model execution finished. */
export interface SchedulerDispatchResult {
	status: 'delivered' | 'admitted';
	message?: string;
	reference?: string;
}

export type SchedulerOccurrenceStatus =
	| 'pending'
	| 'dispatching'
	| 'waiting'
	| 'delivered'
	| 'admitted'
	| 'failed'
	| 'cancelled'
	| 'dismissed';

export interface SchedulerOccurrence {
	id: string;
	jobId: string;
	hostId: string;
	scheduledAt: number;
	kind: 'scheduled' | 'manual';
	status: SchedulerOccurrenceStatus;
	attempts: number;
	createdAt: number;
	updatedAt: number;
	retryAt?: number;
	error?: string;
	/** Enables resume to distinguish paused delivery from edits, deletion, or dismissal. */
	cancellationReason?: 'paused' | 'deleted' | 'edited';
	result?: SchedulerDispatchResult;
	/** Frozen dispatch authority: editing a job never rewrites previously admitted work. */
	jobSnapshot: SchedulerJob;
}

export interface SchedulerSnapshot {
	jobs: SchedulerJob[];
	occurrences: SchedulerOccurrence[];
}

export type SchedulerCommand =
	| { type: 'create'; job: SchedulerJobInput; idempotencyKey?: string }
	| {
			type: 'update';
			id: string;
			patch: Partial<Pick<SchedulerJobInput, 'title' | 'schedule' | 'target'>>;
	  }
	| { type: 'pause' | 'resume' | 'delete'; id: string }
	| { type: 'run-now'; id: string; idempotencyKey?: string }
	/** Adds a one-time delivery without moving a recurring schedule's cadence. */
	| { type: 'snooze'; id: string; until: number; occurrenceId?: string }
	| { type: 'retry'; occurrenceId: string }
	| { type: 'dismiss'; occurrenceId: string };

export interface SchedulerCommandResult extends SchedulerSnapshot {
	jobId?: string;
	occurrenceId?: string;
}

export interface SchedulerBridge {
	schedulerSnapshot(): Promise<SchedulerSnapshot>;
	schedulerCommand(command: SchedulerCommand): Promise<SchedulerCommandResult>;
	onSchedulerChanged(listener: () => void): () => void;
}
