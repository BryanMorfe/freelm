import { selectConversationMode } from './helpers/conversation-mode';
import { expect, test, type Page } from '@playwright/test';
import { initialState } from '../../src/lib/state';
import { defaultToolSettings } from '../../src/lib/tool-settings';
import { configuredImageTool } from '../../src/lib/image-tool';
import { toolApiName } from '../../src/lib/agent';
import type { AppState } from '../../src/types';

async function fixture(
	page: Page,
	options: {
		chatImages?: boolean;
		localPath?: boolean;
		extraProjects?: number;
		runningTask?: boolean;
	} = {},
) {
	const state = initialState();
	state.connections[0].models.chat = 'test-model';
	state.connections[0].catalog = [
		{
			id: 'test-model',
			name: 'Test model',
			enabled: true,
			tasks: ['chat'],
			inputModalities: ['text', 'image'],
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
	state.toolSettings = {
		...defaultToolSettings(),
		enabled: true,
		commandExecution: true,
		workspaceRoot: '/tmp',
	};
	if (options.chatImages) {
		state.connections[0].catalog = [
			...state.connections[0].catalog,
			{
				id: 'image-model',
				name: 'Configured image model',
				enabled: true,
				tasks: ['images'],
				inputModalities: ['text', 'image'],
				outputModalities: ['image'],
				thinkingModes: [],
				imagePresets: [
					{
						id: 'native',
						name: 'Recommended',
						defaultAspectRatio: '1:1',
						aspectRatios: [
							{ id: '1:1', name: '1:1', width: 2048, height: 2048 },
							{ id: '4:3', name: '4:3', width: 2400, height: 1792 },
						],
					},
				],
				defaultImagePreset: 'native',
			},
		];
		state.toolSettings.enabled = false;
		state.toolSettings.imageGeneration = {
			enabled: true,
			connectionId: state.activeConnectionId,
			model: 'image-model',
			size: '',
			quality: '',
		};
	}
	state.projects = [
		{ id: 'chat-project', name: 'Ideas', instructions: 'Be concise.', createdAt: 1 },
		{
			id: 'code-project',
			name: 'Repository',
			instructions: 'Check the code.',
			directories: ['/tmp/repository'],
			createdAt: 1,
		},
	];
	state.threads = [
		{
			id: 'chat-record',
			title: 'Everyday conversation',
			projectId: 'chat-project',
			connectionId: state.activeConnectionId,
			model: 'test-model',
			createdAt: 1,
			updatedAt: 1,
			messages: [{ id: 'chat-message', role: 'user', content: 'An idea', createdAt: 1 }],
		},
		{
			id: 'code-record',
			title: 'Fix the project',
			projectId: 'code-project',
			connectionId: state.activeConnectionId,
			model: 'test-model',
			createdAt: 1,
			updatedAt: 1,
			messages: [{ id: 'code-message', role: 'user', content: 'A coding task', createdAt: 1 }],
		},
		{
			id: 'unassigned-chat-record',
			title: 'A quick question',
			kind: 'chat',
			connectionId: state.activeConnectionId,
			model: 'test-model',
			createdAt: 2,
			updatedAt: 2,
			messages: [{ id: 'quick-message', role: 'user', content: 'A quick question', createdAt: 2 }],
		},
		{
			id: 'unassigned-code-record',
			title: 'Standalone coding task',
			kind: 'code',
			connectionId: state.activeConnectionId,
			model: 'test-model',
			createdAt: 2,
			updatedAt: 2,
			messages: [
				{ id: 'standalone-message', role: 'user', content: 'Check a command', createdAt: 2 },
			],
		},
	];
	for (let index = 0; index < (options.extraProjects || 0); index++)
		state.projects.push({
			id: `extra-${index}`,
			name: `Notes ${index + 1}`,
			kind: options.runningTask ? 'code' : 'chat',
			instructions: '',
			createdAt: index + 2,
		});
	if (options.runningTask)
		state.threads.push({
			id: 'running-task',
			title: 'Background review',
			kind: 'code',
			projectId: 'extra-5',
			connectionId: state.activeConnectionId,
			model: 'test-model',
			createdAt: 1,
			updatedAt: 1,
			messages: [
				{ id: 'running-request', role: 'user', content: 'Review in the background.', createdAt: 1 },
			],
		});
	await page.addInitScript(
		(serialized) => {
			const { state: initial, options, imageDefinition, apiToolNames } = JSON.parse(serialized);
			let current = (JSON.parse(sessionStorage.getItem('conversation-modes-state') || 'null') ||
				initial) as AppState;
			let revision = 0;
			const control: any = { requests: [], catalogs: [], executions: [], state: () => current };
			(window as any).__modesTest = control;
			const response = (body: unknown) => ({
				status: 200,
				contentType: 'application/json',
				encoding: 'text',
				body: JSON.stringify(body),
			});
			(window as any).desktop = {
				platform: 'darwin',
				workspaceLoad: async () => ({
					state: structuredClone(current),
					revision: String(revision),
				}),
				workspaceSave: async (_id: string, _revision: string, next: AppState) => {
					current = structuredClone(next);
					sessionStorage.setItem('conversation-modes-state', JSON.stringify(current));
					return { revision: String(++revision) };
				},
				storageInfo: async () => ({ secure: true, location: '/test/.freelm/config.json' }),
				onPrepareClose: () => () => {},
				onToolApproval: () => () => {},
				...(options.runningTask
					? {
							hostTasksSnapshot: async () => ({
								runs: [
									{
										threadId: 'running-task',
										runId: 'running-task-run',
										owner: 'host',
										status: 'running',
									},
								],
								questions: [],
							}),
						}
					: {}),
				onChunk: () => () => {},
				cancel: async () => {},
				toolCancel: async () => {},
				toolPickDirectory: async () => '/tmp/chosen-project',
				instanceStatus: async () => ({
					host: { running: false, name: 'This computer', instanceId: 'local', port: 4319 },
					instances: [],
				}),
				toolCatalog: async (_workspace: string, _run: string, threadId: string) => {
					const stored = current.threads.find((thread) => thread.id === threadId);
					control.catalogs.push({ threadId, kind: stored?.kind });
					if (stored?.kind !== 'code' && !options.chatImages)
						throw new Error('Local tools are exclusive to Code.');
					return {
						instructions: 'Use Code tools. Private local workspace details.',
						warnings: [],
						tools: [
							...(stored?.kind === 'chat' ? [imageDefinition] : []),
							{
								name: 'exec_command',
								description: 'Run a command.',
								source: 'builtin',
								parameters: {
									type: 'object',
									properties: { cmd: { type: 'string' } },
									required: ['cmd'],
								},
							},
						],
					};
				},
				toolExecute: async (request: any) => {
					control.executions.push(request);
					if (request.name === 'image_gen.imagegen')
						return {
							content: [
								{
									type: 'image',
									name: 'fixture.png',
									dataUrl:
										'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6pAAAAABJRU5ErkJggg==',
								},
							],
						};
					return { content: [{ type: 'text', text: 'fixture command completed' }] };
				},
				request: async (request: any) => {
					const body = request.body;
					if (body.instructions?.startsWith('Write a short conversation title'))
						return response({ output_text: 'A generated title' });
					if (body.instructions?.startsWith('Summarize this conversation for continuity'))
						return response({ output_text: 'A factual conversation summary.' });
					control.requests.push(body);
					const codeTool = body.tools?.find((tool: any) => tool.name === apiToolNames.command);
					const imageTool = body.tools?.find((tool: any) => tool.name === apiToolNames.image);
					const calledTool = options.chatImages ? imageTool : codeTool;
					if (calledTool && !body.input.some((item: any) => item.type === 'function_call_output')) {
						return response({
							output: [
								{
									type: 'message',
									role: 'assistant',
									content: [{ type: 'output_text', text: 'I will check the project.' }],
								},
								{
									type: 'function_call',
									call_id: 'command-call',
									name: calledTool.name,
									arguments: options.chatImages
										? JSON.stringify({
												prompt: 'A blue square',
												size: '2400x1792',
												...(options.localPath
													? { referenced_image_paths: ['/tmp/private.png'] }
													: {}),
											})
										: '{"cmd":"pwd"}',
								},
							],
						});
					}
					return response({
						output_text: options.chatImages
							? 'The image request is complete.'
							: codeTool
								? 'The Code task is complete.'
								: 'A Chat reply.',
					});
				},
			};
		},
		JSON.stringify({
			state,
			options,
			apiToolNames: {
				command: toolApiName('exec_command'),
				image: toolApiName('image_gen.imagegen'),
			},
			imageDefinition: configuredImageTool(
				state.connections[0],
				state.toolSettings.imageGeneration,
				'code',
			),
		}),
	);
	await page.goto('/');
	await expect(page).toHaveTitle('FreeLM');
	await expect(page.getByRole('heading', { name: 'What’s on your mind?' })).toBeVisible();
}

test('Chat and Code have separate records, project folders, and tool execution', async ({
	page,
}) => {
	test.setTimeout(120_000);
	const errors: string[] = [];
	const originalViewport = page.viewportSize()!;
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (message) => {
		if (message.type() === 'error') errors.push(message.text());
	});
	await fixture(page);
	await expect(page.getByRole('navigation', { name: 'Chat projects' })).toContainText('Ideas');
	await expect(page.getByRole('navigation', { name: 'Chat projects' })).not.toContainText(
		'Repository',
	);
	await expect(page.getByRole('navigation', { name: 'Chat projects' })).toContainText(
		'Everyday conversation',
	);
	await expect(page.locator('.history-list')).toContainText('A quick question');
	await expect(page.locator('.history-list')).not.toContainText('Everyday conversation');
	await expect(page.locator('.history-list')).not.toContainText('Fix the project');
	await expect(page.getByRole('combobox', { name: 'Code permissions', exact: true })).toHaveCount(
		0,
	);
	await page.getByLabel('Message', { exact: true }).fill('A normal conversation');
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	await expect(page.locator('.message.assistant')).toContainText('A Chat reply.');
	expect(await page.evaluate(() => (window as any).__modesTest.catalogs)).toEqual([]);
	expect(
		await page.evaluate(() =>
			(window as any).__modesTest.requests[0].tools.map((tool: any) => tool.name),
		),
	).toEqual(
		[
			'conversations.search',
			'conversations.read',
			'memory.search',
			'memory.read',
			'memory.create',
			'memory.update',
			'memory.delete',
		].map(toolApiName),
	);
	expect(await page.evaluate(() => (window as any).__modesTest.executions)).toEqual([]);
	expect(
		await page.evaluate(() => (window as any).__modesTest.requests[0].instructions),
	).not.toContain('Private local workspace details');
	await expect
		.poll(() => page.evaluate(() => (window as any).__modesTest.state().threads[0].kind))
		.toBe('chat');
	await page.getByRole('button', { name: 'New project', exact: true }).click();
	const dialog = page.getByRole('dialog');
	await dialog.getByLabel('Project name').fill('Creative notes');
	await expect(dialog.getByLabel('Project directories')).toHaveCount(0);
	await dialog.getByRole('button', { name: 'Create project', exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					(window as any).__modesTest
						.state()
						.projects.find((project: any) => project.name === 'Creative notes')?.kind,
			),
		)
		.toBe('chat');
	await selectConversationMode(page, 'Code');
	await expect(page.getByRole('heading', { name: 'What should we work on?' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'New task', exact: true })).toBeVisible();
	await expect(page.getByRole('navigation', { name: 'Code projects' })).toContainText('Repository');
	await expect(page.getByRole('navigation', { name: 'Code projects' })).not.toContainText('Ideas');
	await expect(page.getByRole('navigation', { name: 'Code projects' })).toContainText(
		'Fix the project',
	);
	await expect(page.locator('.history-list')).toContainText('Standalone coding task');
	await expect(page.locator('.history-list')).not.toContainText('Fix the project');
	await expect(page.locator('.history-list')).not.toContainText('Everyday conversation');
	await page.getByRole('button', { name: 'New project', exact: true }).click();
	await dialog.getByLabel('Project name').fill('New repository');
	await dialog.getByRole('button', { name: 'Add folder', exact: true }).click();
	await expect(dialog.getByLabel('Project directories')).toHaveValue('/tmp/chosen-project');
	await dialog.getByRole('button', { name: 'Create project', exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					(window as any).__modesTest
						.state()
						.projects.find((project: any) => project.name === 'New repository')?.kind,
			),
		)
		.toBe('code');
	await page.getByLabel('Message', { exact: true }).fill('Check this project');
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	await expect(page.locator('.message.assistant')).toContainText('The Code task is complete.');
	expect(await page.evaluate(() => (window as any).__modesTest.catalogs)).toEqual([
		{ threadId: expect.any(String), kind: 'code' },
	]);
	expect(await page.evaluate(() => (window as any).__modesTest.executions[0])).toMatchObject({
		name: 'exec_command',
		arguments: { cmd: 'pwd' },
	});
	await page.screenshot({ path: '/tmp/freelm-code-workspace.png' });
	await page
		.getByRole('navigation', { name: 'Code projects' })
		.getByRole('button', { name: 'Fix the project', exact: true })
		.click();
	await expect(page.locator('.message.user')).toContainText('A coding task');
	await expect(page.locator('.titlebar-title')).toHaveAttribute(
		'title',
		'Repository · Fix the project',
	);
	// Existing tasks retain their project; the picker belongs to a new task's drawer.
	await expect(page.getByRole('combobox', { name: 'Code project', exact: true })).toHaveCount(0);
	await page.getByRole('button', { name: 'Actions for Fix the project', exact: true }).click();
	const threadActions = page.getByRole('menu', {
		name: 'Actions for Fix the project',
		exact: true,
	});
	await expect(threadActions).toBeVisible();
	await threadActions.getByRole('menuitem', { name: 'Pin task', exact: true }).click();
	await expect(threadActions).toHaveCount(0);
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					(window as any).__modesTest
						.state()
						.threads.find((thread: any) => thread.id === 'code-record').pinned,
			),
		)
		.toBe(true);
	const repository = page.getByRole('button', { name: 'Repository', exact: true });
	await repository.click();
	await expect(repository).toHaveAttribute('aria-expanded', 'false');
	await expect(page.getByRole('button', { name: 'Fix the project', exact: true })).toHaveCount(0);
	await expect(page.locator('.message.user')).toContainText('A coding task');
	await repository.click();
	await expect(repository).toHaveAttribute('aria-expanded', 'true');
	await expect(page.getByRole('button', { name: 'Fix the project', exact: true })).toBeVisible();
	await page.setViewportSize({ width: 1840, height: 1139 });
	await page.screenshot({ path: '/tmp/freelm-sidebar-expanded.png' });
	await page.setViewportSize(originalViewport);
	await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
	await expect(page.getByRole('navigation', { name: 'Code projects' })).toHaveCount(0);
	for (const name of ['Home', 'Images', 'Video', 'Audio'])
		await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Images', exact: true }).click();
	await page.getByRole('button', { name: 'Home', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Home', exact: true })).toHaveAttribute(
		'aria-current',
		'page',
	);
	await expect(page.locator('.message.user')).toContainText('A coding task');
	await expect(page.getByRole('navigation', { name: 'Code projects' })).toHaveCount(0);
	await page.getByRole('button', { name: /Personal workspace/ }).click();
	const settings = page.getByRole('region', { name: 'Settings', exact: true });
	await expect(settings).toBeVisible();
	await expect(page.getByRole('button', { name: 'Home', exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: /Personal workspace/ })).toHaveAttribute(
		'aria-current',
		'page',
	);
	await expect(page.getByRole('button', { name: 'Expand sidebar', exact: true })).toHaveCount(0);
	await settings.getByRole('button', { name: 'Back to workspace', exact: true }).click();
	await expect(settings).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Home', exact: true })).toBeVisible();
	await expect(page.getByRole('navigation', { name: 'Chat projects' })).toHaveCount(0);
	await page.getByRole('button', { name: 'Home', exact: true }).click();
	await expect(page.getByRole('navigation', { name: 'Code projects' })).toHaveCount(0);
	await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
	await page
		.getByRole('navigation', { name: 'Code projects' })
		.getByRole('button', { name: 'Fix the project', exact: true })
		.click();
	await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
	await expect(page.locator('.message.user')).toContainText('A coding task');
	await page.setViewportSize({ width: 1840, height: 1139 });
	await page.screenshot({ path: '/tmp/freelm-sidebar-collapsed.png' });
	await page.setViewportSize(originalViewport);
	await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
	await selectConversationMode(page, 'Chat');
	await expect(
		page.getByRole('heading', { name: 'How can I help with Creative notes?' }),
	).toBeVisible();
	await expect(page.getByRole('navigation', { name: 'Chat projects' })).toContainText(
		'Everyday conversation',
	);
	await expect(page.locator('.history-list')).not.toContainText('Fix the project');
	await page.reload();
	await expect(page.getByRole('navigation', { name: 'Chat projects' })).toContainText(
		'Everyday conversation',
	);
	await selectConversationMode(page, 'Code');
	await expect(page.getByRole('navigation', { name: 'Code projects' })).toContainText(
		'Fix the project',
	);
	await page.screenshot({ path: '/tmp/freelm-code-records.png' });
	await page
		.getByRole('navigation', { name: 'Code projects' })
		.getByRole('button', { name: 'Fix the project', exact: true })
		.click();
	await page.getByRole('button', { name: /Personal workspace/ }).click();
	await settings.getByRole('button', { name: 'Appearance', exact: true }).click();
	await settings.getByRole('radio', { name: 'Light', exact: true }).click();
	await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
	await expect(settings.getByText('Settings saved', { exact: true })).toBeVisible();
	await settings.getByRole('button', { name: 'Back to workspace', exact: true }).click();
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
	await expect(page.locator('.navigation-rail')).toHaveCSS(
		'background-color',
		'rgb(237, 237, 237)',
	);
	await expect(page.locator('.sidebar-panel')).toHaveCSS('background-color', 'rgb(247, 247, 247)');
	await expect(page.locator('.main-workspace')).toHaveCSS('color', 'rgb(34, 34, 34)');
	await expect
		.poll(() =>
			page.locator('.main-workspace').evaluate((element) => {
				let surface: Element | null = element;
				while (surface) {
					const background = getComputedStyle(surface).backgroundColor;
					if (background !== 'rgba(0, 0, 0, 0)' && background !== 'transparent') return background;
					surface = surface.parentElement;
				}
				return '';
			}),
		)
		.toBe('rgb(255, 255, 255)');
	await expect(page.getByRole('button', { name: 'Home', exact: true })).toHaveCSS(
		'color',
		'rgb(34, 34, 34)',
	);
	await expect(page.locator('.message.user')).toContainText('A coding task');
	await page.setViewportSize({ width: 1840, height: 1139 });
	await page.screenshot({ path: '/tmp/freelm-sidebar-light.png' });
	await page.setViewportSize(originalViewport);
	expect(errors).toEqual([]);
});

