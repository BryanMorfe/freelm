import { expect, test, type Page } from '@playwright/test';
import { initialState } from '../../src/lib/state';
import { defaultToolSettings } from '../../src/lib/tool-settings';
import { defaultSearchSettings } from '../../src/lib/search-settings';
import type { SearchServiceStatus } from '../../src/agent-types';
import type { AppState } from '../../src/types';
import { setChecked, openRemoteSettings } from './ui-controls';

// Browser plugin not available. Isolated fixture: Settings → Search → save → start/stop.
test.setTimeout(90_000);
const stopped: SearchServiceStatus = {
	phase: 'stopped',
	version: 'bundled-fixture',
	selectedEngineNames: defaultSearchSettings().engines,
	engines: ['bing', 'brave', 'google', 'bing images', 'google images'].map((name) => ({
		name,
		enabled: name !== 'google',
		categories: [name.endsWith('images') ? 'images' : 'general'],
		paging: name !== 'bing',
		timeRangeSupport: name !== 'bing',
		safeSearch: true,
	})),
};
async function fixture(
	page: Page,
	options: {
		enabled?: boolean;
		holdStatus?: boolean;
		holdStart?: boolean;
		unavailable?: boolean;
	} = {},
) {
	const state = initialState();
	state.connections[0].apiKey = 'private-api-fixture-key';
	state.toolSettings = {
		...defaultToolSettings(),
		// Exercise browsing independence without relying on the Code-tools default.
		enabled: false,
		webBrowsing: { ...defaultSearchSettings(), enabled: options.enabled ?? false },
	};
	await page.addInitScript(
		(serialized) => {
			const { state, status, options } = JSON.parse(serialized);
			const control: any = {
				state,
				remote: structuredClone(state),
				listeners: new Set(),
				status,
				statusCalls: 0,
				startCalls: [],
				stopCalls: [],
				pendingStatus: [],
				pendingStart: [],
				holdStart: options.holdStart ?? false,
				error: '',
				publish: (next: SearchServiceStatus) => {
					control.status = next;
					for (const listener of control.listeners) listener(structuredClone(next));
				},
			};
			(window as any).__searchSettingsTest = control;
			let revision = 0;
			const snapshot = (id: 'local' | 'remote') => ({
				state: structuredClone(id === 'local' ? control.state : control.remote),
				revision: String(revision),
			});
			(window as any).desktop = {
				platform: 'linux',
				workspaceLoad: async (id: 'local' | 'remote') => snapshot(id),
				workspaceSave: async (id: 'local' | 'remote', _revision: string, next: AppState) => {
					if (id === 'local') control.state = structuredClone(next);
					else control.remote = structuredClone(next);
					return { revision: String(++revision) };
				},
				storageInfo: async () => ({ secure: false, location: 'Isolated search fixture' }),
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
				searchStatus: async () => {
					control.statusCalls++;
					if (options.holdStatus)
						return new Promise((resolve) => control.pendingStatus.push(resolve));
					return structuredClone(control.status);
				},
				onSearchStatus: (listener: (status: SearchServiceStatus) => void) => {
					control.listeners.add(listener);
					return () => control.listeners.delete(listener);
				},
				searchStart: async (...args: unknown[]) => {
					control.startCalls.push({
						args,
						settings: structuredClone(control.state.toolSettings.webBrowsing),
					});
					if (control.error) throw new Error(control.error);
					control.publish({ ...control.status, phase: 'starting' });
					if (control.holdStart)
						return new Promise((resolve, reject) => control.pendingStart.push({ resolve, reject }));
					control.publish({ ...control.status, phase: 'running', url: 'http://127.0.0.1:18992' });
					return structuredClone(control.status);
				},
				searchStop: async (...args: unknown[]) => {
					control.stopCalls.push(args);
					control.publish({ ...control.status, phase: 'stopping' });
					control.publish({ ...control.status, phase: 'stopped', url: undefined });
					return structuredClone(control.status);
				},
			};
		},
		JSON.stringify({
			state,
			status: options.unavailable
				? {
						...stopped,
						phase: 'unavailable',
						message: 'The bundled runtime is missing for this platform.',
					}
				: stopped,
			options,
		}),
	);
	return state;
}
async function openSearch(page: Page) {
	await page.goto('/');
	await expect(page).toHaveTitle('FreeLM');
	await expect(page.getByRole('heading', { name: 'What’s on your mind?' })).toBeVisible({
		timeout: 15_000,
	});
	await page.getByRole('button', { name: /Personal workspace/ }).click();
	const settings = page.getByRole('region', { name: 'Settings', exact: true });
	await settings.getByRole('button', { name: 'Search', exact: true }).click();
	await expect(settings.getByRole('heading', { name: 'Search', exact: true })).toBeVisible();
	return settings;
}

