import { selectConversationMode } from './helpers/conversation-mode';
import { expect, test, type Page } from '@playwright/test';
import { initialState } from '../../src/lib/state';
import type { AppState } from '../../src/types';
import type { ToolCallRecord } from '../../src/agent-types';

// Browser plugin unavailable. Synthetic saved history exercises the actual app
// without model requests, executing commands, or touching the user's profile.
const command = `printf "spaces  stay"\npython -c "${'long_identifier_'.repeat(60)}"`;
const patch = `*** Begin Patch
*** Update File: source.txt
@@
-before
+after
*** End Patch`;
const reason = 'The destination was not authorized. <script>window.denialInjected=true</script>';
const legacyReason = 'Automatic approval review needs more context for this command.';
const rawPatchReason = 'The requested update to source.txt was not approved.';
const quotedPatchReason = 'The next requested update was not approved either.';
const imageReason = 'Uploading an image reference was not authorized.';

async function fixture(page: Page, kind: 'chat' | 'code') {
	const state = initialState();
	state.debugMode = false;
	state.memorySettings = { savedMemories: false, referenceHistory: false };
	state.connections[0].models.chat = 'review-model';
	state.connections[0].catalog = [
		{
			id: 'review-model',
			name: 'Review model',
			enabled: true,
			tasks: ['chat'],
			inputModalities: ['text'],
			outputModalities: ['text'],
			thinkingModes: [
				{ id: 'low', name: 'Low', parameters: { responses: { reasoning: { effort: 'low' } } } },
			],
		},
	];
	const toolCalls: ToolCallRecord[] = [
		{
			id: 'review-unavailable',
			name: 'exec_command',
			status: 'failed',
			arguments: JSON.stringify({ cmd: 'cat README.md' }),
			startedAt: 2400,
			result: {
				isError: true,
				approvalReviewError: {
					reason: 'Automatic review could not complete after 3 attempts. The action was not run.',
					code: 'unavailable',
					attempts: 3,
					permissionMode: 'auto-review',
					effectiveDirectory: '/tmp/project',
				},
				content: [{ type: 'text', text: 'PRIVATE_DEBUG_REVIEW_ERROR' }],
			},
		},
		{
			id: 'denied-command',
			name: 'exec_command',
			status: 'denied',
			arguments: JSON.stringify({ cmd: command, workdir: '../other' }),
			startedAt: 2500,
			result: {
				isError: true,
				approvalDenied: {
					reason,
					permissionMode: 'auto-review',
					effectiveDirectory: '/tmp/project/source',
				},
				content: [{ type: 'text', text: 'PRIVATE_DEBUG_DENIAL_PAYLOAD' }],
			},
		},
		{
			id: 'legacy-command',
			name: 'exec_command',
			status: 'failed',
			arguments: JSON.stringify({ cmd: 'cat legacy.txt' }),
			startedAt: 2600,
			result: {
				isError: true,
				content: [
					{
						type: 'text',
						text: `${legacyReason} Do not retry this action without a new user request.`,
					},
				],
			},
		},
		{
			id: 'denied-raw-patch',
			name: 'apply_patch',
			status: 'denied',
			arguments: patch,
			startedAt: 2700,
			result: {
				isError: true,
				approvalDenied: {
					reason: rawPatchReason,
					permissionMode: 'auto-review',
					effectiveDirectory: '/tmp/project',
				},
				content: [{ type: 'text', text: 'PRIVATE_DEBUG_PATCH_PAYLOAD' }],
			},
		},
		{
			id: 'denied-quoted-patch',
			name: 'functions.apply_patch',
			status: 'denied',
			arguments: JSON.stringify(patch),
			startedAt: 2800,
			result: {
				isError: true,
				approvalDenied: {
					reason: quotedPatchReason,
					permissionMode: 'auto-review',
					effectiveDirectory: '/tmp/project',
				},
				content: [{ type: 'text', text: 'PRIVATE_DEBUG_QUOTED_PAYLOAD' }],
			},
		},
		{
			id: 'denied-image',
			name: 'image_gen.imagegen',
			status: 'denied',
			arguments: JSON.stringify({ prompt: 'A synthetic landscape', size: '1024x768' }),
			startedAt: 2900,
			result: {
				isError: true,
				approvalDenied: { reason: imageReason, permissionMode: 'auto-review' },
				content: [{ type: 'text', text: 'PRIVATE_DEBUG_IMAGE_PAYLOAD' }],
			},
		},
		{
			id: 'ordinary-command-failure',
			name: 'exec_command',
			status: 'failed',
			arguments: JSON.stringify({ cmd: 'cat missing.txt' }),
			startedAt: 3000,
			result: {
				isError: true,
				content: [{ type: 'text', text: 'Permission denied: ./missing.txt' }],
			},
		},
		{
			id: 'ordinary-patch-failure',
			name: 'apply_patch',
			status: 'failed',
			arguments: JSON.stringify({ patch }),
			startedAt: 3100,
			result: { isError: true, content: [{ type: 'text', text: 'Could not apply the patch.' }] },
		},
	];
	state.threads = [
		{
			id: 'denials',
			kind,
			title: 'Approval review fixture',
			titleSource: 'manual',
			connectionId: state.activeConnectionId,
			model: 'review-model',
			thinkingMode: 'low',
			createdAt: 1000,
			updatedAt: 7000,
			messages: [
				{
					id: 'user',
					role: 'user',
					content: 'Inspect these authorization outcomes.',
					createdAt: 1000,
				},
				{
					id: 'assistant',
					role: 'assistant',
					content: 'The final response remains primary.',
					createdAt: 2000,
					completedAt: 7000,
					activityFinishedAt: 6500,
					toolCalls,
					activity: [
						...toolCalls.map((call) => ({
							type: 'tool' as const,
							id: `part-${call.id}`,
							toolCallId: call.id,
						})),
						{ type: 'text', id: 'final', text: 'The final response remains primary.' },
					],
				},
			],
		},
	];
	const errors: string[] = [];
	const external: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (entry) => {
		if (entry.type() === 'error') errors.push(entry.text());
	});
	await page.route('https://**', (route) => {
		external.push(route.request().url());
		return route.abort();
	});
	await page.addInitScript((serialized) => {
		let saved: AppState = JSON.parse(serialized);
		let revision = 0;
		(window as any).unexpectedToolRequests = 0;
		(window as any).desktop = {
			platform: 'linux',
			workspaceLoad: async () => ({ state: structuredClone(saved), revision: String(revision) }),
			workspaceSave: async (_id: string, _revision: string, next: AppState) => {
				saved = structuredClone(next);
				return { revision: String(++revision) };
			},
			storageInfo: async () => ({ secure: false, location: '/tmp/synthetic-denial-profile' }),
			onPrepareClose: () => () => {},
			onToolApproval: () => () => {},
			instanceStatus: async () => ({
				host: { running: false, name: 'This computer', instanceId: 'local', port: 4319 },
				instances: [],
			}),
			toolCatalog: async () => ({ tools: [], instructions: '', warnings: [] }),
			request: async () => {
				(window as any).unexpectedToolRequests++;
				throw new Error('This fixture cannot call a model.');
			},
		};
	}, JSON.stringify(state));
	await page.goto('/');
	await expect(page).toHaveTitle('FreeLM');
	if (kind === 'code') await selectConversationMode(page, 'Code');
	await page.locator('.thread-select[title="Approval review fixture"]').click();
	await expect(page.locator('.message')).toHaveCount(2);
	await page.getByRole('button', { name: /^(Thought|Worked) for / }).click();
	return { errors, external };
}

