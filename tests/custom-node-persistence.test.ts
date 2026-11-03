import { it, expect, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CustomNodeHost } from '../electron/custom-nodes/host';
import { WorkflowEngine } from '../electron/workflows/engine';
import { WorkflowStore } from '../electron/workflows/store';
import type { WorkflowDefinition, WorkflowNode } from '../src/workflow-types';
it('saves and reloads real workflow port wiring and artifact runs through the durable engine', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'freelm-node-persistence-'));
  let engine: WorkflowEngine | undefined;
  try {
    const host = new CustomNodeHost(
      path.join(root, 'nodes'),
      {},
      path.resolve(
        process.env.FREELM_NODE_WORKER_DIRECTORY ?? 'dist-electron',
        'custom-node-runtime-worker.cjs',
      ),
    );
    await host.init();
    for (const name of ['sequence', 'analysis'])
      await host.install(await readFile(`examples/custom-nodes/${name}.freelm-node`, 'utf8'));
    const custom = (id: string): WorkflowNode => {
      const p = host.list().find((p) => p.manifest.id === id)!;
      return {
        id,
        type: 'custom',
        label: p.manifest.title,
        config: {},
        position: { x: 0, y: 0 },
        custom: {
          packageId: id,
          version: p.manifest.version,
          digest: p.digest,
          definition: p.manifest,
        },
      };
    };
    const workflow: WorkflowDefinition = {
      id: 'pipeline',
      name: 'Synthetic sequence pipeline',
      version: 1,
      enabled: false,
      createdAt: 1,
      updatedAt: 1,
      nodes: [
        {
          id: 'value',
          type: 'value',
          label: 'Sequence',
          position: { x: 0, y: 0 },
          config: { value: 'ACGT' },
        },
        custom('sequence'),
        custom('analysis'),
      ],
      edges: [
        {
          id: 'e1',
          source: 'value',
          sourceHandle: 'value',
          target: 'sequence',
          targetHandle: 'sequence',
        },
        {
          id: 'e2',
          source: 'sequence',
          sourceHandle: 'structure',
          target: 'analysis',
          targetHandle: 'structure',
        },
        {
          id: 'e3',
          source: 'sequence',
          sourceHandle: 'length',
          target: 'analysis',
          targetHandle: 'length',
        },
      ],
    };
    const create = () =>
      new WorkflowEngine({
        store: new WorkflowStore(path.join(root, 'workflows')),
        execute: (n, i, c) => host.execute(n, i, c),
        autoSchedule: false,
      });
    engine = create();
    await engine.init();
    await engine.saveWorkflow(workflow);
    await engine.dispose();
    engine = create();
    await engine.init();
    expect(engine.listWorkflows()[0].edges).toEqual(workflow.edges);
    expect(engine.listWorkflows()[0].nodes[1].custom).toEqual(workflow.nodes[1].custom);
    const run = await engine.startRun('pipeline');
    await vi.waitFor(() => expect(engine!.getRun(run.id)?.status).toBe('completed'), {
      timeout: 10000,
    });
    expect(engine.getRun(run.id)?.nodes.analysis.output?.report).toBe(
      'Sequence ACGT has 4 symbols.',
    );
    await engine.dispose();
    engine = create();
    await engine.init();
    expect(engine.getRun(run.id)?.nodes.analysis.output?.report).toBe(
      'Sequence ACGT has 4 symbols.',
    );
    expect(engine.getRun(run.id)?.nodes.sequence.output?.structure).toMatchObject({
      kind: 'file',
      name: 'structure.json',
    });
    await host.remove('sequence', '1.0.0');
    expect(engine.listWorkflows()[0].nodes[1].custom).toEqual(workflow.nodes[1].custom);
    const missing = await engine.startRun('pipeline');
    await vi.waitFor(() => expect(engine!.getRun(missing.id)?.status).toBe('failed'), {
      timeout: 10000,
    });
    expect(engine.getRun(missing.id)?.error).toContain('missing');
  } finally {
    await engine?.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
