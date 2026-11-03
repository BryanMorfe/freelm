import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { X509Certificate, webcrypto } from 'node:crypto';
import { createServer } from 'node:https';
import { request as httpsRequest } from 'node:https';
import type { TLSSocket } from 'node:tls';
import * as x509 from '@peculiar/x509';
import { LocalEnrollment, parseLocalInvitation } from '../../electron/pairing/enrollment';
import type { PairingSecureStore } from '../../electron/pairing/secure-store';
import { mobileFixture } from '../../scripts/mobile-fixture';

const crypto = webcrypto as unknown as Crypto;
const algorithm = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
/** TEST ONLY fault-injecting atomic storage. Never imported by production. */
class TestStore implements PairingSecureStore {
  readonly scope = Math.random().toString();
  value: string | null = null;
  fail = false;
  async read() {
    return this.value;
  }
  async create(value: string) {
    if (this.fail || this.value !== null) throw Error('write failed');
    this.value = value;
  }
  async replace(expected: string, value: string) {
    if (this.fail || this.value !== expected) throw Error('write failed');
    this.value = value;
  }
}
async function phone() {
  const keys = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
  const csr = await x509.Pkcs10CertificateRequestGenerator.create(
    { name: 'CN=Untrusted phone input', keys, signingAlgorithm: algorithm },
    crypto,
  );
  const bytes = Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey));
  return {
    csr: csr.toString('pem'),
    key: `-----BEGIN PRIVATE KEY-----\n${bytes.toString('base64')}\n-----END PRIVATE KEY-----`,
  };
}
async function setup() {
  const store = new TestStore();
  const service = new LocalEnrollment(store);
  await service.initialize();
  return { store, service };
}

