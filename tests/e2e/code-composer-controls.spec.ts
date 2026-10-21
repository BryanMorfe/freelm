import { selectConversationMode } from './helpers/conversation-mode';
import { expect, test, type Page } from '@playwright/test';
import { initialState } from '../../src/lib/state';
import { defaultToolSettings } from '../../src/lib/tool-settings';
import { toolApiName } from '../../src/lib/agent';
import type { ToolApproval } from '../../src/agent-types';
import type { AppState } from '../../src/types';

// Chrome protocol calls on this host can take several seconds per interaction.
test.setTimeout(300_000);
test.use({ actionTimeout: 30_000 });

async function fixture(page: Page, options: { approvals?: boolean; debug?: boolean } = {}) {
	const state = initialState();
	state.debugMode = options.debug === true;
	state.connections[0].models.chat = 'test-model';
	state.connections[0].catalog = [
		{
			id: 'test-model',
			name: 'Test model',
			enabled: true,
			tasks: ['chat'],
			inputModalities: ['text'],
			outputModalities: ['text'],
			thinkingModes: [
				{ id: 'low', name: 'Low', parameters: { responses: { reasoning: { effort: 'low' } } } },
			],
		},
	];
	state.toolSettings = defaultToolSettings();
	state.projects = [
		{ id: 'chat-project', kind: 'chat', name: 'Ideas', instructions: '', createdAt: 1 },
		{
			id: 'code-project',
			kind: 'code',
			name: 'Repository',
			directories: ['/tmp/repository'],
			instructions: '',
			createdAt: 1,
		},
	];
	state.threads = [
		{
			id: 'code-task',
			kind: 'code',
			title: 'Existing task',
			projectId: 'code-project',
			connectionId: state.activeConnectionId,
			model: 'test-model',
			thinkingMode: 'low',
			createdAt: 1,
			updatedAt: 1,
			messages: [{ id: 'question', role: 'user', content: 'A coding task', createdAt: 1 }],
		},
	];
	if (options.approvals) {
		state.threads[0].messages.push({
			id: 'answer',
			role: 'assistant',
			content: 'Ready to inspect the repository.',
			createdAt: 2,
			completedAt: 2,
		});
		state.threads.push({
			...state.threads[0],
			id: 'other-task',
			title: 'Other task',
			messages: [],
		});
	}
	await page.addInitScript(
		({ serialized, approvals, commandName }) => {
			const initial = JSON.parse(serialized) as AppState;
			const states: Record<string, AppState> = JSON.parse(
				sessionStorage.getItem('code-composer-state') || 'null',
			) || {
				local: structuredClone(initial),
				remote: structuredClone(initial),
			};
			let revision = 0;
			const chunkListeners = new Set<(event: { id: string; text: string }) => void>();
			const approvalListeners = new Set<(approval: ToolApproval) => void>();
			const requests: any[] = [];
			const calls: any[] = [];
			const decisions: any[] = [];
			const cancellations: string[] = [];
			const control = { states, requests, calls, decisions, cancellations } as any;
			(window as any).__codeComposer = control;
			control.finishRound = (index: number, text: string, command?: string) => {
				const round = requests[index];
				const output: any[] = [];
				if (text)
					output.push({
						type: 'message',
						role: 'assistant',
						content: [{ type: 'output_text', text }],
					});
				if (command)
					output.push({
						type: 'function_call',
						call_id: `command-${index}`,
						name: commandName,
						arguments: JSON.stringify({
							cmd: command,
							workdir: '/tmp/repository',
							yield_time_ms: 1000,
						}),
					});
				round.emit({ type: 'response.completed', response: { status: 'completed', output } });
				round.resolve({
					status: 200,
					contentType: 'text/event-stream',
					encoding: 'text',
					body: '',
				});
			};
			const emitApproval = (approval: ToolApproval) => {
				for (const listener of approvalListeners) listener(approval);
			};
			const snapshot = (id: string) => ({
				state: structuredClone(states[id]),
				revision: String(revision),
			});
			(window as any).desktop = {
				platform: 'linux',
				workspaceLoad: async (id: string) => snapshot(id),
				workspaceSave: async (id: string, _revision: string, next: AppState) => {
					states[id] = structuredClone(next);
					sessionStorage.setItem('code-composer-state', JSON.stringify(states));
					return { revision: String(++revision) };
				},
				storageInfo: async () => ({ secure: false, location: '/test/.freelm/config.json' }),
				onPrepareClose: () => () => {},
				onToolApproval: (listener: (approval: ToolApproval) => void) => {
					approvalListeners.add(listener);
					return () => approvalListeners.delete(listener);
				},
				onChunk: (listener: (event: { id: string; text: string }) => void) => {
					chunkListeners.add(listener);
					return () => chunkListeners.delete(listener);
				},
				toolCatalog: async () => ({
					tools: [
						{
							name: 'exec_command',
							description: 'A mocked repository command.',
							source: 'builtin',
							parameters: {
								type: 'object',
								properties: {
									cmd: { type: 'string' },
									workdir: { type: 'string' },
									yield_time_ms: { type: 'number' },
								},
								required: ['cmd'],
							},
						},
					],
					instructions: '',
					warnings: [],
				}),
				toolExecute: async (request: any) => {
					if (!approvals) throw new Error('This UI test must not execute tools.');
					return new Promise((resolve, reject) => {
						const approval: ToolApproval = {
							id: `approval-${calls.length}`,
							runId: request.runId,
							threadId: request.threadId,
							name: request.name,
							arguments: request.arguments,
							effectiveDirectory: '/tmp/repository',
							message: 'FreeLM needs your approval to run this command.',
							rememberLabel: 'Allow commands for this task',
							permissionMode: 'ask',
						};
						calls.push({ ...request, approval, resolve, reject, settled: false });
						emitApproval(approval);
					});
				},
				toolApprove: async (id: string, approved: boolean, remember?: boolean) => {
					decisions.push({ id, approved, ...(remember ? { remember } : {}) });
					const call = calls.find((item) => item.approval.id === id);
					if (!call || call.settled) throw new Error('Unexpected approval decision.');
					call.settled = true;
					call.resolve({
						content: [
							{ type: 'text', text: approved ? 'Mock command output.' : 'Permission declined.' },
						],
						...(approved
							? { process: { command: call.arguments.cmd, sessionId: 'mock-process', exitCode: 0 } }
							: { isError: true }),
					});
				},
				toolCancel: async (runId: string) => {
					cancellations.push(runId);
					for (const call of calls.filter((item) => item.runId === runId && !item.settled)) {
						call.settled = true;
						emitApproval({ ...call.approval, cancelled: true });
						call.reject(new DOMException('Cancelled', 'AbortError'));
					}
				},
				cancel: async (id: string) =>
					requests
						.find((round) => round.id === id)
						?.reject(new DOMException('Cancelled', 'AbortError')),
				request: async (request: any) => {
					if (request.body.instructions?.startsWith('Write a short conversation title'))
						return {
							status: 200,
							contentType: 'application/json',
							encoding: 'text',
							body: JSON.stringify({ output_text: 'Repository task' }),
						};
					return new Promise((resolve, reject) => {
						const emit = (data: unknown) => {
							for (const listener of chunkListeners)
								listener({ id: request.id, text: `data: ${JSON.stringify(data)}\n\n` });
						};
						requests.push({ id: request.id, emit, resolve, reject });
						emit({ type: 'response.reasoning_text.delta', delta: 'Inspecting the task.' });
					});
				},
				toolPickDirectory: async () => '/tmp/chosen-project',
				instanceOpen: async (id: string) => snapshot(id),
				instanceStatus: async () => ({
					host: { running: false, name: 'This computer', instanceId: 'local', port: 4319 },
					instances: [
						{
							id: 'remote',
							name: 'Workstation',
							transport: 'direct',
							url: 'http://127.0.0.1:4319',
							connected: true,
							hasToken: true,
						},
					],
				}),
			};
		},
		{
			serialized: JSON.stringify(state),
			approvals: options.approvals === true,
			commandName: toolApiName('exec_command'),
		},
	);
	await page.goto('/');
	await expect(page).toHaveTitle('FreeLM');
	await expect(page.locator('vite-error-overlay')).toHaveCount(0);
	await expect(page.getByRole('heading', { name: 'What’s on your mind?' })).toBeVisible();
	await selectConversationMode(page, 'Code');
}

