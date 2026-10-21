import { expect, test, type Page } from '@playwright/test';
import { initialState } from '../../src/lib/state';
import type { PluginLocalManifest } from '../../src/plugin-types';
// Browser plugin unavailable: isolated bridge + actual App in installed Chrome.
const manifest: PluginLocalManifest = {
	manifestVersion: 2,
	id: 'sample.notes',
	name: 'Sample Notes',
	version: '1.0.0',
	author: 'Sample author',
	description: 'A local account notebook.',
	runtime: { apiVersion: 1, entry: 'runtime.ts' },
	auth: { type: 'none' },
	permissions: { network: ['https://notes.example.com'], storage: true },
	contributes: {
		tools: [
			{
				name: 'read_note',
				description: 'Read a stored note.',
				parameters: { type: 'object' },
				readOnly: true,
			},
		],
		tabs: [{ id: 'notes', title: 'Notebook', entry: 'ui.ts', icon: 'notebook' }],
		actions: ['read_note', 'save_note'],
	},
};
const content = `<!doctype html><html data-theme="__FREELM_PLUGIN_THEME__"><body><p id="status">Ready</p><textarea aria-label="Note">A private note</textarea><button id="save">Save note</button><button id="attack">Undeclared action</button><script>
const nonce='__FREELM_PLUGIN_CHANNEL__';let id=0;
function invoke(action,args={}){parent.postMessage({protocol:'freelm-plugin-ui-v1',nonce,id:String(++id),action,args,pluginId:'evil',tabId:'evil',accountId:'evil'},'*')}
document.getElementById('save').onclick=()=>invoke('save_note',{content:document.querySelector('textarea').value});
document.getElementById('attack').onclick=()=>invoke('unlisted',{});
addEventListener('message',e=>{if(e.source===parent&&e.data.protocol==='freelm-plugin-ui-v1'&&e.data.nonce===nonce)document.getElementById('status').textContent=e.data.error||JSON.stringify(e.data.result)});
</script></body></html>`;
async function fixture(page: Page, empty = false, accounts = true) {
	await page.addInitScript(
		(serialized: string) => {
			const { state, manifest, content, empty, accounts } = JSON.parse(serialized);
			const access = { chat: false, code: false, botIds: [], tools: [], allowRemote: false };
			const control: any = {
				calls: [],
				contentRequests: [],
				prepares: [],
				installs: [],
				snapshot: {
					plugins: empty
						? []
						: [
								{
									manifest,
									enabled: true,
									installedAt: 1,
									package: { hash: 'fixturehash', installedBytes: 1000 },
								},
							],
					accounts: accounts
						? [
								{
									id: 'one',
									pluginId: manifest.id,
									label: 'Personal',
									status: 'connected',
									tools: [],
									access,
								},
								{
									id: 'two',
									pluginId: manifest.id,
									label: 'Work',
									status: 'connected',
									tools: [],
									access,
								},
							]
						: [],
				},
			};
			(window as any).__runtimeUI = control;
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
					bots: [],
					conversations: [],
					connections: [],
				}),
				pluginSnapshot: async () => structuredClone(control.snapshot),
				pluginCancelConnect: async () => {},
				pluginCommand: async (command: any) => {
					if (command.type === 'enable') control.snapshot.plugins[0].enabled = command.enabled;
					return structuredClone(control.snapshot);
				},
				pluginPreparePackage: async (bytes: number[]) => {
					control.prepares.push(bytes.length);
					return { reviewId: 'review-1', manifest, files: 3, bytes: 1000 };
				},
				pluginInstallPackage: async (reviewId: string) => {
					control.installs.push(reviewId);
					await new Promise<void>((resolve) => {
						control.finishInstall = resolve;
					});
					control.snapshot.plugins = [
						{
							manifest,
							enabled: false,
							installedAt: 1,
							package: { hash: 'fixturehash', installedBytes: 1000 },
						},
					];
					return structuredClone(control.snapshot);
				},
				pluginTabContent: async (...args: any[]) => {
					control.contentRequests.push(args);
					return { html: content };
				},
				pluginInvokeAction: async (...args: any[]) => {
					control.calls.push(args);
					return { savedTo: args[2] };
				},
			};
		},
		JSON.stringify({ state: initialState(), manifest, content, empty, accounts }),
	);
	await page.goto('/');
	await expect(page).toHaveTitle('FreeLM');
}
async function openTab(page: Page) {
	await page.getByRole('button', { name: 'Notebook · Sample Notes', exact: true }).click();
	await expect(page.getByRole('region', { name: 'Sample Notes plugin' })).toBeVisible();
}

