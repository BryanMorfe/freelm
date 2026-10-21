import { expect, test, type Page } from '@playwright/test';
import { initialState } from '../../src/lib/state';
import type { AppState, ModelDefinition } from '../../src/types';
import type { ModerationSettingsInput } from '../../src/moderation-types';
import { chooseOption, expectValue, openRemoteSettings } from './ui-controls';

// Browser plugin not available. This actual-App fixture uses an isolated
// browser profile and desktop bridge; it never reads a user profile or API.
test.setTimeout(150_000);
test.use({ actionTimeout: 30_000 });

async function fixture(
	page: Page,
	legacyRemote = false,
	moderation?: ModerationSettingsInput,
	chatApi: AppState['connections'][number]['chatApi'] = 'chat/completions',
) {
	const state = initialState();
	delete state.moderation;
	if (moderation) state.moderation = moderation;
	state.backgroundNotifications = false;
	state.memorySettings = { savedMemories: false, referenceHistory: false };
	const model = (
		id: string,
		name: string,
		inputs: ModelDefinition['inputModalities'],
		patch: Partial<ModelDefinition> = {},
	): ModelDefinition => ({
		id,
		name,
		enabled: true,
		tasks: ['chat'],
		inputModalities: inputs,
		outputModalities: ['text'],
		thinkingModes: [
			{ id: 'low', name: 'Low', parameters: { chat: { reasoning_effort: 'low' } } },
			{ id: 'medium', name: 'Medium', parameters: { chat: { reasoning_effort: 'medium' } } },
			{ id: 'high', name: 'High', parameters: { chat: { reasoning_effort: 'high' } } },
			{ id: 'deep', name: 'Deep', parameters: { responses: { reasoning: { effort: 'high' } } } },
		],
		defaultThinkingMode: 'medium',
		...patch,
	});
	state.connections[0] = {
		...state.connections[0],
		id: 'evaluation-api',
		name: 'Evaluation API',
		baseUrl: 'http://evaluation-fixture.invalid/v1',
		chatApi,
		models: { chat: 'text-only', images: 'image-maker', videos: '', speech: '', transcription: '' },
		discoveredModels: ['unclassified-image-model'],
		catalog: [
			model('text-only', 'Text only', ['text']),
			model('image-judge', 'Image judge', ['text', 'image']),
			model('video-judge', 'Video judge', ['text', 'video']),
			model('multimodal-judge', 'Multimodal judge', ['text', 'image', 'video']),
			model('disabled-judge', 'Disabled judge', ['text', 'image', 'video'], { enabled: false }),
			model('image-maker', 'Image maker', ['text', 'image'], {
				tasks: ['images'],
				outputModalities: ['image'],
				thinkingModes: [],
				defaultThinkingMode: undefined,
			}),
		],
	};
	state.activeConnectionId = 'evaluation-api';
	await page.addInitScript(
		({ serialized, legacyRemote }) => {
			const control = {
				state: JSON.parse(sessionStorage.getItem('moderation-ui-state') || serialized) as AppState,
				revision: 1,
				requests: 0,
				allowImageGeneration: false,
				imageRequests: [] as any[],
			};
			(window as any).__moderationTest = control;
			const snapshot = (workspace: string) => ({
				state: structuredClone(control.state),
				revision: String(control.revision),
				...(workspace === 'legacy' ? { moderationSupported: false } : {}),
			});
			(window as any).desktop = {
				platform: 'linux',
				workspaceLoad: async (workspace: string) => snapshot(workspace),
				workspaceSave: async (_workspace: string, _revision: string, next: AppState) => {
					control.state = structuredClone(next);
					sessionStorage.setItem('moderation-ui-state', JSON.stringify(next));
					return { revision: String(++control.revision) };
				},
				storageInfo: async () => ({ secure: false, location: 'Isolated moderation fixture' }),
				onPrepareClose: () => () => {},
				onChunk: () => () => {},
				instanceStatus: async () => ({
					host: { running: false, name: 'Local', instanceId: 'local', port: 4319 },
					instances: legacyRemote
						? [
								{
									id: 'legacy',
									name: 'Legacy moderation fixture',
									transport: 'direct',
									url: 'http://legacy-moderation-fixture.invalid',
									connected: true,
									hasToken: true,
								},
							]
						: [],
				}),
				instanceOpen: async () => snapshot('legacy'),
				request: async (request: any) => {
					control.requests++;
					if (control.allowImageGeneration && request.path === '/images/generations') {
						control.imageRequests.push(structuredClone(request));
						return {
							status: 200,
							contentType: 'application/json',
							encoding: 'text',
							body: JSON.stringify({
								data: [
									{
										b64_json:
											'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6pAAAAABJRU5ErkJggg==',
									},
								],
							}),
							moderationWarnings: [
								'This image was generated without moderation because its evaluator was not configured.',
							],
						};
					}
					throw new Error('Moderation settings must not contact an API.');
				},
			};
		},
		{ serialized: JSON.stringify(state), legacyRemote },
	);
	await page.goto('/');
	await expect(page).toHaveTitle('FreeLM');
	await expect(
		page.getByRole('heading', { name: 'What’s on your mind?', exact: true }),
	).toBeVisible();
}

