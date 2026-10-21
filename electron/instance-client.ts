import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import type { AppState, WireRequest, WireResponse } from '../src/types';
import type { RemoteInfo, RemoteInstanceInput, WorkspaceSnapshot } from '../src/remote-types';
import { validateState } from './validation';
import { validModerationWarnings } from '../src/lib/moderation-warnings';
import { isImageEditRequest } from '../src/lib/moderation-image-references';
import { mediaModerationRoute } from '../src/lib/media-moderation-guard';
import {
	REQUEST_TIMEOUT_MS,
	requestDispatcher,
	longRunningToolDispatcher,
	type RequestOptions,
} from './request-policy';
import { createSSEParser } from '../src/lib/sse';
import { createUtf8Decoder, decodeUtf8 } from '../src/lib/stream-decoder';
import type { TaskOutputReadResult, TaskOutputStatusResult } from '../src/task-output-types';
import { validateTaskOutputIds, validateTaskOutputThreadId } from './task-output-reader';
import type {
	ComposerDiscoveryRequest,
	ComposerDiscoveryResult,
	ComposerResolutionResult,
} from '../src/composer-types';
import { validateComposerDiscovery, validateComposerResolution } from './composer-context';
import type { CodeSurfaceRequest, CodeSurfaceResult } from '../src/code-surface-types';
import {
	validateCodeSurfaceRequest,
	validCodeSurfaceResult,
	CODE_SURFACE_RESPONSE_BYTES,
} from './code-surface';
import type {
	BotCommand,
	BotCommandResult,
	BotSnapshot,
	BotReplyRequest,
	BotReplyResult,
	BotReplyActivity,
	BotSentMessage,
	BotTaskWatchReference,
	BotGroupSendRequest,
	BotGroupSendResult,
} from '../src/bot-types';
import {
	validateBotSnapshot,
	validateBotReplyResult,
	validBotId,
	validBotTaskWatch,
	validBotSentMessage,
	validateBotGroupSendRequest,
	validateBotGroupSendResult,
} from '../src/lib/bots';
import type { BotTaskRequest } from '../src/bot-task-types';

const MAX_BYTES = 512 * 1024 * 1024;
const MAX_TASK_OUTPUT_RESPONSE_BYTES = 24 * 1024 * 1024;
const IMAGE_REFERENCE_FIELDS = new Set([
	'image',
	'image[]',
	'images',
	'images[]',
	'image_url',
	'image_urls',
	'input_image',
	'input_images',
	'input_reference',
	'input_references',
	'reference',
	'references',
	'reference_image',
	'reference_images',
	'referenced_image_paths',
	'num_last_images_to_include',
]);
const IMAGE_EDIT_HOST_UPDATE =
	'Update FreeLM on the remote computer to use contextual image-edit moderation. Image editing and programmatic tool orchestration require the updated host; ordinary image generation and other tools remain available.';
const VIDEO_REFERENCE_HOST_UPDATE =
	'Update FreeLM on the remote computer to use contextual video-reference moderation. Videos using reference images require the updated host; text-only video generation remains available.';

function hasImageReference(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(hasImageReference);
	if (!value || typeof value !== 'object') return false;
	return Object.entries(value).some(([key, item]) => {
		if (IMAGE_REFERENCE_FIELDS.has(key))
			return (
				item !== undefined &&
				item !== null &&
				item !== '' &&
				(!Array.isArray(item) || item.length > 0)
			);
		return hasImageReference(item);
	});
}

function imageRequestHasReferences(request: WireRequest): boolean {
	// Use the collector's classification so unsupported reference shapes cannot pass
	// to an older host that only evaluates the text. Nested known references are also
	// rejected conservatively even when the current collector cannot inspect them.
	return isImageEditRequest(request) || hasImageReference(request.body);
}

export type SshLauncher = (args: string[]) => ChildProcess;

export function validateInstanceInput(value: unknown): asserts value is RemoteInstanceInput {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('Invalid instance settings.');
	const input = value as RemoteInstanceInput;
	if (
		typeof input.name !== 'string' ||
		!input.name.trim() ||
		input.name.length > 256 ||
		(input.id !== undefined &&
			(typeof input.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.id))) ||
		(input.token !== undefined &&
			(typeof input.token !== 'string' || input.token.length > 16384 || /[\r\n]/.test(input.token)))
	)
		throw new Error('Invalid instance settings.');
	if (input.transport === 'direct') instanceUrl(input.url ?? '');
	else if (input.transport === 'ssh') {
		if (
			typeof input.sshHost !== 'string' ||
			!/^[a-zA-Z0-9_][a-zA-Z0-9_.@-]{0,254}$/.test(input.sshHost) ||
			(input.sshHost.match(/@/g)?.length ?? 0) > 1
		)
			throw new Error('Enter an SSH config alias or user@host without spaces or options.');
		if (
			input.port !== undefined &&
			(!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)
		)
			throw new Error('Invalid remote port.');
	} else throw new Error('Choose SSH or a direct connection.');
}

export function validateAssetUrl(value: unknown): asserts value is string {
	if (typeof value !== 'string' || !value || value.length > 32_768)
		throw new Error('Invalid remote media URL.');
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error('Invalid remote media URL.');
	}
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
		throw new Error('Use an HTTP or HTTPS media URL without embedded credentials.');
}