test('Chat keeps API images with Code disabled and filters work tools from a broader catalog', async ({
	page,
}) => {
	test.setTimeout(120_000);
	await fixture(page, { chatImages: true });
	await page.getByLabel('Message', { exact: true }).fill('Generate a blue square');
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	await expect(page.locator('.message.assistant')).toContainText('The image request is complete.');
	const body = await page.evaluate(() => (window as any).__modesTest.requests[0]);
	expect(body.tools.map((tool: { name: string }) => tool.name)).toEqual(
		[
			'image_gen.imagegen',
			'conversations.search',
			'conversations.read',
			'memory.search',
			'memory.read',
			'memory.create',
			'memory.update',
			'memory.delete',
		].map(toolApiName),
	);
	expect(body.tools[0].parameters.properties).not.toHaveProperty('referenced_image_paths');
	expect(body.tools[0].parameters.properties.size.description).toContain('Configured image model');
	expect(body.tools[0].parameters.properties.size.description).toContain('4:3: 2400x1792');
	expect(body.instructions).not.toContain('Private local workspace details');
	expect(await page.evaluate(() => (window as any).__modesTest.executions[0].name)).toBe(
		'image_gen.imagegen',
	);
	expect(await page.evaluate(() => (window as any).__modesTest.executions[0].arguments.size)).toBe(
		'2400x1792',
	);
	await expect
		.poll(() => page.evaluate(() => (window as any).__modesTest.state().threads[0].kind))
		.toBe('chat');
	await expect
		.poll(() => page.evaluate(() => (window as any).__modesTest.state().generations.length))
		.toBe(1);
	expect(
		await page.evaluate(() => (window as any).__modesTest.state().generations[0].parameters.size),
	).toBe('2400x1792');
	await expect
		.poll(() => page.evaluate(() => (window as any).__modesTest.state().threads[0].title))
		.toBe('A generated title');
	await page.reload();
	await expect(page.locator('.history-list')).toContainText('A generated title');
});

