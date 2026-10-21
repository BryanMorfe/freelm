import { selectConversationMode } from './helpers/conversation-mode';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { initialState } from '../../src/lib/state';
import { defaultToolSettings } from '../../src/lib/tool-settings';
import { defaultPersonalization } from '../../src/lib/personalization';
import { configuredImageTool } from '../../src/lib/image-tool';
import { threadMemoryRevision } from '../../src/lib/memories';
import { toolApiName } from '../../src/lib/agent';
import type { AppState, ConversationKind, Thread } from '../../src/types';
import { chooseOption, expectValue } from './ui-controls';

// Chrome protocol calls on this host can take several seconds per interaction.
test.setTimeout(300_000);
test.use({ actionTimeout: 30_000 });

const memoryNames = [
	'conversations.search',
	'conversations.read',
	'memory.search',
	'memory.read',
	'memory.create',
	'memory.update',
	'memory.delete',
];

// Browser plugin not available. Exercise Settings -> generated prompt -> real
// renderer request assembly with a fake desktop bridge and isolated state. No
// user profile, native execution or external API is accessed by this fixture.
async function fixture(
	page: Page,
	api: 'responses' | 'chat/completions' = 'responses',
	hostTools = false,
) {
	const state = initialState();
	state.systemPrompt = 'WORKSPACE_EXTRA_PROMPT: preserve exact facts.';
	state.personalization = defaultPersonalization();
	state.personalization.chat = {
		...state.personalization.chat,
		personality: 'friendly',
		warmth: 'more',
		formatting: 'less',
		emojis: 'less',
		customInstructions: 'CHAT_CUSTOM_SENTINEL: answer in clear prose.',
	};
	state.personalization.code = {
		...state.personalization.code,
		personality: 'professional',
		responseLength: 'less',
		customInstructions: 'CODE_CUSTOM_SENTINEL: explain checks and uncertainties.',
	};
	state.connections[0].baseUrl = 'http://system-prompt-fixture.invalid/v1';
	state.connections[0].chatApi = api;
	state.connections[0].models.chat = 'prompt-model';
	state.connections[0].catalog = [
		{
			id: 'prompt-model',
			name: 'Prompt model',
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
		{
			id: 'image-model',
			name: 'Fixture image model',
			enabled: true,
			tasks: ['images'],
			inputModalities: ['text', 'image'],
			outputModalities: ['image'],
			thinkingModes: [],
			defaultImagePreset: 'high',
			imagePresets: [
				{
					id: 'high',
					name: 'High quality',
					quality: 'high',
					defaultAspectRatio: 'square',
					aspectRatios: [
						{ id: 'square', name: '1:1', width: 2048, height: 2048 },
						{ id: 'portrait', name: '3:4', width: 1792, height: 2400 },
					],
				},
			],
		},
	];
	state.toolSettings = {
		...defaultToolSettings(),
		enabled: hostTools,
		commandExecution: hostTools,
		workspaceRoot: '/tmp/isolated-prompt-fixture',
		imageGeneration: {
			enabled: !hostTools,
			connectionId: state.activeConnectionId,
			model: 'image-model',
			size: '2048x2048',
			quality: 'high',
		},
	};
	state.memorySettings = { savedMemories: true, referenceHistory: true };
	state.projects = [
		{
			id: 'ideas',
			name: 'Ideas',
			kind: 'chat',
			instructions: 'CHAT_PROJECT_SENTINEL: use metric units.',
			createdAt: 1,
		},
		{
			id: 'repository',
			name: 'Repository',
			kind: 'code',
			instructions: 'CODE_PROJECT_SENTINEL: check relevant behavior.',
			directories: ['/tmp/isolated-prompt-fixture'],
			createdAt: 1,
		},
	];
	const thread = (
		id: string,
		title: string,
		kind: ConversationKind,
		projectId?: string,
	): Thread => ({
		id,
		title,
		kind,
		projectId,
		connectionId: state.activeConnectionId,
		model: 'prompt-model',
		thinkingMode: 'low',
		createdAt: 1,
		updatedAt: id === 'ideas-history' ? 10 : 1,
		messages: [
			{ id: `${id}-user`, role: 'user', content: `Existing ${title} question`, createdAt: 1 },
			{
				id: `${id}-assistant`,
				role: 'assistant',
				content: `Existing ${title} answer`,
				createdAt: 2,
				completedAt: 3,
			},
		],
	});
	state.threads = [
		thread('chat-main', 'Chat prompt example', 'chat', 'ideas'),
		thread('ideas-history', 'Previous project decision', 'chat', 'ideas'),
		thread('outside-history', 'Outside private discussion', 'chat'),
		thread('code-main', 'Code prompt example', 'code', 'repository'),
	];
	state.threads[1].memorySummary = {
		content: 'RECENT_PROJECT_SUMMARY: launch uses forty-two seats.',
		sourceRevision: threadMemoryRevision(state.threads[1]),
		generatedAt: 5,
		model: 'prompt-model',
	};
	state.threads[2].memorySummary = {
		content: 'SECRET_OUTSIDE_SUMMARY',
		sourceRevision: threadMemoryRevision(state.threads[2]),
		generatedAt: 5,
		model: 'prompt-model',
	};
	state.savedMemories = [
		{
			id: 'global-note',
			content: 'SAVED_GLOBAL_NOTE: prefer concise explanations.',
			source: 'user',
			revision: 1,
			createdAt: 1,
			updatedAt: 1,
		},
		{
			id: 'project-note',
			content: 'SAVED_PROJECT_NOTE: launch in April.',
			projectId: 'ideas',
			source: 'user',
			revision: 1,
			createdAt: 1,
			updatedAt: 1,
		},
	];
	const image = configuredImageTool(
		state.connections[0],
		state.toolSettings.imageGeneration,
		'chat',
	);
	const execution = {
		name: 'exec_command',
		namespace: 'functions',
		source: 'builtin',
		deferred: false,
		description: 'Run an authorized command.',
		parameters: {
			type: 'object',
			properties: { cmd: { type: 'string' } },
			required: ['cmd'],
			additionalProperties: false,
		},
	};
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (message) => {
		if (message.type() === 'error') errors.push(message.text());
	});
	await page.addInitScript(
		({ serialized, image, execution, hostTools }) => {
			let current: AppState = JSON.parse(serialized);
			let revision = 0;
			const control: any = {
				requests: [],
				summaries: [],
				titles: [],
				catalogs: [],
				executions: [],
				cancelledTools: [],
				clipboard: '',
				state: () => structuredClone(current),
			};
			(window as any).__promptTest = control;
			const json = (body: unknown) => ({
				status: 200,
				contentType: 'application/json',
				encoding: 'text',
				body: JSON.stringify(body),
			});
			control.finish = (index: number, text: string) => {
				const request = control.requests[index];
				request.resolve(
					json(
						request.body.input
							? { output_text: text }
							: { choices: [{ message: { role: 'assistant', content: text } }] },
					),
				);
			};
			(window as any).desktop = {
				platform: 'linux',
				clipboardWriteText: async (text: string) => {
					control.clipboard = text;
				},
				workspaceLoad: async () => ({
					state: structuredClone(current),
					revision: String(revision),
				}),
				workspaceSave: async (_id: string, _revision: string, next: AppState) => {
					current = structuredClone(next);
					return { revision: String(++revision) };
				},
				storageInfo: async () => ({ secure: false, location: 'Isolated system prompt fixture' }),
				onPrepareClose: () => () => {},
				onToolApproval: () => () => {},
				onChunk: () => () => {},
				cancel: async () => {},
				toolCancel: async (runId: string) => {
					control.cancelledTools.push(runId);
				},
				instanceStatus: async () => ({
					host: { running: false, name: 'Local', instanceId: 'local', port: 4319 },
					instances: [],
				}),
				toolCatalog: async (_workspace: string, runId: string, threadId: string) => {
					control.catalogs.push({ runId, threadId });
					const catalog = {
						tools: hostTools ? [execution] : [image, execution],
						instructions: 'CODE_HOST_PRIVATE_GUIDANCE: use the project directories.',
						context: [
							{
								id: 'fixture-code-memory',
								source:
									'Project MEMORY.md at /tmp/isolated-prompt-fixture/MEMORY.md (untrusted saved data)',
								text: control.memoryText ?? 'CODE_MEMORY_SENTINEL: use the existing test helpers.',
							},
						],
						warnings: ['CODE_HOST_WARNING: fixture tools only.'],
					};
					if (control.holdNextCatalog) {
						control.holdNextCatalog = false;
						await new Promise<void>((resolve) => {
							control.releaseCatalog = resolve;
						});
					}
					return structuredClone(catalog);
				},
				toolExecute: async (request: unknown) => {
					control.executions.push(request);
					throw new Error('Prompt inspection must never execute a tool.');
				},
				request: async (request: any) => {
					const instructions =
						request.body.instructions ||
						request.body.messages?.find((message: any) => message.role === 'system')?.content ||
						'';
					if (instructions.startsWith('Write a short conversation title')) {
						control.titles.push(request.body);
						return json(
							request.body.input
								? { output_text: 'Prompt example' }
								: { choices: [{ message: { content: 'Prompt example' } }] },
						);
					}
					return new Promise((resolve) => {
						const captured = { path: request.path, body: structuredClone(request.body), resolve };
						if (instructions.startsWith('Summarize this conversation for continuity'))
							control.summaries.push(captured);
						else control.requests.push(captured);
					});
				},
			};
		},
		{ serialized: JSON.stringify(state), image, execution, hostTools },
	);
	await page.goto('/');
	await expect(page).toHaveTitle('FreeLM');
	await expect(page.getByLabel('Message', { exact: true })).toBeVisible({ timeout: 60_000 });
	await expect(page.locator('vite-error-overlay')).toHaveCount(0);
	return errors;
}