export function instanceUrl(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error('Enter a valid FreeLM instance URL.');
	}
	if (
		url.username ||
		url.password ||
		url.hash ||
		url.search ||
		(url.protocol !== 'https:' &&
			!(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
	)
		throw new Error('Use HTTPS for direct connections, or HTTP on loopback with a secure tunnel.');
	return url;
}

export function sshArguments(host: string, localPort: number, remotePort: number) {
	return [
		'-N',
		'-T',
		'-o',
		'BatchMode=yes',
		'-o',
		'StrictHostKeyChecking=yes',
		'-o',
		'ExitOnForwardFailure=yes',
		'-o',
		'ForwardAgent=no',
		'-o',
		'ServerAliveInterval=15',
		'-o',
		'ServerAliveCountMax=2',
		'-o',
		'ConnectTimeout=10',
		'-L',
		`127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
		'--',
		host,
	];
}

async function unusedPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const port = (server.address() as { port: number }).port;
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
	return port;
}

export class InstanceClient {
	private tunnel?: ChildProcess;
	private controllers = new Set<AbortController>();
	private closed = false;
	private transportError = '';
	private paired = false;
	private pairedHostId = '';
	private conversationModes = false;
	private chatMemory = false;
	private personalization = false;
	private codeCompaction = false;
	private mediaModeration = false;
	private videoFrameModeration = false;
	private videoReferenceModeration = false;
	private imageEditModeration = false;
	private basicMediaModeration = false;
	private legacyModeration: AppState['moderation'];
	private taskOutputs = false;
	private taskOutputStatuses = false;
	private composerContext = false;
	private codeSurfaceSupported = false;
	private bots = false;
	private botTasks = false;
	private botNotifications = false;
	private botActivity = false;
	private botGroups = false;
	private botGroupReadOnly = false;
	private botGroupRecollection = false;
	private botGroupOutreach = false;
	private botMemory = false;
	private botRuntime = false;
	private constructor(
		private readonly base: URL,
		private readonly token: string,
	) {}

	static async connect(
		input: RemoteInstanceInput,
		expectedId?: string,
		launch: SshLauncher = (args) => spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] }),
		signal?: AbortSignal,
	) {
		validateInstanceInput(input);
		if (!input.token?.trim()) throw new Error('Enter the access token shown by the host instance.');
		const port = input.transport === 'ssh' ? await unusedPort() : 0;
		const client = new InstanceClient(
			instanceUrl(input.transport === 'ssh' ? `http://127.0.0.1:${port}` : input.url!),
			input.token.trim(),
		);
		const cancel = () => client.disconnect();
		signal?.addEventListener('abort', cancel, { once: true });
		try {
			if (signal?.aborted) throw new Error('Connection cancelled.');
			if (input.transport === 'ssh') {
				client.tunnel = launch(sshArguments(input.sshHost!, port, input.port ?? 4319));
				let stderr = '';
				client.tunnel.stderr?.on('data', (data: Buffer) => {
					stderr = (stderr + data.toString()).slice(-4096);
				});
				client.tunnel.once('error', (error) => {
					client.transportError = `SSH could not start: ${error.message}`;
					client.disconnect();
				});
				client.tunnel.once('exit', () => {
					if (!client.closed) {
						client.transportError = `SSH connection closed. ${stderr.trim()}`;
						client.disconnect();
					}
				});
			}
			let info: RemoteInfo | undefined;
			const deadline = Date.now() + (input.transport === 'ssh' ? 15000 : 0);
			do {
				try {
					info = await client.json<RemoteInfo>('/info', 'GET', undefined, undefined, 5000);
					break;
				} catch (error) {
					if (client.closed) {
						if (client.transportError) throw new Error(client.transportError);
						if (signal?.aborted) throw new Error('Connection cancelled.');
						throw error;
					}
					if (input.transport !== 'ssh' || Date.now() >= deadline || !(error instanceof TypeError))
						throw error;
					await new Promise((resolve) => setTimeout(resolve, 150));
				}
			} while (true);
			if (
				info?.protocol !== 1 ||
				typeof info.instanceId !== 'string' ||
				!info.instanceId ||
				typeof info.name !== 'string'
			)
				throw new Error('This host does not speak the supported FreeLM instance protocol.');
			if (expectedId && info.instanceId !== expectedId)
				throw new Error(
					'This address belongs to a different FreeLM instance. Remove the saved connection before pairing with a different host.',
				);
			client.pairedHostId = info.instanceId;
			client.conversationModes = info.conversationModes === true;
			client.chatMemory = info.chatMemory === true;
			client.personalization = info.personalization === true;
			client.codeCompaction = info.codeCompaction === true;
			client.basicMediaModeration = info.mediaModeration === true;
			client.mediaModeration =
				client.basicMediaModeration &&
				info.moderationStructuredOutput === true &&
				info.moderationPolicies === 1;
			client.imageEditModeration = client.mediaModeration && info.moderationImageEdits === 1;
			client.videoFrameModeration = client.mediaModeration && info.moderationVideoFrames === 1;
			client.videoReferenceModeration =
				client.videoFrameModeration && info.moderationVideoReferences === 1;
			client.taskOutputs = info.taskOutputs === true;
			client.taskOutputStatuses = info.taskOutputStatus === true;
			client.composerContext = info.composerContext === 1;
			client.codeSurfaceSupported = info.codeSurface === 1;
			client.bots = info.bots === 1;
			client.botTasks = info.botTasks === 1;
			client.botNotifications = info.botNotifications === 1;
			client.botActivity = info.botActivity === 1;
			client.botGroups = info.botGroups === 1;
			client.botGroupReadOnly = info.botGroupReadOnly === 1;
			client.botGroupRecollection = info.botGroupRecollection === 1;
			client.botGroupOutreach = info.botGroupOutreach === 1;
			client.botMemory = info.botMemory === 1;
			client.botRuntime = info.botRuntime === 1;
			client.paired = true;
			return { client, info };
		} catch (error) {
			client.disconnect();
			throw error;
		} finally {
			signal?.removeEventListener('abort', cancel);
		}
	}

	get connected() {
		return !this.closed;
	}
	get supportsConversationModes() {
		return this.conversationModes;
	}

	disconnect() {
		this.closed = true;
		for (const controller of this.controllers) controller.abort();
		this.controllers.clear();
		this.tunnel?.kill();
		this.tunnel = undefined;
	}

	private async fetch(
		path: string,
		method: string,
		body?: unknown,
		signal?: AbortSignal,
		timeout = REQUEST_TIMEOUT_MS,
		accept?: string,
	) {
		if (this.closed)
			throw new Error(
				this.transportError || 'The remote instance is disconnected. Reconnect to continue.',
			);
		const controller = new AbortController();
		this.controllers.add(controller);
		const url = new URL(this.base);
		url.pathname = `${url.pathname.replace(/\/+$/, '')}${path}`;
		try {
			const options: RequestOptions = {
				method,
				headers: {
					Authorization: `Bearer ${this.token}`,
					...(accept ? { Accept: accept } : {}),
					...(this.botRuntime && (path === '/bots' || path.startsWith('/bots/'))
						? { 'X-FreeLM-Bot-Runtime': '1' }
						: {}),
					...(this.botGroupOutreach && path.startsWith('/bots/')
						? { 'X-FreeLM-Bot-Group-Outreach': '1' }
						: {}),
					...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				redirect: 'error',
				dispatcher: timeout === 0 ? longRunningToolDispatcher : requestDispatcher,
				signal: AbortSignal.any([
					controller.signal,
					...(timeout > 0 ? [AbortSignal.timeout(timeout)] : []),
					...(signal ? [signal] : []),
				]),
			};
			const response = await fetch(url, options);
			return { response, finish: () => this.controllers.delete(controller) };
		} catch (error) {
			this.controllers.delete(controller);
			if (this.paired && error instanceof TypeError) this.disconnect();
			throw error;
		}
	}

	private async json<T>(
		path: string,
		method: string,
		body?: unknown,
		signal?: AbortSignal,
		timeout?: number,
		maxBytes = MAX_BYTES,
	): Promise<T> {
		const { response, finish } = await this.fetch(path, method, body, signal, timeout);
		try {
			const text = await readBody(response, maxBytes);
			let data: unknown;
			try {
				data = JSON.parse(text);
			} catch {
				throw new Error('The remote instance returned an invalid response.');
			}
			if (!response.ok) {
				if (response.status === 401) this.disconnect();
				throw new Error(
					(data as { error?: string })?.error ||
						`Remote instance returned HTTP ${response.status}.`,
				);
			}
			return data as T;
		} finally {
			finish();
		}
	}

	async botsSnapshot(signal?: AbortSignal): Promise<BotSnapshot> {
		if (!this.bots) throw new Error('Update FreeLM on this computer to use Bots.');
		const snapshot = await this.json<BotSnapshot>(
			'/bots',
			'GET',
			undefined,
			signal,
			15_000,
			80 * 1024 * 1024,
		);
		validateBotSnapshot(snapshot);
		return this.botSnapshotCapabilities(snapshot);
	}
	private botSnapshotCapabilities(snapshot: BotSnapshot): BotSnapshot {
		return {
			...snapshot,
			memorySupported: this.botMemory,
			runtimeSupported: this.botRuntime,
			...(this.botRuntime ? {} : { jobs: undefined }),
			bots: this.botMemory
				? snapshot.bots
				: snapshot.bots.map((bot) => ({ ...bot, memoryEnabled: false })),
		};
	}
	async botTask(request: BotTaskRequest, signal?: AbortSignal): Promise<unknown> {
		if (!this.botTasks)
			throw new Error('Update FreeLM on this computer to let bots manage its threads.');
		return this.json('/bots/task', 'POST', request, signal, 95_000, 512 * 1024);
	}
	async botsCommand(command: BotCommand): Promise<BotCommandResult> {
		if (!this.bots) throw new Error('Update FreeLM on this computer to use Bots.');
		if (!this.botRuntime && ['job-approve', 'job-deny', 'job-cancel'].includes(command.type))
			throw new Error('Update FreeLM on this bot’s home computer to manage background jobs.');
		if (!this.botMemory && (command.type === 'update-memory' || command.type === 'delete-memory'))
			throw new Error('Update FreeLM on this bot’s home computer to manage persistent memories.');
		if (
			!this.botGroups &&
			(command.type === 'stop' ||
				(command.type === 'create-conversation' && command.participants.length > 1) ||
				((command.type === 'send' || command.type === 'edit') && !!command.mentions?.length) ||
				(command.type === 'update-conversation' &&
					(!!command.draftMentions?.length || command.groupReplyLimit !== undefined)))
		)
			throw new Error(
				'Update FreeLM on this conversation’s computer to use group mentions and reply controls.',
			);
		// New renderers include empty mention arrays even in DMs; older peers reject unknown keys.
		const compatibleCommand = { ...command };
		if (!this.botMemory) {
			if (compatibleCommand.type === 'create-bot') {
				compatibleCommand.profile = { ...compatibleCommand.profile };
				delete compatibleCommand.profile.memoryEnabled;
			} else if (compatibleCommand.type === 'update-bot') {
				compatibleCommand.changes = { ...compatibleCommand.changes };
				delete compatibleCommand.changes.memoryEnabled;
			}
		}
		if (!this.botGroups) {
			if ('mentions' in compatibleCommand) delete compatibleCommand.mentions;
			if ('draftMentions' in compatibleCommand) delete compatibleCommand.draftMentions;
		}
		const result = await this.json<BotCommandResult>(
			'/bots/command',
			'POST',
			compatibleCommand,
			undefined,
			30_000,
			80 * 1024 * 1024,
		);
		validateBotSnapshot(result?.snapshot);
		return { ...result, snapshot: this.botSnapshotCapabilities(result.snapshot) };
	}
	async botsGroupSend(
		request: BotGroupSendRequest,
		signal?: AbortSignal,
	): Promise<BotGroupSendResult> {
		validateBotGroupSendRequest(request);
		if (!this.bots || !this.botGroupOutreach)
			throw new Error(
				'Update FreeLM on this group’s computer to let bots initiate group messages.',
			);
		const result = await this.json<BotGroupSendResult>(
			'/bots/group-send',
			'POST',
			request,
			signal,
			30_000,
			4096,
		);
		validateBotGroupSendResult(result);
		if (result.hostId !== this.pairedHostId || result.conversationId !== request.conversationId)
			throw new Error('The remote host returned a receipt for a different group.');
		return result;
	}
	private assertGroupOutreachReply(request: BotReplyRequest) {
		if (
			!this.botGroupOutreach &&
			request.messages.some(
				(message) => message.id === request.userMessageId && message.groupOutreach,
			)
		)
			throw new Error(
				'Update FreeLM on this bot’s home computer to receive bot-initiated group messages.',
			);
	}
	async botsSteer(request: BotReplyRequest, signal?: AbortSignal): Promise<boolean> {
		this.assertGroupOutreachReply(request);
		// Legacy hosts retain their existing queued-message behavior.
		if (!this.bots || !this.botRuntime) return false;
		const result = await this.json<{ accepted: boolean }>(
			'/bots/steer',
			'POST',
			request,
			signal,
			30_000,
			4096,
		);
		if (!result || typeof result.accepted !== 'boolean')
			throw new Error('The remote host returned an invalid bot steering result.');
		return result.accepted;
	}
	async botsRespond(
		request: BotReplyRequest,
		signal?: AbortSignal,
		onActivity?: (activity: BotReplyActivity) => void,
		onMessage?: (message: BotSentMessage) => Promise<void>,
	): Promise<BotReplyResult> {
		if (!this.bots) throw new Error('Update FreeLM on this computer to use Bots.');
		this.assertGroupOutreachReply(request);
		if (!this.botRuntime && request.notification?.type === 'job')
			throw new Error(
				'Update FreeLM on this bot’s home computer to receive background job updates.',
			);
		if ((request.group || request.notification?.type === 'group_message') && !this.botGroups)
			throw new Error(
				'Update FreeLM on this bot’s home computer to participate in group conversations with mentions and optional replies.',
			);
		if (
			!this.botGroupReadOnly &&
			((request.notification?.type === 'group_message' && request.notification.readOnly) ||
				request.messages.some(
					(message) =>
						message.notification?.type === 'group_message' && message.notification.readOnly,
				))
		)
			throw new Error(
				'Update FreeLM on this bot’s home computer to receive group follow-ups that preserve reaction permissions.',
			);
		if (request.notification && !this.botNotifications)
			throw new Error(
				'Update FreeLM on this bot’s home computer to receive reaction and task notifications.',
			);
		// Older group-aware peers reject additional group fields. Keep their normal reply path,
		// while only upgraded hosts retain source-qualified group recollections.
		let compatibleRequest =
			request.group?.source && !this.botGroupRecollection
				? { ...request, group: { participants: request.group.participants } }
				: request;
		if (!this.botRuntime)
			compatibleRequest = {
				...compatibleRequest,
				source: undefined,
				messages: compatibleRequest.messages.map((message) => {
					if (message.notification?.type !== 'job') return message;
					const { notification: _notification, ...rest } = message;
					return rest;
				}),
			};
		if ((this.botActivity && onActivity) || (this.botRuntime && onMessage))
			return this.botsRespondStream(compatibleRequest, signal, onActivity, onMessage);
		const result = await this.json<BotReplyResult>(
			'/bots/respond',
			'POST',
			compatibleRequest,
			signal,
			REQUEST_TIMEOUT_MS,
			1024 * 1024,
		);
		validateBotReplyResult(result, request);
		await deliverBotMessages(result.messages ?? [], onMessage);
		return result;
	}
	/** Explicit texts are separate messages, delivered before the final result and deduplicated on replay. */
	private async botsRespondStream(
		request: BotReplyRequest,
		signal: AbortSignal | undefined,
		onActivity?: (activity: BotReplyActivity) => void,
		onMessage?: (message: BotSentMessage) => Promise<void>,
	): Promise<BotReplyResult> {
		const { response, finish } = await this.fetch(
			'/bots/respond',
			'POST',
			request,
			signal,
			REQUEST_TIMEOUT_MS,
			'text/event-stream',
		);
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		try {
			if (
				!response.ok ||
				!/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')
			) {
				const text = await readBody(response, 1024 * 1024);
				let value: unknown;
				try {
					value = JSON.parse(text);
				} catch {
					throw new Error('The remote bot returned an invalid response.');
				}
				if (!response.ok) {
					if (response.status === 401) this.disconnect();
					throw new Error(
						value &&
							typeof value === 'object' &&
							'error' in value &&
							typeof value.error === 'string'
							? value.error
							: `Remote instance returned HTTP ${response.status}.`,
					);
				}
				// A host may have been downgraded since pairing; JSON stays compatible without
				// inventing a writing phase that was never observed.
				validateBotReplyResult(value, request);
				await deliverBotMessages(value.messages ?? [], onMessage);
				return value;
			}
			if (Number(response.headers.get('content-length')) > 1024 * 1024)
				throw new Error('Remote bot response is too large.');
			reader = response.body?.getReader();
			if (!reader) throw new Error('The remote bot returned an empty stream.');
			let result: BotReplyResult | undefined;
			let bytes = 0;
			let previous: BotReplyActivity | undefined;
			const delivered = new Map<string, string>();
			const pendingMessages: BotSentMessage[] = [];
			const enqueue = (message: unknown) => {
				if (!validBotSentMessage(message))
					throw new Error('The remote bot returned an invalid explicit message.');
				const serialized = JSON.stringify([message.id, message.content, message.createdAt]);
				if (delivered.has(message.id)) {
					if (delivered.get(message.id) !== serialized)
						throw new Error('The remote bot changed an already delivered message.');
					return;
				}
				if (delivered.size >= 100) throw new Error('The remote bot sent too many messages.');
				delivered.set(message.id, serialized);
				pendingMessages.push(message);
			};
			const flushMessages = async () => {
				while (pendingMessages.length) {
					const message = pendingMessages.shift()!;
					await onMessage?.(message);
				}
			};
			const parser = createSSEParser((data, event) => {
				if (result) throw new Error('The remote bot sent data after its final reply.');
				let value: unknown;
				try {
					value = JSON.parse(data);
				} catch {
					throw new Error('The remote bot returned malformed activity data.');
				}
				if (event === 'result') {
					validateBotReplyResult(value, request);
					for (const message of value.messages ?? []) enqueue(message);
					result = value;
				} else if (event === 'message' && this.botRuntime) {
					enqueue(value);
				} else if (
					event === 'activity' &&
					value &&
					typeof value === 'object' &&
					!Array.isArray(value) &&
					Object.keys(value).length === 1 &&
					'activity' in value &&
					(value.activity === 'queued' ||
						value.activity === 'thinking' ||
						value.activity === 'writing')
				) {
					if (value.activity !== previous) onActivity?.(value.activity);
					previous = value.activity;
				} else if (
					event === 'error' &&
					value &&
					typeof value === 'object' &&
					!Array.isArray(value) &&
					Object.keys(value).length === 1 &&
					'message' in value &&
					typeof value.message === 'string' &&
					value.message.length <= 4096
				)
					throw new Error(value.message || 'The remote bot could not reply.');
				else throw new Error('The remote bot returned invalid activity data.');
			});
			const decoder = createUtf8Decoder('remote instance');
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				bytes += value.byteLength;
				if (bytes > 1024 * 1024) throw new Error('Remote bot response is too large.');
				parser.push(decoder.push(value));
				await flushMessages();
			}
			parser.push(decoder.finish());
			parser.finish();
			await flushMessages();
			if (!result) throw new Error('The remote connection ended before the bot reply completed.');
			return result;
		} catch (error) {
			if (reader) await reader.cancel().catch(() => {});
			else await response.body?.cancel().catch(() => {});
			throw error;
		} finally {
			reader?.releaseLock();
			finish();
		}
	}
	async botsPollTask(
		botId: string,
		watch: BotTaskWatchReference,
		signal?: AbortSignal,
	): Promise<unknown> {
		if (!this.bots || !this.botNotifications)
			throw new Error('Update FreeLM on this bot’s home computer to watch its tasks.');
		if (!validBotId(botId) || !validBotTaskWatch(watch))
			throw new Error('Choose a valid bot and task to watch.');
		return this.json('/bots/watch', 'POST', { botId, watch }, signal, 95_000, 512 * 1024);
	}

	async load(): Promise<WorkspaceSnapshot> {
		const snapshot = await this.json<WorkspaceSnapshot>('/workspace', 'GET');
		if (!snapshot || typeof snapshot.revision !== 'string' || !snapshot.revision)
			throw new Error('Invalid remote workspace revision.');
		if (snapshot.state !== null) {
			validateState(snapshot.state);
			for (const connection of snapshot.state.connections) connection.apiKey = '';
			if (!this.chatMemory)
				snapshot.state.memorySettings = { savedMemories: false, referenceHistory: false };
			if (!this.codeCompaction) delete snapshot.state.codeCompaction;
			// Older moderation hosts cannot offer the current policy contract. Keep their saved
			// policy intact while allowing unrelated workspace changes to synchronize.
			this.legacyModeration =
				!this.mediaModeration && this.basicMediaModeration
					? structuredClone(snapshot.state.moderation)
					: undefined;
			if (!this.mediaModeration) delete snapshot.state.moderation;
		}
		return {
			...snapshot,
			memorySupported: this.chatMemory,
			personalizationSupported: this.personalization,
			codeCompactionSupported: this.codeCompaction,
			moderationSupported: this.mediaModeration,
			taskOutputsSupported: this.taskOutputs,
			taskOutputStatusSupported: this.taskOutputStatuses,
			composerContextSupported: this.composerContext,
			codeSurfaceSupported: this.codeSurfaceSupported,
		};
	}

	async save(revision: string, state: AppState) {
		validateState(state);
		if (!this.personalization && state.personalization !== undefined)
			throw new Error('Update this remote FreeLM instance to use personalization.');
		if (!this.codeCompaction && state.codeCompaction !== undefined)
			throw new Error('Update this remote FreeLM instance to configure Code compaction.');
		if (!this.mediaModeration && state.moderation !== undefined)
			throw new Error('Update this remote FreeLM instance to configure media moderation.');
		if (
			!this.chatMemory &&
			(state.savedMemories?.length ||
				state.threads.some((thread) => thread.memorySummary) ||
				state.memorySettings?.savedMemories ||
				state.memorySettings?.referenceHistory)
		)
			throw new Error('Update this remote FreeLM instance to use Chat memory.');
		// API credentials belong to the host and are never copied through workspace synchronization.
		const copy = structuredClone(state);
		if (!this.mediaModeration && this.basicMediaModeration && this.legacyModeration !== undefined)
			copy.moderation = structuredClone(this.legacyModeration);
		for (const connection of copy.connections) connection.apiKey = '';
		if (!this.chatMemory) {
			delete copy.memorySettings;
			delete copy.savedMemories;
			for (const thread of copy.threads) delete thread.memorySummary;
		}
		const result = await this.json<{ revision: string }>('/workspace', 'PUT', {
			revision,
			state: copy,
		});
		if (!result || typeof result.revision !== 'string' || !result.revision)
			throw new Error('Invalid remote workspace revision.');
		return result;
	}

	async asset(connectionId: string, url: string, signal?: AbortSignal): Promise<WireResponse> {
		validateAssetUrl(url);
		return this.json<WireResponse>('/asset', 'POST', { connectionId, url }, signal);
	}
	async taskOutputRead(threadId: string, outputId: string): Promise<TaskOutputReadResult> {
		validateTaskOutputIds(threadId, outputId);
		if (!this.taskOutputs)
			throw new Error(
				'Update FreeLM on the remote computer to preview and download task output files.',
			);
		const result = await this.json<TaskOutputReadResult>(
			'/task-output',
			'POST',
			{ threadId, outputId },
			undefined,
			30_000,
			MAX_TASK_OUTPUT_RESPONSE_BYTES,
		);
		if (!validTaskOutputRead(result, outputId))
			throw new Error('The remote instance returned invalid task output data.');
		return result;
	}
	async taskOutputStatus(threadId: string): Promise<TaskOutputStatusResult> {
		validateTaskOutputThreadId(threadId);
		if (!this.taskOutputStatuses)
			throw new Error(
				'Update FreeLM on the remote computer to verify which task output files still exist.',
			);
		const result = await this.json<TaskOutputStatusResult>(
			'/task-output-status',
			'POST',
			{ threadId },
			undefined,
			30_000,
			MAX_TASK_OUTPUT_RESPONSE_BYTES,
		);
		if (!validTaskOutputStatus(result, threadId))
			throw new Error('The remote instance returned invalid task output status data.');
		return result;
	}
	async codeSurface(request: CodeSurfaceRequest): Promise<CodeSurfaceResult> {
		validateCodeSurfaceRequest(request);
		if (!this.codeSurfaceSupported)
			throw new Error('Update FreeLM on the remote computer to use the Code workspace surface.');
		const result = await this.json<CodeSurfaceResult>(
			'/code-surface',
			'POST',
			{ ...request, workspaceId: 'local' },
			undefined,
			30_000,
			CODE_SURFACE_RESPONSE_BYTES,
		);
		if (!validCodeSurfaceResult(result, request))
			throw new Error('The remote computer returned invalid Code surface data.');
		return result;
	}
	async composerDiscover(request: ComposerDiscoveryRequest): Promise<ComposerDiscoveryResult> {
		validateComposerDiscovery(request);
		if (!this.composerContext)
			throw new Error(
				'Update FreeLM on the remote computer to use workspace and skill mentions in the Code composer.',
			);
		const result = await this.json<ComposerDiscoveryResult>(
			'/composer/discover',
			'POST',
			{ ...request, workspaceId: 'local' },
			undefined,
			10_000,
			256 * 1024,
		);
		if (!validComposerDiscoveryResult(result))
			throw new Error('The remote computer returned invalid composer suggestions.');
		return result;
	}
	async composerResolve(threadId: string, messageId: string): Promise<ComposerResolutionResult> {
		validateComposerResolution(threadId, messageId);
		if (!this.composerContext)
			throw new Error(
				'Update FreeLM on the remote computer to use workspace and skill mentions in the Code composer.',
			);
		const result = await this.json<ComposerResolutionResult>(
			'/composer/resolve',
			'POST',
			{ threadId, messageId },
			undefined,
			10_000,
			2 * 1024 * 1024,
		);
		if (
			!result ||
			typeof result.instructions !== 'string' ||
			result.instructions.length > 1_000_000 ||
			!validComposerWarnings(result.warnings)
		)
			throw new Error('The remote computer returned invalid composer context.');
		return result;
	}
	async tools(action: 'catalog' | 'execute' | 'cancel' | 'release', input: unknown): Promise<any> {
		const unsupportedMediaTools = new Set([
			'image_gen',
			'image_gen.imagegen',
			'video_gen.videogen',
			'functions.exec',
		]);
		const videoCall =
			action === 'execute' &&
			!!input &&
			typeof input === 'object' &&
			(input as { name?: string }).name === 'video_gen.videogen';
		if (videoCall && !this.videoFrameModeration)
			throw new Error(
				'Update FreeLM on the remote computer to generate videos with frame-based moderation.',
			);
		if (
			videoCall &&
			!this.videoReferenceModeration &&
			hasImageReference((input as { arguments?: unknown }).arguments)
		)
			throw new Error(VIDEO_REFERENCE_HOST_UPDATE);
		if (
			action === 'execute' &&
			!this.mediaModeration &&
			input &&
			typeof input === 'object' &&
			unsupportedMediaTools.has((input as { name?: string }).name ?? '')
		)
			throw new Error(
				'Update FreeLM on the remote computer to use moderated image generation or programmatic tool orchestration.',
			);
		if (action === 'execute' && !this.imageEditModeration && input && typeof input === 'object') {
			const call = input as { name?: string; arguments?: unknown };
			if (
				call.name === 'functions.exec' ||
				call.name === 'functions.wait' ||
				((call.name === 'image_gen' || call.name === 'image_gen.imagegen') &&
					hasImageReference(call.arguments))
			)
				throw new Error(IMAGE_EDIT_HOST_UPDATE);
		}
		const result = await this.json<any>(
			`/tools/${action}`,
			'POST',
			input,
			undefined,
			videoCall ? 0 : REQUEST_TIMEOUT_MS,
		);
		if (action === 'catalog' && !this.mediaModeration && result && Array.isArray(result.tools)) {
			const warning =
				'Image generation and programmatic tool orchestration are unavailable until FreeLM on the remote computer is updated to support media moderation. Other tools remain available.';
			return {
				...result,
				tools: Array.isArray(result.tools)
					? result.tools.filter(
							(tool: { name?: string }) => !unsupportedMediaTools.has(tool?.name ?? ''),
						)
					: result.tools,
				warnings: [...(Array.isArray(result.warnings) ? result.warnings : []), warning],
				instructions: [typeof result.instructions === 'string' ? result.instructions : '', warning]
					.filter(Boolean)
					.join('\n\n'),
			};
		}
		if (
			action === 'catalog' &&
			!this.videoFrameModeration &&
			result &&
			Array.isArray(result.tools)
		) {
			result.tools = result.tools.filter(
				(tool: { name?: string }) => tool?.name !== 'video_gen.videogen',
			);
		}
		if (
			action === 'catalog' &&
			this.videoFrameModeration &&
			!this.videoReferenceModeration &&
			result &&
			Array.isArray(result.tools) &&
			result.tools.some((tool: { name?: string }) => tool?.name === 'video_gen.videogen')
		) {
			result.warnings = [
				...(Array.isArray(result.warnings) ? result.warnings : []),
				VIDEO_REFERENCE_HOST_UPDATE,
			];
			result.instructions = [
				typeof result.instructions === 'string' ? result.instructions : '',
				VIDEO_REFERENCE_HOST_UPDATE,
			]
				.filter(Boolean)
				.join('\n\n');
		}
		if (action === 'catalog' && !this.imageEditModeration && result && Array.isArray(result.tools))
			return {
				...result,
				tools: result.tools.filter(
					(tool: { name?: string }) =>
						tool?.name !== 'functions.exec' && tool?.name !== 'functions.wait',
				),
				warnings: [
					...(Array.isArray(result.warnings) ? result.warnings : []),
					IMAGE_EDIT_HOST_UPDATE,
				],
				instructions: [
					typeof result.instructions === 'string' ? result.instructions : '',
					IMAGE_EDIT_HOST_UPDATE,
				]
					.filter(Boolean)
					.join('\n\n'),
			};
		return result;
	}

	async request(
		request: WireRequest,
		onChunk: (text: string) => void,
		signal?: AbortSignal,
	): Promise<WireResponse> {
		const route = decodeURIComponent(request.path.split('?')[0])
			.replace(/^\/v1(?=\/)/, '')
			.replace(/\/+$/, '');
		const mediaRoute = mediaModerationRoute(request);
		if (!this.mediaModeration && mediaRoute)
			throw new Error(
				'Update FreeLM on the remote computer before generating media. This host does not support media moderation.',
			);
		if (!this.videoFrameModeration && mediaRoute?.kind === 'video')
			throw new Error(
				'Update FreeLM on the remote computer to generate videos with frame-based moderation.',
			);
		if (
			!this.videoReferenceModeration &&
			mediaRoute?.kind === 'video' &&
			mediaRoute.input &&
			imageRequestHasReferences(request)
		)
			throw new Error(VIDEO_REFERENCE_HOST_UPDATE);

		if (
			!this.imageEditModeration &&
			request.method === 'POST' &&
			(route === '/images/edits' ||
				(route === '/images/generations' && imageRequestHasReferences(request)))
		)
			throw new Error(IMAGE_EDIT_HOST_UPDATE);
		if (!request.connectionId) throw new Error('Select an API connection on the remote workspace.');
		const { response, finish } = await this.fetch(
			'/request',
			'POST',
			{
				id: request.id,
				connectionId: request.connectionId,
				path: request.path,
				method: request.method,
				body: request.body,
				form: request.form,
				stream: request.stream,
			},
			signal,
			// Each provider call retains its timeout on the host; sequential frame
			// moderation must not inherit one total inference deadline here.
			mediaRoute?.kind === 'video' ? 0 : REQUEST_TIMEOUT_MS,
		);
		const reader = response.body?.getReader();
		let pending = '',
			bytes = 0,
			lineNumber = 0,
			result: WireResponse | undefined;
		const decoder = createUtf8Decoder('remote instance');
		const consume = (line: string) => {
			lineNumber += 1;
			if (!line.trim()) return;
			let envelope;
			try {
				envelope = JSON.parse(line);
			} catch {
				throw new Error(
					`The remote instance returned malformed stream data at line ${lineNumber} (${line.length} characters). Reconnect and retry.`,
				);
			}
			if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope))
				throw new Error(`Invalid remote response envelope at line ${lineNumber}.`);
			if (envelope.type === 'chunk' && typeof envelope.text === 'string') onChunk(envelope.text);
			else if (envelope.type === 'response' && validResponse(envelope.response))
				result = envelope.response;
			else if (envelope.type === 'error')
				throw new Error(
					typeof envelope.message === 'string' ? envelope.message : 'Remote request failed.',
				);
			else throw new Error(`Invalid remote response envelope at line ${lineNumber}.`);
		};
		try {
			if (!response.ok)
				throw new Error(
					`Remote request failed (HTTP ${response.status}). Reconnect if the host token changed.`,
				);
			if (!reader) throw new Error('The remote instance returned an empty stream.');
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				bytes += value.byteLength;
				if (bytes > MAX_BYTES) throw new Error('The remote response exceeded the 512 MB limit.');
				pending += decoder.push(value);
				let index: number;
				while ((index = pending.indexOf('\n')) >= 0) {
					consume(pending.slice(0, index));
					pending = pending.slice(index + 1);
				}
			}
			consume(pending + decoder.finish());
			if (!result) throw new Error('The remote connection ended before the request completed.');
			if (
				result.status >= 200 &&
				result.status < 300 &&
				request.path.startsWith('/images/') &&
				result.encoding === 'text'
			) {
				let json;
				try {
					json = JSON.parse(result.body);
				} catch {
					throw new Error('The remote instance returned invalid image response data.');
				}
				if (!json || typeof json !== 'object' || Array.isArray(json))
					throw new Error('The remote instance returned invalid image response data.');
				if (Array.isArray(json.data))
					for (const item of json.data) {
						if (typeof item.url === 'string' && /^https?:\/\//i.test(item.url) && !item.b64_json) {
							const asset = await this.asset(request.connectionId, item.url, signal);
							if (
								!validResponse(asset) ||
								asset.encoding !== 'base64' ||
								!/^image\//i.test(asset.contentType) ||
								asset.status < 200 ||
								asset.status >= 300
							)
								throw new Error('The host could not retrieve the generated image.');
							item.url = `data:${asset.contentType.split(';')[0]};base64,${asset.body}`;
						}
					}
				result = { ...result, body: JSON.stringify(json) };
			}
			return result;
		} catch (error) {
			await reader?.cancel().catch(() => {});
			throw error;
		} finally {
			reader?.releaseLock();
			finish();
		}
	}
}

