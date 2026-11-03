import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CustomNodeServices } from '../electron/custom-nodes/services';
import { CustomNodeHost } from '../electron/custom-nodes/host';
import { ByteRedactor } from '../electron/custom-nodes/stream';
import { parseSSE } from '../packages/custom-node-sdk';
import type { WorkflowNode, WorkflowExecutionContext } from '../src/workflow-types';
const manifest = {
  id: 'transfers',
  version: '1.0.0',
  title: 'Synthetic transfer',
  description: 'Synthetic',
  inputs: [],
  outputs: [],
  fields: [],
  permissions: { network: ['https://synthetic.test'] },
  retrySafe: false,
  discovery: true,
};
const vault = {
  available: async () => true,
  encrypt: (s: string) => Buffer.from(s.split('').reverse().join('')),
  decrypt: async (b: Buffer) => b.toString().split('').reverse().join(''),
};
async function fixture(source: string, fetcher: typeof fetch) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'freelm-node-transfer-'));
  const svc = new CustomNodeServices(path.join(root, 'auth'), vault, async () => null, fetcher);
  await svc.init();
  const host = new CustomNodeHost(
    path.join(root, 'nodes'),
    svc,
    path.resolve(
      process.env.FREELM_NODE_WORKER_DIRECTORY ?? 'dist-electron',
      'custom-node-runtime-worker.cjs',
    ),
  );
  await host.init();
  await host.install(JSON.stringify({ manifest, source }));
  const p = host.list()[0];
  await svc.authorize(p, manifest.permissions.network, false);
  const node: WorkflowNode = {
    id: 'node',
    type: 'custom',
    label: 'Synthetic',
    config: {},
    position: { x: 0, y: 0 },
    custom: {
      packageId: p.manifest.id,
      version: p.manifest.version,
      digest: p.digest,
      definition: p.manifest,
    },
  };
  const context = (signal = new AbortController().signal): WorkflowExecutionContext => ({
    signal,
    workflow: {} as never,
    run: { id: 'test', nodes: { node: { attempt: 1 } } } as never,
  });
  return {
    root,
    svc,
    host,
    node,
    p,
    context,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
describe('custom node binary and streaming services', () => {
  it('downloads binary larger than the JSON bridge, uploads multipart/raw, persists and range-reads bytes', async () => {
    const bytes = Buffer.alloc(2 * 1024 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    let multipart = 0,
      raw = 0;
    const f = await fixture(
      `export default {async execute(i,c){const downloaded=i.file?{artifact:i.file}:await c.download({url:'https://synthetic.test/file',name:'structure.bin'});const part=await c.artifacts.readBytes(downloaded.artifact,1048574,8);await c.upload({url:'https://synthetic.test/multipart',artifact:downloaded.artifact,fieldName:'file',fields:{model:'fixture'},idempotencyKey:c.operationId});await c.upload({url:'https://synthetic.test/raw',method:'PUT',artifact:downloaded.artifact});const small=await c.artifacts.writeBytes('tiny.bin','application/octet-stream','AP+A');return {file:downloaded.artifact,part,small:await c.artifacts.readBytes(small)}}}`,
      async (url, init) => {
        if (String(url).endsWith('/file'))
          return new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } });
        if (String(url).endsWith('/multipart')) {
          multipart++;
          const form = init?.body as FormData;
          expect(form.get('model')).toBe('fixture');
          expect(Buffer.from(await (form.get('file') as Blob).arrayBuffer())).toEqual(bytes);
          expect(new Headers(init?.headers).has('content-type')).toBe(false);
          expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('test:node');
        } else {
          raw++;
          expect(Buffer.from(init?.body as Uint8Array)).toEqual(bytes);
          expect(init?.method).toBe('PUT');
        }
        return new Response('ok');
      },
    );
    try {
      const out = await f.host.execute(f.node, {}, f.context());
      expect(out.part).toEqual({
        base64: bytes.subarray(1048574, 1048582).toString('base64'),
        size: bytes.length,
      });
      expect(out.small).toEqual({ base64: 'AP+A', size: 3 });
      const restored = new CustomNodeHost(
        path.join(f.root, 'nodes'),
        f.svc,
        path.resolve(
          process.env.FREELM_NODE_WORKER_DIRECTORY ?? 'dist-electron',
          'custom-node-runtime-worker.cjs',
        ),
      );
      await restored.init();
      await restored.execute(
        JSON.parse(JSON.stringify(f.node)),
        { file: JSON.parse(JSON.stringify(out.file)) },
        f.context(),
      );
      expect(multipart).toBe(2);
      expect(raw).toBe(2);
    } finally {
      await f.cleanup();
    }
  }, 30000);
  it('yields SSE before EOF, redacts split secrets, decodes split UTF-8, and never reconnects', async () => {
    let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined;
    let calls = 0;
    const enc = new TextEncoder();
    const f = await fixture(
      `import {parseSSE} from '@freelm/custom-node-sdk';export default {async execute(i,c){const events=[];for await(const event of parseSSE(c.stream({url:'https://synthetic.test/events',secret:{secretRef:'key'}}))){events.push(event);await c.progress(event.data);}return {events}}}`,
      async () => {
        calls++;
        return new Response(
          new ReadableStream({
            start(c) {
              ctrl = c;
              c.enqueue(enc.encode('id: 1\r\ndata: first\r\n\r\n:' + '.'.repeat(40) + '\r\n'));
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    );
    try {
      await f.svc.setSecret(f.p, 'key', 'synthetic-secret', 'https://synthetic.test');
      const ctx = f.context();
      ctx.onProgress = (message) => {
        if (message === 'first') {
          const next = enc.encode('event: result\ndata: λ synthetic-secret\ndata: second line\n\n');
          for (let i = 0; i < next.length; i++) ctrl!.enqueue(next.subarray(i, i + 1));
          ctrl!.close();
        }
      };
      const result = await f.host.execute(f.node, {}, ctx);
      expect(result.events).toEqual([
        { event: 'message', id: '1', data: 'first' },
        { event: 'result', id: '1', data: 'λ [redacted]\nsecond line' },
      ]);
      expect(calls).toBe(1);
    } finally {
      await f.cleanup();
    }
  }, 30000);
  it('closes early-break streams and supports permission-scoped discovery', async () => {
    let cancelled = 0;
    const f = await fixture(
      `export default {async execute(i,c){for await(const chunk of c.stream({url:'https://synthetic.test/events'})){break;}return {}},async discover(c){return {models:JSON.parse((await c.request({url:'https://synthetic.test/models'})).body)}}}`,
      async (url) =>
        String(url).endsWith('models')
          ? new Response('["synthetic-model"]')
          : new Response(
              new ReadableStream({
                start(c) {
                  c.enqueue(new TextEncoder().encode('first'));
                },
                cancel() {
                  cancelled++;
                },
              }),
            ),
    );
    try {
      await f.host.execute(f.node, {}, f.context());
      expect(cancelled).toBe(1);
      expect(await f.host.discover(f.node.custom!, {}, new AbortController().signal)).toEqual({
        models: ['synthetic-model'],
      });
      await f.svc.authorize(f.p, [], false);
      await expect(
        f.host.discover(f.node.custom!, {}, new AbortController().signal),
      ).rejects.toThrow('authorized');
    } finally {
      await f.cleanup();
    }
  }, 30000);
  it('rejects foreign stream capabilities and cancels pending reads on revocation', async () => {
    let cancelled = false;
    const f = await fixture(
      'export default {execute(){return {}}}',
      async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        ),
    );
    try {
      const opened = (await f.svc.openStream(
        f.p.manifest.id,
        f.p.digest,
        { url: 'https://synthetic.test/events' },
        new AbortController().signal,
      )) as { streamId: string };
      await expect(
        f.svc.readStream('foreign', f.p.digest, opened.streamId, new AbortController().signal),
      ).rejects.toThrow('owned');
      const reading = f.svc.readStream(
        f.p.manifest.id,
        f.p.digest,
        opened.streamId,
        new AbortController().signal,
      );
      const assertion = expect(reading).rejects.toThrow('cancelled');
      await f.svc.authorize(f.p, [], false);
      await assertion;
      expect(cancelled).toBe(true);
      await f.svc.authorize(f.p, manifest.permissions.network, false);
      const reopened = (await f.svc.openStream(
        f.p.manifest.id,
        f.p.digest,
        { url: 'https://synthetic.test/events' },
        new AbortController().signal,
      )) as { streamId: string };
      const pending = f.svc.readStream(
        f.p.manifest.id,
        f.p.digest,
        reopened.streamId,
        new AbortController().signal,
      );
      const denied = expect(pending).rejects.toThrow('cancelled');
      await f.host.remove(f.p.manifest.id, f.p.manifest.version);
      await denied;
      expect(f.svc.metadata(f.p).grants).toEqual({ network: [], inference: false });
    } finally {
      await f.cleanup();
    }
  }, 30000);
  it('streams binary chunks losslessly and aborts an in-flight empty stream', async () => {
    const bytes = Buffer.from([0, 255, 128, 240, 0, 17]);
    let cancel = false;
    const f = await fixture(
      `export default {async execute(i,c){if(i.empty){for await(const chunk of c.stream({url:'https://synthetic.test/empty'})){}return {};}const chunks=[];for await(const chunk of c.stream({url:'https://synthetic.test/binary',format:'base64'}))chunks.push(chunk);return {chunks}}}`,
      async (url) =>
        String(url).endsWith('empty')
          ? new Response(
              new ReadableStream({
                cancel() {
                  cancel = true;
                },
              }),
            )
          : new Response(
              new ReadableStream({
                start(c) {
                  c.enqueue(bytes.subarray(0, 2));
                  c.enqueue(bytes.subarray(2));
                  c.close();
                },
              }),
            ),
    );
    try {
      const out = await f.host.execute(f.node, {}, f.context());
      expect(Buffer.concat((out.chunks as string[]).map((s) => Buffer.from(s, 'base64')))).toEqual(
        bytes,
      );
      const abort = new AbortController();
      const running = f.host.execute(f.node, { empty: true }, f.context(abort.signal));
      const assertion = expect(running).rejects.toThrow(/cancel|abort/i);
      setTimeout(() => abort.abort(), 150);
      await assertion;
      expect(cancel).toBe(true);
    } finally {
      await f.cleanup();
    }
  }, 30000);
  it('limits transfers and refuses forged artifact references before upload', async () => {
    let calls = 0;
    const f = await fixture(
      `export default {async execute(i,c){if(i.download)return c.download({url:'https://synthetic.test/large',name:'large'});return c.upload({url:'https://synthetic.test/upload',artifact:{kind:'file',id:'00000000-0000-0000-0000-000000000000'}})}}`,
      async () => {
        calls++;
        return new Response('', { headers: { 'content-length': String(65 * 1024 * 1024) } });
      },
    );
    try {
      await expect(f.host.execute(f.node, {}, f.context())).rejects.toThrow('denied');
      expect(calls).toBe(0);
      await expect(f.host.execute(f.node, { download: true }, f.context())).rejects.toThrow(
        'limit',
      );
      expect(calls).toBe(1);
    } finally {
      await f.cleanup();
    }
  }, 30000);
});
it('redacts all byte splits and handles SSE CR/LF boundaries without reconnect logic', async () => {
  for (let split = 0; split <= 20; split++) {
    const r = new ByteRedactor('synthetic-secret');
    const b = Buffer.from('a synthetic-secret b');
    expect(
      Buffer.concat([r.push(b.subarray(0, split)), r.push(b.subarray(split), true)]).toString(),
    ).toBe('a [redacted] b');
  }
  async function* chars() {
    for (const c of ':comment\r\nid: a\rdata: one\r\ndata: two\r\nretry: 12\r\n\r\ndata: incomplete')
      yield c;
  }
  const events = [];
  for await (const e of parseSSE(chars())) events.push(e);
  expect(events).toEqual([{ event: 'message', data: 'one\ntwo', id: 'a', retry: 12 }]);
});
