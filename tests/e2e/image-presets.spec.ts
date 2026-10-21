import { expect, test, type Page } from '@playwright/test';
import { chooseOption, expectValue, openRemoteSettings } from './ui-controls';
import type { AppState, ModelDefinition, WireRequest } from '../../src/types';

const nativeModel: ModelDefinition = {
	id: 'qwen-image-2.1',
	name: 'Qwen Image 2.1',
	enabled: true,
	tasks: ['images'],
	inputModalities: ['text', 'image'],
	outputModalities: ['image'],
	thinkingModes: [],
	imagePresets: [
		{
			id: 'native-2k',
			name: 'Native 2K',
			defaultAspectRatio: 'square',
			aspectRatios: [
				{ id: 'square', name: '1:1', width: 2048, height: 2048 },
				{ id: 'wide', name: '16:9', width: 2752, height: 1536 },
			],
		},
		{
			id: 'provider-fine',
			name: 'Studio quality',
			quality: 'provider-fine-v2',
			defaultAspectRatio: 'portrait',
			aspectRatios: [{ id: 'portrait', name: '2:3', width: 1024, height: 1536 }],
		},
	],
	defaultImagePreset: 'native-2k',
};

const otherModel: ModelDefinition = {
	...nativeModel,
	id: 'other-image-model',
	name: 'Other image model',
	imagePresets: [
		{
			id: 'native-2k',
			name: 'Portrait draft',
			quality: 'draft-v3',
			defaultAspectRatio: 'portrait',
			aspectRatios: [{ id: 'portrait', name: '2:3', width: 672, height: 1008 }],
		},
	],
};

async function fixture(page: Page, failedEdit = false) {
	const state: AppState = {
		version: 1,
		theme: 'dark',
		activeConnectionId: 'provider',
		threads: [],
		projects: [],
		generations: [],
		connections: [
			{
				id: 'provider',
				name: 'Preset test API',
				baseUrl: 'http://localhost:8000/v1',
				apiKey: '',
				chatApi: 'responses',
				models: { chat: '', images: nativeModel.id, videos: '', speech: '', transcription: '' },
				discoveredModels: [nativeModel.id, otherModel.id, 'unconfigured-image'],
				catalog: [nativeModel, otherModel],
			},
		],
	};
	await page.addInitScript(
		({ serializedState, failedEdit }) => {
			const state = JSON.parse(serializedState);
			const canvas = document.createElement('canvas');
			canvas.width = 160;
			canvas.height = 320;
			const context = canvas.getContext('2d')!;
			context.fillStyle = '#a57b65';
			context.fillRect(0, 0, 160, 320);
			const image = canvas.toDataURL('image/png');
			state.generations = [
				{
					id: 'portrait-original',
					kind: 'images',
					prompt: 'Original portrait',
					model: 'qwen-image-2.1',
					connectionId: 'provider',
					createdAt: 1,
					status: 'completed',
					assets: [{ name: 'portrait.png', mimeType: 'image/png', url: image }],
					parameters: { size: '160x320' },
				},
			];
			if (failedEdit) {
				state.generations.push({
					id: 'failed-edit',
					kind: 'images',
					prompt: 'The interrupted portrait edit',
					model: 'other-image-model',
					connectionId: 'provider',
					createdAt: 2,
					status: 'failed',
					assets: [],
					error: 'The provider interrupted this edit.',
					parameters: {
						operation: 'edit',
						sourceGenerationId: 'portrait-original',
						sourceAssetIndex: 0,
						size: '160x320',
						quality: 'draft-v3',
						n: 1,
					},
				});
			}
			const control: any = {
				state: JSON.parse(localStorage.getItem('preset-test-state') || JSON.stringify(state)),
				requests: [],
				image,
			};
			(window as any).__presetTest = control;
			(window as any).desktop = {
				platform: 'linux',
				workspaceLoad: async () => ({ state: structuredClone(control.state), revision: '1' }),
				workspaceSave: async (_target: string, _revision: string, state: unknown) => {
					control.state = JSON.parse(JSON.stringify(state));
					localStorage.setItem('preset-test-state', JSON.stringify(state));
					return { revision: '1' };
				},
				storageInfo: async () => ({ secure: false, location: 'Isolated preset fixture' }),
				onPrepareClose: () => () => {},
				completeClose: async () => {},
				onChunk: () => () => {},
				cancel: async () => {},
				instanceStatus: async () => ({
					host: { running: false, name: 'Local', instanceId: 'local', port: 4319 },
					instances: [],
				}),
				request: async (request: unknown) => {
					// The transport JSON-encodes the body, omitting optional undefined fields.
					control.requests.push(JSON.parse(JSON.stringify(request)));
					return {
						status: 200,
						contentType: 'application/json',
						encoding: 'text',
						body: JSON.stringify({ data: [{ b64_json: image.split(',')[1] }] }),
					};
				},
			};
		},
		{ serializedState: JSON.stringify(state), failedEdit },
	);
	await page.goto('/');
	await expect(page).toHaveTitle('FreeLM');
	await expect(page.getByRole('heading', { name: 'What’s on your mind?' })).toBeVisible();
	await page.getByRole('button', { name: 'Images', exact: true }).click();
}

