import type {
	PluginAccess,
	PluginManifest,
	PluginLocalManifest,
	PluginAuth,
	PluginCapability,
	PluginSettingDeclaration,
	PluginSettingValue,
	PluginSettingsValues,
	PluginModelSetting,
} from '../plugin-types';

export const PLUGIN_CAPABILITY_LABELS: Record<PluginCapability, string> = {
	'conversation.read': 'Read visible text from the current conversation',
	'inference.text': 'Send plugin-provided text to the selected inference model',
	'composer.state': 'Read composer availability and empty state',
	'composer.presentation': 'Set composer placeholders and presentation',
	'composer.read': 'Read composer draft text and selection',
	'composer.write': 'Edit composer draft text',
	'composer.attachments': 'Add and remove composer attachments',
	'composer.attachments.read': 'Read composer attachment contents',
	'composer.drawer': 'Add interactive content to the composer drawer',
	'assets.create': 'Create plugin-produced attachment assets',
	commands: 'Register commands',
	shortcuts: 'Register contextual keyboard shortcuts',
};

export const PLUGIN_LIMITS = {
	plugins: 32,
	accounts: 64,
	tools: 128,
	manifestBytes: 64_000,
	schemaBytes: 64_000,
};
const record = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === 'object' && !Array.isArray(value);
function fields(value: Record<string, unknown>, allowed: string[]): void {
	if (Object.keys(value).some((key) => !allowed.includes(key)))
		throw new Error('Plugin manifest contains unsupported fields for this API version.');
}
function string(value: unknown, label: string, max = 256): string {
	if (
		typeof value !== 'string' ||
		!value.trim() ||
		value.length > max ||
		/[\u0000-\u001f\u007f]/.test(value)
	)
		throw new Error(`Invalid plugin ${label}.`);
	return value.trim();
}
/** Endpoint URLs intentionally have no query: secrets must never be imported in manifests. */
export function pluginEndpoint(value: unknown): string {
	const raw = string(value, 'endpoint', 2048);
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error('Plugin endpoint must be an absolute HTTPS URL.');
	}
	if (url.username || url.password || url.search || url.hash)
		throw new Error('Plugin endpoints cannot contain credentials, query parameters, or fragments.');
	const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]';
	if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
		throw new Error(
			'Plugin endpoints require HTTPS; HTTP is allowed only on exact loopback addresses.',
		);
	return url.href;
}
/** Package paths are platform independent, relative, and never resolve outside the archive. */
export function pluginPackagePath(value: unknown): string {
	const pathname = string(value, 'package path', 240);
	if (
		pathname !== value ||
		pathname.startsWith('/') ||
		/[\\:%?#]/.test(pathname) ||
		pathname
			.split('/')
			.some(
				(part) =>
					!part ||
					part === '.' ||
					part === '..' ||
					part.startsWith('.') ||
					/[. ]$/.test(part) ||
					/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
			)
	)
		throw new Error('Plugin package paths must be safe relative paths.');
	return pathname;
}
export function pluginOrigin(value: unknown): string {
	const endpoint = pluginEndpoint(value);
	const url = new URL(endpoint);
	if (url.pathname !== '/')
		throw new Error('Plugin network permissions must be exact origins without paths.');
	return url.origin;
}
function identifier(value: unknown, label: string): string {
	const name = string(value, label, 80);
	if (
		!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name) ||
		['constructor', 'prototype', '__proto__'].includes(name)
	)
		throw new Error(`Invalid plugin ${label}.`);
	return name;
}
function unique<T>(items: T[], key: (item: T) => string, label: string): T[] {
	if (new Set(items.map(key)).size !== items.length) throw new Error(`Duplicate plugin ${label}.`);
	return items;
}
export function validatePluginModelSetting(value: unknown): PluginModelSetting {
	if (!record(value)) throw new Error('Invalid plugin model setting.');
	if (value.source === 'conversation') {
		fields(value, ['source']);
		return { source: 'conversation' };
	}
	if (value.source !== 'configured') throw new Error('Invalid plugin model selection source.');
	fields(value, ['source', 'hostId', 'connectionId', 'modelId', 'thinkingModeId']);
	return {
		source: 'configured',
		hostId: string(value.hostId, 'model host'),
		connectionId: string(value.connectionId, 'model connection'),
		modelId: string(value.modelId, 'model ID', 512),
		thinkingModeId: string(value.thinkingModeId, 'thinking mode'),
	};
}
function settingValue(declaration: PluginSettingDeclaration, value: unknown): PluginSettingValue {
	switch (declaration.type) {
		case 'toggle':
			if (typeof value === 'boolean') return value;
			break;
		case 'text':
			if (
				typeof value === 'string' &&
				value.length <= (declaration.maxLength ?? 8000) &&
				!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) &&
				(declaration.multiline || !/[\r\n]/.test(value))
			)
				return value;
			break;
		case 'number':
			if (
				typeof value === 'number' &&
				Number.isFinite(value) &&
				value >= declaration.min &&
				value <= declaration.max
			) {
				const steps = (value - declaration.min) / (declaration.step ?? 1);
				if (Math.abs(steps - Math.round(steps)) < 1e-8) return value;
			}
			break;
		case 'enum':
			if (typeof value === 'string' && declaration.options.some((option) => option.value === value))
				return value;
			break;
		case 'model':
			return validatePluginModelSetting(value);
	}
	throw new Error(`Invalid value for plugin setting "${declaration.label}".`);
}
function settingDeclaration(value: unknown): PluginSettingDeclaration {
	if (!record(value)) throw new Error('Invalid plugin setting declaration.');
	const base = {
		id: identifier(value.id, 'setting ID'),
		label: string(value.label, 'setting label', 120),
		...(value.description === undefined
			? {}
			: { description: string(value.description, 'setting description', 1000) }),
	};
	let declaration: PluginSettingDeclaration;
	switch (value.type) {
		case 'toggle':
			fields(value, ['id', 'label', 'description', 'type', 'default']);
			declaration = { ...base, type: 'toggle', default: value.default as boolean };
			break;
		case 'text': {
			fields(value, ['id', 'label', 'description', 'type', 'default', 'multiline', 'maxLength']);
			if (value.multiline !== undefined && typeof value.multiline !== 'boolean')
				throw new Error('Invalid plugin multiline setting.');
			const maxLength = value.maxLength ?? 8000;
			if (
				!Number.isInteger(maxLength) ||
				(maxLength as number) < 1 ||
				(maxLength as number) > 16000
			)
				throw new Error('Invalid plugin text setting limit.');
			declaration = {
				...base,
				type: 'text',
				default: value.default as string,
				maxLength: maxLength as number,
				...(value.multiline === undefined ? {} : { multiline: value.multiline }),
			};
			break;
		}
		case 'number': {
			fields(value, ['id', 'label', 'description', 'type', 'default', 'min', 'max', 'step']);
			if (
				typeof value.min !== 'number' ||
				typeof value.max !== 'number' ||
				!Number.isFinite(value.min) ||
				!Number.isFinite(value.max) ||
				value.min > value.max ||
				(value.step !== undefined &&
					(typeof value.step !== 'number' || !Number.isFinite(value.step) || value.step <= 0))
			)
				throw new Error('Invalid plugin number setting bounds.');
			declaration = {
				...base,
				type: 'number',
				default: value.default as number,
				min: value.min,
				max: value.max,
				...(value.step === undefined ? {} : { step: value.step as number }),
			};
			break;
		}
		case 'enum': {
			fields(value, ['id', 'label', 'description', 'type', 'default', 'options']);
			if (!Array.isArray(value.options) || !value.options.length || value.options.length > 64)
				throw new Error('Invalid plugin setting options.');
			const options = unique(
				value.options.map((option) => {
					if (!record(option)) throw new Error('Invalid plugin setting option.');
					fields(option, ['value', 'label']);
					return {
						value: string(option.value, 'option value', 128),
						label: string(option.label, 'option label', 120),
					};
				}),
				(option) => option.value,
				'setting options',
			);
			declaration = { ...base, type: 'enum', default: value.default as string, options };
			break;
		}
		case 'model':
			fields(value, ['id', 'label', 'description', 'type', 'default']);
			declaration = { ...base, type: 'model', default: validatePluginModelSetting(value.default) };
			break;
		default:
			throw new Error('Unsupported plugin setting type.');
	}
	settingValue(declaration, declaration.default);
	return declaration;
}
export function defaultPluginSettings(manifest: PluginManifest): PluginSettingsValues {
	return Object.fromEntries(
		manifest.manifestVersion === 2
			? (manifest.contributes.settings ?? []).map((setting) => [
					setting.id,
					structuredClone(setting.default),
				])
			: [],
	);
}
/** Missing keys receive declared defaults; unknown keys and invalid values are rejected. */
export function validatePluginSettings(
	manifest: PluginManifest,
	value: unknown,
): PluginSettingsValues {
	if (!record(value) || JSON.stringify(value).length > 64000)
		throw new Error('Invalid or oversized plugin settings.');
	const declarations = manifest.manifestVersion === 2 ? (manifest.contributes.settings ?? []) : [];
	const values = defaultPluginSettings(manifest);
	for (const [key, item] of Object.entries(value)) {
		const declaration = declarations.find((setting) => setting.id === key);
		if (!declaration) throw new Error(`Unknown plugin setting "${key}".`);
		values[key] = settingValue(declaration, item);
	}
	return values;
}
export function validatePluginManifest(value: unknown): PluginManifest {
	if (!record(value) || JSON.stringify(value).length > PLUGIN_LIMITS.manifestBytes)
		throw new Error('Invalid or oversized plugin manifest.');
	const local = value.manifestVersion === 2;
	if (!local && value.manifestVersion !== 1)
		throw new Error('Unsupported plugin manifest version.');
	fields(value, [
		'manifestVersion',
		'id',
		'name',
		'version',
		'description',
		'author',
		'homepage',
		'auth',
		...(local ? ['runtime', 'contributes', 'permissions'] : ['mcp']),
	]);
	const id = string(value.id, 'ID', 80);
	if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(id))
		throw new Error('Plugin ID must use lowercase letters, numbers, dots, or hyphens.');
	let mcp: { url: string } | undefined;
	let runtime: PluginLocalManifest['runtime'] | undefined;
	let contributes: PluginLocalManifest['contributes'] | undefined;
	let permissions: PluginLocalManifest['permissions'] | undefined;
	if (local) {
		if (!record(value.runtime) || ![1, 2].includes(value.runtime.apiVersion as number))
			throw new Error('Unsupported plugin runtime API version.');
		fields(value.runtime, ['apiVersion', 'entry']);
		runtime = {
			apiVersion: value.runtime.apiVersion as 1 | 2,
			entry: pluginPackagePath(value.runtime.entry),
		};
		const surfaceAPI = runtime.apiVersion === 2;
		if (!/\.(?:[cm]?js|jsx|tsx?)$/.test(runtime.entry))
			throw new Error('Plugin runtime entry must be JavaScript or TypeScript.');
		if (
			!record(value.permissions) ||
			typeof value.permissions.storage !== 'boolean' ||
			!Array.isArray(value.permissions.network) ||
			value.permissions.network.length > 16
		)
			throw new Error('Plugin must declare network origins and storage access.');
		fields(value.permissions, ['network', 'storage', ...(surfaceAPI ? ['capabilities'] : [])]);
		const capabilities = surfaceAPI ? (value.permissions.capabilities ?? []) : undefined;
		if (
			capabilities !== undefined &&
			(!Array.isArray(capabilities) ||
				capabilities.length > 32 ||
				capabilities.some(
					(capability) =>
						typeof capability !== 'string' || !Object.hasOwn(PLUGIN_CAPABILITY_LABELS, capability),
				))
		)
			throw new Error('Unsupported plugin capability.');
		permissions = {
			network: [...new Set(value.permissions.network.map(pluginOrigin))],
			storage: value.permissions.storage,
			...(capabilities === undefined
				? {}
				: {
						capabilities: unique(
							capabilities as PluginCapability[],
							(capability) => capability,
							'capabilities',
						),
					}),
		};
		if (!record(value.contributes)) throw new Error('Plugin must declare its contributions.');
		fields(value.contributes, [
			'tools',
			'tabs',
			'actions',
			...(surfaceAPI ? ['activation', 'settings', 'views'] : []),
		]);
		const {
			tools = surfaceAPI ? [] : undefined,
			tabs = surfaceAPI ? [] : undefined,
			actions = surfaceAPI ? [] : undefined,
		} = value.contributes;
		if (
			!Array.isArray(tools) ||
			tools.length > PLUGIN_LIMITS.tools ||
			!Array.isArray(tabs) ||
			tabs.length > 8 ||
			!Array.isArray(actions) ||
			actions.length > 128
		)
			throw new Error('Invalid or oversized plugin contributions.');
		contributes = {
			tools: unique(
				tools.map((tool) => {
					if (
						!record(tool) ||
						!record(tool.parameters) ||
						tool.parameters.type !== 'object' ||
						typeof tool.readOnly !== 'boolean'
					)
						throw new Error('Invalid plugin tool declaration.');
					fields(tool, [
						'name',
						'description',
						'parameters',
						'readOnly',
						'execution',
						'effect',
						'requiresApproval',
					]);
					if (tool.execution !== undefined && !['sync', 'async'].includes(String(tool.execution)))
						throw new Error('Invalid plugin tool execution mode.');
					if (
						tool.effect !== undefined &&
						!['read', 'write', 'external', 'destructive', 'unknown'].includes(String(tool.effect))
					)
						throw new Error('Invalid plugin tool effect.');
					if (tool.requiresApproval !== undefined && typeof tool.requiresApproval !== 'boolean')
						throw new Error('Invalid plugin tool approval hint.');
					if (
						(tool.readOnly && tool.effect !== undefined && tool.effect !== 'read') ||
						(!tool.readOnly && tool.effect === 'read')
					)
						throw new Error('Plugin tool effect conflicts with readOnly.');
					if (JSON.stringify(tool.parameters).length > PLUGIN_LIMITS.schemaBytes)
						throw new Error('Plugin tool schema is too large.');
					return {
						name: identifier(tool.name, 'tool name'),
						description: string(tool.description, 'tool description', 8000),
						parameters: tool.parameters,
						readOnly: tool.readOnly,
						...(tool.execution !== undefined
							? { execution: tool.execution as 'sync' | 'async' }
							: {}),
						...(tool.effect !== undefined
							? {
									effect: tool.effect as NonNullable<
										PluginLocalManifest['contributes']['tools'][number]['effect']
									>,
								}
							: {}),
						...(tool.requiresApproval !== undefined
							? { requiresApproval: tool.requiresApproval }
							: {}),
					};
				}),
				(tool) => tool.name,
				'tool names',
			),
			tabs: unique(
				tabs.map((tab) => {
					if (!record(tab)) throw new Error('Invalid plugin tab.');
					fields(tab, ['id', 'title', 'entry', 'icon']);
					const icon = tab.icon as PluginLocalManifest['contributes']['tabs'][number]['icon'];
					if (icon !== undefined && !['puzzle', 'mail', 'notebook', 'layout'].includes(icon))
						throw new Error('Unsupported plugin tab icon.');
					const entry = pluginPackagePath(tab.entry);
					if (!/\.(?:[cm]?js|jsx|tsx?)$/.test(entry))
						throw new Error('Plugin tab entry must be JavaScript or TypeScript.');
					return {
						id: identifier(tab.id, 'tab ID'),
						title: string(tab.title, 'tab title', 80),
						entry,
						...(icon ? { icon } : {}),
					};
				}),
				(tab) => tab.id,
				'tab IDs',
			),
			actions: unique(
				actions.map((action) => identifier(action, 'action name')),
				(action) => action,
				'actions',
			),
		};
		if (surfaceAPI) {
			if (value.contributes.activation !== undefined) {
				const activation = value.contributes.activation;
				if (!record(activation)) throw new Error('Invalid plugin activation.');
				fields(activation, ['surfaces']);
				if (
					!Array.isArray(activation.surfaces) ||
					!activation.surfaces.length ||
					activation.surfaces.length > 2 ||
					activation.surfaces.some((surface) => !['home.chat', 'home.code'].includes(surface))
				)
					throw new Error('Invalid plugin activation surfaces.');
				contributes.activation = {
					surfaces: unique(activation.surfaces, (surface) => surface, 'activation surfaces'),
				};
			}
			if (value.contributes.settings !== undefined) {
				if (!Array.isArray(value.contributes.settings) || value.contributes.settings.length > 32)
					throw new Error('Invalid plugin settings declarations.');
				contributes.settings = unique(
					value.contributes.settings.map(settingDeclaration),
					(setting) => setting.id,
					'setting IDs',
				);
			}
			if (value.contributes.views !== undefined) {
				if (!Array.isArray(value.contributes.views) || value.contributes.views.length > 8)
					throw new Error('Invalid plugin view declarations.');
				contributes.views = unique(
					value.contributes.views.map((view) => {
						if (!record(view)) throw new Error('Invalid plugin view.');
						fields(view, ['id', 'entry']);
						const entry = pluginPackagePath(view.entry);
						if (!/\.(?:[cm]?js|jsx|tsx?)$/.test(entry))
							throw new Error('Plugin view entry must be JavaScript or TypeScript.');
						return { id: identifier(view.id, 'view ID'), entry };
					}),
					(view) => view.id,
					'view IDs',
				);
			}
		}
		if (!contributes.tools.length && !contributes.tabs.length && !contributes.activation)
			throw new Error('Plugin must contribute at least one tool, tab, or surface activation.');
	} else {
		if (!record(value.mcp)) throw new Error('Plugin requires an HTTP MCP endpoint.');
		fields(value.mcp, ['url']);
		mcp = { url: pluginEndpoint(value.mcp.url) };
	}
	if (!record(value.auth)) throw new Error('Plugin must declare its authentication method.');
	let auth: PluginAuth;
	if (value.auth.type === 'none') {
		fields(value.auth, ['type']);
		auth = { type: 'none' };
	} else if (value.auth.type === 'oauth2') {
		fields(value.auth, [
			'type',
			'clientId',
			'authorizationUrl',
			'tokenUrl',
			'revocationUrl',
			'scopes',
			'resource',
			...(local ? ['apiOrigin'] : []),
		]);
		if (!Array.isArray(value.auth.scopes) || value.auth.scopes.length > 64)
			throw new Error('Plugin OAuth scopes must be a list of at most 64 values.');
		const scopes = [
			...new Set(value.auth.scopes.map((scope) => string(scope, 'OAuth scope', 512))),
		];
		if (scopes.some((scope) => /\s/.test(scope)))
			throw new Error('Each OAuth scope must be a single value.');
		const resource =
			value.auth.resource === undefined ? mcp?.url : pluginEndpoint(value.auth.resource);
		const apiOrigin = local ? pluginOrigin(value.auth.apiOrigin) : undefined;
		if (local && !permissions!.network.includes(apiOrigin!))
			throw new Error('Authenticated API origin must be a declared network origin.');
		if (resource && new URL(resource).origin !== (local ? apiOrigin : new URL(mcp!.url).origin))
			throw new Error(
				'OAuth resource must belong to the exact MCP endpoint origin or local authenticated API origin. Upstream API tokens cannot be forwarded to another service.',
			);
		auth = {
			type: 'oauth2',
			clientId: string(value.auth.clientId, 'public OAuth client ID', 512),
			authorizationUrl: pluginEndpoint(value.auth.authorizationUrl),
			tokenUrl: pluginEndpoint(value.auth.tokenUrl),
			...(value.auth.revocationUrl
				? { revocationUrl: pluginEndpoint(value.auth.revocationUrl) }
				: {}),
			scopes,
			...(resource ? { resource } : {}),
			...(apiOrigin ? { apiOrigin } : {}),
		};
	} else
		throw new Error('Unsupported plugin authentication. Use none or public OAuth 2 with PKCE.');
	const common = {
		id,
		name: string(value.name, 'name', 100),
		version: string(value.version, 'version', 64),
		description: string(value.description, 'description', 4000),
		...(value.author !== undefined ? { author: string(value.author, 'author', 200) } : {}),
		...(value.homepage !== undefined ? { homepage: pluginEndpoint(value.homepage) } : {}),
		auth,
	};
	return local
		? {
				...common,
				manifestVersion: 2,
				runtime: runtime!,
				contributes: contributes!,
				permissions: permissions!,
			}
		: { ...common, manifestVersion: 1, mcp: mcp! };
}
export function disabledPluginAccess(): PluginAccess {
	return { chat: false, code: false, botIds: [], tools: [], allowRemote: false };
}
export function validatePluginAccess(value: unknown): PluginAccess {
	if (
		!record(value) ||
		typeof value.chat !== 'boolean' ||
		typeof value.code !== 'boolean' ||
		typeof value.allowRemote !== 'boolean' ||
		!Array.isArray(value.botIds) ||
		!Array.isArray(value.tools)
	)
		throw new Error('Invalid plugin access settings.');
	if (value.botIds.length > 256 || value.tools.length > PLUGIN_LIMITS.tools)
		throw new Error('Plugin access list exceeds its limit.');
	return {
		chat: value.chat,
		code: value.code,
		allowRemote: value.allowRemote,
		botIds: [...new Set(value.botIds.map((id) => string(id, 'bot ID', 256)))],
		tools: [...new Set(value.tools.map((name) => string(name, 'tool name', 256)))],
	};
}
