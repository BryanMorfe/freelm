import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { WorkflowEngine } from '../electron/workflows/engine';
import { WorkflowStore } from '../electron/workflows/store';
import { definitionHash } from '../electron/workflows/definition-version';
import { WorkflowToolService } from '../electron/workflows/tool-service';
import type { WorkflowDefinition } from '../src/workflow-types';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const graph = (id = 'example'): WorkflowDefinition => ({
  id,
  version: 1,
  name: id,
  enabled: false,
  createdAt: 1,
  updatedAt: 1,
  nodes: [
    {
      id: 'value',
      type: 'value',
      label: 'Value',
      position: { x: 0, y: 0 },
      config: { value: 'original' },
    },
  ],
  edges: [],
});
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'freelm-definition-tests-'));
  const store = new WorkflowStore(directory),
    errors: unknown[] = [];
  const engine = new WorkflowEngine({
    store,
    autoSchedule: false,
    now: () => 2000,
    execute: async () => {
      throw Error('No live adapter permitted');
    },
    onError: (error) => errors.push(error),
    resolveProject: (id) =>
      id === 'project' ? { id, name: id, directories: [directory], instructions: '' } : undefined,
  });
  await engine.init();
  cleanup.push(async () => {
    await engine.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  const file = (id = 'example') => path.join(directory, 'definitions', `${id}.json`);
  return { engine, store, errors, directory, file };
}
it('adopts disk revisions without writing and rejects a stale canvas before and after refresh', async () => {
  const { engine, file } = await fixture();
  const original = await engine.saveWorkflow(graph());
  const base = engine.snapshot().definitionVersions!.example;
  const external = { ...original, name: 'External', revision: 5 };
  await writeFile(file(), JSON.stringify(external));
  const bytes = await readFile(file(), 'utf8'),
    modified = (await stat(file())).mtimeMs;
  const command = {
    type: 'save' as const,
    workflow: { ...original, name: 'Stale canvas' },
    expectedRevision: base.revision,
    expectedContentHash: base.contentHash,
  };
  await expect(engine.command(command)).rejects.toThrow(/changed/);
  await engine.command({ type: 'refresh-definitions' });
  expect(engine.getWorkflow('example')).toEqual(external);
  await expect(engine.command(command)).rejects.toThrow(/changed/);
  expect(await readFile(file(), 'utf8')).toBe(bytes);
  expect((await stat(file())).mtimeMs).toBe(modified);
});
it('serializes revision assignment and detects same-revision external edits', async () => {
  const { engine, file } = await fixture();
  const one = await engine.saveWorkflow(graph());
  const versions = await Promise.all([
    engine.saveWorkflow({ ...one, name: 'A' }),
    engine.saveWorkflow({ ...one, name: 'B' }),
  ]);
  expect(versions.map((item) => item.revision)).toEqual([2, 3]);
  const base = engine.snapshot().definitionVersions!.example;
  await writeFile(file(), JSON.stringify({ ...versions[1], name: 'Same revision, other content' }));
  await engine.refreshDefinitions();
  await expect(
    engine.command({
      type: 'save',
      workflow: versions[1],
      expectedRevision: 3,
      expectedContentHash: base.contentHash,
    }),
  ).rejects.toThrow(/changed/);
});
it('isolates bad files on startup and refresh without adopting incomplete dependencies', async () => {
  const { engine, file, store } = await fixture();
  const child = await engine.saveWorkflow(graph('child'));
  const root = await engine.saveWorkflow({
    ...graph('root'),
    nodes: [{ ...graph().nodes[0], type: 'subworkflow', config: { workflowId: 'child' } }],
  });
  await engine.saveWorkflow(graph());
  await writeFile(file('child'), '{partial');
  await writeFile(
    file('root'),
    JSON.stringify({ ...root, name: 'Pending dependent edit', revision: 7 }),
  );
  await writeFile(
    file(),
    JSON.stringify({ ...graph(), name: 'Unrelated valid edit', revision: 9 }),
  );
  await engine.refreshDefinitions();
  expect(engine.getWorkflow('root')).toEqual(root);
  expect(engine.getWorkflow('child')).toEqual(child);
  expect(engine.getWorkflow('example')!.revision).toBe(9);
  expect(engine.snapshot().definitionErrors?.length).toBeGreaterThan(0);
  await engine.dispose();
  const restored = new WorkflowEngine({ store, autoSchedule: false, execute: async () => ({}) });
  cleanup.push(() => restored.dispose());
  await restored.init();
  expect(restored.getWorkflow('example')!.name).toBe('Unrelated valid edit');
  expect(restored.getWorkflow('root')).toBeUndefined();
});
it('keeps admitted runs and project bindings pinned across disk refresh', async () => {
  const { engine, file } = await fixture();
  const original = await engine.saveWorkflow({
    ...graph(),
    nodes: [{ ...graph().nodes[0], type: 'wait', config: { mode: 'human', prompt: 'Wait' } }],
  });
  const binding = await engine.attachWorkflow({ workflowId: original.id, projectId: 'project' });
  const run = await engine.startRun(original.id);
  await vi.waitFor(() => expect(engine.getRun(run.id)?.status).toBe('waiting'));
  await writeFile(file(), JSON.stringify({ ...original, revision: 8, name: 'Refreshed' }));
  await engine.refreshDefinitions();
  expect(engine.getRun(run.id)!.workflowSnapshot).toEqual(original);
  expect(engine.getBinding(binding.id)!.workflowSnapshot).toEqual(original);
});
it('rejects a scheduler admission captured before a definition refresh', async () => {
  const { engine, store, file, errors } = await fixture();
  const original = await engine.saveWorkflow({
    ...graph(),
    enabled: true,
    nodes: [{ ...graph().nodes[0], type: 'schedule', config: { kind: 'once', at: 1000 } }],
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const save = store.setSchedule.bind(store);
  const cursor = vi.spyOn(store, 'setSchedule').mockImplementation(async (...args) => {
    await gate;
    return save(...args);
  });
  const tick = engine.scheduler.tick(2000);
  await vi.waitFor(() => expect(cursor).toHaveBeenCalled());
  await writeFile(file(), JSON.stringify({ ...original, revision: 2, enabled: false }));
  await engine.refreshDefinitions();
  release();
  await tick;
  expect(engine.listRuns()).toEqual([]);
  expect(String(errors[0])).toContain('changed before');
});
it('clears pending file-trigger work when the source definition is replaced', async () => {
  const { engine, file, directory } = await fixture();
  const watched = path.join(directory, 'event.txt');
  await writeFile(watched, 'initial');
  const original = await engine.saveWorkflow({
    ...graph(),
    enabled: true,
    nodes: [{ ...graph().nodes[0], type: 'event', config: { path: watched, debounceMs: 1000 } }],
  });
  await writeFile(watched, 'event');
  await vi.waitFor(() => expect((engine as any).eventTimers.size).toBe(1));
  await writeFile(file(), JSON.stringify({ ...original, revision: 2, enabled: false }));
  await engine.refreshDefinitions();
  expect((engine as any).eventTimers.size).toBe(0);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  expect(engine.listRuns()).toEqual([]);
});
it('library tools require a live project and exact inspected base, preserving project installations', async () => {
  const { engine } = await fixture();
  const original = await engine.saveWorkflow(graph());
  const binding = await engine.attachWorkflow({ workflowId: original.id, projectId: 'project' });
  const service = new WorkflowToolService(engine);
  const context = {
    projectId: 'project',
    threadId: 'thread',
    permissionMode: 'ask' as const,
    connectionId: 'unused',
    model: 'unused',
    signal: new AbortController().signal,
  };
  const args = {
    workflowId: original.id,
    expectedRevision: original.revision,
    expectedContentHash: definitionHash(original),
    graph: { name: 'Library edit', nodes: original.nodes, edges: [] },
  };
  await expect(
    service.execute('workflows.library_save', args, { ...context, projectId: 'missing' }),
  ).rejects.toThrow(/Project not found/);
  await service.execute('workflows.library_save', args, context);
  expect(engine.getWorkflow(original.id)!.name).toBe('Library edit');
  expect(engine.getBinding(binding.id)!.workflowSnapshot).toEqual(original);
  await expect(service.execute('workflows.library_save', args, context)).rejects.toThrow(/changed/);
  await expect(
    service.execute(
      'workflows.library_save',
      {
        ...args,
        graph: {
          ...args.graph,
          nodes: [{ ...original.nodes[0], config: { permissionMode: 'full-access' } }],
        },
      },
      context,
    ),
  ).rejects.toThrow(/host-owned/);
});

it('rejects concurrent create-if-absent commands instead of overwriting the winner', async () => {
  const { engine } = await fixture();
  const results = await Promise.allSettled([
    engine.command({ type: 'save', workflow: graph() }),
    engine.command({ type: 'save', workflow: { ...graph(), name: 'Other creation' } }),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(engine.getWorkflow('example')?.revision).toBe(1);
});
it('rejects a pending scheduler admission when only a dependency changes', async () => {
  const { engine, store, file, errors } = await fixture();
  const child = await engine.saveWorkflow(graph('child'));
  const base = graph();
  await engine.saveWorkflow({
    ...base,
    enabled: true,
    nodes: [
      { ...base.nodes[0], type: 'schedule', config: { kind: 'once', at: 1000 } },
      { ...base.nodes[0], id: 'child', type: 'subworkflow', config: { workflowId: 'child' } },
    ],
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const save = store.setSchedule.bind(store);
  const cursor = vi.spyOn(store, 'setSchedule').mockImplementation(async (...args) => {
    await gate;
    return save(...args);
  });
  const tick = engine.scheduler.tick(2000);
  await vi.waitFor(() => expect(cursor).toHaveBeenCalled());
  await writeFile(file('child'), JSON.stringify({ ...child, revision: 2, name: 'New dependency' }));
  await engine.refreshDefinitions();
  release();
  await tick;
  expect(engine.listRuns()).toEqual([]);
  expect(String(errors[0])).toContain('changed before');
});

it('preserves a pending file event when an unrelated definition changes', async () => {
 const { engine, directory } = await fixture();
 const watched = path.join(directory, 'unchanged-event.txt');
 await writeFile(watched, 'initial');
 await engine.saveWorkflow({ ...graph('watched'), enabled: true, nodes: [{ ...graph().nodes[0], type: 'event', config: { path: watched, debounceMs: 1000 } }] });
 await writeFile(watched, 'event');
 await vi.waitFor(() => expect((engine as any).eventTimers.size).toBe(1));
 await engine.saveWorkflow(graph('unrelated'));
 expect((engine as any).eventTimers.size).toBe(1);
 await vi.waitFor(() => expect(engine.listRuns()).toHaveLength(1), { timeout: 3000 });
 expect(engine.listRuns()[0].workflowId).toBe('watched');
});
