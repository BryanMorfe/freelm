import { selectConversationMode } from './helpers/conversation-mode';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { initialState } from '../../src/lib/state';
import { defaultToolSettings } from '../../src/lib/tool-settings';
import { toolApiName } from '../../src/lib/agent';
import { webTool } from '../../src/lib/web-tools';
import type { AppState } from '../../src/types';

// Browser plugin not available. This private actual-App fixture controls every
// provider/tool response and never executes a command or touches the user profile.
const command = `printf "spaces  stay"\npython -c "${'inspect_long_identifier_without_overflow_'.repeat(28)}"`;
const query =
	'Research current tool status readability and keyboard expansion across narrow chat layouts while preserving the original search query';
const prose = 'Intermediate assistant prose remains readable in full. '.repeat(12);

async function fixture(page: Page, kind: 'chat' | 'code', failures = false) {
	const state = initialState();
	const connection = state.connections[0];
	connection.baseUrl = 'http://activity-preview.invalid/v1';
	connection.models.chat = 'activity-fixture';
	connection.catalog = [
		{
			id: 'activity-fixture',
			name: 'Activity fixture',
			enabled: true,
			tasks: ['chat'],
			inputModalities: ['text'],
			outputModalities: ['text'],
			thinkingModes: [
				{ id: 'low', name: 'Low', parameters: { responses: { reasoning: { effort: 'low' } } } },
			],
		},
	];
	state.memorySettings = { savedMemories: false, referenceHistory: false };
	state.toolSettings = {
		...defaultToolSettings(),
		enabled: kind === 'code',
		webBrowsing: { enabled: true, mode: 'external', searxngUrl: 'http://search.invalid' },
	};
	state.threads = [
		{
			id: 'activity-thread',
			kind,
			title: 'Activity preview',
			titleSource: 'manual',
			connectionId: connection.id,
			model: 'activity-fixture',
			thinkingMode: 'low',
			createdAt: 1000,
			updatedAt: 5000,
			messages: [
				{ id: 'user', role: 'user', content: 'Inspect the fixture.', createdAt: 1000 },
				{
					id: 'answer',
					role: 'assistant',
					content: 'The inspection finished.',
					createdAt: 2000,
					completedAt: 5000,
					activityFinishedAt: 4500,
					toolCalls: [
						{
							id: 'old-command',
							name: 'exec_command',
							arguments: JSON.stringify({ cmd: command }),
							status: 'completed',
							startedAt: 2500,
							result: { content: [{ type: 'text', text: 'PRIVATE_DEBUG_RESULT' }] },
						},
						{
							id: 'failed-call',
							name: kind === 'code' ? 'exec_command' : 'web.run',
							arguments: JSON.stringify(
								kind === 'code'
									? { cmd: 'cat missing.txt' }
									: { search_query: [{ q: 'missing result' }] },
							),
							status: 'failed',
							startedAt: 3000,
							result: {
								isError: true,
								content: [{ type: 'text', text: 'Synthetic unavailable result.' }],
							},
						},
						{
							id: 'error-result',
							name: 'view_image',
							arguments: JSON.stringify({ path: '/tmp/missing.png' }),
							status: 'completed',
							startedAt: 3250,
							result: { isError: true, content: [{ type: 'text', text: 'Image unavailable.' }] },
						},
						{
							id: 'failed-patch',
							name: 'apply_patch',
							arguments: JSON.stringify({
								patch:
									'*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new\n*** End Patch',
							}),
							status: 'failed',
							startedAt: 3500,
							result: {
								isError: true,
								content: [{ type: 'text', text: 'Could not apply patch.' }],
							},
						},
					],
					activity: [
						{ type: 'text', id: 'intermediate', text: prose },
						{ type: 'tool', id: 'tool-part', toolCallId: 'old-command' },
						{ type: 'tool', id: 'failure-part', toolCallId: 'failed-call' },
						{ type: 'tool', id: 'image-part', toolCallId: 'error-result' },
						{ type: 'tool', id: 'patch-part', toolCallId: 'failed-patch' },
						{ type: 'text', id: 'final', text: 'The inspection finished.' },
					],
				},
			],
		},
	];
	if (!failures) {
		const answer = state.threads[0].messages[1];
		answer.toolCalls = answer.toolCalls?.filter((call) => call.id === 'old-command');
		answer.activity = answer.activity?.filter(
			(part) => part.type !== 'tool' || part.toolCallId === 'old-command',
		);
	}
	await page.addInitScript(
		({ serialized, commandName, webName, webDefinition }) => {
			let saved: AppState = JSON.parse(serialized);
			let revision = 0;
			const listeners = new Set<(event: { id: string; text: string }) => void>();
			const rounds: any[] = [],
				calls: any[] = [];
			const control: any = { rounds, calls };
			(window as any).__activityPreview = control;
			control.tool = (index: number, name: string, args: any) => {
				const round = rounds[index];
				round.emit({
					type: 'response.completed',
					response: {
						status: 'completed',
						output: [
							{
								type: 'function_call',
								call_id: `active-${index}`,
								name: name === 'exec_command' ? commandName : webName,
								arguments: JSON.stringify(args),
							},
						],
					},
				});
				round.resolve({
					status: 200,
					contentType: 'text/event-stream',
					encoding: 'text',
					body: '',
				});
			};
			control.finishTool = (index: number) =>
				calls[index].resolve({ content: [{ type: 'text', text: 'Fixture complete.' }] });
			(window as any).desktop = {
				platform: 'linux',
				workspaceLoad: async () => ({ state: structuredClone(saved), revision: String(revision) }),
				workspaceSave: async (_id: string, _revision: string, next: AppState) => {
					saved = structuredClone(next);
					return { revision: String(++revision) };
				},
				storageInfo: async () => ({ secure: false, location: '/tmp/private-activity-preview' }),
				onPrepareClose: () => () => {},
				onToolApproval: () => () => {},
				instanceStatus: async () => ({
					host: { running: false, name: 'This computer', instanceId: 'local', port: 4319 },
					instances: [],
				}),
				toolCatalog: async () => ({
					tools: [
						webDefinition,
						{
							name: 'exec_command',
							description: 'Synthetic command fixture.',
							source: 'builtin',
							parameters: {
								type: 'object',
								properties: { cmd: { type: 'string' } },
								required: ['cmd'],
							},
						},
					],
					instructions: '',
					warnings: [],
				}),
				toolExecute: async (request: any) =>
					new Promise((resolve, reject) => calls.push({ ...request, resolve, reject })),
				toolCancel: async () =>
					calls.forEach((call) => call.reject(new DOMException('Cancelled', 'AbortError'))),
				onChunk: (listener: (event: { id: string; text: string }) => void) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				cancel: async (id: string) =>
					rounds
						.find((round) => round.id === id)
						?.reject(new DOMException('Cancelled', 'AbortError')),
				request: async (request: any) =>
					new Promise((resolve, reject) =>
						rounds.push({
							...request,
							resolve,
							reject,
							emit: (data: unknown) =>
								listeners.forEach((listener) =>
									listener({ id: request.id, text: `data: ${JSON.stringify(data)}\n\n` }),
								),
						}),
					),
			};
		},
		{
			serialized: JSON.stringify(state),
			commandName: toolApiName('exec_command'),
			webName: toolApiName('web.run'),
			webDefinition: webTool,
		},
	);
	await page.goto('/');
	await expect(page).toHaveTitle('FreeLM');
	if (kind === 'code') await selectConversationMode(page, 'Code');
	await page.getByTitle('Activity preview', { exact: true }).click();
	await expect(page.locator('.message')).toHaveCount(2);
	await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
}

