import 'reflect-metadata';
import {
  createHash,
  createPrivateKey,
  randomBytes,
  webcrypto,
  X509Certificate as NodeCertificate,
} from 'node:crypto';
import Ajv from 'ajv';
import type { TLSSocket } from 'node:tls';
import * as x509 from '@peculiar/x509';
import type { PairingSecureStore } from './secure-store';

const crypto = webcrypto as unknown as Crypto;
const algorithm = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('hex');
const lifetime = 120000;
export class PairingAuthorizationError extends Error {}
type Request = {
  invitationId: string;
  secretHash: string;
  id: string;
  keyHash: string;
  csr: string;
  expires: number;
  certificate?: string;
};
type RecordV1 = {
  version: 1;
  hostId: string;
  issuer: string;
  privateKey: string;
  invitation?: { id: string; secretHash: string; expires: number };
  request?: Request;
  active?: { requestId: string; certificate: string; keyHash: string };
  revoked: string[];
};
const hashSchema = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const certificateSchema = { type: 'string', minLength: 100, maxLength: 8192 };
const recordValid = new Ajv({ allErrors: false }).compile({
  type: 'object',
  additionalProperties: false,
  required: ['version', 'hostId', 'issuer', 'privateKey', 'revoked'],
  properties: {
    version: { const: 1 },
    hostId: hashSchema,
    issuer: certificateSchema,
    privateKey: {
      type: 'string',
      minLength: 100,
      maxLength: 4096,
      pattern: '^[A-Za-z0-9+/]+={0,2}$',
    },
    revoked: { type: 'array', maxItems: 128, uniqueItems: true, items: hashSchema },
    invitation: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'secretHash', 'expires'],
      properties: { id: hashSchema, secretHash: hashSchema, expires: { type: 'number' } },
    },
    request: {
      type: 'object',
      additionalProperties: false,
      required: ['invitationId', 'secretHash', 'id', 'keyHash', 'csr', 'expires'],
      properties: {
        invitationId: hashSchema,
        secretHash: hashSchema,
        id: hashSchema,
        keyHash: hashSchema,
        csr: certificateSchema,
        expires: { type: 'number' },
        certificate: certificateSchema,
      },
    },
    active: {
      type: 'object',
      additionalProperties: false,
      required: ['requestId', 'certificate', 'keyHash'],
      properties: { requestId: hashSchema, certificate: certificateSchema, keyHash: hashSchema },
    },
  },
});
export type LocalInvitation = {
  version: 3;
  endpoint: string;
  hostId: string;
  rootCertificate: string;
  invitationId: string;
  secret: string;
  expires: number;
};

/** Parse untrusted QR/manual text without initiating a connection or granting access. */
export function parseLocalInvitation(text: string, now = Date.now()): LocalInvitation {
  if (Buffer.byteLength(text) > 8192) throw new Error('Invitation too large');
  const value = JSON.parse(text) as LocalInvitation;
  const url = new URL(value.endpoint);
  if (
    value.version !== 3 ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !/^[a-f0-9]{64}$/.test(value.hostId) ||
    !/^[a-f0-9]{64}$/.test(value.invitationId) ||
    !/^[a-f0-9]{64}$/.test(value.secret) ||
    !Number.isFinite(value.expires) ||
    value.expires <= now ||
    value.expires > now + lifetime
  )
    throw new Error('Invalid or expired invitation');
  const root = new NodeCertificate(value.rootCertificate);
  if (!root.ca || !root.verify(root.publicKey) || digest(root.raw) !== value.hostId)
    throw new Error('Invalid invitation identity');
  return value;
}

/** Not wired to IPC or a listener until review and end-to-end validation pass.
 * All mutation is a single atomic protected-record compare-and-replace. Callers
 * must surface errors; retry must reload, never overwrite a newer generation. */
const scopes = new Map<
  string,
  { tail: Promise<void>; connections: Set<TLSSocket>; epoch: number }
