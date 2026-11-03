import { test, expect, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { pluginFixture } from './helpers/plugin-fixture';
import { selectConversationMode } from './helpers/conversation-mode';

async function shell(page: Page) {
	return page.evaluate(() =>
		Object.fromEntries(
			[
				'.sidebar',
				'.sidebar-panel',
				'.sidebar-panel-header',
				'.main-workspace',
				'.titlebar-controls',
			].map((selector) => {
				const element = document.querySelector(selector);
				if (!element) return [selector, null];
				const r = element.getBoundingClientRect(),
					c = getComputedStyle(element);
				return [
					selector,
					{
						x: r.x,
						y: r.y,
						width: r.width,
						height: r.height,
						radius: c.borderTopLeftRadius,
						border: c.borderRight,
						background: c.backgroundColor,
						padding: c.padding,
					},
				];
			}),
		),
	);
}

test('Plugins reuses the Code and Bots shell at identical widths, including collapse and narrow overlay', async ({
	page,
}) => {
	test.setTimeout(300000);
	const library = await pluginFixture(page, { existing: false });
	const rail = page.getByRole('navigation', { name: 'Workspaces', exact: true });
	const records = [];
	for (const width of [1440, 820, 680]) {
		await page.setViewportSize({ width, height: 940 });
		await rail.getByRole('button', { name: 'Home', exact: true }).click();
		if (await page.getByRole('button', { name: 'Expand sidebar', exact: true }).isVisible())
			await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
		await selectConversationMode(page, 'Code');
		const code = await shell(page);
		await page.screenshot({ path: `/tmp/freelm-shell-code-${width}.png` });
		await rail.getByRole('button', { name: 'Bots', exact: true }).click();
		const bots = await shell(page);
		await rail.getByRole('button', { name: 'Plugins', exact: true }).click();
		await expect(
			page.getByRole('region', { name: 'Plugin navigation', exact: true }),
		).toBeVisible();
		const plugins = await shell(page);
		expect(plugins).toEqual(code);
		for (const selector of ['.sidebar', '.sidebar-panel', '.main-workspace', '.titlebar-controls'])
			expect(plugins[selector]).toEqual(bots[selector]);
		expect(plugins['.sidebar-panel']?.width).toBe(width > 1000 ? 280 : width > 700 ? 250 : 260);
		await expect(page.locator('.main-workspace .sidebar-panel')).toHaveCount(0);
		await expect(page.locator('.plugin-browser-sidebar')).toHaveCount(0);
		await page.screenshot({ path: `/tmp/freelm-shell-plugins-${width}.png` });
		await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
		await expect(page.locator('.sidebar-panel')).toHaveCount(0);
		const pluginsCollapsed = await shell(page);
		expect(pluginsCollapsed['.main-workspace']?.x).toBe(width > 700 ? 52 : 48);
		await page.screenshot({ path: `/tmp/freelm-shell-plugins-${width}-collapsed.png` });
		await rail.getByRole('button', { name: 'Home', exact: true }).click();
		const codeCollapsed = await shell(page);
		expect(pluginsCollapsed['.main-workspace']).toEqual(codeCollapsed['.main-workspace']);
		expect(pluginsCollapsed['.sidebar']).toEqual(codeCollapsed['.sidebar']);
		records.push({ width, code, bots, plugins, codeCollapsed, pluginsCollapsed });
	}
	await rail.getByRole('button', { name: 'Plugins', exact: true }).click();
	await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
	await page.getByRole('button', { name: 'Search plugins', exact: true }).click();
	const search = page.getByRole('searchbox', { name: 'Find plugins', exact: true });
	await expect(search).toBeFocused();
	await search.fill('follow-up');
	await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
	await expect(
		library.getByRole('button', { name: 'View Follow-up Prompts', exact: true }),
	).toBeVisible();
	await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
	await expect(search).toHaveValue('follow-up');
	await search.press('Escape');
	await expect(search).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Search plugins', exact: true })).toBeFocused();
	await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
	await expect(library.getByRole('button', { name: 'View Notebook', exact: true })).toBeVisible();
	expect(await page.evaluate(() => (window as any).__pluginsTest.commands)).toEqual([]);
	writeFileSync('/tmp/freelm-shell-dimensions.json', JSON.stringify(records, null, 2));
});
