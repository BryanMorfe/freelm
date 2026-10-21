import { openRemoteSettings } from './ui-controls';
import { expect, test, type Page } from '@playwright/test';

const PNG =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6pAAAAABJRU5ErkJggg==';
const HOST_URL = 'http://127.0.0.1:8000/generated/history.png';
const EXTERNAL_URL = 'https://images.example.test/history.png';

async function fixture(page: Page) {
	await page.addInitScript(
		({ png, hostUrl, externalUrl }) => {
			const generation = (id: string, url: string, createdAt: number) => ({
				id,
				kind: 'images',
				prompt: id,
				model: 'image-model',
				connectionId: 'provider',
				createdAt,
				status: 'completed',
				assets: [{ name: `${id}.png`, mimeType: 'image/png', url }],
			});
			const state = {
				version: 1,
				theme: 'dark',
				activeConnectionId: 'provider',
				threads: [],
				projects: [],
				generations: [
					generation('host-image', hostUrl, 3),
					generation('unavailable-image', externalUrl, 2),
					generation('embedded-image', `data:image/png;base64,${png}`, 1),
				],
				connections: [
					{
						id: 'provider',
						name: 'Host provider',
						baseUrl: 'http://127.0.0.1:8000/v1',
						apiKey: '',
						chatApi: 'responses',
						models: {
							chat: 'chat-model',
							images: 'image-model',
							videos: '',
							speech: '',
							transcription: '',
						},
						discoveredModels: [],
					},
				],
			};
			const control: any = {
				states: { local: structuredClone(state), remote: structuredClone(state) },
				calls: [],
				hold: true,
				releases: [],
				fail: true,
			};
			(window as any).__assetTest = control;
			const snapshot = (id: string) => ({
				state: structuredClone(control.states[id]),
				revision: '1',
			});
			(window as any).desktop = {
				platform: 'linux',
				workspaceLoad: async (id: string) => snapshot(id),
				workspaceSave: async (id: string, _revision: string, next: unknown) => {
					control.states[id] = structuredClone(next);
					return { revision: '1' };
				},
				storageInfo: async () => ({ secure: false, location: 'Test workspace' }),
				onPrepareClose: () => () => {},
				completeClose: async () => {},
				onChunk: () => () => {},
				cancel: async () => {},
				instanceStatus: async () => ({
					host: { running: false, name: 'Local', instanceId: 'local-instance', port: 4319 },
					instances: [
						{
							id: 'remote',
							name: 'Image host',
							transport: 'direct',
							url: 'http://127.0.0.1:4319',
							connected: true,
							hasToken: true,
						},
					],
				}),
				instanceOpen: async (id: string) => snapshot(id),
				instanceAsset: async (workspaceId: string, connectionId: string, url: string) => {
					control.calls.push({ workspaceId, connectionId, url });
					if (url === hostUrl && control.hold)
						await new Promise<void>((resolve) => {
							control.releases.push(resolve);
							control.release = () => {
								control.hold = false;
								control.releases.splice(0).forEach((release: () => void) => release());
							};
						});
					if (url === externalUrl && control.fail)
						throw new Error('The host cannot retrieve this image.');
					return { status: 200, contentType: 'image/png', encoding: 'base64', body: png };
				},
			};
		},
		{ png: PNG, hostUrl: HOST_URL, externalUrl: EXTERNAL_URL },
	);
	await page.goto('/');
	await expect(page).toHaveTitle('FreeLM');
	await expect(page.getByRole('heading', { name: 'What’s on your mind?' })).toBeVisible();
}

