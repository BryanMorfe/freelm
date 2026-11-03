import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { request } from 'node:https';
import { MobileListener } from '../../electron/mobile-listener';
import { MobileAccess } from '../../electron/mobile-access';

it('restricts disposable TLS listener to scoped paths, validates host, and requires certificate trust', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'freelm-mobile-tls-'));
  const listener = new MobileListener();
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
      ],
      { stdio: 'ignore' },
    );
    const [cert, key] = await Promise.all([
      readFile(join(dir, 'cert.pem'), 'utf8'),
      readFile(join(dir, 'key.pem'), 'utf8'),
    ]);
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as { port: number }).port;
        server.close(() => resolve(port));
      });
    });
    const endpoint = `https://127.0.0.1:${port}`;
    expect(listener.enabled).toBe(false);
    await expect(
      listener.start(
        { cert, key, endpoint: `https://wrong.example:${port}`, bindAddress: '127.0.0.1' },
        async () => {},
      ),
    ).rejects.toThrow();
    await listener.start({ cert, key, endpoint, bindAddress: '127.0.0.1' }, async (_req, res) => {
      res.end('scoped');
    });
    expect(listener.certificateSHA256).toMatch(/^[a-f0-9]{64}$/);
    const call = (path: string, trust = true, host?: string) =>
      new Promise<number>((resolve, reject) => {
        const req = request(
          endpoint + path,
          { ...(trust ? { ca: cert } : {}), headers: host ? { Host: host } : {} },
          (res) => {
            res.resume();
            resolve(res.statusCode!);
          },
        );
        req.on('error', reject);
        req.end();
      });
    await expect(call('/mobile/snapshot', false)).rejects.toThrow();
    expect(await call('/mobile/snapshot')).toBe(200);
    await expect(call('/mobile/snapshot', true, 'attacker.example')).rejects.toThrow();
    expect(await call('/mobile/snapshot', true, `localhost:${port}`)).toBe(403);
    for (const path of ['/info', '/bots', '/mobile/invitations', '/mobile/revoke', '/mobile/tasks'])
      expect(await call(path)).toBe(403);
    await listener.stop();
    expect(listener.enabled).toBe(false);
  } finally {
    await listener.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

it('bounds pairing to one invitation and one session with restart revocation', () => {
  const access = new MobileAccess();
  const first = access.invite();
  expect(() => access.invite()).toThrow();
  const grant = access.exchange(first.id, first.secret);
  const next = access.invite();
  expect(() => access.exchange(next.id, next.secret)).toThrow();
  expect(access.status().sessions).toHaveLength(1);
  expect(JSON.stringify(access.status())).not.toContain(grant.token);
  access.clear();
  expect(access.authorize(grant.token)).toBeUndefined();
  expect(() => access.exchange(next.id, next.secret)).toThrow();
});