async function openSettings(page: Page) {
	await page.getByRole('button', { name: 'Personal workspace settings', exact: true }).click();
	const settings = page.getByRole('region', { name: 'Settings', exact: true });
	await expect(settings).toBeVisible();
	await settings.getByRole('button', { name: 'Moderation', exact: true }).click();
	await expect(settings.getByRole('heading', { name: 'Moderation', exact: true })).toBeVisible();
	return settings;
}

async function saved(page: Page): Promise<AppState> {
	return page.evaluate(() => structuredClone((window as any).__moderationTest.state));
}

test('Moderation defaults do not choose evaluators or mutate the old profile; empty settings save', async ({
	page,
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (message) => {
		if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text());
	});
	await fixture(page);
	const settings = await openSettings(page);
	for (const kind of ['Image', 'Video']) {
		await expect(
			settings.getByRole('switch', {
				name: `Enable ${kind.toLowerCase()} moderation`,
				exact: true,
			}),
		).toBeChecked();
		await expectValue(
			settings.getByRole('combobox', { name: `${kind} moderation level`, exact: true }),
			'low',
		);
		await expectValue(
			settings.getByRole('combobox', { name: `${kind} moderation API connection` }),
			'',
		);
		await expectValue(settings.getByRole('combobox', { name: `${kind} moderation model` }), '');
		await expect(
			settings.getByRole('combobox', { name: `${kind} moderation model` }),
		).toBeDisabled();
	}
	await expect(
		settings.getByRole('status').filter({ hasText: 'Images will be generated without moderation' }),
	).toBeVisible();
	await expect(
		settings.getByRole('status').filter({ hasText: 'Videos will be generated without moderation' }),
	).toBeVisible();
	await settings.getByRole('switch', { name: 'Enable image moderation', exact: true }).click();
	await expect(
		settings.getByRole('status').filter({ hasText: 'Images will be generated without moderation' }),
	).toHaveCount(0);
	await expect(
		settings.getByRole('status').filter({ hasText: 'Videos will be generated without moderation' }),
	).toBeVisible();
	await settings.getByRole('switch', { name: 'Enable image moderation', exact: true }).click();
	await expect(
		settings.getByRole('combobox', { name: 'Video moderation endpoint', exact: true }),
	).toHaveCount(0);
	await expect(
		settings.getByText(
			'Check video prompts and one frame per second of generated videos. Audio is not evaluated.',
		),
	).toBeVisible();
	expect((await saved(page)).moderation).toBeUndefined();
	const rubric = settings.getByRole('textbox', {
		name: 'Moderation evaluator rubric',
		exact: true,
	});
	await expect(rubric).not.toBeVisible();
	await settings.getByText('View evaluator rubric', { exact: true }).click();
	await expect(rubric).toBeVisible();
	await expect(rubric).toHaveAttribute('readonly', '');
	await expect(rubric).toHaveValue(/Return only one JSON object/);
	await settings.getByText('View evaluator rubric', { exact: true }).click();
	const editRubric = settings.getByRole('textbox', {
		name: 'Image edit moderation evaluator rubric',
		exact: true,
	});
	await expect(editRubric).not.toBeVisible();
	await settings.getByText('View image edit evaluator rubric', { exact: true }).click();
	await expect(editRubric).toBeVisible();
	await expect(editRubric).toHaveAttribute('readonly', '');
	await expect(editRubric).toHaveValue(/input_contains_person/);
	await expect(editRubric).toHaveValue(/EXPECTED EDITED RESULT/);
	await settings.getByText('View image edit evaluator rubric', { exact: true }).click();
	await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
	await expect
		.poll(async () => (await saved(page)).moderation)
		.toEqual({
			image: { enabled: true, level: 'low', connectionId: '', model: '' },
			video: {
				enabled: true,
				level: 'low',
				connectionId: '',
				model: '',
			},
		});
	await expect(settings.getByRole('alert')).toHaveCount(0);
	await expect(page.locator('vite-error-overlay')).toHaveCount(0);
	expect(await page.evaluate(() => (window as any).__moderationTest.requests)).toBe(0);
	expect(errors).toEqual([]);
});