test('historical remote images load and download through the host without fetching client URLs', async ({
	page,
}) => {
	const browserRequests: string[] = [];
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	for (const url of [HOST_URL, EXTERNAL_URL])
		await page.route(url, async (route) => {
			browserRequests.push(route.request().url());
			await route.fulfill({
				status: 200,
				contentType: 'image/png',
				body: Buffer.from(PNG, 'base64'),
			});
		});
	await fixture(page);
	await openRemoteSettings(page);
	await page
		.getByRole('region', { name: 'Remote FreeLM workspaces' })
		.getByRole('button', { name: 'Open', exact: true })
		.click();
	await page.getByRole('button', { name: 'Images', exact: true }).click();
	await expect(page.locator('.image-gallery-card')).toHaveCount(3);
	await page.getByRole('button', { name: 'Open host-image', exact: true }).click();
	const viewer = page.getByRole('dialog', { name: 'Image viewer', exact: true });
	await expect(viewer.getByRole('status')).toContainText('Loading image');
	await expect(viewer.getByRole('link', { name: 'Download image', exact: true })).toHaveCount(0);
	await expect
		.poll(() => page.evaluate(() => (window as any).__assetTest.calls))
		.toEqual(
			expect.arrayContaining([{ workspaceId: 'remote', connectionId: 'provider', url: HOST_URL }]),
		);
	await page.evaluate(() => (window as any).__assetTest.release());
	await expect(viewer.locator('img')).toHaveAttribute('src', `data:image/png;base64,${PNG}`);
	await expect(viewer.getByRole('link', { name: 'Download image', exact: true })).toHaveAttribute(
		'href',
		`data:image/png;base64,${PNG}`,
	);
	await expect
		.poll(() => viewer.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth))
		.toBe(1);
	await viewer.getByRole('button', { name: 'Close image viewer', exact: true }).click();
	await page.getByRole('button', { name: 'Open unavailable-image', exact: true }).click();
	await expect(viewer.getByRole('alert')).toContainText('The host cannot retrieve this image.');
	await expect(viewer.locator('img')).toHaveCount(0);
	await expect(viewer.getByRole('link', { name: 'Download image', exact: true })).toHaveCount(0);
	await page.evaluate(() => {
		(window as any).__assetTest.fail = false;
	});
	await viewer.getByRole('button', { name: 'Retry image' }).click();
	await expect(viewer.getByRole('link', { name: 'Download image', exact: true })).toHaveAttribute(
		'href',
		`data:image/png;base64,${PNG}`,
	);
	await viewer.getByRole('button', { name: 'Close image viewer', exact: true }).click();
	const callCount = await page.evaluate(() => (window as any).__assetTest.calls.length);
	await page.getByRole('button', { name: 'Open embedded-image', exact: true }).click();
	await expect(viewer.locator('img')).toHaveAttribute('src', `data:image/png;base64,${PNG}`);
	expect(await page.evaluate(() => (window as any).__assetTest.calls.length)).toBe(callCount);
	expect(
		await page.evaluate(() =>
			(window as any).__assetTest.calls.every(
				(call: any) => call.workspaceId === 'remote' && call.connectionId === 'provider',
			),
		),
	).toBe(true);
	expect(
		await page.evaluate(() =>
			(window as any).__assetTest.states.remote.generations.map(
				(generation: any) => generation.assets[0].url,
			),
		),
	).toEqual([HOST_URL, EXTERNAL_URL, `data:image/png;base64,${PNG}`]);
	expect(browserRequests).toEqual([]);
	expect(errors).toEqual([]);
});

test('local historical gallery previews URLs and resolves selected pixels through the local workspace', async ({
	page,
}) => {
	await page.route(HOST_URL, (route) =>
		route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(PNG, 'base64') }),
	);
	await page.route(EXTERNAL_URL, (route) =>
		route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(PNG, 'base64') }),
	);
	await fixture(page);
	await page.getByRole('button', { name: 'Images', exact: true }).click();
	await page.evaluate(() => {
		(window as any).__assetTest.hold = false;
		(window as any).__assetTest.fail = false;
	});
	await expect(page.locator('.image-gallery-image')).toHaveCount(3);
	await expect(
		page.getByRole('button', { name: 'Open host-image', exact: true }).locator('img'),
	).toHaveAttribute('src', HOST_URL);
	await page.getByRole('button', { name: 'Open host-image', exact: true }).click();
	const viewer = page.getByRole('dialog', { name: 'Image viewer', exact: true });
	await expect(viewer.locator('img')).toHaveAttribute('src', `data:image/png;base64,${PNG}`);
	await expect(viewer.getByRole('link', { name: 'Download image', exact: true })).toHaveAttribute(
		'href',
		`data:image/png;base64,${PNG}`,
	);
	expect(await page.evaluate(() => (window as any).__assetTest.calls)).toEqual([
		{ workspaceId: 'local', connectionId: 'provider', url: HOST_URL },
	]);
	expect(
		await page.evaluate(
			() => (window as any).__assetTest.states.local.generations[0].assets[0].url,
		),
	).toBe(HOST_URL);
});
