import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PluginHost, pluginToolName } from '../electron/plugins/host';
import { guardedFetch } from '../electron/plugins/oauth';
import { disabledPluginAccess, validatePluginManifest } from '../src/lib/plugin-manifest';
import type { PluginManifest } from '../src/plugin-types';
import type { SecretStorage } from '../electron/state-store';

const hosts: PluginHost[] = [],
	folders: string[] = [],
	servers: Server[] = [];
afterEach(async () => {
	await Promise.allSettled(hosts.splice(0).map((host) => host.close()));
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	await Promise.all(
		folders.splice(0).map((folder) => rm(folder, { force: true, recursive: true })),
	);
});
const cipherKey = randomBytes(32);
const secrets: SecretStorage = {
	available: () => true,
	encrypt(value) {
		const iv = randomBytes(12);
		const cipher = createCipheriv('aes-256-gcm', cipherKey, iv);
		return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]);
	},
	decrypt(value) {
		const decipher = createDecipheriv('aes-256-gcm', cipherKey, value.subarray(0, 12));
		decipher.setAuthTag(value.subarray(-16));
		return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString();
	},
};
async function folder() {
	const value = await mkdtemp(path.join(os.tmpdir(), 'freelm-plugin-test-'));
	folders.push(value);
	return value;
}
function host(directory: string, openExternal: (url: string) => Promise<void> = async () => {}) {
	const host = new PluginHost({ directory, secrets, openExternal });
	hosts.push(host);
	return host;
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
async function fixture(
	options: {
		oauth?: boolean;
		redirect?: string;
		accessToken?: string;
		refreshToken?: string;
		rejectRefresh?: boolean;
	} = {},
) {
	let url = '';
	let authorization: URL | undefined;
	let refreshes = 0,
		calls = 0,
		revocations = 0;
	let refreshGate: Promise<void> | undefined;
	const refreshEntered = deferred<void>();
	const tokens = [options.accessToken || 'test-private-access-one', 'test-private-access-two'];
	const refresh = options.refreshToken || 'test-private-refresh';
	const exchanges: URLSearchParams[] = [];
	let tools = [
		{
			name: 'search',
			description: 'Search records.',
			inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
			annotations: { readOnlyHint: true },
		},
		{
			name: 'send',
			description: 'Send a message.',
			inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
			annotations: { readOnlyHint: false },
		},
	];
	const server = createServer(async (request, response) => {
		let body = '';
		for await (const chunk of request) body += chunk.toString();
		const parsed = new URL(request.url || '/', url);
		if (parsed.pathname === '/token') {
			const fields = new URLSearchParams(body);
			exchanges.push(fields);
			if (fields.get('grant_type') === 'authorization_code') {
				if (
					fields.get('code') !== 'test-code' ||
					!authorization ||
					createHash('sha256')
						.update(fields.get('code_verifier') || '')
						.digest('base64url') !== authorization.searchParams.get('code_challenge') ||
					fields.get('redirect_uri') !== authorization.searchParams.get('redirect_uri') ||
					fields.get('resource') !== `${url}/mcp`
				) {
					response
						.writeHead(400, { 'Content-Type': 'application/json' })
						.end(JSON.stringify({ error: 'invalid_grant' }));
					return;
				}
			} else {
				refreshes++;
				refreshEntered.resolve();
				await refreshGate;
				if (
					options.rejectRefresh ||
					fields.get('refresh_token') !== refresh ||
					fields.get('resource') !== `${url}/mcp`
				) {
					response
						.writeHead(400, { 'Content-Type': 'application/json' })
						.end(JSON.stringify({ error: 'invalid_grant' }));
					return;
				}
			}
			response.writeHead(200, { 'Content-Type': 'application/json' }).end(
				JSON.stringify({
					access_token: fields.get('grant_type') === 'authorization_code' ? tokens[0] : tokens[1],
					refresh_token: refresh,
					token_type: 'Bearer',
					expires_in: 3600,
					scope: 'records.read records.write',
					resource: `${url}/mcp`,
				}),
			);
			return;
		}
		if (parsed.pathname === '/revoke') {
			revocations++;
			response.writeHead(200).end();
			return;
		}
		if (options.redirect) {
			response.writeHead(302, { Location: options.redirect }).end();
			return;
		}
		if (parsed.pathname !== '/mcp') {
			response.writeHead(404).end();
			return;
		}
		if (
			options.oauth &&
			!tokens.some((token) => request.headers.authorization === `Bearer ${token}`)
		) {
			response.writeHead(401).end('not authorized');
			return;
		}
		if (request.method !== 'POST') {
			response.writeHead(405).end();
			return;
		}
		const rpc = JSON.parse(body);
		if (rpc.id === undefined) {
			response.writeHead(202).end();
			return;
		}
		let result: unknown;
		if (rpc.method === 'initialize')
			result = {
				protocolVersion: '2025-03-26',
				capabilities: { tools: {} },
				serverInfo: { name: 'Fixture', version: '1' },
			};
		else if (rpc.method === 'tools/list') result = { tools };
		else if (rpc.method === 'tools/call') {
			calls++;
			result = {
				content: [
					{
						type: 'text',
						text: JSON.stringify({
							tool: rpc.params.name,
							args: rpc.params.arguments,
							meta: rpc.params._meta,
							...(options.oauth
								? { secretEcho: tokens[refreshes ? 1 : 0], refreshEcho: refresh }
								: {}),
						}),
					},
				],
			};
		} else result = {};
		response
			.writeHead(200, { 'Content-Type': 'application/json' })
			.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	servers.push(server);
	url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	const manifest: PluginManifest = {
		manifestVersion: 1,
		id: 'fixture.plugin',
		name: 'Fixture',
		version: '1.0.0',
		description: 'Local fixture plugin.',
		mcp: { url: `${url}/mcp` },
		auth: options.oauth
			? {
					type: 'oauth2',
					clientId: 'existing-public-client',
					authorizationUrl: `${url}/authorize`,
					tokenUrl: `${url}/token`,
					revocationUrl: `${url}/revoke`,
					scopes: ['records.read', 'records.write'],
				}
			: { type: 'none' },
	};
	return {
		url,
		manifest,
		tokens,
		refresh,
		exchanges,
		refreshEntered,
		get calls() {
			return calls;
		},
		get refreshes() {
			return refreshes;
		},
		get revocations() {
			return revocations;
		},
		set tools(value: typeof tools) {
			tools = value;
		},
		get tools() {
			return tools;
		},
		set refreshGate(value: Promise<void>) {
			refreshGate = value;
		},
		async authorize(raw: string) {
			authorization = new URL(raw);
			expect(authorization.searchParams.get('client_id')).toBe('existing-public-client');
			expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
			expect(authorization.searchParams.get('resource')).toBe(`${url}/mcp`);
			const callback = new URL(authorization.searchParams.get('redirect_uri')!);
			callback.search = new URLSearchParams({ code: 'test-code', state: 'incorrect' }).toString();
			expect((await fetch(callback)).status).toBe(400);
			callback.searchParams.set('state', authorization.searchParams.get('state')!);
			expect((await fetch(callback)).status).toBe(200);
		},
	};
}
async function connect(plugin: PluginHost, manifest: PluginManifest) {
	await plugin.command({ type: 'install', manifest });
	return (await plugin.command({ type: 'connect', pluginId: manifest.id, label: 'Personal' }))
		.accounts[0];
}
async function expire(directory: string) {
	const filename = path.join(directory, 'registry.json');
	const value = JSON.parse(await readFile(filename, 'utf8'));
	const token = JSON.parse(
		await secrets.decrypt(Buffer.from(value.accounts[0].credentials, 'base64')),
	);
	token.expiresAt = 0;
	value.accounts[0].credentials = (await secrets.encrypt(JSON.stringify(token))).toString('base64');
	await writeFile(filename, JSON.stringify(value));
}

describe('declarative plugin manifests', () => {
	const valid = {
		manifestVersion: 1,
		id: 'mail.example',
		name: 'Mail',
		version: '1',
		description: 'Mail tools',
		mcp: { url: 'https://mcp.example/mail' },
		auth: { type: 'none' },
	};
	it('validates strictly and rejects executable fields, URL secrets, and insecure remote endpoints', () => {
		expect(validatePluginManifest(valid)).toEqual(valid);
		for (const url of [
			'http://192.168.1.10/mcp',
			'http://localhost/mcp',
			'https://user:secret@example.com/mcp',
			'https://example.com/mcp?token=secret',
			'https://example.com/mcp#secret',
			'file:///tmp/service',
			'http://127.0.0.2/mcp',
		])
			expect(() => validatePluginManifest({ ...valid, mcp: { url } })).toThrow();
		expect(() => validatePluginManifest({ ...valid, command: 'node service.js' })).toThrow(
			/unsupported fields/,
		);
		expect(() =>
			validatePluginManifest({
				...valid,
				mcp: { url: valid.mcp.url, headers: { Authorization: 'secret' } },
			}),
		).toThrow();
	});
	it('binds OAuth to the exact MCP resource and rejects another resource origin', () => {
		const auth = {
			type: 'oauth2',
			clientId: 'registered-client',
			authorizationUrl: 'https://identity.example/authorize',
			tokenUrl: 'https://identity.example/token',
			scopes: ['mail.read'],
		};
		const validated = validatePluginManifest({ ...valid, auth });
		expect(validated.auth).toMatchObject({ resource: valid.mcp.url });
		expect(validatePluginManifest(validated)).toEqual(validated);
		expect(() =>
			validatePluginManifest({
				...valid,
				auth: { ...auth, resource: 'https://gmail.googleapis.com/' },
			}),
		).toThrow(/exact MCP endpoint origin/);
		expect(() =>
			validatePluginManifest({ ...valid, auth: { ...auth, clientSecret: 'not-a-public-client' } }),
		).toThrow();
	});
	it('produces stable, account-specific safe API names', () => {
		const name = pluginToolName('a'.repeat(80), 'account1', 'tool.name with punctuation!');
		expect(name).toMatch(/^plugin_[A-Za-z0-9_]{1,57}$/);
		expect(name.length).toBeLessThanOrEqual(64);
		expect(name).toBe(pluginToolName('a'.repeat(80), 'account1', 'tool.name with punctuation!'));
		expect(name).not.toBe(
			pluginToolName('a'.repeat(80), 'account2', 'tool.name with punctuation!'),
		);
	});
});

describe('plugin accounts and explicit access', () => {
	it('uses SDK discovery, starts denied, scopes grants by surface/bot/host, and persists safely', async () => {
		const service = await fixture();
		const directory = await folder();
		const plugin = host(directory);
		const account = await connect(plugin, service.manifest);
		expect(account.tools.map((tool) => tool.name)).toEqual(['search', 'send']);
		expect(account.access).toEqual(disabledPluginAccess());
		expect(await plugin.catalog({ surface: 'chat' })).toEqual([]);
		const name = pluginToolName(service.manifest.id, account.id, 'search');
		await expect(
			plugin.execute({ surface: 'code' }, name, {}, new AbortController().signal),
		).rejects.toThrow(/not granted/);
		await plugin.command({
			type: 'access',
			accountId: account.id,
			access: { ...disabledPluginAccess(), code: true, botIds: ['nova'], tools: ['search'] },
		});
		expect(await plugin.catalog({ surface: 'bot', botId: 'other' })).toEqual([]);
		expect(await plugin.catalog({ surface: 'bot', botId: 'nova', remote: true })).toEqual([]);
		expect((await plugin.catalog({ surface: 'bot', botId: 'nova' }))[0].name).toBe(name);
		expect((await plugin.catalog({ surface: 'code' }))[0]).toMatchObject({
			source: 'plugin',
			requiresApproval: false,
			deferred: false,
		});
		const result = await plugin.execute(
			{ surface: 'code' },
			name,
			{ query: 'hello' },
			new AbortController().signal,
		);
		expect(JSON.stringify(result)).toContain('hello');
		expect(service.calls).toBe(1);
		await plugin.close();
		const resumed = host(directory);
		expect((await resumed.catalog({ surface: 'code' }))[0].name).toBe(name);
		expect((await stat(path.join(directory, 'registry.json'))).mode & 0o777).toBe(0o600);
		await resumed.command({ type: 'enable', pluginId: service.manifest.id, enabled: false });
		expect(await resumed.catalog({ surface: 'code' })).toEqual([]);
		await expect(
			resumed.execute({ surface: 'code' }, name, {}, new AbortController().signal),
		).rejects.toThrow(/disabled/);
	});
	it('rejects malformed runtime commands and undiscovered grants', async () => {
		const service = await fixture();
		const plugin = host(await folder());
		const account = await connect(plugin, service.manifest);
		await expect(
			plugin.command({ type: 'enable', pluginId: service.manifest.id, enabled: 'yes' } as never),
		).rejects.toThrow();
		await expect(
			plugin.command({
				type: 'access',
				accountId: account.id,
				access: { ...disabledPluginAccess(), tools: ['not-discovered'] },
			}),
		).rejects.toThrow(/discovered catalog/);
		await expect(
			plugin.command({ type: 'connect', pluginId: service.manifest.id, label: '\n' }),
		).rejects.toThrow();
		await expect(plugin.command({ type: 'run', command: 'echo unsafe' } as never)).rejects.toThrow(
			/Unsupported/,
		);
	});
	it('preserves grants for a metadata/version update but clears accounts after endpoint or identity changes', async () => {
		const service = await fixture();
		const plugin = host(await folder());
		const account = await connect(plugin, service.manifest);
		await plugin.command({
			type: 'access',
			accountId: account.id,
			access: { ...disabledPluginAccess(), chat: true, tools: ['search'] },
		});
		await plugin.command({
			type: 'install',
			manifest: { ...service.manifest, version: '2', description: 'Updated description' },
		});
		expect((await plugin.catalog({ surface: 'chat' })).length).toBe(1);
		await plugin.command({
			type: 'install',
			manifest: { ...service.manifest, mcp: { url: `${service.url}/new-mcp` } },
		});
		expect((await plugin.snapshot()).accounts).toEqual([]);
	});
	it('revokes individual tool grants when rediscovery changes a schema or description', async () => {
		const service = await fixture();
		const plugin = host(await folder());
		const account = await connect(plugin, service.manifest);
		await plugin.command({
			type: 'access',
			accountId: account.id,
			access: { ...disabledPluginAccess(), code: true, tools: ['search', 'send'] },
		});
		service.tools = service.tools.map((tool) =>
			tool.name === 'search' ? { ...tool, description: 'Changed behavior' } : tool,
		);
		await plugin.command({ type: 'discover', accountId: account.id });
		expect((await plugin.snapshot()).accounts[0].access.tools).toEqual(['send']);
	});
	it('rejects corrupt storage without replacing it', async () => {
		const directory = await folder();
		const filename = path.join(directory, 'registry.json');
		await writeFile(filename, '{broken');
		await expect(host(directory).snapshot()).rejects.toThrow(/not been overwritten/);
		expect(await readFile(filename, 'utf8')).toBe('{broken');
	});
});

describe('public OAuth and credential isolation', () => {
	it('completes PKCE with a validated state, encrypts credentials, redacts responses, and revokes on disconnect', async () => {
		const service = await fixture({ oauth: true });
		const directory = await folder();
		const plugin = host(directory, service.authorize);
		const account = await connect(plugin, service.manifest);
		const persisted = await readFile(path.join(directory, 'registry.json'), 'utf8');
		expect(persisted).not.toContain(service.tokens[0]);
		expect(persisted).not.toContain(service.refresh);
		expect(JSON.stringify(await plugin.snapshot())).not.toContain('credentials');
		expect(service.exchanges[0].has('client_secret')).toBe(false);
		await plugin.command({
			type: 'access',
			accountId: account.id,
			access: { ...disabledPluginAccess(), chat: true, tools: ['search'] },
		});
		const [tool] = await plugin.catalog({ surface: 'chat' });
		const result = await plugin.execute(
			{ surface: 'chat' },
			tool.name,
			{},
			new AbortController().signal,
		);
		expect(JSON.stringify(result)).not.toContain(service.tokens[0]);
		expect(JSON.stringify(result)).toContain('redacted credential');
		await plugin.command({ type: 'disconnect', accountId: account.id });
		expect(service.revocations).toBe(1);
		expect((await plugin.snapshot()).accounts).toEqual([]);
		await expect(
			plugin.execute({ surface: 'chat' }, tool.name, {}, new AbortController().signal),
		).rejects.toThrow(/unavailable/);
	});
	it('redacts credentials containing JSON quotes and backslashes without corrupting tool text', async () => {
		const service = await fixture({
			oauth: true,
			accessToken: 'private-"access\\token',
			refreshToken: 'private-"refresh\\token',
		});
		const plugin = host(await folder(), service.authorize);
		const account = await connect(plugin, service.manifest);
		await plugin.command({
			type: 'access',
			accountId: account.id,
			access: { ...disabledPluginAccess(), chat: true, tools: ['search'] },
		});
		const [tool] = await plugin.catalog({ surface: 'chat' });
		const result = await plugin.execute(
			{ surface: 'chat' },
			tool.name,
			{},
			new AbortController().signal,
		);
		const content = result.content[0];
		expect(content.type).toBe('text');
		if (content.type === 'text')
			expect(JSON.parse(content.text)).toMatchObject({
				secretEcho: '[redacted credential]',
				refreshEcho: '[redacted credential]',
			});
	});
	it('marks an account for reconnection when token renewal fails without leaking service errors', async () => {
		const service = await fixture({ oauth: true, rejectRefresh: true });
		const directory = await folder();
		const plugin = host(directory, service.authorize);
		const account = await connect(plugin, service.manifest);
		await plugin.command({
			type: 'access',
			accountId: account.id,
			access: { ...disabledPluginAccess(), code: true, tools: ['search'] },
		});
		await plugin.close();
		await expire(directory);
		const resumed = host(directory);
		const [tool] = await resumed.catalog({ surface: 'code' });
		await expect(
			resumed.execute({ surface: 'code' }, tool.name, {}, new AbortController().signal),
		).rejects.toThrow(/Reconnect/);
		expect((await resumed.snapshot()).accounts[0].status).toBe('reconnect');
		expect(await resumed.catalog({ surface: 'code' })).toEqual([]);
		expect(service.calls).toBe(0);
	});
	it('reconnects the same account without self-cancelling and requires fresh grants', async () => {
		const service = await fixture({ oauth: true });
		const plugin = host(await folder(), service.authorize);
		const account = await connect(plugin, service.manifest);
		await plugin.command({
			type: 'access',
			accountId: account.id,
			access: { ...disabledPluginAccess(), chat: true, tools: ['search'] },
		});
		const snapshot = await plugin.command({
			type: 'connect',
			pluginId: service.manifest.id,
			label: 'Reconnected',
			accountId: account.id,
		});
		expect(snapshot.accounts).toHaveLength(1);
		expect(snapshot.accounts[0]).toMatchObject({
			id: account.id,
			status: 'connected',
			label: 'Reconnected',
			access: disabledPluginAccess(),
		});
		expect(snapshot.accounts[0].tools).toHaveLength(2);
		expect(await plugin.catalog({ surface: 'chat' })).toEqual([]);
	});
	it('refreshes expired credentials once for concurrent calls after restart', async () => {
		const service = await fixture({ oauth: true });
		const directory = await folder();
		const plugin = host(directory, service.authorize);
		const account = await connect(plugin, service.manifest);
		await plugin.command({
			type: 'access',
			accountId: account.id,
			access: { ...disabledPluginAccess(), code: true, tools: ['search'] },
		});
		await plugin.close();
		await expire(directory);
		const resumed = host(directory);
		const [tool] = await resumed.catalog({ surface: 'code' });
		await Promise.all(
			[1, 2, 3].map(() =>
				resumed.execute({ surface: 'code' }, tool.name, {}, new AbortController().signal),
			),
		);
		expect(service.refreshes).toBe(1);
		expect(service.calls).toBe(3);
	});
	it('does not execute or persist a refresh after permissions are revoked mid-refresh', async () => {
		const service = await fixture({ oauth: true });
		const directory = await folder();
		const plugin = host(directory, service.authorize);
		const account = await connect(plugin, service.manifest);
		await plugin.command({
			type: 'access',
			accountId: account.id,
			access: { ...disabledPluginAccess(), code: true, tools: ['search'] },
		});
		await plugin.close();
		await expire(directory);
		const resumed = host(directory);
		const [tool] = await resumed.catalog({ surface: 'code' });
		const gate = deferred<void>();
		service.refreshGate = gate.promise;
		const pending = resumed.execute(
			{ surface: 'code' },
			tool.name,
			{},
			new AbortController().signal,
		);
		void pending.catch(() => {});
		await service.refreshEntered.promise;
		await resumed.command({
			type: 'access',
			accountId: account.id,
			access: disabledPluginAccess(),
		});
		gate.resolve();
		await expect(pending).rejects.toThrow(/access changed/);
		expect(service.calls).toBe(0);
		expect(await resumed.catalog({ surface: 'code' })).toEqual([]);
	});
	it('cancels an in-progress sign-in and never creates an account', async () => {
		const service = await fixture({ oauth: true });
		const opened = deferred<void>();
		const plugin = host(await folder(), async () => {
			opened.resolve();
			await new Promise(() => {});
		});
		await plugin.command({ type: 'install', manifest: service.manifest });
		const pending = plugin.command({
			type: 'connect',
			pluginId: service.manifest.id,
			label: 'Work',
		});
		void pending.catch(() => {});
		await opened.promise;
		plugin.cancelConnect();
		await expect(pending).rejects.toThrow(/cancelled/);
		expect((await plugin.snapshot()).accounts).toEqual([]);
	});
	it('refuses OAuth when secure storage is unavailable before launching a browser', async () => {
		const service = await fixture({ oauth: true });
		let opened = false;
		const plugin = new PluginHost({
			directory: await folder(),
			secrets: { ...secrets, available: () => false },
			openExternal: async () => {
				opened = true;
			},
		});
		hosts.push(plugin);
		await plugin.command({ type: 'install', manifest: service.manifest });
		await expect(
			plugin.command({ type: 'connect', pluginId: service.manifest.id, label: 'Work' }),
		).rejects.toThrow(/Secure credential storage/);
		expect(opened).toBe(false);
	});
});

describe('bounded plugin HTTP transport', () => {
	it('does not follow redirects or allow a second endpoint to receive bearer credentials', async () => {
		let destinations: string[] = [];
		const fetcher: typeof fetch = async (input, init) => {
			destinations.push(String(input));
			expect(init?.redirect).toBe('manual');
			return new Response(null, {
				status: 302,
				headers: { location: 'https://attacker.invalid/steal' },
			});
		};
		const guarded = guardedFetch(
			fetcher,
			'https://mcp.example/endpoint',
			new AbortController().signal,
		);
		await expect(
			guarded('https://mcp.example/endpoint', {
				headers: { Authorization: 'Bearer private-token' },
			}),
		).rejects.toThrow(/redirected/);
		await expect(guarded('https://attacker.invalid/steal')).rejects.toThrow(/outside/);
		expect(destinations).toEqual(['https://mcp.example/endpoint']);
	});
	it('enforces response byte limits while streaming', async () => {
		const fetcher: typeof fetch = async () =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new Uint8Array(9));
						controller.enqueue(new Uint8Array(9));
						controller.close();
					},
				}),
			);
		const response = await guardedFetch(
			fetcher,
			'https://mcp.example/',
			new AbortController().signal,
			10,
		)('https://mcp.example/');
		await expect(response.text()).rejects.toThrow(/size limit/);
	});
});

it('forwards host operation identity through MCP metadata and defaults remote tools to async', async () => {
	const service = await fixture();
	const plugin = host(await folder());
	const connected = await connect(plugin, service.manifest);
	await plugin.command({
		type: 'access',
		accountId: connected.id,
		access: { ...disabledPluginAccess(), botIds: ['nova'], tools: ['send'] },
	});
	const caller = { surface: 'bot' as const, botId: 'nova' };
	const [tool] = await plugin.catalog(caller);
	expect(tool).toMatchObject({ execution: 'async', readOnly: false, requiresApproval: true });
	await expect(
		plugin.execute(caller, tool.name, { text: 'hello' }, new AbortController().signal),
	).rejects.toThrow(/requires user approval/);
	expect(service.calls).toBe(0);
	const result = await plugin.execute(
		caller,
		tool.name,
		{ text: 'hello' },
		new AbortController().signal,
		{ operationId: 'bot:stable-action', approval: { approved: true } },
	);
	const item = result.content.find((item) => item.type === 'text');
	if (item?.type !== 'text') throw new Error('Missing result');
	expect(JSON.parse(item.text).meta).toEqual({ 'freelm/operationId': 'bot:stable-action' });
	expect(service.calls).toBe(1);
});