async function assertCollapsed(label: Locator, expectClipped = true) {
	await expect(label).toHaveAttribute('aria-expanded', 'false');
	const span = label.locator('.activity-label-text');
	await expect(span).toHaveCSS('white-space', 'nowrap');
	await expect(span).toHaveCSS('text-overflow', 'ellipsis');
	const geometry = await span.evaluate((node) => ({
		width: node.clientWidth,
		contentWidth: node.scrollWidth,
		height: node.getBoundingClientRect().height,
		lineHeight: parseFloat(getComputedStyle(node).lineHeight),
	}));
	if (expectClipped) expect(geometry.contentWidth).toBeGreaterThan(geometry.width);
	expect(geometry.height).toBeLessThanOrEqual(geometry.lineHeight + 1);
}
async function assertNoOverflow(page: Page) {
	expect(
		await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
	).toBeLessThanOrEqual(1);
	const overflows = await page
		.locator('.message-timeline')
		.evaluateAll((nodes) => nodes.map((node) => node.scrollWidth - node.clientWidth));
	expect(Math.max(0, ...overflows)).toBeLessThanOrEqual(1);
}

async function tokenColor(page: Page, token: string) {
	return page.evaluate((name) => {
		const probe = document.createElement('span');
		probe.style.color = `var(${name})`;
		document.body.append(probe);
		const color = getComputedStyle(probe).color;
		probe.remove();
		return color;
	}, token);
}

