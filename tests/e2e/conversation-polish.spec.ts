import { expect, test, type Page } from '@playwright/test';
import { initialState } from '../../src/lib/state';
import { defaultToolSettings } from '../../src/lib/tool-settings';
import { selectConversationMode } from './helpers/conversation-mode';

// Browser plugin not available. All model responses and persisted data are synthetic.
async function fixture(
  page: Page,
  kind: 'chat' | 'code' = 'chat',
  theme = 'dark',
  sourceCount = 11,
) {
  const state = initialState();
  state.theme = theme as 'dark' | 'light';
  state.memorySettings = { savedMemories: false, referenceHistory: false };
  state.toolSettings = { ...defaultToolSettings(), enabled: false };
  state.toolSettings.webBrowsing!.enabled = false;
  state.connections[0].models.chat = 'fixture';
  state.connections[0].catalog = [
    {
      id: 'fixture',
      name: 'Fixture',
      enabled: true,
      tasks: ['chat'],
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
			thinkingModes: [{ id: 'low', name: 'Low', parameters: { responses: { reasoning: { effort: 'low' } } } }],
    },
  ];
  state.threads = [
    {
      id: 'polish',
      kind,
      title: 'Polish fixture',
      titleSource: 'manual',
      connectionId: state.connections[0].id,
      model: 'fixture',
      thinkingMode: 'low',
      createdAt: 1,
      updatedAt: 2,
      messages: Array.from({ length: 12 }, (_, i) => ({
        id: `old-${i}`,
        role: i % 2 ? ('assistant' as const) : ('user' as const),
        content: `History ${i}: ${'Earlier conversation text. '.repeat(6)}`,
        createdAt: i + 1,
        ...(i === 0
          ? {
              attachments: Array.from({ length: sourceCount }, (_, n) => ({
                name: `source-${n + 1}.txt`,
                type: 'text/plain',
                dataUrl: `data:text/plain;base64,${Buffer.from(`Synthetic source ${n + 1}`).toString('base64')}`,
              })),
            }
          : {}),
      })),
    },
  ];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:|localhost:).*/, (route) => route.abort());
  await page.addInitScript((serialized) => {
    let saved = JSON.parse(sessionStorage.getItem('polish-state') || serialized),
      revision = 0;
    const listeners = new Set<any>();
    const control: any = { requests: [], cancelled: [], saved: () => saved };
    (window as any).__polish = control;
    control.finish = (index: number, text: string) =>
      control.requests[index].resolve({
        status: 200,
        contentType: 'application/json',
        encoding: 'text',
        body: JSON.stringify({ output_text: text }),
      });
    control.stream = (index: number, text: string) =>
      listeners.forEach((listener) =>
        listener({
          id: control.requests[index].request.id,
          text: `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n`,
        }),
      );
    (window as any).desktop = {
      platform: 'darwin',
      workspaceLoad: async () => ({ state: saved, revision: String(revision) }),
      workspaceSave: async (_id: string, _rev: string, next: any) => {
        if (control.failSave) throw Error('Synthetic save failure');
        saved = structuredClone(next);
        sessionStorage.setItem('polish-state', JSON.stringify(saved));
        return { revision: String(++revision) };
      },
      storageInfo: async () => ({ secure: false, location: '/tmp/synthetic-polish' }),
      onPrepareClose: () => () => {},
      onToolApproval: () => () => {},
      toolCancel: async () => {},
      toolCatalog: async () => ({ tools: [], instructions: '', warnings: [] }),
      instanceStatus: async () => ({
        host: { running: false, name: 'Fixture', instanceId: 'local', port: 4319 },
        instances: [],
      }),
      onChunk: (listener: any) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      cancel: async (id: string) => {
        control.cancelled.push(id);
        control.requests
          .find((r: any) => r.request.id === id)
          ?.reject(new DOMException('Aborted', 'AbortError'));
      },
      request: async (request: any) =>
        new Promise((resolve, reject) => control.requests.push({ request, resolve, reject })),
    };
  }, JSON.stringify(state));
  await page.goto('/');
  await expect(page).toHaveTitle('FreeLM');
  if (kind === 'code') await selectConversationMode(page, 'Code');
  await page.locator('.thread-select[title="Polish fixture"]').click();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
  return errors;
}

