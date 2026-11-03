import { ByteRedactor, TRANSFER_LIMIT, STREAM_CHUNK, type NodeStream } from './stream';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SecretStorage } from '../state-store';
import type { InstalledCustomNode } from '../../src/custom-node-types';
import type { NodeAuthority } from './host';
import { guardedFetch } from '../plugins/oauth';
interface Credential {
  name: string;
  origin: string;
  header: string;
  prefix: string;
  encrypted: string;
}
interface Grant {
  network: string[];
  inference: boolean;
  secrets: Credential[];
}
/** This store is host-only and deliberately absent from workflow serialization. */
export class CustomNodeServices implements NodeAuthority {
  private grants: Record<string, Grant> = {};
  private active = new Map<string, Set<AbortController>>();
  private streams = new Map<string, NodeStream>();
  private serial: Promise<unknown> = Promise.resolve();
  constructor(
    private root: string,
    private vault: SecretStorage,
    private infer: (args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>,
    private fetcher: typeof fetch = fetch,
  ) {}
  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      this.grants = JSON.parse(await readFile(path.join(this.root, 'authority.json'), 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  private key(id: string, digest: string) {
    return id + ':' + digest;
  }
  private async persist() {
    const file = path.join(this.root, randomUUID() + '.tmp');
    await writeFile(file, JSON.stringify(this.grants), { mode: 0o600 });
    await rename(file, path.join(this.root, 'authority.json'));
  }
  private mutate(operation: () => Promise<void>) {
    const next = this.serial.then(operation);
    this.serial = next.catch(() => {});
    return next;
  }
  metadata(node: InstalledCustomNode) {
    const g = this.grants[this.key(node.manifest.id, node.digest)];
    return {
      ...node,
      grants: { network: g?.network ?? [], inference: g?.inference ?? false },
      secrets: g?.secrets.map(({ name, origin }) => ({ name, origin })) ?? [],
    };
  }
  authorize(node: InstalledCustomNode, network: string[], inference: boolean) {
    return this.mutate(async () => {
      if (
        !Array.isArray(network) ||
        network.some((o) => !node.manifest.permissions.network?.includes(o)) ||
        typeof inference !== 'boolean' ||
        (inference && !node.manifest.permissions.inference)
      )
        throw new Error('Requested services exceed the node manifest.');
      const key = this.key(node.manifest.id, node.digest);
      for (const c of this.active.get(key) ?? []) c.abort();
      this.grants[key] = {
        network: [...new Set(network)],
        inference,
        secrets: this.grants[key]?.secrets ?? [],
      };
      await this.persist();
    });
  }
  revoke(id: string, digest: string) {
    return this.mutate(async () => {
      const key = this.key(id, digest);
      for (const controller of this.active.get(key) ?? []) controller.abort();
      const grant = this.grants[key];
      if (grant) {
        this.grants[key] = { ...grant, network: [], inference: false };
        await this.persist();
      }
    });
  }
  setSecret(
    node: InstalledCustomNode,
    name: string,
    value: string,
    origin: string,
    header = 'Authorization',
    prefix = 'Bearer ',
  ) {
    return this.mutate(async () => {
      if (
        !/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(name) ||
        typeof value !== 'string' ||
        value.length > 16000 ||
        !node.manifest.permissions.network?.includes(origin) ||
        !/^[-a-zA-Z0-9]+$/.test(header) ||
        /^(host|cookie|content-length|connection|proxy-authorization)$/i.test(header) ||
        typeof prefix !== 'string' ||
        prefix.length > 100 ||
        /[\r\n]/.test(prefix + value)
      )
        throw new Error('Invalid node credential configuration.');
      if (!(await this.vault.available()))
        throw new Error('Secure credential storage is unavailable.');
      const key = this.key(node.manifest.id, node.digest);
      const grant = this.grants[key] ?? { network: [], inference: false, secrets: [] };
      grant.secrets = grant.secrets.filter((s) => s.name !== name);
      if (value)
        grant.secrets.push({
          name,
          origin,
          header,
          prefix,
          encrypted: (await this.vault.encrypt(value)).toString('base64'),
        });
      this.grants[key] = grant;
      await this.persist();
    });
  }
  private async run(
    id: string,
    digest: string,
    signal: AbortSignal,
    fn: (grant: Grant, signal: AbortSignal, retain: () => () => void) => Promise<unknown>,
  ) {
    const key = this.key(id, digest),
      g = this.grants[key];
    if (!g) throw new Error('Custom node services have not been authorized.');
    const c = new AbortController();
    const set = this.active.get(key) ?? new Set();
    set.add(c);
    this.active.set(key, set);
    let retained = false;
    const release = () => {
      set.delete(c);
      if (!set.size) this.active.delete(key);
    };
    try {
      return await fn(g, AbortSignal.any([signal, c.signal, AbortSignal.timeout(110000)]), () => {
        retained = true;
        return release;
      });
    } finally {
      if (!retained) release();
    }
  }
  request = (id: string, digest: string, args: Record<string, unknown>, signal: AbortSignal) =>
    this.perform(id, digest, args, signal, 'text');
  transfer = (id: string, digest: string, args: Record<string, unknown>, signal: AbortSignal) =>
    this.perform(id, digest, args, signal, args.direction === 'download' ? 'binary' : 'upload');
  openStream = (id: string, digest: string, args: Record<string, unknown>, signal: AbortSignal) =>
    this.perform(id, digest, args, signal, 'stream');
  private perform(
    id: string,
    digest: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    mode: 'text' | 'binary' | 'upload' | 'stream',
  ) {
    return this.run(id, digest, signal, async (g, abort, retain) => {
      const url = new URL(String(args.url));
      if (
        !g.network.includes(url.origin) ||
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.hash
      )
        throw new Error('This network origin is not authorized.');
      const method = String(args.method ?? (mode === 'upload' ? 'POST' : 'GET')).toUpperCase();
      if (!/^[A-Z]{1,16}$/.test(method) || ['CONNECT', 'TRACE'].includes(method))
        throw new Error('Unsupported HTTP method.');
      const headers = new Headers();
      if (args.headers) {
        if (typeof args.headers !== 'object' || Array.isArray(args.headers))
          throw new Error('Invalid request headers.');
        for (const [k, v] of Object.entries(args.headers)) {
          if (
            typeof v !== 'string' ||
            /^(authorization|cookie|host|content-length|connection|proxy-.*|sec-.*)$/i.test(k)
          )
            throw new Error('Use a host secret reference for authentication.');
          headers.set(k, v);
        }
      }
      let body: BodyInit | undefined;
      if (mode === 'upload') {
        if (
          !(args.bytes instanceof Uint8Array) ||
          args.bytes.byteLength > TRANSFER_LIMIT ||
          ['GET', 'HEAD'].includes(method)
        )
          throw new Error('Invalid upload artifact.');
        if (args.fieldName !== undefined) {
          if (typeof args.fieldName !== 'string' || !args.fieldName || args.fieldName.length > 200)
            throw new Error('Invalid upload field.');
          const form = new FormData();
          if (args.fields) {
            if (
              typeof args.fields !== 'object' ||
              Array.isArray(args.fields) ||
              Object.keys(args.fields).length > 64
            )
              throw new Error('Invalid upload fields.');
            for (const [k, v] of Object.entries(args.fields)) {
              if (typeof v !== 'string' || v.length > 64000)
                throw new Error('Upload fields must be bounded text.');
              form.append(k, v);
            }
          }
          form.append(
            args.fieldName,
            new Blob([new Uint8Array(args.bytes)], {
              type: String(args.mimeType ?? 'application/octet-stream'),
            }),
            String(args.name ?? 'upload.bin'),
          );
          headers.delete('content-type');
          body = form;
        } else body = new Uint8Array(args.bytes);
      } else if (args.body !== undefined) {
        if (
          typeof args.body !== 'string' ||
          Buffer.byteLength(args.body) > 512 * 1024 ||
          ['GET', 'HEAD'].includes(method)
        )
          throw new Error('Invalid or oversized request body.');
        body = args.body;
      }
      if (args.idempotencyKey !== undefined) {
        if (typeof args.idempotencyKey !== 'string' || args.idempotencyKey.length > 200)
          throw new Error('Invalid idempotency key.');
        headers.set('Idempotency-Key', args.idempotencyKey);
      }
      let secret = '';
      if (args.secret) {
        const name = (args.secret as { secretRef?: string }).secretRef;
        const stored = g.secrets.find((s) => s.name === name && s.origin === url.origin);
        if (!stored) throw new Error('Secret reference is missing or bound to another origin.');
        secret = await this.vault.decrypt(Buffer.from(stored.encrypted, 'base64'));
        headers.set(stored.header, stored.prefix + secret);
      }
      abort.throwIfAborted();
      try {
        const response = await guardedFetch(
          this.fetcher,
          url.href,
          abort,
          mode === 'binary' || mode === 'stream' ? TRANSFER_LIMIT : 512 * 1024,
        )(url.href, { method, headers, body });
        const clean = (v: string) => new ByteRedactor(secret).push(Buffer.from(v), true).toString();
        const metadata = {
          status: response.status,
          headers: Object.fromEntries(
            [...response.headers]
              .filter(
                ([k]) =>
                  !/^(set-cookie|authorization|proxy-authenticate|www-authenticate)$/i.test(k),
              )
              .map(([k, v]) => [k, clean(v)]),
          ),
        };
        if (mode === 'stream') {
          if (this.streams.size >= 32) {
            await response.body?.cancel();
            throw new Error('Too many open streams.');
          }
          const token = randomUUID();
          const reader = (
            response.body ??
            new ReadableStream<Uint8Array>({
              start(c) {
                c.close();
              },
            })
          ).getReader();
          const release = retain();
          const cleanup = () => {
            this.streams.delete(token);
            abort.removeEventListener('abort', cancel);
            void reader.cancel().catch(() => {});
            release();
          };
          const cancel = () => cleanup();
          this.streams.set(token, {
            owner: this.key(id, digest),
            reader,
            signal: abort,
            redactor: new ByteRedactor(secret),
            decoder: new TextDecoder(),
            format: args.format === 'base64' ? 'base64' : 'text',
            bytes: 0,
            pending: Buffer.alloc(0),
            reading: false,
            cleanup,
          });
          abort.addEventListener('abort', cancel, { once: true });
          if (abort.aborted) {
            cleanup();
            abort.throwIfAborted();
          }
          return { ...metadata, streamId: token };
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        abort.throwIfAborted();
        const redacted = new ByteRedactor(secret).push(bytes, true);
        return { ...metadata, body: mode === 'binary' ? redacted : redacted.toString('utf8') };
      } catch {
        throw new Error(
          'Custom node request failed, was cancelled, redirected, or exceeded its response limit.',
        );
      }
    });
  }
  async readStream(id: string, digest: string, token: string, signal: AbortSignal) {
    const stream = this.streams.get(token);
    if (!stream || stream.owner !== this.key(id, digest))
      throw new Error('Stream is unavailable or not owned by this node.');
    if (stream.reading) throw new Error('Concurrent stream reads are not allowed.');
    stream.reading = true;
    try {
      signal.throwIfAborted();
      stream.signal.throwIfAborted();
      while (!stream.pending.length) {
        const { done, value } = await stream.reader.read();
        stream.signal.throwIfAborted();
        signal.throwIfAborted();
        if (value) {
          stream.bytes += value.byteLength;
          if (stream.bytes > TRANSFER_LIMIT) throw new Error('Stream size limit exceeded.');
        }
        stream.pending = stream.redactor.push(value ?? new Uint8Array(), done);
        if (done) {
          const chunk =
            stream.format === 'base64'
              ? stream.pending.toString('base64')
              : stream.decoder.decode(stream.pending);
          stream.cleanup();
          return { done: true, chunk };
        }
      }
      const chunk = stream.pending.subarray(0, STREAM_CHUNK);
      stream.pending = stream.pending.subarray(chunk.length);
      return {
        done: false,
        chunk:
          stream.format === 'base64'
            ? chunk.toString('base64')
            : stream.decoder.decode(chunk, { stream: true }),
      };
    } catch {
      stream.cleanup();
      throw new Error('Custom node stream failed or was cancelled.');
    } finally {
      stream.reading = false;
    }
  }
  async closeStream(id: string, digest: string, token: string) {
    const stream = this.streams.get(token);
    if (stream) {
      if (stream.owner !== this.key(id, digest))
        throw new Error('Stream is not owned by this node.');
      stream.cleanup();
    }
    return null;
  }

  inference = (id: string, digest: string, args: Record<string, unknown>, signal: AbortSignal) =>
    this.run(id, digest, signal, async (g, abort) => {
      if (!g.inference) throw new Error('FreeLM inference is not authorized for this node.');
      try {
        return await this.infer(args, abort);
      } catch {
        throw new Error('FreeLM inference failed or was cancelled.');
      }
    });
}
