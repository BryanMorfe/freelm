import { _electron as electron, expect as baseExpect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

// First-run UX in the actual production app. All state is disposable, and only
// loopback model discovery is allowed; no inference or real credentials are used.
const expect = baseExpect.configure({ timeout: 15_000 });
const profile = await mkdtemp(path.join(os.tmpdir(), 'freelm-setup-'));
let behavior = 'hold';
let requestCount = 0;
const provider = createServer((request, response) => {
	requestCount++;
	if (request.url !== '/v1/models' || request.method !== 'GET') {
		response.writeHead(500).end();
		return;
	}
	if (behavior === 'hold') return;
	response.writeHead(behavior === 'error' ? 503 : 200, { 'content-type': 'application/json' });
	response.end(
		JSON.stringify(
			behavior === 'error'
				? { error: { message: 'Synthetic discovery unavailable. Try again.' } }
				: { data: [{ id: 'fixture-standard' }] },
		),
	);
});
let app;
try {
	await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
	const env = { ...process.env, FREELM_HOME: profile, FREELM_USER_DATA: profile };
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.FREELM_DEV_URL;
	const errors = [];
	const launch = async () => {
		app = await electron.launch({ args: ['.'], env });
		const page = await app.firstWindow();
		page.on('pageerror', (error) => errors.push(error.message));
		await expect(page).toHaveTitle('FreeLM');
		await expect(page.locator('.app-shell')).toBeVisible({ timeout: 30_000 });
		return page;
	};
	let page = await launch();
	const setup = () =>
		page.getByRole('button', { name: 'Connect an API to get started Set up', exact: true });
	const settings = () => page.getByRole('region', { name: 'Settings', exact: true });
	// An empty picker offers configuration directly, without needing a guessed model ID.
	await page.getByRole('button', { name: 'Chat model', exact: true }).click();
	await page.getByRole('button', { name: 'Configure models', exact: true }).click();
	await expect(
		settings().getByRole('heading', { name: 'Model discovery', exact: true }),
	).toBeVisible();
	await settings().getByRole('button', { name: 'Back to workspace', exact: true }).click();
	// The primary first-run action works with the keyboard and opens connection details.
	await setup().focus();
	await page.keyboard.press('Enter');
	await expect(settings().getByLabel('API base URL', { exact: true })).toBeVisible();
	await settings().getByRole('button', { name: 'Back to workspace', exact: true }).click();
	await page.getByRole('combobox', { name: 'Conversation mode', exact: true }).click();
	await page.getByRole('listbox').locator('[role="option"][data-value="code"]').click();
	await setup().click();
	await expect(settings().getByLabel('API base URL', { exact: true })).toBeVisible();
	await settings().getByLabel('Connection name', { exact: true }).fill('Disposable setup provider');
	await settings()
		.getByLabel('API base URL', { exact: true })
		.fill(`http://127.0.0.1:${provider.address().port}/v1`);
	await settings().getByLabel('Chat endpoint', { exact: true }).click();
	await page.getByRole('listbox').locator('[role="option"][data-value="chat/completions"]').click();
	await settings().getByRole('button', { name: 'Configure models', exact: true }).click();
	await expect(
		settings().getByRole('heading', { name: 'Model discovery', exact: true }),
	).toBeVisible();
	await settings().getByRole('button', { name: 'Edit connection', exact: true }).click();
	await expect(settings().getByLabel('Connection name', { exact: true })).toHaveValue(
		'Disposable setup provider',
	);
	await settings().getByRole('button', { name: 'Configure models', exact: true }).click();
	// Held discovery shows a cancellable loading state and keeps connection edits.
	await settings().getByRole('button', { name: 'Discover models', exact: true }).click();
	await expect(
		settings().getByRole('button', { name: 'Discovering…', exact: true }),
	).toBeDisabled();
	await expect.poll(() => requestCount).toBe(1);
	await settings().getByRole('button', { name: 'Cancel discovery', exact: true }).click();
	await expect(
		settings().getByRole('status').filter({ hasText: 'Model discovery cancelled.' }),
	).toBeVisible();
	behavior = 'error';
	await settings().getByRole('button', { name: 'Discover models', exact: true }).click();
	await expect(settings().getByRole('alert')).toContainText(
		'Synthetic discovery unavailable. Try again.',
	);
	behavior = 'success';
	await settings().getByRole('button', { name: 'Discover models', exact: true }).click();
	await expect(
		settings().getByRole('button', { name: 'Configure model fixture-standard', exact: true }),
	).toBeVisible();
	await expect(settings().getByRole('alert')).toHaveCount(0);
	await expect(settings().getByRole('status').filter({ hasText: 'Found 1 model.' })).toBeVisible();
	await settings().getByRole('button', { name: 'Save settings', exact: true }).click();
	await expect(settings().getByRole('status').filter({ hasText: 'Settings saved' })).toBeVisible();
	await page.screenshot({ path: '/tmp/freelm-ux-configuration-after.png' });
	await settings().getByRole('button', { name: 'Edit connection', exact: true }).click();
	await page.screenshot({ path: '/tmp/freelm-ux-connections-after.png' });
	// Leaving with draft edits still requires a deliberate choice; discard is durable.
	await settings().getByLabel('Connection name', { exact: true }).fill('Discard this draft');
	await settings().getByRole('button', { name: 'Back to workspace', exact: true }).click();
	await settings().getByRole('button', { name: 'Keep editing', exact: true }).click();
	await expect(settings().getByLabel('Connection name', { exact: true })).toHaveValue(
		'Discard this draft',
	);
	await settings().getByRole('button', { name: 'Back to workspace', exact: true }).click();
	await settings().getByRole('button', { name: 'Discard changes', exact: true }).click();
	const rail = (label) =>
		page
			.getByRole('navigation', { name: 'Workspaces', exact: true })
			.getByRole('button', { name: label, exact: true });
	await rail('Bots').click();
	await page.getByRole('button', { name: 'Create a bot', exact: true }).last().click();
	await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Unsaved synthetic bot');
	await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
	await page.getByRole('button', { name: 'Create a bot', exact: true }).last().click();
	await expect(page.getByRole('dialog').getByLabel('Name', { exact: true })).toHaveValue('');
	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await rail('Home').click();
	await expect(page.getByRole('combobox', { name: 'Conversation mode', exact: true })).toHaveText(
		'Code',
	);
	await app.close();
	app = undefined;
	page = await launch();
	await expect(page.getByRole('combobox', { name: 'Conversation mode', exact: true })).toHaveText(
		'Code',
	);
	await page.getByRole('button', { name: 'Personal workspace settings', exact: true }).click();
	await settings().getByRole('button', { name: 'Edit connection', exact: true }).click();
	await expect(settings().getByLabel('Connection name', { exact: true })).toHaveValue(
		'Disposable setup provider',
	);
	await expect(settings().getByLabel('Chat endpoint', { exact: true })).toHaveText(
		'/chat/completions',
	);
	await app
		.browserWindow(page)
		.then((window) => window.evaluate((window) => window.setSize(760, 900)));
	await page.screenshot({ path: '/tmp/freelm-ux-connections-narrow.png' });
	await settings().getByRole('button', { name: 'Configure models', exact: true }).click();
	await page.screenshot({ path: '/tmp/freelm-ux-configuration-narrow.png' });
	await expect(page.locator('vite-error-overlay')).toHaveCount(0);
	const saved = JSON.parse(await readFile(path.join(profile, 'config.json'), 'utf8'));
	assert.equal(saved.connections[0].name, 'Disposable setup provider');
	assert.deepEqual(errors, []);
	assert.equal(requestCount, 3, 'Only three synthetic model-discovery requests are expected');
	console.log(
		'Setup UX smoke passed: keyboard setup, connection/model links, loading/cancel/error/retry, draft/discard, Chat/Code/Bots navigation, bot cancel/reopen, native relaunch persistence, narrow settings; no inference.',
	);
} finally {
	await app?.close();
	provider.closeAllConnections();
	await new Promise((resolve) => provider.close(resolve));
	await rm(profile, { recursive: true, force: true });
}
