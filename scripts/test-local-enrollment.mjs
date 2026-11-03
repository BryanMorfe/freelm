// Fail-fast: every invocation builds unique executables before running any test.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
const directory = mkdtempSync(path.join(tmpdir(), 'freelm-enrollment-build-'));
try {
  const qa = path.join(directory, 'pairing-vault-qa');
  const production = path.join(directory, 'pairing-vault-production');
  execFileSync('swiftc', ['-D', 'PAIRING_ISOLATED_QA', 'native/pairing/PairingVault.swift', '-o', qa], { stdio: 'inherit' });
  execFileSync('swiftc', ['native/pairing/PairingVault.swift', '-o', production], { stdio: 'inherit' });
  // Production test flags must fail before any Keychain operation. Never invoke
  // the production helper without arguments from QA.
  const rejected = spawnSync(production, ['--isolated-keychain', '/tmp/invalid/vault.keychain'], { input: '{"operation":"read"}', encoding: 'utf8' });
  if (rejected.status !== 2 || !rejected.stdout.includes('production helper does not accept arguments')) throw Error('Production test boundary failed');
  execFileSync('npx', ['vitest', 'run', 'tests/remote/local-enrollment.test.ts', 'tests/remote/pairing-native-storage.test.ts', 'tests/remote/mobile.test.ts', 'tests/remote/mobile-tls.test.ts'], {
    stdio: 'inherit', env: { ...process.env, FREELM_PAIRING_TEST_HELPER: qa },
  });
} finally { rmSync(directory, { recursive: true, force: true }); }
