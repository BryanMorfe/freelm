import { expect, test, type Page } from '@playwright/test';
import { initialState } from '../../src/lib/state';
import { configuredImageTool } from '../../src/lib/image-tool';
import { defaultToolSettings } from '../../src/lib/tool-settings';
import type { AppState } from '../../src/types';

async function fixture(
	page: Page,
	options: {
		api?: 'responses' | 'chat/completions';
		streamingContinuation?: boolean;
		continuationError?: boolean;
		imageError?: boolean;
		partialError?: boolean;
		multiple?: boolean;
		large?: boolean;
	} = {},
) {
	const state = initialState();
	state.theme = 'dark';
	state.toolSettings = defaultToolSettings();
	state.connections[0].chatApi = options.api ?? 'responses';
	state.connections[0].models.chat = 'vision-model';
	state.connections[0].catalog = [
		{
			id: 'vision-model',
			name: 'Vision model',
			enabled: true,
			tasks: ['chat'],
			inputModalities: ['text', 'image'],
			outputModalities: ['text'],
			thinkingModes: [
				{
					id: 'low',
					name: 'Low',
					parameters: {
						responses: { reasoning: { effort: 'low' } },
						chat: { reasoning_effort: 'low' },
					},
				},
			],
		},
	];
	state.toolSettings.imageGeneration = {
		enabled: true,
		connectionId: state.activeConnectionId,
		model: 'image-model',
		size: '',
		quality: '',
	};
	const imageDefinition = configuredImageTool(
		state.connections[0],
		state.toolSettings.imageGeneration,
		'chat',
	);
	await page.addInitScript(
		({ serialized, imageDefinition, options }) => {
			let current: AppState = JSON.parse(sessionStorage.getItem('chat-image-state') || serialized);
			let revision = 0;
			const canvas = document.createElement('canvas');
			canvas.width = options.large ? 2048 : 384;
			canvas.height = options.large ? 1024 : 256;
			const context = canvas.getContext('2d')!;
			const gradient = context.createLinearGradient(0, 0, 384, 256);
			gradient.addColorStop(0, '#588cad');
			gradient.addColorStop(1, '#b9c8c1');
			context.fillStyle = gradient;
			context.fillRect(0, 0, 384, 256);
			context.fillStyle = '#385a50';
			context.beginPath();
			context.moveTo(0, 256);
			context.lineTo(160, 70);
			context.lineTo(320, 256);
			context.fill();
			const dataUrl = canvas.toDataURL();
			const control: any = { requests: [], original: dataUrl, state: () => current };
			const listeners = new Set<(event: { id: string; text: string }) => void>();
			(window as any).__imageFlow = control;
			const response = (body: unknown, status = 200) => ({
				status,
				contentType: 'application/json',
				encoding: 'text',
				body: JSON.stringify(body),
			});
			(window as any).desktop = {
				platform: 'linux',
				workspaceLoad: async () => ({
					state: structuredClone(current),
					revision: String(revision),
				}),
				workspaceSave: async (_id: string, _revision: string, next: AppState) => {
					current = structuredClone(next);
					sessionStorage.setItem('chat-image-state', JSON.stringify(current));
					return { revision: String(++revision) };
				},
				storageInfo: async () => ({ secure: false, location: '/isolated/.freelm/config.json' }),
				onPrepareClose: () => () => {},
				onToolApproval: () => () => {},
				onChunk: (listener: (event: { id: string; text: string }) => void) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				cancel: async () => {},
				toolCancel: async () => control.cancel?.(),
				instanceStatus: async () => ({
					host: { running: false, name: 'Local', instanceId: 'local', port: 4319 },
					instances: [],
				}),
				toolCatalog: async () => ({ instructions: '', warnings: [], tools: [imageDefinition] }),
				toolExecute: async () =>
					new Promise((resolve, reject) => {
						control.finish = () =>
							resolve(
								options.imageError
									? {
											isError: true,
											content: [{ type: 'text', text: 'The image service is unavailable.' }],
										}
									: {
											isError: options.partialError || undefined,
											content: [
												{
													type: 'text',
													text: options.partialError
														? 'Only one of the requested images was generated.'
														: 'Generated with image-model. Private tool metadata.',
												},
												{ type: 'image', name: 'landscape.png', dataUrl },
												...(options.multiple
													? [{ type: 'image', name: 'second.png', dataUrl }]
													: []),
											],
										},
							);
						control.cancel = () => reject(new DOMException('Cancelled', 'AbortError'));
					}),
				request: async (request: any) => {
					const body = request.body;
					const responses = options.api !== 'chat/completions';
					if (
						body.instructions?.startsWith('Write a short conversation title') ||
						body.messages?.some(
							(item: any) =>
								item.role === 'system' &&
								typeof item.content === 'string' &&
								item.content.startsWith('Write a short conversation title'),
						)
					)
						return response(
							responses
								? { output_text: 'Image flow example' }
								: { choices: [{ message: { role: 'assistant', content: 'Image flow example' } }] },
						);
					control.requests.push(body);
					const continued = responses
						? body.input.some((item: any) => item.type === 'function_call_output')
						: body.messages.some((item: any) => item.role === 'tool');
					if (!continued) {
						const preamble = options.streamingContinuation
							? 'I’ll create a quiet mountain landscape.'
							: '';
						const name = responses ? body.tools[0].name : body.tools[0].function.name;
						const args = JSON.stringify({
							prompt: 'A quiet mountain landscape',
							size: '1536x1024',
						});
						return response(
							responses
								? {
										output: [
											...(preamble
												? [
														{
															type: 'message',
															role: 'assistant',
															content: [{ type: 'output_text', text: preamble }],
														},
													]
												: []),
											{ type: 'function_call', call_id: 'image-call', name, arguments: args },
										],
									}
								: {
										choices: [
											{
												message: {
													role: 'assistant',
													content: preamble,
													tool_calls: [
														{
															id: 'image-call',
															type: 'function',
															function: { name, arguments: args },
														},
													],
												},
												finish_reason: 'tool_calls',
											},
										],
									},
						);
					}
					if (options.streamingContinuation)
						return new Promise((resolve) => {
							let text = '';
							let characters = 0;
							let bytes = 0;
							const emit = (data: unknown) => {
								const chunk = `data: ${data === '[DONE]' ? data : JSON.stringify(data)}\n\n`;
								characters += chunk.length;
								bytes += new TextEncoder().encode(chunk).length;
								for (const listener of listeners) listener({ id: request.id, text: chunk });
							};
							control.streamText = (delta: string) => {
								text += delta;
								emit(
									responses
										? { type: 'response.output_text.delta', delta }
										: { choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] },
								);
							};
							control.completeStream = () => {
								emit(
									responses
										? {
												type: 'response.completed',
												response: {
													status: 'completed',
													output: [
														{
															type: 'message',
															role: 'assistant',
															content: [{ type: 'output_text', text }],
														},
													],
												},
											}
										: { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
								);
								if (!responses) emit('[DONE]');
								resolve({
									status: 200,
									contentType: 'text/event-stream',
									encoding: 'text',
									body: '',
									stream: { bytes, characters },
								});
							};
						});
					return options.continuationError
						? response({ error: { message: 'Request body exceeds configured limit' } }, 413)
						: response({ output_text: 'Your image is ready.' });
				},
			};
		},
		{ serialized: JSON.stringify(state), imageDefinition, options },
	);
	await page.goto('/');
	await expect(page).toHaveTitle('FreeLM');
	await expect(page.getByLabel('Message', { exact: true })).toBeVisible({ timeout: 15_000 });
	await expect(page.locator('.composer-model-name')).toHaveText('Vision model');
}