for (const kind of ['chat', 'code'] as const)
	for (const width of [1440, 720]) {
		test(`${kind} keeps approval denials independently expandable at ${width}px`, async ({
			page,
		}) => {
			await page.setViewportSize({ width, height: 940 });
			const health = await fixture(page, kind);
			const history = page.getByRole('group', { name: 'Response activity', exact: true });
			await expect(history.locator('[data-tool-id]')).toHaveCount(8);
			await expect(history.locator('.approval-denied-activity')).toHaveCount(6);
			await expect(history.locator('.activity-history-group')).toHaveCount(0);
			await expect(history.locator('.approval-denied-details')).toHaveCount(0);
			await expect(history.locator('.tool-debug-details')).toHaveCount(0);
			await expect(history).not.toContainText('PRIVATE_DEBUG');
			const unavailable = history.locator('[data-tool-id="review-unavailable"]');
			await expect(unavailable).toHaveAttribute('data-tool-status', 'failed');
			await expect(unavailable.locator('summary')).toHaveText('Approval review failed');
			await unavailable.locator('summary').click();
			await expect(unavailable).toContainText('The action was not run.');
			await expect(unavailable.locator('.code-block pre code')).toHaveText('cat README.md');
			await expect(unavailable).not.toContainText('Approval denied');
			await expect(unavailable.locator('.activity-shimmer')).toHaveCount(0);
			const row = history.locator('[data-tool-id="denied-command"]');
			await expect(row).toHaveCount(1);
			await expect(row).toHaveAttribute('data-tool-status', 'denied');
			await expect(row.locator('summary')).toHaveText('Approval denied');
			await expect(row).not.toContainText('Ran ');
			await expect(row).not.toContainText('failed');
			await row.locator('summary').press('Enter');
			await expect(row.locator('.approval-denied-details')).toBeVisible();
			await expect(row).toContainText('Automatic review');
			await expect(row.locator('.approval-denied-reason > p')).toHaveText(reason);
			await expect(row).toContainText('/tmp/project/other');
			expect(await row.locator('.code-block pre code').textContent()).toBe(command);
			await expect(row.locator('.code-block pre')).toHaveCSS('overflow-x', 'auto');
			await expect(row.locator('script')).toHaveCount(0);
			await expect(row).not.toContainText('PRIVATE_DEBUG');
			expect(await page.evaluate(() => (window as any).denialInjected)).toBeUndefined();
			const legacy = history.locator('[data-tool-id="legacy-command"]');
			await expect(legacy).toHaveAttribute('data-tool-status', 'denied');
			await legacy.locator('summary').click();
			await expect(legacy.locator('.approval-denied-reason > p')).toHaveText(legacyReason);
			await expect(legacy).not.toContainText('Do not retry');
			await expect(legacy.locator('.code-block pre code')).toHaveText('cat legacy.txt');
			await expect(row.locator('.approval-denied-details')).toBeVisible();
			for (const [id, explanation] of [
				['denied-raw-patch', rawPatchReason],
				['denied-quoted-patch', quotedPatchReason],
			]) {
				const patchRow = history.locator(`[data-tool-id="${id}"]`);
				await patchRow.locator('summary').click();
				await expect(patchRow.locator('.approval-denied-reason > p')).toHaveText(explanation);
				expect(await patchRow.locator('.code-block pre code').textContent()).toBe(patch);
				await expect(patchRow).toContainText('/tmp/project/source.txt');
				await expect(patchRow).not.toContainText('Edited ');
			}
			const imageRow = history.locator('[data-tool-id="denied-image"]');
			await expect(imageRow).toHaveCount(1);
			await imageRow.locator('summary').click();
			await expect(imageRow.locator('.approval-denied-reason > p')).toHaveText(imageReason);
			await expect(imageRow).toContainText('A synthetic landscape');
			await expect(page.locator('.chat-image-result')).toHaveCount(0);
			await expect(imageRow.locator('img')).toHaveCount(0);
			const failure = history.locator('[data-tool-id="ordinary-command-failure"]');
			await expect(failure).toHaveAttribute('data-tool-status', 'failed');
			await expect(failure).toContainText('Could not run cat missing.txt');
			await expect(failure.locator('.approval-denied-activity')).toHaveCount(0);
			const failedPatch = history.locator('[data-tool-id="ordinary-patch-failure"]');
			await expect(failedPatch).toHaveAttribute('data-tool-status', 'failed');
			await expect(failedPatch).toContainText('Could not edit 1 file');
			await expect(failedPatch.locator('.approval-denied-activity')).toHaveCount(0);
			await page
				.getByRole('textbox', { name: 'Message', exact: true })
				.fill('The composer remains usable.');
			await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveText(
				'The composer remains usable.',
			);
			const overflow = await page.evaluate(() => ({
				width: innerWidth,
				scroll: document.documentElement.scrollWidth,
				chatWidth: document.querySelector('.chat-scroll')!.clientWidth,
				chatScroll: document.querySelector('.chat-scroll')!.scrollWidth,
			}));
			expect(overflow.scroll).toBeLessThanOrEqual(overflow.width);
			expect(overflow.chatScroll).toBeLessThanOrEqual(overflow.chatWidth);
			expect(await page.evaluate(() => (window as any).unexpectedToolRequests)).toBe(0);
			expect(health.errors).toEqual([]);
			expect(health.external).toEqual([]);
		});
	}
