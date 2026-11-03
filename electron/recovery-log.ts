import { appendFile, mkdir, stat, rename } from 'node:fs/promises';
import path from 'node:path';

/** Bounded native diagnostics; never accepts prompts, credentials, URLs or worker payloads. */
export function recoveryLog(directory: string) {
  let writes = Promise.resolve();
  return (
    component: string,
    event: string,
    detail: { reason?: string; exitCode?: number } = {},
  ) => {
    const token = (value: string) => (/^[a-zA-Z0-9_. -]{1,80}$/.test(value) ? value : 'unknown');
    const line =
      JSON.stringify({
        time: new Date().toISOString(),
        component: token(component),
        event: token(event),
        ...(detail.reason ? { reason: token(detail.reason) } : {}),
        ...(Number.isInteger(detail.exitCode) ? { exitCode: detail.exitCode } : {}),
      }) + '\n';
    console.error('[FreeLM recovery]', line.trim());
    writes = writes
      .then(async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const file = path.join(directory, 'recovery.jsonl');
        if (
          await stat(file).then(
            (s) => s.size > 64 * 1024,
            () => false,
          )
        ) {
          await rename(file, path.join(directory, 'recovery.previous.jsonl'));
        }
        await appendFile(file, line, { mode: 0o600 });
      })
      .catch(() => {
        /* Diagnostic disk failure must not break recovery. */
      });
    return writes;
  };
}