async function assertFailure(row: Locator, page: Page) {
	await expect(row).toHaveAttribute('data-activity-state', 'failed');
	await expect(row.locator('.activity-shimmer')).toHaveCount(0);
	await expect(row.locator('small').filter({ hasText: /^failed$/i })).toHaveCount(0);
	const label = row.locator('.activity-label-text, .edited-files-label').first();
	await expect(label).toHaveCSS('color', await tokenColor(page, '--danger'));
	await label.hover();
	await expect(label).toHaveCSS('color', await tokenColor(page, '--danger'));
}

async function assertHistoryStates(page: Page) {
	for (const theme of ['dark', 'light']) {
		await page.evaluate((value) => {
			document.documentElement.dataset.theme = value;
		}, theme);
		await page.mouse.move(0, 0);
		const completed = page.locator('[data-tool-id="old-command"]');
		await expect(completed).toHaveAttribute('data-activity-state', 'completed');
		await expect(completed.locator('.activity-shimmer')).toHaveCount(0);
		await expect(completed.locator('.activity-label-text')).toHaveCSS(
			'color',
			await tokenColor(page, '--muted'),
		);
		await assertFailure(page.locator('[data-tool-id="failed-call"]'), page);
		await assertFailure(page.locator('[data-tool-id="error-result"]'), page);
		await assertFailure(page.locator('[data-tool-id="failed-patch"]'), page);
		await expect(page.locator('[data-tool-id="failed-patch"] .edited-files-label')).toContainText(
			'Could not edit',
		);
		await page.screenshot({
			path: `/tmp/freelm-activity-states-${test.info().title.split(' ')[0]}-${page.viewportSize()!.width}-${theme}.png`,
		});
	}
	await page.evaluate(() => {
		document.documentElement.dataset.theme = 'dark';
	});
}

