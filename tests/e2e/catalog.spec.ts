import { selectConversationMode } from './helpers/conversation-mode';
import { expect, test, type Page, type Request } from '@playwright/test';
import { chooseOption, expectValue, openRemoteSettings } from './ui-controls';
import type { AppState, ModelDefinition } from '../../src/types';

const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6pAAAAABJRU5ErkJggg==',
	'base64',
);
const definitions: ModelDefinition[] = [
	{
		id: 'chat-vision',
		name: 'Everyday Vision',
		enabled: true,
		tasks: ['chat'],
		inputModalities: ['text', 'image'],
		outputModalities: ['text'],
		thinkingModes: [
			{
				id: 'quick',
				name: 'Quick',
				parameters: {
					responses: { reasoning: { effort: 'low' } },
					chat: { reasoning_effort: 'low' },
				},
			},
			{
				id: 'deep',
				name: 'Deep thought',
				parameters: {
					responses: { reasoning: { effort: 'high' } },
					chat: { reasoning_effort: 'high', enable_thinking: true },
				},
			},
		],
		defaultThinkingMode: 'quick',
	},
	{
		id: 'chat-text',
		name: 'Text only',
		enabled: true,
		tasks: ['chat'],
		inputModalities: ['text'],
		outputModalities: ['text'],
		thinkingModes: [
			{
				id: 'quick',
				name: 'Quick',
				parameters: {
					responses: { reasoning: { effort: 'low' } },
					chat: { reasoning_effort: 'low' },
				},
			},
		],
	},
	{
		id: 'image-create',
		name: 'Illustrator',
		enabled: true,
		tasks: ['images'],
		inputModalities: ['text'],
		outputModalities: ['image'],
		thinkingModes: [],
	},
	{
		id: 'image-edit',
		name: 'Image editor',
		enabled: true,
		tasks: ['images'],
		inputModalities: ['text', 'image'],
		outputModalities: ['image'],
		thinkingModes: [],
	},
	{
		id: 'image-disabled',
		name: 'Retired image model',
		enabled: false,
		tasks: ['images'],
		inputModalities: ['text', 'image'],
		outputModalities: ['image'],
		thinkingModes: [],
	},
	{
		id: 'video-create',
		name: 'Cinema',
		enabled: true,
		tasks: ['videos'],
		inputModalities: ['text', 'image'],
		outputModalities: ['video'],
		thinkingModes: [],
	},
	{
		id: 'voice-create',
		name: 'Narrator',
		enabled: true,
		tasks: ['speech'],
		inputModalities: ['text'],
		outputModalities: ['audio'],
		thinkingModes: [],
	},
	{
		id: 'audio-transcribe',
		name: 'Transcriber',
		enabled: true,
		tasks: ['transcription'],
		inputModalities: ['audio'],
		outputModalities: ['text'],
		thinkingModes: [],
	},
];

function makeState(): AppState {
	return {
		version: 1,
		theme: 'dark',
		activeConnectionId: 'catalog-provider',
		threads: [],
		projects: [],
		generations: [],
		connections: [
			{
				id: 'catalog-provider',
				name: 'Catalog provider',
				baseUrl: 'http://localhost:8000/v1',
				apiKey: '',
				chatApi: 'responses',
				models: {
					chat: 'chat-vision',
					images: 'image-disabled',
					videos: 'video-create',
					speech: 'voice-create',
					transcription: 'audio-transcribe',
				},
				discoveredModels: [...definitions.map((entry) => entry.id), 'provider-unknown'],
				catalog: definitions,
			},
		],
	};
}

async function persistedState(page: Page): Promise<AppState> {
	return page.evaluate(async () => {
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const open = indexedDB.open('freelm-workspace', 1);
			open.onsuccess = () => resolve(open.result);
			open.onerror = () => reject(open.error);
		});
		try {
			return await new Promise<AppState>((resolve, reject) => {
				const request = db.transaction('state', 'readonly').objectStore('state').get('workspace');
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
		} finally {
			db.close();
		}
	});
}

async function seedCatalog(page: Page, state = makeState()) {
	await page.goto('/');
	await expect(page).toHaveTitle('FreeLM');
	await expect(page.getByRole('heading', { name: 'What’s on your mind?' })).toBeVisible({
		timeout: 15_000,
	});
	await expect.poll(async () => (await persistedState(page))?.version).toBe(1);
	await page.evaluate(async (workspace) => {
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const open = indexedDB.open('freelm-workspace', 1);
			open.onsuccess = () => resolve(open.result);
			open.onerror = () => reject(open.error);
		});
		try {
			await new Promise<void>((resolve, reject) => {
				const tx = db.transaction('state', 'readwrite');
				tx.objectStore('state').put(JSON.parse(workspace), 'workspace');
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
			});
		} finally {
			db.close();
		}
	}, JSON.stringify(state));
	await page.reload();
	await expect(page.getByRole('heading', { name: 'What’s on your mind?' })).toBeVisible({
		timeout: 15_000,
	});
}

