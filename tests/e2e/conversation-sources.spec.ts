import { selectConversationMode } from './helpers/conversation-mode';
import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { initialState } from '../../src/lib/state';
import { collectTaskOutputs } from '../../src/lib/task-outputs';
import type { AppState, Message, Thread } from '../../src/types';
import type { ToolCallRecord, ToolOutputFileChange } from '../../src/agent-types';

// Browser plugin not available. This saved-history fixture exercises the renderer
// without contacting a model, searching the web, or reading the user's files.
const image =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAKAAAAB4CAIAAAD6wG44AAABeElEQVR4nO3Ri00QAADE0Jvn5kRA+Yl/VEBUQHS5G4EpiEnT5A3QpOnBBJb/XqAX5WC49NUE5mA4B8OlhxOYg+EcDJceTWAOhnMwXHo8gTkYzsFw6esJzMFwDoZL30xgDoZzMFx6MoE5GM7BcOnpBOZgOAfDpWcTmIPhHAyXnk9gDoZzMFx6MYE5GM7BcOnbCczBcA6GSy8nMAfDORgufTeBORjOwXDp+wnMwXAOhks/TGAOhnMwXPpxAnMwnIPh0k8TmIPhHAyXfp7AHAznYLj0ywTmYDgHw6VXE5iD4RwMl36dwBwM52C49NsE5mA4B8Ol3ycwB8M5GC69nsAcDOdguPRmAnMwnIPh0tsJzMFwDoZLf0xgDoZzMFx6N4E5GM7BcOnPCczBcA6GS39NYA6GczBc+nsCczCcg+HS+wnMwXAOhksfJjAHwzkYLn2cwBwM52C49M8E5mA4B8OlTxOYg+EcDJf+ncAcDOdguPTfBOZgOAfDPQN61wfy2oBLGQAAAABJRU5ErkJggg==';

