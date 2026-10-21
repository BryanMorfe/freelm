import { expect, test, type Page } from '@playwright/test';
import { initialState } from '../../src/lib/state';
import { defaultToolSettings } from '../../src/lib/tool-settings';
import { toolApiName } from '../../src/lib/agent';
import { imageTool, interactionTools } from '../../src/lib/interaction-tools';
import type { AppState } from '../../src/types';

// Browser plugin unavailable. These actual-App checks use private synthetic
// profiles and controlled desktop/protocol stubs. No provider, host tool,
// command, or user's real configuration is accessed.
test.setTimeout(180_000);
test.use({ actionTimeout: 45_000 });
const ACTOR = 'Capabilities actor';
const TARGET = 'Independent target';
const CHAT = 'Independent Chat';
const OLD = 'EARLIER_TASK_HISTORY_DO_NOT_REPLAY_AFTER_RESET';
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
type Call = { name: string; args: Record<string, unknown> };

async function fixture(page: Page) {
	const state = initialState();
	state.theme = 'dark';
	state.debugMode = false;
	state.backgroundNotifications = false;
	state.memorySettings = { savedMemories: false, referenceHistory: false };
	const model = (id: string) => ({
		id,
		name: id,
		enabled: true,
		tasks: ['chat' as const],
		inputModalities: ['text' as const],
		outputModalities: ['text' as const],
		contextWindow: 128_000,
		thinkingModes: [
			{ id: 'low', name: 'Low', parameters: { responses: { reasoning: { effort: 'low' } } } },
		],
	});
	state.connections = [
		{
			...state.connections[0],
			id: 'actor-api',
			name: 'Actor API',
			baseUrl: 'http://actor.invalid/v1',
			apiKey: 'synthetic-actor-key',
			chatApi: 'responses',
			models: {
				chat: 'actor-model',
				images: 'image-model',
				videos: '',
				speech: '',
				transcription: '',
			},
			catalog: [model('actor-model'), model('chat-model')],
		},
		{
			...state.connections[0],
			id: 'target-api',
			name: 'Target API',
			baseUrl: 'http://target.invalid/v1',
			apiKey: 'synthetic-target-key',
			chatApi: 'responses',
			models: { chat: 'target-model', images: '', videos: '', speech: '', transcription: '' },
			catalog: [model('target-model')],
		},
	];
	state.activeConnectionId = 'actor-api';
	state.toolSettings = {
		...defaultToolSettings(),
		enabled: true,
		approvalMode: 'full-access',
		imageGeneration: {
			enabled: true,
			connectionId: 'actor-api',
			model: 'image-model',
			size: '1024x1024',
			quality: '',
		},
	};
	state.toolSettings.webBrowsing!.enabled = false;
	state.projects = [
		{
			id: 'actor-project',
			kind: 'code',
			name: 'Actor repository',
			directories: ['/tmp/synthetic-actor'],
			instructions: 'ACTOR_PROJECT_ONLY',
			createdAt: 1,
		},
		{
			id: 'target-project',
			kind: 'code',
			name: 'Target repository',
			directories: ['/tmp/synthetic-target'],
			instructions: 'TARGET_PROJECT_ONLY',
			createdAt: 1,
		},
	];
	state.threads = [
		{
			id: 'actor',
			kind: 'code',
			title: ACTOR,
			titleSource: 'manual',
			connectionId: 'actor-api',
			projectId: 'actor-project',
			model: 'actor-model',
			thinkingMode: 'low',
			permissionMode: 'full-access',
			createdAt: 1,
			updatedAt: 2,
			messages: [
				{ id: 'actor-old-user', role: 'user', content: 'Initial task request', createdAt: 1 },
				{ id: 'actor-old-answer', role: 'assistant', content: OLD, createdAt: 2, completedAt: 3 },
			],
		},
		{
			id: 'target',
			kind: 'code',
			title: TARGET,
			titleSource: 'manual',
			connectionId: 'target-api',
			projectId: 'target-project',
			model: 'target-model',
			thinkingMode: 'low',
			permissionMode: 'full-access',
			createdAt: 1,
			updatedAt: 2,
			messages: [
				{ id: 'target-old-user', role: 'user', content: 'Target task context', createdAt: 1 },
				{
					id: 'target-old-answer',
					role: 'assistant',
					content: 'Target ready',
					createdAt: 2,
					completedAt: 3,
				},
			],
		},
		{
			id: 'chat',
			kind: 'chat',
			title: CHAT,
			titleSource: 'manual',
			connectionId: 'actor-api',
			model: 'chat-model',
			thinkingMode: 'low',
			createdAt: 1,
			updatedAt: 2,
			messages: [
				{ id: 'chat-old-user', role: 'user', content: 'Chat task context', createdAt: 1 },
				{
					id: 'chat-old-answer',
					role: 'assistant',
					content: 'Chat ready',
					createdAt: 2,
					completedAt: 3,
				},
			],
		},
	];
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (event) => {
		if (event.type() === 'error') errors.push(event.text());
	});
	await page.addInitScript(
		({ serialized, hostTools }) => {
			let saved: AppState = JSON.parse(
				sessionStorage.getItem('code-capabilities-state') || serialized,
			);
			let revision = 0;
			const requests: any[] = [],
				executions: any[] = [],
				saves: AppState[] = [],
				catalogs: any[] = [];
			const listeners = new Set<(event: { id: string; text: string }) => void>();
			const control = {
				state: () => structuredClone(saved),
				snapshot: () => ({
					requests: requests.map(({ resolve, reject, ...request }) => request),
					executions,
					catalogs,
					saves,
				}),
				finish: (
					index: number,
					answer: string,
					calls: { name: string; args: Record<string, unknown> }[] = [],
				) => {
					const request = requests[index];
					if (!request || request.finished)
						throw new Error('Unexpected synthetic request completion');
					request.finished = true;
					const output = [
						...(answer
							? [
									{
										type: 'message',
										role: 'assistant',
										content: [{ type: 'output_text', text: answer }],
									},
								]
							: []),
						...calls.map((call, callIndex) => ({
							type: 'function_call',
							call_id: `capability-${index}-${callIndex}`,
							name: call.name,
							arguments: JSON.stringify(call.args),
						})),
					];
					for (const listener of listeners)
						listener({
							id: request.id,
							text: `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output, usage: { input_tokens: 1000, output_tokens: 20, total_tokens: 1020 } } })}\n\n`,
						});
					request.resolve({
						status: 200,
						contentType: 'text/event-stream',
						encoding: 'text',
						body: '',
					});
				},
			};
			(window as any).__codeCapabilities = control;
			(window as any).desktop = {
				platform: 'linux',
				workspaceLoad: async () => ({ state: structuredClone(saved), revision: String(revision) }),
				workspaceSave: async (_id: string, _revision: string, next: AppState) => {
					saved = structuredClone(next);
					saves.push(structuredClone(saved));
					sessionStorage.setItem('code-capabilities-state', JSON.stringify(saved));
					return { revision: String(++revision) };
				},
				storageInfo: async () => ({
					secure: false,
					location: '/tmp/private-code-capabilities-profile',
				}),
				onPrepareClose: () => () => {},
				onToolApproval: () => () => {},
				instanceStatus: async () => ({
					host: { running: false, name: 'This computer', instanceId: 'local', port: 4319 },
					instances: [],
				}),
				toolCatalog: async (workspaceId: string, runId: string, threadId: string) => {
					catalogs.push({ workspaceId, runId, threadId });
					return {
						codeCapabilities: 1,
						tools: hostTools,
						instructions: 'Synthetic host tools, no machine operations.',
						warnings: [],
					};
				},
				toolExecute: async (request: any) => {
					executions.push(structuredClone(request));
					return { content: [{ type: 'text', text: 'Synthetic host action approved' }] };
				},
				toolCancel: async () => {},
				onChunk: (listener: (event: { id: string; text: string }) => void) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				cancel: async (id: string) => {
					const request = requests.find((request) => request.id === id);
					if (request && !request.finished) {
						request.finished = true;
						request.cancelled = true;
						request.reject(new DOMException('Cancelled', 'AbortError'));
					}
				},
				request: async (request: any) => {
					if (!request.stream)
						return {
							status: 200,
							contentType: 'application/json',
							encoding: 'text',
							body: JSON.stringify({ output_text: 'Synthetic task title' }),
						};
					return new Promise((resolve, reject) =>
						requests.push({
							...request,
							resolve,
							reject,
							finished: false,
							persistedBeforeRequest: structuredClone(saved),
						}),
					);
				},
			};
		},
		{
			serialized: JSON.stringify(state),
			hostTools: [
				imageTool,
				...interactionTools,
				{
					name: 'exec_command',
					source: 'builtin',
					description: 'Synthetic command tool; no command executes.',
					parameters: {
						type: 'object',
						properties: { cmd: { type: 'string' } },
						required: ['cmd'],
					},
				},
			],
		},
	);
	await page.goto('/');
	await expect(page).toHaveTitle('FreeLM');
	await open(page, 'Code', ACTOR);
	await expect(composer(page)).toBeVisible();
	return errors;
}
async function open(page: Page, kind: 'Code' | 'Chat', title: string) {
	await page.getByRole('button', { name: kind, exact: true }).click({ noWaitAfter: true });
	await page.getByTitle(title, { exact: true }).click({ noWaitAfter: true });
}
async function send(page: Page, value: string) {
	await composer(page).fill(value);
	await composer(page).press('Enter');
}
async function snapshot(
	page: Page,
): Promise<{ requests: any[]; executions: any[]; catalogs: any[]; saves: AppState[] }> {
	return page.evaluate(() => (window as any).__codeCapabilities.snapshot());
}
async function saved(page: Page): Promise<AppState> {
	return page.evaluate(() => (window as any).__codeCapabilities.state());
}
async function finish(page: Page, index: number, answer = '', calls: Call[] = []) {
	await page.evaluate(
		({ index, answer, calls }) => (window as any).__codeCapabilities.finish(index, answer, calls),
		{ index, answer, calls: calls.map((call) => ({ ...call, name: toolApiName(call.name) })) },
	);
}
async function requestCount(page: Page, count: number) {
	await expect.poll(async () => (await snapshot(page)).requests.length).toBe(count);
}

