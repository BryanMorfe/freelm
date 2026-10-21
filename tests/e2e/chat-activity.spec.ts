import { selectConversationMode } from './helpers/conversation-mode';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { initialState } from '../../src/lib/state';
import { defaultToolSettings } from '../../src/lib/tool-settings';
import { configuredImageTool } from '../../src/lib/image-tool';
import { webTool } from '../../src/lib/web-tools';
import { toolApiName } from '../../src/lib/agent';
import type { AppState } from '../../src/types';

test.setTimeout(120_000);

// Browser plugin not available. Exercise the actual renderer in isolated
// Playwright workspaces; stream and tool completion are explicitly controlled.
async function fixture(page: Page, kind: 'chat' | 'code' = 'chat') {
	const state = initialState();
	state.theme = 'dark';
	state.connections[0].models.chat = 'activity-model';
	state.connections[0].catalog = [
		{
			id: 'activity-model',
			name: 'Activity model',
			enabled: true,
			tasks: ['chat'],
			inputModalities: ['text', 'image'],
			outputModalities: ['text'],
			thinkingModes: [
				{ id: 'low', name: 'Low', parameters: { responses: { reasoning: { effort: 'low' } } } },
			],
		},
	];
	state.toolSettings = {
		...defaultToolSettings(),
		enabled: kind === 'code',
		webBrowsing: { enabled: true, mode: 'external', searxngUrl: 'http://search.test' },
		imageGeneration: {
			enabled: true,
			connectionId: state.activeConnectionId,
			model: 'image-model',
			size: '',
			quality: '',
		},
	};
	const imageTool = configuredImageTool(
		state.connections[0],
		state.toolSettings.imageGeneration,
		kind,
	);
	await page.addInitScript(
		({ serialized, tools, names }) => {
			let state: AppState = JSON.parse(sessionStorage.getItem('chat-activity-state') || serialized);
			let revision = 0;
			const listeners = new Set<(event: { id: string; text: string }) => void>();
			const requests: any[] = [];
			const calls: any[] = [];
			const control: any = { requests, calls, state: () => state };
			(window as any).__activityTest = control;
			const response = (body: unknown) => ({
				status: 200,
				contentType: 'application/json',
				encoding: 'text',
				body: JSON.stringify(body),
			});
			const canvas = document.createElement('canvas');
			canvas.width = 320;
			canvas.height = 240;
			const context = canvas.getContext('2d')!;
			context.fillStyle = '#101d31';
			context.fillRect(0, 0, 320, 240);
			const ice = context.createLinearGradient(80, 40, 240, 200);
			ice.addColorStop(0, '#e4edec');
			ice.addColorStop(0.55, '#96bfc7');
			ice.addColorStop(1, '#46677f');
			context.fillStyle = ice;
			context.beginPath();
			context.arc(160, 120, 85, 0, Math.PI * 2);
			context.fill();
			context.strokeStyle = '#42667a';
			context.lineWidth = 2;
			context.beginPath();
			context.moveTo(120, 50);
			context.lineTo(146, 110);
			context.lineTo(123, 180);
			context.moveTo(198, 48);
			context.lineTo(166, 105);
			context.lineTo(200, 181);
			context.stroke();
			const image = canvas.toDataURL();
			control.streamText = (index: number, text: string) => {
				const round = requests[index];
				round.emit({ type: 'response.output_text.delta', delta: text });
				round.text = (round.text || '') + text;
			};
			control.finishRound = (
				index: number,
				text: string,
				name?: string,
				args: Record<string, unknown> = {},
			) => {
				const round = requests[index];
				if (text && text !== round.text)
					round.emit({
						type: 'response.output_text.delta',
						delta: round.text && text.startsWith(round.text) ? text.slice(round.text.length) : text,
					});
				const output: Record<string, unknown>[] = [];
				if (text)
					output.push({
						type: 'message',
						role: 'assistant',
						content: [{ type: 'output_text', text }],
					});
				if (name)
					output.push({
						type: 'function_call',
						call_id: `call-${index}`,
						name: (names as Record<string, string>)[name],
						arguments: JSON.stringify(args),
					});
				round.emit({ type: 'response.completed', response: { status: 'completed', output } });
				round.resolve({
					status: 200,
					contentType: 'text/event-stream',
					encoding: 'text',
					body: '',
				});
			};
			control.finishTool = (index: number) => {
				const call = calls[index];
				call.resolve({
					content:
						call.name === 'image_gen.imagegen'
							? [
									{ type: 'text', text: 'Private image generation metadata' },
									{ type: 'image', name: 'europa.png', dataUrl: image },
								]
							: [
									{
										type: 'text',
										text: JSON.stringify({
											debug_test_marker: 'private-tool-result',
											results: [
												{ title: 'Europa ocean evidence', url: 'https://example.com/europa' },
											],
										}),
									},
								],
				});
			};
			(window as any).desktop = {
				platform: 'darwin',
				workspaceLoad: async () => ({ state: structuredClone(state), revision: String(revision) }),
				workspaceSave: async (_id: string, _revision: string, next: AppState) => {
					state = structuredClone(next);
					sessionStorage.setItem('chat-activity-state', JSON.stringify(state));
					return { revision: String(++revision) };
				},
				storageInfo: async () => ({ secure: true, location: '/test/.freelm/config.json' }),
				onPrepareClose: () => () => {},
				onToolApproval: () => () => {},
				instanceStatus: async () => ({
					host: { running: false, name: 'This computer', instanceId: 'local', port: 4319 },
					instances: [],
				}),
				toolCatalog: async () => ({ tools, instructions: '', warnings: [] }),
				toolExecute: async (request: any) =>
					new Promise((resolve, reject) => calls.push({ ...request, resolve, reject })),
				toolCancel: async () => {
					for (const call of calls) call.reject(new DOMException('Cancelled', 'AbortError'));
				},
				onChunk: (listener: (event: { id: string; text: string }) => void) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				cancel: async (id: string) => {
					requests
						.find((round) => round.id === id)
						?.reject(new DOMException('Cancelled', 'AbortError'));
				},
				request: async (request: any) => {
					if (request.body.instructions?.startsWith('Write a short conversation title'))
						return response({ output_text: 'Europa activity example' });
					return new Promise((resolve, reject) => {
						const emit = (data: unknown) => {
							for (const listener of listeners)
								listener({ id: request.id, text: `data: ${JSON.stringify(data)}\n\n` });
						};
						requests.push({ id: request.id, startedAt: Date.now(), resolve, reject, emit });
						emit({
							type: 'response.reasoning_text.delta',
							delta: 'Internal reasoning is not assistant prose.',
						});
					});
				},
			};
		},
		{
			serialized: JSON.stringify(state),
			tools: [
				webTool,
				imageTool,
				...(kind === 'code'
					? [
							{
								name: 'exec_command',
								description: 'Run a controlled command fixture.',
								source: 'builtin' as const,
								parameters: {
									type: 'object',
									properties: { cmd: { type: 'string' } },
									required: ['cmd'],
								},
							},
						]
					: []),
			],
			names: {
				'web.run': toolApiName('web.run'),
				'image_gen.imagegen': toolApiName('image_gen.imagegen'),
				exec_command: toolApiName('exec_command'),
			},
		},
	);
	await page.goto('/');
	await expect(page).toHaveTitle('FreeLM');
	await expect(page.getByLabel('Message', { exact: true })).toBeVisible({ timeout: 15_000 });
	await expect(page.locator('.composer-model-name')).toHaveText('Activity model');
	if (kind === 'code') await selectConversationMode(page, 'Code');
}

