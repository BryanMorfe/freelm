import { chooseOption, expectValue } from './ui-controls';
import { expect, test, type Page } from '@playwright/test';

async function imageFixture(page: Page, history = true, longPrompts = false) {
	await page.addInitScript(
		({ history, longPrompts }) => {
			const png = (width: number, height: number, color: string) => {
				const canvas = document.createElement('canvas');
				canvas.width = width;
				canvas.height = height;
				const context = canvas.getContext('2d')!;
				context.fillStyle = color;
				context.fillRect(0, 0, width, height);
				context.fillStyle = '#eee7d0';
				context.fillRect(width / 4, height / 4, width / 2, height / 2);
				return canvas.toDataURL('image/png');
			};
			const assets = [
				png(160, 320, '#9a715c'),
				png(320, longPrompts ? 80 : 160, '#526d62'),
				png(longPrompts ? 960 : 240, longPrompts ? 120 : 240, '#5d6787'),
				png(160, 240, '#8a6d85'),
			];
			const generation = (id: number) => ({
				id: `history-${id}`,
				kind: 'images',
				prompt:
					[
						'A tall copper tower',
						'A wide green garden',
						'A square blue studio',
						'A lavender window',
					][id] +
					(longPrompts && id < 3
						? ' with soft afternoon light, intricate textures, layered architecture, and a calm atmosphere.'.repeat(
								16,
							)
						: ''),
				model: 'image-editor',
				connectionId: 'provider',
				createdAt: 10 - id,
				status: 'completed',
				assets: [{ name: `original-${id}.png`, mimeType: 'image/png', url: assets[id] }],
			});
			const seed = {
				version: 1,
				theme: 'dark',
				activeConnectionId: 'provider',
				threads: [],
				projects: [],
				generations: history ? assets.map((_, id) => generation(id)) : [],
				connections: [
					{
						id: 'provider',
						name: 'Image test API',
						baseUrl: 'http://localhost:8000/v1',
						apiKey: '',
						chatApi: 'responses',
						models: { chat: '', images: 'image-editor', videos: '', speech: '', transcription: '' },
						discoveredModels: ['image-editor'],
						catalog: [
							{
								id: 'image-editor',
								name: 'Studio image model',
								enabled: true,
								tasks: ['images'],
								inputModalities: ['text', 'image'],
								outputModalities: ['image'],
								thinkingModes: [],
							},
						],
					},
				],
			};
			const control: any = {
				state: JSON.parse(localStorage.getItem('image-test-state') || JSON.stringify(seed)),
				requests: [],
				cancelled: [],
				hold: false,
				fail: false,
				assets,
				result: png(200, 200, '#a99873'),
			};
			(window as any).__imageTest = control;
			(window as any).desktop = {
				platform: 'linux',
				workspaceLoad: async () => ({ state: structuredClone(control.state), revision: '1' }),
				workspaceSave: async (_target: string, _revision: string, state: unknown) => {
					control.state = structuredClone(state);
					localStorage.setItem('image-test-state', JSON.stringify(state));
					return { revision: '1' };
				},
				storageInfo: async () => ({ secure: false, location: 'Isolated test workspace' }),
				onPrepareClose: () => () => {},
				completeClose: async () => {},
				onChunk: () => () => {},
				instanceStatus: async () => ({
					host: { running: false, name: 'Local', instanceId: 'local', port: 4319 },
					instances: [],
				}),
				request: async (request: any) => {
					control.requests.push(structuredClone(request));
					if (control.hold)
						await new Promise<void>((resolve) => {
							control.release = resolve;
						});
					if (control.fail)
						return {
							status: 503,
							contentType: 'application/json',
							encoding: 'text',
							body: JSON.stringify({ error: { message: 'Synthetic image request failure' } }),
						};
					return {
						status: 200,
						contentType: 'application/json',
						encoding: 'text',
						body: JSON.stringify({ data: [{ b64_json: control.result.split(',')[1] }] }),
					};
				},
				cancel: async (id: string) => {
					control.cancelled.push(id);
				},
			};
		},
		{ history, longPrompts },
	);
	await page.goto('/');
	await expect(page.getByRole('heading', { name: 'What’s on your mind?' })).toBeVisible();
	await page.getByRole('button', { name: 'Images', exact: true }).click();
}

async function requestFields(page: Page, index: number) {
	return page.evaluate((position) => {
		const wire = (window as any).__imageTest.requests[position];
		return {
			path: wire.path,
			body: wire.body,
			fields: Object.fromEntries(
				(wire.form || []).map((part: any) => [part.name, part.file || part.value]),
			),
		};
	}, index);
}

