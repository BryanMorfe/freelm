import { selectConversationMode } from './helpers/conversation-mode';
import { expect, test, type Page } from '@playwright/test';
import { initialState } from '../../src/lib/state';
import { defaultToolSettings } from '../../src/lib/tool-settings';
import { webTool } from '../../src/lib/web-tools';
import type { AppState, Thread } from '../../src/types';

test.setTimeout(120_000);
test.use({ actionTimeout: 15_000 });
const browserErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
	const errors: string[] = [];
	browserErrors.set(page, errors);
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (entry) => {
		if (entry.type() === 'error') errors.push(entry.text());
	});
});
test.afterEach(({ page }) => expect(browserErrors.get(page)).toEqual([]));

// Hold separate provider streams behind an in-memory bridge so interleaving is
// deterministic. This never opens the user's workspace or calls their provider.
async function fixture(
	page: Page,
	web = false,
	{
		storageInfoStalls = false,
		workspaceLoadStalls = false,
		composerModels = false,
	}: {
		storageInfoStalls?: boolean;
		workspaceLoadStalls?: boolean;
		composerModels?: boolean;
	} = {},
) {
	const state = initialState();
	const connection = state.connections[0];
	connection.models.chat = 'lifecycle-fixture';
	connection.catalog = [
		{
			id: 'lifecycle-fixture',
			name: 'Lifecycle fixture',
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
	if (composerModels)
		connection.catalog.push({
			...connection.catalog[0],
			id: 'next-response-fixture',
			name: 'Next response fixture',
			thinkingModes: [
				...connection.catalog[0].thinkingModes!,
				{
					id: 'high',
					name: 'High',
					parameters: {
						responses: { reasoning: { effort: 'high' } },
						chat: { reasoning_effort: 'high' },
					},
				},
			],
		});
	state.memorySettings = { savedMemories: false, referenceHistory: false };
	state.toolSettings = defaultToolSettings();
	if (web)
		state.toolSettings.webBrowsing = {
			...state.toolSettings.webBrowsing!,
			enabled: true,
			mode: 'external',
			searxngUrl: 'http://research-fixture.invalid',
		};
	state.backgroundNotifications = true;
	const now = Date.now() - 60_000;
	state.threads = ['Alpha', 'Beta'].map((title, index): Thread => ({
		id: title.toLowerCase(),
		title,
		titleSource: 'manual',
		kind: 'chat',
		connectionId: connection.id,
		model: 'lifecycle-fixture',
		thinkingMode: 'low',
		createdAt: now + index,
		updatedAt: now + index,
		messages: [],
	}));
	await page.addInitScript(
		({ serialized, tools, storageInfoStalls, workspaceLoadStalls }) => {
			let current: AppState = JSON.parse(sessionStorage.getItem('lifecycle-state') ?? serialized),
				revision = 0;
			const listeners = new Set<(event: { id: string; text: string }) => void>();
			const saveWaiters: (() => void)[] = [];
			const loadWaiters: { resolve: () => void; reject: (reason: Error) => void }[] = [];
			const pending = new Map<
				string,
				{ request: any; text?: string; resolve: (value: any) => void }
			>();
			const find = (prompt: string) => {
				const item = Array.from(pending.values()).find(({ request }) =>
					JSON.stringify(request.body).includes(prompt),
				);
				if (!item) throw new Error(`No pending stream for ${prompt}`);
				return item;
			};
			const emit = (id: string, data: any) => {
				for (const listener of listeners)
					listener({ id, text: `data: ${JSON.stringify(data)}\n\n` });
			};
			const control: any = {
				state: () => current,
				requests: [],
				canceled: [],
				catalogs: [],
				notifications: [],
				toolCalls: [],
				closed: 0,
				storageInfoPending: false,
				releaseLoad: () => {
					for (const waiter of loadWaiters.splice(0)) waiter.resolve();
				},
				rejectLoad: () => {
					for (const waiter of loadWaiters.splice(0))
						waiter.reject(new Error('Fixture workspace unavailable'));
				},
				holdSaves: false,
				releaseSaves: () => {
					control.holdSaves = false;
					for (const release of saveWaiters.splice(0)) release();
				},
				pending: () => Array.from(pending.values()).map(({ request }) => request),
				delta: (prompt: string, text: string) => {
					const item = find(prompt);
					item.text = (item.text ?? '') + text;
					emit(item.request.id, { type: 'response.output_text.delta', delta: text });
				},
				search: (prompt: string) => {
					const item = find(prompt);
					const name = item.request.body.tools[0].name;
					emit(item.request.id, {
						type: 'response.completed',
						response: {
							status: 'completed',
							output: [
								{
									type: 'function_call',
									call_id: 'temporary-search',
									name,
									arguments: JSON.stringify({ search_query: [{ q: 'temporary test search' }] }),
								},
							],
						},
					});
					pending.delete(item.request.id);
					item.resolve({
						status: 200,
						contentType: 'text/event-stream',
						encoding: 'text',
						body: '',
					});
				},
				finish: (prompt: string, answer: string) => {
					const item = find(prompt);
					for (const data of [
						{
							type: 'response.output_text.delta',
							delta:
								item.text && answer.startsWith(item.text) ? answer.slice(item.text.length) : answer,
						},
						{ type: 'response.completed', response: { output_text: answer } },
					])
						emit(item.request.id, data);
					pending.delete(item.request.id);
					item.resolve({
						status: 200,
						contentType: 'text/event-stream',
						encoding: 'text',
						body: '',
					});
				},
			};
			(window as any).__lifecycle = control;
			(window as any).desktop = {
				platform: 'linux',
				workspaceLoad: async () => {
					if (workspaceLoadStalls)
						await new Promise<void>((resolve, reject) => loadWaiters.push({ resolve, reject }));
					return { state: structuredClone(current), revision: String(revision) };
				},
				workspaceSave: async (_id: string, _revision: string, next: AppState) => {
					if (control.holdSaves) await new Promise<void>((resolve) => saveWaiters.push(resolve));
					current = structuredClone(next);
					sessionStorage.setItem('lifecycle-state', JSON.stringify(current));
					return { revision: String(++revision) };
				},
				storageInfo: async () => {
					if (storageInfoStalls) {
						control.storageInfoPending = true;
						return new Promise<never>(() => {});
					}
					return { secure: false, location: 'Private lifecycle fixture' };
				},
				onPrepareClose: (listener: () => void) => {
					control.prepareClose = listener;
					return () => {
						delete control.prepareClose;
					};
				},
				completeClose: async () => {
					control.closed++;
				},
				onToolApproval: () => () => {},
				onOpenThread: () => () => {},
				instanceStatus: async () => ({
					host: { running: false, name: 'Local', instanceId: 'local', port: 4319 },
					instances: [],
				}),
				toolCatalog: async (...args: any[]) => {
					control.catalogs.push(args);
					return { tools, instructions: '', warnings: [] };
				},
				toolExecute: async (request: any) => {
					if (request.name !== 'web.run') throw new Error('Unexpected fixture tool');
					control.toolCalls.push(request);
					return { content: [{ type: 'text', text: 'Temporary search result' }] };
				},
				toolCancel: async () => {},
				notifyCompletion: async (notification: any) => {
					control.notifications.push(notification);
				},
				cancel: async (id: string) => {
					control.canceled.push(id);
					pending.delete(id);
				},
				onChunk: (listener: any) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				request: (request: any) => {
					control.requests.push(request);
					if (!request.stream)
						return Promise.resolve({
							status: 200,
							contentType: 'application/json',
							encoding: 'text',
							body: JSON.stringify({ output_text: 'Fixture conversation' }),
						});
					return new Promise((resolve) => pending.set(request.id, { request, resolve }));
				},
			};
		},
		{
			serialized: JSON.stringify(state),
			tools: web ? [webTool] : [],
			storageInfoStalls,
			workspaceLoadStalls,
		},
	);
	await page.goto('/');
	if (!workspaceLoadStalls)
		await expect(page.getByLabel('Message', { exact: true })).toBeVisible({ timeout: 30_000 });
	await expect(page).toHaveTitle('FreeLM');
	await expect(page.locator('vite-error-overlay')).toHaveCount(0);
}

async function finish(page: Page, prompt: string, answer: string) {
	await page.evaluate(({ prompt, answer }) => (window as any).__lifecycle.finish(prompt, answer), {
		prompt,
		answer,
	});
}

test('Chat can select the next model and attach a scoped draft while the current response keeps its model', async ({
	page,
}) => {
	await fixture(page, true, { composerModels: true });
	const composer = page.getByLabel('Message', { exact: true });
	const picker = page.getByRole('button', { name: 'Chat model', exact: true });
	const attach = page.getByRole('button', { name: 'Attach files', exact: true });
	await page.getByRole('button', { name: 'Alpha', exact: true }).click();
	await composer.fill('Inspect the current request');
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => (window as any).__lifecycle.pending().length))
		.toBe(1);
	await page.evaluate(() =>
		(window as any).__lifecycle.delta('Inspect the current request', 'I am checking the request.'),
	);
	await expect(page.locator('.message.assistant')).toContainText('I am checking the request.');
	await expect(picker).toBeEnabled();
	await expect(attach).toBeEnabled();
	await picker.click();
	await page.getByRole('button', { name: 'More models', exact: true }).click();
	await page.getByRole('option', { name: 'Next response fixture', exact: true }).click();
	await picker.click();
	await page.getByRole('button', { name: 'High', exact: true }).click();
	await page.keyboard.press('Escape');
	await expect(picker).toContainText(/Next response fixture\s*High/);
	await composer.fill('Use these notes in the next response');
	const chooser = page.waitForEvent('filechooser');
	await attach.click();
	await (
		await chooser
	).setFiles({
		name: 'next-response-notes.txt',
		mimeType: 'text/plain',
		buffer: Buffer.from('These notes belong only to the next request.'),
	});
	await expect(page.locator('.attachment-preview')).toContainText('next-response-notes.txt');
	await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toBeEnabled();
	await composer.press('Enter');
	await expect(composer).toHaveText('Use these notes in the next response');
	await expect
		.poll(() => page.evaluate(() => (window as any).__lifecycle.pending().length))
		.toBe(1);
	await page.screenshot({ path: '/tmp/freelm-chat-streaming-controls.png' });

	await page.getByRole('button', { name: 'Beta', exact: true }).click();
	await expect(composer.locator('.cm-placeholder')).toHaveText('Ask anything');
	await expect(page.locator('.attachment-preview')).toHaveCount(0);
	await expect(picker).toContainText(/Lifecycle fixture\s*Low/);
	await page.getByRole('button', { name: 'Responding Alpha', exact: true }).click();
	await expect(composer).toHaveText('Use these notes in the next response');
	await expect(page.locator('.attachment-preview')).toContainText('next-response-notes.txt');
	await expect(picker).toContainText(/Next response fixture\s*High/);

	// A following tool round still belongs to the original response, even though
	// the composer has selected a different model and effort for the next send.
	await page.evaluate(() => (window as any).__lifecycle.search('Inspect the current request'));
	await expect
		.poll(() =>
			page.evaluate(() => (window as any).__lifecycle.requests.filter((r: any) => r.stream).length),
		)
		.toBe(2);
	const runningRequests = await page.evaluate(() =>
		(window as any).__lifecycle.requests.filter((r: any) => r.stream).map((r: any) => r.body),
	);
	for (const body of runningRequests) {
		expect(body.model).toBe('lifecycle-fixture');
		expect(body.reasoning.effort).toBe('low');
		expect(JSON.stringify(body)).not.toContain('These notes belong only to the next request.');
	}
	await finish(page, 'Inspect the current request', 'The current response is complete.');
	await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toHaveCount(0);
	await expect(composer).toHaveText('Use these notes in the next response');
	await expect(page.locator('.attachment-preview')).toContainText('next-response-notes.txt');
	await page.screenshot({ path: '/tmp/freelm-chat-next-response-controls.png' });
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	await expect
		.poll(() =>
			page.evaluate(() => (window as any).__lifecycle.requests.filter((r: any) => r.stream).length),
		)
		.toBe(3);
	const next = await page.evaluate(
		() => (window as any).__lifecycle.requests.filter((r: any) => r.stream).at(-1).body,
	);
	expect(next.model).toBe('next-response-fixture');
	expect(next.reasoning.effort).toBe('high');
	expect(JSON.stringify(next)).toContain('These notes belong only to the next request.');
	await expect(composer.locator('.cm-placeholder')).toHaveText('Ask anything');
	await expect(page.locator('.attachment-preview')).toHaveCount(0);
	await finish(page, 'Use these notes in the next response', 'I used the new model and notes.');
	await expect
		.poll(() =>
			page.evaluate(() =>
				(window as any).__lifecycle
					.state()
					.threads.find((thread: Thread) => thread.id === 'alpha')
					.messages.filter((message: any) => message.role === 'assistant')
					.map((message: any) => ({ model: message.model, thinkingMode: message.thinkingMode })),
			),
		)
		.toEqual([
			{ model: 'lifecycle-fixture', thinkingMode: 'low' },
			{ model: 'next-response-fixture', thinkingMode: 'high' },
		]);
});

