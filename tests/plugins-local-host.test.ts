import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PluginLocalManifest } from '../src/plugin-types';
import { disabledPluginAccess } from '../src/lib/plugin-manifest';

// These tests isolate host authorization/storage from the separately tested compiler and VM.
const boundary = vi.hoisted(() => ({
	packages: new Map<string, { manifest: unknown; hash: string; installedBytes: number }>(),
	bundles: new Map<string, string>(),
	handler: undefined as
		| undefined
		| ((
				input: any,
				callHost: (method: string, args: unknown, signal?: AbortSignal) => Promise<unknown>,
		  ) => Promise<unknown>),
	invocations: [] as any[],
}));
vi.mock('../electron/plugins/packages', () => ({
	PluginPackageStore: class {
		async prepare(bytes: Uint8Array) {
			const key = Buffer.from(bytes).toString();
			const pkg = boundary.packages.get(key)!;
			return { reviewId: key, manifest: pkg.manifest, files: 2, bytes: bytes.length };
		}
		async consume(reviewId: string) {
			const pkg = boundary.packages.get(reviewId);
			if (!pkg) throw new Error('Review expired');
			boundary.packages.delete(reviewId);
			return pkg;
		}
		async readBundle(hash: string) {
			if (!boundary.bundles.has(hash)) throw new Error('Missing package');
			return boundary.bundles.get(hash)!;
		}
		async readTab(hash: string, tab: string) {
			if (!boundary.bundles.has(hash)) throw new Error('Missing package');
			return { html: `<main>${tab}</main>` };
		}
	},
}));
vi.mock('../electron/plugins/runtime', () => ({
	executeLocalPlugin: async (
		input: unknown,
		callHost: (method: string, args: unknown, signal?: AbortSignal) => Promise<unknown>,
	) => {
		boundary.invocations.push(input);
		return boundary.handler ? boundary.handler(input, callHost) : { ok: true };
	},
}));
vi.mock('../electron/plugins/provider-session', () => ({ createProviderSession: () => ({ close() {}, transform: async (args: unknown) => {
 if (!boundary.handler) throw new Error('No fixture transform');
 return boundary.handler({ args }, async () => { throw new Error('No host API'); });
} }) }));
import { PluginHost, pluginToolName, type PluginHostOptions } from '../electron/plugins/host';
const folders: string[] = [],
	hosts: PluginHost[] = [];