for (const width of [1440, 720]) {
	test(`submitting an image edit clears its composer while retaining retry inputs and a later draft at ${width}px`, async ({
		page,
	}) => {
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		page.on('console', (entry) => {
			if (entry.type() === 'error') errors.push(entry.text());
		});
		await page.setViewportSize({ width, height: 940 });
		await imageFixture(page, false);
		await expect(page).toHaveTitle('FreeLM');
		const composer = page.locator('.image-composer');
		const prompt = composer.getByLabel('Generation prompt', { exact: true });
		const attach = composer.getByRole('button', { name: 'Add reference images', exact: true });
		const submittedPrompt = 'Make the submitted reference a copper tower';
		const laterDraft = 'A new lavender garden without the previous reference';
		await expect(attach).toHaveCount(1);
		await expect(composer.getByRole('button', { name: /^Add / })).toHaveCount(1);
		const source = await page.evaluate(() => (window as any).__imageTest.assets[0].split(',')[1]);
		const mask = await page.evaluate(() => (window as any).__imageTest.assets[1].split(',')[1]);
		const referenceChooser = page.waitForEvent('filechooser');
		await attach.click();
		await (
			await referenceChooser
		).setFiles({
			name: 'submitted-reference.png',
			mimeType: 'image/png',
			buffer: Buffer.from(source, 'base64'),
		});
		await expect(
			composer.getByRole('button', { name: 'Remove submitted-reference.png', exact: true }),
		).toBeVisible();
		await expect(composer.getByRole('button', { name: /^Add / })).toHaveCount(1);
		await composer.getByRole('button', { name: 'Image settings', exact: true }).click();
		const settings = page.getByRole('region', { name: 'Image generation settings', exact: true });
		const maskChooser = page.waitForEvent('filechooser');
		await settings.getByRole('button', { name: 'Add image mask', exact: true }).click();
		await (
			await maskChooser
		).setFiles({
			name: 'submitted-mask.png',
			mimeType: 'image/png',
			buffer: Buffer.from(mask, 'base64'),
		});
		await expect(composer.getByRole('button', { name: 'Remove mask', exact: true })).toBeVisible();
		await expect(
			settings.getByRole('button', { name: 'Replace image mask', exact: true }),
		).toBeVisible();
		await settings.getByRole('button', { name: 'Close image settings', exact: true }).click();
		await expect(composer.getByRole('button', { name: /^Add / })).toHaveCount(1);
		await prompt.fill(submittedPrompt);
		await page.evaluate(() => {
			(window as any).__imageTest.hold = true;
		});
		await composer.getByRole('button', { name: 'Edit image', exact: true }).click();
		await expect
			.poll(() => page.evaluate(() => (window as any).__imageTest.requests.length))
			.toBe(1);
		await expect(composer.getByRole('button', { name: 'Stop request', exact: true })).toBeVisible();
		await expect(prompt).toHaveValue('');
		await expect(composer.locator('.image-reference')).toHaveCount(0);
		await expect(composer.locator('.image-mask-note')).toHaveCount(0);
		await expect(composer.getByRole('button', { name: /^Add / })).toHaveCount(1);
		const first = await requestFields(page, 0);
		expect(first.path).toBe('/images/edits');
		expect(first.fields.prompt).toBe(submittedPrompt);
		expect(first.fields.image).toMatchObject({
			name: 'submitted-reference.png',
			type: 'image/png',
			base64: source,
		});
		expect(first.fields.mask).toMatchObject({
			name: 'submitted-mask.png',
			type: 'image/png',
			base64: mask,
		});
		await expect(prompt).toBeEnabled();
		await prompt.fill(laterDraft);
		await expect(attach).toBeVisible();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
			true,
		);
		await page.screenshot({ path: `/tmp/freelm-image-submit-cleared-${width}.png` });
		await page.evaluate(() => {
			(window as any).__imageTest.fail = true;
			(window as any).__imageTest.release();
		});
		await expect(page.locator('.image-compose-error')).toContainText(
			'Synthetic image request failure',
		);
		await expect(prompt).toHaveValue(laterDraft);
		await expect(composer.locator('.image-reference, .image-mask-note')).toHaveCount(0);
		await expect(composer.getByRole('button', { name: /^Add / })).toHaveCount(1);
		await page.evaluate(() => {
			(window as any).__imageTest.hold = false;
			(window as any).__imageTest.fail = false;
		});
		await page.getByRole('button', { name: 'Retry generation', exact: true }).click();
		await expect
			.poll(() => page.evaluate(() => (window as any).__imageTest.requests.length))
			.toBe(2);
		const retried = await requestFields(page, 1);
		expect(retried.path).toBe('/images/edits');
		expect(retried.fields).toEqual(first.fields);
		await page.getByRole('button', { name: 'Close image viewer', exact: true }).click();
		await expect(prompt).toHaveValue(laterDraft);
		await expect(composer.locator('.image-reference, .image-mask-note')).toHaveCount(0);
		await composer.getByRole('button', { name: 'Generate image', exact: true }).click();
		await expect
			.poll(() => page.evaluate(() => (window as any).__imageTest.requests.length))
			.toBe(3);
		const next = await requestFields(page, 2);
		expect(next.path).toBe('/images/generations');
		expect(next.body).toMatchObject({ prompt: laterDraft });
		expect(next.fields).toEqual({});
		await expect(prompt).toHaveValue('');
		await expect(
			page.locator('vite-error-overlay, #webpack-dev-server-client-overlay'),
		).toHaveCount(0);
		expect(errors).toEqual([]);
	});
}

