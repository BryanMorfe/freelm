import { _electron as electron, expect } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

// Real production renderer, native transport, storage, and two app launches.
// Only a disposable profile and loopback provider are used; no real keys or API usage.
const profile = await mkdtemp(path.join(os.tmpdir(), 'freelm-provider-contract-'));
const requests = [];
const fixtureErrors = [];
const prompt = 'Check Standard mode in the actual desktop app.';
const answer = 'Standard mode works without reasoning parameters.';
const invalidTitle = 'Truncated fixture title';
const provider = createServer(async (request, response) => {
	try {
		assert.equal(request.url, '/v1/chat/completions');
		assert.equal(request.method, 'POST');
		let raw = '';
		for await (const chunk of request) raw += chunk;
		const body = JSON.parse(raw);
		for (const key of ['reasoning', 'reasoning_effort', 'useProviderDefaults'])
			assert.equal(Object.hasOwn(body, key), false, `${key} must not reach the provider`);
		const title = body.messages?.some(
			(message) =>
				message.role === 'system' && message.content.startsWith('Write a short conversation title'),
		);
		requests.push({ title, body });
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end(
			JSON.stringify({
				choices: [
					{
						message: { role: 'assistant', content: title ? invalidTitle : answer },
						finish_reason: title ? 'length' : 'stop',
					},
				],
			}),
		);
	} catch (error) {
		fixtureErrors.push(error.message);
		response.writeHead(500, { 'content-type': 'application/json' });
		response.end(JSON.stringify({ error: { message: 'Provider fixture contract failed.' } }));
	}
});
let app;
try {
	await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
	const seedModule = path.join(profile, 'seed.mjs');
	await build({
		stdin: {
			contents:
				'export { initialState } from "./src/lib/state"; export { standardThinkingMode } from "./src/lib/catalog"; export { StateStore } from "./electron/state-store";',
			resolveDir: process.cwd(),
		},
		bundle: true,
		platform: 'node',
		format: 'esm',
		outfile: seedModule,
	});
	const { initialState, standardThinkingMode, StateStore } = await import(
		pathToFileURL(seedModule).href
	);
	const state = initialState();
	state.backgroundNotifications = false;
	state.memorySettings = { savedMemories: false, referenceHistory: false };
	const connection = state.connections[0];
	connection.name = 'Synthetic compatibility provider';
	connection.baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;
	connection.chatApi = 'chat/completions';
	connection.models.chat = 'fixture-standard';
	connection.catalog = [
		{
			id: 'fixture-standard',
			name: 'Fixture Standard model',
			enabled: true,
			tasks: ['chat'],
			inputModalities: ['text'],
			outputModalities: ['text'],
			thinkingModes: [standardThinkingMode()],
			defaultThinkingMode: 'standard',
		},
	];
	await new StateStore(
		path.join(profile, 'workspace.json'),
		{
			available: () => false,
			encrypt: () => {
				throw new Error('No fixture secrets');
			},
			decrypt: () => {
				throw new Error('No fixture secrets');
			},
		},
		path.join(profile, 'config.json'),
	).save(state);
	const env = { ...process.env, FREELM_HOME: profile, FREELM_USER_DATA: profile };
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.FREELM_DEV_URL;
	const errors = [];
	for (let launch = 0; launch < 2; launch++) {
		app = await electron.launch({ args: ['.'], env });
		const page = await app.firstWindow();
		page.on('pageerror', (error) => errors.push(error.message));
		await expect(page).toHaveTitle('FreeLM');
		await expect(page.locator('.app-shell')).toBeVisible({ timeout: 30000 });
		await expect(page.getByRole('button', { name: 'Chat model', exact: true })).toContainText(
			'Standard',
		);
		if (!launch) {
			await page.getByLabel('Message', { exact: true }).fill(prompt);
			await page.getByRole('button', { name: 'Send message', exact: true }).click();
			await expect(page.locator('.message.assistant')).toContainText(answer);
			await expect.poll(() => requests.some((entry) => entry.title)).toBe(true);
			await expect
				.poll(async () => {
					const saved = JSON.parse(await readFile(path.join(profile, 'workspace.json'), 'utf8'));
					return saved.threads[0]?.messages.at(-1)?.content;
				})
				.toBe(answer);
		} else {
			await page.getByRole('button', { name: prompt, exact: true }).click();
			await expect(page.locator('.message.assistant')).toContainText(answer);
		}
		const saved = await page.evaluate(
			async () => (await window.desktop.workspaceLoad('local')).state,
		);
		assert.notEqual(
			saved.threads[0].title,
			invalidTitle,
			'A truncated title must not overwrite the thread title',
		);
		assert.equal(saved.connections[0].catalog[0].thinkingModes[0].useProviderDefaults, true);
		await expect(page.locator('vite-error-overlay')).toHaveCount(0);
		await page.screenshot({ path: `/tmp/freelm-provider-standard-native-${launch}.png` });
		await app.close();
		app = undefined;
	}
	assert.deepEqual(errors, []);
	assert.deepEqual(fixtureErrors, []);
	assert.equal(
		requests.filter((entry) => !entry.title).length,
		1,
		'Relaunch must not issue another inference',
	);
	console.log(
		'Provider compatibility smoke passed: native Standard-mode omission, JSON Chat response, rejected truncated background title, durable catalog/history, and two real app launches with no extra inference.',
	);
} finally {
	await app?.close();
	provider.closeAllConnections();
	await new Promise((resolve) => provider.close(resolve));
	await rm(profile, { recursive: true, force: true });
}