test('goal controls persist pause/resume and stop idle automatic spinning', async ({ page }) => {
	const errors = await fixture(page);
	await page.getByRole('button', { name: 'Add goal', exact: true }).click();
	await page
		.getByRole('textbox', { name: 'Goal objective' })
		.fill('Finish the focused prototype audit');
	await page.getByRole('spinbutton', { name: 'Goal token budget' }).fill('100000');
	await page.getByRole('button', { name: 'Set goal', exact: true }).click();
	await requestCount(page, 1);
	await expect
		.poll(
			async () =>
				(await saved(page)).threads.find((thread) => thread.id === 'actor')?.goal?.tokenBudget,
		)
		.toBe(100000);
	await page.getByRole('button', { name: 'Pause goal', exact: true }).click();
	await expect
		.poll(
			async () => (await saved(page)).threads.find((thread) => thread.id === 'actor')?.goal?.status,
		)
		.toBe('paused');
	await expect.poll(async () => (await snapshot(page)).requests[0].cancelled).toBe(true);
	await page.reload();
	await open(page, 'Code', ACTOR);
	await expect(page.getByRole('button', { name: 'Resume goal', exact: true })).toBeVisible();
	await expect(page.getByLabel('Persistent goal')).toContainText(
		'Finish the focused prototype audit',
	);
	await expect(page.getByLabel('Persistent goal')).toContainText('100,000');
	await requestCount(page, 0);
	await page.getByRole('button', { name: 'Resume goal', exact: true }).click();
	await requestCount(page, 1);
	await finish(page, 0, 'The automatic continuation needs a fresh user decision.');
	await expect
		.poll(
			async () =>
				(await saved(page)).threads.find((thread) => thread.id === 'actor')?.goal?.awaitingResume,
		)
		.toBe(true);
	await expect(page.getByLabel('Persistent goal')).toContainText('Ready to resume');
	// Give a spurious zero-delay continuation enough frames to become observable.
	await page.waitForTimeout(500);
	await requestCount(page, 1);
	await page.screenshot({ path: '/tmp/freelm-code-goal-controls.png' });
	expect(errors).toEqual([]);
});