function fixtureState(): AppState {
	const state = initialState();
	state.theme = 'dark';
	state.connections[0].models.chat = 'review-model';
	state.connections[0].catalog = [
		{
			id: 'review-model',
			name: 'Review model',
			enabled: true,
			tasks: ['chat'],
			inputModalities: ['text', 'image'],
			outputModalities: ['text'],
			thinkingModes: [
				{ id: 'low', name: 'Low', parameters: { responses: { reasoning: { effort: 'low' } } } },
			],
		},
	];
	state.projects = [
		{
			id: 'review-project',
			kind: 'code',
			name: 'Review project',
			instructions: '',
			directories: ['/tmp/review-project'],
			createdAt: 1,
		},
	];
	const source = {
		id: 'page-1',
		title: 'Example research article',
		url: 'https://example.com/article',
		snippet: 'Search snippet.',
	};
	const calls: ToolCallRecord[] = [
		...['printf first', 'printf second'].map((cmd, i): ToolCallRecord => ({
			id: `command-${i}`,
			name: 'exec_command',
			arguments: JSON.stringify({ cmd }),
			status: 'completed',
			startedAt: 2000,
			completedAt: 3000,
			result: {
				content: [{ type: 'text', text: 'ok' }],
				process: { command: cmd, sessionId: `process-${i}`, exitCode: 0 },
			},
		})),
		...['first.png', 'second.png'].map((name, i): ToolCallRecord => ({
			id: `image-${i}`,
			name: 'view_image',
			arguments: JSON.stringify({ path: `/tmp/review-project/${name}` }),
			status: 'completed',
			startedAt: 2000,
			completedAt: 3000,
			result: { content: [{ type: 'image', name, dataUrl: image }] },
		})),
		{
			id: 'missing-image',
			name: 'view_image',
			arguments: JSON.stringify({ path: '/tmp/review-project/missing.png' }),
			status: 'failed',
			startedAt: 2000,
			completedAt: 3000,
			result: { content: [{ type: 'text', text: 'File not found' }], isError: true },
		},
		...['first query', 'second query'].map((q, i): ToolCallRecord => ({
			id: `search-${i}`,
			name: 'web.run',
			arguments: JSON.stringify({ search_query: [{ q }] }),
			status: 'completed',
			startedAt: 2000,
			completedAt: 3000,
			result: { content: [], research: { sources: [source] } },
		})),
		{
			id: 'opened',
			name: 'web.run',
			arguments: JSON.stringify({ open: [{ ref_id: 'page-1' }] }),
			status: 'completed',
			startedAt: 2000,
			completedAt: 3000,
			result: { content: [], research: { sources: [{ ...source, accessedAt: 5000 }] } },
		},
		{
			id: 'image-search',
			name: 'web.run',
			arguments: JSON.stringify({ image_query: [{ q: 'blue landscape' }] }),
			status: 'completed',
			startedAt: 2000,
			completedAt: 3000,
			result: {
				content: [],
				research: {
					images: [
						{
							id: 'web-image',
							title: 'Blue landscape',
							url: 'https://images.example.com/landscape.png',
							sourceUrl: 'https://example.com/landscape',
						},
					],
				},
			},
		},
		{
			id: 'image-view',
			name: 'image.view',
			arguments: JSON.stringify({ target: 'web-image' }),
			status: 'completed',
			startedAt: 2000,
			completedAt: 3000,
			result: {
				content: [{ type: 'image', name: 'web landscape', dataUrl: image }],
				research: {
					images: [
						{
							id: 'web-image',
							title: 'Blue landscape',
							url: 'https://images.example.com/landscape.png',
							sourceUrl: 'https://example.com/landscape',
							viewed: true,
						},
					],
				},
			},
		},
	];
	const messages: Message[] = [
		{
			id: 'user',
			role: 'user',
			content: 'Inspect the references and https://example.com/provided.',
			createdAt: 1000,
			attachments: [
				{ name: 'reference.png', type: 'image/png', dataUrl: image },
				{
					name: 'notes.txt',
					type: 'text/plain',
					dataUrl: 'data:text/plain;base64,U3ludGhldGljIHVwbG9hZCBub3Rlcw==',
				},
			],
		},
		{
			id: 'assistant',
			role: 'assistant',
			content: 'Here is the final answer.',
			createdAt: 2000,
			completedAt: 9000,
			activityFinishedAt: 8000,
			toolCalls: calls,
			activity: [
				...calls.map((call) => ({
					type: 'tool' as const,
					id: `activity-${call.id}`,
					toolCallId: call.id,
				})),
				{ type: 'text', id: 'final', text: 'Here is the final answer.' },
			],
		},
	];
	const thread = (id: string, kind: 'chat' | 'code', content: Message[]): Thread => ({
		id,
		kind,
		title: `${kind === 'code' ? 'Code' : 'Chat'} source review`,
		connectionId: state.activeConnectionId,
		model: 'review-model',
		thinkingMode: 'low',
		createdAt: 1000,
		updatedAt: 9000,
		...(kind === 'code' ? { projectId: 'review-project' } : {}),
		messages: content,
		messageHistory: [
			{
				id: 'hidden-version',
				role: 'user',
				content: 'https://example.com/inactive',
				createdAt: 500,
			},
		],
	});
	const outputCall = (
		id: string,
		changes: ToolOutputFileChange[],
		completedAt: number,
		overrides: Partial<ToolCallRecord> = {},
	): ToolCallRecord => ({
		id,
		name: 'apply_patch',
		arguments: '{}',
		status: 'completed',
		startedAt: completedAt - 100,
		completedAt,
		result: { content: [], fileChanges: changes, outputFiles: changes },
		...overrides,
	});
	const created = outputCall(
		'created-first-turn',
		[
			{ kind: 'add', path: '/tmp/review-project/first-output.txt' },
			{ kind: 'add', path: '/tmp/review-project/move-before.txt' },
			{ kind: 'add', path: '/tmp/review-project/deleted-output.txt' },
		],
		3500,
	);
	const existing = outputCall(
		'edited-existing',
		[{ kind: 'update', path: '/tmp/review-project/existing-only.txt' }],
		3600,
	);
	const denied = outputCall(
		'denied-creation',
		[{ kind: 'add', path: '/tmp/review-project/denied-output.txt' }],
		3700,
		{
			status: 'denied',
			result: {
				content: [{ type: 'text', text: 'Approval denied.' }],
				isError: true,
				approvalDenied: { reason: 'This proposed action was denied.' },
			},
		},
	);
	const followupCalls: ToolCallRecord[] = [
		outputCall(
			'renamed',
			[
				{
					kind: 'move',
					previousPath: '/tmp/review-project/move-before.txt',
					path: '/tmp/review-project/renamed-output.txt',
				},
			],
			10100,
		),
		outputCall(
			'deleted',
			[{ kind: 'delete', path: '/tmp/review-project/deleted-output.txt' }],
			10200,
		),
		outputCall(
			'created-next-turn',
			[
				{ kind: 'add', path: '/tmp/review-project/later-output.txt' },
				{ kind: 'add', path: '/tmp/review-project/missing-output.txt' },
				{ kind: 'add', path: '/tmp/review-project/unavailable-output.bin' },
			],
			10300,
		),
		outputCall(
			'created-alias',
			[{ kind: 'add', path: '/tmp/review-project/first-output-alias.txt' }],
			10310,
		),
		{
			id: 'download-report',
			name: 'python.exec',
			arguments: JSON.stringify({ code: '# Saved report fixture' }),
			status: 'completed',
			startedAt: 10300,
			completedAt: 10400,
			result: {
				content: [
					{
						type: 'file',
						name: 'report.csv',
						mimeType: 'text/csv',
						dataUrl: 'data:text/csv;base64,Y29sdW1uLHZhbHVlCnJlcG9ydCwxCg==',
					},
				],
			},
		},
	];
	const codeMessages: Message[] = [
		messages[0],
		{ ...messages[1], toolCalls: [...calls, created, existing, denied] },
		{ id: 'followup-user', role: 'user', content: 'Continue the same task.', createdAt: 9500 },
		{
			id: 'followup-assistant',
			role: 'assistant',
			content: 'The task outputs are ready.',
			createdAt: 10000,
			completedAt: 10900,
			toolCalls: followupCalls,
		},
	];
	const codeThread = thread('code-review', 'code', codeMessages);
	codeThread.messageHistory = [
		...(codeThread.messageHistory ?? []),
		{
			id: 'inactive-output-version',
			role: 'assistant',
			content: 'An earlier version created a file.',
			createdAt: 3800,
			completedAt: 4100,
			toolCalls: [
				outputCall(
					'created-in-history',
					[{ kind: 'add', path: '/tmp/review-project/history-output.md' }],
					4000,
				),
			],
		},
	];
	state.threads = [
		codeThread,
		{
			...thread('output-only', 'code', [
				{ id: 'output-only-user', role: 'user', content: 'Create a report.', createdAt: 1000 },
				{
					id: 'output-only-assistant',
					role: 'assistant',
					content: 'The report is ready.',
					createdAt: 2000,
					toolCalls: [followupCalls.at(-1)!],
				},
			]),
			title: 'Output-only conversation',
		},
		thread('chat-review', 'chat', messages),
		{
			...thread('empty-chat', 'chat', [
				{ id: 'empty-user', role: 'user', content: 'Hello', createdAt: 1000 },
				{ id: 'plain-assistant', role: 'assistant', content: 'Hello there.', createdAt: 2000 },
			]),
			title: 'Plain conversation',
		},
	];
	return state;
}

