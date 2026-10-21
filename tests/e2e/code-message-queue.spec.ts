import { selectConversationMode } from './helpers/conversation-mode';
import { expect, test, type Page } from '@playwright/test';
import { initialState } from '../../src/lib/state';
import { defaultToolSettings } from '../../src/lib/tool-settings';
import { interactionTools } from '../../src/lib/interaction-tools';
import type { AppState } from '../../src/types';

// Browser plugin unavailable. Use the actual App with private synthetic state,
// controlled Responses streams and mock host tools; no machine commands run.
test.setTimeout(180_000);
test.use({ actionTimeout: 45_000 });

const title = 'Queue review';
const otherTitle = 'Other Code task';
const quote = 'Remember the selected requirement.';
const png =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

async function fixture(page: Page, approvalMode: 'full-access' | 'ask' = 'full-access') {
	const state = initialState();
	state.theme = 'dark';
	state.backgroundNotifications = false;
	state.memorySettings = { savedMemories: false, referenceHistory: false };
	state.connections[0] = {
		...state.connections[0],
		name: 'Private queue API',
		baseUrl: 'http://queue.invalid/v1',
		chatApi: 'responses',
		models: { chat: 'queue-model', images: '', videos: '', speech: '', transcription: '' },
		catalog: [
			{
				id: 'queue-model',
				name: 'Queue model',
				enabled: true,
				tasks: ['chat'],
				inputModalities: ['text', 'image'],
				outputModalities: ['text'],
				contextWindow: 128_000,
				thinkingModes: [
					{ id: 'low', name: 'Low', parameters: { responses: { reasoning: { effort: 'low' } } } },
				],
			},
		],
	};
	state.connections[0].catalog!.push({
		...state.connections[0].catalog![0],
		id: 'queue-model-selected',
		name: 'Selected queue model',
		thinkingModes: ['low', 'high'].map((id) => ({
			id,
			name: id === 'low' ? 'Low' : 'High',
			parameters: { responses: { reasoning: { effort: id } } },
		})),
	});
	state.toolSettings = { ...defaultToolSettings(), enabled: true, approvalMode };
	state.toolSettings.webBrowsing!.enabled = false;
	state.projects = [
		{
			id: 'queue-project',
			kind: 'code',
			name: 'Private queue repository',
			directories: ['/tmp/queue-fixture'],
			instructions: '',
			createdAt: 1,
		},
	];
	state.threads = [title, otherTitle, 'Other Chat'].map((name, index) => ({
		id: `queue-thread-${index}`,
		kind: index === 2 ? 'chat' : 'code',
		title: name,
		titleSource: 'manual',
		connectionId: state.activeConnectionId,
		model: 'queue-model',
		thinkingMode: 'low',
		...(index === 2 ? {} : { projectId: 'queue-project', permissionMode: approvalMode }),
		createdAt: 1000,
		updatedAt: 2000,
		messages: [
			{ id: `old-user-${index}`, role: 'user', content: `Start ${name}.`, createdAt: 1000 },
			{
				id: `old-answer-${index}`,
				role: 'assistant',
				content: index ? `${name} is ready.` : quote,
				createdAt: 1500,
				completedAt: 2000,
			},
		],
	}));
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (event) => {
		if (event.type() === 'error') errors.push(event.text());
	});
	await page.route('**/queue.invalid/**', (route) => route.abort());
	await page.addInitScript(
		({ serialized, questionTool }) => {
			let saved: AppState = JSON.parse(sessionStorage.getItem('code-queue-state') || serialized);
			let revision = 0;
			const listeners = new Set<(event: { id: string; text: string }) => void>();
			const approvalListeners = new Set<(approval: any) => void>();
			const requests: any[] = [];
			const tools: any[] = [];
			const toolCancellations: string[] = [];
			const requestCancellations: string[] = [];
			const catalogs: any[] = [];
			const approvalDecisions: any[] = [];
			const emit = (index: number, event: Record<string, unknown>) => {
				const round = requests[index];
				if (!round || round.finished) throw new Error('Unexpected model fixture stream.');
				for (const listener of listeners)
					listener({ id: round.id, text: `data: ${JSON.stringify(event)}\n\n` });
			};
			const control: any = {
				requests,
				tools,
				toolCancellations,
				requestCancellations,
				catalogs,
				approvalDecisions,
				state: () => structuredClone(saved),
				streamModel: (index: number, text: string, reasoning = false) => {
					const round = requests[index];
					if (!reasoning) round.streamedText = (round.streamedText || '') + text;
					emit(index, {
						type: reasoning
							? 'response.reasoning_summary_text.delta'
							: 'response.output_text.delta',
						delta: text,
						item_id: reasoning ? `reasoning-${index}` : `message-${index}`,
						output_index: 0,
						...(reasoning ? { summary_index: 0 } : { content_index: 0 }),
					});
				},
				failModel: (index: number, error: string) => {
					const round = requests[index];
					if (!round || round.finished) throw new Error('Unexpected model fixture failure.');
					round.finished = true;
					round.resolve({
						status: 503,
						contentType: 'application/json',
						encoding: 'text',
						body: JSON.stringify({ error: { message: error } }),
					});
				},
				requireApproval: (index: number) => {
					const tool = tools[index];
					if (!tool || tool.finished) throw new Error('Unexpected fixture approval.');
					tool.approvalId = `queue-approval-${index}`;
					tool.requiresApproval = true;
					for (const listener of approvalListeners)
						listener({
							id: tool.approvalId,
							runId: tool.runId,
							threadId: tool.threadId,
							name: tool.name,
							arguments: tool.arguments,
							message: 'Approve this synthetic fixture command.',
							permissionMode: 'ask',
							effectiveDirectory: '/tmp/queue-fixture',
						});
				},
				finishModel: (
					index: number,
					answer: string,
					calls: { name: string; args: Record<string, unknown> }[] = [],
				) => {
					const round = requests[index];
					if (!round || round.finished) throw new Error('Unexpected model fixture completion.');
					round.finished = true;
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
							call_id: `queue-call-${index}-${callIndex}`,
							name: call.name,
							arguments: JSON.stringify(call.args),
						})),
					];
					for (const listener of listeners)
						listener({
							id: round.id,
							text: `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output } })}\n\n`,
						});
					round.resolve({
						status: 200,
						contentType: 'text/event-stream',
						encoding: 'text',
						body: '',
					});
				},
				finishTool: (index: number, text: string, sessionId?: string) => {
					const tool = tools[index];
					if (!tool || tool.finished) throw new Error('Unexpected tool fixture completion.');
					if (tool.requiresApproval && !tool.approved)
						throw new Error('Fixture tool cannot finish before explicit approval.');
					tool.finished = true;
					tool.resolve({
						content: [{ type: 'text', text }],
						...(sessionId
							? { process: { command: tool.arguments.cmd || 'write_stdin', sessionId } }
							: {}),
					});
				},
			};
			(window as any).__codeQueue = control;
			(window as any).desktop = {
				platform: 'linux',
				workspaceLoad: async () => ({ state: structuredClone(saved), revision: String(revision) }),
				workspaceSave: async (_id: string, _revision: string, next: AppState) => {
					saved = structuredClone(next);
					sessionStorage.setItem('code-queue-state', JSON.stringify(saved));
					return { revision: String(++revision) };
				},
				storageInfo: async () => ({ secure: false, location: '/tmp/private-code-queue-profile' }),
				onPrepareClose: () => () => {},
				onToolApproval: (listener: (approval: any) => void) => {
					approvalListeners.add(listener);
					return () => approvalListeners.delete(listener);
				},
				toolApprove: async (id: string, approved: boolean, remember?: boolean) => {
					approvalDecisions.push({ id, approved, remember });
					const tool = tools.find((entry) => entry.approvalId === id);
					if (!tool) throw new Error('Unknown fixture approval.');
					tool.approved = approved;
					if (!approved) {
						tool.finished = true;
						tool.resolve({ isError: true, content: [{ type: 'text', text: 'User declined.' }] });
					}
				},
				instanceStatus: async () => ({
					host: { running: false, name: 'This computer', instanceId: 'local', port: 4319 },
					instances: [],
				}),
				toolCatalog: async (workspaceId: string, runId: string, threadId: string) => {
					catalogs.push({ workspaceId, runId, threadId });
					return {
						tools: [
							questionTool,
							{
								name: 'exec_command',
								description: 'Mock command fixture.',
								source: 'builtin',
								parameters: {
									type: 'object',
									properties: { cmd: { type: 'string' } },
									required: ['cmd'],
								},
							},
							{
								name: 'write_stdin',
								description: 'Mock existing process fixture.',
								source: 'builtin',
								parameters: {
									type: 'object',
									properties: { session_id: { type: 'string' }, chars: { type: 'string' } },
									required: ['session_id'],
								},
							},
						],
						instructions: '',
						warnings: [],
					};
				},
				toolExecute: (request: any) =>
					new Promise((resolve, reject) =>
						tools.push({ ...request, resolve, reject, finished: false }),
					),
				toolCancel: async (runId: string) => {
					toolCancellations.push(runId);
					for (const tool of tools)
						if (tool.runId === runId && !tool.finished) {
							tool.finished = true;
							tool.reject(new DOMException('Cancelled', 'AbortError'));
						}
				},
				onChunk: (listener: (event: { id: string; text: string }) => void) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				cancel: async (id: string) => {
					requestCancellations.push(id);
					requests
						.find((round) => round.id === id)
						?.reject(new DOMException('Cancelled', 'AbortError'));
				},
				request: (request: any) =>
					new Promise((resolve, reject) =>
						requests.push({ ...request, resolve, reject, finished: false }),
					),
			};
		},
		{
			serialized: JSON.stringify(state),
			questionTool: interactionTools.find((tool) => tool.name === 'request_user_input'),
		},
	);
	await page.goto('/');
	await expect(page).toHaveTitle('FreeLM');
	await openCode(page);
	await expect(page.locator('.message')).toHaveCount(2);
	await expect(composer(page)).toBeVisible({ timeout: 45_000 });
	return errors;
}

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const rows = (page: Page) => page.locator('.code-message-queue-row');
const saved = (page: Page): Promise<AppState> =>
	page.evaluate(() => (window as any).__codeQueue.state());
