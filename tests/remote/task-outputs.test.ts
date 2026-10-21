import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InstanceHost } from '../../electron/instance-host';
import { InstanceClient } from '../../electron/instance-client';
import { StateStore } from '../../electron/state-store';
import { WorkspaceAuthority } from '../../electron/workspace-authority';
import { initialState } from '../../src/lib/state';
import { collectTaskOutputs } from '../../src/lib/task-outputs';
import type { Thread } from '../../src/types';

const TOKEN = 'task-output-pairing-token';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const task of cleanup.splice(0).reverse()) await task();
});
async function directory() {
	const root = await realpath(await mkdtemp(path.join(tmpdir(), 'freelm-remote-output-')));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	return root;
}
async function fixture() {
	const root = await directory();
	const filename = path.join(root, 'report.md');
	await writeFile(filename, '# Task report\nCompleted.');
	const state = initialState();
	state.connections[0].apiKey = 'provider-secret';
	state.projects = [
		{
			id: 'project',
			kind: 'code',
			directories: [root],
			name: 'Code',
			instructions: '',
			createdAt: 1,
		},
	];
	const task: Thread = {
		id: 'task',
		kind: 'code',
		projectId: 'project',
		title: 'Task',
		connectionId: state.connections[0].id,
		model: 'test',
		createdAt: 1,
		updatedAt: 2,
		messages: [
			{
				id: 'reply',
				role: 'assistant',
				content: 'Created a report.',
				createdAt: 1,
				toolCalls: [
					{
						id: 'created',
						name: 'exec_command',
						arguments: '{}',
						status: 'completed',
						startedAt: 1,
						completedAt: 2,
						result: { content: [], outputFiles: [{ kind: 'add', path: filename }] },
					},
				],
			},
		],
	};
	state.threads = [task, { ...task, id: 'chat', kind: 'chat', projectId: undefined, messages: [] }];
	const store = new StateStore(path.join(root, 'workspace.json'), {
		available: () => false,
		encrypt: () => {
			throw new Error('disabled');
		},
		decrypt: () => {
			throw new Error('disabled');
		},
	});
	await store.save(state);
	const authority = new WorkspaceAuthority(store);
	const host = new InstanceHost({
		authority,
		name: 'Output host',
		instanceId: 'output-host',
		token: TOKEN,
		port: 0,
	});
	const port = await host.start();
	cleanup.push(() => host.stop());
	const url = `http://127.0.0.1:${port}`;
	const id = collectTaskOutputs(task, { workspaceRoot: root }).items[0].id;
	const send = (body: unknown, headers: Record<string, string> = {}) =>
		fetch(url + '/task-output', {
			method: 'POST',
			headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...headers },
			body: JSON.stringify(body),
		});
	return { root, filename, task, state, store, authority, host, url, id, send };
}
async function paired(url: string) {
	const { client } = await InstanceClient.connect({
		name: 'Output host',
		transport: 'direct',
		url,
		token: TOKEN,
	});
	cleanup.push(async () => client.disconnect());
	return client;
}
async function fakeHost(
	handler: (
		request: import('node:http').IncomingMessage,
		response: import('node:http').ServerResponse,
	) => void,
) {
	const server = createServer(handler);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	cleanup.push(
		() =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			}),
	);
	return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe('authenticated remote task Outputs', () => {
	it('negotiates metadata support and refreshes existence on the host without exposing contents', async () => {
		const host = await fixture();
		const client = await paired(host.url);
		expect((await client.load()).taskOutputStatusSupported).toBe(true);
		const status = await client.taskOutputStatus('task');
		expect(status).toMatchObject({
			threadId: 'task',
			files: [{ id: host.id, exists: true, canonicalPath: host.filename }],
			notices: [],
			truncated: false,
			checkedAt: expect.any(Number),
		});
		expect(JSON.stringify(status)).not.toContain('provider-secret');
		expect(JSON.stringify(status)).not.toContain('# Task report');
		expect(await host.store.load()).not.toHaveProperty('taskOutputStatusSupported');
		await rm(host.filename);
		expect((await client.taskOutputStatus('task')).files[0].exists).toBe(false);
		client.disconnect();
		await expect(client.taskOutputStatus('task')).rejects.toThrow('disconnected');
	});

	it('protects metadata checks with authentication and accepts only selected task identifiers', async () => {
		const host = await fixture();
		const send = (body: unknown, headers: Record<string, string> = {}) =>
			fetch(host.url + '/task-output-status', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${TOKEN}`,
					'Content-Type': 'application/json',
					...headers,
				},
				body: JSON.stringify(body),
			});
		expect((await send({ threadId: 'task' }, { Authorization: '' })).status).toBe(401);
		expect((await send({ threadId: 'task' }, { Origin: 'https://example.test' })).status).toBe(403);
		for (const body of [
			{ threadId: 'task', path: '/etc/passwd' },
			{ threadId: 'task', outputId: host.id },
			{ threadId: 'missing' },
			{ threadId: 'chat' },
			{ threadId: 'bad\n' },
			{},
		])
			expect((await send(body)).status).toBe(400);
	});

	it('never issues a status request or falls back locally when an older host lacks metadata support', async () => {
		let requests = 0;
		const url = await fakeHost((request, response) => {
			response.setHeader('Content-Type', 'application/json');
			if (request.url === '/info')
				response.end(
					JSON.stringify({
						protocol: 1,
						instanceId: 'legacy-output',
						name: 'Legacy',
						taskOutputs: true,
					}),
				);
			else if (request.url === '/workspace')
				response.end(JSON.stringify({ state: null, revision: 'legacy:1' }));
			else {
				requests++;
				response.end('{}');
			}
		});
		const client = await paired(url);
		expect((await client.load()).taskOutputStatusSupported).toBe(false);
		await expect(client.taskOutputStatus('task')).rejects.toThrow(
			'Update FreeLM on the remote computer',
		);
		expect(requests).toBe(0);
	});

	it('rejects malformed, oversized and failed remote metadata without trusting unverified existence', async () => {
		let body: unknown;
		let failure = false;
		let oversized = false;
		let requests = 0;
		const url = await fakeHost((request, response) => {
			response.setHeader('Content-Type', 'application/json');
			if (request.url === '/info')
				return response.end(
					JSON.stringify({
						protocol: 1,
						instanceId: 'status-guard',
						name: 'Guard',
						taskOutputStatus: true,
					}),
				);
			requests++;
			if (failure) {
				response.statusCode = 500;
				return response.end(JSON.stringify({ error: 'host verification failed' }));
			}
			if (oversized) response.setHeader('Content-Length', String(24 * 1024 * 1024 + 1));
			response.end(JSON.stringify(body));
		});
		const client = await paired(url);
		const valid = {
			threadId: 'task',
			files: [
				{
					id: 'recorded',
					exists: true,
					canonicalPath: '/project/output.txt',
					identity: 'inode:1:2',
				},
			],
			notices: [],
			truncated: false,
			checkedAt: 1,
		};
		for (const invalid of [
			{ ...valid, threadId: 'wrong-task' },
			{ ...valid, files: [...valid.files, ...valid.files] },
			{ ...valid, files: [{ id: 'recorded', exists: 'true' }] },
			{ ...valid, files: [{ ...valid.files[0], canonicalPath: 'file:///private.txt' }] },
			{ ...valid, files: [{ ...valid.files[0], identity: undefined }] },
			{ ...valid, files: [{ ...valid.files[0], text: 'unrequested contents' }] },
			{
				...valid,
				files: Array.from({ length: 1025 }, (_item, index) => ({
					id: String(index),
					exists: false,
				})),
			},
		]) {
			body = invalid;
			await expect(client.taskOutputStatus('task')).rejects.toThrow(
				'invalid task output status data',
			);
		}
		body = valid;
		expect(await client.taskOutputStatus('task')).toEqual(valid);
		oversized = true;
		await expect(client.taskOutputStatus('task')).rejects.toThrow('too large');
		oversized = false;
		failure = true;
		await expect(client.taskOutputStatus('task')).rejects.toThrow('host verification failed');
		expect(requests).toBe(10);
	});

	it('negotiates support, routes the selected task file through its host, and never returns provider secrets', async () => {
		const host = await fixture();
		const client = await paired(host.url);
		expect((await client.load()).taskOutputsSupported).toBe(true);
		const result = await client.taskOutputRead('task', host.id);
		expect(result).toMatchObject({
			id: host.id,
			path: host.filename,
			name: 'report.md',
			preview: { kind: 'text', text: '# Task report\nCompleted.' },
		});
		expect(result.downloadUrl).toMatch(/^data:application\/octet-stream;base64,/);
		expect(JSON.stringify(result)).not.toContain('provider-secret');
		expect(await host.store.load()).not.toHaveProperty('taskOutputsSupported');
		client.disconnect();
		await expect(client.taskOutputRead('task', host.id)).rejects.toThrow('disconnected');
	});

	it('requires authentication, rejects browser origins and caller paths, and isolates task identities', async () => {
		const host = await fixture();
		const body = { threadId: 'task', outputId: host.id };
		expect((await host.send(body, { Authorization: '' })).status).toBe(401);
		expect((await host.send(body, { Origin: 'https://example.test' })).status).toBe(403);
		expect((await host.send({ ...body, path: '/etc/passwd' })).status).toBe(400);
		expect((await host.send({ ...body, threadId: 'chat' })).status).toBe(400);
		expect((await host.send({ ...body, threadId: 'missing' })).status).toBe(400);
		const spoof = await host.send({
			...body,
			outputId: host.id.replace('report.md', 'workspace.json'),
		});
		expect(spoof.status).toBe(400);
		expect((await spoof.json()).error).toContain('not a recorded output');
		expect((await host.send({ ...body, outputId: 'x'.repeat(8193) })).status).toBe(400);
	});

	it('returns an unavailable explanation for forged outside-root metadata and preserves its recorded path', async () => {
		const host = await fixture();
		const outside = await directory();
		const filename = path.join(outside, 'private.txt');
		await writeFile(filename, 'must not be exposed');
		const snapshot = await host.authority.load(true);
		const task = snapshot.state!.threads.find((item) => item.id === 'task')!;
		task.messages[0].toolCalls![0].result!.outputFiles = [{ kind: 'add', path: filename }];
		await host.authority.save(snapshot.state!, snapshot.revision, true);
		const id = collectTaskOutputs(task, { workspaceRoot: host.root }).items[0].id;
		const result = await (await paired(host.url)).taskOutputRead('task', id);
		expect(result).toMatchObject({
			path: filename,
			unavailable: expect.stringContaining('outside'),
		});
		expect(result.downloadUrl).toBeUndefined();
		expect(result.preview).toBeUndefined();
		expect(JSON.stringify(result)).not.toContain('must not be exposed');
	});

	it('fails clearly before issuing a file request on older remote hosts', async () => {
		let outputRequests = 0;
		const url = await fakeHost((request, response) => {
			response.setHeader('Content-Type', 'application/json');
			if (request.url === '/info')
				response.end(JSON.stringify({ protocol: 1, instanceId: 'legacy', name: 'Legacy' }));
			else if (request.url === '/workspace')
				response.end(JSON.stringify({ state: null, revision: 'legacy:1' }));
			else {
				outputRequests++;
				response.end('{}');
			}
		});
		const client = await paired(url);
		expect((await client.load()).taskOutputsSupported).toBe(false);
		await expect(client.taskOutputRead('task', 'local:task:created:/some/path')).rejects.toThrow(
			'Update FreeLM on the remote computer',
		);
		expect(outputRequests).toBe(0);
	});

	it('rejects unsafe remote preview/download URLs and bounds the new endpoint response', async () => {
		let mode: 'url' | 'size' = 'url';
		const id = 'local:task:created:/project/output.txt';
		const url = await fakeHost((request, response) => {
			response.setHeader('Content-Type', 'application/json');
			if (request.url === '/info')
				return response.end(
					JSON.stringify({ protocol: 1, instanceId: 'guard', name: 'Guard', taskOutputs: true }),
				);
			if (mode === 'size') {
				response.setHeader('Content-Length', String(24 * 1024 * 1024 + 1));
				return response.end('{}');
			}
			response.end(
				JSON.stringify({
					id,
					name: 'output.txt',
					path: '/project/output.txt',
					downloadUrl: 'file:///etc/passwd',
					preview: { kind: 'image', dataUrl: 'https://example.test/tracker.png' },
				}),
			);
		});
		const client = await paired(url);
		await expect(client.taskOutputRead('task', id)).rejects.toThrow('invalid task output data');
		mode = 'size';
		await expect(client.taskOutputRead('task', id)).rejects.toThrow('too large');
	});
});
