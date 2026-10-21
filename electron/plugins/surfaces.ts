import { randomUUID } from 'node:crypto';
import type { Connection } from '../../src/types';
import type { InstalledPlugin, PluginCapability } from '../../src/plugin-types';
import type { PluginSurfaceBinding, PluginSurfaceCall, PluginSurfaceSession } from '../../src/plugin-surface-types';
import { validatePluginModelSetting } from '../../src/lib/plugin-manifest';
import { PluginHost } from './host';
import { startPluginSurfaceRuntime } from './surface-runtime';
import { generatePluginText, type PluginInferenceExecutor, type PluginInferenceModel } from './inference';
import { REQUEST_TIMEOUT_MS } from '../request-policy';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function bounded(value: unknown, limit = 1024 * 1024): unknown {
	const json = JSON.stringify(value ?? null);
	if (Buffer.byteLength(json) > limit) throw new Error('Plugin surface data exceeds its size limit.');
	return JSON.parse(json);
}
const capability: Record<string, PluginCapability> = {
	'conversation.getTurns': 'conversation.read', 'inference.generateText': 'inference.text',
	'composer.getState': 'composer.state', 'composer.readDraft': 'composer.read', 'composer.getSelection': 'composer.read',
	'composer.setText': 'composer.write', 'composer.insertText': 'composer.write', 'composer.applyEdit': 'composer.write',
	'composer.setPlaceholder': 'composer.presentation', 'composer.placeholder.update': 'composer.presentation', 'composer.placeholder.remove': 'composer.presentation',
	'composer.drawer.addItem': 'composer.drawer', 'composer.drawer.addView': 'composer.drawer', 'composer.drawer.update': 'composer.drawer', 'composer.drawer.remove': 'composer.drawer',
	'composer.attachments.add': 'composer.attachments', 'composer.attachments.remove': 'composer.attachments', 'composer.attachments.read': 'composer.attachments.read',
	'assets.create': 'assets.create', 'commands.register': 'commands', 'commands.remove': 'commands',
	'keybindings.register': 'shortcuts', 'keybindings.remove': 'shortcuts',
};
const eventPermission: Record<string, PluginCapability | undefined> = {
	'composer.changed': 'composer.state', 'composer.stateChanged': 'composer.state',
	'composer.selectionChanged': 'composer.read', 'conversation.completed': 'conversation.read',
	'conversation.changed': 'conversation.read',
	'contribution.dismissed': undefined,
};
interface Session {
	id: string; owner: number; binding: PluginSurfaceBinding; plugin: InstalledPlugin; code: string;
	controller: AbortController; runtime?: Awaited<ReturnType<typeof startPluginSurfaceRuntime>>;
	starting?: Promise<void>;
	commands: Set<string>; subscriptions: Map<string, string>; snapshots: Set<string>;
	assets: Map<string, { id: string; name: string; mimeType: string; size: number; dataUrl: string }>;
	inferenceCount: number;
	contextEpoch: number;
	events: { name: string; payload: unknown }[];
}
interface Pending { session: Session; resolve(value: unknown): void; reject(error: Error): void; cleanup(): void }
export interface PluginSurfaceHostOptions {
	plugins: PluginHost;
	emit(owner: number, call: PluginSurfaceCall): void;
	connection(hostId: string, connectionId: string): Promise<Connection | undefined>;
	execute: PluginInferenceExecutor;
	viewURL(html: string, options: { nonce: string; theme: 'light' | 'dark' }): string;
	foregroundBusy?(): boolean;
}

