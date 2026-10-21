import { selectConversationMode } from './helpers/conversation-mode';
import { expect, test, type Page } from '@playwright/test';
import { initialState } from '../../src/lib/state';
import type { AppState, ConversationKind } from '../../src/types';
import type { ToolCallRecord } from '../../src/agent-types';

// Browser plugin not available. Exercise the production App with isolated
// history; no inference requests, workspace commands, or real profile writes.
const paths = Array.from({ length: 12 }, (_, index) => `src/features/feature-${index + 1}.ts`);
const initialPatch = [
	'*** Begin Patch',
	...paths.flatMap((path, index) => [
		`*** Add File: ${path}`,
		`+export const feature${index + 1} = "${'long preview content '.repeat(30)}";`,
	]),
	'*** End Patch',
].join('\n');
function patchCall(id: string, patch: string): ToolCallRecord {
	return {
		id,
		name: 'apply_patch',
		arguments: JSON.stringify({ patch }),
		status: 'completed',
		startedAt: 2500,
		completedAt: 3000,
		result: { content: [] },
	};
}

async function fixture(page: Page, kind: ConversationKind, theme: 'dark' | 'light' = 'dark') {
	const state = initialState();
	state.theme = theme;
	state.debugMode = false;
	state.memorySettings = { savedMemories: false, referenceHistory: false };
	const connection = state.connections[0];
	connection.baseUrl = 'http://127.0.0.1:9/v1';
	connection.catalog = [
		{
			id: 'summary-model',
			name: 'Summary model',
			enabled: true,
			tasks: ['chat'],
			inputModalities: ['text'],
			outputModalities: ['text'],
			thinkingModes: [
				{ id: 'low', name: 'Low', parameters: { responses: { reasoning: { effort: 'low' } } } },
			],
			defaultThinkingMode: 'low',
		},
	];
	connection.models.chat = 'summary-model';
	const deleted = patchCall(
		'delete',
		'*** Begin Patch\n*** Delete File: src/obsolete.ts\n*** End Patch',
	);
	deleted.result!.fileChanges = [
		{ kind: 'delete', path: 'src/obsolete.ts', addedLines: 0, removedLines: 4 },
	];
	const calls = [
		patchCall('initial', initialPatch),
		patchCall(
			'repeat',
			`*** Begin Patch\n*** Update File: ${paths[0]}\n@@\n-old\n+updated\n+ready\n*** End Patch`,
		),
		deleted,
		patchCall(
			'rename',
			'*** Begin Patch\n*** Update File: src/old-name.ts\n*** Move to: src/new-name.ts\n@@\n retained\n*** End Patch',
		),
		{
			...patchCall(
				'failed',
				'*** Begin Patch\n*** Add File: FAILED-PRIVATE.ts\n+not applied\n*** End Patch',
			),
			status: 'failed' as const,
		},
	];
	state.threads = [
		{
			id: 'summary-thread',
			kind,
			title: 'File summary review',
			titleSource: 'manual',
			connectionId: connection.id,
			model: 'summary-model',
			thinkingMode: 'low',
			createdAt: 1000,
			updatedAt: 6000,
			messages: [
				{ id: 'earlier-user', role: 'user', content: 'Make the first change.', createdAt: 1000 },
				{
					id: 'earlier-answer',
					role: 'assistant',
					content: 'The earlier change is ready.',
					createdAt: 1500,
					completedAt: 2000,
					toolCalls: [
						patchCall(
							'earlier',
							'*** Begin Patch\n*** Add File: earlier.md\n+Earlier\n*** End Patch',
						),
					],
				},
				{ id: 'current-user', role: 'user', content: 'Make the next changes.', createdAt: 2300 },
				{
					id: 'current-answer',
					role: 'assistant',
					content: 'The final answer stays above its edited files.',
					createdAt: 2400,
					completedAt: 6000,
					activityFinishedAt: 5000,
					toolCalls: calls,
				},
			],
		},
	];
	await page.addInitScript(
		({ serialized }) => {
			let saved: AppState = JSON.parse(serialized);
			let revision = 0;
			(window as any).desktop = {
				platform: 'linux',
				workspaceLoad: async () => ({ state: structuredClone(saved), revision: String(revision) }),
				workspaceSave: async (_id: string, _revision: string, next: AppState) => {
					saved = structuredClone(next);
					return { revision: String(++revision) };
				},
				storageInfo: async () => ({ secure: false, location: '/tmp/private-file-summary' }),
				onPrepareClose: () => () => {},
				onToolApproval: () => () => {},
				instanceStatus: async () => ({
					host: { running: false, name: 'This computer', instanceId: 'local', port: 4319 },
					instances: [],
				}),
				toolCatalog: async () => ({ tools: [], instructions: '', warnings: [] }),
			};
		},
		{ serialized: JSON.stringify(state) },
	);
	await page.goto('/');
	await expect(page).toHaveTitle('FreeLM');
	if (kind === 'code') await selectConversationMode(page, 'Code');
	await page.getByTitle('File summary review', { exact: true }).click();
	await expect(page.locator('.message')).toHaveCount(4);
}

