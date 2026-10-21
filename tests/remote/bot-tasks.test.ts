import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RendererTaskBridge } from '../../electron/bot-task-service';
import { InstanceHost } from '../../electron/instance-host';
import { InstanceClient } from '../../electron/instance-client';
import { InstanceManager } from '../../electron/instance-manager';
import { StateStore, type SecretStorage } from '../../electron/state-store';
import { WorkspaceAuthority } from '../../electron/workspace-authority';
import { initialState } from '../../src/lib/state';
import { defaultToolSettings } from '../../src/lib/tool-settings';
import type { BotTaskRequest } from '../../src/bot-task-types';
import type { AppState } from '../../src/types';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const token = 'bot-task-fixture-token';
const secrets: SecretStorage = {
	available: () => true,
	encrypt: (value) => Buffer.from(value),
	decrypt: (value) => value.toString(),
};
type Handler = (request: BotTaskRequest, signal: AbortSignal) => unknown | Promise<unknown>;
const task = (changes: Partial<BotTaskRequest> = {}): BotTaskRequest => ({
	id: 'http-delivery-id',
	name: 'threads_read',
	arguments: { threadId: 'same-thread' },
	operationId: 'stable-operation',
	...changes,
});

async function fixture(
	id: string,
	handler?: Handler,
	enabled = true,
	state: AppState = initialState(),
) {
	const folder = await mkdtemp(path.join(tmpdir(), 'freelm-bot-task-remote-'));
	cleanups.push(() => rm(folder, { force: true, recursive: true }));
	const store = new StateStore(path.join(folder, 'workspace.json'), secrets);
	await store.save(state);
	const authority = new WorkspaceAuthority(store);
	const delivered: BotTaskRequest[] = [];
	const cancellations: string[] = [];
	const controllers = new Map<string, AbortController>();
	const bridge = new RendererTaskBridge({
		deliver: (request) => {
			delivered.push(request);
			const controller = new AbortController();
			controllers.set(request.id, controller);
			if (handler) {
				void Promise.resolve()
					.then(() => handler(request, controller.signal))
					.then(
						(result) => bridge.settle(request.id, { ok: true, result }),
						(error: unknown) =>
							bridge.settle(request.id, {
								ok: false,
								error: error instanceof Error ? error.message : 'Fixture failure',
							}),
					);
			}
		},
		cancel: (requestId) => {
			cancellations.push(requestId);
			controllers.get(requestId)?.abort();
		},
	});
	bridge.setReady(true);
	const host = new InstanceHost({
		instanceId: id,
		name: id,
		token,
		port: 0,
		authority,
		...(enabled ? { botTasks: bridge } : {}),
	});
	const port = await host.start();
	cleanups.push(async () => {
		bridge.close();
		await host.stop();
	});
	const url = `http://127.0.0.1:${port}`;
	const { client, info } = await InstanceClient.connect({
		name: id,
		transport: 'direct',
		url,
		token,
	});
	cleanups.push(async () => client.disconnect());
	const post = (body: unknown, headers: Record<string, string> = {}) =>
		fetch(url + '/bots/task', {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
			body: JSON.stringify(body),
		});
	return {
		folder,
		authority,
		bridge,
		host,
		client,
		info,
		url,
		delivered,
		cancellations,
		controllers,
		post,
	};
}