afterEach(async () => {
	await Promise.allSettled(hosts.splice(0).map((host) => host.close()));
	await Promise.all(
		folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
	);
	boundary.packages.clear();
	boundary.bundles.clear();
	boundary.invocations = [];
	boundary.handler = undefined;
});
async function makeHost(
	fetcher?: typeof fetch,
	directory?: string,
	authorizeTool?: PluginHostOptions['authorizeTool'],
) {
	if (!directory) {
		directory = await mkdtemp(path.join(os.tmpdir(), 'freelm-local-plugin-host-'));
		folders.push(directory);
	}
	const host = new PluginHost({
		directory,
		fetch: fetcher,
		authorizeTool,
		openExternal: async () => {},
		secrets: {
			available: () => false,
			encrypt: () => {
				throw new Error('No OAuth fixture');
			},
			decrypt: () => {
				throw new Error('No OAuth fixture');
			},
		},
	});
	hosts.push(host);
	return { host, directory };
}
function manifest(id = 'local.notes'): PluginLocalManifest {
	return {
		manifestVersion: 2,
		id,
		name: 'Notes',
		version: '1',
		description: 'Local notes fixture.',
		auth: { type: 'none' },
		runtime: { apiVersion: 1, entry: 'src/index.ts' },
		permissions: { network: ['https://api.example.test'], storage: true },
		contributes: {
			tools: [
				{
					name: 'notes',
					description: 'Read notes.',
					parameters: { type: 'object', properties: {} },
					readOnly: true,
				},
			],
			tabs: [{ id: 'notebook', title: 'Notebook', entry: 'ui/index.ts' }],
			actions: ['save'],
		},
	};
}
let packageNumber = 0;
async function install(host: PluginHost, spec = manifest(), hash?: string) {
	const review = `review-${++packageNumber}`;
	hash ??= packageNumber.toString(16).padStart(64, '0');
	boundary.packages.set(review, { manifest: spec, hash, installedBytes: 100 });
	boundary.bundles.set(hash, 'compiled fixture');
	const preview = await host.preparePackage(Buffer.from(review));
	expect(preview.reviewId).toBe(review);
	return host.installPackage(review);
}
async function account(host: PluginHost, id = 'local.notes', label = 'Personal') {
	const snapshot = await host.command({ type: 'connect', pluginId: id, label });
	return snapshot.accounts.at(-1)!;
}
async function grant(host: PluginHost, id: string) {
	await host.command({
		type: 'access',
		accountId: id,
		access: { ...disabledPluginAccess(), code: true, tools: ['notes'] },
	});
}
function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe('local plugin host package lifecycle', () => {
	it('requires reviewed ZIP installation, discovers declared tools, and starts denied', async () => {
		const { host } = await makeHost();
		await expect(host.command({ type: 'install', manifest: manifest() })).rejects.toThrow(
			/reviewed ZIP/,
		);
		const snapshot = await install(host);
		expect(snapshot.plugins[0].package).toMatchObject({ installedBytes: 100 });
		const connected = await account(host);
		expect(connected.tools).toEqual([
			{ name: 'notes', description: 'Read notes.', readOnly: true },
		]);
		expect(connected.access).toEqual(disabledPluginAccess());
		expect(await host.catalog({ surface: 'code' })).toEqual([]);
		const name = pluginToolName('local.notes', connected.id, 'notes');
		await expect(
			host.execute({ surface: 'code' }, name, {}, new AbortController().signal),
		).rejects.toThrow(/not granted/);
		await grant(host, connected.id);
		const result = await host.execute({ surface: 'code' }, name, {}, new AbortController().signal);
		expect(result.content).toEqual([{ type: 'text', text: '{"ok":true}' }]);
		expect(boundary.invocations[0].account).toEqual({ id: connected.id, label: 'Personal' });
		expect(boundary.invocations[0]).not.toHaveProperty('tokens');
	});
	it('clears all grants for new code even when the manifest and identity are unchanged', async () => {
		const { host } = await makeHost();
		await install(host);
		const connected = await account(host);
		await grant(host, connected.id);
		const oldHash = (await host.snapshot()).plugins[0].package!.hash;
		const updated = await install(host);
		expect(updated.plugins[0].package!.hash).not.toBe(oldHash);
		expect(updated.accounts[0].id).toBe(connected.id);
		expect(updated.accounts[0].access).toEqual(disabledPluginAccess());
		expect(await host.catalog({ surface: 'code' })).toEqual([]);
	});
	it('drops accounts if package identity or authorization changes', async () => {
		const { host } = await makeHost();
		await install(host);
		await account(host);
		await install(host, { ...manifest(), author: 'A different publisher' });
		expect((await host.snapshot()).accounts).toEqual([]);
	});
	it('disables a missing package on restart and never executes stale cached tools', async () => {
		const { host, directory } = await makeHost();
		await install(host);
		const connected = await account(host);
		await grant(host, connected.id);
		await host.close();
		boundary.bundles.clear();
		const { host: resumed } = await makeHost(undefined, directory);
		expect((await resumed.snapshot()).plugins[0].enabled).toBe(false);
		expect(await resumed.catalog({ surface: 'code' })).toEqual([]);
	});
});

