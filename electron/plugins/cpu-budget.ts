import { performance } from 'node:perf_hooks';

interface BudgetClock { wall(): number; cpu(): number }

function workerClock(): BudgetClock {
	// Node 24 in packaged Electron supports thread CPU accounting. Never use
	// process.cpuUsage(): it also charges this guest for unrelated app workers.
	if (typeof process.threadCpuUsage === 'function') {
		return { wall: () => performance.now(), cpu: () => {
			const usage = process.threadCpuUsage();
			return (usage.user + usage.system) / 1000;
		} };
	}
	// Older development Node versions retain a monotonic wall deadline.
	return { wall: () => performance.now(), cpu: () => performance.now() };
}

/** Counts only synchronous interpreter execution; idle and host I/O are excluded. */
export class PluginCpuBudget {
	private started = 0;
	private cpuStarted = 0;
	private used = 0;
	private windowStart: number;
	constructor(private sliceMs: number, private clock: BudgetClock = workerClock()) {
		this.windowStart = clock.wall();
	}
	begin() {
		this.started = this.clock.wall();
		if (this.started - this.windowStart >= 10_000) { this.used = 0; this.windowStart = this.started; }
		this.cpuStarted = this.clock.cpu();
	}
	exceeded(): boolean {
		const elapsed = Math.max(0, this.clock.cpu() - this.cpuStarted);
		return elapsed > this.sliceMs || this.used + elapsed > 2000 || this.clock.wall() - this.started > 5000;
	}
	end() { this.used += Math.max(0, this.clock.cpu() - this.cpuStarted); }
}
