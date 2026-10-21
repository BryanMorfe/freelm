import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { initialState } from '../../src/lib/state';
import { configuredVideoTool } from '../../src/lib/video-tool';
import { defaultToolSettings } from '../../src/lib/tool-settings';
import type { AppState } from '../../src/types';

// Browser plugin not available. This actual-App fixture uses a local video and
// an isolated desktop bridge; no model or generation provider is contacted.
test.setTimeout(150_000);
const fixtureVideo = new URL('../fixtures/moderation-samples.mp4', import.meta.url);

async function fixture(page: Page, denied = false) {
	const state = initialState();
	state.theme = 'dark';
	state.backgroundNotifications = false;
	state.memorySettings = { savedMemories: false, referenceHistory: false };
	state.toolSettings = defaultToolSettings();
	const connection = state.connections[0];
	connection.chatApi = 'responses';
	connection.models.chat = 'chat-model';
	connection.catalog = [
		{
			id: 'chat-model',
			name: 'Chat model',
			enabled: true,
			tasks: ['chat'],
			inputModalities: ['text', 'image'],
			outputModalities: ['text'],
			thinkingModes: [
				{ id: 'low', name: 'Low', parameters: { responses: { reasoning: { effort: 'low' } } } },
			],
		},
	];
	state.toolSettings.videoGeneration = {
		enabled: true,
		connectionId: state.activeConnectionId,
		model: 'video-model',
		size: '',
		seconds: '',
	};
	const definition = configuredVideoTool(connection, state.toolSettings.videoGeneration, 'chat');
	const dataUrl = `data:video/mp4;base64,${(await readFile(fixtureVideo)).toString('base64')}`;
	await page.addInitScript(
		({ serialized, definition, dataUrl, denied }) => {
			let current: AppState = JSON.parse(serialized);
			let revision = 0;
			const control: any = { requests: [], state: () => current };
			const listeners = new Set<(event: { id: string; text: string }) => void>();
			(window as any).__videoFlow = control;
			const json = (body: unknown) => ({
				status: 200,
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
					return { revision: String(++revision) };
				},
				storageInfo: async () => ({ secure: false, location: 'Isolated video fixture' }),
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
				toolCatalog: async () => ({ instructions: '', warnings: [], tools: [definition] }),
				toolExecute: async () =>
					new Promise((resolve, reject) => {
						control.finish = () =>
							resolve(
								denied
									? {
											isError: true,
											content: [
												{
													type: 'text',
													text: 'Video output was blocked by your moderation policy. No generated media was released.',
												},
											],
										}
									: {
											content: [
												{
													type: 'text',
													text: 'Generated video with video-model. Provider job: private-job-id.',
												},
												{ type: 'file', dataUrl, name: 'sample-video.mp4', mimeType: 'video/mp4' },
											],
										},
							);
						control.cancel = () => reject(new DOMException('Cancelled', 'AbortError'));
					}),
				request: async (request: any) => {
					const body = request.body;
					if (body.instructions?.startsWith('Write a short conversation title'))
						return json({ output_text: 'Video flow example' });
					control.requests.push(body);
					if (!body.input.some((item: any) => item.type === 'function_call_output'))
						return json({
							output: [
								{
									type: 'message',
									role: 'assistant',
									content: [{ type: 'output_text', text: 'I’ll create a short color study.' }],
								},
								{
									type: 'function_call',
									call_id: 'video-call',
									name: body.tools[0].name,
									arguments: JSON.stringify({
										prompt: 'A short color study',
										seconds: '4',
										size: '640x480',
									}),
								},
							],
						});
					if (denied)
						return json({ output_text: 'The video was blocked by your moderation settings.' });
					return new Promise((resolve) => {
						let text = '';
						let characters = 0;
						let bytes = 0;
						const emit = (data: unknown) => {
							const chunk = `data: ${JSON.stringify(data)}\n\n`;
							characters += chunk.length;
							bytes += new TextEncoder().encode(chunk).length;
							for (const listener of listeners) listener({ id: request.id, text: chunk });
						};
						control.streamText = (delta: string) => {
							text += delta;
							emit({ type: 'response.output_text.delta', delta });
						};
						control.completeStream = () => {
							emit({
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
							});
							resolve({
								status: 200,
								contentType: 'text/event-stream',
								encoding: 'text',
								body: '',
								stream: { bytes, characters },
							});
						};
					});
				},
			};
		},
		{ serialized: JSON.stringify(state), definition, dataUrl, denied },
	);
	await page.goto('/');
	await expect(page).toHaveTitle('FreeLM');
	await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
	await page.getByLabel('Message', { exact: true }).fill('Generate a short color study video.');
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	await expect(
		page.locator('.chat-video-result').getByText('Creating video…', { exact: true }),
	).toBeVisible();
	await expect(page.getByLabel('Message', { exact: true })).not.toContainText(
		'Generate a short color study video.',
	);
}

