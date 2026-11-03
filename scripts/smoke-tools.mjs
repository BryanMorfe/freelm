import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

// Runs the packaged renderer and real preload/host runtime against a loopback-only
// provider fixture. All persistence and command execution use a temporary profile.
const userData = await mkdtemp(path.join(os.tmpdir(), 'freelm-tool-smoke-'));
const workdir = path.join(userData, 'workspace');
await mkdir(workdir);
const png =
	'iVBORw0KGgoAAAANSUhEUgAAAKAAAAB4CAIAAAD6wG44AAABLklEQVR4nO3RAQkAIBDAwC9kU8MawRQijIMLMNisfQib7wU8ZXCcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEXmJqKRaCsQ4gAAAAASUVORK5CYII=';
const requests = [];
const imageRequests = [];
const providerErrors = [];
const finalText =
	'Native tools completed: command ran, your blue answer arrived, and the image was generated.';
const question = 'Which color should the test image use?';
const progressMessage = 'The image is ready; I am finishing the response.';
const firstUpdate = 'I will run the command, then ask which color to use.';
const secondUpdate = 'The command finished. I will confirm the image color next.';
const title = 'Native tool inspection';
const completeText = `${firstUpdate}\n\n${secondUpdate}\n\n${finalText}`;
let releaseReasoning;

function toolOutput(body, id) {
	const output = body.input.find(
		(item) => item.type === 'function_call_output' && item.call_id === id,
	);
	assert.ok(output, `Provider continuation must include output for ${id}`);
	return JSON.stringify(output.output);
}

function sendTool(response, name, args, id, text = '') {
	const argumentsText = JSON.stringify(args);
	const item = {
		id: `item-${id}`,
		type: 'function_call',
		name,
		call_id: id,
		arguments: argumentsText,
		status: 'completed',
	};
	const message = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] };
	const outputIndex = text ? 1 : 0;
	const events = [
		...(text ? [{ type: 'response.output_text.delta', delta: text }] : []),
		{
			type: 'response.output_item.added',
			output_index: outputIndex,
			item: { ...item, arguments: '', status: 'in_progress' },
		},
		{
			type: 'response.function_call_arguments.delta',
			output_index: outputIndex,
			item_id: item.id,
			delta: argumentsText.slice(0, 8),
		},
		{
			type: 'response.function_call_arguments.delta',
			output_index: outputIndex,
			item_id: item.id,
			delta: argumentsText.slice(8),
		},
		{ type: 'response.output_item.done', output_index: outputIndex, item },
		{
			type: 'response.completed',
			response: {
				id: `response-${id}`,
				status: 'completed',
				output: text ? [message, item] : [item],
			},
		},
	];
	if (!response.headersSent) response.writeHead(200, { 'content-type': 'text/event-stream' });
	// Completion deliberately ends at EOF without a final event separator.
	response.end(events.map((event) => `data: ${JSON.stringify(event)}`).join('\n\n'));
}

