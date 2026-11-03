import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import iroh from '@number0/iroh';
const { SecretKey, Signature } = iroh;

// No Endpoint, discovery, relay or service API is invoked in this offline suite.
test('Swift/Node Ed25519 identity and signatures interoperate across process restart', () => {
  const key = SecretKey.generate();
  const message = [...Buffer.from('FreeLM isolated Iroh identity proof v1')];
  const dir = mkdtempSync(join(tmpdir(), 'freelm-iroh-offline-'));
  try {
    const seedPath = join(dir, 'synthetic-seed.json');
    writeFileSync(seedPath, JSON.stringify(key.toBytes()), { mode: 0o600 });
    for (let restart = 0; restart < 2; restart++) {
      const result = spawnSync('.build/debug/IrohProbe', [], {
        input: JSON.stringify({ seed: JSON.parse(readFileSync(seedPath)), message, signature: key.sign(message).toBytes() }),
        encoding: 'utf8', timeout: 10000,
      });
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.verified, true);
      assert.deepEqual(output.publicKey, key.public().toBytes());
      key.public().verify(message, Signature.fromBytes(output.signature));
      assert.throws(() => SecretKey.generate().public().verify(message, Signature.fromBytes(output.signature)));
      assert.throws(() => key.public().verify([...message, 0], Signature.fromBytes(output.signature)));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('standard P-256 approval binds endpoint identity; substitution and stale approval reject', () => {
  const membership = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const peer = SecretKey.generate();
  const expected = {
    version: 1, purpose: 'freelm-iroh-membership-binding',
    membership: randomUUID(), endpointKey: peer.public().toString(), epoch: 1,
  };
  // Sign exact bytes, not ad-hoc JSON canonicalization. Fixture only, not a wire protocol.
  const payload = Buffer.from(JSON.stringify(expected));
  const signature = sign('sha256', payload, membership.privateKey);
  const authorize = (bytes, sig, remoteKey, epoch) => {
    if (!verify('sha256', bytes, membership.publicKey, sig)) return false;
    const claim = JSON.parse(bytes);
    return claim.version === 1 && claim.purpose === expected.purpose &&
      claim.membership === expected.membership && claim.endpointKey === remoteKey && claim.epoch === epoch;
  };
  assert.equal(authorize(payload, signature, peer.public().toString(), 1), true);
  assert.equal(authorize(payload, signature, SecretKey.generate().public().toString(), 1), false);
  assert.equal(authorize(payload, signature, peer.public().toString(), 2), false);
  assert.equal(authorize(Buffer.from(JSON.stringify({ ...expected, epoch: 2 })), signature, peer.public().toString(), 2), false);
});
