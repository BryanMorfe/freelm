import { expect, test, type Page } from '@playwright/test';
import { initialState } from '../../src/lib/state';
import { defaultToolSettings } from '../../src/lib/tool-settings';
import type { AppState } from '../../src/types';
import { selectConversationMode } from './helpers/conversation-mode';
import { openRemoteSettings } from './ui-controls';

// Browser plugin not available. Exercise the real App through its desktop bridge;
// directory creation is isolated so acceptance checks never touch the user's files.
// Allow full desktop/remote settings flows on shared native-build machines.
test.describe.configure({ timeout: 120_000 });

async function fixture(page: Page) {
	const initial = initialState();
	initial.toolSettings = {
		...defaultToolSettings(),
		enabled: true,
		workspaceRoot: '/tmp/default-workspace',
	};
	initial.projects = [];
	initial.threads = [];
	await page.addInitScript((serialized: string) => {
		const initial = JSON.parse(serialized) as AppState;
		const saved = sessionStorage.getItem('project-directories-state');
		const control: any = {
			states: saved
				? JSON.parse(saved)
				: { local: structuredClone(initial), remote: structuredClone(initial) },
			revisions: { local: 0, remote: 0 },
			creations: [],
			hold: false,
			failure: '',
			createdPath: '/Users/test/Documents/FreeLM/Weekend App (2)',
		};
		(window as any).__projectDirectories = control;
		const snapshot = (id: string) => ({
			state: structuredClone(control.states[id]),
			revision: String(control.revisions[id]),
			memorySupported: true,
			personalizationSupported: true,
			codeCompactionSupported: true,
			moderationSupported: true,
		});
		(window as any).desktop = {
			platform: 'darwin',
			workspaceLoad: async (id: string) => snapshot(id),
			workspaceSave: async (id: string, _revision: string, state: AppState) => {
				control.states[id] = structuredClone(state);
				sessionStorage.setItem('project-directories-state', JSON.stringify(control.states));
				return { revision: String(++control.revisions[id]) };
			},
			storageInfo: async () => ({ secure: true, location: '/test/.freelm/config.json' }),
			instanceStatus: async () => ({
				host: { running: false, name: 'This computer', instanceId: 'local', port: 4319 },
				instances: [
					{
						id: 'remote',
						name: 'Remote test host',
						transport: 'direct',
						connected: true,
						hasToken: true,
						url: 'http://127.0.0.1:4319',
					},
				],
			}),
			instanceOpen: async (id: string) => snapshot(id),
			instanceDisconnect: async () => {},
			onPrepareClose: () => () => {},
			onToolApproval: () => () => {},
			onChunk: () => () => {},
			cancel: async () => {},
			toolCancel: async () => {},
			toolPickDirectory: async () => '/tmp/explicit-project',
			projectCreateDirectory: async (name: string) => {
				control.creations.push(name);
				if (control.hold)
					await new Promise<void>((resolve) => {
						control.release = resolve;
					});
				if (control.failure) throw new Error(control.failure);
				return control.createdPath;
			},
		};
	}, JSON.stringify(initial));
	await page.goto('/');
	await expect(page).toHaveTitle('FreeLM');
	await expect(page.getByRole('heading', { name: 'What’s on your mind?' })).toBeVisible();
}