test('gallery hover prompts ellipsize full lines on tall and short images without clipping or changing masonry', async ({
	page,
}) => {
	test.setTimeout(120_000);
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (entry) => {
		if (entry.type() === 'error') errors.push(entry.text());
	});
	await imageFixture(page, true, true);
	await expect(page).toHaveTitle('FreeLM');
	await expect(page.locator('vite-error-overlay, #webpack-dev-server-client-overlay')).toHaveCount(
		0,
	);
	const cards = page.locator('.image-gallery-card');
	const tall = cards.filter({ hasText: 'A tall copper tower' });
	const short = cards.filter({ hasText: 'A wide green garden' });
	const panorama = cards.filter({ hasText: 'A square blue studio' });
	const simple = cards.filter({ hasText: 'A lavender window' });
	await expect(cards).toHaveCount(4);
	await expect
		.poll(() =>
			page
				.locator('.image-gallery-image')
				.evaluateAll((images) =>
					images.every((image) => (image as HTMLImageElement).naturalWidth > 0),
				),
		)
		.toBe(true);
	for (const [name, width, height] of [
		['wide', 1440, 940],
		['narrow', 760, 900],
	] as const) {
		await page.setViewportSize({ width, height });
		await tall.locator('.image-gallery-open').focus();
		await short.hover();
		await expect(tall.locator('.image-gallery-caption')).toHaveCSS('opacity', '1');
		await expect(short.locator('.image-gallery-caption')).toHaveCSS('opacity', '1');
		for (const card of [tall, short, panorama]) {
			const caption = card.locator('.image-gallery-caption');
			const text = caption.locator('.image-gallery-caption-text');
			await expect(text).toHaveCSS('overflow', 'hidden');
			await expect(text).toHaveCSS('-webkit-box-orient', 'vertical');
			await expect
				.poll(() =>
					card.evaluate((element) => {
						const image = element.querySelector('img')!.getBoundingClientRect();
						const caption = element
							.querySelector('.image-gallery-caption')!
							.getBoundingClientRect();
						return caption.top >= image.top - 0.1 && caption.bottom <= image.bottom + 0.1;
					}),
				)
				.toBe(true);
			const layout = await text.evaluate((element) => {
				const style = getComputedStyle(element);
				return {
					lines: Number(style.webkitLineClamp),
					lineHeight: parseFloat(style.lineHeight),
					height: element.getBoundingClientRect().height,
					fullHeight: element.scrollHeight,
				};
			});
			expect(layout.lines).toBeGreaterThanOrEqual(1);
			expect(layout.lines).toBeLessThanOrEqual(3);
			expect(layout.height).toBeCloseTo(layout.lines * layout.lineHeight, 1);
			expect(layout.fullHeight).toBeGreaterThan(layout.height);
			expect(
				await card.evaluate((element) => {
					const text = element
						.querySelector('.image-gallery-caption-text')!
						.getBoundingClientRect();
					const remove = element.querySelector('.image-gallery-delete')!.getBoundingClientRect();
					return (
						text.bottom <= remove.top || text.top >= remove.bottom || text.right <= remove.left
					);
				}),
			).toBe(true);
		}
		await expect(tall.locator('.image-gallery-caption-text')).toHaveCSS('-webkit-line-clamp', '3');
		await expect(short.locator('.image-gallery-caption-text')).toHaveCSS('-webkit-line-clamp', '1');
		await expect(panorama.locator('.image-gallery-caption-text')).toHaveCSS(
			'-webkit-line-clamp',
			'1',
		);
		const dimensions = await page.locator('.image-gallery-image').evaluateAll((images) =>
			images.map((element) => {
				const image = element as HTMLImageElement;
				const box = image.getBoundingClientRect();
				return {
					width: box.width,
					height: box.height,
					ratio: image.naturalWidth / image.naturalHeight,
				};
			}),
		);
		for (const image of dimensions) {
			expect(Math.abs(image.width - dimensions[0].width)).toBeLessThan(2);
			expect(Math.abs(image.width / image.height - image.ratio)).toBeLessThan(0.02);
		}
		const simpleText = simple.locator('.image-gallery-caption-text');
		await expect(simpleText).toHaveText('A lavender window');
		expect(
			await simpleText.evaluate((element) => element.scrollHeight <= element.clientHeight + 1),
		).toBe(true);
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
			true,
		);
		await page.screenshot({ path: `/tmp/freelm-image-caption-${name}.png` });
	}
	await short.locator('.image-gallery-open').click();
	const viewer = page.getByRole('dialog', { name: 'Image viewer', exact: true });
	await expect(viewer).toBeVisible();
	const completePrompt = await page.evaluate(
		() => (window as any).__imageTest.state.generations[1].prompt,
	);
	await expect(viewer.locator('.image-viewer-original p')).toHaveText(completePrompt);
	await viewer.getByRole('button', { name: 'Close image viewer', exact: true }).click();
	expect(errors).toEqual([]);
});