async function waitForCompletedActivityDuration(page: Page) {
	// These scenarios inspect completed activity. Keep the controlled request
	// beyond the product's one-second threshold so fast runners do not hide it.
	await expect
		.poll(() =>
			page.evaluate(() => Date.now() - (window as any).__activityTest.requests[0].startedAt),
		)
		.toBeGreaterThanOrEqual(1_100);
}

async function finishRound(
	page: Page,
	index: number,
	text: string,
	name?: string,
	args: Record<string, unknown> = {},
) {
	await expect
		.poll(() => page.evaluate(() => (window as any).__activityTest.requests.length))
		.toBeGreaterThan(index);
	if (!name) await waitForCompletedActivityDuration(page);
	await page.evaluate(
		({ index, text, name, args }) =>
			(window as any).__activityTest.finishRound(index, text, name, args),
		{ index, text, name, args },
	);
}
async function finishTool(page: Page, index: number) {
	await page.evaluate((index) => (window as any).__activityTest.finishTool(index), index);
}

async function expandActivity(page: Page) {
	const summary = page.locator('.thought-summary');
	await expect(summary).toBeVisible();
	if ((await summary.getAttribute('aria-expanded')) !== 'true') await summary.click();
	await expect(summary).toHaveAttribute('aria-expanded', 'true');
}

async function selectText(element: Locator) {
	await element.scrollIntoViewIfNeeded();
	// A real text selection happens after the scroll that revealed the text.
	// Let queued scroll events settle so they do not dismiss the new affordance.
	await element.evaluate(async () => {
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
	});
	await element.evaluate((node) => {
		const range = document.createRange();
		range.selectNodeContents(node);
		const selection = window.getSelection()!;
		selection.removeAllRanges();
		selection.addRange(range);
		node.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
	});
}