>();
export class LocalEnrollment {
  private get scope() {
    let scope = scopes.get(this.store.scope);
    if (!scope) {
      scope = { tail: Promise.resolve(), connections: new Set(), epoch: 0 };
      scopes.set(this.store.scope, scope);
    }
    return scope;
  }
  private async serialized<T>(action: () => Promise<T>): Promise<T> {
    const scope = this.scope;
    const previous = scope.tail;
    let release!: () => void;
    scope.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }
  constructor(
    private readonly store: PairingSecureStore,
    private readonly now = Date.now,
  ) {}
  private async load(): Promise<{ raw: string; state: RecordV1 }> {
    const raw = await this.store.read();
    if (!raw || raw.length > 200000) throw new Error('Pairing identity unavailable');
    const state = JSON.parse(raw) as RecordV1;
    if (
      !recordValid(state) ||
      (state.active && (state.request || state.invitation)) ||
      (state.request && state.invitation)
    )
      throw new Error('Invalid pairing record');
    if (
      state.version !== 1 ||
      !/^[a-f0-9]{64}$/.test(state.hostId) ||
      !Array.isArray(state.revoked) ||
      state.revoked.length > 128 ||
      state.revoked.some((x) => !/^[a-f0-9]{64}$/.test(x))
    )
      throw new Error('Invalid pairing record');
    const root = new NodeCertificate(state.issuer);
    if (
      !root.checkPrivateKey(
        createPrivateKey({
          key: Buffer.from(state.privateKey, 'base64'),
          type: 'pkcs8',
          format: 'der',
        }),
      ) ||
      !root.ca ||
      Date.parse(root.validFrom) > this.now() ||
      digest(root.raw) !== state.hostId ||
      !root.verify(root.publicKey) ||
      Date.parse(root.validTo) <= this.now()
    )
      throw new Error('Invalid issuer');
    if (
      state.invitation &&
      (!/^[a-f0-9]{64}$/.test(state.invitation.id) ||
        !/^[a-f0-9]{64}$/.test(state.invitation.secretHash) ||
        !Number.isFinite(state.invitation.expires))
    )
      throw new Error('Invalid invitation record');
    if (
      state.request &&
      (!/^[a-f0-9]{64}$/.test(state.request.id) ||
        !/^[a-f0-9]{64}$/.test(state.request.keyHash) ||
        typeof state.request.csr !== 'string' ||
        state.request.csr.length > 8192 ||
        !Number.isFinite(state.request.expires))
    )
      throw new Error('Invalid request record');
    for (const entry of [state.active, state.request?.certificate ? state.request : undefined]) {
      if (!entry) continue;
      const cert = new NodeCertificate(entry.certificate!);
      if (
        cert.ca ||
        !cert.verify(root.publicKey) ||
        digest(cert.publicKey.export({ type: 'spki', format: 'der' })) !== entry.keyHash
      )
        throw new Error('Invalid device record');
    }
    return { raw, state };
  }
  private async save(raw: string, state: RecordV1) {
    await this.store.replace(raw, JSON.stringify(state));
  }
  /** Explicit enrollment setup only. Never called by construction, launch or read. */
  async initialize() {
    if ((await this.store.read()) !== null) throw new Error('Pairing identity already exists');
    const keys = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
    const issuer = await x509.X509CertificateGenerator.createSelfSigned(
      {
        name: 'CN=FreeLM Local Pairing',
        keys,
        signingAlgorithm: algorithm,
        notBefore: new Date(this.now() - 60000),
        notAfter: new Date(this.now() + 365 * 86400000),
        extensions: [
          new x509.BasicConstraintsExtension(true, 0, true),
          new x509.KeyUsagesExtension(
            x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
            true,
          ),
        ],
      },
      crypto,
    );
    const state: RecordV1 = {
      version: 1,
      hostId: digest(Buffer.from(issuer.rawData)),
      issuer: issuer.toString('pem'),
      privateKey: Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey)).toString(
        'base64',
      ),
      revoked: [],
    };
    await this.store.create(JSON.stringify(state));
  }
  /** Public status for the local Mac UI. Never returns issuer private material. */
  async localStatus() {
    const { state } = await this.load();
    return {
      issuerId: state.hostId,
      pending:
        state.request && state.request.expires > this.now()
          ? {
              requestId: state.request.id,
              keyHash: state.request.keyHash,
              expires: state.request.expires,
              approved: !!state.request.certificate,
            }
          : null,
      active: state.active
        ? {
            requestId: state.active.requestId,
            keyHash: state.active.keyHash,
            expiresAt: Date.parse(new NodeCertificate(state.active.certificate).validTo),
          }
        : null,
    };
  }
  /** Main-process-only TLS material. Leaf keys rotate at listener start; QR pins the durable root. */
  async serverCredentials(hostname: string) {
    const { state } = await this.load();
    if (!hostname || hostname.length > 253 || /[\s/\\]/.test(hostname))
      throw new Error('Invalid host');
    const keys = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
    const signingKey = await crypto.subtle.importKey(
      'pkcs8',
      Buffer.from(state.privateKey, 'base64'),
      algorithm,
      false,
      ['sign'],
    );
    const { isIP } = await import('node:net');
    const cert = await x509.X509CertificateGenerator.create(
      {
        issuer: new x509.X509Certificate(state.issuer).subject,
        subject: 'CN=FreeLM local host',
        publicKey: keys.publicKey,
        signingKey,
        signingAlgorithm: algorithm,
        notBefore: new Date(this.now() - 60000),
        notAfter: new Date(
          Math.min(this.now() + 86400000, Date.parse(new NodeCertificate(state.issuer).validTo)),
        ),
        extensions: [
          new x509.BasicConstraintsExtension(false, undefined, true),
          new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
          new x509.ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1'], true),
          new x509.SubjectAlternativeNameExtension([
            { type: isIP(hostname) ? 'ip' : 'dns', value: hostname },
          ]),
        ],
      },
      crypto,
    );
    const bytes = Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey));
    return {
      cert: cert.toString('pem'),
      key: `-----BEGIN PRIVATE KEY-----\n${bytes.toString('base64')}\n-----END PRIVATE KEY-----`,
      ca: state.issuer,
    };
  }
  /** Keep authorization and a bounded host operation indivisible relative to revoke. */
  async withAuthorization<T>(socket: TLSSocket, operation: (check: () => void) => Promise<T>) {
    const epoch = await this.serialized(async () => {
      await this.authorizeLocked(socket);
      return this.scope.epoch;
    });
    const check = () => {
      if (this.scope.epoch !== epoch || socket.destroyed)
        throw new PairingAuthorizationError('Device revoked');
    };
    check();
    return operation(check);
  }
  async revokeDevice(socket: TLSSocket) {
    return this.serialized(async () => {
      await this.authorizeLocked(socket);
      await this.revokeLocked(socket);
    });
  }
  async invite(endpoint: string): Promise<LocalInvitation> {
    const { raw, state } = await this.load();
    if (state.active) throw new Error('Revoke the current phone before inviting another');
    const secret = token();
    const invitation = { id: token(), secretHash: digest(secret), expires: this.now() + lifetime };
    const result: LocalInvitation = {
      version: 3,
      endpoint,
      hostId: state.hostId,
      rootCertificate: state.issuer,
      invitationId: invitation.id,
      secret,
      expires: invitation.expires,
    };
    parseLocalInvitation(JSON.stringify(result), this.now());
    state.invitation = invitation;
    delete state.request;
    await this.save(raw, state);
    return result;
  }
  /** Bootstrap request over QR-anchored TLS. PKCS#10 verifies possession; no requested CSR extensions are trusted. */
  async request(invitationId: string, secret: string, csrPEM: string) {
    if (typeof csrPEM !== 'string' || csrPEM.length > 8192 || !/^[a-f0-9]{64}$/.test(secret))
      throw new Error('Invalid request');
    const { raw, state } = await this.load();
    const invite = state.invitation;
    if (
      !invite ||
      state.active ||
      invite.id !== invitationId ||
      invite.secretHash !== digest(secret) ||
      invite.expires <= this.now()
    )
      throw new Error('Invitation unavailable');
    const csr = new x509.Pkcs10CertificateRequest(csrPEM);
    const key = await csr.publicKey.export(algorithm, ['verify'], crypto);
    if (
      key.algorithm.name !== 'ECDSA' ||
      (key.algorithm as EcKeyAlgorithm).namedCurve !== 'P-256' ||
      !(await csr.verify(crypto))
    )
      throw new Error('Invalid proof of possession');
    const keyHash = digest(Buffer.from(csr.publicKey.rawData));
    const request: Request = {
      invitationId,
      secretHash: invite.secretHash,
      id: token(),
      keyHash,
      csr: csrPEM,
      expires: invite.expires,
    };
    state.request = request;
    delete state.invitation;
    await this.save(raw, state);
    return { requestId: request.id, keyHash, expires: request.expires };
  }
  /** Bounded bootstrap status, authenticated with the consumed invite secret.
   * Recovers a lost request/approval response without granting Bots access. */
  async status(invitationId: string, secret: string) {
    if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('Invalid request');
    const { state } = await this.load();
    const request = state.request;
    if (
      !request ||
      request.invitationId !== invitationId ||
      request.secretHash !== digest(secret) ||
      request.expires <= this.now()
    )
      throw new Error('Request unavailable');
    return {
      requestId: request.id,
      keyHash: request.keyHash,
      expires: request.expires,
      certificate: request.certificate ?? null,
    };
  }
  /** LOCAL Mac approval only; never expose this method through a mobile route. */
  async approve(requestId: string, displayedKeyHash: string) {
    const { raw, state } = await this.load();
    const request = state.request;
    if (
      !request ||
      request.id !== requestId ||
      request.keyHash !== displayedKeyHash ||
      request.expires <= this.now() ||
      state.active
    )
      throw new Error('Approval no longer valid');
    if (request.certificate) return request.certificate;
    const csr = new x509.Pkcs10CertificateRequest(request.csr);
    if (
      !(await csr.verify(crypto)) ||
      digest(Buffer.from(csr.publicKey.rawData)) !== request.keyHash
    )
      throw new Error('Invalid request');
    const signingKey = await crypto.subtle.importKey(
      'pkcs8',
      Buffer.from(state.privateKey, 'base64'),
      algorithm,
      false,
      ['sign'],
    );
    const certificate = await x509.X509CertificateGenerator.create(
      {
        issuer: new x509.X509Certificate(state.issuer).subject,
        subject: `CN=${request.id}`,
        publicKey: csr.publicKey,
        signingKey,
        signingAlgorithm: algorithm,
        notBefore: new Date(this.now() - 60000),
        notAfter: new Date(this.now() + 86400000),
        extensions: [
          new x509.BasicConstraintsExtension(false, undefined, true),
          new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
          new x509.ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.2'], true),
        ],
      },
      crypto,
    );
    const pem = certificate.toString('pem');
    if (!new NodeCertificate(pem).verify(new NodeCertificate(state.issuer).publicKey))
      throw new Error('Issuer key mismatch');
    request.certificate = pem;
    await this.save(raw, state);
    return pem;
  }
  async deny(requestId: string) {
    const { raw, state } = await this.load();
    if (state.request?.id !== requestId) throw new Error('Request unavailable');
    delete state.request;
    await this.save(raw, state);
  }
  private peer(socket: TLSSocket) {
    if (!socket.encrypted || !socket.authorized)
      throw new PairingAuthorizationError('Authenticated TLS required');
    const cert = socket.getPeerCertificate();
    if (!cert.raw) throw new PairingAuthorizationError('Client identity required');
    return new NodeCertificate(cert.raw);
  }
  async activate(requestId: string, socket: TLSSocket) {
    const cert = this.peer(socket);
    const { raw, state } = await this.load();
    const fingerprint = digest(cert.raw);
    if (state.revoked.includes(fingerprint)) throw new PairingAuthorizationError('Device revoked');
    if (
      state.active?.requestId === requestId &&
      digest(new NodeCertificate(state.active.certificate).raw) === fingerprint
    )
      return;
    const request = state.request;
    if (
      !request?.certificate ||
      request.id !== requestId ||
      request.expires <= this.now() ||
      state.active ||
      digest(new NodeCertificate(request.certificate).raw) !== fingerprint
    )
      throw new PairingAuthorizationError('Activation unavailable');
    state.active = { requestId, certificate: request.certificate, keyHash: request.keyHash };
    delete state.request;
    delete state.invitation;
    await this.save(raw, state);
  }
  /** Recheck on EVERY Bots operation, including resumed TLS sessions. */
  async authorize(socket: TLSSocket) {
    return this.serialized(() => this.authorizeLocked(socket));
  }
  private async authorizeLocked(socket: TLSSocket) {
    const cert = this.peer(socket);
    const { state } = await this.load();
    const fingerprint = digest(cert.raw);
    if (
      !state.active ||
      state.revoked.includes(fingerprint) ||
      digest(new NodeCertificate(state.active.certificate).raw) !== fingerprint ||
      Date.parse(cert.validTo) <= this.now()
    )
      throw new PairingAuthorizationError('Device not authorized');
    if (!this.scope.connections.has(socket)) {
      this.scope.connections.add(socket);
      socket.once('close', () => this.scope.connections.delete(socket));
    }
    return state.active.keyHash;
  }
  async revoke() {
    return this.serialized(() => this.revokeLocked());
  }
  private async revokeLocked(responseSocket?: TLSSocket) {
    const { raw, state } = await this.load();
    if (state.active) state.revoked.push(digest(new NodeCertificate(state.active.certificate).raw));
    if (state.revoked.length > 128) throw new Error('Issuer rotation required');
    delete state.active;
    delete state.request;
    delete state.invitation;
    await this.save(raw, state);
    this.scope.epoch++;
    for (const socket of this.scope.connections) if (socket !== responseSocket) socket.destroy();
    this.scope.connections.clear();
  }
}
