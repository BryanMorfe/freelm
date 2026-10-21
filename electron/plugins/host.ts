import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ToolDefinition, ToolResult } from '../../src/agent-types';
import type {
	InstalledPlugin,
	PluginAccount,
	PluginCaller,
	PluginCommand,
	PluginManifest,
	PluginLocalManifest,
	PluginPackagePreview,
	PluginSnapshot,
	PluginToolProvider,
	PluginExecutionContext,
	PluginToolAuthorizationRequest,
	PluginToolEffect,
} from '../../src/plugin-types';
import {
	disabledPluginAccess,
	PLUGIN_LIMITS,
	validatePluginAccess,
	validatePluginManifest,
	validatePluginSettings,
	defaultPluginSettings,
} from '../../src/lib/plugin-manifest';
import type { SecretStorage } from '../state-store';
import { atomicWrite, jsonPayload } from '../json-file';
import { convertMCPResult } from '../tools/mcp';
import { PluginPackageStore } from './packages';
import { executeLocalPlugin } from './runtime';
import {
	connectOAuth,
	guardedFetch,
	PluginFailure,
	refreshOAuth,
	revokeOAuth,
	safePluginError,
	validateTokens,
	type PluginTokens,
} from './oauth';

interface StoredTool {
	name: string;
	description: string;
	readOnly: boolean;
	execution?: 'sync' | 'async';
	effect?: PluginToolEffect;
	requiresApproval?: boolean;
	parameters: Record<string, unknown>;
}
interface StoredAccount extends Omit<PluginAccount, 'tools'> {
	tools: StoredTool[];
	credentials?: string;
	storage?: Record<string, unknown>;
}
interface Registry {
	format: 'freelm-plugins-v1';
	plugins: InstalledPlugin[];
	accounts: StoredAccount[];
}
export interface PluginHostOptions {
	directory: string;
	secrets: SecretStorage;
	openExternal: (url: string) => Promise<void>;
	fetch?: typeof fetch;
	/** Host-owned, per-call authorization. Bot mutations fail closed without an approval or this hook. */
	authorizeTool?: (
		request: PluginToolAuthorizationRequest,
		signal: AbortSignal,
	) => Promise<boolean>;
}
const MAX_REGISTRY = 16 * 1024 * 1024;
const DISCOVERY_TIMEOUT = 30_000;
const CALL_TIMEOUT = 120_000;
const record = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === 'object' && !Array.isArray(value);
function text(value: unknown, label: string, max = 256): string {
	if (
		typeof value !== 'string' ||
		!value.trim() ||
		value.length > max ||
		/[\u0000-\u001f\u007f]/.test(value)
	)
		throw new PluginFailure(`Invalid plugin ${label}.`);
	return value.trim();
}
function finite(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function jsonClone<T>(value: T, max: number): T {
	let json: string;
	try {
		json = JSON.stringify(value);
	} catch {
		throw new PluginFailure('Plugin data must be valid JSON.');
	}
	if (!json || Buffer.byteLength(json) > max)
		throw new PluginFailure('Plugin data exceeds its size limit.');
	const result = JSON.parse(json);
	const walk = (item: unknown, depth: number): void => {
		if (depth > 32) throw new PluginFailure('Plugin data is nested too deeply.');
		if (item && typeof item === 'object')
			for (const value of Object.values(item)) walk(value, depth + 1);
	};
	walk(result, 0);
	return result;
}
function identity(manifest: PluginManifest): string {
	return JSON.stringify([
		manifest.id,
		manifest.name,
		manifest.author,
		manifest.manifestVersion === 1 ? manifest.mcp : 'local',
		manifest.auth,
	]);
}
export function pluginToolName(pluginId: string, accountId: string, tool: string): string {
	const label = `${pluginId}_${tool}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 36);
	const hash = createHash('sha256')
		.update(JSON.stringify([pluginId, accountId, tool]))
		.digest('hex')
		.slice(0, 16);
	return `plugin_${label}_${hash}`;
}
function allowed(account: StoredAccount, caller: PluginCaller): boolean {
	if (!caller || !['chat', 'code', 'bot'].includes(caller.surface)) return false;
	if (caller.remote && !account.access.allowRemote) return false;
	return caller.surface === 'bot'
		? typeof caller.botId === 'string' && account.access.botIds.includes(caller.botId)
		: account.access[caller.surface];
}
function toolRecord(value: unknown): StoredTool {
	if (
		!record(value) ||
		!record(value.parameters) ||
		value.parameters.type !== 'object' ||
		typeof value.readOnly !== 'boolean'
	)
		throw new PluginFailure('Invalid plugin tool catalog.');
	if (value.execution !== undefined && value.execution !== 'sync' && value.execution !== 'async')
		throw new PluginFailure('Invalid plugin tool execution mode.');
	if (
		value.effect !== undefined &&
		!['read', 'write', 'external', 'destructive', 'unknown'].includes(String(value.effect))
	)
		throw new PluginFailure('Invalid plugin tool effect.');
	if (value.requiresApproval !== undefined && typeof value.requiresApproval !== 'boolean')
		throw new PluginFailure('Invalid plugin tool approval hint.');
	if (
		(value.readOnly && value.effect !== undefined && value.effect !== 'read') ||
		(!value.readOnly && value.effect === 'read')
	)
		throw new PluginFailure('Plugin tool effect conflicts with readOnly.');
	return {
		name: text(value.name, 'tool name'),
		description: typeof value.description === 'string' ? value.description.slice(0, 8000) : '',
		readOnly: value.readOnly,
		...(value.execution !== undefined ? { execution: value.execution as 'sync' | 'async' } : {}),
		...(value.effect !== undefined ? { effect: value.effect as PluginToolEffect } : {}),
		...(value.requiresApproval !== undefined
			? { requiresApproval: value.requiresApproval as boolean }
			: {}),
		parameters: jsonClone(value.parameters, PLUGIN_LIMITS.schemaBytes),
	};
}
function validateRegistry(value: unknown): Registry {
	if (
		!record(value) ||
		value.format !== 'freelm-plugins-v1' ||
		!Array.isArray(value.plugins) ||
		!Array.isArray(value.accounts) ||
		value.plugins.length > PLUGIN_LIMITS.plugins ||
		value.accounts.length > PLUGIN_LIMITS.accounts
	)
		throw new PluginFailure(
			'Plugin registry is invalid. Your saved registry has not been overwritten.',
		);
	const plugins = value.plugins.map((item): InstalledPlugin => {
		if (!record(item) || typeof item.enabled !== 'boolean' || !finite(item.installedAt))
			throw new PluginFailure('Invalid installed plugin record.');
		const manifest = validatePluginManifest(item.manifest);
		if (
			manifest.manifestVersion === 2 &&
			(!record(item.package) ||
				typeof item.package.hash !== 'string' ||
				!/^[a-f0-9]{64}$/.test(item.package.hash) ||
				!finite(item.package.installedBytes) ||
				item.package.installedBytes > 64 * 1024 * 1024)
		)
			throw new PluginFailure(
				'Local plugin package metadata is invalid. Reinstall its ZIP package.',
			);
		return {
			manifest,
			...(manifest.manifestVersion === 2 && manifest.runtime.apiVersion === 2
				? {
						settings: validatePluginSettings(manifest, item.settings ?? {}),
						surfaceAccess: {
							chat: record(item.surfaceAccess) && item.surfaceAccess.chat === true,
							code: record(item.surfaceAccess) && item.surfaceAccess.code === true,
						},
						grantedCapabilities: (manifest.permissions.capabilities ?? []).filter(
							(capability) =>
								Array.isArray(item.grantedCapabilities) &&
								item.grantedCapabilities.includes(capability),
						),
					}
				: {}),
			...(manifest.manifestVersion === 2
				? {
						package: {
							hash: (item.package as { hash: string }).hash,
							installedBytes: (item.package as { installedBytes: number }).installedBytes,
						},
					}
				: {}),
			enabled: item.enabled,
			installedAt: item.installedAt,
		};
	});
	if (new Set(plugins.map((plugin) => plugin.manifest.id)).size !== plugins.length)
		throw new PluginFailure('Duplicate installed plugin IDs.');
	const accounts = value.accounts.map((item): StoredAccount => {
		if (
			!record(item) ||
			!Array.isArray(item.tools) ||
			item.tools.length > PLUGIN_LIMITS.tools ||
			!['connected', 'reconnect'].includes(String(item.status)) ||
			(item.lastDiscoveredAt !== undefined && !finite(item.lastDiscoveredAt))
		)
			throw new PluginFailure('Invalid plugin account record.');
		const pluginId = text(item.pluginId, 'ID');
		const plugin = plugins.find((plugin) => plugin.manifest.id === pluginId);
		if (!plugin) throw new PluginFailure('Plugin account refers to an unavailable plugin.');
		if (
			item.credentials !== undefined &&
			(typeof item.credentials !== 'string' ||
				item.credentials.length > 128_000 ||
				!/^[A-Za-z0-9+/]+=*$/.test(item.credentials))
		)
			throw new PluginFailure('Invalid encrypted plugin credentials.');
		const tools = item.tools.map(toolRecord);
		if (new Set(tools.map((tool) => tool.name)).size !== tools.length)
			throw new PluginFailure('Duplicate plugin tool names.');
		if (item.storage !== undefined && !record(item.storage))
			throw new PluginFailure('Invalid plugin account storage.');
		const storage = item.storage === undefined ? undefined : jsonClone(item.storage, 1024 * 1024);
		if (
			storage &&
			(Object.keys(storage).length > 128 ||
				Object.keys(storage).some((key) => !/^[A-Za-z0-9_.-]{1,128}$/.test(key)))
		)
			throw new PluginFailure('Invalid plugin storage keys.');
		const access = validatePluginAccess(item.access);
		access.tools = access.tools.filter((name) => tools.some((tool) => tool.name === name));
		return {
			id: text(item.id, 'account ID'),
			pluginId,
			label: text(item.label, 'account label', 100),
			status:
				plugin.manifest.auth.type === 'oauth2' && !item.credentials
					? 'reconnect'
					: (item.status as StoredAccount['status']),
			access,
			tools,
			...(item.credentials ? { credentials: item.credentials as string } : {}),
			...(storage ? { storage } : {}),
			...(item.lastDiscoveredAt !== undefined
				? { lastDiscoveredAt: item.lastDiscoveredAt as number }
				: {}),
			// Persist only our fixed generic error, never a server-provided message.
			...(item.error
				? { error: 'This account needs attention. Reconnect or refresh its tools.' }
				: {}),
		};
	});
	if (new Set(accounts.map((account) => account.id)).size !== accounts.length)
		throw new PluginFailure('Duplicate plugin account IDs.');
	if (accounts.reduce((count, account) => count + account.access.tools.length, 0) > 64)
		throw new PluginFailure('Plugin tool grants exceed the 64-tool host limit.');
	return { format: 'freelm-plugins-v1', plugins, accounts };
}

/** Host-owned declarative connectors. No model or remote caller can install plugins or grant access. */
export class PluginHost implements PluginToolProvider {
	private state: Registry = { format: 'freelm-plugins-v1', plugins: [], accounts: [] };
	private ready?: Promise<void>;
	private writes: Promise<unknown> = Promise.resolve();
	private readonly lifetime = new AbortController();
	private readonly fetcher: typeof fetch;
	private readonly packages: PluginPackageStore;
	private connecting?: { pluginId: string; accountId?: string; controller: AbortController };
	private readonly operations = new Map<string, Set<AbortController>>();
	private readonly refreshing = new Map<string, Promise<PluginTokens>>();
	private readonly versions = new Map<string, number>();
	private readonly surfaceInvalidation = new Set<(pluginId: string) => void>();
	private readonly surfaceErrors = new Map<string, string>();
	constructor(private readonly options: PluginHostOptions) {
		this.fetcher = options.fetch ?? fetch;
		this.packages = new PluginPackageStore(options.directory);
	}
	private async load(): Promise<void> {
		this.lifetime.signal.throwIfAborted();
		this.ready ??= (async () => {
			const filename = path.join(this.options.directory, 'registry.json');
			try {
				if ((await stat(filename)).size > MAX_REGISTRY)
					throw new PluginFailure('Plugin registry exceeds its size limit.');
				this.state = validateRegistry(JSON.parse(await readFile(filename, 'utf8')));
				for (const plugin of this.state.plugins) {
					if (plugin.manifest.manifestVersion !== 2) continue;
					try {
						await this.packages.readBundle(plugin.package!.hash);
					} catch {
						plugin.enabled = false;
						for (const account of this.state.accounts.filter(
							(item) => item.pluginId === plugin.manifest.id,
						))
							account.error = 'Local plugin package is unavailable. Reinstall its ZIP package.';
					}
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
					throw new PluginFailure(
						'Could not read the plugin registry. Your saved data has not been overwritten.',
					);
			}
		})();
		await this.ready;
	}
	private async mutate(work: () => void): Promise<void> {
		const result = this.writes.then(async () => {
			await this.load();
			const before = structuredClone(this.state);
			try {
				work();
				const payload = jsonPayload(this.state);
				if (payload.bytes > MAX_REGISTRY)
					throw new PluginFailure('Plugin registry exceeds its size limit.');
				await atomicWrite(path.join(this.options.directory, 'registry.json'), payload);
			} catch (error) {
				this.state = before;
				throw error;
			}
		});
		this.writes = result.catch(() => {});
		await result;
	}
	async snapshot(): Promise<PluginSnapshot> {
		await this.load();
		await this.writes;
		return structuredClone({
			plugins: this.state.plugins.map((plugin) => ({
				...plugin,
				...(this.surfaceErrors.has(plugin.manifest.id)
					? { runtimeError: this.surfaceErrors.get(plugin.manifest.id) }
					: {}),
			})),
			accounts: this.state.accounts.map(
				({ credentials: _credentials, storage: _storage, tools, ...account }) => ({
					...account,
					tools: tools.map(({ parameters: _parameters, ...tool }) => tool),
				}),
			),
		});
	}
	async preparePackage(bytes: Uint8Array): Promise<PluginPackagePreview> {
		await this.load();
		if (
			!(bytes instanceof Uint8Array) ||
			bytes.byteLength === 0 ||
			bytes.byteLength > 8 * 1024 * 1024
		)
			throw new PluginFailure('Choose a ZIP plugin package of at most 8 MiB.');
		return this.packages.prepare(bytes);
	}
	async installPackage(reviewId: string): Promise<PluginSnapshot> {
		await this.load();
		const installed = await this.packages.consume(text(reviewId, 'package review ID'));
		this.lifetime.signal.throwIfAborted();
		const manifest = validatePluginManifest(installed.manifest);
		if (
			manifest.manifestVersion !== 2 ||
			!/^[a-f0-9]{64}$/.test(installed.hash) ||
			!finite(installed.installedBytes) ||
			installed.installedBytes > 64 * 1024 * 1024
		)
			throw new PluginFailure('Compiled local plugin package is invalid.');
		// Packages are immutable and complete before the registry can point at them.
		// An interrupted registry write leaves only an unreferenced package, never a half-installed plugin.
		await this.packages.readBundle(installed.hash);
		await this.mutate(() => {
			const existing = this.state.plugins.find((item) => item.manifest.id === manifest.id);
			if (existing) {
				this.invalidatePlugin(manifest.id);
				if (identity(existing.manifest) !== identity(manifest)) {
					this.state.accounts = this.state.accounts.filter(
						(account) => account.pluginId !== manifest.id,
					);
				} else {
					for (const account of this.state.accounts.filter(
						(account) => account.pluginId === manifest.id,
					)) {
						account.access = disabledPluginAccess();
						account.tools = manifest.contributes.tools.map(toolRecord);
						account.lastDiscoveredAt = Date.now();
						delete account.error;
					}
				}
				existing.manifest = manifest;
				existing.package = { hash: installed.hash, installedBytes: installed.installedBytes };
				if (manifest.runtime.apiVersion === 2) {
					try {
						existing.settings = validatePluginSettings(manifest, existing.settings ?? {});
					} catch {
						existing.settings = defaultPluginSettings(manifest);
					}
					existing.grantedCapabilities = [...(manifest.permissions.capabilities ?? [])];
					existing.surfaceAccess ??= { chat: true, code: true };
				}
			} else {
				if (this.state.plugins.length >= PLUGIN_LIMITS.plugins)
					throw new PluginFailure('Plugin installation limit reached.');
				this.state.plugins.push({
					manifest,
					enabled: true,
					installedAt: Date.now(),
					package: { hash: installed.hash, installedBytes: installed.installedBytes },
					...(manifest.runtime.apiVersion === 2
						? {
								settings: defaultPluginSettings(manifest),
								grantedCapabilities: [...(manifest.permissions.capabilities ?? [])],
								surfaceAccess: { chat: true, code: true },
							}
						: {}),
				});
			}
		});
		return this.snapshot();
	}
	async tabContent(pluginId: string, tabId: string): Promise<{ html: string }> {
		await this.load();
		await this.writes;
		const plugin = this.plugin(text(pluginId, 'ID'));
		const tab = text(tabId, 'tab ID');
		if (
			!plugin.enabled ||
			plugin.manifest.manifestVersion !== 2 ||
			!plugin.package ||
			!plugin.manifest.contributes.tabs.some((item) => item.id === tab)
		)
			throw new PluginFailure('Plugin tab is unavailable.');
		const hash = plugin.package.hash;
		const result = await this.packages.readTab(hash, tab);
		const current = this.plugin(pluginId);
		if (!current.enabled || current.package?.hash !== hash)
			throw new PluginFailure('Plugin changed while opening its tab. Open it again.');
		// Compiled JS/CSS is capped at 4 MiB; allow bounded headroom for HTML escaping and the CSP wrapper.
		if (typeof result.html !== 'string' || Buffer.byteLength(result.html) > 8 * 1024 * 1024)
			throw new PluginFailure('Plugin tab exceeds its size limit.');
		return result;
	}
	async invokeAction(
		pluginId: string,
		tabId: string,
		accountId: string,
		action: string,
		args: unknown,
	): Promise<unknown> {
		await this.load();
		await this.writes;
		text(pluginId, 'ID');
		text(tabId, 'tab ID');
		text(accountId, 'account ID');
		text(action, 'action name');
		const plugin = this.plugin(pluginId);
		if (
			!plugin.enabled ||
			plugin.manifest.manifestVersion !== 2 ||
			!plugin.manifest.contributes.tabs.some((tab) => tab.id === tabId) ||
			!plugin.manifest.contributes.actions.includes(action)
		)
			throw new PluginFailure('Plugin UI action is not declared by this tab’s plugin.');
		const account = this.assertAccount(accountId);
		if (account.pluginId !== pluginId)
			throw new PluginFailure('Plugin account belongs to another plugin.');
		const op = this.operation(accountId, CALL_TIMEOUT);
		try {
			return await this.runLocal(
				pluginId,
				accountId,
				'action',
				action,
				jsonClone(args, 1024 * 1024),
				op.signal,
			);
		} catch (error) {
			if (!op.signal.aborted) await this.markError(accountId, error);
			throw new PluginFailure(
				op.signal.aborted
					? 'Plugin action was cancelled, timed out, or its access changed.'
					: safePluginError(error),
			);
		} finally {
			op.release();
		}
	}
	private async localTools(plugin: InstalledPlugin): Promise<StoredTool[]> {
		if (plugin.manifest.manifestVersion !== 2 || !plugin.package)
			throw new PluginFailure('Local plugin package is unavailable.');
		await this.packages.readBundle(plugin.package.hash);
		return plugin.manifest.contributes.tools.map(toolRecord);
	}
	private async runLocal(
		pluginId: string,
		accountId: string,
		kind: 'tool' | 'action',
		name: string,
		args: unknown,
		signal: AbortSignal,
		caller?: PluginCaller,
		operationId?: string,
	): Promise<unknown> {
		if (!record(args)) throw new PluginFailure('Plugin operation arguments must be a JSON object.');
		const installed = this.plugin(pluginId);
		if (installed.manifest.manifestVersion !== 2 || !installed.package)
			throw new PluginFailure('Local plugin package is unavailable.');
		const manifest: PluginLocalManifest = installed.manifest;
		const hash = installed.package.hash;
		const version = this.versions.get(accountId) || 0;
		const controller = new AbortController();
		const abort = AbortSignal.any([signal, controller.signal]);
		const secrets = new Set<string>();
		const assertCurrent = (): StoredAccount => {
			abort.throwIfAborted();
			const plugin = this.plugin(pluginId);
			const account = this.assertAccount(accountId, caller, kind === 'tool' ? name : undefined);
			if (
				account.pluginId !== pluginId ||
				plugin.package?.hash !== hash ||
				(this.versions.get(accountId) || 0) !== version
			)
				throw new PluginFailure(
					'Plugin package or account access changed. Retry with current permissions.',
				);
			if (
				(kind === 'tool' && !manifest.contributes.tools.some((tool) => tool.name === name)) ||
				(kind === 'action' && !manifest.contributes.actions.includes(name))
			)
				throw new PluginFailure('Plugin operation is not declared.');
			return account;
		};
		const retainSecrets = (tokens: PluginTokens | undefined) => {
			if (tokens?.accessToken) secrets.add(tokens.accessToken);
			if (tokens?.refreshToken) secrets.add(tokens.refreshToken);
		};
		const clean = <T>(value: T): T => this.redact(value, [...secrets]);
		try {
			const account = assertCurrent();
			if (manifest.auth.type === 'oauth2') retainSecrets(await this.decrypt(account));
			const code = await this.packages.readBundle(hash);
			assertCurrent();
			const result = await executeLocalPlugin(
				{
					code,
					kind,
					name,
					args,
					account: { id: account.id, label: account.label },
					signal: abort,
					...(operationId ? { operationId } : {}),
				},
				async (method, raw, hostSignal) => {
					const bridgeAbort = hostSignal ? AbortSignal.any([abort, hostSignal]) : abort;
					const assertBridge = () => {
						bridgeAbort.throwIfAborted();
						return assertCurrent();
					};
					assertBridge();
					const request = jsonClone(raw, 1024 * 1024);
					if (!record(request)) throw new PluginFailure('Invalid plugin host request.');
					if (method === 'fetch') {
						let url: URL;
						try {
							url = new URL(text(request.url, 'request URL', 8192));
						} catch {
							throw new PluginFailure('Plugin request URL is invalid.');
						}
						if (
							url.username ||
							url.password ||
							url.hash ||
							!manifest.permissions.network.includes(url.origin)
						)
							throw new PluginFailure('Plugin network access is not granted for this origin.');
						const init = request.init === undefined ? {} : request.init;
						if (
							!record(init) ||
							Object.keys(init).some(
								(key) => !['method', 'headers', 'body', 'authenticated'].includes(key),
							) ||
							(init.authenticated !== undefined && typeof init.authenticated !== 'boolean')
						)
							throw new PluginFailure('Invalid plugin fetch options.');
						const verb =
							init.method === undefined
								? 'GET'
								: text(init.method, 'HTTP method', 16).toUpperCase();
						if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(verb))
							throw new PluginFailure('Plugin HTTP method is not supported.');
						const headers = new Headers();
						if (init.headers !== undefined) {
							if (
								!record(init.headers) ||
								Object.keys(init.headers).length > 64 ||
								Buffer.byteLength(JSON.stringify(init.headers)) > 16_384
							)
								throw new PluginFailure('Plugin HTTP headers exceed their limit.');
							for (const [name, value] of Object.entries(init.headers)) {
								if (
									/^(authorization|cookie|host|proxy-.*|sec-.*|connection|content-length|transfer-encoding|trailer|upgrade|te|set-cookie)$/i.test(
										name,
									) ||
									typeof value !== 'string'
								)
									throw new PluginFailure('Plugin cannot supply credential or transport headers.');
								headers.set(name, value);
							}
						}
						if (
							init.body !== undefined &&
							(typeof init.body !== 'string' ||
								Buffer.byteLength(init.body) > 1024 * 1024 ||
								verb === 'GET' ||
								verb === 'HEAD')
						)
							throw new PluginFailure('Plugin request body is invalid or exceeds its limit.');
						if (init.authenticated === true) {
							if (manifest.auth.type !== 'oauth2' || manifest.auth.apiOrigin !== url.origin)
								throw new PluginFailure(
									'Authenticated plugin requests must use the configured API origin.',
								);
							const tokens = await this.tokens(accountId);
							retainSecrets(tokens);
							assertBridge();
							if (!tokens) throw new PluginFailure('Plugin account requires sign-in.');
							headers.set('Authorization', `Bearer ${tokens.accessToken}`);
						}
						assertBridge();
						const response = await guardedFetch(
							this.fetcher,
							url.href,
							AbortSignal.any([bridgeAbort, AbortSignal.timeout(30_000)]),
							1024 * 1024,
						)(url.href, {
							method: verb,
							headers,
							...(init.body === undefined ? {} : { body: init.body as string }),
						});
						const body = await response.text();
						assertBridge();
						if (init.authenticated === true && response.status === 401)
							throw new PluginFailure(
								'Plugin account access expired. Reconnect this account.',
								true,
							);
						return clean({
							status: response.status,
							headers: Object.fromEntries(
								[...response.headers].filter(
									([name]) =>
										!/^(set-cookie|cookie|authorization|www-authenticate|proxy-authenticate)$/i.test(
											name,
										),
								),
							),
							body,
						});
					}
					if (!['storage.get', 'storage.set', 'storage.remove'].includes(method))
						throw new PluginFailure('Unsupported plugin host operation.');
					if (!manifest.permissions.storage)
						throw new PluginFailure('Plugin storage access is not granted.');
					const key = text(request.key, 'storage key', 128);
					if (!/^[A-Za-z0-9_.-]{1,128}$/.test(key))
						throw new PluginFailure('Plugin storage key is invalid.');
					if (method === 'storage.get') {
						const current = assertBridge();
						return clean(
							Object.hasOwn(current.storage || {}, key)
								? structuredClone(current.storage![key])
								: null,
						);
					}
					const value =
						method === 'storage.set' ? clean(jsonClone(request.value, 256 * 1024)) : undefined;
					await this.mutate(() => {
						const current = assertBridge();
						const storage = Object.fromEntries(
							Object.entries(current.storage || {}).filter(([storedKey]) => storedKey !== key),
						);
						if (method === 'storage.set')
							Object.defineProperty(storage, key, {
								value,
								enumerable: true,
								configurable: true,
								writable: true,
							});
						if (Object.keys(storage).length > 128)
							throw new PluginFailure('Plugin account storage is limited to 128 keys.');
						current.storage = jsonClone(storage, 1024 * 1024);
					});
					return null;
				},
			);
			assertCurrent();
			return clean(jsonClone(result, 1024 * 1024));
		} catch (error) {
			if (error instanceof PluginFailure || abort.aborted) throw error;
			const detail = clean(error instanceof Error ? error.message : 'The plugin did not complete.')
				.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
				.slice(0, 2000);
			throw new PluginFailure(`Local plugin failed: ${detail}`);
		} finally {
			controller.abort();
		}
	}
	private plugin(id: string): InstalledPlugin {
		const plugin = this.state.plugins.find((item) => item.manifest.id === id);
		if (!plugin) throw new PluginFailure('Plugin is no longer installed.');
		return plugin;
	}
	private account(id: string): StoredAccount {
		const account = this.state.accounts.find((item) => item.id === id);
		if (!account) throw new PluginFailure('Plugin account is no longer connected.');
		return account;
	}
	private invalidate(id: string, cancelConnection = true): void {
		this.versions.set(id, (this.versions.get(id) || 0) + 1);
		for (const controller of this.operations.get(id) ?? []) controller.abort();
		if (cancelConnection && this.connecting?.accountId === id) this.connecting.controller.abort();
	}
	private invalidatePlugin(id: string): void {
		for (const listener of this.surfaceInvalidation) listener(id);
		this.surfaceErrors.delete(id);
		if (this.connecting?.pluginId === id) this.connecting.controller.abort();
		for (const account of this.state.accounts.filter((account) => account.pluginId === id))
			this.invalidate(account.id);
	}
	private operation(
		id: string,
		timeout: number,
		signal?: AbortSignal,
	): { signal: AbortSignal; release(): void } {
		const controller = new AbortController();
		const set = this.operations.get(id) ?? new Set<AbortController>();
		set.add(controller);
		this.operations.set(id, set);
		return {
			signal: AbortSignal.any([
				controller.signal,
				this.lifetime.signal,
				AbortSignal.timeout(timeout),
				...(signal ? [signal] : []),
			]),
			release: () => {
				set.delete(controller);
				if (!set.size) this.operations.delete(id);
			},
		};
	}
	async command(raw: PluginCommand): Promise<PluginSnapshot> {
		await this.load();
		const command = jsonClone(raw, 96_000);
		if (!record(command) || typeof command.type !== 'string')
			throw new PluginFailure('Invalid plugin command.');
		switch (command.type) {
			case 'settings': {
				const id = text(command.pluginId, 'ID');
				await this.mutate(() => {
					const plugin = this.plugin(id);
					const values = validatePluginSettings(plugin.manifest, command.values);
					this.invalidatePlugin(id);
					plugin.settings = values;
				});
				break;
			}
			case 'surface-access': {
				const id = text(command.pluginId, 'ID');
				if (
					!record(command.surfaceAccess) ||
					typeof command.surfaceAccess.chat !== 'boolean' ||
					typeof command.surfaceAccess.code !== 'boolean'
				)
					throw new PluginFailure('Invalid plugin surface access.');
				await this.mutate(() => {
					const plugin = this.plugin(id);
					this.invalidatePlugin(id);
					plugin.surfaceAccess = {
						chat: command.surfaceAccess.chat,
						code: command.surfaceAccess.code,
					};
				});
				break;
			}
			case 'install': {
				const manifest = validatePluginManifest(command.manifest);
				if (manifest.manifestVersion !== 1)
					throw new PluginFailure('Local plugins must be installed from a reviewed ZIP package.');
				await this.mutate(() => {
					const existing = this.state.plugins.find((plugin) => plugin.manifest.id === manifest.id);
					if (existing) {
						if (identity(existing.manifest) !== identity(manifest)) {
							this.invalidatePlugin(manifest.id);
							this.state.accounts = this.state.accounts.filter(
								(account) => account.pluginId !== manifest.id,
							);
						}
						existing.manifest = manifest;
						delete existing.package;
					} else {
						if (this.state.plugins.length >= PLUGIN_LIMITS.plugins)
							throw new PluginFailure('Plugin installation limit reached.');
						this.state.plugins.push({ manifest, enabled: true, installedAt: Date.now() });
					}
				});
				break;
			}
			case 'remove': {
				const id = text(command.pluginId, 'ID');
				const removed = this.state.accounts
					.filter((account) => account.pluginId === id)
					.map((account) => ({ ...account }));
				const manifest = this.plugin(id).manifest;
				await this.mutate(() => {
					this.invalidatePlugin(id);
					this.state.accounts = this.state.accounts.filter((account) => account.pluginId !== id);
					this.state.plugins = this.state.plugins.filter((plugin) => plugin.manifest.id !== id);
				});
				await Promise.allSettled(removed.map((account) => this.revoke(manifest, account)));
				break;
			}
			case 'enable': {
				const id = text(command.pluginId, 'ID');
				if (typeof command.enabled !== 'boolean')
					throw new PluginFailure('Invalid plugin enabled setting.');
				await this.mutate(() => {
					const plugin = this.plugin(id);
					if (!command.enabled) this.invalidatePlugin(id);
					plugin.enabled = command.enabled;
				});
				break;
			}
			case 'connect':
				await this.connect(
					text(command.pluginId, 'ID'),
					text(command.label, 'account label', 100),
					command.accountId === undefined ? undefined : text(command.accountId, 'account ID'),
				);
				break;
			case 'disconnect': {
				const id = text(command.accountId, 'account ID');
				const account = { ...this.account(id) };
				const manifest = this.plugin(account.pluginId).manifest;
				await this.mutate(() => {
					this.invalidate(id);
					this.state.accounts = this.state.accounts.filter((account) => account.id !== id);
				});
				await this.revoke(manifest, account);
				break;
			}
			case 'discover':
				await this.discover(text(command.accountId, 'account ID'));
				break;
			case 'access': {
				const id = text(command.accountId, 'account ID');
				const access = validatePluginAccess(command.access);
				await this.mutate(() => {
					const account = this.account(id);
					if (
						this.state.accounts.reduce(
							(count, item) =>
								count + (item.id === id ? access.tools.length : item.access.tools.length),
							0,
						) > 64
					)
						throw new PluginFailure(
							'Grant at most 64 plugin tools across connected accounts. Remove an unused tool grant first.',
						);
					if (access.tools.some((name) => !account.tools.some((tool) => tool.name === name)))
						throw new PluginFailure('Grant access only to tools in the discovered catalog.');
					this.invalidate(id);
					account.access = access;
				});
				break;
			}
			default:
				throw new PluginFailure('Unsupported plugin command.');
		}
		return this.snapshot();
	}
	cancelConnect(): void {
		this.connecting?.controller.abort();
	}
	/** Surface sessions are installation-scoped, independent of connected service accounts. */
	onSurfaceInvalidation(listener: (pluginId: string) => void): () => void {
		this.surfaceInvalidation.add(listener);
		return () => this.surfaceInvalidation.delete(listener);
	}
	setSurfaceError(pluginId: string, error?: string): void {
		if (error) this.surfaceErrors.set(pluginId, error.slice(0, 1000));
		else this.surfaceErrors.delete(pluginId);
	}
	async surfacePackage(pluginId: string): Promise<{ plugin: InstalledPlugin; code: string }> {
		await this.load();
		await this.writes;
		const plugin = this.plugin(text(pluginId, 'ID'));
		if (
			!plugin.enabled ||
			plugin.manifest.manifestVersion !== 2 ||
			plugin.manifest.runtime.apiVersion !== 2 ||
			!plugin.package
		)
			throw new PluginFailure('This surface plugin is unavailable or disabled.');
		const hash = plugin.package.hash;
		const code = await this.packages.readBundle(hash);
		if (!plugin.enabled || plugin.package?.hash !== hash)
			throw new PluginFailure('Plugin changed during activation.');
		return { plugin: structuredClone(plugin), code };
	}
	async surfaceView(pluginId: string, viewId: string): Promise<{ html: string }> {
		const { plugin } = await this.surfacePackage(pluginId);
		const manifest = plugin.manifest as PluginLocalManifest;
		if (!manifest.contributes.views?.some((view) => view.id === viewId))
			throw new PluginFailure('This plugin view is not declared.');
		return this.packages.readTab(plugin.package!.hash, `view:${viewId}`);
	}
	private async connect(pluginId: string, label: string, accountId?: string): Promise<void> {
		if (this.connecting)
			throw new PluginFailure('Finish or cancel the current plugin connection first.');
		const plugin = this.plugin(pluginId);
		if (!plugin.enabled)
			throw new PluginFailure('Enable this plugin before connecting an account.');
		if (accountId && this.account(accountId).pluginId !== pluginId)
			throw new PluginFailure('Account belongs to another plugin.');
		if (!accountId && this.state.accounts.length >= PLUGIN_LIMITS.accounts)
			throw new PluginFailure('Plugin account limit reached.');
		const fingerprint = identity(plugin.manifest);
		const version = accountId ? this.versions.get(accountId) || 0 : 0;
		const pending = { pluginId, accountId, controller: new AbortController() };
		this.connecting = pending;
		const signal = AbortSignal.any([
			pending.controller.signal,
			this.lifetime.signal,
			AbortSignal.timeout(5 * 60_000),
		]);
		try {
			if (plugin.manifest.manifestVersion === 2) await this.localTools(plugin);
			signal.throwIfAborted();
			let credentials: string | undefined;
			if (plugin.manifest.auth.type === 'oauth2') {
				if (!(await this.options.secrets.available()))
					throw new PluginFailure(
						'Secure credential storage is unavailable. Unlock the system keychain before connecting.',
					);
				const tokens = await connectOAuth(
					plugin.manifest.auth,
					this.fetcher,
					this.options.openExternal,
					signal,
				);
				credentials = (await this.options.secrets.encrypt(JSON.stringify(tokens))).toString(
					'base64',
				);
			}
			signal.throwIfAborted();
			const id = accountId || randomUUID();
			await this.mutate(() => {
				signal.throwIfAborted();
				if (
					identity(this.plugin(pluginId).manifest) !== fingerprint ||
					!this.plugin(pluginId).enabled ||
					(accountId &&
						((this.versions.get(id) || 0) !== version ||
							!this.state.accounts.some((account) => account.id === id)))
				)
					throw new PluginFailure('Plugin settings changed during connection. Connect again.');
				const old = accountId ? this.account(accountId) : undefined;
				if (old) this.invalidate(id, false);
				const connected: StoredAccount = {
					id,
					pluginId,
					label,
					status: 'connected',
					access: disabledPluginAccess(),
					tools: [],
					...(credentials ? { credentials } : {}),
					...(plugin.manifest.manifestVersion === 2 && old?.storage
						? { storage: old.storage }
						: {}),
				};
				this.state.accounts = [
					...this.state.accounts.filter((account) => account.id !== id),
					connected,
				];
			});
			// Tokens are saved even if discovery fails; the account can retry discovery separately.
			await this.discover(id, signal);
		} catch (error) {
			throw new PluginFailure(
				signal.aborted ? 'Plugin connection was cancelled or timed out.' : safePluginError(error),
			);
		} finally {
			if (this.connecting === pending) this.connecting = undefined;
		}
	}
	private async decrypt(account: StoredAccount): Promise<PluginTokens> {
		try {
			if (!account.credentials || !(await this.options.secrets.available())) throw new Error();
			return validateTokens(
				JSON.parse(await this.options.secrets.decrypt(Buffer.from(account.credentials, 'base64'))),
			);
		} catch {
			throw new PluginFailure(
				'Plugin credentials are unavailable. Unlock secure storage or reconnect this account.',
				true,
			);
		}
	}
	private async tokens(id: string): Promise<PluginTokens | undefined> {
		const account = this.account(id);
		const manifest = this.plugin(account.pluginId).manifest;
		if (manifest.auth.type === 'none') return undefined;
		const encryptedAtRead = account.credentials;
		const previous = await this.decrypt(account);
		if (this.account(id).credentials !== encryptedAtRead) return this.tokens(id);
		if (previous.expiresAt === undefined || previous.expiresAt > Date.now() + 30_000)
			return previous;
		let pending = this.refreshing.get(id);
		if (!pending) {
			const encrypted = account.credentials;
			const fingerprint = identity(manifest);
			const op = this.operation(id, 30_000);
			pending = (async () => {
				try {
					const tokens = await refreshOAuth(
						manifest.auth as Extract<PluginManifest['auth'], { type: 'oauth2' }>,
						previous,
						this.fetcher,
						op.signal,
					);
					const ciphertext = (await this.options.secrets.encrypt(JSON.stringify(tokens))).toString(
						'base64',
					);
					await this.mutate(() => {
						op.signal.throwIfAborted();
						const current = this.account(id);
						if (
							current.credentials !== encrypted ||
							identity(this.plugin(current.pluginId).manifest) !== fingerprint
						)
							throw new PluginFailure('Plugin account changed during authorization refresh.');
						current.credentials = ciphertext;
					});
					return tokens;
				} catch (error) {
					if (!op.signal.aborted) await this.markError(id, error);
					throw error;
				} finally {
					op.release();
				}
			})();
			this.refreshing.set(id, pending);
			void pending
				.finally(() => {
					if (this.refreshing.get(id) === pending) this.refreshing.delete(id);
				})
				.catch(() => {});
		}
		return pending;
	}
	private assertAccount(id: string, caller?: PluginCaller, tool?: string): StoredAccount {
		const account = this.account(id);
		if (!this.plugin(account.pluginId).enabled || account.status !== 'connected')
			throw new PluginFailure('Plugin account is disabled or needs reconnection.');
		if (caller && (!allowed(account, caller) || (tool && !account.access.tools.includes(tool))))
			throw new PluginFailure('Plugin access is not granted for this assistant or tool.');
		return account;
	}
	private async withClient<T>(
		id: string,
		signal: AbortSignal,
		work: (client: Client, secrets: string[]) => Promise<T>,
		caller?: PluginCaller,
		tool?: string,
	): Promise<T> {
		const account = this.assertAccount(id, caller, tool);
		const manifest = this.plugin(account.pluginId).manifest;
		if (manifest.manifestVersion !== 1)
			throw new PluginFailure('This plugin uses the local runtime.');
		const version = this.versions.get(id) || 0;
		const tokens = await this.tokens(id);
		signal.throwIfAborted();
		this.assertAccount(id, caller, tool);
		if ((this.versions.get(id) || 0) !== version)
			throw new PluginFailure('Plugin access changed. Retry with the current permissions.');
		const guarded = guardedFetch(this.fetcher, manifest.mcp.url, signal);
		const fetcher: typeof fetch = async (input, init) => {
			signal.throwIfAborted();
			this.assertAccount(id, caller, tool);
			if ((this.versions.get(id) || 0) !== version)
				throw new PluginFailure('Plugin access changed.');
			const response = await guarded(input, init);
			if (response.status === 401 || response.status === 403) {
				await response.body?.cancel().catch(() => {});
				throw new PluginFailure(
					'Plugin account access was rejected by the service. Reconnect this account or check its permissions.',
					true,
				);
			}
			return response;
		};
		const transport = new StreamableHTTPClientTransport(new URL(manifest.mcp.url), {
			requestInit: { headers: tokens ? { Authorization: `Bearer ${tokens.accessToken}` } : {} },
			fetch: fetcher,
			reconnectionOptions: {
				maxRetries: 0,
				initialReconnectionDelay: 1000,
				maxReconnectionDelay: 1000,
				reconnectionDelayGrowFactor: 1,
			},
		});
		const client = new Client({ name: 'FreeLM plugins', version: '0.1.0' }, { capabilities: {} });
		const abort = () => {
			void client.close().catch(() => {});
		};
		signal.addEventListener('abort', abort, { once: true });
		try {
			await client.connect(transport, { signal, timeout: 20_000 });
			signal.throwIfAborted();
			return await work(
				client,
				[tokens?.accessToken, tokens?.refreshToken].filter((token): token is string => !!token),
			);
		} finally {
			signal.removeEventListener('abort', abort);
			await client.close().catch(() => {});
			await transport.close().catch(() => {});
		}
	}
	private redact<T>(value: T, secrets: string[]): T {
		const patterns = [
			...new Set(secrets.flatMap((secret) => [secret, JSON.stringify(secret).slice(1, -1)])),
		].sort((a, b) => b.length - a.length);
		const clean = (text: string) =>
			patterns.reduce((result, secret) => result.split(secret).join('[redacted credential]'), text);
		const visit = (item: unknown): unknown => {
			if (typeof item === 'string') return clean(item);
			if (Array.isArray(item)) return item.map(visit);
			if (item && typeof item === 'object')
				return Object.fromEntries(
					Object.entries(item).map(([key, val]) => [clean(key), visit(val)]),
				);
			return item;
		};
		return visit(value) as T;
	}
	private async markError(id: string, error: unknown): Promise<void> {
		await this.mutate(() => {
			const account = this.state.accounts.find((account) => account.id === id);
			if (!account) return;
			account.error = safePluginError(error);
			if (error instanceof PluginFailure && error.unauthorized) account.status = 'reconnect';
		}).catch(() => {});
	}
	private async discover(id: string, signal?: AbortSignal): Promise<void> {
		const op = this.operation(id, DISCOVERY_TIMEOUT, signal);
		try {
			const installed = this.plugin(this.assertAccount(id).pluginId);
			const tools =
				installed.manifest.manifestVersion === 2
					? await this.localTools(installed)
					: await this.withClient(id, op.signal, async (client, secrets) => {
							const tools: StoredTool[] = [];
							if (!client.getServerCapabilities()?.tools) return tools;
							let cursor: string | undefined;
							const seen = new Set<string>();
							do {
								const page = await client.listTools(cursor ? { cursor } : {}, {
									signal: op.signal,
									timeout: DISCOVERY_TIMEOUT,
								});
								for (const tool of page.tools) {
									if (tools.length >= PLUGIN_LIMITS.tools)
										throw new PluginFailure(
											'Plugin advertises too many tools. Limit the service catalog to 128 tools.',
										);
									if (tools.some((item) => item.name === tool.name))
										throw new PluginFailure('Plugin advertised duplicate tool names.');
									tools.push(
										toolRecord(
											this.redact(
												{
													name: tool.name,
													description: tool.description || '',
													readOnly: tool.annotations?.readOnlyHint === true,
													...(tool._meta?.['freelm/execution'] === 'sync'
														? { execution: 'sync' }
														: {}),
													...(tool.annotations?.readOnlyHint !== true &&
													tool.annotations?.destructiveHint === true
														? { effect: 'destructive' }
														: {}),
													parameters: tool.inputSchema,
												},
												secrets,
											),
										),
									);
								}
								cursor = page.nextCursor;
								if (cursor && (seen.has(cursor) || seen.size >= 15))
									throw new PluginFailure(
										'Plugin tool pagination exceeded its limit or repeated a page.',
									);
								if (cursor) seen.add(cursor);
							} while (cursor);
							return tools;
						});
			await this.mutate(() => {
				op.signal.throwIfAborted();
				const account = this.assertAccount(id);
				// Replaced schemas/semantics require renewed authorization; additions start denied.
				account.access.tools = account.access.tools.filter((name) => {
					const old = account.tools.find((tool) => tool.name === name),
						next = tools.find((tool) => tool.name === name);
					return old && next && JSON.stringify(old) === JSON.stringify(next);
				});
				account.tools = tools;
				account.lastDiscoveredAt = Date.now();
				delete account.error;
			});
		} catch (error) {
			if (!op.signal.aborted) await this.markError(id, error);
			throw new PluginFailure(safePluginError(error));
		} finally {
			op.release();
		}
	}
	async catalog(caller: PluginCaller): Promise<ToolDefinition[]> {
		await this.load();
		await this.writes;
		const tools: ToolDefinition[] = [];
		for (const account of this.state.accounts) {
			const plugin = this.plugin(account.pluginId);
			if (!plugin.enabled || account.status !== 'connected' || !allowed(account, caller)) continue;
			for (const tool of account.tools) {
				if (!account.access.tools.includes(tool.name)) continue;
				tools.push({
					name: pluginToolName(account.pluginId, account.id, tool.name),
					displayName: `${plugin.manifest.name} · ${account.label}: ${tool.name}`,
					description:
						`${plugin.manifest.name}, account ${account.label}. ${tool.description}`.slice(0, 9000),
					parameters: structuredClone(tool.parameters),
					source: 'plugin',
					readOnly: tool.readOnly,
					execution: tool.execution ?? 'async',
					effect: tool.effect ?? (tool.readOnly ? 'read' : 'unknown'),
					requiresApproval:
						caller.surface === 'bot' && (!tool.readOnly || tool.requiresApproval === true),
					deferred: false,
				});
				if (tools.length >= 64) return tools;
			}
		}
		return tools;
	}
	async execute(
		caller: PluginCaller,
		name: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
		context: PluginExecutionContext = {},
	): Promise<ToolResult> {
		await this.load();
		await this.writes;
		signal.throwIfAborted();
		if (typeof name !== 'string' || !/^plugin_[A-Za-z0-9_]{1,57}$/.test(name) || !record(args))
			throw new PluginFailure('Invalid plugin tool request.');
		const argumentsValue = jsonClone(args, 1024 * 1024);
		const operationId =
			context.operationId === undefined
				? undefined
				: text(context.operationId, 'operation ID', 256);
		let match: { account: StoredAccount; tool: StoredTool } | undefined;
		for (const account of this.state.accounts) {
			const tool = account.tools.find(
				(tool) => pluginToolName(account.pluginId, account.id, tool.name) === name,
			);
			if (tool) {
				match = { account, tool };
				break;
			}
		}
		if (!match)
			throw new PluginFailure('Plugin tool is unavailable. Refresh its catalog in Settings.');
		const { account, tool } = match;
		this.assertAccount(account.id, caller, tool.name);
		const needsApproval = !tool.readOnly || tool.requiresApproval === true;
		if (
			needsApproval &&
			(caller.surface === 'bot' || this.options.authorizeTool) &&
			context.approval?.approved !== true
		) {
			const approved =
				this.options.authorizeTool &&
				(await this.options.authorizeTool(
					{
						caller: { ...caller },
						pluginId: account.pluginId,
						accountId: account.id,
						toolName: tool.name,
						args: structuredClone(argumentsValue),
						operationId,
						effect: tool.effect ?? (tool.readOnly ? 'read' : 'unknown'),
					},
					signal,
				));
			signal.throwIfAborted();
			if (!approved)
				throw new PluginFailure(
					'This plugin action requires user approval. Tool access alone does not approve this action.',
				);
			// Settings can change while an approval sheet is pending.
			this.assertAccount(account.id, caller, tool.name);
		}
		const op = this.operation(account.id, CALL_TIMEOUT, signal);
		try {
			if (this.plugin(account.pluginId).manifest.manifestVersion === 2) {
				const result = await this.runLocal(
					account.pluginId,
					account.id,
					'tool',
					tool.name,
					argumentsValue,
					op.signal,
					caller,
					operationId,
				);
				const serialized = JSON.stringify(result);
				return {
					content: [
						{
							type: 'text',
							text:
								serialized.length > 128_000
									? `${serialized.slice(0, 128_000)}\n[Plugin result truncated.]`
									: serialized,
						},
					],
				};
			}
			return await this.withClient(
				account.id,
				op.signal,
				async (client, secrets) => {
					op.signal.throwIfAborted();
					this.assertAccount(account.id, caller, tool.name);
					const result = await client.callTool(
						{
							name: tool.name,
							arguments: argumentsValue,
							...(operationId ? { _meta: { 'freelm/operationId': operationId } } : {}),
						},
						undefined,
						{ signal: op.signal, timeout: CALL_TIMEOUT },
					);
					op.signal.throwIfAborted();
					this.assertAccount(account.id, caller, tool.name);
					return convertMCPResult(this.redact(result as Record<string, unknown>, secrets));
				},
				caller,
				tool.name,
			);
		} catch (error) {
			if (!op.signal.aborted) await this.markError(account.id, error);
			throw new PluginFailure(
				op.signal.aborted
					? 'Plugin request was cancelled, timed out, or its access changed.'
					: safePluginError(error),
			);
		} finally {
			op.release();
		}
	}
	private async revoke(manifest: PluginManifest, account: StoredAccount): Promise<void> {
		if (manifest.auth.type !== 'oauth2' || !account.credentials) return;
		try {
			await revokeOAuth(
				manifest.auth,
				await this.decrypt(account),
				this.fetcher,
				AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(5000)]),
			);
		} catch {
			/* Local disconnection always wins, even if the service is offline. */
		}
	}
	async close(): Promise<void> {
		this.cancelConnect();
		this.lifetime.abort();
		for (const set of this.operations.values()) for (const controller of set) controller.abort();
		await Promise.allSettled([...this.refreshing.values()]);
		await this.writes;
	}
}
