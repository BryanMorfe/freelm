import { expect, test, type Page } from '@playwright/test';
import { initialState } from '../../src/lib/state';
import type { AppState } from '../../src/types';
import type { SavedMemory } from '../../src/memory-types';
import { chooseOption } from './ui-controls';

function note(id: string, content: string, patch: Partial<SavedMemory> = {}): SavedMemory {
	return { id, content, source: 'user', revision: 1, createdAt: 1, updatedAt: 1, ...patch };
}

async function fixture(page: Page, capacity = false) {
	const state = initialState();
	delete state.memorySettings;
	state.projects = [
		{ id: 'travel', name: 'Travel', kind: 'chat', instructions: '', createdAt: 1 },
		{
			id: 'source',
			name: 'Code folder',
			kind: 'code',
			instructions: '',
			directories: ['/tmp/source'],
			createdAt: 1,
		},
	];
	state.savedMemories = capacity
		? Array.from({ length: 256 }, (_, index) =>
				note(`note-${index}`, `Saved detail ${index}`, { updatedAt: index + 1 }),
			)
		: [
				note('concise', 'I prefer concise explanations.'),
				note('budget', 'Trip budget is $2,000.', {
					projectId: 'travel',
					source: 'model',
					sourceThreadId: 'trip-chat',
				}),
				note('orphan', 'A fact from a removed project.', { projectId: 'removed-project' }),
			];
	state.threads = [
		{
			id: 'trip-chat',
			kind: 'chat',
			title: 'Planning a trip',
			projectId: 'travel',
			connectionId: state.activeConnectionId,
			model: '',
			createdAt: 1,
			updatedAt: 1,
			messages: [{ id: 'trip-message', role: 'user', content: 'Plan a trip.', createdAt: 1 }],
			memorySummary: {
				content: 'A trip is being planned.',
				sourceRevision: 'fixture',
				generatedAt: 1,
				model: 'fixture-model',
			},
		},
	];
	await page.addInitScript((serialized) => {
		const initial = JSON.parse(serialized);
		const control = {
			state: JSON.parse(sessionStorage.getItem('memory-settings-state') || JSON.stringify(initial)),
			revision: 1,
			failNextSave: false,
			saves: [] as any[],
		};
		(window as any).__memorySettingsTest = control;
		(window as any).desktop = {
			platform: 'linux',
			workspaceLoad: async () => ({
				state: structuredClone(control.state),
				revision: String(control.revision),
			}),
			workspaceSave: async (_workspace: string, _revision: string, next: AppState) => {
				if (control.failNextSave) {
					control.failNextSave = false;
					throw new Error('The memory fixture could not save this change.');
				}
				control.state = structuredClone(next);
				control.saves.push(structuredClone(next));
				sessionStorage.setItem('memory-settings-state', JSON.stringify(next));
				return { revision: String(++control.revision) };
			},
			storageInfo: async () => ({ secure: false, location: 'Isolated memory fixture' }),
			onPrepareClose: () => () => {},
			onChunk: () => () => {},
			cancel: async () => {},
			instanceStatus: async () => ({
				host: { running: false, name: 'Local', instanceId: 'local', port: 4319 },
				instances: [],
			}),
		};
	}, JSON.stringify(state));
	await page.goto('/');
	await expect(page).toHaveTitle('FreeLM');
	await page.getByRole('button', { name: 'Personal workspace settings', exact: true }).click();
	const settings = page.getByRole('region', { name: 'Settings', exact: true });
	await settings.getByRole('button', { name: 'Memories', exact: true }).click();
	await expect(settings.getByRole('heading', { name: 'Memories', exact: true })).toBeVisible();
	return settings;
}

async function saved(page: Page): Promise<AppState> {
	return page.evaluate(() => structuredClone((window as any).__memorySettingsTest.state));
}

