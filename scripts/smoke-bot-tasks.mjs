import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

// A real BotHost -> IPC controller -> Chat/Code runner -> fixture HTTP provider loop.
// The temporary profile and project are the only data this test writes.
const profile = await mkdtemp(path.join(os.tmpdir(), 'freelm-bot-tasks-'));
const calls = [];
const workerInputs = [];
const forwardedPrompts = new Set();
const expectedForwardedPrompts = [
	'FIRST PROMPT',
	'QUEUED FOLLOWUP',
	'CHECK APPROVAL',
	'ASYNC PROMPT',
];
const taskNotifications = [];
const referenceImage =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const failedSaveMarker = 'FAILED_SAVE_DO_NOT_DELIVER_7bafc5c8';
let rollbackThreadId;
let rollbackResult;
let serverError;
const message = (text) => ({
	type: 'message',
	role: 'assistant',
	content: [{ type: 'output_text', text }],
});
const server = createServer(async (req, res) => {
	try {
		let raw = '';
		for await (const part of req) raw += part;
		const body = JSON.parse(raw || '{}');
		const notificationMatch = body.instructions?.match(
			/<freelm_notification>\s*([\s\S]*?)\s*<\/freelm_notification>/,
		);
		if (notificationMatch) {
			const notification = JSON.parse(notificationMatch[1]);
			taskNotifications.push(notification);
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(
				JSON.stringify({
					status: 'completed',
					output:
						notification.type === 'reaction'
							? [
									{
										type: 'function_call',
										call_id: 'notification-silence',
										name: 'bot_silence',
										arguments: '{}',
									},
								]
							: [message(`Your delegated task is ${notification.status}.`)],
				}),
			);
		} else if (body.model === 'rollback-orchestrator') {
			assert(rollbackThreadId, 'The rollback scenario needs an existing delegated chat.');
			const outputs = body.input.filter((item) => item.type === 'function_call_output');
			res.writeHead(200, { 'content-type': 'application/json' });
			if (!outputs.length) {
				assert(body.tools.some((tool) => tool.name === 'threads_send'));
				res.end(
					JSON.stringify({
						status: 'completed',
						output: [
							{
								type: 'function_call',
								call_id: 'failed-save',
								name: 'threads_send',
								arguments: JSON.stringify({ threadId: rollbackThreadId, prompt: failedSaveMarker }),
							},
						],
					}),
				);
			} else {
				assert.equal(outputs.length, 1);
				rollbackResult = outputs[0].output;
				assert(
					rollbackResult.startsWith('Error:'),
					`Failed storage must report a tool error: ${rollbackResult}`,
				);
				res.end(
					JSON.stringify({
						status: 'completed',
						output: [
							message('The follow-up could not be saved, so I did not report it as delivered.'),
						],
					}),
				);
			}
		} else if (body.model === 'orchestrator') {
			const outputs = body.input.filter((item) => item.type === 'function_call_output');
			const results = outputs.map((item) => {
				assert(!item.output.startsWith('Error:'), item.output);
				const parsed = JSON.parse(item.output);
				return parsed.result ?? parsed;
			});
			const chat = results.find((item) => item.threadId && item.messageId)?.threadId;
			const code = results.filter((item) => item.threadId && item.messageId).at(-1)?.threadId;
			const originalImage = results[4]?.turns[0]?.messages[0]?.attachments[0];
			const plan = [
				['hosts_list', {}],
				['projects_list', {}],
				['models_list', {}],
				['threads_search', { query: 'old-needle' }],
				['threads_read', { threadId: 'old-thread' }],
				[
					'threads_create',
					{
						kind: 'chat',
						title: 'Bot-created chat',
						prompt: 'FIRST PROMPT',
						model: 'worker',
						attachmentRefs: [originalImage?.ref],
					},
				],
				[
					'threads_send',
					{ threadId: chat, prompt: 'QUEUED FOLLOWUP', attachmentRefs: [originalImage?.ref] },
				],
				['threads_wait', { targets: [{ threadId: chat }], timeoutMs: 10000 }],
				['threads_read', { threadId: chat }],
				['threads_rename', { threadId: chat, title: 'Delegated chat result' }],
				['threads_archive', { threadId: chat, archived: true }],
				['threads_archive', { threadId: chat, archived: false }],
				[
					'threads_create',
					{
						kind: 'code',
						title: 'Bot-created Code task',
						prompt: 'CHECK APPROVAL',
						projectId: 'project',
						model: 'approval-worker',
						attachmentRefs: [originalImage?.ref],
					},
				],
				['threads_wait', { targets: [{ threadId: code }], timeoutMs: 10000 }],
				['threads_read', { threadId: code }],
				['threads_stop', { threadId: code }],
				['threads_wait', { targets: [{ threadId: code }], timeoutMs: 0 }],
				[
					'threads_create',
					{
						kind: 'chat',
						title: 'Asynchronous task',
						prompt: 'ASYNC PROMPT',
						model: 'worker',
						attachmentRefs: [originalImage?.ref],
					},
				],
			];
			if (outputs.length === 4) assert(results[3].threads.some((item) => item.id === 'old-thread'));
			if (outputs.length === 5) {
				assert(originalImage?.ref && originalImage.forwardable);
				assert.equal(originalImage.name, 'older-reference.png');
				assert(
					!JSON.stringify(results[4]).includes(referenceImage),
					'Bot receives metadata, not raw image bytes.',
				);
			}
			if (outputs.length === 7) assert.equal(results[6].delivery.status, 'queued');
			if (outputs.length === 9) {
				const text = JSON.stringify(results[8]);
				assert(text.includes('QUEUED FOLLOWUP'));
				assert(text.includes('ANSWER TO QUEUED FOLLOWUP'));
			}
			if (outputs.length === 14) assert.equal(results[13].polls[0].status, 'waiting_for_approval');
			if (outputs.length === 17) {
				assert.equal(results[16].polls[0].id, code);
				assert.equal(
					results[16].polls[0].status,
					'error',
					'Stopped Code work must not be reported as completed.',
				);
			}
			const step = plan[outputs.length];
			if (step) {
				const [name, args] = step;
				assert(body.tools.some((tool) => tool.name === name));
				calls.push(name);
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(
					JSON.stringify({
						status: 'completed',
						output: [
							{
								type: 'function_call',
								call_id: `step-${outputs.length}`,
								name,
								arguments: JSON.stringify(args),
							},
						],
					}),
				);
			} else {
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(
					JSON.stringify({
						status: 'completed',
						output: [
							message(
								'I found the older conversation, finished the delegated chat, and stopped the Code task at its approval gate.',
							),
						],
					}),
				);
			}
		} else {
			if (body.stream) {
				workerInputs.push(JSON.stringify(body.input));
				const userInputs = body.input.filter((item) => item.role === 'user');
				assert(userInputs.length > 0);
				for (const input of userInputs) {
					const prompt = Array.isArray(input.content)
						? input.content
								.filter((part) => part.type === 'input_text')
								.map((part) => part.text)
								.join('\n')
						: input.content;
					// The app may also use this fixture model for text-only memory summaries.
					if (!expectedForwardedPrompts.includes(prompt)) continue;
					assert(
						Array.isArray(input.content),
						'Forwarded image must serialize as multimodal content.',
					);
					assert(
						input.content.some(
							(part) => part.type === 'input_image' && part.image_url === referenceImage,
						),
						`Both created and queued prompts must deliver the selected original image to the worker provider: ${JSON.stringify({ model: body.model, input })}`,
					);
					forwardedPrompts.add(prompt);
				}
				await new Promise((resolve) => setTimeout(resolve, 1200));
				const input = JSON.stringify(body.input);
				const output =
					body.model === 'approval-worker'
						? [
								{
									type: 'function_call',
									call_id: 'approval-test',
									name: 'exec_command',
									arguments: JSON.stringify({ cmd: 'printf bot-task-test' }),
								},
							]
						: [
								message(
									input.includes('ASYNC PROMPT')
										? 'ASYNC TASK ANSWER'
										: input.includes('QUEUED FOLLOWUP')
											? 'ANSWER TO QUEUED FOLLOWUP'
											: 'ANSWER TO FIRST PROMPT',
								),
							];
				res.writeHead(200, { 'content-type': 'text/event-stream' });
				if (body.model !== 'approval-worker')
					res.write(
						`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: output[0].content[0].text })}\n\n`,
					);
				res.end(
					`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output } })}\n\n`,
				);
			} else {
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ status: 'completed', output: [message('Delegated task')] }));
			}
		}
	} catch (error) {
		serverError = error;
		res.writeHead(500, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ error: String(error) }));
	}
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let desktop, page;
try {
	const env = { ...process.env, FREELM_HOME: profile, FREELM_USER_DATA: profile };
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.FREELM_DEV_URL;
	const executablePath = process.env.FREELM_SMOKE_EXECUTABLE;
	desktop = await electron.launch({
		...(executablePath
			? { executablePath, args: [`--user-data-dir=${profile}`] }
			: { args: ['.'] }),
		env,
	});
	page = await desktop.firstWindow();
	const errors = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await page.locator('.app-shell').waitFor();
	await page.evaluate(
		async ({ baseUrl, profile, referenceImage }) => {
			const s = await window.desktop.load();
			const state = s || {
				version: 1,
				connections: [],
				threads: [],
				projects: [],
				generations: [],
				theme: 'dark',
			};
			state.connections = [
				{
					id: 'fixture',
					name: 'Fixture',
					baseUrl,
					apiKey: 'test-secret',
					chatApi: 'responses',
					discoveredModels: [],
					models: { chat: 'worker', images: '', videos: '', speech: '', transcription: '' },
					catalog: ['orchestrator', 'rollback-orchestrator', 'worker', 'approval-worker'].map(
						(id) => ({
							id,
							name: id,
							enabled: true,
							tasks: ['chat'],
							inputModalities: ['text', 'image'],
							outputModalities: ['text'],
							contextWindow: 128000,
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
						}),
					),
				},
			];
			state.activeConnectionId = 'fixture';
			state.theme = 'dark';
			state.backgroundNotifications = false;
			state.projects = [
				{
					id: 'project',
					name: 'Isolated Code project',
					kind: 'code',
					directories: [profile],
					instructions: '',
					createdAt: 1,
				},
			];
			state.toolSettings = {
				enabled: true,
				commandExecution: true,
				workspaceRoot: profile,
				approvalMode: 'ask',
				imageGeneration: { enabled: false, connectionId: '', model: '', size: '', quality: '' },
				mcpServers: [],
				skillDirectories: [],
			};
			state.threads = Array.from({ length: 35 }, (_, i) => ({
				id: `other-${i}`,
				kind: 'chat',
				title: `Other ${i}`,
				connectionId: 'fixture',
				model: 'worker',
				thinkingMode: 'low',
				messages: [],
				createdAt: 100 + i,
				updatedAt: 100 + i,
			}));
			state.threads.push({
				id: 'old-thread',
				kind: 'chat',
				title: 'Older reference',
				connectionId: 'fixture',
				model: 'worker',
				thinkingMode: 'low',
				createdAt: 1,
				updatedAt: 1,
				messages: [
					{
						id: 'old-user',
						role: 'user',
						content: 'old-needle in historical conversation',
						attachments: [
							{ name: 'older-reference.png', type: 'image/png', dataUrl: referenceImage },
						],
						createdAt: 1,
					},
					{
						id: 'old-assistant',
						role: 'assistant',
						content: 'Useful historical answer',
						createdAt: 2,
						completedAt: 2,
					},
				],
			});
			await window.desktop.save(state);
		},
		{ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, profile, referenceImage },
	);
	await page.reload();
	await page.locator('.app-shell').waitFor();
	await page.evaluate(async () => {
		const snapshot = await window.desktop.botsSnapshot('local');
		await window.desktop.botsCommand('local', {
			type: 'create-bot',
			id: 'delegate',
			profile: {
				memoryEnabled: false,
				name: 'Delegate',
				identity: 'Complete user-requested tasks using threads tools.',
				connectionId: 'fixture',
				model: 'orchestrator',
				thinkingMode: 'low',
			},
		});
		await window.desktop.botsCommand('local', {
			type: 'create-conversation',
			id: 'delegation',
			participants: [{ hostId: snapshot.host.id, botId: 'delegate' }],
		});
	});
	await page.getByRole('button', { name: 'Bots', exact: true }).click();
	await page.getByRole('button', { name: /Delegate delegate@freelm/ }).click();
	await page
		.getByLabel('Message your bot', { exact: true })
		.fill(
			'Find our older reference, start a chat and follow up, then create a Code task and stop it when it needs approval.',
		);
	// The host stays ready while its native window is minimized. Sending through the
	// real composer handler must not depend on animation frames from a visible window.
	await desktop.evaluate(({ BrowserWindow }) => {
		const window = BrowserWindow.getAllWindows()[0];
		if (!window) throw new Error('The fixture window is missing.');
		window.minimize();
	});
	await expect
		.poll(
			() =>
				desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMinimized()),
			{ timeout: 5000 },
		)
		.toBe(true);
	await page.getByRole('button', { name: 'Send message', exact: true }).evaluate((button) => {
		if (!(button instanceof HTMLButtonElement) || button.disabled)
			throw new Error('The fixture composer must be ready to send.');
		button.click();
	});
	await expect
		.poll(
			async () => {
				if (serverError) throw serverError;
				return page.evaluate(async () => {
					const s = await window.desktop.botsSnapshot('local');
					const m = s.conversations[0].messages.find((m) => m.role === 'bot');
					if (m?.status === 'failed') throw new Error(m.error);
					return m?.status;
				});
			},
			{ timeout: 90000 },
		)
		.toBe('completed');
	const state = await page.evaluate(() => window.desktop.load());
	const chat = state.threads.find((t) => t.title === 'Delegated chat result');
	const code = state.threads.find((t) => t.title === 'Bot-created Code task');
	const asynchronous = state.threads.find((t) => t.title === 'Asynchronous task');
	assert(chat && code && asynchronous);
	assert.equal(chat.archivedAt, undefined);
	assert.deepEqual(
		chat.messages.filter((m) => m.role === 'user').map((m) => m.content),
		['FIRST PROMPT', 'QUEUED FOLLOWUP'],
	);
	assert.equal(code.permissionMode, 'ask');
	for (const task of [chat, code]) {
		for (const input of task.messages.filter((entry) => entry.role === 'user'))
			assert.equal(
				input.attachments?.[0]?.dataUrl,
				referenceImage,
				'Forwarded image survives durable thread storage.',
			);
	}
	assert(
		!code.messages
			.flatMap((m) => m.toolCalls || [])
			.some((c) => c.result?.content?.some((x) => x.text?.includes('exit_code: 0'))),
	);
	assert.equal(calls.length, 18);
	assert.deepEqual(errors, []);
	await expect
		.poll(
			() =>
				taskNotifications.some(
					(item) =>
						item.type === 'thread' &&
						item.threadId === asynchronous.id &&
						item.status === 'completed' &&
						item.summary.includes('ASYNC TASK ANSWER'),
				),
			{ timeout: 20000 },
		)
		.toBe(true)
		.catch(async (error) => {
			console.error(
				'Notification debug',
				JSON.stringify({
					taskNotifications,
					bots: JSON.parse(await readFile(path.join(profile, 'bots/workspace.json'), 'utf8')),
					tasks: await page.evaluate(async () =>
						(await window.desktop.load()).threads.filter((t) => t.title === 'Asynchronous task'),
					),
				}),
			);
			throw error;
		});
	assert.equal(
		await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMinimized()),
		true,
		'The complete delegated workflow must finish without restoring its native window.',
	);
	await desktop.evaluate(({ BrowserWindow }) => {
		const window = BrowserWindow.getAllWindows()[0];
		window.restore();
		window.show();
	});
	await expect
		.poll(
			() =>
				desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMinimized()),
			{ timeout: 5000 },
		)
		.toBe(false);
	await expect(
		page
			.getByRole('log', { name: 'Bot messages' })
			.getByText('Your delegated task is completed.', { exact: true }),
	).toBeVisible();
	await expect(page.locator('.bot-message-meta').filter({ hasText: /^Read / })).toContainText(
		/Read \d{1,2}:\d{2}/,
	);
	await page.screenshot({ path: '/tmp/freelm-bot-tasks-native.png' });

	// A separate conversation exercises the actual renderer writer's failed-save path.
	// Keep rejecting every matching save until cleanup: autosave must not accidentally
	// persist the rejected input before rollback is observed.
	rollbackThreadId = chat.id;
	await page.evaluate(async () => {
		const snapshot = await window.desktop.botsSnapshot('local');
		await window.desktop.botsCommand('local', {
			type: 'create-bot',
			id: 'rollback-delegate',
			profile: {
				memoryEnabled: false,
				name: 'Rollback delegate',
				identity: 'Report saved-message errors accurately.',
				connectionId: 'fixture',
				model: 'rollback-orchestrator',
				thinkingMode: 'low',
			},
		});
		await window.desktop.botsCommand('local', {
			type: 'create-conversation',
			id: 'rollback-delegation',
			participants: [{ hostId: snapshot.host.id, botId: 'rollback-delegate' }],
		});
	});
	await page.evaluate((marker) => {
		const original = window.desktop.workspacePatch;
		if (!original) throw new Error('The native renderer must use workspace patches.');
		window.__freelmRollbackPatchFailures = 0;
		window.desktop.workspacePatch = async (...args) => {
			if (args[0] === 'local' && JSON.stringify(args[2]).includes(marker)) {
				window.__freelmRollbackPatchFailures++;
				throw new Error('Fixture queued-message save failure.');
			}
			return original(...args);
		};
		window.__freelmRollbackPatchRestore = () => {
			window.desktop.workspacePatch = original;
			delete window.__freelmRollbackPatchRestore;
			delete window.__freelmRollbackPatchFailures;
		};
	}, failedSaveMarker);
	await page.evaluate(async () => {
		await window.desktop.botsCommand('local', {
			type: 'send',
			conversationId: 'rollback-delegation',
			messageId: 'rollback-request',
			content: 'Try the follow-up and tell me whether it was saved.',
		});
	});
	await expect
		.poll(async () => page.evaluate(() => window.__freelmRollbackPatchFailures), { timeout: 15000 })
		.toBeGreaterThan(0);
	await expect
		.poll(
			async () => {
				if (serverError) throw serverError;
				return page.evaluate(async () => {
					const snapshot = await window.desktop.botsSnapshot('local');
					const reply = snapshot.conversations
						.find((item) => item.id === 'rollback-delegation')
						.messages.find((item) => item.role === 'bot');
					if (reply?.status === 'failed') throw new Error(reply.error);
					return reply?.status;
				});
			},
			{ timeout: 30000 },
		)
		.toBe('completed');
	assert(rollbackResult?.startsWith('Error:'));
	const rolledBack = await page.evaluate(() => window.desktop.load());
	const preservedChat = rolledBack.threads.find((item) => item.id === rollbackThreadId);
	assert(preservedChat, 'The existing conversation must remain available after failed storage.');
	assert(!JSON.stringify(preservedChat.messages).includes(failedSaveMarker));
	assert(!JSON.stringify(preservedChat.queuedMessages ?? []).includes(failedSaveMarker));
	assert(
		!workerInputs.some((input) => input.includes(failedSaveMarker)),
		'An unsaved queued prompt must never reach the worker provider.',
	);
	assert.deepEqual(errors, []);
	assert.deepEqual([...forwardedPrompts].sort(), [...expectedForwardedPrompts].sort());
	console.log(
		'PASS: native bot completes its delegated workflow while minimized: discovers older history and images, forwards image bytes to Chat/Code and streaming follow-ups, receives an async completion notification with a visible proactive reply and timed Read receipt, waits/reads replies, renames, archives/restores, observes approval, reports stopped work without false completion, and rejects unsaved queued input.',
	);
} finally {
	await page?.evaluate(() => window.__freelmRollbackPatchRestore?.()).catch(() => {});
	await desktop?.close();
	await new Promise((resolve) => server.close(resolve));
	await rm(profile, { recursive: true, force: true });
}
