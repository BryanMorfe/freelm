import { expect, test, type Page } from '@playwright/test';
import { initialState } from '../../src/lib/state';
import { defaultToolSettings } from '../../src/lib/tool-settings';
import { defaultSearchSettings } from '../../src/lib/search-settings';
import type { AppState } from '../../src/types';
import type { WebServiceInfo } from '../../src/agent-types';
import { setChecked, openRemoteSettings } from './ui-controls';

// Browser plugin not available. These tests use isolated Playwright workspaces.
// Flow: Settings → Search → configure SearXNG → enable browsing → save → reopen.
test.setTimeout(90_000);

async function openSettings(page: Page) {
	await page.goto('/');
	await expect(page).toHaveTitle('FreeLM');
	await expect(page.getByRole('heading', { name: 'What’s on your mind?' })).toBeVisible({
		timeout: 15_000,
	});
	await page.getByRole('button', { name: /Personal workspace/ }).click();
	const settings = page.getByRole('region', { name: 'Settings', exact: true });
	await settings.getByRole('button', { name: 'Search', exact: true }).click();
	return settings;
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

const discoveryInfo: WebServiceInfo = {
	serviceUrl: 'http://search.example.test:8080/searxng/',
	version: 'test-version',
	categories: ['general', 'images'],
	engines: [
		{
			name: 'fixture-search',
			enabled: true,
			categories: ['general'],
			paging: true,
			timeRangeSupport: true,
			safeSearch: false,
		},
		{
			name: 'fixture-images',
			enabled: false,
			categories: ['images'],
			paging: false,
			timeRangeSupport: false,
			safeSearch: true,
		},
	],
	health: 'ok',
	notices: ['Individual search engines can be unavailable.'],
};

async function desktopFixture(
	page: Page,
	state: AppState,
	options: { holdDiscovery?: boolean; discoveryError?: string; info?: WebServiceInfo } = {},
) {
	await page.addInitScript(
		(serialized) => {
			const {
				state: initial,
				options,
				info,
			} = JSON.parse(serialized) as {
				state: AppState;
				options: { holdDiscovery?: boolean; discoveryError?: string };
				info: WebServiceInfo;
			};
			const states = { local: structuredClone(initial), remote: structuredClone(initial) };
			let revision = 0;
			const control: any = {
				states,
				discoveries: [],
				pending: [],
				holdDiscovery: options.holdDiscovery ?? false,
				discoveryError: options.discoveryError,
			};
			(window as any).__webSettingsTest = control;
			const snapshot = (id: 'local' | 'remote') => ({
				state: structuredClone(states[id]),
				revision: String(revision),
			});
			(window as any).desktop = {
				platform: 'linux',
				workspaceLoad: async (id: 'local' | 'remote') => snapshot(id),
				workspaceSave: async (id: 'local' | 'remote', _revision: string, next: AppState) => {
					if (
						id === 'remote' &&
						JSON.stringify(next.toolSettings) !== JSON.stringify(states.remote.toolSettings)
					)
						throw new Error('Remote tool settings are host-owned.');
					states[id] = structuredClone(next);
					return { revision: String(++revision) };
				},
				storageInfo: async () => ({ secure: false, location: 'Isolated settings fixture' }),
				onPrepareClose: () => () => {},
				onToolApproval: () => () => {},
				instanceStatus: async () => ({
					host: { running: false, name: 'This computer', instanceId: 'local', port: 4319 },
					instances: [
						{
							id: 'remote',
							name: 'Remote search host',
							transport: 'direct',
							url: 'http://127.0.0.1:4319',
							connected: true,
							hasToken: true,
						},
					],
				}),
				instanceOpen: async (id: 'local' | 'remote') => snapshot(id),
				toolInspect: async () => ({ tools: [], skills: [], instructions: '', warnings: [] }),
				toolWebDiscover: async (...args: unknown[]) => {
					control.discoveries.push(structuredClone(args));
					if (control.holdDiscovery)
						return new Promise((resolve, reject) => control.pending.push({ resolve, reject }));
					if (control.discoveryError) throw new Error(control.discoveryError);
					return structuredClone(info);
				},
			};
		},
		JSON.stringify({ state, options, info: options.info ?? discoveryInfo }),
	);
}

test('SearXNG browsing enables independently of Code and images and persists across reopen', async ({
	page,
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (message) => {
		if (message.type() === 'error') errors.push(message.text());
	});
	const settings = await openSettings(page);
	await settings.getByRole('radio', { name: 'External', exact: true }).click();
	const web = settings.getByRole('region', { name: 'Web browsing', exact: true });
	const enabled = web.getByRole('switch', { name: 'Browse the web in Chat and Code', exact: true });
	const url = web.getByLabel('SearXNG service URL', { exact: true });
	await expect(url).toHaveValue('');
	await expect(enabled).not.toBeChecked();
	await expect(enabled).toBeDisabled();
	await expect(web).toContainText('Search text and images, and read web pages and PDFs');
	await expect(web).toContainText('search.formats');
	await url.fill('http://localhost:8080/searxng');
	await expect(enabled).toBeEnabled();
	await expect(
		web.getByRole('button', { name: 'Discover search engines', exact: true }),
	).toBeDisabled();
	await setChecked(enabled);
	await settings.getByRole('button', { name: 'Tools', exact: true }).click();
	await expect(
		settings.getByRole('switch', { name: 'Enable tools in Code', exact: true }),
	).not.toBeChecked();
	await expect(
		settings.getByRole('switch', { name: 'Generate images in Chat and Code', exact: true }),
	).not.toBeChecked();
	await settings.getByRole('button', { name: 'Search', exact: true }).click();
	await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
	await expect(settings.getByText('Settings saved', { exact: true })).toBeVisible();
	await expect
		.poll(async () => (await savedState(page)).toolSettings?.webBrowsing)
		.toEqual({
			...defaultSearchSettings(),
			mode: 'external',
			enabled: true,
			searxngUrl: 'http://localhost:8080/searxng',
		});
	await page.screenshot({ path: '/tmp/freelm-web-browsing-settings.png' });
	await page.setViewportSize({ width: 900, height: 700 });
	await web.scrollIntoViewIfNeeded();
	const cardBounds = await web.boundingBox();
	expect(cardBounds).not.toBeNull();
	expect(cardBounds!.x + cardBounds!.width).toBeLessThanOrEqual(900);
	await expect(url).toBeVisible();
	await page.screenshot({ path: '/tmp/freelm-web-browsing-settings-compact.png' });
	await page.setViewportSize({ width: 1440, height: 940 });
	await page.reload();
	await page.getByRole('button', { name: /Personal workspace/ }).click();
	await settings.getByRole('button', { name: 'Search', exact: true }).click();
	await expect(enabled).toBeChecked();
	await expect(url).toHaveValue('http://localhost:8080/searxng');
	await setChecked(enabled, false);
	await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
	await expect
		.poll(async () => (await savedState(page)).toolSettings?.webBrowsing)
		.toEqual({
			...defaultSearchSettings(),
			mode: 'external',
			enabled: false,
			searxngUrl: 'http://localhost:8080/searxng',
		});
	await expect(page.locator('vite-error-overlay')).toHaveCount(0);
	expect(errors).toEqual([]);
});

test('invalid SearXNG URLs explain the error, block enabling, and cannot be saved while enabled', async ({
	page,
}) => {
	const settings = await openSettings(page);
	await settings.getByRole('radio', { name: 'External', exact: true }).click();
	const web = settings.getByRole('region', { name: 'Web browsing', exact: true });
	const enabled = web.getByRole('switch', { name: 'Browse the web in Chat and Code', exact: true });
	const url = web.getByLabel('SearXNG service URL', { exact: true });
	for (const invalid of [
		'not a URL',
		'ftp://localhost/search',
		'https://user:password@example.com/search',
		'https://example.com/search?token=secret',
		'https://example.com/search#fragment',
	]) {
		await url.fill(invalid);
		await expect(url).toHaveAttribute('aria-invalid', 'true');
		await expect(web.locator('.error-note')).toBeVisible();
		await expect(enabled).toBeDisabled();
	}
	await url.fill('https://search.example.com/search');
	await expect(url).toHaveAttribute('aria-invalid', 'false');
	await expect(web.locator('.error-note')).toHaveCount(0);
	await setChecked(enabled);
	await url.fill('ftp://search.example.com/search');
	await expect(enabled).toBeEnabled();
	await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
	await expect(settings.getByRole('alert')).toBeVisible();
	await expect(settings.getByText('Settings saved', { exact: true })).toHaveCount(0);
	await url.fill('');
	await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
	await expect(settings.getByRole('alert')).toBeVisible();
	await url.fill('https://search.example.com/search');
	await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
	await expect(settings.getByText('Settings saved', { exact: true })).toBeVisible();
	await expect
		.poll(async () => (await savedState(page)).toolSettings?.webBrowsing)
		.toEqual({
			...defaultSearchSettings(),
			mode: 'external',
			enabled: true,
			searxngUrl: 'https://search.example.com/search',
		});
});

test('opening legacy tool settings leaves web browsing absent until the user edits it', async ({
	page,
}) => {
	const state = initialState();
	state.toolSettings = defaultToolSettings();
	delete state.toolSettings.webBrowsing;
	await desktopFixture(page, state);
	const settings = await openSettings(page);
	await expect(settings.getByRole('radio', { name: 'Built-in', exact: true })).toBeChecked();
	await settings.getByRole('button', { name: 'Back to workspace', exact: true }).click();
	await expect(settings).toHaveCount(0);
	await page.getByRole('button', { name: /Personal workspace/ }).click();
	await settings.getByRole('button', { name: 'Appearance', exact: true }).click();
	await settings.getByRole('radio', { name: 'Light', exact: true }).click();
	await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
	await expect(settings.getByText('Settings saved', { exact: true })).toBeVisible();
	const saved = await page.evaluate(() => (window as any).__webSettingsTest.states.local);
	expect(saved.toolSettings.webBrowsing).toBeUndefined();
	expect(saved.theme).toBe('light');
});

test('remote browsing configuration is read-only and remains unchanged when saving appearance', async ({
	page,
}) => {
	const state = initialState();
	state.toolSettings = {
		...defaultToolSettings(),
		webBrowsing: { enabled: true, searxngUrl: 'http://search.internal:8080/search' },
	};
	await desktopFixture(page, state);
	await page.goto('/');
	await openRemoteSettings(page);
	await page
		.getByRole('region', { name: 'Remote FreeLM workspaces' })
		.getByRole('button', { name: 'Open', exact: true })
		.click();
	await expect(page.locator('.instance-context-bar')).toContainText('Remote search host');
	await page.getByRole('button', { name: /Personal workspace/ }).click();
	const settings = page.getByRole('region', { name: 'Settings', exact: true });
	await settings.getByRole('button', { name: 'Search', exact: true }).click();
	const web = settings.getByRole('region', { name: 'Web browsing', exact: true });
	await expect(web.getByLabel('SearXNG service URL', { exact: true })).toBeDisabled();
	await expect(web.getByLabel('SearXNG service URL', { exact: true })).toHaveValue(
		'http://search.internal:8080/search',
	);
	await expect(
		web.getByRole('switch', { name: 'Browse the web in Chat and Code', exact: true }),
	).toBeDisabled();
	await expect(
		web.getByRole('button', { name: 'Discover search engines', exact: true }),
	).toBeDisabled();
	expect(await page.evaluate(() => (window as any).__webSettingsTest.discoveries)).toEqual([]);
	await expect(settings.getByText(/Configure it in Settings on that computer/)).toBeVisible();
	await settings.getByRole('button', { name: 'Appearance', exact: true }).click();
	await settings.getByRole('radio', { name: 'Light', exact: true }).click();
	await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
	await expect(settings.getByText('Settings saved', { exact: true })).toBeVisible();
	const saved = await page.evaluate(() => (window as any).__webSettingsTest.states.remote);
	expect(saved.toolSettings).toEqual(state.toolSettings);
	expect(saved.theme).toBe('light');
	await expect(settings.getByRole('alert')).toHaveCount(0);
});

test('engine discovery is read-only, shows live capabilities, and sends only the service URL', async ({
	page,
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	const state = initialState();
	state.connections[0].apiKey = 'fixture-api-key-not-for-web';
	state.toolSettings = {
		...defaultToolSettings(),
		webBrowsing: { enabled: false, searxngUrl: 'http://search.example.test:8080/searxng' },
	};
	await desktopFixture(page, state);
	const settings = await openSettings(page);
	const web = settings.getByRole('region', { name: 'Web browsing', exact: true });
	await web.getByRole('button', { name: 'Discover search engines', exact: true }).click();
	await expect(web.getByRole('status')).toContainText(
		'2 search engines discovered · SearXNG test-version',
	);
	await expect(web).toContainText('Service health check passed.');
	await expect(web).toContainText('Categories: general, images');
	await expect(web).toContainText('Individual search engines can be unavailable.');
	await web.getByText('Search engine details', { exact: true }).click();
	await expect(web).toContainText('including engines disabled by default');
	const engines = web.locator('li');
	await expect(engines).toHaveCount(2);
	await expect(engines.nth(0)).toContainText('Paging: yes · Time range: yes · SafeSearch: no');
	await expect(engines.nth(1)).toContainText('Disabled by default');
	await expect(engines.nth(1)).toContainText('Paging: no · Time range: no · SafeSearch: yes');
	await expect(
		web.getByRole('switch', { name: 'Browse the web in Chat and Code', exact: true }),
	).not.toBeChecked();
	await expect(web).not.toContainText('fixture-api-key-not-for-web');
	expect(await page.evaluate(() => (window as any).__webSettingsTest.discoveries)).toEqual([
		['http://search.example.test:8080/searxng'],
	]);
	expect(
		await page.evaluate(() => (window as any).__webSettingsTest.states.local.toolSettings),
	).toEqual(state.toolSettings);
	expect(
		await page.evaluate(() => (window as any).__webSettingsTest.states.local.connections),
	).toEqual(state.connections);
	await engines.last().scrollIntoViewIfNeeded();
	await page.screenshot({ path: '/tmp/freelm-web-engine-discovery.png' });
	await page.setViewportSize({ width: 900, height: 700 });
	await engines.last().scrollIntoViewIfNeeded();
	const bounds = await web.boundingBox();
	expect(bounds).not.toBeNull();
	expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(900);
	await page.screenshot({ path: '/tmp/freelm-web-engine-discovery-compact.png' });
	await page.setViewportSize({ width: 1440, height: 940 });
	await settings.getByRole('button', { name: 'Back to workspace', exact: true }).click();
	await expect(settings).toHaveCount(0);
	await expect(page.locator('vite-error-overlay')).toHaveCount(0);
	expect(errors).toEqual([]);
});

test('engine discovery errors and unavailable health remain distinct and do not enable browsing', async ({
	page,
}) => {
	const state = initialState();
	state.toolSettings = {
		...defaultToolSettings(),
		webBrowsing: { enabled: false, searxngUrl: 'http://search.example.test:8080' },
	};
	await desktopFixture(page, state, {
		discoveryError: 'Could not read SearXNG engine configuration.',
	});
	const settings = await openSettings(page);
	const web = settings.getByRole('region', { name: 'Web browsing', exact: true });
	await web.getByRole('button', { name: 'Discover search engines', exact: true }).click();
	await expect(web.getByRole('alert')).toHaveText('Could not read SearXNG engine configuration.');
	await expect(
		web.getByRole('button', { name: 'Discover search engines', exact: true }),
	).toBeEnabled();
	await expect(
		web.getByRole('switch', { name: 'Browse the web in Chat and Code', exact: true }),
	).not.toBeChecked();
	await page.evaluate(() => {
		(window as any).__webSettingsTest.discoveryError = undefined;
		(window as any).__webSettingsTest.holdDiscovery = true;
	});
	await web.getByRole('button', { name: 'Discover search engines', exact: true }).click();
	await expect(
		web.getByRole('button', { name: 'Discovering search engines…', exact: true }),
	).toBeDisabled();
	await page.evaluate(
		(info) =>
			(window as any).__webSettingsTest.pending[0].resolve({
				...info,
				health: 'unavailable',
				notices: ['Health check did not respond.'],
			}),
		discoveryInfo,
	);
	await expect(web).toContainText('Service health check unavailable.');
	await expect(web).toContainText('Health check did not respond.');
	await expect(web).toContainText(
		'Engine discovery does not guarantee that every engine can return search results.',
	);
	await expect(web.getByRole('alert')).toHaveCount(0);
	await expect(web.getByRole('status')).toContainText('2 search engines discovered');
});

test('URL changes and unmounting discard late engine discovery results', async ({ page }) => {
	const state = initialState();
	state.toolSettings = {
		...defaultToolSettings(),
		webBrowsing: { enabled: false, searxngUrl: 'http://first-search.example.test:8080' },
	};
	await desktopFixture(page, state, { holdDiscovery: true });
	const settings = await openSettings(page);
	const web = settings.getByRole('region', { name: 'Web browsing', exact: true });
	await web.getByRole('button', { name: 'Discover search engines', exact: true }).click();
	await expect(
		web.getByRole('button', { name: 'Discovering search engines…', exact: true }),
	).toBeDisabled();
	const url = web.getByLabel('SearXNG service URL', { exact: true });
	await expect(url).toBeEnabled();
	await url.fill('http://second-search.example.test:8080');
	await expect(
		web.getByRole('button', { name: 'Discover search engines', exact: true }),
	).toBeEnabled();
	await page.evaluate(
		(info) =>
			(window as any).__webSettingsTest.pending[0].resolve({ ...info, version: 'stale-first' }),
		discoveryInfo,
	);
	await expect(web.getByRole('status')).toHaveCount(0);
	await expect(web).not.toContainText('stale-first');
	await web.getByRole('button', { name: 'Discover search engines', exact: true }).click();
	await settings.getByRole('button', { name: 'Appearance', exact: true }).click();
	await page.evaluate(
		(info) =>
			(window as any).__webSettingsTest.pending[1].resolve({ ...info, version: 'stale-unmounted' }),
		discoveryInfo,
	);
	await settings.getByRole('button', { name: 'Search', exact: true }).click();
	await expect(web.getByRole('status')).toHaveCount(0);
	await expect(web).not.toContainText('stale-unmounted');
	await expect(
		web.getByRole('button', { name: 'Discover search engines', exact: true }),
	).toBeEnabled();
});
