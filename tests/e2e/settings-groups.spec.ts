import { expect, test, type Page } from '@playwright/test';
import { initialState } from '../../src/lib/state';
import type { AppState, ModelDefinition } from '../../src/types';
import { chooseOption, expectValue } from './ui-controls';

test.use({ actionTimeout: 15_000 });

async function catalogFixture(page: Page) {
	const state = initialState();
	const model = (id: string, name: string, patch: Partial<ModelDefinition>): ModelDefinition => ({
		id,
		name,
		enabled: true,
		tasks: ['chat'],
		inputModalities: ['text'],
		outputModalities: ['text'],
		thinkingModes: [],
		...patch,
	});
	const modes = [
		{
			id: 'low',
			name: 'Low',
			parameters: { responses: { reasoning: { effort: 'low' } } },
		},
		{
			id: 'high',
			name: 'High',
			parameters: { responses: { reasoning: { effort: 'high' } } },
		},
	];
	state.connections[0].name = 'Isolated catalog API';
	state.connections[0].baseUrl = 'http://catalog.invalid/v1';
	state.connections[0].catalog = [
		model('reasoner', 'Reasoner', { contextWindow: 256_000, thinkingModes: modes }),
		model('hybrid', 'Hybrid model', {
			tasks: ['chat', 'images'],
			outputModalities: ['text', 'image'],
			thinkingModes: modes,
		}),
		model('photographer', 'Image maker', { tasks: ['images'], outputModalities: ['image'] }),
		model('animator', 'Video maker', { tasks: ['videos'], outputModalities: ['video'] }),
		model('speaker', 'Speech model', { tasks: ['speech'], outputModalities: ['audio'] }),
		model('listener', 'Transcription model', {
			tasks: ['transcription'],
			inputModalities: ['audio'],
		}),
	];
	// The discovered ID deliberately sounds like an image model: a name is not a
	// capability declaration and must stay Unknown until the user configures it.
	state.connections[0].discoveredModels = ['opaque-image-model'];
	state.connections[0].models = {
		chat: 'reasoner',
		images: 'photographer',
		videos: 'animator',
		speech: 'speaker',
		transcription: 'listener',
	};
	await page.addInitScript((initial) => {
		const control = {
			state: JSON.parse(localStorage.getItem('compact-settings-test') || initial) as AppState,
			requests: 0,
		};
		(window as any).__compactSettings = control;
		(window as any).desktop = {
			platform: 'linux',
			workspaceLoad: async () => ({ state: structuredClone(control.state), revision: '1' }),
			workspaceSave: async (_target: string, _revision: string, next: AppState) => {
				control.state = structuredClone(next);
				localStorage.setItem('compact-settings-test', JSON.stringify(next));
				return { revision: '1' };
			},
			storageInfo: async () => ({ secure: false, location: 'Isolated settings fixture' }),
			onPrepareClose: () => () => {},
			instanceStatus: async () => ({
				host: { running: false, name: 'Test host', instanceId: 'test', port: 4319 },
				instances: [],
			}),
			request: async () => {
				control.requests++;
				throw new Error('Catalog editing must not call a provider.');
			},
		};
	}, JSON.stringify(state));
}