test('context tools return matched results and reset replay while retaining original task history', async ({
	page,
}) => {
	const errors = await fixture(page);
	await send(page, 'LATEST_REQUEST_KEEP_AFTER_CONTEXT_RESET');
	await requestCount(page, 1);
	await finish(page, 0, '', [
		{ name: 'get_context_remaining', args: {} },
		{ name: 'new_context', args: {} },
	]);
	await requestCount(page, 2);
	const request = (await snapshot(page)).requests[1];
	const input = request.body.input as any[];
	const outputs = input.filter((item) => item.type === 'function_call_output');
	expect(outputs.map((item) => item.call_id)).toEqual(['capability-0-0', 'capability-0-1']);
	const remaining = JSON.parse(outputs[0].output);
	expect(remaining).toMatchObject({
		context_window: 128000,
		estimated: true,
		configured_capacity: true,
	});
	expect(remaining.remaining_tokens).toBeGreaterThan(0);
	expect(JSON.stringify(input)).toContain('LATEST_REQUEST_KEEP_AFTER_CONTEXT_RESET');
	expect(JSON.stringify(input)).not.toContain(OLD);
	expect(
		(await snapshot(page)).executions.some((item) =>
			['get_context_remaining', 'new_context'].includes(item.name),
		),
	).toBe(false);
	await finish(page, 1, 'Fresh context is ready.');
	await expect
		.poll(
			async () =>
				(await saved(page)).threads.find((thread) => thread.id === 'actor')?.messages.at(-1)
					?.content,
		)
		.toBe('Fresh context is ready.');
	const task = (await saved(page)).threads.find((thread) => thread.id === 'actor')!;
	expect(task.messages.some((message) => message.content === OLD)).toBe(true);
	expect(task.messages.at(-1)?.agentTranscript?.context).toBeDefined();
	expect(errors).toEqual([]);
});

