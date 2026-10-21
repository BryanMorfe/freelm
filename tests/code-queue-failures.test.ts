import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore } from '../electron/state-store';
import { validateState } from '../electron/validation';
import {
	addCodeQueueFailure,
	createCodeQueueFailure,
	pruneCodeQueueFailures,
	recoverCodeQueueFailures,
	removeCodeQueueFailure,
	INTERRUPTED_CODE_QUEUE_ERROR,
	MAX_CODE_QUEUE_FAILURE_ERROR,
} from '../src/lib/code-queue';
import { forkConversation } from '../src/lib/conversation-tree';
import { initialState, recoverState } from '../src/lib/state';
import type { CodeQueueFailure, Message, Thread } from '../src/types';

const folders: string[] = [];
afterEach(async () => {
	await Promise.all(
		folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
	);
});

function thread(): Thread {
	const messages: Message[] = [
		{ id: 'original-user', role: 'user', content: 'Inspect this project.', createdAt: 1 },
		{
			id: 'original-answer',
			role: 'assistant',
			content: 'Inspected.',
			createdAt: 2,
			completedAt: 3,
		},
		{
			id: 'queued-user',
			role: 'user',
			content: 'Also inspect the attached image.',
			createdAt: 4,
			attachments: [
				{ name: 'reference.png', type: 'image/png', dataUrl: 'data:image/png;base64,AA==' },
			],
		},
		{
			id: 'queue-answer',
			role: 'assistant',
			content: '',
			createdAt: 5,
			phase: 'working',
			agentTranscript: {
				api: 'responses',
				items: [
					{
						type: 'function_call',
						call_id: 'read',
						name: 'read_file',
						arguments: '{"path":"README.md"}',
					},
					{ type: 'function_call_output', call_id: 'read', output: 'Completed read output.' },
				],
			},
		},
	];
	return {
		id: 'task',
		kind: 'code',
		title: 'Task',
		connectionId: 'provider',
		model: 'model',
		createdAt: 1,
		updatedAt: 5,
		messages,
	};
}
function failure(source: Thread, id = 'failure'): CodeQueueFailure {
	return createCodeQueueFailure(
		'queue-answer',
		[source.messages[2]],
		'Provider disconnected.',
		10,
		id,
	)!;
}

