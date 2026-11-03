import { execFileSync, fork } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
const base = path.dirname(new URL(import.meta.url).pathname);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freelm-ios-identity-'));
fs.chmodSync(dir, 0o700);
const run = randomUUID(),
  simulator = 'A427CFD4-8CB4-4734-AD7E-C83BDB6E3D76',
  bundle = 'devplaceholder.MTDMLY96.FreeLMBots';
const results = [];
let child, port;
let streamSeen = false;
let revocation;
let revocationFailure;
const openssl = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
function root(name) {
  openssl(
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    `${name}.key`,
    '-out',
    `${name}.pem`,
    '-days',
    '1',
    '-subj',
    `/CN=Synthetic ${name}`,
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
  );
  openssl('x509', '-in', `${name}.pem`, '-outform', 'DER', '-out', `${name}.der`);
}
function leaf(name, ca, purpose, hostname = 'localhost') {
  openssl(
    'req',
    '-new',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    `${name}.key`,
    '-out',
    `${name}.csr`,
    '-subj',
    `/CN=${name}`,
  );
  fs.writeFileSync(
    path.join(dir, `${name}.ext`),
    `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=${purpose}\nsubjectAltName=DNS:${hostname},IP:${hostname === 'localhost' ? '127.0.0.1' : '127.0.0.2'}\n`,
  );
  openssl(
    'x509',
    '-req',
    '-in',
    `${name}.csr`,
    '-CA',
    `${ca}.pem`,
    '-CAkey',
    `${ca}.key`,
    '-CAcreateserial',
    '-out',
    `${name}.pem`,
    '-days',
    '1',
    '-extfile',
    `${name}.ext`,
  );
  if (purpose === 'clientAuth')
    openssl(
      'pkcs12',
      '-export',
      '-inkey',
      `${name}.key`,
      '-in',
      `${name}.pem`,
      '-certfile',
      `${ca}.pem`,
      '-out',
      `${name}.p12`,
      '-passout',
      'pass:synthetic-only',
    );
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, label) {
  for (let i = 0; i < 300; i++) {
    if (fn()) return;
    await delay(100);
  }
  throw Error('Timeout: ' + label);
}
async function start() {
  child = fork(path.join(base, 'lifecycle-server.mjs'), [dir], {
    stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
  });
  child.on('message', (message) => {
    if (message.event === 'stream') streamSeen = true;
    if (message.event === 'revoked') revocation = message;
    if (message.event === 'revoke-failed') revocationFailure = message;
  });
  const [message] = await once(child, 'message');
  assert.equal(message.event, 'ready');
  port = message.port;
}
async function stop() {
  const process = child;
  child = undefined;
  process.kill('SIGTERM');
  await once(process, 'exit');
}
function launch(phase) {
  try {
    execFileSync('xcrun', ['simctl', 'terminate', simulator, bundle], { stdio: 'pipe' });
  } catch {}
  const report = path.join(dir, phase + '.report');
  fs.rmSync(report, { force: true });
  execFileSync('xcrun', ['simctl', 'launch', simulator, bundle, '--identity-lifecycle-qa'], {
    stdio: 'pipe',
    env: {
      ...process.env,
      SIMCTL_CHILD_BOTS_IDENTITY_DIR: dir,
      SIMCTL_CHILD_BOTS_IDENTITY_RUN: run,
      SIMCTL_CHILD_BOTS_IDENTITY_PHASE: phase,
      SIMCTL_CHILD_BOTS_IDENTITY_ENDPOINT: `https://127.0.0.1:${port}`,
    },
  });
  return report;
}
async function finish(phase, report) {
  await waitFor(() => fs.existsSync(report), phase);
  const result = fs.readFileSync(report, 'utf8');
  assert.equal(result, 'PASS: ' + phase, result);
  results.push(result);
}
async function phase(name) {
  await finish(name, launch(name));
}
let cleanupPassed = false;
try {
  root('ca');
  root('wrong-ca');
  leaf('server', 'ca', 'serverAuth');
  openssl('x509', '-in', 'server.pem', '-outform', 'DER', '-out', 'server.der');
  fs.writeFileSync(
    path.join(dir, 'client.ext'),
    'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n',
  );
  await start();
  const first = launch('enroll');
  await waitFor(() => fs.existsSync(path.join(dir, 'phone-public.pem')), 'iOS public key');
  child.send('issue');
  await finish('enroll', first);
  await phase('negative');
  await stop();
  await start();
  await phase('resume');
  fs.writeFileSync(path.join(dir, 'fail-write'), 'injected');
  await phase('server-write-failure');
  fs.unlinkSync(path.join(dir, 'fail-write'));
  await phase('renew-failure');
  await phase('resume');
  await phase('stage');
  await stop();
  await start();
  const beforeCommit = fs.readFileSync(path.join(dir, 'device.json'), 'utf8');
  fs.writeFileSync(path.join(dir, 'fail-write'), 'injected');
  await phase('commit-write-failure');
  assert.equal(fs.readFileSync(path.join(dir, 'device.json'), 'utf8'), beforeCommit);
  fs.unlinkSync(path.join(dir, 'fail-write'));
  await phase('commit-save-failure');
  await stop();
  await start();
  await phase('recover');
  await phase('old-denial');
  await phase('resume');
  await phase('stage');
  fs.writeFileSync(path.join(dir, 'drop-commit'), 'once');
  const stagedSerial = JSON.parse(fs.readFileSync(path.join(dir, 'device.json'), 'utf8')).pending
    .serial;
  await phase('commit-drop');
  const committed = JSON.parse(fs.readFileSync(path.join(dir, 'device.json'), 'utf8'));
  assert.equal(committed.current, stagedSerial);
  assert.equal(committed.pending, undefined);
  assert.ok(
    fs
      .readFileSync(path.join(dir, 'audit.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse)
      .some((x) => x.event === 'commit-persisted-response-dropped' && x.serial === stagedSerial),
  );
  fs.unlinkSync(path.join(dir, 'drop-commit'));
  await stop();
  await start();
  await phase('recover');
  await phase('old-denial');
  await phase('resume');
  await phase('stage');
  const stream = launch('stream');
  await waitFor(() => streamSeen, 'active streaming connection');
  fs.writeFileSync(path.join(dir, 'fail-write'), 'injected');
  child.send('revoke');
  await waitFor(() => revocationFailure, 'failed revocation');
  assert.ok(revocationFailure.activeStreams > 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'device.json'), 'utf8')).revoked, false);
  assert.equal(fs.existsSync(stream), false);
  fs.unlinkSync(path.join(dir, 'fail-write'));
  child.send('revoke');
  await waitFor(() => revocation, 'durable revocation');
  assert.ok(revocation.activeStreams > 0);
  await finish('stream', stream);
  await stop();
  await start();
  await phase('revoked');
  await phase('cleanup');
  cleanupPassed = true;
  const audit = fs
    .readFileSync(path.join(dir, 'audit.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  const revokeIndex = audit.findIndex((x) => x.event === 'revocation-persisted');
  assert.ok(
    revokeIndex >= 0 && audit.slice(revokeIndex + 1).some((x) => x.event === 'stream-closed'),
    'active stream closed after durable revocation',
  );
  for (const name of fs.readdirSync(dir).filter((x) => x.startsWith('handshake-denial-')))
    assert.ok(!audit.some((x) => x.nonce === name.slice(17)), 'trust failure reached HTTP');
  for (const name of fs.readdirSync(dir).filter((x) => x.startsWith('denial-'))) {
    const nonce = name.slice(7);
    assert.ok(
      audit.some((x) => x.nonce === nonce && !x.authorized),
      'correlated authorization denial ' + nonce,
    );
  }
  assert.ok(
    audit.some((x) => x.path === '/commit' && !x.authorized),
    'revoked commit rejected',
  );
  console.log(
    JSON.stringify(
      {
        status: 'PASS',
        scope: 'iOS Simulator real Keychain, disposable issuer and loopback Node TLS 1.3',
        phases: results,
        revocation,
        audit,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error('Completed phases', JSON.stringify(results));
  if (fs.existsSync(path.join(dir, 'audit.jsonl')))
    console.error(fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8'));
  throw error;
} finally {
  if (!cleanupPassed) {
    try {
      await phase('cleanup');
    } catch (error) {
      console.error('CLEANUP BLOCKER:', error.message, 'run', run);
    }
  }
  if (child) await stop();
  fs.rmSync(dir, { recursive: true, force: true });
  try {
    execFileSync('xcrun', ['simctl', 'terminate', simulator, bundle], { stdio: 'pipe' });
  } catch {}
  execFileSync('xcrun', ['simctl', 'launch', simulator, bundle], { stdio: 'pipe' });
}