const counters = (
	page: Page,
): Promise<{
	requests: any[];
	tools: any[];
	toolCancellations: string[];
	catalogs: any[];
	approvalDecisions: any[];
}> =>
	page.evaluate(() => {
		const control = (window as any).__codeQueue;
		return {
			requests: control.requests.map(({ body, path }: any) => ({ body, path })),
			tools: control.tools.map(({ runId, threadId, name, arguments: args, finished }: any) => ({
				runId,
				threadId,
				name,
				args,
				finished,
			})),
			toolCancellations: control.toolCancellations.slice(),
			catalogs: control.catalogs.slice(),
			approvalDecisions: control.approvalDecisions.slice(),
		};
	});
async function openCode(page: Page, thread = title) {
	await selectConversationMode(page, 'Code');
	await page.getByTitle(thread, { exact: true }).click({ noWaitAfter: true });
}
async function send(page: Page, text: string) {
	await composer(page).fill(text);
	await composer(page).press('Enter');
	await expect
		.poll(() =>
			composer(page).evaluate((element) => {
				const copy = element.cloneNode(true) as HTMLElement;
				copy.querySelectorAll('.cm-placeholder').forEach((placeholder) => placeholder.remove());
				return copy.textContent || '';
			}),
		)
		.toBe('');
}
async function finishModel(
	page: Page,
	index: number,
	answer = '',
	calls: { name: string; args: Record<string, unknown> }[] = [],
) {
	await page.evaluate(
		({ index, answer, calls }) => (window as any).__codeQueue.finishModel(index, answer, calls),
		{ index, answer, calls },
	);
}
async function finishTool(page: Page, index: number, text: string, sessionId?: string) {
	await page.evaluate(
		({ index, text, sessionId }) => (window as any).__codeQueue.finishTool(index, text, sessionId),
		{ index, text, sessionId },
	);
}
async function streamModel(page: Page, index: number, text: string, reasoning = false) {
	await page.evaluate(
		({ index, text, reasoning }) => (window as any).__codeQueue.streamModel(index, text, reasoning),
		{ index, text, reasoning },
	);
}
async function failModel(page: Page, index: number, error: string) {
	await page.evaluate(({ index, error }) => (window as any).__codeQueue.failModel(index, error), {
		index,
		error,
	});
}
async function requireApproval(page: Page, index: number) {
	await page.evaluate((index) => (window as any).__codeQueue.requireApproval(index), index);
}
async function healthy(page: Page, errors: string[]) {
	expect(errors).toEqual([]);
	await expect(page.locator('vite-error-overlay')).toHaveCount(0);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
		true,
	);
	expect(
		await page
			.locator('.chat-scroll')
			.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
	).toBe(true);
}

