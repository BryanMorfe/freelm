import { expect, test, type Page } from '@playwright/test';
import type { AppState } from '../../src/types';

async function settingsPage(page: Page) {
	await page.goto('/');
	await expect(page).toHaveTitle('FreeLM');
	await page.getByRole('button', { name: /Personal workspace/ }).click();
	const settings = page.getByRole('region', { name: 'Settings', exact: true });
	await expect(settings).toBeVisible();
	return settings;
}

async function savedState(page: Page): Promise<AppState> {
	return page.evaluate(async () => {
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open('freelm-workspace', 1);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		try {
			return await new Promise<AppState>((resolve, reject) => {
				const request = db.transaction('state').objectStore('state').get('workspace');
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
		} finally {
			db.close();
		}
	});
}

test('settings selects show a themed listbox, support keyboard navigation and preserve saved values', async ({
	page,
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	const settings = await settingsPage(page);
	await settings.getByRole('button', { name: 'Connections', exact: true }).click();
	const endpoint = settings.getByRole('combobox', { name: 'Chat endpoint', exact: true });
	await endpoint.click();
	await expect(endpoint).toHaveAttribute('aria-expanded', 'true');
	await expect(page.getByRole('listbox')).toBeVisible();
	await expect(page.getByRole('option', { name: '/responses', exact: true })).toHaveAttribute(
		'aria-selected',
		'true',
	);
	await endpoint.press('Escape');
	await expect(page.getByRole('listbox')).toHaveCount(0);
	await expect(settings).toBeVisible();
	await expect(endpoint).toBeFocused();
	await endpoint.press('ArrowDown');
	await endpoint.press('End');
	await endpoint.press('Enter');
	await expect(endpoint).toHaveText('/chat (compatible alias)');
	await endpoint.click();
	await page.getByRole('option', { name: '/chat/completions', exact: true }).click();
	await expect(endpoint).toHaveText('/chat/completions');
	await expect(endpoint).toBeFocused();
	await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
	await expect
		.poll(async () => (await savedState(page)).connections[0].chatApi)
		.toBe('chat/completions');
	await page.reload();
	await page.getByRole('button', { name: /Personal workspace/ }).click();
	await settings.getByRole('button', { name: 'Connections', exact: true }).click();
	await expect(endpoint).toHaveText('/chat/completions');
	await expect(page.locator('vite-error-overlay')).toHaveCount(0);
	expect(errors).toEqual([]);
});

test('settings switches support keyboard activation and selected popup values survive Save', async ({
	page,
}) => {
	const settings = await settingsPage(page);
	await settings.getByRole('button', { name: 'Tools', exact: true }).click();
	const enabled = settings.getByRole('switch', { name: 'Enable tools in Code', exact: true });
	await expect(enabled).toBeChecked();
	await enabled.focus();
	await enabled.press('Space');
	await expect(enabled).not.toBeChecked();
	await enabled.press('Enter');
	await expect(enabled).toBeChecked();
	await enabled.press('Space');
	const approval = settings.getByRole('combobox', { name: 'Tool approval', exact: true });
	await approval.focus();
	await approval.press('f');
	await approval.press('Enter');
	await expect(approval).toHaveText('Full access');
	await approval.click();
	await page.getByRole('heading', { name: 'Tools', exact: true }).click();
	await expect(page.getByRole('listbox')).toHaveCount(0);
	await expect(approval).toHaveText('Full access');
	await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
	await expect.poll(async () => (await savedState(page)).toolSettings?.enabled).toBe(false);
	await expect
		.poll(async () => (await savedState(page)).toolSettings?.approvalMode)
		.toBe('full-access');
});

test('settings popup remains inside a narrow viewport and Appearance has a tidy split System preview', async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const settings = await settingsPage(page);
	const menu = settings.getByRole('navigation', { name: 'Settings options', exact: true });
	const tools = menu.getByRole('button', { name: 'Tools', exact: true });
	const fontSize = await tools.evaluate((button) => getComputedStyle(button).fontSize);
	for (const name of ['Personal', 'Integrations'])
		await expect(menu.getByRole('heading', { name, exact: true })).toHaveCSS('font-size', fontSize);
	await expect(menu.locator('button svg')).toHaveCount(0);
	expect((await tools.boundingBox())!.height).toBeLessThanOrEqual(36);
	await settings.getByRole('button', { name: 'Tools', exact: true }).click();
	await settings.getByRole('combobox', { name: 'Tool approval', exact: true }).click();
	const popup = page.getByRole('listbox');
	await expect(popup).toBeVisible();
	const bounds = await popup.boundingBox();
	expect(bounds).not.toBeNull();
	expect(bounds!.x).toBeGreaterThanOrEqual(8);
	expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(382);
	expect(bounds!.y).toBeGreaterThanOrEqual(8);
	expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(836);
	await page.screenshot({ path: '/tmp/freelm-audit-settings-select-narrow.png' });
	await settings.getByRole('combobox', { name: 'Tool approval', exact: true }).press('Escape');
	await settings.getByRole('button', { name: 'Appearance', exact: true }).click();
	await expect(settings.getByRole('radio', { name: 'System', exact: true })).toBeVisible();
	await expect(settings.locator('.theme-preview-system .theme-system-half')).toHaveCount(2);
	await page.screenshot({ path: '/tmp/freelm-audit-settings-appearance-narrow.png' });
});

test('themed popup coordinates stay inside the viewport at fractional CSS scale', async ({
	page,
}) => {
	const settings = await settingsPage(page);
	await settings.getByRole('button', { name: 'Connections', exact: true }).click();
	await page.addStyleTag({ content: 'body { zoom: 1.25; }' });
	const endpoint = settings.getByRole('combobox', { name: 'Chat endpoint', exact: true });
	await endpoint.click();
	const popup = page.getByRole('listbox');
	await expect(popup).toBeVisible();
	const bounds = await popup.boundingBox();
	const viewport = page.viewportSize()!;
	expect(bounds!.x).toBeGreaterThanOrEqual(8);
	expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width - 8);
	expect(bounds!.y).toBeGreaterThanOrEqual(8);
	expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height - 8);
	await page.screenshot({ path: '/tmp/freelm-audit-settings-select-fractional.png' });
	await page.getByRole('option', { name: '/chat/completions', exact: true }).click();
	await expect(endpoint).toHaveAttribute('data-value', 'chat/completions');
});