test('Code groups yielded shell sessions while streaming without claiming they finished', async ({
	page,
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await fixture(page, 'code');
	await page.getByLabel('Message', { exact: true }).fill('Run four project checks.');
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	const live = page.locator('.message-live-text');
	for (let index = 0; index < 4; index++) {
		await finishRound(page, index, index === 0 ? 'I’ll run the checks.' : '', 'exec_command', {
			cmd: `check-${index}`,
		});
		await expect
			.poll(() => page.evaluate(() => (window as any).__activityTest.calls.length))
			.toBe(index + 1);
		await page.evaluate((index) => {
			(window as any).__activityTest.calls[index].resolve({
				content: [],
				process: {
					command: `check-${index}`,
					sessionId: `session-${index}`,
					...(index < 2 ? {} : { exitCode: 0 }),
				},
			});
		}, index);
	}
	const group = live.locator('.activity-history-group');
	await expect(group).toHaveCount(1);
	await expect(group.locator(':scope > summary')).toHaveText('Running 4 commands');
	await group.locator(':scope > summary').click();
	await expect(group.locator('.tool-call')).toHaveCount(4);
	await expect(group.locator('.tool-status-line')).toHaveText([
		'Running check-0',
		'Running check-1',
		'Ran check-2',
		'Ran check-3',
	]);
	await page.screenshot({ path: '/tmp/freelm-computer-review-20261008/yielded-command-group.png' });
	await finishRound(page, 4, 'The checks are complete.');
	await expandActivity(page);
	await expect(page.locator('.thought-history .activity-history-group > summary')).toHaveText(
		'Ran 4 commands',
	);
	expect(errors).toEqual([]);
});

for (const kind of ['chat', 'code'] as const) {
	test(`completed ${kind} reasoning without intermediate messages keeps a noninteractive section label`, async ({
		page,
	}) => {
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		page.on('console', (message) => {
			if (message.type() === 'error') errors.push(message.text());
		});
		await fixture(page, kind);
		await page.getByLabel('Message', { exact: true }).fill('Explain Europa briefly without tools.');
		await page.getByRole('button', { name: 'Send message', exact: true }).click();
		await expect(page.locator('.working-status')).toHaveText('Thinking');
		await finishRound(page, 0, 'Europa is an icy moon of Jupiter.');
		const summary = page.locator('.thought-summary');
		const summaryName = new RegExp(`^${kind === 'code' ? 'Worked' : 'Thought'} for `);
		await expect(summary).toHaveText(
			new RegExp(`^${kind === 'code' ? 'Worked' : 'Thought'} for (?:\\d+s|\\d+m \\d+s)$`),
		);
		await expect(summary).toHaveCSS('border-bottom-width', kind === 'code' ? '1px' : '0px');
		await expect(summary).toHaveClass(/thought-summary-static/);
		await expect(summary).not.toHaveAttribute('aria-expanded');
		await expect(summary).not.toHaveAttribute('aria-controls');
		await expect(page.getByRole('button', { name: summaryName })).toHaveCount(0);
		await expect(summary.locator('svg')).toHaveCount(0);
		await summary.click();
		await expect(page.locator('.thought-history')).toHaveCount(0);
		const final = page.locator('.message-final');
		await expect(final).toHaveText('Europa is an icy moon of Jupiter.');
		expect(await summary.evaluate((node) => getComputedStyle(node).fontSize)).toBe(
			await final.locator('p').evaluate((node) => getComputedStyle(node).fontSize),
		);
		const geometry = await page.evaluate(() => {
			const summary = document.querySelector('.thought-summary')!.getBoundingClientRect();
			const final = document.querySelector('.message-final')!.getBoundingClientRect();
			return final.top - summary.bottom;
		});
		expect(geometry).toBeGreaterThanOrEqual(0);
		expect(geometry).toBeLessThanOrEqual(12);
		await page.screenshot({ path: `/tmp/freelm-review-${kind}-thinking-static.png` });
		await expect
			.poll(() =>
				page.evaluate(
					() => !!(window as any).__activityTest.state().threads[0]?.messages.at(-1)?.completedAt,
				),
			)
			.toBe(true);
		await page.reload();
		await expect(page.getByLabel('Message', { exact: true })).toBeVisible({ timeout: 15_000 });
		if (kind === 'code') await selectConversationMode(page, 'Code');
		await page.getByRole('button', { name: 'Europa activity example', exact: true }).click();
		await expect(summary).toHaveClass(/thought-summary-static/);
		await expect(summary).toHaveCSS('border-bottom-width', kind === 'code' ? '1px' : '0px');
		await expect(page.getByRole('button', { name: summaryName })).toHaveCount(0);
		await expect(final).toHaveText('Europa is an icy moon of Jupiter.');
		expect(errors).toEqual([]);
	});
}

test('Chat keeps completed tool history beneath commentary and collapses work around final text and images', async ({
	page,
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (message) => {
		if (message.type() === 'error') errors.push(message.text());
	});
	await fixture(page);
	await page
		.getByLabel('Message', { exact: true })
		.fill('Find evidence about Europa and create an illustration.');
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	const active = page.locator('.working-status');
	const search = page.locator('.message-live-text .tool-call[data-tool-name="web.run"]').first();
	await expect(active).toHaveCount(1);
	await expect(active).toHaveText('Thinking');
	await expect(page.locator('.messages')).not.toContainText('Working');
	await expect(page.locator('.messages')).not.toContainText('Internal reasoning');
	await finishRound(page, 0, 'I’ll look for evidence about Europa.', 'web.run', {
		search_query: [{ q: 'Europa ocean evidence' }],
	});
	await expect(active).toHaveCount(0);
	await expect(search).toHaveText('Searching for Europa ocean evidence');
	const activeSearchIcon = search.locator('svg.activity-icon[data-activity-icon="search"]');
	await expect(activeSearchIcon).toHaveCount(1);
	await expect(activeSearchIcon).toHaveAttribute('aria-hidden', 'true');
	await expect(activeSearchIcon).not.toHaveAttribute('aria-label');
	await expect(activeSearchIcon.locator('title')).toHaveCount(0);
	await expect(search.getByRole('img')).toHaveCount(0);
	await expect(search.locator('.activity-shimmer')).toHaveCSS('animation-duration', '4s');
	await expect(search).toHaveCSS('border-top-width', '0px');
	await expect(search).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
	await expect(page.locator('.tool-call details')).toHaveCount(0);
	await page.screenshot({ path: '/tmp/freelm-chat-activity-active.png' });
	await finishTool(page, 0);
	await expect(active).toHaveText('Thinking');
	await expect(page.locator('.message-live-text .tool-call')).toHaveCount(1);
	await expect(search).toHaveText('Searched for Europa ocean evidence');
	await expect(search.locator('.activity-shimmer')).toHaveCount(0);
	await finishRound(page, 1, 'I found a source and will read it.', 'web.run', {
		open: [{ ref_id: 'https://example.com/europa' }],
	});
	await expect(active).toHaveCount(0);
	await expect(page.locator('.message-live-text .tool-call').last()).toContainText('Reading');
	await expect(page.locator('.messages')).not.toContainText('Searching for Europa ocean evidence');
	await finishTool(page, 1);
	await expect(active).toHaveText('Thinking');
	await finishRound(page, 2, 'I’ll create an illustration of the icy moon.', 'image_gen.imagegen', {
		prompt: 'Europa, an icy moon above a dark ocean.',
		size: '1024x768',
	});
	await expect(page.getByRole('status', { name: 'Creating image…', exact: true })).toBeVisible();
	await expect(active).toHaveCount(0);
	await finishTool(page, 2);
	await expect(active).toHaveText('Thinking');
	await waitForCompletedActivityDuration(page);
	await page.evaluate(() =>
		(window as any).__activityTest.streamText(
			3,
			'Europa likely has an ocean beneath its icy crust. ',
		),
	);
	await expect(active).toHaveCount(0);
	await expect(page.locator('.messages')).toContainText('Europa likely has an ocean');
	await finishRound(
		page,
		3,
		'Europa likely has an ocean beneath its icy crust. Your illustration is ready.',
	);
	await expect(active).toHaveCount(0);
	const summary = page.locator('.thought-summary');
	await expect(summary).toHaveText(/^Thought for (?:\d+s|\d+m \d+s)$/);
	await expect(summary).toHaveAttribute('aria-expanded', 'false');
	await expect(page.locator('.thought-history')).toHaveCount(0);
	await expect(page.locator('.thought-output-divider')).toHaveCount(0);
	await expect(page.locator('.message-final')).toContainText('Europa likely has an ocean');
	await expect(page.locator('.messages')).not.toContainText('I found a source');
	await expect(
		page.getByRole('button', { name: 'Open generated image', exact: true }),
	).toBeVisible();
	await expect(page.locator('.messages')).not.toContainText('Private image generation metadata');
	await page.screenshot({ path: '/tmp/freelm-chat-activity-collapsed.png' });
	const image = page.getByRole('button', { name: 'Open generated image', exact: true });
	await image.click();
	await expect(page.getByRole('dialog', { name: 'Image viewer', exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog', { name: 'Image viewer', exact: true })).toHaveCount(0);
	await expect(image).toBeFocused();
	const duration = await summary.textContent();
	await summary.focus();
	await page.keyboard.press('Enter');
	await expect(summary).toHaveAttribute('aria-expanded', 'true');
	const history = page.locator('.thought-history');
	await expect(history.locator('.thought-reasoning')).toHaveCount(0);
	const divider = page.locator('.thought-output-divider');
	await expect(divider).toBeVisible();
	await expect(divider).toHaveCSS('border-top-width', '1px');
	await expect(history.locator('ul, ol, li')).toHaveCount(0);
	expect(await history.evaluate((element) => element.tagName)).not.toMatch(/^(UL|OL)$/);
	expect(
		await history.evaluate((element) =>
			Array.from(element.children).some((child) => getComputedStyle(child).display === 'list-item'),
		),
	).toBe(false);
	await expect(history).toContainText('I’ll look for evidence about Europa.');
	await expect(history).toContainText('I found a source and will read it.');
	await expect(history).toContainText('I’ll create an illustration of the icy moon.');
	await expect(history).toContainText('Europa ocean evidence');
	await expect(history).not.toContainText('Europa likely has an ocean');
	const reply = page.getByRole('button', { name: 'Reply to selection', exact: true });
	const intermediateText = history.locator('.thought-assistant-message p').first();
	await selectText(intermediateText);
	await expect(reply).toHaveCount(0);
	await intermediateText.click({ button: 'right', position: { x: 8, y: 8 }, timeout: 5_000 });
	await expect(page.getByRole('menu', { name: 'Message actions', exact: true })).toHaveCount(0);
	await page.keyboard.press('Escape');
	await expect(page.getByRole('button', { name: 'Open generated image', exact: true })).toHaveCount(
		1,
	);
	const assistantColor = await page
		.locator('.thought-assistant-message')
		.first()
		.evaluate((element) => getComputedStyle(element).color);
	expect(assistantColor).toBe(
		await page.locator('.message-final').evaluate((element) => getComputedStyle(element).color),
	);
	const tool = history.locator('.tool-call').first();
	const searchStatus = tool.locator('.tool-status-line');
	await expect(searchStatus).toHaveText('Searched for Europa ocean evidence');
	const historySearchIcon = searchStatus.locator('svg.activity-icon[data-activity-icon="search"]');
	await expect(historySearchIcon).toHaveCount(1);
	await expect(historySearchIcon).toHaveAttribute('aria-hidden', 'true');
	await expect(historySearchIcon).not.toHaveAttribute('aria-label');
	await expect(historySearchIcon.locator('title')).toHaveCount(0);
	await expect(searchStatus.getByRole('img')).toHaveCount(0);
	await selectText(searchStatus.locator('.activity-label'));
	await expect(reply).toHaveCount(0);
	await searchStatus
		.locator('.activity-label')
		.click({ button: 'right', position: { x: 8, y: 8 }, timeout: 5_000 });
	await expect(page.getByRole('menu', { name: 'Message actions', exact: true })).toHaveCount(0);
	await page.keyboard.press('Escape');
	await expect(
		tool.locator('details, summary, button:not(.activity-label), [role="button"], pre'),
	).toHaveCount(0);
	await expect(tool.locator('.activity-label')).toHaveCount(1);
	await expect(history.getByText('Done', { exact: true })).toHaveCount(0);
	await expect(history).not.toContainText('debug_test_marker');
	await expect(tool).toHaveCSS('border-top-width', '0px');
	await expect(tool).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
	expect(
		await history
			.locator('.thought-tool-message')
			.first()
			.evaluate((element) => getComputedStyle(element).color),
	).not.toBe(assistantColor);
	const userText = page.locator('.message.user .message-content p');
	await selectText(userText);
	await expect(reply).toHaveCount(0);
	await userText.click({ button: 'right', position: { x: 8, y: 8 }, timeout: 5_000 });
	await expect(page.getByRole('menu', { name: 'Message actions', exact: true })).toHaveCount(0);
	await page.keyboard.press('Escape');
	await selectText(page.locator('.message-final p'));
	await expect(reply).toBeVisible();
	await reply.click({ timeout: 5_000 });
	await expect(page.locator('.composer-reply-reference')).toContainText(
		'Europa likely has an ocean beneath its icy crust. Your illustration is ready.',
	);
	await page.getByRole('button', { name: 'Remove reply reference', exact: true }).click();
	await page.screenshot({ path: '/tmp/freelm-chat-activity-expanded.png' });
	await page.setViewportSize({ width: 760, height: 720 });
	await summary.click();
	await expect(summary).toHaveAttribute('aria-expanded', 'false');
	await expect(divider).toHaveCount(0);
	await expect(summary).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await page.screenshot({ path: '/tmp/freelm-chat-activity-compact.png' });
	await expect
		.poll(() =>
			page.evaluate(
				() => !!(window as any).__activityTest.state().threads[0]?.messages.at(-1)?.completedAt,
			),
		)
		.toBe(true);
	await page.reload();
	await page.getByRole('button', { name: 'Europa activity example', exact: true }).click();
	await expect(summary).toHaveText(duration!);
	await expect(summary).toHaveAttribute('aria-expanded', 'false');
	await expect(page.locator('.message-final')).toContainText('Europa likely has an ocean');
	await expect(
		page.getByRole('button', { name: 'Open generated image', exact: true }),
	).toBeEnabled();
	expect(errors).toEqual([]);
});

test('Debug mode defaults off and reveals raw tool results only after explicitly saving the setting', async ({
	page,
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (message) => {
		if (message.type() === 'error') errors.push(message.text());
	});
	await fixture(page);
	await page.getByLabel('Message', { exact: true }).fill('Find evidence about Europa.');
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	await expect(page.locator('.working-status')).toHaveText('Thinking');
	await finishRound(page, 0, 'I’ll search for evidence.', 'web.run', {
		search_query: [{ q: 'Europa debug fixture' }],
	});
	await expect(page.locator('.message-live-text .tool-call')).toHaveText(
		'Searching for Europa debug fixture',
	);
	await finishTool(page, 0);
	await expect(page.locator('.working-status')).toHaveText('Thinking');
	await finishRound(page, 1, 'Europa likely has an ocean beneath its icy crust.');
	const summary = page.locator('.thought-summary');
	await expect(summary).toHaveAttribute('aria-expanded', 'false');
	await expandActivity(page);
	const history = page.locator('.thought-history');
	await expect(history.locator('.tool-call')).toHaveCount(1);
	await expect(history.locator('details, summary, pre')).toHaveCount(0);
	await expect(history.getByText('Done', { exact: true })).toHaveCount(0);
	await expect(history).not.toContainText('debug_test_marker');
	await page.screenshot({ path: '/tmp/freelm-debug-off.png' });
	const settings = page.getByRole('region', { name: 'Settings', exact: true });
	await page.getByRole('button', { name: 'Personal workspace settings', exact: true }).click();
	await settings.getByRole('button', { name: 'Appearance', exact: true }).click();
	const debug = settings.getByRole('switch', { name: 'Debug mode', exact: true });
	await expect(debug).toHaveAttribute('aria-checked', 'false');
	await debug.click();
	await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => (window as any).__activityTest.state().debugMode))
		.toBe(true);
	await settings.getByRole('button', { name: 'Back to workspace', exact: true }).click();
	await expandActivity(page);
	const details = history.locator('.tool-call details');
	await expect(details).toHaveCount(1);
	await details.locator('summary').click();
	await expect(details.locator('.tool-output')).toContainText('debug_test_marker');
	await expect(details.locator('.tool-output')).toContainText('private-tool-result');
	await expect(page.locator('.message-final')).toContainText('Europa likely has an ocean');
	await page.screenshot({ path: '/tmp/freelm-debug-on.png' });
	await page.reload();
	await page.getByRole('button', { name: 'Europa activity example', exact: true }).click();
	await expandActivity(page);
	await expect(details).toHaveCount(1);
	await details.locator('summary').click();
	await expect(details.locator('.tool-output')).toContainText('private-tool-result');
	await page.getByRole('button', { name: 'Personal workspace settings', exact: true }).click();
	await settings.getByRole('button', { name: 'Appearance', exact: true }).click();
	await expect(debug).toHaveAttribute('aria-checked', 'true');
	await debug.click();
	await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => (window as any).__activityTest.state().debugMode))
		.toBe(false);
	await settings.getByRole('button', { name: 'Back to workspace', exact: true }).click();
	await expandActivity(page);
	await expect(details).toHaveCount(0);
	await expect(history.locator('pre')).toHaveCount(0);
	await expect(history).not.toContainText('private-tool-result');
	await page.reload();
	await page.getByRole('button', { name: 'Europa activity example', exact: true }).click();
	await expandActivity(page);
	await expect(details).toHaveCount(0);
	await expect(history).not.toContainText('debug_test_marker');
	await expect(page.locator('.message-final')).toContainText('Europa likely has an ocean');
	expect(errors).toEqual([]);
});