test('Evaluator menus require image input for video frames and preserve independent thinking values', async ({
	page,
}) => {
	await fixture(page);
	const settings = await openSettings(page);
	await chooseOption(
		page,
		settings.getByRole('combobox', { name: 'Image moderation level', exact: true }),
		'high',
	);
	await chooseOption(
		page,
		settings.getByRole('combobox', { name: 'Video moderation level', exact: true }),
		'medium',
	);
	for (const kind of ['Image', 'Video']) {
		await chooseOption(
			page,
			settings.getByRole('combobox', { name: `${kind} moderation API connection` }),
			'evaluation-api',
		);
		const selected = settings.getByRole('combobox', { name: `${kind} moderation model` });
		await expectValue(selected, '');
		await selected.click();
		await expect(page.getByRole('option')).toHaveText(['Image judge', 'Multimodal judge']);
		await page.getByRole('option', { name: 'Image judge', exact: true }).click();
		await expectValue(
			settings.getByRole('combobox', { name: `${kind} moderation thinking effort` }),
			'medium',
		);
		if (kind === 'Image') {
			await expect(
				settings
					.getByRole('status')
					.filter({ hasText: 'Images will be generated without moderation' }),
			).toHaveCount(0);
			await expect(
				settings
					.getByRole('status')
					.filter({ hasText: 'Videos will be generated without moderation' }),
			).toBeVisible();
		}
	}
	await expect(settings.locator('.moderation-configuration-warning')).toHaveCount(0);
	await chooseOption(
		page,
		settings.getByRole('combobox', { name: 'Image moderation thinking effort' }),
		'high',
	);
	const videoThinking = settings.getByRole('combobox', {
		name: 'Video moderation thinking effort',
	});
	await expectValue(videoThinking, 'medium');
	await chooseOption(page, videoThinking, 'low');
	await expect(settings.getByRole('combobox', { name: 'Video moderation endpoint' })).toHaveCount(
		0,
	);
	await expect(
		settings
			.getByRole('region', { name: 'Video moderation', exact: true })
			.getByText(/Clearly artistic adult nudity and adult gore are allowed/),
	).toBeVisible();
	await settings.getByRole('switch', { name: 'Enable video moderation', exact: true }).click();
	await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
	const expected = {
		image: {
			enabled: true,
			level: 'high',
			connectionId: 'evaluation-api',
			model: 'image-judge',
			thinkingMode: 'high',
		},
		video: {
			enabled: false,
			level: 'medium',
			connectionId: 'evaluation-api',
			model: 'image-judge',
			thinkingMode: 'low',
		},
	};
	await expect.poll(async () => (await saved(page)).moderation).toEqual(expected);
	await page.reload();
	await openSettings(page);
	await expectValue(
		settings.getByRole('combobox', { name: 'Image moderation thinking effort' }),
		'high',
	);
	await expectValue(videoThinking, 'low');
	await expect(
		settings.getByRole('switch', { name: 'Enable video moderation', exact: true }),
	).not.toBeChecked();
	await expect(
		settings.getByRole('switch', { name: 'Enable image moderation', exact: true }),
	).toBeChecked();
	await expectValue(
		settings.getByRole('combobox', { name: 'Image moderation level', exact: true }),
		'high',
	);
	await expectValue(
		settings.getByRole('combobox', { name: 'Video moderation level', exact: true }),
		'medium',
	);
	await page.screenshot({ path: '/tmp/freelm-moderation-settings-configured.png' });
	expect(await page.evaluate(() => (window as any).__moderationTest.requests)).toBe(0);
});