async function fixture(page: Page, theme: 'dark' | 'light' = 'dark') {
	const errors: string[] = [];
	const external: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (message) => {
		if (message.type() === 'error') errors.push(message.text());
	});
	await page.route(/^https?:\/\/(?!127\.0\.0\.1(?::|\/)|localhost(?::|\/)).*/, (route) => {
		external.push(route.request().url());
		return route.abort();
	});
	const state = fixtureState();
	state.theme = theme;
	const statuses = Object.fromEntries(
		state.threads.map((thread) => [
			thread.id,
			collectTaskOutputs(thread, { workspaceRoot: '/tmp/review-project' })
				.items.filter((item) => item.kind === 'local-file')
				.map((item) => ({
					id: item.id,
					exists: item.title !== 'missing-output.txt',
					canonicalPath:
						item.title === 'first-output-alias.txt'
							? '/tmp/review-project/first-output.txt'
							: item.path,
					identity:
						item.title === 'first-output-alias.txt'
							? '/tmp/review-project/first-output.txt'
							: item.path,
				})),
		]),
	);
	await writeFile('/tmp/freelm-review-1524-source-fixture.json', JSON.stringify(state));
	await page.addInitScript(
		({ serialized, statuses }) => {
			let state = JSON.parse(sessionStorage.getItem('sources-review-state') || serialized);
			let revision = 0;
			(window as any).__taskOutputReads = [];
			(window as any).__taskOutputStatusChecks = [];
			(window as any).__missingOutputNames = [];
			(window as any).__outputStatusError = false;
			(window as any).desktop = {
				platform: 'linux',
				workspaceLoad: async () => ({ state, revision: String(revision) }),
				workspaceSave: async (_id: string, _revision: string, next: AppState) => {
					state = next;
					sessionStorage.setItem('sources-review-state', JSON.stringify(next));
					return { revision: String(++revision) };
				},
				storageInfo: async () => ({ secure: false, location: '/tmp/synthetic-profile' }),
				onPrepareClose: () => () => {},
				onToolApproval: () => () => {},
				taskOutputStatus: async (workspaceId: string, threadId: string) => {
					(window as any).__taskOutputStatusChecks.push({ workspaceId, threadId });
					if ((window as any).__outputStatusError) throw new Error('Execution host unavailable.');
					return {
						threadId,
						files: (statuses[threadId] || []).map((item) => ({
							...item,
							exists:
								item.exists &&
								!(window as any).__missingOutputNames.includes(
									item.canonicalPath?.split('/').at(-1),
								),
						})),
						checkedAt: Date.now(),
						notices: [],
						truncated: false,
					};
				},
				taskOutputRead: async (workspaceId: string, threadId: string, outputId: string) => {
					(window as any).__taskOutputReads.push({ workspaceId, threadId, outputId });
					const name = outputId.split('/').at(-1)!;
					const result = { id: outputId, name, path: `/tmp/review-project/${name}` };
					if (name === 'missing-output.txt')
						return { ...result, unavailable: 'This output no longer exists.' };
					if (name === 'unavailable-output.bin')
						return {
							...result,
							mimeType: 'application/octet-stream',
							unavailable: 'Preview unavailable for this file type.',
							downloadUrl: 'data:application/octet-stream;base64,YQ==',
						};
					return {
						...result,
						size: 28,
						mimeType: 'text/plain',
						preview: {
							kind: 'text',
							text: `Synthetic preview of ${name}\nBounded fixture content.`,
							truncated: true,
						},
						downloadUrl: 'data:text/plain;base64,U3ludGhldGljIG91dHB1dCBjb250ZW50Lg==',
					};
				},
				instanceStatus: async () => ({
					host: { running: false, name: 'This computer', instanceId: 'local', port: 4319 },
					instances: [],
				}),
			};
		},
		{ serialized: JSON.stringify(state), statuses },
	);
	await page.goto('/');
	await expect(page).toHaveTitle('FreeLM');
	await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
	return { errors, external };
}

