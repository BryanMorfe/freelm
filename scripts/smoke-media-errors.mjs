import { _electron as electron, expect as baseExpect } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

// Built renderer + preload + real transport, isolated from the user's profile.
// The local provider only returns fixture failures; no generation is performed.
const expect = baseExpect.configure({ timeout: 20_000 });
const profile = await mkdtemp(path.join(os.tmpdir(), 'freelm-media-errors-'));
const seedModule = path.join(profile, 'seed.mjs');
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
const reason = 'The evaluator is unavailable. Check its connection in Settings, then retry.';
const wrapped = `Error invoking remote method 'freelm:request': MediaModerationError: ${reason}\n    at fixture (/private/fixture/evaluator.js:12:4)`;
const requests = [];
const fixtureErrors = [];
const provider = createServer(async (request, response) => {
	try {
		for await (const _part of request) {
			/* drain only synthetic fixture inputs */
		}
		assert.equal(request.method, 'POST');
		assert(
			[
				'/v1/images/generations',
				'/v1/videos',
				'/v1/audio/speech',
				'/v1/audio/transcriptions',
			].includes(request.url),
		);
		requests.push(request.url);
		response.writeHead(503, { 'content-type': 'application/json' });
		response.end(JSON.stringify({ error: { message: wrapped } }));
	} catch (error) {
		fixtureErrors.push(error.message);
		response.writeHead(500, { 'content-type': 'application/json' });
		response.end(JSON.stringify({ error: { message: error.message } }));
	}
});
let app;
try {
	await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
	const state = initialState();
	state.backgroundNotifications = false;
	state.memorySettings = { savedMemories: false, referenceHistory: false };
	state.moderation.image.enabled = false;
	state.moderation.video.enabled = false;
	const connection = state.connections[0];
	connection.name = 'Error fixture';
	connection.baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;
	for (const kind of ['images', 'videos', 'speech', 'transcription'])
		connection.models[kind] = kind;
	connection.catalog = [
		{
			id: 'images',
			tasks: ['images'],
			inputModalities: ['text', 'image'],
			outputModalities: ['image'],
		},
		{
			id: 'videos',
			tasks: ['videos'],
			inputModalities: ['text', 'image'],
			outputModalities: ['video'],
		},
		{ id: 'speech', tasks: ['speech'], inputModalities: ['text'], outputModalities: ['audio'] },
		{
			id: 'transcription',
			tasks: ['transcription'],
			inputModalities: ['audio'],
			outputModalities: ['text'],
		},
	].map((definition) => ({
		...definition,
		name: `Fixture ${definition.id}`,
		enabled: true,
		thinkingModes: [],
	}));
	state.generations = ['images', 'videos', 'speech', 'transcription'].map((kind, index) => ({
		id: `saved-${kind}`,
		kind,
		prompt: `Saved ${kind} failure`,
		model: kind,
		connectionId: connection.id,
		createdAt: Date.now() - index,
		status: 'failed',
		assets: [],
		error: wrapped,
	}));
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
	app = await electron.launch({
		...(executablePath
			? { executablePath, args: [`--user-data-dir=${path.join(profile, 'electron')}`] }
			: { args: ['.'] }),
		env,
	});
	const page = await app.firstWindow();
	page.setDefaultTimeout(20_000);
	const consoleErrors = [];
	page.on('pageerror', (error) => consoleErrors.push(error.message));
	page.on('console', (entry) => {
		if (entry.type() === 'error') consoleErrors.push(entry.text());
	});
	await expect(page).toHaveTitle('FreeLM');
	assert.match(page.url(), /\/dist\/index\.html$/);
	await expect(page.getByRole('heading', { name: 'What’s on your mind?' })).toBeVisible();
	const assertClean = async (locator) => {
		await expect(locator).toContainText(reason);
		await expect(locator).not.toContainText(
			/Error invoking|freelm:request|MediaModerationError|private\/fixture|\[object Object\]/,
		);
	};
	for (const kind of ['images', 'videos']) {
		await page
			.getByRole('button', { name: kind === 'images' ? 'Images' : 'Video', exact: true })
			.click();
		await assertClean(page.locator('.image-job-card').filter({ hasText: `Saved ${kind} failure` }));
		const prompt = `Live ${kind} failure`;
		await page.getByLabel('Generation prompt', { exact: true }).fill(prompt);
		const before = requests.length;
		await page
			.getByRole('button', {
				name: kind === 'images' ? 'Generate image' : 'Generate video',
				exact: true,
			})
			.click();
		await expect.poll(() => requests.length).toBe(before + 1);
		await assertClean(page.locator('.image-compose-error'));
		await assertClean(page.locator('.image-job-card').filter({ hasText: prompt }));
		await page.screenshot({ path: `/tmp/freelm-media-errors-${kind}.png` });
		await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();
		await expect(page.locator('.image-compose-error')).toHaveCount(0);
		await page
			.locator('.image-job-card')
			.filter({ hasText: prompt })
			.getByRole('button', { name: 'Retry generation', exact: true })
			.click();
		await expect.poll(() => requests.length).toBe(before + 2);
		await assertClean(page.locator('.image-compose-error'));
	}
	await page.getByRole('button', { name: 'Audio', exact: true }).click();
	await page.getByRole('button', { name: 'Open Saved speech failure', exact: true }).click();
	await assertClean(page.locator('.media-job-state'));
	await page.getByLabel('Text to speak', { exact: true }).fill('Live speech failure');
	await page.getByRole('button', { name: 'Generate speech', exact: true }).click();
	await expect.poll(() => requests.filter((url) => url === '/v1/audio/speech').length).toBe(1);
	await assertClean(page.locator('.media-job-state'));
	await page.screenshot({ path: '/tmp/freelm-media-errors-speech.png' });
	await page.getByRole('button', { name: 'Open Saved transcription failure', exact: true }).click();
	await assertClean(page.locator('.media-job-state'));
	await expect(page.getByRole('tab', { name: 'Transcription', exact: true })).toHaveAttribute(
		'aria-selected',
		'true',
	);
	const chooser = page.waitForEvent('filechooser');
	await page.locator('.media-composer').getByRole('button', { name: 'Audio', exact: true }).click();
	// A valid, silent 8 kHz PCM WAV, used only as a disposable upload fixture.
	const wav = Buffer.alloc(60);
	wav.write('RIFF');
	wav.writeUInt32LE(52, 4);
	wav.write('WAVEfmt ', 8);
	wav.writeUInt32LE(16, 16);
	wav.writeUInt16LE(1, 20);
	wav.writeUInt16LE(1, 22);
	wav.writeUInt32LE(8000, 24);
	wav.writeUInt32LE(16000, 28);
	wav.writeUInt16LE(2, 32);
	wav.writeUInt16LE(16, 34);
	wav.write('data', 36);
	wav.writeUInt32LE(16, 40);
	await (await chooser).setFiles({ name: 'fixture.wav', mimeType: 'audio/wav', buffer: wav });
	await page.getByRole('button', { name: 'Transcribe', exact: true }).click();
	await expect
		.poll(() => requests.filter((url) => url === '/v1/audio/transcriptions').length)
		.toBe(1);
	await assertClean(page.locator('.media-job-state'));
	await page.screenshot({ path: '/tmp/freelm-media-errors-transcription.png' });
	await expect(page.locator('vite-error-overlay')).toHaveCount(0);
	assert.deepEqual(consoleErrors, []);
	assert.deepEqual(fixtureErrors, []);
	await expect
		.poll(async () => {
			const saved = JSON.parse(await readFile(path.join(profile, 'workspace.json'), 'utf8'));
			return saved.generations.filter((item) => item.error?.includes(wrapped)).length;
		})
		.toBe(10);
	console.log(
		'Media errors passed: four saved failures, live image/video/speech/transcription failures, image/video retries, clean presentation, and preserved raw diagnostics.',
	);
} finally {
	await app?.close();
	await new Promise((resolve) => provider.close(resolve));
	await rm(profile, { recursive: true, force: true });
}