describe('committed Code queue failure recovery', () => {
	it('records only unique user IDs, with no second content or attachment copy', () => {
		const source = thread();
		const record = createCodeQueueFailure(
			'queue-answer',
			[source.messages[2], source.messages[2], source.messages[3]],
			'  Provider disconnected.  ',
			10,
			'failure',
		);
		expect(record).toEqual({
			id: 'failure',
			assistantId: 'queue-answer',
			messageIds: ['queued-user'],
			error: 'Provider disconnected.',
			failedAt: 10,
		});
		expect(JSON.stringify(record)).not.toContain('reference.png');
		expect(JSON.stringify(record)).not.toContain('base64');
		expect(
			createCodeQueueFailure('queue-answer', [source.messages[3]], 'Failed', 10),
		).toBeUndefined();
		expect(
			createCodeQueueFailure(
				'queue-answer',
				[source.messages[2]],
				'A'.repeat(MAX_CODE_QUEUE_FAILURE_ERROR + 1),
				10,
			)?.error,
		).toHaveLength(MAX_CODE_QUEUE_FAILURE_ERROR);
	});

	it('updates the same assistant failure without mutating history or duplicating input ownership', () => {
		const source = thread(),
			first = failure(source);
		const previous = [first];
		expect(pruneCodeQueueFailures(previous, source.messages)).toBe(previous);
		const revised = { ...first, error: 'Retry disconnected again.', failedAt: 20 };
		const records = addCodeQueueFailure(previous, revised, source.messages);
		expect(records).toEqual([revised]);
		expect(records[0].messageIds).not.toBe(revised.messageIds);
		expect(previous).toEqual([first]);
		expect(removeCodeQueueFailure(records, 'missing')).toBe(records);
		expect(removeCodeQueueFailure(records, first.id)).toEqual([]);
		expect(source.messages[3].agentTranscript?.items).toHaveLength(2);
	});

	it('drops missing or inactive-path references, including duplicate owner and input records', () => {
		const source = thread(),
			record = failure(source);
		expect(pruneCodeQueueFailures([record], source.messages.slice(0, 2))).toEqual([]);
		expect(
			pruneCodeQueueFailures([record, { ...record, id: 'duplicate' }], source.messages),
		).toEqual([record]);
		expect(
			addCodeQueueFailure([record], { ...record, assistantId: 'missing' }, source.messages),
		).toEqual([record]);
		expect(
			pruneCodeQueueFailures(
				[{ ...record, messageIds: ['queued-user', 'missing'] }],
				source.messages,
			),
		).toEqual([]);
	});

	it('turns a persisted unfinished delivery into a visible failure without replaying committed users or tool outputs', () => {
		const source = thread();
		source.codeQueueDelivery = {
			assistantId: 'queue-answer',
			messageIds: ['queued-user'],
			startedAt: 6,
		};
		const state = initialState();
		source.connectionId = state.activeConnectionId;
		state.threads = [source];
		const recovered = recoverState(state),
			task = recovered.threads[0];
		expect(task.codeQueueDelivery).toBeUndefined();
		expect(task.codeQueueFailures).toHaveLength(1);
		expect(task.codeQueueFailures?.[0]).toMatchObject({
			assistantId: 'queue-answer',
			messageIds: ['queued-user'],
			error: INTERRUPTED_CODE_QUEUE_ERROR,
			failedAt: 6,
		});
		expect(task.messages.filter((message) => message.id === 'queued-user')).toHaveLength(1);
		expect(task.messages[2]).toBe(source.messages[2]);
		expect(task.messages[3].agentTranscript).toBe(source.messages[3].agentTranscript);
		expect(task.messages[3].interrupted).toBe(true);
		expect(source.codeQueueDelivery).toBeDefined();
		expect(recoverState(recovered)).toBe(recovered);
		validateState(recovered);
	});

	it('preserves a provider failure across reload and clears a successful completed delivery', () => {
		const source = thread();
		source.messages[3] = { ...source.messages[3], error: 'Upstream 503.', completedAt: 8 };
		source.codeQueueDelivery = {
			assistantId: 'queue-answer',
			messageIds: ['queued-user'],
			startedAt: 6,
		};
		const recovered = recoverCodeQueueFailures(source);
		expect(recovered.codeQueueFailures?.[0].error).toBe('Upstream 503.');
		const successful = {
			...recovered,
			codeQueueDelivery: source.codeQueueDelivery,
			messages: source.messages.map((message) =>
				message.id === 'queue-answer'
					? {
							...message,
							error: undefined,
							interrupted: undefined,
							content: 'Completed.',
							completedAt: 9,
						}
					: message,
			),
		};
		const completed = recoverCodeQueueFailures(successful);
		expect(completed.codeQueueDelivery).toBeUndefined();
		expect(completed.codeQueueFailures).toEqual([]);
		expect(recoverCodeQueueFailures(completed)).toBe(completed);
	});

	it('does not copy failure actions or active delivery into a conversation branch', () => {
		const source = thread();
		source.codeQueueFailures = [failure(source)];
		source.codeQueueDelivery = {
			assistantId: 'queue-answer',
			messageIds: ['queued-user'],
			startedAt: 6,
		};
		const fork = forkConversation(source, 'queue-answer', 'branch');
		expect(fork.codeQueueFailures).toBeUndefined();
		expect(fork.codeQueueDelivery).toBeUndefined();
		expect(source.codeQueueFailures).toHaveLength(1);
	});

	it('persists failure and delivery references without duplicating image payloads and recovers on reload', async () => {
		const folder = await mkdtemp(path.join(tmpdir(), 'freelm-code-queue-failure-'));
		folders.push(folder);
		const filename = path.join(folder, 'workspace.json'),
			config = path.join(folder, 'config.json');
		const secrets = {
			available: () => false,
			encrypt: () => {
				throw new Error('Unused');
			},
			decrypt: () => {
				throw new Error('Unused');
			},
		};
		const store = new StateStore(filename, secrets, config);
		const state = initialState(),
			source = thread();
		source.connectionId = state.activeConnectionId;
		source.codeQueueFailures = [failure(source)];
		source.codeQueueDelivery = {
			assistantId: 'queue-answer',
			messageIds: ['queued-user'],
			startedAt: 6,
		};
		state.threads = [source];
		await store.save(state);
		const reopened = new StateStore(filename, secrets, config),
			loaded = await reopened.load();
		expect(loaded?.threads[0].codeQueueFailures).toEqual(source.codeQueueFailures);
		expect(loaded?.threads[0].codeQueueDelivery).toEqual(source.codeQueueDelivery);
		const recovered = recoverState(loaded!);
		await reopened.save(recovered);
		const next = await new StateStore(filename, secrets, config).load();
		expect(next?.threads[0].codeQueueDelivery).toBeUndefined();
		expect(next?.threads[0].codeQueueFailures).toHaveLength(1);
		expect(next?.threads[0].messages[2].attachments).toEqual(source.messages[2].attachments);
		expect((await readFile(filename, 'utf8')).match(/base64,AA==/g)).toHaveLength(1);
	});

	it.each([
		{
			id: 'failure',
			assistantId: 'missing',
			messageIds: ['queued-user'],
			error: 'Failed',
			failedAt: 10,
		},
		{
			id: 'failure',
			assistantId: 'queued-user',
			messageIds: ['queued-user'],
			error: 'Failed',
			failedAt: 10,
		},
		{
			id: 'failure',
			assistantId: 'queue-answer',
			messageIds: ['missing'],
			error: 'Failed',
			failedAt: 10,
		},
		{
			id: 'failure',
			assistantId: 'queue-answer',
			messageIds: ['queue-answer'],
			error: 'Failed',
			failedAt: 10,
		},
		{ id: 'failure', assistantId: 'queue-answer', messageIds: [], error: 'Failed', failedAt: 10 },
		{
			id: 'failure',
			assistantId: 'queue-answer',
			messageIds: ['queued-user', 'queued-user'],
			error: 'Failed',
			failedAt: 10,
		},
		{
			id: 'failure',
			assistantId: 'queue-answer',
			messageIds: ['queued-user'],
			error: '',
			failedAt: 10,
		},
		{
			id: 'failure',
			assistantId: 'queue-answer',
			messageIds: ['queued-user'],
			error: 'Failed',
			failedAt: -1,
		},
		{
			id: 'failure',
			assistantId: 'queue-answer',
			messageIds: ['queued-user'],
			error: 'Failed',
			failedAt: 10,
			attachments: [],
		},
	])('rejects invalid or uncommitted failure references: %j', (record) => {
		const state = initialState(),
			source = thread();
		source.connectionId = state.activeConnectionId;
		state.threads = [{ ...source, codeQueueFailures: [record] as CodeQueueFailure[] }];
		expect(() => validateState(state)).toThrow('Workspace data is invalid');
	});

	it('rejects malformed delivery markers and duplicate failure IDs across records', () => {
		const state = initialState(),
			source = thread();
		source.connectionId = state.activeConnectionId;
		state.threads = [source];
		for (const delivery of [
			{ assistantId: 'queue-answer', messageIds: ['queued-user'], startedAt: -1 },
			{ assistantId: 'missing', messageIds: ['queued-user'], startedAt: 6 },
			{ assistantId: 'queue-answer', messageIds: ['queued-user'], startedAt: 6, attachments: [] },
		])
			expect(() =>
				validateState({ ...state, threads: [{ ...source, codeQueueDelivery: delivery }] }),
			).toThrow();
		expect(() =>
			validateState({
				...state,
				threads: [{ ...source, codeQueueFailures: [failure(source), failure(source)] }],
			}),
		).toThrow();
		expect(() =>
			validateState({
				...state,
				threads: [{ ...source, kind: 'chat', codeQueueFailures: [failure(source)] }],
			}),
		).toThrow();
	});
});