/** Host-owned sessions: the guest never supplies an IPC sender or another plugin's identity. */
export class PluginSurfaceHost {
	private sessions = new Map<string, Session>();
	private pending = new Map<string, Pending>();
	private inferences = 0;
	private ownerEpochs = new Map<number, number>();
	private pluginEpochs = new Map<string, number>();
	private closed = false;
	private removeInvalidation: () => void;
	constructor(private options: PluginSurfaceHostOptions) {
		this.removeInvalidation = options.plugins.onSurfaceInvalidation((id) => {
			this.pluginEpochs.set(id, (this.pluginEpochs.get(id) ?? 0) + 1);
			for (const session of this.sessions.values()) if (session.plugin.manifest.id === id) this.closeSession(session);
		});
	}
	async open(owner: number, raw: PluginSurfaceBinding): Promise<{ sessions: PluginSurfaceSession[] }> {
		if (this.closed) throw new Error('Plugin surface host is closed.');
		const binding = bounded(raw, 8192) as PluginSurfaceBinding;
		if (!binding || ![binding.id, binding.composerId, binding.workspaceId].every((s) => typeof s === 'string' && s.length > 0 && s.length <= 256) ||
			binding.surface?.kind !== 'home' || !['chat', 'code'].includes(binding.surface.mode) || !['dark', 'light'].includes(binding.theme))
			throw new Error('Invalid plugin surface binding.');
		if (binding.model !== undefined) {
			const model = validatePluginModelSetting({ source: 'configured', ...binding.model });
			if (model.source !== 'configured' || model.hostId !== binding.workspaceId) throw new Error('Plugin model belongs to a different workspace.');
			binding.model = { hostId: model.hostId, connectionId: model.connectionId, modelId: model.modelId, thinkingModeId: model.thinkingModeId };
		}
		if (binding.threadId !== undefined && (typeof binding.threadId !== 'string' || binding.threadId.length > 256)) throw new Error('Invalid conversation binding.');
		this.closeOwner(owner);
		const epoch = this.ownerEpochs.get(owner), pluginEpochs = new Map(this.pluginEpochs);
		const current = () => !this.closed && this.ownerEpochs.get(owner) === epoch;
		const snapshot = await this.options.plugins.snapshot();
		if (!current()) return { sessions: [] };
		const result: PluginSurfaceSession[] = [];
		for (const candidate of snapshot.plugins) {
			if (result.length >= 8 || this.sessions.size >= 16) break;
			const manifest = candidate.manifest;
			if (!candidate.enabled || manifest.manifestVersion !== 2 || manifest.runtime.apiVersion !== 2 ||
				!manifest.contributes.activation?.surfaces.includes(`home.${binding.surface.mode}`) || !candidate.surfaceAccess?.[binding.surface.mode]) continue;
			const pluginCurrent = () => (this.pluginEpochs.get(manifest.id) ?? 0) === (pluginEpochs.get(manifest.id) ?? 0);
			if (!pluginCurrent()) continue;
			let loaded: Awaited<ReturnType<PluginHost['surfacePackage']>>;
			try { loaded = await this.options.plugins.surfacePackage(manifest.id); }
			catch (error) {
				if (!current()) return { sessions: [] };
				if (!pluginCurrent()) continue;
				this.options.plugins.setSurfaceError(manifest.id, error instanceof Error ? error.message : String(error));
				continue;
			}
			if (!current()) return { sessions: [] };
			if (!pluginCurrent()) continue;
			const { plugin, code } = loaded;
			if (!plugin.enabled || !plugin.surfaceAccess?.[binding.surface.mode]) continue;
			const session: Session = { id: randomUUID(), owner, binding, plugin, code, controller: new AbortController(),
				commands: new Set(), subscriptions: new Map(), snapshots: new Set(), assets: new Map(), inferenceCount: 0, contextEpoch: 0, events: [] };
			this.sessions.set(session.id, session);
			result.push({ id: session.id, pluginId: manifest.id, name: manifest.name, capabilities: plugin.grantedCapabilities ?? [] });
		}
		return { sessions: result.filter(session => this.sessions.has(session.id)) };
	}
	private get(owner: number, id: string): Session {
		const session = this.sessions.get(id);
		if (!session || session.owner !== owner || session.controller.signal.aborted) throw new Error('Plugin surface session has expired.');
		return session;
	}
	async activate(owner: number, ids: string[]): Promise<void> {
		if (!Array.isArray(ids) || ids.length > 8) throw new Error('Invalid plugin activation list.');
		await Promise.all(ids.map(async (id) => {
			const session = this.get(owner, id);
			if (session.starting) return session.starting;
			this.options.plugins.setSurfaceError(session.plugin.manifest.id);
			session.starting = (async () => {
				try {
					const runtime = await startPluginSurfaceRuntime({ code: session.code, context: {
						...session.binding, plugin: { id: session.plugin.manifest.id, name: session.plugin.manifest.name },
					}, signal: session.controller.signal, onError: (error) => this.fail(session, error) },
					(method, args, signal) => this.call(session, method, args, signal ?? session.controller.signal));
					if (session.controller.signal.aborted) runtime.dispose();
					else {
						session.runtime = runtime;
						for (const event of session.events.splice(0)) runtime.event(event.name, event.payload);
					}
				} catch (error) { if (!session.controller.signal.aborted) this.fail(session, error); }
			})();
			return session.starting;
		}));
	}
	private fail(session: Session, error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		this.options.plugins.setSurfaceError(session.plugin.manifest.id, message);
		this.emit(session, '$error', { message: message.slice(0, 1000) });
		this.closeSession(session);
	}
	private emit(session: Session, method: string, args: Record<string, unknown>, requestId = '') {
		this.options.emit(session.owner, { bindingId: session.binding.id, sessionId: session.id, requestId, method, args });
	}
	private ui(session: Session, method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
		signal.throwIfAborted();
		if (this.pending.size >= 128) throw new Error('Too many pending plugin UI operations.');
		return new Promise((resolve, reject) => {
			const id = randomUUID();
			const abort = () => finish(new Error('Plugin operation cancelled.'));
			const timer = setTimeout(() => finish(new Error('Plugin UI operation timed out.')), 30000);
			const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); this.pending.delete(id); };
			const finish = (error: Error) => { cleanup(); reject(error); };
			this.pending.set(id, { session, resolve, reject, cleanup });
			signal.addEventListener('abort', abort, { once: true });
			try { this.emit(session, method, bounded(args) as Record<string, unknown>, id); }
			catch { finish(new Error('The plugin composer is unavailable.')); }
		});
	}
	reply(owner: number, sessionId: string, requestId: string, reply: unknown) {
		const pending = this.pending.get(requestId);
		if (!pending || pending.session.id !== sessionId || pending.session.owner !== owner) return;
		pending.cleanup();
		if (!object(reply)) { pending.reject(new Error('Invalid plugin UI reply.')); return; }
		if (typeof reply.error === 'string') pending.reject(new Error(reply.error.slice(0, 2000)));
		else { try { pending.resolve(bounded(reply.result)); } catch (e) { pending.reject(e as Error); } }
	}
	private require(session: Session, permission: PluginCapability) {
		if (!session.plugin.grantedCapabilities?.includes(permission)) throw new Error(`Plugin permission is required: ${permission}.`);
	}
	private async call(session: Session, method: string, raw: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
		signal.throwIfAborted();
		this.get(session.owner, session.id);
		const args = bounded(raw) as Record<string, unknown>;
		if (method === 'diagnostics.report') {
			if (typeof args.message !== 'string' || args.message.length > 4000) throw new Error('Invalid plugin diagnostic.');
			this.options.plugins.setSurfaceError(session.plugin.manifest.id, args.message);
			return null;
		}
		if (method === 'commands.run') {
			this.require(session, 'commands');
			if (typeof args.id !== 'string' || !session.commands.has(args.id)) throw new Error('Plugin command is not registered.');
			// Route through the composer so it supplies the current revision and
			// executes native declarative actions with the same atomic checks.
			return this.ui(session, method, { id: args.id, payload: object(args.payload) ? args.payload : {} }, signal);
		}
		if (method === 'settings.get') return { revision: 0, values: session.plugin.settings ?? {} };
		if (method === 'events.subscribe') {
			if (typeof args.name !== 'string' || !Object.hasOwn(eventPermission, args.name) || typeof args.id !== 'string' || session.subscriptions.size >= 64) throw new Error('Invalid plugin subscription.');
			const permission = eventPermission[args.name];
			if (permission) this.require(session, permission);
			session.subscriptions.set(args.id, args.name); return null;
		}
		if (method === 'events.remove') { session.subscriptions.delete(String(args.id)); return null; }
		const permission = capability[method];
		if (!permission) throw new Error('Unsupported plugin surface operation.');
		this.require(session, permission);
		if (method === 'conversation.getTurns') {
			if (!Number.isInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 20) throw new Error('Request between 1 and 20 conversation exchanges.');
			const epoch = session.contextEpoch;
			const result = await this.ui(session, method, args, signal);
			this.get(session.owner, session.id); signal.throwIfAborted();
			if (epoch !== session.contextEpoch) throw new Error('Conversation changed while reading. Read the current conversation again.');
			if (!object(result) || !Array.isArray(result.turns)) throw new Error('Invalid conversation snapshot.');
			const snapshotId = randomUUID();
			if (session.snapshots.size >= 32) session.snapshots.delete(session.snapshots.values().next().value!);
			session.snapshots.add(snapshotId);
			return { ...result, snapshotId };
		}
		if (method === 'inference.generateText') return this.infer(session, args, signal);
		if (method === 'assets.create') {
			if (typeof args.name !== 'string' || args.name.length > 256 || /[\x00-\x1f/\\]/.test(args.name) || typeof args.mimeType !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(args.mimeType) ||
				(typeof args.text === 'string') === (typeof args.base64 === 'string') || session.assets.size >= 16) throw new Error('Invalid plugin asset.');
			if (typeof args.base64 === 'string' && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(args.base64)) throw new Error('Invalid asset encoding.');
			const bytes = typeof args.text === 'string' ? Buffer.from(args.text) : Buffer.from(args.base64 as string, 'base64');
			if (bytes.length > 512000) throw new Error('Plugin asset exceeds 500 KiB.');
			const asset = { id: randomUUID(), name: args.name, mimeType: args.mimeType, size: bytes.length, dataUrl: `data:${args.mimeType};base64,${bytes.toString('base64')}` };
			session.assets.set(asset.id, asset);
			const { dataUrl: _data, ...handle } = asset; return handle;
		}
		if (method === 'composer.attachments.add') {
			const id = object(args.asset) ? args.asset.id : args.asset;
			const asset = session.assets.get(String(id));
			if (!asset) throw new Error('Asset does not belong to this plugin session.');
			return this.ui(session, method, { ...args, asset }, signal);
		}
		if (method === 'composer.drawer.addView') {
			const view = typeof args.view === 'string' ? args.view : '';
			const { html } = await this.options.plugins.surfaceView(session.plugin.manifest.id, view);
			this.get(session.owner, session.id); signal.throwIfAborted();
			const nonce = randomUUID();
			return this.ui(session, method, { ...args, nonce, url: this.options.viewURL(html, { nonce, theme: session.binding.theme }) }, signal);
		}
		if (method === 'commands.register') {
			if (typeof args.id !== 'string' || args.id.length > 160 || session.commands.size >= 64) throw new Error('Invalid plugin command.');
			const action = args.action ?? args.hostAction;
			if (action !== undefined) {
				this.require(session, 'composer.write');
				if (!object(action) || action.type !== 'composer.setText') throw new Error('Unsupported declarative plugin command.');
				args.action = action;
				delete args.hostAction;
			}
			const result = await this.ui(session, method, args, signal);
			session.commands.add(args.id); return result;
		}
		if (method === 'commands.remove') session.commands.delete(String(args.id));
		return this.ui(session, method, args, signal);
	}
	private async infer(session: Session, args: Record<string, unknown>, parentSignal: AbortSignal) {
		if (session.inferenceCount >= 2) throw new Error('A plugin can have at most two pending inference requests.');
		if (args.snapshotId !== undefined && !session.snapshots.has(String(args.snapshotId))) throw new Error('Conversation snapshot expired. Read the current conversation again.');
		const selection = validatePluginModelSetting(args.model ?? { source: 'conversation' });
		let model: PluginInferenceModel | undefined = session.binding.model;
		if (selection.source === 'configured') {
			const approved = Object.values(session.plugin.settings ?? {}).some((value) => object(value) && value.source === 'configured' &&
				(['hostId', 'connectionId', 'modelId', 'thinkingModeId'] as const).every((key) => value[key] === selection[key]));
			if (!approved) throw new Error('Choose this inference model in the plugin settings before using it.');
			model = { hostId: selection.hostId, connectionId: selection.connectionId, modelId: selection.modelId, thinkingModeId: selection.thinkingModeId };
		}
		if (!model) throw new Error('Select a conversation model, or choose an inference model in the plugin settings.');
		const signal = AbortSignal.any([parentSignal, session.controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
		const assertCurrent = () => {
			signal.throwIfAborted(); this.get(session.owner, session.id);
			if (args.snapshotId !== undefined && !session.snapshots.has(String(args.snapshotId))) throw new Error('Conversation snapshot expired. Read the current conversation again.');
		};
		session.inferenceCount++;
		let acquired = false;
		try {
			while (this.inferences >= 2 || this.options.foregroundBusy?.()) {
				assertCurrent();
				await new Promise<void>((resolve, reject) => {
					const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new Error('Plugin inference cancelled.')); };
					const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 100);
					signal.addEventListener('abort', abort, { once: true });
					if (signal.aborted) abort();
				});
			}
			assertCurrent(); this.inferences++; acquired = true;
			const connection = await this.options.connection(model.hostId, model.connectionId);
			assertCurrent();
			if (!connection) throw new Error('The selected plugin inference connection is unavailable.');
			const result = await generatePluginText(connection, model, { ...args, system: args.system ?? '' }, signal, this.options.execute);
			assertCurrent(); return result;
		} finally { session.inferenceCount--; if (acquired) this.inferences--; }
	}
	event(owner: number, sessionId: string, name: string, payload: unknown) {
		const session = this.get(owner, sessionId);
		if (!Object.hasOwn(eventPermission, name)) throw new Error('Invalid plugin surface event.');
		if (name === 'conversation.changed' || name === 'conversation.completed') { session.snapshots.clear(); session.contextEpoch++; }
		if (![...session.subscriptions.values()].includes(name)) return;
		const permission = eventPermission[name]; if (permission) this.require(session, permission);
		let data = bounded(payload, 16384);
		if (name === 'composer.changed' || name === 'composer.stateChanged') {
			// State permission alone never reveals draft or attachment contents.
			const allowed = ['revision', 'sequence', 'origin', 'empty', 'editable', 'focused', 'working', 'running', 'hasAttachments', 'hasReply', 'hasContext', 'pendingAttachments', 'queueEditing', 'hasCompletedTurn', 'hasQueuedMessages', 'awaitingInput'];
			data = object(data) ? Object.fromEntries(Object.entries(data).filter(([key, value]) => allowed.includes(key) && ['string', 'number', 'boolean'].includes(typeof value))) : {};
		}
		if (session.runtime) session.runtime.event(name, data);
		else {
			if (session.events.length >= 64) { this.fail(session, new Error('Plugin startup event queue exceeded its limit.')); return; }
			const prior = session.events.findIndex(event => event.name === name && name !== 'conversation.completed');
			if (prior >= 0) session.events.splice(prior, 1);
			session.events.push({ name, payload: data });
		}
	}
	command(owner: number, sessionId: string, id: string, payload: unknown) {
		const session = this.get(owner, sessionId);
		if (!session.commands.has(id)) throw new Error('Plugin command is not registered.');
		session.runtime?.command(id, bounded(payload, 8192));
	}
	viewCall(owner: number, sessionId: string, method: string, args: Record<string, unknown>) {
		const session = this.get(owner, sessionId);
		return this.call(session, method, args, session.controller.signal);
	}
	close(owner: number, ids: string[]) {
		if (!Array.isArray(ids) || ids.length > 16) throw new Error('Invalid plugin session list.');
		for (const id of ids) { const session = this.sessions.get(id); if (session?.owner === owner) this.closeSession(session); }
	}
	private closeSession(session: Session) {
		if (!this.sessions.delete(session.id)) return;
		session.controller.abort(); session.runtime?.dispose();
		for (const pending of this.pending.values()) if (pending.session === session) { pending.cleanup(); pending.reject(new Error('Plugin session closed.')); }
		session.assets.clear(); session.snapshots.clear(); session.events.length = 0;
		this.emit(session, '$disposed', {});
	}
	closeOwner(owner: number) { this.ownerEpochs.set(owner, (this.ownerEpochs.get(owner) ?? 0) + 1); for (const session of this.sessions.values()) if (session.owner === owner) this.closeSession(session); }
	closeAll() { this.closed = true; this.removeInvalidation(); for (const session of this.sessions.values()) this.closeSession(session); }
}
