import { selectConversationMode } from './helpers/conversation-mode';
import { expect, test, type Page } from '@playwright/test';
import { initialState } from '../../src/lib/state';
import { defaultToolSettings } from '../../src/lib/tool-settings';
import { toolApiName } from '../../src/lib/agent';
import type { AppState } from '../../src/types';

// Browser plugin is unavailable. Exercise the actual App with Playwright and an
// isolated in-memory desktop bridge: no native apps, profiles, or providers.
const pixel =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lT0AAAAASUVORK5CYII=';
const browserIssues = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
	const issues: string[] = [];
	browserIssues.set(page, issues);
	page.on('console', (message) => {
		if (['warning', 'error'].includes(message.type()))
			issues.push(`${message.type()}: ${message.text()}`);
	});
	page.on('pageerror', (error) => issues.push(error.message));
});
test.afterEach(({ page }) => expect(browserIssues.get(page)).toEqual([]));

async function fixture(page: Page, setupRequired = false) {
	const state = initialState();
	state.toolSettings = defaultToolSettings();
	state.connections[0].models.chat = 'computer-test';
	state.connections[0].catalog = [
		{
			id: 'computer-test',
			name: 'Computer test model',
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
			id: 'computer-project',
			kind: 'code',
			name: 'Computer project',
			directories: ['/tmp/computer-ui-fixture'],
			instructions: '',
			createdAt: 1,
		},
	];
	state.threads = ['computer-task', 'other-task'].map((id) => ({
		id,
		kind: 'code',
		title: id === 'computer-task' ? 'Computer task' : 'Other task',
		titleSource: 'manual',
		projectId: 'computer-project',
		connectionId: state.activeConnectionId,
		model: 'computer-test',
		thinkingMode: 'low',
		permissionMode: 'ask',
		createdAt: 1,
		updatedAt: 1,
		messages: [
			{ id: `${id}-user`, role: 'user', content: 'An existing task', createdAt: 1 },
			{
				id: `${id}-assistant`,
				role: 'assistant',
				content: 'Ready for another step.',
				createdAt: 2,
				completedAt: 2,
			},
		],
	}));
	await page.addInitScript(
		({ serialized, icon, apiName, setupRequired }) => {
			let current: AppState = JSON.parse(sessionStorage.getItem('computer-ui-state') || serialized),
				revision = 0;
			const approvals = new Set<(value: any) => void>(),
				chunks = new Set<(value: any) => void>(),
				previews = new Set<(value: any) => void>();
			const control: any = {
				requests: [],
				calls: [],
				decisions: [],
				discovery: [],
				stopped: [],
				cancelled: [],
				events: [],
				setup: [],
				setupRequired,
				status: {
					platform: 'darwin',
					available: true,
					accessibility: false,
					screenRecording: false,
					message: 'Test helper requires access.',
				},
				state: () => current,
				sessions: [],
			};
			(window as any).__computerUI = control;
			const app = { id: 'com.example.Notes', name: 'Notes', icon };
			control.finishToolRound = () => {
				const request = control.requests[0];
				const output = [
					{
						type: 'function_call',
						call_id: 'open-notes',
						name: apiName,
						arguments: JSON.stringify({ appId: app.id }),
					},
				];
				request.emit({ type: 'response.completed', response: { status: 'completed', output } });
				request.resolve({
					status: 200,
					contentType: 'text/event-stream',
					encoding: 'text',
					body: '',
				});
			};
			control.preview = (status = 'active', threadId = 'computer-task') => {
				const value = {
					sessionId: 'notes-session',
					runId: 'test-run',
					threadId,
					app,
					status,
					image: { dataUrl: icon, width: 1, height: 1 },
					windowTitle: 'Test note',
					updatedAt: Date.now(),
				};
				control.sessions = [value];
				for (const listener of previews) listener(value);
			};
			(window as any).desktop = {
				platform: 'darwin',
				workspaceLoad: async () => ({
					state: structuredClone(current),
					revision: String(revision),
				}),
				workspaceSave: async (_id: string, _revision: string, next: AppState) => {
					current = structuredClone(next);
					sessionStorage.setItem('computer-ui-state', JSON.stringify(current));
					return { revision: String(++revision) };
				},
				storageInfo: async () => ({ secure: false, location: 'Private Computer Use fixture' }),
				onPrepareClose: () => () => {},
				onToolApproval: (listener: (value: any) => void) => {
					approvals.add(listener);
					return () => approvals.delete(listener);
				},
				onChunk: (listener: (value: any) => void) => {
					chunks.add(listener);
					return () => chunks.delete(listener);
				},
				onComputerPreview: (listener: (value: any) => void) => {
					previews.add(listener);
					return () => previews.delete(listener);
				},
				computerSessions: async () => control.sessions,
				computerStatus: async () => structuredClone(control.status),
				computerSetup: async (action: string) => {
					control.setup.push(action);
					return structuredClone(control.status);
				},
				computerStop: async (id: string) => {
					control.events.push('computer-stop');
					control.stopped.push(id);
					control.preview('stopped');
				},
				instanceStatus: async () => ({
					host: { running: false, name: 'Local', instanceId: 'local', port: 4319 },
					instances: [],
				}),
				composerDiscover: async (request: any) => {
					control.discovery.push(request);
					const all = [
						{
							kind: 'app',
							id: 'computer-use',
							label: 'Computer Use',
							path: 'computer-use',
							description: 'Control apps on this computer',
						},
						{
							kind: 'app',
							id: app.id,
							label: 'Notes',
							path: app.id,
							icon,
							description: 'Computer Use',
						},
					];
					return {
						items:
							request.kind === 'apps' || request.kind === 'files'
								? all.filter((item) =>
										item.label.toLowerCase().includes(request.query.toLowerCase()),
									)
								: [],
					};
				},
				composerResolve: async () => ({
					instructions: 'The user mentioned Notes. Mentions are not permission grants.',
					warnings: [],
				}),
				toolCatalog: async () => ({
					tools: [
						{
							name: 'computer_open',
							description: 'Request app access.',
							source: 'builtin',
							parameters: {
								type: 'object',
								properties: { appId: { type: 'string' } },
								required: ['appId'],
							},
						},
					],
					instructions: '',
					warnings: [],
				}),
				toolExecute: (request: any) =>
					new Promise((resolve) => {
						const approval = {
							id: 'computer-approval',
							runId: request.runId,
							threadId: request.threadId,
							name: request.name,
							arguments: request.arguments,
							permissionMode: 'ask',
							message: 'Allow app access for this run.',
							computer: {
								app,
								scope: 'run',
								...(control.setupRequired ? { setup: structuredClone(control.status) } : {}),
							},
						};
						control.calls.push({ ...request, approval, resolve });
						for (const listener of approvals) listener(approval);
					}),
				toolApprove: async (id: string, approved: boolean) => {
					control.decisions.push({ id, approved });
					control.calls
						.find((call: any) => call.approval.id === id)
						?.resolve({
							content: [
								{ type: 'text', text: approved ? 'App access approved.' : 'App access declined.' },
							],
							...(approved ? {} : { isError: true, approvalDenied: true }),
						});
				},
				toolCancel: async () => {},
				cancel: async (id: string) => {
					control.events.push('response-cancel');
					control.cancelled.push(id);
					control.requests
						.find((request: any) => request.id === id)
						?.reject(new DOMException('Stopped', 'AbortError'));
				},
				request: async (request: any) => {
					if (control.requests.length)
						return {
							status: 200,
							contentType: 'application/json',
							encoding: 'text',
							body: JSON.stringify({ output_text: 'Finished the fixture turn.' }),
						};
					return new Promise((resolve, reject) => {
						const emit = (value: unknown) => {
							for (const listener of chunks)
								listener({ id: request.id, text: `data: ${JSON.stringify(value)}\n\n` });
						};
						control.requests.push({ ...request, resolve, reject, emit });
						emit({
							type: 'response.reasoning_text.delta',
							delta: 'Preparing to request app access.',
						});
					});
				},
			};
		},
		{
			serialized: JSON.stringify(state),
			icon: pixel,
			apiName: toolApiName('computer_open'),
			setupRequired,
		},
	);
	await page.goto('/');
	await expect(page).toHaveTitle('FreeLM');
	await expect(page.locator('vite-error-overlay')).toHaveCount(0);
	await selectConversationMode(page, 'Code');
	await page.getByRole('button', { name: /^(?:Responding )?Computer task$/ }).click();
	await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
}

