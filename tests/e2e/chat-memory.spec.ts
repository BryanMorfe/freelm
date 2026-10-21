import { selectConversationMode } from './helpers/conversation-mode';
import { expect, test, type Page } from '@playwright/test';
import { initialState } from '../../src/lib/state';
import { defaultToolSettings } from '../../src/lib/tool-settings';
import { toolApiName } from '../../src/lib/agent';
import { threadMemoryRevision } from '../../src/lib/memories';
import type { AppState, Thread } from '../../src/types';
import type { ChatMemorySettings } from '../../src/memory-types';

test.setTimeout(120_000);

const memoryNames = [
	'conversations.search',
	'conversations.read',
	'memory.search',
	'memory.read',
	'memory.create',
	'memory.update',
	'memory.delete',
];

// Browser plugin not available. The flow under test is Chat -> scoped memory
// context/tool calls -> persisted notes and summaries, in an isolated renderer.
// The fake desktop bridge never accesses a user profile, filesystem or provider.
async function fixture(
	page: Page,
	options: { chatApi?: 'responses' | 'chat'; memorySettings?: ChatMemorySettings } = {},
) {
	const state = initialState();
	state.connections[0].baseUrl = 'http://memory-fixture.invalid/v1';
	state.connections[0].models.chat = 'memory-model';
	state.connections[0].chatApi = options.chatApi || 'responses';
	state.connections[0].catalog = [
		{
			id: 'memory-model',
			name: 'Memory model',
			enabled: true,
			tasks: ['chat'],
			inputModalities: ['text'],
			outputModalities: ['text'],
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
		},
	];
	state.toolSettings = defaultToolSettings();
	state.toolSettings.enabled = false;
	state.toolSettings.imageGeneration.enabled = false;
	state.toolSettings.webBrowsing = { enabled: false, mode: 'external', searxngUrl: '' };
	state.memorySettings = options.memorySettings || { savedMemories: true, referenceHistory: true };
	state.projects = [
		{ id: 'alpha', name: 'Alpha', kind: 'chat', instructions: 'Discuss Alpha.', createdAt: 1 },
		{ id: 'beta', name: 'Beta', kind: 'chat', instructions: '', createdAt: 1 },
		{
			id: 'code',
			name: 'Code folder',
			kind: 'code',
			directories: ['/tmp/fixture'],
			instructions: '',
			createdAt: 1,
		},
	];
	const thread = (
		id: string,
		title: string,
		projectId: string | undefined,
		content: string,
		kind: 'chat' | 'code' = 'chat',
	): Thread => ({
		id,
		title,
		kind,
		projectId,
		connectionId: state.activeConnectionId,
		model: 'memory-model',
		thinkingMode: 'low',
		createdAt: 1,
		updatedAt: id === 'alpha-history' ? 10 : 1,
		messages: [
			{ id: `${id}-user`, role: 'user', content: `Question about ${content}`, createdAt: 1 },
			{ id: `${id}-assistant`, role: 'assistant', content, createdAt: 2, completedAt: 3 },
		],
	});
	state.threads = [
		thread('current-chat', 'Current chat', 'alpha', 'Current context.'),
		thread(
			'alpha-history',
			'Original Alpha decision',
			'alpha',
			'Alpha launch uses forty-two seats.',
		),
		thread('beta-history', 'Private Beta decision', 'beta', 'Beta launch SECRET_BETA_CONTENT.'),
		thread(
			'outside-history',
			'Unprojected discussion',
			undefined,
			'Launch SECRET_OUTSIDE_CONTENT.',
		),
		thread('code-chat', 'Code task', 'code', 'Launch SECRET_CODE_CONTENT.', 'code'),
	];
	for (const entry of state.threads.slice(1))
		entry.memorySummary = {
			content:
				entry.id === 'alpha-history'
					? 'RECENT_ALPHA_SUMMARY: launch has forty-two seats.'
					: `SECRET_SUMMARY_${entry.id}`,
			sourceRevision: threadMemoryRevision(entry),
			generatedAt: 5,
			model: 'memory-model',
		};
	state.savedMemories = [
		{
			id: 'workspace-note',
			content: 'SAVED_WORKSPACE_NOTE: prefer concise answers.',
			source: 'user',
			revision: 1,
			createdAt: 1,
			updatedAt: 1,
		},
		{
			id: 'alpha-note',
			content: 'SAVED_ALPHA_NOTE: use metric units.',
			projectId: 'alpha',
			source: 'user',
			revision: 1,
			createdAt: 1,
			updatedAt: 2,
		},
		{
			id: 'beta-note',
			content: 'SECRET_BETA_NOTE',
			projectId: 'beta',
			source: 'user',
			revision: 1,
			createdAt: 1,
			updatedAt: 2,
		},
	];
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (message) => {
		if (message.type() === 'error') errors.push(message.text());
	});
	await page.addInitScript(
		({ serialized, names }) => {
			let current: AppState = JSON.parse(sessionStorage.getItem('chat-memory-state') || serialized);
			let revision = 0;
			const listeners = new Set<(event: { id: string; text: string }) => void>();
			const control: any = {
				requests: [],
				summaries: [],
				titles: [],
				saves: [],
				nativeCatalogs: [],
				nativeExecutions: [],
				cancelled: [],
				heldSaves: [],
				saveAttempts: [],
				state: () => structuredClone(current),
			};
			(window as any).__memoryTest = control;
			const json = (body: unknown) => ({
				status: 200,
				contentType: 'application/json',
				encoding: 'text',
				body: JSON.stringify(body),
			});
			const complete = (
				round: any,
				text: string,
				calls: { name: string; args: Record<string, unknown> }[] = [],
			) => {
				if (!round) throw new Error('The requested fixture round does not exist.');
				const emit = (body: unknown) => {
					for (const listener of listeners)
						listener({ id: round.id, text: `data: ${JSON.stringify(body)}\n\n` });
				};
				const responses = !!round.body.input;
				if (responses) {
					if (text) emit({ type: 'response.output_text.delta', delta: text });
					emit({
						type: 'response.completed',
						response: {
							status: 'completed',
							output: [
								...(text
									? [
											{
												type: 'message',
												role: 'assistant',
												content: [{ type: 'output_text', text }],
											},
										]
									: []),
								...calls.map((call, index) => ({
									type: 'function_call',
									call_id: `call-${round.id}-${index}`,
									name: names[call.name],
									arguments: JSON.stringify(call.args),
								})),
							],
						},
					});
				} else {
					emit({
						choices: [
							{
								index: 0,
								delta: {
									role: 'assistant',
									content: text || null,
									...(calls.length
										? {
												tool_calls: calls.map((call, index) => ({
													index,
													id: `call-${round.id}-${index}`,
													type: 'function',
													function: {
														name: names[call.name],
														arguments: JSON.stringify(call.args),
													},
												})),
											}
										: {}),
								},
							},
						],
					});
					emit({
						choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }],
					});
					for (const listener of listeners) listener({ id: round.id, text: 'data: [DONE]\n\n' });
				}
				round.resolve({
					status: 200,
					contentType: 'text/event-stream',
					encoding: 'text',
					body: '',
				});
			};
			control.finish = (
				index: number,
				text: string,
				name?: string,
				args: Record<string, unknown> = {},
			) => complete(control.requests[index], text, name ? [{ name, args }] : []);
			control.finishSummary = (index: number, text: string) =>
				complete(control.summaries[index], text);
			control.releaseSave = (index: number) => control.heldSaves[index].resolve();
			(window as any).desktop = {
				platform: 'linux',
				workspaceLoad: async () => ({
					state: structuredClone(current),
					revision: String(revision),
				}),
				workspaceSave: async (_workspace: string, _revision: string, next: AppState) => {
					control.saveAttempts.push(structuredClone(next));
					const holdMemory =
						control.holdMemoryContent &&
						next.savedMemories?.some((note) => note.content === control.holdMemoryContent);
					if (holdMemory && !control.didHoldSave) {
						control.didHoldSave = true;
						await new Promise<void>((resolve) =>
							control.heldSaves.push({ state: structuredClone(next), resolve }),
						);
					}
					current = structuredClone(next);
					control.saves.push(structuredClone(next));
					sessionStorage.setItem('chat-memory-state', JSON.stringify(current));
					return { revision: String(++revision) };
				},
				storageInfo: async () => ({ secure: false, location: 'Isolated Chat memory fixture' }),
				onPrepareClose: () => () => {},
				onToolApproval: () => () => {},
				onChunk: (listener: (event: { id: string; text: string }) => void) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				// Intentionally let cancelled responses arrive late to exercise rejection
				// by the renderer rather than relying on a cooperative fake transport.
				cancel: async (id: string) => {
					control.cancelled.push(id);
				},
				toolCancel: async () => {},
				instanceStatus: async () => ({
					host: { running: false, name: 'Local', instanceId: 'local', port: 4319 },
					instances: [],
				}),
				toolCatalog: async (...args: unknown[]) => {
					control.nativeCatalogs.push(args);
					throw new Error('Chat memory must not load native tools.');
				},
				toolExecute: async (request: unknown) => {
					control.nativeExecutions.push(request);
					throw new Error('Chat memory must not execute native tools.');
				},
				request: async (request: any) => {
					const instructions =
						request.body.instructions ||
						request.body.messages?.find((item: any) => item.role === 'system')?.content ||
						'';
					if (instructions.startsWith('Write a short conversation title')) {
						control.titles.push(structuredClone(request.body));
						return json(
							request.body.input
								? { output_text: 'Memory continuity' }
								: { choices: [{ message: { content: 'Memory continuity' } }] },
						);
					}
					return new Promise((resolve) => {
						const round = { id: request.id, body: structuredClone(request.body), resolve };
						if (instructions.startsWith('Summarize this conversation for continuity'))
							control.summaries.push(round);
						else control.requests.push(round);
					});
				},
			};
		},
		{
			serialized: JSON.stringify(state),
			names: Object.fromEntries(memoryNames.map((name) => [name, toolApiName(name)])),
		},
	);
	await page.goto('/');
	await expect(page).toHaveTitle('FreeLM');
	await expect(page.getByLabel('Message', { exact: true })).toBeVisible({ timeout: 15_000 });
	await expect(page.locator('vite-error-overlay')).toHaveCount(0);
	await page.getByRole('button', { name: 'Current chat', exact: true }).click();
	await expect(page.locator('.message.assistant')).toContainText('Current context.');
	return errors;
}

