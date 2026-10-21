import { _electron as electron, expect } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

// Real Code composer -> provider tool calls -> native project workflow runtime ->
// durable asynchronous completion queue -> same Code thread. No user profile,
// model backend, network service, or project outside this temporary directory.
const profile = await realpath(await mkdtemp(path.join(os.tmpdir(), 'freelm-workflow-projects-')));
const projectIds = ['novis', 'biology'];
const failures = [],
	rendererErrors = [],
	diagnostics = [],
	events = [];
const toolCalls = [],
	notifications = [],
	workflowPrompts = [];
let desktop;
const node = (id, type, config = {}, x = 0) => ({
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
const authoredGraph = {
	name: 'Code-authored helper',
	request: { prompt: { key: 'request', label: 'Request', required: true } },
	nodes: [node('request', 'entry'), node('result', 'output', { name: 'result' }, 320)],
	edges: [edge('request', 'result')],
};
const reusable = {
	version: 1,
	id: 'shared-research',
	name: 'Reusable research fixture',
	enabled: false,
	request: {
		prompt: { key: 'question', label: 'What would you like to investigate?', required: true },
	},
	nodes: [
		node('request', 'entry'),
		node('research', 'text', { prompt: 'WORKFLOW_EVIDENCE: {{run.inputs.question}}' }, 320),
		node('store', 'collection', { name: 'evidence', scope: 'workflow', operation: 'append' }, 640),
		node('history', 'collection', { name: 'evidence', scope: 'workflow', operation: 'list' }, 960),
		node('result', 'output', { name: 'evidence' }, 1280),
	],
	edges: [
		edge('request', 'research'),
		edge('research', 'store'),
		edge('store', 'history'),
		edge('history', 'result'),
	],
	createdAt: 1,
	updatedAt: 1,
};
const message = (text) => ({
	type: 'message',
	role: 'assistant',
	content: [{ type: 'output_text', text }],
});
const content = (item) =>
	typeof item?.content === 'string'
		? item.content
		: (item?.content ?? [])
				.filter((part) => part.type === 'input_text')
				.map((part) => part.text)
				.join('\n');
function toolResult(item) {
	assert(item && !item.output?.startsWith('Error:'), item?.output ?? 'Missing tool output');
	const parsed = JSON.parse(item.output);
	return parsed.result ?? parsed;
}
function toolCall(body, name, args, callId) {
	const definition = body.tools?.find(
		(tool) => tool.name === name || tool.name.startsWith(`${name.replaceAll('.', '_')}_`),
	);
	assert(definition, `Tool ${name} must be offered to this Code task.`);
	toolCalls.push(name);
	return {
		type: 'function_call',
		call_id: callId,
		name: definition.name,
		arguments: JSON.stringify(args),
	};
}
function respond(res, output, stream) {
	if (stream) {
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		if (output[0]?.type === 'message')
			res.write(
				`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: output[0].content[0].text })}\n\n`,
			);
		res.end(
			`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output } })}\n\n`,
		);
	} else
		res
			.writeHead(200, { 'content-type': 'application/json' })
			.end(JSON.stringify({ status: 'completed', output }));
}
const server = createServer(async (req, res) => {
	try {
		assert.equal(req.url, '/v1/responses');
		let raw = '';
		for await (const chunk of req) raw += chunk;
		const body = JSON.parse(raw);
		const inputs = body.input ?? [];
		const latestUser = inputs.findLastIndex((item) => item.role === 'user');
		const prompt = content(inputs[latestUser]);
		const outputs = inputs
			.slice(latestUser + 1)
			.filter((item) => item.type === 'function_call_output');
		if (prompt.includes('WORKFLOW_EVIDENCE:')) {
			const topic = prompt.includes('NOVIS_TOPIC')
				? 'NOVIS_TOPIC'
				: prompt.includes('BIOLOGY_TOPIC')
					? 'BIOLOGY_TOPIC'
					: undefined;
			assert(topic, `The workflow must receive the actual request: ${prompt}`);
			workflowPrompts.push(prompt);
			assert.equal(
				body.tools?.length ?? 0,
				0,
				'Text workflow nodes do not receive Code tool authority.',
			);
			await new Promise((resolve) => setTimeout(resolve, 1500));
			events.push(`finished-${topic}`);
			respond(res, [message(`EVIDENCE_FOR_${topic}`)], body.stream);
		} else if (prompt.startsWith('Automated status update for a workflow you started.')) {
			const metadata = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
			assert.equal(metadata.status, 'completed');
			if (!outputs.length) {
				notifications.push(metadata);
				respond(
					res,
					[
						toolCall(
							body,
							'workflows.read_run',
							{ runId: metadata.runId },
							`read-${metadata.runId}`,
						),
					],
					body.stream,
				);
			} else {
				const result = toolResult(outputs.at(-1));
				assert.equal(result.status, 'completed');
				assert.equal(result.runId, metadata.runId);
				const output = JSON.parse(result.content.text);
				const topic = JSON.stringify(output).includes('EVIDENCE_FOR_NOVIS_TOPIC')
					? 'NOVIS_TOPIC'
					: 'BIOLOGY_TOPIC';
				assert(JSON.stringify(output).includes(`EVIDENCE_FOR_${topic}`));
				events.push(`notified-${topic}`);
				respond(
					res,
					[message(`ASYNC_RESULT_${topic}: workflow completed and its saved evidence was read.`)],
					body.stream,
				);
			}
		} else if (prompt.includes('NATIVE_WORKFLOW_TRIAL_')) {
			const topic = prompt.includes('NOVIS_TOPIC') ? 'NOVIS_TOPIC' : 'BIOLOGY_TOPIC';
			const results = outputs.map(toolResult);
			const plan = [
				['workflows.create', { idempotencyKey: `author-${topic}`, graph: authoredGraph }],
				[
					'workflows.create',
					{ idempotencyKey: `install-${topic}`, libraryWorkflowId: reusable.id },
				],
				[
					'workflows.run',
					{ bindingId: results[1]?.bindingId, idempotencyKey: `run-${topic}`, prompt: topic },
				],
			];
			const step = plan[outputs.length];
			if (step)
				respond(
					res,
					[toolCall(body, step[0], step[1], `step-${topic}-${outputs.length}`)],
					body.stream,
				);
			else {
				assert.equal(results[2].accepted, true);
				assert(
					['queued', 'running'].includes(results[2].status),
					'Run tool must return before provider completion.',
				);
				events.push(`admitted-${topic}`);
				respond(
					res,
					[message(`ADMITTED_${topic}: research is running asynchronously.`)],
					body.stream,
				);
			}
		} else respond(res, [message('Workflow fixture task')], body.stream);
	} catch (error) {
		failures.push(error.stack ?? String(error));
		if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ error: error.message }));
	}
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const env = {
	...process.env,
	FREELM_HOME: profile,
	FREELM_USER_DATA: profile,
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.FREELM_DEV_URL;
async function launch() {
	const executablePath = process.env.FREELM_SMOKE_EXECUTABLE;
	desktop = await electron.launch({
		...(executablePath
			? { executablePath, args: [`--user-data-dir=${env.FREELM_USER_DATA}`] }
			: { args: ['.'] }),
		env,
	});
	const page = await desktop.firstWindow();
	page.setDefaultTimeout(20000);
	page.on('pageerror', (error) => rendererErrors.push(error.message));
	page.on('console', (message) => {
		if (message.type() === 'error') diagnostics.push(message.text());
	});
	desktop.process().stderr?.on('data', (data) => diagnostics.push(String(data).slice(0, 2000)));
	await page.locator('.app-shell').waitFor();
	await expect(page.getByRole('button', { name: 'Home', exact: true })).toBeVisible({
		timeout: 30000,
	});
	await expect
		.poll(async () => (await loaded(page))?.projects?.length ?? 0, { timeout: 30000 })
		.toBe(2);
	await expect
		.poll(
			() =>
				snapshot(page)
					.then(() => true)
					.catch(() => false),
			{ timeout: 30000 },
		)
		.toBe(true);
	return page;
}
async function snapshot(page) {
	return page.evaluate(() => window.desktop.workflowSnapshot());
}
async function loaded(page) {
	return page.evaluate(() => window.desktop.load());
}
try {
	for (const project of projectIds) await mkdir(path.join(profile, project));
	const seedModule = path.join(profile, 'seed.mjs');
	await build({
		stdin: {
			contents:
				'export { initialState } from "./src/lib/state"; export { StateStore } from "./electron/state-store"; export { defaultToolSettings } from "./src/lib/tool-settings";',
			resolveDir: process.cwd(),
		},
		bundle: true,
		platform: 'node',
		format: 'esm',
		outfile: seedModule,
	});
	const { initialState, StateStore, defaultToolSettings } = await import(
		pathToFileURL(seedModule).href
	);
	const state = initialState();
	state.theme = 'dark';
	state.backgroundNotifications = false;
	state.memorySettings = { savedMemories: false, referenceHistory: false };
	state.toolSettings = {
		...defaultToolSettings(),
		enabled: true,
		commandExecution: false,
		workspaceRoot: profile,
		approvalMode: 'full-access',
		skillDirectories: [],
		mcpServers: [],
	};
	state.connections = [
		{
			id: 'fixture',
			name: 'Workflow fixture',
			baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
			apiKey: '',
			chatApi: 'responses',
			models: { chat: 'fixture-model', images: '', videos: '', speech: '', transcription: '' },
			discoveredModels: [],
			catalog: [
				{
					id: 'fixture-model',
					name: 'Fixture model',
					enabled: true,
					tasks: ['chat'],
					inputModalities: ['text'],
					outputModalities: ['text'],
					thinkingModes: [
						{ id: 'low', name: 'Low', parameters: { responses: { reasoning: { effort: 'low' } } } },
					],
					defaultThinkingMode: 'low',
				},
			],
		},
	];
	state.activeConnectionId = 'fixture';
	state.projects = projectIds.map((id) => ({
		id,
		name: id === 'novis' ? 'Novis fixture' : 'Biology fixture',
		kind: 'code',
		directories: [path.join(profile, id)],
		instructions: `Only ${id} project context.`,
		createdAt: 1,
	}));
	state.threads = projectIds.map((id) => ({
		id: `task-${id}`,
		projectId: id,
		kind: 'code',
		title: `${id} workflow task`,
		titleSource: 'manual',
		connectionId: 'fixture',
		model: 'fixture-model',
		thinkingMode: 'low',
		permissionMode: 'full-access',
		messages: [],
		createdAt: 1,
		updatedAt: 1,
	}));
	await new StateStore(
		path.join(profile, 'workspace.json'),
		{
			available: () => false,
			encrypt: () => {
				throw new Error('No fixture secrets');
			},
			decrypt: () => {
				throw new Error('No fixture secrets');
			},
		},
		path.join(profile, 'config.json'),
	).save(state);
	let page = await launch();
	await page.evaluate(
		(workflow) => window.desktop.workflowCommand({ type: 'save', workflow }),
		reusable,
	);
	const picker = page.getByRole('combobox', { name: 'Conversation mode', exact: true });
	await picker.click();
	await page.getByRole('listbox').locator('[role="option"][data-value="code"]').click();
	for (const project of projectIds) {
		const topic = `${project.toUpperCase()}_TOPIC`;
		await page.getByRole('button', { name: `${project} workflow task`, exact: true }).click();
		await page
			.getByRole('textbox', { name: 'Message', exact: true })
			.fill(
				`NATIVE_WORKFLOW_TRIAL_${topic}: create a helper, install the reusable research workflow, and run this topic.`,
			);
		await page.getByRole('button', { name: 'Send message', exact: true }).click();
		await expect
			.poll(
				async () => {
					if (failures.length) throw new Error(failures.join('\n'));
					const current = await loaded(page);
					return current.threads
						.find((thread) => thread.id === `task-${project}`)
						.messages.some(
							(entry) =>
								entry.role === 'assistant' && entry.content.includes(`ASYNC_RESULT_${topic}`),
						);
				},
				{ timeout: 45000 },
			)
			.toBe(true);
	}
	const workflowState = await snapshot(page);
	assert.equal(
		workflowState.workflows.length,
		1,
		'Code-authored graphs remain private project installations.',
	);
	assert.equal(
		workflowState.bindings.length,
		4,
		'Each project has an authored helper and an installed reusable workflow.',
	);
	const runs = workflowState.runs.filter((run) => !run.parentRunId);
	assert.equal(runs.length, 2);
	assert(runs.every((run) => run.status === 'completed' && run.workflowId === reusable.id));
	assert.notEqual(runs[0].bindingId, runs[1].bindingId);
	for (const run of runs) {
		const topic = `${run.projectId.toUpperCase()}_TOPIC`;
		assert.equal(run.sourceThreadId, `task-${run.projectId}`);
		assert.equal(
			run.inputs.question,
			topic,
			'The composer/tool prompt maps to the reusable request field.',
		);
		assert.deepEqual(
			run.outputs.evidence,
			[`EVIDENCE_FOR_${topic}`],
			'Persistent collection records are isolated by project installation.',
		);
		assert(
			events.indexOf(`admitted-${topic}`) < events.indexOf(`finished-${topic}`),
			'Code receives admission while inference is still running.',
		);
		const otherProject = projectIds.find((id) => id !== run.projectId);
		const denied = await page.evaluate(
			async ({ runId, project }) => {
				const toolRun = `isolation-${project}`;
				await window.desktop.toolCatalog('local', toolRun, `task-${project}`);
				try {
					await window.desktop.toolExecute({
						workspaceId: 'local',
						runId: toolRun,
						threadId: `task-${project}`,
						name: 'workflows.read_run',
						arguments: { runId },
					});
					return 'unexpected access';
				} catch (error) {
					return error.message;
				} finally {
					await window.desktop.toolCancel(toolRun);
				}
			},
			{ runId: run.id, project: otherProject },
		);
		assert.match(denied, /not found in this project/);
	}
	const persisted = await loaded(page);
	for (const project of projectIds) {
		const thread = persisted.threads.find((item) => item.id === `task-${project}`);
		assert.equal(
			thread.messages.filter(
				(item) => item.role === 'user' && item.content.startsWith('Automated status update'),
			).length,
			1,
		);
		assert.equal(thread.queuedMessages?.length ?? 0, 0);
	}
	assert.equal(notifications.length, 2);
	assert.equal(workflowPrompts.length, 2);
	assert.deepEqual(failures, []);
	assert.deepEqual(rendererErrors, []);
	const requestsBeforeRestart = toolCalls.length;
	await desktop.close();
	desktop = undefined;
	page = await launch();
	await expect.poll(async () => (await snapshot(page)).runs.length).toBe(2);
	await new Promise((resolve) => setTimeout(resolve, 1000));
	assert.equal(
		toolCalls.length,
		requestsBeforeRestart,
		'Restart must not redeliver a completed workflow notification or replay work.',
	);
	assert.equal(notifications.length, 2);
	const restored = await loaded(page);
	for (const project of projectIds)
		assert.equal(
			restored.threads
				.find((thread) => thread.id === `task-${project}`)
				.messages.filter(
					(item) => item.role === 'user' && item.content.startsWith('Automated status update'),
				).length,
			1,
		);
	console.log(
		'PASS: native Code authoring + reusable installation in two projects; asynchronous run admission; request mapping; isolated persistent research history; completion delivered once to initiating Code threads; agent reads results; denied cross-project reads; restart without replay.',
	);
	console.log(
		JSON.stringify(
			{
				codeToolCalls: toolCalls,
				workflowProviderRequests: workflowPrompts.length,
				completionNotifications: notifications.length,
				completedRuns: runs.map(({ id, projectId, bindingId, sourceThreadId, outputs }) => ({
					id,
					projectId,
					bindingId,
					sourceThreadId,
					outputs,
				})),
				events,
			},
			null,
			2,
		),
	);
} catch (error) {
	console.error('Native project workflow diagnostics:', diagnostics.slice(-15), {
		failures,
		rendererErrors,
		events,
		toolCalls,
		notifications,
	});
	if (desktop) {
		const page = await desktop.firstWindow();
		console.error(await snapshot(page).catch(() => ({})));
		console.error(
			await loaded(page)
				.then((state) =>
					state.threads.map(({ id, messages, queuedMessages }) => ({
						id,
						messages,
						queuedMessages,
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
	await rm(profile, { recursive: true, force: true });
}