test('Code preserves interleaved live commentary and tool history until the final answer collapses it', async ({
	page,
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (message) => {
		if (message.type() === 'error') errors.push(message.text());
	});
	await fixture(page, 'code');
	await expect(page.locator('vite-error-overlay, #webpack-dev-server-client-overlay')).toHaveCount(
		0,
	);
	const composer = page.getByLabel('Message', { exact: true });
	await composer.fill('Inspect the source, then check the affected tests.');
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	const firstCommentary = 'I’ll inspect the source files before choosing a change.';
	const secondCommentary = 'The source is clear; I’ll now check the matching tests.';
	const firstCommand = 'rg --files src/components src/lib';
	const secondCommand = `rg -n 'activity' ${Array.from(
		{ length: 24 },
		(_, index) => `tests/activity-timeline-case-${index}.test.ts`,
	).join(' ')}`;
	const live = page.locator('.message-live-text');
	const liveRows = live.locator(':scope > [data-activity-id]');
	const liveTools = live.locator('.tool-call');
	const final = page.locator('.message-final');
	const working = page.locator('.working-section-header');
	const awaitRound = async (index: number) => {
		await expect
			.poll(() => page.evaluate(() => (window as any).__activityTest.requests.length))
			.toBe(index + 1);
	};
	const streamText = async (index: number, text: string) => {
		await page.evaluate(
			({ index, text }) => (window as any).__activityTest.streamText(index, text),
			{ index, text },
		);
	};
	const ordered = async (expected: string[]) => {
		await expect(liveRows).toHaveText(expected);
	};
	await awaitRound(0);
	await expect(working).toHaveText(/^Working for (?:\d+s|\d+m \d+s)$/);
	await expect(working).toHaveCSS('border-bottom-width', '1px');
	await expect(working.locator('.activity-shimmer, svg')).toHaveCount(0);
	await expect(page.locator('.working-status')).toHaveText('Thinking');
	await streamText(0, firstCommentary);
	await expect(final).toHaveText(firstCommentary);
	await finishRound(page, 0, firstCommentary, 'exec_command', { cmd: firstCommand });
	await ordered([firstCommentary, `Running ${firstCommand}`]);
	await expect(final).toHaveCount(0);
	await expect(liveTools.first()).toHaveAttribute('data-tool-status', 'running');
	await expect(liveTools.first().locator('.activity-shimmer')).toHaveCSS(
		'animation-duration',
		'4s',
	);
	await expect(liveTools.first().locator('[data-activity-icon="terminal"]')).toHaveCount(1);
	await expect(liveRows.last()).toHaveAttribute('role', 'status');
	const duringTool = await working.textContent();
	await expect(working).not.toHaveText(duringTool!);
	const firstActivityId = await liveRows.first().getAttribute('data-activity-id');
	const firstToolId = await liveTools.first().getAttribute('data-tool-id');
	await finishTool(page, 0);
	await awaitRound(1);
	await ordered([firstCommentary, `Ran ${firstCommand}`]);
	await expect(liveTools.first()).toHaveAttribute('data-tool-status', 'completed');
	await expect(liveTools.first()).toHaveAttribute('data-tool-id', firstToolId!);
	await expect(liveTools.first().locator('.activity-shimmer')).toHaveCount(0);
	await expect(working).toHaveText(/^Working for (?:\d+s|\d+m \d+s)$/);
	await expect(page.locator('.thought-summary, .thought-history, .active-tool-status')).toHaveCount(
		0,
	);
	await streamText(1, secondCommentary);
	await expect(final).toHaveText(secondCommentary);
	await ordered([firstCommentary, `Ran ${firstCommand}`]);
	expect(
		await page.locator('.message-timeline').evaluate((element) => {
			const command = element
				.querySelector('.message-live-text .tool-call')!
				.getBoundingClientRect();
			const nextCommentary = element.querySelector('.message-final')!.getBoundingClientRect();
			return command.bottom <= nextCommentary.top;
		}),
	).toBe(true);
	await finishRound(page, 1, secondCommentary, 'exec_command', { cmd: secondCommand });
	await ordered([
		firstCommentary,
		`Ran ${firstCommand}`,
		secondCommentary,
		`Running ${secondCommand}`,
	]);
	await expect(liveRows.first()).toHaveAttribute('data-activity-id', firstActivityId!);
	await expect(liveTools.first()).toHaveAttribute('data-tool-id', firstToolId!);
	await expect(liveTools).toHaveCount(2);
	await expect(liveTools.last()).toHaveAttribute('data-tool-status', 'running');
	await expect(live.locator('[data-activity-icon="terminal"]')).toHaveCount(2);
	await expect(live.locator('.activity-shimmer')).toHaveCount(1);
	await expect(page.locator('.tool-debug-details, .tool-arguments, .tool-output')).toHaveCount(0);
	await expect(page.locator('.messages')).not.toContainText('debug_test_marker');
	await expect(page.locator('.messages')).not.toContainText('Internal reasoning');
	await expect(page.locator('.messages')).not.toContainText('Tool details');
	const longLabel = liveTools.last().locator('.activity-label');
	const labelText = longLabel.locator('.activity-label-text');
	await expect(longLabel).toHaveAttribute('aria-expanded', 'false');
	await expect(labelText).toHaveCSS('white-space', 'nowrap');
	await expect(labelText).toHaveCSS('text-overflow', 'ellipsis');
	expect(await labelText.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
		true,
	);
	await expect(composer).toBeEnabled();
	await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await page.screenshot({ path: '/tmp/freelm-code-live-timeline-wide.png' });
	await page.setViewportSize({ width: 760, height: 900 });
	await expect(composer).toBeVisible();
	await expect(longLabel).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await page.screenshot({ path: '/tmp/freelm-code-live-timeline-narrow.png' });
	await longLabel.click();
	await expect(longLabel).toHaveAttribute('aria-expanded', 'true');
	await expect(labelText).toHaveCSS('white-space', 'nowrap');
	await expect(liveTools.last().locator('.code-block pre code')).toHaveText(secondCommand);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await longLabel.click();
	await expect(longLabel).toHaveAttribute('aria-expanded', 'false');
	await finishTool(page, 1);
	await awaitRound(2);
	await ordered([firstCommentary, `Ran ${firstCommand}`, secondCommentary, `Ran ${secondCommand}`]);
	await expect(liveTools).toHaveCount(2);
	await expect(live.locator('.activity-shimmer')).toHaveCount(0);
	await expect(working).toHaveText(/^Working for (?:\d+s|\d+m \d+s)$/);
	await expect(page.locator('.thought-summary')).toHaveCount(0);
	const answer = 'The source and its tests agree. The inspection is complete.';
	await streamText(2, answer);
	await expect(final).toHaveText(answer);
	await expect(liveTools).toHaveCount(2);
	const duringAnswer = await working.textContent();
	await expect(working).not.toHaveText(duringAnswer!);
	await expect(page.locator('.working-status')).toHaveCount(0);
	await finishRound(page, 2, answer);
	await expect(live).toHaveCount(0);
	const summary = page.locator('.thought-summary');
	await expect(summary).toHaveText(/^Worked for (?:\d+s|\d+m \d+s)$/);
	await expect(summary).toHaveAttribute('aria-expanded', 'false');
	await expect(summary).toHaveCSS('border-bottom-width', '1px');
	await expect(page.locator('.thought-output-divider')).toHaveCount(0);
	expect(
		await summary.evaluate((node) => {
			const header = node.getBoundingClientRect();
			const output = node
				.closest('.message-timeline')!
				.querySelector('.message-final')!
				.getBoundingClientRect();
			return header.bottom <= output.top && Math.abs(header.width - output.width) < 1;
		}),
	).toBe(true);
	await expect(page.locator('.thought-history')).toHaveCount(0);
	await expect(final).toHaveText(answer);
	await expect(page.locator('.messages')).not.toContainText(firstCommentary);
	await summary.click();
	await expect(summary).toHaveCSS('border-bottom-width', '1px');
	expect(
		await summary.evaluate(
			(node) =>
				node.getBoundingClientRect().bottom <=
				node
					.closest('.thought-activity')!
					.querySelector('.thought-history')!
					.getBoundingClientRect().top,
		),
	).toBe(true);
	await expect(page.locator('.thought-history > [data-activity-id]')).toHaveText([
		firstCommentary,
		`Ran ${firstCommand}`,
		secondCommentary,
		`Ran ${secondCommand}`,
	]);
	await expect(page.locator('.thought-history .tool-call')).toHaveCount(2);
	await expect(page.locator('.thought-output-divider')).toBeVisible();
	await expect(page.locator('.tool-debug-details')).toHaveCount(0);
	expect(errors).toEqual([]);
});