test('Code queues text, selected context and attachments after the entire tool batch, preserving process identity and navigation', async ({
	page,
}) => {
	const errors = await fixture(page);
	await send(page, 'Inspect the project using a continuing session.');
	await expect.poll(async () => (await counters(page)).requests.length).toBe(1);
	await finishModel(page, 0, 'Inspecting the project.', [
		{ name: 'exec_command', args: { cmd: 'synthetic continuing process' } },
		{ name: 'exec_command', args: { cmd: 'synthetic second command' } },
	]);
	await expect.poll(async () => (await counters(page)).tools.length).toBe(1);
	await expect(composer(page)).toBeEditable();
	const answer = page.locator('[data-message-id="old-answer-0"] .message-content');
	await answer.evaluate((element) => {
		const range = document.createRange();
		range.selectNodeContents(element);
		const selection = window.getSelection()!;
		selection.removeAllRanges();
		selection.addRange(range);
	});
	await answer.dispatchEvent('pointerup');
	await page.getByRole('button', { name: 'Reply to selection', exact: true }).click();
	await page.locator('.composer input[type="file"]').setInputFiles({
		name: 'queued-notes.md',
		mimeType: 'text/markdown',
		buffer: Buffer.from('Queued file detail.'),
	});
	await expect(page.locator('.attachment-preview')).toContainText('queued-notes.md');
	await send(page, 'First queued follow-up.');
	await expect(rows(page)).toHaveCount(1);
	await page.locator('.composer input[type="file"]').setInputFiles({
		name: 'queued-image.png',
		mimeType: 'image/png',
		buffer: Buffer.from(png, 'base64'),
	});
	await expect(page.locator('.attachment-preview img')).toBeVisible();
	await send(page, 'Second queued follow-up.');
	await expect(rows(page)).toHaveCount(2);
	await expect(rows(page).nth(0)).toContainText('First queued follow-up.');
	await expect(rows(page).nth(1)).toContainText('Second queued follow-up.');
	await page.screenshot({ path: '/tmp/freelm-code-queue-wide.png' });
	await page.setViewportSize({ width: 720, height: 900 });
	await healthy(page, errors);
	await page.screenshot({ path: '/tmp/freelm-code-queue-narrow.png' });
	await page.setViewportSize({ width: 1440, height: 940 });
	await openCode(page, otherTitle);
	await expect(rows(page)).toHaveCount(0);
	await composer(page).fill('Keep this unrelated Code draft.');
	await finishTool(page, 0, 'Process is still running; session_id: queue-session', 'queue-session');
	await expect.poll(async () => (await counters(page)).tools.length).toBe(2);
	expect((await counters(page)).requests).toHaveLength(1);
	expect((await counters(page)).toolCancellations).toEqual([]);
	await finishTool(page, 1, 'Second command finished.');
	await expect.poll(async () => (await counters(page)).requests.length).toBe(2);
	await expect(composer(page)).toHaveText('Keep this unrelated Code draft.');
	await expect(page.locator('.message.assistant').last()).toContainText(
		'Other Code task is ready.',
	);
	const body = (await counters(page)).requests[1].body;
	const input = body.input as any[];
	expect(input.filter((item) => item.type === 'function_call').map((item) => item.call_id)).toEqual(
		['queue-call-0-0', 'queue-call-0-1'],
	);
	expect(
		input.filter((item) => item.type === 'function_call_output').map((item) => item.call_id),
	).toEqual(['queue-call-0-0', 'queue-call-0-1']);
	const followUps = input.filter((item) => item.role === 'user').slice(-2);
	expect(JSON.stringify(followUps[0])).toContain('First queued follow-up.');
	expect(JSON.stringify(followUps[0])).toContain(quote);
	expect(JSON.stringify(followUps[0])).toContain('Queued file detail.');
	expect(JSON.stringify(followUps[1])).toContain('Second queued follow-up.');
	expect(followUps[1].content.filter((part: any) => part.type === 'input_image')).toHaveLength(1);
	expect((await counters(page)).toolCancellations).toEqual([]);
	await finishModel(page, 1, '', [
		{ name: 'write_stdin', args: { session_id: 'queue-session', chars: '' } },
	]);
	await expect.poll(async () => (await counters(page)).tools.length).toBe(3);
	const tools = (await counters(page)).tools;
	expect(new Set(tools.map((tool) => tool.runId)).size).toBe(1);
	expect(tools[2]).toMatchObject({
		name: 'write_stdin',
		args: { session_id: 'queue-session', chars: '' },
		threadId: 'queue-thread-0',
	});
	expect((await counters(page)).catalogs).toHaveLength(1);
	await finishTool(page, 2, 'The continuing process completed.');
	await expect.poll(async () => (await counters(page)).requests.length).toBe(3);
	await finishModel(page, 2, 'All queued requirements are complete.');
	await expect.poll(async () => (await counters(page)).toolCancellations.length).toBe(1);
	await expect.poll(async () => (await saved(page)).threads[0].messages.length).toBe(7);
	const thread = (await saved(page)).threads[0];
	expect(thread.queuedMessages).toEqual([]);
	expect(
		thread.messages.filter((message) => message.role === 'user').map((message) => message.content),
	).toEqual([
		'Start Queue review.',
		'Inspect the project using a continuing session.',
		'First queued follow-up.',
		'Second queued follow-up.',
	]);
	expect(new Set(thread.messages.map((message) => message.id)).size).toBe(thread.messages.length);
	expect(thread.messages[4].replyTo).toMatchObject({ messageId: 'old-answer-0', text: quote });
	expect(thread.messages[4].attachments).toHaveLength(1);
	expect(thread.messages[5].attachments).toHaveLength(1);
	expect((await saved(page)).threads[1].queuedMessages).toBeUndefined();
	await openCode(page);
	await expect(rows(page)).toHaveCount(0);
	await expect(page.locator('.message.assistant').last()).toContainText('All queued requirements');
	await healthy(page, errors);
});

test('editing pauses queue delivery, saving preserves FIFO position and deletion does not disturb the composer draft', async ({
	page,
}) => {
	const errors = await fixture(page);
	await send(page, 'Begin the edit review.');
	await expect.poll(async () => (await counters(page)).requests.length).toBe(1);
	for (const text of [
		'Edit this first message.',
		'Delete this second message.',
		'Keep this third message.',
	])
		await send(page, text);
	await expect(rows(page)).toHaveCount(3);
	await composer(page).fill('Retain this ordinary draft.');
	await rows(page).first().getByRole('combobox', { name: 'Queued message actions' }).click();
	await page.getByRole('option', { name: 'Edit message', exact: true }).click();
	await expect(composer(page)).toHaveText('Edit this first message.');
	await composer(page).fill('Revised first message.');
	await finishModel(page, 0, '', [
		{ name: 'exec_command', args: { cmd: 'synthetic edit boundary' } },
	]);
	await expect.poll(async () => (await counters(page)).tools.length).toBe(1);
	await finishTool(page, 0, 'First edit boundary finished.');
	await expect.poll(async () => (await counters(page)).requests.length).toBe(2);
	expect(JSON.stringify((await counters(page)).requests[1].body)).not.toContain(
		'Edit this first message.',
	);
	expect(JSON.stringify((await counters(page)).requests[1].body)).not.toContain(
		'Revised first message.',
	);
	await expect(rows(page)).toHaveCount(3);
	await page.getByRole('button', { name: 'Save queued message', exact: true }).click();
	await expect(composer(page)).toHaveText('Retain this ordinary draft.');
	await expect(rows(page).first()).toContainText('Revised first message.');
	await rows(page).nth(1).getByRole('button', { name: 'Remove queued message' }).click();
	await expect(rows(page)).toHaveCount(2);
	await expect(composer(page)).toHaveText('Retain this ordinary draft.');
	await finishModel(page, 1, '', [
		{ name: 'exec_command', args: { cmd: 'synthetic next edit boundary' } },
	]);
	await expect.poll(async () => (await counters(page)).tools.length).toBe(2);
	await finishTool(page, 1, 'Second edit boundary finished.');
	await expect.poll(async () => (await counters(page)).requests.length).toBe(3);
	const users = (await counters(page)).requests[2].body.input
		.filter((item: any) => item.role === 'user')
		.slice(-2);
	expect(JSON.stringify(users[0])).toContain('Revised first message.');
	expect(JSON.stringify(users[1])).toContain('Keep this third message.');
	expect(JSON.stringify((await counters(page)).requests[2].body)).not.toContain(
		'Delete this second message.',
	);
	await finishModel(page, 2, 'The revised queue is complete.');
	await expect.poll(async () => (await saved(page)).threads[0].queuedMessages?.length).toBe(0);
	await expect
		.poll(async () => (await saved(page)).chatDrafts?.['queue-thread-0']?.content)
		.toBe('Retain this ordinary draft.');
	await healthy(page, errors);
});