async function begin(page: Page) {
	await page.getByLabel('Message', { exact: true }).fill('Generate a mountain image.');
	await expect(page.getByLabel('Message', { exact: true })).toHaveText(
		'Generate a mountain image.',
	);
	await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	await expect(page.getByRole('status', { name: 'Creating image…', exact: true })).toBeVisible();
}
async function finish(page: Page) {
	await page.evaluate(() => (window as any).__imageFlow.finish());
}

for (const api of ['responses', 'chat/completions'] as const) {
	test(`${api} keeps the streaming final answer below the generated image through completion and reload`, async ({
		page,
	}) => {
		test.setTimeout(120_000);
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		page.on('console', (message) => {
			if (message.type() === 'error') errors.push(message.text());
		});
		await fixture(page, { api, streamingContinuation: true });
		await begin(page);
		const assistant = page.locator('.message.assistant');
		const preamble = assistant.getByText('I’ll create a quiet mountain landscape.', {
			exact: true,
		});
		await expect(preamble).toBeVisible();
		await finish(page);
		const opener = page.getByRole('button', { name: 'Open generated image', exact: true });
		await expect(opener).toBeEnabled();
		await page.waitForFunction(() => typeof (window as any).__imageFlow.streamText === 'function');
		const firstText = 'Your image is ready.';
		const finalText = `${firstText} It shows a mountain beneath a blue sky.`;
		await page.evaluate((text) => (window as any).__imageFlow.streamText(text), `${firstText} `);
		const final = assistant.locator('.message-final');
		await expect(final).toHaveText(firstText);
		await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toBeVisible();
		await expect(assistant.getByText(firstText, { exact: true })).toHaveCount(1);
		const asset = assistant.locator('.chat-image-result');
		const imageBounds = await asset.boundingBox();
		const finalBounds = await final.boundingBox();
		expect(imageBounds).not.toBeNull();
		expect(finalBounds).not.toBeNull();
		expect(finalBounds!.y).toBeGreaterThanOrEqual(imageBounds!.y + imageBounds!.height);
		expect((await preamble.boundingBox())!.y).toBeLessThan(imageBounds!.y);
		await page.evaluate(() => {
			(window as any).__imageFlow.liveElements = {
				asset: document.querySelector('.message.assistant .chat-image-result'),
				final: document.querySelector('.message.assistant .message-final'),
			};
		});
		const name = api === 'responses' ? 'responses' : 'chat-completions';
		await page.screenshot({ path: `/tmp/freelm-image-stream-${name}-live.png` });
		await opener.click();
		await expect(page.getByRole('dialog', { name: 'Image viewer', exact: true })).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(opener).toBeFocused();
		await page.evaluate(() =>
			(window as any).__imageFlow.streamText('It shows a mountain beneath a blue sky.'),
		);
		await expect(final).toHaveText(finalText);
		await expect(assistant.getByText(finalText, { exact: true })).toHaveCount(1);
		await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toBeVisible();
		await page.evaluate(() => (window as any).__imageFlow.completeStream());
		await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toHaveCount(0);
		await expect(final).toHaveText(finalText);
		await expect(assistant.getByText(finalText, { exact: true })).toHaveCount(1);
		await expect(preamble).toHaveCount(0);
		expect(
			await page.evaluate(() => {
				const previous = (window as any).__imageFlow.liveElements;
				return {
					asset: previous.asset === document.querySelector('.message.assistant .chat-image-result'),
					final: previous.final === document.querySelector('.message.assistant .message-final'),
				};
			}),
		).toEqual({ asset: true, final: true });
		const completeImageBounds = (await asset.boundingBox())!;
		expect((await final.boundingBox())!.y).toBeGreaterThanOrEqual(
			completeImageBounds.y + completeImageBounds.height,
		);
		await page.screenshot({ path: `/tmp/freelm-image-stream-${name}-complete.png` });
		await expect
			.poll(() =>
				page.evaluate(
					() => !!(window as any).__imageFlow.state().threads[0].messages.at(-1).completedAt,
				),
			)
			.toBe(true);
		await page.reload();
		await expect(page.getByLabel('Message', { exact: true })).toBeVisible({ timeout: 15_000 });
		await page.getByRole('button', { name: 'Image flow example', exact: true }).click();
		await expect(final).toHaveText(finalText, { timeout: 15_000 });
		await expect(assistant.getByText(finalText, { exact: true })).toHaveCount(1);
		await expect(opener).toBeEnabled();
		const restoredImageBounds = (await asset.boundingBox())!;
		expect((await final.boundingBox())!.y).toBeGreaterThanOrEqual(
			restoredImageBounds.y + restoredImageBounds.height,
		);
		await opener.click();
		await expect(page.getByRole('dialog', { name: 'Image viewer', exact: true })).toBeVisible();
		await page.keyboard.press('Escape');
		expect(errors).toEqual([]);
	});
}

