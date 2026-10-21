import { selectConversationMode } from './helpers/conversation-mode';
import { expect, test, type Page } from '@playwright/test';
import { initialState } from '../../src/lib/state';
import type { AppState } from '../../src/types';

// Browser plugin not available: use the repository's Playwright workflow.
// Only private in-memory state and metadata are used, never provider calls or user files.
async function fixture(page: Page) {
	const state = initialState();
	const connection = state.connections[0];
	connection.models.chat = 'completion-model';
	connection.catalog = [
		{
			id: 'completion-model',
			name: 'Completion model',
			enabled: true,
			tasks: ['chat'],
			inputModalities: ['text'],
			outputModalities: ['text'],
			thinkingModes: [
				{ id: 'low', name: 'Low', parameters: { responses: { reasoning: { effort: 'low' } } } },
			],
		},
	];
	state.projects = [
		{
			id: 'repository',
			kind: 'code',
			name: 'Repository',
			directories: ['/tmp/completion-repository'],
			instructions: '',
			createdAt: 1,
		},
	];
	state.threads = [
		{
			id: 'completion-task',
			kind: 'code',
			title: 'Completion task',
			titleSource: 'manual',
			projectId: 'repository',
			connectionId: connection.id,
			model: 'completion-model',
			thinkingMode: 'low',
			createdAt: 1,
			updatedAt: 1,
			messages: [],
		},
	];
	await page.addInitScript((serialized) => {
		let current: AppState = JSON.parse(serialized),
			revision = 0;
		(window as any).__completionFixture = { state: () => current, discovery: [] as any[] };
		(window as any).desktop = {
			platform: 'linux',
			workspaceLoad: async () => ({ state: structuredClone(current), revision: String(revision) }),
			workspaceSave: async (_id: string, _revision: string, next: AppState) => {
				current = structuredClone(next);
				return { revision: String(++revision) };
			},
			storageInfo: async () => ({ secure: false, location: 'Private completion fixture' }),
			onPrepareClose: () => () => {},
			onToolApproval: () => () => {},
			onChunk: () => () => {},
			instanceStatus: async () => ({
				host: { running: false, name: 'Local', instanceId: 'local', port: 4319 },
				instances: [],
			}),
			composerDiscover: async (request: any) => {
				(window as any).__completionFixture.discovery.push(request);
				if (request.query === 'old') await new Promise((resolve) => setTimeout(resolve, 500));
				return {
					items:
						request.kind === 'skills'
							? [
									{
										kind: 'skill',
										id: 'skill-app-design',
										label: 'App Design',
										path: '/configured/app-design/SKILL.md',
										description: 'Plan the app',
									},
								]
							: [
									{
										kind: 'file',
										id: `file-${request.query || 'docs'}`,
										label: request.query === 'old' ? 'old.ts' : 'tools.md',
										path: '/tmp/completion-repository/docs/tools.md',
									},
									{
										kind: 'folder',
										id: 'folder-docs',
										label: 'docs',
										path: '/tmp/completion-repository/docs',
									},
								],
				};
			},
			request: async () => {
				throw new Error('Completion selection must not send messages.');
			},
		};
	}, JSON.stringify(state));
	await page.goto('/');
	await expect(page).toHaveTitle('FreeLM');
	await expect(page.locator('vite-error-overlay')).toHaveCount(0);
	await selectConversationMode(page, 'Code');
	await page.getByRole('button', { name: 'Completion task', exact: true }).click();
	await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
}
async function draft(page: Page) {
	return page.evaluate(
		() => (window as any).__completionFixture.state().chatDrafts?.['completion-task'],
	);
}

