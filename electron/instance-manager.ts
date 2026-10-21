import { randomBytes, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import path from 'node:path';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import type { SecretStorage } from './state-store';
import { InstanceClient, validateInstanceInput, type SshLauncher } from './instance-client';
import { InstanceHost } from './instance-host';
import type { AgentHost } from './agent-host';
import type { WorkspaceAuthority } from './workspace-authority';
import type {
	HostStatus,
	InstanceOverview,
	RemoteInstance,
	RemoteInstanceInput,
} from '../src/remote-types';
import type { AppState, WireRequest } from '../src/types';
import type { ComposerDiscoveryRequest } from '../src/composer-types';
import type { CodeSurfaceRequest } from '../src/code-surface-types';
import type { BotHost } from './bot-host';
import type {
	BotCommand,
	BotParticipant,
	BotReplyRequest,
	BotReplyActivity,
	BotTaskWatchReference,
	BotSentMessage,
	BotGroupSendRequest,
	BotGroupSendResult,
} from '../src/bot-types';
import type { BotTaskService } from './bot-task-service';
import { validateBotTaskRequest } from '../src/bot-task-types';

interface SavedProfile extends Omit<RemoteInstanceInput, 'token' | 'id'> {
	id: string;
	instanceId: string;
	encryptedToken?: string;
}
interface SavedInstances {
	format: 'freelm-instances-v1';
	instanceId: string;
	name: string;
	profiles: SavedProfile[];
}

export class InstanceManager {
	private saved!: SavedInstances;
	private ready: Promise<void>;
	private pending: Promise<void> = Promise.resolve();
	private tokens = new Map<string, string>();
	private clients = new Map<string, InstanceClient>();
	private host?: InstanceHost;
	private bots?: BotHost;
	private botTasks?: BotTaskService;
	private hostState!: HostStatus;
	private closed = false;
	private connecting = new Map<
		string,
		{ cancelled: boolean; client?: InstanceClient; controller: AbortController }
	>();

	constructor(
		private readonly filename: string,
		private readonly secrets: SecretStorage,
		private readonly authority: WorkspaceAuthority,
		private readonly launch?: SshLauncher,
		private readonly agent?: AgentHost,
	) {
		this.ready = this.initialize();
	}

	private async initialize() {
		let source: string | undefined;
		try {
			source = await readFile(this.filename, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
		if (source) {
			const data = JSON.parse(source) as SavedInstances;
			if (
				data?.format !== 'freelm-instances-v1' ||
				typeof data.instanceId !== 'string' ||
				!/^[a-zA-Z0-9-]{1,128}$/.test(data.instanceId) ||
				typeof data.name !== 'string' ||
				data.name.length > 256 ||
				!Array.isArray(data.profiles) ||
				data.profiles.length > 100 ||
				new Set(data.profiles.map((profile) => profile.id)).size !== data.profiles.length
			)
				throw new Error('Saved instance settings are invalid.');
			for (const profile of data.profiles) {
				validateInstanceInput(profile);
				if (
					!profile.id ||
					typeof profile.instanceId !== 'string' ||
					!profile.instanceId ||
					(profile.encryptedToken !== undefined && typeof profile.encryptedToken !== 'string')
				)
					throw new Error('Saved remote identity is invalid.');
				// Discard unknown disk fields, including any plaintext tokens.
				const cleaned = this.profile(profile, profile.id, profile.instanceId);
				if (profile.encryptedToken) cleaned.encryptedToken = profile.encryptedToken;
				Object.keys(profile).forEach(
					(key) => delete (profile as unknown as Record<string, unknown>)[key],
				);
				Object.assign(profile, cleaned);
			}
			this.saved = data;
		} else {
			this.saved = {
				format: 'freelm-instances-v1',
				instanceId: randomUUID(),
				name: hostname(),
				profiles: [],
			};
			await this.write();
		}
		this.hostState = {
			running: false,
			name: this.saved.name,
			instanceId: this.saved.instanceId,
			port: 4319,
		};
	}

	async status(): Promise<InstanceOverview> {
		await this.ready;
		return {
			host: { ...this.hostState },
			instances: this.saved.profiles.map((profile) => this.present(profile)),
		};
	}

	private present(profile: SavedProfile): RemoteInstance {
		return {
			id: profile.id,
			name: profile.name,
			transport: profile.transport,
			sshHost: profile.sshHost,
			port: profile.port,
			url: profile.url,
			instanceId: profile.instanceId,
			connected: this.clients.get(profile.id)?.connected ?? false,
			hasToken: this.tokens.has(profile.id) || !!profile.encryptedToken,
		};
	}

	private profile(input: RemoteInstanceInput, id: string, instanceId: string): SavedProfile {
		return {
			id,
			instanceId,
			name: input.name.trim(),
			transport: input.transport,
			...(input.transport === 'ssh'
				? { sshHost: input.sshHost!, port: input.port ?? 4319 }
				: { url: input.url! }),
		};
	}

	private async token(profile: SavedProfile) {
		const session = this.tokens.get(profile.id);
		if (session) return session;
		if (profile.encryptedToken && (await this.secrets.available())) {
			try {
				return await this.secrets.decrypt(Buffer.from(profile.encryptedToken, 'base64'));
			} catch {
				throw new Error(
					'Could not unlock the remote access token. Unlock your system keychain or enter the token again.',
				);
			}
		}
		return '';
	}

	async connect(input: RemoteInstanceInput) {
		await this.ready;
		if (this.closed) throw new Error('FreeLM is shutting down.');
		validateInstanceInput(input);
		const existing = input.id
			? this.saved.profiles.find((profile) => profile.id === input.id)
			: undefined;
		if (input.id && !existing) throw new Error('The saved instance no longer exists.');
		if (!existing && this.saved.profiles.length >= 100)
			throw new Error('Remove a saved instance before adding another.');
		const id = existing?.id ?? randomUUID();
		if (this.connecting.has(id)) throw new Error('This instance is already connecting.');
		const operation: { cancelled: boolean; client?: InstanceClient; controller: AbortController } =
			{ cancelled: false, controller: new AbortController() };
		this.connecting.set(id, operation);
		let candidate: InstanceClient | undefined;
		try {
			const token = input.token?.trim() || (existing ? await this.token(existing) : '');
			const result = await InstanceClient.connect(
				{ ...input, token },
				existing?.instanceId,
				this.launch,
				operation.controller.signal,
			);
			candidate = result.client;
			operation.client = candidate;
			if (operation.cancelled) throw new Error('Connection cancelled.');
			const snapshot = await candidate.load();
			if (this.closed) throw new Error('FreeLM is shutting down.');
			if (operation.cancelled) throw new Error('Connection cancelled.');
			const profile = this.profile(input, id, result.info.instanceId);
			if (await this.secrets.available())
				profile.encryptedToken = (await this.secrets.encrypt(token)).toString('base64');
			const oldProfiles = this.saved.profiles;
			this.saved.profiles = existing
				? this.saved.profiles.map((item) => (item.id === id ? profile : item))
				: [...this.saved.profiles, profile];
			try {
				await this.persist();
			} catch (error) {
				this.saved.profiles = oldProfiles;
				throw error;
			}
			if (operation.cancelled || this.closed) throw new Error('Connection cancelled.');
			this.tokens.set(id, token);
			this.clients.get(id)?.disconnect();
			this.clients.set(id, candidate);
			return { instance: this.present(profile), snapshot };
		} catch (error) {
			candidate?.disconnect();
			throw error;
		} finally {
			this.connecting.delete(id);
		}
	}

	async open(id: string) {
		await this.ready;
		const active = this.clients.get(id);
		if (active?.connected) return active.load();
		const profile = this.saved.profiles.find((item) => item.id === id);
		if (!profile) throw new Error('The saved instance no longer exists.');
		return (await this.connect(profile)).snapshot;
	}

	async load(id: string) {
		await this.ready;
		return this.client(id).load();
	}
	setBots(host: BotHost) {
		this.bots = host;
	}
	setBotTasks(bridge: BotTaskService) {
		this.botTasks = bridge;
	}
	async botTask(
		name: string,
		args: Record<string, unknown>,
		operationId: string,
		signal?: AbortSignal,
	) {
		await this.ready;
		const hostId = args.hostId ?? this.saved.instanceId;
		if (typeof hostId !== 'string' || !hostId)
			throw new Error('Choose a host returned by hosts_list.');
		const { hostId: _hostId, ...parameters } = args;
		let result: unknown;
		if (hostId === this.saved.instanceId || hostId === 'local') {
			if (!this.botTasks) throw new Error('Thread tools are unavailable on this host.');
			result = await this.botTasks.execute(name, parameters, operationId, signal);
		} else {
			const profile = this.saved.profiles.find(
				(item) => item.instanceId === hostId && this.clients.get(item.id)?.connected,
			);
			if (!profile)
				throw new Error('That computer is disconnected. Reconnect it before managing its threads.');
			result = await this.client(profile.id).botTask(
				validateBotTaskRequest({ id: randomUUID(), name, arguments: parameters, operationId }),
				signal,
			);
		}
		return { hostId: hostId === 'local' ? this.saved.instanceId : hostId, result };
	}
	async botsSnapshot(id: string) {
		await this.ready;
		return this.client(id).botsSnapshot();
	}
	async botsCommand(id: string, command: BotCommand) {
		await this.ready;
		return this.client(id).botsCommand(command);
	}
	async botsGroupSend(
		hostId: string,
		request: BotGroupSendRequest,
		signal?: AbortSignal,
	): Promise<BotGroupSendResult> {
		await this.ready;
		if (request.author.hostId !== this.saved.instanceId)
			throw new Error('A bot can initiate a group message only from its home computer.');
		const profile = this.saved.profiles.find(
			(item) => item.instanceId === hostId && this.clients.get(item.id)?.connected,
		);
		if (!profile) throw new Error('This group’s computer is disconnected. Reconnect it and retry.');
		return this.client(profile.id).botsGroupSend(request, signal);
	}
	async botsSteer(
		participant: BotParticipant,
		request: BotReplyRequest,
		signal?: AbortSignal,
	): Promise<boolean> {
		await this.ready;
		const profile = this.saved.profiles.find(
			(item) => item.instanceId === participant.hostId && this.clients.get(item.id)?.connected,
		);
		if (!profile)
			throw new Error('This bot’s home computer is disconnected. Reconnect it and retry.');
		return this.client(profile.id).botsSteer(request, signal);
	}
	async botsRespond(
		participant: BotParticipant,
		request: BotReplyRequest,
		signal?: AbortSignal,
		onActivity?: (activity: BotReplyActivity) => void,
		onMessage?: (message: BotSentMessage) => Promise<void>,
	) {
		await this.ready;
		const profile = this.saved.profiles.find(
			(item) => item.instanceId === participant.hostId && this.clients.get(item.id)?.connected,
		);
		if (!profile)
			throw new Error('This bot’s home computer is disconnected. Reconnect it and retry.');
		return this.client(profile.id).botsRespond(request, signal, onActivity, onMessage);
	}
	/** Poll through the bot's home computer, using only that host's task access. */
	async botsPollTask(
		participant: BotParticipant,
		watch: BotTaskWatchReference,
		signal?: AbortSignal,
	) {
		await this.ready;
		const profile = this.saved.profiles.find(
			(item) => item.instanceId === participant.hostId && this.clients.get(item.id)?.connected,
		);
		if (!profile)
			throw new Error('This bot’s home computer is disconnected. Reconnect it and retry.');
		return this.client(profile.id).botsPollTask(participant.botId, watch, signal);
	}
	async botProfile(participant: BotParticipant) {
		await this.ready;
		const profile = this.saved.profiles.find(
			(item) => item.instanceId === participant.hostId && this.clients.get(item.id)?.connected,
		);
		if (!profile)
			throw new Error('This bot’s home computer is disconnected. Reconnect it and retry.');
		const snapshot = await this.client(profile.id).botsSnapshot();
		if (snapshot.host.id !== participant.hostId)
			throw new Error('This computer returned a different bot host identity. Reconnect it.');
		const bot = snapshot.bots.find((item) => item.id === participant.botId);
		if (!bot) throw new Error('This bot is no longer available on its home computer.');
		return bot;
	}
	/** Only returned hosts are authoritative; missing hosts failed or are disconnected. */
	async connectedBotSnapshots(signal?: AbortSignal) {
		await this.ready;
		signal?.throwIfAborted();
		const profiles = this.saved.profiles.filter((item) => this.clients.get(item.id)?.connected);
		const results = await Promise.allSettled(
			profiles.map(async (item) => {
				const snapshot = await this.client(item.id).botsSnapshot(signal);
				if (snapshot.host.id !== item.instanceId)
					throw new Error('This computer returned a different bot host identity. Reconnect it.');
				return snapshot;
			}),
		);
		signal?.throwIfAborted();
		return results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
	}
	async save(id: string, revision: string, state: AppState) {
		await this.ready;
		return this.client(id).save(revision, state);
	}
	async request(
		id: string,
		request: WireRequest,
		onChunk: (text: string) => void,
		signal?: AbortSignal,
	) {
		await this.ready;
		return this.client(id).request(request, onChunk, signal);
	}
	async asset(id: string, connectionId: string, url: string, signal?: AbortSignal) {
		await this.ready;
		return this.client(id).asset(connectionId, url, signal);
	}
	async taskOutputRead(id: string, threadId: string, outputId: string) {
		await this.ready;
		return this.client(id).taskOutputRead(threadId, outputId);
	}
	async taskOutputStatus(id: string, threadId: string) {
		await this.ready;
		return this.client(id).taskOutputStatus(threadId);
	}
	async composerDiscover(id: string, request: ComposerDiscoveryRequest) {
		await this.ready;
		return this.client(id).composerDiscover(request);
	}
	async codeSurface(request: CodeSurfaceRequest) {
		await this.ready;
		return this.client(request.workspaceId).codeSurface(request);
	}
	async composerResolve(id: string, threadId: string, messageId: string) {
		await this.ready;
		return this.client(id).composerResolve(threadId, messageId);
	}
	async tools(id: string, action: 'catalog' | 'execute' | 'cancel' | 'release', input: unknown) {
		await this.ready;
		const client = this.client(id);
		if (action !== 'cancel' && !client.supportsConversationModes)
			throw new Error(
				'Update FreeLM on the remote computer to use Code tools or Chat image generation.',
			);
		return client.tools(action, input);
	}
	private client(id: string) {
		const client = this.clients.get(id);
		if (!client?.connected)
			throw new Error('The remote instance is disconnected. Reconnect to continue.');
		return client;
	}
	async disconnect(id: string) {
		await this.ready;
		const operation = this.connecting.get(id);
		if (operation) {
			operation.cancelled = true;
			operation.controller.abort();
			operation.client?.disconnect();
		}
		this.clients.get(id)?.disconnect();
		this.clients.delete(id);
	}
	async remove(id: string) {
		await this.disconnect(id);
		if (this.connecting.has(id)) throw new Error('Wait for this instance to finish connecting.');
		this.saved.profiles = this.saved.profiles.filter((profile) => profile.id !== id);
		this.tokens.delete(id);
		await this.persist();
	}

	async startHost(options: { name: string; port: number }): Promise<HostStatus> {
		await this.ready;
		if (this.closed) throw new Error('FreeLM is shutting down.');
		if (
			!options ||
			typeof options.name !== 'string' ||
			!options.name.trim() ||
			options.name.length > 256 ||
			!Number.isInteger(options.port) ||
			options.port < 1 ||
			options.port > 65535
		)
			throw new Error('Enter a host name and a port from 1 to 65535.');
		if (this.host) throw new Error('Stop hosting before changing its settings.');
		const token = randomBytes(32).toString('base64url');
		const host = new InstanceHost({
			bots: this.bots,
			botTasks: this.botTasks,
			agent: this.agent,
			authority: this.authority,
			instanceId: this.saved.instanceId,
			name: options.name.trim(),
			token,
			port: options.port,
		});
		this.host = host;
		try {
			const port = await host.start();
			this.saved.name = options.name.trim();
			await this.persist();
			this.hostState = {
				running: true,
				name: this.saved.name,
				instanceId: this.saved.instanceId,
				port,
				token,
			};
			return { ...this.hostState };
		} catch (error) {
			await host.stop();
			this.host = undefined;
			throw error;
		}
	}

	async stopHost() {
		await this.ready;
		await this.host?.stop();
		this.host = undefined;
		this.hostState = { ...this.hostState, running: false, token: undefined };
	}

	async close() {
		this.closed = true;
		await this.ready;
		for (const operation of this.connecting.values()) {
			operation.cancelled = true;
			operation.controller.abort();
			operation.client?.disconnect();
		}
		for (const client of this.clients.values()) client.disconnect();
		this.clients.clear();
		await this.stopHost();
		await this.pending;
	}

	private persist() {
		const data = JSON.stringify(this.saved);
		const next = this.pending.then(() => this.write(data));
		this.pending = next.catch(() => undefined);
		return next;
	}
	private async write(data = JSON.stringify(this.saved)) {
		await mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
		const temporary = `${this.filename}.${randomUUID()}.tmp`;
		try {
			const handle = await open(temporary, 'wx', 0o600);
			try {
				await handle.writeFile(data, 'utf8');
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(temporary, this.filename);
		} catch (error) {
			await rm(temporary, { force: true }).catch(() => {});
			throw error;
		}
	}
}
