import { it, expect, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { recoveryLog } from '../electron/recovery-log';
it('rotates native diagnostics and excludes arbitrary error payloads and credentials', async () => {
 const folder=await mkdtemp(path.join(os.tmpdir(),'freelm-recovery-log-'));const quiet=vi.spyOn(console,'error').mockImplementation(()=>{});
 try {
  await writeFile(path.join(folder,'recovery.jsonl'),'x'.repeat(65537),{mode:0o600});
  const log=recoveryLog(folder);await log('renderer','renderer-gone',{reason:'https://secret.invalid/?token=private',exitCode:5});
  const entries=(await readFile(path.join(folder,'recovery.jsonl'),'utf8')).trim().split('\n').map(s=>JSON.parse(s));
  expect(entries[0]).toMatchObject({component:'renderer',event:'renderer-gone',reason:'unknown',exitCode:5});
  expect(JSON.stringify(entries)).not.toContain('secret');
  expect((await stat(path.join(folder,'recovery.previous.jsonl'))).size).toBe(65537);
  if(process.platform!=='win32')expect((await stat(path.join(folder,'recovery.jsonl'))).mode&0o777).toBe(0o600);
 } finally {quiet.mockRestore();await rm(folder,{recursive:true,force:true});}
});
