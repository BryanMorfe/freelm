import { expect, test, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { initialState } from '../../src/lib/state';
import { createWorkflow, createWorkflowNode } from '../../src/lib/workflow-catalog';
import { WorkflowEngine } from '../../electron/workflows/engine';
import { WorkflowStore } from '../../electron/workflows/store';
import type {
	WorkflowCommand,
	WorkflowDefinition,
	WorkflowNodeExecutor,
} from '../../src/workflow-types';
import { chooseOption } from './ui-controls';

// Browser plugin not available. The real App and durable workflow engine run
// against an isolated temporary store; external provider/tool calls are fixtures.
test.setTimeout(120_000);
test.use({ actionTimeout: 45_000 });

const cleanup = new WeakMap<Page, () => Promise<void>>();
const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
	const entries: string[] = [];
	errors.set(page, entries);
	page.on('pageerror', (error) => entries.push(error.message));
	page.on('console', (entry) => {
		if (entry.type() === 'error') entries.push(entry.text());
	});
});
test.afterEach(async ({ page }) => {
	await cleanup.get(page)?.();
	expect(errors.get(page)).toEqual([]);
});

async function fixture(
	page: Page,
	workflows: WorkflowDefinition[] = [],
	execute?: WorkflowNodeExecutor,
) {
	const control = {
		failSaves: false,
		beforeSave: undefined as (() => Promise<void>) | undefined,
		beforeBindingSave: undefined as (() => Promise<void>) | undefined,
		snapshotReads: 0,
		commands: [] as { type: string; started: number; finished?: number }[],
	};
	const projects = [
		{
			id: 'novis-project',
			name: 'Novis',
			kind: 'code' as const,
			instructions: 'Explore local AI systems.',
			directories: ['/fixture/Novis'],
			createdAt: 1,
		},
		{
			id: 'materials-project',
			name: 'Materials',
			kind: 'code' as const,
			instructions: 'Explore material durability.',
			directories: ['/fixture/Materials'],
			createdAt: 2,
		},
	];
	const directory = await mkdtemp(path.join(os.tmpdir(), 'freelm-workflow-ui-'));
	const engine = new WorkflowEngine({
		store: new WorkflowStore(directory),
		autoSchedule: false,
		resolveProject: (id) => projects.find((project) => project.id === id),
		onChange: () => {
			void page
				.evaluate(() => window.dispatchEvent(new Event('fixture:workflows-changed')))
				.catch(() => {});
		},
		execute:
			execute ??
			(async () => ({
				value: 'A draft ready for review.',
				text: 'A draft ready for review.',
			})),
	});
	await engine.init();
	for (const workflow of workflows) await engine.saveWorkflow(workflow);
	cleanup.set(page, async () => {
		await engine.dispose();
		await rm(directory, { recursive: true, force: true });
	});
	const state = initialState();
	state.projects = projects;
	state.connections[0].id = 'workflow-provider';
	state.connections[0].name = 'Local test provider';
	state.connections[0].models.chat = 'fixture-chat';
	state.connections[0].catalog = [
		{
			id: 'fixture-chat',
			name: 'Fixture chat',
			enabled: true,
			tasks: ['chat'],
			inputModalities: ['text', 'image'],
			outputModalities: ['text'],
			thinkingModes: [],
		},
	];
	state.activeConnectionId = state.connections[0].id;
	state.memorySettings = { savedMemories: false, referenceHistory: false };
	const catalog = {
		connections: state.connections,
		tools: [
			{
				name: 'files.read',
				displayName: 'Read file',
				source: 'builtin' as const,
				description: 'Read a file in the working directory.',
				parameters: { type: 'object', properties: { path: { type: 'string' } } },
			},
		],
		skills: [
			{
				id: 'skill-notes',
				name: 'Project notes',
				description: 'Summarize project notes.',
				path: '/fixture/notes/SKILL.md',
			},
		],
	};
	await page.exposeFunction('__workflowBindings', () =>
		(engine.snapshot().bindings ?? []).map((binding) => ({
			id: binding.id,
			hostId: binding.hostId,
			projectId: binding.projectId,
			workflowId: binding.workflowId,
			name: binding.name || binding.workflowSnapshot.name,
			revision: binding.revision,
		})),
	);
	await page.exposeFunction(
		'__workflowSnapshot',
		(scope?: { bindingId?: string; projectId?: string }) => {
			control.snapshotReads++;
			return { ...engine.snapshot(scope), connections: catalog.connections, projects };
		},
	);
	await page.exposeFunction('__workflowCommand', async (command: WorkflowCommand) => {
		const observed: { type: string; started: number; finished?: number } = {
			type: command.type,
			started: Date.now(),
		};
		control.commands.push(observed);
		if (command.type === 'save') await control.beforeSave?.();
		if (command.type === 'save' && control.failSaves) throw new Error('Fixture save unavailable.');
		if (command.type === 'update-binding') await control.beforeBindingSave?.();
		const snapshot = await engine.command(command);
		observed.finished = Date.now();
		return {
			...snapshot,
			...(command.type === 'catalog' ? catalog : { connections: catalog.connections }),
			projects,
		};
	});
	await page.addInitScript(
		({ serialized }) => {
			let current = JSON.parse(serialized),
				revision = 0;
			const bridge = window as any;
			bridge.desktop = {
				platform: 'linux',
				workspaceLoad: async () => ({
					state: structuredClone(current),
					revision: String(revision),
				}),
				workspaceSave: async (_target: string, _revision: string, next: unknown) => {
					current = structuredClone(next);
					return { revision: String(++revision) };
				},
				storageInfo: async () => ({ secure: false, location: 'Isolated workflow fixture' }),
				instanceStatus: async () => ({
					host: { running: true, name: 'This computer', instanceId: 'local-instance', port: 4319 },
					instances: [],
				}),
				workflowSnapshot: bridge.__workflowSnapshot,
				workflowBindings: bridge.__workflowBindings,
				workflowCommand: bridge.__workflowCommand,
				onWorkflowsChanged: (listener: () => void) => {
					window.addEventListener('fixture:workflows-changed', listener);
					return () => window.removeEventListener('fixture:workflows-changed', listener);
				},
				onToolApproval: () => () => {},
				onOpenThread: () => () => {},
				onPrepareClose: () => () => {},
			};
		},
		{ serialized: JSON.stringify(state) },
	);
	await page.goto('/');
	await expect(page).toHaveTitle('FreeLM');
	await page.getByRole('button', { name: 'Workflows', exact: true }).click();
	await expect(page.locator('.workflows-sidebar')).toBeVisible();
	await expect(page.locator('vite-error-overlay')).toHaveCount(0);
	return Object.assign(engine, { control, projects });
}

