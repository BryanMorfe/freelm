import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, request as httpRequest, type Server, type RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StateStore } from '../../electron/state-store';
import { WorkspaceAuthority, WorkspaceConflictError } from '../../electron/workspace-authority';
import { InstanceHost } from '../../electron/instance-host';
import { InstanceClient } from '../../electron/instance-client';
import type { AppState } from '../../src/types';
import { personalizationFixture } from '../fixtures/personalization';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const task of cleanup.splice(0).reverse()) await task();
});
const TOKEN = 'a-test-instance-token-with-adequate-length';
const SECRET = 'provider-secret-must-stay-on-host';

function state(baseUrl = 'http://127.0.0.1:8000/v1'): AppState {
	return {
		version: 1,
		theme: 'dark',
		activeConnectionId: 'provider',
		threads: [],
		projects: [],
		generations: [],
		connections: [
			{
				id: 'provider',
				name: 'Provider',
				baseUrl,
				apiKey: SECRET,
				chatApi: 'responses',
				models: { chat: 'example-model', images: '', videos: '', speech: '', transcription: '' },
				discoveredModels: [],
			},
		],
	};
}

async function authority(baseUrl?: string) {
	const directory = await mkdtemp(path.join(tmpdir(), 'freelm-remote-host-'));
	cleanup.push(() => rm(directory, { force: true, recursive: true }));
	const store = new StateStore(path.join(directory, 'workspace.json'), {
		available: () => false,
		encrypt: () => {
			throw new Error('No insecure encryption');
		},
		decrypt: () => {
			throw new Error('No insecure decryption');
		},
	});
	await store.save(state(baseUrl));
	return { authority: new WorkspaceAuthority(store), store };
}

async function provider(listener: RequestListener) {
	const server = createServer(listener);
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	cleanup.push(() => close(server));
	const port = (server.address() as { port: number }).port;
	return `http://127.0.0.1:${port}`;
}

function close(server: Server) {
	return new Promise<void>((resolve) => {
		server.close(() => resolve());
		server.closeAllConnections();
	});
}

