import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

// Real playground -> Electron IPC -> multipart HTTP, with a disposable profile
// and a loopback-only provider. No real account, API, or generated video is used.
const reference = await readFile(new URL('../tests/fixtures/reference.avif', import.meta.url));
const profile = await mkdtemp(path.join(os.tmpdir(), 'freelm-avif-playgrounds-'));
const png =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFioAAAAASUVORK5CYII=';
const received = [];
const fixtureErrors = [];
let rejectVideo = false;
const providerError = 'Reference image must be PNG, JPEG, WebP, HEIC, or HEIF';
const provider = createServer(async (request, response) => {
	try {
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		if (request.method === 'POST' && ['/v1/images/edits', '/v1/videos'].includes(request.url)) {
			assert.match(request.headers['content-type'], /^multipart\/form-data; boundary=/);
			const form = await new Request('http://localhost/fixture', {
				method: 'POST',
				headers: { 'content-type': request.headers['content-type'] },
				body: Buffer.concat(chunks),
			}).formData();
			const image = form.get(request.url.endsWith('/videos') ? 'input_reference' : 'image');
			assert.equal(image.name, 'reference.avif');
			assert.equal(image.type, 'image/avif');
			assert.deepEqual(Buffer.from(await image.arrayBuffer()), reference);
			assert.equal(form.get('prompt'), 'A blue abstract shape');
			received.push({
				path: request.url,
				filename: image.name,
				mimeType: image.type,
				bytes: reference.length,
			});
			response.writeHead(rejectVideo && request.url.endsWith('/videos') ? 400 : 200, {
				'content-type': 'application/json',
			});
			response.end(
				JSON.stringify(
					request.url.endsWith('/edits')
						? { data: [{ b64_json: png }] }
						: rejectVideo
							? { error: { message: providerError } }
							: { id: 'native-avif-video', status: 'queued', progress: 0 },
				),
			);
		} else if (request.method === 'GET' && request.url === '/v1/videos/native-avif-video') {
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(JSON.stringify({ id: 'native-avif-video', status: 'queued', progress: 0 }));
		} else {
			throw new Error(`Unexpected fixture request: ${request.method} ${request.url}`);
		}
	} catch (error) {
		fixtureErrors.push(error.message);
		response.writeHead(500, { 'content-type': 'application/json' });
		response.end(JSON.stringify({ error: { message: error.message } }));
	}
});
let app;
try {
	await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
	const baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;
	const config = {
		format: 'freelm-config-v1',
		version: 1,
		encryptedKeys: {},
		theme: 'dark',
		backgroundNotifications: false,
		activeConnectionId: 'avif-fixture',
		moderation: {
			image: { enabled: false, level: 'low', connectionId: '', model: '', thinkingMode: '' },
			video: {
				enabled: false,
				level: 'low',
				connectionId: '',
				model: '',
				thinkingMode: '',
				videoApi: 'chat/completions',
			},
		},
		connections: [
			{
				id: 'avif-fixture',
				name: 'AVIF fixture',
				baseUrl,
				apiKey: '',
				chatApi: 'responses',
				discoveredModels: [],
				models: { chat: '', images: 'image', videos: 'video', speech: '', transcription: '' },
				catalog: ['image', 'video'].map((kind) => ({
					id: kind,
					name: `Fixture ${kind}`,
					enabled: true,
					tasks: [kind === 'image' ? 'images' : 'videos'],
					inputModalities: ['text', 'image'],
					outputModalities: [kind === 'image' ? 'image' : 'video'],
					thinkingModes: [],
				})),
			},
		],
	};
	await writeFile(path.join(profile, 'config.json'), JSON.stringify(config), { mode: 0o600 });
	await writeFile(
		path.join(profile, 'workspace.json'),
		JSON.stringify({
			format: 'freelm-workspace-v2',
			version: 1,
			threads: [],
			projects: [],
			generations: [],
		}),
		{ mode: 0o600 },
	);
	const env = { ...process.env, FREELM_USER_DATA: profile, FREELM_HOME: profile };
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.FREELM_DEV_URL;
	app = await electron.launch({ args: ['.'], env });
	const page = await app.firstWindow();
	const errors = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (entry) => {
		if (entry.type() === 'error') errors.push(entry.text());
	});
	await expect(page).toHaveTitle('FreeLM');
	await expect(page.getByRole('heading', { name: 'What’s on your mind?' })).toBeVisible();
	for (const kind of ['image', 'video', 'video']) {
		await page
			.getByRole('button', { name: kind === 'image' ? 'Images' : 'Video', exact: true })
			.click();
		const composer = page.locator('.image-composer');
		const chooser = page.waitForEvent('filechooser');
		await composer
			.getByRole('button', {
				name: kind === 'image' ? 'Add reference images' : 'Add reference image',
				exact: true,
			})
			.click();
		await (
			await chooser
		).setFiles({ name: 'reference.avif', mimeType: 'image/avif', buffer: reference });
		const preview = composer.getByRole('img', { name: 'reference.avif', exact: true });
		await expect
			.poll(() => preview.evaluate((image) => [image.naturalWidth, image.naturalHeight]))
			.toEqual([16, 12]);
		await composer.getByLabel('Generation prompt', { exact: true }).fill('A blue abstract shape');
		await page.screenshot({ path: `/tmp/freelm-native-${kind}-avif-preview.png` });
		const expectedCount = received.length + 1;
		await composer
			.getByRole('button', {
				name: kind === 'image' ? 'Edit image' : 'Generate video',
				exact: true,
			})
			.click();
		await expect.poll(() => received.length).toBe(expectedCount);
		if (rejectVideo) {
			await expect(page.locator('.image-compose-error')).toContainText(providerError);
			await page.screenshot({ path: '/tmp/freelm-native-video-avif-provider-error.png' });
		} else if (kind === 'image') {
			await expect(page.locator('.image-gallery-card:not(.image-job-card)')).toHaveCount(1);
			await expect(page.locator('.image-compose-error')).toHaveCount(0);
			await page.getByRole('button', { name: 'Close image viewer', exact: true }).click();
		} else {
			await composer.getByRole('button', { name: 'Pause checking', exact: true }).click();
			await expect(page.locator('.image-compose-error')).toHaveCount(0);
			rejectVideo = true;
		}
	}
	assert.deepEqual(fixtureErrors, []);
	assert.deepEqual(errors, []);
	console.log(
		JSON.stringify({
			result: 'passed',
			received,
			decodedPreview: '16x12',
			providerRejection: 'displayed unchanged',
			moderation: 'disabled to isolate transport',
			profile: 'disposable',
			provider: 'loopback fixture',
		}),
	);
} finally {
	await app?.evaluate(({ app }) => app.exit(0)).catch(() => {});
	await app?.close().catch(() => {});
	await new Promise((resolve) => {
		provider.close(resolve);
		provider.closeAllConnections();
	});
	await rm(profile, { recursive: true, force: true });
}
