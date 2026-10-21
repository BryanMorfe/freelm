import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const profile = await mkdtemp(path.join(os.tmpdir(), 'freelm-context-smoke-'));
let desktop;
let originalClipboard;
try {
	const env = { ...process.env, FREELM_USER_DATA: profile };
	delete env.FREELM_HOME;
	delete env.FREELM_DEV_URL;
	delete env.ELECTRON_RUN_AS_NODE;
	desktop = await electron.launch({ executablePath: require('electron'), args: ['.'], env });
	originalClipboard = await desktop.evaluate(({ clipboard }) => clipboard.readText());
	const page = await desktop.firstWindow();
	await page.locator('.app-shell').waitFor();
	// Observe the native menu created from Chromium's actual context-menu event.
	// Suppress its OS popup so the isolated smoke run never grabs the user's mouse.
	await desktop.evaluate(({ Menu }) => {
		const build = Menu.buildFromTemplate;
		globalThis.__contextMenus = [];
		Menu.buildFromTemplate = function (template) {
			const menu = build.call(Menu, template);
			menu.popup = () => {
				globalThis.__contextMenus.push(
					template.map(({ role, enabled, type }) => ({ role, enabled, type })),
				);
				globalThis.__contextMenu = menu;
			};
			return menu;
		};
	});
	const input = page.getByLabel('Message', { exact: true });
	await input.fill('A native editing selection');
	await input.press('ControlOrMeta+A');
	await input.click({ button: 'right' });
	await expect.poll(() => desktop.evaluate(() => globalThis.__contextMenus.length)).toBe(1);
	const selected = await desktop.evaluate(() => globalThis.__contextMenus[0]);
	assert.equal(selected.find((item) => item.role === 'copy')?.enabled, true);
	assert.equal(selected.find((item) => item.role === 'cut')?.enabled, true);
	assert.equal(selected.find((item) => item.role === 'selectAll')?.enabled, true);
	assert.deepEqual(
		selected.map((item) => item.role || item.type),
		['undo', 'redo', 'separator', 'cut', 'copy', 'paste', 'separator', 'selectAll'],
	);
	await desktop.evaluate(({ BrowserWindow }) => {
		BrowserWindow.getAllWindows()[0].webContents.copy();
	});
	assert.equal(
		await desktop.evaluate(({ clipboard }) => clipboard.readText()),
		'A native editing selection',
	);
	await input.press('ArrowRight');
	await input.click({ button: 'right' });
	await expect.poll(() => desktop.evaluate(() => globalThis.__contextMenus.length)).toBe(2);
	const collapsed = await desktop.evaluate(() => globalThis.__contextMenus[1]);
	assert.equal(collapsed.find((item) => item.role === 'copy')?.enabled, false);
	assert.equal(collapsed.find((item) => item.role === 'paste')?.enabled, true);
	await page.screenshot({ path: '/tmp/freelm-audit-20260930/native-editor.png' });
	console.log(
		'Native editor context-menu roles and selection flags pass; Chromium copied the selected text.',
	);
} finally {
	if (desktop && originalClipboard !== undefined)
		await desktop
			.evaluate(({ clipboard }, text) => clipboard.writeText(text), originalClipboard)
			.catch(() => {});
	await desktop?.close();
	await rm(profile, { recursive: true, force: true });
}