test('Code has bottom composer context, three approval choices, project actions, and keyboard dismissal', async ({
	page,
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (entry) => {
		if (entry.type() === 'error') errors.push(entry.text());
	});
	await fixture(page);
	await expect(
		page.getByRole('heading', { name: 'What should we work on?', exact: true }),
	).toBeVisible();
	await expect(page.locator('.code-workspace .suggestions')).toHaveCount(0);
	await expect(page.locator('.code-project-setup')).toHaveCount(0);
	const permission = page.getByRole('combobox', { name: 'Code permissions', exact: true });
	await expect(permission).toContainText('Ask for approval');
	await permission.press('Enter');
	const menu = page.getByRole('listbox');
	await expect(menu.getByRole('option')).toHaveCount(3);
	await expect(menu).toContainText('If the review fails, the action is blocked.');
	await expect(menu).toContainText('this host’s files and network');
	await permission.press('ArrowDown');
	await permission.press('Enter');
	await expect(permission).toContainText('Approve for me');
	await permission.press('Enter');
	await permission.press('Escape');
	await expect(menu).toHaveCount(0);
	await expect(permission).toBeFocused();
	await permission.click();
	await page.getByRole('heading', { name: 'What should we work on?', exact: true }).click();
	await expect(menu).toHaveCount(0);
	const project = page.getByRole('combobox', { name: 'Code project', exact: true });
	const composer = page.getByRole('textbox', { name: 'Message', exact: true });
	await composer.fill('Keep this unsent task while choosing its project.');
	await project.click();
	await expect(menu.locator('[data-value=""]')).toHaveCount(0);
	await expect(menu.getByRole('separator')).toHaveCount(1);
	await expect(menu.locator('[data-value="chat-project"]')).toHaveCount(0);
	await expect(menu.locator('[data-value="code-project"]')).toContainText('/tmp/repository');
	await menu.locator('[data-value="code-project"]').click();
	await expect(project).toContainText('Repository');
	await expect(project).toHaveAttribute('title', 'Repository\n/tmp/repository');
	await expect(project.locator('svg.lucide-chevron-down')).toHaveCount(0);
	await expect(composer).toHaveText('Keep this unsent task while choosing its project.');
	await expect(
		page.getByRole('heading', { name: 'What should we work on in Repository?', exact: true }),
	).toBeVisible();
	await project.click();
	await menu.locator('[data-value="__edit_code_project__"]').click();
	await expect(page.getByRole('dialog').getByLabel('Project directories')).toHaveValue(
		'/tmp/repository',
	);
	await page.keyboard.press('Escape');
	await project.focus();
	await page.keyboard.press('Tab');
	const clearProject = page.getByRole('button', { name: 'Clear project', exact: true });
	await expect(clearProject).toBeFocused();
	await clearProject.press('Enter');
	await expect(project).toContainText('Choose project');
	await expect(clearProject).toHaveCount(0);
	await expect(composer).toHaveText('Keep this unsent task while choosing its project.');
	await project.press('Enter');
	await project.press('Home');
	await project.press('Enter');
	await expect(project).toContainText('Repository');
	await project.click();
	await menu.locator('[data-value="__new_code_project__"]').click();
	await expect(page.getByRole('dialog').getByLabel('Project directories')).toBeVisible();
	await page.keyboard.press('Escape');
	await page.emulateMedia({ reducedMotion: 'reduce' });
	for (const width of [1440, 720]) {
		await page.setViewportSize({ width, height: 780 });
		const layout = await page.locator('.code-workspace').evaluate((workspace) => {
			const area = workspace.querySelector('.composer-area')!.getBoundingClientRect();
			const composer = workspace.querySelector('.composer')!.getBoundingClientRect();
			const controls = [
				...workspace.querySelectorAll('.composer-toolbar button, .code-context-bar button'),
			].map((control) => control.getBoundingClientRect());
			const project = workspace.querySelector('.code-context-project')!.getBoundingClientRect();
			const host = workspace.querySelector('.code-context-host')!.getBoundingClientRect();
			return {
				bottomGap: workspace.getBoundingClientRect().bottom - area.bottom,
				composerLeft: composer.left,
				composerRight: composer.right,
				minLeft: Math.min(...controls.map((rect) => rect.left)),
				maxRight: Math.max(...controls.map((rect) => rect.right)),
				overflow: workspace.scrollWidth - workspace.clientWidth,
				hostGap: host.left - project.right,
			};
		});
		expect(layout.bottomGap).toBeLessThan(2);
		expect(layout.minLeft).toBeGreaterThanOrEqual(layout.composerLeft - 1);
		expect(layout.maxRight).toBeLessThanOrEqual(layout.composerRight + 1);
		expect(layout.overflow).toBeLessThanOrEqual(1);
		expect(layout.hostGap).toBeGreaterThanOrEqual(0);
		expect(layout.hostGap).toBeLessThanOrEqual(14);
		await permission.click();
		await expect(menu).toBeVisible();
		const bounds = await menu.boundingBox();
		expect(bounds!.x).toBeGreaterThanOrEqual(0);
		expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
		expect(bounds!.y).toBeGreaterThanOrEqual(0);
		expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(780);
		await page.keyboard.press('Escape');
	}
	expect(errors).toEqual([]);
});