function validResponse(value: unknown): value is WireResponse {
	const response = value as WireResponse;
	return (
		!!response &&
		Number.isInteger(response.status) &&
		typeof response.contentType === 'string' &&
		typeof response.body === 'string' &&
		['text', 'base64'].includes(response.encoding) &&
		(response.moderationWarnings === undefined ||
			validModerationWarnings(response.moderationWarnings))
	);
}

function validTaskOutputRead(value: TaskOutputReadResult, id: string) {
	const bounded = (value: unknown, max: number): value is string =>
		typeof value === 'string' && value.length <= max;
	const fileUrl = (value: unknown) =>
		bounded(value, 12 * 1024 * 1024) &&
		/^data:application\/octet-stream;base64,[A-Za-z0-9+/]*={0,2}$/.test(value);
	const preview = value?.preview;
	return (
		!!value &&
		value.id === id &&
		bounded(value.name, 4096) &&
		bounded(value.path, 4096) &&
		(value.size === undefined || (Number.isSafeInteger(value.size) && value.size >= 0)) &&
		(value.mimeType === undefined || bounded(value.mimeType, 128)) &&
		(value.unavailable === undefined || bounded(value.unavailable, 4096)) &&
		(value.downloadUrl === undefined || fileUrl(value.downloadUrl)) &&
		(!preview ||
			(preview.kind === 'text' &&
				bounded(preview.text, 256 * 1024 + 1) &&
				typeof preview.truncated === 'boolean') ||
			(preview.kind === 'image' &&
				bounded(preview.dataUrl, 12 * 1024 * 1024) &&
				/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(preview.dataUrl)))
	);
}