test('a Chat image call cannot forward local file paths to the host', async ({ page }) => {
	test.setTimeout(120_000);
	await fixture(page, { chatImages: true, localPath: true });
	await page.getByLabel('Message', { exact: true }).fill('Edit this image');
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	await expect(page.locator('.message.assistant')).toContainText('The image request is complete.');
	expect(await page.evaluate(() => (window as any).__modesTest.executions)).toEqual([]);
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					(window as any).__modesTest.state().threads[0]?.messages.at(-1)?.toolCalls?.[0]?.result,
			),
		)
		.toMatchObject({
			isError: true,
			content: [
				{ type: 'text', text: expect.stringContaining('Chat cannot read local file paths') },
			],
		});
});

test('project name and folder disclose threads without navigating or losing a draft', async ({
	page,
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await fixture(page);
	const projects = page.getByRole('navigation', { name: 'Chat projects' });
	await projects.getByRole('button', { name: 'Everyday conversation', exact: true }).click();
	const composer = page.getByLabel('Message', { exact: true });
	await composer.fill('Keep this draft while I browse project threads.');
	let project = projects.getByRole('button', { name: 'Ideas', exact: true });
	const row = project.locator('..');
	const threads = page.locator('#project-threads-chat-project');
	await expect(project).toHaveAttribute('aria-expanded', 'true');
	await expect(project).toHaveAttribute('aria-controls', 'project-threads-chat-project');
	await expect(project.locator('svg.lucide-folder-open')).toHaveCount(1);
	await expect(row.getByRole('button')).toHaveCount(3);
	await expect(
		row.locator('.project-toggle, .lucide-chevron-down, .lucide-chevron-right'),
	).toHaveCount(0);
	const rowBounds = (await row.boundingBox())!;
	const labelBounds = (await project.boundingBox())!;
	expect(labelBounds.width).toBeGreaterThanOrEqual(rowBounds.width - 49);
	const preserveConversation = async (name = 'Ideas') => {
		await expect(page.locator('.message.user')).toHaveText('An idea');
		await expect(page.locator('.titlebar-title')).toHaveAttribute(
			'title',
			`${name} · Everyday conversation`,
		);
		await expect(composer).toHaveText('Keep this draft while I browse project threads.');
	};
	// Both visible parts of the same button disclose the list; native button keys do the same.
	await project.locator('svg').click();
	await expect(project).toHaveAttribute('aria-expanded', 'false');
	await expect(project.locator('svg.lucide-folder')).toHaveCount(1);
	await expect(threads).toBeHidden();
	await preserveConversation();
	await project.press('Enter');
	await expect(project).toHaveAttribute('aria-expanded', 'true');
	await expect(project.locator('svg.lucide-folder-open')).toHaveCount(1);
	await expect(threads).toBeVisible();
	await preserveConversation();
	await project.locator('span').click();
	await expect(project).toHaveAttribute('aria-expanded', 'false');
	await preserveConversation();
	await project.press('Space');
	await expect(project).toHaveAttribute('aria-expanded', 'true');
	await expect(project.locator('svg.lucide-folder-open')).toHaveCount(1);
	await preserveConversation();
	await project.click();
	await expect(project).toHaveAttribute('aria-expanded', 'false');
	await row.hover();
	await projects.getByRole('button', { name: 'Edit project Ideas', exact: true }).click();
	const dialog = page.getByRole('dialog');
	await dialog.getByLabel('Project name').fill('Ideas revised');
	await dialog.getByRole('button', { name: 'Save project', exact: true }).click();
	project = projects.getByRole('button', { name: 'Ideas revised', exact: true });
	await expect(project).toHaveAttribute('aria-expanded', 'false');
	await preserveConversation('Ideas revised');
	await project.locator('..').hover();
	await projects.getByRole('button', { name: 'New chat in Ideas revised', exact: true }).click();
	await expect(
		page.getByRole('heading', { name: 'How can I help with Ideas revised?' }),
	).toBeVisible();
	await expect(composer.locator('.cm-placeholder')).toBeVisible();
	await expect(project).toHaveAttribute('aria-expanded', 'true');
	await expect(
		projects.getByRole('button', { name: 'Everyday conversation', exact: true }),
	).toBeVisible();
	expect(await page.evaluate(() => (window as any).__modesTest.requests)).toEqual([]);
	expect(errors).toEqual([]);
});

test('project actions reset drafts, move chats with a menu or drag, and reveal additional projects', async ({
	page,
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await fixture(page, { extraProjects: 6 });
	await page.getByLabel('Message', { exact: true }).fill('Unsaved first draft');
	await page.getByRole('button', { name: 'New chat', exact: true }).click();
	await expect(
		page.getByLabel('Message', { exact: true }).locator('.cm-placeholder'),
	).toBeVisible();
	await page.getByRole('button', { name: 'New chat in Ideas', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'How can I help with Ideas?' })).toBeVisible();
	await page.getByLabel('Message', { exact: true }).fill('Project draft');
	await page.getByRole('button', { name: 'Ideas', exact: true }).click();
	await expect(page.getByLabel('Message', { exact: true })).toHaveText('Project draft');
	await expect(page.getByRole('button', { name: 'Ideas', exact: true })).toHaveAttribute(
		'aria-expanded',
		'false',
	);
	await expect(page.getByRole('button', { name: 'Ideas', exact: true })).toHaveAttribute(
		'aria-current',
		'page',
	);
	await page.getByRole('button', { name: 'Ideas', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Notes 6', exact: true })).toHaveCount(0);
	await page.getByRole('button', { name: 'Show more projects', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Notes 6', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Actions for A quick question', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Move to project', exact: true }).click();
	const moveDialog = page.getByRole('dialog');
	await expect(moveDialog).not.toContainText('Repository');
	await moveDialog.getByRole('button', { name: 'Ideas', exact: true }).click();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					(window as any).__modesTest
						.state()
						.threads.find((thread: any) => thread.id === 'unassigned-chat-record').projectId,
			),
		)
		.toBe('chat-project');
	await expect(page.getByRole('navigation', { name: 'Chat projects' })).toContainText(
		'A quick question',
	);
	const row = page.getByRole('button', { name: 'A quick question', exact: true }).locator('..');
	const destination = page.getByRole('button', { name: 'Notes 6', exact: true }).locator('..');
	await row.dragTo(destination);
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					(window as any).__modesTest
						.state()
						.threads.find((thread: any) => thread.id === 'unassigned-chat-record').projectId,
			),
		)
		.toBe('extra-5');
	await page.getByRole('button', { name: 'A quick question', exact: true }).click();
	await expect(page.locator('.titlebar-title')).toHaveAttribute(
		'title',
		'Notes 6 · A quick question',
	);
	await page.getByRole('button', { name: 'Actions for A quick question', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Move to project', exact: true }).click();
	await moveDialog.getByRole('button', { name: 'No project', exact: true }).click();
	await expect(page.locator('.history-list')).toContainText('A quick question');
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					(window as any).__modesTest
						.state()
						.threads.find((thread: any) => thread.id === 'unassigned-chat-record').projectId,
			),
		)
		.toBeUndefined();
	await page.screenshot({ path: '/tmp/freelm-audit-20260930/sidebar-projects.png' });
	expect(errors).toEqual([]);
});

test('Settings keeps the rail and protects changes when navigating directly to another workspace', async ({
	page,
}) => {
	await fixture(page);
	await page.getByRole('button', { name: /Personal workspace/ }).click();
	const settings = page.getByRole('region', { name: 'Settings', exact: true });
	for (const name of ['Home', 'Images', 'Video', 'Audio'])
		await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
	await settings.getByRole('button', { name: 'System', exact: true }).click();
	await settings
		.getByRole('textbox', { name: 'System prompt', exact: true })
		.fill('A saved preference');
	await page.getByRole('button', { name: 'Images', exact: true }).click();
	const guard = settings.locator('.settings-leave-prompt');
	await expect(guard).toBeVisible();
	await guard.getByRole('button', { name: 'Keep editing', exact: true }).click();
	await expect(settings).toBeVisible();
	await expect(settings.getByRole('textbox', { name: 'System prompt', exact: true })).toHaveValue(
		'A saved preference',
	);
	// Keep editing cancels the queued Images destination; a later Back restores Chat.
	await settings.getByRole('button', { name: 'Back to workspace', exact: true }).click();
	await guard.getByRole('button', { name: /Save/ }).click();
	await expect(settings).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Home', exact: true })).toHaveAttribute(
		'aria-current',
		'page',
	);
	await page.getByRole('button', { name: /Personal workspace/ }).click();
	await settings.getByRole('button', { name: 'System', exact: true }).click();
	await settings
		.getByRole('textbox', { name: 'System prompt', exact: true })
		.fill('A revised preference');
	await page.getByRole('button', { name: 'Images', exact: true }).click();
	await guard.getByRole('button', { name: /Save/ }).click();
	await expect(settings).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Images', exact: true })).toHaveAttribute(
		'aria-current',
		'page',
	);
	await expect
		.poll(() => page.evaluate(() => (window as any).__modesTest.state().systemPrompt))
		.toBe('A revised preference');
	await page.getByRole('button', { name: /Personal workspace/ }).click();
	await settings.getByRole('button', { name: 'System', exact: true }).click();
	await settings
		.getByRole('textbox', { name: 'System prompt', exact: true })
		.fill('Discard this preference');
	await page.getByRole('button', { name: 'Home', exact: true }).click();
	await guard.getByRole('button', { name: /Discard/ }).click();
	await expect(settings).toHaveCount(0);
	await expect
		.poll(() => page.evaluate(() => (window as any).__modesTest.state().systemPrompt))
		.toBe('A revised preference');
	await page.getByRole('button', { name: /Personal workspace/ }).click();
	await page.screenshot({ path: '/tmp/freelm-audit-20260930/settings-rail.png' });
});