describe('bot task tools over authenticated instance HTTP', () => {
	it.each([false, undefined])(
		'requires host remote execution opt-in for Code (allowRemote=%s) without blocking Chat or reads',
		async (allowRemote) => {
			const state = initialState();
			state.toolSettings = { ...defaultToolSettings(), enabled: true, allowRemote };
			state.threads = Array.from({ length: 35 }, (_, index) => ({
				id: `recent-chat-${index}`,
				kind: 'chat',
				title: `Chat ${index}`,
				connectionId: state.activeConnectionId,
				model: 'fixture-model',
				messages: [],
				createdAt: 100 + index,
				updatedAt: 100 + index,
			}));
			state.threads.push({
				id: 'older-code',
				kind: 'code',
				title: 'Code older than the automatic memory window',
				connectionId: state.activeConnectionId,
				model: 'fixture-model',
				messages: [],
				createdAt: 1,
				updatedAt: 1,
			});
			const remote = await fixture('policy', () => ({ accepted: true }), true, state);
			const createCode = task({
				name: 'threads_create',
				arguments: { kind: 'code', prompt: 'Run the requested task' },
			});
			const sendCode = task({
				name: 'threads_send',
				arguments: { threadId: 'older-code', prompt: 'Continue the task' },
			});
			await expect(remote.client.botTask(createCode)).rejects.toThrow(
				'Remote Code execution is disabled',
			);
			await expect(remote.client.botTask(sendCode)).rejects.toThrow(
				'Remote Code execution is disabled',
			);
			expect(remote.delivered).toHaveLength(0);
			for (const allowed of [
				task({ name: 'threads_create', arguments: { kind: 'chat', prompt: 'Discuss this idea' } }),
				task({
					name: 'threads_send',
					arguments: { threadId: 'recent-chat-0', prompt: 'Follow up' },
				}),
				task({ name: 'threads_read', arguments: { threadId: 'older-code' } }),
			])
				await expect(remote.client.botTask(allowed)).resolves.toEqual({ accepted: true });
			// Read the live host setting on every invocation; an explicit host-local change
			// permits the same Code operations without relaxing their normal task permissions.
			const snapshot = await remote.authority.load();
			snapshot.state!.toolSettings!.allowRemote = true;
			await remote.authority.save(snapshot.state!, snapshot.revision);
			await expect(remote.client.botTask(createCode)).resolves.toEqual({ accepted: true });
			await expect(remote.client.botTask(sendCode)).resolves.toEqual({ accepted: true });
			expect(remote.delivered).toHaveLength(5);
		},
	);

	it('advertises the capability and enforces authentication and browser-origin isolation', async () => {
		const remote = await fixture('remote', (request) => ({
			threadId: request.arguments.threadId,
			title: 'Remote task',
		}));
		expect(remote.info.botTasks).toBe(1);
		expect((await remote.post(task(), { Authorization: '' })).status).toBe(401);
		expect((await remote.post(task(), { Authorization: 'Bearer incorrect' })).status).toBe(401);
		expect((await remote.post(task(), { Origin: 'https://untrusted.example' })).status).toBe(403);
		expect(remote.delivered).toHaveLength(0);
		await expect(remote.client.botTask(task())).resolves.toEqual({
			threadId: 'same-thread',
			title: 'Remote task',
		});
		expect(remote.delivered).toHaveLength(1);
		expect(remote.delivered[0]).toMatchObject({
			name: 'threads_read',
			arguments: { threadId: 'same-thread' },
			operationId: 'stable-operation',
		});
		// The host owns delivery correlation rather than trusting a caller-selected request ID.
		expect(remote.delivered[0].id).not.toBe('http-delivery-id');
	});

	it('preserves UTF-8 replies beyond 65k characters and reports oversized replies', async () => {
		const content = 'A long reply 🙂\n'.repeat(8000);
		const remote = await fixture('large', (request) => ({
			content: request.arguments.oversize ? 'x'.repeat(512 * 1024) : content,
		}));
		expect(content.length).toBeGreaterThan(65_536);
		await expect(remote.client.botTask(task())).resolves.toEqual({ content });
		await expect(remote.client.botTask(task({ arguments: { oversize: true } }))).rejects.toThrow(
			'transport limit',
		);
	});

	it('rejects unknown tools, extra envelope data, host rerouting, and oversized requests before dispatch', async () => {
		const remote = await fixture('remote', () => null);
		for (const invalid of [
			{ ...task(), name: 'exec_command' },
			{ ...task(), apiKey: 'never-accepted' },
			task({ arguments: { threadId: 'same-thread', hostId: 'another-host' } }),
		]) {
			const response = await remote.post(invalid);
			expect(response.status).toBe(400);
			expect(await response.json()).toHaveProperty('error');
		}
		expect(
			(await remote.post(task({ arguments: { content: 'x'.repeat(128 * 1024) } }))).status,
		).toBe(413);
		expect(remote.delivered).toHaveLength(0);
	});

	it('propagates caller cancellation across HTTP to the registered renderer task', async () => {
		const remote = await fixture('remote');
		const controller = new AbortController();
		const pending = remote.client.botTask(task({ name: 'threads_wait' }), controller.signal);
		const rejected = expect(pending).rejects.toBeDefined();
		await vi.waitFor(() => expect(remote.delivered).toHaveLength(1));
		controller.abort();
		await rejected;
		const requestId = remote.delivered[0].id;
		await vi.waitFor(() => expect(remote.controllers.get(requestId)?.signal.aborted).toBe(true));
		expect(remote.cancellations).toEqual([requestId]);
		expect(remote.bridge.settle(requestId, { ok: true, result: 'late' })).toBe(false);
	});

	it('cancels tasks after client disconnection and host shutdown', async () => {
		const remote = await fixture('disconnect');
		const pending = remote.client.botTask(task({ name: 'threads_wait' }));
		const rejected = expect(pending).rejects.toBeDefined();
		await vi.waitFor(() => expect(remote.delivered).toHaveLength(1));
		remote.client.disconnect();
		await rejected;
		await vi.waitFor(() => expect(remote.cancellations).toEqual([remote.delivered[0].id]));
		const stopping = await fixture('shutdown');
		const waiting = stopping.client.botTask(task({ name: 'threads_wait' }));
		const stopped = expect(waiting).rejects.toBeDefined();
		await vi.waitFor(() => expect(stopping.delivered).toHaveLength(1));
		await stopping.host.stop();
		await stopped;
		await vi.waitFor(() => expect(stopping.cancellations).toEqual([stopping.delivered[0].id]));
	});

	it('returns actionable renderer-unavailable errors and refuses hosts without the capability', async () => {
		const unavailable = await fixture('unavailable', () => null);
		unavailable.bridge.setReady(false);
		await expect(unavailable.client.botTask(task())).rejects.toThrow('Open this computer');
		expect(unavailable.delivered).toHaveLength(0);
		const older = await fixture('older', () => null, false);
		expect(older.info.botTasks).toBeUndefined();
		await expect(older.client.botTask(task())).rejects.toThrow('Update FreeLM');
		expect((await older.post(task())).status).toBe(404);
		expect(older.delivered).toHaveLength(0);
	});

	it('routes identical thread IDs by host identity and never falls back to another computer', async () => {
		const remoteA = await fixture('workstation-a', (request) => ({
			threadId: request.arguments.threadId,
			title: 'Task on A',
		}));
		const remoteB = await fixture('workstation-b', (request) => ({
			threadId: request.arguments.threadId,
			title: 'Task on B',
		}));
		const local = await fixture('local-fixture', (request) => ({
			threadId: request.arguments.threadId,
			title: 'Local task',
		}));
		const manager = new InstanceManager(
			path.join(local.folder, 'instances.json'),
			secrets,
			local.authority,
		);
		cleanups.push(() => manager.close());
		manager.setBotTasks(local.bridge);
		const localHostId = (await manager.status()).host.instanceId;
		await manager.connect({ name: 'A', transport: 'direct', url: remoteA.url, token });
		const connectionB = await manager.connect({
			name: 'B',
			transport: 'direct',
			url: remoteB.url,
			token,
		});
		await expect(
			manager.botTask('threads_read', { hostId: 'workstation-a', threadId: 'same-thread' }, 'a'),
		).resolves.toEqual({
			hostId: 'workstation-a',
			result: { threadId: 'same-thread', title: 'Task on A' },
		});
		await expect(
			manager.botTask('threads_read', { hostId: 'workstation-b', threadId: 'same-thread' }, 'b'),
		).resolves.toEqual({
			hostId: 'workstation-b',
			result: { threadId: 'same-thread', title: 'Task on B' },
		});
		await expect(
			manager.botTask('threads_read', { hostId: 'local', threadId: 'same-thread' }, 'local'),
		).resolves.toEqual({
			hostId: localHostId,
			result: { threadId: 'same-thread', title: 'Local task' },
		});
		await expect(
			manager.botTask('threads_read', { hostId: 'unknown', threadId: 'same-thread' }, 'unknown'),
		).rejects.toThrow('disconnected');
		await manager.disconnect(connectionB.instance.id);
		await expect(
			manager.botTask(
				'threads_read',
				{ hostId: 'workstation-b', threadId: 'same-thread' },
				'b-again',
			),
		).rejects.toThrow('disconnected');
		for (const host of [remoteA, remoteB, local]) {
			expect(host.delivered).toHaveLength(1);
			expect(host.delivered[0].arguments).toEqual({ threadId: 'same-thread' });
		}
	});
});
