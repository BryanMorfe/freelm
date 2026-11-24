import { createRequire } from 'node:module';
import { mkdtemp } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
// Real Electron renderer with a disposable profile and no live inference.
// Run after npm run build: node scripts/smoke-composer-model-label.mjs
const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(root + '/package.json');
const { build } = require('esbuild');
const { _electron: electron } = require('@playwright/test');
const profile = await mkdtemp(path.join(os.tmpdir(), 'freelm-label-native-'));
await build({
	stdin: {
		contents:
			'export { initialState } from "./src/lib/state"; export { StateStore } from "./electron/state-store";',
		resolveDir: root,
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	outfile: profile + '/seed.mjs',
});
const { initialState, StateStore } = await import(pathToFileURL(profile + '/seed.mjs'));
const state = initialState();
state.backgroundNotifications = false;
state.connections[0].baseUrl = 'http://127.0.0.1:1/v1';
state.connections[0].models.chat = 'deepseek-v4.1-flash';
state.connections[0].catalog = [
	{
		id: 'deepseek-v4.1-flash',
		name: 'DeepSeek V4.1 Flash',
		enabled: true,
		tasks: ['chat'],
		inputModalities: ['text'],
		outputModalities: ['text'],
		thinkingModes: [
			{
				id: 'xhigh',
				name: 'Extra High',
				parameters: { responses: { reasoning: { effort: 'xhigh' } } },
			},
		],
		defaultThinkingMode: 'xhigh',
	},
];
state.threads = ['chat', 'code'].map((kind) => ({
	id: kind,
	kind,
	title: kind + ' model label',
	titleSource: 'manual',
	connectionId: state.activeConnectionId,
	model: 'deepseek-v4.1-flash',
	thinkingMode: 'xhigh',
	createdAt: 1,
	updatedAt: 1,
	messages: [],
}));
await new StateStore(
	profile + '/workspace.json',
	{
		available: () => false,
		encrypt: () => {
			throw Error('no secrets');
		},
		decrypt: () => {
			throw Error('no secrets');
		},
	},
	profile + '/config.json',
).save(state);
const env = { ...process.env, FREELM_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.FREELM_DEV_URL;
delete env.FREELM_HOME;
let app;
try {
	app = await electron.launch({ cwd: root, args: ['.'], env });
	const page = await app.firstWindow();
	page.setDefaultTimeout(15000);
	await page.locator('.app-shell').waitFor();
	assert.equal(await page.title(), 'FreeLM');
	await page.evaluate(() =>
		localStorage.setItem('freelm-onboarding-v1', JSON.stringify({ version: 1, welcomeVersion: 1 })),
	);
	await page.reload();
	const errors = [];
	page.on('pageerror', (e) => errors.push(e.message));
	for (const theme of ['dark', 'light']) {
		const snapshot = await page.evaluate(() => window.desktop.workspaceLoad('local'));
		snapshot.state.theme = theme;
		await page.evaluate(
			(s) => window.desktop.workspaceSave('local', s.revision, s.state),
			snapshot,
		);
		for (const kind of ['chat', 'code']) {
			await page.evaluate(
				(kind) =>
					localStorage.setItem(
						'freelm-navigation-v1',
						JSON.stringify({
							version: 1,
							mode: kind,
							conversationKind: kind,
							audioMode: 'speech',
							pluginKey: null,
						}),
					),
				kind,
			);
			await page.reload();
			await page.locator('.composer-model-trigger').waitFor();
			await page.locator(`.thread-select[title="${kind} model label"]`).click();
			for (const width of [1440, 820, 1440]) {
				await app.evaluate(
					({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 940),
					width,
				);
				await page.waitForTimeout(250);
				const metrics = await page.locator('.adaptive-composer-toolbar').evaluate((el) => ({
					mode: el.dataset.compact,
					width: el.clientWidth,
					scroll: el.scrollWidth,
					labels: [...el.querySelectorAll('.composer-model-name,.composer-thinking-value')].map(
						(l) => ({
							text: l.textContent,
							client: l.clientWidth,
							scroll: l.scrollWidth,
							visible: !!l.getBoundingClientRect().width,
						}),
					),
				}));
				console.log(theme, kind, width, metrics);
				assert.deepEqual(
					metrics.labels.map((l) => l.text),
					['DeepSeek V4.1 Flash', 'Extra High'],
				);
				assert(metrics.labels.every((l) => l.visible && l.scroll <= l.client + 1));
				assert(metrics.scroll <= metrics.width + 1);
			}
			const trigger = page.locator('.composer-model-trigger');
			await trigger.click();
			await page.getByRole('dialog', { name: 'Choose a model', exact: true }).waitFor();
			await page.keyboard.press('Escape');
			await page.screenshot({
				path: path.join(os.tmpdir(), `freelm-label-native-${kind}-${theme}.png`),
				scale: 'css',
			});
			// Exercise a genuinely constrained pane, then restore the full labels.
			await page.locator('.composer').evaluate((el) => (el.style.maxWidth = '280px'));
			await page.waitForFunction(
				() => document.querySelector('.adaptive-composer-toolbar').dataset.compact === 'icons',
			);
			const compact = await page
				.locator('.adaptive-composer-toolbar')
				.evaluate((el) => ({ width: el.clientWidth, scroll: el.scrollWidth }));
			assert(compact.scroll <= compact.width + 1);
			await trigger.click();
			await page.getByRole('dialog', { name: 'Choose a model', exact: true }).waitFor();
			await page.keyboard.press('Escape');
			await page.locator('.composer').evaluate((el) => (el.style.maxWidth = ''));
			await page.waitForFunction(
				() => document.querySelector('.composer-model-name').getBoundingClientRect().width > 0,
			);
			await page.evaluate(() => (document.body.style.zoom = '1.25'));
			await page.waitForTimeout(250);
			const zoomed = await page
				.locator('.composer-model-name')
				.evaluate(
					(el) => el.getBoundingClientRect().width > 0 && el.scrollWidth <= el.clientWidth + 1,
				);
			assert(zoomed);
			await page.evaluate(() => (document.body.style.zoom = ''));
		}
	}
	assert.deepEqual(errors, []);
	console.log('NATIVE PASS', profile);
} finally {
	if (app) await app.close();
}
