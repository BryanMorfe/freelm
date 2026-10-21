import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StateStore } from '../../electron/state-store';
import { WorkspaceAuthority } from '../../electron/workspace-authority';
import { HostTaskService } from '../../electron/host-task-service';
import { AgentHost } from '../../electron/agent-host';
import { InstanceHost } from '../../electron/instance-host';
import { initialState } from '../../src/lib/state';
import { defaultToolSettings } from '../../src/lib/tool-settings';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(allowRemote = true) {
	const folder = await mkdtemp(path.join(tmpdir(), 'freelm-remote-task-owner-'));
	cleanups.push(() => rm(folder, { recursive: true, force: true }));
	const store = new StateStore(path.join(folder, 'workspace.json'), {
		available: () => false,
		encrypt: () => Buffer.from(''),
		decrypt: () => '',
	});
	const authority = new WorkspaceAuthority(store);
	const state = initialState();
	state.toolSettings = {
		...defaultToolSettings(),
		enabled: true,
		allowRemote,
		workspaceRoot: folder,
	};
	state.threads = [
		{
			id: 'task',
			kind: 'code',
			title: 'Remote task',
			connectionId: state.connections[0].id,
			model: 'fixture',
			createdAt: 1,
			updatedAt: 1,
			messages: [
				{ id: 'answer', role: 'assistant', phase: 'working', content: 'Working', createdAt: 1 },
			],
		},
	];
	await authority.save(state, (await authority.load()).revision);
	const agent = new AgentHost(
		() => authority.loadToolState(),
		async () => true,
	);
	const request = vi.fn(async () => {
		throw new Error('No provider request expected.');
	});
	const tasks = new HostTaskService({ authority, agent, hostId: () => 'fixture', request });
	await tasks.ready;
	// Startup recovery is intentionally complete before simulating a newly streaming remote answer.
	await authority.mutate((current) => ({
		state: {
			...current,
			threads: current.threads.map((thread) => ({
				...thread,
				messages: thread.messages.map((message) => ({ ...message, interrupted: undefined })),
			})),
		},
		value: undefined,
	}));
	cleanups.push(() => tasks.close());
	const host = new InstanceHost({
		authority,
		agent,
		botTasks: tasks,
		instanceId: 'fixture',
		name: 'Fixture',
		token: 'fixture-token',
		port: 0,
	});
	const port = await host.start();
	cleanups.push(() => host.stop());
	const send = (action: string, data: object) =>
		fetch(`http://127.0.0.1:${port}/tools/${action}`, {
			method: 'POST',
			headers: { Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json' },
			body: JSON.stringify(data),
		});
	return { host, tasks, authority, request, send };
}
describe('remote task ownership', () => {
	it('keeps remote ownership through tool cancellation until the final response is durably saved', async () => {
		const f = await fixture();
		expect(
			(await f.send('catalog', { runId: 'client', threadId: 'task', claimTask: true })).status,
		).toBe(200);
		expect(f.tasks.snapshot().runs).toEqual([
			expect.objectContaining({ threadId: 'task', owner: 'remote' }),
		]);
		expect(await f.tasks.dispatch('task')).toEqual({ status: 'queued' });
		await f.tasks.rendererClosed();
		expect((await f.tasks.statuses(['task'])).task).toBe('working');
		expect((await f.send('cancel', { runId: 'client' })).status).toBe(200);
		expect((await f.send('release', { runId: 'client' })).status).toBe(400);
		expect((await f.tasks.statuses(['task'])).task).toBe('working');
		await f.authority.mutate((state) => ({
			state: {
				...state,
				threads: state.threads.map((thread) => ({
					...thread,
					messages: thread.messages.map((message) => ({ ...message, completedAt: Date.now() })),
				})),
			},
			value: undefined,
		}));
		expect((await f.send('release', { runId: 'client' })).status).toBe(200);
		expect(f.tasks.snapshot().runs).toEqual([]);
		expect((await f.tasks.statuses(['task'])).task).toBe('completed');
		expect(f.request).not.toHaveBeenCalled();
	});
	it('rejects competing clients and preserves the host remote-permission gate', async () => {
		const f = await fixture(false);
		expect(f.tasks.claimRenderer('task', 'local')).toBe(true);
		expect(
			(await f.send('catalog', { runId: 'remote', threadId: 'task', claimTask: true })).status,
		).toBe(409);
		await f.tasks.rendererClosed();
		const denied = await f.send('catalog', { runId: 'remote', threadId: 'task', claimTask: true });
		expect(denied.status).toBe(400);
		expect((await denied.json()).error).toContain('has not enabled tools');
		expect(f.tasks.snapshot().runs).toEqual([]);
	});
	it('catalog previews take no task lease and server shutdown interrupts remote work', async () => {
		const f = await fixture();
		expect((await f.send('catalog', { runId: 'preview', threadId: 'task' })).status).toBe(200);
		expect(f.tasks.snapshot().runs).toEqual([]);
		await f.send('cancel', { runId: 'preview' });
		expect(
			(await f.send('catalog', { runId: 'remote', threadId: 'task', claimTask: true })).status,
		).toBe(200);
		await f.host.stop();
		expect((await f.tasks.statuses(['task'])).task).toBe('error');
		expect((await f.authority.load()).state!.threads[0].messages.at(-1)?.interrupted).toBe(true);
	});
});