test('image gallery keeps equal widths and natural aspect ratios, with a full-screen viewer at desktop and narrow sizes', async ({
	page,
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (entry) => {
		if (entry.type() === 'error') errors.push(entry.text());
	});
	await imageFixture(page);
	const thumbnails = page.locator('.image-gallery-image');
	await expect(thumbnails).toHaveCount(4);
	await expect
		.poll(() =>
			thumbnails.evaluateAll((images) =>
				images.every((image) => (image as HTMLImageElement).naturalWidth > 0),
			),
		)
		.toBe(true);
	const dimensions = await thumbnails.evaluateAll((images) =>
		images.map((element) => {
			const image = element as HTMLImageElement;
			const box = image.getBoundingClientRect();
			return {
				width: box.width,
				height: box.height,
				x: box.x,
				y: box.y,
				ratio: image.naturalWidth / image.naturalHeight,
			};
		}),
	);
	for (const image of dimensions) {
		expect(Math.abs(image.width - dimensions[0].width)).toBeLessThan(2);
		expect(Math.abs(image.width / image.height - image.ratio)).toBeLessThan(0.02);
	}
	expect(dimensions[0].height).toBeGreaterThan(dimensions[1].height * 3.8);
	expect(new Set(dimensions.map((image) => Math.round(image.x))).size).toBeGreaterThan(1);
	expect(dimensions[0].y).toBe(Math.min(...dimensions.map((image) => image.y)));
	await page.screenshot({ path: '/tmp/freelm-images-gallery-desktop.png' });
	await page.getByRole('button', { name: 'Open A tall copper tower', exact: true }).click();
	const viewer = page.getByRole('dialog', { name: 'Image viewer', exact: true });
	await expect(viewer).toBeVisible();
	await expect(viewer).toContainText('A tall copper tower');
	const box = await viewer.boundingBox();
	expect(box?.width).toBeGreaterThan(1400);
	expect(box?.height).toBeGreaterThan(900);
	await chooseOption(page, viewer.getByLabel('Image zoom', { exact: true }), '150');
	await expectValue(viewer.getByLabel('Image zoom', { exact: true }), '150');
	await viewer.getByRole('button', { name: 'Next image', exact: true }).click();
	await expect(viewer).toContainText('A wide green garden');
	await page.screenshot({ path: '/tmp/freelm-images-viewer-desktop.png' });
	await page.keyboard.press('Escape');
	await expect(viewer).toBeHidden();
	await page.setViewportSize({ width: 720, height: 900 });
	await page.screenshot({ path: '/tmp/freelm-images-gallery-narrow.png' });
	const narrow = await thumbnails.evaluateAll((images) =>
		images.map((image) => {
			const box = image.getBoundingClientRect();
			return { width: box.width, height: box.height, right: box.right };
		}),
	);
	for (const image of narrow) {
		expect(Math.abs(image.width - narrow[0].width)).toBeLessThan(2);
		expect(image.right).toBeLessThanOrEqual(720);
	}
	expect(narrow[0].height).toBeGreaterThan(narrow[1].height * 3.8);
	await page.getByRole('button', { name: 'Open A tall copper tower', exact: true }).click();
	await expect(
		viewer.getByRole('button', { name: 'Close image viewer', exact: true }),
	).toBeVisible();
	await page.screenshot({ path: '/tmp/freelm-images-viewer-narrow.png' });
	expect(errors).toEqual([]);
});