test('Moderation keeps 30px themed controls and readable grouped rows at wide and narrow sizes', async ({
	page,
}) => {
	await fixture(page);
	const settings = await openSettings(page);
	const level = settings.getByRole('combobox', { name: 'Image moderation level', exact: true });
	for (const width of [1440, 390]) {
		await page.setViewportSize({ width, height: 940 });
		await expect(level).toHaveCSS('height', '30px');
		await expect(level).toHaveCSS('font-size', '13px');
		const content = settings.locator('.moderation-settings');
		expect(
			await content
				.locator('.settings-row-label')
				.evaluateAll((labels) =>
					labels.every((label) => parseFloat(getComputedStyle(label).fontSize) >= 13),
				),
		).toBe(true);
		await level.click();
		const popup = page.getByRole('listbox');
		await expect(popup).toBeVisible();
		const bounds = (await popup.boundingBox())!;
		expect(bounds.x).toBeGreaterThanOrEqual(7);
		expect(bounds.x + bounds.width).toBeLessThanOrEqual(width - 7);
		await level.press('Escape');
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
			true,
		);
		await page.screenshot({ path: `/tmp/freelm-moderation-settings-${width}.png` });
	}
	await level.focus();
	await level.press('End');
	await level.press('Enter');
	await expectValue(level, 'high');
	await expect(settings.getByText(/including artistic nudity/)).toBeVisible();
});

test('Older remote hosts disable Moderation without adding settings to their saved profile', async ({
	page,
}) => {
	await fixture(page, true);
	await openRemoteSettings(page);
	await page
		.getByRole('region', { name: 'Remote FreeLM workspaces' })
		.getByRole('button', { name: 'Open', exact: true })
		.click();
	const settings = await openSettings(page);
	await expect(
		settings.getByText('Update the remote FreeLM instance to configure moderation.', {
			exact: true,
		}),
	).toBeVisible();
	const content = settings.locator('.moderation-settings');
	for (const control of await content.getByRole('combobox').all())
		await expect(control).toBeDisabled();
	for (const kind of ['image', 'video'])
		await expect(
			content.getByRole('switch', { name: `Enable ${kind} moderation`, exact: true }),
		).toBeDisabled();
	await settings.getByRole('button', { name: 'Chat', exact: true }).click();
	await settings.getByRole('switch', { name: 'Background notifications', exact: true }).click();
	await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
	await expect.poll(async () => (await saved(page)).backgroundNotifications).toBe(true);
	expect((await saved(page)).moderation).toBeUndefined();
	expect(await page.evaluate(() => (window as any).__moderationTest.requests)).toBe(0);
});

test('Legacy global moderation normalizes in the settings draft and saves independent policies', async ({
	page,
}) => {
	const legacy: ModerationSettingsInput = {
		enabled: false,
		level: 'medium',
		image: { connectionId: 'evaluation-api', model: 'image-judge', thinkingMode: 'high' },
		video: { connectionId: '', model: '', videoApi: 'chat/completions' },
	};
	await fixture(page, false, legacy);
	const settings = await openSettings(page);
	for (const kind of ['Image', 'Video']) {
		await expect(
			settings.getByRole('switch', {
				name: `Enable ${kind.toLowerCase()} moderation`,
				exact: true,
			}),
		).not.toBeChecked();
		await expectValue(
			settings.getByRole('combobox', { name: `${kind} moderation level`, exact: true }),
			'medium',
		);
	}
	await expect(settings.locator('.moderation-configuration-warning')).toHaveCount(0);
	expect((await saved(page)).moderation).toEqual(legacy);
	await settings.getByRole('switch', { name: 'Enable image moderation', exact: true }).click();
	await chooseOption(
		page,
		settings.getByRole('combobox', { name: 'Image moderation level', exact: true }),
		'high',
	);
	await expect(
		settings.getByRole('switch', { name: 'Enable video moderation', exact: true }),
	).not.toBeChecked();
	await expectValue(
		settings.getByRole('combobox', { name: 'Video moderation level', exact: true }),
		'medium',
	);
	await expect(settings.locator('.moderation-configuration-warning')).toHaveCount(0);
	await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
	await expect
		.poll(async () => (await saved(page)).moderation)
		.toEqual({
			image: {
				enabled: true,
				level: 'high',
				connectionId: 'evaluation-api',
				model: 'image-judge',
				thinkingMode: 'high',
			},
			video: {
				enabled: false,
				level: 'medium',
				connectionId: '',
				model: '',
				videoApi: 'chat/completions',
			},
		});
	expect(await page.evaluate(() => (window as any).__moderationTest.requests)).toBe(0);
});

