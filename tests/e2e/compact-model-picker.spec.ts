import { expect, test, type Page } from '@playwright/test';
import { initialState } from '../../src/lib/state';
import type { ModelDefinition, ThinkingMode } from '../../src/types';

async function seed(
	page: Page,
	options: { unconfigured?: boolean; modes?: ThinkingMode[]; selectedThinkingMode?: string } = {},
) {
	const state = initialState();
	const modes = options.modes || [
		{ id: 'low', name: 'Low', parameters: { responses: { reasoning: { effort: 'low' } } } },
		{
			id: 'custom-deep',
			name: 'Deliberate',
			parameters: { responses: { reasoning: { effort: 'high' } } },
		},
		{ id: 'max', name: 'Max', parameters: { responses: { reasoning: { effort: 'max' } } } },
	];
	const catalog: ModelDefinition[] = Array.from({ length: 40 }, (_, i) => ({
		id: `provider-model-${i + 1}`,
		name: `Model ${String(i + 1).padStart(2, '0')}`,
		enabled: true,
		tasks: ['chat'],
		inputModalities: ['text', 'image'],
		outputModalities: ['text'],
		thinkingModes: options.unconfigured ? [] : modes,
		defaultThinkingMode: options.unconfigured ? undefined : 'low',
	}));
	catalog.push(
		{
			id: 'image-create',
			name: 'Image studio',
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
			id: 'video-create',
			name: 'Cinema',
			enabled: true,
			tasks: ['videos'],
			inputModalities: ['text'],
			outputModalities: ['video'],
			thinkingModes: [],
		},
	);
	state.connections[0].catalog = catalog;
	state.connections[0].models.chat = 'provider-model-38';
	state.connections[0].models.images = 'image-create';
	state.connections[0].models.videos = 'video-create';
	if (options.selectedThinkingMode)
		state.threads = [
			{
				id: 'thinking-order-thread',
				kind: 'chat',
				title: 'Thinking order fixture',
				titleSource: 'manual',
				connectionId: state.connections[0].id,
				model: 'provider-model-38',
				thinkingMode: options.selectedThinkingMode,
				messages: [],
				createdAt: 1,
				updatedAt: 1,
			},
		];
	await page.goto('/');
	await expect(page.getByRole('button', { name: 'Chat model', exact: true })).toBeVisible({
		timeout: 15000,
	});
	await page.evaluate(async (workspace) => {
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const open = indexedDB.open('freelm-workspace', 1);
			open.onsuccess = () => resolve(open.result);
			open.onerror = () => reject(open.error);
		});
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction('state', 'readwrite');
			tx.objectStore('state').put(JSON.parse(workspace), 'workspace');
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
		db.close();
	}, JSON.stringify(state));
	await page.reload();
	await expect(page.getByRole('button', { name: 'Chat model', exact: true })).toContainText(
		'Model 38',
	);
}

function modelDialog(page: Page) {
	return page.getByRole('dialog', { name: 'Choose a model', exact: true });
}