async function startWorkflow(page: Page) {
	await page.getByRole('button', { name: 'Run workflow', exact: true }).first().click();
	const composer = page.locator('.workflow-editor-request');
	if (await composer.isVisible())
		await composer.getByRole('button', { name: 'Run workflow', exact: true }).click();
}

// Flow: Workflows -> data template -> edit/drag/connect -> run -> persisted output.
test('edits and connects a data workflow, runs the real engine, and restores it after reload', async ({
	page,
}) => {
	const engine = await fixture(page);
	await page.getByRole('button', { name: /Transform data A ready-to-run/ }).click();
	await expect(page.locator('.workflow-node')).toHaveCount(3);
	await page.getByLabel('Workflow name', { exact: true }).fill('Reusable data flow');
	const value = page.locator('.workflow-node[data-node-type="value"]');
	await value.locator('.workflow-node-header').click();
	await page.getByLabel('Value', { exact: true }).fill('{"topic":"a useful workflow"}');
	await page.getByLabel('Node name', { exact: true }).fill('Source data');
	await expect
		.poll(() => engine.listWorkflows()[0]?.nodes[0].config.value)
		.toEqual({ topic: 'a useful workflow' });
	const original = engine.listWorkflows()[0].nodes[0].position;
	const bounds = await value.locator('.workflow-node-header').boundingBox();
	await page.mouse.move(bounds!.x + 80, bounds!.y + 20);
	await page.mouse.down();
	await page.mouse.move(bounds!.x + 110, bounds!.y + 65, { steps: 6 });
	await page.mouse.up();
	await expect.poll(() => engine.listWorkflows()[0].nodes[0].position.y).not.toBe(original.y);
	await page.getByRole('button', { name: 'Undo', exact: true }).click();
	await expect.poll(() => engine.listWorkflows()[0].nodes[0].position).toEqual(original);
	await page.getByRole('button', { name: 'Redo', exact: true }).click();
	await expect.poll(() => engine.listWorkflows()[0].nodes[0].position.y).not.toBe(original.y);
	await page
		.getByRole('button', { name: 'Connection from Source data to Transform', exact: true })
		.click();
	await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
	await expect(page.locator('.workflow-edge-hit')).toHaveCount(1);
	const sourcePort = await page
		.getByRole('button', { name: 'Connect Source data Value output', exact: true })
		.boundingBox();
	const targetPort = await page
		.getByRole('button', { name: 'Connect Transform Input input', exact: true })
		.boundingBox();
	await page.mouse.move(
		sourcePort!.x + sourcePort!.width - 3,
		sourcePort!.y + sourcePort!.height / 2,
	);
	await page.mouse.down();
	await page.mouse.move(targetPort!.x + 3, targetPort!.y + targetPort!.height / 2, { steps: 12 });
	await page.mouse.up();
	await expect(page.locator('.workflow-edge-hit')).toHaveCount(2);
	await startWorkflow(page);
	try {
		await expect(page.getByText('Run completed', { exact: true })).toBeVisible({ timeout: 15_000 });
	} catch (failure) {
		console.log(
			'Workflow run diagnostic',
			JSON.stringify({ commands: engine.control.commands, runs: engine.listRuns() }),
		);
		throw failure;
	}
	await expect
		.poll(() => engine.listRuns()[0]?.outputs)
		.toEqual({ result: 'Make something useful with a useful workflow.' });
	await page.locator('.workflow-node[data-node-type="output"] .workflow-node-header').click();
	await expect(
		page
			.getByRole('complementary', { name: 'Workflow inspector' })
			.getByText(/Make something useful with a useful workflow/)
			.first(),
	).toBeVisible();
	await page.screenshot({ path: '/tmp/freelm-workflows-dark.png' });
	await page.reload();
	await page.getByRole('button', { name: 'Workflows', exact: true }).click();
	await page.getByRole('button', { name: /Reusable data flow 3 nodes/ }).click();
	await expect(page.locator('.workflow-node')).toHaveCount(3);
	await expect(page.getByLabel('Workflow name', { exact: true })).toHaveValue('Reusable data flow');
	await expect(page.getByText('Run completed', { exact: true })).toBeVisible({ timeout: 15_000 });
});