test('Memories defaults on, manages scoped notes and saves preferences without restoring stale notes', async ({
	page,
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	const settings = await fixture(page);
	const useMemories = settings.getByRole('switch', { name: 'Use saved memories', exact: true });
	await expect(useMemories).toBeChecked();
	await expect(
		settings.getByRole('switch', { name: 'Reference chat history', exact: true }),
	).toBeChecked();
	await expect(settings.getByText('Saved by Chat', { exact: true })).toBeVisible();
	await expect(settings.getByText('Unavailable project', { exact: true })).toBeVisible();
	await useMemories.click();
	await settings.getByRole('button', { name: 'Add memory', exact: true }).click();
	const editor = settings.getByRole('form', { name: 'Add memory', exact: true });
	await editor.getByRole('textbox', { name: 'Memory', exact: true }).fill('I prefer Celsius.');
	const scope = editor.getByRole('combobox', { name: 'Memory scope', exact: true });
	await scope.click();
	await expect(page.getByRole('option', { name: 'Workspace', exact: true })).toBeVisible();
	await expect(page.getByRole('option', { name: 'Travel', exact: true })).toBeVisible();
	await expect(page.getByRole('option', { name: 'Code folder', exact: true })).toHaveCount(0);
	await page.getByRole('option', { name: 'Travel', exact: true }).click();
	await editor.getByRole('button', { name: 'Save memory', exact: true }).click();
	await expect(editor).toHaveCount(0);
	await expect
		.poll(
			async () =>
				(await saved(page)).savedMemories?.find((memory) => memory.content === 'I prefer Celsius.')
					?.projectId,
		)
		.toBe('travel');
	await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
	await expect
		.poll(async () => (await saved(page)).memorySettings)
		.toEqual({ savedMemories: false, referenceHistory: true });
	await expect.poll(async () => (await saved(page)).savedMemories?.length).toBe(4);
	const budget = settings.getByRole('article').filter({ hasText: 'Trip budget is $2,000.' });
	await budget.getByRole('button', { name: 'Edit memory', exact: true }).click();
	const edit = settings.getByRole('form', { name: 'Edit memory', exact: true });
	await expect(edit.getByText('Scope: Travel', { exact: true })).toBeVisible();
	await edit.getByRole('textbox', { name: 'Memory', exact: true }).fill('Trip budget is $2,500.');
	await edit.getByRole('button', { name: 'Save memory', exact: true }).click();
	await expect
		.poll(
			async () =>
				(await saved(page)).savedMemories?.find((memory) => memory.id === 'budget')?.revision,
		)
		.toBe(2);
	const search = settings.getByRole('textbox', { name: 'Search memories', exact: true });
	await search.fill('Travel');
	await expect(settings.getByRole('article')).toHaveCount(2);
	await search.fill('$2,500');
	await expect(settings.getByRole('article')).toHaveCount(1);
	await settings
		.getByRole('article')
		.getByRole('button', { name: 'Delete memory', exact: true })
		.click();
	await expect
		.poll(async () => (await saved(page)).savedMemories?.some((memory) => memory.id === 'budget'))
		.toBe(false);
	await search.fill('');
	await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
	await expect.poll(async () => (await saved(page)).savedMemories?.length).toBe(3);
	await settings.getByRole('button', { name: 'Clear summaries', exact: true }).click();
	await expect.poll(async () => (await saved(page)).threads[0].memorySummary).toBeUndefined();
	await page.reload();
	await page.getByRole('button', { name: 'Personal workspace settings', exact: true }).click();
	await settings.getByRole('button', { name: 'Memories', exact: true }).click();
	await expect(useMemories).not.toBeChecked();
	await expect(settings.getByRole('article')).toHaveCount(3);
	await expect(settings.getByRole('article').filter({ hasText: 'Trip budget' })).toHaveCount(0);
	expect(errors).toEqual([]);
});

test('memory edits survive a failed save and retry with the captured revision', async ({
	page,
}) => {
	const settings = await fixture(page);
	const concise = settings
		.getByRole('article')
		.filter({ hasText: 'I prefer concise explanations.' });
	await concise.getByRole('button', { name: 'Edit memory', exact: true }).click();
	const editor = settings.getByRole('form', { name: 'Edit memory', exact: true });
	const content = editor.getByRole('textbox', { name: 'Memory', exact: true });
	await content.fill('I prefer concise explanations with examples.');
	await page.evaluate(() => {
		(window as any).__memorySettingsTest.failNextSave = true;
	});
	await editor.getByRole('button', { name: 'Save memory', exact: true }).click();
	await expect(
		settings
			.getByRole('alert')
			.filter({ hasText: 'The memory fixture could not save this change.' }),
	).toBeVisible();
	await expect(content).toHaveValue('I prefer concise explanations with examples.');
	await expect(editor.getByRole('button', { name: 'Save memory', exact: true })).toBeEnabled();
	expect(
		(await saved(page)).savedMemories?.find((memory) => memory.id === 'concise')?.content,
	).toBe('I prefer concise explanations.');
	await editor.getByRole('button', { name: 'Save memory', exact: true }).click();
	await expect(editor).toHaveCount(0);
	await expect
		.poll(
			async () =>
				(await saved(page)).savedMemories?.find((memory) => memory.id === 'concise')?.revision,
		)
		.toBe(2);
	await expect(
		settings
			.getByRole('article')
			.filter({ hasText: 'I prefer concise explanations with examples.' }),
	).toBeVisible();
});

test('memory capacity and growing editor remain usable in narrow Settings', async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const settings = await fixture(page, true);
	const add = settings.getByRole('button', { name: 'Add memory', exact: true });
	await expect(add).toBeDisabled();
	await settings
		.getByRole('article')
		.first()
		.getByRole('button', { name: 'Delete memory', exact: true })
		.click();
	await expect(add).toBeEnabled();
	await add.click();
	const editor = settings.getByRole('form', { name: 'Add memory', exact: true });
	const content = editor.getByRole('textbox', { name: 'Memory', exact: true });
	await expect(content).toHaveAttribute('maxlength', '4000');
	const firstHeight = (await content.boundingBox())!.height;
	await content.fill(
		Array.from({ length: 14 }, (_, index) => `Line ${index}: a saved detail.`).join('\n'),
	);
	await expect.poll(async () => (await content.boundingBox())!.height).toBeGreaterThan(firstHeight);
	await content.fill(
		Array.from({ length: 70 }, (_, index) => `Line ${index}: a saved detail.`).join('\n'),
	);
	expect((await content.boundingBox())!.height).toBeLessThanOrEqual(600);
	await chooseOption(
		page,
		editor.getByRole('combobox', { name: 'Memory scope', exact: true }),
		'',
	);
	const overflow = await settings
		.locator('.settings-main')
		.evaluate((element) => element.scrollWidth - element.clientWidth);
	expect(overflow).toBeLessThanOrEqual(1);
	await page.screenshot({ path: '/tmp/freelm-memory-settings-narrow.png' });
	await content.fill('m'.repeat(4000));
	await editor.getByRole('button', { name: 'Save memory', exact: true }).click();
	await expect(editor).toHaveCount(0);
	await expect(add).toBeDisabled();
	await expect
		.poll(async () =>
			(await saved(page)).savedMemories?.some((memory) => memory.content.length === 4000),
		)
		.toBe(true);
});