async function mockProvider(page: Page) {
	const requests: Request[] = [];
	await page.route('http://localhost:8000/v1/**', async (route) => {
		const headers = {
			'access-control-allow-origin': '*',
			'access-control-allow-headers': '*',
			'access-control-allow-methods': '*',
		};
		if (route.request().method() === 'OPTIONS') {
			await route.fulfill({ status: 204, headers });
			return;
		}
		const path = new URL(route.request().url()).pathname;
		if (
			path.endsWith('/responses') ||
			path.endsWith('/chat/completions') ||
			path.endsWith('/chat')
		) {
			const payload = route.request().postDataJSON();
			const instructions =
				payload.instructions ||
				payload.messages?.find((message: { role: string }) => message.role === 'system')?.content;
			if (instructions?.startsWith('Write a short conversation title')) {
				await route.fulfill({
					contentType: 'application/json',
					headers,
					body: JSON.stringify(
						path.endsWith('/responses')
							? { output_text: '' }
							: { choices: [{ message: { content: '' } }] },
					),
				});
				return;
			}
		}
		requests.push(route.request());
		if (path.includes('/images/')) {
			await route.fulfill({
				contentType: 'application/json',
				headers,
				body: JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }),
			});
		} else if (path.endsWith('/audio/speech')) {
			await route.fulfill({ contentType: 'audio/pcm', headers, body: Buffer.alloc(320) });
		} else if (path.endsWith('/audio/transcriptions')) {
			await route.fulfill({
				contentType: 'application/json',
				headers,
				body: JSON.stringify({ text: 'Catalog transcription complete.' }),
			});
		} else {
			const body = path.endsWith('/responses')
				? `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Catalog answer.' })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { output_text: 'Catalog answer.' } })}\n\n`
				: `data: ${JSON.stringify({ choices: [{ delta: { content: 'Catalog answer.' } }] })}\n\ndata: [DONE]\n\n`;
			await route.fulfill({ contentType: 'text/event-stream', headers, body });
		}
	});
	return requests;
}

