import { selectConversationMode } from './helpers/conversation-mode';
import { test, expect, type Page } from '@playwright/test';
import { initialState } from '../../src/lib/state';
import { defaultToolSettings } from '../../src/lib/tool-settings';
import { createComposerMention } from '../../src/lib/composer-mention-codec';

async function fixture(page: Page, oldHost = false) {
	const state = initialState();
	const connection = state.connections[0];
	connection.models.chat = 'test';
	connection.catalog = [
		{
			id: 'test',
			name: 'Test',
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
	state.threads = [
		{
			id: 'task',
			kind: 'code',
			title: 'Composer runtime',
			connectionId: connection.id,
			model: 'test',
			thinkingMode: 'low',
			createdAt: 1,
			updatedAt: 1,
			messages: [],
		},
	];
	const ref = createComposerMention({
		kind: 'skill',
		id: 'chosen-skill',
		label: 'Chosen Skill',
		path: '/configured/skill/SKILL.md',
	});
	await page.addInitScript((serialized: string) => {
		const { state, ref, oldHost } = JSON.parse(serialized);
		let saved = structuredClone(state),
			revision = 0;
		const chunks = new Set<any>();
		const requests: any[] = [];
		const resolutions: any[] = [];
		const control: any = {
			requests,
			resolutions,
			get saved() {
				return saved;
			},
			finish(index: number, text: string) {
				const round = requests[index];
				round.emit({
					type: 'response.completed',
					response: {
						status: 'completed',
						output: [
							{
								type: 'message',
								id: 'answer',
								role: 'assistant',
								content: [{ type: 'output_text', text }],
							},
						],
					},
				});
				round.resolve({
					status: 200,
					contentType: 'text/event-stream',
					encoding: 'text',
					body: '',
				});
			},
		};
		(window as any).__composerRuntime = control;
		(window as any).desktop = {
			platform: 'linux',
			workspaceLoad: async () => ({ state: saved, revision: String(revision) }),
			workspaceSave: async (_id: any, _rev: any, next: any) => {
				saved = structuredClone(next);
				return { revision: String(++revision) };
			},
			storageInfo: async () => ({ secure: false, location: '/test/config.json' }),
			onPrepareClose: () => () => {},
			onToolApproval: () => () => {},
			onChunk: (listener: any) => {
				chunks.add(listener);
				return () => chunks.delete(listener);
			},
			instanceStatus: async () => ({
				host: { running: false, name: 'This computer', instanceId: 'local', port: 4319 },
				instances: [],
			}),
			toolCatalog: async () => ({
				tools: [],
				instructions: 'Host tools.',
				warnings: [],
				codeCapabilities: 1,
				...(!oldHost ? { codePlanMode: 1 } : {}),
			}),
			toolExecute: async () => {
				throw Error('No actual execution allowed in composer UI test');
			},
			toolCancel: async () => {},
			cancel: async () => {},
			composerDiscover: async () => ({
				items: [
					{
						kind: ref.kind,
						id: ref.id,
						label: ref.label,
						path: ref.path,
						description: 'Selected skill',
					},
				],
			}),
			composerResolve: async (_workspace: any, threadId: any, messageId: any) => {
				const message = saved.threads
					.find((t: any) => t.id === threadId)
					?.messages.find((m: any) => m.id === messageId);
				resolutions.push(structuredClone(message));
				if (!message?.composer?.references?.length) throw Error('References not committed');
				return { instructions: 'Explicit skill: Chosen Skill. Follow its bounded instructions.' };
			},
			request: async (request: any) =>
				new Promise((resolve) => {
					const emit = (data: any) => {
						for (const listener of chunks)
							listener({ id: request.id, text: `data: ${JSON.stringify(data)}\n\n` });
					};
					requests.push({ ...request, emit, resolve });
					emit({ type: 'response.reasoning_text.delta', delta: 'Inspecting.' });
				}),
		};
	}, JSON.stringify({ state, ref, oldHost }));
	await page.goto('/');
	await selectConversationMode(page, 'Code');
	await page.getByRole('button', { name: 'Composer runtime', exact: true }).click();
	return page.getByRole('textbox', { name: 'Message', exact: true });
}

test('Plan prompt is real, persists, and Implement switches the next request into work', async ({
	page,
}) => {
	const input = await fixture(page);
	await input.fill('/plan');
	await input.press('Enter');
	await input.fill('Plan a small change.');
	await input.press('Enter');
	await expect
		.poll(() => page.evaluate(() => (window as any).__composerRuntime.requests.length))
		.toBe(1);
	expect(
		await page.evaluate(() => (window as any).__composerRuntime.requests[0].body.instructions),
	).toContain('Code Plan mode is active');
	await page.evaluate(() =>
		(window as any).__composerRuntime.finish(
			0,
			'<proposed_plan>\n# Small change\nRead the file, update it, and verify.\n</proposed_plan>',
		),
	);
	await expect(page.getByRole('button', { name: 'Implement plan', exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Turn off Plan mode', exact: true })).toBeVisible();
	await expect(page.locator('.message-content').last()).not.toContainText('<proposed_plan>');
	await page.getByRole('button', { name: 'Implement plan', exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => (window as any).__composerRuntime.requests.length))
		.toBe(2);
	expect(
		await page.evaluate(() => (window as any).__composerRuntime.requests[1].body.instructions),
	).not.toContain('Code Plan mode is active');
	await page.evaluate(() => (window as any).__composerRuntime.finish(1, 'Implemented.'));
});

test('Goal selection creates an actual persistent goal and clears the one-shot mode', async ({
	page,
}) => {
	const input = await fixture(page);
	await input.fill('/goal');
	await input.press('Enter');
	await input.fill('Finish the concrete task.');
	await input.press('Enter');
	await expect
		.poll(() => page.evaluate(() => (window as any).__composerRuntime.requests.length))
		.toBe(1);
	await expect
		.poll(() =>
			page.evaluate(() => (window as any).__composerRuntime.saved.threads[0].goal?.objective),
		)
		.toBe('Finish the concrete task.');
	expect(
		await page.evaluate(() => (window as any).__composerRuntime.requests[0].body.instructions),
	).toContain('Persistent Code goal: Finish the concrete task.');
	await expect(page.getByRole('button', { name: 'Turn off Goal mode', exact: true })).toHaveCount(
		0,
	);
	// Stop the pending mock response; the fixture must not drive an automatic goal loop.
	await page.getByRole('button', { name: 'Stop response', exact: true }).click();
});

test('a queued selected skill resolves only after commitment and reaches the next model prompt', async ({
	page,
}) => {
	const input = await fixture(page);
	await input.fill('Inspect the task.');
	await input.press('Enter');
	await expect
		.poll(() => page.evaluate(() => (window as any).__composerRuntime.requests.length))
		.toBe(1);
	await input.fill('Then use /Chosen');
	await page.getByRole('option', { name: /Chosen Skill/ }).click();
	await input.press('Enter');
	await expect
		.poll(() =>
			page.evaluate(
				() => (window as any).__composerRuntime.saved.threads[0].queuedMessages?.length,
			),
		)
		.toBe(1);
	expect(await page.evaluate(() => (window as any).__composerRuntime.resolutions.length)).toBe(0);
	await page.evaluate(() => (window as any).__composerRuntime.finish(0, 'Inspected.'));
	await expect
		.poll(() => page.evaluate(() => (window as any).__composerRuntime.requests.length))
		.toBe(2);
	expect(
		await page.evaluate(
			() => (window as any).__composerRuntime.resolutions[0].composer.references[0].id,
		),
	).toBe('chosen-skill');
	const body = await page.evaluate(() => (window as any).__composerRuntime.requests[1].body);
	expect(body.instructions).toContain('Explicit skill: Chosen Skill');
	expect(JSON.stringify(body.input)).toContain('Then use Chosen Skill');
	expect(JSON.stringify(body.input)).not.toContain('freelm-skill:');
	await page.evaluate(() => (window as any).__composerRuntime.finish(1, 'Done.'));
});

test('old execution hosts cannot pretend to enforce Plan mode', async ({ page }) => {
	const input = await fixture(page, true);
	await input.fill('/plan');
	await input.press('Enter');
	await input.fill('Plan a small change.');
	await input.press('Enter');
	await expect(
		page.getByText(
			'Plan mode requires an updated FreeLM execution host with read-only planning support.',
			{ exact: true },
		),
	).toBeVisible();
	expect(await page.evaluate(() => (window as any).__composerRuntime.requests.length)).toBe(0);
});
