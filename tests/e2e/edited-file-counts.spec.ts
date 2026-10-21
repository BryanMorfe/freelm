import { selectConversationMode } from './helpers/conversation-mode';
import { expect, test, type Page } from '@playwright/test';
import type { ToolCallRecord } from '../../src/agent-types';
import { initialState } from '../../src/lib/state';
import type { AppState } from '../../src/types';

// Browser plugin unavailable. Isolated production-App history only: no inference,
// command execution, or writes to the user's FreeLM profile.
function patch(paths: string[]) {
	return [
		'*** Begin Patch',
		...paths.flatMap((path) => [`*** Add File: ${path}`, '+content']),
		'*** End Patch',
	].join('\n');
}
function edit(
	id: string,
	paths: string[],
	format: 'native' | 'raw' | 'quoted' = 'native',
	name = 'apply_patch',
): ToolCallRecord {
	const value = patch(paths);
	return {
		id,
		name,
		arguments:
			format === 'native'
				? JSON.stringify({ patch: value })
				: format === 'quoted'
					? JSON.stringify(value)
					: value,
		status: 'completed',
		startedAt: 2000,
		completedAt: 2500,
		...(format === 'native'
			? {
					result: {
						content: [
							{
								type: 'text' as const,
								text: `Applied patch:\n${paths.map((path) => `A ${path}`).join('\n')}`,
							},
						],
						fileChanges: paths.map((path) => ({
							kind: 'add' as const,
							path,
							addedLines: 1,
							removedLines: 0,
						})),
					},
				}
			: {}),
	};
}

async function fixture(page: Page) {
	const state = initialState();
	state.debugMode = false;
	state.memorySettings = { savedMemories: false, referenceHistory: false };
	const connection = state.connections[0];
	connection.baseUrl = 'http://127.0.0.1:9/v1';
	connection.models.chat = 'file-count-model';
	connection.catalog = [
		{
			id: 'file-count-model',
			name: 'File count model',
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
	const calls = [
		edit('group-one', ['src/a.ts', 'src/b.ts']),
		edit('group-two', ['src/b.ts', 'src/c.ts'], 'native', 'functions.apply_patch'),
		edit('native-multi', ['docs/a.md', 'docs/b.md', 'docs/c.md']),
		edit('raw-multi', ['legacy/raw-a.ts', 'legacy/raw-b.ts'], 'raw'),
		edit(
			'quoted-multi',
			['legacy/quoted-a.ts', 'legacy/quoted-b.ts'],
			'quoted',
			'functions_apply_patch',
		),
	];
	state.threads = [
		{
			id: 'file-count-thread',
			kind: 'code',
			title: 'Edited file count review',
			titleSource: 'manual',
			connectionId: connection.id,
			model: 'file-count-model',
			thinkingMode: 'low',
			createdAt: 1000,
			updatedAt: 6000,
			messages: [
				{ id: 'user', role: 'user', content: 'Review these recorded file edits.', createdAt: 1000 },
				{
					id: 'count-answer',
					role: 'assistant',
					content: 'The recorded changes are ready.',
					createdAt: 1500,
					completedAt: 6000,
					activityFinishedAt: 5500,
					toolCalls: calls,
					activity: [
						{ type: 'tool', id: 'group-one-part', toolCallId: 'group-one' },
						{ type: 'tool', id: 'group-two-part', toolCallId: 'group-two' },
						{ type: 'text', id: 'native-break', text: 'Next are the documentation changes.' },
						{ type: 'tool', id: 'native-part', toolCallId: 'native-multi' },
						{ type: 'text', id: 'raw-break', text: 'Next is the older freeform record.' },
						{ type: 'tool', id: 'raw-part', toolCallId: 'raw-multi' },
						{ type: 'text', id: 'quoted-break', text: 'Finally, the quoted legacy record.' },
						{ type: 'tool', id: 'quoted-part', toolCallId: 'quoted-multi' },
						{ type: 'text', id: 'final', text: 'The recorded changes are ready.' },
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
				storageInfo: async () => ({ secure: false, location: '/tmp/private-file-count-test' }),
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
	await selectConversationMode(page, 'Code');
	await page.getByTitle('Edited file count review', { exact: true }).click();
	await expect(page.locator('.message')).toHaveCount(2);
	await page.getByRole('button', { name: /^Worked for / }).click();
}

test('edited file activity counts stay truthful across native and legacy patch records', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1100, height: 900 });
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await fixture(page);
	const history = page.locator('[data-message-id="count-answer"] .thought-history');
	const group = history.locator('.activity-history-group');
	await expect(group).toHaveCount(1);
	await expect(group.locator(':scope > summary')).toHaveText('Edited 3 files');
	await group.locator(':scope > summary').click();
	await expect(history.locator('[data-tool-id="group-one"] .edited-files-label')).toHaveText(
		'Edited 2 files',
	);
	await expect(history.locator('[data-tool-id="group-two"] .edited-files-label')).toHaveText(
		'Edited 2 files',
	);
	for (const [id, count] of [
		['native-multi', 3],
		['raw-multi', 2],
		['quoted-multi', 2],
	] as const) {
		const call = history.locator(`[data-tool-id="${id}"]`);
		await expect(call.locator('.edited-files-label')).toHaveText(`Edited ${count} files`);
		await call.locator('.edited-files-activity > summary').click();
		await expect(call.locator('.edited-file-row')).toHaveCount(count);
	}
	await expect(history.locator('[data-activity-id="native-break"]')).toContainText('documentation');
	await expect(history.locator('[data-activity-id="raw-break"]')).toContainText('freeform');
	await expect(history.locator('[data-activity-id="quoted-break"]')).toContainText('quoted');
	await expect(history.locator('.activity-shimmer')).toHaveCount(0);
	await expect(page.locator('.tool-debug-details')).toHaveCount(0);
	expect(errors).toEqual([]);
});