describe('local plugin host broker isolation', () => {
	it('scopes persistent storage to an account and excludes contents from renderer snapshots', async () => {
		const { host, directory } = await makeHost();
		await install(host);
		const first = await account(host);
		const second = await account(host, 'local.notes', 'Work');
		boundary.handler = async (input, call) => {
			if (input.args.write)
				await call('storage.set', { key: 'private-note', value: input.args.write });
			return call('storage.get', { key: 'private-note' });
		};
		expect(
			await host.invokeAction('local.notes', 'notebook', first.id, 'save', {
				write: 'Keep this note',
			}),
		).toBe('Keep this note');
		expect(await host.invokeAction('local.notes', 'notebook', second.id, 'save', {})).toBe(null);
		expect(JSON.stringify(await host.snapshot())).not.toContain('Keep this note');
		await host.command({
			type: 'connect',
			pluginId: 'local.notes',
			label: 'Personal reconnected',
			accountId: first.id,
		});
		expect(await host.invokeAction('local.notes', 'notebook', first.id, 'save', {})).toBe(
			'Keep this note',
		);
		await host.close();
		const { host: resumed } = await makeHost(undefined, directory);
		expect(await resumed.invokeAction('local.notes', 'notebook', first.id, 'save', {})).toBe(
			'Keep this note',
		);
	});
	it('only lets declared tabs invoke their own actions and accounts independently of assistant grants', async () => {
		const { host } = await makeHost();
		await install(host);
		const own = await account(host);
		await install(host, manifest('other.notes'));
		const foreign = await account(host, 'other.notes');
		expect(await host.tabContent('local.notes', 'notebook')).toEqual({
			html: '<main>notebook</main>',
		});
		await expect(
			host.invokeAction('local.notes', 'notebook', foreign.id, 'save', {}),
		).rejects.toThrow(/another plugin/);
		await expect(
			host.invokeAction('local.notes', 'missing-tab', own.id, 'save', {}),
		).rejects.toThrow(/not declared/);
		await expect(
			host.invokeAction('local.notes', 'notebook', own.id, 'delete-all', {}),
		).rejects.toThrow(/not declared/);
		expect(await host.invokeAction('local.notes', 'notebook', own.id, 'save', {})).toEqual({
			ok: true,
		});
		await host.command({ type: 'enable', pluginId: 'local.notes', enabled: false });
		await expect(
			host.invokeAction('local.notes', 'notebook', own.id, 'save', {}),
		).rejects.toThrow();
	});
	it('enforces exact network origins, reserved headers, declared storage, and no process bridge', async () => {
		const requests: string[] = [];
		const { host } = await makeHost(async (url, init) => {
			requests.push(String(url));
			expect(init?.redirect).toBe('manual');
			return new Response('fixture response');
		});
		await install(host, {
			...manifest(),
			permissions: { network: ['https://api.example.test'], storage: false },
		});
		const connected = await account(host);
		boundary.handler = async (input, call) => {
			try {
				return await call(input.args.method, input.args.request);
			} catch {
				return { denied: true };
			}
		};
		const denied = async (method: string, request: unknown) =>
			expect(
				await host.invokeAction('local.notes', 'notebook', connected.id, 'save', {
					method,
					request,
				}),
			).toEqual({ denied: true });
		await denied('fetch', { url: 'https://api.example.test.attacker.invalid/' });
		await denied('fetch', {
			url: 'https://api.example.test/',
			init: { headers: { Authorization: 'Bearer stolen' } },
		});
		await denied('fetch', { url: 'https://api.example.test/', init: { authenticated: true } });
		await denied('storage.set', { key: 'note', value: 'hello' });
		await denied('exec', { cmd: 'touch /tmp/plugin-escape' });
		expect(requests).toEqual([]);
		const result = await host.invokeAction('local.notes', 'notebook', connected.id, 'save', {
			method: 'fetch',
			request: { url: 'https://api.example.test/notes?q=hi' },
		});
		expect(result).toMatchObject({ status: 200, body: 'fixture response' });
		expect(requests).toEqual(['https://api.example.test/notes?q=hi']);
	});
	it('rechecks authorization before host effects after an in-flight invocation is disabled', async () => {
		const { host, directory } = await makeHost();
		await install(host);
		const connected = await account(host);
		const entered = gate(),
			resume = gate();
		boundary.handler = async (_input, call) => {
			entered.resolve();
			await resume.promise;
			return call('storage.set', { key: 'late', value: 'should never persist' });
		};
		const pending = host.invokeAction('local.notes', 'notebook', connected.id, 'save', {});
		void pending.catch(() => {});
		await entered.promise;
		await host.command({ type: 'enable', pluginId: 'local.notes', enabled: false });
		resume.resolve();
		await expect(pending).rejects.toThrow(/cancelled/);
		expect(await readFile(path.join(directory, 'registry.json'), 'utf8')).not.toContain(
			'should never persist',
		);
	});
	it('bounds storage values and blocks another operation after update cancels the old package', async () => {
		const { host } = await makeHost();
		await install(host);
		const connected = await account(host);
		boundary.handler = async (_input, call) => {
			try {
				await call('storage.set', { key: 'big', value: 'x'.repeat(300_000) });
				return 'unexpected';
			} catch {
				return 'denied';
			}
		};
		expect(await host.invokeAction('local.notes', 'notebook', connected.id, 'save', {})).toBe(
			'denied',
		);
		const entered = gate(),
			resume = gate();
		boundary.handler = async (_input, call) => {
			entered.resolve();
			await resume.promise;
			return call('storage.get', { key: 'big' });
		};
		const pending = host.invokeAction('local.notes', 'notebook', connected.id, 'save', {});
		void pending.catch(() => {});
		await entered.promise;
		await install(host);
		resume.resolve();
		await expect(pending).rejects.toThrow(/cancelled/);
	});
	it('cancels an abandoned interpreter bridge call and preserves useful runtime diagnostics', async () => {
		const { host, directory } = await makeHost();
		await install(host);
		const connected = await account(host);
		boundary.handler = async (_input, call) => {
			const finished = new AbortController();
			finished.abort();
			try {
				await call('storage.set', { key: 'late', value: 'orphan side effect' }, finished.signal);
				return 'unexpected';
			} catch {
				return 'cancelled';
			}
		};
		expect(await host.invokeAction('local.notes', 'notebook', connected.id, 'save', {})).toBe(
			'cancelled',
		);
		expect(await readFile(path.join(directory, 'registry.json'), 'utf8')).not.toContain(
			'orphan side effect',
		);
		boundary.handler = async () => {
			throw new Error('The requested note does not exist.');
		};
		await expect(
			host.invokeAction('local.notes', 'notebook', connected.id, 'save', {}),
		).rejects.toThrow('The requested note does not exist.');
		await expect(
			host.invokeAction('local.notes', 'notebook', connected.id, 'save', []),
		).rejects.toThrow(/JSON object/);
	});
	it('injects OAuth only at the declared API origin and redacts tokens before any guest response', async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), 'freelm-local-plugin-auth-'));
		folders.push(directory);
		const accessToken = 'local-fixture-access-token',
			refreshToken = 'local-fixture-refresh-token';
		const requests: { url: string; auth: string | null }[] = [];
		const oauthHost = new PluginHost({
			directory,
			secrets: {
				available: () => true,
				encrypt: (value) => Buffer.from('cipher:' + Buffer.from(value).toString('base64')),
				decrypt: (value) => Buffer.from(value.toString().slice(7), 'base64').toString(),
			},
			openExternal: async (url) => {
				const parsed = new URL(url);
				expect(parsed.searchParams.has('resource')).toBe(false);
				const callback = new URL(parsed.searchParams.get('redirect_uri')!);
				callback.search = new URLSearchParams({
					code: 'fixture-code',
					state: parsed.searchParams.get('state')!,
				}).toString();
				expect((await fetch(callback)).status).toBe(200);
			},
			fetch: async (url, init) => {
				if (String(url) === 'https://auth.example.test/token') {
					expect(new URLSearchParams(String(init?.body)).has('resource')).toBe(false);
					return new Response(
						JSON.stringify({
							access_token: accessToken,
							refresh_token: refreshToken,
							token_type: 'Bearer',
							expires_in: 3600,
						}),
						{ headers: { 'Content-Type': 'application/json' } },
					);
				}
				requests.push({ url: String(url), auth: new Headers(init?.headers).get('Authorization') });
				return new Response(JSON.stringify({ echoed: accessToken, refresh: refreshToken }), {
					headers: { 'x-debug-token': accessToken, 'set-cookie': 'hidden-cookie' },
				});
			},
		});
		hosts.push(oauthHost);
		await install(oauthHost, {
			...manifest(),
			permissions: {
				storage: true,
				network: ['https://api.example.test', 'https://other.example.test'],
			},
			auth: {
				type: 'oauth2',
				clientId: 'existing-client',
				authorizationUrl: 'https://auth.example.test/authorize',
				tokenUrl: 'https://auth.example.test/token',
				scopes: ['read'],
				apiOrigin: 'https://api.example.test',
			},
		});
		const connected = await account(oauthHost);
		boundary.handler = async (input, call) => {
			try {
				return await call('fetch', {
					url: input.args.url,
					init: { authenticated: input.args.authenticated },
				});
			} catch {
				return { denied: true };
			}
		};
		const result = await oauthHost.invokeAction('local.notes', 'notebook', connected.id, 'save', {
			url: 'https://api.example.test/messages',
			authenticated: true,
		});
		expect(JSON.stringify(result)).not.toContain(accessToken);
		expect(JSON.stringify(result)).not.toContain(refreshToken);
		expect(JSON.stringify(result)).toContain('redacted credential');
		expect(JSON.stringify(result)).not.toContain('hidden-cookie');
		expect(requests).toEqual([
			{ url: 'https://api.example.test/messages', auth: `Bearer ${accessToken}` },
		]);
		expect(
			await oauthHost.invokeAction('local.notes', 'notebook', connected.id, 'save', {
				url: 'https://other.example.test/messages',
				authenticated: true,
			}),
		).toEqual({ denied: true });
		expect(requests).toHaveLength(1);
		await oauthHost.invokeAction('local.notes', 'notebook', connected.id, 'save', {
			url: 'https://other.example.test/public',
			authenticated: false,
		});
		expect(requests[1]).toEqual({ url: 'https://other.example.test/public', auth: null });
		expect(JSON.stringify(await oauthHost.snapshot())).not.toContain(accessToken);
	});
});