test('two chats stream independently, stopping one preserves the other and both save', async ({
	page,
}) => {
	await fixture(page);
	await page.evaluate(() => {
		(window as any).__lifecycle.holdSaves = true;
	});
	const composer = page.getByLabel('Message', { exact: true });
	await page.getByRole('button', { name: 'Alpha', exact: true }).click();
	await composer.fill('Alpha concurrent request');
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => (window as any).__lifecycle.pending().length))
		.toBe(1);
	await page.getByRole('button', { name: 'Beta', exact: true }).click();
	await composer.fill('Beta concurrent request');
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => (window as any).__lifecycle.pending().length))
		.toBe(2);
	await expect(page.getByLabel('Responding', { exact: true })).toHaveCount(2);
	await page.evaluate(() => {
		(window as any).__lifecycle.delta('Alpha concurrent request', 'Alpha ');
		(window as any).__lifecycle.delta('Beta concurrent request', 'Beta partial reply');
	});
	await expect(page.getByText('Beta partial reply', { exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Responding Alpha', exact: true }).click();
	await expect(page.locator('.message.assistant')).toContainText('Alpha');
	await expect(page.getByText('Beta partial reply', { exact: true })).toHaveCount(0);
	await page.getByRole('button', { name: 'Responding Beta', exact: true }).click();
	await page.getByRole('button', { name: 'Stop response', exact: true }).click();
	await expect.poll(() => page.evaluate(() => (window as any).__lifecycle.canceled.length)).toBe(1);
	await expect(page.getByLabel('Responding', { exact: true })).toHaveCount(1);
	await finish(page, 'Alpha concurrent request', 'Alpha completed independently');
	await expect(page.getByLabel('Responding', { exact: true })).toHaveCount(0);
	await page.evaluate(() => (window as any).__lifecycle.releaseSaves());
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					(window as any).__lifecycle
						.state()
						.threads.find((thread: Thread) => thread.id === 'alpha')
						.messages.at(-1).content,
			),
		)
		.toBe('Alpha completed independently');
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					(window as any).__lifecycle
						.state()
						.threads.find((thread: Thread) => thread.id === 'beta')
						.messages.at(-1).interrupted,
			),
		)
		.toBe(true);
	await page.getByRole('button', { name: 'Alpha', exact: true }).click();
	await expect(page.getByText('Alpha completed independently', { exact: true })).toBeVisible();
	await expect
		.poll(() => page.evaluate(() => (window as any).__lifecycle.notifications.length))
		.toBe(1);
	await page.screenshot({ path: '/tmp/freelm-chat-lifecycle.png' });
	await page.reload();
	await page.getByRole('button', { name: 'Alpha', exact: true }).click();
	await expect(page.getByText('Alpha completed independently', { exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Beta', exact: true }).click();
	await expect(page.getByText('Beta partial reply', { exact: true })).toBeVisible();
});

test('archive removes a conversation from history and Settings restores its messages', async ({
	page,
}) => {
	await fixture(page);
	await page.getByRole('button', { name: 'Alpha', exact: true }).click();
	await page.getByLabel('Message', { exact: true }).fill('Archived question');
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => (window as any).__lifecycle.pending().length))
		.toBe(1);
	await finish(page, 'Archived question', 'Archived answer');
	await expect(page.getByText('Archived answer', { exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Actions for Alpha', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Archive chat', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Alpha', exact: true })).toHaveCount(0);
	await page.getByRole('button', { name: 'Personal workspace settings', exact: true }).click();
	await page.getByRole('button', { name: 'Archived chats', exact: true }).click();
	await expect(
		page.locator('.settings-section-content:not([hidden])').getByText('Alpha', { exact: true }),
	).toBeVisible();
	await page.getByRole('button', { name: 'Restore', exact: true }).click();
	await expect(page.getByText('No archived conversations.', { exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Back to workspace', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Alpha', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Alpha', exact: true }).click();
	await expect(page.getByText('Archived question', { exact: true })).toBeVisible();
	await expect(page.getByText('Archived answer', { exact: true })).toBeVisible();
	await page.screenshot({ path: '/tmp/freelm-chat-archive-restored.png' });
});

test('temporary Chat can use configured tools without persistence and does not leak into Code', async ({
	page,
}) => {
	await fixture(page, true);
	await page.getByRole('button', { name: 'Temporary chat', exact: true }).click();
	const composer = page.getByLabel('Message', { exact: true });
	await composer.fill('Private temporary prompt');
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	await expect.poll(() => page.evaluate(() => (window as any).__lifecycle.catalogs.length)).toBe(1);
	expect(await page.evaluate(() => (window as any).__lifecycle.catalogs[0][3])).toBe(true);
	await expect
		.poll(() => page.evaluate(() => (window as any).__lifecycle.pending().length))
		.toBe(1);
	await page.evaluate(() => (window as any).__lifecycle.search('Private temporary prompt'));
	await expect
		.poll(() => page.evaluate(() => (window as any).__lifecycle.toolCalls.length))
		.toBe(1);
	await expect
		.poll(() => page.evaluate(() => (window as any).__lifecycle.pending().length))
		.toBe(1);
	await finish(page, 'Private temporary prompt', 'Temporary answer');
	await expect(page.getByText('Temporary answer', { exact: true })).toBeVisible();
	await expect
		.poll(() =>
			page.evaluate(() =>
				JSON.stringify((window as any).__lifecycle.state()).includes('Private temporary prompt'),
			),
		)
		.toBe(false);
	await composer.fill('Private unsent draft');
	await page.getByRole('button', { name: 'New chat', exact: true }).click();
	await expect
		.poll(() =>
			page.evaluate(() =>
				JSON.stringify((window as any).__lifecycle.state()).includes('Private unsent draft'),
			),
		)
		.toBe(false);
	await selectConversationMode(page, 'Code');
	await expect(page.locator('.chat-workspace')).toHaveAttribute('data-conversation-kind', 'code');
	await page.getByLabel('Message', { exact: true }).fill('Normal Code draft');
	await expect
		.poll(() =>
			page.evaluate(() =>
				Object.entries((window as any).__lifecycle.state().chatDrafts ?? {}).some(
					([key, value]: any) =>
						key.startsWith('new:code:') && value.content === 'Normal Code draft',
				),
			),
		)
		.toBe(true);
});

test('Chat notification setting suppresses completion notifications and survives reload', async ({
	page,
}) => {
	await fixture(page);
	await page.getByRole('button', { name: 'Personal workspace settings', exact: true }).click();
	await page
		.getByRole('navigation', { name: 'Settings options', exact: true })
		.getByRole('button', { name: 'Chat', exact: true })
		.click();
	const notifications = page.getByRole('switch', { name: 'Background notifications', exact: true });
	await expect(notifications).toHaveAttribute('aria-checked', 'true');
	await notifications.click();
	await page.getByRole('button', { name: 'Save settings', exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => (window as any).__lifecycle.state().backgroundNotifications))
		.toBe(false);
	await page.getByRole('button', { name: 'Back to workspace', exact: true }).click();
	await page.getByRole('button', { name: 'Alpha', exact: true }).click();
	await page.getByLabel('Message', { exact: true }).fill('Muted completion request');
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => (window as any).__lifecycle.pending().length))
		.toBe(1);
	await finish(page, 'Muted completion request', 'Muted completed reply');
	await expect(page.getByText('Muted completed reply', { exact: true })).toBeVisible();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					(window as any).__lifecycle
						.state()
						.threads.find((thread: Thread) => thread.id === 'alpha')
						.messages.at(-1).completedAt,
			),
		)
		.toBeGreaterThan(0);
	expect(await page.evaluate(() => (window as any).__lifecycle.notifications)).toEqual([]);
	await page.reload();
	await page.getByRole('button', { name: 'Personal workspace settings', exact: true }).click();
	await page
		.getByRole('navigation', { name: 'Settings options', exact: true })
		.getByRole('button', { name: 'Chat', exact: true })
		.click();
	await expect(notifications).toHaveAttribute('aria-checked', 'false');
	await page.screenshot({ path: '/tmp/freelm-chat-notifications-disabled.png' });
});

test('closing immediately after typing flushes the draft before confirming close', async ({
	page,
}) => {
	await fixture(page);
	await page.getByRole('button', { name: 'Alpha', exact: true }).click();
	const composer = page.getByLabel('Message', { exact: true });
	await composer.fill('Draft with the very last keystrokes');
	await page.evaluate(() => (window as any).__lifecycle.prepareClose());
	expect(await page.evaluate(() => (window as any).__lifecycle.closed)).toBe(1);
	expect(
		await page.evaluate(() => (window as any).__lifecycle.state().chatDrafts.alpha.content),
	).toBe('Draft with the very last keystrokes');
	await page.reload();
	await page.getByRole('button', { name: 'Alpha', exact: true }).click();
	await expect(composer).toHaveText('Draft with the very last keystrokes');
});

test('saved workspace opens while secure storage metadata never resolves', async ({ page }) => {
	await fixture(page, false, { storageInfoStalls: true });
	expect(await page.evaluate(() => (window as any).__lifecycle.storageInfoPending)).toBe(true);
	await expect(page.getByRole('status', { name: 'Loading workspace', exact: true })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Beta', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Alpha', exact: true }).click();
	await page.getByLabel('Message', { exact: true }).fill('Draft despite stalled Keychain metadata');
	await expect
		.poll(() => page.evaluate(() => (window as any).__lifecycle.state().chatDrafts?.alpha?.content))
		.toBe('Draft despite stalled Keychain metadata');
	expect(await page.evaluate(() => (window as any).__lifecycle.storageInfoPending)).toBe(true);
	await page.screenshot({ path: '/tmp/freelm-chat-storage-metadata-stalled.png' });
});

