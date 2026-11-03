import 'reflect-metadata';
import { it, expect } from 'vitest';
import { randomBytes, webcrypto } from 'node:crypto';
import { request } from 'node:https';
import { createServer as createRelay, connect, type Socket } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as x509 from '@peculiar/x509';
import { LocalEnrollment } from '../../electron/pairing/enrollment';
import { LocalPairingListener } from '../../electron/pairing/listener';
import {
  NativePairingSecureStore,
  type PairingSecureStore,
} from '../../electron/pairing/secure-store';
import { InstanceHost } from '../../electron/instance-host';
import { mobileFixture } from '../../scripts/mobile-fixture';
import { localPairingReleaseVerified } from '../../electron/pairing/release-gate';

it('keeps the production release gate closed', () =>
  expect(localPairingReleaseVerified).toBe(false));
it('integrates real TLS enrollment, local approval and actual Bots routes with protected storage when QA helper is supplied', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'freelm-enrollment-'));
  const binary = process.env.FREELM_PAIRING_TEST_HELPER;
  let value: string | null = null;
  const memory: PairingSecureStore = {
    scope: directory,
    read: async () => value,
    create: async (next) => {
      if (value) throw Error();
      value = next;
    },
    replace: async (expected, next) => {
      if (value !== expected) throw Error();
      value = next;
    },
  };
  let store: PairingSecureStore = memory;
  if (binary) {
    const filename = path.join(directory, 'vault.keychain');
    execFileSync(binary, ['--isolated-keychain', filename], {
      input: JSON.stringify({
        operation: 'initialize-test-keychain',
        password: randomBytes(32).toString('hex'),
      }),
    });
    store = new NativePairingSecureStore(binary, filename);
  }
  const enrollment = new LocalEnrollment(store);
  await enrollment.initialize();
  const fixture = await mobileFixture();
  const host = new InstanceHost({
    instanceId: 'synthetic-mac',
    name: 'Test Mac',
    port: 0,
    token: randomBytes(32).toString('hex'),
    bots: fixture.bots,
    authority: fixture.authority,
  });
  let listener = new LocalPairingListener(
    enrollment,
    { id: 'synthetic-mac', name: 'Test Mac' },
    (req, res, check) =>
      host.handleAuthorizedMobile(req, res, check, () => {
        throw Error('No bearer disconnect');
      }),
  );
  // Logical network segments are simulated; all sockets remain on loopback.
  // The relay forwards TLS bytes unchanged and never receives a private key.
  const relaySockets=new Set<Socket>();let encryptedBytes=0;
  const relay=createRelay(client=>{
    const upstream=connect(Number(new URL(listener.endpoint!).port),'127.0.0.1');
    for(const socket of [client,upstream]){relaySockets.add(socket);socket.once('close',()=>relaySockets.delete(socket));socket.on('error',()=>{client.destroy();upstream.destroy();});}
    client.on('data',chunk=>{encryptedBytes+=chunk.length;});client.pipe(upstream);upstream.pipe(client);
    client.once('close',()=>upstream.destroy());upstream.once('close',()=>client.destroy());
  });
  await new Promise<void>(resolve=>relay.listen(0,'127.0.0.1',resolve));
  const relayPort=(relay.address() as {port:number}).port;
  let segment:'same'|'different'='same', relayAvailable=true, useRelay=false;
  try {
    await listener.start('https://127.0.0.1:0', '127.0.0.1');
    const invite = await listener.invite();
    const parsed = JSON.parse(JSON.stringify(invite));
    const crypto = webcrypto as unknown as Crypto;
    const algorithm = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
    const keys = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
    const csr = await x509.Pkcs10CertificateRequestGenerator.create(
      { name: 'CN=Synthetic phone', keys, signingAlgorithm: algorithm },
      crypto,
    );
    const key = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey)).toString('base64')}\n-----END PRIVATE KEY-----`;
    let cert: string | undefined;
    const call = (route: string, body?: unknown, client = false) =>
      new Promise<{ status: number; body: any }>((resolve, reject) => {
        if(segment==='different' && (!useRelay || !relayAvailable)){reject(Error('Simulated network partition'));return;}
        const req = request(
          new URL(route, listener.endpoint!),
          {
            ...(useRelay ? {port:relayPort} : {}),
            method: body === undefined ? 'GET' : 'POST',
            ca: parsed.rootCertificate,
            ...(client ? { key, cert } : {}),
            headers: { 'Content-Type': 'application/json', Host:new URL(listener.endpoint!).host },
            agent: false,
          },
          (res) => {
            let text = '';
            res.on('data', (chunk) => (text += chunk));
            res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
          },
        );
        req.on('error', reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
      });
    const auth = { invitationId: parsed.invitationId, secret: parsed.secret };
    expect((await call('/mobile/snapshot')).status).toBe(401);
    const pending = await call('/local-pairing/request', { ...auth, csr: csr.toString('pem') });
    expect(pending.status).toBe(200);
    expect((await call('/local-pairing/approve', pending.body)).status).toBe(403);
    expect(
      (await call('/local-pairing/request', { ...auth, csr: csr.toString('pem') })).status,
    ).not.toBe(200);
    expect((await call('/local-pairing/status', auth)).body.certificate).toBeNull();
    await new LocalEnrollment(store).approve(pending.body.requestId, pending.body.keyHash);
    cert = (await call('/local-pairing/status', auth)).body.certificate;
    expect((await call('/mobile/snapshot', undefined, true)).status).toBe(401);
    expect(
      (await call('/local-pairing/activate', { requestId: pending.body.requestId }, true)).body
        .hostId,
    ).toBe('synthetic-mac');
    const preferences = await call('/mobile/preferences', undefined, true);
    expect((await call('/mobile/preferences', {revision:preferences.body.revision,sound:{muted:false,volume:0.7}}, true)).status).toBe(200);
    expect((await call('/mobile/preferences', {revision:preferences.body.revision,sound:{muted:false,volume:0.7}}, true)).status).toBe(409);
    const operation = {
      hostId: 'synthetic-mac',
      conversationId: 'welcome',
      messageId: 'integrated-phone',
      content: 'Synthetic secure enrollment',
    };
    expect((await call('/mobile/send', operation, true)).status).toBe(200);
    expect((await call('/mobile/send', operation, true)).status).toBe(200);
    expect(
      (await call('/mobile/snapshot', undefined, true)).body.conversations[0].messages.filter(
        (m: { id: string }) => m.id === 'integrated-phone',
      ),
    ).toHaveLength(1);
    expect((await call('/bots', undefined, true)).status).toBe(403);
    segment='different';
    await expect(call('/mobile/snapshot',undefined,true)).rejects.toThrow('Simulated network partition');
    useRelay=true;
    expect((await call('/mobile/snapshot',undefined,true)).status).toBe(200);
    relayAvailable=false;
    const queued={...operation,messageId:'partition-reconnect',content:'Queued synthetic message during partition'};
    await writeFile(path.join(directory,'outbox.json'),JSON.stringify(queued),{mode:0o600});
    await expect(call('/mobile/send',queued,true)).rejects.toThrow('Simulated network partition');
    relayAvailable=true;
    expect((await call('/mobile/send',JSON.parse(await readFile(path.join(directory,'outbox.json'),'utf8')),true)).status).toBe(200);
    expect(encryptedBytes).toBeGreaterThan(0);

    await listener.stop();
    listener = new LocalPairingListener(
      new LocalEnrollment(store),
      { id: 'synthetic-mac', name: 'Test Mac' },
      (req, res, check) => host.handleAuthorizedMobile(req, res, check, () => {}),
    );
    await listener.start('https://127.0.0.1:0', '127.0.0.1');
    expect((await call('/mobile/snapshot', undefined, true)).status).toBe(200);
    expect(
      (await call('/local-pairing/activate', { requestId: pending.body.requestId }, true)).status,
    ).toBe(200);
    // Re-read an unacknowledged durable test outbox after host restart: no duplicate execution.
    expect((await call('/mobile/send',JSON.parse(await readFile(path.join(directory,'outbox.json'),'utf8')),true)).status).toBe(200);
    expect((await call('/mobile/snapshot',undefined,true)).body.conversations[0].messages.filter((m:{id:string})=>m.id==='partition-reconnect')).toHaveLength(1);
    expect((await call('/mobile/disconnect', {}, true)).status).toBe(200);
    expect((await call('/mobile/snapshot', undefined, true)).status).toBe(401);
    expect(
      (await call('/local-pairing/activate', { requestId: pending.body.requestId }, true)).status,
    ).toBe(401);
  } finally {
    await new Promise<void>(resolve=>{relay.close(()=>resolve());for(const socket of relaySockets)socket.destroy();});
    await listener.stop();
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 20000);