test('viewer edits reuse the selected original, create a transparent erase mask, and send the requested resize', async ({
	page,
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (entry) => {
		if (entry.type() === 'error') errors.push(entry.text());
	});
	await imageFixture(page);
	await page.getByRole('button', { name: 'Open A tall copper tower', exact: true }).click();
	const viewer = page.getByRole('dialog', { name: 'Image viewer', exact: true });
	await viewer.getByRole('button', { name: 'Remove background', exact: true }).click();
	await expect(viewer.getByLabel('Describe image edits', { exact: true })).toHaveValue(
		/background/i,
	);
	expect(await page.evaluate(() => (window as any).__imageTest.requests)).toEqual([]);
	await viewer.getByLabel('Describe image edits', { exact: true }).fill('Make the tower blue');
	await viewer.getByRole('button', { name: 'Edit image', exact: true }).click();
	await expect.poll(() => page.evaluate(() => (window as any).__imageTest.requests.length)).toBe(1);
	const edit = await requestFields(page, 0);
	expect(edit.path).toBe('/images/edits');
	expect(edit.fields.prompt).toBe('Make the tower blue');
	expect(edit.fields.model).toBe('image-editor');
	expect(edit.fields.size).toBe('160x320');
	const source = await page.evaluate(() => (window as any).__imageTest.assets[0].split(',')[1]);
	expect(edit.fields.image.base64).toBe(source);
	await expect
		.poll(() =>
			page.evaluate(() =>
				(window as any).__imageTest.state.generations.some(
					(generation: any) =>
						generation.prompt === 'Make the tower blue' && generation.status === 'completed',
				),
			),
		)
		.toBe(true);
	if (await viewer.isVisible())
		await viewer.getByRole('button', { name: 'Close image viewer', exact: true }).click();
	await page.getByRole('button', { name: 'Open A tall copper tower', exact: true }).click();
	await viewer.getByRole('button', { name: 'Erase', exact: true }).click();
	const selection = viewer.getByRole('group', { name: 'Image erase selection', exact: true });
	await expect(selection).toBeVisible();
	const rectangle = await selection.boundingBox();
	expect(rectangle).not.toBeNull();
	await page.mouse.move(
		rectangle!.x + rectangle!.width * 0.25,
		rectangle!.y + rectangle!.height * 0.25,
	);
	await page.mouse.down();
	await page.mouse.move(
		rectangle!.x + rectangle!.width * 0.55,
		rectangle!.y + rectangle!.height * 0.55,
		{ steps: 5 },
	);
	await page.mouse.up();
	await viewer.getByRole('button', { name: 'Edit image', exact: true }).click();
	await expect.poll(() => page.evaluate(() => (window as any).__imageTest.requests.length)).toBe(2);
	const erase = await requestFields(page, 1);
	expect(erase.path).toBe('/images/edits');
	expect(erase.fields.image.base64).toBe(source);
	expect(erase.fields.mask.type).toBe('image/png');
	const mask = await page.evaluate(async (base64) => {
		const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
		const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
		const canvas = document.createElement('canvas');
		canvas.width = image.width;
		canvas.height = image.height;
		const context = canvas.getContext('2d')!;
		context.drawImage(image, 0, 0);
		return {
			width: image.width,
			height: image.height,
			selectedAlpha: context.getImageData(
				Math.floor(image.width * 0.4),
				Math.floor(image.height * 0.4),
				1,
				1,
			).data[3],
			outsideAlpha: context.getImageData(0, 0, 1, 1).data[3],
		};
	}, erase.fields.mask.base64);
	expect(mask).toEqual({ width: 160, height: 320, selectedAlpha: 0, outsideAlpha: 255 });
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					(window as any).__imageTest.state.generations.filter(
						(generation: any) => generation.status === 'completed',
					).length,
			),
		)
		.toBe(6);
	if (await viewer.isVisible())
		await viewer.getByRole('button', { name: 'Close image viewer', exact: true }).click();
	await page.getByRole('button', { name: 'Open A tall copper tower', exact: true }).click();
	await viewer.getByRole('button', { name: 'Resize', exact: true }).click();
	await viewer.getByLabel('Width', { exact: true }).fill('640');
	await viewer.getByLabel('Height', { exact: true }).fill('960');
	await viewer.getByRole('button', { name: 'Edit image', exact: true }).click();
	await expect.poll(() => page.evaluate(() => (window as any).__imageTest.requests.length)).toBe(3);
	const resized = await requestFields(page, 2);
	expect(resized.path).toBe('/images/edits');
	expect(resized.fields.image.base64).toBe(source);
	expect(resized.fields.size).toBe('640x960');
	expect(resized.fields.mask).toBeUndefined();
	await expect(viewer.getByRole('button', { name: 'Stop image edit', exact: true })).toHaveCount(0);
	await page.evaluate(() => {
		(window as any).__imageTest.hold = true;
	});
	await viewer.getByLabel('Describe image edits', { exact: true }).fill('An edit to cancel');
	await viewer.getByRole('button', { name: 'Edit image', exact: true }).click();
	await expect.poll(() => page.evaluate(() => (window as any).__imageTest.requests.length)).toBe(4);
	await viewer.getByRole('button', { name: 'Stop image edit', exact: true }).click();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					(window as any).__imageTest.state.generations.find(
						(generation: any) => generation.prompt === 'An edit to cancel',
					)?.status,
			),
		)
		.toBe('cancelled');
	expect(await page.evaluate(() => (window as any).__imageTest.requests.length)).toBe(4);
	await page.evaluate(() => (window as any).__imageTest.release());
	expect(errors).toEqual([]);
});

