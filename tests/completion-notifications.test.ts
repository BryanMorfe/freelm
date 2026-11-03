import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CompletionNotifications } from '../electron/completion-notifications';
import type { CompletionEvent } from '../src/notification-types';
import { notificationWorkspace } from '../src/lib/notification-navigation';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});
const event = (kind: 'thread' | 'bot' | 'workflow' = 'thread', runId = 'run'): CompletionEvent => ({
  destination: { hostId: 'host', workspaceId: 'local', kind, entityId: 'entity', runId },
  outcome: 'completed',
  title: 'Fixture',
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'freelm-completion-'));
  roots.push(root);
  const state = { focused: false, supported: true, enabled: true, muted: false, volume: 0.35 };
  const show = vi.fn(),
    sound = vi.fn();
  const options = {
    filename: path.join(root, 'receipts.json'),
    preferences: async () => ({
      backgroundNotifications: state.enabled,
      botResponseSound: { muted: state.muted, volume: state.volume },
    }),
    focused: () => state.focused,
    supported: () => state.supported,
    show,
    sound,
  };
  return { options, state, show, sound, service: new CompletionNotifications(options) };
}
it('submits all three entity types with generic bodies and qualified click destinations', async () => {
  const f = await fixture();
  for (const kind of ['thread', 'bot', 'workflow'] as const)
    expect(await f.service.emit(event(kind))).toBe('submitted');
  expect(f.show.mock.calls.map(([v]) => v.silent)).toEqual([false, true, false]);
  expect(f.show.mock.calls[1][0].body).toBe('A new Bot reply is ready.');
  expect(f.show.mock.calls[2][0].destination).toEqual(event('workflow').destination);
  expect(f.sound).toHaveBeenCalledTimes(1);
});
it('deduplicates concurrent producers and replay after restart without storing message contents', async () => {
  const f = await fixture();
  expect(await Promise.all(Array.from({ length: 5 }, () => f.service.emit(event('bot'))))).toEqual([
    'submitted',
    'duplicate',
    'duplicate',
    'duplicate',
    'duplicate',
  ]);
  expect(await new CompletionNotifications(f.options).emit(event('bot'))).toBe('duplicate');
  expect(f.sound).toHaveBeenCalledTimes(1);
  expect(f.show).toHaveBeenCalledTimes(1);
  const bytes = await readFile(f.options.filename, 'utf8');
  expect(bytes).not.toContain('Fixture');
  expect(bytes).not.toContain('entity');
});
it('keeps distinct runs and hosts separate even with equal entity IDs', async () => {
  const f = await fixture();
  const other = event();
  other.destination.hostId = 'other';
  other.destination.workspaceId = 'remote';
  for (const e of [event(), event('thread', 'run2'), other]) await f.service.emit(e);
  expect(f.show).toHaveBeenCalledTimes(3);
});
it('preserves foreground suppression while an opted-in Bot chime plays once', async () => {
  const f = await fixture();
  f.state.focused = true;
  expect(await f.service.emit(event('bot'))).toBe('suppressed');
  expect(f.show).not.toHaveBeenCalled();
  expect(f.sound).toHaveBeenCalledTimes(1);
  f.state.focused = false;
  expect(await f.service.emit(event('bot'))).toBe('duplicate');
});
it('master off, muted and zero volume prevent audio; no history replay when enabled later', async () => {
  const f = await fixture();
  f.state.enabled = false;
  expect(await f.service.emit(event('bot'))).toBe('suppressed');
  f.state.enabled = true;
  expect(await f.service.emit(event('bot'))).toBe('duplicate');
  f.state.muted = true;
  await f.service.emit(event('bot', 'muted'));
  f.state.muted = false;
  f.state.volume = 0;
  await f.service.emit(event('bot', 'zero'));
  expect(f.sound).not.toHaveBeenCalled();
  expect(f.show).toHaveBeenCalledTimes(2);
});
it('failures and cancelled/interrupted work stay quiet without new attention policy', async () => {
  const f = await fixture();
  for (const outcome of ['failed', 'cancelled'] as const)
    expect(await f.service.emit({ ...event('bot'), outcome })).toBe('quiet');
  expect(f.show).not.toHaveBeenCalled();
  expect(f.sound).not.toHaveBeenCalled();
});
it('records unsupported/failed submission without retrying side effects', async () => {
  const f = await fixture();
  f.state.supported = false;
  expect(await f.service.emit(event())).toBe('unsupported');
  f.state.supported = true;
  f.show.mockImplementation(() => {
    throw new Error('OS failure');
  });
  expect(await f.service.emit(event('thread', 'error'))).toBe('failed');
  expect(await f.service.emit(event('thread', 'error'))).toBe('duplicate');
  expect(f.service.diagnostics().at(-2)?.status).toBe('failed');
});
it('keeps explicit scheduled foreground alerts but still honors the sound master switch', async () => {
  const f = await fixture();
  f.state.enabled = false;
  f.state.focused = true;
  expect(await f.service.emit({ ...event('bot'), scheduled: true })).toBe('submitted');
  expect(f.sound).not.toHaveBeenCalled();
  expect(f.show.mock.calls[0][0].silent).toBe(true);
});
it('routes by exact host/profile and refuses stale, removed or changed targets', () => {
  const overview = {
    host: { instanceId: 'host', name: 'Local', port: 1, running: false },
    instances: [
      {
        id: 'remote',
        instanceId: 'other',
        name: 'Remote',
        transport: 'ssh' as const,
        connected: false,
        hasToken: true,
      },
    ],
  };
  expect(notificationWorkspace(event().destination, overview)).toBe('local');
  const remote = { ...event().destination, workspaceId: 'remote', hostId: 'other' };
  expect(notificationWorkspace(remote, overview)).toBe('remote');
  expect(() => notificationWorkspace({ ...remote, hostId: 'host' }, overview)).toThrow(
    'removed or changed',
  );
  expect(() => notificationWorkspace({ ...remote, workspaceId: 'missing' }, overview)).toThrow();
  expect(() => notificationWorkspace({ ...remote, kind: 'workflow' }, overview)).toThrow(
    'owning computer',
  );
});

