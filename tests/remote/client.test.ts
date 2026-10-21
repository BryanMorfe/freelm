import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import {
	createServer as createTcpServer,
	connect as tcpConnect,
	type Server as TcpServer,
} from 'node:net';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import {
	InstanceClient,
	instanceUrl,
	sshArguments,
	validateInstanceInput,
	validateAssetUrl,
} from '../../electron/instance-client';
import { InstanceHost } from '../../electron/instance-host';
import type { WorkspaceAuthority } from '../../electron/workspace-authority';
import type { AppState, WireRequest } from '../../src/types';
import { initialState } from '../../src/lib/state';
import { personalizationFixture } from '../fixtures/personalization';

const servers: (Server | TcpServer)[] = [];
const clients: InstanceClient[] = [];
const hosts: InstanceHost[] = [];
afterEach(async () => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	clients.splice(0).forEach((client) => client.disconnect());
	await Promise.all(hosts.splice(0).map((host) => host.stop()));
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					if ('closeAllConnections' in server) server.closeAllConnections();
					server.close(() => resolve());
				}),
		),
	);
});
async function mock(
	handler: (
		request: import('node:http').IncomingMessage,
		response: import('node:http').ServerResponse,
	) => void,
) {
	const server = createServer(handler);
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const port = (server.address() as { port: number }).port;
	return { url: `http://127.0.0.1:${port}`, port };
}
const wire: WireRequest = {
	id: 'request1',
	workspaceId: 'remote',
	connectionId: 'provider',
	apiKey: 'must-never-cross',
	baseUrl: 'http://wrong-provider',
	path: '/responses',
	method: 'POST',
	body: { model: 'model' },
	stream: true,
};
function info(response: import('node:http').ServerResponse, instanceId = 'host-identity') {
	response.setHeader('Content-Type', 'application/json');
	response.end(JSON.stringify({ protocol: 1, instanceId, name: 'Remote' }));
}
async function paired(url: string) {
	const { client } = await InstanceClient.connect({
		name: 'Host',
		transport: 'direct',
		url,
		token: 'pairing-token',
	});
	clients.push(client);
	return client;
}