function validTaskOutputStatus(value: unknown, threadId: string): value is TaskOutputStatusResult {
	const record = (item: unknown): item is Record<string, unknown> =>
		!!item && typeof item === 'object' && !Array.isArray(item);
	const bounded = (item: unknown, max: number): item is string =>
		typeof item === 'string' && item.length <= max;
	const safe = (item: unknown, max: number): item is string =>
		bounded(item, max) && !!item && !/[\u0000-\u001f\u007f]/.test(item);
	if (
		!record(value) ||
		Object.keys(value).some(
			(key) => !['threadId', 'files', 'notices', 'truncated', 'checkedAt'].includes(key),
		) ||
		value.threadId !== threadId ||
		!Array.isArray(value.files) ||
		value.files.length > 1_024 ||
		!Array.isArray(value.notices) ||
		value.notices.length > 17 ||
		!value.notices.every((notice) => bounded(notice, 4_096)) ||
		typeof value.truncated !== 'boolean' ||
		!Number.isSafeInteger(value.checkedAt) ||
		(value.checkedAt as number) < 0
	)
		return false;
	const ids = new Set<string>();
	return value.files.every((item) => {
		if (
			!record(item) ||
			Object.keys(item).some(
				(key) => !['id', 'exists', 'canonicalPath', 'identity', 'unavailable'].includes(key),
			) ||
			!safe(item.id, 8_192) ||
			ids.has(item.id) ||
			typeof item.exists !== 'boolean' ||
			(item.canonicalPath !== undefined &&
				(!safe(item.canonicalPath, 4_096) || !item.canonicalPath.startsWith('/'))) ||
			(item.identity !== undefined && !safe(item.identity, 4_256)) ||
			(item.unavailable !== undefined && !bounded(item.unavailable, 4_096)) ||
			(item.exists && (!item.canonicalPath || !item.identity))
		)
			return false;
		ids.add(item.id);
		return true;
	});
}