describe('bot plugin action authorization and execution metadata', () => {
	async function ready(
		authorizeTool?: PluginHostOptions['authorizeTool'],
		readOnly = false,
		execution?: 'sync' | 'async',
	) {
		const { host } = await makeHost(undefined, undefined, authorizeTool);
		const spec = manifest();
		spec.contributes.tools[0] = {
			...spec.contributes.tools[0],
			readOnly,
			...(execution ? { execution } : {}),
		};
		await install(host, spec);
		const connected = await account(host);
		await host.command({
			type: 'access',
			accountId: connected.id,
			access: { ...disabledPluginAccess(), botIds: ['nova'], tools: ['notes'] },
		});
		return {
			host,
			connected,
			name: pluginToolName('local.notes', connected.id, 'notes'),
			caller: { surface: 'bot' as const, botId: 'nova' },
		};
	}
	it('keeps grants distinct from approval and forwards the durable operation identity only after approval', async () => {
		const f = await ready();
		expect((await f.host.catalog(f.caller))[0]).toMatchObject({
			execution: 'async',
			readOnly: false,
			effect: 'unknown',
			requiresApproval: true,
		});
		await expect(
			f.host.execute(f.caller, f.name, { text: 'change' }, new AbortController().signal, {
				operationId: 'stable-1',
			}),
		).rejects.toThrow(/requires user approval/);
		expect(boundary.invocations).toHaveLength(0);
		await f.host.execute(f.caller, f.name, { text: 'change' }, new AbortController().signal, {
			operationId: 'stable-1',
			approval: { approved: true },
		});
		expect(boundary.invocations[0].operationId).toBe('stable-1');
	});
	it('does not prompt for explicitly quick read-only tools', async () => {
		const approval = vi.fn(async () => false);
		const f = await ready(approval, true, 'sync');
		expect((await f.host.catalog(f.caller))[0]).toMatchObject({
			execution: 'sync',
			readOnly: true,
			effect: 'read',
			requiresApproval: false,
		});
		await f.host.execute(f.caller, f.name, {}, new AbortController().signal);
		expect(approval).not.toHaveBeenCalled();
	});
	it('uses the host hook with exact arguments and rechecks access after approval', async () => {
		let revoke!: () => Promise<unknown>;
		const approval = vi.fn(
			async (_request: Parameters<NonNullable<PluginHostOptions['authorizeTool']>>[0]) => {
				await revoke();
				return true;
			},
		);
		const f = await ready(approval);
		revoke = () =>
			f.host.command({ type: 'access', accountId: f.connected.id, access: disabledPluginAccess() });
		await expect(
			f.host.execute(f.caller, f.name, { text: 'change' }, new AbortController().signal, {
				operationId: 'stable-2',
			}),
		).rejects.toThrow(/not granted/);
		expect(approval.mock.calls[0][0]).toMatchObject({
			caller: f.caller,
			accountId: f.connected.id,
			toolName: 'notes',
			args: { text: 'change' },
			operationId: 'stable-2',
		});
		expect(boundary.invocations).toHaveLength(0);
	});
});