test('Chat video generation becomes playable with a download and remains before the streaming final response', async ({
	page,
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (message) => {
		if (message.type() === 'error') errors.push(message.text());
	});
	await fixture(page);
	const asset = page.locator('.chat-video-result');
	await expect(asset.locator('video')).toHaveCount(0);
	await page.evaluate(() => (window as any).__videoFlow.finish());
	const video = page.getByLabel('Generated video', { exact: true });
	await expect(video).toBeVisible();
	await expect(video).toHaveAttribute('controls', '');
	await expect
		.poll(() => video.evaluate((element) => (element as HTMLVideoElement).readyState))
		.toBeGreaterThanOrEqual(1);
	expect(await video.evaluate((element) => (element as HTMLVideoElement).duration)).toBeCloseTo(
		3.25,
		1,
	);
	await video.evaluate((element) => (element as HTMLVideoElement).play());
	await expect
		.poll(() => video.evaluate((element) => (element as HTMLVideoElement).currentTime))
		.toBeGreaterThan(0);
	await video.evaluate((element) => (element as HTMLVideoElement).pause());
	const download = page.getByRole('link', { name: 'Download video', exact: true });
	const downloadEvent = page.waitForEvent('download');
	await download.click();
	const downloaded = await downloadEvent;
	expect(downloaded.suggestedFilename()).toBe('sample-video.mp4');
	expect(await readFile((await downloaded.path())!)).toEqual(await readFile(fixtureVideo));
	await page.waitForFunction(() => typeof (window as any).__videoFlow.streamText === 'function');
	await page.evaluate(() => (window as any).__videoFlow.streamText('Your video is ready.'));
	const final = page.locator('.message.assistant .message-final');
	await expect(final).toHaveText('Your video is ready.');
	const bounds = (await asset.boundingBox())!;
	expect((await final.boundingBox())!.y).toBeGreaterThanOrEqual(bounds.y + bounds.height);
	await page.evaluate(() => (window as any).__videoFlow.completeStream());
	await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toHaveCount(0);
	await expect(final).toHaveText('Your video is ready.');
	const completedBounds = (await asset.boundingBox())!;
	expect((await final.boundingBox())!.y).toBeGreaterThanOrEqual(
		completedBounds.y + completedBounds.height,
	);
	await expect(page.locator('vite-error-overlay')).toHaveCount(0);
	await page.screenshot({ path: '/tmp/freelm-chat-video-result.png' });
	const followup = await page.evaluate(() =>
		JSON.stringify((window as any).__videoFlow.requests.at(-1)),
	);
	expect(followup).toContain('sample-video.mp4');
	expect(followup).not.toContain('data:video/');
	await page.getByRole('button', { name: 'Video', exact: true }).click();
	await expect(page.getByRole('region', { name: 'Videos playground', exact: true })).toBeVisible();
	await expect(
		page.getByRole('button', { name: 'Open A short color study', exact: true }),
	).toBeVisible();
	expect(errors).toEqual([]);
});

test('Chat video moderation failure exposes its error without releasing a video or download', async ({
	page,
}) => {
	await fixture(page, true);
	await page.evaluate(() => (window as any).__videoFlow.finish());
	const asset = page.locator('.chat-video-result');
	await expect(asset.getByRole('alert')).toContainText(
		'Video output was blocked by your moderation policy',
	);
	await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toHaveCount(0);
	await expect(asset.locator('video')).toHaveCount(0);
	await expect(asset.getByRole('link', { name: 'Download video', exact: true })).toHaveCount(0);
	await expect(page.locator('.message.assistant .message-final')).toHaveText(
		'The video was blocked by your moderation settings.',
	);
});
