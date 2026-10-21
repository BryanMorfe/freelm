import { expect as playwrightExpect, test, type Page } from '@playwright/test';
import { initialState } from '../../src/lib/state';
import { defaultToolSettings } from '../../src/lib/tool-settings';
import type { AppState } from '../../src/types';

const expect = playwrightExpect.configure({ timeout: 15_000 });

// Browser plugin not available. This private in-memory bridge exercises the real
// composer without user storage, external providers, or filesystem tools.
async function fixture(page: Page) {
	const state = initialState();
	const connection = state.connections[0];
	connection.models.chat = 'marker-fixture';
	connection.catalog = [
		{
			id: 'marker-fixture',
			name: 'Marker fixture',
			enabled: true,
			tasks: ['chat'],
			inputModalities: ['text'],
			outputModalities: ['text'],
			thinkingModes: [
				{ id: 'low', name: 'Low', parameters: { responses: { reasoning: { effort: 'low' } } } },
			],
		},
	];
	state.toolSettings = { ...defaultToolSettings(), enabled: false };
	state.memorySettings = { savedMemories: false, referenceHistory: false };
	state.threads = [
		{
			id: 'markers',
			kind: 'chat',
			title: 'Markdown marker audit',
			titleSource: 'manual',
			connectionId: connection.id,
			model: 'marker-fixture',
			thinkingMode: 'low',
			messages: [],
			createdAt: 1,
			updatedAt: 1,
		},
	];
	await page.addInitScript((serialized) => {
		let current: AppState = JSON.parse(serialized),
			revision = 0;
		(window as any).__markerFixture = { state: () => current };
		(window as any).desktop = {
			platform: 'linux',
			workspaceLoad: async () => ({ state: structuredClone(current), revision: String(revision) }),
			workspaceSave: async (_id: string, _revision: string, next: AppState) => {
				current = structuredClone(next);
				return { revision: String(++revision) };
			},
			storageInfo: async () => ({ secure: false, location: 'Private marker fixture' }),
			onPrepareClose: () => () => {},
			onToolApproval: () => () => {},
			onChunk: () => () => {},
			instanceStatus: async () => ({
				host: { running: false, name: 'Local', instanceId: 'local', port: 4319 },
				instances: [],
			}),
		};
	}, JSON.stringify(state));
	await page.goto('/');
	await expect(page).toHaveTitle('FreeLM');
	await expect(page).toHaveURL(new URL('/', test.info().project.use.baseURL!).href);
	await expect(page.locator('vite-error-overlay')).toHaveCount(0);
	await page.getByRole('button', { name: 'Markdown marker audit', exact: true }).click();
	await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
}

async function expectSource(page: Page, source: string) {
	await expect
		.poll(() =>
			page.evaluate(
				() => (window as any).__markerFixture.state().chatDrafts?.markers?.content || '',
			),
		)
		.toBe(source);
}

test('completed inline code and quote prose hide redundant markers while source remains editable', async ({
	page,
}) => {
	test.setTimeout(300_000);
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (entry) => {
		if (entry.type() === 'error') errors.push(entry.text());
	});
	await fixture(page);
	const editor = page.getByRole('textbox', { name: 'Message', exact: true });
	await editor.fill('`command');
	// Cursor movement creates a real editing boundary. Fast consecutive typing
	// otherwise forms one ordinary undo group, including the opening text.
	await editor.press('ArrowLeft');
	await editor.press('ArrowRight');
	await page.keyboard.insertText('`');
	await expectSource(page, '`command`');
	await expect(editor).toHaveText('command');
	await expect(page.locator('.cm-composer-inline-code')).toHaveText('command');
	await editor.press('ArrowLeft');
	await expect(editor).toHaveText('`command`');
	await editor.press('ControlOrMeta+End');
	await expect(editor).toHaveText('command');
	await editor.press('ControlOrMeta+z');
	await expectSource(page, '`command');
	await expect(editor).toHaveText('`command');
	await editor.press('ControlOrMeta+Shift+z');
	await expectSource(page, '`command`');
	await expect(editor).toHaveText('command');

	const quote = '> A quoted statement\n> Another line';
	await editor.fill(quote);
	await expectSource(page, quote);
	await expect(editor).not.toContainText('>');
	await expect(page.locator('.cm-composer-quote-line')).toHaveCount(2);
	await editor.press('ControlOrMeta+Home');
	await expect(editor).toContainText('>');
	await editor.press('ControlOrMeta+End');
	await expect(editor).not.toContainText('>');
	await page.keyboard.insertText(' with an edit');
	await expectSource(page, quote + ' with an edit');
	await expect(editor).not.toContainText('>');
	await page.screenshot({ path: '/tmp/freelm-composer-quote-markers.png', animations: 'disabled' });
	await page.setViewportSize({ width: 720, height: 780 });
	await expect(editor).not.toContainText('>');
	await expect(editor).toBeVisible();
	await page.screenshot({
		path: '/tmp/freelm-composer-quote-markers-compact.png',
		animations: 'disabled',
	});
	await editor.fill('`literal $x$` and $x^2$');
	await expectSource(page, '`literal $x$` and $x^2$');
	await expect(page.locator('.cm-composer-math')).toHaveCount(1);
	await expect(page.locator('.cm-composer-inline-code')).toHaveText('literal $x$');
	await page.screenshot({
		path: '/tmp/freelm-composer-inline-markers.png',
		animations: 'disabled',
	});
	expect(errors).toEqual([]);
});
