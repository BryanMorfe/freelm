import { test, expect, type Page } from '@playwright/test';
import { initialState } from '../../src/lib/state';
import type { AppState } from '../../src/types';
test.setTimeout(180000);
async function fixture(page: Page) {
	let state = initialState();
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(e.message));
	const thread = (title: string) => ({
		id: 'same-thread',
		title,
		titleSource: 'manual' as const,
		connectionId: state.connections[0].id,
		model: '',
		thinkingMode: '',
		createdAt: 1,
		updatedAt: 1,
		messages: [
			{ id: 'answer', role: 'assistant' as const, content: title + ' reply', createdAt: 1 },
		],
	});
	state.threads = [thread('Local fixture')];
	const remote = { ...structuredClone(state), threads: [thread('Remote fixture')] };
	await page.exposeFunction('__feedbackLoad', (id: string) => ({
		state: structuredClone(id === 'local' ? state : remote),
		revision: '1',
		moderationSupported: true,
		personalizationSupported: true,
		codeCompactionSupported: true,
	}));
	await page.exposeFunction('__feedbackSave', (id: string, _revision: string, next: AppState) => {
		if (id === 'local') state = structuredClone(next);
		return { revision: '2' };
	});
	await page.addInitScript(() => {
		const w = window as any;
		w.__audio = [];
		w.__audioFailure = false;
		w.Audio = class {
			volume = 1;
			onended: any;
			constructor(public src: string) {}
			pause() {}
			async play() {
				if (w.__audioFailure) throw Error('Synthetic playback failure');
				w.__audio.push({ src: this.src, volume: this.volume });
			}
		};
		w.desktop = {
			platform: 'linux',
			workspaceLoad: (id: string) => w.__feedbackLoad(id),
			workspaceSave: (...args: any[]) => w.__feedbackSave(...args),
			instanceOpen: (id: string) => w.__feedbackLoad(id),
			instanceDisconnect: async () => {},
			storageInfo: async () => ({ secure: false, location: 'Disposable notification fixture' }),
			onPrepareClose: () => () => {},
			onChunk: () => () => {},
			cancel: async () => {},
			onHostTasksChanged: () => () => {},
			instanceStatus: async () => ({
				host: { instanceId: 'home', name: 'Local', running: false, port: 4319 },
				instances: [
					{
						id: 'remote',
						instanceId: 'remote-host',
						name: 'Remote',
						connected: true,
						hasToken: true,
						transport: 'ssh',
					},
				],
			}),
			onNotificationOpen: (cb: any) => {
				w.__openNotification = cb;
				return () => {};
			},
			notificationReady: async () => null,
			onBotResponseSound: (cb: any) => {
				w.__sound = cb;
				return () => {};
			},
			request: async () => {
				throw Error('No inference permitted');
			},
		};
	});
	await page.goto('/');
	await expect(page).toHaveTitle('FreeLM');
	await expect(page.locator('.app-shell')).toBeVisible();
	return { saved: () => state, errors };
}
async function settings(page: Page) {
	await page.getByRole('button', { name: 'Personal workspace settings', exact: true }).click();
	const region = page.getByRole('region', { name: 'Settings', exact: true });
	await region.getByRole('button', { name: 'Chat', exact: true }).click();
	return region;
}
test('sound defaults on, preview is explicit and saved mute survives cancel and relaunch', async ({
	page,
}) => {
	const f = await fixture(page);
	let region = await settings(page);
	const toggle = region.getByRole('switch', { name: 'Bot response sound', exact: true });
	await expect(toggle).toHaveAttribute('aria-checked', 'true');
	await expect(region.getByRole('slider', { name: 'Bot response volume' })).toHaveValue('100');
	expect(await page.evaluate(() => (window as any).__audio)).toEqual([]);
	await region.getByRole('button', { name: 'Preview background chime', exact: true }).click();
	await expect.poll(() => page.evaluate(() => (window as any).__audio.length)).toBe(1);
	await toggle.click();
	await region.getByRole('slider', { name: 'Bot response volume' }).fill('25');
	await region.getByRole('button', { name: 'Save settings', exact: true }).click();
	await expect.poll(() => f.saved().botResponseSound).toEqual({ muted: true, volume: 0.25 });
	await region.getByRole('button', { name: 'Back to workspace', exact: true }).click();
	await page.reload();
	region = await settings(page);
	await expect(
		region.getByRole('switch', { name: 'Bot response sound', exact: true }),
	).toHaveAttribute('aria-checked', 'false');
	await expect(region.getByRole('slider', { name: 'Bot response volume' })).toHaveValue('25');
	await page.setViewportSize({ width: 820, height: 900 });
	await region.getByRole('button', { name: 'Preview background chime', exact: true }).scrollIntoViewIfNeeded();
	await page.screenshot({ path: '/tmp/freelm-completion-settings-narrow.png' });
	await region.getByRole('switch', { name: 'Background notifications', exact: true }).click();
	await expect(
		region.getByRole('switch', { name: 'Bot response sound', exact: true }),
	).toBeDisabled();
	await region.getByRole('button', { name: 'Back to workspace', exact: true }).click();
	await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
	await expect.poll(() => f.saved().backgroundNotifications).not.toBe(false);
	expect(f.errors).toEqual([]);
	await expect(page.locator('vite-error-overlay')).toHaveCount(0);
});
test('preview failures are visible and keyboard retry succeeds without unsolicited sound', async ({
	page,
}) => {
	const f = await fixture(page);
	const region = await settings(page);
	await page.evaluate(() => {
		(window as any).__audioFailure = true;
	});
	const preview = region.getByRole('button', { name: 'Preview background chime', exact: true });
	await preview.focus();
	await page.keyboard.press('Enter');
	await expect(region.getByRole('alert')).toContainText('could not play');
	await page.evaluate(() => {
		(window as any).__audioFailure = false;
	});
	await preview.click();
	await expect(region.getByRole('alert')).toHaveCount(0);
	await expect.poll(() => page.evaluate(() => (window as any).__audio.length)).toBe(1);
	await page.screenshot({ path: '/tmp/freelm-completion-settings-desktop.png' });
	expect(f.errors).toEqual([]);
});
test('completion click opens its exact workspace and rejects a changed host instead of the same local ID', async ({
	page,
}) => {
	const f = await fixture(page);
	await page.waitForFunction(() => typeof (window as any).__openNotification === 'function');
	await page.evaluate(() =>
		(window as any).__openNotification({
			hostId: 'remote-host',
			workspaceId: 'remote',
			kind: 'thread',
			entityId: 'same-thread',
			runId: 'run',
		}),
	);
	await expect(page.locator('.message-content')).toContainText('Remote fixture reply');
	await page.evaluate(() =>
		(window as any).__openNotification({
			hostId: 'home',
			workspaceId: 'local',
			kind: 'thread',
			entityId: 'same-thread',
			runId: 'run',
		}),
	);
	await expect(page.locator('.message-content')).toContainText('Local fixture reply');
	await page.evaluate(() =>
		(window as any).__openNotification({
			hostId: 'replaced',
			workspaceId: 'remote',
			kind: 'thread',
			entityId: 'same-thread',
			runId: 'run',
		}),
	);
	await expect(
		page.getByText(/computer for this notification was removed or changed/),
	).toBeVisible();
	await expect(page.locator('.message-content')).toContainText('Local fixture reply');
	await page.evaluate(() =>
		(window as any).__openNotification({
			hostId: 'home',
			workspaceId: 'local',
			kind: 'thread',
			entityId: 'deleted',
			runId: 'run',
		}),
	);
	await expect(page.getByRole('alert')).toContainText('This conversation is no longer available.');
	await page.getByRole('button', { name: 'Dismiss notification error' }).click();
	await expect(page.getByRole('alert')).toHaveCount(0);
	expect(f.errors).toEqual([]);
});