async function send(page: Page, text: string) {
	await page.getByLabel('Message', { exact: true }).fill(text);
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
}
async function requests(page: Page): Promise<any[]> {
	return page.evaluate(() => (window as any).__memoryTest.requests.map((round: any) => round.body));
}
async function saved(page: Page): Promise<AppState> {
	return page.evaluate(() => (window as any).__memoryTest.state());
}
async function round(
	page: Page,
	index: number,
	text: string,
	name?: string,
	args: Record<string, unknown> = {},
) {
	await expect.poll(async () => (await requests(page)).length).toBe(index + 1);
	await page.evaluate(
		({ index, text, name, args }) => (window as any).__memoryTest.finish(index, text, name, args),
		{ index, text, name, args },
	);
}
function instructions(body: any): string {
	return (
		body.instructions || body.messages?.find((item: any) => item.role === 'system')?.content || ''
	);
}
function toolNames(body: any): string[] {
	return (body.tools || []).map((tool: any) => tool.name || tool.function?.name);
}
function toolOutputs(body: any): string[] {
	return body.input
		? body.input
				.filter((item: any) => item.type === 'function_call_output')
				.map((item: any) => item.output)
		: body.messages.filter((item: any) => item.role === 'tool').map((item: any) => item.content);
}
async function noNativeCalls(page: Page) {
	expect(
		await page.evaluate(() => ({
			catalogs: (window as any).__memoryTest.nativeCatalogs,
			executions: (window as any).__memoryTest.nativeExecutions,
		})),
	).toEqual({ catalogs: [], executions: [] });
}

