import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { createServer as createHttpServer, type Server } from 'node:http';
import { InstanceManager } from '../../electron/instance-manager';
import { InstanceHost } from '../../electron/instance-host';
import { WorkspaceAuthority } from '../../electron/workspace-authority';
import { StateStore, type SecretStorage } from '../../electron/state-store';
import type { AppState } from '../../src/types';

const folders: string[] = [],
	managers: InstanceManager[] = [],
	hosts: InstanceHost[] = [],
	servers: Server[] = [];
afterEach(async () => {
	await Promise.all(managers.splice(0).map((manager) => manager.close()));
	await Promise.all(hosts.splice(0).map((host) => host.stop()));
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.closeAllConnections();
					server.close(() => resolve());
				}),
		),
	);
	await Promise.all(
		folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
	);
});
function secrets(secure = true): SecretStorage {
	const key = randomBytes(32);
	return {
		available: () => secure,
		encrypt: (value) => {
			const iv = randomBytes(16);
			const cipher = createCipheriv('aes-256-cbc', key, iv);
			return Buffer.concat([iv, cipher.update(value), cipher.final()]);
		},
		decrypt: (value) => {
			const cipher = createDecipheriv('aes-256-cbc', key, value.subarray(0, 16));
			return Buffer.concat([cipher.update(value.subarray(16)), cipher.final()]).toString();
		},
	};
}
function state(): AppState {
	return {
		version: 1,
		theme: 'dark',
		activeConnectionId: 'provider',
		projects: [],
		threads: [],
		generations: [],
		connections: [
			{
				id: 'provider',
				name: 'Provider',
				baseUrl: 'http://localhost:9999/v1',
				apiKey: 'provider-secret-only-on-host',
				chatApi: 'responses',
				models: { chat: 'model', images: '', videos: '', speech: '', transcription: '' },
				discoveredModels: [],
			},
		],
	};
}
async function setup(secure = true) {
	const folder = await mkdtemp(path.join(os.tmpdir(), 'freelm-manager-'));
	folders.push(folder);
	const secretApi = secrets(secure);
	const authority = new WorkspaceAuthority(
		new StateStore(path.join(folder, 'workspace.json'), secretApi),
	);
	await authority.save(state(), (await authority.load()).revision);
	const manager = new InstanceManager(path.join(folder, 'instances.json'), secretApi, authority);
	managers.push(manager);
	return { folder, secretApi, authority, manager };
}
async function hosting(authority: WorkspaceAuthority) {
	const host = new InstanceHost({
		authority,
		instanceId: 'stable-host-id',
		name: 'Host',
		token: 'host-access-token',
		port: 0,
	});
	hosts.push(host);
	const port = await host.start();
	return { host, url: `http://127.0.0.1:${port}` };
}
async function port() {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const value = (server.address() as { port: number }).port;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return value;
}
async function protocolHost(authority: WorkspaceAuthority, conversationModes: unknown) {
	const snapshot = await authority.load(true);
	const routes: string[] = [];
	const server = createHttpServer((request, response) => {
		routes.push(request.url!);
		request.resume();
		response.setHeader('Content-Type', 'application/json');
		if (request.url === '/info')
			return response.end(
				JSON.stringify({
					protocol: 1,
					instanceId: 'compatibility-host',
					name: 'Host',
					conversationModes,
				}),
			);
		if (request.url === '/workspace') return response.end(JSON.stringify(snapshot));
		if (request.url === '/request')
			return response.end(
				JSON.stringify({
					type: 'response',
					response: { status: 200, contentType: 'application/json', body: '{}', encoding: 'text' },
				}) + '\n',
			);
		response.end(JSON.stringify({ accepted: true }));
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return { routes, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

describe('instance manager', () => {
	it.each([undefined, false, 'true'])(
		'blocks legacy tool catalogs and execution before contacting a host with capability %s',
		async (capability) => {
			const { authority, manager } = await setup();
			const host = await protocolHost(authority, capability);
			const { instance } = await manager.connect({
				name: 'Host',
				transport: 'direct',
				url: host.url,
				token: 'host-access-token',
			});
			for (const action of ['catalog', 'execute'] as const)
				await expect(manager.tools(instance.id, action, {})).rejects.toThrow(
					'Update FreeLM on the remote computer',
				);
			expect(host.routes.filter((route) => route.startsWith('/tools/'))).toEqual([]);
			// Cancellation and ordinary provider requests remain compatible with older hosts.
			expect(await manager.tools(instance.id, 'cancel', { requestId: 'previous-run' })).toEqual({
				accepted: true,
			});
			expect((await manager.load(instance.id)).state!.connections[0].id).toBe('provider');
			for (const path of ['/responses', '/audio/speech']) {
				const response = await manager.request(
					instance.id,
					{
						id: 'provider-request',
						connectionId: 'provider',
						baseUrl: 'http://unused',
						apiKey: '',
						path,
						method: 'POST',
						body: { model: 'model' },
					},
					() => {},
				);
				expect(response.status).toBe(200);
			}
			expect(host.routes.filter((route) => route.startsWith('/tools/'))).toEqual(['/tools/cancel']);
		},
	);
	it('forwards tool catalogs and execution after the host explicitly advertises conversation modes', async () => {
		const { authority, manager } = await setup();
		const host = await protocolHost(authority, true);
		const { instance } = await manager.connect({
			name: 'Host',
			transport: 'direct',
			url: host.url,
			token: 'host-access-token',
		});
		expect(await manager.tools(instance.id, 'catalog', { threadId: 'chat' })).toEqual({
			accepted: true,
		});
		expect(await manager.tools(instance.id, 'execute', { threadId: 'code' })).toEqual({
			accepted: true,
		});
		expect(host.routes.filter((route) => route.startsWith('/tools/'))).toEqual([
			'/tools/catalog',
			'/tools/execute',
		]);
	});
	it('encrypts saved tokens, preserves local identity, and reconnects after restart', async () => {
		const { folder, secretApi, authority, manager } = await setup();
		const host = await hosting(authority);
		const connection = await manager.connect({
			name: 'Host',
			transport: 'direct',
			url: host.url,
			token: 'host-access-token',
		});
		expect(connection.snapshot.state!.connections[0].apiKey).toBe('');
		const file = path.join(folder, 'instances.json'),
			source = await readFile(file, 'utf8');
		expect(source).not.toContain('host-access-token');
		expect(source).not.toContain('provider-secret');
		expect((await stat(file)).mode & 0o777).toBe(0o600);
		const originalId = (await manager.status()).host.instanceId;
		await manager.close();
		const second = new InstanceManager(file, secretApi, authority);
		managers.push(second);
		expect((await second.status()).host.instanceId).toBe(originalId);
		expect((await second.status()).instances[0].connected).toBe(false);
		expect((await second.open(connection.instance.id)).state!.connections[0].apiKey).toBe('');
		expect((await second.status()).instances[0].connected).toBe(true);
		await second.remove(connection.instance.id);
		expect((await second.status()).instances).toEqual([]);
	});
	it('keeps tokens in memory only when the OS secret store is unavailable', async () => {
		const { folder, secretApi, authority, manager } = await setup(false);
		const host = await hosting(authority);
		const connection = await manager.connect({
			name: 'Host',
			transport: 'direct',
			url: host.url,
			token: 'host-access-token',
		});
		await manager.disconnect(connection.instance.id);
		await manager.open(connection.instance.id);
		expect((await manager.status()).instances[0].hasToken).toBe(true);
		const file = path.join(folder, 'instances.json');
		expect(await readFile(file, 'utf8')).not.toContain('host-access-token');
		await manager.close();
		const second = new InstanceManager(file, secretApi, authority);
		managers.push(second);
		expect((await second.status()).instances[0].hasToken).toBe(false);
		await expect(second.open(connection.instance.id)).rejects.toThrow('access token');
	});
	it('saves remote projects through CAS and never replaces host credentials', async () => {
		const { authority, manager } = await setup();
		const host = await hosting(authority);
		const { instance, snapshot } = await manager.connect({
			name: 'Host',
			transport: 'direct',
			url: host.url,
			token: 'host-access-token',
		});
		const update = structuredClone(snapshot.state!);
		update.projects.push({
			id: 'remote-project',
			name: 'From client',
			instructions: '',
			createdAt: 1,
		});
		const saved = await manager.save(instance.id, snapshot.revision, update);
		expect(saved.revision).not.toBe(snapshot.revision);
		const local = await authority.load();
		expect(local.state!.projects[0].name).toBe('From client');
		expect(local.state!.connections[0].apiKey).toBe('provider-secret-only-on-host');
		update.projects[0].name = 'Divergent stale edit';
		await expect(manager.save(instance.id, snapshot.revision, update)).rejects.toThrow(
			'WORKSPACE_CONFLICT',
		);
		await manager.disconnect(instance.id);
		await expect(manager.load(instance.id)).rejects.toThrow('disconnected');
	});
	it('does not save failed pairings and rotates the runtime-only hosting token', async () => {
		const { folder, authority, manager } = await setup();
		const host = await hosting(authority);
		await expect(
			manager.connect({ name: 'Bad', transport: 'direct', url: host.url, token: 'incorrect' }),
		).rejects.toThrow('access token');
		expect((await manager.status()).instances).toEqual([]);
		const hostPort = await port();
		const first = await manager.startHost({ name: 'This computer', port: hostPort });
		expect(first.running).toBe(true);
		expect(await readFile(path.join(folder, 'instances.json'), 'utf8')).not.toContain(first.token!);
		await manager.stopHost();
		expect((await manager.status()).host.token).toBeUndefined();
		const second = await manager.startHost({ name: 'This computer', port: hostPort });
		expect(second.token).not.toBe(first.token);
		const denied = await fetch(`http://127.0.0.1:${hostPort}/info`, {
			headers: { Authorization: `Bearer ${first.token}` },
		});
		expect(denied.status).toBe(401);
		await manager.close();
		await expect(fetch(`http://127.0.0.1:${hostPort}/info`)).rejects.toThrow();
	});
});