test('notification navigation respects unsaved settings and Keep editing', async ({ page }) => {
	const f = await fixture(page);
	const region = await settings(page);
	await region.getByRole('switch', { name: 'Bot response sound', exact: true }).click();
	const click = () =>
		page.evaluate(() =>
			(window as any).__openNotification({
				hostId: 'home',
				workspaceId: 'local',
				kind: 'thread',
				entityId: 'same-thread',
				runId: 'draft-run',
			}),
		);
	await click();
	await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
	await expect(
		region.getByRole('switch', { name: 'Bot response sound', exact: true }),
	).toHaveAttribute('aria-checked', 'false');
	await click();
	await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
	await expect(region).toHaveCount(0);
	await expect(page.locator('.message-content')).toContainText('Local fixture reply');
	expect(f.saved().botResponseSound?.muted ?? false).toBe(false);
	expect(f.errors).toEqual([]);
});

test('foreground cue uses a distinct asset and drops stale focus events', async ({ page }) => {
 await fixture(page);
 await page.evaluate(() => {
  Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  (window as any).__sound(.25, 'message');
  (window as any).__sound(.25);
 });
 let audio = await page.evaluate(() => (window as any).__audio);
 expect(audio).toHaveLength(1);
 expect(audio[0].src).toContain('bot-message');
 expect(audio[0].volume).toBe(.25);
 await page.evaluate(() => {
  Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
  (window as any).__sound(.35, 'message');
  (window as any).__sound(.35);
 });
 audio = await page.evaluate(() => (window as any).__audio);
 expect(audio).toHaveLength(2);
 expect(audio[1].src).toContain('bot-response');
});
