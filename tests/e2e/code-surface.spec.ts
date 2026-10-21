import { expect, test, type Page } from '@playwright/test';
import { initialState } from '../../src/lib/state';
import { defaultToolSettings } from '../../src/lib/tool-settings';
import type { CodeSurfaceRequest, CodeSurfaceResult } from '../../src/code-surface-types';
import type {
	CodeBrowserRequest,
	CodeBrowserState,
	CodeBrowserSelection,
} from '../../src/code-browser-types';
import { selectConversationMode } from './helpers/conversation-mode';
import { chooseOption, openRemoteSettings } from './ui-controls';

// Browser plugin unavailable. Exercise the real App with a private in-memory
// host adapter; no filesystem writes, network requests, or model execution.
test.setTimeout(120_000);
const root = '/tmp/code-surface-fixture';
const remoteRoot = '/srv/code-surface-fixture';
const linkedPage = 'https://example.invalid/agent-link?mode=preview#details';
const markdown = '# Workspace notes\n\nA **rendered** Markdown document.\n';
const source = Array.from({ length: 45 }, (_, i) => `export const line${i + 1} = ${i + 1};`).join(
	'\n',
);
const png =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

function savedState(directory = root, theme: 'light' | 'dark' = 'dark') {
	const state = initialState();
	state.theme = theme;
	state.backgroundNotifications = false;
	state.memorySettings = { savedMemories: false, referenceHistory: false };
	state.toolSettings = { ...defaultToolSettings(), enabled: false };
	state.connections[0].models.chat = 'surface-model';
	state.connections[0].catalog = [
		{
			id: 'surface-model',
			name: 'Surface model',
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
			id: 'surface-project',
			kind: 'code',
			name: 'Surface project',
			instructions: '',
			directories: [directory],
			createdAt: 1,
		},
	];
	state.projects.push({ ...state.projects[0], id: 'separate-project', name: 'Separate project' });
	state.threads = ['Surface task', 'Separate task', 'Regular Chat'].map((title, index) => ({
		id: `surface-thread-${index}`,
		kind: index === 2 ? 'chat' : 'code',
		title,
		titleSource: 'manual',
		connectionId: state.activeConnectionId,
		model: 'surface-model',
		thinkingMode: 'low',
		...(index === 2 ? {} : { projectId: index === 1 ? 'separate-project' : 'surface-project' }),
		createdAt: 1,
		updatedAt: 2,
		messages: [
			{ id: `user-${index}`, role: 'user', content: 'Review the workspace.', createdAt: 1 },
			{
				id: `answer-${index}`,
				role: 'assistant',
				createdAt: 2,
				completedAt: 3,
				content: `Read [app.ts line 32](${directory}/src/app.ts:32) and [Workspace notes](${directory}/README.md). Open the [Agent preview](${linkedPage}), or visit ${linkedPage}.`,
				...(index === 0
					? {
							toolCalls: [
								{
									id: 'surface-edit',
									name: 'apply_patch',
									status: 'completed' as const,
									startedAt: 2,
									completedAt: 3,
									arguments: JSON.stringify({
										patch:
											'*** Begin Patch\n*** Update File: src/app.ts\n@@\n-export const old = true;\n+export const ready = true;\n*** End Patch',
									}),
									result: { content: [] },
								},
								{
									id: 'surface-search',
									name: 'web_search',
									status: 'completed' as const,
									startedAt: 2,
									completedAt: 3,
									arguments: JSON.stringify({ query: 'agent preview' }),
									result: {
										content: [],
										research: {
											sources: [
												{
													id: 'surface-web-source',
													title: 'Preview documentation',
													url: linkedPage,
												},
											],
										},
									},
								},
							],
						}
					: {}),
			},
			{
				id: `math-answer-${index}`,
				role: 'assistant',
				createdAt: 4,
				completedAt: 5,
				content: `For $x^2$, open the [Math preview](${linkedPage}).`,
			},
		],
	}));
	return state;
}

