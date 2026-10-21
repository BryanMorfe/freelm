import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceAuthority } from '../electron/workspace-authority';
import { StateStore } from '../electron/state-store';
import { AgentHost } from '../electron/agent-host';
import { createAgentHost } from '../electron/agent-bridge';
import { performRequest } from '../electron/transport';
import { defaultToolSettings } from '../src/lib/tool-settings';
import type { AppState, Message, Thread, WireResponse } from '../src/types';
import type { CodeActionDecision, ToolHostRequest } from '../src/agent-types';
import { buildCodeReviewEvidence, type CodeReviewThread } from '../electron/code-review-context';

vi.mock('electron', () => ({ dialog: {}, ipcMain: { handle: vi.fn() } }));
vi.mock('../electron/transport', async (original) => ({
	...(await original<typeof import('../electron/transport')>()),
	performRequest: vi.fn(),
}));

const goal = 'Create a chess UI and inspect the existing source.';
const cleanup: (() => Promise<unknown>)[] = [];
beforeEach(() => vi.mocked(performRequest).mockReset());
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
	vi.restoreAllMocks();
});

function call(cmd: string): ToolHostRequest {
	return {
		workspaceId: 'local',
		runId: 'run',
		threadId: 'task',
		name: 'exec_command',
		arguments: { cmd },
	};
}
function completed(decision: CodeActionDecision): WireResponse {
	return {
		status: 200,
		contentType: 'application/json',
		encoding: 'text',
		body: JSON.stringify({
			status: 'completed',
			output: [
				{
					type: 'message',
					role: 'assistant',
					content: [{ type: 'output_text', text: JSON.stringify(decision) }],
				},
			],
		}),
	};
}

async function fixture() {
	const folder = await mkdtemp(path.join(tmpdir(), 'freelm-code-review-context-'));
	cleanup.push(() => rm(folder, { recursive: true, force: true }));
	const project = path.join(folder, 'project');
	await mkdir(path.join(project, 'public'), { recursive: true });
	await Promise.all([
		writeFile(path.join(project, 'package.json'), '{"name":"review-fixture"}'),
		writeFile(path.join(project, 'public', 'app.js'), 'console.log("fixture");'),
		writeFile(path.join(project, 'public', 'style.css'), 'body { color: white; }'),
	]);
	const thread: Thread = {
		id: 'task',
		kind: 'code',
		title: 'Task',
		projectId: 'project',
		connectionId: 'provider',
		model: 'model',
		thinkingMode: 'low',
		permissionMode: 'auto-review',
		createdAt: 1,
		updatedAt: 2,
		messages: [
			{ id: 'user', role: 'user', content: goal, createdAt: 1 },
			{
				id: 'assistant',
				role: 'assistant',
				content: 'I will inspect the project source.',
				createdAt: 2,
			},
		],
	};
	const state: AppState = {
		version: 1,
		theme: 'dark',
		activeConnectionId: 'provider',
		threads: [thread],
		generations: [],
		projects: [
			{
				id: 'project',
				kind: 'code',
				name: 'Selected project',
				instructions: '',
				directories: [project],
				createdAt: 1,
			},
		],
		connections: [
			{
				id: 'provider',
				name: 'Provider',
				baseUrl: 'http://provider.invalid/v1',
				apiKey: '',
				chatApi: 'responses',
				models: { chat: 'model', images: '', videos: '', speech: '', transcription: '' },
				discoveredModels: ['model'],
				catalog: [
					{
						id: 'model',
						name: 'Model',
						enabled: true,
						tasks: ['chat'],
						inputModalities: ['text'],
						outputModalities: ['text'],
						thinkingModes: [
							{
								id: 'low',
								name: 'Low',
								parameters: { responses: { reasoning: { effort: 'low' } } },
							},
						],
						defaultThinkingMode: 'low',
					},
				],
			},
		],
		toolSettings: { ...defaultToolSettings(), approvalMode: 'auto-review', workspaceRoot: project },
	};
	const store = new StateStore(
		path.join(folder, 'workspace.json'),
		{
			available: () => false,
			encrypt: () => {
				throw new Error('Unused');
			},
			decrypt: () => {
				throw new Error('Unused');
			},
		},
		path.join(folder, 'config.json'),
	);
	const authority = new WorkspaceAuthority(store);
	await authority.save(state, (await authority.load()).revision);
	return { state, authority, project };
}