async function draft(page: Page) {
	return page.evaluate(() => (window as any).__computerUI.state().chatDrafts?.['computer-task']);
}

async function approval(page: Page, setupRequired = false) {
	const editor = page.getByRole('textbox', { name: 'Message', exact: true });
	await editor.fill('Use Notes to inspect the test note.');
	await editor.press('Enter');
	await expect
		.poll(() => page.evaluate(() => (window as any).__computerUI.requests.length))
		.toBe(1);
	await editor.fill('Preserve this unsent follow-up.');
	await expect
		.poll(async () => (await draft(page))?.content)
		.toBe('Preserve this unsent follow-up.');
	await page.evaluate(() => (window as any).__computerUI.finishToolRound());
	await expect(
		page.getByRole('region', {
			name: setupRequired ? 'Set up computer access for Notes' : 'Authorize Notes',
		}),
	).toBeVisible();
	await expect(editor).toBeHidden();
}

test('Code app mentions show icons and persist across navigation and reload; Chat has no app picker', async ({
	page,
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await fixture(page);
	const editor = page.getByRole('textbox', { name: 'Message', exact: true });
	await editor.fill('@');
	const apps = page.getByRole('option', { name: 'Apps Use an app on this computer' });
	const alignment = await apps.evaluate((row) => {
		const icon = row.querySelector('svg')!.getBoundingClientRect();
		const label = row.querySelector('.composer-completion-label')!.getBoundingClientRect();
		return Math.abs(icon.y + icon.height / 2 - (label.y + label.height / 2));
	});
	expect(alignment).toBeLessThanOrEqual(1);
	await apps.click();
	await expect(
		page.getByRole('option', { name: 'Computer Use Control apps on this computer' }),
	).toBeVisible();
	await page.getByRole('option', { name: 'Notes Computer Use' }).click();
	await expect(page.locator('.cm-composer-mention-app')).toHaveText('Notes');
	await expect(page.locator('.cm-composer-mention-app img')).toHaveAttribute('src', pixel);
	await expect
		.poll(async () => (await draft(page))?.composer?.references?.[0]?.id)
		.toBe('com.example.Notes');
	await page.getByRole('button', { name: 'Other task', exact: true }).click();
	await page.getByRole('button', { name: /^(?:Responding )?Computer task$/ }).click();
	await expect(page.locator('.cm-composer-mention-app img')).toHaveAttribute('src', pixel);
	await page.reload();
	await selectConversationMode(page, 'Code');
	await page.getByRole('button', { name: /^(?:Responding )?Computer task$/ }).click();
	await expect(page.locator('.cm-composer-mention-app')).toHaveText('Notes');
	await editor.fill('@Notes');
	await expect(page.getByRole('option', { name: 'Notes Computer Use' })).toBeVisible();
	await expect(page.getByRole('listbox', { name: 'Composer suggestions' })).toContainText(
		'Suggestions',
	);
	for (const width of [1440, 720]) {
		await page.setViewportSize({ width, height: 900 });
		const box = await page.getByRole('listbox', { name: 'Composer suggestions' }).boundingBox();
		expect(box!.x).toBeGreaterThanOrEqual(0);
		expect(box!.x + box!.width).toBeLessThanOrEqual(width);
		const iconAlignment = await page
			.getByRole('option', { name: 'Notes Computer Use' })
			.evaluate((row) => {
				const icon = row.querySelector('img')!.getBoundingClientRect();
				const label = row.querySelector('.composer-completion-label')!.getBoundingClientRect();
				return Math.abs(icon.y + icon.height / 2 - (label.y + label.height / 2));
			});
		expect(iconAlignment).toBeLessThanOrEqual(1);
		await page.screenshot({
			path: `/tmp/freelm-computer-mentions-${width}.png`,
			animations: 'disabled',
		});
	}
	await editor.press('Escape');
	await page.setViewportSize({ width: 1440, height: 940 });
	await selectConversationMode(page, 'Chat');
	await editor.fill('@Notes');
	await expect(page.getByRole('listbox', { name: 'Composer suggestions' })).toHaveCount(0);
	await expect
		.poll(() => page.evaluate(() => (window as any).__computerUI.requests.length))
		.toBe(0);
	expect(errors).toEqual([]);
});

test('empty Outputs and Sources share one compact explanation', async ({ page }) => {
	await fixture(page);
	for (const width of [1440, 720]) {
		await page.setViewportSize({ width, height: 900 });
		const empty = page.locator('.conversation-summary-empty');
		await expect(
			empty.getByRole('heading', { name: 'Outputs & sources', exact: true }),
		).toBeVisible();
		await expect(
			empty.getByText('Created files and referenced sources appear here.'),
		).toBeVisible();
		await expect(page.getByRole('region', { name: 'Outputs', exact: true })).toHaveCount(0);
		const size = await empty.evaluate((node) => ({
			height: node.getBoundingClientRect().height,
			fontSize: Number.parseFloat(getComputedStyle(node.querySelector('h2')!).fontSize),
		}));
		expect(size.height).toBeLessThan(100);
		expect(size.fontSize).toBeGreaterThanOrEqual(13);
		await page.screenshot({
			path: `/tmp/freelm-empty-summary-${width}.png`,
			animations: 'disabled',
		});
	}
});

for (const approve of [true, false])
	test(`Computer authorization ${approve ? 'approval' : 'denial'} replaces the composer and preserves its draft`, async ({
		page,
	}) => {
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await fixture(page);
		await approval(page);
		await page.getByRole('button', { name: 'Other task', exact: true }).click();
		await expect(page.getByRole('region', { name: 'Authorize Notes' })).toHaveCount(0);
		await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
		await selectConversationMode(page, 'Chat');
		await expect(page.getByRole('region', { name: 'Authorize Notes' })).toHaveCount(0);
		await selectConversationMode(page, 'Code');
		await page.getByRole('button', { name: /^(?:Responding )?Computer task$/ }).click();
		await expect(page.getByRole('region', { name: 'Authorize Notes' })).toBeVisible();
		for (const width of [1440, 720]) {
			await page.setViewportSize({ width, height: 900 });
			const box = await page.getByRole('region', { name: 'Authorize Notes' }).boundingBox();
			expect(box!.x).toBeGreaterThanOrEqual(0);
			expect(box!.x + box!.width).toBeLessThanOrEqual(width);
			await expect(page.getByRole('button', { name: 'Authorize computer use' })).toBeVisible();
			await page.screenshot({
				path: `/tmp/freelm-computer-authorization-${approve}-${width}.png`,
				animations: 'disabled',
			});
		}
		await page
			.getByRole('button', {
				name: approve ? 'Authorize computer use' : 'Don’t allow',
				exact: true,
			})
			.click();
		await expect(page.getByRole('region', { name: 'Authorize Notes' })).toHaveCount(0);
		await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveText(
			'Preserve this unsent follow-up.',
		);
		await expect
			.poll(() => page.evaluate(() => (window as any).__computerUI.decisions))
			.toEqual([{ id: 'computer-approval', approved: approve }]);
		expect(errors).toEqual([]);
	});

test('app previews are task-scoped and stop closes access without navigating away', async ({
	page,
}) => {
	await fixture(page);
	await page.evaluate(() => (window as any).__computerUI.preview());
	const preview = page.getByRole('region', { name: 'Computer Use apps' });
	await expect(preview).toBeVisible();
	await expect(preview.getByText('Active', { exact: true })).toBeVisible();
	await preview.getByRole('button', { name: 'View Notes preview' }).click();
	await expect(page.getByRole('dialog', { name: 'Notes preview' })).toBeVisible();
	await page.getByRole('button', { name: 'Close preview' }).click();
	await page.getByRole('button', { name: 'Other task', exact: true }).click();
	await expect(preview).toHaveCount(0);
	await page.getByRole('button', { name: /^(?:Responding )?Computer task$/ }).click();
	await expect(preview).toBeVisible();
	await preview.getByRole('button', { name: 'Stop computer use' }).click();
	await expect(preview.getByText('Finished', { exact: true })).toBeVisible();
	await expect(preview.getByRole('button', { name: 'Stop computer use' })).toHaveCount(0);
	await expect
		.poll(() => page.evaluate(() => (window as any).__computerUI.stopped))
		.toEqual(['notes-session']);
});

test('Computer Use is off by default and setup actions route explicitly from settings', async ({
	page,
}) => {
	await fixture(page);
	await page.getByRole('button', { name: /Personal workspace/ }).click();
	const settings = page.getByRole('region', { name: 'Settings', exact: true });
	await settings.getByRole('button', { name: 'Tools', exact: true }).click();
	const toggle = settings.getByRole('switch', { name: 'Use apps on this computer' });
	await expect(toggle).not.toBeChecked();
	await settings.getByRole('button', { name: 'Check permissions' }).click();
	await expect(settings.getByText('Setup required', { exact: true })).toBeVisible();
	for (const label of ['Request permissions', 'Accessibility', 'Screen Recording', 'Reveal helper'])
		await settings.getByRole('button', { name: label, exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => (window as any).__computerUI.setup))
		.toEqual(['request', 'accessibility', 'screen-recording', 'helper']);
	for (const width of [1440, 720]) {
		await page.setViewportSize({ width, height: 900 });
		await toggle.scrollIntoViewIfNeeded();
		const box = await toggle.boundingBox();
		expect(box!.x + box!.width).toBeLessThanOrEqual(width);
		await page.screenshot({
			path: `/tmp/freelm-computer-settings-${width}.png`,
			animations: 'disabled',
		});
	}
	await toggle.click();
	await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
	await expect
		.poll(() =>
			page.evaluate(() => (window as any).__computerUI.state().toolSettings.computerUse.enabled),
		)
		.toBe(true);
});

test('Computer Use settings distinguish desktop conditions from permission setup and preserve unknown status', async ({
	page,
}) => {
	await fixture(page);
	await page.getByRole('button', { name: /Personal workspace/ }).click();
	const settings = page.getByRole('region', { name: 'Settings', exact: true });
	await settings.getByRole('button', { name: 'Tools', exact: true }).click();
	const scenarios = [
		{ flags: { screenLocked: true }, label: 'Mac is locked', guidance: 'Unlock it' },
		{
			flags: { sessionActive: false },
			label: 'User session is inactive',
			guidance: 'Switch back to this user session',
		},
		{ flags: { displaysAwake: false }, label: 'Displays are asleep', guidance: 'Wake a display' },
		{ flags: {}, label: 'Ready for Computer Use', guidance: null },
	];
	const computerSettings = settings.getByRole('region', { name: 'Computer Use', exact: true });
	for (const scenario of scenarios) {
		await page.evaluate((flags) => {
			(window as any).__computerUI.status = {
				platform: 'darwin',
				available: true,
				accessibility: true,
				screenRecording: true,
				...flags,
			};
		}, scenario.flags);
		await settings.getByRole('button', { name: 'Check permissions' }).click();
		await expect(settings.getByText(scenario.label, { exact: true })).toBeVisible();
		await expect(settings.getByText('Setup required', { exact: true })).toHaveCount(0);
		if (scenario.guidance)
			await expect(computerSettings.getByRole('status')).toContainText(scenario.guidance);
		if (scenario.label === 'Displays are asleep') {
			for (const width of [1440, 720]) {
				await page.setViewportSize({ width, height: 900 });
				const notice = computerSettings.getByRole('status');
				await notice.scrollIntoViewIfNeeded();
				const bounds = await notice.boundingBox();
				expect(bounds!.x).toBeGreaterThanOrEqual(0);
				expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
				await page.screenshot({
					path: `/tmp/freelm-computer-environment-${width}.png`,
					animations: 'disabled',
				});
			}
		}
	}
	expect(await page.evaluate(() => (window as any).__computerUI.setup)).toEqual([]);
});

test('permission setup does not continue or request new permissions while the desktop is unavailable', async ({
	page,
}) => {
	await fixture(page, true);
	await approval(page, true);
	const sheet = page.getByRole('region', { name: 'Set up computer access for Notes' });
	await page.evaluate(() => {
		(window as any).__computerUI.status = {
			platform: 'darwin',
			available: true,
			accessibility: true,
			screenRecording: true,
			sessionActive: false,
		};
	});
	await sheet.getByRole('button', { name: 'Check and continue', exact: true }).click();
	await expect(sheet.getByRole('heading', { name: 'User session is inactive' })).toBeVisible();
	await expect(sheet.getByText(/Switch back to this user session/)).toBeVisible();
	await expect(sheet.getByRole('button', { name: 'Request permissions' })).toHaveCount(0);
	expect(await page.evaluate(() => (window as any).__computerUI.decisions)).toEqual([]);
	expect(await page.evaluate(() => (window as any).__computerUI.setup)).toEqual([]);
	await page.evaluate(() => {
		(window as any).__computerUI.status.sessionActive = true;
	});
	await sheet.getByRole('button', { name: 'Check and continue', exact: true }).click();
	await expect(sheet).toHaveCount(0);
	expect(await page.evaluate(() => (window as any).__computerUI.decisions)).toEqual([
		{ id: 'computer-approval', approved: true },
	]);
});

test('missing computer permissions pause the task and only continue after the user sets up access', async ({
	page,
}) => {
	await fixture(page, true);
	await approval(page, true);
	const sheet = page.getByRole('region', { name: 'Set up computer access for Notes' });
	const controlState = () =>
		page.evaluate(() => {
			const control = (window as any).__computerUI;
			return { setup: control.setup, decisions: control.decisions };
		});
	expect(await controlState()).toEqual({ setup: [], decisions: [] });
	await sheet.getByRole('button', { name: 'Check and continue', exact: true }).click();
	await expect(sheet).toBeVisible();
	expect((await controlState()).decisions).toEqual([]);
	for (const label of ['Request permissions', 'Accessibility', 'Screen Recording'])
		await sheet.getByRole('button', { name: label, exact: true }).click();
	expect((await controlState()).setup).toEqual(['request', 'accessibility', 'screen-recording']);
	await page.getByRole('button', { name: 'Other task', exact: true }).click();
	await expect(sheet).toHaveCount(0);
	await selectConversationMode(page, 'Chat');
	await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
	await selectConversationMode(page, 'Code');
	await page.getByRole('button', { name: /^(?:Responding )?Computer task$/ }).click();
	await expect(sheet).toBeVisible();
	for (const width of [1440, 720]) {
		await page.setViewportSize({ width, height: 900 });
		await expect(sheet).toBeInViewport({ ratio: 1 });
		await expect(
			sheet.getByRole('button', { name: 'Check and continue', exact: true }),
		).toBeInViewport({ ratio: 1 });
		await page.screenshot({
			path: `/tmp/freelm-computer-permission-setup-${width}.png`,
			animations: 'disabled',
		});
	}
	await page.evaluate(() => {
		const control = (window as any).__computerUI;
		control.status = {
			platform: 'darwin',
			available: true,
			accessibility: true,
			screenRecording: false,
		};
	});
	await sheet.getByRole('button', { name: 'Check and continue', exact: true }).click();
	await expect(sheet).toBeVisible();
	expect((await controlState()).decisions).toEqual([]);
	await page.evaluate(() => {
		(window as any).__computerUI.status.screenRecording = true;
	});
	await sheet.getByRole('button', { name: 'Check and continue', exact: true }).click();
	await expect(sheet).toHaveCount(0);
	await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveText(
		'Preserve this unsent follow-up.',
	);
	expect((await controlState()).decisions).toEqual([{ id: 'computer-approval', approved: true }]);
});

test('canceling computer permission setup declines the request and restores the composer draft', async ({
	page,
}) => {
	await fixture(page, true);
	await approval(page, true);
	const sheet = page.getByRole('region', { name: 'Set up computer access for Notes' });
	await sheet.getByRole('button', { name: 'Cancel', exact: true }).click();
	await expect(sheet).toHaveCount(0);
	await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveText(
		'Preserve this unsent follow-up.',
	);
	expect(await page.evaluate(() => (window as any).__computerUI.decisions)).toEqual([
		{ id: 'computer-approval', approved: false },
	]);
	expect(await page.evaluate(() => (window as any).__computerUI.setup)).toEqual([]);
});

test('active computer access stays visible with Pinned summary hidden and Stop cancels the renderer run', async ({
	page,
}) => {
	await fixture(page);
	await page.getByRole('button', { name: 'Hide pinned summary', exact: true }).click();
	await expect(page.getByRole('complementary', { name: 'Pinned summary' })).toHaveCount(0);
	const editor = page.getByRole('textbox', { name: 'Message', exact: true });
	await editor.fill('Use @Notes');
	await page.getByRole('option', { name: 'Notes Computer Use' }).click();
	await editor.press('Enter');
	await expect
		.poll(() => page.evaluate(() => (window as any).__computerUI.requests.length))
		.toBe(1);
	await expect(page.locator('.message-composer-mention img')).toHaveAttribute('src', pixel);
	await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toBeVisible();
	await page.evaluate(() => (window as any).__computerUI.preview());
	const preview = page.getByRole('region', { name: 'Computer Use apps' });
	await expect(preview).toBeVisible();
	await expect(page.getByRole('button', { name: 'Show pinned summary' })).toHaveAttribute(
		'aria-pressed',
		'false',
	);
	await expect(page.getByRole('heading', { name: 'Sources', exact: true })).toHaveCount(0);
	for (const width of [1440, 720]) {
		await page.setViewportSize({ width, height: 900 });
		const stop = preview.getByRole('button', { name: 'Stop computer use' });
		await expect(stop).toBeVisible();
		await expect(stop).toBeInViewport({ ratio: 1 });
		const bounds = await stop.boundingBox();
		expect(bounds!.x).toBeGreaterThanOrEqual(0);
		expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
		await page.screenshot({
			path: `/tmp/freelm-computer-preview-stop-${width}.png`,
			animations: 'disabled',
		});
	}
	await preview.getByRole('button', { name: 'Stop computer use' }).click();
	await expect
		.poll(() => page.evaluate(() => (window as any).__computerUI.cancelled.length))
		.toBe(1);
	await expect
		.poll(() => page.evaluate(() => (window as any).__computerUI.stopped))
		.toEqual(['notes-session']);
	await expect
		.poll(() => page.evaluate(() => (window as any).__computerUI.events))
		.toEqual(['response-cancel', 'computer-stop']);
	await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Computer task', exact: true })).toBeVisible();
	await expect(preview).toHaveCount(0);
});
