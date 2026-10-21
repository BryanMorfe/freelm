import { chooseOption } from './ui-controls';
import { test, expect, type Page, type Request, type Route } from '@playwright/test';

const MODEL_IDS = [
	'custom-chat',
	'custom-image',
	'custom-video',
	'custom-speech',
	'custom-transcribe',
];
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6pAAAAABJRU5ErkJggg==',
	'base64',
);
const FILE = { name: 'reference.png', mimeType: 'image/png', buffer: PNG };
// A 0.2-second H.264 color clip generated locally; exercises actual browser decoding.
const VIDEO = Buffer.from(
	'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAN0bW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAAMgAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAp90cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAAMgAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAACAAAAAgAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAADIAAAEAAABAAAAAAIXbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAyAAAACgBVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABwm1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAYJzdGJsAAAAvnN0c2QAAAAAAAAAAQAAAK5hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAACAAIABIAAAASAAAAAAAAAABFUxhdmM2MS4xOS4xMDEgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAANGF2Y0MBZAAK/+EAF2dkAAqs2UlsBEAAAAMAQAAADIPEiWWAAQAGaOvjyyLA/fj4AAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAHeIAAAAAAAAABhzdHRzAAAAAAAAAAEAAAAFAAACAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAOGN0dHMAAAAAAAAABQAAAAEAAAQAAAAAAQAACgAAAAABAAAEAAAAAAEAAAAAAAAAAQAAAgAAAAAcc3RzYwAAAAAAAAABAAAAAQAAAAUAAAABAAAAKHN0c3oAAAAAAAAAAAAAAAUAAALNAAAADAAAAAwAAAAMAAAADAAAABRzdGNvAAAAAAAAAAEAAAOkAAAAYXVkdGEAAABZbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAsaWxzdAAAACSpdG9vAAAAHGRhdGEAAAABAAAAAExhdmY2MS43LjEwMAAAAAhmcmVlAAADBW1kYXQAAAKuBgX//6rcRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY0IHIzMTA4IDMxZTE5ZjkgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDIzIC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MSByZWY9MyBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgzOjB4MTEzIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0xIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTMgYl9weXJhbWlkPTIgYl9hZGFwdD0xIGJfYmlhcz0wIGRpcmVjdD0xIHdlaWdodGI9MSBvcGVuX2dvcD0wIHdlaWdodHA9MiBrZXlpbnQ9MjUwIGtleWludF9taW49MjUgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD00MCByYz1jcmYgbWJ0cmVlPTEgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MToxLjAwAIAAAAAXZYiEADP//t8y+BTNfHrR6c0WEtSkkf0AAAAIQZokbEK//lYAAAAIQZ5CeIX/VcEAAAAIAZ5hdEK/WsAAAAAIAZ5jakK/WsE=',
	'base64',
);
const cors = {
	'access-control-allow-origin': '*',
	'access-control-allow-headers': '*',
	'access-control-allow-methods': '*',
};