for (const width of [1440, 720]) {
	test(`Code response file summary, hover preview and expansion at ${width}px`, async ({
		page,
	}) => {
		await page.setViewportSize({ width, height: 940 });
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		page.on('console', (entry) => {
			if (entry.type() === 'error') errors.push(entry.text());
		});
		await fixture(page, 'code');
		const answer = page.locator('[data-message-id="current-answer"]');
		const card = answer.locator('.file-edit-summary');
		await expect(card).toBeVisible();
		await expect(card).toContainText('Edited 14 files');
		await expect(card).toContainText('+14');
		await expect(card).toContainText('-5');
		const header = await card.evaluate((element) => {
			const heading = element.querySelector('.file-edit-summary-title')!.getBoundingClientRect();
			const counts = element
				.querySelector('.file-edit-summary-header .file-edit-counts')!
				.getBoundingClientRect();
			const canvas = document.createElement('canvas');
			canvas.width = canvas.height = 1;
			const ctx = canvas.getContext('2d')!;
			const red = (color: string) => {
				ctx.clearRect(0, 0, 1, 1);
				ctx.fillStyle = color;
				ctx.fillRect(0, 0, 1, 1);
				return ctx.getImageData(0, 0, 1, 1).data[0];
			};
			return {
				gap: counts.top - heading.bottom,
				body: red(getComputedStyle(element).backgroundColor),
				header: red(
					getComputedStyle(element.querySelector('.file-edit-summary-header')!).backgroundColor,
				),
			};
		});
		expect(header.gap).toBeLessThanOrEqual(2);
		expect(header.header - header.body).toBeGreaterThanOrEqual(0);
		expect(header.header - header.body).toBeLessThanOrEqual(8);
		const rows = card.locator('.file-edit-summary-row');
		await expect(rows).toHaveCount(3);
		await expect(card).not.toContainText('earlier.md');
		await expect(card).not.toContainText('FAILED-PRIVATE');
		await expect(page.locator('.tool-debug-details')).toHaveCount(0);
		await expect(page.locator('.file-edit-preview')).toHaveCount(0);
		const first = rows.first();
		await expect(first).toContainText('+3');
		await expect(first).toContainText('-1');
		await first.hover();
		const preview = page.locator('.file-edit-preview');
		await expect(preview).toBeVisible();
		await expect(preview).toContainText('feature-1.ts');
		await expect(preview).toContainText('export const feature1');
		await expect(preview).toContainText('updated');
		await preview.hover();
		await page.waitForTimeout(350);
		await expect(preview).toBeVisible();
		const diffScroll = preview.locator('.file-edit-preview-scroll');
		await expect(diffScroll).toHaveCSS('overflow-x', 'auto');
		await diffScroll.hover();
		await page.mouse.wheel(300, 0);
		await expect
			.poll(() => diffScroll.evaluate((element) => element.scrollLeft))
			.toBeGreaterThan(0);
		await page.mouse.wheel(-300, 0);
		const bounds = await preview.boundingBox();
		expect(bounds!.x).toBeGreaterThanOrEqual(0);
		expect(bounds!.y).toBeGreaterThanOrEqual(0);
		expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
		expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(941);
		await page.screenshot({ path: `/tmp/freelm-file-summary-preview-${width}.png` });
		await page.keyboard.press('Escape');
		await expect(preview).toHaveCount(0);
		await card.getByRole('button', { name: /Show 11 more files/ }).click();
		await expect(rows).toHaveCount(14);
		await expect(card).toContainText('new-name.ts');
		await expect(card).toContainText('obsolete.ts');
		const renamed = rows.filter({ hasText: 'new-name.ts' });
		await renamed.focus();
		await expect(preview).toContainText('old-name.ts');
		await renamed.press('Enter');
		await expect(preview).toBeVisible();
		await page.getByRole('textbox', { name: 'Message', exact: true }).click();
		await expect(preview).toHaveCount(0);
		await card.getByRole('button', { name: 'Show less', exact: true }).click();
		await expect(rows).toHaveCount(3);
		expect(await answer.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
			true,
		);
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
			true,
		);
		expect(
			await card.evaluate((element) => {
				const answer = element.closest('.message')!;
				return (
					!!(
						answer.querySelector('.message-final')!.compareDocumentPosition(element) &
						Node.DOCUMENT_POSITION_FOLLOWING
					) &&
					!!(
						element.compareDocumentPosition(answer.querySelector('.message-footer')!) &
						Node.DOCUMENT_POSITION_FOLLOWING
					)
				);
			}),
		).toBe(true);
		await page.screenshot({ path: `/tmp/freelm-file-summary-card-${width}.png` });
		await page.reload();
		await selectConversationMode(page, 'Code');
		await page.getByTitle('File summary review', { exact: true }).click();
		await expect(
			page.locator('[data-message-id="current-answer"] .file-edit-summary'),
		).toContainText('Edited 14 files');
		await expect(page.locator('vite-error-overlay')).toHaveCount(0);
		expect(errors).toEqual([]);
	});
}

test('file preview stays within a zoomed light-theme viewport', async ({ page }) => {
	await page.setViewportSize({ width: 1000, height: 800 });
	await fixture(page, 'code', 'light');
	const heading = page.locator('[data-message-id="current-answer"] .file-edit-summary-header');
	await expect(heading).not.toHaveCSS('background-color', 'rgb(255, 255, 255)');
	await page.evaluate(() => {
		document.body.style.zoom = '1.25';
	});
	const row = page.locator('[data-message-id="current-answer"] .file-edit-summary-row').first();
	await row.hover();
	const preview = page.locator('.file-edit-preview');
	await expect(preview).toBeVisible();
	const bounds = await preview.boundingBox();
	expect(bounds!.x).toBeGreaterThanOrEqual(0);
	expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1001);
	expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(801);
	await page.screenshot({ path: '/tmp/freelm-file-summary-light-zoom.png' });
});

test('ordinary Chat does not get a local-file summary card', async ({ page }) => {
	await fixture(page, 'chat');
	await expect(page.locator('.file-edit-summary')).toHaveCount(0);
	await expect(page.locator('.message-final').last()).toContainText(
		'The final answer stays above its edited files.',
	);
});
