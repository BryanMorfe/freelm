import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

// Native preload/host/provider/runtime/approval/persistence proof in a disposable profile.
const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'freelm-workflows-smoke-')));
const failures = [],
	requests = [],
	rendererErrors = [];
const diagnostics = [];
let desktop;
const server = createServer(async (req, res) => {
	try {
		assert.equal(req.url, '/v1/chat/completions');
		let raw = '';
		for await (const chunk of req) raw += chunk;
		const body = JSON.parse(raw);
		requests.push(body);
		const tools = body.tools ?? [];
		const result = body.messages?.some((message) => message.role === 'tool');
		const content = tools.length ? 'Native workflow agent completed' : 'Native workflow draft';
		const message =
			tools.length && !result
				? {
						role: 'assistant',
						content: '',
						tool_calls: [
							{
								id: `clock-${requests.length}`,
								type: 'function',
								function: { name: tools[0].function.name, arguments: '{}' },
							},
						],
					}
				: { role: 'assistant', content };
		if (!tools.length) await new Promise((resolve) => setTimeout(resolve, 800));
		res.writeHead(200, { 'content-type': 'application/json' }).end(
			JSON.stringify({
				choices: [{ index: 0, finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }],
			}),
		);
	} catch (error) {
		failures.push(error.message);
		if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ error: error.message }));
	}
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const stamp = Date.now();
const node = (id, type, config = {}, x = 80) => ({
	id,
	type,
	label: id,
	config,
	position: { x, y: 120 },
});
const edge = (source, target, sourceHandle = 'value', targetHandle = 'input') => ({
	id: `${source}-${target}`,
	source,
	target,
	sourceHandle,
	targetHandle,
});
const definition = (id, name, nodes, edges) => ({
	version: 1,
	id,
	name,
	enabled: false,
	settings: { workspaceRoot: home },
	nodes,
	edges,
	createdAt: stamp,
	updatedAt: stamp,
});
const env = { ...process.env, FREELM_HOME: home, FREELM_USER_DATA: home };
delete env.ELECTRON_RUN_AS_NODE;
delete env.FREELM_DEV_URL;
async function launch() {
	const executablePath = process.env.FREELM_SMOKE_EXECUTABLE;
	desktop = await electron.launch({
		...(executablePath ? { executablePath, args: [`--user-data-dir=${home}`] } : { args: ['.'] }),
		env,
	});
	const page = await desktop.firstWindow();
	page.setDefaultTimeout(20000);
	page.on('pageerror', (error) => rendererErrors.push(error.message));
	page.on('console', (message) => {
		if (message.type() === 'error') diagnostics.push(message.text());
	});
	page.on('requestfailed', (request) =>
		diagnostics.push(`${request.url()}: ${request.failure()?.errorText}`),
	);
	desktop.process().stderr?.on('data', (data) => diagnostics.push(String(data).slice(0, 2000)));
	await page.locator('.app-shell').waitFor();
	assert.equal(
		await page.evaluate(() => typeof window.desktop.workflowCommand),
		'function',
		'Build Electron before running this smoke test.',
	);
	return page;
}
async function command(page, command) {
	return page.evaluate((command) => window.desktop.workflowCommand(command), command);
}
async function run(page, id, inputs = {}) {
	const snapshot = await command(page, { type: 'run', id, inputs });
	return snapshot.runs
		.filter((run) => run.workflowId === id)
		.sort((a, b) => b.createdAt - a.createdAt)[0].id;
}
async function state(page, runId) {
	return page.evaluate(
		async (id) => (await window.desktop.workflowSnapshot()).runs.find((run) => run.id === id),
		runId,
	);
}
async function completed(page, runId, status = 'completed') {
	await expect
		.poll(
			async () => {
				const run = await state(page, runId);
				if (run?.status === 'failed') throw new Error(run.error || JSON.stringify(run.nodes));
				return run?.status;
			},
			{ timeout: 30000 },
		)
		.toBe(status);
	return state(page, runId);
}
try {
	await writeFile(
		path.join(home, 'config.json'),
		JSON.stringify({
			format: 'freelm-config-v1',
			version: 1,
			encryptedKeys: {},
			theme: 'dark',
			activeConnectionId: 'fixture',
			backgroundNotifications: false,
			memorySettings: { savedMemories: false, referenceHistory: false },
			toolSettings: {
				enabled: true,
				workspaceRoot: home,
				commandExecution: true,
				approvalMode: 'full-access',
				mcpServers: [],
				skillDirectories: [],
				imageGeneration: { enabled: false, connectionId: '', model: '', size: '', quality: '' },
				pythonExecution: { enabled: false },
			},
			connections: [
				{
					id: 'fixture',
					name: 'Workflow fixture',
					baseUrl,
					apiKey: '',
					chatApi: 'chat/completions',
					models: { chat: 'fixture-model', images: '', videos: '', speech: '', transcription: '' },
					discoveredModels: [],
					catalog: [
						{
							id: 'fixture-model',
							name: 'Fixture model',
							enabled: true,
							tasks: ['chat'],
							inputModalities: ['text', 'image'],
							outputModalities: ['text'],
							thinkingModes: [
								{ id: 'low', name: 'Low', parameters: { chat: { reasoning_effort: 'low' } } },
							],
						},
					],
				},
			],
		}),
	);
	await writeFile(
		path.join(home, 'workspace.json'),
		JSON.stringify({
			format: 'freelm-workspace-v2',
			version: 1,
			projects: [],
			threads: [],
			generations: [],
		}),
	);
	const imagePath = path.join(home, 'reference.png');
	await writeFile(
		imagePath,
		Buffer.from(
			'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
			'base64',
		),
	);
	let page = await launch();
	const main = definition(
		'native-pipeline',
		'Native pipeline smoke',
		[
			node('entry', 'entry'),
			node(
				'draft',
				'text',
				{ connectionId: 'fixture', model: 'fixture-model', prompt: 'Write the fixture draft' },
				390,
			),
			node(
				'agent',
				'agent',
				{
					connectionId: 'fixture',
					model: 'fixture-model',
					prompt: 'Use the clock and finish',
					tools: ['clock.curr_time'],
					skills: [],
				},
				700,
			),
			node(
				'code',
				'code',
				{ language: 'javascript', code: 'return inputs.input + " / JavaScript verified";' },
				1010,
			),
			node('save', 'save', { path: 'workflow-result.txt', format: 'text' }, 1320),
			node('output', 'output', { name: 'saved' }, 1630),
		],
		[
			edge('entry', 'draft', 'value', 'prompt'),
			edge('draft', 'agent', 'text', 'prompt'),
			edge('agent', 'code', 'text'),
			edge('code', 'save'),
			edge('save', 'output'),
		],
	);
	const waiting = definition(
		'native-wait',
		'Durable approval wait',
		[
			node('entry', 'entry'),
			node('review', 'wait', { mode: 'human', message: 'Approve fixture output' }, 390),
			node('output', 'output', { name: 'reviewed' }, 700),
		],
		[edge('entry', 'review'), edge('review', 'output')],
	);
	const tool = definition(
		'native-approval',
		'Tool approval smoke',
		[
			node('entry', 'entry'),
			node(
				'command',
				'tool',
				{
					tool: 'exec_command',
					arguments: { cmd: 'printf workflow-native-approval', yield_time_ms: 1000 },
				},
				390,
			),
			node('output', 'output', { name: 'tool' }, 700),
		],
		[edge('entry', 'command'), edge('command', 'output')],
	);
	const media = definition(
		'native-media',
		'Media preview smoke',
		[
			node('image', 'media-transform', {
				path: imagePath,
				operation: 'resize',
				width: 32,
				height: 32,
				format: 'png',
			}),
			node('output', 'output', { name: 'image' }, 390),
		],
		[edge('image', 'output')],
	);
	for (const workflow of [main, waiting, tool, media])
		await command(page, { type: 'save', workflow });
	await page.getByRole('button', { name: 'Workflows', exact: true }).click();
	await page.getByRole('button', { name: /Native pipeline smoke/ }).click();
	await expect(page.getByRole('textbox', { name: 'Workflow name' })).toHaveValue(
		'Native pipeline smoke',
	);
	const mainRun = await run(page, main.id, { topic: 'real native services' });
	await expect
		.poll(() => state(page, mainRun).then((run) => run.nodes.draft.status))
		.toBe('running');
	await page.getByRole('button', { name: 'Home', exact: true }).click();
	const mainResult = await completed(page, mainRun);
	assert.equal(
		await readFile(path.join(home, 'workflow-result.txt'), 'utf8'),
		'Native workflow agent completed / JavaScript verified',
	);
	assert.equal(mainResult.nodes.code.status, 'completed');
	assert.equal(requests.length, 3);
	console.log(
		'PASS: host text -> tool-using agent -> isolated JavaScript -> save completed after navigating away.',
	);
	const waitRun = await run(page, waiting.id, { value: 'Persist this review' });
	await completed(page, waitRun, 'waiting');
	await page.getByRole('button', { name: 'Workflows', exact: true }).click();
	await page.getByRole('button', { name: /Tool approval smoke/ }).click();
	const toolRun = await run(page, tool.id);
	await expect(page.getByRole('button', { name: 'Allow once', exact: true })).toBeVisible();
	assert.equal((await state(page, toolRun)).nodes.command.status, 'running');
	await page.getByRole('button', { name: 'Allow once', exact: true }).click();
	const toolResult = await completed(page, toolRun);
	assert.match(toolResult.nodes.command.output.text, /workflow-native-approval/);
	console.log(
		'PASS: native workflow tool requires explicit UI approval despite global Full access.',
	);
	const mediaRun = await run(page, media.id);
	const mediaResult = await completed(page, mediaRun);
	const asset = mediaResult.nodes.image.output.image;
	assert.ok(asset.path.startsWith(path.join(home, 'workflows', 'artifacts')));
	assert.equal(asset.mimeType, 'image/png');
	await page.getByRole('button', { name: /Media preview smoke/ }).click();
	await page.locator('[data-node-id="image"] .workflow-node-header').click();
	await expect(page.getByAltText('Workflow output')).toBeVisible();
	await expect
		.poll(() => page.getByAltText('Workflow output').evaluate((image) => image.naturalWidth))
		.toBe(32);
	await page.screenshot({ path: '/tmp/freelm-workflows-native.png' });
	await desktop.close();
	desktop = undefined;
	page = await launch();
	const persisted = await page.evaluate(() => window.desktop.workflowSnapshot());
	assert.equal(persisted.workflows.length, 4);
	assert.equal(persisted.runs.find((run) => run.id === mainRun)?.status, 'completed');
	assert.equal(persisted.runs.find((run) => run.id === waitRun)?.status, 'waiting');
	await command(page, { type: 'resume', runId: waitRun, nodeId: 'review' });
	await completed(page, waitRun);
	const preview = await page.evaluate(
		async ({ runId, path }) => {
			const url = await window.desktop.workflowAsset(runId, path);
			return new Promise((resolve, reject) => {
				const image = new Image();
				image.onload = () => resolve({ url, width: image.naturalWidth });
				image.onerror = () => reject(new Error('Persisted media failed to decode'));
				image.src = url;
			});
		},
		{ runId: mediaRun, path: asset.path },
	);
	assert.equal(preview.width, 32);
	assert.match(preview.url, /^freelm-workflow:/);
	assert.deepEqual((await page.evaluate(() => window.desktop.load()))?.threads ?? [], []);
	assert.deepEqual(failures, []);
	assert.deepEqual(rendererErrors, []);
	console.log(
		'PASS: native media preview, run persistence across restart, durable human wait/resume, no synthetic chat history. Screenshot: /tmp/freelm-workflows-native.png',
	);
	await desktop.close();
	desktop = undefined;
	await writeFile(
		path.join(home, 'workflows', 'definitions', 'corrupt-fixture.json'),
		'{invalid workflow JSON',
	);
	page = await launch();
	await page.getByRole('button', { name: 'Home', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Home', exact: true })).toHaveAttribute(
		'aria-current',
		'page',
	);
	await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeEditable();
	const loadError = await page.evaluate(async () => {
		try {
			await window.desktop.workflowSnapshot();
			return '';
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	});
	assert.match(loadError, /Could not load workflows/);
	assert.match(loadError, /other FreeLM workspaces are still available/);
	const commandError = await page.evaluate(async () => {
		try {
			await window.desktop.workflowCommand({ type: 'run', id: 'native-pipeline' });
			return '';
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	});
	assert.match(commandError, /Could not load workflows/);
	assert.equal((await page.evaluate(() => window.desktop.load()))?.connections[0]?.id, 'fixture');
	assert.equal(requests.length, 3);
	assert.deepEqual(rendererErrors, []);
	console.log(
		'PASS: corrupt workflow JSON is isolated; Home remains editable, workspace loads, and workflow commands report a clear load error.',
	);
} catch (error) {
	console.error('Native smoke diagnostics:', diagnostics.slice(-12));
	if (desktop) {
		const page = await desktop.firstWindow();
		await page.screenshot({ path: '/tmp/freelm-workflows-failure.png' }).catch(() => {});
		console.error(
			await page
				.evaluate(async () =>
					(await window.desktop.workflowSnapshot()).runs.map((run) => ({
						workflow: run.workflowName,
						status: run.status,
						error: run.error,
						nodes: Object.values(run.nodes).map((node) => ({
							id: node.nodeId,
							status: node.status,
							error: node.error,
						})),
					})),
				)
				.catch(() => ({})),
		);
	}
	throw error;
} finally {
	if (desktop) await desktop.close();
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
	await rm(home, { recursive: true, force: true });
}