describe('provider adapter host authorization', () => {
  it.each([false, true])(
    'requires a separate provider capability (declared=%s)',
    async (declared) => {
      const fetcher = vi.fn<typeof fetch>(async () => new Response('{}'));
      const { host } = await makeHost(fetcher);
      const spec = manifest();
      spec.runtime.apiVersion = 2;
      spec.contributes.providers = [
        { id: 'custom', name: 'Custom', capabilities: { tools: false, streaming: false } },
      ];
      spec.permissions.capabilities = declared ? ['provider.use'] : [];
      await install(host, spec);
      const connected = await account(host);
      boundary.handler = async (input) =>
        input.args.phase === 'request'
          ? { path: '/generate', format: 'json', body: {} }
          : {
              events: [
                { type: 'text', text: 'Synthetic reply' },
                { type: 'finish', reason: 'stop' },
              ],
            };
      const run = () =>
        host.generateWithProvider({
          pluginId: spec.id,
          accountId: connected.id,
          providerId: 'custom',
          caller: { surface: 'code' },
          baseUrl: 'https://api.example.test',
          request: {
            version: 1,
            model: 'fixture',
            system: '',
            messages: [],
            tools: [],
            maxOutputTokens: 100,
            stream: false,
          },
          onEvent() {},
          signal: new AbortController().signal,
        });
      await expect(run()).rejects.toThrow(/not granted/);
      await grant(host, connected.id);
      if (declared) await expect(run()).resolves.toMatchObject({ text: 'Synthetic reply' });
      else {
        await expect(run()).rejects.toThrow(/not granted/);
        expect(fetcher).not.toHaveBeenCalled();
      }
      await host.command({ type: 'enable', pluginId: spec.id, enabled: false });
      await expect(run()).rejects.toThrow(/disabled/);
    },
  );
});
