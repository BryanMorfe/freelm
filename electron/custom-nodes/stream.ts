/** Bounded incremental byte redaction keeps credentials split across network chunks private. */
export class ByteRedactor {
  private pending = Buffer.alloc(0);
  private patterns: Buffer[];
  constructor(secret: string) {
    this.patterns = [...new Set(secret ? [secret, encodeURIComponent(secret)] : [])].map((s) =>
      Buffer.from(s),
    );
  }
  push(bytes: Uint8Array, final = false): Buffer {
    if (!this.patterns.length) return Buffer.from(bytes);
    const input = Buffer.concat([this.pending, Buffer.from(bytes)]);
    const tail = final ? 0 : Math.max(0, ...this.patterns.map((p) => p.length - 1));
    const limit = Math.max(0, input.length - tail);
    const output: Buffer[] = [];
    let cursor = 0;
    while (cursor < limit) {
      let at = -1,
        matched: Buffer | undefined;
      for (const pattern of this.patterns) {
        const next = input.indexOf(pattern, cursor);
        if (next >= 0 && next < limit && (at < 0 || next < at)) {
          at = next;
          matched = pattern;
        }
      }
      if (at < 0) {
        output.push(input.subarray(cursor, limit));
        cursor = limit;
        break;
      }
      if (at > cursor) output.push(input.subarray(cursor, at));
      output.push(Buffer.from('[redacted]'));
      cursor = at + matched!.length;
    }
    this.pending = Buffer.from(input.subarray(cursor));
    return Buffer.concat(output);
  }
}
export interface NodeStream {
  owner: string;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  signal: AbortSignal;
  redactor: ByteRedactor;
  decoder: TextDecoder;
  format: 'text' | 'base64';
  bytes: number;
  pending: Buffer;
  reading: boolean;
  cleanup: () => void;
}
export const TRANSFER_LIMIT = 64 * 1024 * 1024;
export const STREAM_CHUNK = 48 * 1024;