test('messages have a right-click copy action without repeating model labels', async ({
	page,
	context,
}) => {
	await fixture(page);
	await context.grantPermissions(['clipboard-read', 'clipboard-write']);
	await page.getByRole('button', { name: 'Everyday conversation', exact: true }).click();
	await page.locator('.message.user .message-content').click({ button: 'right' });
	const menu = page.getByRole('menu', { name: 'Message actions' });
	await expect(menu).toBeVisible();
	await menu.getByRole('menuitem', { name: 'Copy message', exact: true }).click();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('An idea');
	await expect(menu).toHaveCount(0);
	await expect(page.locator('.assistant-label')).toHaveCount(0);
});

test('mode switching restores each conversation and draft; New task remains explicit', async ({
	page,
}) => {
	await fixture(page);
	const composer = page.getByLabel('Message', { exact: true });
	await page.getByRole('button', { name: 'Everyday conversation', exact: true }).click();
	await composer.fill('Unsent Chat draft');
	await selectConversationMode(page, 'Code');
	await page.getByRole('button', { name: 'Fix the project', exact: true }).click();
	await composer.fill('Unsent Code draft');
	await selectConversationMode(page, 'Chat');
	await expect(page.locator('.message.user')).toContainText('An idea');
	await expect(composer).toHaveText('Unsent Chat draft');
	await selectConversationMode(page, 'Code');
	await expect(page.locator('.message.user')).toContainText('A coding task');
	await expect(composer).toHaveText('Unsent Code draft');
	await page.getByRole('button', { name: 'New task', exact: true }).click();
	await composer.fill('A new task draft');
	await selectConversationMode(page, 'Chat');
	await selectConversationMode(page, 'Code');
	await expect(
		page.getByRole('heading', { name: 'What should we work on?', exact: true }),
	).toBeVisible();
	await expect(composer).toHaveText('A new task draft');
	await page.getByRole('button', { name: 'Fix the project', exact: true }).click();
	await expect(composer).toHaveText('Unsent Code draft');
});

test('running tasks stay discoverable across modes and beyond the project limit', async ({
	page,
}) => {
	await fixture(page, { extraProjects: 6, runningTask: true });
	const running = page.getByRole('region', { name: 'Running conversations' });
	await expect(
		running.getByRole('button', { name: 'Open running task: Background review' }),
	).toBeVisible();
	await selectConversationMode(page, 'Code');
	await expect(page.getByRole('button', { name: 'Notes 6', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Projects', exact: true }).click();
	await expect(running).toBeVisible();
	await selectConversationMode(page, 'Chat');
	await running.getByRole('button', { name: 'Open running task: Background review' }).click();
	await expect(page.getByRole('combobox', { name: 'Conversation mode', exact: true })).toHaveText(
		'Code',
	);
	await expect(page.locator('.message.user')).toContainText('Review in the background.');
	await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toBeVisible();
	await page.screenshot({ path: '/tmp/freelm-running-conversations.png' });
});
