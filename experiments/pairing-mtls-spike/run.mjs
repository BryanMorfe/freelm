import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import assert from 'node:assert/strict';
const base = path.dirname(new URL(import.meta.url).pathname);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freelm-mtls-spike-'));
fs.chmodSync(dir, 0o700);
let server;
const evidence = [];
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
function persist(allowed) {
  const target = path.join(dir, 'authorization.json'),
    temporary = target + '.tmp';
  const fd = fs.openSync(temporary, 'w', 0o600);
  fs.writeFileSync(fd, JSON.stringify({ version: 1, allowed }));
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(temporary, target);
  const directory = fs.openSync(dir, 'r');
  fs.fsyncSync(directory);
  fs.closeSync(directory);
}
async function start(leaf = 'server') {
  server = spawn(process.execPath, [path.join(base, 'server.mjs'), dir, leaf], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const [data] = await once(server.stdout, 'data');
  return Number(data.toString().trim());
}
async function stop() {
  const child = server;
  server = undefined;
  child.kill('SIGTERM');
  await once(child, 'exit');
}
function check(label, port, rootName, client, expected, decision) {
  const auditPath = path.join(dir, 'audit.jsonl');
  const before = fs.existsSync(auditPath)
    ? fs.readFileSync(auditPath, 'utf8').trim().split('\n').length
    : 0;
  const output = execFileSync(
    path.join(dir, 'client'),
    [
      `https://127.0.0.1:${port}/`,
      path.join(dir, rootName + '.der'),
      client === 'none' ? 'none' : path.join(dir, client + '.p12'),
    ],
    { encoding: 'utf8', timeout: 15000 },
  ).trim();
  assert.match(output, expected, label + ': ' + output);
  const entries = fs.existsSync(auditPath)
    ? fs.readFileSync(auditPath, 'utf8').trim().split('\n').map(JSON.parse)
    : [];
  if (decision) {
    assert.ok(entries.length > before, label + ' reached authorization');
    assert.equal(entries.at(-1).decision, decision);
  } else if (expected.source.startsWith('^TLS_REJECTED'))
    assert.equal(entries.length, before, label + ' rejected before request');
  evidence.push({
    test: label,
    result: output,
    ...(decision ? { serverDecision: entries.at(-1) } : {}),
  });
}
try {
  root('ca');
  root('wrong-ca');
  leaf('server', 'ca', 'serverAuth');
  leaf('wrong-host', 'ca', 'serverAuth', 'wrong.invalid');
  leaf('phone', 'ca', 'clientAuth');
  leaf('other-phone', 'ca', 'clientAuth');
  leaf('foreign-phone', 'wrong-ca', 'clientAuth');
  execFileSync(
    'swiftc',
    ['-parse-as-library', path.join(base, 'Client.swift'), '-o', path.join(dir, 'client')],
    { stdio: 'pipe' },
  );
  const fingerprint = new X509Certificate(fs.readFileSync(path.join(dir, 'phone.pem')))
    .fingerprint256;
  persist([fingerprint]);
  let port = await start();
  check('Swift and Node TLS 1.3 mutual authentication', port, 'ca', 'phone', /^200 .*TLSv1.3/);
  check(
    'valid but unauthorized device rejected before negative handshakes',
    port,
    'ca',
    'other-phone',
    /^(403|TLS_REJECTED -1206)/,
    'denied',
  );
  check('wrong QR anchor rejected', port, 'wrong-ca', 'phone', /^TLS_REJECTED/);
  check('no client identity rejected', port, 'ca', 'none', /^TLS_REJECTED/);
  check('foreign client CA rejected', port, 'ca', 'foreign-phone', /^TLS_REJECTED/);
  check(
    'valid but unauthorized device rejected',
    port,
    'ca',
    'other-phone',
    /^(403|TLS_REJECTED -1206)/,
    'denied',
  );
  await stop();
  port = await start();
  check('authorized device survives server process restart', port, 'ca', 'phone', /^200/);
  persist([]);
  check(
    'revocation denies next request',
    port,
    'ca',
    'phone',
    /^(403|TLS_REJECTED -1206)/,
    'denied',
  );
  await stop();
  port = await start();
  check(
    'revocation survives server process restart',
    port,
    'ca',
    'phone',
    /^(403|TLS_REJECTED -1206)/,
    'denied',
  );
  fs.writeFileSync(path.join(dir, 'authorization.json'), 'broken');
  check('corrupt authorization fails closed', port, 'ca', 'phone', /^503/, 'unavailable');
  fs.unlinkSync(path.join(dir, 'authorization.json'));
  check('missing authorization fails closed', port, 'ca', 'phone', /^503/, 'unavailable');
  persist([fingerprint]);
  await stop();
  port = await start('wrong-host');
  check('wrong server hostname rejected despite trusted CA', port, 'ca', 'phone', /^TLS_REJECTED/);
  console.log(
    JSON.stringify(
      {
        status: 'PASS',
        scope: 'disposable macOS Swift URLSession ↔ Node HTTPS; no system Keychain or trust roots',
        checks: evidence,
      },
      null,
      2,
    ),
  );
} finally {
  if (server) await stop();
  fs.rmSync(dir, { recursive: true, force: true });
}
