import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { initialState } from '../../src/lib/state';
import { defaultPluginSettings, validatePluginManifest } from '../../src/lib/plugin-manifest';

// Isolated desktop bridge: no installed user plugins or inference requests are used.
async function fixture(page: Page) {
	const manifest = validatePluginManifest(
		JSON.parse(readFileSync('examples/plugins/follow-up/manifest.json', 'utf8')),
	);
	const state = initialState();
	state.connections[0].id = 'test-connection';
	state.connections[0].name = 'Fixture connection';
	state.activeConnectionId = 'test-connection';
	state.connections[0].catalog = [
		{
			id: 'test-model',
			name: 'Fixture model',
			enabled: true,
			tasks: ['chat'],
			inputModalities: ['text'],
			outputModalities: ['text'],
			thinkingModes: [
				{ id: 'brief', name: 'Brief', parameters: { responses: { reasoning: { effort: 'low' } } } },
			],
		},
	];
	await page.addInitScript(
		(serialized: string) => {
			const { state, manifest, settings } = JSON.parse(serialized);
			const control = {
				commands: [] as any[],
				snapshot: {
					plugins: [
						{
							manifest,
							settings,
							enabled: true,
							installedAt: 1,
							surfaceAccess: { chat: true, code: true },
							runtimeError: '',
						},
					],
					accounts: [],
				},
			};
			(window as any).__pluginNativeSettings = control;
			(window as any).desktop = {
				platform: 'linux',
				workspaceLoad: async () => ({ state, revision: '1' }),
				workspaceSave: async () => ({ revision: '2' }),
				storageInfo: async () => ({ secure: true, location: 'Isolated fixture' }),
				onPrepareClose: () => () => {},
				onChunk: () => () => {},
				cancel: async () => {},
				instanceStatus: async () => ({
					host: { running: false, name: 'Local', instanceId: 'local', port: 4319 },
					instances: [],
				}),
				botsSnapshot: async () => ({
					host: { id: 'local', name: 'Local' },
					revision: 1,
					bots: [],
					conversations: [],
					connections: [],
				}),
				pluginSnapshot: async () => structuredClone(control.snapshot),
				pluginCancelConnect: async () => {},
				pluginCommand: async (command: any) => {
					control.commands.push(command);
					const plugin = control.snapshot.plugins[0];
					if (command.type === 'settings') plugin.settings = command.values;
					if (command.type === 'surface-access') plugin.surfaceAccess = command.surfaceAccess;
					if (command.type === 'enable') plugin.enabled = command.enabled;
					return structuredClone(control.snapshot);
				},
			};
		},
		JSON.stringify({ state, manifest, settings: defaultPluginSettings(manifest) }),
	);
	await page.goto('/');
	await page.getByRole('button', { name: 'Personal workspace settings', exact: true }).click();
	const settings = page.getByRole('region', { name: 'Settings', exact: true });
	await settings.getByRole('button', { name: 'Plugins', exact: true }).click();
	return settings;
}

test('accountless extension exposes native settings, explicit model effort, and independent surface access', async ({
	page,
}) => {
	const settings = await fixture(page);
	await expect(
		settings.getByText('No account or sign-in is required for this extension.'),
	).toBeVisible();
	await expect(settings.getByRole('button', { name: 'Add account', exact: true })).toHaveCount(0);
	await expect(settings.getByRole('combobox', { name: 'Model', exact: true })).toHaveText(
		'Same as conversation',
	);
	await settings.getByRole('spinbutton', { name: 'Recent exchanges', exact: true }).fill('5');
	await settings.getByRole('spinbutton', { name: 'Recent exchanges', exact: true }).press('Enter');
	await expect
		.poll(() =>
			page.evaluate(
				() => (window as any).__pluginNativeSettings.snapshot.plugins[0].settings.recentTurns,
			),
		)
		.toBe(5);
	await settings.getByRole('combobox', { name: 'Model', exact: true }).click();
	await page.getByRole('option', { name: /Fixture model · Brief/ }).click();
	await expect
		.poll(() =>
			page.evaluate(
				() => (window as any).__pluginNativeSettings.snapshot.plugins[0].settings.model,
			),
		)
		.toEqual({
			source: 'configured',
			hostId: 'local',
			connectionId: 'test-connection',
			modelId: 'test-model',
			thinkingModeId: 'brief',
		});
	await settings
		.getByRole('switch', { name: 'Enable Follow-up Prompts in Code', exact: true })
		.click();
	await expect(
		settings.getByRole('switch', { name: 'Enable Follow-up Prompts in Code', exact: true }),
	).not.toBeChecked();
	await expect(
		settings.getByRole('switch', { name: 'Enable Follow-up Prompts in Chat', exact: true }),
	).toBeChecked();
	await settings.getByText('Capabilities and authorization', { exact: true }).click();
	await expect(
		settings.getByText('Read visible text from the current conversation', { exact: true }),
	).toBeVisible();
	await expect(
		settings.getByText('Send plugin-provided text to the selected inference model', {
			exact: true,
		}),
	).toBeVisible();
	const primarySize = await settings
		.getByRole('spinbutton', { name: 'Recent exchanges', exact: true })
		.evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
	expect(primarySize).toBeGreaterThanOrEqual(13);
});
