// Isolated QA only. No production imports, enrollment UI, or reachable bind address.
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { X509Certificate, createHash } from 'node:crypto';
const dir = process.argv[2];
const read = (name) => fs.readFileSync(path.join(dir, name));
const fingerprint = (cert) =>
  createHash('sha256')
    .update(cert.publicKey.export({ format: 'der', type: 'spki' }))
    .digest('hex');
function save(record) {
  if (fs.existsSync(path.join(dir, 'fail-write'))) throw Error('injected persistence failure');
  const target = path.join(dir, 'device.json'),
    temp = target + '.tmp';
  const fd = fs.openSync(temp, 'w', 0o600);
  fs.writeFileSync(fd, JSON.stringify(record));
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(temp, target);
  const d = fs.openSync(dir, 'r');
  fs.fsyncSync(d);
  fs.closeSync(d);
}
function load() {
  const value = JSON.parse(read('device.json'));
  if (
    value.version !== 1 ||
    typeof value.revoked !== 'boolean' ||
    typeof value.publicKeyHash !== 'string' ||
    typeof value.current !== 'string'
  )
    throw Error('invalid authorization');
  return value;
}
function issue(publicKey, serial) {
  fs.writeFileSync(path.join(dir, 'issue-public.pem'), publicKey);
  execFileSync(
    'openssl',
    [
      'x509',
      '-new',
      '-force_pubkey',
      'issue-public.pem',
      '-CA',
      'ca.pem',
      '-CAkey',
      'ca.key',
      '-set_serial',
      String(serial),
      '-days',
      '1',
      '-subj',
      '/CN=Synthetic iPhone',
      '-extfile',
      'client.ext',
      '-out',
      'issued.pem',
    ],
    { cwd: dir, stdio: 'pipe' },
  );
  const cert = new X509Certificate(read('issued.pem'));
  return { der: cert.raw.toString('base64'), serial: cert.serialNumber };
}
const sockets = new Map();
let streamCount = 0;
const server = https.createServer(
  {
    key: read('server.key'),
    cert: read('server.pem'),
    ca: read('ca.pem'),
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.3',
    maxVersion: 'TLSv1.3',
  },
  (req, res) => {
    let state;
    try {
      state = load();
    } catch {
      res.writeHead(503);
      res.end();
      return;
    }
    try {
      const cert = new X509Certificate(req.socket.getPeerCertificate().raw);
      const authorized =
        req.socket.authorized &&
        !state.revoked &&
        fingerprint(cert) === state.publicKeyHash &&
        [state.current, state.pending?.serial].includes(cert.serialNumber) &&
        (cert.serialNumber === state.current || req.url === '/commit');
      fs.appendFileSync(
        path.join(dir, 'audit.jsonl'),
        JSON.stringify({
          path: req.url,
          nonce: req.headers['x-qa-nonce'],
          authorized,
          serial: cert.serialNumber,
          protocol: req.socket.getProtocol(),
        }) + '\n',
      );
      if (!authorized) {
        res.writeHead(403);
        res.end();
        return;
      }
      if (!sockets.has(req.socket)) req.socket.once('close', () => sockets.delete(req.socket));
      sockets.set(req.socket, { key: state.publicKeyHash, serial: cert.serialNumber });
      if (req.url === '/renew' && req.method === 'POST') {
        if (!state.pending) {
          state.pending = issue(state.publicPEM, Number(state.nextSerial));
          state.nextSerial++;
          save(state);
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(state.pending));
        return;
      }
      if (req.url === '/commit' && req.method === 'POST') {
        if (state.pending?.serial === cert.serialNumber) {
          state.current = state.pending.serial;
          state.pending = undefined;
          save(state);
          for (const [socket, peer] of sockets)
            if (peer.key === state.publicKeyHash && peer.serial !== state.current) socket.destroy();
        } else if (cert.serialNumber !== state.current) {
          res.writeHead(409);
          res.end();
          return;
        }
        if (fs.existsSync(path.join(dir, 'drop-commit'))) {
          fs.appendFileSync(
            path.join(dir, 'audit.jsonl'),
            JSON.stringify({
              event: 'commit-persisted-response-dropped',
              nonce: req.headers['x-qa-nonce'],
              serial: state.current,
            }) + '\n',
          );
          req.socket.destroy();
          return;
        }
        res.end('committed');
        return;
      }
      if (req.url === '/events') {
        streamCount++;
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.write('synthetic-start\n');
        process.send?.({ event: 'stream' });
        const timer = setInterval(() => res.write('synthetic-tick\n'), 100);
        res.on('close', () => {
          clearInterval(timer);
          streamCount--;
          fs.appendFileSync(
            path.join(dir, 'audit.jsonl'),
            JSON.stringify({ event: 'stream-closed' }) + '\n',
          );
        });
        return;
      }
      if (req.url === '/snapshot') {
        res.end('synthetic-authorized');
        return;
      }
      res.writeHead(404);
      res.end();
    } catch {
      res.writeHead(503);
      res.end('persistence-failed');
    }
  },
);
server.on('tlsClientError', () => {});
process.on('message', (message) => {
  if (message === 'issue') {
    const publicPEM = read('phone-public.pem').toString();
    const certificate = issue(publicPEM, 1001);
    const cert = new X509Certificate(Buffer.from(certificate.der, 'base64'));
    save({
      version: 1,
      revoked: false,
      publicPEM,
      publicKeyHash: fingerprint(cert),
      current: certificate.serial,
      nextSerial: 1002,
    });
    fs.writeFileSync(path.join(dir, 'phone.der'), cert.raw);
    process.send?.({ event: 'issued' });
  } else if (message === 'revoke') {
    try {
      const state = load();
      state.revoked = true;
      state.pending = undefined;
      save(state);
      const active = streamCount;
      fs.appendFileSync(
        path.join(dir, 'audit.jsonl'),
        JSON.stringify({ event: 'revocation-persisted', activeStreams: active }) + '\n',
      );
      for (const socket of sockets.keys()) socket.destroy();
      process.send?.({ event: 'revoked', activeStreams: active });
    } catch {
      process.send?.({ event: 'revoke-failed', activeStreams: streamCount });
    }
  }
});
server.listen(0, '127.0.0.1', () =>
  process.send?.({ event: 'ready', port: server.address().port }),
);
process.on('SIGTERM', () => {
  server.closeAllConnections();
  server.close(() => process.exit(0));
});