test('Code expands commands into code blocks, keeps useful history, and cancels a later response', async ({
	page,
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (message) => {
		if (message.type() === 'error') errors.push(message.text());
	});
	await fixture(page, 'code');
	await page.getByLabel('Message', { exact: true }).fill('Inspect this project.');
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	const active = page.locator('.working-section-header');
	const shimmer = page.locator('.working-status > .activity-shimmer');
	await expect(active).toHaveCount(1);
	await expect(active).toHaveText(/^Working for (?:\d+s|\d+m \d+s)$/);
	await expect(active.locator('.activity-shimmer')).toHaveCount(0);
	await expect(shimmer).toHaveText('Thinking');
	await expect(shimmer.locator('*')).toHaveCount(0);
	await expect(active).not.toHaveText('Working for 0s', { timeout: 10_000 });
	await expect(shimmer).toHaveCSS('animation-duration', '4s');
	const command = "printf '%s\\n' 'Inspecting README.md'";
	await finishRound(page, 0, 'I’ll inspect the project readme.', 'exec_command', { cmd: command });
	const commandStatus = page.locator('.message-live-text .tool-status-line');
	await expect(commandStatus).toHaveText(`Running ${command}`);
	await expect(page.locator('.active-tool-status')).toHaveCount(0);
	await expect(page.locator('.message-live-text')).toContainText(
		'I’ll inspect the project readme.',
	);
	await expect(commandStatus.locator('code')).toHaveCount(0);
	await expect(commandStatus.locator('[data-activity-icon="terminal"]')).toHaveCount(1);
	await page.screenshot({ path: '/tmp/freelm-code-inline-command-active.png' });
	await finishTool(page, 0);
	await expect(active).toHaveText(/^Working for (?:\d+s|\d+m \d+s)$/);
	await expect(commandStatus).toHaveText(`Ran ${command}`);
	await finishRound(page, 1, 'The project readme describes a desktop assistant.');
	await expect(active).toHaveCount(0);
	await expandActivity(page);
	const history = page.locator('.thought-history');
	await expect(history.locator('.thought-reasoning')).toHaveCount(0);
	await expect(history).toContainText('I’ll inspect the project readme.');
	await expect(history.locator('.tool-status-line')).toHaveText(`Ran ${command}`);
	await history.locator('.activity-label').click();
	const completedCommand = history.locator('.code-block pre code');
	await expect(completedCommand).toHaveText(command);
	await expect(page.locator('.thought-output-divider')).toBeVisible();
	const reply = page.getByRole('button', { name: 'Reply to selection', exact: true });
	await selectText(completedCommand);
	await expect(reply).toHaveCount(0);
	await completedCommand.click({ button: 'right', position: { x: 8, y: 8 }, timeout: 5_000 });
	await expect(page.getByRole('menu', { name: 'Message actions', exact: true })).toHaveCount(0);
	await page.keyboard.press('Escape');
	await selectText(history.locator('.thought-assistant-message p'));
	await expect(reply).toHaveCount(0);
	const finalText = page.locator('.message-final p');
	await selectText(finalText);
	await expect(reply).toBeVisible();
	await finalText.click({ button: 'right', position: { x: 8, y: 8 }, timeout: 5_000 });
	await expect(reply).toHaveCount(0);
	const selectedTextMenu = page.getByRole('menu', { name: 'Message actions', exact: true });
	await expect(selectedTextMenu).toBeVisible();
	expect(
		await selectedTextMenu.evaluate((element) => {
			const bounds = element.getBoundingClientRect();
			return (
				bounds.left >= 0 &&
				bounds.top >= 0 &&
				bounds.right <= innerWidth &&
				bounds.bottom <= innerHeight
			);
		}),
	).toBe(true);
	await expect(
		selectedTextMenu.getByRole('menuitem', { name: 'Copy selection', exact: true }),
	).toBeVisible();
	await selectedTextMenu
		.getByRole('menuitem', { name: 'Reply to selection', exact: true })
		.click({ timeout: 5_000 });
	await expect(page.locator('.composer-reply-reference')).toContainText(
		'The project readme describes a desktop assistant.',
	);
	await page.getByRole('button', { name: 'Remove reply reference', exact: true }).click();
	await page.setViewportSize({ width: 820, height: 900 });
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await page.screenshot({ path: '/tmp/freelm-code-inline-command-expanded.png' });
	await page.locator('.thought-summary').click();
	await expect(page.locator('.thought-output-divider')).toHaveCount(0);
	await page.getByLabel('Message', { exact: true }).fill('Continue inspecting this project.');
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	await expect(active).toHaveText(/^Working for (?:\d+s|\d+m \d+s)$/);
	await page.getByRole('button', { name: 'Stop response', exact: true }).click();
	await expect(active).toHaveCount(0);
	await expect(page.locator('.message.assistant').last()).toContainText('Response stopped.');
	await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
	expect(errors).toEqual([]);
});