describe('instance client', () => {
	it('blocks personalized saves before HTTP on legacy hosts and keeps ordinary saves usable', async () => {
		let writes = 0;
		let received: AppState | undefined;
		const original = initialState();
		const host = await mock((request, response) => {
			if (request.url === '/info') return info(response);
			response.setHeader('Content-Type', 'application/json');
			if (request.method === 'GET')
				return response.end(JSON.stringify({ state: original, revision: 'host:0' }));
			writes++;
			let body = '';
			request.on('data', (chunk) => {
				body += chunk;
			});
			request.on('end', () => {
				received = JSON.parse(body).state;
				response.end(JSON.stringify({ revision: 'host:1' }));
			});
		});
		const client = await paired(host.url);
		const snapshot = await client.load();
		expect(snapshot.personalizationSupported).toBe(false);
		expect(snapshot.codeCompactionSupported).toBe(false);
		expect(snapshot.state).not.toHaveProperty('codeCompaction');
		expect(snapshot.state).not.toHaveProperty('personalization');
		expect(writes).toBe(0);
		const personalization = personalizationFixture();
		await expect(
			client.save(snapshot.revision, { ...snapshot.state!, personalization }),
		).rejects.toThrow('Update this remote FreeLM instance to use personalization');
		const defaults = structuredClone(personalization);
		for (const profile of [defaults.chat, defaults.code]) {
			profile.personality = 'default';
			profile.warmth =
				profile.enthusiasm =
				profile.responseLength =
				profile.formatting =
				profile.emojis =
					'default';
			profile.customInstructions = '';
		}
		await expect(
			client.save(snapshot.revision, { ...snapshot.state!, personalization: defaults }),
		).rejects.toThrow('use personalization');
		expect(writes).toBe(0);
		await expect(
			client.save(snapshot.revision, {
				...snapshot.state!,
				codeCompaction: { thresholdPercent: 85, reserveTokens: 40000 },
			}),
		).rejects.toThrow('Update this remote FreeLM instance to configure Code compaction');
		expect(writes).toBe(0);
		await expect(
			client.save(snapshot.revision, { ...snapshot.state!, theme: 'light' }),
		).resolves.toEqual({ revision: 'host:1' });
		expect(writes).toBe(1);
		expect(received?.theme).toBe('light');
		expect(received).not.toHaveProperty('personalization');
		expect(received).not.toHaveProperty('personalizationSupported');
		expect(received).not.toHaveProperty('codeCompaction');
		expect(received).not.toHaveProperty('codeCompactionSupported');
	});

	it('disables memory on legacy workspace loads without writing the host state', async () => {
		const original = initialState();
		original.connections[0].apiKey = 'host-secret';
		original.memorySettings = { savedMemories: true, referenceHistory: true };
		let writes = 0;
		const host = await mock((request, response) => {
			if (request.url === '/info') return info(response);
			if (request.method !== 'GET') writes++;
			response.setHeader('Content-Type', 'application/json');
			response.end(JSON.stringify({ state: original, revision: 'host:0' }));
		});
		const snapshot = await (await paired(host.url)).load();
		expect(snapshot.memorySupported).toBe(false);
		expect(snapshot.state?.memorySettings).toEqual({
			savedMemories: false,
			referenceHistory: false,
		});
		expect(snapshot.state?.connections[0].apiKey).toBe('');
		expect(writes).toBe(0);
		expect(original.memorySettings).toEqual({ savedMemories: true, referenceHistory: true });
	});

	it('rejects memory-bearing saves before a legacy host can silently drop them', async () => {
		let writes = 0;
		const host = await mock((request, response) => {
			if (request.url === '/info') return info(response);
			writes++;
			response.end(JSON.stringify({ revision: 'host:1' }));
		});
		const client = await paired(host.url);
		const original = initialState();
		delete original.codeCompaction;
		delete original.moderation;
		const withMemory: AppState[] = [
			{ ...original, memorySettings: { savedMemories: true, referenceHistory: false } },
			{ ...original, memorySettings: { savedMemories: false, referenceHistory: true } },
			{
				...original,
				savedMemories: [
					{
						id: 'note',
						content: 'A user fact',
						createdAt: 1,
						updatedAt: 1,
						revision: 1,
						source: 'user',
					},
				],
			},
			{
				...original,
				threads: [
					{
						id: 'chat',
						title: 'Chat',
						connectionId: original.activeConnectionId,
						model: 'test',
						createdAt: 1,
						updatedAt: 1,
						messages: [],
						memorySummary: {
							content: 'A conversation fact',
							sourceRevision: 'transcript:1',
							generatedAt: 1,
							model: 'test',
						},
					},
				],
			},
		];
		for (const state of withMemory)
			await expect(client.save('host:0', state)).rejects.toThrow(
				'Update this remote FreeLM instance to use Chat memory',
			);
		expect(writes).toBe(0);
	});

	it('keeps legacy chat saves usable while omitting unsupported memory metadata from a copy', async () => {
		let received: { state: AppState; revision: string } | undefined;
		const host = await mock((request, response) => {
			if (request.url === '/info') return info(response);
			let input = '';
			request.on('data', (chunk) => (input += chunk));
			request.on('end', () => {
				received = JSON.parse(input);
				response.end(JSON.stringify({ revision: 'host:1' }));
			});
		});
		const client = await paired(host.url);
		const original = initialState();
		delete original.codeCompaction;
		delete original.moderation;
		original.connections[0].apiKey = 'host-secret';
		original.memorySettings = { savedMemories: false, referenceHistory: false };
		original.savedMemories = [];
		expect(await client.save('host:0', original)).toEqual({ revision: 'host:1' });
		expect(received?.revision).toBe('host:0');
		expect(received?.state).not.toHaveProperty('memorySettings');
		expect(received?.state).not.toHaveProperty('savedMemories');
		expect(received?.state.connections[0].apiKey).toBe('');
		expect(original.memorySettings).toEqual({ savedMemories: false, referenceHistory: false });
		expect(original.savedMemories).toEqual([]);
		expect(original.connections[0].apiKey).toBe('host-secret');
	});

	it('validates remote media URLs without blocking host-local signed asset URLs', () => {
		for (const url of [
			null,
			{},
			'',
			'file:///etc/passwd',
			'data:image/png;base64,AA==',
			'https://user:password@host/image.png',
			'x'.repeat(32769),
		])
			expect(() => validateAssetUrl(url)).toThrow();
		for (const url of [
			'http://localhost:8000/image.png',
			'https://cdn.example.com/image?signature=abc',
		])
			expect(() => validateAssetUrl(url)).not.toThrow();
	});
	it('requires HTTPS except loopback and rejects SSH option injection', () => {
		for (const url of [
			'http://example.com',
			'http://127.0.0.1.evil.test',
			'https://user:pass@example.com',
			'https://host/#token',
			'file:///tmp',
		])
			expect(() => instanceUrl(url)).toThrow();
		for (const url of [
			'https://example.com/freelm',
			'http://127.0.0.1:4319',
			'http://localhost:4319',
			'http://[::1]:4319',
		])
			expect(() => instanceUrl(url)).not.toThrow();
		for (const sshHost of [
			'-oProxyCommand=evil',
			'user@host;echo',
			'host with spaces',
			'a\nhost',
			'a@b@c',
		])
			expect(() => validateInstanceInput({ name: 'Host', transport: 'ssh', sshHost })).toThrow();
		const args = sshArguments('user@host', 52341, 4319);
		expect(args).toContain('StrictHostKeyChecking=yes');
		expect(args).toContain('BatchMode=yes');
		expect(args).toContain('ForwardAgent=no');
		expect(args).toContain('ExitOnForwardFailure=yes');
		expect(args).toContain('127.0.0.1:52341:127.0.0.1:4319');
		expect(args.slice(-2)).toEqual(['--', 'user@host']);
	});
	it('pins protocol and remote identity', async () => {
		const host = await mock((_request, response) => info(response, 'different'));
		await expect(
			InstanceClient.connect(
				{ name: 'Host', transport: 'direct', url: host.url, token: 'pairing-token' },
				'expected',
			),
		).rejects.toThrow('different FreeLM instance');
	});
	it('streams chunks and sends only the host connection identifier', async () => {
		let received: Record<string, unknown> = {};
		const host = await mock((request, response) => {
			expect(request.headers.authorization).toBe('Bearer pairing-token');
			if (request.url === '/info') return info(response);
			let input = '';
			request.on('data', (chunk) => (input += chunk));
			request.on('end', () => {
				received = JSON.parse(input);
				response.setHeader('Content-Type', 'application/x-ndjson');
				response.write(JSON.stringify({ type: 'chunk', text: 'data: hello\n\n' }) + '\n');
				response.end(
					JSON.stringify({
						type: 'response',
						response: { status: 200, contentType: 'text/event-stream', body: '', encoding: 'text' },
					}) + '\n',
				);
			});
		});
		const client = await paired(host.url);
		const chunks: string[] = [];
		expect((await client.request(wire, (chunk) => chunks.push(chunk))).status).toBe(200);
		expect(chunks).toEqual(['data: hello\n\n']);
		expect(received.connectionId).toBe('provider');
		for (const key of ['apiKey', 'baseUrl', 'workspaceId'])
			expect(received).not.toHaveProperty(key);
	});
	it('does not accept a truncated response or silently use the local API', async () => {
		const host = await mock((request, response) =>
			request.url === '/info'
				? info(response)
				: response.end(JSON.stringify({ type: 'chunk', text: 'partial' }) + '\n'),
		);
		const client = await paired(host.url);
		await expect(client.request(wire, () => {})).rejects.toThrow('before the request completed');
		client.disconnect();
		await expect(client.request(wire, () => {})).rejects.toThrow('disconnected');
	});
	it('decodes remote envelopes with multi-byte characters split across every byte', async () => {
		const message = 'data: {"delta":"你好 😀 �"}\n\n';
		const envelopes = Buffer.from(
			[
				JSON.stringify({ type: 'chunk', text: message }),
				JSON.stringify({
					type: 'response',
					response: { status: 200, contentType: 'text/event-stream', body: '', encoding: 'text' },
				}),
			].join('\n') + '\n',
		);
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: URL) =>
				url.pathname === '/info'
					? new Response(JSON.stringify({ protocol: 1, instanceId: 'utf8', name: '远程 😀' }))
					: new Response(
							new ReadableStream({
								start(controller) {
									for (const byte of envelopes) controller.enqueue(new Uint8Array([byte]));
									controller.close();
								},
							}),
						),
			),
		);
		const client = await paired('http://127.0.0.1:4319');
		const chunks: string[] = [];
		expect((await client.request(wire, (chunk) => chunks.push(chunk))).status).toBe(200);
		expect(chunks).toEqual([message]);
	});
	it.each([
		['malformed', [0xc3, 0x28], 'invalid-utf8'],
		['truncated', [0xf0, 0x9f, 0x98], 'incomplete-utf8'],
	] as const)(
		'rejects %s UTF-8 in remote streams without leaking private content',
		async (_label, invalid, kind) => {
			vi.stubGlobal(
				'fetch',
				vi.fn(async (url: URL) =>
					url.pathname === '/info'
						? new Response(JSON.stringify({ protocol: 1, instanceId: 'utf8', name: 'Host' }))
						: new Response(
								new ReadableStream({
									start(controller) {
										controller.enqueue(
											Buffer.from(
												JSON.stringify({ type: 'chunk', text: 'secret-remote-response' }) + '\n',
											),
										);
										controller.enqueue(new Uint8Array(invalid));
										controller.close();
									},
								}),
							),
				),
			);
			const client = await paired('http://127.0.0.1:4319');
			const chunks: string[] = [];
			const error = await client
				.request(wire, (chunk) => chunks.push(chunk))
				.catch((error: Error) => error);
			expect(error).toMatchObject({ name: 'ResponseDecodingError', kind });
			expect((error as Error).message).toContain('remote instance response');
			expect((error as Error).message).not.toContain('secret-remote-response');
			expect((error as Error).cause).toBeUndefined();
			expect(chunks).toEqual(['secret-remote-response']);
		},
	);
	it.each([
		['malformed', [0xff], 'invalid-utf8'],
		['truncated', [0xe2, 0x82], 'incomplete-utf8'],
	] as const)(
		'rejects %s UTF-8 in buffered remote JSON before parsing it',
		async (_label, invalid, kind) => {
			vi.stubGlobal(
				'fetch',
				vi.fn(
					async () =>
						new Response(
							Buffer.concat([Buffer.from('{"name":"secret-remote-json'), Buffer.from(invalid)]),
						),
				),
			);
			const error = await InstanceClient.connect({
				name: 'Host',
				transport: 'direct',
				url: 'http://127.0.0.1:4319',
				token: 'pairing-token',
			}).catch((error: Error) => error);
			expect(error).toMatchObject({ name: 'ResponseDecodingError', kind });
			expect((error as Error).message).not.toContain('secret-remote-json');
		},
	);
	it('reports malformed remote envelope position without including its private contents', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: URL) =>
				url.pathname === '/info'
					? new Response(
							JSON.stringify({
								protocol: 1,
								instanceId: 'utf8',
								name: 'Host',
								mediaModeration: true,
								moderationStructuredOutput: true,
								moderationPolicies: 1,
							}),
						)
					: new Response('\n{"text":"secret-envelope",malformed}\n'),
			),
		);
		const client = await paired('http://127.0.0.1:4319');
		const error = await client.request(wire, () => {}).catch((error: Error) => error);
		expect((error as Error).message).toBe(
			'The remote instance returned malformed stream data at line 2 (36 characters). Reconnect and retry.',
		);
		expect((error as Error).message).not.toContain('secret-envelope');
	});
	it('does not leak malformed generated image JSON from the remote envelope', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: URL) =>
				url.pathname === '/info'
					? new Response(
							JSON.stringify({
								protocol: 1,
								instanceId: 'utf8',
								name: 'Host',
								mediaModeration: true,
								moderationStructuredOutput: true,
								moderationPolicies: 1,
							}),
						)
					: new Response(
							JSON.stringify({
								type: 'response',
								response: {
									status: 200,
									contentType: 'application/json',
									body: '{"secret-image", malformed}',
									encoding: 'text',
								},
							}),
						),
			),
		);
		const client = await paired('http://127.0.0.1:4319');
		await expect(
			client.request({ ...wire, path: '/images/generations' }, () => {}),
		).rejects.toThrow('The remote instance returned invalid image response data.');
	});
	it.each([
		[
			'valid',
			['Image moderation is enabled. This request continued without image moderation.'],
			true,
		],
		['blank', [' '], false],
		['wrong type', [false], false],
		['oversized item', ['x'.repeat(2049)], false],
		['too many items', Array.from({ length: 9 }, () => 'A warning'), false],
	] as const)(
		'validates %s moderation warnings across the remote response bridge',
		async (_name, warnings, accepted) => {
			const result = {
				status: 200,
				contentType: 'application/json',
				encoding: 'text',
				body: JSON.stringify({
					data: [
						{
							b64_json:
								'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+HXXkAAAAASUVORK5CYII=',
						},
					],
				}),
				moderationWarnings: warnings,
			};
			vi.stubGlobal(
				'fetch',
				vi.fn(
					async (url: URL) =>
						new Response(
							JSON.stringify(
								url.pathname === '/info'
									? {
											protocol: 1,
											instanceId: 'warnings',
											name: 'Warning host',
											mediaModeration: true,
											moderationStructuredOutput: true,
											moderationPolicies: 1,
										}
									: { type: 'response', response: result },
							) + '\n',
						),
				),
			);
			const client = await paired('http://127.0.0.1:4319');
			const pending = client.request({ ...wire, path: '/images/generations' }, () => {});
			if (accepted) {
				const response = await pending;
				expect(response.moderationWarnings).toEqual(warnings);
				expect(response.body).toBe(result.body);
			} else await expect(pending).rejects.toThrow('Invalid remote response envelope');
		},
	);
	it('materializes host-local image URLs through the authenticated asset route', async () => {
		let assetInput: unknown;
		const host = await mock((request, response) => {
			if (request.url === '/info')
				return response.end(
					JSON.stringify({
						protocol: 1,
						instanceId: 'host-identity',
						name: 'Remote',
						mediaModeration: true,
						moderationStructuredOutput: true,
						moderationPolicies: 1,
					}),
				);
			if (request.url === '/asset') {
				let body = '';
				request.on('data', (chunk) => (body += chunk));
				request.on('end', () => {
					assetInput = JSON.parse(body);
					response.end(
						JSON.stringify({
							status: 200,
							contentType: 'image/png',
							body: 'aGVsbG8=',
							encoding: 'base64',
						}),
					);
				});
				return;
			}
			response.end(
				JSON.stringify({
					type: 'response',
					response: {
						status: 200,
						contentType: 'application/json',
						encoding: 'text',
						body: JSON.stringify({ data: [{ url: 'http://localhost:8000/generated.png' }] }),
					},
				}) + '\n',
			);
		});
		const client = await paired(host.url);
		const result = await client.request(
			{ ...wire, path: '/images/generations', stream: false },
			() => {},
		);
		expect(JSON.parse(result.body).data[0].url).toBe('data:image/png;base64,aGVsbG8=');
		expect(assetInput).toEqual({
			connectionId: 'provider',
			url: 'http://localhost:8000/generated.png',
		});
	});
	it('aborts a running remote stream on cancellation', async () => {
		const host = await mock((request, response) => {
			if (request.url === '/info') return info(response);
			response.writeHead(200);
			response.write(JSON.stringify({ type: 'chunk', text: 'first' }) + '\n');
		});
		const client = await paired(host.url);
		const controller = new AbortController();
		await expect(
			client.request(wire, () => controller.abort(), controller.signal),
		).rejects.toThrow();
	});
	it('tunnels using injected system SSH launcher and cleans it on disconnect', async () => {
		let killed = false,
			args: string[] = [];
		const instanceHost = new InstanceHost({
			authority: {} as WorkspaceAuthority,
			instanceId: 'ssh-real-host',
			name: 'SSH host',
			token: 'pairing-token',
			port: 0,
		});
		hosts.push(instanceHost);
		const host = { port: await instanceHost.start() };
		const result = await InstanceClient.connect(
			{
				name: 'SSH host',
				transport: 'ssh',
				sshHost: 'my-server',
				port: host.port,
				token: 'pairing-token',
			},
			undefined,
			(received) => {
				args = received;
				const forwarding = args[args.indexOf('-L') + 1];
				const localPort = Number(forwarding.split(':')[1]);
				const tunnel = createTcpServer((socket) => {
					const upstream = tcpConnect(host.port, '127.0.0.1');
					socket.pipe(upstream);
					upstream.pipe(socket);
					socket.once('close', () => upstream.destroy());
				});
				servers.push(tunnel);
				tunnel.listen(localPort, '127.0.0.1');
				const child = new EventEmitter() as ChildProcess;
				child.kill = () => {
					killed = true;
					tunnel.close();
					return true;
				};
				return child;
			},
		);
		clients.push(result.client);
		expect(result.info.instanceId).toBe('ssh-real-host');
		expect(args.at(-1)).toBe('my-server');
		result.client.disconnect();
		expect(killed).toBe(true);
	});
});