test('workspace splash stays available during loading, respects motion preferences, and opens the workspace', async ({
	page,
}) => {
	// Browser plugin not available. Exercise the real app through its isolated desktop bridge.
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	await fixture(page, false, { workspaceLoadStalls: true });
	const splash = page.getByRole('status', { name: 'Loading workspace', exact: true });
	await expect(splash).toBeVisible();
	await expect(page.getByLabel('Message', { exact: true })).toHaveCount(0);
	const logo = splash.locator('.drawing-logo');
	const layers = logo.locator('.drawing-logo-part use');
	await expect(layers).toHaveCount(3);
	// <use> resolves the canonical SVG definitions even though their source is
	// visually hidden. Catch missing geometry without a real profile.
	expect(
		await layers.evaluateAll((parts) =>
			parts.every((part) => {
				const bounds = (part as SVGGraphicsElement).getBBox();
				const source = document.getElementById(part.getAttribute('href')!.slice(1));
				return source && bounds.width > 0 && bounds.height > 0;
			}),
		),
	).toBe(true);
	const ink = logo.locator('.drawing-logo-ink');
	const drawing = logo.locator('.drawing-logo-art');
	await expect(ink).toHaveCount(2);
	for (const path of await ink.all()) await expect(path).not.toHaveCSS('animation-name', 'none');
	const phase = async (milliseconds: number) => {
		await logo.evaluate((element, time) => {
			for (const animation of element.getAnimations({ subtree: true })) {
				animation.pause();
				animation.currentTime = time;
			}
		}, milliseconds);
		return ink.evaluateAll((paths) =>
			paths.map((path) => Number.parseFloat(getComputedStyle(path).strokeDashoffset)),
		);
	};
	expect(await phase(0)).toEqual([1, 1]);
	const stem = await phase(500);
	expect(stem[0]).toBeLessThan(1);
	expect(stem[0]).toBeGreaterThan(0);
	expect(stem[1]).toBe(1);
	await page.screenshot({ path: '/tmp/freelm-workspace-splash-drawing-stem.png' });
	const top = await phase(1_200);
	// The same mask continues from the stem through the top ribbon without
	// a second animation starting or a pause between those surfaces.
	expect(top[0]).toBeLessThan(stem[0]);
	expect(top[0]).toBeGreaterThan(0);
	// Start the middle ribbon while the first stroke is still drawing.
	expect(top[1]).toBeLessThan(1);
	expect(top[1]).toBeGreaterThan(0);
	await page.screenshot({ path: '/tmp/freelm-workspace-splash-drawing-top.png' });
	const middle = await phase(1_650);
	expect(middle).toEqual([0, 0]);
	await page.screenshot({ path: '/tmp/freelm-workspace-splash-drawing-middle.png' });
	expect(await phase(2_600)).toEqual([0, 0]);
	await expect(drawing).toHaveCSS('opacity', '1');
	await expect(drawing).toHaveCSS('transform', 'none');
	await expect(splash).toHaveCSS('background-color', 'rgb(33, 33, 33)');
	await page.screenshot({ path: '/tmp/freelm-workspace-splash-dark.png' });

	// The hydrated workspace selects its theme. Verify the same pending screen also
	// honors the light theme tokens, without waiting for a real disk-backed profile.
	await page.evaluate(() => {
		document.documentElement.dataset.theme = 'light';
	});
	await expect(splash).toHaveCSS('background-color', 'rgb(255, 255, 255)');
	await page.screenshot({ path: '/tmp/freelm-workspace-splash-light.png' });
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await expect(drawing).toHaveCSS('animation-name', 'none');
	await expect(drawing).toHaveCSS('opacity', '1');
	for (const path of await ink.all()) {
		await expect(path).toHaveCSS('animation-name', 'none');
		expect(
			await path.evaluate((element) =>
				Number.parseFloat(getComputedStyle(element).strokeDashoffset),
			),
		).toBe(0);
	}
	await page.setViewportSize({ width: 390, height: 844 });
	const bounds = await logo.boundingBox();
	expect(bounds).not.toBeNull();
	expect(bounds!.x).toBeGreaterThanOrEqual(0);
	expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
	expect(bounds!.y).toBeGreaterThanOrEqual(0);
	expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
	await page.screenshot({ path: '/tmp/freelm-workspace-splash-reduced-motion-narrow.png' });

	await page.setViewportSize({ width: 1440, height: 940 });
	await page.evaluate(() => (window as any).__lifecycle.releaseLoad());
	await expect(splash).toHaveCount(0);
	await expect(page.getByLabel('Message', { exact: true })).toBeVisible({ timeout: 30_000 });
	await page.getByRole('button', { name: 'Alpha', exact: true }).click();
	await page.getByLabel('Message', { exact: true }).fill('Ready after the logo splash');
	await expect
		.poll(() => page.evaluate(() => (window as any).__lifecycle.state().chatDrafts?.alpha?.content))
		.toBe('Ready after the logo splash');
	await expect(page.locator('vite-error-overlay')).toHaveCount(0);
});

test('workspace loading failure replaces the splash with recovery controls', async ({ page }) => {
	await fixture(page, false, { workspaceLoadStalls: true });
	const splash = page.getByRole('status', { name: 'Loading workspace', exact: true });
	await expect(splash).toBeVisible();
	await page.evaluate(() => (window as any).__lifecycle.rejectLoad());
	await expect(splash).toHaveCount(0);
	await expect(page.getByRole('heading', { name: 'Workspace unavailable' })).toBeVisible();
	await expect(
		page.getByText('Could not open your workspace: Fixture workspace unavailable'),
	).toBeVisible();
	await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
	await expect(page.getByLabel('Message', { exact: true })).toHaveCount(0);
	await page.screenshot({ path: '/tmp/freelm-workspace-splash-failure.png' });
});
