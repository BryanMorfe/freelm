import type { ToolDefinition, ToolResult } from './agent-types';

interface PluginIdentity {
	id: string;
	name: string;
	version: string;
	description: string;
	author?: string;
	homepage?: string;
	auth: PluginAuth;
}
export type PluginAuth =
	| { type: 'none' }
	| {
			type: 'oauth2';
			clientId: string;
			authorizationUrl: string;
			tokenUrl: string;
			revocationUrl?: string;
			scopes: string[];
			resource?: string;
			/** Local plugins may request authenticated fetch only at this exact origin. */
			apiOrigin?: string;
	  };
export interface PluginMCPManifest extends PluginIdentity {
	manifestVersion: 1;
	mcp: { url: string };
}
export type PluginToolEffect = NonNullable<ToolDefinition['effect']>;
export interface PluginToolDeclaration {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	readOnly: boolean;
	/** Defaults to async. Use sync only for short, bounded operations. */
	execution?: 'sync' | 'async';
	/** Descriptive risk hint; readOnly and host approval remain authoritative. */
	effect?: PluginToolEffect;
	/** May require approval even when otherwise classified as read-only. */
	requiresApproval?: boolean;
}
export interface PluginTabDeclaration {
	id: string;
	title: string;
	entry: string;
	icon?: 'puzzle' | 'mail' | 'notebook' | 'layout';
}
export type PluginSurface = 'home.chat' | 'home.code';
export type PluginCapability =
	| 'conversation.read'
	| 'inference.text'
	| 'composer.state'
	| 'composer.presentation'
	| 'composer.read'
	| 'composer.write'
	| 'composer.attachments'
	| 'composer.attachments.read'
	| 'composer.drawer'
	| 'assets.create'
	| 'commands'
	| 'shortcuts';
export type PluginModelSetting =
	| { source: 'conversation' }
	| {
			source: 'configured';
			hostId: string;
			connectionId: string;
			modelId: string;
			thinkingModeId: string;
	  };
export type PluginSettingValue = string | number | boolean | PluginModelSetting;
export type PluginSettingsValues = Record<string, PluginSettingValue>;
interface PluginSettingBase {
	id: string;
	label: string;
	description?: string;
}
export type PluginSettingDeclaration = PluginSettingBase &
	(
		| { type: 'toggle'; default: boolean }
		| { type: 'text'; default: string; multiline?: boolean; maxLength?: number }
		| { type: 'number'; default: number; min: number; max: number; step?: number }
		| { type: 'enum'; default: string; options: { value: string; label: string }[] }
		| { type: 'model'; default: PluginModelSetting }
	);
/** Independently packaged source, compiled at installation and executed through the SDK. */
export interface PluginLocalManifest extends PluginIdentity {
	manifestVersion: 2;
	runtime: { apiVersion: 1 | 2; entry: string };
	contributes: {
		tools: PluginToolDeclaration[];
		tabs: PluginTabDeclaration[];
		actions: string[];
		activation?: { surfaces: PluginSurface[] };
		settings?: PluginSettingDeclaration[];
		views?: { id: string; entry: string }[];
	};
	permissions: { network: string[]; storage: boolean; capabilities?: PluginCapability[] };
}
export type PluginManifest = PluginMCPManifest | PluginLocalManifest;
export interface PluginPackagePreview {
	reviewId: string;
	manifest: PluginLocalManifest;
	files: number;
	bytes: number;
}
export interface PluginAccess {
	chat: boolean;
	code: boolean;
	botIds: string[];
	/** Exact discovered MCP tool names explicitly authorized by the user. */
	tools: string[];
	allowRemote: boolean;
}
export interface PluginToolInfo {
	name: string;
	description: string;
	/** Informational server hint only; never grants permissions. */
	readOnly: boolean;
	/** Defaults to async. Use sync only for short, bounded operations. */
	execution?: 'sync' | 'async';
	/** Descriptive risk hint; readOnly and host approval remain authoritative. */
	effect?: PluginToolEffect;
	/** May require approval even when otherwise classified as read-only. */
	requiresApproval?: boolean;
}
export interface PluginAccount {
	id: string;
	pluginId: string;
	label: string;
	status: 'connected' | 'reconnect';
	access: PluginAccess;
	tools: PluginToolInfo[];
	lastDiscoveredAt?: number;
	error?: string;
}
export interface InstalledPlugin {
	manifest: PluginManifest;
	enabled: boolean;
	installedAt: number;
	package?: { hash: string; installedBytes: number };
	settings?: PluginSettingsValues;
	grantedCapabilities?: PluginCapability[];
	surfaceAccess?: { chat: boolean; code: boolean };
	runtimeError?: string;
}
export interface PluginSnapshot {
	plugins: InstalledPlugin[];
	accounts: PluginAccount[];
}
export type PluginCommand =
	| { type: 'install'; manifest: unknown }
	| { type: 'remove'; pluginId: string }
	| { type: 'enable'; pluginId: string; enabled: boolean }
	| { type: 'settings'; pluginId: string; values: PluginSettingsValues }
	| { type: 'surface-access'; pluginId: string; surfaceAccess: { chat: boolean; code: boolean } }
	| { type: 'connect'; pluginId: string; label: string; accountId?: string }
	| { type: 'disconnect'; accountId: string }
	| { type: 'discover'; accountId: string }
	| { type: 'access'; accountId: string; access: PluginAccess };
export interface PluginBridge {
	pluginSnapshot(): Promise<PluginSnapshot>;
	pluginCommand(command: PluginCommand): Promise<PluginSnapshot>;
	pluginCancelConnect(): Promise<void>;
	pluginPreparePackage?(bytes: number[]): Promise<PluginPackagePreview>;
	pluginInstallPackage?(reviewId: string): Promise<PluginSnapshot>;
	pluginTabContent?(
		pluginId: string,
		tabId: string,
		options?: { nonce: string; theme: 'light' | 'dark' },
	): Promise<{ html: string; url?: string }>;
	pluginInvokeAction?(
		pluginId: string,
		tabId: string,
		accountId: string,
		action: string,
		args: unknown,
	): Promise<unknown>;
}
export interface PluginCaller {
	surface: 'chat' | 'code' | 'bot';
	botId?: string;
	remote?: boolean;
}
/** Host-only context. Never construct approval from model arguments or plugin-returned data. */
export interface PluginExecutionContext {
	operationId?: string;
	/** Approval of this exact tool, account, and arguments, obtained by the host. */
	approval?: { approved: true };
}
export interface PluginToolAuthorizationRequest {
	caller: PluginCaller;
	pluginId: string;
	accountId: string;
	toolName: string;
	args: Record<string, unknown>;
	operationId?: string;
	effect: PluginToolEffect;
}
export interface PluginToolProvider {
	catalog(caller: PluginCaller): Promise<ToolDefinition[]>;
	execute(
		caller: PluginCaller,
		name: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
		context?: PluginExecutionContext,
	): Promise<ToolResult>;
}
