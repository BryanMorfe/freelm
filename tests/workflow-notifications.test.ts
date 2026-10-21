import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WorkflowThreadNotifications } from '../electron/workflows/notifications';
import type { WorkflowRun } from '../src/workflow-types';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});
const run = (overrides: Partial<WorkflowRun> = {}): WorkflowRun & { outputNames: string[] } => ({
	id: 'run-one',
	workflowId: 'research',
	workflowName: 'Research',
	status: 'completed',
	workflowSnapshot: {
		version: 1,
		id: 'research',
		name: 'Research',
		enabled: false,
		nodes: [],
		edges: [],
		createdAt: 1,
		updatedAt: 1,
	},
	nodes: {},
	inputs: { goal: 'Question' },
	trigger: { kind: 'manual' },
	createdAt: 1,
	finishedAt: 2,
	projectId: 'novis',
	sourceThreadId: 'code-thread',
	outputs: { report: 'large output is read through a tool' },
	outputNames: ['report'],
	...overrides,
});
async function fixture(
	overrides: Partial<ConstructorParameters<typeof WorkflowThreadNotifications>[0]> = {},
) {
	const root = await mkdtemp(path.join(os.tmpdir(), 'freelm-workflow-notifications-'));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const options = {
		filename: path.join(root, 'receipts.json'),
		runs: () => [run()],
		threads: async () => [{ id: 'code-thread', kind: 'code', projectId: 'novis' }],
		ready: () => true,
		deliver: vi.fn(async () => ({ promptSaved: true, delivery: { status: 'queued' } })),
		...overrides,
	};
	const service = new WorkflowThreadNotifications(options);
	await service.init();
	cleanups.push(() => service.close());
	return { service, options };
}
it('delivers a bounded completion once, preserving the receipt across restart', async () => {
	const { service, options } = await fixture();
	await Promise.all([service.flush(), service.flush()]);
	expect(options.deliver).toHaveBeenCalledTimes(1);
	const [thread, prompt, operation] = vi.mocked(options.deliver).mock.calls[0];
	expect(thread).toBe('code-thread');
	expect(prompt).toContain('workflows.read_run');
	expect(prompt).toContain('run-one');
	expect(prompt).not.toContain('large output');
	expect(operation).toMatch(/^workflow-completion-[a-f0-9]{64}$/);
	await service.close();
	const restarted = new WorkflowThreadNotifications(options);
	await restarted.init();
	await restarted.flush();
	expect(options.deliver).toHaveBeenCalledTimes(1);
	await restarted.close();
});
it('retries a saved-but-undeliverable completion with the same durable queue identity', async () => {
	let calls = 0;
	const deliver = vi.fn(async () => ({
		promptSaved: true,
		delivery: { status: ++calls === 1 ? 'unavailable' : 'started' },
	}));
	const { service } = await fixture({ deliver });
	await service.flush();
	await service.flush();
	expect(deliver).toHaveBeenCalledTimes(2);
	expect(deliver.mock.calls[0]).toEqual(deliver.mock.calls[1]);
	await service.flush();
	expect(deliver).toHaveBeenCalledTimes(2);
});
it('does not deliver to another project, archived threads, or Chat, and ignores child runs', async () => {
	const { service, options } = await fixture({
		runs: () => [
			run({ projectId: 'other' }),
			run({ id: 'child', parentRunId: 'parent' }),
			run({ id: 'archived-run', sourceThreadId: 'archived' }),
			run({ id: 'chat-run', sourceThreadId: 'chat' }),
			run({ id: 'active', status: 'running' }),
		],
		threads: async () => [
			{ id: 'code-thread', kind: 'code', projectId: 'novis' },
			{ id: 'archived', kind: 'code', projectId: 'novis', archivedAt: 1 },
			{ id: 'chat', kind: 'chat', projectId: 'novis' },
		],
	});
	await service.flush();
	expect(options.deliver).not.toHaveBeenCalled();
});
it('retains pending completions while the local renderer is unavailable', async () => {
	let ready = false;
	const { service, options } = await fixture({ ready: () => ready });
	await service.flush();
	expect(options.deliver).not.toHaveBeenCalled();
	ready = true;
	await service.flush();
	expect(options.deliver).toHaveBeenCalledOnce();
});