async function fixture(page: Page, theme: 'light' | 'dark' = 'dark') {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (event) => {
		if (event.type() === 'error') errors.push(event.text());
	});
	await page.addInitScript(
		({ local, remote, root, remoteRoot, source, markdown, png }) => {
			let revision = 0;
			const states: Record<string, any> = { local: JSON.parse(local), remote: JSON.parse(remote) };
			const requests: CodeSurfaceRequest[] = [];
			const browserRequests: CodeBrowserRequest[] = [];
			const browsers = new Map<string, CodeBrowserState>();
			const stateListeners = new Set<(state: CodeBrowserState) => void>();
			const selectionListeners = new Set<(selection: CodeBrowserSelection) => void>();
			const fileContents = new Map<string, string>();
			for (const directory of [root, remoteRoot]) {
				fileContents.set(`${directory}/README.md`, markdown);
				fileContents.set(`${directory}/src/app.ts`, source);
			}
			const control: any = {
				states,
				requests,
				browserRequests,
				browsers,
				fileContents,
				conflict: false,
				network: [],
				selectElement() {
					const active = [...browsers.values()].find((browser) => browser.inspecting);
					if (!active) throw new Error('No inspected browser');
					const selection = {
						tabId: active.tabId,
						scope: active.scope,
						element: {
							tag: 'button',
							text: 'Save draft',
							selector: '#save-draft',
							url: active.url,
							rect: { x: 30, y: 40, width: 120, height: 40 },
						},
					};
					for (const listener of selectionListeners) listener(selection);
				},
			};
			(window as any).__codeSurface = control;
			const snapshot = (id: string) => ({
				state: structuredClone(states[id]),
				revision: String(revision),
				moderationSupported: true,
				personalizationSupported: true,
				codeCompactionSupported: true,
				composerContextSupported: true,
				codeSurfaceSupported: true,
				memorySupported: true,
			});
			(window as any).desktop = {
				platform: 'linux',
				workspaceLoad: async (id: string) => snapshot(id),
				workspaceSave: async (id: string, _revision: string, state: unknown) => {
					states[id] = structuredClone(state);
					return { revision: String(++revision) };
				},
				storageInfo: async () => ({ secure: false, location: '/tmp/synthetic-profile' }),
				onPrepareClose: () => () => {},
				completeClose: async () => {},
				onToolApproval: () => () => {},
				onChunk: () => () => {},
				cancel: async () => {},
				instanceStatus: async () => ({
					host: { running: false, name: 'This computer', instanceId: 'local', port: 4319 },
					instances: [
						{
							id: 'remote',
							name: 'Remote fixture',
							transport: 'direct',
							url: 'http://remote.invalid:4319',
							connected: true,
							hasToken: true,
						},
					],
				}),
				instanceOpen: async (id: string) => snapshot(id),
				composerDiscover: async (request: any) => {
					control.discoveryRequests ||= [];
					control.discoveryRequests.push(structuredClone(request));
					const directory = request.workspaceId === 'remote' ? remoteRoot : root;
					return {
						items: [...fileContents.keys()]
							.filter(
								(path) =>
									path.startsWith(directory + '/') &&
									path.toLowerCase().includes(request.query.toLowerCase()),
							)
							.map((path) => ({
								kind: 'file',
								id: path,
								path,
								label: path.split('/').at(-1)!,
								description: path.slice(directory.length + 1),
							})),
					};
				},
				codeSurface: async (request: CodeSurfaceRequest): Promise<CodeSurfaceResult> => {
					requests.push(structuredClone(request));
					const directory = request.workspaceId === 'remote' ? remoteRoot : root;
					const path = request.path || directory;
					if (path !== directory && !path.startsWith(`${directory}/`))
						throw new Error('Path is outside this task workspace.');
					if (request.action === 'list')
						return {
							kind: 'list',
							roots: [{ path: directory, name: 'Surface project' }],
							path,
							entries: !request.path
								? [{ name: 'Surface project', path: directory, kind: 'directory' }]
								: path.endsWith('/src')
									? [{ name: 'app.ts', path: `${directory}/src/app.ts`, kind: 'file' }]
									: [
											{ name: 'src', path: `${directory}/src`, kind: 'directory' },
											{ name: 'README.md', path: `${directory}/README.md`, kind: 'file' },
										],
							truncated: false,
							notices: [],
						};
					if (request.action === 'write') {
						if (control.conflict)
							throw new Error('This file changed on disk. Reload it before saving.');
						fileContents.set(path, request.content || '');
						return {
							kind: 'saved',
							path,
							revision: 'saved-revision',
							size: (request.content || '').length,
						};
					}
					if (request.action === 'diff')
						return {
							kind: 'diff',
							path,
							review: request.review || 'uncommitted',
							diff: 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-export const old = true;\n+export const ready = true;\n',
							truncated: false,
							notices: [],
						};
					const content = fileContents.get(path);
					if (content === undefined) throw new Error('File not found.');
					return {
						kind: 'file',
						path,
						name: path.split('/').at(-1)!,
						size: content.length,
						revision: 'initial-revision',
						content,
						editable: true,
						truncated: false,
					};
				},
				codeBrowser: async (request: CodeBrowserRequest) => {
					browserRequests.push(structuredClone(request));
					if (request.action === 'open')
						browsers.set(request.tabId, {
							tabId: request.tabId,
							scope: request.scope,
							url: request.url || 'about:blank',
							title: 'Fixture page',
							loading: false,
							canGoBack: false,
							canGoForward: false,
							visible: false,
							inspecting: false,
						});
					if (request.action === 'hide' && !request.tabId) {
						for (const browser of browsers.values()) browser.visible = false;
						return {};
					}
					const browser = browsers.get(request.tabId!);
					if (!browser) return {};
					if (request.action === 'navigate') {
						browser.url = request.url;
						browser.canGoBack = true;
					}
					if (request.action === 'show') browser.visible = true;
					if (request.action === 'hide') browser.visible = false;
					if (request.action === 'inspect')
						browser.inspecting = request.enabled ?? !browser.inspecting;
					if (request.action === 'close') browsers.delete(request.tabId);
					for (const listener of stateListeners) listener(structuredClone(browser));
					return {
						state: structuredClone(browser),
						...(request.action === 'capture'
							? {
									screenshot: {
										dataUrl: png,
										width: 1,
										height: 1,
										url: browser.url,
										title: browser.title,
									},
								}
							: {}),
					};
				},
				onCodeBrowserState: (listener: (state: CodeBrowserState) => void) => {
					stateListeners.add(listener);
					return () => stateListeners.delete(listener);
				},
				onCodeBrowserElement: (listener: (selection: CodeBrowserSelection) => void) => {
					selectionListeners.add(listener);
					return () => selectionListeners.delete(listener);
				},
			};
		},
		{
			local: JSON.stringify(savedState(root, theme)),
			remote: JSON.stringify(savedState(remoteRoot, theme)),
			root,
			remoteRoot,
			source,
			markdown,
			png,
		},
	);
	await page.goto('/');
	await expect(page).toHaveTitle('FreeLM');
	await selectConversationMode(page, 'Code');
	await page.locator('.thread-select[title="Surface task"]').click();
	await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
	return errors;
}

