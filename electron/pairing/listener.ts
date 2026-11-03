import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TLSSocket } from 'node:tls';
import type { Duplex } from 'node:stream';
import { WorkspaceConflictError } from '../workspace-authority';
import { LocalEnrollment, PairingAuthorizationError } from './enrollment';

const json = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
};
async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 16384) throw Error('Request too large');
    chunks.push(Buffer.from(chunk));
  }
  const value = JSON.parse(Buffer.concat(chunks).toString());
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid request');
  return value as Record<string, unknown>;
}
const string = (value: unknown) => {
  if (typeof value !== 'string') throw Error('Invalid request');
  return value;
};

/** Dedicated TLS surface; it has no owner API or network approval route. */
export class LocalPairingListener {
  private server?: Server;
  private sockets = new Set<Duplex>();
  endpoint?: string;
  private attempts = 0;
  private window = 0;
  constructor(
    readonly enrollment: LocalEnrollment,
    private readonly workspaceHost: { id: string; name: string },
    private readonly bots: (
      req: IncomingMessage,
      res: ServerResponse,
      check: () => void,
    ) => Promise<void>,
  ) {}
  async start(endpoint: string, bindAddress: string) {
    if (this.server) throw Error('Local pairing already started');
    const url = new URL(endpoint);
    if (
      (url.port === '0' && !['127.0.0.1', '::1'].includes(bindAddress)) ||
      url.protocol !== 'https:' ||
      !url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      !bindAddress
    )
      throw Error('Invalid local endpoint');
    const credentials = await this.enrollment.serverCredentials(
      url.hostname.replace(/^\[|\]$/g, ''),
    );
    const server = createServer(
      { ...credentials, minVersion: 'TLSv1.3', requestCert: true, rejectUnauthorized: false },
      (req, res) => {
        // Bootstrap has no client certificate yet. All Bots routes independently require mTLS.
        void this.handle(req, res, url.host).catch((error: unknown) => {
          const status =
            error instanceof WorkspaceConflictError
              ? 409
              : error instanceof PairingAuthorizationError
                ? 401
                : typeof error === 'object' &&
                    error !== null &&
                    'status' in error &&
                    [400, 401, 403, 409, 429].includes(Number(error.status))
                  ? Number(error.status)
                  : 503;
          if (res.headersSent) res.destroy();
          else
            json(res, status, {
              error:
                status === 409
                  ? 'Preferences changed. Reload before saving.'
                  : status === 401
                    ? 'Device access expired or was revoked.'
                    : 'Request unavailable. Retry without changing credentials.',
            });
        });
      },
    );
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    server.maxHeadersCount = 32;
    server.maxConnections = 32;
    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(Number(url.port), bindAddress, resolve);
      });
      url.port = String((server.address() as { port: number }).port);
      this.endpoint = url.origin;
    } catch (error) {
      this.server = undefined;
      server.close();
      throw error;
    }
  }
  private async handle(req: IncomingMessage, res: ServerResponse, host: string) {
    if (
      req.headers.origin !== undefined ||
      req.headers.host !== host ||
      req.headers.authorization !== undefined
    )
      throw Object.assign(Error('Invalid origin'), { status: 403 });
    const route = `${req.method} ${req.url}`;
    if (route.startsWith('POST /local-pairing/')) {
      if (req.headers['content-type'] !== 'application/json') throw Error('JSON required');
      if (Date.now() - this.window > 60000) {
        this.window = Date.now();
        this.attempts = 0;
      }
      if (++this.attempts > 60) {
        json(res, 429, { error: 'Try again later.' });
        return;
      }
      const value = await body(req);
      if (route === 'POST /local-pairing/request')
        json(
          res,
          200,
          await this.enrollment.request(
            string(value.invitationId),
            string(value.secret),
            string(value.csr),
          ),
        );
      else if (route === 'POST /local-pairing/status')
        json(
          res,
          200,
          await this.enrollment.status(string(value.invitationId), string(value.secret)),
        );
      else if (route === 'POST /local-pairing/activate') {
        await this.enrollment.activate(string(value.requestId), req.socket as TLSSocket);
        const active = (await this.enrollment.localStatus()).active;
        json(res, 200, {
          expiresAt: active?.expiresAt,
          hostId: this.workspaceHost.id,
          hostName: this.workspaceHost.name,
          capabilities: ['bots.read', 'bots.send', 'preferences.sound'],
          replication: false,
        });
      } else throw Object.assign(Error('No network approval route'), { status: 403 });
      return;
    }
    if (route === 'POST /mobile/disconnect') {
      await this.enrollment.revokeDevice(req.socket as TLSSocket);
      res.once('finish', () => req.socket.destroy());
      json(res, 200, { revoked: true });
      return;
    }
    const allowed = new Set([
      'GET /mobile/snapshot',
      'POST /mobile/send',
      'GET /mobile/preferences',
      'POST /mobile/preferences',
    ]);
    if (!allowed.has(route)) throw Object.assign(Error('Bots only'), { status: 403 });
    await this.enrollment.withAuthorization(req.socket as TLSSocket, (check) =>
      this.bots(req, res, check),
    );
  }
  async invite() {
    if (!this.endpoint) throw Error('Start local sharing first');
    return {
      ...(await this.enrollment.invite(this.endpoint)),
      workspaceHostId: this.workspaceHost.id,
      hostName: this.workspaceHost.name,
    };
  }
  async stop() {
    const server = this.server;
    this.server = undefined;
    this.endpoint = undefined;
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of this.sockets) socket.destroy();
      });
    }
  }
}