test('slash modes select composer chips before sending; skills are inline atomic references', async ({
	page,
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await fixture(page);
	const editor = page.getByRole('textbox', { name: 'Message', exact: true });
	await editor.fill('/goal');
	await expect(page.getByRole('option', { name: /Goal Set a goal/ })).toBeVisible();
	await editor.dispatchEvent('keydown', {
		key: 'Enter',
		code: 'Enter',
		isComposing: true,
		keyCode: 229,
	});
	await expect(page.getByRole('button', { name: 'Turn off Goal mode' })).toHaveCount(0);
	await editor.press('Enter');
	await expect(page.getByRole('button', { name: 'Turn off Goal mode' })).toBeVisible();
	await expect(editor).not.toContainText('/goal');
	await editor.fill('Build something with a goal.');
	await expect.poll(async () => (await draft(page))?.composer?.mode).toBe('goal');
	await page.getByRole('button', { name: 'Turn off Goal mode' }).click();
	await editor.fill('/plan');
	await editor.press('Tab');
	await expect(page.getByRole('button', { name: 'Turn off Plan mode' })).toBeVisible();
	await expect(editor).not.toContainText('/plan');
	await page.getByRole('button', { name: 'Turn off Plan mode' }).click();
	await editor.fill('Use /app-des');
	await expect(page.getByRole('option', { name: /App Design Plan the app/ })).toBeVisible();
	await editor.press('Enter');
	await expect(page.locator('.cm-composer-mention-skill')).toHaveText('✦App Design');
	await page.keyboard.insertText('for the next feature.');
	await expect(editor).toContainText('Use ✦App Design for the next feature.');
	await expect
		.poll(async () => (await draft(page))?.composer?.references?.[0]?.id)
		.toBe('skill-app-design');
	await editor.press('ControlOrMeta+Home');
	await editor.press('ArrowRight');
	await editor.press('ArrowRight');
	await editor.press('ArrowRight');
	await editor.press('ArrowRight');
	await editor.press('Delete');
	await expect(page.locator('.cm-composer-mention-skill')).toHaveCount(0);
	await expect.poll(async () => (await draft(page))?.composer?.references?.length ?? 0).toBe(0);
	await editor.press('ControlOrMeta+z');
	await expect(page.locator('.cm-composer-mention-skill')).toHaveCount(1);
	await expect
		.poll(async () => (await draft(page))?.composer?.references?.[0]?.id)
		.toBe('skill-app-design');
	expect(errors).toEqual([]);
});

test('@ opens real context actions and file discovery ignores stale results, persists across navigation', async ({
	page,
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await fixture(page);
	const editor = page.getByRole('textbox', { name: 'Message', exact: true });
	await editor.fill('@');
	await expect(page.getByRole('listbox', { name: 'Composer suggestions' })).toContainText(
		'Files and folders',
	);
	await expect(page.getByRole('listbox', { name: 'Composer suggestions' })).toContainText('Skills');
	await page.getByRole('option', { name: /Files and folders Mention/ }).click();
	await expect(page.getByRole('option', { name: /tools.md/ })).toBeVisible();
	await editor.fill('@old');
	await expect
		.poll(() =>
			page.evaluate(() =>
				(window as any).__completionFixture.discovery.some((item: any) => item.query === 'old'),
			),
		)
		.toBe(true);
	await editor.fill('@docs/');
	await expect(page.getByRole('option', { name: /tools.md/ })).toBeVisible();
	await page.waitForTimeout(550);
	await expect(page.getByRole('option', { name: /old.ts/ })).toHaveCount(0);
	for (const width of [1440, 720]) {
		await page.setViewportSize({ width, height: 800 });
		const bounds = await page.getByRole('listbox', { name: 'Composer suggestions' }).boundingBox();
		expect(bounds!.x).toBeGreaterThanOrEqual(0);
		expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
		await page.screenshot({
			path: `/tmp/freelm-composer-completion-${width}.png`,
			animations: 'disabled',
		});
	}
	await page.getByRole('option', { name: /tools.md/ }).hover();
	await editor.press('Enter');
	await expect(page.locator('.cm-composer-mention-file')).toContainText('tools.md');
	await expect
		.poll(async () => (await draft(page))?.composer?.references?.[0]?.path)
		.toBe('/tmp/completion-repository/docs/tools.md');
	await selectConversationMode(page, 'Chat');
	await selectConversationMode(page, 'Code');
	await page.getByRole('button', { name: 'Completion task', exact: true }).click();
	await expect(page.locator('.cm-composer-mention-file')).toContainText('tools.md');
	await editor.fill('`/goal`');
	await expect(page.getByRole('listbox', { name: 'Composer suggestions' })).toHaveCount(0);
	await editor.fill('/goal');
	await editor.press('Escape');
	await expect(page.getByRole('listbox', { name: 'Composer suggestions' })).toHaveCount(0);
	expect(errors).toEqual([]);
});
