import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const home = await mkdtemp(path.join(os.tmpdir(), 'freelm-custom-node-ui-'));
const evidence = path.resolve('docs/evidence/custom-nodes');
await mkdir(evidence, { recursive: true });
const env = { ...process.env, FREELM_HOME: home, FREELM_USER_DATA: home };
delete env.ELECTRON_RUN_AS_NODE;
delete env.FREELM_DEV_URL;
await writeFile(path.join(home,'config.json'),JSON.stringify({format:'freelm-config-v1',version:1,encryptedKeys:{},theme:'dark',connections:[],activeConnectionId:'',backgroundNotifications:false}));
await writeFile(path.join(home,'workspace.json'),JSON.stringify({format:'freelm-workspace-v2',version:1,projects:[],threads:[],generations:[]}));
let app;
const errors = [];
try {
  app = await electron.launch({ args: ['.'], env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.locator('.app-shell').waitFor();
  if (await page.locator('.welcome-later').isVisible())
    await page.locator('.welcome-later').click();
  await page.getByRole('button', { name: 'Workflows', exact: true }).click();
  await page.getByRole('button', { name: 'New workflow', exact: true }).first().click();
  await page.getByRole('button', { name: 'Add node', exact: true }).click();
  await page
    .getByLabel('Install custom node package')
    .setInputFiles(path.resolve('examples/custom-nodes/sequence.freelm-node'));
  await expect(page.getByText('Synthetic sequence structure', { exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(evidence, 'chooser.png'), fullPage: true });
  const snapshot = await page.evaluate(() => window.desktop.workflowSnapshot());
  const p = snapshot.customNodes.find((p) => p.manifest.id === 'sequence');
  assert(p);
  assert.deepEqual(p.grants, { network: [], inference: false });
  const analysis = await readFile('examples/custom-nodes/analysis.freelm-node', 'utf8');
  await page.evaluate(
    (source) => window.desktop.workflowCommand({ type: 'install-custom-node', source }),
    analysis,
  );
  const packages = (await page.evaluate(() => window.desktop.workflowSnapshot())).customNodes;
  const custom = (id, p) => ({
    id,
    type: 'custom',
    label: p.manifest.title,
    position: { x: 200, y: 200 },
    config: {},
    custom: {
      packageId: p.manifest.id,
      version: p.manifest.version,
      digest: p.digest,
      definition: p.manifest,
    },
  });
  const w = {
    id: 'synthetic-custom-pipeline',
    version: 1,
    name: 'Synthetic custom node pipeline',
    enabled: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    nodes: [
      {
        id: 'value',
        type: 'value',
        label: 'Sequence',
        position: { x: 0, y: 0 },
        config: { value: 'ACGT' },
      },
      custom('sequence', p),
      custom(
        'analysis',
        packages.find((p) => p.manifest.id === 'analysis'),
      ),
    ],
    edges: [
      {
        id: 'a',
        source: 'value',
        target: 'sequence',
        sourceHandle: 'value',
        targetHandle: 'sequence',
      },
      {
        id: 'b',
        source: 'sequence',
        target: 'analysis',
        sourceHandle: 'structure',
        targetHandle: 'structure',
      },
      {
        id: 'c',
        source: 'sequence',
        target: 'analysis',
        sourceHandle: 'length',
        targetHandle: 'length',
      },
    ],
  };
  await page.evaluate((workflow) => window.desktop.workflowCommand({ type: 'save', workflow }), w);
  await page.evaluate(() =>
    window.desktop.workflowCommand({ type: 'run', id: 'synthetic-custom-pipeline' }),
  );
  await expect
    .poll(
      async () => {
        const s = await page.evaluate(() => window.desktop.workflowSnapshot());
        const run = s.runs.find((r) => r.workflowId === 'synthetic-custom-pipeline');
        if (run?.status === 'failed') throw new Error(run.error);
        return run?.status;
      },
      { timeout: 30000 },
    )
    .toBe('completed');
  const run = (await page.evaluate(() => window.desktop.workflowSnapshot())).runs.find(
    (r) => r.workflowId === w.id,
  );
  assert.equal(run.nodes.analysis.output.report, 'Sequence ACGT has 4 symbols.');
  await page.reload();
  await page.locator('.app-shell').waitFor();
  const restored = await page.evaluate(() => window.desktop.workflowSnapshot());
  assert.deepEqual(restored.workflows.find((x) => x.id === w.id).edges, w.edges);
  assert.equal(restored.workflows.find((x) => x.id === w.id).nodes[1].custom.digest, p.digest);
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(evidence, 'native-smoke.json'),
    JSON.stringify(
      {
        passed: true,
        home,
        tests: [
          'actual chooser file installation',
          'desktop IPC graph save/run',
          'artifact multiport handoff',
          'renderer reload pinned wiring',
        ],
        report: run.nodes.analysis.output.report,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: true, home }));
} catch (error) {
  if (app) {
    const page = await app.firstWindow();
    console.error((await page.locator('body').innerText()).slice(-8000));
    await page.screenshot({ path: path.join(evidence, 'failure.png') });
  }
  throw error;
} finally {
  await app?.close();
}