function wav() {
	const data = Buffer.alloc(1644);
	data.write('RIFF');
	data.writeUInt32LE(data.length - 8, 4);
	data.write('WAVEfmt ', 8);
	data.writeUInt32LE(16, 16);
	data.writeUInt16LE(1, 20);
	data.writeUInt16LE(1, 22);
	data.writeUInt32LE(8000, 24);
	data.writeUInt32LE(16000, 28);
	data.writeUInt16LE(2, 32);
	data.writeUInt16LE(16, 34);
	data.write('data', 36);
	data.writeUInt32LE(data.length - 44, 40);
	return data;
}
function responseFrames(text: string) {
	return `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { output_text: text } })}\n\n`;
}
async function json(route: Route, data: unknown, status = 200) {
	await route.fulfill({
		status,
		contentType: 'application/json',
		headers: cors,
		body: JSON.stringify(data),
	});
}
async function mockAPI(page: Page, handler: (route: Route, path: string) => Promise<void>) {
	const requests: Request[] = [];
	await page.route('http://localhost:8000/v1/**', async (route) => {
		if (route.request().method() === 'OPTIONS') {
			await route.fulfill({ status: 204, headers: cors });
			return;
		}
		const path = new URL(route.request().url()).pathname.slice('/v1'.length);
		if (['/responses', '/chat/completions', '/chat'].includes(path)) {
			const body = route.request().postDataJSON();
			const instructions =
				body.instructions ||
				body.messages?.find((message: { role: string }) => message.role === 'system')?.content;
			if (instructions?.startsWith('Write a short conversation title')) {
				await json(
					route,
					path === '/responses'
						? { output_text: 'A thoughtful conversation' }
						: {
								choices: [
									{ message: { content: 'A thoughtful conversation' }, finish_reason: 'stop' },
								],
							},
				);
				return;
			}
		}
		requests.push(route.request());
		if (path === '/models') {
			await json(route, { data: MODEL_IDS.map((id) => ({ id })) });
			return;
		}
		await handler(route, path);
	});
	return requests;
}
async function configure(page: Page, endpoint = 'responses') {
	await page.goto('/');
	await expect(page).toHaveTitle(/FreeLM/);
	await expect(page.getByRole('heading', { name: 'What’s on your mind?' })).toBeVisible({
		timeout: 15_000,
	});
	await page.getByRole('button', { name: /Personal workspace/ }).click();
	const settings = page.getByRole('region', { name: 'Settings', exact: true });
	await settings.getByRole('button', { name: 'Connections', exact: true }).click();
	await settings.getByLabel('Connection name').fill('E2E local');
	await settings.getByLabel('API base URL').fill('http://localhost:8000/v1');
	await settings.getByLabel(/API key/).fill('e2e-test-key');
	await chooseOption(page, settings.getByLabel('Chat endpoint'), endpoint);
	await settings.getByRole('button', { name: 'Configuration', exact: true }).click();
	await settings.getByRole('button', { name: 'Discover models' }).click();
	await expect(settings.getByRole('status').filter({ hasText: 'Found 5 models.' })).toContainText(
		'Found 5 models.',
	);
	await expect(settings.locator('.catalog-entry')).toHaveCount(5);
	for (const [index, label] of ['Chat', 'Images', 'Video', 'Speech', 'Transcription'].entries()) {
		await settings
			.getByRole('button', { name: `Configure model ${MODEL_IDS[index]}`, exact: true })
			.click();
		const editor = settings.getByRole('group', { name: 'New catalog model' });
		if (label !== 'Chat') {
			await editor.getByLabel('Available in: Chat', { exact: true }).uncheck();
			await editor.getByLabel(`Available in: ${label}`, { exact: true }).check();
		}
		if (['Chat', 'Images', 'Video'].includes(label))
			await editor.getByLabel('Input modalities: image', { exact: true }).check();
		if (label === 'Transcription') {
			await editor.getByLabel('Input modalities: audio', { exact: true }).check();
		}
		if (['Images', 'Video', 'Speech'].includes(label)) {
			await editor.getByLabel('Output modalities: text', { exact: true }).uncheck();
			await editor
				.getByLabel(
					`Output modalities: ${label === 'Images' ? 'image' : label === 'Video' ? 'video' : 'audio'}`,
					{ exact: true },
				)
				.check();
		}
		if (label === 'Chat')
			await editor.getByRole('button', { name: 'Add thinking value Low', exact: true }).click();
		await editor.getByLabel(`Use as default for: ${label}`, { exact: true }).check();
		await editor.getByRole('button', { name: 'Apply model', exact: true }).click();
	}

	await settings.getByRole('button', { name: 'Save settings' }).click();
	await expect(settings.getByText('Settings saved', { exact: true })).toBeVisible();
	await settings.getByRole('button', { name: 'Back to workspace' }).click();
	await expect(settings).toBeHidden();
	const model = page.getByRole('button', { name: 'Chat model', exact: true });
	await expect(model.locator('.composer-model-name')).toHaveText('custom-chat');
	await expect(model.locator('.composer-thinking-value')).toHaveText('Low');
}
async function persistedState(page: Page) {
	return page.evaluate(async () => {
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const open = indexedDB.open('freelm-workspace', 1);
			open.onsuccess = () => resolve(open.result);
			open.onerror = () => reject(open.error);
		});
		try {
			return await new Promise<any>((resolve, reject) => {
				const get = db.transaction('state', 'readonly').objectStore('state').get('workspace');
				get.onsuccess = () => resolve(get.result);
				get.onerror = () => reject(get.error);
			});
		} finally {
			db.close();
		}
	});
}

