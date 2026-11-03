import { X509Certificate, createHash } from 'node:crypto';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WorkspaceConflictError } from './workspace-authority';

export interface MobileListenerOptions {
  cert: string;
  key: string;
  endpoint: string;
  bindAddress: string;
}

/** Explicit opt-in listener. Never routes to the desktop owner API. */
export class MobileListener {
  private server: Server | null = null;
  private pairAttempts = 0;
  private pairWindow = 0;
  private sockets = new Set<Duplex>();
  private starting: Promise<number> | null = null;
  endpoint?: string;
  certificateSHA256?: string;
  get enabled() {
    return this.server !== null;
  }
  async start(
    options: MobileListenerOptions,
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  ) {
    if (this.server || this.starting)
      throw new Error('Stop the iPhone listener before changing its settings.');
    const url = new URL(options.endpoint);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      !url.port ||
      !options.bindAddress
    )
      throw new Error('Supply an HTTPS host address with an explicit port and no path.');
    const certificate = new X509Certificate(options.cert);
    if (
      Date.parse(certificate.validFrom) > Date.now() ||
      Date.parse(certificate.validTo) <= Date.now()
    )
      throw new Error('The TLS certificate is not currently valid.');
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (!certificate.checkHost(hostname) && !certificate.checkIP(hostname))
      throw new Error('The TLS certificate must match the host address.');
    const server = createServer(
      { cert: options.cert, key: options.key, minVersion: 'TLSv1.2' },
      (req, res) => {
        const routes = new Set([
          'POST /mobile/pair',
          'POST /mobile/disconnect',
          'GET /mobile/snapshot',
          'POST /mobile/send',
          'GET /mobile/preferences',
          'POST /mobile/preferences',
        ]);
        if (
          req.headers.origin !== undefined ||
          req.headers.host !== url.host ||
          !routes.has(`${req.method} ${req.url}`)
        ) {
          res.writeHead(403);
          res.end();
          return;
        }
        if (req.url === '/mobile/pair') {
          if (Date.now() - this.pairWindow >= 60_000) {
            this.pairWindow = Date.now();
            this.pairAttempts = 0;
          }
          if (++this.pairAttempts > 20) {
            res.writeHead(429, { 'Retry-After': '60' });
            res.end();
            return;
          }
        }
        void handler(req, res).catch((error: unknown) => {
          if (res.destroyed) return;
          if (res.headersSent) {
            res.destroy();
            return;
          }
          const status =
            typeof error === 'object' && error !== null && 'status' in error
              ? Number(error.status)
              : error instanceof WorkspaceConflictError
                ? 409
                : 400;
          res.writeHead(status, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(
            JSON.stringify({
              error: error instanceof Error ? error.message : 'The request failed.',
            }),
          );
        });
      },
    );
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
    this.starting = new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(Number(url.port), options.bindAddress, () => {
        this.server = server;
        this.endpoint = url.origin;
        this.certificateSHA256 = createHash('sha256').update(certificate.raw).digest('hex');
        resolve(Number(url.port));
      });
    });
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }
  disconnect() {
    for (const socket of this.sockets) socket.destroy();
  }
  async stop() {
    if (this.starting) await this.starting.catch(() => undefined);
    const server = this.server;
    this.server = null;
    this.endpoint = undefined;
    this.certificateSHA256 = undefined;
    if (server)
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        this.disconnect();
      });
  }
}