const panel = (page: Page) =>
	page.getByRole('region', { name: 'Code workspace tabs', exact: true });
const summary = (page: Page) =>
	page.getByRole('complementary', { name: 'Pinned summary', exact: true });

async function openPanel(page: Page) {
	await page.getByRole('button', { name: 'Show workspace tabs', exact: true }).click();
	await expect(panel(page)).toBeVisible();
}

test('workspace panel restores the summary preference and keeps the Code draft editable', async ({
	page,
}) => {
	const errors = await fixture(page);
	const composer = page.getByRole('textbox', { name: 'Message', exact: true });
	await composer.fill('Keep this draft while reviewing the workspace.');
	await expect(summary(page)).toBeVisible();
	await openPanel(page);
	await expect(summary(page)).toHaveCount(0);
	await expect(composer).toHaveText('Keep this draft while reviewing the workspace.');
	await page.getByRole('button', { name: 'Hide workspace tabs', exact: true }).click();
	await expect(panel(page)).not.toBeVisible();
	await expect(summary(page)).toBeVisible();

	await page.getByRole('button', { name: 'Hide pinned summary', exact: true }).click();
	await openPanel(page);
	await page.getByRole('button', { name: 'Hide workspace tabs', exact: true }).click();
	await expect(summary(page)).toHaveCount(0);
	await openPanel(page);
	await page.getByRole('button', { name: 'Show pinned summary', exact: true }).click();
	await expect(summary(page)).toBeVisible();
	await page.getByRole('button', { name: 'Hide workspace tabs', exact: true }).click();
	await expect(summary(page)).toBeVisible();

	await selectConversationMode(page, 'Chat');
	await page.locator('.thread-select[title="Regular Chat"]').click();
	await expect(page.getByRole('button', { name: 'Show workspace tabs', exact: true })).toHaveCount(
		0,
	);
	await selectConversationMode(page, 'Code');
	await page.locator('.thread-select[title="Surface task"]').click();
	await expect(composer).toHaveText('Keep this draft while reviewing the workspace.');
	expect(errors).toEqual([]);
});