for (const chatApi of ['responses', 'chat'] as const)
	test(`${chatApi}: Chat injects scoped saved notes and genuine recent summaries without native tools`, async ({
		page,
	}) => {
		const errors = await fixture(page, { chatApi });
		await send(page, 'Use what you remember.');
		await expect.poll(async () => (await requests(page)).length).toBe(1);
		const body = (await requests(page))[0];
		expect(instructions(body)).toContain('SAVED_WORKSPACE_NOTE');
		expect(instructions(body)).toContain('SAVED_ALPHA_NOTE');
		expect(instructions(body)).toContain('RECENT_ALPHA_SUMMARY');
		expect(instructions(body)).toContain('cached conversation summary');
		expect(instructions(body)).not.toContain('SECRET_');
		expect(toolNames(body)).toEqual(expect.arrayContaining(memoryNames.map(toolApiName)));
		expect(toolNames(body)).toHaveLength(7);
		await round(page, 0, 'Scoped memory is available.');
		await expect(page.locator('.message-final').last()).toHaveText('Scoped memory is available.');
		await noNativeCalls(page);
		expect(errors).toEqual([]);
	});

test('conversation search and reads enforce project scope on actual tool continuations', async ({
	page,
}) => {
	const errors = await fixture(page);
	await send(page, 'Find our launch decision.');
	await round(page, 0, '', 'conversations.search', { query: 'launch' });
	await expect.poll(async () => (await requests(page)).length).toBe(2);
	const search = JSON.parse(toolOutputs((await requests(page))[1]).at(-1)!);
	expect(search.results).toHaveLength(2);
	expect(search.results.every((item: any) => item.thread_id === 'alpha-history')).toBe(true);
	expect(JSON.stringify(search)).toContain('forty-two seats');
	expect(JSON.stringify(search)).not.toContain('SECRET_');
	await round(page, 1, '', 'conversations.read', {
		thread_id: 'alpha-history',
		message_id: 'alpha-history-assistant',
	});
	await expect.poll(async () => (await requests(page)).length).toBe(3);
	const read = JSON.parse(toolOutputs((await requests(page))[2]).at(-1)!);
	expect(read.messages).toEqual([
		expect.objectContaining({
			message_id: 'alpha-history-assistant',
			content: 'Alpha launch uses forty-two seats.',
		}),
	]);
	await round(page, 2, '', 'conversations.read', { thread_id: 'beta-history' });
	await expect.poll(async () => (await requests(page)).length).toBe(4);
	expect(toolOutputs((await requests(page))[3]).at(-1)).toContain(
		'Tool error: Conversation is unavailable in this Chat memory scope.',
	);
	await round(page, 3, 'Our launch uses forty-two seats.');
	await expect(page.locator('.message-final').last()).toHaveText(
		'Our launch uses forty-two seats.',
	);
	await noNativeCalls(page);
	expect(errors).toEqual([]);
});

