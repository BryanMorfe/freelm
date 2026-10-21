import { expect, test, type Locator, type Page } from '@playwright/test';
import { initialState } from '../../src/lib/state';
import { defaultToolSettings } from '../../src/lib/tool-settings';
import type { AppState } from '../../src/types';
import { chooseOption, expectValue, openRemoteSettings } from './ui-controls';

// Browser plugin not available. This isolated bridge exercises Settings drafts,
// prompt inspection and catalog cancellation without a provider or user profile.
async function fixture(page: Page, legacyRemote = false) {
	const state = initialState();
	state.connections[0].name = 'Fixture API';
	state.connections[0].models.chat = 'fixture-model';
	state.connections[0].catalog = [
		{
			id: 'fixture-model',
			name: 'Fixture model',
			enabled: true,
			tasks: ['chat'],
			inputModalities: ['text'],
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
	state.memorySettings = { savedMemories: false, referenceHistory: false };
	state.systemPrompt = 'Workspace fixture guidance.';
	state.toolSettings = defaultToolSettings();
	state.toolSettings.enabled = true;
	state.toolSettings.commandExecution = true;
	state.toolSettings.workspaceRoot = '/tmp/personalization-fixture';
	state.projects = [
		{
			id: 'chat-project',
			kind: 'chat',
			name: 'Chat project',
			instructions: 'Only the Chat project instruction.',
			createdAt: 1,
		},
		{
			id: 'code-project',
			kind: 'code',
			name: 'Code project',
			instructions: 'Only the Code project instruction.',
			directories: ['/tmp/personalization-fixture'],
			createdAt: 1,
		},
	];
	state.threads = [
		{
			id: 'chat-thread',
			kind: 'chat',
			title: 'Project chat',
			projectId: 'chat-project',
			connectionId: state.activeConnectionId,
			model: 'fixture-model',
			thinkingMode: 'low',
			createdAt: 1,
			updatedAt: 1,
			messages: [{ id: 'chat-user', role: 'user', content: 'An earlier question.', createdAt: 1 }],
		},
		{
			id: 'code-thread',
			kind: 'code',
			title: 'Code task',
			projectId: 'code-project',
			connectionId: state.activeConnectionId,
			model: 'fixture-model',
			thinkingMode: 'low',
			createdAt: 1,
			updatedAt: 1,
			messages: [],
		},
	];
	await page.addInitScript(
		({ serialized, legacyRemote }) => {
			const initial = JSON.parse(serialized);
			const control: any = {
				state: JSON.parse(
					sessionStorage.getItem('personalization-fixture-state') || JSON.stringify(initial),
				),
				revision: 0,
				requests: [],
				catalogs: [],
				cancels: [],
				executions: [],
				catalogMode: 'ready',
				pending: [],
			};
			(window as any).__personalizationTest = control;
			const catalog = {
				instructions: 'Host Code guidance for /tmp/personalization-fixture.',
				warnings: [],
				tools: [
					{
						name: 'exec_command',
						source: 'builtin',
						description: 'Run a command.',
						parameters: {
							type: 'object',
							properties: { cmd: { type: 'string' } },
							required: ['cmd'],
						},
					},
				],
			};
			(window as any).desktop = {
				platform: 'linux',
				workspaceLoad: async (workspace: string) => ({
					state: structuredClone(control.state),
					revision: String(control.revision),
					...(workspace === 'legacy' ? { personalizationSupported: false } : {}),
				}),
				workspaceSave: async (_workspace: string, _revision: string, next: AppState) => {
					control.state = structuredClone(next);
					sessionStorage.setItem('personalization-fixture-state', JSON.stringify(next));
					return { revision: String(++control.revision) };
				},
				storageInfo: async () => ({ secure: false, location: 'Isolated personalization fixture' }),
				onPrepareClose: () => () => {},
				onChunk: () => () => {},
				onToolApproval: () => () => {},
				cancel: async () => {},
				instanceStatus: async () => ({
					host: { running: false, name: 'Local', instanceId: 'local', port: 4319 },
					instances: legacyRemote
						? [
								{
									id: 'legacy',
									name: 'Legacy fixture',
									transport: 'direct',
									url: 'http://legacy-fixture.invalid',
									connected: true,
									hasToken: true,
								},
							]
						: [],
				}),
				instanceOpen: async () => ({
					state: structuredClone(control.state),
					revision: String(control.revision),
					personalizationSupported: false,
				}),
				toolCatalog: async (_workspace: string, runId: string, threadId: string) => {
					control.catalogs.push({ runId, threadId });
					if (control.catalogMode === 'fail')
						throw new Error('Fixture host catalog is unavailable.');
					if (control.catalogMode === 'wait')
						return new Promise((resolve) =>
							control.pending.push(() => resolve(structuredClone(catalog))),
						);
					return structuredClone(catalog);
				},
				toolCancel: async (runId: string) => {
					control.cancels.push(runId);
				},
				toolExecute: async (request: unknown) => {
					control.executions.push(request);
					throw new Error('Preview must never execute tools.');
				},
				request: async (request: any) => {
					control.requests.push(structuredClone(request.body));
					return {
						status: 200,
						contentType: 'application/json',
						encoding: 'text',
						body: JSON.stringify({ output_text: 'Fixture reply.' }),
					};
				},
			};
		},
		{ serialized: JSON.stringify(state), legacyRemote },
	);
	await page.goto('/');
	await expect(page).toHaveTitle('FreeLM');
}

async function openSettings(page: Page) {
	await page.getByRole('button', { name: 'Personal workspace settings', exact: true }).click();
	const settings = page.getByRole('region', { name: 'Settings', exact: true });
	await expect(settings).toBeVisible();
	return settings;
}
async function saved(page: Page): Promise<AppState> {
	return page.evaluate(() => structuredClone((window as any).__personalizationTest.state));
}

async function expectChevronClearance(control: Locator) {
	await expect(control).toHaveClass(/select-trigger/);
	expect(await control.evaluate((element) => element.tagName)).toBe('BUTTON');
	const geometry = await control.evaluate((element) => {
		const trigger = element.getBoundingClientRect();
		const label = element.querySelector('span')!.getBoundingClientRect();
		const icon = element.querySelector('svg')!.getBoundingClientRect();
		return { rightInset: trigger.right - icon.right, labelGap: icon.left - label.right };
	});
	expect(geometry.rightInset).toBeGreaterThanOrEqual(10);
	expect(geometry.labelGap).toBeGreaterThanOrEqual(12);
}

test('Personalization uses padded themed menus with keyboard selection, dismissal and narrow viewport placement', async ({
	page,
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await fixture(page);
	const settings = await openSettings(page);
	await settings.getByRole('button', { name: 'Personalization', exact: true }).click();
	await expect(settings.locator('select')).toHaveCount(0);
	const personality = settings.getByRole('combobox', { name: 'Personality', exact: true });
	await expectChevronClearance(personality);
	await personality.click();
	const menu = page.getByRole('listbox');
	await expect(menu).toHaveClass('select-popup');
	await expect(menu.getByRole('option')).toHaveCount(8);
	const selected = menu.locator('[role="option"][data-value="default"]');
	await expect(selected).toHaveAttribute('aria-selected', 'true');
	await expect(selected.locator('svg')).toHaveCount(1);
	await expect(menu.locator('[role="option"][data-value="friendly"] small')).toBeVisible();
	await page.screenshot({ path: '/tmp/freelm-dropdown-20261001-personalization-desktop.png' });
	await personality.press('End');
	await personality.press('Escape');
	await expect(menu).toHaveCount(0);
	await expect(personality).toBeFocused();
	await expectValue(personality, 'default');
	await personality.press('p');
	await personality.press('Enter');
	await expectValue(personality, 'professional');
	await expect(menu).toHaveCount(0);
	await personality.press('ArrowDown');
	await personality.press('ArrowDown');
	await personality.press('Enter');
	await expectValue(personality, 'candid');
	await personality.click();
	await settings.getByRole('textbox', { name: 'Chat custom instructions', exact: true }).click();
	await expect(menu).toHaveCount(0);
	await expectValue(personality, 'candid');
	const warmth = settings.getByRole('combobox', { name: 'Warmth', exact: true });
	await expectChevronClearance(warmth);
	await warmth.focus();
	await warmth.press('End');
	await warmth.press('Enter');
	await expectValue(warmth, 'more');
	await page.setViewportSize({ width: 390, height: 844 });
	await expectChevronClearance(warmth);
	await warmth.click();
	await expect(menu.getByRole('option')).toHaveCount(3);
	await expect(menu.locator('[data-value="more"]')).toHaveAttribute('aria-selected', 'true');
	const bounds = (await menu.boundingBox())!;
	expect(bounds.x).toBeGreaterThanOrEqual(7);
	expect(bounds.x + bounds.width).toBeLessThanOrEqual(383);
	expect(bounds.y).toBeGreaterThanOrEqual(7);
	expect(bounds.y + bounds.height).toBeLessThanOrEqual(837);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await page.screenshot({ path: '/tmp/freelm-dropdown-20261001-personalization-narrow.png' });
	await warmth.press('Escape');
	await expect(menu).toHaveCount(0);
	await expect(page.locator('vite-error-overlay')).toHaveCount(0);
	expect(errors).toEqual([]);
});

test('Legacy remote personalization disables the shared controls without opening menus or changing saved settings', async ({
	page,
}) => {
	await fixture(page, true);
	await openRemoteSettings(page);
	await page
		.getByRole('region', { name: 'Remote FreeLM workspaces' })
		.getByRole('button', { name: 'Open', exact: true })
		.click();
	const settings = await openSettings(page);
	await settings.getByRole('button', { name: 'Personalization', exact: true }).click();
	await expect(
		settings.getByText('Update this remote FreeLM instance to enable personalization.', {
			exact: true,
		}),
	).toBeVisible();
	await expect(settings.locator('select')).toHaveCount(0);
	const controls = settings.getByRole('combobox');
	await expect(controls).toHaveCount(6);
	for (const control of await controls.all()) {
		await expect(control).toHaveClass(/select-trigger/);
		await expect(control).toBeDisabled();
	}
	await expect(
		settings.getByRole('textbox', { name: 'Chat custom instructions', exact: true }),
	).toBeDisabled();
	await expect(page.getByRole('listbox')).toHaveCount(0);
	expect((await saved(page)).personalization).toBeUndefined();
	await settings.getByRole('tab', { name: 'Code', exact: true }).click();
	for (const control of await controls.all()) await expect(control).toBeDisabled();
	await expect(page.getByRole('listbox')).toHaveCount(0);
});

test('Personalization keeps Chat and Code drafts separate, saves both, and discards unsaved changes', async ({
	page,
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await fixture(page);
	const settings = await openSettings(page);
	await settings.getByRole('button', { name: 'Personalization', exact: true }).click();
	const chat = settings.getByRole('tab', { name: 'Chat', exact: true });
	const code = settings.getByRole('tab', { name: 'Code', exact: true });
	await expect(chat).toHaveAttribute('aria-selected', 'true');
	await chooseOption(
		page,
		settings.getByRole('combobox', { name: 'Personality', exact: true }),
		'friendly',
	);
	await chooseOption(page, settings.getByRole('combobox', { name: 'Warmth', exact: true }), 'more');
	await settings
		.getByRole('textbox', { name: 'Chat custom instructions', exact: true })
		.fill('Chat-only custom instruction.');
	await chat.focus();
	await chat.press('ArrowRight');
	await expect(code).toBeFocused();
	await expect(code).toHaveAttribute('aria-selected', 'true');
	await expectValue(
		settings.getByRole('combobox', { name: 'Personality', exact: true }),
		'default',
	);
	await chooseOption(
		page,
		settings.getByRole('combobox', { name: 'Personality', exact: true }),
		'efficient',
	);
	await chooseOption(
		page,
		settings.getByRole('combobox', { name: 'Response length', exact: true }),
		'less',
	);
	await settings
		.getByRole('textbox', { name: 'Code custom instructions', exact: true })
		.fill('Code-only custom instruction.');
	await settings.getByRole('button', { name: 'System', exact: true }).click();
	const output = settings.locator('pre[aria-label="Generated system prompt"]');
	await expect(output).toContainText('Chat-only custom instruction.');
	await expect(output).not.toContainText('Code-only custom instruction.');
	await expect(
		settings.getByText('Draft preview — save settings to apply these instructions.', {
			exact: true,
		}),
	).toBeVisible();
	await chooseOption(
		page,
		settings.getByRole('combobox', { name: 'Prompt conversation', exact: true }),
		'chat-thread',
	);
	await expect(output).toContainText('Only the Chat project instruction.');
	await expect(output).not.toContainText('Only the Code project instruction.');
	await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
	await expect
		.poll(async () => (await saved(page)).personalization?.code.customInstructions)
		.toBe('Code-only custom instruction.');
	await expect(settings.getByText('Preview from saved settings.', { exact: true })).toBeVisible();
	await page.reload();
	await openSettings(page);
	await settings.getByRole('button', { name: 'Personalization', exact: true }).click();
	await expectValue(
		settings.getByRole('combobox', { name: 'Personality', exact: true }),
		'friendly',
	);
	await expect(
		settings.getByRole('textbox', { name: 'Chat custom instructions', exact: true }),
	).toHaveValue('Chat-only custom instruction.');
	await code.click();
	await expectValue(
		settings.getByRole('combobox', { name: 'Personality', exact: true }),
		'efficient',
	);
	await expectValue(
		settings.getByRole('combobox', { name: 'Response length', exact: true }),
		'less',
	);
	await page.setViewportSize({ width: 390, height: 844 });
	const instructions = settings.getByRole('textbox', {
		name: 'Code custom instructions',
		exact: true,
	});
	await instructions.fill(
		Array.from({ length: 45 }, (_, index) => `Draft instruction line ${index}.`).join('\n'),
	);
	await expect(instructions).toHaveAttribute('maxlength', '10000');
	const bounds = (await instructions.boundingBox())!;
	expect(bounds.height).toBeGreaterThan(140);
	expect(bounds.height).toBeLessThanOrEqual(600);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await page.screenshot({ path: '/tmp/freelm-personalization-narrow.png' });
	await settings.getByRole('button', { name: 'Back to workspace', exact: true }).click();
	await settings.getByRole('button', { name: 'Discard changes', exact: true }).click();
	await openSettings(page);
	await settings.getByRole('button', { name: 'Personalization', exact: true }).click();
	await code.click();
	await expect(instructions).toHaveValue('Code-only custom instruction.');
	expect(await page.evaluate(() => (window as any).__personalizationTest.catalogs)).toEqual([]);
	expect(errors).toEqual([]);
});

test('System separates the current draft prompt and tools from the exact last sent request', async ({
	page,
}) => {
	await fixture(page);
	await page.getByRole('button', { name: 'Project chat', exact: true }).click();
	await page.getByRole('textbox', { name: 'Message', exact: true }).fill('A new question.');
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	await expect(page.getByText('Fixture reply.', { exact: true })).toBeVisible();
	const sent = await page.evaluate(() =>
		(window as any).__personalizationTest.requests.find((request: any) =>
			request.instructions?.includes('Workspace fixture guidance.'),
		),
	);
	expect(sent).toBeTruthy();
	const settings = await openSettings(page);
	await settings.getByRole('button', { name: 'System', exact: true }).click();
	await expectValue(
		settings.getByRole('combobox', { name: 'Prompt conversation', exact: true }),
		'chat-thread',
	);
	const preview = settings.locator('pre[aria-label="Generated system prompt"]');
	const last = settings.locator('pre[aria-label="Last sent system prompt"]');
	await expect(last).toHaveText(sent.instructions);
	await expect(preview).toHaveText(sent.instructions);
	await expect(settings.locator('pre[aria-label="API tool definitions"]')).toHaveCount(0);
	await settings
		.locator('.system-prompt-tools summary')
		.filter({ hasText: /^API tool definitions/ })
		.click();
	expect(
		JSON.parse((await settings.locator('pre[aria-label="API tool definitions"]').textContent())!),
	).toEqual(sent.tools ?? []);
	await settings
		.locator('.system-prompt-tools summary')
		.filter({ hasText: /^Last sent API tool definitions/ })
		.click();
	expect(
		JSON.parse(
			(await settings.locator('pre[aria-label="Last sent API tool definitions"]').textContent())!,
		),
	).toEqual(sent.tools ?? []);
	await settings
		.getByRole('textbox', { name: 'System prompt', exact: true })
		.fill('Changed draft guidance.');
	await expect(preview).toContainText('Changed draft guidance.');
	await expect(last).toHaveText(sent.instructions);
	await expect(last).not.toContainText('Changed draft guidance.');
	await page.evaluate(() =>
		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: {
				writeText: async (text: string) => {
					(window as any).__copiedPrompt = text;
				},
			},
		}),
	);
	await settings.getByRole('button', { name: 'Copy prompt', exact: true }).click();
	expect(await page.evaluate(() => (window as any).__copiedPrompt)).toBe(
		await preview.textContent(),
	);
	await page.screenshot({ path: '/tmp/freelm-system-prompt-transparency.png' });
});

test('Code preview cancels stale catalog work, caches successful catalogs and exposes failures without a complete prompt', async ({
	page,
}) => {
	await fixture(page);
	const settings = await openSettings(page);
	expect(await page.evaluate(() => (window as any).__personalizationTest.catalogs.length)).toBe(0);
	await page.evaluate(() => {
		(window as any).__personalizationTest.catalogMode = 'wait';
	});
	await settings.getByRole('button', { name: 'System', exact: true }).click();
	await chooseOption(
		page,
		settings.getByRole('combobox', { name: 'Prompt mode', exact: true }),
		'code',
	);
	await chooseOption(
		page,
		settings.getByRole('combobox', { name: 'Prompt conversation', exact: true }),
		'code-thread',
	);
	await expect
		.poll(() => page.evaluate(() => (window as any).__personalizationTest.catalogs.length))
		.toBe(1);
	await settings.getByRole('button', { name: 'Personalization', exact: true }).click();
	await settings.getByRole('tab', { name: 'Code', exact: true }).click();
	await settings
		.getByRole('textbox', { name: 'Code custom instructions', exact: true })
		.fill('Latest Code instructions.');
	await page.evaluate(() => {
		const control = (window as any).__personalizationTest;
		control.pending.splice(0).forEach((resolve: () => void) => resolve());
		control.catalogMode = 'ready';
	});
	await expect
		.poll(() => page.evaluate(() => (window as any).__personalizationTest.cancels.length))
		.toBeGreaterThanOrEqual(1);
	await settings.getByRole('button', { name: 'System', exact: true }).click();
	const output = settings.locator('pre[aria-label="Generated system prompt"]');
	await expect(output).toContainText('Latest Code instructions.');
	await expect(output).toContainText('Host Code guidance for /tmp/personalization-fixture.');
	await expect(output).not.toContainText('Only the Chat project instruction.');
	const catalogs = await page.evaluate(() => (window as any).__personalizationTest.catalogs.length);
	await settings
		.getByRole('textbox', { name: 'System prompt', exact: true })
		.fill('Updated workspace draft.');
	await expect(output).toContainText('Updated workspace draft.');
	expect(await page.evaluate(() => (window as any).__personalizationTest.catalogs.length)).toBe(
		catalogs,
	);
	await page.evaluate(() => {
		(window as any).__personalizationTest.catalogMode = 'fail';
	});
	await settings.getByRole('button', { name: 'Refresh prompt', exact: true }).click();
	await expect(settings.getByRole('alert')).toContainText('Fixture host catalog is unavailable.');
	await expect(output).toHaveCount(0);
	await expect(settings.getByRole('button', { name: 'Copy prompt', exact: true })).toBeDisabled();
	await chooseOption(
		page,
		settings.getByRole('combobox', { name: 'Prompt mode', exact: true }),
		'chat',
	);
	await expect(output).toContainText('Chat capabilities:');
	await expect(output).not.toContainText('Host Code guidance');
	expect(await page.evaluate(() => (window as any).__personalizationTest.executions)).toEqual([]);
	await expect(page.locator('vite-error-overlay')).toHaveCount(0);
});