async function host(baseUrl?: string) {
	const workspace = await authority(baseUrl);
	const host = new InstanceHost({
		authority: workspace.authority,
		instanceId: 'instance-test',
		name: 'Remote workstation',
		token: TOKEN,
		port: 0,
	});
	const port = await host.start();
	cleanup.push(() => host.stop());
	const url = `http://127.0.0.1:${port}`;
	const send = (route: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') =>
		fetch(url + route, {
			method,
			headers: {
				Authorization: `Bearer ${TOKEN}`,
				...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	return { ...workspace, host, url, port, send };
}

function wire(overrides: Record<string, unknown> = {}) {
	return {
		id: crypto.randomUUID(),
		connectionId: 'provider',
		path: '/responses',
		method: 'POST',
		body: { model: 'example-model', input: 'Hello' },
		...overrides,
	};
}

describe('workspace authority', () => {
	it('rejects a simultaneous stale writer and preserves the successful workspace', async () => {
		const { authority: workspace, store } = await authority();
		const local = await workspace.load();
		const remote = await workspace.load(true);
		local.state!.projects.push({ id: 'local', name: 'Local', instructions: '', createdAt: 1 });
		remote.state!.projects.push({ id: 'remote', name: 'Remote', instructions: '', createdAt: 1 });
		const writes = await Promise.allSettled([
			workspace.save(local.state!, local.revision),
			workspace.save(remote.state!, remote.revision, true),
		]);
		expect(writes[0].status).toBe('fulfilled');
		expect(writes[1].status).toBe('rejected');
		if (writes[1].status === 'rejected')
			expect(writes[1].reason).toBeInstanceOf(WorkspaceConflictError);
		expect((await workspace.load()).state?.projects.map((project) => project.id)).toEqual([
			'local',
		]);
		expect((await store.load())?.projects.map((project) => project.id)).toEqual(['local']);
	});

	it('redacts and preserves host credentials while rejecting connection mutations', async () => {
		const { authority: workspace, store } = await authority();
		const remote = await workspace.load(true);
		expect(remote.state?.connections[0].apiKey).toBe('');
		expect(JSON.stringify(remote)).not.toContain(SECRET);
		remote.state!.theme = 'light';
		remote.state!.systemPrompt = 'Use the remote workspace conventions.';
		remote.state!.thinkingPresets = [
			{
				id: 'remote-budget',
				name: 'Remote budget',
				parameters: { chat: { thinking_budget: 2048 } },
			},
		];
		await workspace.save(remote.state!, remote.revision, true);
		const savedRemote = await workspace.load(true);
		expect(savedRemote.state?.systemPrompt).toBe(remote.state!.systemPrompt);
		expect(savedRemote.state?.thinkingPresets).toEqual(remote.state!.thinkingPresets);
		expect((await store.load())?.systemPrompt).toBe(remote.state!.systemPrompt);
		expect((await store.load())?.thinkingPresets).toEqual(remote.state!.thinkingPresets);
		expect((await workspace.load()).state?.connections[0].apiKey).toBe(SECRET);
		expect((await store.load())?.connections[0].apiKey).toBe(SECRET);
		expect(await readFile(store.filename, 'utf8')).not.toContain(SECRET);
		for (const change of [
			(connection: AppState['connections'][0]) => {
				connection.baseUrl = 'https://attacker.example/v1';
			},
			(connection: AppState['connections'][0]) => {
				connection.apiKey = 'replacement';
			},
			(connection: AppState['connections'][0]) => {
				connection.models.chat = 'different';
			},
		]) {
			const next = await workspace.load(true);
			change(next.state!.connections[0]);
			await expect(workspace.save(next.state!, next.revision, true)).rejects.toThrow(
				'configured on the host',
			);
		}
	});

	it('changes the revision epoch when the authority restarts', async () => {
		const { authority: workspace, store } = await authority();
		const previous = await workspace.load();
		const restarted = new WorkspaceAuthority(store);
		expect((await restarted.load()).revision).not.toBe(previous.revision);
		previous.state!.theme = 'light';
		await expect(restarted.save(previous.state!, previous.revision)).rejects.toThrow(
			'WORKSPACE_CONFLICT:',
		);
	});

	it('treats omitted optional catalog fields as unchanged across remote JSON while protecting host connections', async () => {
		const { authority: workspace, store } = await authority();
		const local = await workspace.load();
		local.state!.connections[0].catalog = [
			{
				id: 'image-model',
				name: 'Image model',
				enabled: true,
				tasks: ['images'],
				inputModalities: ['text'],
				outputModalities: ['image'],
				thinkingModes: [],
				defaultThinkingMode: undefined,
				defaultImagePreset: 'draft',
				imagePresets: [
					{
						id: 'draft',
						name: 'Draft',
						quality: undefined,
						defaultAspectRatio: 'wide',
						aspectRatios: [{ id: 'wide', name: '16:9', width: 1024, height: 576 }],
					},
				],
			},
		];
		const saved = await workspace.save(local.state!, local.revision);
		const remote = await workspace.load(true);
		expect(remote.state!.connections[0].catalog![0]).not.toHaveProperty('defaultThinkingMode');
		expect(remote.state!.connections[0].apiKey).toBe('');
		const wireState: AppState = JSON.parse(JSON.stringify(remote.state));
		expect(await workspace.save(wireState, remote.revision, true)).toEqual(saved);
		wireState.systemPrompt = 'Remote project instructions';
		const changed = await workspace.save(wireState, remote.revision, true);
		expect((await store.load())?.systemPrompt).toBe(wireState.systemPrompt);
		expect((await store.load())?.connections[0].apiKey).toBe(SECRET);
		wireState.connections[0].catalog![0].name = 'Unauthorized catalog change';
		await expect(workspace.save(wireState, changed.revision, true)).rejects.toThrow(
			'configured on the host',
		);
		expect((await store.load())?.connections[0].catalog![0].name).toBe('Image model');
		wireState.connections[0].catalog![0].name = 'Image model';
		wireState.connections[0].catalog![0].imagePresets![0].aspectRatios[0].width = 2048;
		await expect(workspace.save(wireState, changed.revision, true)).rejects.toThrow(
			'configured on the host',
		);
		expect(
			(await store.load())?.connections[0].catalog![0].imagePresets![0].aspectRatios[0].width,
		).toBe(1024);
	});

	it('keeps the revision for no-op local and redacted remote autosaves', async () => {
		const { authority: workspace } = await authority();
		const local = await workspace.load();
		const remote = await workspace.load(true);
		expect(await workspace.save(local.state!, local.revision)).toEqual({
			revision: local.revision,
		});
		expect(await workspace.save(remote.state!, remote.revision, true)).toEqual({
			revision: local.revision,
		});
		remote.state!.theme = 'light';
		const changed = await workspace.save(remote.state!, remote.revision, true);
		expect(changed.revision).not.toBe(remote.revision);
		expect(await workspace.save(remote.state!, remote.revision, true)).toEqual(changed);
	});

	it('does not advance canonical state or revision when persistence fails', async () => {
		const { authority: workspace, store } = await authority();
		const before = await workspace.load();
		const changed = structuredClone(before.state!);
		changed.theme = 'light';
		const save = vi.spyOn(store, 'saveSnapshot').mockRejectedValueOnce(new Error('Disk full'));
		await expect(workspace.save(changed, before.revision)).rejects.toThrow('Disk full');
		expect(await workspace.load()).toEqual(before);
		save.mockRestore();
		await expect(workspace.save(changed, before.revision)).resolves.toHaveProperty('revision');
	});

	it('treats host-side connection changes as a conflict for an older remote snapshot', async () => {
		const { authority: workspace } = await authority();
		const remote = await workspace.load(true);
		const local = await workspace.load();
		local.state!.connections[0].models.chat = 'updated-host-model';
		await workspace.save(local.state!, local.revision);
		remote.state!.theme = 'light';
		await expect(workspace.save(remote.state!, remote.revision, true)).rejects.toThrow(
			'WORKSPACE_CONFLICT:',
		);
	});
});

describe('authenticated loopback instance host', () => {
	it('requires authentication, rejects browser origins and hostile Host headers, and advertises protocol', async () => {
		const instance = await host();
		expect((await fetch(instance.url + '/info')).status).toBe(401);
		expect(
			(
				await fetch(instance.url + '/info', {
					headers: { Authorization: `Bearer ${TOKEN}`, Origin: 'http://malicious.example' },
				})
			).status,
		).toBe(403);
		const hostileHost = await new Promise<number>((resolve) => {
			const request = httpRequest(
				instance.url + '/info',
				{ headers: { Authorization: `Bearer ${TOKEN}`, Host: 'malicious.example' } },
				(response) => {
					response.resume();
					resolve(response.statusCode!);
				},
			);
			request.end();
		});
		expect(hostileHost).toBe(403);
		const forwardedHost = await new Promise<number>((resolve) => {
			const request = httpRequest(
				instance.url + '/info',
				{ headers: { Authorization: `Bearer ${TOKEN}`, Host: '127.0.0.1:43210' } },
				(response) => {
					response.resume();
					resolve(response.statusCode!);
				},
			);
			request.end();
		});
		expect(forwardedHost).toBe(200);
		expect(await (await instance.send('/info')).json()).toEqual({
			protocol: 1,
			instanceId: 'instance-test',
			name: 'Remote workstation',
			conversationModes: true,
			chatMemory: true,
			personalization: true,
			codeCompaction: true,
			mediaModeration: true,
			moderationStructuredOutput: true,
			moderationPolicies: 1,
			moderationImageEdits: 1,
			moderationVideoFrames: 1,
			moderationVideoReferences: 1,
			taskOutputs: true,
			taskOutputStatus: true,
			composerContext: 1,
			codeSurface: 1,
		});
		expect((await instance.send('/unknown')).status).toBe(404);
	});

	it('returns redacted state and reports stale remote saves as HTTP conflicts', async () => {
		const instance = await host();
		const original = await (await instance.send('/workspace')).json();
		expect(JSON.stringify(original)).not.toContain(SECRET);
		original.state.theme = 'light';
		expect((await instance.send('/workspace', original, 'PUT')).status).toBe(200);
		original.state.theme = 'system';
		const rejected = await instance.send('/workspace', original, 'PUT');
		expect(rejected.status).toBe(409);
		expect((await rejected.json()).error).toMatch(/^WORKSPACE_CONFLICT:/);
	});

	it('negotiates Chat memory and preserves notes, preferences and summaries through a remote save', async () => {
		const instance = await host();
		const { client } = await InstanceClient.connect({
			name: 'Current host',
			transport: 'direct',
			url: instance.url,
			token: TOKEN,
		});
		cleanup.push(async () => client.disconnect());
		const snapshot = await client.load();
		expect(snapshot.memorySupported).toBe(true);
		const changed = snapshot.state!;
		changed.memorySettings = { savedMemories: true, referenceHistory: false };
		changed.savedMemories = [
			{
				id: 'fact',
				content: 'The user prefers concise explanations.',
				createdAt: 1,
				updatedAt: 2,
				revision: 1,
				source: 'user',
			},
		];
		changed.threads = [
			{
				id: 'chat',
				title: 'Chat',
				connectionId: 'provider',
				model: 'test',
				createdAt: 1,
				updatedAt: 2,
				messages: [],
				memorySummary: {
					content: 'Discussed the app.',
					sourceRevision: 'transcript:1',
					generatedAt: 2,
					model: 'test',
				},
			},
		];
		await client.save(snapshot.revision, changed);
		const reloaded = await client.load();
		const disk = await instance.store.load();
		for (const saved of [reloaded.state, disk]) {
			expect(saved?.memorySettings).toEqual(changed.memorySettings);
			expect(saved?.savedMemories).toEqual(changed.savedMemories);
			expect(saved?.threads[0].memorySummary).toEqual(changed.threads[0].memorySummary);
			expect(saved).not.toHaveProperty('memorySupported');
		}
		await expect(client.save(snapshot.revision, { ...changed, savedMemories: [] })).rejects.toThrow(
			'WORKSPACE_CONFLICT',
		);
		expect((await instance.store.load())?.savedMemories).toEqual(changed.savedMemories);
	});

	it('negotiates personalization and durably saves both profiles with revision protection', async () => {
		const instance = await host();
		const { client, info } = await InstanceClient.connect({
			name: 'Current host',
			transport: 'direct',
			url: instance.url,
			token: TOKEN,
		});
		cleanup.push(async () => client.disconnect());
		expect(info.personalization).toBe(true);
		const snapshot = await client.load();
		expect(snapshot.personalizationSupported).toBe(true);
		const changed = { ...snapshot.state!, personalization: personalizationFixture() };
		const saved = await client.save(snapshot.revision, changed);
		for (const persisted of [(await client.load()).state, await instance.store.load()]) {
			expect(persisted?.personalization).toEqual(changed.personalization);
			expect(persisted).not.toHaveProperty('personalizationSupported');
		}
		await expect(
			client.save(snapshot.revision, {
				...changed,
				personalization: {
					...changed.personalization,
					code: { ...changed.personalization.code, personality: 'efficient' },
				},
			}),
		).rejects.toThrow('WORKSPACE_CONFLICT');
		expect((await instance.store.load())?.personalization).toEqual(changed.personalization);
		const { personalization: _removed, ...ordinary } = changed;
		await client.save(saved.revision, ordinary);
		expect((await client.load()).state).not.toHaveProperty('personalization');
	});

	it('negotiates and durably saves global Code compaction with revision protection', async () => {
		const instance = await host();
		const { client, info } = await InstanceClient.connect({
			name: 'Current host',
			transport: 'direct',
			url: instance.url,
			token: TOKEN,
		});
		cleanup.push(async () => client.disconnect());
		expect(info.codeCompaction).toBe(true);
		const snapshot = await client.load();
		expect(snapshot.codeCompactionSupported).toBe(true);
		const changed = {
			...snapshot.state!,
			codeCompaction: { thresholdPercent: 85, reserveTokens: 40000 },
		};
		await client.save(snapshot.revision, changed);
		for (const persisted of [(await client.load()).state, await instance.store.load()]) {
			expect(persisted?.codeCompaction).toEqual(changed.codeCompaction);
			expect(persisted).not.toHaveProperty('codeCompactionSupported');
		}
		await expect(
			client.save(snapshot.revision, {
				...changed,
				codeCompaction: { thresholdPercent: 50, reserveTokens: 0 },
			}),
		).rejects.toThrow('WORKSPACE_CONFLICT');
		expect((await instance.store.load())?.codeCompaction).toEqual(changed.codeCompaction);
	});

	it('runs requests with host credentials and refuses client overrides or unsupported paths', async () => {
		const received: { authorization?: string; url?: string }[] = [];
		const api = await provider((request, response) => {
			received.push({ authorization: request.headers.authorization, url: request.url });
			response.writeHead(200, { 'Content-Type': 'application/json' });
			response.end(JSON.stringify({ output_text: 'Hello from the host' }));
		});
		const instance = await host(api + '/v1');
		const reply = await instance.send('/request', wire());
		const envelope = JSON.parse((await reply.text()).trim());
		expect(envelope.type).toBe('response');
		expect(envelope.response.body).toContain('Hello from the host');
		expect(received).toEqual([{ authorization: `Bearer ${SECRET}`, url: '/v1/responses' }]);
		for (const overrides of [
			{ baseUrl: api },
			{ apiKey: 'override' },
			{ path: '/files' },
			{ path: '/videos/..', method: 'GET' },
			{ connectionId: 'missing' },
		])
			expect((await instance.send('/request', wire(overrides))).status).toBeGreaterThanOrEqual(400);
		expect(received).toHaveLength(1);
	});

	it('terminates a complete stream with a response envelope and reports upstream failures', async () => {
		let fail = false;
		const api = await provider((_request, response) => {
			response.writeHead(200, { 'Content-Type': 'text/event-stream' });
			response.write('data: {"delta":"hello"}\n\n');
			setTimeout(() => {
				if (fail) response.destroy();
				else response.end('data: [DONE]\n\n');
			}, 5);
		});
		const instance = await host(api + '/v1');
		const complete = (await (await instance.send('/request', wire({ stream: true }))).text())
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		expect(complete[0]).toMatchObject({ type: 'chunk' });
		expect(complete.at(-1)).toMatchObject({ type: 'response', response: { status: 200 } });
		fail = true;
		const failed = (await (await instance.send('/request', wire({ stream: true }))).text())
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		expect(failed.at(-1)).toMatchObject({ type: 'error', message: expect.any(String) });
	});

	it('forwards streaming chunks and cancels the upstream request on disconnect', async () => {
		let upstreamClosed = false;
		const api = await provider((_request, response) => {
			response.writeHead(200, { 'Content-Type': 'text/event-stream' });
			response.write('data: {"delta":"hello"}\n\n');
			response.once('close', () => {
				upstreamClosed = true;
			});
		});
		const instance = await host(api + '/v1');
		const controller = new AbortController();
		const response = await fetch(instance.url + '/request', {
			method: 'POST',
			headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
			body: JSON.stringify(wire({ stream: true })),
			signal: controller.signal,
		});
		const reader = response.body!.getReader();
		const first = await reader.read();
		expect(new TextDecoder().decode(first.value)).toContain('"type":"chunk"');
		controller.abort();
		await reader.cancel().catch(() => undefined);
		await vi.waitFor(() => expect(upstreamClosed).toBe(true));
	});

	it('downloads host-only assets without credentials and refuses redirects and oversized media', async () => {
		const credentials: (string | undefined)[] = [];
		const api = await provider((request, response) => {
			credentials.push(request.headers.authorization);
			if (request.url === '/redirect') {
				response.writeHead(302, { Location: '/image' });
				response.end();
			} else if (request.url === '/huge') {
				response.writeHead(200, {
					'Content-Type': 'image/png',
					'Content-Length': String(32 * 1024 * 1024 + 1),
				});
				response.end();
			} else {
				response.writeHead(200, { 'Content-Type': 'image/png' });
				response.end(Buffer.from([137, 80, 78, 71]));
			}
		});
		const instance = await host(api + '/v1');
		const result = await (
			await instance.send('/asset', { connectionId: 'provider', url: api + '/image' })
		).json();
		expect(result).toEqual({
			status: 200,
			contentType: 'image/png',
			encoding: 'base64',
			body: 'iVBORw==',
		});
		expect(
			(await instance.send('/asset', { connectionId: 'provider', url: api + '/redirect' })).status,
		).toBe(400);
		const huge = await instance.send('/asset', { connectionId: 'provider', url: api + '/huge' });
		expect(huge.status).toBe(400);
		expect((await huge.json()).error).toContain('32 MB');
		expect(credentials).toEqual([undefined, undefined, undefined]);
	});

	it('rejects oversized bodies before receiving their contents', async () => {
		const instance = await host();
		const status = await new Promise<number>((resolve, reject) => {
			const request = httpRequest(
				instance.url + '/request',
				{
					method: 'POST',
					headers: {
						Authorization: `Bearer ${TOKEN}`,
						'Content-Type': 'application/json',
						'Content-Length': String(256 * 1024 * 1024 + 1),
					},
				},
				(response) => {
					response.resume();
					resolve(response.statusCode!);
				},
			);
			request.on('error', reject);
			request.end();
		});
		expect(status).toBe(413);
	});
});