test('searches the node catalog, persists real capability selections, and renders at a narrow light viewport', async ({
	page,
}) => {
	const engine = await fixture(page);
	await page.getByRole('button', { name: /Agent task Give an agent/ }).click();
	await page.locator('.workflow-node[data-node-type="agent"] .workflow-node-header').click();
	await page
		.getByLabel('Prompt', { exact: true })
		.fill('Summarize the project using the selected capabilities.');
	await page.getByRole('checkbox', { name: /Read file/ }).check();
	await page.getByRole('checkbox', { name: /Project notes/ }).check();
	await expect(page.getByLabel('JSON schema', { exact: true })).toHaveCount(0);
	await chooseOption(
		page,
		page.getByRole('combobox', { name: 'Response format', exact: true }),
		'json',
	);
	const schema = {
		type: 'object',
		properties: { summary: { type: 'string' } },
		required: ['summary'],
		additionalProperties: false,
	};
	await page.getByLabel('JSON schema', { exact: true }).fill(JSON.stringify(schema));
	await page.getByLabel('Validation retries', { exact: true }).fill('2');
	await expect
		.poll(
			() => engine.listWorkflows()[0]?.nodes.find((node) => node.type === 'agent')?.config.schema,
		)
		.toEqual(schema);
	await expect
		.poll(
			() =>
				engine.listWorkflows()[0]?.nodes.find((node) => node.type === 'agent')?.config
					.validationRetries,
		)
		.toBe(2);

	await expect
		.poll(
			() => engine.listWorkflows()[0]?.nodes.find((node) => node.type === 'agent')?.config.tools,
		)
		.toEqual(['files.read']);
	await expect
		.poll(
			() => engine.listWorkflows()[0]?.nodes.find((node) => node.type === 'agent')?.config.skills,
		)
		.toEqual(['skill-notes']);
	await page.getByRole('button', { name: 'Add node', exact: true }).click();
	await page.getByLabel('Search nodes', { exact: true }).fill('condition');
	await page
		.getByRole('button', { name: /Condition Choose a branch/ })
		.dragTo(page.getByRole('application', { name: 'Workflow canvas' }), {
			targetPosition: { x: 440, y: 210 },
		});
	await expect(page.locator('.workflow-node[data-node-type="condition"]')).toHaveCount(1);
	await chooseOption(page, page.getByRole('combobox', { name: 'Operator', exact: true }), 'equals');
	await page.getByLabel('Compare with', { exact: true }).fill('"approved"');
	await expect
		.poll(
			() =>
				engine.listWorkflows()[0]?.nodes.find((node) => node.type === 'condition')?.config.operator,
		)
		.toBe('equals');
	await page.locator('html').evaluate((element) => element.setAttribute('data-theme', 'light'));
	await page.setViewportSize({ width: 1024, height: 900 });
	await expect(page.getByLabel('Node name', { exact: true })).toBeVisible();
	const typography = await page
		.locator('.workflow-inspector .settings-row-label')
		.evaluateAll((elements) =>
			elements.map((element) => parseFloat(getComputedStyle(element).fontSize)),
		);
	expect(typography.every((size) => size >= 13)).toBe(true);
	await page.screenshot({ path: '/tmp/freelm-workflows-light-narrow.png' });
});