test('workspace panel resizes and expands without moving its global toggle', async ({ page }) => {
	const errors = await fixture(page);
	await openPanel(page);
	const toggle = page.getByRole('button', { name: 'Hide workspace tabs', exact: true });
	const originalToggle = await toggle.boundingBox();
	const separator = page.getByRole('separator', { name: 'Resize workspace tabs', exact: true });
	const originalWidth = (await panel(page).boundingBox())!.width;
	const handle = (await separator.boundingBox())!;
	await page.mouse.move(handle.x + handle.width / 2, handle.y + 160);
	await page.mouse.down();
	await page.mouse.move(handle.x - 100, handle.y + 160, { steps: 8 });
	await page.mouse.up();
	await expect
		.poll(async () => (await panel(page).boundingBox())!.width)
		.toBeGreaterThan(originalWidth + 40);
	await page.getByRole('button', { name: 'Expand workspace tabs', exact: true }).click();
	await expect
		.poll(async () => (await panel(page).boundingBox())!.width)
		.toBeGreaterThan(originalWidth + 200);
	expect(Math.abs((await toggle.boundingBox())!.x - originalToggle!.x)).toBeLessThan(2);
	await page.screenshot({ path: '/tmp/freelm-code-surface-expanded.png' });
	await page.getByRole('button', { name: 'Hide workspace tabs', exact: true }).click();
	await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
	expect(errors).toEqual([]);
});

test('Code composer fits its actual pane across split widths, window sizes, and zoom', async ({
	page,
}) => {
	test.setTimeout(180_000);
	await page.setViewportSize({ width: 1800, height: 1000 });
	const errors = await fixture(page);
	await openPanel(page);
	await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Keep this draft.');
	const separator = page.getByRole('separator', { name: 'Resize workspace tabs', exact: true });
	await expect(separator).toHaveAttribute('aria-valuenow', '55');

	async function expectFitted(label: string) {
		await expect(page.locator('.composer .send-button')).toBeVisible();
		await expect(page.locator('.composer .code-permission-trigger')).toBeVisible();
		await expect(page.locator('.composer .composer-model-trigger')).toBeVisible();
		await expect
			.poll(
				() =>
					page.evaluate(() => {
						const chat = document.querySelector('.chat-workspace')!.getBoundingClientRect();
						const composer = document.querySelector('.composer')!.getBoundingClientRect();
						const toolbar = document.querySelector('.adaptive-composer-toolbar')!;
						const problems: string[] = [];
						if (composer.left < chat.left - 1 || composer.right > chat.right + 1)
							problems.push(
								`Composer ${composer.left}–${composer.right} outside chat ${chat.left}–${chat.right}`,
							);
						for (const button of toolbar.querySelectorAll('button')) {
							const bounds = button.getBoundingClientRect();
							if (!bounds.width || !bounds.height) continue;
							if (bounds.left < composer.left - 1 || bounds.right > composer.right + 1)
								problems.push(
									`Toolbar control outside composer: ${button.getAttribute('aria-label') || button.textContent}`,
								);
						}
						const tools = toolbar.querySelector('.composer-tools')!.getBoundingClientRect();
						const actions = toolbar.querySelector('.composer-actions')!.getBoundingClientRect();
						if (tools.right > actions.left + 1) problems.push('Toolbar groups overlap');
						return problems;
					}),
				{ message: label },
			)
			.toEqual([]);
	}

	// Keep the production composer width: forcing a narrow element would miss
	// viewport media rules that let it overflow its parent when tabs are open.
	await expectFitted('1800px window, default 55% workspace panel');
	const layout = (await page.locator('.conversation-layout').boundingBox())!;
	const handle = (await separator.boundingBox())!;
	await page.mouse.move(handle.x + handle.width / 2, handle.y + 80);
	await page.mouse.down();
	await page.mouse.move(layout.x + layout.width * 0.3, handle.y + 80, { steps: 6 });
	await page.mouse.up();
	await expect(separator).toHaveAttribute('aria-valuenow', '70');
	await expectFitted('1800px window, 70% workspace panel');
	await page.setViewportSize({ width: 1440, height: 1000 });
	await expectFitted('1440px window, 70% workspace panel');
	await page.setViewportSize({ width: 820, height: 1000 });
	await expect(separator).not.toBeVisible();
	await expectFitted('820px minimum window, stacked workspace panel');
	await page.setViewportSize({ width: 1800, height: 1000 });
	await page.evaluate(() => {
		document.body.style.zoom = '1.25';
	});
	await expectFitted('1800px window, 70% workspace panel, 125% zoom');
	await page.locator('.composer').scrollIntoViewIfNeeded();
	await page.screenshot({ path: '/tmp/freelm-composer-split-width-zoom.png' });
	expect(errors).toEqual([]);
});

