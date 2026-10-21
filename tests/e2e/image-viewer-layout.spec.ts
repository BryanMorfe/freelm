import { chooseOption } from './ui-controls';
import { expect, test, type Page } from '@playwright/test';

// Headless Chromium normally hides scrollbars, which conceals this layout regression.
test.use({
	viewport: { width: 1547, height: 958 },
	launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] },
});

async function openImage(
	page: Page,
	width: number,
	height: number,
	longPrompt = false,
	readOnly = false,
) {
	await page.addInitScript(
		({ width, height, longPrompt, readOnly }) => {
			const canvas = document.createElement('canvas');
			canvas.width = width;
			canvas.height = height;
			const context = canvas.getContext('2d')!;
			context.fillStyle = '#708779';
			context.fillRect(0, 0, width, height);
			const imageUrl = canvas.toDataURL();
			const state = {
				version: 1,
				theme: 'dark',
				activeConnectionId: 'provider',
				threads: readOnly
					? [
							{
								id: 'chat-image-layout',
								kind: 'chat',
								title: 'Image layout chat',
								connectionId: 'provider',
								model: 'chat-model',
								thinkingMode: 'low',
								createdAt: 1,
								updatedAt: 2,
								messages: [
									{
										id: 'image-response',
										role: 'assistant',
										content: '',
										createdAt: 1,
										completedAt: 2,
										toolCalls: [
											{
												id: 'image-result',
												name: 'image_gen.imagegen',
												arguments: JSON.stringify({
													prompt: 'A tall image in chat',
													size: `${width}x${height}`,
												}),
												status: 'completed',
												startedAt: 1,
												completedAt: 2,
												result: {
													content: [{ type: 'image', name: 'layout.png', dataUrl: imageUrl }],
												},
											},
										],
									},
								],
							},
						]
					: [],
				projects: [],
				generations: [
					{
						id: 'layout-image',
						kind: 'images',
						prompt: `Layout ${width}x${height}${longPrompt ? ' with an original prompt that wraps across many lines.'.repeat(30) : ''}`,
						model: 'image-editor',
						connectionId: 'provider',
						createdAt: 1,
						status: 'completed',
						assets: [{ name: 'layout.png', mimeType: 'image/png', url: imageUrl }],
					},
				],
				connections: [
					{
						id: 'provider',
						name: 'Layout test API',
						baseUrl: 'http://localhost:8000/v1',
						apiKey: '',
						chatApi: 'responses',
						models: {
							chat: readOnly ? 'chat-model' : '',
							images: 'image-editor',
							videos: '',
							speech: '',
							transcription: '',
						},
						discoveredModels: ['image-editor'],
						catalog: readOnly
							? [
									{
										id: 'chat-model',
										name: 'Chat model',
										enabled: true,
										tasks: ['chat'],
										inputModalities: ['text'],
										outputModalities: ['text'],
										thinkingModes: [
											{
												id: 'low',
												name: 'Low',
												parameters: { responses: { reasoning: { effort: 'low' } } },
											},
										],
									},
								]
							: undefined,
					},
				],
			};
			(window as any).desktop = {
				platform: 'linux',
				workspaceLoad: async () => ({ state: structuredClone(state), revision: '1' }),
				workspaceSave: async () => ({ revision: '1' }),
				storageInfo: async () => ({ secure: false, location: 'Isolated layout test' }),
				onPrepareClose: () => () => {},
				completeClose: async () => {},
				onChunk: () => () => {},
				instanceStatus: async () => ({
					host: { running: false, name: 'Local', instanceId: 'local', port: 4319 },
					instances: [],
				}),
			};
		},
		{ width, height, longPrompt, readOnly },
	);
	await page.goto('/');
	if (readOnly) await page.getByRole('button', { name: 'Image layout chat', exact: true }).click();
	else await page.getByRole('button', { name: 'Images', exact: true }).click();
	// Fractional CSS sizes reproduce the rounding seen at non-default display scales.
	await page.addStyleTag({ content: 'body { zoom: 1.25; }' });
	await page
		.getByRole('button', { name: readOnly ? 'Open generated image' : /^Open Layout /, exact: true })
		.click();
	await expect(page.getByRole('dialog', { name: 'Image viewer', exact: true })).toBeVisible();
	await expect(page.locator('.image-viewer-image img')).toHaveJSProperty('naturalWidth', width);
}

async function expectStableGeometry(page: Page, fit: boolean) {
	const samples = await page.evaluate(async () => {
		const canvas = document.querySelector<HTMLElement>('.image-viewer-canvas')!;
		const image = document.querySelector<HTMLElement>('.image-viewer-image')!;
		const samples: number[][] = [];
		for (let frame = 0; frame < 120; frame++) {
			await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
			const box = image.getBoundingClientRect();
			samples.push([
				canvas.clientWidth,
				canvas.clientHeight,
				canvas.scrollWidth,
				canvas.scrollHeight,
				box.width,
				box.height,
			]);
		}
		return samples;
	});
	// Allow initial image loading/zoom to settle, then catch the two-state scrollbar loop.
	const settled = samples.slice(20);
	const states = new Set(settled.map((sample) => JSON.stringify(sample)));
	expect(
		[...states],
		'viewer geometry must settle instead of alternating with its scrollbars',
	).toHaveLength(1);
	const [width, height, scrollWidth, scrollHeight] = settled[0];
	if (fit) {
		expect(scrollWidth, 'Fit must not create horizontal canvas overflow').toBeLessThanOrEqual(
			width + 1,
		);
		expect(scrollHeight, 'Fit must not create vertical canvas overflow').toBeLessThanOrEqual(
			height + 1,
		);
	} else {
		expect(scrollHeight).toBeGreaterThan(height);
	}
}