test('Code groups completed events and toggles an accurate pinned summary independently', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const health = await fixture(page);
	await selectConversationMode(page, 'Code');
	await page.locator('.thread-select[title="Code source review"]').click();
	const panel = page.getByRole('complementary', { name: 'Pinned summary', exact: true });
	await expect(panel).toBeVisible();
	await expect(panel.getByRole('heading', { name: 'Sources', exact: true })).toBeVisible();
	await expect(panel.getByRole('heading', { name: 'Outputs', exact: true })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Pinned summary', exact: true })).toHaveCount(0);
	const toggle = page.getByRole('button', { name: 'Hide pinned summary', exact: true });
	await expect(toggle).toHaveAttribute('aria-pressed', 'true');
	await expect(toggle).toHaveAttribute('aria-controls', 'pinned-summary-panel');
	const exportBounds = await page
		.getByRole('button', { name: 'Export task', exact: true })
		.boundingBox();
	const toggleBounds = await toggle.boundingBox();
	expect(toggleBounds!.x).toBeGreaterThan(exportBounds!.x);
	await expect(panel).toContainText('reference.png');
	await expect(panel).toContainText('notes.txt');
	await expect(panel).toContainText('Example research article');
	await expect(panel).toContainText('Blue landscape');
	await expect(panel.locator('a[href="https://example.com/article"]')).toHaveCount(1);
	await expect(panel.locator('a[href="https://example.com/provided"]')).toHaveCount(1);
	await expect(panel).not.toContainText('inactive');
	await expect(panel).not.toContainText('missing.png');
	const uploads = panel.locator('.conversation-source-upload');
	await uploads.filter({ hasText: 'reference.png' }).locator('summary').click();
	await expect(panel.locator('img[alt="reference.png"]')).toBeVisible();
	await uploads.filter({ hasText: 'notes.txt' }).locator('summary').click();
	await expect(panel.locator('.conversation-source-text')).toContainText('Synthetic upload notes');
	await uploads.filter({ hasText: 'reference.png' }).locator('summary').click();
	await uploads.filter({ hasText: 'notes.txt' }).locator('summary').click();
	await page.getByRole('button', { name: 'Worked for 7s', exact: true }).click();
	const history = page.getByRole('group', { name: 'Response activity', exact: true });
	const commandGroup = history
		.locator('details')
		.filter({ has: page.locator('summary', { hasText: 'Ran 2 commands' }) });
	await expect(commandGroup).toHaveCount(1);
	await commandGroup.locator('summary').click();
	await expect(commandGroup).toContainText('printf first');
	await expect(commandGroup).toContainText('printf second');
	const imagesGroup = history
		.locator('details')
		.filter({ has: page.locator('summary', { hasText: 'Viewed 2 images' }) });
	await imagesGroup.locator('summary').click();
	await expect(imagesGroup).toContainText('first.png');
	await expect(imagesGroup).toContainText('second.png');
	await expect(history.locator('[data-tool-id="missing-image"]')).toHaveAttribute(
		'data-activity-state',
		'failed',
	);
	await expect(history.locator('[data-tool-id="missing-image"]')).toContainText(
		'Could not view an image',
	);
	await expect(history.locator('.tool-debug-details')).toHaveCount(0);
	const alignment = await page
		.locator('.message.assistant')
		.first()
		.evaluate((element) => ({
			image: element.querySelector('.tool-images img')!.getBoundingClientRect().left,
			text: element.querySelector('.message-final')!.getBoundingClientRect().left,
		}));
	expect(Math.abs(alignment.image - alignment.text)).toBeLessThanOrEqual(1);
	await page.screenshot({ path: '/tmp/freelm-review-1524-wide.png' });
	await page.locator('.tool-images img').first().scrollIntoViewIfNeeded();
	await page.screenshot({ path: '/tmp/freelm-review-1524-image-alignment.png' });
	await expect(page.getByRole('button', { name: /^(Hide|Show|Close) sources$/ })).toHaveCount(0);
	await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
	await expect(panel).toBeVisible();
	await expect(panel.getByRole('heading', { name: 'Sources', exact: true })).toBeVisible();
	await expect(panel.getByRole('heading', { name: 'Outputs', exact: true })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Pinned summary', exact: true })).toHaveCount(0);
	await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
	await expect(panel).toBeVisible();
	const editor = page.getByRole('textbox', { name: 'Message', exact: true });
	await editor.fill('Preserve this Code draft while changing the layout.');
	await toggle.click();
	await expect(panel).toHaveCount(0);
	await expect(
		page.getByRole('button', { name: 'Show pinned summary', exact: true }),
	).toHaveAttribute('aria-pressed', 'false');
	await expect(editor).toHaveText('Preserve this Code draft while changing the layout.');
	await selectConversationMode(page, 'Chat');
	await page.locator('.thread-select[title="Chat source review"]').click();
	await expect(panel).toHaveCount(0);
	// Reload has no native close/flush handshake; wait for the ordinary draft save first.
	await expect
		.poll(() =>
			page.evaluate(() => {
				const saved = JSON.parse(sessionStorage.getItem('sources-review-state') || '{}');
				return saved.chatDrafts?.['code-review']?.content;
			}),
		)
		.toBe('Preserve this Code draft while changing the layout.');
	await page.reload();
	await page.locator('.thread-select[title="Chat source review"]').click();
	await expect(panel).toHaveCount(0);
	await page.getByRole('button', { name: 'Show pinned summary', exact: true }).click();
	await expect(panel).toBeVisible();
	await selectConversationMode(page, 'Code');
	await page.locator('.thread-select[title="Code source review"]').click();
	await expect(editor).toHaveText('Preserve this Code draft while changing the layout.');
	await expect(panel).toBeVisible();
	expect(health.errors).toEqual([]);
	expect(health.external).toEqual([]);
});

test('narrow pinned summary keeps draft, navigation, and history usable', async ({ page }) => {
	await page.setViewportSize({ width: 720, height: 900 });
	const health = await fixture(page);
	await page.locator('.thread-select[title="Chat source review"]').click();
	const panel = page.getByRole('complementary', { name: 'Pinned summary', exact: true });
	await expect(panel).toBeVisible();
	await expect(panel.getByRole('heading', { name: 'Sources', exact: true })).toBeVisible();
	await expect(panel.getByRole('heading', { name: 'Outputs', exact: true })).toHaveCount(0);
	await expect(page.getByRole('heading', { name: 'Pinned summary', exact: true })).toHaveCount(0);
	await expect(page.getByRole('button', { name: /^(Hide|Show|Close) sources$/ })).toHaveCount(0);
	const editor = page.getByRole('textbox', { name: 'Message', exact: true });
	await editor.fill('Keep this editable draft.');
	await expect(panel).toBeVisible();
	await page.screenshot({ path: '/tmp/freelm-review-1524-narrow.png' });
	await page.keyboard.press('Escape');
	await expect(panel).toBeVisible();
	await expect(editor).toHaveText('Keep this editable draft.');
	await page.locator('.thread-select[title="Plain conversation"]').click();
	await expect(panel).toContainText('Created files and referenced sources appear here.');
	await expect(page.locator('.conversation-sources-backdrop')).toHaveCount(0);
	await page.getByRole('button', { name: 'New chat', exact: true }).click();
	await expect(panel).toHaveCount(0);
	await expect(page.getByRole('button', { name: /^(Hide|Show) pinned summary$/ })).toHaveCount(0);
	await page.locator('.thread-select[title="Chat source review"]').click();
	await expect(editor).toHaveText('Keep this editable draft.');
	await expect
		.poll(() =>
			page.evaluate(() => {
				const saved = JSON.parse(sessionStorage.getItem('sources-review-state') || '{}');
				return saved.chatDrafts?.['chat-review']?.content;
			}),
		)
		.toBe('Keep this editable draft.');
	await page.reload();
	await page.locator('.thread-select[title="Chat source review"]').click();
	await expect(panel).toBeVisible();
	await expect(editor).toHaveText('Keep this editable draft.');
	const bounds = await panel.boundingBox();
	const chatBounds = await page.locator('.chat-workspace').boundingBox();
	expect(bounds!.y).toBeGreaterThanOrEqual(chatBounds!.y + chatBounds!.height - 1);
	const overflow = await page.evaluate(() => ({
		scroll: document.documentElement.scrollWidth,
		width: innerWidth,
		chatScroll: document.querySelector('.chat-scroll')!.scrollWidth,
		chatWidth: document.querySelector('.chat-scroll')!.clientWidth,
	}));
	expect(overflow.scroll).toBeLessThanOrEqual(overflow.width);
	expect(overflow.chatScroll).toBeLessThanOrEqual(overflow.chatWidth);
	await page.getByRole('button', { name: 'Hide pinned summary', exact: true }).click();
	await expect(panel).toHaveCount(0);
	await expect(editor).toHaveText('Keep this editable draft.');
	await page.getByRole('button', { name: 'Show pinned summary', exact: true }).click();
	await expect(panel).toBeVisible();
	expect(health.errors).toEqual([]);
	expect(health.external).toEqual([]);
});

for (const width of [1440, 720]) {
	test(`task-wide Outputs preview only on click and keep Sources separate at ${width}px`, async ({
		page,
	}) => {
		await page.setViewportSize({ width, height: 900 });
		const health = await fixture(page, width === 720 ? 'light' : 'dark');
		await selectConversationMode(page, 'Code');
		await page.locator('.thread-select[title="Code source review"]').click();
		const panel = page.getByRole('complementary', { name: 'Pinned summary', exact: true });
		const outputs = panel.getByRole('region', { name: 'Outputs', exact: true });
		await expect(panel.getByRole('heading', { name: 'Sources', exact: true })).toBeVisible();
		await expect(outputs.getByRole('heading', { name: 'Outputs', exact: true })).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Pinned summary', exact: true })).toHaveCount(0);
		const readCount = () => page.evaluate(() => (window as any).__taskOutputReads.length);
		const rows = outputs.getByRole('button', { name: /^Open output / });
		await expect(rows).toHaveCount(3);
		await expect(rows).toHaveText([
			'first-output.txtfirst-output.txt',
			'renamed-output.txtrenamed-output.txt',
			'history-output.mdhistory-output.md',
		]);
		await expect(
			outputs.getByRole('button', { name: 'View all 6 outputs', exact: true }),
		).toBeVisible();
		expect(await readCount()).toBe(0);
		const first = outputs.getByRole('button', {
			name: 'Open output first-output.txt',
			exact: true,
		});
		await first.hover();
		expect(await readCount()).toBe(0);
		const outputGap = await first.evaluate((row) => {
			const title = row.querySelector('.conversation-source-title')!.getBoundingClientRect();
			const path = row.querySelector('.conversation-source-path')!.getBoundingClientRect();
			return path.top - title.bottom;
		});
		expect(outputGap).toBeLessThanOrEqual(1);
		await outputs.getByRole('button', { name: 'View all 6 outputs', exact: true }).click();
		await expect(rows).toHaveCount(6);
		await expect(outputs).not.toContainText('first-output-alias.txt');
		await expect(outputs).not.toContainText('missing-output.txt');
		await expect(outputs).not.toContainText('move-before.txt');
		await expect(outputs).not.toContainText('deleted-output.txt');
		await expect(outputs).not.toContainText('existing-only.txt');
		await expect(outputs).not.toContainText('denied-output.txt');
		await expect(outputs).not.toContainText('reference.png');
		await expect(outputs).not.toContainText('notes.txt');
		await expect(outputs).not.toContainText('Blue landscape');
		await expect(
			outputs.getByRole('button', { name: 'Open output later-output.txt', exact: true }),
		).toBeVisible();
		await expect(
			outputs.getByRole('button', { name: 'Open output report.csv', exact: true }),
		).toBeVisible();
		expect(await readCount()).toBe(0);
		await first.click();
		const preview = page.getByRole('dialog', { name: 'Output: first-output.txt', exact: true });
		await expect(preview).toBeVisible();
		await expect(preview.locator('pre')).toContainText('Synthetic preview of first-output.txt');
		await expect(preview).toContainText(
			'Preview truncated. Download the file for its full contents.',
		);
		await expect(
			preview.getByRole('button', { name: 'Close output preview', exact: true }),
		).toBeFocused();
		await expect.poll(readCount).toBe(1);
		const read = await page.evaluate(() => (window as any).__taskOutputReads[0]);
		expect(read).toEqual({
			workspaceId: 'local',
			threadId: 'code-review',
			outputId: 'local:code-review:created-first-turn:/tmp/review-project/first-output.txt',
		});
		await page.keyboard.press('Shift+Tab');
		await expect(preview.getByRole('link', { name: 'Download', exact: true })).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(
			preview.getByRole('button', { name: 'Close output preview', exact: true }),
		).toBeFocused();
		const downloading = page.waitForEvent('download');
		await preview.getByRole('link', { name: 'Download', exact: true }).click();
		const download = await downloading;
		expect(download.suggestedFilename()).toBe('first-output.txt');
		await download.cancel();
		await page.keyboard.press('Escape');
		await expect(preview).toHaveCount(0);
		await expect(first).toBeFocused();
		expect(await readCount()).toBe(1);
		await outputs
			.getByRole('button', { name: 'Open output unavailable-output.bin', exact: true })
			.click();
		const unavailable = page.getByRole('dialog', {
			name: 'Output: unavailable-output.bin',
			exact: true,
		});
		await expect(unavailable.getByRole('status')).toHaveText(
			'Preview unavailable for this file type.',
		);
		await expect(unavailable.getByRole('link', { name: 'Download', exact: true })).toBeVisible();
		await page.keyboard.press('Escape');
		await expect.poll(readCount).toBe(2);
		await outputs.getByRole('button', { name: 'Open output report.csv', exact: true }).click();
		const artifact = page.getByRole('dialog', { name: 'Output: report.csv', exact: true });
		await expect(artifact.locator('pre')).toContainText('column,value');
		await expect(artifact.locator('pre')).toContainText('report,1');
		await expect(artifact.getByRole('link', { name: 'Download', exact: true })).toHaveAttribute(
			'download',
			'report.csv',
		);
		expect(await readCount()).toBe(2);
		await page.screenshot({ path: `/tmp/freelm-task-output-preview-${width}.png` });
		await page.keyboard.press('Escape');
		await outputs.getByRole('button', { name: 'Show less', exact: true }).click();
		await expect(rows).toHaveCount(3);
		await first.click();
		await expect(preview).toBeVisible();
		await expect.poll(readCount).toBe(3);
		await page.evaluate(() => {
			(window as any).__missingOutputNames = ['first-output.txt'];
			window.dispatchEvent(new Event('focus'));
		});
		await expect(first).toHaveCount(0);
		await expect(preview).toHaveCount(0);
		await expect(rows).toHaveCount(5);
		expect(await readCount()).toBe(3);
		await page.evaluate(() => {
			(window as any).__outputStatusError = true;
			window.dispatchEvent(new Event('focus'));
		});
		await expect(outputs.getByRole('status')).toContainText('Could not verify output files');
		await expect(rows).toHaveCount(1); // The persisted CSV remains downloadable.
		await expect(rows).toContainText('report.csv');
		await page.evaluate(() => {
			(window as any).__outputStatusError = false;
			(window as any).__missingOutputNames = [];
			window.dispatchEvent(new Event('focus'));
		});
		await expect(first).toBeVisible();
		await expect(page.getByRole('dialog', { name: /^Output:/ })).toHaveCount(0);
		expect(await readCount()).toBe(3);
		await expect(rows).toHaveCount(3);
		await page.screenshot({ path: `/tmp/freelm-existing-outputs-${width}.png` });
		const overflow = await page.evaluate(() => ({
			width: innerWidth,
			scroll: document.documentElement.scrollWidth,
		}));
		expect(overflow.scroll).toBeLessThanOrEqual(overflow.width);
		await selectConversationMode(page, 'Chat');
		await page.locator('.thread-select[title="Chat source review"]').click();
		await expect(outputs).toHaveCount(0);
		await expect(outputs.getByRole('button', { name: /^Open output / })).toHaveCount(0);
		await expect(panel).toContainText('reference.png');
		await expect(page.getByRole('dialog', { name: /^Output:/ })).toHaveCount(0);
		await page.locator('.thread-select[title="Plain conversation"]').click();
		await expect(outputs).toHaveCount(0);
		await expect(panel.getByRole('heading')).toHaveText(['Outputs & sources']);
		await expect(panel).toContainText('Created files and referenced sources appear here.');
		await page.screenshot({ path: `/tmp/freelm-compact-summary-${width}.png` });
		await selectConversationMode(page, 'Code');
		await page.locator('.thread-select[title="Output-only conversation"]').click();
		await expect(outputs.getByRole('button', { name: 'Open output report.csv' })).toBeVisible();
		await expect(panel.getByRole('heading', { name: 'Sources', exact: true })).toHaveCount(0);
		await expect(panel.locator('.conversation-summary-empty')).toHaveCount(0);
		await selectConversationMode(page, 'Chat');
		await page.getByRole('button', { name: 'New chat', exact: true }).click();
		await expect(panel).toHaveCount(0);
		await expect(page.getByRole('button', { name: /^(Hide|Show) pinned summary$/ })).toHaveCount(0);
		expect(await readCount()).toBe(3);
		expect(health.errors).toEqual([]);
		expect(health.external).toEqual([]);
	});
}
