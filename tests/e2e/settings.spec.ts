import { chooseOption } from './ui-controls';
import { expect, test, type Page } from '@playwright/test';
import { initialState } from '../../src/lib/state';
import type { AppState } from '../../src/types';

async function openSettings(page: Page) {
	await page.goto('/');
	await expect(page).toHaveTitle('FreeLM');
	await expect(page.getByRole('heading', { name: 'What’s on your mind?' })).toBeVisible();
	await page.getByRole('button', { name: /Personal workspace/ }).click();
	await expect(page.getByRole('region', { name: 'Settings', exact: true })).toBeVisible();
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

test('settings is a page with separate sections and protects unsaved changes when returning to chat', async ({
	page,
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await openSettings(page);
	const settings = page.getByRole('region', { name: 'Settings', exact: true });
	await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
	await expect(settings.getByRole('heading', { name: 'Personal', exact: true })).toBeVisible();
	await expect(settings.getByRole('heading', { name: 'Integrations', exact: true })).toBeVisible();
	const options = settings.getByRole('navigation', { name: 'Settings options', exact: true });
	await expect(options.locator('button svg')).toHaveCount(0);
	const optionSize = await options
		.getByRole('button', { name: 'Configuration', exact: true })
		.evaluate((button) => getComputedStyle(button).fontSize);
	for (const name of ['Personal', 'Integrations'])
		await expect(options.getByRole('heading', { name, exact: true })).toHaveCSS(
			'font-size',
			optionSize,
		);
	const optionHeight = await options
		.getByRole('button', { name: 'Configuration', exact: true })
		.boundingBox();
	expect(optionHeight!.height).toBeLessThanOrEqual(36);
	await settings.getByRole('button', { name: 'System', exact: true }).click();
	await settings
		.getByRole('textbox', { name: 'System prompt', exact: true })
		.fill('Use clear, direct answers.');
	await settings.getByRole('button', { name: 'Appearance', exact: true }).click();
	await settings.getByRole('radio', { name: 'Light', exact: true }).click();
	await settings.getByRole('button', { name: 'Connections', exact: true }).click();
	await expect(settings.getByLabel('Connection name', { exact: true })).toBeVisible();
	await settings.getByRole('button', { name: 'Remote FreeLM', exact: true }).click();
	await expect(settings.getByText('Available in the desktop app', { exact: true })).toBeVisible();
	await settings.getByRole('button', { name: 'Back to workspace', exact: true }).click();
	await expect(
		settings.getByText('You have unsaved settings changes.', { exact: true }),
	).toBeVisible();
	await settings.getByRole('button', { name: 'Keep editing', exact: true }).click();
	await settings.getByRole('button', { name: 'System', exact: true }).click();
	await expect(settings.getByRole('textbox', { name: 'System prompt', exact: true })).toHaveValue(
		'Use clear, direct answers.',
	);
	await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
	await expect
		.poll(async () => (await persistedState(page)).systemPrompt)
		.toBe('Use clear, direct answers.');
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
	await settings
		.getByRole('textbox', { name: 'System prompt', exact: true })
		.fill('This should be discarded.');
	await settings.getByRole('button', { name: 'Back to workspace', exact: true }).click();
	await settings.getByRole('button', { name: 'Discard changes', exact: true }).click();
	await expect(settings).toHaveCount(0);
	await page.reload();
	await page.getByRole('button', { name: /Personal workspace/ }).click();
	await settings.getByRole('button', { name: 'System', exact: true }).click();
	await expect(settings.getByRole('textbox', { name: 'System prompt', exact: true })).toHaveValue(
		'Use clear, direct answers.',
	);
	expect(errors).toEqual([]);
});

test('a reusable thinking value configures a discovered model and combines workspace and project prompts in requests', async ({
	page,
}) => {
	const requests: Record<string, unknown>[] = [];
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
		if (new URL(route.request().url()).pathname.endsWith('/models')) {
			await route.fulfill({
				contentType: 'application/json',
				headers,
				body: JSON.stringify({ data: [{ id: 'reasoner' }, { id: 'image-maker' }] }),
			});
			return;
		}
		requests.push(route.request().postDataJSON());
		await route.fulfill({
			contentType: 'text/event-stream',
			headers,
			body: 'data: {"type":"response.output_text.delta","delta":"Configured answer."}\n\ndata: [DONE]\n\n',
		});
	});
	await openSettings(page);
	const settings = page.getByRole('region', { name: 'Settings', exact: true });
	await settings.getByRole('button', { name: 'Add thinking value', exact: true }).click();
	await settings
		.getByLabel('Thinking value display name', { exact: true })
		.fill('Careful analysis');
	await settings.getByLabel('API effort value', { exact: true }).fill('xhigh');
	await settings.getByRole('button', { name: 'Apply thinking value', exact: true }).click();
	await settings.getByRole('button', { name: 'Discover models', exact: true }).click();
	await expect(
		settings.getByRole('button', { name: 'Configure model image-maker', exact: true }),
	).toBeVisible();
	await settings.getByRole('button', { name: 'Configure model reasoner', exact: true }).click();
	await settings.getByLabel('Display name', { exact: true }).fill('My reasoner');
	await settings
		.getByRole('button', { name: 'Add thinking value Careful analysis', exact: true })
		.click();
	await settings.getByLabel('Use as default for: Chat', { exact: true }).check();
	await chooseOption(page, settings.getByLabel('Default thinking mode', { exact: true }), 'xhigh');
	await settings.getByRole('button', { name: 'Apply model', exact: true }).click();
	// Presets are copied into a model; later reusable-value edits must not silently change it.
	await settings
		.getByRole('button', { name: 'Edit thinking value Careful analysis', exact: true })
		.click();
	await settings.getByLabel('API effort value', { exact: true }).fill('medium');
	await settings.getByRole('button', { name: 'Apply thinking value', exact: true }).click();
	await settings.getByRole('button', { name: 'System', exact: true }).click();
	await settings
		.getByRole('textbox', { name: 'System prompt', exact: true })
		.fill('Use metric units.');
	await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
	await settings.getByRole('button', { name: 'Back to workspace', exact: true }).click();
	await expect
		.poll(
			async () =>
				(await persistedState(page)).connections[0].catalog?.[0].thinkingModes[0].parameters
					.responses,
		)
		.toEqual({ reasoning: { effort: 'xhigh' } });
	await page.getByRole('button', { name: 'New project', exact: true }).click();
	await page.getByLabel('Project name', { exact: true }).fill('Studio');
	await page
		.getByLabel('Project instructions', { exact: true })
		.fill('Consider the prototype constraints.');
	await page.getByRole('button', { name: 'Create project', exact: true }).click();
	await page.getByRole('button', { name: 'New chat in Studio', exact: true }).click();
	const model = page.getByRole('button', { name: 'Chat model', exact: true });
	await expect(model.locator('.composer-model-name')).toHaveText('My reasoner');
	await expect(model.locator('.composer-thinking-value')).toHaveText('Careful analysis');
	await page.getByLabel('Message', { exact: true }).fill('Discuss this design.');
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	await expect(page.locator('.message.assistant')).toContainText('Configured answer.');
	expect(requests[0]).toMatchObject({
		model: 'reasoner',
		reasoning: { effort: 'xhigh' },
		instructions: 'Use metric units.\n\nConsider the prototype constraints.',
	});
});