const options = (page: Page) =>
	page.getByRole('region', { name: 'Image generation settings', exact: true });
async function settings(page: Page) {
	if (!(await options(page).isVisible()))
		await page.getByRole('button', { name: 'Image settings', exact: true }).click();
	return options(page);
}
async function chooseModel(page: Page, id: string) {
	if (await options(page).isVisible())
		await options(page).getByRole('button', { name: 'Close image settings' }).click();
	await page.getByRole('button', { name: 'Image model', exact: true }).click();
	const picker = page.getByRole('dialog', { name: 'Choose a model', exact: true });
	const known = picker.locator(`[role="option"][data-value=${JSON.stringify(id)}]`);
	if (await known.count()) {
		await known.click();
		return;
	}
	await picker.getByRole('button', { name: 'Use a model ID…' }).click();
	await picker.getByRole('combobox', { name: 'Search models' }).fill(id);
	await picker.getByRole('option').first().click();
}
async function requests(page: Page): Promise<WireRequest[]> {
	return page.evaluate(() => (window as any).__presetTest.requests);
}
async function state(page: Page): Promise<AppState> {
	return page.evaluate(() => (window as any).__presetTest.state);
}
async function generate(page: Page, prompt: string) {
	if (await options(page).isVisible())
		await options(page).getByRole('button', { name: 'Close image settings' }).click();
	const count = (await requests(page)).length;
	await page.getByLabel('Generation prompt', { exact: true }).fill(prompt);
	await page.getByRole('button', { name: 'Generate image', exact: true }).click();
	await expect.poll(async () => (await requests(page)).length).toBe(count + 1);
	await expect(page.getByRole('dialog', { name: 'Image viewer', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Close image viewer', exact: true }).click();
	return (await requests(page))[count];
}

test('presets send exact dimensions, omit display-only quality, and preserve explicit provider mappings', async ({
	page,
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await fixture(page);
	const panel = await settings(page);
	await expectValue(panel.getByLabel('Quality', { exact: true }), 'native-2k');
	await chooseOption(page, panel.getByLabel('Aspect ratio', { exact: true }), 'wide');
	await expect(panel.getByLabel('Resolution', { exact: true })).toHaveText('2752 × 1536 px');
	await page.screenshot({ path: '/tmp/freelm-image-presets.png' });
	const native = await generate(page, 'Native wide image');
	expect(native.path).toBe('/images/generations');
	expect(native.body).toMatchObject({ model: 'qwen-image-2.1', size: '2752x1536' });
	expect(native.body).not.toHaveProperty('quality');
	expect(native.body).not.toHaveProperty('imagePreset');
	expect(native.body).not.toHaveProperty('aspectRatio');
	await expect
		.poll(
			async () =>
				(await state(page)).generations.find((item) => item.prompt === 'Native wide image')
					?.parameters,
		)
		.toMatchObject({
			imagePreset: 'native-2k',
			aspectRatio: 'wide',
			size: '2752x1536',
		});
	await settings(page);
	await chooseOption(page, panel.getByLabel('Quality', { exact: true }), 'provider-fine');
	await expectValue(panel.getByLabel('Aspect ratio', { exact: true }), 'portrait');
	const mapped = await generate(page, 'Explicit API quality');
	expect(mapped.body).toMatchObject({ size: '1024x1536', quality: 'provider-fine-v2' });
	expect(JSON.stringify(mapped.body)).not.toContain('Studio quality');
	expect(errors).toEqual([]);
});

test('switching models resets preset dimensions and quality even when preset IDs collide', async ({
	page,
}) => {
	await fixture(page);
	const panel = await settings(page);
	await chooseOption(page, panel.getByLabel('Aspect ratio', { exact: true }), 'wide');
	await chooseModel(page, 'other-image-model');
	await settings(page);
	await expectValue(panel.getByLabel('Quality', { exact: true }), 'native-2k');
	await expectValue(panel.getByLabel('Aspect ratio', { exact: true }), 'portrait');
	await expect(panel.getByLabel('Resolution', { exact: true })).toHaveText('672 × 1008 px');
	const other = await generate(page, 'Use the other model defaults');
	expect(other.body).toMatchObject({
		model: 'other-image-model',
		size: '672x1008',
		quality: 'draft-v3',
	});
	await chooseModel(page, 'unconfigured-image');
	await settings(page);
	await expectValue(panel.getByLabel('Quality', { exact: true }), '');
	await expect(panel.getByLabel('Size', { exact: true })).toHaveValue('');
	await expect(panel.getByLabel('API quality', { exact: true })).toHaveValue('');
	const unknown = await generate(page, 'Use provider defaults');
	expect(unknown.body).toMatchObject({ model: 'unconfigured-image' });
	expect(unknown.body).not.toHaveProperty('size');
	expect(unknown.body).not.toHaveProperty('quality');
});

test('custom settings remain available for arbitrary APIs and can return to a configured preset', async ({
	page,
}) => {
	await fixture(page);
	const panel = await settings(page);
	await chooseOption(page, panel.getByLabel('Quality', { exact: true }), '');
	await panel.getByLabel('Size', { exact: true }).fill('1536x864');
	await panel.getByLabel('API quality', { exact: true }).fill('bespoke-quality');
	const custom = await generate(page, 'Custom provider dimensions');
	expect(custom.body).toMatchObject({ size: '1536x864', quality: 'bespoke-quality' });
	await settings(page);
	await chooseOption(page, panel.getByLabel('Quality', { exact: true }), 'native-2k');
	const preset = await generate(page, 'Return to square default');
	expect(preset.body).toMatchObject({ size: '2048x2048' });
	expect(preset.body).not.toHaveProperty('quality');
});

test('editing a saved image preserves source dimensions rather than the generation aspect preset', async ({
	page,
}) => {
	await fixture(page);
	const panel = await settings(page);
	await chooseOption(page, panel.getByLabel('Aspect ratio', { exact: true }), 'wide');
	await panel.getByRole('button', { name: 'Close image settings' }).click();
	await page.getByRole('button', { name: 'Open Original portrait', exact: true }).click();
	const viewer = page.getByRole('dialog', { name: 'Image viewer', exact: true });
	await viewer.getByLabel('Describe image edits').fill('Turn the portrait blue');
	await viewer.getByRole('button', { name: 'Edit image', exact: true }).click();
	await expect.poll(async () => (await requests(page)).length).toBe(1);
	const edit = (await requests(page))[0];
	expect(edit.path).toBe('/images/edits');
	const fields = Object.fromEntries(edit.form!.map((part) => [part.name, part.file || part.value]));
	expect(fields.size).toBe('160x320');
	expect(fields).not.toHaveProperty('quality');
	expect(fields.image).toMatchObject({
		base64: await page.evaluate(() => (window as any).__presetTest.image.split(',')[1]),
	});
	await expect
		.poll(
			async () =>
				(await state(page)).generations.find((item) => item.prompt === 'Turn the portrait blue')
					?.parameters,
		)
		.toMatchObject({ size: '160x320' });
	expect(
		(await state(page)).generations.find((item) => item.prompt === 'Turn the portrait blue')
			?.parameters,
	).not.toHaveProperty('aspectRatio');
});

test('retrying a saved edit preserves its model and API quality while reopening another model’s source', async ({
	page,
}) => {
	await fixture(page, true);
	await page.getByRole('button', { name: 'Retry generation', exact: true }).click();
	const viewer = page.getByRole('dialog', { name: 'Image viewer', exact: true });
	await expect(viewer).toBeVisible();
	await expect(viewer.getByRole('button', { name: 'Image model', exact: true })).toContainText(
		'Other image model',
	);
	await expect(viewer).toContainText('Your previous edit was interrupted.');
	await viewer.getByLabel('Describe image edits').fill('Retry with a blue background');
	await viewer.getByRole('button', { name: 'Edit image', exact: true }).click();
	await expect.poll(async () => (await requests(page)).length).toBe(1);
	const edit = (await requests(page))[0];
	expect(edit.path).toBe('/images/edits');
	const fields = Object.fromEntries(edit.form!.map((part) => [part.name, part.file || part.value]));
	expect(fields).toMatchObject({
		model: 'other-image-model',
		quality: 'draft-v3',
		size: '160x320',
	});
	expect(fields.image).toMatchObject({
		base64: await page.evaluate(() => (window as any).__presetTest.image.split(',')[1]),
	});
});

test('catalog editing persists recommended and custom presets with their selected defaults', async ({
	page,
}) => {
	test.setTimeout(120_000);
	await page.setViewportSize({ width: 720, height: 940 });
	await fixture(page);
	await page.getByRole('button', { name: /Personal workspace/ }).click();
	const preferences = page.getByRole('region', { name: 'Settings', exact: true });
	await preferences.getByRole('button', { name: 'Edit model Qwen Image 2.1', exact: true }).click();
	await preferences.getByRole('button', { name: 'Use recommended presets', exact: true }).click();
	await expect(preferences.locator('.image-preset-card')).toHaveCount(1);
	await preferences.locator('.image-preset-card').first().locator('summary').click();
	const ratioBounds = await preferences.locator('.image-ratio-row').evaluateAll((rows) =>
		rows.every((row) => {
			const bounds = row.getBoundingClientRect();
			return [...row.querySelectorAll('input, button')].every((control) => {
				const rect = control.getBoundingClientRect();
				return rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1;
			});
		}),
	);
	expect(ratioBounds).toBe(true);
	await expect(preferences.getByLabel('Image preset 1 API quality', { exact: true })).toHaveValue(
		'',
	);
	await chooseOption(
		page,
		preferences.getByLabel('Image preset 1 default aspect ratio', { exact: true }),
		{ label: '9:16' },
	);
	await preferences.getByRole('button', { name: 'Add image preset', exact: true }).click();
	await preferences.getByLabel('Image preset 2 label', { exact: true }).fill('Print detail');
	await preferences.getByLabel('Image preset 2 API quality', { exact: true }).fill('print-v2');
	await preferences
		.getByLabel('Image preset 2 aspect ratio 1 label', { exact: true })
		.fill('Portrait');
	await preferences.getByLabel('Image preset 2 aspect ratio 1 width', { exact: true }).fill('1200');
	await preferences
		.getByLabel('Image preset 2 aspect ratio 1 height', { exact: true })
		.fill('1800');
	await preferences
		.getByRole('button', { name: 'Add aspect ratio to image preset 2', exact: true })
		.click();
	await preferences
		.getByLabel('Image preset 2 aspect ratio 2 label', { exact: true })
		.fill('Landscape');
	await preferences.getByLabel('Image preset 2 aspect ratio 2 width', { exact: true }).fill('1800');
	await preferences
		.getByLabel('Image preset 2 aspect ratio 2 height', { exact: true })
		.fill('1200');
	await chooseOption(
		page,
		preferences.getByLabel('Image preset 2 default aspect ratio', { exact: true }),
		{ label: 'Landscape' },
	);
	await chooseOption(page, preferences.getByLabel('Default image preset', { exact: true }), {
		label: 'Print detail',
	});
	await preferences.getByRole('button', { name: 'Apply model', exact: true }).click();
	await preferences.getByRole('button', { name: 'Save settings', exact: true }).click();
	await expect
		.poll(async () => (await state(page)).connections[0].catalog![0].imagePresets?.[1].name)
		.toBe('Print detail');
	const saved = (await state(page)).connections[0].catalog![0];
	expect(saved.imagePresets![0]).toMatchObject({ defaultAspectRatio: '9:16' });
	expect(saved.imagePresets![0]).not.toHaveProperty('quality');
	expect(saved.imagePresets![0].aspectRatios).toHaveLength(7);
	expect(saved.imagePresets![0].aspectRatios.find((ratio) => ratio.id === '16:9')).toMatchObject({
		width: 2752,
		height: 1536,
	});
	expect(saved.imagePresets![1]).toMatchObject({ name: 'Print detail', quality: 'print-v2' });
	expect(saved.defaultImagePreset).toBe(saved.imagePresets![1].id);
	expect(saved.imagePresets![1].defaultAspectRatio).toBe(saved.imagePresets![1].aspectRatios[1].id);
	await page.reload();
	await expect(page.getByRole('heading', { name: 'What’s on your mind?' })).toBeVisible();
	await page.getByRole('button', { name: 'Images', exact: true }).click();
	const panel = await settings(page);
	await expectValue(panel.getByLabel('Quality', { exact: true }), saved.defaultImagePreset!);
	await expectValue(
		panel.getByLabel('Aspect ratio', { exact: true }),
		saved.imagePresets![1].defaultAspectRatio!,
	);
	await expect(panel.getByLabel('Resolution', { exact: true })).toHaveText('1800 × 1200 px');
	const result = await generate(page, 'Persisted print settings');
	expect(result.body).toMatchObject({ size: '1800x1200', quality: 'print-v2' });
	expect((await state(page)).connections[0].catalog![0]).toEqual(saved);
});

test('remote image models stay categorized and read-only without changing host presets', async ({
	page,
}) => {
	await fixture(page);
	const before = (await state(page)).connections[0].catalog;
	await page.evaluate(() => {
		const desktop = (window as any).desktop;
		desktop.instanceStatus = async () => ({
			host: { running: false, name: 'Local', instanceId: 'local', port: 4319 },
			instances: [
				{
					id: 'remote-preset',
					name: 'Remote preset host',
					transport: 'direct',
					url: 'http://127.0.0.1:4319',
					connected: true,
					hasToken: true,
				},
			],
		});
		desktop.instanceOpen = async () => ({
			state: structuredClone((window as any).__presetTest.state),
			revision: '1',
		});
	});
	await openRemoteSettings(page);
	await page
		.getByRole('region', { name: 'Remote FreeLM workspaces', exact: true })
		.getByRole('button', { name: 'Open', exact: true })
		.click();
	await expect(page.locator('.instance-context-bar')).toContainText('Remote preset host');
	await page.getByRole('button', { name: /Personal workspace/ }).click();
	const preferences = page.getByRole('region', { name: 'Settings', exact: true });
	await expect(preferences).toContainText('Edit them in Settings on that computer.');
	const images = preferences
		.locator('.model-catalog')
		.getByRole('region', { name: 'Image', exact: true });
	const model = images.locator('.catalog-entry').filter({ hasText: 'Qwen Image 2.1' });
	await expect(model).toBeVisible();
	await expect(model.locator('summary')).toHaveCount(0);
	await expect(preferences.locator('.catalog-image-summary')).toHaveCount(0);
	await expect(
		preferences.getByRole('button', { name: 'Edit model Qwen Image 2.1', exact: true }),
	).toHaveCount(0);
	await expect(
		preferences.getByRole('button', { name: 'Add image preset', exact: true }),
	).toHaveCount(0);
	expect((await state(page)).connections[0].catalog).toEqual(before);
	expect(await requests(page)).toEqual([]);
});