const server = createServer(async (request, response) => {
	try {
		let raw = '';
		for await (const chunk of request) raw += chunk.toString();
		const body = JSON.parse(raw || '{}');
		if (body.instructions?.startsWith('Write a short conversation title')) {
			response.writeHead(200, { 'content-type': 'text/event-stream' });
			response.end(
				`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: title })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { output_text: title } })}\n\n`,
			);
			return;
		}
		if (request.url === '/v1/images/generations') {
			imageRequests.push(body);
			assert.equal(body.model, 'configured-image-tool-model');
			assert.equal(body.size, '1536x864');
			assert.equal(body.quality, 'high');
			assert.equal(body.prompt, 'A blue rectangle for the native tool fixture.');
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(JSON.stringify({ data: [{ b64_json: png }] }));
			return;
		}
		assert.equal(request.url, '/v1/responses');
		assert.deepEqual(body.reasoning, { effort: 'low' });
		requests.push(body);
		assert.equal(body.model, 'native-tool-chat');
		assert.equal(body.stream, true);
		assert.ok(body.tools.some((tool) => tool.name === 'exec_command'));
		assert.ok(body.tools.some((tool) => tool.name === 'request_user_input'));
		const imageTool = body.tools.find((tool) => tool.name.startsWith('image_gen_imagegen_'));
		assert.ok(imageTool, 'Configured image tool must be advertised');
		assert.match(imageTool.description, /configured-image-tool-model/);
		const sizeGuidance = JSON.stringify(imageTool);
		assert.match(sizeGuidance, /Fixture wide/);
		assert.match(sizeGuidance, /16:9/);
		assert.match(sizeGuidance, /1536x864/);
		assert.equal(imageTool.parameters.properties.size.type, 'string');
		switch (requests.length) {
			case 1:
				response.writeHead(200, { 'content-type': 'text/event-stream' });
				response.write(
					'data: {"type":"response.reasoning_text.delta","delta":"Inspecting the fixture."}\n\n',
				);
				await new Promise((resolve) => {
					releaseReasoning = resolve;
				});
				sendTool(
					response,
					'exec_command',
					{ cmd: "printf 'native-tool-check\\n'", shell: '/bin/sh', yield_time_ms: 1000 },
					'call-command',
					firstUpdate,
				);
				break;
			case 2:
				assert.match(toolOutput(body, 'call-command'), /native-tool-check/);
				sendTool(
					response,
					'request_user_input',
					{
						questions: [
							{
								id: 'color',
								header: 'Color',
								question,
								options: [
									{ label: 'Blue', description: 'Use blue for this fixture.' },
									{ label: 'Green', description: 'Use green for this fixture.' },
								],
							},
						],
					},
					'call-question',
					secondUpdate,
				);
				break;
			case 3:
				assert.match(toolOutput(body, 'call-question'), /Blue/);
				sendTool(
					response,
					imageTool.name,
					{ prompt: 'A blue rectangle for the native tool fixture.', size: '1536x864' },
					'call-image',
				);
				break;
			case 4:
				assert.match(toolOutput(body, 'call-image'), /configured-image-tool-model/);
				assert.ok(
					JSON.stringify(body.input).includes(png),
					'Generated image must be included in model continuation',
				);
				sendTool(
					response,
					'send_message_to_user_async',
					{ message: progressMessage },
					'call-progress',
				);
				break;
			case 5:
				assert.match(toolOutput(body, 'call-progress'), /The image is ready/);
				response.writeHead(200, { 'content-type': 'text/event-stream' });
				response.end(
					`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: finalText })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: finalText }] }] } })}`,
				);
				break;
			default:
				throw new Error('Unexpected additional model request.');
		}
	} catch (error) {
		providerErrors.push(error.message);
		if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
		response.end(JSON.stringify({ error: { message: error.message } }));
	}
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
let desktop;
let page;
const rendererErrors = [];
let stderr = '';
try {
	const env = { ...process.env, FREELM_USER_DATA: userData };
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.FREELM_DEV_URL;
	delete env.FREELM_HOME;
	desktop = await electron.launch({ args: ['.'], env });
	desktop.process().stderr?.on('data', (data) => {
		stderr = (stderr + data.toString()).slice(-6000);
	});
	page = await desktop.firstWindow();
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	page.on('pageerror', (error) => rendererErrors.push(error.message));
	await page.waitForFunction(() => !!window.desktop?.toolCatalog);
	await page.locator('.app-shell').waitFor();
	await page.getByLabel('Message', { exact: true }).waitFor();
	assert.equal(
		(await page.evaluate(() => window.desktop.storageInfo())).location,
		path.join(userData, 'config.json'),
		'Tool smoke must use its disposable profile before writing any state',
	);
	const state = {
		version: 1,
		connections: [
			{
				id: 'fixture',
				name: 'Tool fixture',
				baseUrl,
				apiKey: '',
				chatApi: 'responses',
				models: {
					chat: 'native-tool-chat',
					images: 'unused-default-image-model',
					videos: '',
					speech: '',
					transcription: '',
				},
				discoveredModels: [],
				catalog: [
					{
						id: 'native-tool-chat',
						name: 'native-tool-chat',
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
					{
						id: 'configured-image-tool-model',
						name: 'Fixture image model',
						enabled: true,
						tasks: ['images'],
						inputModalities: ['text', 'image'],
						outputModalities: ['image'],
						thinkingModes: [],
						imagePresets: [
							{
								id: 'fixture-wide',
								name: 'Fixture wide',
								aspectRatios: [{ id: 'wide', name: '16:9', width: 1536, height: 864 }],
							},
						],
					},
				],
			},
		],
		activeConnectionId: 'fixture',
		threads: [],
		projects: [],
		generations: [],
		theme: 'dark',
		toolSettings: {
			enabled: true,
			workspaceRoot: workdir,
			commandExecution: true,
			approvalMode: 'ask',
			allowRemote: false,
			imageGeneration: {
				enabled: true,
				connectionId: 'fixture',
				model: 'configured-image-tool-model',
				size: '1024x1024',
				quality: 'high',
			},
			mcpServers: [],
			skillDirectories: [],
		},
	};
	await page.evaluate(async (next) => {
		const current = await window.desktop.workspaceLoad('local');
		await window.desktop.workspaceSave('local', current.revision, next);
	}, state);
	await page.reload();
	await page.getByRole('button', { name: 'Home', exact: true }).click();
	await page.getByRole('combobox', { name: 'Conversation mode', exact: true }).click();
	await page.getByRole('listbox').locator('[role="option"][data-value="code"]').click();
	const modelPicker = page.getByRole('button', { name: 'Chat model', exact: true });
	await expect(modelPicker.locator('.composer-model-name')).toHaveText('native-tool-chat');
	await expect(modelPicker.locator('.composer-thinking-value')).toHaveText('Low');
	await page
		.getByLabel('Message', { exact: true })
		.fill('Run the native tool check, ask which color, then generate a fixture image.');
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	await expect(page.locator('.working-section-header')).toContainText('Working for');
	await expect(page.getByRole('status', { name: 'Working on response', exact: true })).toHaveText(
		/^Working for [1-9]\d*s$/,
		{ timeout: 5000 },
	);
	assert.notEqual(
		await page
			.locator('.working-status .activity-shimmer')
			.evaluate((node) => getComputedStyle(node).animationName),
		'none',
	);
	await page.screenshot({ path: '/tmp/freelm-working-native.png' });
	await expect.poll(() => typeof releaseReasoning).toBe('function');
	releaseReasoning();
	const approval = page.getByRole('region', { name: 'Pending tool approvals', exact: true });
	await expect(approval).toBeVisible({ timeout: 15000 });
	await expect(page.getByRole('dialog', { name: 'Approve tool action', exact: true })).toHaveCount(
		0,
	);
	await expect(approval).toContainText('native-tool-check');
	await expect(page.getByText(firstUpdate, { exact: true })).toBeVisible();
	const activeCommand = page.locator(
		'.message-live-text .tool-call[data-tool-id="call-command"][data-activity-state="active"]',
	);
	await expect(activeCommand.locator('.activity-label-text')).toHaveText(
		/^(?:Waiting for approval: )?Running printf 'native-tool-check\\n'$/,
	);
	await expect(activeCommand.locator('.activity-shimmer')).toHaveCount(1);
	await expect(page.locator('.tool-debug-details')).toHaveCount(0);
	assert.equal(requests.length, 1, 'The model must wait for approval before seeing command output');
	await approval.getByRole('button', { name: 'Allow once', exact: true }).click();
	const interaction = page.getByRole('region', { name: 'Assistant question', exact: true });
	await expect(interaction).toBeVisible({ timeout: 15000 });
	await expect(interaction).toContainText(question);
	await expect(page.getByText(secondUpdate, { exact: true })).toBeVisible();
	await expect(
		page.locator(
			'.message-live-text .tool-call[data-tool-id="call-command"][data-activity-state="active"]',
		),
	).toHaveCount(0);
	await expect(
		page.locator('.message-live-text .tool-call[data-activity-state="active"]'),
	).toHaveCount(1);
	await interaction.getByRole('button', { name: /^Blue/ }).click();
	await interaction.getByRole('button', { name: 'Send', exact: true }).click();
	await expect(approval).toContainText('Generate image');
	assert.equal(imageRequests.length, 0, 'Image generation must wait for its own approval');
	await approval.getByRole('button', { name: 'Allow once', exact: true }).click();
	await expect(page.locator('.message.assistant')).toContainText(finalText, { timeout: 15000 });
	await expect(page.getByRole('button', { name: 'Stop response' })).toHaveCount(0);
	await expect(page.locator('.message.assistant [role="alert"]')).toHaveCount(0);
	await expect(page.locator('.tool-images img')).toBeVisible();
	await expect(page.locator('.chat-image-result')).toHaveCount(1);
	const summary = page.locator('.thought-summary');
	await expect(summary).toHaveText(/^Worked for \d+(?:s|m \d+s)$/);
	await expect(summary).toHaveAttribute('aria-expanded', 'false');
	await expect(page.locator('.thought-history')).toHaveCount(0);
	await expect(page.getByText(firstUpdate, { exact: true })).toHaveCount(0);
	await expect(page.getByText(progressMessage, { exact: true })).toHaveCount(0);
	await expect(page.locator('.message-final')).toHaveText(finalText);
	await expect(page.locator('.working-status')).toHaveCount(0);
	await expect(page.locator('.message.assistant .activity-shimmer')).toHaveCount(0);
	await page.screenshot({ path: '/tmp/freelm-tools-native-collapsed.png' });
	await summary.click();
	await expect(summary).toHaveAttribute('aria-expanded', 'true');
	await expect(page.getByText(progressMessage, { exact: true })).toBeVisible();
	await expect(page.locator('.tool-message pre')).toHaveCount(0);
	await expect(page.locator('.thought-history img')).toHaveCount(0);
	await expect(page.locator('.tool-images img')).toHaveCount(1);
	const expectedTimeline = [
		firstUpdate,
		'call-command',
		secondUpdate,
		'call-question',
		'call-image',
		'call-progress',
		finalText,
	];
	const history = () =>
		page
			.locator('.thought-history > div')
			.evaluateAll((nodes) =>
				nodes.map(
					(node) =>
						node.querySelector('[data-tool-id]')?.getAttribute('data-tool-id') || node.textContent,
				),
			);
	const expectedHistory = [
		firstUpdate,
		'call-command',
		secondUpdate,
		'call-question',
		'call-image',
		'call-progress',
	];
	assert.deepEqual(await history(), expectedHistory);
	await expect(page.locator('.thread-select').filter({ hasText: title })).toBeVisible();
	await page.getByTitle('Open generated image', { exact: true }).click();
	const imagePreview = page.getByRole('dialog', { name: 'Image viewer', exact: true });
	await expect(imagePreview.locator('.image-viewer-image img')).toBeVisible();
	await expect(
		imagePreview.getByRole('link', { name: 'Download image', exact: true }),
	).toBeVisible();
	await expect(imagePreview.getByLabel('Describe image edits', { exact: true })).toHaveCount(0);
	await imagePreview.getByRole('button', { name: 'Full screen', exact: true }).click();
	const fullscreen = page.getByRole('dialog', { name: 'Full screen image', exact: true });
	await expect(fullscreen.getByRole('button')).toHaveCount(1);
	await fullscreen.click({ position: { x: 5, y: 5 } });
	await imagePreview.getByRole('button', { name: 'Close image viewer', exact: true }).click();
	await expect(imagePreview).toBeHidden();
	await page.screenshot({ path: '/tmp/freelm-tools-native.png' });
	assert.deepEqual(providerErrors, []);
	assert.equal(requests.length, 5);
	assert.equal(imageRequests.length, 1);
	assert.deepEqual(rendererErrors, []);
	await expect
		.poll(async () => {
			const stored = JSON.parse(await readFile(path.join(userData, 'workspace.json'), 'utf8'));
			return stored.threads[0]?.messages.at(-1)?.content;
		})
		.toBe(completeText);
	const stored = JSON.parse(await readFile(path.join(userData, 'workspace.json'), 'utf8'));
	const config = JSON.parse(await readFile(path.join(userData, 'config.json'), 'utf8'));
	assert.equal(stored.format, 'freelm-workspace-v2');
	assert.equal(stored.threads.length, 1);
	assert.equal(stored.threads[0].kind, 'code');
	assert.equal(stored.generations.length, 1);
	assert.equal(stored.toolSettings, undefined);
	assert.equal(stored.connections, undefined);
	assert.equal(config.format, 'freelm-config-v1');
	assert.deepEqual(config.toolSettings, state.toolSettings);
	assert.equal(config.connections.length, 1);
	assert.equal(config.threads, undefined);
	assert.equal(config.generations, undefined);
	const assistant = stored.threads[0].messages.at(-1);
	assert.equal(stored.threads[0].title, title);
	assert.ok(assistant.completedAt >= assistant.createdAt);
	assert.ok(assistant.activityFinishedAt >= assistant.createdAt);
	assert.ok(assistant.activityFinishedAt <= assistant.completedAt);
	assert.deepEqual(
		assistant.activity.map((part) => (part.type === 'text' ? part.text : part.toolCallId)),
		expectedTimeline,
	);
	assert.deepEqual(
		assistant.toolCalls.map((call) => ({ name: call.name, status: call.status })),
		[
			{ name: 'exec_command', status: 'completed' },
			{ name: 'request_user_input', status: 'completed' },
			{ name: 'image_gen.imagegen', status: 'completed' },
			{ name: 'send_message_to_user_async', status: 'completed' },
		],
	);
	assert.equal(assistant.agentTranscript.api, 'responses');
	assert.equal(
		assistant.agentTranscript.items.filter((item) => item.type === 'function_call_output').length,
		4,
	);
	assert.equal(stored.generations[0].model, 'configured-image-tool-model');
	assert.equal(stored.generations[0].parameters.size, '1536x864');
	assert.equal(stored.generations[0].assets[0].url, `data:image/png;base64,${png}`);
	await page.reload();
	await page.getByRole('button', { name: 'Home', exact: true }).click();
	await page.getByRole('combobox', { name: 'Conversation mode', exact: true }).click();
	await page.getByRole('listbox').locator('[role="option"][data-value="code"]').click();
	await page.getByRole('button', { name: title, exact: true }).click();
	await expect(page.locator('.tool-images img')).toBeVisible();
	await expect(page.locator('.message.assistant')).toContainText(finalText);
	await expect(page.locator('.thought-summary')).toHaveAttribute('aria-expanded', 'false');
	await expect(page.getByText(progressMessage, { exact: true })).toHaveCount(0);
	await page.locator('.thought-summary').click();
	await expect(page.getByText(progressMessage, { exact: true })).toBeVisible();
	assert.deepEqual(await history(), expectedHistory);
	await expect(page.locator('.thought-history img')).toHaveCount(0);
	await expect(page.locator('.working-status')).toHaveCount(0);
	await page.getByRole('button', { name: 'Images', exact: true }).click();
	await expect(page.locator('.image-gallery-image')).toBeVisible();
	assert.deepEqual(rendererErrors, []);
	await page.screenshot({ path: '/tmp/freelm-tools-native-gallery.png' });
	console.log(
		'Native Code tools smoke passed: elapsed Working for header and Thinking shimmer, one replaceable active tool label, completed Worked for disclosure, ordered intermediate prose/tools, real approved exec_command, user question, configured image model/preset guidance and per-call size, visible generated assets, generated title, gallery and persisted timeline across reload.',
	);
} catch (error) {
	await page?.screenshot({ path: '/tmp/freelm-tools-native-failed.png' }).catch(() => {});
	console.error('Provider fixture errors:', providerErrors);
	console.error('Renderer fixture errors:', rendererErrors);
	console.error('Electron stderr tail:', stderr);
	console.error(error);
	// A failed fixture may leave a provider round pending. Do not hang cleanup.
	desktop?.process().kill('SIGKILL');
	throw error;
} finally {
	releaseReasoning?.();
	await desktop?.evaluate(({ app }) => app.exit()).catch(() => {});
	await desktop?.close().catch(() => {});
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
	await rm(userData, { recursive: true, force: true });
}