it('deduplicates the same owning host reached through a different saved profile', async () => {
  const f = await fixture();
  await f.service.emit(event('bot'));
  const duplicate = event('bot');
  duplicate.destination.workspaceId = 'another-profile';
  expect(await f.service.emit(duplicate)).toBe('duplicate');
  expect(f.sound).toHaveBeenCalledTimes(1);
});
it('fails closed on damaged receipt storage without replacing it or submitting effects', async () => {
  const f = await fixture();
  await f.service.close();
  await writeFile(f.options.filename, 'invalid');
  const service = new CompletionNotifications(f.options);
  await expect(service.emit(event())).rejects.toThrow();
  expect(f.show).not.toHaveBeenCalled();
  expect(await readFile(f.options.filename, 'utf8')).toBe('invalid');
});

it('plays the enabled 100% default only when a sound preference is absent', async () => {
  const f = await fixture();
  const service = new CompletionNotifications({
    ...f.options,
    preferences: async () => ({ backgroundNotifications: true }),
  });
  await service.emit(event('bot'));
  expect(f.sound).toHaveBeenCalledExactlyOnceWith(1);
});
it('keeps an explicitly saved mute choice when the default is enabled', async () => {
  const f = await fixture();
  f.state.muted = true;
  await f.service.emit(event('bot'));
  expect(f.sound).not.toHaveBeenCalled();
});
it('the enabled default still respects the notification master preference', async () => {
  const f = await fixture();
  const service = new CompletionNotifications({
    ...f.options,
    preferences: async () => ({ backgroundNotifications: false }),
  });
  expect(await service.emit(event('bot'))).toBe('suppressed');
  expect(f.sound).not.toHaveBeenCalled();
  expect(f.show).not.toHaveBeenCalled();
});

it('plays an explicit saved 35% volume unchanged', async () => {
  const f = await fixture();
  await f.service.emit(event('bot'));
  expect(f.sound).toHaveBeenCalledExactlyOnceWith(0.35);
});

it('selects one sound after awaited preferences and deduplicates focus changes', async () => {
 const f = await fixture();
 const service = new CompletionNotifications({ ...f.options, preferences: async () => {
  f.state.focused = true;
  return { botResponseSound: { muted: false, volume: .35 } };
 }});
 await service.emit(event('bot'));
 expect(f.sound).toHaveBeenCalledExactlyOnceWith(.35, 'message');
 f.state.focused = false;
 expect(await service.emit(event('bot'))).toBe('duplicate');
 expect(f.sound).toHaveBeenCalledTimes(1);
 expect(f.show).not.toHaveBeenCalled();
});
it('coalesces intermediate and final audio across focus changes without replay', async () => {
 const f = await fixture();
 f.state.focused = true;
 await f.service.emit(event('bot', 'intermediate'));
 f.state.focused = false;
 await f.service.emit(event('bot', 'final'));
 expect(f.sound).toHaveBeenCalledExactlyOnceWith(.35, 'message');
 expect(f.show).toHaveBeenCalledTimes(1);
 expect(await f.service.emit(event('bot', 'final'))).toBe('duplicate');
});
