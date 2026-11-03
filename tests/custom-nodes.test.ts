import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CustomNodeHost } from '../electron/custom-nodes/host';
import type { WorkflowExecutionContext, WorkflowNode } from '../src/workflow-types';
const manifest = {
  id: 'sequence',
  version: '1.0.0',
  title: 'Sequence structure',
  description: 'Synthetic only',
  inputs: [{ id: 'sequence', label: 'Sequence', type: 'text', required: true }],
  outputs: [
    { id: 'structure', label: 'Structure', type: 'file', required: true },
    { id: 'length', label: 'Length', type: 'number' },
  ],
  fields: [],
  permissions: {},
  retrySafe: true,
};
const source = `import {defineNode} from '@freelm/custom-node-sdk';export default defineNode({async execute(inputs,ctx){await ctx.progress('Building synthetic structure');return {structure:await ctx.artifacts.write('structure.json','application/json',JSON.stringify({sequence:inputs.sequence})),length:inputs.sequence.length};}});`;
function context(
  node: WorkflowNode,
  signal = new AbortController().signal,
): WorkflowExecutionContext {
  return {
    run: {
      id: 'synthetic',
      nodes: { [node.id]: { attempt: 1 } },
    } as WorkflowExecutionContext['run'],
    workflow: {} as WorkflowExecutionContext['workflow'],
    signal,
  };
}
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'freelm-node-test-'));
  const host = new CustomNodeHost(
    root,
    {},
    path.resolve(
      process.env.FREELM_NODE_WORKER_DIRECTORY ?? 'dist-electron',
      'custom-node-runtime-worker.cjs',
    ),
  );
  await host.init();
  return { root, host };
}
function node(host: CustomNodeHost): WorkflowNode {
  const p = host.list()[0];
  return {
    id: 'node',
    type: 'custom',
    label: p.manifest.title,
    position: { x: 0, y: 0 },
    config: {},
    custom: {
      packageId: p.manifest.id,
      version: p.manifest.version,
      digest: p.digest,
      definition: p.manifest,
    },
  };
}
describe('isolated custom nodes', () => {
  it('installs, persists named ports, hands off durable artifacts, and handles missing versions', async () => {
    const { root, host } = await setup();
    try {
      await host.install(JSON.stringify({ manifest, source }));
      let n = node(host);
      const first = await host.execute(n, { sequence: 'ACGT' }, context(n));
      expect(first.length).toBe(4);
      const restored = new CustomNodeHost(
        root,
        {},
        path.resolve(
          process.env.FREELM_NODE_WORKER_DIRECTORY ?? 'dist-electron',
          'custom-node-runtime-worker.cjs',
        ),
      );
      await restored.init();
      n = JSON.parse(JSON.stringify(n));
      expect(restored.list()).toEqual(host.list());
      expect(n.custom?.definition.outputs).toEqual(manifest.outputs);
      await restored.install(
        JSON.stringify({
          manifest: {
            ...manifest,
            id: 'analysis',
            inputs: [
              { id: 'structure', label: 'Structure', type: 'file', required: true },
              { id: 'length', label: 'Length', type: 'number', required: true },
            ],
            outputs: [{ id: 'report', label: 'Report', type: 'text', required: true }],
          },
          source: `export default {async execute(input,ctx){const data=JSON.parse(await ctx.artifacts.read(input.structure));return {report:data.sequence+': '+input.length}}}`,
        }),
      );
      const p = restored.list().find((p) => p.manifest.id === 'analysis')!;
      const a = {
        ...n,
        custom: {
          packageId: p.manifest.id,
          version: p.manifest.version,
          digest: p.digest,
          definition: p.manifest,
        },
      };
      expect(await restored.execute(a, first, context(a))).toEqual({ report: 'ACGT: 4' });
      await restored.remove('sequence', '1.0.0');
      await expect(restored.execute(n, { sequence: 'A' }, context(n))).rejects.toThrow('missing');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
  it('denies ambient APIs, undeclared network, and external imports', async () => {
    const { root, host } = await setup();
    try {
      await host.install(
        JSON.stringify({
          manifest: { ...manifest, outputs: [] },
          source: `export default {async execute(i,c){if(typeof process!=='undefined'||typeof fetch!=='undefined')throw new Error('Ambient authority');return await c.request({url:'https://example.test'})}}`,
        }),
      );
      const n = node(host);
      await expect(host.execute(n, { sequence: 'A' }, context(n))).rejects.toThrow('permission');
      await expect(
        host.install(
          JSON.stringify({
            manifest: { ...manifest, version: '2.0.0' },
            source: `import fs from 'node:fs';export default {execute(){return fs.readFileSync('/etc/passwd')}}`,
          }),
        ),
      ).rejects.toThrow('Only');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
  it('cancels async waits and refuses unsafe retry', async () => {
    const { root, host } = await setup();
    try {
      await host.install(
        JSON.stringify({
          manifest: { ...manifest, retrySafe: false, outputs: [] },
          source: `export default {async execute(i,c){await c.sleep(30000);return {}}}`,
        }),
      );
      const n = node(host);
      const c = new AbortController();
      const execution = host.execute(n, { sequence: 'A' }, context(n, c.signal));
      setTimeout(() => c.abort(), 100);
      await expect(execution).rejects.toThrow(/cancel|abort/i);
      const ctx = context(n);
      ctx.run.nodes.node.attempt = 2;
      await expect(host.execute(n, { sequence: 'A' }, ctx)).rejects.toThrow('safe retries');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
  it('runs a synthetic async remote job once and reuses synthetic inference authority', async () => {
    const { root } = await setup();
    let submissions = 0,
      polls = 0;
    const host = new CustomNodeHost(
      root,
      {
        request: async (_id, _digest, args) => {
          if (args.method === 'POST') {
            submissions++;
            return { status: 202, body: 'job-1', headers: {} };
          }
          polls++;
          return { status: 200, body: polls > 1 ? 'done' : 'pending', headers: {} };
        },
        inference: async () => ({ text: 'Synthetic inference result' }),
      },
      path.resolve(
        process.env.FREELM_NODE_WORKER_DIRECTORY ?? 'dist-electron',
        'custom-node-runtime-worker.cjs',
      ),
    );
    try {
      await host.init();
      await host.install(
        JSON.stringify({
          manifest: {
            ...manifest,
            permissions: { network: ['https://synthetic.test'], inference: true },
            outputs: [{ id: 'report', label: 'Report', type: 'text' }],
          },
          source: `import {poll} from '@freelm/custom-node-sdk';export default {async execute(i,c){const job=await c.request({url:'https://synthetic.test/jobs',method:'POST',idempotencyKey:c.operationId});await poll(c,()=>c.request({url:'https://synthetic.test/jobs/'+job.body}),v=>v.body==='done',3,1);const result=await c.inference({connectionId:'synthetic',model:'fixture',prompt:i.sequence});return {report:result.text}}}`,
        }),
      );
      const n = node(host);
      expect(await host.execute(n, { sequence: 'A' }, context(n))).toEqual({
        report: 'Synthetic inference result',
      });
      expect(submissions).toBe(1);
      expect(polls).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
  it('refuses same-version replacement and invalid typed inputs', async () => {
    const { root, host } = await setup();
    try {
      await host.install(JSON.stringify({ manifest, source }));
      await expect(
        host.install(JSON.stringify({ manifest, source: source + '\n;globalThis.changed=true;' })),
      ).rejects.toThrow('Increment');
      const n = node(host);
      await expect(host.execute(n, { sequence: 3 }, context(n))).rejects.toThrow('Invalid value');
      expect(await readFile(path.join(root, 'registry.json'), 'utf8')).not.toContain('apiKey');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
});
