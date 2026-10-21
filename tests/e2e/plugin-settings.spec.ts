import { expect, test, type Page } from '@playwright/test';
import { initialState } from '../../src/lib/state';
import type { PluginManifest } from '../../src/plugin-types';

// Browser plugin not available. Exercise real Settings with an isolated desktop bridge.
const manifest: PluginManifest = {
	manifestVersion: 1,
	id: 'example.mail',
	name: 'Example Mail',
	version: '1.0.0',
	description: 'Mail tools from an existing service.',
	author: 'Example team',
	mcp: { url: 'https://mail.example.com/mcp' },
	auth: {
		type: 'oauth2',
		clientId: 'desktop-client',
		authorizationUrl: 'https://mail.example.com/authorize',
		tokenUrl: 'https://mail.example.com/token',
		scopes: ['mail.read', 'mail.send'],
	},
};
async function fixture(page: Page, existing = true, pending = false) {
	await page.addInitScript(
		(serialized: string) => {
			const { state, manifest, existing, pending } = JSON.parse(serialized);
			const emptyAccess = () => ({
				chat: false,
				code: false,
				botIds: [],
				tools: [],
				allowRemote: false,
			});
			const tools = [
				{ name: 'search_mail', description: 'Search mailbox contents.', readOnly: true },
				{ name: 'send_mail', description: 'Send a message.', readOnly: false },
			];
			const control: any = {
				commands: [],
				fail: false,
				cancel: null,
				snapshot: {
					plugins: existing ? [{ manifest, enabled: true, installedAt: 1 }] : [],
					accounts: existing
						? [
								{
									id: 'personal',
									pluginId: manifest.id,
									label: 'Personal',
									status: 'connected',
									access: emptyAccess(),
									tools,
								},
							]
						: [],
				},
			};
			(window as any).__pluginsTest = control;
			(window as any).desktop = {
				platform: 'linux',
				workspaceLoad: async () => ({ state, revision: '1' }),
				workspaceSave: async () => ({ revision: '2' }),
				storageInfo: async () => ({ secure: true, location: 'Isolated plugin fixture' }),
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
					bots: [{ id: 'nova', name: 'Nova', address: 'nova@freelm' }],
					conversations: [],
					connections: [],
				}),
				pluginSnapshot: async () => structuredClone(control.snapshot),
				pluginCancelConnect: async () => control.cancel?.(),
				pluginCommand: async (command: any) => {
					control.commands.push(command);
					if (control.fail) {
						control.fail = false;
						throw new Error('Service unavailable. Please reconnect this account.');
					}
					switch (command.type) {
						case 'install':
							control.snapshot.plugins = [
								...control.snapshot.plugins.filter(
									(plugin: any) => plugin.manifest.id !== command.manifest.id,
								),
								{ manifest: command.manifest, enabled: false, installedAt: 1 },
							];
							break;
						case 'enable':
							control.snapshot.plugins = control.snapshot.plugins.map((plugin: any) =>
								plugin.manifest.id === command.pluginId
									? { ...plugin, enabled: command.enabled }
									: plugin,
							);
							break;
						case 'access':
							control.snapshot.accounts = control.snapshot.accounts.map((account: any) =>
								account.id === command.accountId ? { ...account, access: command.access } : account,
							);
							break;
						case 'discover':
							control.snapshot.accounts = control.snapshot.accounts.map((account: any) =>
								account.id === command.accountId
									? {
											...account,
											tools: [
												...tools,
												{ name: 'archive_mail', description: 'Archive messages.', readOnly: false },
											],
										}
									: account,
							);
							break;
						case 'connect':
							if (pending)
								await new Promise<void>((_resolve, reject) => {
									control.cancel = () => reject(new Error('Sign-in cancelled.'));
								});
							control.snapshot.accounts = [
								...control.snapshot.accounts.filter(
									(account: any) => account.id !== command.accountId,
								),
								{
									id: command.accountId || 'new-account',
									pluginId: command.pluginId,
									label: command.label,
									status: 'connected',
									access: emptyAccess(),
									tools,
								},
							];
							break;
						case 'disconnect':
							control.snapshot.accounts = control.snapshot.accounts.filter(
								(account: any) => account.id !== command.accountId,
							);
							break;
						case 'remove':
							control.snapshot.plugins = control.snapshot.plugins.filter(
								(plugin: any) => plugin.manifest.id !== command.pluginId,
							);
							control.snapshot.accounts = [];
							break;
					}
					return structuredClone(control.snapshot);
				},
			};
		},
		JSON.stringify({ state: initialState(), manifest, existing, pending }),
	);
	await page.goto('/');
	await expect(page).toHaveTitle('FreeLM');
	await page.getByRole('button', { name: 'Personal workspace settings', exact: true }).click();
	const settings = page.getByRole('region', { name: 'Settings', exact: true });
	await settings.getByRole('button', { name: 'Plugins', exact: true }).click();
	await expect(settings.getByRole('heading', { name: 'Plugins', exact: true })).toBeVisible();
	return settings;
}

