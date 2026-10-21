import { expect, test, type Page } from '@playwright/test';
import { initialState } from '../../src/lib/state';
import { defaultToolSettings } from '../../src/lib/tool-settings';
import type { AppState, Thread } from '../../src/types';
import { selectConversationMode } from './helpers/conversation-mode';

// Browser plugin not available. Exercise the real App in Chrome with an isolated
// synthetic profile and held protocol requests; no user profile or provider calls.
test.setTimeout(300_000);
test.use({ actionTimeout: 30_000 });

const objective =
	'Finish the shared composer drawer and verify that goals and queued follow-ups remain usable';
const followUp = 'Check the narrow window layout and preserve the current composer draft.';
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const drawer = (page: Page) => page.locator('.composer-drawer');

async function fixture(page: Page) {
	const state = initialState();
	state.backgroundNotifications = false;
	state.memorySettings = { savedMemories: false, referenceHistory: false };
	state.connections[0].baseUrl = 'http://drawer.invalid/v1';
	state.connections[0].models.chat = 'drawer-model';
	state.connections[0].catalog = [
		{
			id: 'drawer-model',
			name: 'Drawer model',
			enabled: true,
			tasks: ['chat'],
			inputModalities: ['text'],
			outputModalities: ['text'],
			thinkingModes: [
				{ id: 'low', name: 'Low', parameters: { responses: { reasoning: { effort: 'low' } } } },
			],
		},
	];
	state.toolSettings = { ...defaultToolSettings(), enabled: true, approvalMode: 'full-access' };
	state.toolSettings.webBrowsing!.enabled = false;
	state.projects = [
		{
			id: 'drawer-project',
			kind: 'code',
			name: 'Drawer fixture',
			directories: ['/tmp/drawer-fixture'],
			instructions: '',
			createdAt: 1,
		},
	];
	const thread = (id: string, title: string): Thread => ({
		id,
		title,
		titleSource: 'manual',
		kind: 'code',
		projectId: 'drawer-project',
		connectionId: state.activeConnectionId,
		model: 'drawer-model',
		thinkingMode: 'low',
		permissionMode: 'full-access',
		createdAt: 1,
		updatedAt: 2,
		messages: [
			{ id: `${id}-user`, role: 'user', content: 'Review the composer layout.', createdAt: 1 },
			{
				id: `${id}-answer`,
				role: 'assistant',
				content: 'Ready for the next step.',
				createdAt: 2,
				completedAt: 3,
			},
		],
	});
	state.threads = [
		thread('combined', 'Goal and queue'),
		thread('empty', 'No drawer content'),
		thread('failure', 'Failed queue'),
		thread('many', 'Many queued messages'),
	];
	state.threads[0].goal = {
		id: 'goal',
		objective,
		status: 'paused',
		usedTokens: 1234,
		tokenBudget: 100000,
		elapsedMs: 3000,
		turns: 1,
		createdAt: 1,
		updatedAt: 2,
	};
	state.threads[0].queuedMessages = [
		{ id: 'queued-one', content: followUp, createdAt: 4 },
		{ id: 'queued-two', content: 'Then check the final spacing.', createdAt: 5 },
	];
	state.threads[3].queuedMessages = Array.from({ length: 12 }, (_, i) => ({
		id: `many-${i}`,
		content: `Queued follow-up ${i + 1}: ${followUp}`,
		createdAt: i + 4,
	}));
	state.threads[2].messages[1].error = 'Synthetic provider unavailable.';
	state.threads[2].codeQueueFailures = [
		{
			id: 'failure',
			assistantId: 'failure-answer',
			messageIds: ['failure-user'],
			error: 'Synthetic provider unavailable.',
			failedAt: 4,
		},
	];
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (event) => {
		if (event.type() === 'error') errors.push(event.text());
	});
	await page.route('**/drawer.invalid/**', (route) => route.abort());
	await page.addInitScript(
		({ serialized }) => {
			let saved = JSON.parse(serialized);
			let revision = 0;
			const requests: any[] = [];
			const chunks = new Set<(chunk: any) => void>();
			(window as any).__drawerQA = {
				state: () => structuredClone(saved),
				requests: () => requests.map(({ resolve, reject, ...request }) => request),
				finish: (index: number) => {
					const request = requests[index];
					for (const listener of chunks)
						listener({
							id: request.id,
							text: `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Synthetic retry completed.' }] }] } })}\n\n`,
						});
					request.resolve({
						status: 200,
						contentType: 'text/event-stream',
						encoding: 'text',
						body: '',
					});
				},
			};
			(window as any).desktop = {
				platform: 'linux',
				workspaceLoad: async () => ({ state: structuredClone(saved), revision: String(revision) }),
				workspaceSave: async (_id: string, _revision: string, next: AppState) => {
					saved = structuredClone(next);
					return { revision: String(++revision) };
				},
				storageInfo: async () => ({ secure: false, location: '/tmp/isolated-drawer-profile' }),
				onPrepareClose: () => () => {},
				instanceStatus: async () => ({
					host: { running: false, name: 'This computer', instanceId: 'local', port: 4319 },
					instances: [],
				}),
				toolCatalog: async () => ({ tools: [], instructions: '', warnings: [] }),
				toolExecute: async () => {
					throw new Error('Unexpected host execution in drawer fixture.');
				},
				toolCancel: async () => {},
				onChunk: (listener: (chunk: any) => void) => {
					chunks.add(listener);
					return () => chunks.delete(listener);
				},
				request: (request: any) =>
					new Promise((resolve, reject) => requests.push({ ...request, resolve, reject })),
				cancel: async (id: string) => {
					const request = requests.find((request) => request.id === id);
					if (request) {
						request.cancelled = true;
						request.reject(new DOMException('Cancelled', 'AbortError'));
					}
				},
			};
		},
		{ serialized: JSON.stringify(state) },
	);
	await page.goto('/');
	await expect(page).toHaveTitle('FreeLM');
	await selectConversationMode(page, 'Code');
	await page.getByTitle('Goal and queue', { exact: true }).click();
	await expect(composer(page)).toBeVisible();
	return errors;
}

