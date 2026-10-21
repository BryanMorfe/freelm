import { selectConversationMode } from './helpers/conversation-mode';
import { expect, test, type Page } from '@playwright/test';
import { initialState } from '../../src/lib/state';
import { defaultToolSettings } from '../../src/lib/tool-settings';
import { COMPACTION_PROMPT, SUMMARY_PREFIX } from '../../src/lib/context-compaction';
import { toolApiName } from '../../src/lib/agent';
import type { AppState, ConversationKind, ModelDefinition } from '../../src/types';

// Browser plugin not available. Exercise the real App with private synthetic
// profiles, controlled protocol streams, and mocked host tools only.
test.setTimeout(180_000);
test.use({ actionTimeout: 15_000 });

type Options = {
	kind?: ConversationKind;
	api?: 'responses' | 'chat/completions';
	largeHistory?: boolean;
	largeWindow?: boolean;
	longRun?: boolean;
};
const threadTitle = 'Compaction review';
const summaryText =
	'Checkpoint: continue the requested review. The initial inspection is complete; preserve user constraints and finish the remaining validation.';
const oldText =
	'HISTORIC_LOG The previous inspection is complete and its observations are preserved.';
const oldTranscriptText =
	oldText + ' Detailed earlier observations were recorded successfully. '.repeat(1200);

