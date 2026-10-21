import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { InstanceClient } from '../../electron/instance-client';
import { InstanceHost } from '../../electron/instance-host';
import { WorkspaceAuthority } from '../../electron/workspace-authority';
import { StateStore } from '../../electron/state-store';
import { initialState } from '../../src/lib/state';
import { defaultToolSettings } from '../../src/lib/tool-settings';
import { createComposerMention } from '../../src/lib/composer-mention-codec';
import type { ComposerDiscoveryRequest } from '../../src/composer-types';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const task of cleanup.splice(0).reverse()) await task();
});
const TOKEN = 'composer-test-pairing-token';
const request: ComposerDiscoveryRequest = {
	workspaceId: 'remote-client-workspace',
	conversationKind: 'code',
	threadId: 'task',
	projectId: 'project',
	kind: 'files',
	query: 'report',
};
async function paired(url: string) {
	const { client } = await InstanceClient.connect({
		name: 'Remote host',
		transport: 'direct',
		url,
		token: TOKEN,
	});
	cleanup.push(async () => client.disconnect());
	return client;
}
async function fixture() {
	const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'freelm-remote-composer-')));
	cleanup.push(() => rm(directory, { force: true, recursive: true }));
	const root = path.join(directory, 'host-workspace');
	await mkdir(root);
	await writeFile(path.join(root, 'report.md'), 'HOST CONTENT THAT MUST NOT BE READ');
	const state = initialState();
	state.projects = [
		{
			id: 'project',
			kind: 'code',
			name: 'Host project',
			directories: [root],
			instructions: '',
			createdAt: 1,
		},
	];
	state.threads = [
		{
			id: 'task',
			kind: 'code',
			projectId: 'project',
			title: 'Task',
			connectionId: state.connections[0].id,
			model: 'model',
			createdAt: 1,
			updatedAt: 1,
			messages: [],
		},
		{
			id: 'chat',
			kind: 'chat',
			title: 'Chat',
			connectionId: state.connections[0].id,
			model: 'model',
			createdAt: 1,
			updatedAt: 1,
			messages: [],
		},
	];
	state.toolSettings = {
		...defaultToolSettings(),
		enabled: true,
		allowRemote: true,
		workspaceRoot: '/client-path-must-not-be-used',
	};
	const store = new StateStore(path.join(directory, 'state.json'), {
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
		name: 'Remote host',
		instanceId: 'composer-host',
		token: TOKEN,
		port: 0,
	});
	const port = await host.start();
	cleanup.push(() => host.stop());
	const url = `http://127.0.0.1:${port}`;
	const client = await paired(url);
	return { root, authority, client, url, store };
}
async function fakeHost(handler: (request: IncomingMessage, response: ServerResponse) => void) {
	const server = createServer(handler);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
	return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe('remote composer context', () => {
	it('negotiates discovery and resolution on the host and revalidates saved active message references', async () => {
		const { root, authority, client, store } = await fixture();
		expect((await client.load()).composerContextSupported).toBe(true);
		const result = await client.composerDiscover(request);
		expect(result.items).toHaveLength(1);
		expect(result.items[0].path).toBe(path.join(root, 'report.md'));
		expect(JSON.stringify(result)).not.toContain('HOST CONTENT');
		const mention = createComposerMention(result.items[0]);
		const snapshot = await authority.load();
		snapshot.state!.threads[0].messages.push({
			id: 'user',
			role: 'user',
			content: `Read ${mention.token}`,
			composer: { references: [mention] },
			createdAt: 1,
		});
		await authority.save(snapshot.state!, snapshot.revision);
		const resolved = await client.composerResolve('task', 'user');
		expect(resolved.instructions).toContain(root);
		expect(resolved.instructions).not.toContain('HOST CONTENT');
		expect(await store.load()).not.toHaveProperty('composerContextSupported');
		await rm(path.join(root, 'report.md'));
		await expect(client.composerResolve('task', 'user')).rejects.toThrow();
	});
	it('does not route unsupported hosts or execute a client-local fallback', async () => {
		let requests = 0;
		const url = await fakeHost((request, response) => {
			response.setHeader('Content-Type', 'application/json');
			if (request.url === '/info')
				return response.end(
					JSON.stringify({ protocol: 1, instanceId: 'old-host', name: 'Old host' }),
				);
			requests++;
			response.end('{}');
		});
		const client = await paired(url);
		await expect(client.composerDiscover(request)).rejects.toThrow(
			'Update FreeLM on the remote computer',
		);
		await expect(client.composerResolve('task', 'user')).rejects.toThrow(
			'Update FreeLM on the remote computer',
		);
		expect(requests).toBe(0);
	});
	it('requires host-enabled remote context and rejects Chat and arbitrary directory requests', async () => {
		const { authority, client, url } = await fixture();
		await expect(
			client.composerDiscover({ ...request, threadId: 'chat', projectId: undefined }),
		).rejects.toThrow('only in Code');
		const forged = await fetch(`${url}/composer/discover`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ ...request, workspaceId: 'local', roots: ['/outside'] }),
		});
		expect(forged.ok).toBe(false);
		const unauthorized = await fetch(`${url}/composer/discover`, {
			method: 'POST',
			headers: { Authorization: 'Bearer wrong', 'Content-Type': 'application/json' },
			body: JSON.stringify({ ...request, workspaceId: 'local' }),
		});
		expect(unauthorized.status).toBe(401);
		const snapshot = await authority.load();
		snapshot.state!.toolSettings!.allowRemote = false;
		await authority.save(snapshot.state!, snapshot.revision);
		await expect(client.composerDiscover(request)).rejects.toThrow('Enable remote Code tools');
	});
	it('validates remote metadata instead of trusting malformed paths and oversized suggestions', async () => {
		let value: unknown = {
			items: [{ kind: 'file', id: 'id', label: 'file', path: 'relative.txt' }],
		};
		const url = await fakeHost((request, response) => {
			response.setHeader('Content-Type', 'application/json');
			if (request.url === '/info')
				return response.end(
					JSON.stringify({
						protocol: 1,
						instanceId: 'guard-host',
						name: 'Guard',
						composerContext: 1,
					}),
				);
			response.end(JSON.stringify(value));
		});
		const client = await paired(url);
		await expect(client.composerDiscover(request)).rejects.toThrow('invalid composer suggestions');
		value = {
			items: Array.from({ length: 31 }, (_, index) => ({
				kind: 'file',
				id: `id-${index}`,
				label: 'file',
				path: '/file',
			})),
		};
		await expect(client.composerDiscover(request)).rejects.toThrow('invalid composer suggestions');
		value = { instructions: 42 };
		await expect(client.composerResolve('task', 'user')).rejects.toThrow(
			'invalid composer context',
		);
	});
});