test('built-in search config saves independently and Start/Stop operate saved configuration', async ({
	page,
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (message) => {
		if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text());
	});
	const original = await fixture(page);
	const settings = await openSearch(page);
	const start = settings.getByRole('button', { name: 'Start search', exact: true });
	const stop = settings.getByRole('button', { name: 'Stop search', exact: true });
	await expect(settings.getByRole('radio', { name: 'Built-in', exact: true })).toBeChecked();
	await expect(
		settings.getByRole('status', { name: '' }).filter({ hasText: /^Stopped$/ }),
	).toBeVisible();
	await expect(settings.getByRole('heading', { name: 'Text search', exact: true })).toBeVisible();
	await expect(settings.getByRole('heading', { name: 'Image search', exact: true })).toBeVisible();
	const engineRow = settings.locator('.search-engine-row').first();
	const titleBounds = await engineRow.locator('strong').boundingBox();
	const switchBounds = await engineRow.getByRole('switch').boundingBox();
	expect(switchBounds!.x).toBeGreaterThan(titleBounds!.x + titleBounds!.width);
	await expect(start).toBeDisabled();
	await expect(stop).toBeDisabled();
	await setChecked(
		settings.getByRole('switch', { name: 'Browse the web in Chat and Code', exact: true }),
	);
	await setChecked(settings.getByRole('switch', { name: 'Start search with FreeLM', exact: true }));
	await setChecked(settings.getByRole('switch', { name: 'Enable google', exact: true }));
	await expect(start).toBeDisabled();
	await expect(settings).toContainText('Save your search changes before starting.');
	await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
	await expect(start).toBeEnabled();
	await start.click();
	await expect(settings.locator('.search-service-status')).toContainText('Running');
	await expect(settings.locator('.search-service-status')).toContainText('http://127.0.0.1:18992');
	await expect(stop).toBeEnabled();
	const control = await page.evaluate(() => ({
		state: (window as any).__searchSettingsTest.state,
		starts: (window as any).__searchSettingsTest.startCalls,
	}));
	expect(control.starts).toEqual([{ args: [], settings: control.state.toolSettings.webBrowsing }]);
	expect(control.state.toolSettings.webBrowsing).toEqual({
		...defaultSearchSettings(),
		enabled: true,
		autoStart: true,
		engines: [...defaultSearchSettings().engines, 'google'],
	});
	expect(control.state.connections).toEqual(original.connections);
	expect(control.state.toolSettings.enabled).toBe(false);
	expect(control.state.toolSettings.imageGeneration.enabled).toBe(false);
	await page.screenshot({ path: '/tmp/freelm-built-in-search-settings.png' });
	await page.setViewportSize({ width: 900, height: 700 });
	await settings.locator('.search-service-status').scrollIntoViewIfNeeded();
	const bounds = await settings.locator('.search-service-status').boundingBox();
	expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(900);
	await page.screenshot({ path: '/tmp/freelm-built-in-search-settings-compact.png' });
	await stop.click();
	await expect(settings.locator('.search-service-status')).toContainText('Stopped');
	await expect(start).toBeEnabled();
	expect(await page.evaluate(() => (window as any).__searchSettingsTest.stopCalls)).toEqual([[]]);
	await expect(page.locator('vite-error-overlay')).toHaveCount(0);
	expect(errors).toEqual([]);
});

test('status reading does not modify settings and subscriptions do not poll or survive leaving Search', async ({
	page,
}) => {
	const original = await fixture(page, { enabled: true, holdStatus: true });
	const settings = await openSearch(page);
	const initialReads = await page.evaluate(() => (window as any).__searchSettingsTest.statusCalls);
	expect(initialReads).toBeGreaterThan(0);
	expect(initialReads).toBeLessThanOrEqual(2); // Development StrictMode replays the mount effect.
	await expect(settings.locator('.search-service-status')).toContainText('Checking service…');
	await expect(settings.getByRole('button', { name: 'Start search', exact: true })).toBeDisabled();
	await page.evaluate((initial) => {
		const control = (window as any).__searchSettingsTest;
		control.publish({ ...initial, phase: 'running', url: 'http://127.0.0.1:18992' });
		for (const resolve of control.pendingStatus) resolve({ ...initial, phase: 'stopped' });
	}, stopped);
	await expect(settings.locator('.search-service-status')).toContainText('Running');
	expect(await page.evaluate(() => (window as any).__searchSettingsTest.statusCalls)).toBe(
		initialReads,
	);
	expect(
		await page.evaluate(() => (window as any).__searchSettingsTest.state.toolSettings),
	).toEqual(original.toolSettings);
	await settings.getByRole('button', { name: 'Appearance', exact: true }).click();
	expect(await page.evaluate(() => (window as any).__searchSettingsTest.listeners.size)).toBe(0);
	await page.evaluate(
		(initial) =>
			(window as any).__searchSettingsTest.publish({
				...initial,
				phase: 'error',
				message: 'Old hidden event.',
			}),
		stopped,
	);
	await settings.getByRole('button', { name: 'Search', exact: true }).click();
	await page.evaluate(() => {
		const control = (window as any).__searchSettingsTest;
		for (const resolve of control.pendingStatus) resolve(structuredClone(control.status));
	});
	await expect(settings.locator('.search-service-status')).toContainText('Old hidden event.');
	expect(await page.evaluate(() => (window as any).__searchSettingsTest.listeners.size)).toBe(1);
	expect(await page.evaluate(() => (window as any).__searchSettingsTest.statusCalls)).toBe(
		initialReads * 2,
	);
});

