import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { initialState } from '../../src/lib/state';

// Browser plugin not available. These isolated actual-App checks cover decoding
// and the renderer's wire payload. smoke-avif-playgrounds.mjs checks real IPC/HTTP.
const reference = readFileSync(new URL('../fixtures/reference.avif', import.meta.url));
const providerError = 'Reference image must be PNG, JPEG, WebP, HEIC, or HEIF';

async function fixture(page: Page, rejectVideo = false) {
	const state = initialState();
	state.connections[0] = {
		...state.connections[0],
		id: 'avif-fixture',
		name: 'AVIF fixture',
		baseUrl: 'http://avif-fixture.invalid/v1',
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
	};
	state.activeConnectionId = 'avif-fixture';
	state.moderation = {
		image: { enabled: false, level: 'low', connectionId: '', model: '', thinkingMode: '' },
		video: {
			enabled: false,
			level: 'low',
			connectionId: '',
			model: '',
			thinkingMode: '',
			videoApi: 'chat/completions',
		},
	};
	await page.addInitScript(
		({ serialized, rejectVideo, providerError }) => {
			const control: any = { state: JSON.parse(serialized), requests: [] };
			(window as any).__avifPlayground = control;
			const json = (body: unknown, status = 200) => ({
				status,
				contentType: 'application/json',
				encoding: 'text',
				body: JSON.stringify(body),
			});
			(window as any).desktop = {
				platform: 'linux',
				workspaceLoad: async () => ({ state: structuredClone(control.state), revision: '1' }),
				workspaceSave: async (_target: string, _revision: string, next: unknown) => {
					control.state = structuredClone(next);
					return { revision: '1' };
				},
				storageInfo: async () => ({ secure: false, location: 'Isolated AVIF fixture' }),
				onPrepareClose: () => () => {},
				onChunk: () => () => {},
				cancel: async () => {},
				instanceStatus: async () => ({
					host: { running: false, name: 'Local', instanceId: 'local', port: 4319 },
					instances: [],
				}),
				request: async (request: any) => {
					control.requests.push(structuredClone(request));
					if (request.path === '/images/edits') {
						const canvas = document.createElement('canvas');
						canvas.width = 32;
						canvas.height = 24;
						canvas.getContext('2d')!.fillRect(0, 0, 32, 24);
						return json({ data: [{ b64_json: canvas.toDataURL().split(',')[1] }] });
					}
					if (rejectVideo) return json({ error: { message: providerError } }, 400);
					return json({ id: 'avif-video-job', status: 'queued', progress: 0 });
				},
			};
		},
		{ serialized: JSON.stringify(state), rejectVideo, providerError },
	);
	await page.goto('/');
	await expect(page).toHaveTitle('FreeLM');
	await expect(page.getByRole('heading', { name: 'What’s on your mind?' })).toBeVisible();
}

async function attach(page: Page, kind: 'image' | 'video') {
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
	await expect(preview).toBeVisible();
	await expect
		.poll(() =>
			preview.evaluate((image: HTMLImageElement) => [image.naturalWidth, image.naturalHeight]),
		)
		.toEqual([16, 12]);
	await composer.getByLabel('Generation prompt', { exact: true }).fill('A blue abstract shape');
	return composer;
}

for (const kind of ['image', 'video'] as const) {
	test(`${kind} playground previews AVIF and forwards original bytes on submit`, async ({
		page,
	}) => {
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		page.on('console', (entry) => {
			if (entry.type() === 'error') errors.push(entry.text());
		});
		await fixture(page);
		const composer = await attach(page, kind);
		await page.screenshot({ path: `/tmp/freelm-${kind}-avif-preview.png` });
		await composer
			.getByRole('button', {
				name: kind === 'image' ? 'Edit image' : 'Generate video',
				exact: true,
			})
			.click();
		await expect
			.poll(() => page.evaluate(() => (window as any).__avifPlayground.requests.length))
			.toBeGreaterThan(0);
		const wire = await page.evaluate(() => (window as any).__avifPlayground.requests[0]);
		expect(wire.path).toBe(kind === 'image' ? '/images/edits' : '/videos');
		expect(
			wire.form.find((part: any) => part.name === (kind === 'image' ? 'image' : 'input_reference'))
				.file,
		).toEqual({
			name: 'reference.avif',
			type: 'image/avif',
			base64: reference.toString('base64'),
		});
		await expect(composer.getByLabel('Generation prompt', { exact: true })).toHaveValue('');
		await expect(composer.locator('.image-reference')).toHaveCount(0);
		await expect(page.locator('.image-compose-error')).toHaveCount(0);
		if (kind === 'video')
			await composer.getByRole('button', { name: 'Pause checking', exact: true }).click();
		else await expect(page.locator('.image-gallery-card:not(.image-job-card)')).toHaveCount(1);
		expect(errors).toEqual([]);
	});
}

test('video playground exposes an AVIF rejection returned by its backend', async ({ page }) => {
	await fixture(page, true);
	const composer = await attach(page, 'video');
	await composer.getByRole('button', { name: 'Generate video', exact: true }).click();
	await expect(page.locator('.image-compose-error')).toContainText(providerError);
	await expect
		.poll(() => page.evaluate(() => (window as any).__avifPlayground.requests.length))
		.toBe(1);
	await page.screenshot({ path: '/tmp/freelm-video-avif-provider-error.png' });
});
