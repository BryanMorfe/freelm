import { _electron as electron, expect as playwrightExpect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

// Actual renderer -> preload -> host catalog/tools -> loopback provider, using a
// disposable profile. FREELM_SMOKE_EXECUTABLE selects a staged packaged build.
const require = createRequire(import.meta.url);
const expect = playwrightExpect.configure({ timeout: 30_000 });
const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'freelm-code-prompts-smoke-')));
const workspace = path.join(home, 'project');
await mkdir(workspace);
const sources = {
	'AGENTS.md': 'NATIVE_PROMPT_REPOSITORY: preserve existing project edits.',
	'MEMORY.md': 'NATIVE_PROMPT_MEMORY: the fixture uses a loopback provider.',
};
for (const [name, content] of Object.entries(sources))
	await writeFile(path.join(workspace, name), content);
const projectInstruction = 'NATIVE_PROMPT_PROJECT: verify requested changes.';
const sentinels = ['NATIVE_PROMPT_REPOSITORY', 'NATIVE_PROMPT_MEMORY', 'NATIVE_PROMPT_PROJECT'];
const commandOutput = 'freelm-code-prompt-check';
const requests = new Map([
	['responses', []],
	['chat/completions', []],
]);
const providerErrors = [],
	rendererErrors = [];
let desktop, page;
let stderr = '';

const textOf = (content) =>
	typeof content === 'string' ? content : (content ?? []).map((part) => part.text ?? '').join('\n');
const instructionsOf = (body) =>
	body.instructions ?? body.messages?.find((message) => message.role === 'system')?.content ?? '';
const contextOf = (body) =>
	(body.input ?? body.messages ?? [])
		.filter((message) => message.role === 'user')
		.map((message) => textOf(message.content))
		.find((text) => text.includes('NATIVE_PROMPT_REPOSITORY'));