describe('production Code reviewer context', () => {
	it('uses the separate history loader in the production bridge while ordinary tool reads stay lightweight', async () => {
		const { authority } = await fixture();
		const toolLoad = vi.spyOn(authority, 'loadToolState');
		const reviewLoad = vi.spyOn(authority, 'loadCodeReviewState');
		vi.mocked(performRequest).mockImplementation(async (request) => {
			const hasHumanGoal = JSON.stringify(request.body).includes(goal);
			return completed({
				approved: hasHumanGoal,
				reason: hasHumanGoal
					? 'The human requested this inspection.'
					: 'No human request is present.',
			});
		});
		const bridge = createAgentHost(authority, () => null);
		cleanup.push(() => bridge.service.close());
		await bridge.service.catalog('run', 'task');
		for (const [cmd, expected] of [
			['cat package.json', 'review-fixture'],
			['cat public/app.js', 'console.log'],
			['cat public/style.css', 'color: white'],
		]) {
			const result = await bridge.service.execute(call(cmd));
			expect(result.isError).not.toBe(true);
			expect(
				result.content
					.filter((part) => part.type === 'text')
					.map((part) => part.text)
					.join('\n'),
			).toContain(expected);
		}
		expect(toolLoad).toHaveBeenCalled();
		expect(reviewLoad).toHaveBeenCalledTimes(3);
		for (const result of toolLoad.mock.results)
			expect((await result.value)?.threads[0].messages).toEqual([]);
	});

	it('copies only selected task context and strips media before cloning review history', async () => {
		const { state, authority } = await fixture();
		const snapshot = await authority.load();
		const selected = state.threads[0];
		const media = 'data:image/png;base64,' + 'A'.repeat(100_000);
		selected.messages[0].attachments = [
			{ name: 'reference.png', type: 'image/png', dataUrl: media },
		];
		selected.messages[1].agentTranscript = {
			api: 'responses',
			items: [{ type: 'input_image', image_url: media }],
		};
		selected.messages[1].toolCalls = [
			{
				id: 'image',
				name: 'image_gen.imagegen',
				arguments: '{}',
				status: 'completed',
				startedAt: 2,
				result: {
					content: [
						{ type: 'image', dataUrl: media },
						{ type: 'text', text: 'Created a reference image.' },
					],
				},
			},
		];
		selected.queuedMessages = [
			{
				id: 'pending',
				content: 'Pending work.',
				createdAt: 3,
				attachments: [{ name: 'pending.png', type: 'image/png', dataUrl: media }],
			},
		];
		selected.messageHistory = [
			{
				id: 'old-version',
				role: 'user',
				content: 'Inactive version should stay private.',
				createdAt: 1,
			},
		];
		state.threads.push({
			...selected,
			id: 'unrelated',
			queuedMessages: undefined,
			messages: [
				{ id: 'private', role: 'user', content: 'UNRELATED-PRIVATE-HISTORY', createdAt: 1 },
			],
		});
		state.generations = [
			{
				id: 'gallery',
				kind: 'images',
				prompt: 'Gallery',
				model: 'image',
				connectionId: 'provider',
				createdAt: 1,
				status: 'completed',
				assets: [{ name: 'gallery.png', mimeType: 'image/png', url: media }],
			},
		];
		state.chatDrafts = { draft: { content: 'PRIVATE-DRAFT', attachments: [], updatedAt: 1 } };
		state.connections.push({
			...state.connections[0],
			id: 'unrelated-provider',
			name: 'UNRELATED-PROVIDER',
		});
		state.projects.push({
			...state.projects[0],
			id: 'unrelated-project',
			name: 'UNRELATED-PROJECT',
		});
		await authority.save(state, snapshot.revision);
		const review = (await authority.loadCodeReviewState('task'))!;
		expect(review.threads).toHaveLength(1);
		expect(review.projects).toHaveLength(1);
		expect(review.connections).toHaveLength(1);
		expect(review.generations).toEqual([]);
		expect(review.chatDrafts).toBeUndefined();
		expect(review.threads[0].queuedMessages).toBeUndefined();
		expect(review.threads[0].messageHistory).toBeUndefined();
		expect(review.threads[0].messages[0].attachments).toEqual([
			{ name: 'reference.png', type: 'image/png', dataUrl: '' },
		]);
		expect(review.threads[0].messages[1].agentTranscript).toBeUndefined();
		expect(review.threads[0].messages[1].toolCalls?.[0].result?.content).toEqual([
			{ type: 'text', text: 'Created a reference image.' },
		]);
		const serialized = JSON.stringify(review);
		for (const privateValue of [
			media,
			'UNRELATED-PRIVATE-HISTORY',
			'PRIVATE-DRAFT',
			'Inactive version should stay private.',
			'UNRELATED-PROVIDER',
			'UNRELATED-PROJECT',
		])
			expect(serialized).not.toContain(privateValue);
		review.threads[0].messages[0].content = 'Changed returned copy';
		review.projects[0].directories![0] = '/changed';
		expect((await authority.load()).state?.threads[0].messages[0].content).toBe(goal);
		expect(await authority.loadCodeReviewState('missing')).toBeNull();
	});

	it('retains original human authorization and later restrictions beyond sixty-four messages', async () => {
		const { state, authority } = await fixture();
		const later: Message[] = Array.from({ length: 80 }, (_, index) => ({
			id: `assistant-${index}`,
			role: 'assistant',
			content: `Progress ${index}`,
			createdAt: index + 3,
		}));
		later.push({
			id: 'restriction',
			role: 'user',
			content: 'Do not read .env or credentials.',
			createdAt: 100,
		});
		state.threads[0].messages.push(...later);
		await authority.save(state, (await authority.load()).revision);
		const review = (await authority.loadCodeReviewState('task'))!;
		expect(review.threads[0].messages[0].content).toBe(goal);
		expect(review.threads[0].messages.at(-1)?.content).toBe('Do not read .env or credentials.');
		expect(review.threads[0].messages.some((message) => message.id === 'assistant-0')).toBe(false);
	});
	it('carries initial history omissions only in the review snapshot, preserving durable task history', async () => {
		const { state, authority } = await fixture();
		const activity: Message[] = Array.from({ length: 80 }, (_, index) => ({
			id: `progress-${index}`,
			role: 'assistant',
			content: `Progress ${index}`,
			createdAt: index + 3,
			toolCalls: [
				{
					id: `call-${index}`,
					name: 'exec_command',
					arguments: JSON.stringify({ cmd: 'echo historic', output: 'x'.repeat(5000) }),
					status: 'completed',
					startedAt: index + 3,
				},
			],
		}));
		state.threads[0].messages.push(...activity);
		await authority.save(state, (await authority.load()).revision);
		const review = (await authority.loadCodeReviewState('task'))!;
		const thread = review.threads[0] as CodeReviewThread;
		expect(thread.reviewEvidenceOmissions).toEqual({ messages: 17, toolCalls: 16 });
		const text = buildCodeReviewEvidence(
			thread.messages,
			{ proposedAction: { name: 'exec_command', arguments: { cmd: 'echo ok' } } },
			'Review policy',
			20_000,
			2000,
			thread.reviewEvidenceOmissions,
		)!;
		const evidence = JSON.parse(text);
		expect(evidence.contextOmissions.historicalMessagesOmitted).toBeGreaterThanOrEqual(17);
		expect(evidence.contextOmissions.historicalToolCallsOmitted).toBeGreaterThanOrEqual(16);
		expect(evidence.earlierMessagesOmitted).toBe(true);
		const durable = (await authority.load()).state!.threads[0];
		expect(durable).not.toHaveProperty('reviewEvidenceOmissions');
		expect(durable.messages).toHaveLength(82);
		expect(durable.messages[2].toolCalls![0].arguments).toContain('x'.repeat(5000));
	});

	it('uses the fifth loader only in auto-review and retains cancellation while loading it', async () => {
		const { authority } = await fixture();
		const reviewer = vi.fn(async () => ({ approved: true, reason: 'Inspection authorized.' }));
		let resolve!: (state: AppState | null) => void;
		const reviewLoad = vi.fn(
			() =>
				new Promise<AppState | null>((done) => {
					resolve = done;
				}),
		);
		const host = new AgentHost(
			() => authority.loadToolState(),
			async () => true,
			undefined,
			reviewer,
			reviewLoad,
		);
		cleanup.push(() => host.close());
		await host.catalog('run', 'task');
		const execution = host.execute(call('cat package.json'));
		const cancelled = expect(execution).rejects.toMatchObject({ name: 'AbortError' });
		await vi.waitFor(() => expect(reviewLoad).toHaveBeenCalledWith('task'));
		host.cancel('run');
		resolve(await authority.loadCodeReviewState('task'));
		await cancelled;
		expect(reviewer).not.toHaveBeenCalled();
	});
});