test('Unconfigured image moderation allows a benign request and preserves its viewer warning after setup changes', async ({
	page,
}) => {
	await fixture(page);
	await page.evaluate(() => {
		(window as any).__moderationTest.allowImageGeneration = true;
	});
	await page.getByRole('button', { name: 'Images', exact: true }).click();
	const playground = page.getByRole('region', { name: 'Images playground', exact: true });
	await expect(playground).toBeVisible();
	await expect(
		playground.getByRole('status', { name: 'Moderation warning', exact: true }),
	).toContainText('Image moderation is enabled');
	const prompt = 'A plain blue square.';
	await playground.getByRole('textbox', { name: 'Generation prompt', exact: true }).fill(prompt);
	await expect(
		playground.getByRole('button', { name: 'Generate image', exact: true }),
	).toBeEnabled();
	await playground.getByRole('button', { name: 'Generate image', exact: true }).click();
	const viewer = page.getByRole('dialog', { name: 'Image viewer', exact: true });
	await expect(viewer).toBeVisible();
	await expect(viewer.getByRole('status', { name: 'Moderation warning', exact: true })).toHaveText(
		'This image was generated without moderation because its evaluator was not configured.',
	);
	await expect
		.poll(async () => (await saved(page)).generations[0]?.moderationWarnings)
		.toEqual([
			'This image was generated without moderation because its evaluator was not configured.',
		]);
	expect(
		await page.evaluate(() =>
			(window as any).__moderationTest.imageRequests.map((request: any) => ({
				path: request.path,
				prompt: request.body.prompt,
				model: request.body.model,
			})),
		),
	).toEqual([{ path: '/images/generations', prompt, model: 'image-maker' }]);
	await viewer.getByRole('button', { name: 'Close image viewer', exact: true }).click();
	const settings = await openSettings(page);
	await chooseOption(
		page,
		settings.getByRole('combobox', { name: 'Image moderation API connection', exact: true }),
		'evaluation-api',
	);
	await chooseOption(
		page,
		settings.getByRole('combobox', { name: 'Image moderation model', exact: true }),
		'image-judge',
	);
	await expect(
		settings.getByRole('status').filter({ hasText: 'Images will be generated without moderation' }),
	).toHaveCount(0);
	await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
	await expect.poll(async () => (await saved(page)).moderation?.image.model).toBe('image-judge');
	await settings.getByRole('button', { name: 'Back to workspace', exact: true }).click();
	await expect(playground).toBeVisible();
	await expect(
		playground.getByRole('status', { name: 'Moderation warning', exact: true }),
	).toHaveCount(0);
	await playground.getByRole('button', { name: `Open ${prompt}`, exact: true }).click();
	await expect(viewer).toBeVisible();
	await expect(viewer.getByRole('status', { name: 'Moderation warning', exact: true })).toHaveText(
		'This image was generated without moderation because its evaluator was not configured.',
	);
	await page.screenshot({ path: '/tmp/freelm-independent-moderation-image-warning.png' });
	expect(await page.evaluate(() => (window as any).__moderationTest.requests)).toBe(1);
});

test('Video moderation follows the connection API even when legacy video transport differs', async ({
	page,
}) => {
	await fixture(
		page,
		false,
		{
			image: { enabled: false, level: 'low', connectionId: '', model: '' },
			video: {
				enabled: true,
				level: 'high',
				connectionId: 'evaluation-api',
				model: 'image-judge',
				videoApi: 'chat/completions',
			},
		},
		'responses',
	);
	const settings = await openSettings(page);
	const videoThinking = settings.getByRole('combobox', {
		name: 'Video moderation thinking effort',
	});
	await expectValue(videoThinking, 'deep');
	await videoThinking.click();
	await expect(page.getByRole('option')).toHaveText(['Deep']);
	await page.getByRole('option', { name: 'Deep', exact: true }).click();
	await expect(settings.locator('.moderation-configuration-warning')).toHaveCount(0);
	await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
	await expect
		.poll(async () => (await saved(page)).moderation?.video)
		.toMatchObject({ model: 'image-judge', thinkingMode: 'deep' });
});
