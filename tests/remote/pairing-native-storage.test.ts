import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes, webcrypto } from 'node:crypto';
import 'reflect-metadata';
import * as x509 from '@peculiar/x509';
import { NativePairingSecureStore } from '../../electron/pairing/secure-store';
import { LocalEnrollment } from '../../electron/pairing/enrollment';

const binary = process.env.FREELM_PAIRING_TEST_HELPER;
it.skipIf(!binary)(
  'persists issuer/approval in an isolated native Keychain, enforces CAS, and preserves system search/default settings',
  async () => {
    const search = () =>
      execFileSync('/usr/bin/security', ['list-keychains', '-d', 'user'], { encoding: 'utf8' });
    const current = () =>
      execFileSync('/usr/bin/security', ['default-keychain', '-d', 'user'], { encoding: 'utf8' });
    const beforeSearch = search(),
      beforeDefault = current();
    const directory = await mkdtemp(path.join(tmpdir(), 'freelm-enrollment-'));
    const keychain = path.join(directory, 'vault.keychain');
    try {
      execFileSync(binary!, ['--isolated-keychain', keychain], {
        input: JSON.stringify({
          operation: 'initialize-test-keychain',
          password: randomBytes(32).toString('hex'),
        }),
      });
      expect(() => new NativePairingSecureStore(binary!, '')).toThrow();
      const store = new NativePairingSecureStore(binary!, keychain);
      expect(await store.read()).toBeNull();
      const service = new LocalEnrollment(store);
      await service.initialize();
      const original = await store.read();
      expect(original).not.toBeNull();
      const invite = await service.invite('https://localhost');
      expect((await store.read()) === original).toBe(false);
      await expect(store.replace(original!, '{}')).rejects.toThrow();
      const crypto = webcrypto as unknown as Crypto;
      const algorithm = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
      const keys = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
      const csr = await x509.Pkcs10CertificateRequestGenerator.create(
        { name: 'CN=Test phone', keys, signingAlgorithm: algorithm },
        crypto,
      );
      const pending = await service.request(
        invite.invitationId,
        invite.secret,
        csr.toString('pem'),
      );
      const restarted = new LocalEnrollment(new NativePairingSecureStore(binary!, keychain));
      const certificate = await restarted.approve(pending.requestId, pending.keyHash);
      expect(certificate).toContain('BEGIN CERTIFICATE');
      await expect(
        restarted.request(invite.invitationId, invite.secret, csr.toString('pem')),
      ).rejects.toThrow();
      await restarted.deny(pending.requestId);
      await expect(
        new LocalEnrollment(store).approve(pending.requestId, pending.keyHash),
      ).rejects.toThrow();
      const raw = await store.read();
      const outcomes = await Promise.allSettled([
        store.replace(raw!, raw! + ' '),
        store.replace(raw!, raw! + '\n'),
      ]);
      expect(outcomes.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      // Production access must fail before touching storage for this unsigned test caller.
      await expect(new NativePairingSecureStore(binary!).read()).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
      expect(search()).toBe(beforeSearch);
      expect(current()).toBe(beforeDefault);
    }
  },
  30000,
);