test('Chat image generation becomes a plain image with viewer actions and survives reload', async ({
	page,
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await fixture(page);
	await begin(page);
	await expect(
		page.getByLabel('Message', { exact: true }).locator('.cm-placeholder'),
	).toBeVisible();
	await expect(page.locator('.tool-arguments')).toHaveCount(0);
	await expect(page.locator('.chat-image-dots')).toBeVisible();
	await expect(page.locator('.chat-image-placeholder')).toHaveCSS('aspect-ratio', '1.5 / 1');
	await expect(page.locator('.chat-image-placeholder .activity-shimmer')).toHaveCSS(
		'animation-duration',
		'4s',
	);
	await page.screenshot({ path: '/tmp/freelm-chat-image-pending.png' });
	await finish(page);
	await expect(page.locator('.message.assistant')).toContainText('Your image is ready.');
	await expect(page.locator('.chat-image-placeholder')).toHaveCount(0);
	await expect(page.locator('.message.assistant details')).toHaveCount(0);
	await expect(page.locator('.message.assistant')).not.toContainText('Private tool metadata');
	await expect(page.getByRole('link', { name: 'Download image', exact: true })).toHaveCount(0);
	const opener = page.getByRole('button', { name: 'Open generated image', exact: true });
	await expect(opener).toBeEnabled();
	await page.screenshot({ path: '/tmp/freelm-chat-image-complete.png' });
	await opener.click();
	const viewer = page.getByRole('dialog', { name: 'Image viewer', exact: true });
	await expect(viewer).toBeVisible();
	await expect(viewer.getByLabel('Describe image edits', { exact: true })).toHaveCount(0);
	await expect(viewer.getByRole('button', { name: 'Previous image', exact: true })).toHaveCount(0);
	await expect(viewer.getByText('Original prompt', { exact: true })).toHaveCount(0);
	const download = viewer.getByRole('link', { name: 'Download image', exact: true });
	await expect(download).toHaveAttribute('download', 'landscape.png');
	expect(await download.getAttribute('href')).toBe(
		await page.evaluate(() => (window as any).__imageFlow.original),
	);
	const downloadEvent = page.waitForEvent('download');
	await download.click();
	expect((await downloadEvent).suggestedFilename()).toBe('landscape.png');
	await viewer.getByRole('button', { name: 'Full screen', exact: true }).click();
	const full = page.getByRole('dialog', { name: 'Full screen image', exact: true });
	await expect(full).toBeVisible();
	await expect(full.getByRole('button')).toHaveCount(1);
	await page.keyboard.press('Escape');
	await expect(viewer).toBeVisible();
	await expect(viewer.getByRole('button', { name: 'Full screen', exact: true })).toBeFocused();
	await viewer.getByRole('button', { name: 'View image full screen', exact: true }).click();
	await full.click({ position: { x: 5, y: 5 } });
	await expect(viewer).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(opener).toBeFocused();
	await expect
		.poll(() =>
			page.evaluate(
				() => (window as any).__imageFlow.state().threads[0].messages.at(-1).toolCalls[0].status,
			),
		)
		.toBe('completed');
	await page.reload();
	await page.getByRole('button', { name: 'Image flow example', exact: true }).click();
	await expect(
		page.getByRole('button', { name: 'Open generated image', exact: true }),
	).toBeEnabled();
	expect(errors).toEqual([]);
});

test('image remains viewable when the subsequent chat request fails', async ({ page }) => {
	await fixture(page, { continuationError: true });
	await begin(page);
	await finish(page);
	await expect(page.locator('.message.assistant')).toContainText('API 413');
	await page.getByRole('button', { name: 'Open generated image', exact: true }).click();
	await expect(page.getByRole('link', { name: 'Download image', exact: true })).toBeVisible();
});

test('failed and cancelled image generations stop the placeholder and show a concise status', async ({
	page,
}) => {
	await fixture(page, { imageError: true });
	await begin(page);
	await finish(page);
	await expect(page.getByRole('alert')).toContainText('The image service is unavailable.');
	await expect(page.locator('.chat-image-placeholder')).toHaveCount(0);
	await page.getByRole('button', { name: 'New chat', exact: true }).click();
	await begin(page);
	await page.getByRole('button', { name: 'Stop response', exact: true }).click();
	await expect(page.locator('.chat-image-placeholder')).toHaveCount(0);
	await expect(page.locator('.chat-image-status')).toBeVisible();
});

test('narrow light-mode images and multiple-image viewer respect reduced motion', async ({
	page,
}) => {
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.setViewportSize({ width: 401, height: 700 });
	await fixture(page, { multiple: true });
	await begin(page);
	await page.locator('html').evaluate((element) => element.setAttribute('data-theme', 'light'));
	await expect(page.locator('.chat-image-placeholder .activity-shimmer')).toHaveCSS(
		'animation-name',
		'none',
	);
	await expect(page.locator('.chat-image-dots')).toHaveCSS('animation-name', 'none');
	expect(
		await page
			.locator('.chat-image-dots')
			.evaluate((element) => getComputedStyle(element, '::after').animationName),
	).toBe('none');
	await finish(page);
	await expect(
		page.getByRole('button', { name: 'Open generated image 2', exact: true }),
	).toBeEnabled();
	await page.getByRole('button', { name: 'Open generated image 1', exact: true }).click();
	const viewer = page.getByRole('dialog', { name: 'Image viewer', exact: true });
	await viewer.getByRole('button', { name: 'Next image', exact: true }).click();
	await expect(viewer.getByRole('button', { name: 'Next image', exact: true })).toBeDisabled();
	await expect(viewer.getByRole('link', { name: 'Download image', exact: true })).toHaveAttribute(
		'download',
		'second.png',
	);
	await page.screenshot({ path: '/tmp/freelm-chat-image-viewer-narrow.png' });
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('generated context uses a decodable bounded preview while the viewer keeps the original', async ({
	page,
}) => {
	await fixture(page, { large: true });
	await begin(page);
	await finish(page);
	await expect(page.locator('.message.assistant')).toContainText('Your image is ready.', {
		timeout: 15_000,
	});
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					!!(window as any).__imageFlow.state().threads[0]?.messages.at(-1)?.toolCalls?.[0]?.result,
			),
		)
		.toBe(true);
	const evidence = await page.evaluate(async () => {
		const control = (window as any).__imageFlow;
		const output = control.requests
			.at(-1)
			.input.find((item: any) => item.type === 'function_call_output');
		const preview = output.output.find((part: any) => part.type === 'input_image').image_url;
		const image = new Image();
		image.src = preview;
		await image.decode();
		const canvas = document.createElement('canvas');
		canvas.width = image.naturalWidth;
		canvas.height = image.naturalHeight;
		const context = canvas.getContext('2d')!;
		context.drawImage(image, 0, 0);
		const alpha = context.getImageData(canvas.width - 1, canvas.height - 1, 1, 1).data[3];
		const original = control
			.state()
			.threads[0].messages.at(-1)
			.toolCalls[0].result.content.find((part: any) => part.type === 'image').dataUrl;
		return {
			width: image.naturalWidth,
			height: image.naturalHeight,
			previewChars: preview.length,
			changed: preview !== control.original,
			originalPreserved: original === control.original,
			alpha,
		};
	});
	expect(evidence).toEqual({
		width: 1536,
		height: 768,
		previewChars: expect.any(Number),
		changed: true,
		originalPreserved: true,
		alpha: 0,
	});
	expect(evidence.previewChars).toBeLessThanOrEqual(1024 * 1024);
	await page.getByRole('button', { name: 'Open generated image', exact: true }).click();
	await expect(page.locator('.image-viewer-image img')).toHaveJSProperty('naturalWidth', 2048);
	await expect(page.locator('.image-viewer-image img')).toHaveJSProperty('naturalHeight', 1024);
});

test('a partial image failure shows the error alongside the usable image', async ({ page }) => {
	await fixture(page, { partialError: true });
	await begin(page);
	await finish(page);
	await expect(page.getByRole('alert')).toContainText(
		'Only one of the requested images was generated.',
	);
	await page.getByRole('button', { name: 'Open generated image', exact: true }).click();
	await expect(page.getByRole('link', { name: 'Download image', exact: true })).toBeVisible();
});
