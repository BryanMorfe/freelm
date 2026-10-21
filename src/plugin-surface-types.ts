import type { PluginCapability } from './plugin-types';

/** Internal desktop protocol. Plugin code receives only its scoped SDK context. */
export interface PluginSurfaceBinding {
	id: string;
	composerId: string;
	workspaceId: string;
	threadId?: string;
	surface: { kind: 'home'; mode: 'chat' | 'code' };
	model?: { hostId: string; connectionId: string; modelId: string; thinkingModeId: string };
	theme: 'light' | 'dark';
}
export interface PluginSurfaceSession {
	id: string;
	pluginId: string;
	name: string;
	capabilities: PluginCapability[];
}
export interface PluginSurfaceCall {
	bindingId: string;
	sessionId: string;
	requestId: string;
	method: string;
	args: Record<string, unknown>;
}
export interface PluginSurfaceBridge {
	pluginSurfaceOpen(binding: PluginSurfaceBinding): Promise<{ sessions: PluginSurfaceSession[] }>;
	pluginSurfaceActivate(sessionIds: string[]): Promise<void>;
	pluginSurfaceClose(sessionIds: string[]): Promise<void>;
	pluginSurfaceReply(
		sessionId: string,
		requestId: string,
		reply: { result?: unknown; error?: string },
	): Promise<void>;
	pluginSurfaceEvent(sessionId: string, name: string, payload: unknown): Promise<void>;
	pluginSurfaceCommand(sessionId: string, id: string, payload: unknown): Promise<void>;
	pluginSurfaceViewCall(
		sessionId: string,
		method: string,
		args: Record<string, unknown>,
	): Promise<unknown>;
	onPluginSurfaceCall(listener: (call: PluginSurfaceCall) => void): () => void;
}
