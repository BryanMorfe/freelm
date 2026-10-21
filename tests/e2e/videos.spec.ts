import { openRemoteSettings } from './ui-controls';
import { expect, test, type Page } from '@playwright/test';

let clips: { portrait: string; landscape: string };
const REFERENCE = {
	name: 'reference.png',
	mimeType: 'image/png',
	buffer: Buffer.from(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6pAAAAABJRU5ErkJggg==',
		'base64',
	),
};

test.beforeAll(async ({ browser }) => {
	const page = await browser.newPage();
	clips = await page.evaluate(async () => {
		async function record(width: number, height: number, color: string) {
			const canvas = document.createElement('canvas');
			canvas.width = width;
			canvas.height = height;
			const context = canvas.getContext('2d')!;
			const stream = canvas.captureStream(20);
			const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
			const chunks: BlobPart[] = [];
			recorder.ondataavailable = (event) => chunks.push(event.data);
			const stopped = new Promise<void>((resolve) => {
				recorder.onstop = () => resolve();
			});
			recorder.start();
			for (let frame = 0; frame < 8; frame++) {
				context.fillStyle = color;
				context.fillRect(0, 0, width, height);
				context.fillStyle = '#d8bd7a';
				context.fillRect((frame * width) / 16, height / 4, width / 3, height / 2);
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			recorder.stop();
			await stopped;
			stream.getTracks().forEach((track) => track.stop());
			return await new Promise<string>((resolve) => {
				const reader = new FileReader();
				reader.onload = () => resolve(String(reader.result));
				reader.readAsDataURL(new Blob(chunks, { type: 'video/webm' }));
			});
		}
		const [portrait, landscape] = await Promise.all([
			record(180, 320, '#8f6b56'),
			record(320, 180, '#4d7069'),
		]);
		return { portrait, landscape };
	});
	await page.close();
});

async function fixture(page: Page, history = false, legacyRetry = false) {
	await page.addInitScript(
		({ clips, history, legacyRetry }) => {
			const catalog = [
				{
					id: 'video-ref',
					name: 'Cinema Reference',
					enabled: true,
					tasks: ['videos'],
					inputModalities: ['text', 'image'],
					outputModalities: ['video'],
					thinkingModes: [],
				},
				{
					id: 'video-text',
					name: 'Cinema Text',
					enabled: true,
					tasks: ['videos'],
					inputModalities: ['text'],
					outputModalities: ['video'],
					thinkingModes: [],
				},
				{
					id: 'disabled-video',
					name: 'Disabled Cinema',
					enabled: false,
					tasks: ['videos'],
					inputModalities: ['text'],
					outputModalities: ['video'],
					thinkingModes: [],
				},
				{
					id: 'audio-only',
					name: 'Audio Only',
					enabled: true,
					tasks: ['speech'],
					inputModalities: ['text'],
					outputModalities: ['audio'],
					thinkingModes: [],
				},
			];
			const seed = {
				version: 1,
				theme: 'dark',
				activeConnectionId: 'provider',
				threads: [],
				projects: [],
				connections: [
					{
						id: 'provider',
						name: 'Video test API',
						baseUrl: 'http://localhost:8000/v1',
						apiKey: '',
						chatApi: 'responses',
						models: { chat: '', images: '', videos: 'video-ref', speech: '', transcription: '' },
						discoveredModels: [
							'video-ref',
							'video-text',
							'unknown-video',
							'disabled-video',
							'audio-only',
						],
						catalog,
					},
				],
				generations: history
					? [
							{
								id: 'portrait-history',
								kind: 'videos',
								prompt: 'A tall moving tower',
								model: 'video-ref',
								connectionId: 'provider',
								createdAt: 2,
								status: 'completed',
								parameters: { size: '720x1280', seconds: '4' },
								assets: [{ name: 'portrait.webm', mimeType: 'video/webm', url: clips.portrait }],
							},
							{
								id: 'landscape-history',
								kind: 'videos',
								prompt: 'A wide moving garden',
								model: 'video-ref',
								connectionId: 'provider',
								createdAt: 1,
								status: 'completed',
								parameters: { size: '1280x720', seconds: '8' },
								assets: [{ name: 'landscape.webm', mimeType: 'video/webm', url: clips.landscape }],
							},
						]
					: [],
			};
			if (legacyRetry) {
				seed.generations[0].status = 'failed';
				seed.generations[0].assets = [];
			}
			const control: any = {
				states: JSON.parse(
					localStorage.getItem('video-test-states') ||
						JSON.stringify({ local: seed, remote: { ...seed, generations: [] } }),
				),
				requests: [],
				saveCalls: [],
				cancelled: [],
				creates: 0,
				createStatus: 'completed',
				pollStatus: 'completed',
				progress: 42,
				holdSave: false,
				holdCreate: false,
				holdContent: false,
				createFailures: 0,
				contentFailures: 0,
			};
			(window as any).__videoTest = control;
			const snapshot = (target: string) => ({
				state: structuredClone(control.states[target]),
				revision: '1',
			});
			const json = (value: unknown, status = 200) => ({
				status,
				contentType: 'application/json',
				encoding: 'text',
				body: JSON.stringify(value),
			});
			(window as any).desktop = {
				platform: 'linux',
				workspaceLoad: async (target: string) => snapshot(target),
				workspaceSave: async (target: string, _revision: string, state: any) => {
					control.saveCalls.push({ target, state: structuredClone(state) });
					if (
						control.holdSave &&
						state.generations.some((item: any) => item.status === 'pending')
					) {
						control.saveStarted = true;
						await new Promise<void>((resolve) => {
							control.releaseSave = () => {
								control.holdSave = false;
								resolve();
							};
						});
					}
					control.states[target] = structuredClone(state);
					localStorage.setItem('video-test-states', JSON.stringify(control.states));
					return { revision: '1' };
				},
				storageInfo: async () => ({ secure: false, location: 'Isolated video workspace' }),
				onPrepareClose: () => () => {},
				completeClose: async () => {},
				onChunk: () => () => {},
				instanceStatus: async () => ({
					host: { running: false, name: 'Local', instanceId: 'local-instance', port: 4319 },
					instances: [
						{
							id: 'remote',
							name: 'Video host',
							transport: 'direct',
							url: 'http://127.0.0.1:4319',
							connected: true,
							hasToken: true,
						},
					],
				}),
				instanceOpen: async (target: string) => snapshot(target),
				instanceDisconnect: async () => {},
				request: async (request: any) => {
					control.requests.push({
						...structuredClone(request),
						savedStatus: control.states[request.workspaceId].generations[0]?.status,
					});
					if (request.method === 'POST' && request.path === '/videos') {
						const id = `job-${++control.creates}`;
						if (control.holdCreate)
							await new Promise<void>((resolve) => {
								control.releaseCreate = () => {
									control.holdCreate = false;
									resolve();
								};
							});
						if (control.createFailures-- > 0)
							return json({ error: { message: 'Video provider rejected this attempt.' } }, 503);
						return json({ id, status: control.createStatus, progress: 0 });
					}
					if (request.path.endsWith('/content')) {
						if (control.contentFailures-- > 0)
							return json({ error: { message: 'The video download was interrupted.' } }, 503);
						if (control.holdContent)
							await new Promise<void>((resolve) => {
								control.releaseContent = () => {
									control.holdContent = false;
									resolve();
								};
							});
						return {
							status: 200,
							contentType: 'video/webm',
							encoding: 'base64',
							body: clips.landscape.split(',')[1],
						};
					}
					if (request.path.startsWith('/videos/'))
						return json({
							id: request.path.split('/').at(-1),
							status: control.pollStatus,
							progress: control.progress,
						});
					throw new Error(`Unexpected provider request: ${request.path}`);
				},
				cancel: async (id: string) => {
					control.cancelled.push(id);
				},
			};
		},
		{ clips, history, legacyRetry },
	);
	await page.goto('/');
	await expect(page).toHaveTitle('FreeLM');
	await page.getByRole('button', { name: 'Video', exact: true }).click();
}

async function chooseModel(page: Page, model: string) {
	await page.getByRole('button', { name: 'Video model', exact: true }).click();
	const picker = page.getByRole('dialog', { name: 'Choose a model', exact: true });
	const known = picker.locator(`[role="option"][data-value=${JSON.stringify(model)}]`);
	if (await known.count()) {
		await known.click();
		return;
	}
	await picker.getByRole('button', { name: 'Use a model ID…' }).click();
	await page.getByRole('combobox', { name: 'Search models', exact: true }).fill(model);
	await page.getByRole('option', { name: new RegExp(model) }).click();
}

async function submittedFields(page: Page) {
	return page.evaluate(() =>
		(window as any).__videoTest.requests
			.filter((request: any) => request.method === 'POST')
			.map((request: any) =>
				Object.fromEntries(request.form.map((part: any) => [part.name, part.file || part.value])),
			),
	);
}

test('video gallery preserves natural ratios and its viewer plays, navigates, and retains playback through full screen', async ({
	page,
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (entry) => {
		if (entry.type() === 'error') errors.push(entry.text());
	});
	await fixture(page, true);
	const thumbnails = page.locator('.video-gallery-video');
	await expect(thumbnails).toHaveCount(2);
	await expect
		.poll(() =>
			thumbnails.evaluateAll((elements) =>
				elements.every((element) => (element as HTMLVideoElement).videoWidth > 0),
			),
		)
		.toBe(true);
	const geometry = await thumbnails.evaluateAll((elements) =>
		elements.map((element) => {
			const video = element as HTMLVideoElement;
			const box = video.getBoundingClientRect();
			return { width: box.width, height: box.height, ratio: video.videoWidth / video.videoHeight };
		}),
	);
	expect(geometry[0].width).toBeCloseTo(geometry[1].width, 0);
	for (const item of geometry) expect(item.width / item.height).toBeCloseTo(item.ratio, 2);
	expect(geometry[0].height).toBeGreaterThan(geometry[1].height * 3);
	await page.screenshot({ path: '/tmp/freelm-video-workflow-gallery-desktop.png' });
	await page.getByRole('button', { name: 'Open A tall moving tower', exact: true }).click();
	const viewer = page.getByRole('dialog', { name: 'Video viewer', exact: true });
	const player = page.locator('.video-viewer-player');
	await expect(player).toHaveJSProperty('videoWidth', 180);
	await expect(viewer).toContainText('A tall moving tower');
	await player.evaluate(async (video: HTMLVideoElement) => {
		video.muted = true;
		await video.play();
	});
	await expect
		.poll(() => player.evaluate((video: HTMLVideoElement) => video.currentTime))
		.toBeGreaterThan(0);
	const time = await player.evaluate((video: HTMLVideoElement) => {
		video.pause();
		(window as any).__videoPlayer = video;
		return video.currentTime;
	});
	await page.getByRole('button', { name: 'View video full screen', exact: true }).click();
	const fullscreen = page.getByRole('dialog', { name: 'Full screen video', exact: true });
	const closeFullscreen = page.getByRole('button', {
		name: 'Close full screen video',
		exact: true,
	});
	await expect(fullscreen).toBeVisible();
	await expect(closeFullscreen).toBeFocused();
	await expect(page.locator('.video-viewer-backdrop')).toBeVisible();
	await expect(page.locator('.video-viewer-backdrop')).toHaveCSS('filter', /blur/);
	expect(await player.evaluate((video) => video === (window as any).__videoPlayer)).toBe(true);
	expect(await player.evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(
		time,
		2,
	);
	await page.keyboard.press('Tab');
	expect(
		await page.evaluate(() => !!document.activeElement?.closest('.video-viewer-fullscreen')),
	).toBe(true);
	await closeFullscreen.focus();
	await page.keyboard.press('Shift+Tab');
	expect(
		await page.evaluate(() => !!document.activeElement?.closest('.video-viewer-fullscreen')),
	).toBe(true);
	await player.focus();
	await page.keyboard.press('Escape');
	await expect(viewer).toBeVisible();
	await player.dblclick({ position: { x: 30, y: 20 } });
	await expect(fullscreen).toBeVisible();
	expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
	const box = await player.boundingBox();
	await page.mouse.click(box!.x + box!.width / 2, box!.y + 10);
	await expect(fullscreen).toBeVisible();
	await page.screenshot({ path: '/tmp/freelm-video-workflow-fullscreen-desktop.png' });
	await page.mouse.click(box!.x / 2, box!.y + box!.height / 2);
	await expect(viewer).toBeVisible();
	await expect(
		page.getByRole('button', { name: 'View video full screen', exact: true }),
	).toBeFocused();
	const normal = await player.boundingBox();
	await player.dblclick({ position: { x: normal!.width / 2, y: normal!.height - 12 } });
	await expect(viewer).toBeVisible();
	await page.getByRole('button', { name: 'Next video', exact: true }).click();
	await expect(player).toHaveJSProperty('videoWidth', 320);
	await expect(viewer).toContainText('A wide moving garden');
	expect(await page.evaluate(() => (window as any).__videoPlayer.paused)).toBe(true);
	await page.setViewportSize({ width: 390, height: 520 });
	await page.getByRole('button', { name: 'View video full screen', exact: true }).click();
	await expect(fullscreen).toBeVisible();
	const narrow = await player.boundingBox();
	expect(narrow!.width / narrow!.height).toBeCloseTo(320 / 180, 2);
	await page.screenshot({ path: '/tmp/freelm-video-workflow-fullscreen-narrow.png' });
	await page.keyboard.press('Escape');
	await expect(viewer).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(viewer).toHaveCount(0);
	expect(errors).toEqual([]);
});

test('video submission clears promptly, saves before sending, and captures model, settings, and reference', async ({
	page,
}) => {
	await fixture(page);
	await page.getByRole('button', { name: 'Video model', exact: true }).click();
	await expect(page.getByRole('option')).toHaveCount(3);
	await expect(page.getByRole('option', { name: /Cinema Reference/ })).toBeVisible();
	await expect(page.getByRole('option', { name: /Disabled Cinema|Audio Only/ })).toHaveCount(0);
	await page.keyboard.press('Escape');
	await chooseModel(page, 'custom-cinema');
	await page.getByRole('button', { name: 'Video settings', exact: true }).click();
	await page.getByLabel('Duration (seconds)', { exact: true }).fill('6');
	await page.getByLabel('Size', { exact: true }).fill('720x1280');
	await page.getByRole('button', { name: 'Video settings', exact: true }).click();
	await page.locator('.video-upload-input').setInputFiles(REFERENCE);
	await page.getByLabel('Generation prompt', { exact: true }).fill('A copper kite rises');
	await page.evaluate(() => {
		(window as any).__videoTest.holdSave = true;
	});
	await page.getByRole('button', { name: 'Generate video', exact: true }).click();
	await expect(page.getByLabel('Generation prompt', { exact: true })).toHaveValue('');
	await expect.poll(() => page.evaluate(() => (window as any).__videoTest.saveStarted)).toBe(true);
	expect(await submittedFields(page)).toEqual([]);
	await page.getByLabel('Generation prompt', { exact: true }).fill('The next untouched draft');
	await page.evaluate(() => (window as any).__videoTest.releaseSave());
	await expect
		.poll(() => submittedFields(page))
		.toEqual([
			{
				model: 'custom-cinema',
				prompt: 'A copper kite rises',
				size: '736x1280',
				seconds: '6',
				input_reference: {
					name: 'reference.png',
					type: 'image/png',
					base64: REFERENCE.buffer.toString('base64'),
				},
			},
		]);
	await expect
		.poll(() =>
			page.evaluate(() => (window as any).__videoTest.states.local.generations[0]?.status),
		)
		.toBe('completed');
	expect(await page.evaluate(() => (window as any).__videoTest.requests[0].savedStatus)).toBe(
		'pending',
	);
	await page.getByRole('button', { name: 'Close video viewer', exact: true }).click();
	await expect(page.getByLabel('Generation prompt', { exact: true })).toHaveValue(
		'The next untouched draft',
	);
	const record = await page.evaluate(() => (window as any).__videoTest.states.local.generations[0]);
	expect(record).toMatchObject({
		prompt: 'A copper kite rises',
		model: 'custom-cinema',
		parameters: { size: '736x1280', seconds: '6' },
	});
	expect(JSON.stringify(record.parameters)).not.toContain(REFERENCE.buffer.toString('base64'));
});

test('long video jobs keep polling beyond four hours and still support pause and resume', async ({
	page,
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (entry) => {
		if (entry.type() === 'error') errors.push(entry.text());
	});
	await page.clock.install();
	await fixture(page);
	await page.evaluate(() => {
		Object.assign((window as any).__videoTest, {
			createStatus: 'queued',
			pollStatus: 'in_progress',
		});
	});
	await page.getByRole('button', { name: 'Video settings', exact: true }).click();
	await page.getByLabel('Duration (seconds)', { exact: true }).fill('15');
	await page.getByLabel('Size', { exact: true }).fill('1920x1080');
	await page.getByRole('button', { name: 'Close video settings', exact: true }).click();
	await page.getByLabel('Generation prompt', { exact: true }).fill('A slowly changing coastline');
	await page.getByRole('button', { name: 'Generate video', exact: true }).click();
	await expect(page.getByText('42%', { exact: true })).toBeVisible();
	const statusRequests = () =>
		page.evaluate(
			() =>
				(window as any).__videoTest.requests.filter(
					(request: any) => request.method === 'GET' && request.path === '/videos/job-1',
				).length,
		);
	const pause = page.locator('.video-composer').getByRole('button', {
		name: 'Pause checking',
		exact: true,
	});
	for (const elapsed of [31 * 60_000, 210 * 60_000]) {
		const before = await statusRequests();
		// Jump elapsed time without replaying hours of polls; the next poll must still run.
		await page.clock.fastForward(elapsed);
		await expect.poll(statusRequests).toBeGreaterThan(before);
		await expect(pause).toBeEnabled();
		await expect(page.getByRole('button', { name: 'Resume checking', exact: true })).toHaveCount(0);
	}
	await expect(page.locator('vite-error-overlay')).toHaveCount(0);
	await page.screenshot({ path: '/tmp/freelm-video-long-running.png' });
	await pause.click();
	await expect(page.getByRole('button', { name: 'Resume checking', exact: true })).toBeVisible();
	const pausedRequests = await statusRequests();
	await page.clock.fastForward(60_000);
	expect(await statusRequests()).toBe(pausedRequests);
	await page.evaluate(() => {
		(window as any).__videoTest.pollStatus = 'completed';
	});
	await page.getByRole('button', { name: 'Resume checking', exact: true }).click();
	await expect(page.getByRole('dialog', { name: 'Video viewer', exact: true })).toBeVisible();
	await expect(page.locator('.video-viewer-player')).toHaveJSProperty('videoWidth', 320);
	expect(await submittedFields(page)).toEqual([
		{
			model: 'video-ref',
			prompt: 'A slowly changing coastline',
			size: '1920x1088',
			seconds: '15',
		},
	]);
	expect(errors).toEqual([]);
});

test('paused video history resumes the existing job after reload and downloads playable content', async ({
	page,
}) => {
	await fixture(page);
	await page.evaluate(() => {
		Object.assign((window as any).__videoTest, {
			createStatus: 'queued',
			pollStatus: 'in_progress',
		});
	});
	await page.getByLabel('Generation prompt', { exact: true }).fill('A quiet coastline');
	await page.getByRole('button', { name: 'Generate video', exact: true }).click();
	await expect(page.getByText('42%', { exact: true })).toBeVisible();
	await page
		.locator('.video-composer')
		.getByRole('button', { name: 'Pause checking', exact: true })
		.click();
	await expect(page.getByRole('button', { name: 'Resume checking', exact: true })).toBeVisible();
	await expect
		.poll(() =>
			page.evaluate(() => (window as any).__videoTest.states.local.generations[0]?.remoteId),
		)
		.toBe('job-1');
	await page.reload();
	await page.getByRole('button', { name: 'Video', exact: true }).click();
	await page.getByRole('button', { name: 'Resume checking', exact: true }).click();
	await expect(page.getByRole('dialog', { name: 'Video viewer', exact: true })).toBeVisible();
	expect(await submittedFields(page)).toEqual([]);
	const requests = await page.evaluate(() =>
		(window as any).__videoTest.requests.map((request: any) => request.path),
	);
	expect(requests).toEqual(['/videos/job-1', '/videos/job-1/content']);
	const video = page.locator('.video-viewer video').first();
	await expect
		.poll(() => video.evaluate((element: HTMLVideoElement) => element.videoWidth))
		.toBe(320);
	const download = page.waitForEvent('download');
	await page.getByRole('link', { name: 'Download video', exact: true }).click();
	expect((await download).suggestedFilename()).toBe('video-job-1.mp4');
});

test('retry uses the failed request snapshot instead of a newer composer draft', async ({
	page,
}) => {
	await fixture(page);
	await page.getByRole('button', { name: 'Video settings', exact: true }).click();
	await page.getByLabel('Duration (seconds)', { exact: true }).fill('6');
	await page.getByLabel('Size', { exact: true }).fill('720x1280');
	await page.getByRole('button', { name: 'Video settings', exact: true }).click();
	await page.locator('.video-upload-input').setInputFiles(REFERENCE);
	await page
		.getByLabel('Generation prompt', { exact: true })
		.fill('The original reference request');
	await page.evaluate(() => {
		(window as any).__videoTest.createFailures = 1;
	});
	await page.getByRole('button', { name: 'Generate video', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Retry generation', exact: true })).toBeVisible();
	await chooseModel(page, 'video-text');
	await page.getByLabel('Generation prompt', { exact: true }).fill('A different draft');
	await page.getByRole('button', { name: 'Retry generation', exact: true }).click();
	await expect.poll(async () => (await submittedFields(page)).length).toBe(2);
	const fields = await submittedFields(page);
	expect(fields[1]).toEqual(fields[0]);
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					(window as any).__videoTest.states.local.generations.filter(
						(item: any) => item.status === 'completed',
					).length,
			),
		)
		.toBe(1);
});

test('stopping creation ignores late provider completion and preserves a newly typed draft', async ({
	page,
}) => {
	await fixture(page);
	await page.evaluate(() => {
		(window as any).__videoTest.holdCreate = true;
	});
	await page.getByLabel('Generation prompt', { exact: true }).fill('The stopped request');
	await page.getByRole('button', { name: 'Generate video', exact: true }).click();
	await expect.poll(async () => (await submittedFields(page)).length).toBe(1);
	await page.getByLabel('Generation prompt', { exact: true }).fill('A new unsent request');
	await page
		.locator('.video-composer')
		.getByRole('button', { name: 'Stop request', exact: true })
		.click();
	await expect
		.poll(() =>
			page.evaluate(() => (window as any).__videoTest.states.local.generations[0]?.status),
		)
		.toBe('cancelled');
	await page.evaluate(() => (window as any).__videoTest.releaseCreate());
	await expect(page.getByLabel('Generation prompt', { exact: true })).toHaveValue(
		'A new unsent request',
	);
	await expect(page.getByRole('dialog', { name: 'Video viewer', exact: true })).toHaveCount(0);
	expect(await page.evaluate(() => (window as any).__videoTest.requests.length)).toBe(1);
});

test('switching workspace cancels an in-flight video without copying its result into the next workspace', async ({
	page,
}) => {
	await fixture(page);
	await page.evaluate(() => {
		(window as any).__videoTest.holdCreate = true;
	});
	await page.getByLabel('Generation prompt', { exact: true }).fill('Stay in the local workspace');
	await page.getByRole('button', { name: 'Generate video', exact: true }).click();
	await expect.poll(async () => (await submittedFields(page)).length).toBe(1);
	await openRemoteSettings(page);
	await page
		.getByRole('region', { name: 'Remote FreeLM workspaces' })
		.getByRole('button', { name: 'Open', exact: true })
		.click();
	await expect(page.locator('.instance-context-bar')).toContainText('Video host');
	await page.evaluate(() => (window as any).__videoTest.releaseCreate());
	await expect
		.poll(() =>
			page.evaluate(() => (window as any).__videoTest.states.local.generations[0]?.status),
		)
		.toBe('cancelled');
	expect(await page.evaluate(() => (window as any).__videoTest.states.remote.generations)).toEqual(
		[],
	);
	expect(await page.evaluate(() => (window as any).__videoTest.requests.length)).toBe(1);
});

test('reloaded reference retries require reattachment and restore their saved parameters', async ({
	page,
}) => {
	await fixture(page);
	await page.locator('.video-upload-input').setInputFiles(REFERENCE);
	await page
		.getByLabel('Generation prompt', { exact: true })
		.fill('Retry only with the original reference');
	await page.evaluate(() => {
		(window as any).__videoTest.createFailures = 1;
	});
	await page.getByRole('button', { name: 'Generate video', exact: true }).click();
	await expect
		.poll(() =>
			page.evaluate(() => (window as any).__videoTest.states.local.generations[0]?.status),
		)
		.toBe('failed');
	await page.reload();
	await page.getByRole('button', { name: 'Video', exact: true }).click();
	await page.getByRole('button', { name: 'Retry generation', exact: true }).click();
	await expect(page.getByLabel('Generation prompt', { exact: true })).toHaveValue(
		'Retry only with the original reference',
	);
	await expect(
		page
			.getByRole('alert')
			.filter({ hasText: /reference/i })
			.first(),
	).toBeVisible();
	expect(await submittedFields(page)).toEqual([]);
	await page.getByRole('button', { name: 'Video settings', exact: true }).click();
	await expect(page.getByLabel('Duration (seconds)', { exact: true })).toHaveValue('4');
	await expect(page.getByLabel('Size', { exact: true })).toHaveValue('1280x736');
});

test('video composer grows in short windows and blocks references for text-only models', async ({
	page,
}) => {
	await fixture(page);
	await chooseModel(page, 'video-text');
	await expect(
		page.getByRole('button', { name: 'Add reference image', exact: true }),
	).toBeDisabled();
	await chooseModel(page, 'video-ref');
	await page.locator('.video-upload-input').setInputFiles(REFERENCE);
	await chooseModel(page, 'video-text');
	await page
		.getByLabel('Generation prompt', { exact: true })
		.fill('This model cannot use my image');
	await expect(page.getByRole('button', { name: 'Generate video', exact: true })).toBeDisabled();
	await expect(page.getByRole('alert')).toContainText(/image/i);
	await page.getByRole('button', { name: 'Remove reference.png', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Generate video', exact: true })).toBeEnabled();
	await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
	await page.setViewportSize({ width: 390, height: 440 });
	const prompt = page.getByLabel('Generation prompt', { exact: true });
	await prompt.fill('A short prompt');
	const short = await prompt.boundingBox();
	await prompt.fill('A longer video prompt line with a scene description.\n'.repeat(20));
	const long = await prompt.boundingBox();
	expect(long!.height).toBeGreaterThan(short!.height);
	expect(long!.height).toBeLessThanOrEqual(600);
	const send = page.getByRole('button', { name: 'Generate video', exact: true });
	await send.scrollIntoViewIfNeeded();
	const box = await send.boundingBox();
	expect(box!.y + box!.height).toBeLessThanOrEqual(440);
	await page.screenshot({ path: '/tmp/freelm-video-workflow-composer-narrow.png' });
	expect(await submittedFields(page)).toEqual([]);
});

test('pausing during content download ignores late bytes and resumes without another creation', async ({
	page,
}) => {
	await fixture(page);
	await page.evaluate(() => {
		(window as any).__videoTest.holdContent = true;
	});
	await page.getByLabel('Generation prompt', { exact: true }).fill('Pause while downloading');
	await page.getByRole('button', { name: 'Generate video', exact: true }).click();
	await expect
		.poll(() =>
			page.evaluate(() =>
				(window as any).__videoTest.requests.some((request: any) =>
					request.path.endsWith('/content'),
				),
			),
		)
		.toBe(true);
	await page
		.locator('.video-composer')
		.getByRole('button', { name: 'Pause checking', exact: true })
		.click();
	await expect(page.getByRole('button', { name: 'Resume checking', exact: true })).toBeVisible();
	await page.evaluate(() => (window as any).__videoTest.releaseContent());
	await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
	await expect
		.poll(() => page.evaluate(() => (window as any).__videoTest.states.local.generations[0]?.error))
		.toContain('paused');
	expect(
		await page.evaluate(() => (window as any).__videoTest.states.local.generations[0]?.assets),
	).toEqual([]);
	await expect(page.getByRole('dialog', { name: 'Video viewer', exact: true })).toHaveCount(0);
	await page.getByRole('button', { name: 'Resume checking', exact: true }).click();
	await expect
		.poll(() =>
			page.evaluate(() => (window as any).__videoTest.states.local.generations[0]?.status),
		)
		.toBe('completed');
	expect((await submittedFields(page)).length).toBe(1);
});

test('an interrupted content download retains its remote job and resumes without another POST', async ({
	page,
}) => {
	await fixture(page);
	await page.evaluate(() => {
		(window as any).__videoTest.contentFailures = 1;
	});
	await page
		.getByLabel('Generation prompt', { exact: true })
		.fill('Keep this completed remote job');
	await page.getByRole('button', { name: 'Generate video', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Resume checking', exact: true })).toBeVisible();
	await expect
		.poll(() => page.evaluate(() => (window as any).__videoTest.states.local.generations[0]))
		.toMatchObject({ status: 'pending', remoteId: 'job-1', assets: [] });
	await page.getByRole('button', { name: 'Resume checking', exact: true }).click();
	await expect
		.poll(() =>
			page.evaluate(() => (window as any).__videoTest.states.local.generations[0]?.status),
		)
		.toBe('completed');
	expect((await submittedFields(page)).length).toBe(1);
	await expect(page.locator('.video-viewer-player')).toHaveJSProperty('videoWidth', 320);
});

test('video resolution snaps on blur and Enter and normalizes unblurred submissions while preserving provider defaults', async ({
	page,
}) => {
	await fixture(page);
	await page.getByRole('button', { name: 'Video settings', exact: true }).click();
	const size = page.getByLabel('Size', { exact: true });
	await expect(size).toHaveValue('1280x736');
	await size.fill('1290x710');
	await size.press('Tab');
	await expect(size).toHaveValue('1280x704');
	await size.fill('1x1');
	await size.press('Enter');
	await expect(size).toHaveValue('32x32');
	await size.fill('1920x1080');
	await size.press('Tab');
	await expect(size).toHaveValue('1920x1088');
	await size.fill('720x1280');
	await size.press('Enter');
	await expect(size).toHaveValue('736x1280');
	expect(await submittedFields(page)).toEqual([]);
	await page.getByRole('button', { name: 'Close video settings', exact: true }).click();
	await page.getByLabel('Generation prompt', { exact: true }).fill('Normalize before submitting');
	await page.getByRole('button', { name: 'Video settings', exact: true }).click();
	await size.fill('1920x1080');
	await expect(size).toBeFocused();
	// Submit without moving focus, so the request cannot rely on the blur handler.
	await page.locator('.video-composer').evaluate((form: HTMLFormElement) => form.requestSubmit());
	await expect
		.poll(() => submittedFields(page))
		.toEqual([
			{
				model: 'video-ref',
				prompt: 'Normalize before submitting',
				size: '1920x1088',
				seconds: '4',
			},
		]);
	await expect
		.poll(() => page.evaluate(() => (window as any).__videoTest.states.local.generations[0]))
		.toMatchObject({ status: 'completed', parameters: { size: '1920x1088' } });
	await page.getByRole('button', { name: 'Close video viewer', exact: true }).click();
	await page.getByLabel('Generation prompt', { exact: true }).fill('Use the provider resolution');
	await page.getByRole('button', { name: 'Video settings', exact: true }).click();
	await size.fill('');
	await page.locator('.video-composer').evaluate((form: HTMLFormElement) => form.requestSubmit());
	await expect
		.poll(async () => (await submittedFields(page))[1])
		.toEqual({ model: 'video-ref', prompt: 'Use the provider resolution', seconds: '4' });
	await expect
		.poll(() => page.evaluate(() => (window as any).__videoTest.states.local.generations[0]))
		.toMatchObject({ status: 'completed', parameters: { size: '' } });
});

test('retrying historical video parameters snaps the new request and saved record', async ({
	page,
}) => {
	await fixture(page, true, true);
	await page.getByRole('button', { name: 'Retry generation', exact: true }).click();
	await expect
		.poll(() => submittedFields(page))
		.toEqual([
			{ model: 'video-ref', prompt: 'A tall moving tower', size: '736x1280', seconds: '4' },
		]);
	await expect
		.poll(() => page.evaluate(() => (window as any).__videoTest.states.local.generations[0]))
		.toMatchObject({
			status: 'completed',
			prompt: 'A tall moving tower',
			parameters: { size: '736x1280' },
		});
});