describe('remote video generation lifetime', () => {
	it.each(['tool', 'content'] as const)(
		'omits inference deadlines for video %s while preserving disconnect cancellation',
		async (operation) => {
			let executionSignal: AbortSignal | undefined;
			const fetcher = vi.fn(async (url: URL | string, options: RequestInit) => {
				if (String(url).endsWith('/info'))
					return Response.json({
						protocol: 1,
						instanceId: 'video-host',
						name: 'Video host',
						mediaModeration: true,
						moderationStructuredOutput: true,
						moderationPolicies: 1,
						moderationImageEdits: 1,
						moderationVideoFrames: 1,
					});
				executionSignal = options.signal!;
				return new Promise<Response>((_resolve, reject) =>
					executionSignal!.addEventListener('abort', () => reject(executionSignal!.reason), {
						once: true,
					}),
				);
			});
			vi.stubGlobal('fetch', fetcher);
			const client = await paired('http://127.0.0.1:9000');
			const timeout = vi.spyOn(AbortSignal, 'timeout');
			const request =
				operation === 'tool'
					? client.tools('execute', {
							name: 'video_gen.videogen',
							runId: 'video',
							threadId: 'thread',
							arguments: { prompt: 'A sunrise' },
						})
					: client.request({ ...wire, method: 'GET', path: '/videos/clip/content' }, () => {});
			const rejection = expect(request).rejects.toBeDefined();
			expect(timeout).not.toHaveBeenCalled();
			expect(executionSignal?.aborted).toBe(false);
			client.disconnect();
			expect(executionSignal?.aborted).toBe(true);
			await rejection;
		},
	);
	it('hides video tools and blocks encoded video content on hosts without frame moderation', async () => {
		const fetcher = vi.fn(async (url: URL | string) =>
			String(url).endsWith('/info')
				? Response.json({
						protocol: 1,
						instanceId: 'older-host',
						name: 'Older host',
						mediaModeration: true,
						moderationStructuredOutput: true,
						moderationPolicies: 1,
						moderationImageEdits: 1,
					})
				: Response.json({
						tools: [{ name: 'video_gen.videogen' }, { name: 'exec_command' }],
						warnings: [],
						instructions: '',
					}),
		);
		vi.stubGlobal('fetch', fetcher);
		const client = await paired('http://127.0.0.1:9000');
		expect((await client.tools('catalog', {})).tools).toEqual([{ name: 'exec_command' }]);
		await expect(client.tools('execute', { name: 'video_gen.videogen' })).rejects.toThrow(
			'frame-based',
		);
		await expect(
			client.request({ ...wire, method: 'GET', path: '/videos/job%2Fid/content' }, () => {}),
		).rejects.toThrow('frame-based');
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
});