async function createProject(page: Page, name: string) {
	await page.getByRole('button', { name: 'New project', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Create a project', exact: true });
	await dialog.getByLabel('Project name', { exact: true }).fill(name);
	return dialog;
}

async function projects(page: Page, workspace = 'local') {
	return page.evaluate(
		(workspace) => (window as any).__projectDirectories.states[workspace].projects,
		workspace,
	);
}

test('name-only Code projects bind the host-created path and retain it across reload and rename', async ({
	page,
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await fixture(page);
	await selectConversationMode(page, 'Code');
	const dialog = await createProject(page, 'Weekend App');
	await expect(dialog.getByLabel('Project directories')).toHaveValue('');
	await expect(dialog).toContainText('~/Documents/FreeLM/');
	await page.screenshot({ path: '/tmp/freelm-project-directory-wide.png' });
	await page.setViewportSize({ width: 800, height: 700 });
	await expect(
		dialog.getByRole('button', { name: 'Create project', exact: true }),
	).toBeInViewport();
	await page.screenshot({ path: '/tmp/freelm-project-directory-narrow.png' });
	await dialog.getByRole('button', { name: 'Create project', exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await expect
		.poll(() => projects(page))
		.toEqual([
			expect.objectContaining({
				name: 'Weekend App',
				kind: 'code',
				directories: ['/Users/test/Documents/FreeLM/Weekend App (2)'],
			}),
		]);
	expect(await page.evaluate(() => (window as any).__projectDirectories.creations)).toEqual([
		'Weekend App',
	]);
	await page.reload({ waitUntil: 'domcontentloaded' });
	await selectConversationMode(page, 'Code');
	await page.getByRole('button', { name: 'Weekend App', exact: true }).hover();
	await page.getByRole('button', { name: 'Edit project Weekend App', exact: true }).click();
	const edit = page.getByRole('dialog', { name: 'Edit project', exact: true });
	await expect(edit.getByLabel('Project directories')).toHaveValue(
		'/Users/test/Documents/FreeLM/Weekend App (2)',
	);
	await edit.getByLabel('Project name').fill('Renamed Weekend App');
	await edit.getByRole('button', { name: 'Save project', exact: true }).click();
	await expect
		.poll(() => projects(page))
		.toEqual([
			expect.objectContaining({
				name: 'Renamed Weekend App',
				directories: ['/Users/test/Documents/FreeLM/Weekend App (2)'],
			}),
		]);
	expect(await page.evaluate(() => (window as any).__projectDirectories.creations)).toEqual([]);
	expect(errors).toEqual([]);
	await expect(page.locator('vite-error-overlay')).toHaveCount(0);
});

test('pending directory creation cannot submit the same project twice', async ({ page }) => {
	await fixture(page);
	await selectConversationMode(page, 'Code');
	await page.evaluate(() => {
		(window as any).__projectDirectories.hold = true;
	});
	const dialog = await createProject(page, 'Weekend App');
	await dialog.getByRole('button', { name: 'Create project', exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => (window as any).__projectDirectories.creations.length))
		.toBe(1);
	await expect(dialog.locator('.primary-button')).toBeDisabled();
	await expect(dialog.getByLabel('Project name')).toBeDisabled();
	await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
	await expect(dialog.getByRole('button', { name: 'Close dialog', exact: true })).toBeDisabled();
	await page.keyboard.press('Enter');
	await expect(dialog).toBeVisible();
	expect(await projects(page)).toEqual([]);
	expect(await page.evaluate(() => (window as any).__projectDirectories.creations)).toEqual([
		'Weekend App',
	]);
	await page.evaluate(() => {
		(window as any).__projectDirectories.release();
	});
	await expect(dialog).toHaveCount(0);
	await expect.poll(() => projects(page)).toHaveLength(1);
});

test('directory failure preserves the project form and permits retry', async ({ page }) => {
	await fixture(page);
	await selectConversationMode(page, 'Code');
	await page.evaluate(() => {
		(window as any).__projectDirectories.failure = 'The Documents folder is not writable.';
	});
	const dialog = await createProject(page, 'Weekend App');
	await dialog.getByLabel('Project instructions').fill('Keep the project instructions.');
	await dialog.getByRole('button', { name: 'Create project', exact: true }).click();
	await expect(dialog.getByRole('alert')).toContainText('The Documents folder is not writable.');
	await expect(dialog.getByLabel('Project name')).toHaveValue('Weekend App');
	await expect(dialog.getByLabel('Project instructions')).toHaveValue(
		'Keep the project instructions.',
	);
	expect(await projects(page)).toEqual([]);
	await page.evaluate(() => {
		(window as any).__projectDirectories.failure = '';
	});
	await dialog.getByRole('button', { name: 'Create project', exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await expect
		.poll(() => projects(page))
		.toEqual([
			expect.objectContaining({
				name: 'Weekend App',
				instructions: 'Keep the project instructions.',
				directories: ['/Users/test/Documents/FreeLM/Weekend App (2)'],
			}),
		]);
});

test('Chat and explicitly bound Code projects do not create automatic directories', async ({
	page,
}) => {
	await fixture(page);
	const chat = await createProject(page, 'Ideas');
	await expect(chat.getByLabel('Project directories')).toHaveCount(0);
	await chat.getByRole('button', { name: 'Create project', exact: true }).click();
	await expect(chat).toHaveCount(0);
	await selectConversationMode(page, 'Code');
	const code = await createProject(page, 'Existing code');
	await code.getByRole('button', { name: 'Add folder', exact: true }).click();
	await expect(code.getByLabel('Project directories')).toHaveValue('/tmp/explicit-project');
	await code.getByRole('button', { name: 'Create project', exact: true }).click();
	await expect(code).toHaveCount(0);
	await expect
		.poll(() => projects(page))
		.toEqual([
			expect.objectContaining({ name: 'Ideas', kind: 'chat' }),
			expect.objectContaining({
				name: 'Existing code',
				kind: 'code',
				directories: ['/tmp/explicit-project'],
			}),
		]);
	expect((await projects(page))[0].directories).toBeUndefined();
	expect(await page.evaluate(() => (window as any).__projectDirectories.creations)).toEqual([]);
});

test('remote projects never create a directory on this computer', async ({ page }) => {
	await fixture(page);
	await openRemoteSettings(page);
	await page
		.getByRole('region', { name: 'Remote FreeLM workspaces' })
		.getByRole('button', { name: 'Open', exact: true })
		.click();
	await expect(page.locator('.instance-context-bar')).toContainText('Remote test host');
	await selectConversationMode(page, 'Code');
	const dialog = await createProject(page, 'Remote project');
	await expect(dialog.getByLabel('Project directories')).toHaveAttribute('readonly', '');
	await expect(dialog).toContainText('Directory bindings are managed on the host computer');
	await dialog.getByRole('button', { name: 'Create project', exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await expect
		.poll(() => projects(page, 'remote'))
		.toEqual([expect.objectContaining({ name: 'Remote project', kind: 'code' })]);
	expect((await projects(page, 'remote'))[0].directories).toBeUndefined();
	expect(await projects(page)).toEqual([]);
	expect(await page.evaluate(() => (window as any).__projectDirectories.creations)).toEqual([]);
});