describe('durable local enrollment controls (isolated)', () => {
  it('requires explicit initialization, preserves existing identity and fails closed on corruption/storage failure', async () => {
    const store = new TestStore();
    const service = new LocalEnrollment(store);
    expect(store.value).toBeNull();
    await expect(service.invite('https://localhost')).rejects.toThrow();
    store.fail = true;
    await expect(service.initialize()).rejects.toThrow();
    expect(store.value).toBeNull();
    store.fail = false;
    await service.initialize();
    const original = store.value;
    await expect(service.initialize()).rejects.toThrow();
    expect(store.value).toBe(original);
    store.value = '{}';
    await expect(service.invite('https://localhost')).rejects.toThrow();
  });
  it('rejects malformed/expired QR, wrong secrets, tampered proof, replay and mismatched approval', async () => {
    let now = Date.now();
    const store = new TestStore();
    const service = new LocalEnrollment(store, () => now);
    await service.initialize();
    const invite = await service.invite('https://localhost');
    const p = await phone();
    expect(parseLocalInvitation(JSON.stringify(invite), now).hostId).toBe(invite.hostId);
    expect(() =>
      parseLocalInvitation(JSON.stringify({ ...invite, endpoint: 'http://localhost' }), now),
    ).toThrow();
    expect(() =>
      parseLocalInvitation(JSON.stringify({ ...invite, hostId: 'a'.repeat(64) }), now),
    ).toThrow();
    await expect(service.request(invite.invitationId, 'b'.repeat(64), p.csr)).rejects.toThrow();
    const der = Buffer.from(p.csr.replace(/-----[^-]+-----|\s/g, ''), 'base64');
    der[der.length - 1] ^= 1;
    await expect(
      service.request(
        invite.invitationId,
        invite.secret,
        `-----BEGIN CERTIFICATE REQUEST-----\n${der.toString('base64')}\n-----END CERTIFICATE REQUEST-----`,
      ),
    ).rejects.toThrow();
    const pending = await service.request(invite.invitationId, invite.secret, p.csr);
    await expect(service.request(invite.invitationId, invite.secret, p.csr)).rejects.toThrow();
    await expect(service.approve(pending.requestId, 'c'.repeat(64))).rejects.toThrow();
    await service.deny(pending.requestId);
    await expect(service.approve(pending.requestId, pending.keyHash)).rejects.toThrow();
    const expired = await service.invite('https://localhost');
    now += 120001;
    expect(() => parseLocalInvitation(JSON.stringify(expired), now)).toThrow();
    await expect(service.request(expired.invitationId, expired.secret, p.csr)).rejects.toThrow();
  });
  it('serializes conflicting requests using compare-and-replace; persistence failure never consumes invitation', async () => {
    const { store, service } = await setup();
    const invite = await service.invite('https://localhost');
    const p = await phone();
    const before = store.value;
    store.fail = true;
    await expect(service.request(invite.invitationId, invite.secret, p.csr)).rejects.toThrow();
    expect(store.value).toBe(before);
    store.fail = false;
    const results = await Promise.allSettled([
      service.request(invite.invitationId, invite.secret, p.csr),
      new LocalEnrollment(store).request(invite.invitationId, invite.secret, p.csr),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
  it('serializes a deliberately delayed authorization read with durable revocation', async () => {
    const { store, service } = await setup();
    const p = await phone();
    const invite = await service.invite('https://localhost');
    const pending = await service.request(invite.invitationId, invite.secret, p.csr);
    const cert = await service.approve(pending.requestId, pending.keyHash);
    // Socket double isolates scheduling; the separate integration test proves real mTLS.
    const events = new EventEmitter();
    const socket = Object.assign(events, {
      encrypted: true,
      authorized: true,
      destroyed: false,
      getPeerCertificate: () => ({ raw: new X509Certificate(cert).raw }),
      destroy() {
        this.destroyed = true;
        events.emit('close');
        return this;
      },
    });
    await service.activate(pending.requestId, socket as unknown as TLSSocket);
    let release!: () => void;
    let captured!: () => void;
    const capturedRead = new Promise<void>((resolve) => {
      captured = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realRead = store.read.bind(store);
    let first = true;
    store.read = async () => {
      const raw = await realRead();
      if (first) {
        first = false;
        captured();
        await gate;
      }
      return raw;
    };
    const authorization = service.authorize(socket as unknown as TLSSocket);
    await capturedRead;
    const revocation = new LocalEnrollment(store).revoke();
    release();
    await authorization;
    await revocation;
    expect(socket.destroyed).toBe(true);
    await expect(service.authorize(socket as unknown as TLSSocket)).rejects.toThrow();
  });
  it('revokes without waiting for a stalled authorized host operation', async () => {
    const { store, service } = await setup(); const p = await phone();
    const invitation = await service.invite('https://localhost');
    const pending = await service.request(invitation.invitationId, invitation.secret, p.csr);
    const certificate = await service.approve(pending.requestId, pending.keyHash);
    const events = new EventEmitter();
    const socket = Object.assign(events, {encrypted:true, authorized:true, destroyed:false,
      getPeerCertificate:()=>({raw:new X509Certificate(certificate).raw}),
      destroy(){this.destroyed=true;events.emit('close');return this;}});
    await service.activate(pending.requestId, socket as unknown as TLSSocket);
    let release!:()=>void; let entered!:()=>void;
    const enteredPromise=new Promise<void>(resolve=>{entered=resolve;});
    const held=new Promise<void>(resolve=>{release=resolve;});
    const work=service.withAuthorization(socket as unknown as TLSSocket,async check=>{entered();await held;check();return 'must not execute';});
    const rejection=expect(work).rejects.toThrow('Device revoked');
    await enteredPromise;
    await new LocalEnrollment(store).revoke();
    expect(socket.destroyed).toBe(true);release();await rejection;
  });
  it('uses real mTLS for activation, survives restart/lost response, runs Bots once, and durably revokes active connections', async () => {
    const { store } = await setup();
    let service = new LocalEnrollment(store);
    // Fixture-only server certificate issuance. No production listener is enabled.
    const issuer = JSON.parse(store.value!);
    const keys = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
    const caKey = await crypto.subtle.importKey(
      'pkcs8',
      Buffer.from(issuer.privateKey, 'base64'),
      algorithm,
      false,
      ['sign'],
    );
    const serverCert = await x509.X509CertificateGenerator.create(
      {
        issuer: new x509.X509Certificate(issuer.issuer).subject,
        subject: 'CN=localhost',
        publicKey: keys.publicKey,
        signingKey: caKey,
        signingAlgorithm: algorithm,
        extensions: [
          new x509.BasicConstraintsExtension(false, undefined, true),
          new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: 'localhost' }]),
          new x509.ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1'], true),
        ],
      },
      crypto,
    );
    const serverKey = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey)).toString('base64')}\n-----END PRIVATE KEY-----`;
    const fixture = await mobileFixture();
    const server = createServer(
      {
        key: serverKey,
        cert: serverCert.toString('pem'),
        ca: issuer.issuer,
        requestCert: true,
        rejectUnauthorized: false,
        minVersion: 'TLSv1.3',
      },
      async (req, res) => {
        try {
          const socket = req.socket as TLSSocket;
          if (req.url?.startsWith('/activate/'))
            await service.activate(req.url.slice('/activate/'.length), socket);
          else {
            await service.authorize(socket);
            if (req.url === '/send')
              await fixture.bots.command({
                type: 'send',
                conversationId: 'welcome',
                messageId: 'enrolled-message',
                content: 'Synthetic enrolled phone',
              });
            else if (req.url === '/stream') {
              res.writeHead(200);
              res.write('ready');
              return;
            } else if (req.url !== '/snapshot') throw Error('Bots only');
          }
          res.writeHead(200);
          res.end('ok');
        } catch {
          res.writeHead(403);
          res.end('denied');
        }
      },
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const call = (path: string, p?: { key: string; cert: string }, ca = issuer.issuer) =>
      new Promise<number>((resolve, reject) => {
        const req = httpsRequest(
          { hostname: '127.0.0.1', servername: 'localhost', port, path, ca, ...p, agent: false },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode!));
          },
        );
        req.on('error', reject);
        req.end();
      });
    try {
      const invite = parseLocalInvitation(
        JSON.stringify(await service.invite(`https://localhost:${port}`)),
      );
      const p = await phone();
      const pending = await service.request(invite.invitationId, invite.secret, p.csr);
      expect(await call('/snapshot')).toBe(403);
      const original = store.value;
      store.fail = true;
      await expect(service.approve(pending.requestId, pending.keyHash)).rejects.toThrow();
      expect(store.value).toBe(original);
      store.fail = false;
      const identity = { ...p, cert: await service.approve(pending.requestId, pending.keyHash) };
      expect(await call('/snapshot', identity)).toBe(403);
      const approved = store.value;
      store.fail = true;
      expect(await call(`/activate/${pending.requestId}`, identity)).toBe(403);
      expect(store.value).toBe(approved);
      store.fail = false;
      expect(await call(`/activate/${pending.requestId}`, identity)).toBe(200);
      // Discard activation response/state in client; reconstruct service from durable record.
      service = new LocalEnrollment(store);
      expect(await call(`/activate/${pending.requestId}`, identity)).toBe(200);
      expect(await call('/send', identity)).toBe(200);
      expect(await call('/send', identity)).toBe(200);
      const snapshot = await fixture.bots.snapshot();
      expect(
        snapshot.conversations[0].messages.filter((m) => m.id === 'enrolled-message'),
      ).toHaveLength(1);
      expect(await call('/tasks', identity)).toBe(403);
      const foreign = await setup();
      await expect(
        call('/snapshot', identity, JSON.parse(foreign.store.value!).issuer),
      ).rejects.toThrow();
      const active = store.value;
      store.fail = true;
      await expect(service.revoke()).rejects.toThrow();
      expect(store.value).toBe(active);
      store.fail = false;
      expect(await call('/snapshot', identity)).toBe(200);
      let closed = false;
      let finish: (() => void) | undefined;
      const streamClosed = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const stream = httpsRequest({
        hostname: '127.0.0.1',
        servername: 'localhost',
        port,
        path: '/stream',
        ca: issuer.issuer,
        ...identity,
        agent: false,
      });
      await new Promise<void>((resolve, reject) => {
        stream.on('response', (res) => {
          expect(res.statusCode).toBe(200);
          res.once('data', () => resolve());
          res.on('close', () => {
            closed = true;
            finish!();
          });
          res.resume();
        });
        stream.on('error', reject);
        stream.end();
      });
      expect(closed).toBe(false);
      store.fail = true;
      await expect(service.revoke()).rejects.toThrow();
      expect(closed).toBe(false);
      store.fail = false;
      await service.revoke();
      await streamClosed;
      expect(closed).toBe(true);
      service = new LocalEnrollment(store);
      expect(await call('/snapshot', identity)).toBe(403);
      expect(await call(`/activate/${pending.requestId}`, identity)).toBe(403);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fixture.close();
    }
  }, 20000);
});
