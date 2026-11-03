import { afterEach, describe, expect, it, vi } from 'vitest';
import { CrashBudget, RendererRecovery } from '../electron/recovery';

afterEach(() => vi.useRealTimers());
function fixture(overrides: Partial<ConstructorParameters<typeof RendererRecovery>[0]> = {}) {
  vi.useFakeTimers();
  const cleanup = vi.fn(async () => {}),
    reload = vi.fn(async () => {}),
    fallback = vi.fn(),
    log = vi.fn();
  const recovery = new RendererRecovery({
    budget: new CrashBudget(),
    cleanup,
    reload,
    fallback,
    log,
    ...overrides,
  });
  return { recovery, cleanup, reload, fallback, log };
}
describe('renderer crash recovery', () => {
  it('awaits durable cleanup before backoff, coalesces duplicate failures and reloads once', async () => {
    let settle!: () => void;
    const f = fixture({
      cleanup: () =>
        new Promise<void>((r) => {
          settle = r;
        }),
    });
    f.recovery.failed({ reason: 'oom', exitCode: 5 });
    f.recovery.failed({ reason: 'crashed' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.reload).not.toHaveBeenCalled();
    settle();
    await vi.advanceTimersByTimeAsync(499);
    expect(f.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.reload).toHaveBeenCalledTimes(1);
    f.recovery.loaded();
    f.recovery.dispose();
  });
  it('cuts off the third crash even when every reload finishes, and manual retry retains the budget', async () => {
    const f = fixture();
    for (let i = 0; i < 3; i++) {
      f.recovery.failed({ reason: 'killed' });
      await vi.advanceTimersByTimeAsync(2500);
      f.recovery.loaded();
    }
    expect(f.reload).toHaveBeenCalledTimes(2);
    expect(f.cleanup).toHaveBeenCalledTimes(3);
    expect(f.fallback).toHaveBeenLastCalledWith('crash-loop');
    f.recovery.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.reload).toHaveBeenCalledTimes(3);
    f.recovery.failed({ reason: 'crashed' });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.fallback).toHaveBeenCalledTimes(2);
    expect(f.reload).toHaveBeenCalledTimes(3);
    f.recovery.dispose();
  });
  it('allows automatic recovery again after a stable two-minute interval', () => {
    let now = 0;
    const b = new CrashBudget([1, 2], 120000, () => now);
    expect([b.next(), b.next(), b.next()]).toEqual([1, 2, undefined]);
    now = 120001;
    expect(b.next()).toBe(1);
  });
  it('does not reload after cleanup rejects or times out', async () => {
    const f = fixture({
      cleanup: async () => {
        throw Error('disk full');
      },
    });
    f.recovery.failed({ reason: 'crashed' });
    await vi.advanceTimersByTimeAsync(20000);
    expect(f.fallback).toHaveBeenCalledWith('cleanup-failed');
    expect(f.reload).not.toHaveBeenCalled();
    f.recovery.dispose();
    const g = fixture({ cleanup: () => new Promise(() => {}) });
    g.recovery.failed({ reason: 'crashed' });
    await vi.advanceTimersByTimeAsync(15000);
    expect(g.fallback).toHaveBeenCalledWith('cleanup-failed');
    expect(g.reload).not.toHaveBeenCalled();
    g.recovery.dispose();
  });
  it('cancels pending backoff and late cleanup on window close', async () => {
    const f = fixture();
    f.recovery.failed({ reason: 'crashed' });
    await vi.advanceTimersByTimeAsync(100);
    f.recovery.dispose();
    await vi.advanceTimersByTimeAsync(30000);
    expect(f.reload).not.toHaveBeenCalled();
    let settle!: () => void;
    const g = fixture({
      cleanup: () =>
        new Promise<void>((r) => {
          settle = r;
        }),
    });
    g.recovery.failed({ reason: 'crashed' });
    g.recovery.dispose();
    settle();
    await vi.advanceTimersByTimeAsync(30000);
    expect(g.reload).not.toHaveBeenCalled();
    expect(g.fallback).not.toHaveBeenCalled();
  });
  it('bounds failures and timeouts while reloading; a loaded page cancels the watchdog', async () => {
    const f = fixture({
      reload: async () => {
        throw Error('missing file');
      },
    });
    f.recovery.failed({ reason: 'crashed' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.fallback).toHaveBeenCalledWith('crash-loop');
    f.recovery.dispose();
    const g = fixture();
    g.recovery.failed({ reason: 'crashed' });
    await vi.advanceTimersByTimeAsync(500);
    g.recovery.loaded();
    await vi.advanceTimersByTimeAsync(35000);
    expect(g.reload).toHaveBeenCalledTimes(1);
    expect(g.fallback).not.toHaveBeenCalled();
    g.recovery.dispose();
  });
});