test('image playground filters model choices, blocks unsupported references, and keeps manual model IDs', async ({
	page,
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	const requests = await mockProvider(page);
	await seedCatalog(page);
	await page.getByRole('button', { name: 'Images', exact: true }).click();
	const choose = async (id: string) => {
		await page.getByRole('button', { name: 'Image model', exact: true }).click();
		const picker = page.getByRole('dialog', { name: 'Choose a model', exact: true });
		await expect(picker).toBeVisible();
		const known = picker.locator(`[role="option"][data-value=${JSON.stringify(id)}]`);
		if (await known.count()) {
			await known.click();
			return;
		}
		await picker.getByRole('button', { name: 'Use a model ID…' }).click();
		await picker.getByRole('combobox', { name: 'Search models' }).fill(id);
		await picker.getByRole('option').first().click();
	};
	await expect(page.getByRole('button', { name: 'Image model', exact: true })).toContainText(
		'Illustrator',
	);
	await page.getByRole('button', { name: 'Image model', exact: true }).click();
	const picker = page.getByRole('dialog', { name: 'Choose a model', exact: true });
	await expect(picker.getByRole('option')).toHaveCount(3);
	await expect(picker.getByRole('option').filter({ hasText: 'chat-vision' })).toHaveCount(0);
	await expect(picker.getByRole('option').filter({ hasText: 'image-disabled' })).toHaveCount(0);
	await page.keyboard.press('Escape');
	await expect(picker).toBeHidden();
	await expect(
		page.getByRole('button', { name: 'Add reference images', exact: true }),
	).toBeDisabled();
	await choose('image-edit');
	await page
		.locator('.image-upload-input')
		.setInputFiles({ name: 'reference.png', mimeType: 'image/png', buffer: PNG });
	await page.getByLabel('Generation prompt').fill('A blue glass sculpture');
	await choose('image-create');
	expect(requests, 'Opening and choosing a model must not submit the image composer').toHaveLength(
		0,
	);
	await expect(page.getByRole('alert')).toContainText(/image/i);
	await expect(page.getByRole('button', { name: 'Edit image', exact: true })).toBeDisabled();
	await page.getByLabel('Generation prompt').press('Control+Enter');
	expect(requests).toHaveLength(0);
	await page.screenshot({ path: '/tmp/freelm-catalog-media.png' });
	await choose('image-edit');
	await page.getByRole('button', { name: 'Edit image', exact: true }).click();
	await expect(page.locator('.image-gallery-image')).toHaveCount(1);
	expect(requests[0].url()).toContain('/images/edits');
	expect(requests[0].postData()).toContain('image-edit');
	await page.getByRole('button', { name: 'Close image viewer', exact: true }).click();
	await page.getByRole('button', { name: 'Image model', exact: true }).click();
	await picker.getByRole('button', { name: 'Use a model ID…' }).click();
	await picker.getByRole('combobox', { name: 'Search models' }).fill('image-disabled');
	await expect(picker.getByRole('option')).toHaveCount(0);
	await expect(picker).toContainText('disabled');
	await page.keyboard.press('Escape');
	await page.keyboard.press('Escape');
	await choose('my-unlisted-image');
	await page
		.locator('.image-upload-input')
		.setInputFiles({ name: 'reference.png', mimeType: 'image/png', buffer: PNG });
	await page.getByLabel('Generation prompt').fill('An unlisted model edit');
	await expect(page.getByRole('button', { name: 'Edit image', exact: true })).toBeEnabled();
	await page.getByRole('button', { name: 'Edit image', exact: true }).click();
	await expect.poll(() => requests.length).toBe(2);
	await expect(page.locator('.image-gallery-image')).toHaveCount(2);
	expect(requests[1].postData()).toContain('my-unlisted-image');
	expect(errors).toEqual([]);
});

test('audio and video playgrounds use task capabilities and block unsupported transcription context', async ({
	page,
}) => {
	const requests = await mockProvider(page);
	await seedCatalog(page);
	await page.getByRole('button', { name: 'Video', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Video model', exact: true })).toContainText(
		'Cinema',
	);
	await page.getByRole('button', { name: 'Video model', exact: true }).click();
	await expect(page.getByRole('option')).toHaveCount(2);
	await page.keyboard.press('Escape');
	await page.getByRole('button', { name: 'Video settings', exact: true }).click();
	await expect(page.getByLabel('Model capabilities')).toContainText('Cinema');
	await page.getByRole('button', { name: 'Close video settings', exact: true }).click();
	await page.getByRole('button', { name: 'Audio', exact: true }).click();
	await expect(page.getByLabel('Model', { exact: true })).toHaveValue('voice-create');
	await expect(page.locator('#media-models-speech option')).toHaveCount(2);
	await expect(page.getByLabel('Model capabilities')).toContainText('Narrator');
	await page.getByLabel('Text to speak').fill('One thoughtful sentence.');
	await page.getByLabel('Model', { exact: true }).fill('audio-transcribe');
	await expect(page.getByRole('button', { name: 'Generate speech', exact: true })).toBeDisabled();
	await page.getByLabel('Model', { exact: true }).fill('voice-create');
	await page.getByRole('button', { name: 'Generate speech', exact: true }).click();
	await expect(page.getByText('Your PCM audio is ready.')).toBeVisible();
	expect(requests[0].postDataJSON().model).toBe('voice-create');
	await page.getByRole('tab', { name: 'Transcription', exact: true }).click();
	await expect(page.locator('#media-models-transcription option')).toHaveCount(2);
	await page
		.locator('.media-workspace input[type="file"]')
		.first()
		.setInputFiles({ name: 'recording.wav', mimeType: 'audio/wav', buffer: Buffer.alloc(44) });
	await page.getByLabel('Transcription context').fill('A vocabulary hint');
	await expect(page.locator('.media-capability-error')).toContainText(/text/i);
	await expect(page.getByRole('button', { name: 'Transcribe', exact: true })).toBeDisabled();
	await page.getByLabel('Transcription context').fill('');
	await page.getByRole('button', { name: 'Transcribe', exact: true }).click();
	await expect(page.locator('.media-transcript')).toContainText('Catalog transcription complete.');
	expect(requests[1].postData()).toContain('audio-transcribe');
});

test('configuration lists discovered and default IDs, searches names, and preserves custom metadata through discovery', async ({
	page,
}) => {
	const state = makeState();
	state.connections[0].models.chat = 'manual-default';
	state.connections[0].discoveredModels = ['provider-unknown'];
	await seedCatalog(page, state);
	await page.route('http://localhost:8000/v1/models', (route) =>
		route.fulfill({
			contentType: 'application/json',
			headers: { 'access-control-allow-origin': '*' },
			body: JSON.stringify({ data: [{ id: 'chat-vision' }, { id: 'fresh-model' }] }),
		}),
	);
	await page.getByRole('button', { name: /Personal workspace/ }).click();
	const settings = page.getByRole('region', { name: 'Settings', exact: true });
	await expect(
		settings.getByRole('button', { name: 'Configure model provider-unknown' }),
	).toBeVisible();
	await expect(
		settings.getByRole('button', { name: 'Configure model manual-default' }),
	).toBeVisible();
	await expect(settings.getByRole('button', { name: 'Edit model Everyday Vision' })).toBeVisible();
	await settings.getByLabel('Search models', { exact: true }).fill('vision');
	await expect(settings.locator('.catalog-entry')).toHaveCount(1);
	await expect(settings.locator('.catalog-entry')).toContainText('Everyday Vision');
	await settings.getByLabel('Search models', { exact: true }).clear();
	await settings.getByRole('button', { name: 'Discover models', exact: true }).click();
	await expect(settings.getByRole('button', { name: 'Configure model fresh-model' })).toBeVisible();
	await expect(
		settings.getByRole('button', { name: 'Configure model provider-unknown' }),
	).toBeHidden();
	await expect(
		settings.getByRole('button', { name: 'Configure model manual-default' }),
	).toBeVisible();
	await settings.getByRole('button', { name: 'Configure model fresh-model' }).click();
	const editor = settings.getByRole('group', { name: 'New catalog model' });
	await editor.getByRole('button', { name: 'Add thinking value High', exact: true }).click();
	await chooseOption(page, editor.getByLabel('Default thinking mode'), 'high');
	await editor.getByRole('button', { name: 'Apply model', exact: true }).click();
	await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
	await expect
		.poll(async () => (await persistedState(page)).connections[0].catalog?.length)
		.toBe(definitions.length + 1);
	const saved = (await persistedState(page)).connections[0];
	expect(saved.catalog?.slice(0, definitions.length)).toEqual(definitions);
	expect(saved.models.chat).toBe('manual-default');
	expect(saved.discoveredModels).toEqual(['chat-vision', 'fresh-model']);
	expect(saved.catalog?.at(-1)?.thinkingModes).toEqual([
		{
			id: 'high',
			name: 'High',
			parameters: {
				responses: { reasoning: { effort: 'high' } },
				chat: { reasoning_effort: 'high' },
			},
		},
	]);
});

test('settings creates a catalog model with custom thinking parameters and persists it', async ({
	page,
}) => {
	const state = makeState();
	state.connections[0].catalog = [];
	await seedCatalog(page, state);
	await page.getByRole('button', { name: /Personal workspace/ }).click();
	const settings = page.getByRole('region', { name: 'Settings', exact: true });
	await settings.getByRole('button', { name: 'Add model', exact: true }).click();
	const editor = settings.getByRole('group', { name: 'New catalog model' });
	await editor.getByLabel('Display name').fill('My thoughtful model');
	await editor.getByLabel('API model ID').fill('provider/thoughtful');
	await editor.getByLabel('Available in: Chat', { exact: true }).check();
	await editor.getByLabel('Input modalities: text', { exact: true }).check();
	await editor.getByLabel('Input modalities: image', { exact: true }).check();
	await editor.getByLabel('Output modalities: text', { exact: true }).check();
	await editor.getByRole('button', { name: 'Add thinking mode', exact: true }).click();
	await editor.getByLabel('Thinking mode 1 name').fill('Deliberate');
	await editor.getByLabel('Thinking mode 1 ID').fill('deliberate');
	await editor.getByText('Request parameters', { exact: true }).click();
	await editor.getByLabel('Thinking mode 1 Responses JSON').fill('{"model":"do-not-override"}');
	await editor
		.getByLabel('Thinking mode 1 Chat JSON')
		.fill('{"reasoning_effort":"high","enable_thinking":true}');
	await editor.getByRole('button', { name: 'Apply model', exact: true }).click();
	await expect(settings.getByRole('alert')).toContainText('cannot override');
	await settings.getByRole('button', { name: 'Save settings' }).click();
	await expect(
		settings.getByText(
			'Apply or cancel the model or thinking option being edited before saving settings.',
		),
	).toBeVisible();
	await expect(editor).toBeVisible();
	await editor
		.getByLabel('Thinking mode 1 Responses JSON')
		.fill('{"reasoning":{"effort":"high","summary":"auto"}}');
	await chooseOption(page, editor.getByLabel('Default thinking mode'), 'deliberate');
	await editor.getByLabel('Use as default for: Chat', { exact: true }).check();
	await editor.getByRole('button', { name: 'Apply model', exact: true }).click();
	await expect(editor).toBeHidden();
	await settings.getByRole('button', { name: 'Save settings' }).click();
	await settings.getByRole('button', { name: 'Back to workspace' }).click();
	await expect(settings).toBeHidden();
	await expect
		.poll(async () => (await persistedState(page)).connections[0].catalog?.[0]?.id)
		.toBe('provider/thoughtful');
	const saved = (await persistedState(page)).connections[0].catalog![0];
	expect(saved).toMatchObject({
		name: 'My thoughtful model',
		tasks: ['chat'],
		inputModalities: ['text', 'image'],
		outputModalities: ['text'],
		defaultThinkingMode: 'deliberate',
	});
	expect(saved.thinkingModes[0].parameters).toEqual({
		responses: { reasoning: { effort: 'high', summary: 'auto' } },
		chat: { reasoning_effort: 'high', enable_thinking: true },
	});
	await page.reload();
	await expect(page.getByRole('button', { name: 'Chat model', exact: true })).toContainText(
		'My thoughtful model',
	);
	await page.getByRole('button', { name: /Personal workspace/ }).click();
	await settings.getByRole('button', { name: 'Edit model My thoughtful model' }).click();
	await expectValue(settings.getByLabel('Default thinking mode'), 'deliberate');
	await settings.getByText('Request parameters', { exact: true }).click();
	await expect(settings.getByLabel('Thinking mode 1 Chat JSON')).toHaveValue(/enable_thinking/);
	await page.screenshot({ path: '/tmp/freelm-catalog-settings.png' });
	await page.setViewportSize({ width: 720, height: 900 });
	await settings.getByLabel('Display name').scrollIntoViewIfNeeded();
	await page.screenshot({ path: '/tmp/freelm-catalog-settings-narrow.png' });
});

test('only the context window is model-level and survives validation, saving and reload', async ({
	page,
}) => {
	// Browser plugin not available; use the repository's Playwright workflow.
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await seedCatalog(page);
	await page.getByRole('button', { name: /Personal workspace/ }).click();
	const settings = page.getByRole('region', { name: 'Settings', exact: true });
	await settings.getByRole('button', { name: 'Edit model Everyday Vision' }).click();
	const context = settings.locator('.catalog-context');
	await expect(context).toContainText('Shared by Chat and Code');
	await expect(context).toContainText('Settings → Code');
	await expect(context.locator('output')).toContainText('128,000 tokens');
	await expect(context.getByRole('spinbutton')).toHaveCount(1);
	await expect(context.getByLabel('Compact at (%)', { exact: true })).toHaveCount(0);
	await expect(context.getByLabel('Minimum remaining tokens', { exact: true })).toHaveCount(0);
	await context.getByLabel('Context window (tokens)', { exact: true }).fill('256000');
	await settings.getByRole('button', { name: 'Apply model', exact: true }).click();
	// The catalog overview stays compact; context details live in its editor.
	await expect(settings.locator('.catalog-context-summary')).toHaveCount(0);
	await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
	await expect
		.poll(async () => (await persistedState(page)).connections[0].catalog?.[0]?.contextWindow)
		.toBe(256_000);
	await page.reload();
	await page.getByRole('button', { name: /Personal workspace/ }).click();
	await settings.getByRole('button', { name: 'Edit model Everyday Vision' }).click();
	await expect(context.getByLabel('Context window (tokens)', { exact: true })).toHaveValue(
		'256000',
	);
	await context.getByLabel('Context window (tokens)', { exact: true }).fill('0');
	await settings.getByRole('button', { name: 'Apply model', exact: true }).click();
	await expect(settings.getByRole('alert')).toContainText('positive whole number');
	await context.getByLabel('Context window (tokens)', { exact: true }).fill('32000');
	await page.setViewportSize({ width: 720, height: 900 });
	await context.scrollIntoViewIfNeeded();
	await page.screenshot({ path: '/tmp/freelm-model-context-only-narrow.png' });
	expect(await context.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
		true,
	);
	await settings.getByRole('button', { name: 'Apply model', exact: true }).click();
	await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
	const saved = (await persistedState(page)).connections[0].catalog![0];
	expect(saved.contextWindow).toBe(32_000);
	expect(saved).not.toHaveProperty('compactionThresholdPercent');
	expect(saved).not.toHaveProperty('compactionReserveTokens');
	await settings.getByRole('button', { name: 'Edit model Illustrator' }).click();
	await expect(context).toHaveCount(0);
	expect(errors).toEqual([]);
});

test('global Code compaction settings validate, preview model limits, persist and fit narrow settings', async ({
	page,
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (message) => {
		if (message.type() === 'error') errors.push(message.text());
	});
	await seedCatalog(page);
	await page.getByRole('button', { name: /Personal workspace/ }).click();
	const settings = page.getByRole('region', { name: 'Settings', exact: true });
	await settings.getByRole('button', { name: 'Code', exact: true }).click();
	const code = settings.getByRole('region', { name: 'Context compaction', exact: true });
	await expect(code.getByLabel('Compact at (%)', { exact: true })).toHaveValue('90');
	await expect(code.getByLabel('Minimum remaining tokens', { exact: true })).toHaveValue('32000');
	await expect(code).toContainText('Apply these settings to all Code models');
	await expect(code).toContainText('Chat uses FreeLM’s automatic compaction defaults');
	await code.getByLabel('Compact at (%)', { exact: true }).fill('100');
	await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
	await expect(settings.getByRole('alert')).toContainText('from 1 to 99');
	await code.getByLabel('Compact at (%)', { exact: true }).fill('50');
	await code.getByLabel('Minimum remaining tokens', { exact: true }).fill('-1');
	await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
	await expect(settings.getByRole('alert')).toContainText('nonnegative whole number');
	await code.getByLabel('Minimum remaining tokens', { exact: true }).fill('13000');
	await settings.getByRole('button', { name: 'Configuration', exact: true }).click();
	await settings.getByRole('button', { name: 'Edit model Everyday Vision' }).click();
	await settings.getByLabel('Context window (tokens)', { exact: true }).fill('20000');
	await settings.getByRole('button', { name: 'Apply model', exact: true }).click();
	await settings.getByRole('button', { name: 'Code', exact: true }).click();
	await expect(code.locator('output')).toContainText('compact at 7,000 of 20,000 tokens used');
	await page.screenshot({ path: '/tmp/freelm-global-code-compaction-wide.png' });
	await page.setViewportSize({ width: 720, height: 900 });
	await code.scrollIntoViewIfNeeded();
	await page.screenshot({ path: '/tmp/freelm-global-code-compaction-narrow.png' });
	expect(await code.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
		true,
	);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
		true,
	);
	await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
	await expect
		.poll(async () => (await persistedState(page)).codeCompaction)
		.toEqual({
			thresholdPercent: 50,
			reserveTokens: 13_000,
		});
	await page.reload();
	await page.getByRole('button', { name: /Personal workspace/ }).click();
	await settings.getByRole('button', { name: 'Code', exact: true }).click();
	await expect(code.getByLabel('Compact at (%)', { exact: true })).toHaveValue('50');
	await expect(code.getByLabel('Minimum remaining tokens', { exact: true })).toHaveValue('13000');
	await expect(code.locator('output')).toContainText('7,000 of 20,000');
	await code.getByLabel('Minimum remaining tokens', { exact: true }).fill('32000');
	await expect(code.locator('output')).toContainText('10,000 of 20,000');
	await expect(code.locator('output')).toContainText('smaller reserve of 5,000 tokens');
	await code.getByLabel('Minimum remaining tokens', { exact: true }).fill('0');
	await expect(code.locator('output')).toContainText('10,000 of 20,000');
	await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
	await expect.poll(async () => (await persistedState(page)).codeCompaction?.reserveTokens).toBe(0);
	expect(errors).toEqual([]);
});

test('older remote hosts lock Code compaction and preserve legacy model settings when saving appearance', async ({
	page,
}) => {
	const state = structuredClone(makeState());
	(
		state.connections[0].catalog![0] as ModelDefinition & Record<string, unknown>
	).compactionThresholdPercent = 80;
	(
		state.connections[0].catalog![0] as ModelDefinition & Record<string, unknown>
	).compactionReserveTokens = 16000;
	await page.addInitScript((serialized) => {
		const initial = JSON.parse(serialized);
		const control = {
			states: { local: structuredClone(initial), remote: structuredClone(initial) },
			saves: [] as string[],
		};
		let revision = 0;
		(window as any).__legacyCompaction = control;
		const snapshot = (id: 'local' | 'remote') => ({
			state: structuredClone(control.states[id]),
			revision: String(revision),
			...(id === 'remote' ? { codeCompactionSupported: false } : {}),
		});
		(window as any).desktop = {
			platform: 'linux',
			workspaceLoad: async (id: 'local' | 'remote') => snapshot(id),
			workspaceSave: async (id: 'local' | 'remote', _revision: string, next: AppState) => {
				if (
					id === 'remote' &&
					(next.codeCompaction ||
						(next.connections[0].catalog?.[0] as ModelDefinition & Record<string, unknown>)
							.compactionThresholdPercent !== 80)
				)
					throw new Error('Legacy host settings were changed unexpectedly.');
				control.states[id] = structuredClone(next);
				control.saves.push(id);
				return { revision: String(++revision) };
			},
			storageInfo: async () => ({ secure: false, location: 'Private legacy-host fixture' }),
			onPrepareClose: () => () => {},
			onToolApproval: () => () => {},
			instanceStatus: async () => ({
				host: { running: false, name: 'This computer', instanceId: 'local', port: 4319 },
				instances: [
					{
						id: 'remote',
						name: 'Legacy Code host',
						transport: 'direct',
						url: 'http://legacy-code.invalid',
						connected: true,
						hasToken: true,
					},
				],
			}),
			instanceOpen: async () => snapshot('remote'),
			toolInspect: async () => ({ tools: [], skills: [], instructions: '', warnings: [] }),
		};
	}, JSON.stringify(state));
	await page.goto('/');
	await expect(page.getByRole('heading', { name: 'What’s on your mind?' })).toBeVisible();
	await openRemoteSettings(page);
	await page
		.getByRole('region', { name: 'Remote FreeLM workspaces' })
		.getByRole('button', { name: 'Open', exact: true })
		.click();
	await page.getByRole('button', { name: 'Personal workspace settings', exact: true }).click();
	const settings = page.getByRole('region', { name: 'Settings', exact: true });
	await settings.getByRole('button', { name: 'Code', exact: true }).click();
	await expect(
		settings.getByText('Update the remote FreeLM instance to configure Code compaction.', {
			exact: true,
		}),
	).toBeVisible();
	await expect(settings.getByLabel('Compact at (%)', { exact: true })).toBeDisabled();
	await expect(settings.getByLabel('Minimum remaining tokens', { exact: true })).toBeDisabled();
	await settings.getByRole('button', { name: 'Appearance', exact: true }).click();
	await settings.getByRole('radio', { name: 'Light', exact: true }).click();
	await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => (window as any).__legacyCompaction.states.remote.theme))
		.toBe('light');
	const saved = await page.evaluate(() => (window as any).__legacyCompaction.states.remote);
	expect(saved.codeCompaction).toBeUndefined();
	expect(saved.connections[0].catalog[0]).toMatchObject({
		compactionThresholdPercent: 80,
		compactionReserveTokens: 16000,
	});
	await expect(settings.getByRole('alert')).toHaveCount(0);
});