function validComposerWarnings(value: unknown): value is string[] | undefined {
	return (
		value === undefined ||
		(Array.isArray(value) &&
			value.length <= 16 &&
			value.every((item) => typeof item === 'string' && item.length <= 4_096))
	);
}
function validComposerDiscoveryResult(value: unknown): value is ComposerDiscoveryResult {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const result = value as Record<string, unknown>;
	if (
		Object.keys(result).some((key) => !['items', 'warnings'].includes(key)) ||
		!Array.isArray(result.items) ||
		result.items.length > 30 ||
		!validComposerWarnings(result.warnings)
	)
		return false;
	const seen = new Set<string>();
	return result.items.every((item) => {
		if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
		const candidate = item as Record<string, unknown>;
		if (
			Object.keys(candidate).some(
				(key) => !['kind', 'id', 'label', 'path', 'description'].includes(key),
			) ||
			!['file', 'folder', 'skill'].includes(candidate.kind as string) ||
			![candidate.id, candidate.label, candidate.path].every(
				(field) =>
					typeof field === 'string' &&
					field.length > 0 &&
					field.length <= 4096 &&
					!/[\x00-\x1f\x7f]/.test(field),
			) ||
			!(candidate.path as string).startsWith('/') ||
			(candidate.description !== undefined &&
				(typeof candidate.description !== 'string' || candidate.description.length > 4_096)) ||
			seen.has(candidate.id as string)
		)
			return false;
		seen.add(candidate.id as string);
		return true;
	});
}

async function readBody(response: Response, maxBytes = MAX_BYTES) {
	if (Number(response.headers.get('content-length')) > maxBytes) {
		await response.body?.cancel();
		throw new Error('Remote response is too large.');
	}
	const reader = response.body?.getReader();
	if (!reader) return '';
	let size = 0;
	const chunks: Uint8Array[] = [];
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) throw new Error('Remote response is too large.');
			chunks.push(value);
		}
		return decodeUtf8(Buffer.concat(chunks), 'remote instance');
	} catch (error) {
		await reader.cancel().catch(() => {});
		throw error;
	} finally {
		reader.releaseLock();
	}
}

async function deliverBotMessages(
	messages: readonly BotSentMessage[],
	onMessage?: (message: BotSentMessage) => Promise<void>,
) {
	const delivered = new Map<string, string>();
	for (const message of messages) {
		const serialized = JSON.stringify([message.id, message.content, message.createdAt]);
		if (delivered.has(message.id)) {
			if (delivered.get(message.id) !== serialized)
				throw new Error('The remote bot changed an already delivered message.');
			continue;
		}
		delivered.set(message.id, serialized);
		await onMessage?.(message);
	}
}