async function assertAttached(page: Page) {
	await expect(drawer(page)).toBeVisible();
	const geometry = await page.locator('.composer-area').evaluate((area) => {
		const drawer = area.querySelector('.composer-drawer')!;
		const composer = area.querySelector('.composer:not([hidden]):not(.composer-approval)')!;
		const d = drawer.getBoundingClientRect(),
			c = composer.getBoundingClientRect();
		return {
			gap: c.top - d.bottom,
			leftInset: d.left - c.left,
			rightInset: c.right - d.right,
			overflow: document.documentElement.scrollWidth - window.innerWidth,
		};
	});
	expect(Math.abs(geometry.gap)).toBeLessThanOrEqual(1);
	expect(geometry.leftInset).toBeGreaterThanOrEqual(0);
	expect(geometry.rightInset).toBeGreaterThanOrEqual(0);
	expect(geometry.overflow).toBeLessThanOrEqual(1);
}

for (const width of [1440, 800]) {
	test(`drawer stacks goals and queued input with usable controls at ${width}px`, async ({
		page,
	}) => {
		await page.setViewportSize({ width, height: width === 1440 ? 940 : 700 });
		const errors = await fixture(page);
		await expect(drawer(page)).toHaveCount(1);
		await expect(drawer(page).getByLabel('Persistent goal')).toBeVisible();
		await expect(drawer(page).getByLabel('Queued messages', { exact: true })).toBeVisible();
		const goalBox = await page.getByLabel('Persistent goal').boundingBox();
		const queueBox = await page.getByLabel('Queued messages', { exact: true }).boundingBox();
		expect(queueBox!.y).toBeGreaterThanOrEqual(goalBox!.y + goalBox!.height - 1);
		await assertAttached(page);
		await page.screenshot({ path: `/tmp/freelm-drawer-combined-${width}.png` });

		if (width === 1440) {
			const firstRow = page.locator('.code-message-queue-row').first();
			await firstRow.getByRole('button', { name: 'Expand queued message', exact: true }).click();
			await expect(firstRow.locator('.code-message-queue-expanded')).toContainText(followUp);
			await firstRow.getByRole('combobox', { name: 'Queued message actions' }).click();
			await page.getByRole('option', { name: 'Edit message', exact: true }).click();
			await expect(composer(page)).toHaveText(followUp);
			await composer(page).fill('Updated queued follow-up');
			await page.getByRole('button', { name: 'Save queued message', exact: true }).click();
			await expect(firstRow).toContainText('Updated queued follow-up');
			await firstRow.getByRole('button', { name: 'Remove queued message' }).click();
			await page.getByRole('button', { name: 'Remove queued message' }).click();
			await expect(page.getByLabel('Queued messages', { exact: true })).toHaveCount(0);
			await expect(drawer(page).getByLabel('Persistent goal')).toBeVisible();
			await assertAttached(page);
			await page.screenshot({ path: `/tmp/freelm-drawer-goal-${width}.png` });

			await page.getByRole('button', { name: 'Resume goal', exact: true }).click();
			await expect(page.getByRole('button', { name: 'Pause goal', exact: true })).toBeVisible();
			await expect
				.poll(() => page.evaluate(() => (window as any).__drawerQA.requests().length))
				.toBe(1);
			await expect(composer(page)).toBeEditable();
			await page.getByRole('button', { name: 'Pause goal', exact: true }).click();
			await expect(page.getByRole('button', { name: 'Resume goal', exact: true })).toBeVisible();
			await expect
				.poll(() => page.evaluate(() => (window as any).__drawerQA.requests()[0]?.cancelled))
				.toBe(true);
			await page.getByRole('button', { name: 'Clear goal', exact: true }).click();
			await expect(drawer(page)).toHaveCount(0);

			await page.getByTitle('Failed queue', { exact: true }).click();
			await expect(
				drawer(page).getByRole('group', { name: 'Failed queued messages' }),
			).toBeVisible();
			await expect(page.getByRole('button', { name: 'Retry queued messages' })).toBeEnabled();
			await assertAttached(page);
			await page.screenshot({ path: `/tmp/freelm-drawer-failure-${width}.png` });
			await page.getByRole('button', { name: 'Retry queued messages' }).click();
			await expect
				.poll(() => page.evaluate(() => (window as any).__drawerQA.requests().length))
				.toBe(2);
			await page.evaluate(() => (window as any).__drawerQA.finish(1));
			await expect(page.getByText('Synthetic retry completed.', { exact: true })).toBeVisible();
			await expect(drawer(page)).toHaveCount(0);
		}
		await page.getByTitle('Many queued messages', { exact: true }).click();
		await assertAttached(page);
		const scrolling = await drawer(page).evaluate((element) => {
			const composer = document.querySelector('.composer-area > .composer:not([hidden])')!;
			element.scrollTop = element.scrollHeight;
			return {
				height: element.clientHeight,
				content: element.scrollHeight,
				scroll: element.scrollTop,
				composerBottom: composer.getBoundingClientRect().bottom,
				viewport: window.innerHeight,
			};
		});
		expect(scrolling.content).toBeGreaterThan(scrolling.height);
		expect(scrolling.scroll).toBeGreaterThan(0);
		expect(scrolling.composerBottom).toBeLessThanOrEqual(scrolling.viewport);
		await page
			.locator('.code-message-queue-row')
			.last()
			.getByRole('button', { name: 'Remove queued message' })
			.click();
		await expect(page.locator('.code-message-queue-row')).toHaveCount(11);
		await page.screenshot({ path: `/tmp/freelm-drawer-scroll-${width}.png` });
		await page.getByTitle('No drawer content', { exact: true }).click();
		await expect(drawer(page)).toHaveCount(0);
		await page.getByRole('button', { name: 'New task', exact: true }).click();
		await expect(drawer(page).getByLabel('Code workspace context')).toBeVisible();
		await assertAttached(page);
		await page.screenshot({ path: `/tmp/freelm-drawer-new-${width}.png` });
		await selectConversationMode(page, 'Chat');
		await expect(drawer(page)).toHaveCount(0);
		await expect(page.locator('vite-error-overlay')).toHaveCount(0);
		expect(errors).toEqual([]);
	});
}
