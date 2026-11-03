import { expect, test } from '@playwright/test';
test.setTimeout(120000);
test.beforeEach(async ({page}) => {
 await page.addInitScript(() => {
  (window as any).desktop = {
   platform: 'linux', workspaceLoad: async () => ({state: null, revision: '0'}),
   workspaceSave: async () => ({revision: '1'}),
   storageInfo: async () => ({secure: false, location: 'Synthetic onboarding fixture'}),
   onPrepareClose: () => () => {}, onToolApproval: () => () => {},
   instanceStatus: async () => ({host: {running: false, name: 'Fixture', instanceId: 'local', port: 4319}, instances: []}),
   toolInspect: async () => ({tools: [], skills: [], instructions: '', warnings: []}),
  };
 });
});

test('welcome preserves connection drafts and stays in the popover', async ({ page }) => {
  await page.goto('/', {waitUntil: 'domcontentloaded'});
  const dialog = page.getByRole('dialog', { name: 'Welcome!', exact: true });
  await expect(dialog).toBeVisible({timeout: 30000});
  await expect(dialog).toHaveCSS('width', '750px');
  await page.getByRole('button', { name: 'Add API Connection', exact: true }).click();
  await expect(page.getByRole('heading', {name: 'Add API connection', exact: true})).toBeFocused();
  const endpoint = page.getByRole('combobox', {name: 'Chat endpoint', exact: true});
  await endpoint.click();
  await page.getByRole('option', {name: '/chat/completions', exact: true}).click();
  await expect(endpoint).toContainText('/chat/completions');
  await endpoint.press('Enter');
  await page.keyboard.press('Escape');
  await expect(endpoint).toBeFocused();
  await expect(page.getByRole('dialog', {name: 'Add API connection', exact: true})).toBeVisible();

  await page.getByLabel('Connection name', { exact: true }).fill('Synthetic API');
  await page.getByLabel('API base URL', { exact: true }).fill('invalid');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('valid HTTP');
  await page.getByLabel('API base URL', { exact: true }).fill('https://synthetic.invalid/v1');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Configure your models' })).toBeVisible({timeout: 30000});
  await page.getByRole('button', { name: 'Finish setup', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('at least one model');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByLabel('Connection name', { exact: true })).toHaveValue('Synthetic API');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload({waitUntil: 'domcontentloaded'});
  await expect(page.locator('.welcome-onboarding')).not.toBeVisible({timeout: 30000});
});
test('narrow reduced-motion welcome stays readable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/', {waitUntil: 'domcontentloaded'});
  await expect(page.getByRole('dialog', { name: 'Welcome!', exact: true })).toBeVisible({timeout: 30000});
  await expect(page.locator('.welcome-clouds svg')).toHaveCSS('animation-name', 'none');
  for (const bank of await page.locator('.welcome-cloud-bank').all()) {
    await expect(bank).toHaveCSS('animation-name', 'none');
  }
  await expect(
    page.getByRole('button', { name: 'Add API Connection', exact: true }),
  ).toBeInViewport();
});
