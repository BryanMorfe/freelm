import { expect, type Page } from '@playwright/test';
import { unzipSync } from 'fflate';
import { initialState } from '../../../src/lib/state';
import { validatePluginManifest } from '../../../src/lib/plugin-manifest';
import type { PluginManifest } from '../../../src/plugin-types';
// Browser plugin not available. Exercise real Settings with an isolated desktop bridge.
export const manifest: PluginManifest = {
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
export async function pluginFixture(
	page: Page,
	{ existing = true, pending = false, selectExisting = true, light = false } = {},
) {
	await page.exposeFunction('__prepareIncludedPackage', (bytes: number[]) => {
		const files = unzipSync(Uint8Array.from(bytes));
		return {
			manifest: validatePluginManifest(
				JSON.parse(new TextDecoder().decode(files['manifest.json'])),
			),
			files: Object.keys(files).length,
			bytes: Object.values(files).reduce((sum, file) => sum + file.length, 0),
		};
	});
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
				prepared: [],
				installs: [],
				failPrepare: false,
				review: null,
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
				pluginPreparePackage: async (bytes: number[]) => {
					control.prepared.push(bytes.length);
					if (control.failPrepare) {
						control.failPrepare = false;
						throw new Error('Synthetic package inspection failed. Try again.');
					}
					const preview = await (window as any).__prepareIncludedPackage(bytes);
					control.review = preview.manifest;
					return { ...preview, reviewId: 'included-review' };
				},
				pluginInstallPackage: async (reviewId: string) => {
					control.installs.push(reviewId);
					control.snapshot.plugins = [
						...control.snapshot.plugins.filter(
							(plugin: any) => plugin.manifest.id !== control.review.id,
						),
						{ manifest: control.review, enabled: false, installedAt: 2 },
					];
					return structuredClone(control.snapshot);
				},
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
		JSON.stringify({
			state: { ...initialState(), theme: light ? 'light' : 'dark' },
			manifest,
			existing,
			pending,
		}),
	);
	await page.goto('/');
	await expect(page).toHaveTitle('FreeLM');
	await page
		.getByRole('navigation', { name: 'Workspaces', exact: true })
		.getByRole('button', { name: 'Plugins', exact: true })
		.click();
	const settings = page.getByRole('region', { name: 'Plugins', exact: true });
	await expect(
		settings.getByRole('heading', { name: 'Plugins', exact: true, level: 1 }),
	).toBeVisible();
	if (existing && selectExisting)
		await settings.getByRole('button', { name: 'View Example Mail', exact: true }).click();
	return settings;
}