async function selectConversation(page: Page, kind: ConversationKind) {
	if (kind === 'code') await selectConversationMode(page, 'Code');
	await page
		.getByRole('button', {
			name: `${kind === 'chat' ? 'Chat' : 'Code'} prompt example`,
			exact: true,
		})
		.click();
}

async function settings(page: Page): Promise<Locator> {
	await page.getByRole('button', { name: 'Personal workspace settings', exact: true }).click();
	const region = page.getByRole('region', { name: 'Settings', exact: true });
	await expect(region).toBeVisible();
	return region;
}

async function prompt(page: Page, region: Locator) {
	await region.getByRole('button', { name: 'System', exact: true }).click();
	const output = region.getByLabel('Generated system prompt', { exact: true });
	await expect(output).toBeVisible();
	return output;
}

async function schemas(region: Locator, last = false): Promise<unknown[]> {
	const label = `${last ? 'Last sent ' : ''}API tool definitions`;
	const details = region
		.locator('.system-prompt-tools')
		.filter({ hasText: new RegExp(`^${label} \\(`) });
	if ((await details.getAttribute('open')) === null) await details.locator('summary').click();
	return JSON.parse((await region.getByLabel(label, { exact: true }).textContent())!);
}

async function send(page: Page, text: string) {
	await page.getByLabel('Message', { exact: true }).fill(text);
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
}