test('task followups and creation persist first and dispatch with each task’s own configuration', async ({
	page,
}) => {
	const errors = await fixture(page);
	await send(page, 'Ask the target to verify its work and start another focused task.');
	await requestCount(page, 1);
	// Actor keeps running while another workspace/composer is visible.
	await open(page, 'Chat', CHAT);
	await expect(composer(page)).toBeVisible();
	await finish(page, 0, '', [
		{
			name: 'tasks.send_message_to_thread',
			args: { threadId: 'target', prompt: 'TARGET_BACKGROUND_FOLLOWUP' },
		},
	]);
	await expect
		.poll(
			async () =>
				(await snapshot(page)).requests.filter((request) => request.body.model === 'target-model')
					.length,
		)
		.toBe(1);
	await requestCount(page, 3);
	const first = await snapshot(page),
		targetRequest = first.requests.find((request) => request.body.model === 'target-model');
	expect(targetRequest.connectionId).toBe('target-api');
	expect(targetRequest.baseUrl).toBe('http://target.invalid/v1');
	expect(targetRequest.body.instructions).toContain('TARGET_PROJECT_ONLY');
	expect(targetRequest.body.instructions).not.toContain('ACTOR_PROJECT_ONLY');
	expect(JSON.stringify(targetRequest.body.input)).toContain('TARGET_BACKGROUND_FOLLOWUP');
	expect(
		first.saves.some((state) =>
			state.threads
				.find((thread) => thread.id === 'target')
				?.queuedMessages?.some((message) => message.content === 'TARGET_BACKGROUND_FOLLOWUP'),
		),
	).toBe(true);
	expect(
		targetRequest.persistedBeforeRequest.threads
			.find((thread: { id: string }) => thread.id === 'target')
			.messages.some(
				(message: { content: string }) => message.content === 'TARGET_BACKGROUND_FOLLOWUP',
			),
	).toBe(true);
	await expect(page.locator('.message.assistant')).toContainText('Chat ready');
	await expect(page.locator('.code-goal-controls')).toHaveCount(0);
	const actorNext = first.requests.findIndex(
		(request, index) => index > 0 && request.body.model === 'actor-model',
	);
	expect(actorNext).toBeGreaterThan(0);
	await finish(page, actorNext, '', [
		{
			name: 'tasks.create_thread',
			args: { prompt: 'CREATED_TASK_REQUEST', title: 'Created background task' },
		},
	]);
	await expect
		.poll(async () =>
			(await snapshot(page)).catalogs.some(
				(catalog) => !['actor', 'target', 'chat'].includes(catalog.threadId),
			),
		)
		.toBe(true);
	await requestCount(page, 5);
	const second = await snapshot(page),
		created = (await saved(page)).threads.find(
			(thread) => thread.title === 'Created background task',
		)!;
	expect(created).toMatchObject({
		projectId: 'actor-project',
		connectionId: 'actor-api',
		model: 'actor-model',
		thinkingMode: 'low',
		permissionMode: 'full-access',
	});
	expect(
		second.saves.some((state) =>
			state.threads
				.find((thread) => thread.id === created.id)
				?.queuedMessages?.some((message) => message.content === 'CREATED_TASK_REQUEST'),
		),
	).toBe(true);
	const createdRequest = second.requests.find(
		(request) =>
			request.body.model === 'actor-model' &&
			request.body.input.some(
				(item: { role?: string; content?: unknown }) =>
					item.role === 'user' && JSON.stringify(item.content).includes('CREATED_TASK_REQUEST'),
			),
	);
	expect(createdRequest.body.instructions).toContain('ACTOR_PROJECT_ONLY');
	expect(createdRequest.body.instructions).not.toContain('TARGET_PROJECT_ONLY');
	await expect(page.locator('.message.assistant')).toContainText('Chat ready');
	for (const [index, request] of second.requests.entries())
		if (!request.finished)
			await finish(
				page,
				index,
				request.body.model === 'target-model' ? 'Target check complete.' : 'Task complete.',
			);
	await expect
		.poll(
			async () =>
				(await saved(page)).threads.find((thread) => thread.id === 'target')?.messages.at(-1)
					?.content,
		)
		.toBe('Target check complete.');
	expect(
		second.executions
			.filter((item) => item.name === 'code_task_authorize')
			.map((item) => item.arguments.name),
	).toEqual(['tasks.send_message_to_thread', 'tasks.create_thread']);
	expect(errors).toEqual([]);
});