test('remote integration stays embedded and prevents navigation during a sharing request', async ({
	page,
}) => {
	await page.addInitScript((initial) => {
		let state: AppState = JSON.parse(initial);
		let revision = 0;
		const host = { running: false, name: 'This computer', instanceId: 'test-host', port: 4319 };
		(window as any).desktop = {
			platform: 'linux',
			workspaceLoad: async () => ({ state: structuredClone(state), revision: String(revision) }),
			workspaceSave: async (_id: string, _revision: string, next: typeof state) => {
				state = structuredClone(next);
				return { revision: String(++revision) };
			},
			storageInfo: async () => ({ secure: false, location: 'Test profile' }),
			onPrepareClose: () => () => {},
			instanceStatus: async () => ({ host: { ...host }, instances: [] }),
			hostStart: async () => {
				await new Promise<void>((resolve) => {
					(window as any).__finishSharing = resolve;
				});
				host.running = true;
				return { ...host };
			},
		};
	}, JSON.stringify(initialState()));
	await openSettings(page);
	const settings = page.getByRole('region', { name: 'Settings', exact: true });
	await settings.getByRole('button', { name: 'Remote FreeLM', exact: true }).click();
	await expect(
		settings.getByRole('region', { name: 'Remote FreeLM workspaces', exact: true }),
	).toBeVisible();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await settings.getByRole('button', { name: 'Start sharing', exact: true }).click();
	await expect(
		settings.getByRole('button', { name: 'Back to workspace', exact: true }),
	).toBeDisabled();
	await expect(settings.getByRole('button', { name: 'Configuration', exact: true })).toBeDisabled();
	await page.keyboard.press('Escape');
	await expect(settings).toBeVisible();
	await page.evaluate(() => (window as any).__finishSharing());
	await expect(settings.getByRole('button', { name: 'Stop sharing', exact: true })).toBeVisible();
	await expect(
		settings.getByRole('button', { name: 'Back to workspace', exact: true }),
	).toBeEnabled();
	await settings.getByRole('button', { name: 'Back to workspace', exact: true }).click();
	await expect(settings).toHaveCount(0);
});