for (const kind of ['chat', 'code'] as const) {
	for (const width of [1440, 720]) {
		test(`${kind} activity truncates and expands at ${width}px with preserved prose and command whitespace`, async ({
			page,
		}) => {
			test.setTimeout(120_000);
			await page.setViewportSize({ width, height: 940 });
			const errors: string[] = [];
			page.on('pageerror', (error) => errors.push(error.message));
			page.on('console', (entry) => {
				if (entry.type() === 'error') errors.push(entry.text());
			});
			await fixture(page, kind);
			await page.getByRole('button', { name: /^(Thought|Worked) for / }).click();
			const completed = page.locator('[data-tool-id="old-command"] .activity-label');
			await assertCollapsed(completed);
			await completed.focus();
			await completed.press('Enter');
			await expect(completed).toHaveAttribute('aria-expanded', 'true');
			const commandDetails = page.locator('[data-tool-id="old-command"] .activity-details');
			await expect(commandDetails.locator('.code-block-toolbar')).toContainText('bash');
			await expect(commandDetails.locator('pre code')).toHaveText(command);
			expect(await commandDetails.locator('pre code').textContent()).toBe(command);
			await expect(commandDetails.locator('pre')).toHaveCSS('white-space', 'pre');
			await expect(completed.locator('code')).toHaveCount(0);
			await expect(completed.locator('.activity-label-text')).toHaveCSS('white-space', 'nowrap');
			expect(await completed.evaluate((node) => node.getBoundingClientRect().height)).toBeLessThan(
				40,
			);
			await expect(page.locator('.thought-assistant-message')).toHaveText(prose.trim());
			await expect(page.locator('.message-final')).toHaveText('The inspection finished.');
			await expect(page.locator('.tool-debug-details')).toHaveCount(0);
			await expect(page.locator('.messages')).not.toContainText('PRIVATE_DEBUG_RESULT');
			await assertNoOverflow(page);
			await page.screenshot({ path: `/tmp/freelm-activity-${kind}-${width}-expanded.png` });
			await completed.press('Space');
			await assertCollapsed(completed);
			await expect(commandDetails).toBeHidden();
			await expect(commandDetails.locator('.code-block')).toHaveCount(0);
			await page.screenshot({ path: `/tmp/freelm-activity-${kind}-${width}-collapsed.png` });
			await page.getByLabel('Message', { exact: true }).fill('Continue the fixture.');
			await page.getByRole('button', { name: 'Send message', exact: true }).click();
			await expect
				.poll(() => page.evaluate(() => (window as any).__activityPreview.rounds.length))
				.toBe(1);
			const thinking = page.locator('.messages .working-status').last();
			await expect(thinking).toHaveText('Thinking');
			await expect(thinking.getByRole('button')).toHaveCount(0);
			await expect(thinking.locator('[data-activity-icon]')).toHaveCount(0);
			await expect(thinking.locator('.activity-shimmer')).toHaveCSS('background-size', '30% 100%');
			const shortWidth = await thinking.locator('.activity-shimmer').evaluate((element) => {
				const range = document.createRange();
				range.selectNodeContents(element);
				return Math.abs(
					element.getBoundingClientRect().width - range.getBoundingClientRect().width,
				);
			});
			expect(shortWidth).toBeLessThanOrEqual(1);
			await page.evaluate(
				({ kind, command, query }) =>
					(window as any).__activityPreview.tool(
						0,
						kind === 'code' ? 'exec_command' : 'web.run',
						kind === 'code' ? { cmd: command } : { search_query: [{ q: query }] },
					),
				{ kind, command, query },
			);
			const active = page.locator('.message-live-text [data-tool-id="active-0"] .activity-label');
			await assertCollapsed(active, kind === 'code' || width === 720);
			await expect(active.locator('.activity-shimmer')).toHaveCSS('animation-duration', '4s');
			await expect(active.locator('.activity-shimmer')).toHaveCSS('background-size', '30% 100%');
			await active.click();
			await expect(active).toHaveAttribute('aria-expanded', 'true');
			await expect(active).toContainText(kind === 'code' ? 'spaces  stay' : query);
			if (kind === 'code') {
				const code = page.locator(
					'.message-live-text [data-tool-id="active-0"] .activity-details pre code',
				);
				expect(await code.textContent()).toBe(command);
				await expect(active.locator('.activity-label-text')).toHaveCSS('white-space', 'nowrap');
			} else {
				await expect(active.locator('.activity-label-text')).toHaveCSS('white-space', 'nowrap');
				await expect(page.locator('[data-tool-id="active-0"] .tool-request-details')).toHaveText(
					`Query${query}`,
				);
			}
			await assertNoOverflow(page);
			await page.screenshot({ path: `/tmp/freelm-activity-${kind}-${width}-active.png` });
			await page.evaluate(() => (window as any).__activityPreview.finishTool(0));
			await expect
				.poll(() => page.evaluate(() => (window as any).__activityPreview.rounds.length))
				.toBe(2);
			await page.evaluate(() =>
				(window as any).__activityPreview.tool(1, 'web.run', {
					open: [{ ref_id: 'https://example.org' }],
				}),
			);
			const nextActive = page.locator(
				'.message-live-text [data-tool-id="active-1"] .activity-label',
			);
			await expect(nextActive).toHaveAttribute('aria-expanded', 'false');
			await expect(nextActive).toContainText('Reading');
			const nextText = nextActive.locator('.activity-label-text');
			const widths = await nextText.evaluate((element) => ({
				text: element.getBoundingClientRect().width,
				row: element.closest('.activity-label-container')!.getBoundingClientRect().width,
			}));
			expect(widths.text).toBeLessThan(widths.row);
			await nextActive.click();
			await expect(page.locator('[data-tool-id="active-1"] .tool-request-details')).toHaveText(
				'Pagehttps://example.org',
			);
			await expect(page.locator('vite-error-overlay')).toHaveCount(0);
			expect(errors).toEqual([]);
		});
	}
}

// Keep error-history rendering separate from controlled streaming: these records
// exercise result errors and patches without changing the live transport fixture.
for (const kind of ['chat', 'code'] as const) {
	test(`${kind} activity lifecycle colors keep failures red in both themes`, async ({ page }) => {
		await page.setViewportSize({ width: kind === 'chat' ? 720 : 1440, height: 940 });
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await fixture(page, kind, true);
		await page.getByRole('button', { name: /^(Thought|Worked) for / }).click();
		await assertHistoryStates(page);
		await assertNoOverflow(page);
		await expect(page.locator('vite-error-overlay')).toHaveCount(0);
		expect(errors).toEqual([]);
	});
}