test('pauses for human review, resumes, and cancels a later run', async ({ page }) => {
	const workflow = createWorkflow('review');
	const engine = await fixture(page, [workflow]);
	await page.getByRole('button', { name: /Draft and review 4 nodes/ }).click();
	await startWorkflow(page);
	await expect(page.getByRole('button', { name: 'Approve & continue', exact: true })).toBeVisible();
	expect(engine.listRuns()[0].status).toBe('waiting');
	await page.getByRole('button', { name: 'Approve & continue', exact: true }).click();
	await expect(page.getByText('Run completed', { exact: true })).toBeVisible({ timeout: 15_000 });
	await startWorkflow(page);
	await expect(page.getByRole('button', { name: 'Approve & continue', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Cancel run', exact: true }).click();
	await expect
		.poll(() => engine.listRuns().sort((a, b) => b.createdAt - a.createdAt)[0].status)
		.toBe('cancelled');
});

test('retains unsaved edits and blocks dependent runs when an in-flight save fails', async ({
	page,
}) => {
	const engine = await fixture(page);
	await page.getByRole('button', { name: 'New workflow', exact: true }).first().click();
	await expect(page.locator('.workflow-node')).toHaveCount(2);
	engine.control.failSaves = true;
	let releaseSave: (() => void) | undefined;
	engine.control.beforeSave = () =>
		new Promise<void>((resolve) => {
			releaseSave = resolve;
		});
	await page.getByLabel('Workflow name', { exact: true }).fill('Retained local draft');
	await expect.poll(() => Boolean(releaseSave)).toBe(true);
	await startWorkflow(page);
	expect(engine.listRuns()).toHaveLength(0);
	releaseSave!();
	await expect(page.getByRole('alert')).toContainText('Fixture save unavailable');
	expect(engine.listRuns()).toHaveLength(0);
	engine.control.beforeSave = undefined;
	const reads = engine.control.snapshotReads;
	await expect.poll(() => engine.control.snapshotReads).toBeGreaterThan(reads);
	await expect(page.getByLabel('Workflow name', { exact: true })).toHaveValue(
		'Retained local draft',
	);
	await expect(page.locator('.workflow-list-item')).toContainText('Retained local draft');
	engine.control.failSaves = false;
	await startWorkflow(page);
	await expect(page.getByText('Run completed', { exact: true })).toBeVisible({ timeout: 15_000 });
	expect(engine.listWorkflows()[0].name).toBe('Retained local draft');
});

// Flow: configure a reusable feedback loop -> observe its rounds -> inspect a versioned record.
test('shows feedback progress and preserves collection and structured-output controls', async ({
	page,
}) => {
	const child = createWorkflow('agent');
	child.name = 'Refinement round';
	const entry = child.nodes[0],
		agent = child.nodes[1],
		result = child.nodes[2];
	child.edges = [
		{
			id: 'child-input',
			source: entry.id,
			target: agent.id,
			sourceHandle: 'value',
			targetHandle: 'context',
		},
		{
			id: 'child-output',
			source: agent.id,
			target: result.id,
			sourceHandle: 'value',
			targetHandle: 'input',
		},
	];
	const parent = createWorkflow();
	parent.name = 'Feedback and records';
	const seed = createWorkflowNode('value', { x: 40, y: 100 });
	seed.config.value = { score: 0, done: false };
	const loop = createWorkflowNode('loop', { x: 330, y: 100 });
	loop.config.workflowId = child.id;
	const collection = createWorkflowNode('collection', { x: 620, y: 100 });
	collection.config = {
		...collection.config,
		operation: 'upsert',
		recordId: 'best-result',
		expectedRevision: 0,
	};
	const output = createWorkflowNode('output', { x: 910, y: 100 });
	parent.nodes = [seed, loop, collection, output];
	parent.edges = parent.nodes.slice(1).map((node, i) => ({
		id: `edge-${i}`,
		source: parent.nodes[i].id,
		target: node.id,
		sourceHandle: 'value',
		targetHandle: node.type === 'collection' ? 'value' : 'input',
	}));
	let release: (() => void) | undefined;
	const firstRound = new Promise<void>((resolve) => {
		release = resolve;
	});
	let calls = 0;
	const engine = await fixture(page, [child, parent], async (_node, inputs, context) => {
		if (++calls === 1)
			await Promise.race([
				firstRound,
				new Promise<never>((_, reject) =>
					context.signal.addEventListener(
						'abort',
						() => reject(new Error('Cancelled fixture round.')),
						{ once: true },
					),
				),
			]);
		const current = (inputs.context as { current: { score: number } }).current;
		const value = { score: current.score + 1, done: current.score + 1 >= 2 };
		return { value, text: JSON.stringify(value) };
	});
	await page.getByRole('button', { name: /Feedback and records 4 nodes/ }).click();
	await page.locator('.workflow-node[data-node-type="loop"] .workflow-node-header').click();
	await expect(page.getByLabel('Maximum rounds', { exact: true })).toHaveValue('3');
	await expect(page.getByLabel('Stop value path', { exact: true })).toHaveValue('done');
	await chooseOption(page, page.getByRole('combobox', { name: 'Stop when', exact: true }), 'never');
	await expect(page.getByLabel('Stop value path', { exact: true })).toHaveCount(0);
	await chooseOption(
		page,
		page.getByRole('combobox', { name: 'Stop when', exact: true }),
		'truthy',
	);
	await startWorkflow(page);
	await expect(
		page.locator('.workflow-node[data-node-type="loop"] .workflow-node-result'),
	).toContainText('Waiting for feedback round 1 of 3', { timeout: 15_000 });
	await expect(page.getByText('0 of 3 rounds completed', { exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Approve & continue', exact: true })).toHaveCount(
		0,
	);
	release!();
	await expect(page.getByText('Run completed', { exact: true })).toBeVisible({ timeout: 15_000 });
	await expect(page.getByText('2 of 3 rounds completed', { exact: true })).toBeVisible();
	await expect(page.getByText('Stop condition met', { exact: true })).toBeVisible();
	await expect(page.getByRole('region', { name: 'Last execution', exact: true })).not.toContainText(
		'Waiting for feedback round',
	);
	await page
		.locator('.workflow-record summary')
		.filter({ hasText: /^Round 2$/ })
		.click();
	await expect(page.locator('.workflow-record[open] pre')).toContainText('"score": 2');
	await page.getByText('Feedback rounds', { exact: true }).scrollIntoViewIfNeeded();
	await page.screenshot({ path: '/tmp/freelm-workflow-feedback-dark.png' });
	await page.getByRole('button', { name: 'Fit workflow', exact: true }).click();
	await page.locator('.workflow-node[data-node-type="collection"] .workflow-node-header').click();
	await expect(page.getByLabel('Expected revision', { exact: true })).toHaveValue('0');
	await expect(page.getByLabel('Field filters', { exact: true })).toHaveCount(0);
	await page
		.locator('.workflow-record summary')
		.filter({ hasText: /^best-result/ })
		.click();
	await expect(page.locator('.workflow-record[open]').first()).toContainText('Revision 1');
	await expect(page.locator('.workflow-record[open] > pre').first()).toContainText('"score": 2');
	await page.locator('.workflow-record-metadata summary').click();
	await expect(page.locator('.workflow-record-metadata pre')).toContainText('"workflowId"');
	await page.locator('html').evaluate((element) => element.setAttribute('data-theme', 'light'));
	await page.setViewportSize({ width: 1024, height: 900 });
	await page.locator('.workflow-record[open]').first().scrollIntoViewIfNeeded();
	await page.screenshot({ path: '/tmp/freelm-workflow-collection-light.png' });
	await chooseOption(page, page.getByRole('combobox', { name: 'Operation', exact: true }), 'list');
	await expect(page.getByLabel('Record ID', { exact: true })).toHaveCount(0);
	await page.getByLabel('Field filters', { exact: true }).fill('{"done":true}');
	await page.getByLabel('Maximum records', { exact: true }).fill('25');
	await chooseOption(
		page,
		page.getByRole('combobox', { name: 'Shared with', exact: true }),
		'workflow',
	);
	await expect
		.poll(
			() =>
				engine
					.listWorkflows()
					.find((item) => item.id === parent.id)
					?.nodes.find((node) => node.type === 'collection')?.config,
		)
		.toMatchObject({ operation: 'list', scope: 'workflow', filter: { done: true }, limit: 25 });
});

test('creates editable Research team and Co-Scientist templates with linked child workflows', async ({
	page,
}) => {
	const engine = await fixture(page);
	await page.getByRole('button', { name: /Research team Generate, review/ }).click();
	await expect(page.getByLabel('Workflow name', { exact: true })).toHaveValue('Research team', {
		timeout: 15_000,
	});
	await expect.poll(() => engine.listWorkflows().length).toBe(2);
	let parent = engine.listWorkflows().find((workflow) => workflow.name === 'Research team')!;
	let child = engine
		.listWorkflows()
		.find(
			(workflow) =>
				workflow.id === parent.nodes.find((node) => node.type === 'loop')!.config.workflowId,
		)!;
	expect(child).toBeDefined();
	expect(child.nodes.filter((node) => node.type === 'agent')).toHaveLength(4);
	for (const node of child.nodes.filter((node) => node.type === 'agent')) {
		expect(node.config).toMatchObject({
			model: 'fixture-chat',
			responseFormat: 'json',
			validationRetries: 1,
		});
		expect(node.config.schema).toBeTruthy();
	}
	await page.getByRole('button', { name: 'Browse templates', exact: true }).click();
	await page.getByRole('button', { name: /Co-Scientist Explore hypotheses/ }).click();
	await expect(page.getByLabel('Workflow name', { exact: true })).toHaveValue('Co-Scientist', {
		timeout: 15_000,
	});
	await expect.poll(() => engine.listWorkflows().length).toBe(4);
	parent = engine.listWorkflows().find((workflow) => workflow.name === 'Co-Scientist')!;
	const feedback = parent.nodes.find((node) => node.type === 'loop')!;
	child = engine.listWorkflows().find((workflow) => workflow.id === feedback.config.workflowId)!;
	expect(child.nodes.filter((node) => node.type === 'agent')).toHaveLength(6);
	expect(feedback.config).toMatchObject({ maxIterations: 2, minIterations: 2 });
	await page.screenshot({ path: '/tmp/freelm-co-scientist-template.png' });
});

// Flow: reuse one library definition in two projects -> request form -> isolated history and results.
test('adds a reusable workflow to two projects and keeps requests and history isolated', async ({
	page,
}) => {
	const workflow = createWorkflow();
	workflow.name = 'Reusable investigation';
	workflow.description = 'Investigate a question in the current project.';
	workflow.request = {
		prompt: {
			key: 'question',
			label: 'Research question',
			placeholder: 'What would you like to investigate?',
			required: true,
		},
		fields: [
			{ key: 'constraints', label: 'Constraints', type: 'text' },
			{
				key: 'parameters',
				label: 'Parameters',
				type: 'object',
				defaultValue: { retries: 2, verified: true, nested: { mode: 'bounded' } },
			},
		],
	};
	const transform = createWorkflowNode('transform', { x: 350, y: 100 });
	transform.config = {
		operation: 'template',
		template: 'Investigation: {{run.inputs.question}}\nConstraints: {{run.inputs.constraints}}',
	};
	workflow.nodes.splice(1, 0, transform);
	workflow.edges = [
		{
			id: 'request-transform',
			source: workflow.nodes[0].id,
			sourceHandle: 'value',
			target: transform.id,
			targetHandle: 'input',
		},
		{
			id: 'transform-result',
			source: transform.id,
			sourceHandle: 'value',
			target: workflow.nodes[2].id,
			targetHandle: 'input',
		},
	];
	const engine = await fixture(page, [workflow]);
	await page.getByRole('button', { name: 'Home', exact: true }).click();
	await chooseOption(page, page.getByRole('combobox', { name: 'Conversation mode' }), 'code');
	await expect(page.locator('.project-workflow-add')).toHaveCount(0);
	await page.getByRole('button', { name: 'Novis', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Novis', exact: true })).toHaveAttribute(
		'aria-expanded',
		'false',
	);
	await page.getByRole('button', { name: 'Add to Novis', exact: true }).click();
	const projectMenu = page.getByRole('menu', { name: 'Add to Novis', exact: true });
	await expect(projectMenu.getByRole('menuitem')).toHaveText(['New task', 'Add workflow']);
	await projectMenu.getByRole('menuitem', { name: 'Add workflow', exact: true }).click();
	await expect(page.getByRole('navigation', { name: 'Code projects' })).toBeVisible();
	await page.getByRole('button', { name: 'Add Reusable investigation', exact: true }).click();
	await expect(page.locator('.workflow-project-header')).toContainText('Novis');
	await expect(
		page
			.locator('#project-threads-novis-project .project-workflow-row')
			.filter({ hasText: 'Reusable investigation' }),
	).toBeVisible();
	await expect(page.getByRole('application', { name: 'Workflow canvas' })).toHaveCount(0);
	await page
		.getByLabel('Workflow request', { exact: true })
		.fill('How can we reduce inference latency?');
	await page.getByLabel('Constraints', { exact: true }).fill('Keep answer quality unchanged.');
	await page.getByLabel('Parameters field 1', { exact: true }).fill('attempts');
	await page.getByRole('button', { name: 'Run workflow', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Run completed', exact: true })).toBeVisible();
	await expect(page.getByLabel('Workflow request', { exact: true })).toHaveValue('');
	await expect(page.getByRole('region', { name: 'Run results' })).toContainText(
		'Investigation: How can we reduce inference latency?',
	);
	const firstRun = engine.listRuns()[0];
	expect(firstRun.projectId).toBe('novis-project');
	expect(firstRun.inputs.question).toBe('How can we reduce inference latency?');
	expect(firstRun.inputs.parameters).toEqual({
		attempts: 2,
		verified: true,
		nested: { mode: 'bounded' },
	});
	await page.screenshot({ path: '/tmp/freelm-project-workflow-dark.png' });
	await page.getByRole('button', { name: 'Workflows', exact: true }).click();
	await page.getByRole('button', { name: /Reusable investigation 3 nodes/ }).click();
	await expect(page.getByText('Run completed', { exact: true })).toHaveCount(0);
	await page.getByRole('button', { name: 'Add to project', exact: true }).click();
	await chooseOption(
		page,
		page.getByRole('combobox', { name: 'Choose project for workflow' }),
		'materials-project',
	);
	await expect(page.locator('.workflow-project-header')).toContainText('Materials');
	await expect(page.getByRole('complementary', { name: 'Run history' })).toContainText(
		'No runs yet.',
	);
	await page
		.getByLabel('Workflow request', { exact: true })
		.fill('Which coatings resist saltwater corrosion?');
	await page.getByRole('button', { name: 'Run workflow', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Run completed', exact: true })).toBeVisible();
	await expect(page.getByRole('complementary', { name: 'Run history' })).toContainText(
		'Which coatings resist saltwater corrosion?',
	);
	await expect(page.getByRole('complementary', { name: 'Run history' })).not.toContainText(
		'inference latency',
	);
	expect(engine.listRuns()).toHaveLength(2);
	expect(new Set(engine.listRuns().map((run) => run.bindingId)).size).toBe(2);
	await page.getByRole('button', { name: 'Configuration', exact: true }).click();
	await expect(page.getByRole('combobox', { name: 'Project workflow permissions' })).toBeVisible();
	await page.getByRole('button', { name: 'Save configuration', exact: true }).click();
	await expect(page.getByText('Configuration saved', { exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Configuration', exact: true }).click();
	await page.locator('html').evaluate((element) => element.setAttribute('data-theme', 'light'));
	await page.setViewportSize({ width: 1024, height: 900 });
	await expect(page.getByLabel('Workflow request', { exact: true })).toBeVisible();
	const typography = await page
		.locator(
			'.workflow-project-header button, .workflow-request-label, .workflow-project-result h2, .workflow-request-composer textarea',
		)
		.evaluateAll((elements) =>
			elements.map((element) => parseFloat(getComputedStyle(element).fontSize)),
		);
	expect(typography.every((size) => size >= 13)).toBe(true);
	await page.screenshot({ path: '/tmp/freelm-project-workflow-light-narrow.png' });
	await page.getByRole('button', { name: 'Edit workflow', exact: true }).click();
	await expect(page.getByRole('application', { name: 'Workflow canvas' })).toBeVisible();
	await page.getByLabel('Workflow name', { exact: true }).fill('Reusable investigation revised');
	await expect
		.poll(
			() =>
				engine.snapshot().bindings?.find((binding) => binding.projectId === 'materials-project')
					?.workflowSnapshot.name,
		)
		.toBe('Reusable investigation revised');
	expect(engine.listWorkflows()[0].name).toBe('Reusable investigation');
	await page.getByRole('button', { name: 'Back to Materials workflow' }).click();
	await expect(page.locator('.workflow-project-header h1')).toHaveText(
		'Reusable investigation revised',
	);
	await expect(page.getByRole('complementary', { name: 'Run history' })).not.toContainText(
		'inference latency',
	);
});

test('recovers rejected project edits and runs, then approves an agent-created private workflow child', async ({
	page,
}) => {
	const child = createWorkflow('review');
	child.name = 'Private review step';
	const workflow = createWorkflow();
	workflow.name = 'Private project investigation';
	const subworkflow = createWorkflowNode('subworkflow', { x: 350, y: 100 });
	subworkflow.config.workflowId = child.id;
	workflow.nodes.splice(1, 0, subworkflow);
	workflow.edges = [
		{
			id: 'request-child',
			source: workflow.nodes[0].id,
			sourceHandle: 'value',
			target: subworkflow.id,
			targetHandle: 'input',
		},
		{
			id: 'child-result',
			source: subworkflow.id,
			sourceHandle: 'value',
			target: workflow.nodes[2].id,
			targetHandle: 'input',
		},
	];
	const engine = await fixture(page);
	const binding = await engine.attachWorkflow({
		workflowId: workflow.id,
		projectId: 'novis-project',
		workflow,
		dependencies: [child],
	});
	await page.getByRole('button', { name: 'Home', exact: true }).click();
	await chooseOption(page, page.getByRole('combobox', { name: 'Conversation mode' }), 'code');
	await page
		.locator('#project-threads-novis-project')
		.getByRole('button', { name: 'Private project investigation', exact: true })
		.click();
	await page.getByRole('button', { name: 'Edit workflow', exact: true }).click();
	await expect(page.getByRole('application', { name: 'Workflow canvas' })).toBeVisible();
	await expect(page.getByLabel('Workflow name', { exact: true })).toHaveValue(
		'Private project investigation',
	);
	await expect(page.getByRole('switch', { name: 'Automatic triggers' })).toHaveCount(0);
	engine.control.beforeBindingSave = async () => {
		engine.control.beforeBindingSave = undefined;
		await engine.updateBinding(binding.id, {
			workflow: { ...binding.workflowSnapshot, description: 'Updated concurrently by Code.' },
		});
	};
	await page.getByLabel('Workflow name', { exact: true }).fill('Unsaved local change');
	await expect(page.getByRole('alert')).toContainText('changed');
	await expect(page.getByLabel('Workflow name', { exact: true })).toHaveValue(
		'Unsaved local change',
	);
	await page.getByRole('button', { name: 'Reload saved version', exact: true }).click();
	await expect(page.getByLabel('Workflow name', { exact: true })).toHaveValue(
		'Private project investigation',
	);

	await page.getByRole('button', { name: 'Back to Novis workflow', exact: true }).click();
	await page.getByLabel('Workflow request', { exact: true }).fill('Review this project proposal.');
	engine.projects[0].directories = [];
	await page.getByRole('button', { name: 'Run workflow', exact: true }).click();
	await expect(page.getByRole('alert')).toContainText('Choose a project directory');
	await expect(page.getByLabel('Workflow request', { exact: true })).toHaveValue(
		'Review this project proposal.',
	);
	expect(engine.listRuns()).toHaveLength(0);
	engine.projects[0].directories = ['/fixture/Novis'];
	await page.getByRole('button', { name: 'Run workflow', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Approve & continue', exact: true })).toBeVisible({
		timeout: 15_000,
	});
	await expect(page.locator('.workflow-run-approval')).toContainText('Private review step');
	await page.getByRole('button', { name: 'Approve & continue', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Run completed', exact: true })).toBeVisible({
		timeout: 15_000,
	});
	expect(engine.listWorkflows()).toHaveLength(0);
	expect(engine.listRuns().every((run) => run.projectId === 'novis-project')).toBe(true);
	await page.reload();
	await page.getByRole('button', { name: 'Home', exact: true }).click();
	await chooseOption(page, page.getByRole('combobox', { name: 'Conversation mode' }), 'code');
	await page
		.locator('#project-threads-novis-project')
		.getByRole('button', { name: 'Private project investigation', exact: true })
		.click();
	await expect(page.getByRole('heading', { name: 'Run completed', exact: true })).toBeVisible();
});
