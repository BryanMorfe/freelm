import type { Message } from '../types';

/** Per-run input, separate from Code's durable queue. Messages already belong to history. */
export class ChatSteeringInbox {
  private messages: Message[] = [];
  private inference = new AbortController();
  ready: Promise<void> = Promise.resolve();
  get signal(): AbortSignal {
    return this.inference.signal;
  }
  get pending(): boolean {
    return this.messages.length > 0;
  }
  push(message: Message): void {
    this.messages.push(message);
    this.inference.abort();
  }
  take(): Message[] {
    const messages = this.messages.splice(0);
    this.inference = new AbortController();
    return messages;
  }
}