// Browser plugin is unavailable. These isolated browser profiles inspect the
// production renderer without changing the user's desktop settings or APIs.
for (const width of [1440, 720]) {
	test(`grouped settings keep every page readable and within its content column at ${width}px`, async ({
		page,
	}) => {
		await page.setViewportSize({ width, height: 940 });
		const errors: string[] = [];
		const consoleErrors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		page.on('console', (message) => {
			if (['error', 'warning'].includes(message.type())) consoleErrors.push(message.text());
		});
		await page.goto('/');
		await expect(page).toHaveTitle('FreeLM');
		await expect(
			page.getByRole('heading', { name: 'What’s on your mind?', exact: true }),
		).toBeVisible();
		await page.getByRole('button', { name: 'Personal workspace settings', exact: true }).click();
		const settings = page.getByRole('region', { name: 'Settings', exact: true });
		const menu = settings.getByRole('navigation', { name: 'Settings options' });
		for (const name of [
			'Configuration',
			'Personalization',
			'Chat',
			'Code',
			'Archived chats',
			'System',
			'Memories',
			'Appearance',
			'Connections',
			'Search',
			'Tools',
			'MCP servers',
			'Skills',
			'Remote FreeLM',
		]) {
			await menu.getByRole('button', { name, exact: true }).click();
			const content = settings.locator('.settings-section-content:visible');
			await expect(content.locator('.settings-group').first()).toBeVisible();
			const result = await content.evaluate((element) => {
				const visible = (node: Element) =>
					(node as HTMLElement).offsetWidth > 0 && (node as HTMLElement).offsetHeight > 0;
				const bounds = element.getBoundingClientRect();
				const groups = [...element.querySelectorAll('.settings-group-list')].filter(visible);
				const fonts = [
					...element.querySelectorAll('.settings-row-label, h3, button, input, .select-trigger'),
				]
					.filter(visible)
					.map((node) => ({
						text: node.textContent?.trim().slice(0, 50),
						size: parseFloat(getComputedStyle(node).fontSize),
					}));
				const dropdowns = [...element.querySelectorAll('.select-trigger')]
					.filter(visible)
					.map((node) => ({
						label: node.getAttribute('aria-label') || node.textContent?.trim(),
						height: node.getBoundingClientRect().height,
					}));
				const rows = [...element.querySelectorAll('.settings-row')].filter(visible);
				return {
					outside: groups.filter((group) => {
						const rect = group.getBoundingClientRect();
						return rect.left < bounds.left - 1 || rect.right > bounds.right + 1;
					}).length,
					small: fonts.filter((entry) => entry.size < 13),
					oversizedDropdowns: dropdowns.filter((entry) => Math.abs(entry.height - 30) > 0.5),
					oversizedRows: rows.filter((row) => {
						const style = getComputedStyle(row);
						return parseFloat(style.paddingTop) > 12 || parseFloat(style.paddingBottom) > 12;
					}).length,
					looseDescriptions: [...element.querySelectorAll('.settings-row-description')]
						.filter(visible)
						.filter((node) => {
							const style = getComputedStyle(node);
							return parseFloat(style.lineHeight) / parseFloat(style.fontSize) > 1.45;
						}).length,
					documentOverflow: document.documentElement.scrollWidth > innerWidth,
					unlabeledGroups: [...element.querySelectorAll('.settings-group')]
						.filter(visible)
						.filter(
							(group) => !document.getElementById(group.getAttribute('aria-labelledby') || ''),
						).length,
				};
			});
			expect(result, name).toEqual({
				outside: 0,
				small: [],
				oversizedDropdowns: [],
				oversizedRows: 0,
				looseDescriptions: 0,
				documentOverflow: false,
				unlabeledGroups: 0,
			});
			if (['Personalization', 'Connections', 'Tools', 'Configuration', 'Search'].includes(name))
				await page.screenshot({ path: `/tmp/freelm-grouped-${name.toLowerCase()}-${width}.png` });
		}
		await menu.getByRole('button', { name: 'Appearance', exact: true }).click();
		await settings.getByRole('radio', { name: 'Light', exact: true }).click();
		await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
		await menu.getByRole('button', { name: 'Connections', exact: true }).click();
		await page.screenshot({ path: `/tmp/freelm-grouped-connections-light-${width}.png` });
		await expect(page.locator('vite-error-overlay')).toHaveCount(0);
		expect(consoleErrors).toEqual([]);
		expect(errors).toEqual([]);
	});

	test(`compact model categories preserve editing and saved capabilities at ${width}px`, async ({
		page,
	}) => {
		await page.setViewportSize({ width, height: 940 });
		await catalogFixture(page);
		const errors: string[] = [];
		const consoleErrors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		page.on('console', (message) => {
			if (['error', 'warning'].includes(message.type())) consoleErrors.push(message.text());
		});
		await page.goto('/');
		await expect(page).toHaveTitle('FreeLM');
		await expect(
			page.getByRole('heading', { name: 'What’s on your mind?', exact: true }),
		).toBeVisible();
		await page.getByRole('button', { name: 'Personal workspace settings', exact: true }).click();
		const settings = page.getByRole('region', { name: 'Settings', exact: true });
		const catalog = settings.locator('.model-catalog');
		const category = (name: string) => catalog.getByRole('region', { name, exact: true });
		await expect(catalog.locator('.catalog-model-section .settings-group-heading h3')).toHaveText([
			'Chat & Code',
			'Image',
			'Video',
			'Audio',
			'Unknown',
		]);
		await expect(category('Chat & Code').locator('.catalog-entry')).toHaveCount(2);
		await expect(category('Image').locator('.catalog-entry')).toHaveCount(1);
		await expect(category('Video').locator('.catalog-entry')).toHaveCount(1);
		await expect(category('Audio').locator('.catalog-entry')).toHaveCount(2);
		await expect(category('Unknown').locator('.catalog-entry')).toHaveCount(1);
		await expect(catalog.locator('.catalog-entry')).toHaveCount(7);
		await expect(
			category('Chat & Code').getByRole('button', { name: 'Edit model Hybrid model', exact: true }),
		).toBeVisible();
		await expect(
			catalog.getByRole('button', { name: 'Edit model Hybrid model', exact: true }),
		).toHaveCount(1);
		await expect(
			category('Unknown').getByRole('button', {
				name: 'Configure model opaque-image-model',
				exact: true,
			}),
		).toBeVisible();
		await expect(
			catalog.locator(
				'.catalog-entry .catalog-task-tags, .catalog-entry .catalog-capabilities, .catalog-entry .catalog-thinking-summary, .catalog-entry .catalog-context-summary, .catalog-entry .catalog-image-summary, .catalog-entry .catalog-badge',
			),
		).toHaveCount(0);
		await category('Chat & Code').evaluate((element) => element.scrollIntoView({ block: 'start' }));
		await page.screenshot({ path: `/tmp/freelm-compact-catalog-${width}.png` });
		await settings.getByRole('textbox', { name: 'Search models', exact: true }).fill('hybrid');
		await expect(catalog.locator('.catalog-entry')).toHaveCount(1);
		await expect(category('Image')).toHaveCount(0);
		await expect(category('Unknown')).toHaveCount(0);
		await settings.getByRole('textbox', { name: 'Search models', exact: true }).fill('');

		await catalog.getByRole('button', { name: 'Edit model Reasoner', exact: true }).click();
		await expect(settings.getByLabel('Context window (tokens)', { exact: true })).toHaveValue(
			'256000',
		);
		const thinking = settings.getByRole('combobox', { name: 'Default thinking mode', exact: true });
		await expect(thinking).toHaveCSS('height', '30px');
		await chooseOption(page, thinking, 'high');
		await expectValue(thinking, 'high');
		await settings.getByLabel('Display name', { exact: true }).fill('Thoughtful model');
		await settings.getByRole('button', { name: 'Apply model', exact: true }).click();
		await expect(
			category('Chat & Code').getByRole('button', {
				name: 'Edit model Thoughtful model',
				exact: true,
			}),
		).toBeVisible();

		await category('Unknown')
			.getByRole('button', { name: 'Configure model opaque-image-model', exact: true })
			.click();
		await settings.getByLabel('Display name', { exact: true }).fill('New image model');
		await settings.getByLabel('Available in: Chat', { exact: true }).uncheck();
		await settings.getByLabel('Available in: Images', { exact: true }).check();
		await settings.getByLabel('Output modalities: text', { exact: true }).uncheck();
		await settings.getByLabel('Output modalities: image', { exact: true }).check();
		await settings.getByRole('button', { name: 'Apply model', exact: true }).click();
		await expect(category('Unknown')).toHaveCount(0);
		await expect(category('Image').locator('.catalog-entry')).toHaveCount(2);
		await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
		await expect
			.poll(() =>
				page.evaluate(() => (window as any).__compactSettings.state.connections[0].catalog.length),
			)
			.toBe(7);
		await page.reload();
		await expect(
			page.getByRole('heading', { name: 'What’s on your mind?', exact: true }),
		).toBeVisible();
		await page.getByRole('button', { name: 'Personal workspace settings', exact: true }).click();
		await expect(category('Image').locator('.catalog-entry')).toHaveCount(2);
		await expect(category('Unknown')).toHaveCount(0);
		await catalog.getByRole('button', { name: 'Edit model Thoughtful model', exact: true }).click();
		await expect(settings.getByLabel('Context window (tokens)', { exact: true })).toHaveValue(
			'256000',
		);
		await expectValue(
			settings.getByRole('combobox', { name: 'Default thinking mode', exact: true }),
			'high',
		);
		const layout = await catalog.evaluate((element) => {
			const bounds = element.getBoundingClientRect();
			const controls = [...element.querySelectorAll('input, button, .settings-group-list')].filter(
				(node) => (node as HTMLElement).offsetWidth > 0 && (node as HTMLElement).offsetHeight > 0,
			);
			return {
				overflow: document.documentElement.scrollWidth > innerWidth,
				outside: controls.filter((node) => {
					const rect = node.getBoundingClientRect();
					return rect.left < bounds.left - 1 || rect.right > bounds.right + 1;
				}).length,
				small: controls.filter((node) => parseFloat(getComputedStyle(node).fontSize) < 13).length,
			};
		});
		expect(layout).toEqual({ overflow: false, outside: 0, small: 0 });
		await page.screenshot({ path: `/tmp/freelm-compact-model-editor-${width}.png` });
		expect(await page.evaluate(() => (window as any).__compactSettings.requests)).toBe(0);
		await expect(page.locator('vite-error-overlay')).toHaveCount(0);
		expect(consoleErrors).toEqual([]);
		expect(errors).toEqual([]);
	});
}