test('discovers models, sends project instructions and images, and restores chat history without saving API keys', async ({
	page,
}) => {
	test.setTimeout(120_000);
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	const requests = await mockAPI(page, async (route) => {
		await route.fulfill({
			contentType: 'text/event-stream',
			headers: cors,
			body: responseFrames('A thoughtful response with **Markdown**.'),
		});
	});
	await configure(page);
	await page.getByRole('button', { name: 'New project', exact: true }).click();
	await page.getByLabel('Project name').fill('Studio');
	await page.getByLabel('Project instructions').fill('Respond with concise creative advice.');
	await page.getByRole('button', { name: 'Create project', exact: true }).click();
	await page.getByRole('button', { name: 'New chat in Studio', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Studio', exact: true })).toHaveAttribute(
		'aria-current',
		'page',
	);
	await page.locator('.composer input[type="file"]').setInputFiles(FILE);
	await page.getByLabel('Message', { exact: true }).fill('Discuss this image');
	await page.getByRole('button', { name: 'Send message' }).click();
	await expect(page.locator('.message.assistant')).toContainText(
		'A thoughtful response with Markdown.',
	);
	await expect(page.locator('.message.assistant strong')).toHaveText('Markdown');
	const wire = requests.find((request) => request.url().endsWith('/responses'))!;
	expect(wire.headers().authorization).toBe('Bearer e2e-test-key');
	expect(wire.postDataJSON()).toMatchObject({
		model: 'custom-chat',
		instructions: 'Respond with concise creative advice.',
		input: [
			{
				role: 'user',
				content: [
					{ type: 'input_text', text: 'Discuss this image' },
					{ type: 'input_image', image_url: expect.stringContaining('data:image/png;base64,') },
				],
			},
		],
	});
	await expect
		.poll(async () => (await persistedState(page))?.threads?.[0]?.messages?.at(-1)?.content)
		.toContain('A thoughtful response');
	const state = await persistedState(page);
	expect(state.connections[0].apiKey).toBe('');
	expect(state.connections[0].models).toEqual({
		chat: MODEL_IDS[0],
		images: MODEL_IDS[1],
		videos: MODEL_IDS[2],
		speech: MODEL_IDS[3],
		transcription: MODEL_IDS[4],
	});
	expect(state.connections[0].discoveredModels).toHaveLength(5);
	await page.reload();
	await page
		.getByRole('navigation', { name: 'Chat projects' })
		.getByRole('button', { name: state.threads[0].title, exact: true })
		.click();
	await expect(page.locator('.history-list')).not.toContainText(state.threads[0].title);
	await expect(page.locator('.message.assistant')).toContainText('A thoughtful response');
	await expect(page.getByRole('button', { name: 'Studio', exact: true })).toHaveAttribute(
		'aria-current',
		'page',
	);
	expect(errors).toEqual([]);
	await page.screenshot({ path: '/tmp/freelm-e2e-chat.png' });
	await page.setViewportSize({ width: 980, height: 700 });
	await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
	await page.screenshot({ path: '/tmp/freelm-e2e-chat-compact.png' });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.getByRole('button', { name: 'Collapse sidebar' }).click();
	await expect(page.getByRole('button', { name: 'Images', exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Expand sidebar', exact: true })).toBeVisible();
	const composer = await page.getByLabel('Message', { exact: true }).boundingBox();
	expect(composer).not.toBeNull();
	expect(composer!.x).toBeGreaterThanOrEqual(0);
	expect(composer!.x + composer!.width).toBeLessThanOrEqual(390);
	await page.screenshot({ path: '/tmp/freelm-sidebar-mobile.png' });
});

test('switches Chat Completions routes and includes the existing conversation on follow-up', async ({
	page,
}) => {
	test.setTimeout(120_000);
	const requests = await mockAPI(page, async (route, path) => {
		const text = path === '/chat' ? 'Alias response' : 'Completions response';
		await route.fulfill({
			contentType: 'text/event-stream',
			headers: cors,
			body: `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
		});
	});
	await configure(page, 'chat/completions');
	await page.getByLabel('Message', { exact: true }).fill('First turn');
	await page.getByRole('button', { name: 'Send message' }).click();
	await expect(page.locator('.message.assistant')).toContainText('Completions response');
	await page.getByRole('button', { name: /Personal workspace/ }).click();
	await page.getByRole('button', { name: 'Connections', exact: true }).click();
	await chooseOption(page, page.getByLabel('Chat endpoint'), 'chat');
	await page.getByRole('button', { name: 'Save settings' }).click();
	await page.getByRole('button', { name: 'Back to workspace' }).click();
	await page.getByLabel('Message', { exact: true }).fill('Second turn');
	await page.getByRole('button', { name: 'Send message' }).click();
	await expect(page.locator('.message.assistant').last()).toContainText('Alias response');
	expect(requests.find((request) => request.url().endsWith('/chat'))?.postDataJSON()).toMatchObject(
		{
			messages: [
				{ role: 'user', content: 'First turn' },
				{ role: 'assistant', content: 'Completions response' },
				{ role: 'user', content: 'Second turn' },
			],
		},
	);
});

test('displays provider errors, retries successfully, and stops an in-flight response', async ({
	page,
}) => {
	let turn = 0;
	let release: (() => void) | undefined;
	await mockAPI(page, async (route) => {
		turn++;
		if (turn === 1) {
			await json(route, { error: { message: 'Mock model unavailable' } }, 503);
			return;
		}
		if (turn === 2) {
			await route.fulfill({
				contentType: 'text/event-stream',
				headers: cors,
				body: responseFrames('Recovered response'),
			});
			return;
		}
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		await route.abort().catch(() => {});
	});
	await configure(page);
	await page.getByLabel('Message', { exact: true }).fill('Try this');
	await page.getByRole('button', { name: 'Send message' }).click();
	await expect(page.getByRole('alert')).toContainText('API 503: Mock model unavailable');
	await page.getByRole('button', { name: 'Regenerate response' }).click();
	await expect(page.locator('.message.assistant')).toContainText('Recovered response');
	await page.getByLabel('Message', { exact: true }).fill('A longer request');
	await page.getByRole('button', { name: 'Send message' }).click();
	await expect.poll(() => turn).toBe(3);
	await page.getByRole('button', { name: 'Stop response' }).click();
	await expect(page.getByText('Response stopped.', { exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
	release?.();
});

test('generates an image, edits uploads with a mask, and restores creation history', async ({
	page,
}) => {
	const requests = await mockAPI(page, async (route) =>
		json(route, { data: [{ b64_json: PNG.toString('base64') }] }),
	);
	await configure(page);
	await page.getByRole('button', { name: 'Images', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Image model', exact: true })).toHaveText(
		'custom-image',
	);
	await page.getByLabel('Generation prompt').fill('A paper forest');
	await page.getByRole('button', { name: 'Generate image', exact: true }).click();
	await expect(page.locator('.image-gallery-image')).toHaveAttribute(
		'src',
		/^data:image\/png;base64,/,
	);
	const imageRequest = requests
		.find((request) => request.url().endsWith('/images/generations'))
		?.postDataJSON();
	expect(imageRequest).toMatchObject({ model: 'custom-image', prompt: 'A paper forest', n: 1 });
	// A custom model without a resolution preset uses the provider's default.
	expect(imageRequest).not.toHaveProperty('size');
	const viewer = page.getByRole('dialog', { name: 'Image viewer', exact: true });
	const download = page.waitForEvent('download');
	await viewer.getByRole('link', { name: 'Download image', exact: true }).click();
	expect((await download).suggestedFilename()).toMatch(/^image-.*\.png$/);
	await viewer.getByRole('button', { name: 'Close image viewer' }).click();
	await page.locator('.image-upload-input').setInputFiles(FILE);
	await expect(
		page.getByRole('button', { name: 'Remove reference.png', exact: true }),
	).toBeVisible();
	await page.locator('.image-mask-input').setInputFiles({ ...FILE, name: 'mask.png' });
	await expect(page.getByRole('button', { name: 'Remove mask', exact: true })).toBeVisible();
	await page.getByLabel('Generation prompt').fill('Make the trees blue');
	await page.getByRole('button', { name: 'Edit image', exact: true }).click();
	await expect(
		page.getByRole('button', { name: 'Open Make the trees blue', exact: true }),
	).toBeVisible();
	await expect(page.locator('.image-gallery-image')).toHaveCount(2);
	const edit = requests.find((request) => request.url().endsWith('/images/edits'))!;
	expect(edit.headers()['content-type']).toContain('multipart/form-data; boundary=');
	expect(edit.postData()).toContain('name="image"; filename="reference.png"');
	expect(edit.postData()).toContain('name="mask"; filename="mask.png"');
	expect(edit.postData()).toContain('Make the trees blue');
	await expect
		.poll(
			async () =>
				(await persistedState(page))?.generations?.filter(
					(item: any) => item.status === 'completed',
				).length,
		)
		.toBe(2);
	await page.reload();
	await page.getByRole('button', { name: 'Images', exact: true }).click();
	await page.getByRole('button', { name: 'Open Make the trees blue', exact: true }).click();
	await expect(viewer.locator('img')).toBeVisible();
	await page.screenshot({ path: '/tmp/freelm-e2e-images.png' });
});

test('pauses and resumes video polling without creating a second job, then downloads content', async ({
	page,
}) => {
	let polls = 0;
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	const requests = await mockAPI(page, async (route, path) => {
		if (path === '/videos') await json(route, { id: 'video_mock', status: 'queued', progress: 0 });
		else if (path === '/videos/video_mock')
			await json(route, {
				id: 'video_mock',
				status: ++polls === 1 ? 'in_progress' : 'completed',
				progress: polls === 1 ? 42 : 100,
			});
		else if (path === '/videos/video_mock/content') {
			await route.fulfill({
				contentType: 'video/mp4',
				headers: cors,
				body: VIDEO,
			});
		} else throw new Error(`Unexpected API call: ${path}`);
	});
	await configure(page);
	await page.getByRole('button', { name: 'Video', exact: true }).click();
	await page.getByLabel('Generation prompt').fill('A quiet coastline');
	await page.locator('.video-upload-input').setInputFiles(FILE);
	await page.getByRole('button', { name: 'Generate video', exact: true }).click();
	await expect(page.getByText('42%', { exact: true })).toBeVisible();
	await page
		.locator('.video-composer')
		.getByRole('button', { name: 'Pause checking', exact: true })
		.click();
	await expect(page.getByText('Checking paused', { exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Resume checking', exact: true }).click();
	// Completing the job and mounting its media player are separate updates.
	// Wait for the asynchronously initialized viewer before testing its download.
	await expect(page.locator('.video-viewer-player')).toHaveAttribute(
		'src',
		/^data:video\/mp4;base64,/,
		{ timeout: 20_000 },
	);
	await expect(page.locator('.video-viewer-player')).toHaveJSProperty('videoWidth', 32, {
		timeout: 15_000,
	});
	expect(
		requests.filter((request) => request.method() === 'POST' && request.url().endsWith('/videos')),
	).toHaveLength(1);
	expect(requests.find((request) => request.url().endsWith('/videos'))?.postData()).toContain(
		'name="input_reference"; filename="reference.png"',
	);
	expect(
		requests.find((request) => request.url().endsWith('/content'))?.headers().authorization,
	).toBe('Bearer e2e-test-key');
	const download = page.waitForEvent('download');
	await page.getByRole('link', { name: 'Download video', exact: true }).click();
	expect((await download).suggestedFilename()).toBe('video-video_mock.mp4');
	expect(errors).toEqual([]);
});

test('generates playable speech and uploads audio for a downloadable transcript', async ({
	page,
}) => {
	const requests = await mockAPI(page, async (route, path) => {
		if (path === '/audio/speech')
			await route.fulfill({ contentType: 'audio/wav', headers: cors, body: wav() });
		else if (path === '/audio/transcriptions')
			await json(route, { text: 'Welcome to the studio.' });
		else throw new Error(`Unexpected API call: ${path}`);
	});
	await configure(page);
	await page.getByRole('button', { name: 'Audio', exact: true }).click();
	await page.getByLabel('Text to speak').fill('Welcome to the studio.');
	await page.getByLabel('Voice', { exact: true }).fill('custom-voice');
	await chooseOption(page, page.getByLabel('Format'), 'wav');
	await page.getByLabel('Voice instructions').fill('Warm and calm');
	await page.getByRole('button', { name: 'Generate speech', exact: true }).click();
	await expect(page.locator('.media-audio-result audio')).toHaveAttribute(
		'src',
		/^data:audio\/wav;base64,/,
	);
	await expect
		.poll(() =>
			page
				.locator('.media-audio-result audio')
				.evaluate((element: HTMLAudioElement) => element.duration),
		)
		.toBeGreaterThan(0);
	expect(
		requests.find((request) => request.url().endsWith('/audio/speech'))?.postDataJSON(),
	).toMatchObject({
		model: 'custom-speech',
		input: 'Welcome to the studio.',
		voice: 'custom-voice',
		instructions: 'Warm and calm',
		response_format: 'wav',
	});
	await page.getByRole('tab', { name: 'Transcription', exact: true }).click();
	await page
		.getByLabel('Upload audio file')
		.setInputFiles({ name: 'meeting.wav', mimeType: 'audio/wav', buffer: wav() });
	await page.getByLabel('Language').fill('en');
	await page.getByLabel('Transcription context').fill('Studio terminology');
	await page.getByRole('button', { name: 'Transcribe', exact: true }).click();
	await expect(page.locator('.media-transcript p')).toHaveText('Welcome to the studio.');
	const request = requests.find((request) => request.url().endsWith('/audio/transcriptions'))!;
	expect(request.postData()).toContain('name="file"; filename="meeting.wav"');
	expect(request.postData()).toContain('custom-transcribe');
	expect(request.postData()).toContain('Studio terminology');
	const download = page.waitForEvent('download');
	await page
		.locator('.media-transcript')
		.getByRole('link', { name: 'Download', exact: true })
		.click();
	expect((await download).suggestedFilename()).toBe('transcript.txt');
});
