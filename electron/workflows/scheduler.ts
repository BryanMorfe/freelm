import type {
	WorkflowDefinition,
	WorkflowNode,
	WorkflowRun,
	WorkflowTrigger,
} from '../../src/workflow-types';
import { WorkflowStore } from './store';

import type { SchedulerSchedule } from '../../src/scheduler-types';
import { dateValue, validateSchedule, nextScheduleAt } from '../scheduler/recurrence';
export { validateSchedule, nextScheduleAt } from '../scheduler/recurrence';
export type WorkflowSchedule = SchedulerSchedule;

export function scheduleConfig(node: WorkflowNode): WorkflowSchedule {
	return (node.config.schedule && typeof node.config.schedule === 'object'
		? node.config.schedule
		: node.config) as unknown as WorkflowSchedule;
}
export interface WorkflowSchedulerOptions {
	store: WorkflowStore;
	workflows: () => WorkflowDefinition[];
	runs: () => WorkflowRun[];
	start: (
		workflowId: string,
		options: { trigger: WorkflowTrigger; overlap?: 'skip' | 'queue' },
		definition: WorkflowDefinition,
		definitions: WorkflowDefinition[],
	) => Promise<unknown>;
	now?: () => number;
	onError?: (error: unknown) => void;
}
export class WorkflowScheduler {
	private timer?: ReturnType<typeof setInterval>;
	private ticking?: Promise<void>;
	private closed = false;
	constructor(private readonly options: WorkflowSchedulerOptions) {}
	start(): void {
		if (this.timer || this.closed) return;
		this.timer = setInterval(() => {
			void this.tick().catch((error) => this.options.onError?.(error));
		}, 1000);
		this.timer.unref?.();
		void this.tick().catch((error) => this.options.onError?.(error));
	}
	tick(now = this.options.now?.() ?? Date.now()): Promise<void> {
		if (this.closed) return Promise.resolve();
		if (this.ticking) return this.ticking;
		this.ticking = this.check(now).finally(() => {
			this.ticking = undefined;
		});
		return this.ticking;
	}
	private async check(now: number): Promise<void> {
		const definitions = this.options.workflows();
		for (const workflow of definitions) {
			if (!workflow.enabled) continue;
			for (const node of workflow.nodes.filter((node) => node.type === 'schedule')) {
				try {
					const schedule = scheduleConfig(node);
					validateSchedule(schedule);
					const key = `${workflow.id}:${node.id}`,
						fingerprint = JSON.stringify(schedule);
					let cursor = this.options.store.getSchedule(key);
					if (!cursor || cursor.fingerprint !== fingerprint) {
						const initial =
							schedule.kind === 'once' ? dateValue(schedule.at) : nextScheduleAt(schedule, now);
						cursor = { fingerprint, nextAt: initial };
						await this.options.store.setSchedule(key, cursor);
					}
					if (cursor.nextAt === undefined || cursor.nextAt > now) continue;
					const due = cursor.nextAt;
					// A one-minute grace accepts ordinary timer jitter; larger gaps are missed occurrences.
					const missed = now - due >= 60_000;
					if (!missed || schedule.missed === 'once') {
						const busy = this.options
							.runs()
							.some(
								(run) =>
									run.workflowId === workflow.id &&
									['running', 'waiting', 'queued'].includes(run.status),
							);
						if (!busy || schedule.overlap === 'queue') {
							// start persists this key with the run before the cursor moves. Crash retries deduplicate it.
							await this.options.start(workflow.id, {
								overlap: schedule.overlap,
								trigger: {
									kind: 'schedule',
									nodeId: node.id,
									key: `${key}:${due}`,
									payload: { scheduledAt: due },
								},
								}, workflow, definitions);
						}
					}
					const nextAt =
						schedule.kind === 'interval'
							? nextScheduleAt({ ...schedule, at: due }, now)
							: nextScheduleAt(schedule, now);
					await this.options.store.setSchedule(key, { fingerprint, lastAt: due, nextAt });
				} catch (error) {
					// A broken schedule must not prevent other workflows from being checked.
					this.options.onError?.(error);
				}
			}
		}
	}
	async dispose(): Promise<void> {
		this.closed = true;
		if (this.timer) clearInterval(this.timer);
		await this.ticking;
	}
}