test('Remote remains accessible through Settings without a redundant rail shortcut or replacing an unsaved draft', async ({
	page,
}) => {
	await page.goto('/');
	await expect(page).toHaveTitle('FreeLM');
	await expect(page.getByRole('button', { name: 'Manage instances', exact: true })).toHaveCount(0);
	const footer = page.getByRole('button', { name: 'Personal workspace settings', exact: true });
	await expect(footer).toBeVisible();
	const position = (await footer.boundingBox())!;
	expect(position.y).toBeGreaterThan(page.viewportSize()!.height - 100);
	await footer.click();
	const settings = page.getByRole('region', { name: 'Settings', exact: true });
	await expect(settings).toBeVisible();
	await expect
		.poll(async () => Math.abs((await footer.boundingBox())!.y - position.y))
		.toBeLessThanOrEqual(1);
	await settings.getByRole('button', { name: 'System', exact: true }).click();
	await settings
		.getByRole('textbox', { name: 'System prompt', exact: true })
		.fill('Keep this draft while I inspect instances.');
	await settings.getByRole('button', { name: 'Remote FreeLM', exact: true }).click();
	await expect(settings.getByRole('heading', { name: 'Remote FreeLM', exact: true })).toBeVisible();
	await settings.getByRole('button', { name: 'System', exact: true }).click();
	await expect(settings.getByRole('textbox', { name: 'System prompt', exact: true })).toHaveValue(
		'Keep this draft while I inspect instances.',
	);
	await settings.getByRole('button', { name: 'Remote FreeLM', exact: true }).click();
	await expect(settings.getByRole('heading', { name: 'Remote FreeLM', exact: true })).toBeVisible();
	await settings.getByRole('button', { name: 'System', exact: true }).click();
	await expect(settings.getByRole('textbox', { name: 'System prompt', exact: true })).toHaveValue(
		'Keep this draft while I inspect instances.',
	);
	await settings.getByRole('button', { name: 'Back to workspace', exact: true }).click();
	await expect(settings.getByRole('alert')).toContainText('You have unsaved settings changes.');
});

test('selected projects keep a hover-only fill and a visible keyboard focus cue', async ({
	page,
}) => {
	await page.goto('/');
	await page.getByRole('button', { name: 'New project', exact: true }).click();
	await page.getByRole('textbox', { name: 'Project name', exact: true }).fill('Compact project');
	await page.getByRole('button', { name: 'Create project', exact: true }).click();
	const project = page.getByRole('button', { name: 'Compact project', exact: true });
	const row = project.locator('..');
	await expect(project).toHaveAttribute('aria-current', 'page');
	await expect(project).toHaveAttribute('aria-expanded', 'true');
	await project.click();
	await expect(project).toHaveAttribute('aria-expanded', 'false');
	await page.mouse.move(700, 20);
	await expect(project).toBeFocused();
	await expect(row).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
	await row.hover();
	await expect(row).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
	await page.mouse.move(700, 20);
	await project.press('Tab');
	await page.keyboard.press('Shift+Tab');
	await expect(project).toBeFocused();
	await expect(project).toHaveCSS('outline-style', 'solid');
	await expect(row).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
});