for (const kind of ['chat', 'code'] as const) {
	test(`${kind} groups adjacent finished tools during streaming and starts a new group after commentary`, async ({
		page,
	}) => {
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await fixture(page, kind);
		await page.getByLabel('Message', { exact: true }).fill('Compare three pieces of evidence.');
		await page.getByRole('button', { name: 'Send message', exact: true }).click();
		const live = page.locator('.message-live-text');
		const toolName = kind === 'code' ? 'exec_command' : 'web.run';
		const argumentsAt = (index: number) =>
			kind === 'code'
				? { cmd: ['pwd', 'rg --files', 'git status'][index] }
				: { search_query: [{ q: `Europa evidence ${index + 1}` }] };
		const groupedLabel = kind === 'code' ? 'Ran 2 commands' : 'Searched the web 2 times';
		await finishRound(page, 0, 'I’ll compare the first two sources.', toolName, argumentsAt(0));
		await expect(live.locator('.tool-call')).toHaveCount(1);
		await finishTool(page, 0);
		await expect(live.locator('.tool-call')).toHaveAttribute('data-tool-status', 'completed');
		await finishRound(page, 1, '', toolName, argumentsAt(1));
		await expect(live.locator('.tool-call')).toHaveCount(2);
		await expect(live.locator('.activity-history-group')).toHaveCount(0);
		await expect(live.locator('.activity-shimmer')).toHaveCount(1);
		await finishTool(page, 1);
		const group = live.locator('.activity-history-group');
		await expect(group).toHaveCount(1);
		await expect(group.locator(':scope > summary')).toHaveText(groupedLabel);
		await expect(group).not.toHaveAttribute('open');
		await expect(live.locator('.activity-shimmer')).toHaveCount(0);
		await group.locator('summary').click();
		await expect(group.locator('.tool-call')).toHaveCount(2);
		await expect(group.locator('.tool-call').first()).toBeVisible();
		await group.locator(':scope > summary').click();
		await finishRound(
			page,
			2,
			'The first pair agrees. I’ll check the final source.',
			toolName,
			argumentsAt(2),
		);
		await expect(group.locator(':scope > summary')).toHaveText(groupedLabel);
		await expect(live.locator(':scope > .thought-tool-message .tool-call')).toHaveCount(1);
		await expect(live.locator(':scope > .thought-tool-message .activity-shimmer')).toHaveCount(1);
		const order = await live.evaluate((node) =>
			Array.from(node.children).map((child) => child.className),
		);
		expect(order).toEqual([
			'message-timeline-text',
			'activity-history-group',
			'message-timeline-text',
			'thought-tool-message',
		]);
		await finishTool(page, 2);
		await expect(group.locator(':scope > summary')).toHaveText(groupedLabel);
		await expect(live.locator(':scope > .thought-tool-message .tool-call')).toHaveAttribute(
			'data-tool-status',
			'completed',
		);
		await finishRound(page, 3, 'All three sources agree.');
		await expect(live).toHaveCount(0);
		await expandActivity(page);
		const history = page.locator('.thought-history');
		await expect(history.locator('.activity-history-group > summary')).toHaveText(groupedLabel);
		await expect(history.locator(':scope > .thought-tool-message .tool-call')).toHaveCount(1);
		await expect(history.locator('.activity-shimmer, .thought-reasoning')).toHaveCount(0);
		await expect(history).not.toContainText('Thinking');
		await expect(page.locator('.message-final')).toHaveText('All three sources agree.');
		expect(errors).toEqual([]);
	});
}