test('task permission selection persists and remote host controls reflect read-only settings', async ({
	page,
}) => {
	await fixture(page);
	await page.getByTitle('Existing task', { exact: true }).click();
	await expect(page.locator('.code-context-bar')).toHaveCount(0);
	await expect(page.getByRole('combobox', { name: 'Code project', exact: true })).toHaveCount(0);
	await expect(page.getByRole('navigation', { name: 'Code projects', exact: true })).toContainText(
		'Repository',
	);
	await expect(page.getByRole('button', { name: 'Clear project', exact: true })).toHaveCount(0);
	const permission = page.getByRole('combobox', { name: 'Code permissions', exact: true });
	await permission.click();
	await page.getByRole('listbox').locator('[data-value="full-access"]').click();
	await expect
		.poll(() =>
			page.evaluate(() => (window as any).__codeComposer.states.local.threads[0].permissionMode),
		)
		.toBe('full-access');
	await page.reload();
	await selectConversationMode(page, 'Code');
	await page.getByTitle('Existing task', { exact: true }).click();
	await expect(permission).toContainText('Full access');
	await page.getByRole('button', { name: 'New task', exact: true }).click();
	await expect(page.getByRole('combobox', { name: 'Code project', exact: true })).toBeVisible();
	await page.getByRole('combobox', { name: 'Code execution host', exact: true }).click();
	await page.getByRole('listbox').locator('[data-value="remote"]').click();
	await expect(page.locator('.code-workspace')).toBeVisible();
	await expect(
		page.getByRole('combobox', { name: 'Code execution host', exact: true }),
	).toContainText('Workstation');
	await expect(permission).toBeDisabled();
	await page.getByTitle('Existing task', { exact: true }).click();
	await expect(page.locator('.code-context-bar')).toHaveCount(0);
	await expect(page.getByRole('combobox', { name: 'Code project', exact: true })).toHaveCount(0);
	await expect(page.getByRole('navigation', { name: 'Code projects', exact: true })).toContainText(
		'Repository',
	);
});