test('Stop preserves queued inputs through reload and idle Send commits them exactly once', async ({
	page,
}) => {
	const errors = await fixture(page);
	await send(page, 'Begin the stopped task.');
	await expect.poll(async () => (await counters(page)).requests.length).toBe(1);
	await finishModel(page, 0, '', [
		{ name: 'exec_command', args: { cmd: 'synthetic interrupted command' } },
	]);
	await expect.poll(async () => (await counters(page)).tools.length).toBe(1);
	await send(page, 'Resume with this queued message.');
	await expect(rows(page)).toHaveCount(1);
	await composer(page).fill('Preserve the unsent draft too.');
	await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toHaveCount(0);
	await composer(page).fill('');
	await page.getByRole('button', { name: 'Stop response', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toHaveCount(0);
	await composer(page).fill('Preserve the unsent draft too.');
	await expect(rows(page)).toHaveCount(1);
	await expect(composer(page)).toHaveText('Preserve the unsent draft too.');
	await expect
		.poll(async () => (await saved(page)).threads[0].messages.at(-1)?.interrupted)
		.toBe(true);
	await expect.poll(async () => (await saved(page)).threads[0].queuedMessages?.length).toBe(1);
	await expect
		.poll(async () => (await saved(page)).chatDrafts?.['queue-thread-0']?.content)
		.toBe('Preserve the unsent draft too.');
	const queuedId = (await saved(page)).threads[0].queuedMessages![0].id;
	await page.reload();
	await openCode(page);
	await expect(rows(page)).toHaveCount(1);
	await expect(composer(page)).toHaveText('Preserve the unsent draft too.');
	expect((await counters(page)).requests).toHaveLength(0);
	await rows(page)
		.first()
		.getByRole('button', { name: 'Send queued message', exact: true })
		.click();
	await expect.poll(async () => (await counters(page)).requests.length).toBe(1);
	expect(
		JSON.stringify((await counters(page)).requests[0].body).match(
			/Resume with this queued message\./g,
		),
	).toHaveLength(1);
	await expect(rows(page)).toHaveCount(0);
	await finishModel(page, 0, 'The preserved queued input was completed.');
	await expect
		.poll(async () => (await saved(page)).threads[0].messages.at(-1)?.content)
		.toBe('The preserved queued input was completed.');
	const thread = (await saved(page)).threads[0];
	expect(thread.queuedMessages).toEqual([]);
	expect(thread.messages.filter((message) => message.id === queuedId)).toHaveLength(1);
	expect(
		thread.messages.filter((message) => message.content === 'Resume with this queued message.'),
	).toHaveLength(1);
	expect((await counters(page)).tools).toHaveLength(0);
	await expect(composer(page)).toHaveText('Preserve the unsent draft too.');
	await page.reload();
	await openCode(page);
	await expect(rows(page)).toHaveCount(0);
	await expect(page.locator('.message.assistant').last()).toContainText('preserved queued input');
	expect((await counters(page)).requests).toHaveLength(0);
	await healthy(page, errors);
});

test('Code uses the ordinary Send control for text and attachment-only follow-ups during an active stream', async ({
	page,
}) => {
	const errors = await fixture(page);
	await send(page, 'Begin the active composer control check.');
	await expect.poll(async () => (await counters(page)).requests.length).toBe(1);
	await streamModel(page, 0, 'The Code stream is active.');
	await expect(page.locator('.message.assistant').last()).toContainText(
		'The Code stream is active.',
	);
	const sendButton = page.getByRole('button', { name: 'Send message', exact: true });
	const stopButton = page.getByRole('button', { name: 'Stop response', exact: true });
	await expect(composer(page)).toBeEditable();
	await expect(stopButton).toBeVisible();
	await expect(sendButton).toHaveCount(0);
	for (const control of [
		page.getByRole('button', { name: 'Attach files', exact: true }),
		page.getByRole('button', { name: 'Chat model', exact: true }),
		page.getByRole('combobox', { name: 'Code permissions', exact: true }),
	])
		await expect(control).toBeEnabled();
	await composer(page).fill('FOLLOWUP_WITH_ORDINARY_SEND');
	await expect(sendButton).toBeEnabled();
	await expect(stopButton).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Queue message', exact: true })).toHaveCount(0);
	await sendButton.click();
	await expect(rows(page)).toHaveCount(1);
	await expect(composer(page)).toBeFocused();
	await expect(stopButton).toBeVisible();
	await page.locator('.composer input[type="file"]').setInputFiles({
		name: 'notes.md',
		mimeType: 'text/markdown',
		buffer: Buffer.from('ACTIVE_ATTACHMENT_ONLY_FOLLOWUP'),
	});
	await expect(sendButton).toBeEnabled();
	await expect(stopButton).toHaveCount(0);
	await page
		.locator('.composer-area')
		.screenshot({ path: '/tmp/freelm-code-active-send-ui-wide.png' });
	await page.setViewportSize({ width: 720, height: 900 });
	await healthy(page, errors);
	await page
		.locator('.composer-area')
		.screenshot({ path: '/tmp/freelm-code-active-send-ui-narrow.png' });
	await page.setViewportSize({ width: 1440, height: 940 });
	await sendButton.click();
	await expect(rows(page)).toHaveCount(2);
	await expect(composer(page)).toBeFocused();
	await expect(stopButton).toBeVisible();
	expect((await counters(page)).requests).toHaveLength(1);
	await finishModel(page, 0, 'The Code stream is active.');
	await expect.poll(async () => (await counters(page)).requests.length).toBe(2);
	const input = JSON.stringify((await counters(page)).requests[1].body.input);
	for (const text of ['FOLLOWUP_WITH_ORDINARY_SEND', 'ACTIVE_ATTACHMENT_ONLY_FOLLOWUP'])
		expect(input.split(text)).toHaveLength(2);
	await finishModel(page, 1, 'The active composer follow-ups are complete.');
	await expect(rows(page)).toHaveCount(0);
	await expect(stopButton).toHaveCount(0);
	await healthy(page, errors);
});

for (const phase of ['text', 'reasoning'] as const) {
	test(`Code keeps ordinary Send and editing controls available after a real ${phase} stream delta`, async ({
		page,
	}) => {
		test.setTimeout(300_000);
		const errors = await fixture(page);
		await send(page, 'Begin the real stream check.');
		await expect.poll(async () => (await counters(page)).requests.length).toBe(1);
		await streamModel(page, 0, `Actual ${phase} delta.`, phase === 'reasoning');
		await expect
			.poll(async () => (await saved(page)).threads[0].messages.at(-1)?.phase)
			.toBe(phase === 'text' ? 'responding' : 'working');
		if (phase === 'text')
			await expect(page.locator('.message.assistant').last()).toContainText('Actual text delta.');
		const sendButton = page.getByRole('button', { name: 'Send message', exact: true });
		const stopButton = page.getByRole('button', { name: 'Stop response', exact: true });
		const attachmentButton = page.getByRole('button', { name: 'Attach files', exact: true });
		const modelButton = page.getByRole('button', { name: 'Chat model', exact: true });
		const permissionButton = page.getByRole('combobox', { name: 'Code permissions', exact: true });
		await expect(composer(page)).toBeEditable();
		await expect(stopButton).toBeVisible();
		await expect(sendButton).toHaveCount(0);
		await expect(attachmentButton).toBeEnabled();
		await expect(modelButton).toBeEnabled();
		await expect(permissionButton).toBeEnabled();
		await modelButton.click();
		await expect(page.getByRole('dialog', { name: 'Choose a model', exact: true })).toBeVisible();
		await page.keyboard.press('Escape');
		await permissionButton.click();
		await expect(page.getByRole('listbox').locator('[data-value="ask"]')).toBeVisible();
		await page.keyboard.press('Escape');
		await modelButton.click();
		await page.getByRole('button', { name: 'More models', exact: true }).click();
		await page.getByRole('option', { name: 'Selected queue model', exact: true }).click();
		await modelButton.click();
		await page.getByRole('button', { name: 'High', exact: true }).click();
		await page.keyboard.press('Escape');
		await expect(modelButton).toContainText('Selected queue model');
		await expect(modelButton).toContainText('High');
		expect((await counters(page)).requests[0].body).toMatchObject({
			model: 'queue-model',
			reasoning: { effort: 'low' },
		});
		await composer(page).fill('Queued with the button after streaming.');
		await expect(sendButton).toBeEnabled();
		await expect(stopButton).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Queue message', exact: true })).toHaveCount(0);
		await sendButton.click();
		await expect(rows(page)).toHaveCount(1);
		await expect(composer(page)).toBeFocused();
		await expect(stopButton).toBeVisible();
		await rows(page).first().getByRole('combobox', { name: 'Queued message actions' }).click();
		await page.getByRole('option', { name: 'Edit message', exact: true }).click();
		await expect(composer(page)).toBeEditable();
		await composer(page).fill('Queued with the button after streaming, then edited.');
		await expect(
			page.getByRole('button', { name: 'Save queued message', exact: true }),
		).toBeEnabled();
		await page.getByRole('button', { name: 'Save queued message', exact: true }).click();
		await expect(rows(page).first()).toContainText('then edited.');
		await send(page, 'Queued with Enter after streaming.');
		await expect(rows(page)).toHaveCount(2);
		const choosingFile = page.waitForEvent('filechooser');
		await attachmentButton.click();
		await (
			await choosingFile
		).setFiles({
			name: 'active-stream-notes.md',
			mimeType: 'text/markdown',
			buffer: Buffer.from('ATTACHMENT_ONLY_ACTIVE_STREAM_FOLLOWUP'),
		});
		await expect(page.locator('.attachment-preview')).toContainText('active-stream-notes.md');
		await expect(sendButton).toBeEnabled();
		await expect(stopButton).toHaveCount(0);
		await expect(modelButton).toBeEnabled();
		await expect(permissionButton).toBeEnabled();
		if (phase === 'text') {
			await page
				.locator('.composer-area')
				.screenshot({ path: '/tmp/freelm-code-active-send-wide.png' });
			await page.setViewportSize({ width: 720, height: 900 });
			await healthy(page, errors);
			await page
				.locator('.composer-area')
				.screenshot({ path: '/tmp/freelm-code-active-send-narrow.png' });
			await page.setViewportSize({ width: 1440, height: 940 });
		}
		await sendButton.click();
		await expect(rows(page)).toHaveCount(3);
		await expect(page.locator('.attachment-preview')).toHaveCount(0);
		await expect(stopButton).toBeVisible();
		expect((await counters(page)).requests).toHaveLength(1);
		expect((await counters(page)).toolCancellations).toEqual([]);
		await finishModel(
			page,
			0,
			phase === 'text' ? 'Actual text delta.' : 'The reasoning is complete.',
		);
		await expect.poll(async () => (await counters(page)).requests.length).toBe(2);
		expect((await counters(page)).requests[1].body).toMatchObject({
			model: 'queue-model-selected',
			reasoning: { effort: 'high' },
		});
		const input = JSON.stringify((await counters(page)).requests[1].body.input);
		for (const text of [
			'Queued with the button after streaming, then edited.',
			'Queued with Enter after streaming.',
			'ATTACHMENT_ONLY_ACTIVE_STREAM_FOLLOWUP',
		])
			expect(input.split(text)).toHaveLength(2);
		expect(input).not.toContain('Queued with the button after streaming.');
		await finishModel(page, 1, 'The streamed follow-ups are complete.');
		await expect(stopButton).toHaveCount(0);
		await expect(rows(page)).toHaveCount(0);
		await healthy(page, errors);
	});
}

test('an empty queued continuation fails even when the preceding segment used tools', async ({
	page,
}) => {
	const errors = await fixture(page);
	await send(page, 'Complete the command before the queued follow-up.');
	await expect.poll(async () => (await counters(page)).requests.length).toBe(1);
	await finishModel(page, 0, '', [
		{ name: 'exec_command', args: { cmd: 'synthetic preceding command' } },
	]);
	await expect.poll(async () => (await counters(page)).tools.length).toBe(1);
	await send(page, 'REQUIRE_A_NONEMPTY_QUEUED_RESPONSE');
	await finishTool(page, 0, 'Prior command completed.');
	await expect.poll(async () => (await counters(page)).requests.length).toBe(2);
	// Whitespace passes the protocol's nonempty-text check but must fail the
	// current segment's meaningful-response check, independent of earlier tools.
	await finishModel(page, 1, '   ');
	const failure = page.locator('.code-message-queue-failure-row');
	await expect(failure).toContainText('REQUIRE_A_NONEMPTY_QUEUED_RESPONSE');
	await expect(failure).toContainText('The provider returned no text.');
	await expect.poll(async () => (await saved(page)).threads[0].codeQueueFailures?.length).toBe(1);
	await failure.getByRole('button', { name: 'Retry queued messages', exact: true }).click();
	await expect.poll(async () => (await counters(page)).requests.length).toBe(3);
	expect(
		JSON.stringify((await counters(page)).requests[2].body).split(
			'REQUIRE_A_NONEMPTY_QUEUED_RESPONSE',
		),
	).toHaveLength(2);
	expect((await counters(page)).tools).toHaveLength(1);
	await finishModel(page, 2, 'A nonempty queued response completed.');
	await expect
		.poll(async () => (await saved(page)).threads[0].codeQueueFailures?.length ?? 0)
		.toBe(0);
	await healthy(page, errors);
});

test('queued continuation failures can retry committed inputs and completed tools without duplication through Stop and reload', async ({
	page,
}) => {
	const errors = await fixture(page);
	await send(page, 'Inspect before applying the queued changes.');
	await expect.poll(async () => (await counters(page)).requests.length).toBe(1);
	await finishModel(page, 0, '', [
		{ name: 'exec_command', args: { cmd: 'synthetic completed command' } },
	]);
	await expect.poll(async () => (await counters(page)).tools.length).toBe(1);
	await send(page, 'COMMITTED_QUEUED_REQUIREMENT');
	await expect(rows(page)).toHaveCount(1);
	await expect.poll(async () => (await saved(page)).threads[0].queuedMessages?.length).toBe(1);
	const committedId = (await saved(page)).threads[0].queuedMessages![0].id;
	await finishTool(page, 0, 'COMPLETED_TOOL_OUTPUT');
	await expect.poll(async () => (await counters(page)).requests.length).toBe(2);
	await finishModel(page, 1, '', [
		{ name: 'exec_command', args: { cmd: 'synthetic completed command within queued segment' } },
	]);
	await expect.poll(async () => (await counters(page)).tools.length).toBe(2);
	await finishTool(page, 1, 'FAILED_SEGMENT_COMPLETED_OUTPUT');
	await expect.poll(async () => (await counters(page)).requests.length).toBe(3);
	await failModel(page, 2, 'Queued continuation backend unavailable.');
	const failure = page.locator('.code-message-queue-failure-row');
	await expect(failure).toContainText('COMMITTED_QUEUED_REQUIREMENT');
	await expect(failure).toContainText('Queued continuation backend unavailable.');
	await expect(
		failure.getByRole('button', { name: 'Retry queued messages', exact: true }),
	).toBeEnabled();
	await page.screenshot({ path: '/tmp/freelm-queue-failed-followup-wide.png' });
	await page.setViewportSize({ width: 720, height: 900 });
	await healthy(page, errors);
	await page.screenshot({ path: '/tmp/freelm-queue-failed-followup-narrow.png' });
	await page.setViewportSize({ width: 1440, height: 940 });
	await expect.poll(async () => (await saved(page)).threads[0].codeQueueFailures?.length).toBe(1);
	const originalFailure = (await saved(page)).threads[0].codeQueueFailures![0];
	expect(originalFailure.messageIds).toEqual([committedId]);
	expect(
		(await saved(page)).threads[0].messages.filter((message) => message.id === committedId),
	).toHaveLength(1);
	await failure.getByRole('button', { name: 'Retry queued messages', exact: true }).click();
	await expect.poll(async () => (await counters(page)).requests.length).toBe(4);
	const assertRetry = async (index: number) => {
		const input = (await counters(page)).requests[index].body.input as any[];
		expect(JSON.stringify(input).split('COMMITTED_QUEUED_REQUIREMENT')).toHaveLength(2);
		for (const callId of ['queue-call-0-0', 'queue-call-1-0']) {
			expect(
				input.filter((item) => item.type === 'function_call' && item.call_id === callId),
			).toHaveLength(1);
			expect(
				input.filter((item) => item.type === 'function_call_output' && item.call_id === callId),
			).toHaveLength(1);
		}
		expect(JSON.stringify(input)).toContain('COMPLETED_TOOL_OUTPUT');
		expect(JSON.stringify(input)).toContain('FAILED_SEGMENT_COMPLETED_OUTPUT');
		expect((await counters(page)).tools).toHaveLength(2);
	};
	await assertRetry(3);
	await send(page, 'UNCONSUMED_NEW_QUEUED_REQUIREMENT');
	await failModel(page, 3, 'Retry backend still unavailable.');
	await expect(failure).toContainText('Retry backend still unavailable.');
	await expect.poll(async () => (await saved(page)).threads[0].queuedMessages?.length).toBe(1);
	await failure.getByRole('button', { name: 'Retry queued messages', exact: true }).click();
	await expect.poll(async () => (await counters(page)).requests.length).toBe(5);
	await assertRetry(4);
	expect(JSON.stringify((await counters(page)).requests[4].body)).not.toContain(
		'UNCONSUMED_NEW_QUEUED_REQUIREMENT',
	);
	await composer(page).fill('');
	await page.getByRole('button', { name: 'Stop response', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toHaveCount(0);
	await composer(page).fill('Keep this recovery draft.');
	await expect.poll(async () => (await saved(page)).threads[0].codeQueueFailures?.length).toBe(1);
	await expect.poll(async () => (await saved(page)).threads[0].queuedMessages?.length).toBe(1);
	await page.reload();
	await openCode(page);
	await expect(failure).toContainText('COMMITTED_QUEUED_REQUIREMENT');
	await expect(composer(page)).toHaveText('Keep this recovery draft.');
	expect((await counters(page)).requests).toHaveLength(0);
	await failure.getByRole('button', { name: 'Retry queued messages', exact: true }).click();
	await expect.poll(async () => (await counters(page)).requests.length).toBe(1);
	const reopenedInput = (await counters(page)).requests[0].body.input as any[];
	expect(JSON.stringify(reopenedInput).split('COMMITTED_QUEUED_REQUIREMENT')).toHaveLength(2);
	expect(reopenedInput.filter((item) => item.type === 'function_call_output')).toHaveLength(2);
	expect(JSON.stringify(reopenedInput)).toContain('COMPLETED_TOOL_OUTPUT');
	expect(JSON.stringify(reopenedInput)).toContain('FAILED_SEGMENT_COMPLETED_OUTPUT');
	expect(JSON.stringify(reopenedInput)).not.toContain('UNCONSUMED_NEW_QUEUED_REQUIREMENT');
	await finishModel(page, 0, 'The failed queued continuation recovered.');
	await expect.poll(async () => (await counters(page)).requests.length).toBe(2);
	expect(
		JSON.stringify((await counters(page)).requests[1].body.input).split(
			'UNCONSUMED_NEW_QUEUED_REQUIREMENT',
		),
	).toHaveLength(2);
	await finishModel(page, 1, 'All recovery and new queued requirements completed.');
	await expect
		.poll(async () => (await saved(page)).threads[0].codeQueueFailures?.length ?? 0)
		.toBe(0);
	await expect.poll(async () => (await saved(page)).threads[0].queuedMessages?.length).toBe(0);
	expect(
		(await saved(page)).threads[0].messages.filter((message) => message.id === committedId),
	).toHaveLength(1);
	expect((await counters(page)).tools).toHaveLength(0);
	await expect(composer(page)).toHaveText('Keep this recovery draft.');
	await healthy(page, errors);
});

test('two Code tasks retain their own inline questions and queues until explicit answers and complete tool batches', async ({
	page,
}) => {
	// This scenario runs two independent tasks through question and tool boundaries.
	test.setTimeout(300_000);
	const errors = await fixture(page);
	const question = (label: string) => ({
		name: 'request_user_input',
		args: {
			questions: [
				{
					id: `choice-${label}`,
					question: `Choose the ${label} plan.`,
					options: [{ label: `Use ${label}`, description: '' }],
				},
			],
		},
	});
	await send(page, 'Ask about task A before acting.');
	await expect.poll(async () => (await counters(page)).requests.length).toBe(1);
	await finishModel(page, 0, '', [
		question('A'),
		{ name: 'exec_command', args: { cmd: 'synthetic task A after answer' } },
	]);
	const prompt = page.getByRole('region', { name: 'Assistant question', exact: true });
	await expect(prompt).toContainText('Choose the A plan.');
	await prompt.getByLabel('Your answer: Choose the A plan.', { exact: true }).fill('Draft A');
	await expect(composer(page)).toBeVisible();
	await send(page, 'QUEUE_ONLY_FOR_TASK_A');
	await expect(rows(page)).toHaveCount(1);
	await page.screenshot({ path: '/tmp/freelm-queue-inline-question-wide.png' });
	await page.setViewportSize({ width: 720, height: 900 });
	await healthy(page, errors);
	await page.screenshot({ path: '/tmp/freelm-queue-inline-question-narrow.png' });
	await page.setViewportSize({ width: 1440, height: 940 });
	expect((await counters(page)).requests).toHaveLength(1);
	expect((await counters(page)).tools).toHaveLength(0);
	await openCode(page, otherTitle);
	await expect(prompt).toHaveCount(0);
	await send(page, 'Ask about task B before acting.');
	await expect.poll(async () => (await counters(page)).requests.length).toBe(2);
	await finishModel(page, 1, '', [
		question('B'),
		{ name: 'exec_command', args: { cmd: 'synthetic task B after answer' } },
	]);
	await expect(prompt).toContainText('Choose the B plan.');
	await send(page, 'QUEUE_ONLY_FOR_TASK_B');
	await expect(rows(page)).toHaveCount(1);
	expect((await counters(page)).requests).toHaveLength(2);
	expect((await counters(page)).tools).toHaveLength(0);
	await prompt.getByRole('button', { name: 'Use B', exact: true }).click();
	await prompt.getByRole('button', { name: 'Send', exact: true }).click();
	await expect.poll(async () => (await counters(page)).tools.length).toBe(1);
	expect((await counters(page)).tools[0].threadId).toBe('queue-thread-1');
	expect((await counters(page)).requests).toHaveLength(2);
	await finishTool(page, 0, 'Task B approved plan completed.');
	await expect.poll(async () => (await counters(page)).requests.length).toBe(3);
	const taskBInput = JSON.stringify((await counters(page)).requests[2].body.input);
	expect(taskBInput).toContain('Use B');
	expect(taskBInput).toContain('QUEUE_ONLY_FOR_TASK_B');
	expect(taskBInput).not.toContain('QUEUE_ONLY_FOR_TASK_A');
	await finishModel(page, 2, 'Task B is complete.');
	await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toHaveCount(0);
	await openCode(page);
	await expect(prompt).toContainText('Choose the A plan.');
	await expect(prompt.getByLabel('Your answer: Choose the A plan.', { exact: true })).toHaveValue(
		'Draft A',
	);
	await expect(rows(page)).toContainText('QUEUE_ONLY_FOR_TASK_A');
	await prompt.getByRole('button', { name: 'Use A', exact: true }).click();
	await prompt.getByRole('button', { name: 'Send', exact: true }).click();
	await expect.poll(async () => (await counters(page)).tools.length).toBe(2);
	expect((await counters(page)).tools[1].threadId).toBe('queue-thread-0');
	await finishTool(page, 1, 'Task A approved plan completed.');
	await expect.poll(async () => (await counters(page)).requests.length).toBe(4);
	const taskAInput = JSON.stringify((await counters(page)).requests[3].body.input);
	expect(taskAInput).toContain('Use A');
	expect(taskAInput).toContain('QUEUE_ONLY_FOR_TASK_A');
	expect(taskAInput).not.toContain('QUEUE_ONLY_FOR_TASK_B');
	await finishModel(page, 3, 'Task A is complete.');
	await expect.poll(async () => (await saved(page)).threads[0].queuedMessages?.length).toBe(0);
	await expect.poll(async () => (await saved(page)).threads[1].queuedMessages?.length).toBe(0);
	await healthy(page, errors);
});

test('the nonmodal question sheet can minimize and reopen without answering, losing drafts or trapping keyboard focus', async ({
	page,
}) => {
	const errors = await fixture(page);
	await send(page, 'Ask one question while I keep composing.');
	await expect.poll(async () => (await counters(page)).requests.length).toBe(1);
	await composer(page).focus();
	await expect(composer(page)).toBeFocused();
	await finishModel(page, 0, '', [
		{
			name: 'request_user_input',
			args: {
				questions: [
					{
						id: 'single',
						question: 'Which sample plan should I use before continuing?',
						options: [
							{
								label: 'Preserve the current sample',
								description: 'Inspect and extend the existing sample safely.',
							},
							{
								label: 'Create a fresh sample',
								description: 'Use a separate sample without changing the existing one.',
							},
						],
					},
				],
			},
		},
	]);
	const prompt = page.getByRole('region', { name: 'Assistant question', exact: true });
	const answer = prompt.getByLabel(
		'Your answer: Which sample plan should I use before continuing?',
		{ exact: true },
	);
	const submit = prompt.getByRole('button', { name: 'Send', exact: true });
	await expect(prompt).toBeVisible();
	await expect(prompt.getByRole('heading', { name: 'Question', exact: true })).toBeVisible();
	await expect(page.locator('[aria-modal="true"],.tool-prompt-backdrop')).toHaveCount(0);
	await expect(composer(page)).toBeFocused();
	await expect(submit).toBeDisabled();
	await expect(
		prompt.getByRole('button', { name: 'Preserve the current sample', exact: true }),
	).toHaveAttribute('aria-pressed', 'false');
	await answer.fill('Keep this custom answer pending.');
	await expect(submit).toBeEnabled();
	const custom = prompt.locator('.tool-question-custom');
	const [pencilBox, answerBox] = await Promise.all([
		custom.locator('svg').boundingBox(),
		answer.boundingBox(),
	]);
	expect(pencilBox).not.toBeNull();
	expect(answerBox).not.toBeNull();
	expect(pencilBox!.x + pencilBox!.width).toBeLessThan(answerBox!.x);
	expect(pencilBox!.y).toBeGreaterThanOrEqual(answerBox!.y - 2);
	expect(pencilBox!.y).toBeLessThan(answerBox!.y + answerBox!.height);
	await page
		.locator('.composer-area')
		.screenshot({ path: '/tmp/freelm-question-sheet-wide-composer.png' });
	await page.screenshot({ path: '/tmp/freelm-question-sheet-wide.png' });
	await page.setViewportSize({ width: 720, height: 900 });
	await healthy(page, errors);
	await page.screenshot({ path: '/tmp/freelm-question-sheet-narrow.png' });
	await page.setViewportSize({ width: 1440, height: 940 });
	await prompt.getByRole('button', { name: 'Minimize question', exact: true }).focus();
	await page.keyboard.press('Shift+Tab');
	expect(
		await page.evaluate(
			() => !document.activeElement?.closest('[aria-label="Assistant question"]'),
		),
	).toBe(true);
	await submit.focus();
	await page.keyboard.press('Tab');
	expect(
		await page.evaluate(
			() => !document.activeElement?.closest('[aria-label="Assistant question"]'),
		),
	).toBe(true);
	await page.getByRole('button', { name: 'Home', exact: true }).focus();
	await expect(page.getByRole('button', { name: 'Home', exact: true })).toBeFocused();
	await prompt.getByRole('button', { name: 'Minimize question', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Question', exact: true })).toBeVisible();
	await expect(answer).toHaveCount(0);
	await send(page, 'QUEUED_WHILE_QUESTION_MINIMIZED');
	await expect(rows(page)).toContainText('QUEUED_WHILE_QUESTION_MINIMIZED');
	await composer(page).fill('Keep the composer draft while answering.');
	await page.screenshot({ path: '/tmp/freelm-question-sheet-minimized.png' });
	expect((await counters(page)).requests).toHaveLength(1);
	expect((await counters(page)).tools).toHaveLength(0);
	await page.getByRole('button', { name: 'Question', exact: true }).click();
	await expect(answer).toHaveValue('Keep this custom answer pending.');
	await expect(composer(page)).toHaveText('Keep the composer draft while answering.');
	await submit.click();
	await expect.poll(async () => (await counters(page)).requests.length).toBe(2);
	const input = JSON.stringify((await counters(page)).requests[1].body.input);
	for (const value of ['Keep this custom answer pending.', 'QUEUED_WHILE_QUESTION_MINIMIZED'])
		expect(input.split(value)).toHaveLength(2);
	await finishModel(page, 1, 'The explicit question answer and queued follow-up are complete.');
	await expect(prompt).toHaveCount(0);
	await expect(composer(page)).toHaveText('Keep the composer draft while answering.');
	await healthy(page, errors);
});

test('multi-page question answers remain pending across navigation and another task Skip until an explicit complete Send', async ({
	page,
}) => {
	test.setTimeout(300_000);
	const errors = await fixture(page);
	await send(page, 'Ask two questions before the next command.');
	await expect.poll(async () => (await counters(page)).requests.length).toBe(1);
	await finishModel(page, 0, '', [
		{
			name: 'request_user_input',
			args: {
				questions: [
					{
						id: 'preserve',
						question: 'How should I handle the sample files?',
						options: [
							{
								label: 'Preserve existing files',
								description: 'Inspect the sample and build on it.',
							},
						],
					},
					{
						id: 'framework',
						question: 'Which framework should the sample use?',
						options: [
							{
								label: 'Use the suggested framework',
								description: 'Use the suggested sample implementation.',
							},
						],
					},
				],
			},
		},
		{ name: 'exec_command', args: { cmd: 'synthetic command after both question answers' } },
	]);
	const prompt = page.getByRole('region', { name: 'Assistant question', exact: true });
	const next = prompt.getByRole('button', { name: 'Next', exact: true });
	await expect(next).toBeDisabled();
	await expect(prompt.getByRole('button', { name: 'Send', exact: true })).toHaveCount(0);
	await prompt.getByRole('button', { name: 'Preserve existing files', exact: true }).click();
	await expect(
		prompt.getByRole('button', { name: 'Preserve existing files', exact: true }),
	).toHaveAttribute('aria-pressed', 'true');
	await next.click();
	const framework = prompt.getByLabel('Your answer: Which framework should the sample use?', {
		exact: true,
	});
	await expect(framework).toBeVisible();
	await expect(prompt.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
	await framework.fill('Use my custom sample framework.');
	await prompt.getByRole('button', { name: 'Previous', exact: true }).click();
	await expect(
		prompt.getByRole('button', { name: 'Preserve existing files', exact: true }),
	).toHaveAttribute('aria-pressed', 'true');
	await next.click();
	await expect(framework).toHaveValue('Use my custom sample framework.');
	await send(page, 'QUEUED_ONLY_FOR_MULTIPAGE_TASK_A');
	await page.screenshot({ path: '/tmp/freelm-question-sheet-multipage-wide.png' });
	await page.setViewportSize({ width: 720, height: 900 });
	await healthy(page, errors);
	await page.screenshot({ path: '/tmp/freelm-question-sheet-multipage-narrow.png' });
	await page.setViewportSize({ width: 1440, height: 940 });
	await prompt.getByRole('button', { name: 'Minimize question', exact: true }).click();
	await page.getByRole('button', { name: 'Question', exact: true }).click();
	await expect(framework).toHaveValue('Use my custom sample framework.');
	expect((await counters(page)).requests).toHaveLength(1);
	expect((await counters(page)).tools).toHaveLength(0);
	await openCode(page, otherTitle);
	await expect(prompt).toHaveCount(0);
	await send(page, 'Ask a different question for task B.');
	await expect.poll(async () => (await counters(page)).requests.length).toBe(2);
	await finishModel(page, 1, '', [
		{
			name: 'request_user_input',
			args: {
				questions: [
					{
						id: 'other',
						question: 'Should this other task use its sample?',
						options: [{ label: 'Use the other sample', description: '' }],
					},
				],
			},
		},
	]);
	await expect(prompt).toContainText('Should this other task use its sample?');
	await prompt.getByRole('button', { name: 'Skip', exact: true }).click();
	await expect.poll(async () => (await counters(page)).requests.length).toBe(3);
	const taskBInput = (await counters(page)).requests[2].body.input as any[];
	const skipped = taskBInput.find(
		(item) => item.type === 'function_call_output' && item.call_id === 'queue-call-1-0',
	);
	expect(JSON.parse(skipped.output)).toEqual({ answers: {} });
	expect(JSON.stringify(taskBInput)).not.toContain('QUEUED_ONLY_FOR_MULTIPAGE_TASK_A');
	await finishModel(page, 2, 'The other task question was explicitly skipped.');
	await openCode(page);
	await expect(framework).toHaveValue('Use my custom sample framework.');
	await expect(rows(page)).toContainText('QUEUED_ONLY_FOR_MULTIPAGE_TASK_A');
	await prompt.getByRole('button', { name: 'Send', exact: true }).click();
	await expect.poll(async () => (await counters(page)).tools.length).toBe(1);
	expect((await counters(page)).requests).toHaveLength(3);
	await finishTool(page, 0, 'MULTIPAGE_TASK_A_TOOL_COMPLETED');
	await expect.poll(async () => (await counters(page)).requests.length).toBe(4);
	const taskAInput = (await counters(page)).requests[3].body.input as any[];
	const answered = taskAInput.find(
		(item) => item.type === 'function_call_output' && item.call_id === 'queue-call-0-0',
	);
	expect(JSON.parse(answered.output)).toEqual({
		answers: {
			preserve: { answers: ['Preserve existing files'] },
			framework: { answers: ['Use my custom sample framework.'] },
		},
	});
	for (const value of ['QUEUED_ONLY_FOR_MULTIPAGE_TASK_A', 'MULTIPAGE_TASK_A_TOOL_COMPLETED'])
		expect(JSON.stringify(taskAInput).split(value)).toHaveLength(2);
	expect(JSON.stringify(taskAInput)).not.toContain(
		'The other task question was explicitly skipped.',
	);
	await finishModel(page, 3, 'Both question pages and the queued Code requirement are complete.');
	await expect(prompt).toHaveCount(0);
	await healthy(page, errors);
});

test('queueing remains available during permissions and never grants them or advances an unfinished tool batch', async ({
	page,
}) => {
	const errors = await fixture(page, 'ask');
	await send(page, 'Run two commands only after approval.');
	await expect.poll(async () => (await counters(page)).requests.length).toBe(1);
	await finishModel(page, 0, '', [
		{ name: 'exec_command', args: { cmd: 'synthetic first protected command' } },
		{ name: 'exec_command', args: { cmd: 'synthetic second protected command' } },
	]);
	await expect.poll(async () => (await counters(page)).tools.length).toBe(1);
	await requireApproval(page, 0);
	const approvals = page.getByLabel('Pending tool approvals', { exact: true });
	await expect(approvals).toBeVisible();
	await expect(composer(page)).toBeEditable();
	await send(page, 'QUEUE_DURING_FIRST_APPROVAL');
	await expect(rows(page)).toHaveCount(1);
	expect((await counters(page)).approvalDecisions).toEqual([]);
	expect((await counters(page)).requests).toHaveLength(1);
	expect((await counters(page)).tools[0].finished).toBe(false);
	await openCode(page, otherTitle);
	await expect(approvals).toHaveCount(0);
	await composer(page).fill('Preserve the unrelated task draft.');
	await openCode(page);
	await expect(approvals).toBeVisible();
	await approvals.getByRole('button', { name: 'Allow once', exact: true }).click();
	await expect.poll(async () => (await counters(page)).approvalDecisions.length).toBe(1);
	await finishTool(page, 0, 'FIRST_EXPLICITLY_APPROVED_OUTPUT');
	await expect.poll(async () => (await counters(page)).tools.length).toBe(2);
	await requireApproval(page, 1);
	await expect(approvals).toBeVisible();
	await composer(page).fill('QUEUE_DURING_SECOND_APPROVAL');
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	await expect(rows(page)).toHaveCount(2);
	expect((await counters(page)).requests).toHaveLength(1);
	expect((await counters(page)).approvalDecisions).toHaveLength(1);
	await approvals.getByRole('button', { name: 'Allow once', exact: true }).click();
	await expect.poll(async () => (await counters(page)).approvalDecisions.length).toBe(2);
	await finishTool(page, 1, 'SECOND_EXPLICITLY_APPROVED_OUTPUT');
	await expect.poll(async () => (await counters(page)).requests.length).toBe(2);
	const input = (await counters(page)).requests[1].body.input as any[];
	expect(input.filter((item) => item.type === 'function_call_output')).toHaveLength(2);
	for (const marker of [
		'QUEUE_DURING_FIRST_APPROVAL',
		'QUEUE_DURING_SECOND_APPROVAL',
		'FIRST_EXPLICITLY_APPROVED_OUTPUT',
		'SECOND_EXPLICITLY_APPROVED_OUTPUT',
	])
		expect(JSON.stringify(input).split(marker)).toHaveLength(2);
	await finishModel(page, 1, 'Both approved commands and queued requirements are complete.');
	await expect(rows(page)).toHaveCount(0);
	await openCode(page, otherTitle);
	await expect(composer(page)).toHaveText('Preserve the unrelated task draft.');
	await healthy(page, errors);
});