test('workspace files use Markdown preview, searchable highlighted source, and file line links', async ({
	page,
}) => {
	const errors = await fixture(page);
	await openPanel(page);
	const files = panel(page).getByRole('region', { name: 'Workspace files', exact: true });
	await expect(files.getByRole('button', { name: 'README.md', exact: true })).toBeVisible();
	await files.getByRole('textbox', { name: 'Find files', exact: true }).fill('README');
	await expect(files.getByRole('button', { name: 'src', exact: true })).toHaveCount(0);
	await files.getByRole('button', { name: 'README.md', exact: true }).click();
	await expect(panel(page).getByRole('heading', { name: 'Workspace notes' })).toBeVisible();
	await panel(page).getByRole('button', { name: 'Source', exact: true }).click();
	const markdownSource = panel(page).locator('[aria-label="Source of README.md"]');
	await expect(markdownSource).toContainText('# Workspace notes');
	await expect(markdownSource).toHaveAttribute('contenteditable', 'false');
	await panel(page).getByRole('button', { name: 'Find in file', exact: true }).click();
	await panel(page).getByRole('textbox', { name: 'Find in file', exact: true }).fill('rendered');
	await expect(panel(page).locator('[role="tabpanel"]:visible .cm-activeLine')).toContainText(
		'rendered',
	);
	await panel(page).getByRole('button', { name: 'Close file search', exact: true }).click();
	await panel(page).getByRole('button', { name: 'Preview', exact: true }).click();
	await expect(panel(page).getByRole('heading', { name: 'Workspace notes' })).toBeVisible();

	await page.getByRole('link', { name: 'app.ts line 32', exact: true }).click();
	await expect(panel(page).locator('[aria-label="Source of app.ts"]')).toBeVisible();
	// CodeMirror may defer parsing outside its initial viewport. Verify the
	// keyword's actual color; the native smoke checks the full token palette.
	await expect(
		panel(page).locator('[aria-label="Source of app.ts"] .cm-line span').first(),
	).toHaveCSS('color', 'rgb(184, 116, 217)');
	await expect(panel(page).locator('[role="tabpanel"]:visible .cm-activeLine')).toHaveText(
		'export const line32 = 32;',
	);
	await panel(page).getByRole('button', { name: 'Toggle file explorer', exact: true }).click();
	await expect(files).toBeVisible();
	await files.getByRole('button', { name: 'src', exact: true }).click();
	await expect(files.getByRole('button', { name: 'app.ts', exact: true })).toBeVisible();
	const requests = await page.evaluate(() => (window as any).__codeSurface.requests);
	expect(requests).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				action: 'read',
				workspaceId: 'local',
				threadId: 'surface-thread-0',
				path: `${root}/README.md`,
			}),
			expect.objectContaining({
				action: 'read',
				workspaceId: 'local',
				threadId: 'surface-thread-0',
				path: `${root}/src/app.ts`,
			}),
		]),
	);
	expect(requests.some((request: CodeSurfaceRequest) => request.action === 'write')).toBe(false);
	await page.screenshot({ path: '/tmp/freelm-code-surface-files.png' });
	expect(errors).toEqual([]);
});