const pendingCommand = "printf 'a  b\\n'\ncat README.md";
const unsentDraft = 'Keep this draft until the repository inspection finishes.';

async function stageApproval(page: Page) {
	await page.getByTitle('Existing task', { exact: true }).click();
	const composer = page.getByRole('textbox', { name: 'Message', exact: true });
	await composer.fill(unsentDraft);
	await page.locator('.composer input[type="file"]').setInputFiles({
		name: 'draft-notes.txt',
		mimeType: 'text/plain',
		buffer: Buffer.from('These notes belong to the unsent draft.'),
	});
	await expect(page.locator('.attachment-preview')).toContainText('draft-notes.txt');
	await page.locator('.message.assistant').hover();
	await page.getByRole('button', { name: 'Regenerate response', exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => (window as any).__codeComposer.requests.length))
		.toBe(1);
	await page.evaluate(
		(command) =>
			(window as any).__codeComposer.finishRound(0, 'I will read the repository README.', command),
		pendingCommand,
	);
	await expect(
		page.getByRole('region', { name: 'Pending tool approvals', exact: true }),
	).toBeVisible();
}

test('pending Code approval leaves the composer editable, stays scoped to its task, and preserves unsent draft and attachment', async ({
	page,
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (entry) => {
		if (entry.type() === 'error') errors.push(entry.text());
	});
	await fixture(page, { approvals: true });
	await stageApproval(page);
	const approval = page.getByRole('region', { name: 'Pending tool approvals', exact: true });
	const composer = page.getByRole('textbox', { name: 'Message', exact: true });
	await expect(page.locator('.composer-area > .composer-approval')).toBeVisible();
	await expect(composer).toBeVisible();
	await expect(composer).toBeEditable();
	await expect(page.getByRole('button', { name: 'Attach files', exact: true })).toBeEnabled();
	await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
	await expect(page.getByRole('button', { name: 'Queue message', exact: true })).toHaveCount(0);
	await expect(
		page
			.locator('.composer:not(.composer-approval)')
			.getByRole('button', { name: 'Stop response', exact: true }),
	).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Chat model', exact: true })).toBeEnabled();
	await expect(page.getByRole('combobox', { name: 'Code permissions', exact: true })).toBeEnabled();
	await expect(page.locator('.code-context-bar')).toHaveCount(0);
	await expect(approval).toContainText('/tmp/repository');
	await expect(approval.locator('code').filter({ hasText: 'printf' })).toHaveText(pendingCommand);
	await expect(approval.getByLabel('Arguments for exec_command', { exact: true })).toHaveCount(0);
	await expect(approval).not.toContainText('yield_time_ms');
	await expect(approval.getByRole('button', { name: 'Allow once', exact: true })).toBeVisible();
	await expect(
		approval.getByRole('button', { name: 'Allow commands for this task', exact: true }),
	).toBeVisible();
	await expect(approval.getByRole('button', { name: 'Decline', exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(approval).toBeVisible();
	await expect
		.poll(() => page.evaluate(() => (window as any).__codeComposer.decisions))
		.toEqual([]);
	await page.getByRole('button', { name: 'Other task', exact: true }).click();
	await expect(approval).toHaveCount(0);
	await expect(composer).toBeVisible();
	await expect(composer).not.toContainText(unsentDraft);
	await page.getByTitle('Existing task', { exact: true }).click();
	await expect(approval).toBeVisible();
	await expect(composer).toBeEditable();
	await expect(composer).toHaveText(unsentDraft);
	await expect
		.poll(() => page.evaluate(() => (window as any).__codeComposer.decisions))
		.toEqual([]);
	for (const width of [1440, 720]) {
		await page.setViewportSize({ width, height: 800 });
		const bounds = await approval.boundingBox();
		expect(bounds!.x).toBeGreaterThanOrEqual(0);
		expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
		const overflow = await page
			.locator('.code-workspace')
			.evaluate((el) => el.scrollWidth - el.clientWidth);
		expect(overflow).toBeLessThanOrEqual(1);
		await page.screenshot({ path: `/tmp/freelm-code-approval-1319-${width}.png` });
	}
	await approval.getByRole('button', { name: 'Allow once', exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => (window as any).__codeComposer.decisions))
		.toEqual([{ id: 'approval-0', approved: true }]);
	await expect(approval).toHaveCount(0);
	await expect(composer).toBeVisible();
	await expect(composer).toHaveText(unsentDraft);
	await expect(page.locator('.attachment-preview')).toContainText('draft-notes.txt');
	await expect
		.poll(() => page.evaluate(() => (window as any).__codeComposer.requests.length))
		.toBe(2);
	await page.evaluate(() =>
		(window as any).__codeComposer.finishRound(1, 'The repository inspection is complete.'),
	);
	await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toHaveCount(0);
	await page.getByRole('button', { name: 'Other task', exact: true }).click();
	await page.getByTitle('Existing task', { exact: true }).click();
	await expect(composer).toHaveText(unsentDraft);
	await expect(page.locator('.attachment-preview')).toContainText('draft-notes.txt');
	await expect
		.poll(() =>
			page.evaluate(
				() => (window as any).__codeComposer.states.local.chatDrafts['code-task'].content,
			),
		)
		.toBe(unsentDraft);
	expect(errors).toEqual([]);
});

test('Code approval decline is explicit and cancelling an empty pending approval does not approve it', async ({
	page,
}) => {
	await fixture(page, { approvals: true });
	await stageApproval(page);
	const approval = page.getByRole('region', { name: 'Pending tool approvals', exact: true });
	await approval.getByRole('button', { name: 'Decline', exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => (window as any).__codeComposer.decisions))
		.toEqual([{ id: 'approval-0', approved: false }]);
	await expect(approval).toHaveCount(0);
	await expect
		.poll(() => page.evaluate(() => (window as any).__codeComposer.requests.length))
		.toBe(2);
	await page.evaluate(
		(command) =>
			(window as any).__codeComposer.finishRound(1, 'Another command requires approval.', command),
		pendingCommand,
	);
	await expect(approval).toBeVisible();
	const composer = page.getByRole('textbox', { name: 'Message', exact: true });
	await composer.fill('');
	await page.getByRole('button', { name: 'Remove draft-notes.txt', exact: true }).click();
	await page.getByRole('button', { name: 'Stop response', exact: true }).click();
	await expect(approval).toHaveCount(0);
	await composer.fill(unsentDraft);
	await page.locator('.composer input[type="file"]').setInputFiles({
		name: 'draft-notes.txt',
		mimeType: 'text/plain',
		buffer: Buffer.from('These notes belong to the unsent draft.'),
	});
	await expect(composer).toHaveText(unsentDraft);
	await expect(page.locator('.attachment-preview')).toContainText('draft-notes.txt');
	await expect(page.getByText('Response stopped.', { exact: true })).toBeVisible();
	await expect
		.poll(() => page.evaluate(() => (window as any).__codeComposer.decisions.length))
		.toBe(1);
	await expect
		.poll(() =>
			page.evaluate(() => (window as any).__codeComposer.calls.every((call: any) => call.settled)),
		)
		.toBe(true);
});

test('Code approval exposes raw arguments only in Debug and task allowance uses its own explicit decision', async ({
	page,
}) => {
	await fixture(page, { approvals: true, debug: true });
	await stageApproval(page);
	const approval = page.getByRole('region', { name: 'Pending tool approvals', exact: true });
	const raw = approval.getByLabel('Arguments for exec_command', { exact: true });
	await expect(raw).not.toBeVisible();
	await approval.locator('summary').click();
	await expect(raw).toBeVisible();
	await expect(raw).toContainText('yield_time_ms');
	await approval.getByRole('button', { name: 'Allow commands for this task', exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => (window as any).__codeComposer.decisions))
		.toEqual([{ id: 'approval-0', approved: true, remember: true }]);
	await expect(approval).toHaveCount(0);
	await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveText(unsentDraft);
	await expect
		.poll(() => page.evaluate(() => (window as any).__codeComposer.requests.length))
		.toBe(2);
	await page.evaluate(() =>
		(window as any).__codeComposer.finishRound(1, 'The explicit task allowance is complete.'),
	);
	await expect(page.locator('.message.assistant').last()).toContainText(
		'The explicit task allowance is complete.',
	);
});