async function requests(page: Page): Promise<any[]> {
	return page.evaluate(() =>
		(window as any).__promptTest.requests.map(({ body, path }: any) => ({ body, path })),
	);
}

function instructions(body: any): string {
	return (
		body.instructions ||
		body.messages?.find((message: any) => message.role === 'system')?.content ||
		''
	);
}

function userContext(body: any): string[] {
	return (body.input ?? body.messages ?? [])
		.filter((message: any) => message.role === 'user')
		.map((message: any) =>
			typeof message.content === 'string'
				? message.content
				: (message.content ?? []).map((part: any) => part.text ?? '').join('\n'),
		);
}

test('System prompt selectors use the shared menus for modes, projects and conversations', async ({
	page,
}) => {
	const errors = await fixture(page);
	const region = await settings(page);
	const output = await prompt(page, region);
	await expect(region.locator('select')).toHaveCount(0);
	const mode = region.getByRole('combobox', { name: 'Prompt mode', exact: true });
	const conversation = region.getByRole('combobox', { name: 'Prompt conversation', exact: true });
	const project = region.getByRole('combobox', { name: 'Prompt project', exact: true });
	for (const control of [mode, conversation, project]) {
		await expect(control).toHaveClass(/select-trigger/);
		expect(await control.evaluate((element) => element.tagName)).toBe('BUTTON');
		const inset = await control.evaluate(
			(element) =>
				element.getBoundingClientRect().right -
				element.querySelector('svg')!.getBoundingClientRect().right,
		);
		expect(inset).toBeGreaterThanOrEqual(10);
	}
	await mode.click();
	const menu = page.getByRole('listbox');
	await expect(menu).toHaveClass('select-popup');
	await expect(menu.getByRole('option')).toHaveCount(2);
	await expect(menu.locator('[data-value="chat"]')).toHaveAttribute('aria-selected', 'true');
	await mode.press('End');
	await mode.press('Escape');
	await expectValue(mode, 'chat');
	await expect(menu).toHaveCount(0);
	await chooseOption(page, project, 'ideas');
	await expect(output).toContainText('CHAT_PROJECT_SENTINEL');
	await expect(output).toContainText('SAVED_PROJECT_NOTE');
	await conversation.click();
	await expect(menu.locator('[data-value="chat-main"]')).toBeVisible();
	await expect(menu.locator('[data-value="code-main"]')).toHaveCount(0);
	await region.getByRole('textbox', { name: 'System prompt', exact: true }).click();
	await expect(menu).toHaveCount(0);
	await expectValue(conversation, '');
	await conversation.focus();
	await conversation.press('ArrowDown');
	await conversation.press('ArrowDown');
	await conversation.press('Enter');
	await expectValue(conversation, 'chat-main');
	await expect(project).toHaveCount(0);
	await expect(output).toContainText('CHAT_PROJECT_SENTINEL');
	await page.setViewportSize({ width: 390, height: 844 });
	await conversation.click();
	const bounds = (await menu.boundingBox())!;
	expect(bounds.x).toBeGreaterThanOrEqual(7);
	expect(bounds.x + bounds.width).toBeLessThanOrEqual(383);
	expect(bounds.y).toBeGreaterThanOrEqual(7);
	expect(bounds.y + bounds.height).toBeLessThanOrEqual(837);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await page.screenshot({ path: '/tmp/freelm-dropdown-20261001-system-narrow.png' });
	await conversation.press('Escape');
	await expect(menu).toHaveCount(0);
	expect(await page.evaluate(() => (window as any).__promptTest.executions)).toEqual([]);
	expect(await requests(page)).toEqual([]);
	await expect(page.locator('vite-error-overlay')).toHaveCount(0);
	expect(errors).toEqual([]);
});

