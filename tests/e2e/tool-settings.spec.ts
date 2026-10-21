import {
	chooseOption,
	chooseCustomModel,
	expectValue,
	setChecked,
	openRemoteSettings,
} from './ui-controls';
import { expect, test, type Page } from '@playwright/test';
import { initialState } from '../../src/lib/state';
import { defaultToolSettings } from '../../src/lib/tool-settings';
import type { AppState } from '../../src/types';

async function openSettings(page: Page) {
	await page.goto('/');
	await expect(page).toHaveTitle('FreeLM');
	await expect(page.getByRole('heading', { name: 'What’s on your mind?' })).toBeVisible();
	await page.getByRole('button', { name: /Personal workspace/ }).click();
	return page.getByRole('region', { name: 'Settings', exact: true });
}

async function savedState(page: Page): Promise<AppState> {
	return page.evaluate(async () => {
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open('freelm-workspace', 1);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		try {
			return await new Promise<AppState>((resolve, reject) => {
				const request = db.transaction('state').objectStore('state').get('workspace');
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
		} finally {
			db.close();
		}
	});
}

async function desktopFixture(
	page: Page,
	state: AppState = initialState(),
	options: { legacy?: boolean } = {},
) {
	if (!options.legacy) state.toolSettings ??= defaultToolSettings();
	await page.addInitScript((serialized) => {
		const initial = JSON.parse(serialized) as AppState;
		const states: Record<string, AppState> = {
			local: structuredClone(initial),
			remote: structuredClone(initial),
		};
		let revision = 0;
		const inspected: unknown[] = [];
		(window as any).__toolSettingsTest = { states, inspected };
		const snapshot = (id: string) => ({
			state: structuredClone(states[id]),
			revision: String(revision),
		});
		(window as any).desktop = {
			platform: 'linux',
			workspaceLoad: async (id: string) => snapshot(id),
			workspaceSave: async (id: string, _revision: string, next: AppState) => {
				if (
					id === 'remote' &&
					JSON.stringify(next.toolSettings) !== JSON.stringify(states[id].toolSettings)
				) {
					throw new Error('Remote tool settings are host-owned.');
				}
				states[id] = structuredClone(next);
				return { revision: String(++revision) };
			},
			storageInfo: async () => ({ secure: false, location: 'Test workspace' }),
			onPrepareClose: () => () => {},
			onToolApproval: () => () => {},
			instanceStatus: async () => ({
				host: { running: false, name: 'This computer', instanceId: 'local', port: 4319 },
				instances: [
					{
						id: 'remote',
						name: 'Remote tool host',
						transport: 'direct',
						url: 'http://127.0.0.1:4319',
						connected: true,
						hasToken: true,
					},
				],
			}),
			instanceOpen: async (id: string) => snapshot(id),
			toolPickDirectory: async () => '/tmp/freelm-test-skills',
			toolInspect: async (settings: unknown) => {
				inspected.push(structuredClone(settings));
				return {
					tools: [
						{
							name: 'mcp__fixture__lookup',
							displayName: 'Lookup record',
							description: 'Find a record in the fixture.',
							parameters: { type: 'object', properties: { query: { type: 'string' } } },
							source: 'mcp',
						},
					],
					skills: [
						{
							id: 'fixture',
							name: 'Fixture skill',
							description: 'Use fixture project conventions.',
							path: '/tmp/freelm-test-skills/fixture/SKILL.md',
						},
					],
					instructions: '',
					warnings: ['Fixture discovery warning'],
				};
			},
		};
	}, JSON.stringify(state));
}

test('tool configuration, custom image model, MCP server and skill folders persist in the browser preview', async ({
	page,
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	const settings = await openSettings(page);
	await settings.getByRole('button', { name: 'Tools', exact: true }).click();
	await expect(settings.getByText(/available in the desktop app/)).toBeVisible();
	await expect(
		settings.getByText(
			/Chat Python, image and video generation, and web browsing have their own switches/,
		),
	).toBeVisible();
	await expect(settings.getByText(/Used by Code tasks outside a project/)).toBeVisible();
	await setChecked(settings.getByRole('switch', { name: /^Enable tools in Code/ }));
	await setChecked(settings.getByRole('switch', { name: /^Run commands/ }));
	await settings
		.getByLabel('Default working directory', { exact: true })
		.fill('/tmp/freelm-workspace');
	await chooseOption(
		page,
		settings.getByRole('combobox', { name: 'Tool approval', exact: true }),
		'full-access',
	);
	await setChecked(settings.getByRole('switch', { name: /^Generate images in Chat and Code/ }));
	await chooseCustomModel(
		page,
		settings.getByRole('button', { name: 'Image model', exact: true }),
		'custom-image-model',
	);
	await expect(settings.getByRole('button', { name: 'Image model', exact: true })).toHaveText(
		'custom-image-model',
	);
	await settings.getByLabel('Default image size').fill('2048x2048');
	await settings.getByLabel('Default image quality').fill('high');
	await expect(settings.getByText(/Default image size is a fallback/)).toBeVisible();
	await expect(settings.getByText(/The model can choose a size for each request/)).toBeVisible();
	await expect(settings.getByText(/Configuration → Models/)).toBeVisible();
	const guidance = settings.locator('details').filter({ hasText: 'Image size guidance' });
	await expect(guidance).not.toHaveAttribute('open');
	await guidance.getByText('Image size guidance', { exact: true }).click();
	await expect(guidance).toContainText('custom-image-model');
	await expect(guidance).toContainText('2048x2048');
	await expect(guidance).toContainText('high');
	await expect(guidance).toContainText('No aspect ratio/resolution recommendations');
	await guidance.getByText('Image size guidance', { exact: true }).click();
	await settings.locator('.settings-scroll').evaluate((element) => element.scrollTo(0, 0));
	await page.screenshot({ path: '/tmp/freelm-tools-settings.png' });
	await settings.getByRole('button', { name: 'MCP servers', exact: true }).click();
	await settings.getByRole('button', { name: 'Add MCP server' }).click();
	const server = settings.getByRole('region', { name: 'MCP server 1' });
	await server.getByLabel('Server name', { exact: true }).fill('My integration');
	await chooseOption(
		page,
		server.getByRole('combobox', { name: 'Transport', exact: true }),
		'http',
	);
	await server.getByLabel('Server URL', { exact: true }).fill('http://localhost:9000/mcp');
	await server.getByLabel(/Bearer token environment variable/).fill('MCP_API_TOKEN');
	await setChecked(server.getByRole('switch', { name: /^Enable MCP server/ }));
	await expect(settings.getByRole('button', { name: 'Discover MCP tools' })).toBeDisabled();
	await settings.getByRole('button', { name: 'Skills', exact: true }).click();
	await settings.getByRole('button', { name: 'Add directory' }).click();
	await settings.getByLabel('Skill directory 1', { exact: true }).fill('/tmp/my-skills');
	await expect(settings.getByRole('button', { name: 'Discover skills' })).toBeDisabled();
	await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
	await expect(settings.getByText('Settings saved', { exact: true })).toBeVisible();
	await expect
		.poll(async () => (await savedState(page)).toolSettings)
		.toMatchObject({
			enabled: true,
			commandExecution: true,
			workspaceRoot: '/tmp/freelm-workspace',
			approvalMode: 'full-access',
			imageGeneration: {
				enabled: true,
				model: 'custom-image-model',
				size: '2048x2048',
				quality: 'high',
			},
			mcpServers: [
				{
					name: 'My integration',
					enabled: true,
					transport: 'http',
					url: 'http://localhost:9000/mcp',
					bearerTokenEnv: 'MCP_API_TOKEN',
				},
			],
			skillDirectories: ['/tmp/my-skills'],
		});
	await page.reload();
	await page.getByRole('button', { name: /Personal workspace/ }).click();
	await settings.getByRole('button', { name: 'Tools', exact: true }).click();
	await expect(settings.getByRole('switch', { name: /^Run commands/ })).toBeChecked();
	await expect(settings.getByLabel('Default working directory', { exact: true })).toHaveValue(
		'/tmp/freelm-workspace',
	);
	await expect(settings.getByRole('button', { name: 'Image model', exact: true })).toHaveText(
		'custom-image-model',
	);
	await expect(page.locator('vite-error-overlay')).toHaveCount(0);
	expect(errors).toEqual([]);
});

test('image tool guidance shows catalog aspect ratios and exact resolutions without enabling the tool', async ({
	page,
}) => {
	const state = initialState();
	const connection = state.connections[0];
	connection.models.images = 'preset-image-model';
	connection.catalog = [
		{
			id: 'preset-image-model',
			name: 'Preset image model',
			enabled: true,
			tasks: ['images'],
			inputModalities: ['text', 'image'],
			outputModalities: ['image'],
			thinkingModes: [],
			imagePresets: [
				{
					id: 'studio',
					name: 'Studio quality',
					quality: 'studio-v2',
					defaultAspectRatio: 'square',
					aspectRatios: [
						{ id: 'square', name: '1:1', width: 1024, height: 1024 },
						{ id: 'landscape', name: '16:9', width: 1536, height: 864 },
					],
				},
			],
			defaultImagePreset: 'studio',
		},
	];
	state.toolSettings = {
		...defaultToolSettings(),
		imageGeneration: {
			enabled: false,
			connectionId: connection.id,
			model: 'preset-image-model',
			size: '640x640',
			quality: 'studio-v2',
		},
	};
	await desktopFixture(page, state);
	const settings = await openSettings(page);
	await settings.getByRole('button', { name: 'Tools', exact: true }).click();
	await expect(
		settings.getByRole('switch', { name: /^Generate images in Chat and Code/ }),
	).not.toBeChecked();
	const guidance = settings.locator('details').filter({ hasText: 'Image size guidance' });
	await expect(guidance).not.toHaveAttribute('open');
	await guidance.getByText('Image size guidance', { exact: true }).click();
	for (const text of [
		'preset-image-model',
		'640x640',
		'studio-v2',
		'16:9',
		'1536x864',
		'1:1',
		'1024x1024',
	])
		await expect(guidance).toContainText(text);
	await settings.getByLabel('Default image size').fill('768x768');
	await expect(guidance).toContainText('768x768');
	await expect(guidance).not.toContainText('640x640');
	await expect(
		settings.getByRole('switch', { name: /^Generate images in Chat and Code/ }),
	).not.toBeChecked();
	await expect(page.locator('vite-error-overlay')).toHaveCount(0);
});

test('desktop discovery displays MCP schemas and skills metadata without starting MCP for a skills refresh', async ({
	page,
}) => {
	await desktopFixture(page);
	const settings = await openSettings(page);
	await settings.getByRole('button', { name: 'MCP servers', exact: true }).click();
	await settings.getByRole('button', { name: 'Add MCP server' }).click();
	await settings.getByLabel('Command', { exact: true }).fill('/usr/bin/fixture-server');
	await settings.getByLabel('Arguments', { exact: true }).fill('--directory\n/tmp/fixture path');
	await setChecked(settings.getByRole('switch', { name: /^Enable MCP server/ }));
	await settings.getByRole('button', { name: 'Discover MCP tools' }).click();
	await expect(settings.getByRole('heading', { name: '1 tool discovered' })).toBeVisible();
	await expect(settings.getByText('Lookup record', { exact: true })).toBeVisible();
	await expect(settings.getByText('Fixture discovery warning')).toBeVisible();
	await settings.getByText('Parameters', { exact: true }).click();
	await expect(settings.locator('.tool-settings-results pre')).toContainText('query');
	await page.screenshot({ path: '/tmp/freelm-mcp-settings.png' });
	await settings.getByRole('button', { name: 'Skills', exact: true }).click();
	await settings.getByRole('button', { name: 'Add directory' }).click();
	await settings.getByRole('button', { name: 'Browse skill directory 1' }).click();
	await expect(settings.getByLabel('Skill directory 1', { exact: true })).toHaveValue(
		'/tmp/freelm-test-skills',
	);
	await settings.getByRole('button', { name: 'Discover skills' }).click();
	await expect(settings.getByText('Fixture skill', { exact: true })).toBeVisible();
	await expect(settings.getByText('Use fixture project conventions.')).toBeVisible();
	const inspected = await page.evaluate(() => (window as any).__toolSettingsTest.inspected);
	expect(inspected[0].mcpServers).toHaveLength(1);
	expect(inspected[0].mcpServers[0].args).toEqual(['--directory', '/tmp/fixture path']);
	expect(inspected[1].mcpServers).toEqual([]);
	expect(inspected[1].skillDirectories).toEqual(['/tmp/freelm-test-skills']);
	await page.screenshot({ path: '/tmp/freelm-skills-settings.png' });
});

test('remote tool settings cannot be edited or inspected from a connected client', async ({
	page,
}) => {
	await desktopFixture(page);
	await page.goto('/');
	await openRemoteSettings(page);
	await page
		.getByRole('region', { name: 'Remote FreeLM workspaces' })
		.getByRole('button', { name: 'Open', exact: true })
		.click();
	await expect(page.locator('.instance-context-bar')).toContainText('Remote tool host');
	await page.getByRole('button', { name: /Personal workspace/ }).click();
	const settings = page.getByRole('region', { name: 'Settings', exact: true });
	await settings.getByRole('button', { name: 'Tools', exact: true }).click();
	await expect(settings.getByRole('switch', { name: /^Enable tools in Code/ })).toBeDisabled();
	await expect(settings.getByText(/Configure them in Settings on that computer/)).toBeVisible();
	await settings.getByRole('button', { name: 'MCP servers', exact: true }).click();
	await expect(settings.getByRole('button', { name: 'Add MCP server' })).toBeDisabled();
	await expect(settings.getByRole('button', { name: 'Discover MCP tools' })).toBeDisabled();
	await settings.getByRole('button', { name: 'Skills', exact: true }).click();
	await expect(settings.getByRole('button', { name: 'Add directory' })).toBeDisabled();
	expect(await page.evaluate(() => (window as any).__toolSettingsTest.inspected)).toEqual([]);
});

test('legacy remote hosts can save appearance without creating host-owned tool settings', async ({
	page,
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	const state = initialState();
	delete state.toolSettings;
	await desktopFixture(page, state, { legacy: true });
	await page.goto('/');
	await openRemoteSettings(page);
	await page
		.getByRole('region', { name: 'Remote FreeLM workspaces' })
		.getByRole('button', { name: 'Open', exact: true })
		.click();
	await expect(page.locator('.instance-context-bar')).toContainText('Remote tool host');
	await page.getByRole('button', { name: /Personal workspace/ }).click();
	const settings = page.getByRole('region', { name: 'Settings', exact: true });
	await settings.getByRole('button', { name: 'Tools', exact: true }).click();
	await expect(settings.getByRole('switch', { name: /^Enable tools in Code/ })).toBeDisabled();
	await settings.getByRole('button', { name: 'Appearance', exact: true }).click();
	await settings.getByRole('radio', { name: 'Light', exact: true }).click();
	await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
	await expect(settings.getByText('Settings saved', { exact: true })).toBeVisible();
	const saved = await page.evaluate(() => (window as any).__toolSettingsTest.states.remote);
	expect(saved.theme).toBe('light');
	expect(saved.toolSettings).toBeUndefined();
	await expect(settings.getByRole('alert')).toHaveCount(0);
	expect(errors).toEqual([]);
});

test('image defaults stay with the selected connection and path validation rejects leading spaces', async ({
	page,
}) => {
	const state = initialState();
	state.connections[0].models.images = 'active-api-image-model';
	state.connections.push({
		...structuredClone(state.connections[0]),
		id: 'other',
		name: 'Other API',
		models: { ...state.connections[0].models, images: '' },
		discoveredModels: [],
	});
	state.toolSettings = {
		...defaultToolSettings(),
		imageGeneration: { enabled: false, connectionId: 'other', model: '', size: '', quality: '' },
	};
	await desktopFixture(page, state);
	const settings = await openSettings(page);
	await settings.getByRole('button', { name: 'Tools', exact: true }).click();
	await expectValue(settings.getByRole('combobox', { name: 'Image API connection' }), 'other');
	await setChecked(settings.getByRole('switch', { name: /^Generate images in Chat and Code/ }));
	await expect(settings.getByRole('button', { name: 'Image model', exact: true })).toHaveText(
		'Select model',
	);
	await chooseCustomModel(
		page,
		settings.getByRole('button', { name: 'Image model', exact: true }),
		'other-api-image-model',
	);
	await settings
		.getByLabel('Default working directory', { exact: true })
		.fill(' /tmp/my-workspace');
	await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
	await expect(settings.getByRole('alert')).toContainText('Use an absolute working directory');
	await settings.getByLabel('Default working directory', { exact: true }).fill('/tmp/my-workspace');
	await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
	await expect(settings.getByText('Settings saved', { exact: true })).toBeVisible();
	const saved = await page.evaluate(
		() => (window as any).__toolSettingsTest.states.local.toolSettings,
	);
	expect(saved.imageGeneration).toMatchObject({
		connectionId: 'other',
		model: 'other-api-image-model',
	});
});

test('Code permissions preserve disabled tools, display legacy Full access, and save Approve for me without a working directory', async ({
	page,
}) => {
	const state = initialState();
	state.toolSettings = {
		...defaultToolSettings(),
		enabled: false,
		commandExecution: false,
		approvalMode: 'trusted',
		workspaceRoot: '',
	};
	await desktopFixture(page, state);
	const settings = await openSettings(page);
	await settings.getByRole('button', { name: 'Tools', exact: true }).click();
	const enabled = settings.getByRole('switch', { name: 'Enable tools in Code', exact: true });
	const commands = settings.getByRole('switch', { name: 'Run commands', exact: true });
	const permissions = settings.getByRole('combobox', { name: 'Tool approval', exact: true });
	await expect(enabled).not.toBeChecked();
	await expect(commands).not.toBeChecked();
	await expect(permissions).toHaveText('Full access');
	await permissions.click();
	await expect(page.getByRole('option')).toHaveText([
		'Ask for approval',
		'Approve for me',
		'Full access',
	]);
	await page.getByRole('option', { name: 'Approve for me', exact: true }).click();
	await expect(settings.getByText(/with no operating-system sandbox/)).toBeVisible();
	await expect(
		settings.getByText(/Leave blank to start in the host’s home directory/),
	).toBeVisible();
	await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
	await expect(settings.getByText('Settings saved', { exact: true })).toBeVisible();
	await expect
		.poll(() => page.evaluate(() => (window as any).__toolSettingsTest.states.local.toolSettings))
		.toMatchObject({
			enabled: false,
			commandExecution: false,
			approvalMode: 'auto-review',
			workspaceRoot: '',
		});
	await setChecked(enabled);
	await setChecked(commands);
	await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => (window as any).__toolSettingsTest.states.local.toolSettings))
		.toMatchObject({
			enabled: true,
			commandExecution: true,
			approvalMode: 'auto-review',
			workspaceRoot: '',
		});
	await expect(settings.getByRole('alert')).toHaveCount(0);
});

test('video generation tools save a separate model and optional defaults', async ({ page }) => {
	test.setTimeout(150_000);
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	const state = initialState();
	state.connections[0].models.videos = 'video-default';
	state.toolSettings = defaultToolSettings();
	await desktopFixture(page, state);
	const settings = await openSettings(page);
	await settings.getByRole('button', { name: 'Tools', exact: true }).click();
	const group = settings.getByRole('region', { name: 'Video generation', exact: true });
	await expect(group.getByRole('textbox', { name: 'Default video size', exact: true })).toHaveValue(
		'1280x736',
	);
	await expect(
		group.getByRole('textbox', { name: 'Default video size', exact: true }),
	).toHaveAttribute('placeholder', '1280x736');
	await expect(
		group.getByText(
			'The model can choose a size and duration for each request. A blank size uses the playground default, 1280x736; a blank duration uses your video provider’s default.',
		),
	).toBeVisible();
	await expect(
		group.getByRole('switch', { name: 'Generate videos in Chat and Code' }),
	).not.toBeChecked();
	await group.getByRole('switch', { name: 'Generate videos in Chat and Code' }).click();
	await expectValue(
		group.getByRole('combobox', { name: 'Video API connection' }),
		state.activeConnectionId,
	);
	await expect(group.getByRole('button', { name: 'Video model', exact: true })).toHaveText(
		'video-default',
	);
	await chooseCustomModel(
		page,
		group.getByRole('button', { name: 'Video model', exact: true }),
		'custom-video-model',
	);
	await group.getByRole('textbox', { name: 'Default video size', exact: true }).fill('1920x1080');
	await group
		.getByRole('textbox', { name: 'Default video duration (seconds)', exact: true })
		.fill('15');
	await expect(group.getByRole('textbox', { name: 'Default video size', exact: true })).toHaveValue(
		'1920x1088',
	);
	await expect(group.getByRole('textbox', { name: 'Default video size', exact: true })).toHaveCSS(
		'font-size',
		'13px',
	);
	await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
	await expect(settings.getByText('Settings saved', { exact: true })).toBeVisible();
	const saved = await page.evaluate(
		() => (window as any).__toolSettingsTest.states.local.toolSettings,
	);
	expect(saved.videoGeneration).toEqual({
		enabled: true,
		connectionId: state.activeConnectionId,
		model: 'custom-video-model',
		size: '1920x1088',
		seconds: '15',
	});
	expect(saved.imageGeneration).toEqual(state.toolSettings.imageGeneration);
	await group.getByRole('textbox', { name: 'Default video size', exact: true }).fill('');
	await group
		.getByRole('textbox', { name: 'Default video duration (seconds)', exact: true })
		.fill('');
	await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
	await expect
		.poll(() =>
			page.evaluate(
				() => (window as any).__toolSettingsTest.states.local.toolSettings.videoGeneration,
			),
		)
		.toMatchObject({ size: '', seconds: '' });
	await group.scrollIntoViewIfNeeded();
	await page.screenshot({ path: '/tmp/freelm-video-tool-settings.png' });
	await expect(page.locator('vite-error-overlay')).toHaveCount(0);
	expect(errors).toEqual([]);
});
