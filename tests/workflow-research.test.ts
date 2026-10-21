import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createResearchWorkflows, DEFAULT_RESEARCH_GOAL } from '../src/lib/workflow-research';
import { WorkflowEngine, validateWorkflow } from '../electron/workflows/engine';
import { WorkflowStore } from '../electron/workflows/store';
import { structuredWorkflowOutput } from '../electron/workflows/structured-output';
import type { Connection } from '../src/types';

const connection: Connection = {
	id: 'local-test',
	name: 'Local test',
	baseUrl: 'http://127.0.0.1:1/v1',
	apiKey: '',
	chatApi: 'responses',
	models: { chat: 'qwen3.8-27b', images: '', videos: '', speech: '', transcription: '' },
	discoveredModels: [],
	catalog: [
		{
			id: 'qwen3.8-27b',
			name: 'Qwen 3.8 27B',
			enabled: true,
			tasks: ['chat'],
			inputModalities: ['text'],
			outputModalities: ['text'],
			thinkingModes: [
				{
					id: 'medium',
					name: 'Medium',
					parameters: { responses: { reasoning: { effort: 'medium' } } },
				},
			],
			defaultThinkingMode: 'medium',
		},
	],
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

it('requires an explicit topic and preserves composer questions and constraints across domains', () => {
	const bundle = createResearchWorkflows([connection], { kind: 'co-scientist' });
	const parent = bundle.workflows.at(-1)!;
	expect(parent.name).toBe('Co-Scientist');
	expect(parent.request?.prompt).toMatchObject({ key: 'goal', required: true });
	const initialize = new Function('inputs', String(parent.nodes.find((node) => node.id === 'seed')!.config.code));
	expect(() => initialize({ input: {} })).toThrow('Enter a research question');
	for (const [key, question] of [
		['prompt', 'What makes a polymer recyclable at room temperature?'],
		['text', 'Which assumptions are necessary for this mathematical conjecture?'],
		['goal', 'How can Novis reduce inference latency?'],
	]) {
		const state = initialize({ input: { [key]: question, constraints: 'Use falsifiable claims', references: 'Project reference notes' } });
		expect(state.goal).toBe(question);
		expect(state.constraints).toBe('Use falsifiable claims');
		expect(state.references).toBe('Project reference notes');
		expect(state.hypotheses).toEqual([]);
	}
	for (const workflow of bundle.workflows)
		for (const node of workflow.nodes.filter((node) => node.type === 'agent'))
			expect(String(node.config.prompt)).not.toContain('For the local-inference question');
});

it('creates editable ordinary-node research templates with configured models and explicit schemas', () => {
	for (const kind of ['research-team', 'co-scientist'] as const) {
		const result = createResearchWorkflows([connection], { kind, tools: ['web.run'] });
		expect(result.workflows).toHaveLength(2);
		expect(result.workflows.at(-1)?.id).toBe(result.primaryId);
		for (const workflow of result.workflows) {
			validateWorkflow(workflow);
			expect(workflow.enabled).toBe(false);
			for (const node of workflow.nodes.filter((node) => node.type === 'agent')) {
				expect(node.config.model).toBe('qwen3.8-27b');
				expect(node.config.thinkingMode).toBe('medium');
				expect(structuredWorkflowOutput(node.config)).toBeDefined();
				expect(node.config.permissionMode).toBe('ask');
			}
		}
		const child = result.workflows[0];
		expect(child.nodes.filter((node) => node.type === 'agent')).toHaveLength(
			kind === 'co-scientist' ? 6 : 4,
		);
		expect(child.nodes.find((node) => node.id === 'generate')?.config.tools).toEqual(['web.run']);
		expect(child.nodes.find((node) => node.id === 'evolve')?.config.tools).toEqual([]);
		expect(
			child.edges
				.filter((edge) => edge.source === 'round-input')
				.map((edge) => edge.target)
				.sort(),
		).toEqual(['prepare-round', 'read-rounds']);
		expect(child.edges.filter((edge) => edge.target === 'generate')).toMatchObject([
			{ source: 'prepare-round', targetHandle: 'context' },
		]);
		expect(result.workflows[1].edges.filter((edge) => edge.target === 'synthesize')).toMatchObject([
			{ source: 'prepare-report', targetHandle: 'context' },
		]);
		for (const workflow of result.workflows) {
			for (const edge of workflow.edges.filter(
				(edge) => workflow.nodes.find((node) => node.id === edge.target)?.type === 'collection',
			))
				expect(edge.targetHandle).toBe('value');
		}
		const hypothesis = {
			id: 'H1',
			claim: 'Claim',
			rationale: 'Rationale',
			experiment: 'Test',
			sources: [],
		};
		const generation = structuredWorkflowOutput(
			child.nodes.find((node) => node.id === 'generate')!.config,
		)!;
		expect(() => generation.parse(JSON.stringify({ hypotheses: [hypothesis] }))).toThrow(
			'fewer than 2',
		);
		expect(() =>
			generation.parse(JSON.stringify({ hypotheses: [hypothesis, hypothesis, hypothesis] })),
		).toThrow('more than 2');
		const evolution = structuredWorkflowOutput(
			child.nodes.find((node) => node.id === 'evolve')!.config,
		)!;
		expect(() =>
			evolution.parse(
				JSON.stringify({ hypotheses: [hypothesis, hypothesis, hypothesis], changes: [] }),
			),
		).toThrow('more than 2');
	}
	expect(() => createResearchWorkflows([connection], { connectionId: 'removed' })).toThrow(
		'connection is unavailable',
	);
});

it('prepares bounded round/report contexts without entry aliases or repeated full history', () => {
	const bundle = createResearchWorkflows([connection], { kind: 'co-scientist' });
	const current = {
		goal: DEFAULT_RESEARCH_GOAL,
		iteration: 9,
		feedback: 'Act on the latest feedback',
		hypotheses: [{ id: 'H1', rationale: 'CURRENT_ONLY_MARKER' + 'x'.repeat(44_000) }],
		ranking: [{ hypothesisId: 'H1', score: 1216 }],
		sources: [{ url: 'https://example.org/current' }],
	};
	const records = Array.from({ length: 9 }, (_, index) => ({
		iteration: index + 1,
		feedback: 'f'.repeat(2000),
		hypotheses: [{ id: 'H1', rationale: 'HISTORY_DETAILS_MUST_NOT_REPEAT' + 'y'.repeat(10_000) }],
		ranking: [{ hypothesisId: 'H1', score: 1200 + index }],
	}));
	const payload = { iteration: 10, current, value: current, input: current, previous: records };
	const original = JSON.stringify({ payload, records });
	for (const [workflow, id, input] of [
		[bundle.workflows[0], 'prepare-round', payload],
		[bundle.workflows[1], 'prepare-report', current],
	] as const) {
		const node = workflow.nodes.find((node) => node.id === id)!;
		const prepare = new Function('inputs', String(node.config.code));
		const output = prepare({ input: [input, records] });
		expect(output.current).toBe(current);
		expect(output.iteration).toBe(id === 'prepare-round' ? 10 : 9);
		expect(Object.keys(output)).toEqual(['iteration', 'current', 'history']);
		expect(output.history).toHaveLength(8);
		expect(
			output.history.every((row: { iteration: number }) => row.iteration < current.iteration),
		).toBe(true);
		expect(output.history[0]).toEqual({
			iteration: 1,
			feedback: 'f'.repeat(600),
			hypothesisIds: ['H1'],
			ranking: [{ hypothesisId: 'H1', score: 1200 }],
		});
		const serialized = JSON.stringify(output);
		expect(serialized.split('CURRENT_ONLY_MARKER')).toHaveLength(2);
		expect(serialized).not.toContain('HISTORY_DETAILS_MUST_NOT_REPEAT');
		expect(serialized.length).toBeLessThan(JSON.stringify(current).length + 6500);
		expect(serialized.length).toBeLessThan(96_000);
		expect(() =>
			prepare({ input: [{ current: { notes: 'x'.repeat(96_000) }, iteration: 1 }, records] }),
		).toThrow('96,000-character context budget');
	}
	expect(JSON.stringify({ payload, records })).toBe(original);
});

it('computes tournament ratings deterministically and rejects incomplete or invalid matches', async () => {
	const child = createResearchWorkflows([connection], { kind: 'co-scientist' }).workflows[0];
	const code = String(child.nodes.find((node) => node.id === 'ratings')!.config.code);
	const evaluate = (comparisons: unknown[], prior: unknown[] = []) =>
		new Function('inputs', `return (async()=>{${code}})()`)({
			input: [
				{ hypotheses: [{ id: 'H1' }, { id: 'H2' }] },
				{ comparisons, rankingCaveats: 'A model judgment' },
				{ current: { ranking: prior } },
			],
		});
	const match = { leftId: 'H1', rightId: 'H2', winnerId: 'H1', rationale: 'More testable' };
	const first = await evaluate([match]);
	expect(first.ranking).toEqual([
		{ hypothesisId: 'H1', score: 1216 },
		{ hypothesisId: 'H2', score: 1184 },
	]);
	const second = await evaluate([match], first.ranking);
	expect(second.ranking[0].score).toBeGreaterThan(1216);
	await expect(evaluate([])).rejects.toThrow('each hypothesis pair');
	await expect(evaluate([match, match])).rejects.toThrow('Duplicate');
	await expect(evaluate([{ ...match, winnerId: 'invented' }])).rejects.toThrow('Invalid');
});

it('executes two research rounds with actual template transforms, shared records and isolated investigations', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'freelm-research-template-'));
	const source = {
		title: 'Efficient Memory Management for Large Language Model Serving with PagedAttention',
		url: 'https://arxiv.org/abs/2309.06180',
		supports: 'Fixture source for memory-efficient serving; local latency remains unmeasured.',
	};
	const reviewSource = {
		title: 'Review evidence fixture',
		url: 'https://example.org/review-evidence',
		supports: 'Fixture counter-evidence: throughput does not establish individual request latency.',
	};
	const observed: {
		iteration: number;
		prior: unknown;
		history: unknown[];
		ranking: { hypothesisId: string; score: number }[];
	}[] = [];
	const engine = new WorkflowEngine({
		store: new WorkflowStore(root),
		autoSchedule: false,
		execute: async (node, inputs, context) => {
			if (node.type === 'code') {
				// Execute only trusted code shipped in this template, not model-generated code.
				const value = await new Function(
					'inputs',
					`return (async()=>{${String(node.config.code)}})()`,
				)(inputs);
				return { value };
			}
			const round = Number(context.run.inputs.iteration ?? 0);
			const h = {
				id: 'H1',
				claim: `Round ${round}: batch compatible requests`,
				rationale: 'Measured comparison required',
				experiment: 'Compare p95 latency at fixed load and quality',
				sources: [source],
			};
			const alternative = { ...h, id: 'H2', claim: `Round ${round}: cache reusable prefixes` };
			let value: unknown;
			switch (node.id) {
				case 'generate': {
					const start = inputs.context as {
						current: { feedback: string; ranking: { hypothesisId: string; score: number }[] };
						history: unknown[];
					};
					observed.push({
						iteration: round,
						prior: start.current.feedback,
						history: start.history,
						ranking: start.current.ranking,
					});
					value = { hypotheses: [h, alternative] };
					break;
				}
				case 'proximity':
					value = {
						hypotheses: [h, alternative],
						clusters: ['batching', 'caching'],
						diversityNotes: 'Two distinct fixture hypotheses',
					};
					break;
				case 'review':
					value = {
						reviews: [h, alternative].map((candidate) => ({
							hypothesisId: candidate.id,
							strengths: 'Testable',
							criticisms: ['Control queue depth'],
							missingEvidence: ['Benchmark'],
							proposedTest: 'Fixed-load baseline',
							sources: [reviewSource],
						})),
					};
					break;
				case 'rank':
					value = {
						comparisons: [
							{
								leftId: 'H1',
								rightId: 'H2',
								winnerId: 'H1',
								rationale: 'More testable in this fixture',
							},
						],
						rankingCaveats: 'Heuristic',
					};
					break;
				case 'evolve':
					// Even if refinement omits a citation, assembly must preserve prior/candidate/review evidence.
					value = {
						hypotheses: [h, alternative].map((candidate) => ({ ...candidate, sources: [] })),
						changes: [`Addressed round ${round} critiques`],
					};
					break;
				case 'meta':
					value = {
						feedback: `Feedback from round ${round}`,
						done: true,
						stopReason: 'Ready for measurement',
						nextSteps: ['Benchmark'],
					};
					break;
				case 'synthesize': {
					const prepared = inputs.context as {
						current: { sources: unknown[]; rankingCaveats: string };
						history: { iteration: number }[];
					};
					const final = prepared.current;
					expect(prepared.history.map((row) => row.iteration)).toEqual([1]);
					expect(final.sources).toEqual([source, reviewSource]);
					expect(final.rankingCaveats).toBe('Heuristic');
					value = {
						summary: 'Two rounds completed, no experiments run.',
						findings: [
							{ claim: 'Batch requests', assessment: 'Untested', nextExperiment: 'Benchmark' },
						],
						sources: final.sources,
						limitations: ['No measurements'],
						nextSteps: ['Review'],
					};
					break;
				}
				default:
					throw new Error(`Unexpected adapter node ${node.id}`);
			}
			structuredWorkflowOutput(node.config)?.parse(JSON.stringify(value));
			return { value, json: value, text: JSON.stringify(value) };
		},
	});
	await engine.init();
	cleanups.push(async () => {
		await engine.dispose();
		await rm(root, { recursive: true, force: true });
	});
	const bundle = createResearchWorkflows([connection], { kind: 'co-scientist' });
	for (const workflow of bundle.workflows) await engine.saveWorkflow(workflow);
	for (let investigation = 0; investigation < 2; investigation++) {
		const run = await engine.startRun(bundle.primaryId, {
			inputs: { goal: DEFAULT_RESEARCH_GOAL },
		});
		await vi.waitFor(
			async () => {
				await engine.tick();
				const current = engine.getRun(run.id)!;
				if (current.status === 'failed')
					throw new Error(current.error || JSON.stringify(current.nodes));
				expect(current.status).toBe('completed');
			},
			{ timeout: 15000, interval: 20 },
		);
		const result = engine.getRun(run.id)!;
		expect(result.nodes.investigate.output?.iterations).toBe(2);
		expect(result.outputs?.rounds).toHaveLength(2);
		expect(result.outputs?.report).toContain('No measurements');
		expect(result.outputs?.report).toContain('\n\n## Sources\n\n');
		expect(result.outputs?.report).toContain(source.url);
		expect(result.outputs?.report).toContain(reviewSource.url);
		const rounds = (
			result.outputs!.rounds as {
				data: {
					sources: unknown[];
					ranking: { hypothesisId: string; score: number }[];
					rankingCaveats: string;
				};
			}[]
		).map((record) => record.data);
		expect(rounds[0].sources).toEqual([source, reviewSource]);
		expect(rounds[1].sources).toEqual([source, reviewSource]);
		expect(rounds[0].ranking[0].score).toBe(1216);
		expect(rounds[1].ranking[0].score).toBeGreaterThan(rounds[0].ranking[0].score);
		expect(rounds[1].rankingCaveats).toBe('Heuristic');
	}
	for (let i = 0; i < observed.length; i += 2) {
		expect(observed[i]).toEqual({ iteration: 1, prior: '', history: [], ranking: [] });
		expect(observed[i + 1].iteration).toBe(2);
		expect(observed[i + 1].prior).toBe('Feedback from round 1');
		// Round 1 is already the complete current state, so it is not duplicated in older history.
		expect(observed[i + 1].history).toHaveLength(0);
		expect(observed[i + 1].ranking[0]).toEqual({ hypothesisId: 'H1', score: 1216 });
	}
}, 15_000);