test('Stop cancels an in-progress startup and a late start reply cannot restore Running', async ({
	page,
}) => {
	await fixture(page, { enabled: true, holdStart: true });
	const settings = await openSearch(page);
	await settings.getByRole('button', { name: 'Start search', exact: true }).click();
	await expect(settings.locator('.search-service-status')).toContainText('Starting…');
	const stop = settings.getByRole('button', { name: 'Stop search', exact: true });
	await expect(stop).toBeEnabled();
	await stop.click();
	await expect(settings.locator('.search-service-status')).toContainText('Stopped');
	await page.evaluate(
		(initial) =>
			(window as any).__searchSettingsTest.pendingStart[0].resolve({
				...initial,
				phase: 'running',
				url: 'http://127.0.0.1:18992',
			}),
		stopped,
	);
	await expect(settings.getByRole('button', { name: 'Start search', exact: true })).toBeEnabled();
	await expect(settings.locator('.search-service-status')).not.toContainText('Running');
	await expect(settings.getByRole('alert')).toHaveCount(0);
});

test('startup errors and unavailable bundled runtimes are readable and do not enable work tools', async ({
	page,
}) => {
	await fixture(page, { enabled: true });
	const settings = await openSearch(page);
	await page.evaluate(() => {
		(window as any).__searchSettingsTest.error = 'SearXNG could not bind its local port.';
	});
	await settings.getByRole('button', { name: 'Start search', exact: true }).click();
	await expect(settings.getByRole('alert')).toHaveText('SearXNG could not bind its local port.');
	await expect(settings.getByRole('button', { name: 'Start search', exact: true })).toBeEnabled();
	await page.evaluate(
		(initial) =>
			(window as any).__searchSettingsTest.publish({
				...initial,
				phase: 'unavailable',
				message: 'The bundled runtime is missing for this platform.',
				logExcerpt: 'Fixture diagnostic line.',
			}),
		stopped,
	);
	await expect(settings.locator('.search-service-status')).toContainText(
		'The bundled runtime is missing for this platform.',
	);
	await expect(settings.getByRole('button', { name: 'Start search', exact: true })).toBeDisabled();
	await settings.getByText('Service logs', { exact: true }).click();
	await expect(settings.locator('.search-service-logs pre')).toHaveText('Fixture diagnostic line.');
});

test('built-in controls are read-only for a remote workspace', async ({ page }) => {
	await fixture(page, { enabled: true });
	await page.goto('/');
	await openRemoteSettings(page);
	await page
		.getByRole('region', { name: 'Remote FreeLM workspaces' })
		.getByRole('button', { name: 'Open', exact: true })
		.click();
	await page.getByRole('button', { name: /Personal workspace/ }).click();
	const settings = page.getByRole('region', { name: 'Settings', exact: true });
	await settings.getByRole('button', { name: 'Search', exact: true }).click();
	await expect(settings).toContainText('Configure it in Settings on that computer.');
	await expect(
		settings.getByRole('switch', { name: 'Browse the web in Chat and Code', exact: true }),
	).toBeDisabled();
	await expect(
		settings.getByRole('switch', { name: 'Start search with FreeLM', exact: true }),
	).toBeDisabled();
	await expect(settings.getByRole('button', { name: 'Start search', exact: true })).toBeDisabled();
	expect(await page.evaluate(() => (window as any).__searchSettingsTest.statusCalls)).toBe(0);
	expect(await page.evaluate(() => (window as any).__searchSettingsTest.startCalls)).toEqual([]);
});

test('Tools links to the Search page and a browser without a native bridge explains the unavailable service', async ({
	page,
}) => {
	await page.goto('/');
	await page.getByRole('button', { name: /Personal workspace/ }).click();
	const settings = page.getByRole('region', { name: 'Settings', exact: true });
	await settings.getByRole('button', { name: 'Tools', exact: true }).click();
	await settings.getByRole('button', { name: 'Open Search settings', exact: true }).click();
	await expect(settings.getByRole('heading', { name: 'Search', exact: true })).toBeVisible();
	await expect(settings).toContainText('Desktop app required');
	await expect(settings.getByRole('button', { name: 'Start search', exact: true })).toBeDisabled();
	await expect(settings.getByRole('button', { name: 'Stop search', exact: true })).toBeDisabled();
});