for (const endpoint of ['responses', 'chat/completions', 'chat'] as const) {
	test(`chat catalog selection sends saved thinking parameters for ${endpoint}`, async ({
		page,
	}) => {
		const state = makeState();
		state.connections[0].chatApi = endpoint;
		const requests = await mockProvider(page);
		await seedCatalog(page, state);
		await page.getByRole('button', { name: 'Chat model', exact: true }).click();
		const chooser = page.getByRole('dialog', { name: 'Choose a model' });
		await expect(chooser.getByRole('option', { name: /Illustrator/ })).toHaveCount(0);
		await expect(chooser.getByRole('slider', { name: 'Thinking mode' })).toHaveAttribute(
			'aria-valuetext',
			'Quick',
		);
		await chooser.getByRole('button', { name: 'Deep thought', exact: true }).click();
		await page.screenshot({
			path: `/tmp/freelm-catalog-thinking-${endpoint.replace('/', '-')}.png`,
		});
		await page.keyboard.press('Escape');
		await page.getByLabel('Message', { exact: true }).click();
		await page.getByLabel('Message', { exact: true }).fill('Take a moment to reason');
		await page.getByRole('button', { name: 'Send message' }).click();
		await expect(page.locator('.message.assistant')).toContainText('Catalog answer.');
		expect(requests[0].postDataJSON()).toMatchObject(
			endpoint === 'responses'
				? { model: 'chat-vision', reasoning: { effort: 'high' } }
				: { model: 'chat-vision', reasoning_effort: 'high', enable_thinking: true },
		);
		await expect
			.poll(async () => (await persistedState(page)).threads[0]?.thinkingMode)
			.toBe('deep');
		await page.reload();
		await page.getByRole('button', { name: 'Take a moment to reason', exact: true }).click();
		await page.getByRole('button', { name: 'Chat model', exact: true }).click();
		await expect(chooser.getByRole('slider', { name: 'Thinking mode' })).toHaveAttribute(
			'aria-valuetext',
			'Deep thought',
		);
		await expect(chooser).not.toContainText('Provider default');
		await expect(chooser.getByText('Provider default', { exact: true })).toHaveCount(0);
		await chooser.getByRole('button', { name: 'Quick', exact: true }).click();
		await page.keyboard.press('Escape');
		await expect
			.poll(async () => (await persistedState(page)).threads[0]?.thinkingMode)
			.toBe('quick');
		await page.getByLabel('Message', { exact: true }).click();
		await page.getByLabel('Message', { exact: true }).fill('Use the quick effort now');
		await page.getByRole('button', { name: 'Send message' }).click();
		await expect(page.locator('.message.assistant')).toHaveCount(2);
		await expect(page.locator('.message.assistant').last()).toContainText('Catalog answer.');
		expect(requests[1].postDataJSON()).toMatchObject(
			endpoint === 'responses' ? { reasoning: { effort: 'low' } } : { reasoning_effort: 'low' },
		);
		expect(requests[1].postDataJSON()).not.toHaveProperty('enable_thinking');
	});
}

