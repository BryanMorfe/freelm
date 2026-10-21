import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InstanceClient } from '../../electron/instance-client';
import { InstanceHost } from '../../electron/instance-host';
import { StateStore } from '../../electron/state-store';
import { WorkspaceAuthority } from '../../electron/workspace-authority';
import { initialState } from '../../src/lib/state';
import { defaultToolSettings } from '../../src/lib/tool-settings';
import type { CodeSurfaceRequest } from '../../src/code-surface-types';

const TOKEN = 'code-surface-test-token';
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
	for (const operation of cleanup.splice(0).reverse()) await operation();
});
const request = (
	action: CodeSurfaceRequest['action'],
	extra: Partial<CodeSurfaceRequest> = {},
): CodeSurfaceRequest => ({ workspaceId: 'remote-host', threadId: 'task', action, ...extra });
async function fixture() {
	const root = await realpath(await mkdtemp(path.join(tmpdir(), 'freelm-remote-surface-')));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const filename = path.join(root, 'report.md');
	await writeFile(filename, '# Original\n');
	const state = initialState();
	state.toolSettings = { ...defaultToolSettings(), allowRemote: true };
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
	state.threads = [
		{
			id: 'task',
			kind: 'code',
			projectId: 'project',
			title: 'Task',
			connectionId: state.connections[0].id,
			model: 'test',
			createdAt: 1,
			updatedAt: 1,
			messages: [],
		},
	];
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
		name: 'Surface host',
		instanceId: 'surface-host',
		token: TOKEN,
		port: 0,
	});
	const port = await host.start();
	cleanup.push(() => host.stop());
	const url = `http://127.0.0.1:${port}`;
	const { client, info } = await InstanceClient.connect({
		name: 'Surface host',
		transport: 'direct',
		url,
		token: TOKEN,
	});
	cleanup.push(() => client.disconnect());
	return { root, filename, state, store, authority, host, url, client, info };
}
async function fakeHost(capability: boolean, response: () => unknown) {
	let calls = 0;
	const server = createServer((req, res) => {
		res.setHeader('Content-Type', 'application/json');
		if (req.url === '/info')
			res.end(
				JSON.stringify({
					protocol: 1,
					instanceId: 'fake',
					name: 'Fake',
					...(capability ? { codeSurface: 1 } : {}),
				}),
			);
		else {
			calls++;
			res.end(JSON.stringify(response()));
		}
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	cleanup.push(
		() =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			}),
	);
	const { client } = await InstanceClient.connect({
		name: 'Fake',
		transport: 'direct',
		url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
		token: TOKEN,
	});
	cleanup.push(() => client.disconnect());
	return { client, calls: () => calls };
}

describe('remote Code surface', () => {
	it('transports scoped HTML and local assets without trusting a peer-issued preview URL', async () => {
		const { client, root } = await fixture();
		const filename = path.join(root, 'index.html');
		await writeFile(filename, '<script src="app.js"></script><h1>Remote preview</h1>');
		await writeFile(path.join(root, 'app.js'), 'globalThis.ready=true;');
		const preview = await client.codeSurface(request('preview', { path: filename }));
		expect(preview.kind).toBe('preview');
		if (preview.kind !== 'preview') return;
		expect(preview.html).toContain('data:text/javascript;base64,');
		expect(preview.url).toBeUndefined();
		expect(preview.notices).toEqual([]);
	});
	it('negotiates capability and lists, reads and explicitly saves host-scoped files', async () => {
		const { root, filename, client, info, store } = await fixture();
		expect(info.codeSurface).toBe(1);
		expect((await client.load()).codeSurfaceSupported).toBe(true);
		expect(await client.codeSurface(request('list'))).toMatchObject({
			kind: 'list',
			roots: [{ path: root }],
		});
		const read = await client.codeSurface(request('read', { path: filename }));
		expect(read).toMatchObject({ kind: 'file', content: '# Original\n' });
		if (read.kind !== 'file') throw new Error();
		expect(
			await client.codeSurface(
				request('write', { path: filename, content: '# Updated\n', revision: read.revision }),
			),
		).toMatchObject({ kind: 'saved', path: filename });
		expect(await readFile(filename, 'utf8')).toBe('# Updated\n');
		await expect(
			client.codeSurface(
				request('write', { path: filename, content: 'stale', revision: read.revision }),
			),
		).rejects.toThrow('FILE_CONFLICT');
		expect(await store.load()).not.toHaveProperty('codeSurfaceSupported');
		client.disconnect();
		await expect(client.codeSurface(request('list'))).rejects.toThrow('disconnected');
	});
	it('supports new tasks by project but enforces remote permissions and rejects unknown task roots', async () => {
		const { client, filename, authority, state } = await fixture();
		expect(
			await client.codeSurface({
				workspaceId: 'remote-host',
				projectId: 'project',
				action: 'read',
				path: filename,
			}),
		).toMatchObject({ content: '# Original\n' });
		await expect(
			client.codeSurface(request('read', { threadId: 'missing', path: filename })),
		).rejects.toThrow('no longer exists');
		await expect(client.codeSurface(request('read', { path: '/etc/passwd' }))).rejects.toThrow(
			'outside',
		);
		state.toolSettings!.allowRemote = false;
		const snapshot = await authority.load();
		await authority.save(state, snapshot.revision);
		await expect(client.codeSurface(request('read', { path: filename }))).rejects.toThrow(
			'Enable remote Code',
		);
	});
	it('requires pairing authentication and host-local route identity', async () => {
		const { url } = await fixture();
		const send = (body: unknown, token?: string) =>
			fetch(`${url}/code-surface`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(token ? { Authorization: `Bearer ${token}` } : {}),
				},
				body: JSON.stringify(body),
			});
		expect((await send({ workspaceId: 'local', threadId: 'task', action: 'list' })).status).toBe(
			401,
		);
		expect((await send(request('list'), TOKEN)).status).toBe(400);
	});
	it('gives an explicit update error for old hosts without sending unsupported requests', async () => {
		const { client, calls } = await fakeHost(false, () => ({}));
		await expect(client.codeSurface(request('list'))).rejects.toThrow('Update FreeLM');
		expect(calls()).toBe(0);
	});
	it('rejects executable or remote image preview data supplied by a peer', async () => {
		const { client } = await fakeHost(true, () => ({
			kind: 'file',
			path: '/workspace/image.png',
			name: 'image.png',
			revision: 'a'.repeat(64),
			size: 3,
			editable: false,
			truncated: false,
			image: { mimeType: 'image/png', dataUrl: 'https://example.test/tracker.png' },
		}));
		await expect(
			client.codeSurface(request('read', { path: '/workspace/image.png' })),
		).rejects.toThrow('invalid Code surface data');
	});
});
