import { expect, test } from '@playwright/test';
import { pluginFixture } from './helpers/plugin-fixture';
import { chooseOption } from './ui-controls';

// Browser plugin not available; all plugin and persistence operations use a disposable mock.
test('adapter selection saves its account and remains explicit when disabled or missing', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.route(/https?:\/\/(?!127\.0\.0\.1|localhost)/, (route) => route.abort());
  await page.addInitScript(() =>
    localStorage.setItem(
      'freelm-onboarding-v1',
      JSON.stringify({ version: 1, welcomeVersion: 1, announcementVersion: null }),
    ),
  );
  await pluginFixture(page, { selectExisting: false });
  await page.evaluate(() => {
    const control = (window as any).__pluginsTest;
    control.snapshot.plugins[0].manifest = {
      manifestVersion: 2,
      id: 'example.mail',
      name: 'Fixture Provider',
      version: '1.0.0',
      description: 'Synthetic adapter',
      author: 'Test',
      runtime: { apiVersion: 2, entry: 'index.js' },
      contributes: {
        tools: [],
        tabs: [],
        actions: [],
        providers: [
          { id: 'text', name: 'Text adapter', capabilities: { tools: true, streaming: true } },
        ],
      },
      permissions: { network: [], storage: false, capabilities: ['provider.use'] },
    };
    (window as any).desktop.workspaceSave = async (
      _id: string,
      _revision: string,
      state: unknown,
    ) => {
      control.saved = structuredClone(state);
      return { revision: String(Date.now()) };
    };
  });
  await page.getByRole('button', { name: 'Personal workspace settings', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Settings', exact: true });
  await settings.getByRole('button', { name: 'Connections', exact: true }).click();
  const protocol = settings.getByRole('combobox', { name: 'Provider protocol', exact: true });
  await chooseOption(page, protocol, { label: 'Fixture Provider · Text adapter · Personal' });
  await expect(settings.getByRole('combobox', { name: 'Chat endpoint' })).toHaveCount(0);
  await chooseOption(
    page,
    settings.getByRole('combobox', { name: 'Credential header' }),
    'x-api-key',
  );
  await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__pluginsTest.saved?.connections[0]?.providerAdapter),
    )
    .toEqual({
      pluginId: 'example.mail',
      providerId: 'text',
      accountId: 'personal',
      credentialHeader: 'x-api-key',
    });
  await settings.getByRole('button', { name: 'Configuration', exact: true }).click();
  await expect(
    settings.getByRole('button', { name: 'Discover models', exact: true }),
  ).toBeDisabled();
  await expect(
    settings.getByText('Provider adapters use manual model IDs. Add models in the catalog below.'),
  ).toBeVisible();
  await settings.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.screenshot({ path: '/tmp/freelm-adapter-desktop.png' });
  for (const missing of [false, true]) {
    await page.evaluate((missing) => {
      const snapshot = (window as any).__pluginsTest.snapshot;
      if (missing) snapshot.plugins = [];
      else snapshot.plugins[0].enabled = false;
      window.dispatchEvent(new Event('focus'));
    }, missing);
    await expect(protocol).toContainText('Unavailable: example.mail');
    await expect(settings.getByText(/This connection will not fall back/)).toBeVisible();
    await expect(settings.getByRole('combobox', { name: 'Chat endpoint' })).toHaveCount(0);
  }
  await page.setViewportSize({ width: 600, height: 850 });
  await expect(protocol).toBeVisible();
  await page.screenshot({ path: '/tmp/freelm-adapter-narrow.png' });
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  expect(errors).toEqual([]);
});