test('Code offers goals, context and task tools while Chat excludes them', async ({ page }) => {
	const errors = await fixture(page);
	await send(page, 'Show the enabled Code capabilities.');
	await requestCount(page, 1);
	const codeNames = (await snapshot(page)).requests[0].body.tools.map(
		(tool: { name: string }) => tool.name,
	);
	for (const name of [
		'get_goal',
		'create_goal',
		'update_goal',
		'get_context_remaining',
		'new_context',
		'tasks.list_threads',
		'tasks.read_thread',
		'tasks.create_thread',
		'tasks.send_message_to_thread',
	])
		expect(codeNames).toContain(toolApiName(name));
	await finish(page, 0, 'Code tools are enabled.');
	await open(page, 'Chat', CHAT);
	await send(page, 'Show the enabled Chat capabilities.');
	await requestCount(page, 2);
	const chatNames = (await snapshot(page)).requests[1].body.tools.map(
		(tool: { name: string }) => tool.name,
	);
	expect(chatNames).toContain(toolApiName('image_gen.imagegen'));
	for (const name of [
		'get_goal',
		'create_goal',
		'update_goal',
		'get_context_remaining',
		'new_context',
		...codeNames.filter((name: string) => name.startsWith('tasks')),
	])
		expect(chatNames).not.toContain(toolApiName(name));
	await expect(page.locator('.code-goal-controls')).toHaveCount(0);
	await finish(page, 1, 'Chat tools stay separate.');
	expect(errors).toEqual([]);
});