test('model memory search, read, create, update and delete persist through the workspace writer', async ({
	page,
}) => {
	const errors = await fixture(page);
	await send(page, 'Remember my preference and then correct it.');
	await round(page, 0, '', 'memory.search', { query: 'concise' });
	await expect.poll(async () => (await requests(page)).length).toBe(2);
	expect(JSON.parse(toolOutputs((await requests(page))[1]).at(-1)!).memories).toEqual([
		expect.objectContaining({ id: 'workspace-note', revision: 1 }),
	]);
	await round(page, 1, '', 'memory.read', { id: 'workspace-note' });
	await expect.poll(async () => (await requests(page)).length).toBe(3);
	expect(JSON.parse(toolOutputs((await requests(page))[2]).at(-1)!).memory.content).toContain(
		'SAVED_WORKSPACE_NOTE',
	);
	await round(page, 2, '', 'memory.create', { content: 'MODEL_SAVED_NOTE: prefer Celsius.' });
	await expect.poll(async () => (await requests(page)).length).toBe(4);
	const created = JSON.parse(toolOutputs((await requests(page))[3]).at(-1)!).memory;
	expect(created).toMatchObject({
		content: 'MODEL_SAVED_NOTE: prefer Celsius.',
		projectId: 'alpha',
		revision: 1,
		source: 'model',
		sourceThreadId: 'current-chat',
	});
	expect((await saved(page)).savedMemories).toContainEqual(created);
	await round(page, 3, '', 'memory.update', {
		id: created.id,
		revision: 1,
		content: 'MODEL_SAVED_NOTE: prefer Fahrenheit.',
	});
	await expect.poll(async () => (await requests(page)).length).toBe(5);
	expect(JSON.parse(toolOutputs((await requests(page))[4]).at(-1)!).memory).toMatchObject({
		id: created.id,
		revision: 2,
		content: 'MODEL_SAVED_NOTE: prefer Fahrenheit.',
	});
	expect((await saved(page)).savedMemories?.find((note) => note.id === created.id)?.revision).toBe(
		2,
	);
	await round(page, 4, 'Your updated preference is saved.');
	await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toHaveCount(0);
	await send(page, 'Show my corrected preference.');
	await expect.poll(async () => (await requests(page)).length).toBe(6);
	expect(instructions((await requests(page))[5])).toContain('MODEL_SAVED_NOTE: prefer Fahrenheit.');
	expect(instructions((await requests(page))[5])).not.toContain(
		'MODEL_SAVED_NOTE: prefer Celsius.',
	);
	await round(page, 5, '', 'memory.delete', { id: created.id, revision: 2 });
	await expect.poll(async () => (await requests(page)).length).toBe(7);
	expect(JSON.parse(toolOutputs((await requests(page))[6]).at(-1)!)).toEqual({
		deleted: created.id,
	});
	await round(page, 6, 'That saved preference is forgotten.');
	await expect
		.poll(async () => (await saved(page)).savedMemories?.some((note) => note.id === created.id))
		.toBe(false);
	await page.reload();
	await expect(page.getByRole('button', { name: 'Current chat', exact: true })).toBeVisible();
	expect((await saved(page)).savedMemories?.some((note) => note.id === created.id)).toBe(false);
	expect(
		(await saved(page)).threads
			.find((thread) => thread.id === 'current-chat')
			?.messages.some((message) => message.content === 'Your updated preference is saved.'),
	).toBe(true);
	await noNativeCalls(page);
	expect(errors).toEqual([]);
});