test('workspace tabs and file requests stay scoped to their project and remote host', async ({
	page,
}) => {
	// This scenario crosses several complete host/mode layouts; keep a bounded
	// total budget without loosening the individual UI assertions.
	test.setTimeout(180_000);
	const errors = await fixture(page);
	await page.getByRole('link', { name: 'Workspace notes', exact: true }).click();
	await expect(panel(page).getByRole('heading', { name: 'Workspace notes' })).toBeVisible();
	await page.locator('.thread-select[title="Separate task"]').click();
	await expect(panel(page)).not.toBeVisible();
	await page.locator('.thread-select[title="Surface task"]').click();
	await expect(panel(page).getByRole('heading', { name: 'Workspace notes' })).toBeVisible();
	await openRemoteSettings(page);
	await page
		.getByRole('region', { name: 'Remote FreeLM workspaces' })
		.getByRole('button', { name: 'Open', exact: true })
		.click();
	await selectConversationMode(page, 'Code');
	await page.locator('.thread-select[title="Surface task"]').click();
	await expect(panel(page)).not.toBeVisible();
	await page.getByRole('link', { name: 'Workspace notes', exact: true }).click();
	await expect(panel(page).getByRole('heading', { name: 'Workspace notes' })).toBeVisible();
	const remoteReads = await page.evaluate(() =>
		(window as any).__codeSurface.requests.filter(
			(request: CodeSurfaceRequest) => request.workspaceId === 'remote',
		),
	);
	expect(remoteReads).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				action: 'read',
				workspaceId: 'remote',
				threadId: 'surface-thread-0',
				path: `${remoteRoot}/README.md`,
			}),
		]),
	);
	expect(
		remoteReads.every(
			(request: CodeSurfaceRequest) => !request.path || request.path.startsWith(remoteRoot),
		),
	).toBe(true);
	expect(errors).toEqual([]);
});

async function newTab(page: Page, kind: 'Browser' | 'Files' | 'Changes') {
	await panel(page).getByRole('button', { name: 'New workspace tab', exact: true }).click();
	await panel(page).getByRole('menuitem', { name: kind, exact: true }).click();
}

test('assistant web links open the Code browser and reuse it across Markdown renderers', async ({
	page,
}) => {
	const errors = await fixture(page);
	const popups: Page[] = [];
	page.on('popup', (popup) => popups.push(popup));
	// Stub any accidental external navigation; a regression must not make a real
	// network request while this test checks which UI surface owns the link.
	await page
		.context()
		.route('https://example.invalid/**', (route) =>
			route.fulfill({ contentType: 'text/html', body: '<title>External fixture</title>' }),
		);
	await page.getByRole('link', { name: 'Agent preview', exact: true }).click();
	await expect(panel(page)).toBeVisible();
	const address = panel(page).getByRole('textbox', { name: 'Browser address', exact: true });
	await expect(address).toHaveValue(linkedPage);
	await expect
		.poll(() =>
			page.evaluate(() =>
				(window as any).__codeSurface.browserRequests.filter(
					(request: CodeBrowserRequest) => request.action === 'open',
				),
			),
		)
		.toEqual([expect.objectContaining({ action: 'open', url: linkedPage })]);
	const browserId = await panel(page)
		.getByRole('tab', { selected: true })
		.getAttribute('aria-controls');
	const tabs = await panel(page).getByRole('tab').count();
	for (const linkName of [linkedPage, 'Math preview']) {
		await page.getByRole('link', { name: 'Workspace notes', exact: true }).click();
		await expect(panel(page).getByRole('heading', { name: 'Workspace notes' })).toBeVisible();
		await page.getByRole('link', { name: linkName, exact: true }).click();
		await expect(address).toHaveValue(linkedPage);
		await expect(panel(page).getByRole('tab', { selected: true })).toHaveAttribute(
			'aria-controls',
			browserId!,
		);
		await expect(panel(page).getByRole('tab')).toHaveCount(tabs + 1);
	}
	expect(popups).toEqual([]);
	expect(
		await page.evaluate(() =>
			(window as any).__codeSurface.browserRequests.filter(
				(request: CodeBrowserRequest) => request.action === 'open',
			),
		),
	).toHaveLength(1);
	expect(errors).toEqual([]);
});

