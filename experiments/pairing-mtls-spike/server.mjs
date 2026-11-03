// Standalone loopback fixture; not imported by the shipping app.
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
const [dir, leaf = 'server'] = process.argv.slice(2);
const read = (name) => fs.readFileSync(path.join(dir, name));
const server = https.createServer(
  {
    key: read(`${leaf}.key`),
    cert: read(`${leaf}.pem`),
    ca: read('ca.pem'),
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.3',
    maxVersion: 'TLSv1.3',
  },
  (req, res) => {
    // A valid certificate is necessary, never sufficient authorization.
    const audit = (decision) =>
      fs.appendFileSync(
        path.join(dir, 'audit.jsonl'),
        JSON.stringify({ decision, protocol: req.socket.getProtocol() }) + '\n',
      );
    let authorization;
    try {
      authorization = JSON.parse(read('authorization.json'));
      if (authorization.version !== 1 || !Array.isArray(authorization.allowed))
        throw Error('invalid');
    } catch {
      audit('unavailable');
      res.writeHead(503);
      res.end('authorization-unavailable');
      return;
    }
    const fingerprint = req.socket.getPeerCertificate().fingerprint256;
    if (!req.socket.authorized || !authorization.allowed.includes(fingerprint)) {
      audit('denied');
      res.writeHead(403);
      res.end('device-not-authorized');
      return;
    }
    audit('authorized');
    res.end(
      JSON.stringify({
        protocol: req.socket.getProtocol(),
        identity: 'synthetic-mac',
        result: 'authorized',
      }),
    );
  },
);
server.on('tlsClientError', (error) => console.error('TLS diagnostic:', error.message));
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
process.on('SIGTERM', () => {
  server.closeAllConnections();
  server.close(() => process.exit(0));
});
