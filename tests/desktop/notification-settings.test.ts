import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { StateStore } from '../../electron/state-store';
import { initialState } from '../../src/lib/state';
import { validateState } from '../../electron/validation';
import { createWorkspacePatch, applyWorkspacePatch } from '../../src/workspace-patch';
import { defaultBotResponseSound } from '../../src/notification-types';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});
it('defaults missing preferences on while preserving saved mute and config-only storage', async () => {
  const before = initialState();
  expect(before.botResponseSound).toBeUndefined();
  expect(defaultBotResponseSound).toEqual({ muted: false, volume: 1 });
  const root = await mkdtemp(path.join(os.tmpdir(), 'freelm-sound-'));
  roots.push(root);
  const filename = path.join(root, 'workspace.json'),
    config = path.join(root, 'config.json');
  const secrets = {
    available: () => false,
    encrypt: () => {
      throw new Error('unused');
    },
    decrypt: () => {
      throw new Error('unused');
    },
  };
  await new StateStore(filename, secrets, config).save(before);
  const legacy = await new StateStore(filename, secrets, config).load();
  expect(legacy?.botResponseSound).toBeUndefined();
  expect(legacy?.botResponseSound ?? defaultBotResponseSound).toEqual({
    muted: false,
    volume: 1,
  });
  for (const preference of [
    { muted: false, volume: 0.35 },
    { muted: false, volume: 0 },
    { muted: true, volume: 0.35 },
  ]) {
    await new StateStore(filename, secrets, config).save({
      ...before,
      botResponseSound: preference,
    });
    expect((await new StateStore(filename, secrets, config).load())?.botResponseSound).toEqual(
      preference,
    );
  }
  const after = { ...before, botResponseSound: { muted: true, volume: 0.25 } };
  validateState(after);
  expect(applyWorkspacePatch(before, createWorkspacePatch(before, after))).toEqual(after);
  await new StateStore(filename, secrets, config).save(after);
  expect((await new StateStore(filename, secrets, config).load())?.botResponseSound).toEqual(
    after.botResponseSound,
  );
  expect(JSON.parse(await readFile(filename, 'utf8'))).not.toHaveProperty('botResponseSound');
  for (const value of [
    { muted: false, volume: 2 },
    { muted: 'no', volume: 0.3 },
    { muted: false, volume: NaN },
    { muted: false, volume: 0.3, other: 1 },
  ])
    expect(() => validateState({ ...before, botResponseSound: value })).toThrow();
});