test('research source links use the same Code browser from replies and the pinned summary', async ({
	page,
}) => {
	const errors = await fixture(page);
	const popups: Page[] = [];
	page.on('popup', (popup) => popups.push(popup));
	await page
		.context()
		.route('https://example.invalid/**', (route) =>
			route.fulfill({ contentType: 'text/html', body: '<title>External fixture</title>' }),
		);
	await summary(page).getByRole('link', { name: linkedPage, exact: true }).click();
	await expect(
		panel(page).getByRole('textbox', { name: 'Browser address', exact: true }),
	).toHaveValue(linkedPage);
	const browserId = await panel(page)
		.getByRole('tab', { selected: true })
		.getAttribute('aria-controls');
	await page.getByRole('link', { name: 'Workspace notes', exact: true }).click();
	await page.locator('.research-sources > summary').click();
	await page
		.getByRole('list', { name: 'Sources', exact: true })
		.getByRole('link', { name: linkedPage, exact: true })
		.click();
	await expect(panel(page).getByRole('tab', { selected: true })).toHaveAttribute(
		'aria-controls',
		browserId!,
	);
	await expect(
		panel(page).getByRole('textbox', { name: 'Browser address', exact: true }),
	).toHaveValue(linkedPage);
	expect(popups).toEqual([]);
	expect(errors).toEqual([]);
});

test('Chat keeps normal external links without creating Code workspace tabs', async ({ page }) => {
	const errors = await fixture(page);
	await selectConversationMode(page, 'Chat');
	await page.locator('.thread-select[title="Regular Chat"]').click();
	await page
		.context()
		.route('https://example.invalid/**', (route) =>
			route.fulfill({ contentType: 'text/html', body: '<title>External fixture</title>' }),
		);
	const popupReady = page.waitForEvent('popup');
	await page.getByRole('link', { name: 'Agent preview', exact: true }).click();
	const popup = await popupReady;
	await expect(popup).toHaveURL(linkedPage);
	await popup.close();
	await expect(panel(page)).toHaveCount(0);
	expect(await page.evaluate(() => (window as any).__codeSurface.browserRequests)).toEqual([]);
	expect(errors).toEqual([]);
});

test('browser annotations survive annotation mode and attach screenshot context to the unsent draft', async ({
	page,
}) => {
	// This scenario crosses several complete host/mode layouts; keep a bounded
	// total budget without loosening the individual UI assertions.
	test.setTimeout(180_000);
	const errors = await fixture(page);
	const composer = page.getByRole('textbox', { name: 'Message', exact: true });
	await composer.fill('Please review this control.');
	await openPanel(page);
	await newTab(page, 'Browser');
	await expect(
		panel(page).getByRole('heading', { name: 'Browse beside your task', exact: true }),
	).toBeVisible();
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
			),
	);
	expect(
		await page.evaluate(() =>
			(window as any).__codeSurface.browserRequests.filter(
				(request: CodeBrowserRequest) => request.action === 'show',
			),
		),
	).toEqual([]);
	const address = panel(page).getByRole('textbox', { name: 'Browser address', exact: true });
	await address.fill('https://example.invalid/fixture');
	await address.press('Enter');
	await expect
		.poll(() =>
			page.evaluate(() =>
				(window as any).__codeSurface.browserRequests.filter(
					(request: CodeBrowserRequest) => request.action === 'navigate',
				),
			),
		)
		.toEqual([
			expect.objectContaining({ action: 'navigate', url: 'https://example.invalid/fixture' }),
		]);
	await panel(page).getByRole('button', { name: 'Annotate page', exact: true }).click();
	await page.evaluate(() => (window as any).__codeSurface.selectElement());
	await panel(page)
		.getByRole('textbox', { name: 'Annotation comment', exact: true })
		.fill('Make this button easier to find.');
	await panel(page).getByRole('button', { name: 'Add comment', exact: true }).click();
	await expect(panel(page).getByText('1 annotation', { exact: true })).toBeVisible();
	await panel(page).getByRole('button', { name: 'Hide annotation markers', exact: true }).click();
	await expect(
		panel(page).getByRole('button', { name: 'Show annotation markers', exact: true }),
	).toBeVisible();
	await panel(page).getByRole('button', { name: 'Exit annotation mode', exact: true }).click();
	await expect(panel(page).getByText('1 annotation', { exact: true })).toBeVisible();
	await panel(page).getByRole('button', { name: 'Annotate', exact: true }).click();
	await panel(page).getByRole('button', { name: 'Add to message', exact: true }).click();
	await expect(composer).toContainText('Please review this control.');
	await expect(composer).toContainText('Make this button easier to find.');
	await expect(composer).not.toContainText('#save-draft');
	await expect(
		page.getByRole('button', { name: 'Remove Browser annotation context.txt', exact: true }),
	).toBeVisible();
	await expect
		.poll(() =>
			page.evaluate(() => {
				const drafts: any[] = Object.values(
					(window as any).__codeSurface.states.local.chatDrafts || {},
				);
				const context = drafts
					.flatMap((draft) => draft.attachments || [])
					.find((attachment) => attachment.name === 'Browser annotation context.txt');
				if (!context) return '';
				const [header, data] = context.dataUrl.split(',');
				return header.includes(';base64') ? atob(data) : decodeURIComponent(data);
			}),
		)
		.toContain('#save-draft');
	await expect(composer).toContainText('https://example.invalid/fixture');
	await expect(
		page.getByRole('button', { name: 'Remove browser-annotations.png', exact: true }),
	).toBeVisible();
	await expect(page.locator('.message.user')).toHaveCount(1);
	await expect(panel(page).getByText('1 annotation', { exact: true })).toHaveCount(0);
	await page.screenshot({ path: '/tmp/freelm-code-surface-annotation.png' });
	await selectConversationMode(page, 'Chat');
	await page.locator('.thread-select[title="Regular Chat"]').click();
	await selectConversationMode(page, 'Code');
	await page.locator('.thread-select[title="Surface task"]').click();
	await expect(composer).toContainText('Make this button easier to find.');
	expect((await composer.innerText()).split('Make this button easier to find.')).toHaveLength(2);
	await expect(
		page.getByRole('button', { name: 'Remove browser-annotations.png', exact: true }),
	).toHaveCount(1);
	await expect(
		page.getByRole('button', { name: 'Remove Browser annotation context.txt', exact: true }),
	).toHaveCount(1);
	expect(errors).toEqual([]);
});