for (const api of ['responses', 'chat/completions'] as const) {
	for (const kind of ['chat', 'code'] as const) {
		test(`${api}: ${kind} preview and immutable sent snapshot match actual prompts and API tool schemas`, async ({
			page,
		}) => {
			const errors = await fixture(page, api);
			await selectConversation(page, kind);
			let region = await settings(page);
			const preview = await prompt(page, region);
			const before = (await preview.textContent())!;
			const beforeContext =
				kind === 'code'
					? (await region.getByLabel('Generated user-role context', { exact: true }).textContent())!
					: '';
			const beforeTools = await schemas(region);
			expect(before).toContain('WORKSPACE_EXTRA_PROMPT');
			expect(before).toContain(`${kind.toUpperCase()}_CUSTOM_SENTINEL`);
			expect(kind === 'code' ? beforeContext : before).toContain(
				`${kind.toUpperCase()}_PROJECT_SENTINEL`,
			);
			expect(before).not.toContain(`${kind === 'chat' ? 'CODE' : 'CHAT'}_CUSTOM_SENTINEL`);
			expect(before).not.toContain('SECRET_OUTSIDE_SUMMARY');
			if (kind === 'chat') {
				expect(before).toContain('Personality: Friendly.');
				expect(before).toContain('Warmth (more):');
				expect(before).toContain('SAVED_GLOBAL_NOTE');
				expect(before).toContain('SAVED_PROJECT_NOTE');
				expect(before).toContain('RECENT_PROJECT_SUMMARY');
				expect(before).toContain('Fixture image model (image-model)');
				expect(before).toContain('1792x2400');
				expect(before).toContain('API quality is fixed to high');
				expect(before).not.toContain('CODE_HOST_PRIVATE_GUIDANCE');
				const names = beforeTools.map((tool: any) => tool.name || tool.function.name);
				expect(names.sort()).toEqual(
					[...memoryNames, 'image_gen.imagegen'].map(toolApiName).sort(),
				);
			} else {
				expect(before).not.toContain('CODE_PROJECT_SENTINEL');
				expect(before).toContain('You are an AI coding assistant in FreeLM.');
				expect(before).toContain('Personality: Professional.');
				expect(before).toContain('Response length (less):');
				expect(before).not.toContain('SAVED_');
				expect(before).not.toContain('RECENT_PROJECT_SUMMARY');
				expect(before).not.toContain('Memory guidance:');
				expect(beforeTools).toEqual([]);
			}
			// Preview is read-only and cannot load native tools in Chat or disabled Code.
			expect(await page.evaluate(() => (window as any).__promptTest.catalogs)).toEqual([]);
			await region.getByRole('button', { name: 'Back to workspace', exact: true }).click();
			await send(page, 'Verify this prompt.');
			await expect.poll(async () => (await requests(page)).length).toBe(1);
			const first = (await requests(page))[0];
			expect(first.path).toMatch(new RegExp(`/${api}$`));
			expect(instructions(first.body)).toBe(before);
			if (kind === 'code') expect(userContext(first.body)).toContain(beforeContext);
			expect(first.body.tools || []).toEqual(beforeTools);
			await page.evaluate(() => (window as any).__promptTest.finish(0, 'The prompt was received.'));
			await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toHaveCount(0);
			region = await settings(page);
			await prompt(page, region);
			const last = region.locator('pre[aria-label="Last sent system prompt"]');
			await expect(last).toHaveText(before);
			if (kind === 'code')
				await expect(region.getByLabel('Last sent user-role context', { exact: true })).toHaveText(
					beforeContext,
				);
			expect(await schemas(region, true)).toEqual(first.body.tools || []);
			await region.getByRole('button', { name: 'Personalization', exact: true }).click();
			await region
				.getByRole('tab', { name: kind === 'chat' ? 'Chat' : 'Code', exact: true })
				.click();
			await chooseOption(
				page,
				region.getByRole('combobox', { name: 'Personality', exact: true }),
				'candid',
			);
			await region
				.getByLabel(`${kind === 'chat' ? 'Chat' : 'Code'} custom instructions`, { exact: true })
				.fill(`${kind.toUpperCase()}_UPDATED_CUSTOM: be constructively direct.`);
			const draft = await prompt(page, region);
			await expect(draft).toContainText(`${kind.toUpperCase()}_UPDATED_CUSTOM`);
			await expect(draft).toContainText('Personality: Candid.');
			await expect(
				region.getByText('Draft preview — save settings to apply these instructions.', {
					exact: true,
				}),
			).toBeVisible();
			await expect(last).toHaveText(before);
			expect(await schemas(region, true)).toEqual(first.body.tools || []);
			if (api === 'responses' && kind === 'chat')
				await page.screenshot({ path: '/tmp/freelm-system-prompt-chat-snapshot.png' });
			const after = (await draft.textContent())!;
			await region.getByRole('button', { name: 'Save settings', exact: true }).click();
			await expect
				.poll(() =>
					page.evaluate(
						(kind) => (window as any).__promptTest.state().personalization[kind].personality,
						kind,
					),
				)
				.toBe('candid');
			await expect(region.getByText('Preview from saved settings.', { exact: true })).toBeVisible();
			await expect(last).toHaveText(before);
			await region.getByRole('button', { name: 'Back to workspace', exact: true }).click();
			await send(page, 'Verify the saved personalization.');
			await expect.poll(async () => (await requests(page)).length).toBe(2);
			expect(instructions((await requests(page))[1].body)).toBe(after);
			await page.evaluate(() =>
				(window as any).__promptTest.finish(1, 'The saved instructions were received.'),
			);
			await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toHaveCount(0);
			region = await settings(page);
			await prompt(page, region);
			await expect(region.locator('pre[aria-label="Last sent system prompt"]')).toHaveText(after);
			expect(await page.evaluate(() => (window as any).__promptTest.executions)).toEqual([]);
			expect(errors).toEqual([]);
		});
	}
}

