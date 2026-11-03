import { afterEach, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProviderSession } from '../electron/plugins/provider-session';

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
it('rejects crashed provider work once, releases worker slots and allows a fresh explicit session without replay', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'freelm-provider-recovery-'));
  folders.push(dir);
  const crash = path.join(dir, 'crash.cjs'),
    healthy = path.join(dir, 'healthy.cjs');
  await writeFile(crash, 'process.exit(7)');
  await writeFile(
    healthy,
    `const {parentPort}=require('node:worker_threads');let count=0;parentPort.on('message',m=>parentPort.postMessage({id:m.id,json:JSON.stringify({input:JSON.parse(m.json),count:++count})}));parentPort.postMessage({ready:true});`,
  );
  for (let i = 0; i < 10; i++) {
    const session = createProviderSession('', 'fixture', new AbortController().signal, crash);
    await expect(session.transform({ operation: 'must not replay' })).rejects.toThrow(
      'Provider worker exited',
    );
    await expect(session.transform({ operation: 'retry' })).rejects.toThrow('unavailable');
    session.close();
  }
  const ctl = new AbortController();
  const fresh = createProviderSession('', 'fixture', ctl.signal, healthy);
  expect(await fresh.transform({ operation: 'explicit new operation' })).toEqual({
    input: { operation: 'explicit new operation' },
    count: 1,
  });
  ctl.abort();
  await expect(fresh.transform({})).rejects.toThrow('unavailable');
  fresh.close();
});