test('chat attachment checks prevent unsupported image and audio inputs before requests', async ({
	page,
}) => {
	const state = makeState();
	state.connections[0].models.chat = 'chat-text';
	const requests = await mockProvider(page);
	await seedCatalog(page, state);
	await page
		.locator('.composer input[type="file"]')
		.setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: PNG });
	await expect(page.getByRole('alert')).toContainText(/does not support image/i);
	await expect(page.locator('.attachment-preview')).toHaveCount(0);
	await page
		.locator('.composer input[type="file"]')
		.setInputFiles({ name: 'voice.mp3', mimeType: 'audio/mpeg', buffer: Buffer.alloc(32) });
	await expect(page.getByRole('alert')).toContainText(
		'Audio and video chat attachments are not supported yet',
	);
	await expect(page.locator('.attachment-preview')).toHaveCount(0);
	await expect(
		page.getByLabel('Message', { exact: true }).locator('.cm-placeholder'),
	).toBeVisible();
	expect(requests).toHaveLength(0);
});

test('new chats and legacy chats always select and persist a usable thinking value', async ({
	page,
}) => {
	const state = makeState();
	state.connections[0].catalog = structuredClone(definitions);
	const model = state.connections[0].catalog[0];
	model.defaultThinkingMode = undefined;
	model.thinkingModes.unshift({ id: 'empty', name: 'Legacy empty', parameters: { responses: {} } });
	state.threads = [
		{
			id: 'legacy',
			kind: 'chat',
			title: 'Legacy chat',
			connectionId: state.activeConnectionId,
			model: model.id,
			messages: [
				{
					id: 'old',
					role: 'assistant',
					model: model.id,
					content: 'Old response without recorded effort.',
					createdAt: 1,
				},
			],
			createdAt: 1,
			updatedAt: 1,
		},
	];
	const requests = await mockProvider(page);
	await seedCatalog(page, state);
	const picker = page.getByRole('button', { name: 'Chat model', exact: true });
	await expect(picker).toContainText(/Everyday Vision.*Quick/);
	await page.getByRole('button', { name: 'Legacy chat', exact: true }).click();
	await expect(picker).toContainText(/Everyday Vision.*Quick/);
	await page.getByLabel('Message', { exact: true }).fill('Continue with an explicit effort');
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	await expect(page.locator('.message.assistant').last()).toContainText('Catalog answer.');
	expect(requests[0].postDataJSON()).toMatchObject({ reasoning: { effort: 'low' } });
	await expect.poll(async () => (await persistedState(page)).threads[0].thinkingMode).toBe('quick');
	const saved = (await persistedState(page)).threads[0];
	expect(saved.messages[0].thinkingMode).toBeUndefined();
	expect(saved.messages.at(-1)?.thinkingMode).toBe('quick');
	await picker.click();
	const chooser = page.getByRole('dialog', { name: 'Choose a model' });
	await chooser.getByRole('button', { name: 'Deep thought', exact: true }).click();
	await page.keyboard.press('Escape');
	await page.getByRole('button', { name: 'New chat', exact: true }).click();
	await expect(picker).toContainText(/Everyday Vision.*Quick/);
	await selectConversationMode(page, 'Code');
	await expect(picker).toContainText(/Everyday Vision.*Quick/);
});

