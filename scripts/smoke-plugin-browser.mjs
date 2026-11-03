import { _electron as electron, expect as baseExpect } from '@playwright/test';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

// Actual built desktop app, disposable profile, zero installs, grants or inference.
const expect = baseExpect.configure({ timeout: 20000 });
const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'freelm-plugin-browser-')));
const env = { ...process.env, FREELM_HOME: home, FREELM_USER_DATA: home };
delete env.ELECTRON_RUN_AS_NODE;
delete env.FREELM_DEV_URL;
let app;
const errors = [];
const shellMeasurements = [];
async function shell(page) {
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
async function compareShell(page, width) {
	const rail = page.getByRole('navigation', { name: 'Workspaces', exact: true });
	await rail.getByRole('button', { name: 'Home', exact: true }).click();
	const picker = page.getByRole('combobox', { name: 'Conversation mode', exact: true });
	await picker.click();
	await page.getByRole('listbox').locator('[role="option"][data-value="code"]').click();
	const code = await shell(page);
	await page.screenshot({ path: `/tmp/freelm-shell-native-code-${width}.png` });
	await rail.getByRole('button', { name: 'Plugins', exact: true }).click();
	await expect(page.getByRole('region', { name: 'Plugin navigation', exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'View Notebook', exact: true })).toBeVisible();
	const plugins = await shell(page);
	assert.deepEqual(plugins, code, 'Plugins must use the same shell geometry and surfaces as Code');
	await page.screenshot({ path: `/tmp/freelm-shell-native-plugins-${width}.png` });
	await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
	await expect(page.locator('.sidebar-panel')).toHaveCount(0);
	const collapsed = await shell(page);
	assert.equal(collapsed['.main-workspace'].x, 52);
	await page.screenshot({ path: `/tmp/freelm-shell-native-plugins-${width}-collapsed.png` });
	await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
	shellMeasurements.push({ width, code, plugins, collapsed });
}
try {
	for (let launch = 0; launch < 2; launch++) {
		app = await electron.launch({
			...(process.env.FREELM_SMOKE_EXECUTABLE
				? { executablePath: process.env.FREELM_SMOKE_EXECUTABLE, args: [`--user-data-dir=${home}`] }
				: { args: ['.'] }),
			env,
		});
		assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), home);
		const page = await app.firstWindow();
		page.on('pageerror', (error) => errors.push(error.message));
		await expect(page).toHaveTitle('FreeLM');
		await expect(page.locator('.app-shell')).toBeVisible({ timeout: 30000 });
		const rail = page
			.getByRole('navigation', { name: 'Workspaces', exact: true })
			.getByRole('button', { name: 'Plugins', exact: true });
		if (!launch) await rail.click();
		await expect(rail).toHaveAttribute('aria-current', 'page');
		const library = page.getByRole('region', { name: 'Plugins', exact: true });
		await expect(library.getByRole('button', { name: 'View Notebook', exact: true })).toBeVisible();
		if (!launch) {
			await compareShell(page, 1440);
			await page.screenshot({ path: '/tmp/freelm-plugin-native-browse.png' });
			await library.getByRole('button', { name: 'View Follow-up Prompts', exact: true }).click();
			const summary = library.locator('.plugin-manifest-details summary');
			await summary.focus();
			await page.keyboard.press(' ');
			await expect(library.locator('.plugin-manifest-details')).not.toHaveAttribute('open', '');
			await page.keyboard.press('Enter');
			await expect(library.locator('.plugin-manifest-details')).toHaveAttribute('open', '');
			await expect(
				library.getByText('Send plugin-provided text to the selected inference model', {
					exact: true,
				}),
			).toBeVisible();
			await library.getByRole('heading', { name: 'Follow-up Prompts', exact: true }).focus();
			await page.screenshot({ path: '/tmp/freelm-plugin-native-detail.png' });
			await library.getByRole('button', { name: 'Review install', exact: true }).click();
			await expect(
				library.getByRole('heading', { name: 'Review plugin', exact: true }),
			).toBeVisible();
			await expect(
				library.getByRole('button', { name: 'Install reviewed plugin', exact: true }),
			).toBeEnabled();
			await library.getByRole('button', { name: 'Back', exact: true }).click();
			await library.getByRole('button', { name: 'Cancel', exact: true }).click();
			await library.getByRole('button', { name: 'Browse', exact: true }).first().click();
			await library.getByRole('button', { name: 'Install plugin', exact: true }).click();
			await library.getByLabel('Manifest JSON', { exact: true }).fill('{"manifestVersion":1}');
			await library.getByRole('button', { name: 'Review manifest', exact: true }).click();
			await expect(library.getByRole('alert')).toBeVisible();
			await library.getByRole('button', { name: 'Cancel', exact: true }).click();
		} else {
			await app
				.browserWindow(page)
				.then((window) => window.evaluate((window) => window.setSize(820, 900)));
			await compareShell(page, 820);
			await library.getByRole('button', { name: 'View Notebook', exact: true }).click();
			await page.screenshot({ path: '/tmp/freelm-plugin-native-narrow.png' });
		}
		const snapshot = await page.evaluate(() => window.desktop.pluginSnapshot());
		assert.equal(snapshot.plugins.length, 0, 'Review/cancel must not install a plugin');
		assert.equal(snapshot.accounts.length, 0, 'Review must not create or grant an account');
		await expect(page.locator('vite-error-overlay')).toHaveCount(0);
		await app.close();
		app = undefined;
	}
	assert.deepEqual(errors, []);
	await writeFile(
		'/tmp/freelm-shell-native-dimensions.json',
		JSON.stringify(shellMeasurements, null, 2),
	);
	console.log(
		'Plugin browser native smoke passed: actual bundled catalog, keyboard disclosures, real package inspection, review/cancel and invalid manifest, persisted Plugins destination across two launches, narrow layout; zero installed plugins, accounts, grants or inference.',
	);
} finally {
	await app?.close();
	await rm(home, { recursive: true, force: true });
}
