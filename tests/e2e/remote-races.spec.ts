import { openRemoteSettings } from './ui-controls';
import { expect, test, type Page } from '@playwright/test';
import { selectConversationMode } from './helpers/conversation-mode';

// Chrome protocol interactions on the Mac host can exceed a minute per complete flow.
test.setTimeout(180_000);
test.use({ actionTimeout: 30_000 });

async function desktopFixture(page: Page, navigation = false) {
	await page.addInitScript((withNavigation) => {
		const makeState = () => ({
			version: 1,
			theme: 'dark',
			activeConnectionId: 'provider',
			threads: [],
			projects: [],
			generations: [],
			connections: [
				{
					id: 'provider',
					name: 'Host provider',
					baseUrl: 'http://localhost:8000/v1',
					apiKey: '',
					chatApi: 'responses',
					models: {
						chat: 'chat-model',
						images: 'image-model',
						videos: 'video-model',
						speech: 'speech-model',
						transcription: 'transcription-model',
					},
					discoveredModels: [],
					catalog: [
						{
							id: 'chat-model',
							name: 'chat-model',
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
					],
				},
			],
		});
		const control: any = {
			states: { local: makeState(), remote: makeState() },
			versions: { local: 0, remote: 0 },
			requests: [],
			backups: [],
			saveCalls: [],
			holdSave: false,
			saveStarted: false,
			holdOpen: false,
			openStarted: false,
			failStorageInfo: false,
			storageFailures: 0,
			closed: 0,
			closeHandlers: new Set<() => void>(),
		};
		const snapshot = (id: string) => ({
			state: structuredClone(control.states[id]),
			revision: `${id}:${control.versions[id]}`,
			// This fixture represents an updated host; legacy-host rejection is tested separately.
			moderationSupported: true,
		});
		if (withNavigation) {
			for (const [host, state] of Object.entries(control.states) as [string, any][]) {
				state.threads = ['chat', 'code'].map((kind) => ({
					id: `shared-${kind}`,
					kind,
					title: `${host} ${kind} conversation`,
					connectionId: 'provider',
					model: 'chat-model',
					thinkingMode: 'low',
					createdAt: 1,
					updatedAt: 1,
					messages: [
						{ id: 'request', role: 'user', content: `${host} ${kind} context`, createdAt: 1 },
					],
				}));
			}
		}
		(window as any).__remoteTest = control;
		(window as any).desktop = {
			platform: 'linux',
			workspaceLoad: async (id: string) => snapshot(id),
			workspaceBackup: async (state: unknown) => {
				control.backups.push(structuredClone(state));
				return '/tmp/freelm-test-recovery.json';
			},
			workspaceSave: async (id: string, revision: string, state: unknown) => {
				control.saveCalls.push({ id, revision });
				if (
					control.holdSave &&
					((state as any).generations.some((item: any) => item.status === 'pending') ||
						(state as any).threads.some((thread: any) =>
							thread.messages.some(
								(message: any) => message.role === 'assistant' && !message.content,
							),
						))
				) {
					control.saveStarted = true;
					await new Promise<void>((resolve) => {
						control.releaseSave = () => {
							control.holdSave = false;
							resolve();
						};
					});
				}
				if (JSON.stringify(state) === JSON.stringify(control.states[id]))
					return { revision: `${id}:${control.versions[id]}` };
				if (revision !== `${id}:${control.versions[id]}`)
					throw new Error('WORKSPACE_CONFLICT: another client saved changes.');
				control.states[id] = structuredClone(state);
				return { revision: `${id}:${++control.versions[id]}` };
			},
			storageInfo: async () => {
				if (control.failStorageInfo) {
					control.storageFailures++;
					throw new Error('Storage info unavailable');
				}
				return { secure: false, location: 'Test workspace' };
			},
			instanceStatus: async () => ({
				host: { running: false, name: 'This computer', instanceId: 'local-instance', port: 4319 },
				instances: [
					{
						id: 'remote',
						name: 'Remote test host',
						transport: 'direct',
						url: 'http://127.0.0.1:4319',
						connected: true,
						hasToken: true,
					},
				],
			}),
			instanceOpen: async (id: string) => {
				if (control.holdOpen) {
					control.openStarted = true;
					await new Promise<void>((resolve) => {
						control.releaseOpen = resolve;
					});
				}
				return snapshot(id);
			},
			instanceDisconnect: async () => {},
			request: async (request: any) => {
				control.requests.push({
					...request,
					savedStatus: control.states[request.workspaceId].generations[0]?.status,
				});
				return {
					status: 200,
					contentType: 'application/json',
					encoding: 'text',
					body: JSON.stringify({
						data: [
							{
								b64_json:
									'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6pAAAAABJRU5ErkJggg==',
							},
						],
					}),
				};
			},
			cancel: async () => {},
			onChunk: () => () => {},
			onPrepareClose: (handler: () => void) => {
				control.closeHandlers.add(handler);
				return () => control.closeHandlers.delete(handler);
			},
			completeClose: async () => {
				control.closed++;
			},
		};
	}, navigation);
	await page.goto('/');
	await expect(page).toHaveTitle('FreeLM');
	await expect(page.getByRole('heading', { name: 'What’s on your mind?' })).toBeVisible();
}

test('mode destinations are isolated by host even when thread IDs match', async ({ page }) => {
	await desktopFixture(page, true);
	await selectConversationMode(page, 'Code');
	await page.getByRole('button', { name: 'local code conversation', exact: true }).click();
	await page.getByLabel('Message', { exact: true }).fill('Local draft');
	await openRemote(page);
	await expect(page.getByRole('heading', { name: 'What’s on your mind?' })).toBeVisible();
	await selectConversationMode(page, 'Code');
	await expect(page.getByRole('heading', { name: 'What should we work on?' })).toBeVisible();
	await page.getByRole('button', { name: 'remote code conversation', exact: true }).click();
	await page.getByLabel('Message', { exact: true }).fill('Remote draft');
	await openRemoteSettings(page);
	await page
		.getByRole('region', { name: 'Local workspace', exact: true })
		.getByRole('button', { name: 'Open', exact: true })
		.click();
	await expect(page.locator('.message.user')).toContainText('local code context');
	await expect(page.getByLabel('Message', { exact: true })).toHaveText('Local draft');
	await openRemote(page);
	await expect(page.locator('.message.user')).toContainText('remote code context');
	await expect(page.getByLabel('Message', { exact: true })).toHaveText('Remote draft');
});

async function openRemote(page: Page) {
	await openRemoteSettings(page);
	await page
		.getByRole('region', { name: 'Remote FreeLM workspaces' })
		.getByRole('button', { name: 'Open', exact: true })
		.click();
	await expect(page.locator('.instance-context-bar')).toContainText('Remote test host');
}

async function generate(page: Page) {
	await page.getByRole('button', { name: 'Images', exact: true }).click();
	await page.getByLabel('Generation prompt').fill('A blue glass sculpture');
	await page.getByRole('button', { name: 'Generate image', exact: true }).click();
}

test('remote media waits for its pending record to be saved before calling the provider', async ({
	page,
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await desktopFixture(page);
	await openRemote(page);
	await page.evaluate(() => {
		(window as any).__remoteTest.holdSave = true;
	});
	await generate(page);
	await expect.poll(() => page.evaluate(() => (window as any).__remoteTest.saveStarted)).toBe(true);
	expect(await page.evaluate(() => (window as any).__remoteTest.requests)).toEqual([]);
	await page.evaluate(() => {
		(window as any).__remoteTest.releaseSave();
	});
	await expect(page.locator('.image-gallery-image')).toBeVisible();
	expect(
		await page.evaluate(() =>
			(window as any).__remoteTest.requests.map((item: any) => ({
				workspaceId: item.workspaceId,
				savedStatus: item.savedStatus,
			})),
		),
	).toEqual([{ workspaceId: 'remote', savedStatus: 'pending' }]);
	expect(errors).toEqual([]);
	await page.screenshot({ path: '/tmp/freelm-remote-persistence-gate.png' });
});

test('a stale remote media save prevents spending on the provider', async ({ page }) => {
	await desktopFixture(page);
	await openRemote(page);
	await page.evaluate(() => {
		const c = (window as any).__remoteTest;
		c.holdSave = true;
	});
	await generate(page);
	await expect.poll(() => page.evaluate(() => (window as any).__remoteTest.saveStarted)).toBe(true);
	await page.evaluate(() => {
		const c = (window as any).__remoteTest;
		c.versions.remote++;
		c.releaseSave();
	});
	await expect(page.locator('.storage-error')).toContainText('WORKSPACE_CONFLICT');
	expect(await page.evaluate(() => (window as any).__remoteTest.requests)).toEqual([]);
	expect(await page.evaluate(() => (window as any).__remoteTest.states.remote.generations)).toEqual(
		[],
	);
});

test('a failed reload never authorizes overwriting the latest workspace with the old view', async ({
	page,
}) => {
	await desktopFixture(page);
	await page.evaluate(() => {
		const c = (window as any).__remoteTest;
		c.states.local.projects.push({
			id: 'host-project',
			name: 'Host only',
			instructions: '',
			createdAt: 1,
		});
		c.versions.local++;
	});
	await page.getByRole('button', { name: 'New project', exact: true }).click();
	await page.getByLabel('Project name').fill('Unsaved local project');
	await page.getByRole('button', { name: 'Create project', exact: true }).click();
	await expect(page.locator('.storage-error')).toContainText('WORKSPACE_CONFLICT');
	await page.evaluate(() => {
		(window as any).__remoteTest.failStorageInfo = true;
	});
	await page.getByRole('button', { name: 'Reload latest', exact: true }).click();
	await page.getByRole('button', { name: 'Back up and reload', exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => (window as any).__remoteTest.storageFailures))
		.toBe(1);
	await expect(page.locator('.app-shell')).not.toHaveAttribute('inert', '');
	await page.getByRole('button', { name: 'Close reload dialog' }).click();
	await page.getByRole('button', { name: 'Retry save', exact: true }).click();
	expect(
		await page.evaluate(() =>
			(window as any).__remoteTest.states.local.projects.map((p: any) => p.name),
		),
	).toEqual(['Host only']);
	await expect(page.locator('.sidebar')).toContainText('Unsaved local project');
});

test('closing during a workspace transition does not save state to another target', async ({
	page,
}) => {
	await desktopFixture(page);
	await page.evaluate(() => {
		(window as any).__remoteTest.holdOpen = true;
	});
	await openRemoteSettings(page);
	await page
		.getByRole('region', { name: 'Remote FreeLM workspaces' })
		.getByRole('button', { name: 'Open', exact: true })
		.click();
	await expect.poll(() => page.evaluate(() => (window as any).__remoteTest.openStarted)).toBe(true);
	await page.evaluate(async () => {
		await Promise.all(
			[...((window as any).__remoteTest.closeHandlers as Set<() => void>)].map((handler) =>
				handler(),
			),
		);
	});
	expect(await page.evaluate(() => (window as any).__remoteTest.closed)).toBe(0);
	await page.evaluate(() => {
		(window as any).__remoteTest.releaseOpen();
	});
	await expect(page.locator('.instance-context-bar')).toContainText('Remote test host');
});

test('switching waits for an aborted pending save and persists cancellation on its original host', async ({
	page,
}) => {
	await desktopFixture(page);
	await openRemote(page);
	await page.evaluate(() => {
		(window as any).__remoteTest.holdSave = true;
	});
	await generate(page);
	await expect.poll(() => page.evaluate(() => (window as any).__remoteTest.saveStarted)).toBe(true);
	await openRemoteSettings(page);
	await page
		.getByRole('region', { name: 'Remote FreeLM workspaces' })
		.getByRole('button', { name: 'Open', exact: true })
		.click();
	await expect(page.locator('.app-shell')).toHaveAttribute('inert', '');
	expect(await page.evaluate(() => (window as any).__remoteTest.requests)).toEqual([]);
	await page.evaluate(() => {
		(window as any).__remoteTest.releaseSave();
	});
	await expect(page.locator('.instance-context-bar')).toHaveCount(0);
	expect(
		await page.evaluate(() => (window as any).__remoteTest.states.remote.generations[0]?.status),
	).toBe('cancelled');
	expect(await page.evaluate(() => (window as any).__remoteTest.states.local.generations)).toEqual(
		[],
	);
	expect(await page.evaluate(() => (window as any).__remoteTest.requests)).toEqual([]);
});

test('closing waits for media cancellation before its final workspace save', async ({ page }) => {
	await desktopFixture(page);
	await openRemote(page);
	await page.evaluate(() => {
		(window as any).__remoteTest.holdSave = true;
	});
	await generate(page);
	await expect.poll(() => page.evaluate(() => (window as any).__remoteTest.saveStarted)).toBe(true);
	await page.evaluate(() => {
		const handlers = (window as any).__remoteTest.closeHandlers as Set<() => void>;
		void Promise.all([...handlers].map((handler) => handler()));
	});
	expect(await page.evaluate(() => (window as any).__remoteTest.closed)).toBe(0);
	await page.evaluate(() => {
		(window as any).__remoteTest.releaseSave();
	});
	await expect.poll(() => page.evaluate(() => (window as any).__remoteTest.closed)).toBe(1);
	expect(
		await page.evaluate(() => (window as any).__remoteTest.states.remote.generations[0]?.status),
	).toBe('cancelled');
	expect(await page.evaluate(() => (window as any).__remoteTest.requests)).toEqual([]);
});

test('switching waits for cancelled chat preflight and saves the interrupted message', async ({
	page,
}) => {
	await desktopFixture(page);
	await openRemote(page);
	await page.evaluate(() => {
		(window as any).__remoteTest.holdSave = true;
	});
	await page.getByLabel('Message', { exact: true }).fill('Wait before sending');
	await page.getByRole('button', { name: 'Send message' }).click();
	await expect.poll(() => page.evaluate(() => (window as any).__remoteTest.saveStarted)).toBe(true);
	await openRemoteSettings(page);
	await page
		.getByRole('region', { name: 'Remote FreeLM workspaces' })
		.getByRole('button', { name: 'Open', exact: true })
		.click();
	await page.evaluate(() => {
		(window as any).__remoteTest.releaseSave();
	});
	await expect(page.locator('.instance-context-bar')).toHaveCount(0);
	expect(
		await page.evaluate(
			() => (window as any).__remoteTest.states.remote.threads[0].messages.at(-1).interrupted,
		),
	).toBe(true);
	expect(await page.evaluate(() => (window as any).__remoteTest.states.local.threads)).toEqual([]);
	expect(await page.evaluate(() => (window as any).__remoteTest.requests)).toEqual([]);
});
