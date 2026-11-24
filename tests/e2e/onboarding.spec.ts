import { expect, test } from '@playwright/test';
test.setTimeout(120000);
test.beforeEach(async ({ page }) => {
  await page.route(/^https?:\/\/(?!127\.0\.0\.1(?::|\/)|localhost(?::|\/)).*/, (route) =>
    route.abort(),
  );
  await page.addInitScript(() => {
    (window as any).desktop = {
      platform: 'linux',
      workspaceLoad: async () => ({ state: null, revision: '0' }),
      workspaceSave: async () => ({ revision: '1' }),
      storageInfo: async () => ({ secure: false, location: 'Synthetic onboarding fixture' }),
      onPrepareClose: () => () => {},
      onToolApproval: () => () => {},
      instanceStatus: async () => ({
        host: { running: false, name: 'Fixture', instanceId: 'local', port: 4319 },
        instances: [],
      }),
      toolInspect: async () => ({ tools: [], skills: [], instructions: '', warnings: [] }),
    };
  });
});

for (const [name, raw, announcement] of [
  ['malformed', '{', null],
  ['truncated', '{"version":1,"announcementVersion":"release-x"', null],
  ['valid', '{"version":1,"announcementVersion":"release-x"}', 'release-x'],
] as const) {
  test(`welcome completion survives reload with ${name} preferences`, async ({ page }, info) => {
    await page.addInitScript((value) => {
      if (sessionStorage.getItem('onboarding-fixture-seeded')) return;
      sessionStorage.setItem('onboarding-fixture-seeded', 'yes');
      localStorage.setItem('freelm-onboarding-v1', value);
      localStorage.setItem('unrelated-fixture-preference', '{"preserved":true}');
    }, raw);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const welcome = page.getByRole('dialog', { name: 'Welcome!', exact: true });
    await expect(welcome).toBeVisible({ timeout: 30000 });
    await page.getByRole('button', { name: 'Close setup and keep draft', exact: true }).click();
    await expect(welcome).not.toBeVisible();
    expect(
      await page.evaluate(() => JSON.parse(localStorage.getItem('freelm-onboarding-v1')!)),
    ).toEqual({
      version: 1,
      welcomeVersion: 1,
      announcementVersion: announcement,
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible({
      timeout: 30000,
    });
    await expect(welcome).not.toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('unrelated-fixture-preference'))).toBe(
      '{"preserved":true}',
    );
    await page.screenshot({ path: info.outputPath(`${name}-completed-after-reload.png`) });
  });
}

test('Finish setup repairs corrupt preferences after saving a manually configured connection', async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('onboarding-fixture-seeded')) return;
    sessionStorage.setItem('onboarding-fixture-seeded', 'yes');
    localStorage.setItem('freelm-onboarding-v1', '{');
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Add API Connection', exact: true }).click();
  await page.getByLabel('Connection name', { exact: true }).fill('Synthetic API');
  await page.getByLabel('API base URL', { exact: true }).fill('https://synthetic.invalid/v1');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Add model', exact: true }).click();
  await page.getByLabel('Display name', { exact: true }).fill('Synthetic model');
  await page.getByLabel('API model ID', { exact: true }).fill('synthetic-model');
  await page.getByRole('button', { name: 'Add Standard mode', exact: true }).click();
  await page.getByRole('button', { name: 'Apply model', exact: true }).click();
  await page.getByRole('button', { name: 'Finish setup', exact: true }).click();
  await expect(page.locator('.welcome-onboarding')).not.toBeVisible();
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('freelm-onboarding-v1')!)),
  ).toEqual({ version: 1, welcomeVersion: 1, announcementVersion: null });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible({
    timeout: 30000,
  });
  await expect(page.locator('.welcome-onboarding')).not.toBeVisible();
});

test('failed preference writes allow session dismissal and retry without losing valid preferences', async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('onboarding-fixture-seeded')) {
      localStorage.setItem(
        'freelm-onboarding-v1',
        '{"version":1,"announcementVersion":"release-x"}',
      );
      sessionStorage.setItem('onboarding-fixture-seeded', 'yes');
    }
    (window as any).__failOnboardingWrite = true;
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'freelm-onboarding-v1' && (window as any).__failOnboardingWrite)
        throw new DOMException('Synthetic quota failure', 'QuotaExceededError');
      return write.call(this, key, value);
    };
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const welcome = page.getByRole('dialog', { name: 'Welcome!', exact: true });
  await expect(welcome).toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: 'Close setup and keep draft', exact: true }).click();
  await expect(welcome).not.toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('freelm-onboarding-v1'))).toBe(
    '{"version":1,"announcementVersion":"release-x"}',
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(welcome).toBeVisible({ timeout: 30000 });
  await page.evaluate(() => {
    (window as any).__failOnboardingWrite = false;
  });
  await page.getByRole('button', { name: 'Close setup and keep draft', exact: true }).click();
  await expect(welcome).not.toBeVisible();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible({
    timeout: 30000,
  });
  await expect(welcome).not.toBeVisible();
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('freelm-onboarding-v1')!)),
  ).toEqual({ version: 1, welcomeVersion: 1, announcementVersion: 'release-x' });
});

test('welcome preserves connection drafts and stays in the popover', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const dialog = page.getByRole('dialog', { name: 'Welcome!', exact: true });
  await expect(dialog).toBeVisible({ timeout: 30000 });
  await expect(dialog).toHaveCSS('width', '750px');
  await page.getByRole('button', { name: 'Add API Connection', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Add API connection', exact: true }),
  ).toBeFocused();
  const endpoint = page.getByRole('combobox', { name: 'Chat endpoint', exact: true });
  await endpoint.click();
  await page.getByRole('option', { name: '/chat/completions', exact: true }).click();
  await expect(endpoint).toContainText('/chat/completions');
  await endpoint.press('Enter');
  await page.keyboard.press('Escape');
  await expect(endpoint).toBeFocused();
  await expect(page.getByRole('dialog', { name: 'Add API connection', exact: true })).toBeVisible();

  await page.getByLabel('Connection name', { exact: true }).fill('Synthetic API');
  await page.getByLabel('API base URL', { exact: true }).fill('invalid');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('valid HTTP');
  await page.getByLabel('API base URL', { exact: true }).fill('https://synthetic.invalid/v1');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Configure your models' })).toBeVisible({
    timeout: 30000,
  });
  await page.getByRole('button', { name: 'Finish setup', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('at least one model');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByLabel('Connection name', { exact: true })).toHaveValue('Synthetic API');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('.welcome-onboarding')).not.toBeVisible({ timeout: 30000 });
});
test('narrow reduced-motion welcome stays readable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('dialog', { name: 'Welcome!', exact: true })).toBeVisible({
    timeout: 30000,
  });
  await expect(page.locator('.welcome-clouds svg')).toHaveCSS('animation-name', 'none');
  for (const bank of await page.locator('.welcome-cloud-bank').all()) {
    await expect(bank).toHaveCSS('animation-name', 'none');
  }
  await expect(
    page.getByRole('button', { name: 'Add API Connection', exact: true }),
  ).toBeInViewport();
});