test('compact effort chooser supports configured values and sends the visible selection', async ({
	page,
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	let sent: Record<string, any> | undefined;
	await page.route('http://localhost:8000/v1/responses', async (route) => {
		const headers = {
			'access-control-allow-origin': '*',
			'access-control-allow-headers': '*',
			'access-control-allow-methods': '*',
		};
		if (route.request().method() === 'OPTIONS') {
			await route.fulfill({ status: 204, headers });
			return;
		}
		const body = route.request().postDataJSON();
		if (body.instructions?.startsWith('Write a short conversation title'))
			return route.fulfill({ headers, json: { output_text: '' } });
		sent = body;
		await route.fulfill({
			headers,
			contentType: 'text/event-stream',
			body: 'data: {"type":"response.output_text.delta","delta":"Compact chooser answer."}\n\ndata: {"type":"response.completed","response":{"output_text":"Compact chooser answer."}}\n\n',
		});
	});
	await seed(page);
	await expect(page).toHaveTitle('FreeLM');
	const trigger = page.getByRole('button', { name: 'Chat model', exact: true });
	await expect(trigger).not.toContainText('·');
	expect(
		await trigger
			.locator('.composer-thinking-value')
			.evaluate((element) => getComputedStyle(element).fontSize),
	).toBe(
		await trigger
			.locator('.composer-model-name')
			.evaluate((element) => getComputedStyle(element).fontSize),
	);
	await trigger.click();
	const picker = modelDialog(page);
	await expect(picker.getByRole('slider', { name: 'Thinking mode', exact: true })).toHaveAttribute(
		'aria-valuetext',
		'Low',
	);
	await expect(picker.getByRole('combobox')).toHaveCount(0);
	await expect(picker.getByRole('listbox')).toHaveCount(0);
	await expect(picker.getByText('Model settings', { exact: true })).toHaveCount(0);
	expect((await picker.boundingBox())!.height).toBeLessThan(160);
	await picker.getByRole('button', { name: 'Deliberate', exact: true }).click();
	await expect(trigger).toContainText('Deliberate');
	await expect(picker.getByRole('slider')).toHaveAttribute('aria-valuetext', 'Deliberate');
	await picker.getByRole('slider').press('End');
	await expect(trigger.locator('.composer-thinking-value')).toHaveText('Max');
	await expect(trigger.locator('.composer-thinking-value')).toHaveCSS('color', 'rgb(10, 132, 255)');
	await page.screenshot({ path: '/tmp/freelm-audit-20260930/chooser-effort.png' });
	await picker.getByRole('slider').press('Escape');
	await expect(picker).toHaveCount(0);
	await expect(trigger).toBeFocused();
	await page
		.getByRole('textbox', { name: 'Message', exact: true })
		.fill('Check the selected effort');
	await page.getByRole('button', { name: 'Send message' }).click();
	await expect(page.getByText('Compact chooser answer.', { exact: true })).toBeVisible();
	expect(sent?.reasoning).toEqual({ effort: 'max' });
	expect(errors).toEqual([]);
});

test('effort slider uses canonical labels with out-of-order configuration and preserves the selected API mapping', async ({
	page,
}) => {
	const mode = (id: string, name: string, effort = id): ThinkingMode => ({
		id,
		name,
		parameters: { responses: { reasoning: { effort } } },
	});
	const modes = [
		mode('high', 'High'),
		mode('low', 'Low'),
		mode('max', 'Max'),
		mode('xhigh', 'Extra High'),
		mode('custom-medium', 'Medium', 'medium'),
	];
	let sent: Record<string, any> | undefined;
	await page.route('http://localhost:8000/v1/responses', async (route) => {
		const headers = {
			'access-control-allow-origin': '*',
			'access-control-allow-headers': '*',
			'access-control-allow-methods': '*',
		};
		if (route.request().method() === 'OPTIONS') {
			await route.fulfill({ status: 204, headers });
			return;
		}
		sent = route.request().postDataJSON();
		await route.fulfill({
			headers,
			contentType: 'text/event-stream',
			body: 'data: {"type":"response.output_text.delta","delta":"Ordered effort answer."}\n\ndata: {"type":"response.completed","response":{"output_text":"Ordered effort answer."}}\n\n',
		});
	});
	await seed(page, { modes, selectedThinkingMode: 'high' });
	await page.getByRole('button', { name: 'Thinking order fixture', exact: true }).click();
	const trigger = page.getByRole('button', { name: 'Chat model', exact: true });
	await expect(trigger.locator('.composer-thinking-value')).toHaveText('High');
	await trigger.click();
	const picker = modelDialog(page);
	const slider = picker.getByRole('slider', { name: 'Thinking mode', exact: true });
	await expect(slider).toHaveValue('2');
	expect(
		await picker
			.locator('.effort-stops button')
			.evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label'))),
	).toEqual(['Low', 'Medium', 'High', 'Extra High', 'Max']);
	await slider.press('ArrowRight');
	await expect(slider).toHaveAttribute('aria-valuetext', 'Extra High');
	await slider.press('End');
	await expect(slider).toHaveAttribute('aria-valuetext', 'Max');
	await expect(trigger.locator('.composer-thinking-value')).toHaveClass(/is-maximum/);
	await expect(trigger.locator('.composer-thinking-value')).toHaveCSS('color', 'rgb(10, 132, 255)');
	await slider.press('Home');
	await expect(slider).toHaveAttribute('aria-valuetext', 'Low');
	await slider.press('ArrowRight');
	await expect(slider).toHaveAttribute('aria-valuetext', 'Medium');
	await expect(trigger.locator('.composer-thinking-value')).not.toHaveClass(/is-maximum/);
	await page.screenshot({ path: '/tmp/freelm-thinking-order-slider.png' });
	await slider.press('Escape');
	await page
		.getByRole('textbox', { name: 'Message', exact: true })
		.fill('Send the visible Medium selection.');
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	await expect(page.getByText('Ordered effort answer.', { exact: true })).toBeVisible();
	expect(sent?.reasoning).toEqual({ effort: 'medium' });
});

test('adding Medium after High places its settings row and slider stop in the canonical position', async ({
	page,
}) => {
	const mode = (id: string, name: string): ThinkingMode => ({
		id,
		name,
		parameters: { responses: { reasoning: { effort: id } }, chat: { reasoning_effort: id } },
	});
	const modes = [
		mode('low', 'Low'),
		mode('high', 'High'),
		mode('xhigh', 'Extra High'),
		mode('max', 'Max'),
	];
	await seed(page, { modes, selectedThinkingMode: 'high' });
	await page.getByRole('button', { name: 'Thinking order fixture', exact: true }).click();
	await page.getByRole('button', { name: 'Personal workspace settings', exact: true }).click();
	const settings = page.getByRole('region', { name: 'Settings', exact: true });
	await settings.getByRole('button', { name: 'Edit model Model 38', exact: true }).click();
	const editor = settings.getByRole('group', { name: 'Edit catalog model', exact: true });
	await editor.getByRole('button', { name: 'Add thinking value Medium', exact: true }).click();
	expect(
		await editor
			.locator('.catalog-mode input[aria-label$=" name"]')
			.evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value)),
	).toEqual(['Low', 'Medium', 'High', 'Extra High', 'Max']);
	await expect(editor.getByLabel('Default thinking mode', { exact: true })).toHaveAttribute(
		'data-value',
		'low',
	);
	await page.screenshot({ path: '/tmp/freelm-thinking-order-settings.png' });
	await editor.getByRole('button', { name: 'Apply model', exact: true }).click();
	await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
	await expect(settings.getByText('Settings saved', { exact: true })).toBeVisible();
	await settings.getByRole('button', { name: 'Back to workspace', exact: true }).click();
	const trigger = page.getByRole('button', { name: 'Chat model', exact: true });
	await expect(trigger.locator('.composer-thinking-value')).toHaveText('High');
	await trigger.click();
	const picker = modelDialog(page);
	expect(
		await picker
			.locator('.effort-stops button')
			.evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label'))),
	).toEqual(['Low', 'Medium', 'High', 'Extra High', 'Max']);
	await expect(picker.getByRole('slider', { name: 'Thinking mode', exact: true })).toHaveValue('2');
	await picker.getByRole('slider').press('Escape');
	await page.reload();
	await page.getByRole('button', { name: 'Thinking order fixture', exact: true }).click();
	await trigger.click();
	expect(
		await modelDialog(page)
			.locator('.effort-stops button')
			.evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label'))),
	).toEqual(['Low', 'Medium', 'High', 'Extra High', 'Max']);
	await expect(
		modelDialog(page).getByRole('slider', { name: 'Thinking mode', exact: true }),
	).toHaveValue('2');
});