for (const [shape, width, height] of [
	['portrait', 1536, 2752],
	['square', 2048, 2048],
	['landscape', 2752, 1536],
] as const) {
	test(`image viewer ${shape} geometry settles at fractional scale in Fit and fixed zoom`, async ({
		page,
	}) => {
		await openImage(page, width, height);
		await expectStableGeometry(page, true);
		for (const zoom of ['100', '200']) {
			await chooseOption(page, page.getByLabel('Image zoom', { exact: true }), zoom);
			await expectStableGeometry(page, false);
			const rendered = await page.locator('.image-viewer-image').evaluate((element) => ({
				width: parseFloat(getComputedStyle(element).width),
				height: parseFloat(getComputedStyle(element).height),
			}));
			expect(rendered.width).toBeCloseTo((width * Number(zoom)) / 100, 1);
			expect(rendered.height).toBeCloseTo((height * Number(zoom)) / 100, 1);
		}
		await chooseOption(page, page.getByLabel('Image zoom', { exact: true }), 'fit');
		await expectStableGeometry(page, true);
	});
}

test('image viewer remains stable after wrapped prompts, composer growth, and narrow viewport changes', async ({
	page,
}) => {
	await openImage(page, 1536, 2752, true);
	await page
		.getByLabel('Describe image edits', { exact: true })
		.fill('Preserve the lighting and materials while extending the scene. '.repeat(30));
	await expectStableGeometry(page, true);
	await page.getByLabel('Describe image edits', { exact: true }).fill('A small change');
	await page.setViewportSize({ width: 401, height: 600 });
	await expectStableGeometry(page, true);
	await page.setViewportSize({ width: 650, height: 801 });
	await expectStableGeometry(page, true);
});

test('chat image viewer is read-only, stable at fixed zoom and narrow sizes, and restores full-screen focus', async ({
	page,
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await openImage(page, 1536, 2752, false, true);
	const viewer = page.getByRole('dialog', { name: 'Image viewer', exact: true });
	const fullScreen = viewer.getByRole('button', { name: 'Full screen', exact: true });
	const closeViewer = viewer.getByRole('button', { name: 'Close image viewer', exact: true });
	await expect(closeViewer).toBeFocused();
	await expect(viewer.getByText('Original prompt', { exact: true })).toHaveCount(0);
	await expect(viewer.getByRole('textbox')).toHaveCount(0);
	await expect(viewer.getByRole('button', { name: 'Remove background', exact: true })).toHaveCount(
		0,
	);
	await expect(viewer.getByRole('button', { name: 'Previous image', exact: true })).toHaveCount(0);
	await expect(viewer.getByRole('button', { name: 'Next image', exact: true })).toHaveCount(0);
	await expect(viewer.getByRole('link', { name: 'Download image', exact: true })).toHaveAttribute(
		'download',
		'layout.png',
	);
	await expectStableGeometry(page, true);
	for (const zoom of ['100', '200']) {
		await chooseOption(page, viewer.getByLabel('Image zoom', { exact: true }), zoom);
		await expectStableGeometry(page, false);
	}
	await chooseOption(page, viewer.getByLabel('Image zoom', { exact: true }), 'fit');
	await fullScreen.click();
	const expanded = page.getByRole('dialog', { name: 'Full screen image', exact: true });
	const closeExpanded = expanded.getByRole('button', {
		name: 'Close full screen image',
		exact: true,
	});
	await expect(expanded).toBeVisible();
	await expect(viewer).toBeHidden();
	await expect(closeExpanded).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(closeExpanded).toBeFocused();
	await page.keyboard.press('Shift+Tab');
	await expect(closeExpanded).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(viewer).toBeVisible();
	await expect(fullScreen).toBeFocused();
	await page.screenshot({ path: '/tmp/freelm-chat-image-viewer-desktop.png' });
	await page.setViewportSize({ width: 401, height: 600 });
	await expectStableGeometry(page, true);
	const headerBounds = await viewer.locator('.image-viewer-header').evaluate((element) => {
		const bounds = element.getBoundingClientRect();
		return [...element.querySelectorAll('button, a')].map((control) => {
			const box = control.getBoundingClientRect();
			return {
				left: box.left,
				right: box.right,
				headerLeft: bounds.left,
				headerRight: bounds.right,
			};
		});
	});
	for (const control of headerBounds) {
		expect(control.left).toBeGreaterThanOrEqual(control.headerLeft);
		expect(control.right).toBeLessThanOrEqual(control.headerRight);
	}
	await page.screenshot({ path: '/tmp/freelm-chat-image-viewer-narrow.png' });
	const imageExpand = viewer.getByRole('button', { name: 'View image full screen', exact: true });
	await imageExpand.click();
	await expect(expanded).toBeVisible();
	// The blurred area dismisses the full-screen layer while keeping the viewer open.
	await expanded.click({ position: { x: 2, y: 2 } });
	await expect(expanded).toBeHidden();
	await expect(imageExpand).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(viewer).toBeHidden();
	await expect(
		page.getByRole('button', { name: 'Open generated image', exact: true }),
	).toBeFocused();
	expect(errors).toEqual([]);
});