const finalText = (api) => `Native Code prompt and command verified (${api}).`;
function sse(response, events) {
	response.writeHead(200, { 'content-type': 'text/event-stream' });
	response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
}
function answer(response, api, text) {
	if (api === 'responses') {
		const message = {
			type: 'message',
			role: 'assistant',
			content: [{ type: 'output_text', text }],
		};
		sse(response, [
			{ type: 'response.output_text.delta', delta: text },
			{ type: 'response.completed', response: { status: 'completed', output: [message] } },
		]);
	} else
		sse(response, [
			{ choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
			{ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
		]);
}
const server = createServer(async (request, response) => {
	try {
		let raw = '';
		for await (const chunk of request) raw += chunk.toString();
		const body = JSON.parse(raw || '{}');
		const api =
			request.url === '/v1/responses'
				? 'responses'
				: request.url === '/v1/chat/completions'
					? 'chat/completions'
					: undefined;
		assert.ok(api, `Unexpected fixture route: ${request.url}`);
		if (instructionsOf(body).startsWith('Write a short conversation title')) {
			answer(response, api, 'Native prompt validation');
			return;
		}
		const received = requests.get(api);
		received.push(body);
		assert.equal(body.model, `prompt-${api === 'responses' ? 'responses' : 'chat'}`);
		assert.equal(body.stream, true);
		assert.match(instructionsOf(body), /Code working principles/);
		assert.match(instructionsOf(body), /NATIVE_CODE_STYLE/);
		assert.doesNotMatch(instructionsOf(body), /NATIVE_PROMPT_(?:REPOSITORY|MEMORY|PROJECT)/);
		const supplied = contextOf(body);
		assert.ok(supplied, 'Source-labelled context must reach the provider');
		for (const marker of sentinels) {
			const userText = (body.input ?? body.messages)
				.filter((item) => item.role === 'user')
				.map((item) => textOf(item.content))
				.join('\n');
			assert.equal(userText.split(marker).length - 1, 1, `${marker} appears once per request`);
		}
		assert.match(supplied, /AGENTS\.md/);
		assert.match(supplied, /MEMORY\.md/);
		assert.ok(body.tools.some((tool) => (tool.function ?? tool).name === 'exec_command'));
		const callId = `command-${api === 'responses' ? 'responses' : 'chat'}`;
		if (received.length === 1) {
			const args = JSON.stringify({
				cmd: "printf 'freelm-code-prompt-check\\n'",
				shell: '/bin/sh',
				yield_time_ms: 1000,
			});
			if (api === 'responses') {
				const item = {
					type: 'function_call',
					id: `item-${callId}`,
					call_id: callId,
					name: 'exec_command',
					arguments: args,
					status: 'completed',
				};
				sse(response, [
					{ type: 'response.output_item.done', output_index: 0, item },
					{ type: 'response.completed', response: { status: 'completed', output: [item] } },
				]);
			} else
				sse(response, [
					{
						choices: [
							{
								index: 0,
								delta: {
									role: 'assistant',
									tool_calls: [
										{
											index: 0,
											id: callId,
											type: 'function',
											function: { name: 'exec_command', arguments: args },
										},
									],
								},
								finish_reason: null,
							},
						],
					},
					{ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
				]);
		} else {
			assert.equal(received.length, 2, 'Expected one command and one continuation');
			const output =
				api === 'responses'
					? body.input.find(
							(item) => item.type === 'function_call_output' && item.call_id === callId,
						)?.output
					: body.messages.find((item) => item.role === 'tool' && item.tool_call_id === callId)
							?.content;
			assert.match(JSON.stringify(output), new RegExp(commandOutput));
			answer(response, api, finalText(api));
		}
	} catch (error) {
		providerErrors.push(error.message);
		if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
		response.end(JSON.stringify({ error: { message: error.message } }));
	}
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

try {
	const executablePath = process.env.FREELM_SMOKE_EXECUTABLE;
	const env = { ...process.env, FREELM_HOME: home, FREELM_USER_DATA: home };
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
	await page.waitForFunction(() => !!window.desktop?.storageInfo);
	await page.locator('.app-shell').waitFor();
	assert.equal(
		(await page.evaluate(() => window.desktop.storageInfo())).location,
		path.join(home, 'config.json'),
		'Assert disposable profile before reading or saving workspace state',
	);
	assert.equal(
		await desktop.evaluate(({ app }) => app.getPath('userData')),
		path.join(home, 'electron'),
		'Electron data must also be isolated',
	);
	const stamp = Date.now();
	const connections = ['responses', 'chat/completions'].map((api) => {
		const suffix = api === 'responses' ? 'responses' : 'chat';
		return {
			id: `fixture-${suffix}`,
			name: `Prompt fixture ${suffix}`,
			baseUrl,
			apiKey: '',
			chatApi: api,
			models: { chat: `prompt-${suffix}`, images: '', videos: '', speech: '', transcription: '' },
			discoveredModels: [],
			catalog: [
				{
					id: `prompt-${suffix}`,
					name: `Prompt ${suffix}`,
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
					defaultThinkingMode: 'low',
				},
			],
		};
	});
	const seed = {
		version: 1,
		connections,
		activeConnectionId: connections[0].id,
		theme: 'dark',
		backgroundNotifications: false,
		generations: [],
		personalization: Object.fromEntries(
			['chat', 'code'].map((kind) => [
				kind,
				{
					personality: kind === 'code' ? 'efficient' : 'default',
					warmth: 'default',
					enthusiasm: 'default',
					responseLength: 'default',
					formatting: 'default',
					emojis: 'default',
					customInstructions: kind === 'code' ? 'NATIVE_CODE_STYLE: use plain language.' : '',
				},
			]),
		),
		projects: [
			{
				id: 'prompt-project',
				name: 'Prompt fixture project',
				kind: 'code',
				instructions: projectInstruction,
				directories: [workspace],
				createdAt: stamp,
			},
		],
		threads: connections.map((connection) => ({
			id: `thread-${connection.id}`,
			title: `Native ${connection.chatApi}`,
			kind: 'code',
			projectId: 'prompt-project',
			connectionId: connection.id,
			model: connection.models.chat,
			thinkingMode: 'low',
			permissionMode: 'full-access',
			createdAt: stamp,
			updatedAt: stamp,
			messages: [
				{ id: `${connection.id}-setup`, role: 'user', content: 'Fixture setup.', createdAt: stamp },
				{
					id: `${connection.id}-ready`,
					role: 'assistant',
					content: 'Ready for the native prompt check.',
					createdAt: stamp,
					completedAt: stamp,
				},
			],
		})),
		toolSettings: {
			enabled: true,
			workspaceRoot: workspace,
			commandExecution: true,
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
	};
	await page.evaluate(async (seed) => {
		const current = await window.desktop.workspaceLoad('local');
		await window.desktop.workspaceSave('local', current.revision, { ...current.state, ...seed });
	}, seed);
	await page.reload();
	await expect(page.getByRole('button', { name: 'Home', exact: true })).toBeVisible();
	const mode = page.getByRole('combobox', { name: 'Conversation mode', exact: true });
	if (!(await mode.isVisible()))
		await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
	await mode.click();
	await page.getByRole('listbox').locator('[role="option"][data-value="code"]').click();
	await expect(mode).toHaveText('Code');
	for (const connection of connections) {
		const api = connection.chatApi;
		await page.getByRole('button', { name: `Native ${api}`, exact: true }).click();
		await page
			.getByLabel('Message', { exact: true })
			.fill('Run the benign fixture command and confirm the result.');
		await page.getByRole('button', { name: 'Send message', exact: true }).click();
		await expect(page.locator('.message.assistant').last()).toContainText(finalText(api));
		await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toHaveCount(0);
		await expect(page.locator('.message.assistant [role="alert"]')).toHaveCount(0);
		await expect
			.poll(async () => {
				const stored = await page.evaluate(() => window.desktop.load());
				return stored.threads
					.find((thread) => thread.id === `thread-${connection.id}`)
					?.messages.at(-1)?.completedAt;
			})
			.toBeTruthy();
		const stored = await page.evaluate(() => window.desktop.load());
		const assistant = stored.threads
			.find((thread) => thread.id === `thread-${connection.id}`)
			.messages.at(-1);
		assert.equal(assistant.content, finalText(api));
		assert.equal(assistant.error, undefined);
		assert.deepEqual(
			assistant.toolCalls.map((call) => [call.name, call.status]),
			[['exec_command', 'completed']],
		);
		assert.match(JSON.stringify(assistant.toolCalls[0].result), new RegExp(commandOutput));
		for (const marker of sentinels)
			assert.ok(
				!JSON.stringify(assistant.agentTranscript).includes(marker),
				'Supplied context must not be persisted into the model transcript',
			);
		assert.equal(requests.get(api).length, 2);

		await page.getByRole('button', { name: 'Personal workspace settings', exact: true }).click();
		const settings = page.getByRole('region', { name: 'Settings', exact: true });
		await settings.getByRole('button', { name: 'System', exact: true }).click();
		await settings.getByRole('combobox', { name: 'Prompt conversation', exact: true }).click();
		await page
			.getByRole('listbox')
			.locator(`[role="option"][data-value="thread-${connection.id}"]`)
			.click();
		await expect(settings.locator('pre[aria-label="Generated system prompt"]')).toContainText(
			'Code working principles',
		);
		const lastBody = requests.get(api).at(-1);
		console.log(
			`${api}: native command and transcript passed; Settings snapshot count=${await settings.locator('pre[aria-label="Last sent system prompt"]').count()}, empty=${await settings.getByText('No sent prompt snapshot is available for this conversation in this app session.', { exact: true }).count()}`,
		);
		await expect(settings.locator('pre[aria-label="Last sent system prompt"]')).toHaveText(
			instructionsOf(lastBody),
		);
		await expect(settings.locator('pre[aria-label="Last sent user-role context"]')).toHaveText(
			contextOf(lastBody),
		);
		await expect(settings.locator('pre[aria-label="Generated user-role context"]')).toHaveText(
			contextOf(lastBody),
		);
		await settings.getByRole('button', { name: 'Back to workspace', exact: true }).click();
	}
	for (const [name, content] of Object.entries(sources))
		assert.equal(await readFile(path.join(workspace, name), 'utf8'), content);
	assert.deepEqual(providerErrors, []);
	assert.deepEqual(rendererErrors, []);
	await page.screenshot({ path: '/tmp/freelm-code-prompts-native.png' });
	console.log(
		'PASS: packaged Code prompt assembly, source-labelled user context, real command/continuation, persistence isolation, and exact Settings preview/last-sent snapshots on Responses and Chat Completions.',
	);
} catch (error) {
	await page?.screenshot({ path: '/tmp/freelm-code-prompts-native-failed.png' }).catch(() => {});
	console.error('Provider fixture errors:', providerErrors);
	console.error('Renderer fixture errors:', rendererErrors);
	console.error('Electron stderr tail:', stderr);
	throw error;
} finally {
	await desktop?.evaluate(({ app }) => app.exit()).catch(() => {});
	await desktop?.close().catch(() => {});
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
	await rm(home, { recursive: true, force: true });
}