test('compact model list shows selected model, stays stable on hover, and supports keyboard navigation', async ({
	page,
}) => {
	await seed(page);
	const trigger = page.getByRole('button', { name: 'Chat model', exact: true });
	await trigger.click();
	await modelDialog(page).getByRole('button', { name: 'More models' }).click();
	const picker = modelDialog(page);
	const list = picker.getByRole('listbox', { name: 'Model choices' });
	const selected = picker.getByRole('option', { name: 'Model 38', exact: true });
	await expect(selected).toHaveAttribute('aria-selected', 'true');
	await expect(list).toBeFocused();
	const bounds = (await list.boundingBox())!;
	const current = (await selected.boundingBox())!;
	expect(current.y).toBeGreaterThanOrEqual(bounds.y);
	expect(current.y + current.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
	await expect(picker.getByRole('combobox')).toHaveCount(0);
	await expect(picker.locator('small')).toHaveCount(0);
	const before = await list.evaluate((element) => element.scrollTop);
	const anchor = (await picker.boundingBox())!;
	await selected.hover();
	expect(await list.evaluate((element) => element.scrollTop)).toBe(before);
	expect((await picker.boundingBox())!.y).toBe(anchor.y);
	await page.screenshot({ path: '/tmp/freelm-audit-20260930/chooser-models.png' });
	await list.press('Home');
	await list.press('Enter');
	await expect(trigger).toContainText('Model 01');
	await expect(trigger).toContainText('Low');
	await trigger.click();
	await modelDialog(page).getByRole('button', { name: 'More models' }).click();
	await list.press('End');
	await list.press('Enter');
	await expect(trigger).toContainText('Model 40');
});

test('custom model ID is an explicit advanced action and unconfigured models require thinking values', async ({
	page,
}) => {
	await seed(page);
	const trigger = page.getByRole('button', { name: 'Chat model', exact: true });
	await trigger.click();
	await modelDialog(page).getByRole('button', { name: 'More models' }).click();
	await modelDialog(page).getByRole('button', { name: 'Use a model ID…' }).click();
	const search = modelDialog(page).getByRole('combobox', { name: 'Search models' });
	await expect(search).toBeFocused();
	await search.fill('my-custom-model');
	await search.press('Enter');
	await expect(trigger).toContainText('my-custom-model');
	await page
		.getByRole('textbox', { name: 'Message', exact: true })
		.fill('This cannot send without thinking configuration');
	await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
	await trigger.click();
	await expect(
		modelDialog(page).getByText(
			'Choose Standard mode or configure a thinking value for this model.',
		),
	).toBeVisible();
	await expect(modelDialog(page).getByRole('slider')).toHaveCount(0);
	await modelDialog(page).getByRole('button', { name: 'Configure thinking values' }).click();
	await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
});

test('media pickers open compact model lists directly and stay within a narrow viewport', async ({
	page,
}) => {
	await seed(page);
	await page.setViewportSize({ width: 390, height: 500 });
	await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
	await page.getByRole('button', { name: 'Images', exact: true }).click();
	await page.getByRole('button', { name: 'Image model', exact: true }).click();
	let picker = modelDialog(page);
	await expect(picker.getByRole('listbox')).toBeFocused();
	await expect(picker.getByRole('slider')).toHaveCount(0);
	await expect(picker.getByRole('combobox')).toHaveCount(0);
	await picker.getByRole('option', { name: 'Image editor', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Image model', exact: true })).toHaveText(
		'Image editor',
	);
	await page.getByRole('button', { name: 'Video', exact: true }).click();
	await page.getByRole('button', { name: 'Video model', exact: true }).click();
	picker = modelDialog(page);
	await expect(picker.getByRole('listbox')).toBeFocused();
	await expect(picker.getByRole('option', { name: 'Cinema', exact: true })).toBeVisible();
	const box = (await picker.boundingBox())!;
	expect(box.x).toBeGreaterThanOrEqual(12);
	expect(box.x + box.width).toBeLessThanOrEqual(378);
	expect(box.y).toBeGreaterThanOrEqual(12);
	expect(box.y + box.height).toBeLessThanOrEqual(488);
	await page.screenshot({ path: '/tmp/freelm-audit-20260930/chooser-mobile.png' });
	await page.keyboard.press('Escape');
	await expect(picker).toHaveCount(0);
});
