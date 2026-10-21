import { _electron as electron, expect as baseExpect } from '@playwright/test';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

// Launch the real built app against one disposable profile, then actually quit
// and relaunch it. No user profile, real provider, or generated content is used.
const expect = baseExpect.configure({ timeout: 20_000 });
const profile = await mkdtemp(path.join(os.tmpdir(), 'freelm-navigation-restore-'));
const seedModule = path.join(profile, 'seed.mjs');
const navigationKey = 'freelm-navigation-v1';
await build({
	stdin: {
		contents:
			'export { initialState } from "./src/lib/state"; export { StateStore } from "./electron/state-store";',
		resolveDir: process.cwd(),
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	outfile: seedModule,
});
const { initialState, StateStore } = await import(pathToFileURL(seedModule).href);
const state = initialState();
state.backgroundNotifications = false;
state.memorySettings = { savedMemories: false, referenceHistory: false };
state.connections[0].baseUrl = 'http://127.0.0.1:1/v1';
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
const executablePath = process.env.FREELM_SMOKE_EXECUTABLE;
const rendererErrors = [];
let app;
let page;
let launchCount = 0;
const rail = (label) =>
	page.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', {
		name: label,
		exact: true,
	});
const savedNavigation = () =>
	page.evaluate((key) => JSON.parse(localStorage.getItem(key) || 'null'), navigationKey);
const assertSurface = async (label) => {
	await expect(rail(label)).toHaveAttribute('aria-current', 'page');
	await expect(page.locator('vite-error-overlay')).toHaveCount(0);
	if (label !== 'Home') {
		await expect
			.poll(async () => (await savedNavigation())?.mode)
			.toBe(label === 'Video' ? 'videos' : label.toLowerCase());
	}
};
const assertConversation = async (kind) => {
	await assertSurface('Home');
	await expect(page.getByRole('combobox', { name: 'Conversation mode', exact: true })).toHaveText(
		kind === 'code' ? 'Code' : 'Chat',
	);
	await expect
		.poll(async () => {
			const saved = await savedNavigation();
			return [saved?.mode, saved?.conversationKind];
		})
		.toEqual([kind, kind]);
};
const setConversation = async (kind) => {
	await rail('Home').click();
	await page.getByRole('combobox', { name: 'Conversation mode', exact: true }).click();
	await page.getByRole('listbox').locator(`[role="option"][data-value="${kind}"]`).click();
	await assertConversation(kind);
};
const launch = async () => {
	app = await electron.launch({
		...(executablePath
			? { executablePath, args: [`--user-data-dir=${path.join(profile, 'electron')}`] }
			: { args: ['.'] }),
		env,
	});
	launchCount += 1;
	page = await app.firstWindow();
	page.setDefaultTimeout(20_000);
	page.on('pageerror', (error) => rendererErrors.push(error.message));
	await expect(page).toHaveTitle('FreeLM');
	assert.match(page.url(), /\/dist\/index\.html$/);
	await expect(rail('Home')).toBeVisible({ timeout: 30_000 });
};
const restart = async () => {
	await app.close();
	app = undefined;
	await launch();
};

try {
	await launch();
	await assertConversation('chat');

	await setConversation('code');
	await rail('Images').click();
	await assertSurface('Images');
	await restart();
	await assertSurface('Images');
	await page.screenshot({ path: '/tmp/freelm-navigation-restore-images.png' });
	await rail('Home').click();
	await assertConversation('code');
	await restart();
	await assertConversation('code');

	await setConversation('chat');
	await restart();
	await assertConversation('chat');

	for (const label of ['Bots', 'Workflows', 'Video']) {
		await rail(label).click();
		await assertSurface(label);
		await page.reload();
		await assertSurface(label);
	}
	await rail('Audio').click();
	await assertSurface('Audio');
	await page.getByRole('tab', { name: 'Transcription', exact: true }).click();
	await expect(page.getByRole('tab', { name: 'Transcription', exact: true })).toHaveAttribute(
		'aria-selected',
		'true',
	);
	await expect.poll(async () => (await savedNavigation())?.audioMode).toBe('transcription');
	await restart();
	await assertSurface('Audio');
	await expect(page.getByRole('tab', { name: 'Transcription', exact: true })).toHaveAttribute(
		'aria-selected',
		'true',
	);
	await page.screenshot({ path: '/tmp/freelm-navigation-restore-audio.png' });

	// Settings is temporary UI: reopening should return to the actual workspace.
	await page.getByRole('button', { name: 'Personal workspace settings', exact: true }).click();
	await expect(
		page.getByRole('button', { name: 'Personal workspace settings', exact: true }),
	).toHaveAttribute('aria-current', 'page');
	await restart();
	await assertSurface('Audio');
	await expect(page.getByRole('tab', { name: 'Transcription', exact: true })).toHaveAttribute(
		'aria-selected',
		'true',
	);
	await page.getByRole('tab', { name: 'Text to speech', exact: true }).click();
	await rail('Images').click();
	await rail('Audio').click();
	await expect(page.getByRole('tab', { name: 'Text to speech', exact: true })).toHaveAttribute(
		'aria-selected',
		'true',
	);
	await page.reload();
	await assertSurface('Audio');
	await expect(page.getByRole('tab', { name: 'Text to speech', exact: true })).toHaveAttribute(
		'aria-selected',
		'true',
	);

	// A corrupted preference must not prevent opening the real application.
	await page.evaluate((key) => localStorage.setItem(key, '{invalid JSON'), navigationKey);
	await page.reload();
	await assertConversation('chat');
	await expect(page.locator('.storage-error')).toHaveCount(0);
	assert.deepEqual(rendererErrors, []);
	assert.equal(launchCount, 6);
	console.log(
		'Navigation restore passed: fresh Chat default; five real quit/relaunch cycles; Images, Code, Chat, and Audio Transcription restoration; remembered Home mode; Bots/Workflows/Video reloads; Speech restoration; Settings does not replace the workspace; corrupted preference fallback.',
	);
} finally {
	await app?.close();
	await rm(profile, { recursive: true, force: true });
}