test('ZIP review precedes compile/install and enabling adds the tab without changing built-in mode', async ({
	page,
}) => {
	await fixture(page, true);
	await page.getByRole('button', { name: 'Personal workspace settings', exact: true }).click();
	const settings = page.getByRole('region', { name: 'Settings', exact: true });
	await settings.getByRole('button', { name: 'Plugins', exact: true }).click();
	await settings.getByRole('button', { name: 'Install plugin', exact: true }).click();
	await settings.getByLabel('Choose plugin ZIP', { exact: true }).setInputFiles({
		name: 'notes.zip',
		mimeType: 'application/zip',
		buffer: Buffer.from([80, 75, 3, 4]),
	});
	await expect(settings.getByRole('heading', { name: 'Review plugin' })).toBeVisible();
	await expect(settings.getByText('https://notes.example.com', { exact: true })).toBeVisible();
	await expect(
		settings.getByText('Private storage for each account', { exact: true }),
	).toBeVisible();
	await expect(settings.getByText('read_note, save_note', { exact: true })).toBeVisible();
	await expect.poll(() => page.evaluate(() => (window as any).__runtimeUI.installs)).toEqual([]);
	await settings.getByRole('button', { name: 'Install reviewed plugin' }).click();
	await expect(settings.getByText('Compiling and installing plugin…')).toBeVisible();
	await page.evaluate(() => (window as any).__runtimeUI.finishInstall());
	await expect(settings.getByRole('switch', { name: 'Enable Sample Notes' })).not.toBeChecked();
	await expect(
		page.getByRole('button', { name: 'Notebook · Sample Notes', exact: true }),
	).toHaveCount(0);
	await settings.getByRole('switch', { name: 'Enable Sample Notes' }).click();
	await openTab(page);
	await expect(
		page.frameLocator('.plugin-workspace-frame').getByRole('button', { name: 'Save note' }),
	).toBeVisible();
	await page.getByRole('button', { name: 'Home', exact: true }).click();
	await expect(page.getByRole('region', { name: 'Sample Notes plugin' })).toHaveCount(0);
});

test('sandbox bridge isolates frame source, nonce, declared actions, and selected account', async ({
	page,
}) => {
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(e.message));
	await fixture(page);
	await openTab(page);
	const iframe = page.locator('.plugin-workspace-frame');
	await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
	const frame = page.frameLocator('.plugin-workspace-frame');
	await frame.getByRole('button', { name: 'Save note' }).click();
	const firstContentRequest = await page.evaluate(() =>
		(window as any).__runtimeUI.contentRequests.at(-1),
	);
	expect(firstContentRequest).toEqual([
		'sample.notes',
		'notes',
		{
			nonce: expect.stringMatching(/^[a-f0-9-]{36}$/),
			theme: expect.stringMatching(/^(light|dark)$/),
		},
	]);
	await expect(frame.locator('#status')).toContainText('"savedTo":"one"');
	await expect
		.poll(() => page.evaluate(() => (window as any).__runtimeUI.calls[0]))
		.toEqual(['sample.notes', 'notes', 'one', 'save_note', { content: 'A private note' }]);
	await page.evaluate(() => {
		const html = document.querySelector('iframe')!.srcdoc;
		const nonce = html.match(/const nonce='([^']+)'/)![1];
		window.postMessage(
			{ protocol: 'freelm-plugin-ui-v1', nonce, id: 'forged', action: 'save_note', args: {} },
			'*',
		);
	});
	await frame.getByRole('button', { name: 'Undeclared action' }).click();
	await expect(frame.locator('#status')).toContainText('not declared');
	await expect.poll(() => page.evaluate(() => (window as any).__runtimeUI.calls.length)).toBe(1);
	await page.getByRole('combobox', { name: 'Plugin account' }).click();
	await page.getByRole('option', { name: 'Work', exact: true }).click();
	await frame.getByRole('button', { name: 'Save note' }).click();
	await expect(frame.locator('#status')).toContainText('"savedTo":"two"');
	const secondContentRequest = await page.evaluate(() =>
		(window as any).__runtimeUI.contentRequests.at(-1),
	);
	expect(secondContentRequest[2].nonce).not.toBe(firstContentRequest[2].nonce);
	await expect.poll(() => page.evaluate(() => (window as any).__runtimeUI.calls[1][2])).toBe('two');
	await page.evaluate(() => {
		(window as any).__runtimeUI.snapshot.plugins[0].enabled = false;
		window.dispatchEvent(new Event('freelm:plugins-changed'));
	});
	await expect(iframe).toHaveCount(0);
	await expect(
		page.getByRole('button', { name: 'Notebook · Sample Notes', exact: true }),
	).toHaveCount(0);
	expect(errors).toEqual([]);
});

test('plugin without a connected account shows setup and never mounts its frame', async ({
	page,
}) => {
	await fixture(page, false, false);
	await openTab(page);
	await expect(
		page.getByRole('heading', { name: 'Connect an account to get started' }),
	).toBeVisible();
	await expect(page.locator('.plugin-workspace-frame')).toHaveCount(0);
	await page.getByRole('button', { name: 'Open plugin settings' }).click();
	await expect(page.getByRole('heading', { name: 'Plugins', exact: true })).toBeVisible();
	await expect.poll(() => page.evaluate(() => (window as any).__runtimeUI.calls.length)).toBe(0);
});
