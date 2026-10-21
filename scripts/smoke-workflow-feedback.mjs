import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

// Native preload/host/provider/runtime/approval/persistence proof in a disposable profile.
const home = await realpath(
	await mkdtemp(path.join(os.tmpdir(), 'freelm-workflow-feedback-smoke-')),
);
const failures = [],
	requests = [],
	rendererErrors = [];
const diagnostics = [];
let desktop;
let correctedFirstRound = false;
const server = createServer(async (req, res) => {
	try {
		assert.equal(req.url, '/v1/chat/completions');
		let raw = '';
		for await (const chunk of req) raw += chunk;
		const body = JSON.parse(raw);
		requests.push(body);
		assert.equal(body.response_format?.type, 'json_schema');
		assert.equal(body.response_format?.json_schema?.strict, true);
		const allText = JSON.stringify(body.messages);
		const round = allText.includes('Round 2') ? 2 : 1;
		const hasTools = !!body.tools?.length;
		const toolResult = body.messages?.some((message) => message.role === 'tool');
		let message;
		if (hasTools && !toolResult) {
			assert.equal(body.tools.length, 1);
			message = {
				role: 'assistant',
				content: '',
				tool_calls: [
					{
						id: `clock-${requests.length}`,
						type: 'function',
						function: { name: body.tools[0].function.name, arguments: '{}' },
					},
				],
			};
		} else {
			let value = { count: round, done: round === 2, note: `Round ${round} verified` };
			if (allText.includes('Always invalid') || (round === 1 && hasTools && !correctedFirstRound))
				value = { count: 'wrong type', done: false, note: 'schema must reject this' };
			if (!hasTools && !allText.includes('Always invalid')) correctedFirstRound = true;
			message = { role: 'assistant', content: JSON.stringify(value) };
		}
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
				if (run?.status === 'failed' && status !== 'failed')
					throw new Error(run.error || JSON.stringify(run.nodes));
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

	const schema = {
		type: 'object',
		properties: { count: { type: 'integer' }, done: { type: 'boolean' }, note: { type: 'string' } },
		required: ['count', 'done', 'note'],
		additionalProperties: false,
	};
	const agent = {
		connectionId: 'fixture',
		model: 'fixture-model',
		responseFormat: 'json',
		schema,
		validationRetries: 1,
		tools: ['clock.curr_time'],
		prompt:
			'Round {{run.inputs.iteration}}. Previous {{run.inputs.value}}. Use the clock and return the next validated state.',
	};
	const child = definition(
		'feedback-round',
		'Native feedback round',
		[
			node('agent', 'agent', agent),
			node('remember', 'collection', { name: 'rounds', operation: 'append' }, 400),
			node('out', 'output', { name: 'result' }, 720),
		],
		[edge('agent', 'remember'), edge('remember', 'out')],
	);
	const parent = definition(
		'feedback-parent',
		'Native feedback pipeline',
		[
			node('seed', 'value', { value: { count: 0 } }),
			node('loop', 'loop', { workflowId: child.id, maxIterations: 4 }, 400),
			node('wait', 'wait', { message: 'Review the two validated rounds' }, 720),
			node('read', 'collection', { name: 'rounds', operation: 'list' }, 1040),
			node('out', 'output', { name: 'records' }, 1360),
		],
		[edge('seed', 'loop'), edge('loop', 'wait'), edge('wait', 'read'), edge('read', 'out')],
	);
	let page = await launch();
	await command(page, { type: 'save', workflow: child });
	await command(page, { type: 'save', workflow: parent });
	const runId = await run(page, parent.id);
	await expect
		.poll(
			async () => {
				const current = await state(page, runId);
				if (current.status === 'failed') throw new Error(current.error);
				return current.nodes.wait.status;
			},
			{ timeout: 30000 },
		)
		.toBe('waiting');
	const waiting = await state(page, runId);
	assert.equal(waiting.nodes.loop.output.iterations, 2);
	assert.equal(waiting.nodes.loop.output.stopped, true);
	assert.equal(correctedFirstRound, true);
	const children = (await page.evaluate(() => window.desktop.workflowSnapshot())).runs.filter(
		(run) => run.parentRunId === runId,
	);
	assert.equal(children.length, 2);
	assert.ok(children.every((run) => run.rootRunId === runId));
	assert.equal(
		children.find((run) => run.inputs.iteration === 1).nodes.agent.output.validationAttempts,
		2,
	);
	assert.equal(children.find((run) => run.inputs.iteration === 2).inputs.current.count, 1);
	const countBeforeRestart = requests.length;
	await desktop.close();
	desktop = undefined;
	page = await launch();
	assert.equal((await state(page, runId)).status, 'waiting');
	await command(page, { type: 'resume', runId, nodeId: 'wait', value: true });
	const result = await completed(page, runId);
	assert.deepEqual(
		result.outputs.records.map((item) => item.count),
		[1, 2],
	);
	assert.equal(requests.length, countBeforeRestart);
	console.log(
		'PASS: native structured Agent format enforcement, selected clock tool, schema correction, two sequential feedback rounds, shared root collection, persistent wait/restart without replay.',
	);

	const isolated = definition(
		'isolated-read',
		'Independent collection read',
		[
			node('read', 'collection', { name: 'rounds' }),
			node('out', 'output', { name: 'result' }, 400),
		],
		[edge('read', 'out')],
	);
	await command(page, { type: 'save', workflow: isolated });
	assert.deepEqual((await completed(page, await run(page, isolated.id))).outputs.result, []);
	const invalid = definition(
		'invalid-agent',
		'Schema failure must stop downstream effects',
		[
			node('agent', 'agent', {
				...agent,
				tools: [],
				prompt: 'Always invalid',
				validationRetries: 0,
			}),
			node('write', 'collection', { name: 'invalid', scope: 'workflow', operation: 'append' }, 400),
		],
		[edge('agent', 'write')],
	);
	await command(page, { type: 'save', workflow: invalid });
	const rejected = await completed(page, await run(page, invalid.id), 'failed');
	assert.match(rejected.error, /structured|schema|validation/i);
	assert.equal(rejected.nodes.write.status, 'pending');
	assert.deepEqual(failures, []);
	assert.deepEqual(rendererErrors, []);
	assert.deepEqual((await page.evaluate(() => window.desktop.load()))?.threads ?? [], []);
	console.log(
		'PASS: independent root collections isolated; invalid Agent output fails before downstream writes; no synthetic Chat threads.',
	);
} catch (error) {
	console.error('Native feedback smoke diagnostics:', diagnostics.slice(-12));
	if (desktop) {
		const page = await desktop.firstWindow();
		console.error(
			await page
				.evaluate(async () =>
					(await window.desktop.workflowSnapshot()).runs.map((run) => ({
						id: run.id,
						name: run.workflowName,
						status: run.status,
						error: run.error,
						nodes: run.nodes,
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