test('Code host preview cancels stale catalog discovery and caches only completed guidance without executing tools', async ({
	page,
}) => {
	const errors = await fixture(page, 'responses', true);
	await selectConversation(page, 'code');
	const region = await settings(page);
	await page.evaluate(() => {
		(window as any).__promptTest.holdNextCatalog = true;
	});
	await region.getByRole('button', { name: 'System', exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => (window as any).__promptTest.catalogs.length))
		.toBe(1);
	const firstRun = await page.evaluate(() => (window as any).__promptTest.catalogs[0].runId);
	await chooseOption(
		page,
		region.getByRole('combobox', { name: 'Prompt mode', exact: true }),
		'chat',
	);
	await chooseOption(
		page,
		region.getByRole('combobox', { name: 'Prompt conversation', exact: true }),
		'chat-main',
	);
	await expect
		.poll(() => page.evaluate(() => (window as any).__promptTest.cancelledTools))
		.toContain(firstRun);
	await page.evaluate(() => (window as any).__promptTest.releaseCatalog());
	const output = region.getByLabel('Generated system prompt', { exact: true });
	await expect(output).toContainText('CHAT_CUSTOM_SENTINEL');
	await expect(output).not.toContainText('CODE_HOST_PRIVATE_GUIDANCE');
	await chooseOption(
		page,
		region.getByRole('combobox', { name: 'Prompt mode', exact: true }),
		'code',
	);
	await chooseOption(
		page,
		region.getByRole('combobox', { name: 'Prompt conversation', exact: true }),
		'code-main',
	);
	await expect(output).toContainText('CODE_HOST_PRIVATE_GUIDANCE');
	await expect(output).toContainText('CODE_HOST_WARNING');
	await expect
		.poll(() => page.evaluate(() => (window as any).__promptTest.catalogs.length))
		.toBe(2);
	expect((await schemas(region)).map((tool: any) => tool.name)).toEqual([
		toolApiName('exec_command'),
	]);
	await region.getByRole('button', { name: 'Personalization', exact: true }).click();
	await region.getByRole('tab', { name: 'Code', exact: true }).click();
	await region
		.getByLabel('Code custom instructions', { exact: true })
		.fill('CODE_CATALOG_DRAFT: preserve enabled tools.');
	await prompt(page, region);
	await expect(output).toContainText('CODE_CATALOG_DRAFT');
	expect(await page.evaluate(() => (window as any).__promptTest.catalogs.length)).toBe(2);
	await region.getByRole('button', { name: 'Refresh prompt', exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => (window as any).__promptTest.catalogs.length))
		.toBe(3);
	await expect(output).toContainText('CODE_HOST_PRIVATE_GUIDANCE');
	expect(await page.evaluate(() => (window as any).__promptTest.executions)).toEqual([]);
	expect(await requests(page)).toEqual([]);
	await page.screenshot({ path: '/tmp/freelm-system-prompt-code-catalog.png' });
	expect(errors).toEqual([]);
});

