import { _electron as electron, expect as playwrightExpect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

// Real Settings -> preload -> durable host clock -> Bot/Code execution. Every
// profile, model and project in this test is disposable; no user data is loaded.
const require = createRequire(import.meta.url);
const expect = playwrightExpect.configure({ timeout: 30_000 });
const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'freelm-scheduler-smoke-')));
const workspace = path.join(home, 'project');
await mkdir(workspace);
const providerErrors = [],
	rendererErrors = [],
	requests = [];
let desktop,
	page,
	stderr = '',
	passed = false;
const source = 'Schedule the fixture reminder and then its follow-up check.';
const reminderText = 'Native scheduler reminder: take a short break.';
const botWork = 'Perform the native scheduled bot check.';
const botResult = 'The native scheduled bot check is complete.';
const codeWork = 'Perform the native scheduled Code check.';
const codeResult = 'The native scheduled Code check is complete.';
const message = (text) => ({
	type: 'message',
	role: 'assistant',
	content: [{ type: 'output_text', text }],
});
const textOf = (value) =>
	typeof value === 'string' ? value : (value ?? []).map((item) => item.text ?? '').join('\n');
function answer(response, body, output) {
	if (body.model === 'scheduler-code' && body.stream) {
		response.writeHead(200, { 'content-type': 'text/event-stream' });
		response.end(
			`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: codeResult })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output } })}\n\n`,
		);
	} else {
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end(JSON.stringify({ status: 'completed', output }));
	}
}
const server = createServer(async (request, response) => {
	try {
		let raw = '';
		for await (const chunk of request) raw += chunk.toString();
		assert.equal(request.url, '/v1/responses');
		const body = JSON.parse(raw);
		requests.push(body);
		if (body.model === 'scheduler-code') {
			assert.ok(
				body.input.some((item) => item.role === 'user' && textOf(item.content) === codeWork),
			);
			answer(response, body, [message(codeResult)]);
			return;
		}
		assert.equal(body.model, 'scheduler-bot');
		const eventMatch = body.instructions.match(
			/<freelm_notification>\s*([\s\S]*?)\s*<\/freelm_notification>/,
		);
		if (eventMatch) {
			const event = JSON.parse(eventMatch[1]);
			assert.equal(event.type, 'scheduled');
			assert.equal(event.kind, 'work');
			assert.equal(event.prompt, botWork);
			assert.equal(
				body.input.filter((item) => item.role === 'user').length,
				1,
				'A scheduled event must not fabricate a human message',
			);
			assert.match(body.instructions, /saved user request, triggered at/);
			answer(response, body, [message(botResult)]);
			return;
		}
		const outputs = body.input.filter((item) => item.type === 'function_call_output');
		if (!outputs.length) {
			assert.ok(body.tools.some((tool) => tool.name === 'scheduler_create'));
			assert.ok(
				!body.tools.some((tool) => tool.name === 'threads_send'),
				'Bot history access remains disabled',
			);
			assert.ok(body.input.some((item) => item.role === 'user' && textOf(item.content) === source));
			const now = Date.now();
			answer(
				response,
				body,
				[
					['native-reminder', 'Native bot reminder', 'reminder', reminderText, now + 3000],
					['native-wake', 'Native bot scheduled work', 'task', botWork, now + 15_000],
				].map(([id, title, action, text, at]) => ({
					type: 'function_call',
					call_id: id,
					name: 'scheduler_create',
					arguments: JSON.stringify({
						title,
						action,
						text,
						schedule: { kind: 'once', at: new Date(at).toISOString(), missed: 'once' },
						idempotencyKey: id,
					}),
				})),
			);
		} else {
			assert.equal(outputs.length, 2);
			for (const output of outputs) {
				assert.ok(!output.output.startsWith('Error:'), output.output);
				assert.ok(JSON.parse(output.output).job?.id, output.output);
			}
			answer(response, body, [message('The fixture reminder and follow-up are scheduled.')]);
		}
	} catch (error) {
		providerErrors.push(error.message);
		if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
		response.end(JSON.stringify({ error: { message: error.message } }));
	}
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
async function launch() {
	const executablePath = process.env.FREELM_SMOKE_EXECUTABLE;
	const env = { ...process.env, FREELM_HOME: home };
	delete env.FREELM_USER_DATA;
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.FREELM_DEV_URL;
	desktop = await electron.launch({
		executablePath: executablePath || require('electron'),
		args: [...(executablePath ? [] : ['.']), `--user-data-dir=${path.join(home, 'electron')}`],
		env,
	});
	desktop.process().stderr?.on('data', (chunk) => {
		stderr = (stderr + chunk).slice(-6000);
	});
	page = await desktop.firstWindow();
	page.setDefaultTimeout(20_000);
	page.on('pageerror', (error) => rendererErrors.push(error.message));
	await page.waitForFunction(() => !!window.desktop?.schedulerSnapshot);
	await page.locator('.app-shell').waitFor();
	assert.equal(
		(await page.evaluate(() => window.desktop.storageInfo())).location,
		path.join(home, 'config.json'),
	);
	assert.equal(
		await desktop.evaluate(({ app }) => app.getPath('userData')),
		path.join(home, 'electron'),
	);
}
async function stop() {
	await desktop?.evaluate(({ app }) => app.exit()).catch(() => {});
	await desktop?.close().catch(() => {});
	desktop = undefined;
}
async function snapshot() {
	return page.evaluate(() => window.desktop.schedulerSnapshot());
}
async function command(value) {
	return page.evaluate((value) => window.desktop.schedulerCommand(value), value);
}
async function botMessages() {
	return page.evaluate(
		async () =>
			(await window.desktop.botsSnapshot('local')).conversations.find(
				(item) => item.id === 'scheduler-dm',
			).messages,
	);
}
async function openSettings() {
	await page.getByRole('button', { name: 'Personal workspace settings', exact: true }).click();
	const settings = page.getByRole('region', { name: 'Settings', exact: true });
	await settings
		.getByRole('navigation', { name: 'Settings options' })
		.getByRole('button', { name: 'Scheduled tasks', exact: true })
		.click();
	await expect(
		settings.getByRole('heading', { name: 'Your schedules', exact: true }),
	).toBeVisible();
	return settings;
}
try {
	await launch();
	const stamp = Date.now();
	await page.evaluate(
		async ({ baseUrl, workspace, stamp }) => {
			const current = await window.desktop.workspaceLoad('local');
			const connection = {
				id: 'scheduler-fixture',
				name: 'Scheduler fixture',
				baseUrl,
				apiKey: '',
				chatApi: 'responses',
				models: { chat: 'scheduler-code', images: '', videos: '', speech: '', transcription: '' },
				discoveredModels: [],
				catalog: ['scheduler-bot', 'scheduler-code'].map((id) => ({
					id,
					name: id,
					enabled: true,
					tasks: ['chat'],
					inputModalities: ['text'],
					outputModalities: ['text'],
					defaultThinkingMode: 'low',
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
				})),
			};
			await window.desktop.workspaceSave('local', current.revision, {
				...current.state,
				version: 1,
				connections: [connection],
				activeConnectionId: connection.id,
				theme: 'dark',
				generations: [],
				backgroundNotifications: false,
				projects: [
					{
						id: 'scheduler-project',
						name: 'Scheduler fixture project',
						kind: 'code',
						instructions: '',
						directories: [workspace],
						createdAt: stamp,
					},
				],
				threads: [
					{
						id: 'scheduler-code-thread',
						title: 'Native scheduled Code task',
						titleSource: 'manual',
						kind: 'code',
						projectId: 'scheduler-project',
						connectionId: connection.id,
						model: 'scheduler-code',
						thinkingMode: 'low',
						permissionMode: 'full-access',
						createdAt: stamp,
						updatedAt: stamp,
						messages: [
							{ id: 'setup', role: 'user', content: 'Fixture setup.', createdAt: stamp },
							{
								id: 'ready',
								role: 'assistant',
								content: 'Ready.',
								createdAt: stamp,
								completedAt: stamp,
							},
						],
					},
				],
				toolSettings: {
					enabled: true,
					workspaceRoot: workspace,
					commandExecution: false,
					approvalMode: 'full-access',
					allowRemote: false,
					imageGeneration: { enabled: false, connectionId: '', model: '', size: '', quality: '' },
					videoGeneration: { enabled: false, connectionId: '', model: '', size: '', seconds: '' },
					pythonExecution: { enabled: false },
					webBrowsing: { enabled: false, searxngUrl: '' },
					computerUse: { enabled: false },
					mcpServers: [],
					skillDirectories: [],
				},
			});
		},
		{ baseUrl, workspace, stamp },
	);
	await page.reload();
	await page.locator('.app-shell').waitFor();
	let settings = await openSettings();
	await settings.getByRole('button', { name: 'New reminder', exact: true }).click();
	const editor = settings.getByRole('form', { name: 'New reminder' });
	await editor
		.getByRole('textbox', { name: 'Title', exact: true })
		.fill('Native Settings reminder');
	await editor
		.getByRole('textbox', { name: 'Message', exact: true })
		.fill('Native Settings reminder delivered.');
	const future = new Date(Date.now() + 120_000);
	const local = new Date(future.getTime() - future.getTimezoneOffset() * 60_000)
		.toISOString()
		.slice(0, 16);
	await editor.getByLabel('Date and time', { exact: true }).fill(local);
	await editor.getByRole('button', { name: 'Create reminder', exact: true }).click();
	await expect(editor).toHaveCount(0);
	const uiJob = (await snapshot()).jobs.find((job) => job.title === 'Native Settings reminder');
	assert.ok(uiJob);
	const row = settings.locator(`[data-schedule-id="${uiJob.id}"]`);
	await row.getByRole('button', { name: 'Pause', exact: true }).click();
	await expect(row.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
	assert.equal((await snapshot()).jobs.find((job) => job.id === uiJob.id).enabled, false);
	await stop();
	await launch();
	assert.equal(
		(await snapshot()).jobs.find((job) => job.id === uiJob.id).enabled,
		false,
		'Pause persists over a process restart',
	);
	assert.equal((await snapshot()).occurrences.length, 0);
	settings = await openSettings();
	await settings
		.locator(`[data-schedule-id="${uiJob.id}"]`)
		.getByRole('button', { name: 'Resume', exact: true })
		.click();
	// The native date control is minute-granular. Move this saved UI-created
	// reminder near now through the real preload API to exercise the host clock.
	await command({
		type: 'update',
		id: uiJob.id,
		patch: { schedule: { kind: 'once', at: Date.now() + 2000, missed: 'once' } },
	});
	await expect
		.poll(
			async () => (await snapshot()).occurrences.find((item) => item.jobId === uiJob.id)?.status,
		)
		.toBe('delivered');
	assert.equal(requests.length, 0, 'Settings reminder delivery never invokes inference');
	await page.evaluate(async () => {
		const bridge = window.desktop;
		const hostId = (await bridge.botsSnapshot('local')).host.id;
		await bridge.botsCommand('local', {
			type: 'create-bot',
			id: 'scheduler-bot',
			profile: {
				name: 'Scheduler test bot',
				identity: 'A native test fixture.',
				connectionId: 'scheduler-fixture',
				model: 'scheduler-bot',
				thinkingMode: 'low',
				historyAccess: false,
			},
		});
		await bridge.botsCommand('local', {
			type: 'create-conversation',
			id: 'scheduler-dm',
			participants: [{ hostId, botId: 'scheduler-bot' }],
		});
	});
	await page.evaluate(
		(content) =>
			window.desktop.botsCommand('local', {
				type: 'send',
				conversationId: 'scheduler-dm',
				messageId: 'scheduler-source',
				content,
			}),
		source,
	);
	await expect
		.poll(
			async () =>
				(await botMessages()).find((item) => item.role === 'bot' && !item.notification)?.status,
		)
		.toBe('completed');
	assert.equal(requests.filter((item) => item.model === 'scheduler-bot').length, 2);
	await expect
		.poll(async () => (await botMessages()).find((item) => item.content === reminderText)?.status)
		.toBe('completed');
	assert.equal(
		requests.filter((item) => item.model === 'scheduler-bot').length,
		2,
		'Bot reminder delivery requires no additional inference',
	);
	const codeJob = await command({
		type: 'create',
		idempotencyKey: 'native-code-schedule',
		job: {
			title: 'Native Code scheduled work',
			schedule: { kind: 'once', at: Date.now() + 2000, missed: 'once' },
			target: { kind: 'code', threadId: 'scheduler-code-thread', prompt: codeWork },
		},
	});
	await expect
		.poll(
			async () =>
				(await snapshot()).occurrences.find((item) => item.jobId === codeJob.jobId)?.status,
		)
		.toBe('admitted');
	await expect
		.poll(async () =>
			page.evaluate(
				async () =>
					(await window.desktop.load()).threads
						.find((item) => item.id === 'scheduler-code-thread')
						?.messages.at(-1)?.content,
			),
		)
		.toBe(codeResult);
	await expect
		.poll(async () => (await botMessages()).find((item) => item.content === botResult)?.status)
		.toBe('completed');
	assert.equal(requests.filter((item) => item.model === 'scheduler-bot').length, 3);
	assert.equal(requests.filter((item) => item.model === 'scheduler-code').length, 1);
	await expect
		.poll(
			async () =>
				(await snapshot()).occurrences.filter((item) =>
					['delivered', 'admitted'].includes(item.status),
				).length,
		)
		.toBe(4);
	const before = await snapshot();
	await page.screenshot({ path: '/tmp/freelm-scheduler-native.png' });
	await stop();
	await launch();
	await new Promise((resolve) => setTimeout(resolve, 2200));
	const after = await snapshot();
	assert.deepEqual(
		after.occurrences.map((item) => [item.id, item.status]).sort(),
		before.occurrences.map((item) => [item.id, item.status]).sort(),
		'Completed deliveries are not repeated after restart',
	);
	assert.equal(requests.length, 4);
	assert.equal(
		(await botMessages()).filter((item) => item.notification?.type === 'scheduled').length,
		2,
	);
	const stored = JSON.parse(await readFile(path.join(home, 'scheduler', 'jobs.json'), 'utf8'));
	const mailbox = JSON.parse(await readFile(path.join(home, 'bots', 'workspace.json'), 'utf8'));
	assert.equal(stored.occurrences.length, 4);
	assert.equal(mailbox.scheduledDeliveries.length, 2);
	assert.equal(mailbox.conversations[0].messages.filter((item) => item.role === 'user').length, 1);
	const state = await page.evaluate(() => window.desktop.load());
	assert.equal(
		state.threads
			.find((item) => item.id === 'scheduler-code-thread')
			.messages.filter((item) => item.role === 'user' && item.content === codeWork).length,
		1,
	);
	assert.deepEqual(providerErrors, []);
	assert.deepEqual(rendererErrors, []);
	await writeFile(
		'/tmp/freelm-scheduler-native-result.json',
		JSON.stringify(
			{
				passed: true,
				providerRequests: requests.length,
				occurrences: stored.occurrences.map(({ id, status }) => ({ id, status })),
				botReceipts: mailbox.scheduledDeliveries.length,
				screenshot: '/tmp/freelm-scheduler-native.png',
			},
			null,
			2,
		),
	);
	passed = true;
	console.log(
		'PASS: native Settings/preload scheduling, pause/resume persistence, exact no-model reminders, real Bot scheduler tools and scheduled wake, Code queue execution, restart dedup, durable records, and isolated profile. Screenshot: /tmp/freelm-scheduler-native.png',
	);
} catch (error) {
	await page?.screenshot({ path: '/tmp/freelm-scheduler-native-failed.png' }).catch(() => {});
	console.error('Provider fixture errors:', providerErrors);
	console.error('Renderer fixture errors:', rendererErrors);
	console.error('Electron stderr tail:', stderr);
	console.error('Disposable failure profile retained:', home);
	throw error;
} finally {
	await stop();
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
	if (passed) await rm(home, { recursive: true, force: true });
}