for (const disabled of ['savedMemories', 'referenceHistory'] as const)
	test(`disabling ${disabled} removes only its prompt section and tools`, async ({ page }) => {
		const settings = { savedMemories: true, referenceHistory: true, [disabled]: false };
		const errors = await fixture(page, { memorySettings: settings });
		await send(page, 'Check enabled memory capabilities.');
		await expect.poll(async () => (await requests(page)).length).toBe(1);
		const body = (await requests(page))[0];
		const text = instructions(body);
		expect(text.includes('SAVED_WORKSPACE_NOTE')).toBe(disabled !== 'savedMemories');
		expect(text.includes('RECENT_ALPHA_SUMMARY')).toBe(disabled !== 'referenceHistory');
		const expected = memoryNames
			.filter((name) =>
				disabled === 'savedMemories'
					? name.startsWith('conversations.')
					: name.startsWith('memory.'),
			)
			.map(toolApiName);
		expect(toolNames(body).sort()).toEqual(expected.sort());
		await round(page, 0, 'Only enabled capabilities are available.');
		await expect(page.locator('.message-final').last()).toHaveText(
			'Only enabled capabilities are available.',
		);
		expect((await saved(page)).savedMemories).toHaveLength(3);
		await noNativeCalls(page);
		expect(errors).toEqual([]);
	});

