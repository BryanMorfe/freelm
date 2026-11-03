import { it, expect } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CustomNodeServices } from '../electron/custom-nodes/services';
import type { InstalledCustomNode } from '../src/custom-node-types';
const node: InstalledCustomNode = {
  digest: 'a'.repeat(64),
  manifest: {
    id: 'remote',
    version: '1.0.0',
    title: 'Remote',
    description: 'Synthetic',
    inputs: [],
    outputs: [],
    fields: [],
    permissions: { network: ['https://synthetic.test'], inference: true },
  },
};
// Fake vault is test-only; production uses OS safeStorage and never plaintext fallback.
const vault = {
  available: async () => true,
  encrypt: (v: string) => Buffer.from(v.split('').reverse().join('')),
  decrypt: async (v: Buffer) => v.toString().split('').reverse().join(''),
};
it('requires explicit grants, binds secret origin, redacts echo, and persists only encrypted material', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'freelm-node-services-'));
  let calls = 0;
  try {
    const svc = new CustomNodeServices(
      root,
      vault,
      async () => ({ text: 'fixture' }),
      async (_url, init) => {
        calls++;
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer synthetic-secret');
        expect(init?.redirect).toBe('manual');
        return new Response('echo synthetic-secret', {
          headers: { 'set-cookie': 'synthetic-secret' },
        });
      },
    );
    await svc.init();
    const signal = new AbortController().signal;
    await expect(
      svc.request('remote', node.digest, { url: 'https://synthetic.test' }, signal),
    ).rejects.toThrow('authorized');
    await svc.authorize(node, ['https://synthetic.test'], true);
    await svc.setSecret(node, 'token', 'synthetic-secret', 'https://synthetic.test');
    const result = await svc.request(
      'remote',
      node.digest,
      { url: 'https://synthetic.test', secret: { secretRef: 'token' } },
      signal,
    );
    expect(JSON.stringify(result)).not.toContain('synthetic-secret');
    expect(calls).toBe(1);
    expect(await svc.inference('remote', node.digest, {}, signal)).toEqual({ text: 'fixture' });
    await expect(
      svc.request(
        'remote',
        node.digest,
        { url: 'https://elsewhere.test', secret: { secretRef: 'token' } },
        signal,
      ),
    ).rejects.toThrow('authorized');
    expect(JSON.stringify(svc.metadata(node))).not.toContain('synthetic-secret');
    expect(await readFile(path.join(root, 'authority.json'), 'utf8')).not.toContain(
      'synthetic-secret',
    );
    await svc.authorize(node, [], false);
    await expect(svc.inference('remote', node.digest, {}, signal)).rejects.toThrow('authorized');
    const restored = new CustomNodeServices(root, vault, async () => null);
    await restored.init();
    expect(restored.metadata(node).grants).toEqual({ network: [], inference: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('blocks redirects and cancels active network when grants are revoked', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'freelm-node-services-'));
  try {
    const controller = new AbortController();
    const svc = new CustomNodeServices(
      root,
      vault,
      async () => null,
      async () =>
        new Response('', { status: 302, headers: { location: 'https://elsewhere.test' } }),
    );
    await svc.init();
    await svc.authorize(node, ['https://synthetic.test'], false);
    await expect(
      svc.request('remote', node.digest, { url: 'https://synthetic.test' }, controller.signal),
    ).rejects.toThrow('redirected');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