for (const api of ['responses', 'chat/completions'] as const) {
	test(`${api}: Code context retains provenance separately in preview, wire request, snapshot and copy`, async ({
		page,
	}) => {
		const errors = await fixture(page, api, true);
		await selectConversation(page, 'code');
		let region = await settings(page);
		const system = await prompt(page, region);
		const context = region.getByLabel('Generated user-role context', { exact: true });
		await expect(context).toContainText('CODE_MEMORY_SENTINEL');
		await expect(context).toContainText('/tmp/isolated-prompt-fixture/MEMORY.md');
		await expect(context).toContainText('CODE_PROJECT_SENTINEL');
		await expect(system).not.toContainText('CODE_MEMORY_SENTINEL');
		await expect(system).not.toContainText('CODE_PROJECT_SENTINEL');
		const sentSystem = (await system.textContent())!;
		const sentContext = (await context.textContent())!;
		await region.getByRole('button', { name: 'Copy prompt', exact: true }).click();
		expect(await page.evaluate(() => (window as any).__promptTest.clipboard)).toBe(
			`System instructions\n\n${sentSystem}\n\nUser-role context\n\n${sentContext}`,
		);
		await region.getByRole('button', { name: 'Back to workspace', exact: true }).click();
		await send(page, 'Check the project using its saved context.');
		await expect.poll(async () => (await requests(page)).length).toBe(1);
		const body = (await requests(page))[0].body;
		expect(instructions(body)).toBe(sentSystem);
		expect(userContext(body).filter((text) => text.includes('CODE_MEMORY_SENTINEL'))).toEqual([
			sentContext,
		]);
		await page.evaluate(() => (window as any).__promptTest.finish(0, 'Project context received.'));
		await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toHaveCount(0);
		region = await settings(page);
		await prompt(page, region);
		const snapshot = region.getByLabel('Last sent user-role context', { exact: true });
		await expect(snapshot).toHaveText(sentContext);
		await page.evaluate(() => {
			(window as any).__promptTest.memoryText = 'UPDATED_CODE_MEMORY: the latest project note.';
		});
		await region.getByRole('button', { name: 'Refresh prompt', exact: true }).click();
		await expect(context).toContainText('UPDATED_CODE_MEMORY');
		await expect(context).not.toContainText('CODE_MEMORY_SENTINEL');
		await expect(snapshot).toHaveText(sentContext);
		if (api === 'responses') {
			await context.scrollIntoViewIfNeeded();
			await page.screenshot({ path: '/tmp/freelm-code-user-context.png' });
		}
		await region.getByRole('button', { name: 'Copy last sent prompt', exact: true }).click();
		expect(await page.evaluate(() => (window as any).__promptTest.clipboard)).toBe(
			`System instructions\n\n${sentSystem}\n\nUser-role context\n\n${sentContext}`,
		);
		expect(await page.evaluate(() => (window as any).__promptTest.executions)).toEqual([]);
		expect(errors).toEqual([]);
	});
}