test('unconfigured thinking blocks chat and settings requires a concrete value', async ({
	page,
}) => {
	const state = makeState();
	state.connections[0].models.chat = 'chat-text';
	state.connections[0].catalog = structuredClone(definitions);
	state.connections[0].catalog.find((model) => model.id === 'chat-text')!.thinkingModes = [];
	const requests = await mockProvider(page);
	await seedCatalog(page, state);
	await page.getByLabel('Message', { exact: true }).fill('Do not send without a thinking value');
	await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
	await expect(page.getByRole('alert')).toContainText('Configure a thinking value');
	await page.getByRole('button', { name: 'Chat model', exact: true }).click();
	const chooser = page.getByRole('dialog', { name: 'Choose a model' });
	await expect(chooser.getByRole('slider', { name: 'Thinking mode' })).toHaveCount(0);
	await expect(chooser.getByRole('button', { name: 'Configure thinking values' })).toBeVisible();
	await expect(chooser.getByText('Provider default', { exact: true })).toHaveCount(0);
	await page.keyboard.press('Escape');
	expect(requests).toHaveLength(0);
	await page.getByRole('button', { name: /Personal workspace/ }).click();
	const settings = page.getByRole('region', { name: 'Settings', exact: true });
	await settings.getByRole('button', { name: 'Edit model Text only', exact: true }).click();
	await settings.getByRole('button', { name: 'Apply model', exact: true }).click();
	await expect(settings.getByRole('alert')).toContainText('Configure at least one thinking value');
	await settings.getByRole('button', { name: 'Add thinking mode', exact: true }).click();
	await settings.getByLabel('Thinking mode 1 name').fill('Explicit off');
	await settings.getByLabel('Thinking mode 1 ID').fill('off');
	await settings.getByText('Request parameters', { exact: true }).click();
	await settings.getByLabel('Thinking mode 1 Responses JSON').fill('{}');
	await settings.getByRole('button', { name: 'Apply model', exact: true }).click();
	await expect(settings.getByRole('alert')).toContainText('must specify a thinking value');
	await settings.getByLabel('Thinking mode 1 Responses JSON').fill('{"enable_thinking":false}');
	await expectValue(settings.getByLabel('Default thinking mode'), 'off');
	await expect(
		settings.getByLabel('Default thinking mode').locator('option[value=""]'),
	).toHaveCount(0);
	await settings.getByRole('button', { name: 'Apply model', exact: true }).click();
	await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
	await settings.getByRole('button', { name: 'Back to workspace', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Chat model', exact: true })).toContainText(
		/Text only.*Explicit off/,
	);
	await page.getByLabel('Message', { exact: true }).fill('Send with the configured explicit value');
	await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	await expect(page.locator('.message.assistant')).toContainText('Catalog answer.');
	expect(requests[0].postDataJSON()).toMatchObject({ enable_thinking: false });
	await expect
		.poll(
			async () =>
				(await persistedState(page)).connections[0].catalog?.find(
					(model) => model.id === 'chat-text',
				)?.defaultThinkingMode,
		)
		.toBe('off');
});

test('explicit Standard mode stays opt-in, saves, reopens, and omits reasoning parameters', async ({
	page,
}) => {
	test.setTimeout(300_000);
	const state = makeState();
	state.connections[0].models.chat = 'chat-text';
	state.connections[0].catalog = structuredClone(definitions);
	const definition = state.connections[0].catalog.find((model) => model.id === 'chat-text')!;
	definition.thinkingModes = [];
	definition.defaultThinkingMode = undefined;
	const requests = await mockProvider(page);
	await seedCatalog(page, state);
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await page.getByLabel('Message', { exact: true }).fill('Standard mode fixture');
	await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
	await page.getByRole('button', { name: /Personal workspace/ }).click();
	const settings = page.getByRole('region', { name: 'Settings', exact: true });
	await settings.getByRole('button', { name: 'Edit model Text only', exact: true }).click();
	await settings.getByRole('button', { name: 'Add Standard mode', exact: true }).click();
	await expect(settings.getByLabel('Thinking mode 1 use provider defaults')).toBeChecked();
	await settings.getByRole('button', { name: 'Cancel model changes', exact: true }).click();
	await settings.getByRole('button', { name: 'Back to workspace', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
	await page.getByRole('button', { name: /Personal workspace/ }).click();
	await settings.getByRole('button', { name: 'Edit model Text only', exact: true }).click();
	await settings.getByRole('button', { name: 'Add Standard mode', exact: true }).click();
	await settings.getByRole('button', { name: 'Apply model', exact: true }).click();
	await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
	await settings.getByRole('button', { name: 'Back to workspace', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Chat model', exact: true })).toContainText(
		'Standard',
	);
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	await expect(page.locator('.message.assistant')).toContainText('Catalog answer.');
	const body = requests[0].postDataJSON();
	for (const key of ['reasoning', 'reasoning_effort', 'useProviderDefaults'])
		expect(body).not.toHaveProperty(key);
	await expect
		.poll(async () => (await persistedState(page)).threads[0]?.messages.at(-1)?.content)
		.toBe('Catalog answer.');
	await page.reload();
	await expect(page.getByRole('status', { name: 'Loading workspace', exact: true })).toBeHidden({
		timeout: 30_000,
	});
	await expect(page.getByRole('button', { name: 'Chat model', exact: true })).toContainText(
		'Standard',
	);
	await page.getByRole('button', { name: 'Standard mode fixture', exact: true }).click();
	await expect(page.locator('.message.assistant')).toContainText('Catalog answer.');
	await page.screenshot({ path: '/tmp/freelm-standard-mode-chat.png' });
	await page.getByRole('button', { name: /Personal workspace/ }).click();
	await settings.getByRole('button', { name: 'Edit model Text only', exact: true }).click();
	await expect(settings.getByLabel('Thinking mode 1 use provider defaults')).toBeChecked();
	await page.setViewportSize({ width: 720, height: 900 });
	await settings
		.getByRole('button', { name: 'Add Standard mode', exact: true })
		.scrollIntoViewIfNeeded();
	await page.screenshot({ path: '/tmp/freelm-standard-mode-settings-narrow.png' });
	expect(errors).toEqual([]);
});

test('provider-default toggles preserve custom JSON drafts and cancel restores saved parameters', async ({
	page,
}) => {
	test.setTimeout(300_000);
	const mode = {
		id: 'custom',
		name: 'Custom',
		parameters: {
			responses: { reasoning: { effort: 'high' } },
			chat: { reasoning_effort: 'high' },
		},
	};
	const state = makeState();
	state.connections[0].models.chat = 'chat-text';
	state.connections[0].catalog = [
		{
			id: 'chat-text',
			name: 'Toggle fixture',
			enabled: true,
			tasks: ['chat'],
			inputModalities: ['text'],
			outputModalities: ['text'],
			thinkingModes: [mode],
			defaultThinkingMode: 'custom',
		},
	];
	await seedCatalog(page, state);
	await page.getByRole('button', { name: /Personal workspace/ }).click();
	const settings = page.getByRole('region', { name: 'Settings', exact: true });
	await settings.getByRole('button', { name: 'Edit model Toggle fixture', exact: true }).click();
	await settings.getByText('Request parameters', { exact: true }).click();
	const responses = settings.getByLabel('Thinking mode 1 Responses JSON');
	const chat = settings.getByLabel('Thinking mode 1 Chat JSON');
	const toggle = settings.getByLabel('Thinking mode 1 use provider defaults');
	const responseDraft = '{"reasoning":{"effort":"medium"},"custom_budget":256}';
	const chatDraft = '{"reasoning_effort":"low","custom_budget":256}';
	await responses.fill(responseDraft);
	await chat.fill(chatDraft);
	for (let cycle = 0; cycle < 2; cycle++) {
		await toggle.click();
		await expect(toggle).toBeChecked();
		await expect(responses).toBeDisabled();
		await expect(chat).toBeDisabled();
		await toggle.click();
		await expect(responses).toBeEnabled();
		await expect(responses).toHaveValue(responseDraft);
		await expect(chat).toHaveValue(chatDraft);
	}
	await settings.getByRole('button', { name: 'Cancel model changes', exact: true }).click();
	await settings.getByRole('button', { name: 'Edit model Toggle fixture', exact: true }).click();
	await settings.getByText('Request parameters', { exact: true }).click();
	await expect(toggle).not.toBeChecked();
	await expect(responses).toHaveValue(JSON.stringify(mode.parameters.responses, null, 2));
	await expect(chat).toHaveValue(JSON.stringify(mode.parameters.chat, null, 2));
	// Applying defaults omits the preserved draft tuning instead of accidentally sending it.
	await toggle.click();
	await settings.getByRole('button', { name: 'Apply model', exact: true }).click();
	await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
	await expect
		.poll(async () => (await persistedState(page)).connections[0].catalog![0].thinkingModes[0])
		.toEqual({
			id: 'custom',
			name: 'Custom',
			useProviderDefaults: true,
			parameters: { responses: {}, chat: {} },
		});
});