test('review manifest identity and scopes before installation, then enable and connect a labeled account', async ({
	page,
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	const settings = await fixture(page, false);
	await settings.getByRole('button', { name: 'Install plugin', exact: true }).click();
	await settings.getByRole('textbox', { name: 'Manifest JSON' }).fill(JSON.stringify(manifest));
	await settings.getByRole('button', { name: 'Review manifest' }).click();
	await expect(settings.getByText('desktop-client', { exact: true })).toBeVisible();
	await expect(settings.getByText('mail.read, mail.send', { exact: true })).toBeVisible();
	await expect
		.poll(() => page.evaluate(() => (window as any).__pluginsTest.commands.length))
		.toBe(0);
	await settings.getByRole('button', { name: 'Install reviewed plugin' }).click();
	await expect(settings.getByRole('switch', { name: 'Enable Example Mail' })).not.toBeChecked();
	await settings.getByRole('switch', { name: 'Enable Example Mail' }).click();
	await settings.getByRole('button', { name: 'Add account', exact: true }).click();
	await settings.getByRole('textbox', { name: 'Account label' }).fill('Work');
	await settings.getByRole('button', { name: 'Sign in', exact: true }).click();
	await expect(settings.getByRole('heading', { name: 'Work', exact: true })).toBeVisible();
	await settings.locator('.plugin-permissions summary').click();
	for (const label of [
		'Allow Chat for Work',
		'Allow Code for Work',
		'Allow Nova for Work',
		'Allow tool search_mail for Work',
		'Allow tool send_mail for Work',
		'Allow remote clients for Work',
	])
		await expect(settings.getByRole('switch', { name: label, exact: true })).not.toBeChecked();
	await expect(settings.getByRole('button', { name: 'Save settings', exact: true })).toHaveCount(0);
	expect(errors).toEqual([]);
});

test('account permission grants use exact tools and bots, survive reopening, and keep new tools off', async ({
	page,
}) => {
	const settings = await fixture(page);
	await settings.locator('.plugin-permissions summary').click();
	await expect(settings.getByText(/without a separate prompt for each call/)).toBeVisible();
	await settings.getByRole('switch', { name: 'Allow Nova for Personal', exact: true }).click();
	await settings
		.getByRole('switch', { name: 'Allow tool search_mail for Personal', exact: true })
		.click();
	await expect
		.poll(() => page.evaluate(() => (window as any).__pluginsTest.snapshot.accounts[0].access))
		.toEqual({
			chat: false,
			code: false,
			botIds: ['nova'],
			tools: ['search_mail'],
			allowRemote: false,
		});
	await settings.getByRole('button', { name: 'Discover tools', exact: true }).click();
	await expect(
		settings.getByRole('switch', { name: 'Allow tool archive_mail for Personal' }),
	).not.toBeChecked();
	await settings.getByRole('button', { name: 'Appearance', exact: true }).click();
	await settings.getByRole('button', { name: 'Plugins', exact: true }).click();
	await settings.locator('.plugin-permissions summary').click();
	await expect(
		settings.getByRole('switch', { name: 'Allow tool search_mail for Personal', exact: true }),
	).toBeChecked();
	await expect(
		settings.getByRole('switch', { name: 'Allow Nova for Personal', exact: true }),
	).toBeChecked();
});

test('cancel OAuth, surface service failures, and disconnect without losing other settings', async ({
	page,
}) => {
	const settings = await fixture(page, true, true);
	await settings.getByRole('button', { name: 'Reconnect', exact: true }).click();
	await expect(settings.getByText('Complete sign-in in your browser.')).toBeVisible();
	await settings.getByRole('button', { name: 'Cancel sign-in', exact: true }).click();
	await expect(settings.getByRole('alert')).toContainText('Sign-in cancelled.');
	await page.evaluate(() => {
		(window as any).__pluginsTest.fail = true;
	});
	await settings.getByRole('button', { name: 'Discover tools', exact: true }).click();
	await expect(settings.getByRole('alert')).toContainText('Service unavailable.');
	await settings.getByRole('button', { name: 'Disconnect', exact: true }).click();
	await expect(
		settings.getByRole('heading', { name: 'Personal', exact: true, level: 4 }),
	).toHaveCount(0);
	await settings.getByRole('button', { name: 'Remove plugin', exact: true }).click();
	await expect(settings.getByRole('alert')).toContainText('Remove Example Mail');
	await settings.getByRole('button', { name: 'Remove and disconnect' }).click();
	await expect(settings.getByText('No plugins installed')).toBeVisible();
});

test('invalid manifests remain uninstalled and browser-only settings explain desktop requirement', async ({
	page,
}) => {
	const settings = await fixture(page, false);
	await settings.getByRole('button', { name: 'Install plugin', exact: true }).click();
	await settings.getByRole('textbox', { name: 'Manifest JSON' }).fill('{"manifestVersion":1}');
	await settings.getByRole('button', { name: 'Review manifest' }).click();
	await expect(settings.getByRole('alert')).toBeVisible();
	await expect
		.poll(() => page.evaluate(() => (window as any).__pluginsTest.commands.length))
		.toBe(0);
	await settings.getByRole('button', { name: 'Appearance', exact: true }).click();
	await page.evaluate(() => {
		delete (window as any).desktop.pluginSnapshot;
	});
	await settings.getByRole('button', { name: 'Plugins', exact: true }).click();
	await expect(settings.getByRole('heading', { name: 'Desktop app required' })).toBeVisible();
	await expect(settings.getByRole('button', { name: 'Install plugin', exact: true })).toHaveCount(
		0,
	);
});
