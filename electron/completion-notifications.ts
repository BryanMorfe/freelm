import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { atomicWrite, jsonPayload } from './json-file';
import {
  defaultBotResponseSound,
  type BotResponseSound,
  type CompletionEvent,
  type NotificationDestination,
  validNotificationDestination,
} from '../src/notification-types';
export interface CompletionNotificationOptions {
  filename: string;
  preferences(): Promise<{
    backgroundNotifications?: boolean;
    botResponseSound?: BotResponseSound;
  }>;
  focused(): boolean;
  supported(): boolean;
  show(input: {
    title: string;
    body: string;
    silent: boolean;
    destination: NotificationDestination;
  }): void;
  sound(volume: number, kind?: 'message'): void;
}
export type CompletionDisposition =
  'duplicate' | 'quiet' | 'suppressed' | 'unsupported' | 'submitted' | 'failed';
/** Reserve before external effects: at-most-once submission, never claim OS/user receipt. */
export class CompletionNotifications {
  private receipts: string[] = [];
  private lastMessageSound = -Infinity;
  private ready: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private recent: { key: string; status: CompletionDisposition }[] = [];
  constructor(private readonly options: CompletionNotificationOptions) {
    this.ready = this.load();
    void this.ready.catch(() => {});
  }
  private async load() {
    try {
      const value = JSON.parse(await readFile(this.options.filename, 'utf8'));
      if (
        value.version !== 1 ||
        !Array.isArray(value.receipts) ||
        value.receipts.length > 10000 ||
        !value.receipts.every((x: unknown) => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x))
      )
        throw new Error('Invalid completion notification receipts.');
      this.receipts = value.receipts;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
				console.error('Resetting corrupted completion notification receipts:', e);
				this.receipts = [];
			}
		}
  }
  diagnostics() {
    return this.recent.map((x) => ({ ...x }));
  }
  emit(event: CompletionEvent): Promise<CompletionDisposition> {
    const work = this.queue.then(() => this.deliver(event));
    this.queue = work.catch(() => {});
    return work;
  }
  private async deliver(event: CompletionEvent): Promise<CompletionDisposition> {
    await this.ready;
    if (
      !validNotificationDestination(event.destination) ||
      !['completed', 'failed', 'cancelled'].includes(event.outcome) ||
      typeof event.title !== 'string'
    )
      throw new Error('Invalid completion notification.');
    const d = event.destination;
    const key = createHash('sha256')
      .update(JSON.stringify([d.hostId, d.kind, d.entityId, d.runId, event.outcome]))
      .digest('hex');
    const finish = (status: CompletionDisposition) => {
      this.recent = [...this.recent.slice(-19), { key, status }];
      return status;
    };
    if (this.receipts.includes(key)) return finish('duplicate');
    const prefs = await this.options.preferences();
    const receipts = [...this.receipts.slice(-9999), key];
    await atomicWrite(this.options.filename, jsonPayload({ version: 1, receipts }));
    this.receipts = receipts;
    if (event.outcome !== 'completed') return finish('quiet');
    const enabled = prefs.backgroundNotifications !== false;
    if (!enabled && !event.scheduled) return finish('suppressed');
    // Decide once, after persistence and preferences: a message has one sound route.
    const focused = this.options.focused();
    const sound = prefs.botResponseSound ?? defaultBotResponseSound;
    if (d.kind === 'bot' && enabled && !sound.muted && sound.volume > 0) {
      try {
        const now = performance.now();
        if (now - this.lastMessageSound >= 750) {
          this.lastMessageSound = now;
          if (focused) this.options.sound(sound.volume, 'message');
          else this.options.sound(sound.volume);
        }
      } catch {
        /* A failed sound never fails saved work or replays it. */
      }
    }
    if (focused && !event.scheduled) return finish('suppressed');
    if (!this.options.supported()) return finish('unsupported');
    try {
      this.options.show({
        title: `FreeLM · ${event.title.slice(0, 160)}`,
        body:
          d.kind === 'thread'
            ? 'Your reply is ready.'
            : d.kind === 'bot'
              ? 'A new Bot reply is ready.'
              : 'Your workflow is complete.',
        silent: d.kind === 'bot',
        destination: { ...d },
      });
      return finish('submitted');
    } catch {
      return finish('failed');
    }
  }
  async close() {
    await this.queue;
  }
}
