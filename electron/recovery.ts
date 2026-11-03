/** A rolling crash budget is deliberately not reset by a successful page load. */
export class CrashBudget {
  private crashes: number[] = [];
  constructor(
    private readonly delays = [500, 2000],
    private readonly windowMs = 120_000,
    private readonly now = Date.now,
  ) {}
  next(): number | undefined {
    const now = this.now();
    this.crashes = this.crashes.filter((time) => now - time < this.windowMs);
    this.crashes.push(now);
    return this.delays[this.crashes.length - 1];
  }
}

export interface RecoveryFailure {
  reason: string;
  exitCode?: number;
}
interface RecoveryOptions {
  budget: CrashBudget;
  cleanup(): Promise<void>;
  reload(): Promise<unknown>;
  fallback(reason: string): void;
  log(event: string, failure: RecoveryFailure): void;
  cleanupTimeoutMs?: number;
  loadTimeoutMs?: number;
}

/** Owns only a replaceable renderer. Never recreates the host or replays an operation. */
export class RendererRecovery {
  private epoch = 0;
  private stopped = false;
  private pending = false;
  private timer?: ReturnType<typeof setTimeout>;
  private watchdog?: ReturnType<typeof setTimeout>;
  constructor(private readonly options: RecoveryOptions) {}
  failed(failure: RecoveryFailure) {
    if (this.stopped || this.pending) return;
    this.pending = true;
    const epoch = ++this.epoch;
    clearTimeout(this.watchdog);
    this.options.log('renderer-gone', failure);
    const delay = this.options.budget.next();
    void this.prepare(epoch, delay, failure);
  }
  private async prepare(
    epoch: number,
    delay: number | undefined,
    failure: RecoveryFailure,
    manual = false,
  ) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.options.cleanup(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('cleanup-timeout')),
            this.options.cleanupTimeoutMs ?? 15_000,
          );
        }),
      ]);
    } catch {
      if (!this.stopped && epoch === this.epoch) this.cutoff('cleanup-failed', failure);
      return;
    } finally {
      clearTimeout(timeout);
    }
    if (this.stopped || epoch !== this.epoch) return;
    if (delay === undefined) return this.cutoff('crash-loop', failure);
    this.options.log(manual ? 'renderer-manual-reload' : 'renderer-reload-scheduled', failure);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.stopped || epoch !== this.epoch) return;
      this.pending = false;
      this.watchdog = setTimeout(
        () => this.failed({ reason: 'load-timeout' }),
        this.options.loadTimeoutMs ?? 30_000,
      );
      void this.options.reload().catch(() => this.failed({ reason: 'load-failed' }));
    }, delay);
  }
  private cutoff(reason: string, failure: RecoveryFailure) {
    this.options.log(reason, failure);
    this.options.fallback(reason);
  }
  loaded() {
    if (this.watchdog) this.options.log('renderer-restored', { reason: 'loaded' });
    clearTimeout(this.watchdog);
    this.watchdog = undefined;
  }
  /** A deliberate user retry retains the budget, so it cannot restart an automatic crash loop. */
  retry() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    clearTimeout(this.watchdog);
    this.pending = true;
    void this.prepare(++this.epoch, 0, { reason: 'manual-retry' }, true);
  }
  dispose() {
    this.stopped = true;
    this.epoch++;
    clearTimeout(this.timer);
    clearTimeout(this.watchdog);
  }
}