test('Code never receives Chat memory context or tools', async ({ page }) => {
	const errors = await fixture(page);
	await selectConversationMode(page, 'Code');
	await page.getByRole('button', { name: 'Code task', exact: true }).click();
	await send(page, 'Explain this code task.');
	await expect.poll(async () => (await requests(page)).length).toBe(1);
	const body = (await requests(page))[0];
	expect(toolNames(body)).toEqual([]);
	expect(instructions(body)).not.toContain('Chat memory');
	expect(instructions(body)).not.toContain('SAVED_');
	expect(instructions(body)).not.toContain('RECENT_ALPHA_SUMMARY');
	await round(page, 0, 'A Code reply without Chat memory.');
	await expect(page.locator('.message-final').last()).toHaveText(
		'A Code reply without Chat memory.',
	);
	expect(await page.evaluate(() => (window as any).__memoryTest.summaries.length)).toBe(0);
	await noNativeCalls(page);
	expect(errors).toEqual([]);
});

test('completed Chat generates a background summary that the next project chat receives', async ({
	page,
}) => {
	const errors = await fixture(page);
	await send(page, 'We decided to launch in April.');
	await expect.poll(async () => (await requests(page)).length).toBe(1);
	expect(await page.evaluate(() => (window as any).__memoryTest.summaries.length)).toBe(0);
	await round(page, 0, 'The launch is scheduled for April.');
	await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toHaveCount(0);
	await expect
		.poll(() => page.evaluate(() => (window as any).__memoryTest.summaries.length))
		.toBe(1);
	const summaryBody = await page.evaluate(() => (window as any).__memoryTest.summaries[0].body);
	expect(summaryBody.tools).toBeUndefined();
	expect(JSON.stringify(summaryBody.input)).toContain('The launch is scheduled for April.');
	expect(JSON.stringify(summaryBody.input)).not.toContain('SAVED_WORKSPACE_NOTE');
	await page.evaluate(() =>
		(window as any).__memoryTest.finishSummary(
			0,
			'FRESH_BACKGROUND_SUMMARY: Alpha launch was set for April.',
		),
	);
	await expect
		.poll(
			async () =>
				(await saved(page)).threads.find((thread) => thread.id === 'current-chat')?.memorySummary
					?.content,
		)
		.toBe('FRESH_BACKGROUND_SUMMARY: Alpha launch was set for April.');
	await page.getByRole('button', { name: 'New chat in Alpha', exact: true }).click();
	await send(page, 'Continue from our last decision.');
	await expect.poll(async () => (await requests(page)).length).toBe(2);
	expect(instructions((await requests(page))[1])).toContain('FRESH_BACKGROUND_SUMMARY');
	await round(page, 1, 'We will continue with the April launch.');
	await expect(page.locator('.message-final').last()).toHaveText(
		'We will continue with the April launch.',
	);
	await page.screenshot({ path: '/tmp/freelm-chat-memory-continuity.png' });
	await noNativeCalls(page);
	expect(errors).toEqual([]);
});

