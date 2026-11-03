import { _electron as electron, chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
const profile = await mkdtemp(path.join(os.tmpdir(), 'freelm-recovery-ui-'));
let requests = 0,
  aborted = 0;
const server = createServer(async (req, res) => {
  for await (const chunk of req) {
  }
  requests++;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Partial synthetic answer"}\n\n',
  );
  res.on('close', () => aborted++);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
let app;
try {
  const env = { ...process.env, FREELM_USER_DATA: profile, FREELM_HOME: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.FREELM_DEV_URL;
  app = await electron.launch({ args: ['.'], env });
  let page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.locator('.app-shell').waitFor();
  await page.waitForFunction(() => !!window.desktop);
  const state = {
    version: 1,
    connections: [
      {
        id: 'fixture',
        name: 'Synthetic recovery',
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        apiKey: '',
        chatApi: 'responses',
        models: { chat: 'fixture', images: '', videos: '', speech: '', transcription: '' },
        discoveredModels: ['fixture'],
        catalog: [
          {
            id: 'fixture',
            name: 'Recovery fixture',
            enabled: true,
            tasks: ['chat'],
            inputModalities: ['text'],
            outputModalities: ['text'],
            thinkingModes: [
              {
                id: 'standard',
                name: 'Standard',
                parameters: { responses: { reasoning: { effort: 'low' } } },
              },
            ],
            defaultThinkingMode: 'standard',
          },
        ],
      },
    ],
    activeConnectionId: 'fixture',
    theme: 'dark',
    threads: [],
    projects: [],
    generations: [],
    systemPrompt: 'Synthetic preserved setting',
    memorySettings: { referenceHistory: false, savedMemories: false },
  };
  await page.evaluate(async (s) => {
    await window.desktop.load();
    await window.desktop.save(s);
  }, state);
  await page.reload();
  await page.getByLabel('Message', { exact: true }).fill('Synthetic recovery test');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => requests).toBe(1);
  await expect(page.locator('.message.assistant')).toContainText('Partial synthetic answer');
  // Persist the partial response through the ordinary renderer autosave before terminating it.
  await expect
    .poll(async () => {
      const s = await page.evaluate(() => window.desktop.load());
      return s.threads[0]?.messages.at(-1)?.content;
    })
    .toContain('Partial synthetic answer');
  await app.evaluate(({ dialog, BrowserWindow }) => {
    globalThis.__dialogs = [];
    globalThis.__nativeDialog = dialog.showMessageBox;
    dialog.showMessageBox = async (_window, options) => {
      globalThis.__dialogs.push(options);
      return new Promise((resolve) => {
        globalThis.__resolveRecoveryDialog = resolve;
      });
    };
    globalThis.__listenerCount =
      BrowserWindow.getAllWindows()[0].webContents.listenerCount('render-process-gone');
  });
  let restoredCount = 0;
  const restored = async () => {
    await expect.poll(async () => (await readFile(path.join(profile, 'logs/recovery.jsonl'), 'utf8').catch(() => '')).split('renderer-restored').length - 1, {timeout:15000}).toBe(++restoredCount);
    const [port, route] = (await readFile(path.join(profile, '.cache', 'DevToolsActivePort'), 'utf8').catch(() => readFile(path.join(profile, 'DevToolsActivePort'), 'utf8'))).trim().split('\n');
    const browser = await chromium.connectOverCDP(`ws://127.0.0.1:${port}${route}`);
    page = browser.contexts()[0].pages()[0];
  };
  const crash = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer(),
    );
  await crash();
  await expect.poll(() => aborted).toBe(1);
  await restored();
  await page.locator('.app-shell').waitFor();
  await page.getByLabel('Message', { exact: true }).waitFor();
  const recovered = await page.evaluate(() => window.desktop.load());
  const answer = recovered.threads[0].messages.at(-1);
  assert.equal(answer.interrupted, true);
  assert.equal(answer.content, 'Partial synthetic answer');
  assert.equal(recovered.systemPrompt, 'Synthetic preserved setting');
  assert.equal(recovered.connections[0].models.chat, 'fixture');
  assert.equal(requests, 1);
  await page.getByRole('button', { name: 'Synthetic recovery test', exact: true }).click();
  await page.screenshot({ path: path.join(profile, 'recovered.png') });
  const listenerCount = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.listenerCount('render-process-gone'),
  );
  assert.equal(listenerCount, await app.evaluate(() => globalThis.__listenerCount));
  await crash();
  await restored();
  await page.locator('.app-shell').waitFor();
  await crash();
  await expect.poll(() => app.evaluate(() => globalThis.__dialogs.length)).toBe(1);
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(requests, 1);
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.isCrashed(),
    ),
    true,
  );
  const dialogs = await app.evaluate(() => globalThis.__dialogs);
  assert.match(dialogs[0].message, /stopped automatic recovery/);
  assert.match(dialogs[0].detail, /will not be resent/);
  // Explicit manual retry must not reset the automatic crash budget.
  await app.evaluate(() => globalThis.__resolveRecoveryDialog({ response: 0 }));
  await restored();
  await page.locator('.app-shell').waitFor();
  await crash();
  await expect.poll(() => app.evaluate(() => globalThis.__dialogs.length)).toBe(2);
  const log = await readFile(path.join(profile, 'logs/recovery.jsonl'), 'utf8');
  assert.equal((log.match(/renderer-gone/g) || []).length, 4);
  assert.equal((log.match(/renderer-reload-scheduled/g) || []).length, 2);
  assert.equal((log.match(/crash-loop/g) || []).length, 2);
  assert.equal(errors.length, 0);
  assert.equal(requests, 1);
  const evidence = {
    passed: true,
    profile,
    requests,
    aborted,
    rendererCrashes: 4,
    automaticReloads: 2,
    manualReloads: 1,
    cutoffs: 2,
    duplicateListeners: false,
    settingsPreserved: true,
    partialAnswerInterrupted: true,
    errors,
  };
  await writeFile(path.join(profile, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
  await app.evaluate(() => globalThis.__resolveRecoveryDialog({ response: 1 }));
  await app.close();
  app = undefined;
} finally {
  if (app) await app.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