async function fixture(page: Page, options: Options = {}) {
	const kind = options.kind || 'chat';
	const api = options.api || 'responses';
	const state = initialState();
	state.theme = 'dark';
	state.debugMode = false;
	state.backgroundNotifications = false;
	state.memorySettings = { savedMemories: false, referenceHistory: false };
	state.connections[0].name = 'Synthetic compaction API';
	state.connections[0].baseUrl = 'http://compaction.invalid/v1';
	state.connections[0].chatApi = api;
	state.connections[0].models.chat = 'compaction-model';
	state.connections[0].catalog = [
		{
			id: 'compaction-model',
			name: 'Compaction model',
			enabled: true,
			tasks: ['chat'],
			inputModalities: ['text'],
			outputModalities: ['text'],
			contextWindow: options.largeWindow ? 120_000 : options.longRun ? 60_000 : 20_000,
			compactionThresholdPercent: options.largeWindow ? 90 : options.longRun ? 90 : 50,
			compactionReserveTokens: options.largeWindow ? 5000 : options.longRun ? 5000 : 13_000,
			thinkingModes: [
				{
					id: 'low',
					name: 'Low',
					parameters: {
						responses: { reasoning: { effort: 'low' } },
						chat: { reasoning_effort: 'low' },
					},
				},
			],
		} as ModelDefinition,
	];
	state.codeCompaction = {
		thresholdPercent: options.largeWindow || options.longRun ? 90 : 50,
		reserveTokens: options.largeWindow || options.longRun ? 5000 : 13_000,
	};
	state.toolSettings = {
		...defaultToolSettings(),
		enabled: kind === 'code',
		approvalMode: 'full-access',
	};
	state.toolSettings.webBrowsing!.enabled = false;
	state.projects =
		kind === 'code'
			? [
					{
						id: 'test-project',
						kind,
						name: 'Synthetic repository',
						directories: ['/tmp/compaction-fixture'],
						instructions: '',
						createdAt: 1,
					},
				]
			: [];
	state.threads = [
		{
			id: 'compaction-thread',
			kind,
			title: threadTitle,
			titleSource: 'manual',
			connectionId: state.activeConnectionId,
			model: 'compaction-model',
			thinkingMode: 'low',
			createdAt: 1000,
			updatedAt: 2000,
			...(kind === 'code'
				? { projectId: 'test-project', permissionMode: 'full-access' as const }
				: {}),
			messages: [
				{
					id: 'old-user',
					role: 'user',
					content: 'Initial request: inspect the prototype and preserve the existing work.',
					createdAt: 1000,
				},
				{
					id: 'old-assistant',
					role: 'assistant',
					content: options.largeHistory === false ? 'The initial inspection is complete.' : oldText,
					...(options.largeHistory === false
						? {}
						: {
								agentTranscript: {
									api: api === 'responses' ? ('responses' as const) : ('chat' as const),
									items: [
										{
											...(api === 'responses' ? { type: 'message' } : {}),
											role: 'assistant',
											content:
												api === 'responses'
													? [{ type: 'output_text', text: oldTranscriptText }]
													: oldTranscriptText,
										},
									],
								},
							}),
					createdAt: 1500,
					completedAt: 2000,
				},
			],
		},
	];
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (message) => {
		if (message.type() === 'error') errors.push(message.text());
	});
	await page.route('**/compaction.invalid/**', (route) => route.abort());
	await page.addInitScript(
		({ serialized, prompt, summary, api, commandName, longRun }) => {
			let saved: AppState = JSON.parse(
				sessionStorage.getItem('context-compaction-state') || serialized,
			);
			let revision = 0;
			const listeners = new Set<(event: { id: string; text: string }) => void>();
			const requests: any[] = [];
			const tools: any[] = [];
			const cancellations: string[] = [];
			const control: any = { requests, tools, cancellations, state: () => structuredClone(saved) };
			(window as any).__compaction = control;
			const json = (value: unknown) => ({
				status: 200,
				contentType: 'application/json',
				encoding: 'text',
				body: JSON.stringify(value),
			});
			const text = (content: any): string =>
				typeof content === 'string'
					? content
					: Array.isArray(content)
						? content.map((part) => part.text || '').join('')
						: '';
			control.finish = (index: number, answer: string, count = 0, inputTokens = 0) => {
				const round = requests[index];
				if (!round || round.finished) throw new Error('Unexpected fixture completion.');
				round.finished = true;
				const calls = Array.from({ length: count }, (_, call) => ({
					id: `fixture-${index}-${call}`,
					type: 'function',
					function: {
						name: commandName,
						arguments: JSON.stringify({ cmd: `fixture command ${index}.${call}` }),
					},
				}));
				if (api === 'responses') {
					const output: any[] = answer
						? [
								{
									type: 'message',
									role: 'assistant',
									content: [{ type: 'output_text', text: answer }],
								},
							]
						: [];
					output.push(
						...calls.map((call) => ({
							type: 'function_call',
							call_id: call.id,
							name: call.function.name,
							arguments: call.function.arguments,
						})),
					);
					round.emit({
						type: 'response.completed',
						response: {
							status: 'completed',
							output,
							usage: {
								input_tokens: inputTokens,
								output_tokens: 40,
								total_tokens: inputTokens + 40,
							},
						},
					});
				} else {
					round.emit({
						choices: [
							{
								index: 0,
								delta: {
									role: 'assistant',
									...(answer ? { content: answer } : {}),
									...(calls.length
										? { tool_calls: calls.map((call, index) => ({ index, ...call })) }
										: {}),
								},
								finish_reason: calls.length ? 'tool_calls' : 'stop',
							},
						],
						usage: {
							prompt_tokens: inputTokens,
							completion_tokens: 40,
							total_tokens: inputTokens + 40,
						},
					});
				}
				round.resolve({
					status: 200,
					contentType: 'text/event-stream',
					encoding: 'text',
					body: '',
				});
			};
			(window as any).desktop = {
				platform: 'linux',
				workspaceLoad: async () => ({ state: structuredClone(saved), revision: String(revision) }),
				workspaceSave: async (_id: string, _revision: string, next: AppState) => {
					saved = structuredClone(next);
					sessionStorage.setItem('context-compaction-state', JSON.stringify(saved));
					return { revision: String(++revision) };
				},
				storageInfo: async () => ({ secure: false, location: '/tmp/private-compaction-profile' }),
				onPrepareClose: () => () => {},
				onToolApproval: () => () => {},
				instanceStatus: async () => ({
					host: { running: false, name: 'This computer', instanceId: 'local', port: 4319 },
					instances: [],
				}),
				toolCatalog: async () => ({
					tools: [
						{
							name: 'exec_command',
							description: 'A synthetic host fixture; never executes a machine command.',
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
				toolExecute: async (request: any) => {
					tools.push(request);
					return {
						content: [
							{
								type: 'text',
								text: 'Mock output with preserved observations. '.repeat(longRun ? 210 : 1),
							},
						],
						process: {
							command: request.arguments.cmd,
							sessionId: `fixture-session-${tools.length}`,
							exitCode: 0,
						},
					};
				},
				toolCancel: async () => {},
				onChunk: (listener: (event: { id: string; text: string }) => void) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				cancel: async (id: string) => {
					cancellations.push(id);
					requests
						.find((round) => round.id === id)
						?.reject(new DOMException('Cancelled', 'AbortError'));
				},
				request: async (request: any) => {
					const body = request.body;
					if (body.instructions?.startsWith('Write a short conversation title'))
						return json({ output_text: 'Synthetic review' });
					const items = api === 'responses' ? body.input : body.messages;
					const isSummary = text(items[items.length - 1]?.content).startsWith(prompt);
					return new Promise((resolve, reject) => {
						const round = {
							...request,
							isSummary,
							resolve,
							reject,
							finished: false,
							emit: (data: unknown) => {
								for (const listener of listeners)
									listener({ id: request.id, text: `data: ${JSON.stringify(data)}\n\n` });
							},
						};
						requests.push(round);
						if (longRun)
							setTimeout(() => {
								const index = requests.indexOf(round);
								const normals = requests.filter((item) => !item.isSummary).length;
								control.finish(
									index,
									isSummary
										? summary
										: normals <= 18
											? ''
											: 'Long-running review finished after all 72 fixture commands.',
									!isSummary && normals <= 18 ? 4 : 0,
								);
							}, 0);
					});
				},
			};
		},
		{
			serialized: JSON.stringify(state),
			prompt: COMPACTION_PROMPT,
			summary: summaryText,
			api,
			commandName: toolApiName('exec_command'),
			longRun: Boolean(options.longRun),
		},
	);
	await page.goto('/');
	await expect(page).toHaveTitle('FreeLM');
	if (kind === 'code')
		await selectConversationMode(page, 'Code');
	await page.getByTitle(threadTitle, { exact: true }).click({ noWaitAfter: true });
	await expect(page.locator('.message')).toHaveCount(2);
	await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible({
		timeout: 45_000,
	});
	return { errors, kind, api };
}

const saved = (page: Page): Promise<AppState> =>
	page.evaluate(() => (window as any).__compaction.state());
const requests = (page: Page): Promise<any[]> =>
	page.evaluate(() =>
		(window as any).__compaction.requests.map(({ body, path, isSummary }: any) => ({
			body,
			path,
			isSummary,
		})),
	);
async function finish(page: Page, index: number, text: string) {
	await page.evaluate(({ index, text }) => (window as any).__compaction.finish(index, text), {
		index,
		text,
	});
}
async function send(page: Page, text = 'Continue the review and finish the remaining validation.') {
	await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
	await page
		.getByRole('button', { name: 'Send message', exact: true })
		.click({ noWaitAfter: true });
}
async function healthy(page: Page, errors: string[]) {
	await expect(page).toHaveTitle('FreeLM');
	await expect(page.locator('vite-error-overlay')).toHaveCount(0);
	expect(errors).toEqual([]);
	await expect
		.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
		.toBe(true);
	expect(
		await page
			.locator('.chat-scroll')
			.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
	).toBe(true);
}

for (const [kind, api] of [
	['chat', 'responses'],
	['code', 'chat/completions'],
] as const) {
	test(`${kind} ${api} compacts with shimmer, preserves history and reuses the saved checkpoint after reload`, async ({
		page,
	}) => {
		const { errors } = await fixture(page, { kind, api });
		await send(page);
		await expect.poll(async () => (await requests(page)).length).toBe(1);
		expect((await requests(page))[0].isSummary).toBe(true);
		await expect(page.getByRole('status', { name: 'Compacting conversation' })).toContainText(
			'Compacting context',
		);
		await expect(
			page.getByRole('status', { name: 'Compacting conversation' }).locator('.activity-shimmer'),
		).toHaveCSS('animation-name', 'activity-shimmer');
		expect((await requests(page))[0].body.tools).toBeUndefined();
		if (kind === 'chat')
			expect(await page.evaluate(() => (window as any).__compaction.tools.length)).toBe(0);
		await page.screenshot({ path: `/tmp/freelm-context-compaction-${kind}-wide.png` });
		await page.setViewportSize({ width: 720, height: 900 });
		await healthy(page, errors);
		await page.screenshot({ path: `/tmp/freelm-context-compaction-${kind}-narrow.png` });
		await finish(page, 0, summaryText);
		await expect.poll(async () => (await requests(page)).length).toBe(2);
		await expect(page.getByRole('status', { name: 'Compacting conversation' })).toHaveCount(0);
		await finish(page, 1, 'The review is complete and the original history is preserved.');
		await expect(page.locator('.message.assistant').last()).toContainText('The review is complete');
		await expect
			.poll(
				async () =>
					(await saved(page)).threads[0].messages.at(-1)?.agentTranscript?.context?.compactionCount,
			)
			.toBe(1);
		const before = await saved(page);
		expect(before.threads[0].messages[1].content).toBe(oldText);
		expect(before.threads[0].messages).toHaveLength(4);
		await page.reload();
		if (kind === 'code')
			await selectConversationMode(page, 'Code');
		await page.getByTitle(threadTitle, { exact: true }).click({ noWaitAfter: true });
		await expect(page.locator('.message')).toHaveCount(4);
		await send(page, 'Continue from the checkpoint with a short follow-up.');
		await expect.poll(async () => (await requests(page)).length).toBe(1);
		const next = (await requests(page))[0];
		expect(next.isSummary).toBe(false);
		expect(JSON.stringify(next.body)).toContain(SUMMARY_PREFIX.trim());
		expect(JSON.stringify(next.body)).toContain('The review is complete');
		expect(JSON.stringify(next.body)).not.toContain('HISTORIC_LOG');
		expect(next.path).toBe(`/${api}`);
		await finish(page, 0, 'The saved checkpoint was reused successfully.');
		await expect(page.locator('.message.assistant').last()).toContainText('reused successfully');
		await expect.poll(async () => (await saved(page)).threads[0].messages.length).toBe(6);
		await healthy(page, errors);
		// Regeneration reuses only the checkpoint preceding the selected reply.
		await page.locator('.message.assistant').last().hover();
		await page
			.locator('.message.assistant')
			.last()
			.getByRole('button', { name: 'Regenerate response' })
			.click({ noWaitAfter: true });
		await expect.poll(async () => (await requests(page)).length).toBe(2);
		expect(JSON.stringify((await requests(page))[1].body)).toContain(SUMMARY_PREFIX.trim());
		await finish(page, 1, 'A regenerated follow-up based on the same valid checkpoint.');
		await expect(page.locator('.message.assistant').last()).toContainText('regenerated follow-up');
		// Editing before the checkpoint creates another path and must not import it.
		await page.locator('.message.user').first().hover();
		await page
			.locator('.message.user')
			.first()
			.getByRole('button', { name: 'Edit message' })
			.click({ noWaitAfter: true });
		await page
			.getByRole('textbox', { name: 'Edit message', exact: true })
			.fill('Changed initial objective: start a different review.');
		await page
			.getByRole('button', { name: 'Save and send', exact: true })
			.click({ noWaitAfter: true });
		await expect.poll(async () => (await requests(page)).length).toBe(3);
		const edited = (await requests(page))[2];
		expect(edited.isSummary).toBe(false);
		expect(JSON.stringify(edited.body)).not.toContain(SUMMARY_PREFIX.trim());
		await finish(page, 2, 'The changed objective starts its own context path.');
		await expect(page.locator('.message.assistant').last()).toContainText('own context path');
		await healthy(page, errors);
	});
}

test('cancelling pending compaction preserves history and an editable next-message draft without installing a partial checkpoint', async ({
	page,
}) => {
	const { errors } = await fixture(page);
	await send(page);
	await expect(page.getByRole('status', { name: 'Compacting conversation' })).toBeVisible();
	await page
		.getByRole('textbox', { name: 'Message', exact: true })
		.fill('Keep this next-message draft when I stop.');
	await page
		.getByRole('button', { name: 'Stop response', exact: true })
		.click({ noWaitAfter: true });
	await expect(page.getByRole('status', { name: 'Compacting conversation' })).toHaveCount(0);
	await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveText(
		'Keep this next-message draft when I stop.',
	);
	await expect
		.poll(async () => (await saved(page)).threads[0].messages.at(-1)?.interrupted)
		.toBe(true);
	const state = await saved(page);
	expect(state.threads[0].messages[1].content).toBe(oldText);
	expect(state.threads[0].messages.at(-1)?.agentTranscript?.context).toBeUndefined();
	await expect
		.poll(async () => (await saved(page)).chatDrafts?.['compaction-thread']?.content)
		.toBe('Keep this next-message draft when I stop.');
	await page.reload();
	await page.getByTitle(threadTitle, { exact: true }).click({ noWaitAfter: true });
	await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveText(
		'Keep this next-message draft when I stop.',
	);
	await healthy(page, errors);
});

test('saved global Code percentage and reserve control the actual API compaction trigger', async ({
	page,
}) => {
	const { errors } = await fixture(page, { kind: 'code', largeWindow: true });
	await page.getByRole('button', { name: /Personal workspace/ }).click({ noWaitAfter: true });
	const settings = page.getByRole('region', { name: 'Settings', exact: true });
	await settings
		.getByRole('button', { name: 'Configuration', exact: true })
		.click({ noWaitAfter: true });
	await settings
		.getByRole('button', { name: 'Edit model Compaction model', exact: true })
		.click({ noWaitAfter: true });
	await settings.getByLabel('Context window (tokens)', { exact: true }).fill('20000');
	await settings
		.getByRole('button', { name: 'Apply model', exact: true })
		.click({ noWaitAfter: true });
	await settings.getByRole('button', { name: 'Code', exact: true }).click({ noWaitAfter: true });
	await settings.getByLabel('Compact at (%)', { exact: true }).fill('50');
	await settings.getByLabel('Minimum remaining tokens', { exact: true }).fill('13000');
	await expect(settings.locator('.code-compaction-preview')).toContainText(
		'compact at 7,000 of 20,000 tokens used',
	);
	await settings
		.getByRole('button', { name: 'Save settings', exact: true })
		.click({ noWaitAfter: true });
	await settings
		.getByRole('button', { name: 'Back to workspace', exact: true })
		.click({ noWaitAfter: true });
	await expect.poll(async () => (await saved(page)).codeCompaction?.reserveTokens).toBe(13000);
	await send(page);
	await expect.poll(async () => (await requests(page)).length).toBe(1);
	expect((await requests(page))[0]).toMatchObject({ isSummary: true, path: '/responses' });
	await finish(page, 0, summaryText);
	await expect.poll(async () => (await requests(page)).length).toBe(2);
	await finish(page, 1, 'The configured percentage and reserve triggered compaction.');
	await expect(page.locator('.message.assistant').last()).toContainText(
		'reserve triggered compaction',
	);
	expect((await requests(page)).every((round) => round.path === '/responses')).toBe(true);
	await healthy(page, errors);
});

test('Code continues beyond 16 rounds and 64 tools, compacts mid-run and persists the finished transcript', async ({
	page,
}) => {
	const { errors } = await fixture(page, { kind: 'code', largeHistory: false, longRun: true });
	await send(page, 'Complete this long-running fixture review without a fixed turn limit.');
	await expect(page.locator('.message.assistant').last()).toContainText(
		'finished after all 72 fixture commands',
		{ timeout: 120_000 },
	);
	await expect
		.poll(async () => (await saved(page)).threads[0].messages.at(-1)?.completedAt)
		.toBeGreaterThan(2000);
	expect(await page.evaluate(() => (window as any).__compaction.tools.length)).toBe(72);
	const rounds = await requests(page);
	expect(rounds.filter((round) => !round.isSummary)).toHaveLength(19);
	expect(rounds.some((round) => round.isSummary)).toBe(true);
	expect(rounds.every((round) => round.path === '/responses')).toBe(true);
	expect(rounds.filter((round) => round.isSummary).every((round) => !round.body.tools)).toBe(true);
	const state = await saved(page);
	expect(state.threads[0].messages.at(-1)?.toolCalls).toHaveLength(72);
	expect(
		state.threads[0].messages.at(-1)?.agentTranscript?.context?.compactionCount,
	).toBeGreaterThan(0);
	expect(state.threads[0].messages.at(-1)?.agentTranscript?.items.length).toBeGreaterThan(144);
	await page.setViewportSize({ width: 720, height: 900 });
	await healthy(page, errors);
	await page.screenshot({ path: '/tmp/freelm-context-compaction-long-code-narrow.png' });
	await page.reload();
	await selectConversationMode(page, 'Code');
	await page.getByTitle(threadTitle, { exact: true }).click({ noWaitAfter: true });
	await expect(page.locator('.message.assistant').last()).toContainText('72 fixture commands');
	expect((await saved(page)).threads[0].messages.at(-1)?.toolCalls).toHaveLength(72);
	await healthy(page, errors);
});