test('image generation settings reach the API and cancellation remains cancelled after reload', async ({
	page,
}) => {
	await imageFixture(page, false);
	await page.getByRole('button', { name: 'Image settings', exact: true }).click();
	const settings = page.getByRole('region', { name: 'Image generation settings', exact: true });
	await settings.getByLabel('Size', { exact: true }).fill('1536x1024');
	await settings.getByLabel('API quality', { exact: true }).fill('high');
	await chooseOption(
		page,
		settings.getByRole('combobox', { name: 'Number of images', exact: true }),
		'2',
	);
	await page.getByRole('button', { name: 'Image settings', exact: true }).click();
	await page.getByLabel('Generation prompt', { exact: true }).fill('A green field');
	await page.getByRole('button', { name: 'Generate image', exact: true }).click();
	await expect.poll(() => page.evaluate(() => (window as any).__imageTest.requests.length)).toBe(1);
	expect((await requestFields(page, 0)).body).toMatchObject({
		model: 'image-editor',
		prompt: 'A green field',
		size: '1536x1024',
		quality: 'high',
		n: 2,
	});
	await expect(page.locator('.image-gallery-image')).toHaveCount(1);
	await page.getByRole('button', { name: 'Close image viewer', exact: true }).click();
	await page.evaluate(() => {
		(window as any).__imageTest.hold = true;
	});
	await page.getByLabel('Generation prompt', { exact: true }).fill('A request to stop');
	await page.getByRole('button', { name: 'Generate image', exact: true }).click();
	await expect.poll(() => page.evaluate(() => (window as any).__imageTest.requests.length)).toBe(2);
	await page
		.locator('.image-composer')
		.getByRole('button', { name: 'Stop request', exact: true })
		.click();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					(window as any).__imageTest.state.generations.find(
						(generation: any) => generation.prompt === 'A request to stop',
					)?.status,
			),
		)
		.toBe('cancelled');
	expect(await page.evaluate(() => (window as any).__imageTest.cancelled.length)).toBe(1);
	expect(await page.evaluate(() => (window as any).__imageTest.requests.length)).toBe(2);
	await page.evaluate(() => (window as any).__imageTest.release());
	await page.reload();
	await page.getByRole('button', { name: 'Images', exact: true }).click();
	await expect(page.locator('.image-gallery-image')).toHaveCount(1);
	expect(
		await page.evaluate(
			() =>
				(window as any).__imageTest.state.generations.find(
					(generation: any) => generation.prompt === 'A request to stop',
				)?.status,
		),
	).toBe('cancelled');
});