for (const kind of ['chat', 'code'] as const)
  for (const theme of ['dark', 'light']) {
    test(`${kind} send reveals the new message and fades only history in ${theme}`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width: theme === 'dark' ? 1440 : 820, height: 600 });
      await page.emulateMedia({ reducedMotion: theme === 'light' ? 'reduce' : 'no-preference' });
      const errors = await fixture(page, kind, theme);
      const input = page.getByRole('textbox', { name: 'Message', exact: true });
      await page.locator('.composer-area input[type="file"]').setInputFiles({ name: 'new-source.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic attachment') });
      await input.fill('New deliberate message\n' + 'Multiline draft\n'.repeat(12));
      await page.locator('.chat-scroll').evaluate((node) => {
        node.scrollTop = 0;
        node.dispatchEvent(new Event('scroll'));
      });
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      const message = page.locator('.message.user').last();
      await expect(message).toContainText('New deliberate message');
      await expect
        .poll(() =>
          message.evaluate((node) => {
            const row = node.getBoundingClientRect(),
              viewport = document.querySelector('.chat-scroll')!.getBoundingClientRect();
            return row.bottom <= viewport.bottom + 1 && row.bottom > viewport.top;
          }),
        )
        .toBe(true);
      await expect
        .poll(() => page.evaluate(() => (window as any).__polish.requests.length))
        .toBe(1);
      await expect(page.locator('.chat-scroll')).toHaveCSS('mask-image', /linear-gradient/);
      await expect(page.locator('.composer')).toHaveCSS('mask-image', 'none');
      await page.locator('.chat-scroll').evaluate((node) => {
        node.scrollTop = 0;
        node.dispatchEvent(new Event('scroll'));
      });
      await page.evaluate(() => (window as any).__polish.stream(0, 'A streamed update.'));
      await page.waitForTimeout(100);
      expect(await page.locator('.chat-scroll').evaluate((node) => node.scrollTop)).toBe(0);
      await page.getByRole('button', { name: 'Stop response', exact: true }).click();
      await page.screenshot({ path: info.outputPath(`${kind}-${theme}.png`) });
      expect(errors).toEqual([]);
    });
  }

test('Chat steering interrupts inference, persists ordered messages once, and can be stopped', async ({
  page,
}) => {
  const errors = await fixture(page);
  const input = page.getByRole('textbox', { name: 'Message', exact: true });
  await input.fill('First request');
  await input.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).__polish.requests.length)).toBe(1);
  await input.fill('Change direction now');
  await input.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).__polish.requests.length)).toBe(2);
  expect(await page.evaluate(() => (window as any).__polish.cancelled.length)).toBe(1);
  expect(
    await page.evaluate(() => JSON.stringify((window as any).__polish.requests[1].request.body)),
  ).toContain('Change direction now');
  await expect(
    page.locator('.message.user').filter({ hasText: 'Change direction now' }),
  ).toHaveCount(1);
  await input.fill('Another immediate correction');
  await input.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).__polish.requests.length)).toBe(3);
  await page.getByRole('button', { name: 'Stop response', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).__polish
            .saved()
            .threads[0].messages.filter((m: any) => m.content === 'Another immediate correction')
            .length,
      ),
    )
    .toBe(1);
  await page.reload();
  await page.locator('.thread-select[title="Polish fixture"]').click();
  await expect(
    page.locator('.message.user').filter({ hasText: 'Change direction now' }),
  ).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).__polish.requests.length)).toBe(0);
  expect(errors).toEqual([]);
});

for (const count of [10, 11])
  test(`${count} sources have stable ordered expansion and compact rows`, async ({
    page,
  }, info) => {
    await fixture(page, 'code', 'dark', count);
    const show = page.getByRole('button', { name: 'Show pinned summary', exact: true });
    if (await show.isVisible()) await show.click();
    const rows = page.locator('.conversation-source-row');
    await expect(rows).toHaveCount(10);
    const toggle = page.getByRole('button', { name: /See more/ });
    if (count === 10) await expect(toggle).toHaveCount(0);
    else {
      await toggle.focus();
      await toggle.press('Enter');
      await expect(rows).toHaveCount(11);
      await expect(page.getByRole('button', { name: 'See less', exact: true })).toHaveAttribute(
        'aria-expanded',
        'true',
      );
      await expect(rows.last()).toContainText('source-11.txt');
      await rows.first().locator('summary').click();
      await expect(rows.first().locator('pre')).toHaveText('Synthetic source 1');
      await page.getByRole('button', { name: 'See less', exact: true }).click();
      await expect(rows).toHaveCount(10);
    }
    await expect(rows.first()).toHaveCSS('padding-top', '8px');
    await expect(rows.first().locator('.conversation-source-provenance')).toHaveCSS(
      'margin-top',
      '0px',
    );
    await page.screenshot({ path: info.outputPath(`sources-${count}.png`) });
  });
