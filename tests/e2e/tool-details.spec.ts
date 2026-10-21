import { selectConversationMode } from './helpers/conversation-mode';
import { expect, test, type Page } from '@playwright/test';
import { initialState } from '../../src/lib/state';
import type { AppState } from '../../src/types';

// Browser plugin not available. Isolated actual-App history with synthetic tool
// records; no provider requests, commands, or changes to the user's profile.
const command = `printf "spaces  stay"\npython -c "${'long_identifier_'.repeat(60)}"`;
const patch = `*** Begin Patch
*** Update File: src/app.ts
@@
-const old = true;
+const updated = true;
+const ready = true;
*** Add File: docs/guide.md
+# Guide
+Ready to use.
*** End Patch`;

async function fixture(page: Page, kind: 'chat' | 'code', errorDetails = false) {
	const state = initialState();
	state.memorySettings = { savedMemories: false, referenceHistory: false };
	const connection = state.connections[0];
	connection.models.chat = 'details-model';
	connection.catalog = [
		{
			id: 'details-model',
			name: 'Details model',
			enabled: true,
			tasks: ['chat'],
			inputModalities: ['text'],
			outputModalities: ['text'],
			thinkingModes: [
				{ id: 'low', name: 'Low', parameters: { responses: { reasoning: { effort: 'low' } } } },
			],
		},
	];
	const wrappedError =
		"Error invoking remote method 'freelm:tool-execute': ToolExecutionError: The request could not complete. Try again.\n    at execute (/private/host.ts:12:5)";
	const toolCalls = [
		{
			id: 'command',
			name: 'exec_command',
			arguments: JSON.stringify({ cmd: command }),
			status: 'completed' as const,
			result: { content: [{ type: 'text' as const, text: 'PRIVATE_DEBUG_COMMAND_OUTPUT' }] },
		},
		{
			id: 'plan',
			name: 'update_plan',
			arguments: JSON.stringify({
				explanation: 'Keep the changes focused.',
				plan: [
					{ step: 'Inspect the project', status: 'completed' },
					{ step: 'Verify the new interface', status: 'in_progress' },
				],
			}),
			status: 'completed' as const,
			result: { content: [] },
		},
		{
			id: 'patch',
			name: 'apply_patch',
			arguments: JSON.stringify({ patch }),
			status: 'completed' as const,
			result: {
				content: [
					{
						type: 'text' as const,
						text: 'Success. Updated the following files:\nM src/app.ts\nA docs/guide.md',
					},
				],
			},
		},
		{
			id: 'failed-patch',
			name: 'apply_patch',
			arguments: JSON.stringify({ patch }),
			status: 'failed' as const,
			result: {
				isError: true,
				content: [
					{ type: 'text' as const, text: errorDetails ? wrappedError : 'Could not apply patch.' },
				],
			},
		},
		...(errorDetails
			? [
					{
						id: 'failed-command',
						name: 'exec_command',
						arguments: JSON.stringify({ cmd: 'printf "Error: intentional example"' }),
						status: 'failed' as const,
						result: { isError: true, content: [{ type: 'text' as const, text: wrappedError }] },
					},
				]
			: []),
	].map((call) => ({ ...call, startedAt: 2500 }));
	state.threads = [
		{
			id: 'details-thread',
			kind,
			title: 'Tool details preview',
			titleSource: 'manual',
			connectionId: connection.id,
			model: 'details-model',
			thinkingMode: 'low',
			createdAt: 1000,
			updatedAt: 5000,
			messages: [
				{ id: 'user', role: 'user', content: 'Inspect these tool details.', createdAt: 1000 },
				{
					id: 'assistant',
					role: 'assistant',
					content: 'The final answer stays primary.',
					...(errorDetails ? { error: wrappedError } : {}),
					createdAt: 2000,
					completedAt: 5000,
					activityFinishedAt: 4500,
					toolCalls,
					activity: [
						...toolCalls.map((call) => ({
							type: 'tool' as const,
							id: `part-${call.id}`,
							toolCallId: call.id,
						})),
						{ type: 'text', id: 'final', text: 'The final answer stays primary.' },
					],
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
				storageInfo: async () => ({ secure: false, location: '/tmp/private-tool-details' }),
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
	await page.getByTitle('Tool details preview', { exact: true }).click();
	await expect(page.locator('.message')).toHaveCount(2);
	await page.getByRole('button', { name: /^(Thought|Worked) for / }).click();
}

test('persisted response and expanded tool failures use readable errors with Debug off', async ({
	page,
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await fixture(page, 'code', true);
	await expect(page.getByRole('alert')).toHaveText('The request could not complete. Try again.');
	const command = page.locator('[data-tool-id="failed-command"]');
	await command.locator('.activity-label').click();
	await expect(command.locator('.tool-error-message')).toHaveText(
		'The request could not complete. Try again.',
	);
	await expect(command.locator('.code-block pre code')).toHaveText(
		'printf "Error: intentional example"',
	);
	const patch = page.locator('[data-tool-id="failed-patch"]');
	await patch.locator('.edited-files-activity > summary').click();
	await expect(patch.locator('.tool-error-message')).toHaveText(
		'The request could not complete. Try again.',
	);
	await expect(page.locator('.messages')).not.toContainText('Error invoking remote method');
	await expect(page.locator('.messages')).not.toContainText('ToolExecutionError');
	await expect(page.locator('.messages')).not.toContainText('/private/host.ts');
	await expect(page.locator('.tool-debug-details')).toHaveCount(0);
	expect(errors).toEqual([]);
});

for (const kind of ['chat', 'code'] as const) {
	for (const width of [1440, 720]) {
		test(`${kind} exposes useful command, plan and file details at ${width}px`, async ({
			page,
		}) => {
			await page.setViewportSize({ width, height: 940 });
			const errors: string[] = [];
			page.on('pageerror', (error) => errors.push(error.message));
			page.on('console', (entry) => {
				if (entry.type() === 'error') errors.push(entry.text());
			});
			await fixture(page, kind);
			const commandRow = page.locator('[data-tool-id="command"]');
			const commandLabel = commandRow.locator('.activity-label');
			await expect(commandLabel).toHaveAttribute('aria-expanded', 'false');
			await expect(commandLabel.locator('code')).toHaveCount(0);
			await expect(commandRow.locator('.code-block')).toHaveCount(0);
			await commandLabel.press('Enter');
			await expect(commandLabel).toHaveAttribute('aria-expanded', 'true');
			await expect(commandRow.locator('.code-block pre code')).toHaveText(command);
			expect(await commandRow.locator('.code-block pre code').textContent()).toBe(command);
			await expect(commandRow.getByRole('button', { name: 'Copy code' })).toBeVisible();
			await expect(commandRow.locator('.code-block pre')).toHaveCSS('overflow-x', 'auto');
			const planRow = page.locator('[data-tool-id="plan"]');
			const planLabel = planRow.locator('.activity-label');
			await expect(planLabel).toHaveAttribute('aria-expanded', 'false');
			await expect(planRow.locator('.tool-plan')).toHaveCount(0);
			await planLabel.click();
			await expect(planRow.locator('.tool-plan')).toContainText('Inspect the project');
			await expect(planRow.locator('.tool-plan')).toContainText('Verify the new interface');
			await planLabel.click();
			await expect(planRow.locator('.tool-plan')).toHaveCount(0);
			await planLabel.click();
			const patchRow = page.locator('[data-tool-id="patch"]');
			await patchRow.locator('.edited-files-activity > summary').click();
			await expect(patchRow).toContainText('src/app.ts');
			await expect(patchRow).toContainText('docs/guide.md');
			await expect(patchRow).toContainText('+2');
			await expect(patchRow).toContainText(/[-−]1/);
			const changedFile = patchRow.locator('[data-file-path="src/app.ts"]');
			await expect(changedFile.locator('.edited-file-diff')).toHaveCount(0);
			await changedFile.locator('summary').click();
			await expect(changedFile.locator('.edited-file-diff')).toContainText('-const old = true;');
			await expect(changedFile.locator('.edited-file-diff')).toContainText(
				'+const updated = true;',
			);
			await expect(changedFile.locator('.edited-file-diff')).toHaveCSS('overflow-x', 'auto');
			const failedPatch = page.locator('[data-tool-id="failed-patch"]');
			await failedPatch.locator('.edited-files-activity > summary').click();
			await expect(failedPatch).toContainText('Could not edit 2 files');
			await expect(failedPatch).toContainText('Proposed changes · patch did not complete');
			await expect(page.locator('.tool-debug-details')).toHaveCount(0);
			await expect(page.locator('.messages')).not.toContainText('PRIVATE_DEBUG_COMMAND_OUTPUT');
			await expect(page.locator('.message-final')).toHaveText('The final answer stays primary.');
			await expect(page.locator('vite-error-overlay')).toHaveCount(0);
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
				true,
			);
			for (const node of await page.locator('.message-timeline, .thought-history').all())
				expect(
					await node.evaluate((element) => element.scrollWidth - element.clientWidth),
				).toBeLessThanOrEqual(1);
			await page.screenshot({ path: `/tmp/freelm-tool-details-${kind}-${width}.png` });
			await patchRow.locator('.edited-files-activity > summary').click();
			await expect(patchRow.locator('[data-file-path]').first()).not.toBeVisible();
			expect(errors).toEqual([]);
		});
	}
}