test('new foreground Chat cancels a background summary and rejects its late stale result', async ({
	page,
}) => {
	const errors = await fixture(page);
	await send(page, 'The launch is in April.');
	await round(page, 0, 'April is the current launch date.');
	await expect
		.poll(() => page.evaluate(() => (window as any).__memoryTest.summaries.length))
		.toBe(1);
	const summaryId = await page.evaluate(() => (window as any).__memoryTest.summaries[0].id);
	await send(page, 'Correction: the launch is now June.');
	await expect.poll(async () => (await requests(page)).length).toBe(2);
	await expect
		.poll(() => page.evaluate(() => (window as any).__memoryTest.cancelled))
		.toContain(summaryId);
	await page.evaluate(() => (window as any).__memoryTest.finishSummary(0, 'STALE_APRIL_SUMMARY'));
	await round(page, 1, 'June replaces April as the launch date.');
	await expect(page.locator('.message-final').last()).toHaveText(
		'June replaces April as the launch date.',
	);
	await expect
		.poll(
			async () =>
				(await saved(page)).threads.find((thread) => thread.id === 'current-chat')?.memorySummary
					?.content,
		)
		.not.toBe('STALE_APRIL_SUMMARY');
	await page.getByRole('button', { name: 'New chat in Alpha', exact: true }).click();
	await send(page, 'What is the latest launch date?');
	await expect.poll(async () => (await requests(page)).length).toBe(3);
	expect(instructions((await requests(page))[2])).not.toContain('STALE_APRIL_SUMMARY');
	expect(instructions((await requests(page))[2])).toContain('June replaces April');
	await round(page, 2, 'The launch date is June.');
	await noNativeCalls(page);
	expect(errors).toEqual([]);
});

test('a cancelled model memory write queued behind another save never applies after the queue resumes', async ({
	page,
}) => {
	const errors = await fixture(page);
	await page.evaluate(() => {
		(window as any).__memoryTest.holdMemoryContent = 'QUEUENOTE_FIRST';
	});
	await send(page, 'Save the first note.');
	await round(page, 0, '', 'memory.create', { content: 'QUEUENOTE_FIRST' });
	await expect
		.poll(() => page.evaluate(() => (window as any).__memoryTest.heldSaves.length))
		.toBe(1);
	await page.getByRole('button', { name: 'Stop response', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toHaveCount(0);
	await send(page, 'Save the second note.');
	await round(page, 1, '', 'memory.create', { content: 'QUEUENOTE_SECOND' });
	await expect(page.locator('.working-status')).toHaveText('Saving a memory');
	// The first write has already applied optimistically and is waiting on disk;
	// the second write is waiting behind it and must honor cancellation first.
	expect(instructions((await requests(page))[1])).toContain('QUEUENOTE_FIRST');
	await page.getByRole('button', { name: 'Stop response', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toHaveCount(0);
	await page.evaluate(() => (window as any).__memoryTest.releaseSave(0));
	await expect
		.poll(
			async () =>
				(await saved(page)).threads.find((thread) => thread.id === 'current-chat')?.messages.at(-1)
					?.interrupted,
		)
		.toBe(true);
	await send(page, 'Which notes survived?');
	await expect.poll(async () => (await requests(page)).length).toBe(3);
	const context = instructions((await requests(page))[2]);
	expect(context).toContain('QUEUENOTE_FIRST');
	expect(context).not.toContain('QUEUENOTE_SECOND');
	await round(page, 2, 'Only the first note was saved.');
	await expect(page.locator('.message-final').last()).toHaveText('Only the first note was saved.');
	await expect
		.poll(
			async () =>
				(await saved(page)).threads.find((thread) => thread.id === 'current-chat')?.messages.at(-1)
					?.content,
		)
		.toBe('Only the first note was saved.');
	expect(
		(await saved(page)).savedMemories
			?.filter((note) => note.content.startsWith('QUEUENOTE_'))
			.map((note) => note.content),
	).toEqual(['QUEUENOTE_FIRST']);
	expect(
		await page.evaluate(() =>
			(window as any).__memoryTest.saveAttempts.some((snapshot: AppState) =>
				snapshot.savedMemories?.some((note) => note.content === 'QUEUENOTE_SECOND'),
			),
		),
	).toBe(false);
	await noNativeCalls(page);
	expect(errors).toEqual([]);
});
