import { constants } from 'node:fs';
import { TRANSFER_LIMIT } from './stream';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, open } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
import type { InstalledCustomNode } from '../../src/custom-node-types';
import type { WorkflowNode, WorkflowExecutionContext } from '../../src/workflow-types';
import { validateNodeManifest, validatePortValues } from './manifest';
import { executeCustomNode, nodeWorkerPath } from './runtime';
interface Package extends InstalledCustomNode {
  code: string;
}
/** Production authority is supplied by the host, never by a graph or package. */
export interface NodeAuthority {
  revoke?(id: string, digest: string): Promise<void>;
  transfer?(
    id: string,
    digest: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown>;
  openStream?(
    id: string,
    digest: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown>;
  readStream?(id: string, digest: string, token: string, signal: AbortSignal): Promise<unknown>;
  closeStream?(id: string, digest: string, token: string): Promise<unknown>;
  request?(
    packageId: string,
    digest: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown>;
  inference?(
    packageId: string,
    digest: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown>;
}
export class CustomNodeHost {
  private packages = new Map<string, Package>();
  private mutations: Promise<unknown> = Promise.resolve();
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const next = this.mutations.then(op);
    this.mutations = next.catch(() => {});
    return next;
  }
  constructor(
    private root: string,
    private authority: NodeAuthority = {},
    private workerPath?: string,
  ) {}
  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      const entries = JSON.parse(
        await readFile(path.join(this.root, 'registry.json'), 'utf8'),
      ) as Package[];
      for (const p of entries) {
        validateNodeManifest(p.manifest);
        if (
          typeof p.code !== 'string' ||
          p.digest !==
            createHash('sha256')
              .update(JSON.stringify(p.manifest) + '\n' + p.code)
              .digest('hex')
        )
          throw new Error('Invalid installed node integrity.');
        this.packages.set(p.manifest.id + '@' + p.manifest.version, p);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  list(): InstalledCustomNode[] {
    return [...this.packages.values()].map(({ manifest, digest }) => ({
      manifest: structuredClone(manifest),
      digest,
    }));
  }
  private async persist(next: Map<string, Package>) {
    const tmp = path.join(this.root, randomUUID() + '.tmp');
    await writeFile(tmp, JSON.stringify([...next.values()]), { mode: 0o600 });
    await rename(tmp, path.join(this.root, 'registry.json'));
    this.packages = next;
  }
  install(source: string) {
    return this.enqueue(() => this.installPackage(source));
  }
  private async installPackage(source: string) {
    if (typeof source !== 'string' || Buffer.byteLength(source) > 1024 * 1024)
      throw new Error('Node package exceeds 1 MiB.');
    const pkg = JSON.parse(source);
    validateNodeManifest(pkg.manifest);
    if (typeof pkg.source !== 'string') throw new Error('Package requires TypeScript source.');
    const code = await new Promise<string>((resolve, reject) => {
      const worker = new Worker(
        this.workerPath
          ? path.join(path.dirname(this.workerPath), 'custom-node-compiler-worker.cjs')
          : nodeWorkerPath('compiler'),
        { env: {}, workerData: { source: pkg.source }, resourceLimits: { maxOldGenerationSizeMb: 128 } },
      );
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        void worker.terminate();
        reject(new Error('Node compilation timed out.'));
      }, 30000);
      const finish = () => {
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
      };
      worker.once('error', (e) => {
        if (settled) return;
        finish();
        reject(e);
      });
      worker.once('exit', (code) => {
        if (settled) return;
        finish();
        reject(new Error(`Node compiler exited before completion (${code}).`));
      });
      worker.once('message', (v) => {
        if (settled) return;
        finish();
        if (v.error) reject(new Error(v.error));
        else if (typeof v.code !== 'string' || v.code.length > 4 * 1024 * 1024)
          reject(new Error('Invalid compiled node.'));
        else resolve(v.code);
      });
    });
    const digest = createHash('sha256')
      .update(JSON.stringify(pkg.manifest) + '\n' + code)
      .digest('hex');
    const key = pkg.manifest.id + '@' + pkg.manifest.version;
    const old = this.packages.get(key);
    if (old && old.digest !== digest)
      throw new Error(
        'This version is already installed with different content. Increment the version.',
      );
    const next = new Map(this.packages);
    next.set(key, { manifest: pkg.manifest, code, digest });
    await this.persist(next);
    return this.list();
  }
  remove(id: string, version: string) {
    return this.enqueue(() => this.removePackage(id, version));
  }
  private async removePackage(id: string, version: string) {
    const installed = this.packages.get(id + '@' + version);
    if (installed) await this.authority.revoke?.(id, installed.digest);
    const next = new Map(this.packages);
    next.delete(id + '@' + version);
    await this.persist(next);
  }
  async discover(
    reference: NonNullable<WorkflowNode['custom']>,
    config: Record<string, unknown>,
    signal: AbortSignal,
  ) {
    return this.execute(
      {
        id: 'discovery',
        type: 'custom',
        label: 'Discovery',
        position: { x: 0, y: 0 },
        config,
        custom: reference,
      },
      {},
      {
        signal,
        workflow: {} as WorkflowExecutionContext['workflow'],
        run: { id: randomUUID(), nodes: {} } as WorkflowExecutionContext['run'],
      },
      'discover',
    );
  }
  async execute(
    node: WorkflowNode,
    inputs: Record<string, unknown>,
    ctx: WorkflowExecutionContext,
    operation: 'execute' | 'discover' = 'execute',
  ) {
    const ref = node.custom;
    const pkg = ref && this.packages.get(ref.packageId + '@' + ref.version);
    if (!pkg || pkg.digest !== ref?.digest)
      throw new Error('Custom node version is missing or changed. Reinstall the pinned package.');
    if ((ctx.run.nodes[node.id]?.attempt ?? 1) > 1 && !pkg.manifest.retrySafe)
      throw new Error(
        'This node does not declare safe retries. Inspect any remote job before starting a new run.',
      );
    if (operation === 'execute') validatePortValues(pkg.manifest.inputs, inputs);
    const artifactRoot = path.join(this.root, 'artifacts');
    await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
    // Only artifact capabilities supplied on input or created in this invocation may be read.
    const readable = new Set<string>();
    const scan = (v: unknown): void => {
      if (v && typeof v === 'object') {
        if ('id' in v && typeof v.id === 'string' && 'kind' in v && v.kind === 'file')
          readable.add(v.id);
        for (const x of Object.values(v)) scan(x);
      }
    };
    scan(inputs);
    const streams = new Set<string>();
    let storedBytes = 0,
      storedFiles = 0;
    const readArtifact = async (value: unknown) => {
      const a = value as { id?: string };
      if (!a || !a.id || !readable.has(a.id) || !/^[a-f0-9-]{36}$/.test(a.id))
        throw new Error('Artifact read denied.');
      const file = await open(
        path.join(artifactRoot, a.id),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > TRANSFER_LIMIT)
          throw new Error('Artifact exceeds the 64 MiB transfer limit.');
        const bytes = await file.readFile();
        if (bytes.length > TRANSFER_LIMIT) throw new Error('Artifact grew beyond its limit.');
        return bytes;
      } finally {
        await file.close();
      }
    };
    const storeArtifact = async (bytes: Buffer, name: unknown, mimeType: unknown) => {
      ctx.signal.throwIfAborted();
      if (bytes.length > TRANSFER_LIMIT) throw new Error('Artifact exceeds 64 MiB.');
      storedBytes += bytes.length;
      if (storedBytes > 128 * 1024 * 1024 || ++storedFiles > 64)
        throw new Error('Invocation artifact quota exceeded.');
      const id = randomUUID();
      await writeFile(path.join(artifactRoot, id), bytes, { mode: 0o600, flag: 'wx' });
      readable.add(id);
      return {
        kind: 'file',
        id,
        name: String(name ?? 'artifact.bin').slice(0, 160),
        mimeType: String(mimeType ?? 'application/octet-stream').slice(0, 200),
        size: bytes.length,
      };
    };
    const allowNetwork = (args: Record<string, unknown>) => {
      const u = new URL(String(args.url));
      if (!pkg.manifest.permissions.network?.includes(u.origin) || u.username || u.password)
        throw new Error('Custom node network permission is not granted.');
    };
    const output = await executeCustomNode(
      {
        code: pkg.code,
        kind: 'tool',
        name: operation,
        args: { inputs, config: node.config },
        account: { id: pkg.manifest.id, label: pkg.manifest.title },
        operationId: ctx.run.id + ':' + node.id,
        signal: ctx.signal,
        workerPath: this.workerPath,
        wallTimeoutMs: 120000,
      },
      async (method, args, signal) => {
        const abort = signal ?? ctx.signal;
        abort.throwIfAborted();
        if (method === 'progress') {
          ctx.onProgress?.(String(args.message).slice(0, 2000));
          return null;
        }
        if (method === 'sleep') {
          const ms = Number(args.milliseconds);
          if (!Number.isFinite(ms) || ms < 0 || ms > 30000)
            throw new Error('Sleep must be between 0 and 30000 ms.');
          await delay(ms, undefined, { signal: abort });
          return null;
        }
        if (method === 'artifact.write' || method === 'artifact.writeBytes') {
          const content = method === 'artifact.write' ? args.text : args.base64;
          if (typeof content !== 'string' || content.length > 700000)
            throw new Error('Inline artifact exceeds 512 KiB.');
          if (
            method === 'artifact.writeBytes' &&
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)
          )
            throw new Error('Invalid artifact base64.');
          const bytes = Buffer.from(content, method === 'artifact.write' ? 'utf8' : 'base64');
          if (bytes.length > 512 * 1024) throw new Error('Inline artifact exceeds 512 KiB.');
          return storeArtifact(bytes, args.name, args.mimeType);
        }
        if (method === 'artifact.read' || method === 'artifact.readBytes') {
          const bytes = await readArtifact(args.artifact);
          if (method === 'artifact.read') {
            if (bytes.length > 512 * 1024)
              throw new Error('Text reads are limited to 512 KiB; use ranged binary reads.');
            return bytes.toString('utf8');
          }
          const offset = Number(args.offset ?? 0),
            length = Number(args.length ?? 384 * 1024);
          if (
            !Number.isSafeInteger(offset) ||
            offset < 0 ||
            !Number.isSafeInteger(length) ||
            length < 0 ||
            length > 384 * 1024
          )
            throw new Error('Invalid artifact byte range.');
          return {
            base64: bytes.subarray(offset, offset + length).toString('base64'),
            size: bytes.length,
          };
        }
        if (method === 'download' || method === 'upload') {
          allowNetwork(args);
          if (!this.authority.transfer) throw new Error('Node transfers are unavailable.');
          const request = { ...args, direction: method };
          if (method === 'upload') {
            const artifact = args.artifact as { name?: string; mimeType?: string };
            Object.assign(request, {
              bytes: await readArtifact(artifact),
              name: artifact.name,
              mimeType: artifact.mimeType,
            });
          }
          const result = (await this.authority.transfer(
            pkg.manifest.id,
            pkg.digest,
            request,
            abort,
          )) as { status: number; headers: Record<string, string>; body: unknown };
          if (method === 'upload') return result;
          if (!(result.body instanceof Uint8Array))
            throw new Error('Download did not return binary data.');
          return {
            status: result.status,
            headers: result.headers,
            artifact: await storeArtifact(
              Buffer.from(result.body),
              args.name,
              result.headers['content-type'] ?? 'application/octet-stream',
            ),
          };
        }
        if (method === 'stream.open') {
          allowNetwork(args);
          if (!this.authority.openStream || streams.size >= 4)
            throw new Error('Node streaming is unavailable or its limit was reached.');
          const result = (await this.authority.openStream(
            pkg.manifest.id,
            pkg.digest,
            args,
            abort,
          )) as { streamId: string };
          streams.add(result.streamId);
          return result;
        }
        if (method === 'stream.read' || method === 'stream.close') {
          const token = String(args.streamId);
          if (!streams.has(token)) throw new Error('Stream does not belong to this invocation.');
          if (method === 'stream.close') {
            streams.delete(token);
            return this.authority.closeStream?.(pkg.manifest.id, pkg.digest, token);
          }
          return this.authority.readStream?.(pkg.manifest.id, pkg.digest, token, abort);
        }
        if (method === 'request') {
          allowNetwork(args);
          if (!this.authority.request)
            throw new Error('Custom node network permission is not granted.');
          return this.authority.request(pkg.manifest.id, pkg.digest, args, abort);
        }
        if (method === 'inference') {
          if (!pkg.manifest.permissions.inference || !this.authority.inference)
            throw new Error('Custom node inference permission is not granted.');
          return this.authority.inference(pkg.manifest.id, pkg.digest, args, abort);
        }
        throw new Error('Unknown custom node service.');
      },
    );
    if (operation === 'execute')
      validatePortValues(pkg.manifest.outputs, output as Record<string, unknown>);
    return output as Record<string, unknown>;
  }
}