test('changes review separates saved turn edits from native Git scopes', async ({ page }) => {
	const errors = await fixture(page);
	await openPanel(page);
	await newTab(page, 'Changes');
	const review = panel(page).getByRole('region', { name: 'Changes review', exact: true });
	await expect(review).toContainText('src/app.ts');
	await expect(review).toContainText('export const ready = true;');
	expect(
		await page.evaluate(() =>
			(window as any).__codeSurface.requests.filter(
				(request: CodeSurfaceRequest) => request.action === 'diff',
			),
		),
	).toEqual([]);
	for (const label of ['Uncommitted', 'Unstaged', 'Staged']) {
		await chooseOption(
			page,
			review.getByRole('combobox', { name: 'Review changes', exact: true }),
			{ label },
		);
		await expect(review.getByLabel('Git diff', { exact: true })).toContainText(
			'export const ready = true;',
		);
		await expect
			.poll(() =>
				page.evaluate(() =>
					(window as any).__codeSurface.requests
						.filter((request: CodeSurfaceRequest) => request.action === 'diff')
						.at(-1),
				),
			)
			.toMatchObject({
				action: 'diff',
				review: label.toLowerCase(),
				workspaceId: 'local',
				threadId: 'surface-thread-0',
				projectId: 'surface-project',
			});
	}
	expect(errors).toEqual([]);
});

test('narrow light layout keeps file navigation and composer usable at the base text size', async ({
	page,
}) => {
	await page.setViewportSize({ width: 760, height: 900 });
	const errors = await fixture(page, 'light');
	await openPanel(page);
	const files = panel(page).getByRole('region', { name: 'Workspace files', exact: true });
	await files.getByRole('button', { name: 'README.md', exact: true }).click();
	await expect(
		panel(page).getByRole('heading', { name: 'Workspace notes', exact: true }),
	).toBeVisible();
	const composer = page.getByRole('textbox', { name: 'Message', exact: true });
	await composer.fill('Reviewing on a smaller window.');
	await expect(composer).toHaveText('Reviewing on a smaller window.');
	const dimensions = await page.evaluate(() => ({
		viewport: innerWidth,
		content: document.documentElement.scrollWidth,
		fonts: [
			...document.querySelectorAll(
				'.code-surface-toolbar button, .code-workspace-tab button[role="tab"]',
			),
		]
			.filter((element) => element.getBoundingClientRect().width > 0)
			.map((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
	}));
	expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
	expect(dimensions.fonts.length).toBeGreaterThan(0);
	expect(Math.min(...dimensions.fonts)).toBeGreaterThanOrEqual(13);
	await page.screenshot({ path: '/tmp/freelm-code-surface-light-narrow.png' });
	expect(errors).toEqual([]);
});
