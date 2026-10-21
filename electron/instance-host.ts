import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { RemoteInfo } from '../src/remote-types';
import type { Connection, WireRequest, WireResponse } from '../src/types';
import { apiUrl } from './transport';
import { MediaModerationGuard } from './media-moderation';
import { validateRequest, validateState } from './validation';
import { WorkspaceAuthority, WorkspaceConflictError } from './workspace-authority';
import type { AgentHost } from './agent-host';
import type { BotHost } from './bot-host';
import type { BotReplyActivity, BotReplyResult, BotSnapshot } from '../src/bot-types';
import {
	validateBotCommand,
	validateBotReplyRequest,
	validateBotReplyResult,
	validateBotGroupSendRequest,
	validBotId,
	validBotTaskWatch,
	validBotSentMessage,
	MAX_BOT_MESSAGE,
} from '../src/lib/bots';
import { validateBotTaskRequest } from '../src/bot-task-types';
import { assertBotTaskRemoteExecution } from '../src/lib/bot-task-tools';
import { validateToolRequest } from './agent-validation';
import {
	readTaskOutput,
	taskOutputStatus,
	validateTaskOutputIds,
	validateTaskOutputThreadId,
} from './task-output-reader';
import {
	ComposerContextHost,
	validateComposerDiscovery,
	validateComposerResolution,
} from './composer-context';
import {
	CodeSurfaceService,
	validateCodeSurfaceRequest,
	CODE_SURFACE_RESPONSE_BYTES,
} from './code-surface';

const MAX_BODY_BYTES = 256 * 1024 * 1024;
const MAX_ASSET_BYTES = 32 * 1024 * 1024;

class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readJson(request: IncomingMessage, limit = MAX_BODY_BYTES): Promise<unknown> {
	if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? ''))
		throw new HttpError(415, 'Send an application/json request.');
	if (Number(request.headers['content-length']) > limit)
		throw new HttpError(413, `Request exceeds the ${limit / 1024 / 1024} MB limit.`);
	const chunks: Buffer[] = [];
	let length = 0;
	for await (const chunk of request) {
		length += chunk.length;
		if (length > limit)
			throw new HttpError(413, `Request exceeds the ${limit / 1024 / 1024} MB limit.`);
		chunks.push(chunk);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8'));
	} catch {
		throw new HttpError(400, 'Invalid JSON request.');
	}
}

function sendJson(response: ServerResponse, status: number, value: unknown) {
	response.writeHead(status, {
		'Content-Type': 'application/json',
		'Cache-Control': 'no-store',
		'X-Content-Type-Options': 'nosniff',
	});
	response.end(JSON.stringify(value));
}

function supportedRequest(request: WireRequest) {
	if (request.method === 'GET')
		return request.path === '/models' || /^\/videos\/[^/]+(?:\/content)?$/.test(request.path);
	return [
		'/responses',
		'/chat/completions',
		'/chat',
		'/images/generations',
		'/images/edits',
		'/videos',
		'/audio/speech',
		'/audio/transcriptions',
	].includes(request.path);
}

export interface InstanceHostOptions {
	bots?: BotHost;
	botTasks?: import('./bot-task-service').BotTaskService;
	agent?: AgentHost;
	authority: WorkspaceAuthority;
	instanceId: string;
	name: string;
	token: string;
	port: number;
}

/** Authenticated loopback service, intended to be reached through an SSH tunnel. */
export class InstanceHost {
	private readonly mediaModeration: MediaModerationGuard;
	private readonly composer: ComposerContextHost;
	private readonly codeSurface: CodeSurfaceService;
	private server: Server | null = null;
	private port = 0;
	private starting: Promise<number> | null = null;
	private sockets = new Set<Socket>();
	private requests = new Map<string, AbortController>();
	private toolRuns = new Set<string>();
	private toolClaims = new Set<string>();

	constructor(private readonly options: InstanceHostOptions) {
		this.mediaModeration = new MediaModerationGuard(() => options.authority.loadModerationState());
		this.composer = new ComposerContextHost((request) =>
			options.authority.loadComposerState(request),
		);
		this.codeSurface = new CodeSurfaceService((request) =>
			options.authority.loadComposerState(request),
		);
		if (!options.token || options.token.length > 4096)
			throw new Error('A host access token is required.');
		if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)
			throw new Error('Invalid host port.');
	}

	start(): Promise<number> {
		if (this.starting) return this.starting;
		if (this.server) return Promise.resolve(this.port);
		const server = createServer((request, response) => {
			void this.handle(request, response).catch((error: unknown) => {
				if (response.destroyed) return;
				const message = error instanceof Error ? error.message : 'The host request failed.';
				if (response.headersSent) response.end(JSON.stringify({ type: 'error', message }) + '\n');
				else
					sendJson(
						response,
						error instanceof HttpError
							? error.status
							: error instanceof WorkspaceConflictError
								? 409
								: 400,
						{ error: message },
					);
			});
		});
		server.requestTimeout = 120_000;
		server.headersTimeout = 30_000;
		server.on('connection', (socket) => {
			this.sockets.add(socket);
			socket.once('close', () => this.sockets.delete(socket));
		});
		this.starting = new Promise<number>((resolve, reject) => {
			const failed = (error: Error) => {
				this.starting = null;
				reject(error);
			};
			server.once('error', failed);
			server.listen(this.options.port, '127.0.0.1', () => {
				server.off('error', failed);
				this.server = server;
				this.port = (server.address() as { port: number }).port;
				this.starting = null;
				resolve(this.port);
			});
		});
		return this.starting;
	}

	async stop(): Promise<void> {
		for (const id of this.toolRuns) this.options.agent?.cancel(id);
		this.toolRuns.clear();
		await Promise.all(
			[...this.toolClaims].map((runId) => this.options.botTasks?.releaseExternal?.(runId, true)),
		);
		this.toolClaims.clear();
		if (this.starting) await this.starting.catch(() => undefined);
		const server = this.server;
		if (!server) return;
		this.server = null;
		this.port = 0;
		for (const controller of this.requests.values()) controller.abort();
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
			for (const socket of this.sockets) socket.destroy();
		});
	}

	private authenticate(request: IncomingMessage) {
		if (request.headers.origin !== undefined)
			throw new HttpError(403, 'Browser-origin requests are not allowed.');
		const host = /^(?:127\.0\.0\.1|localhost)(?::([0-9]{1,5}))?$/.exec(request.headers.host ?? '');
		// SSH forwards to a different client-side port, which fetch uses in Host.
		if (!host || (host[1] !== undefined && (Number(host[1]) < 1 || Number(host[1]) > 65535)))
			throw new HttpError(403, 'Invalid host header.');
		const actual = Buffer.from(request.headers.authorization ?? '');
		const expected = Buffer.from(`Bearer ${this.options.token}`);
		if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
			throw new HttpError(401, 'Invalid FreeLM access token.');
	}

	private async connection(id: unknown): Promise<Connection> {
		if (typeof id !== 'string' || !id || id.length > 256)
			throw new HttpError(400, 'A valid connection identifier is required.');
		const snapshot = await this.options.authority.load();
		const connection = snapshot.state?.connections.find((item) => item.id === id);
		if (!connection) throw new HttpError(404, 'This API connection does not exist on the host.');
		return connection;
	}

	private async handle(request: IncomingMessage, response: ServerResponse) {
		this.authenticate(request);
		const route = `${request.method} ${request.url}`;
		if (route === 'GET /info') {
			const info: RemoteInfo = {
				protocol: 1,
				instanceId: this.options.instanceId,
				name: this.options.name,
				conversationModes: true,
				chatMemory: true,
				personalization: true,
				codeCompaction: true,
				mediaModeration: true,
				moderationStructuredOutput: true,
				moderationPolicies: 1,
				moderationImageEdits: 1,
				moderationVideoFrames: 1,
				moderationVideoReferences: 1,
				taskOutputs: true,
				taskOutputStatus: true,
				composerContext: 1,
				codeSurface: 1,
				...(this.options.bots
					? {
							bots: 1 as const,
							botNotifications: 1 as const,
							botActivity: 1 as const,
							botGroups: 1 as const,
							botGroupReadOnly: 1 as const,
							botGroupRecollection: 1 as const,
							botGroupOutreach: 1 as const,
							botMemory: 1 as const,
							botRuntime: 1 as const,
						}
					: {}),
				...(this.options.botTasks ? { botTasks: 1 as const } : {}),
			};
			sendJson(response, 200, info);
		} else if (route === 'POST /bots/task') {
			if (!this.options.botTasks)
				throw new HttpError(404, 'Update this FreeLM host to use bot thread tools.');
			const input = validateBotTaskRequest(await readJson(request, 128 * 1024));
			if (input.arguments.hostId !== undefined)
				throw new HttpError(400, 'Thread operations execute only on the addressed host.');
			assertBotTaskRemoteExecution(
				input.name,
				input.arguments,
				await this.options.authority.loadToolState(),
			);
			const controller = new AbortController();
			const id = `bot-task-${randomUUID()}`;
			this.requests.set(id, controller);
			const disconnect = () => {
				if (!response.writableEnded) controller.abort();
			};
			response.once('close', disconnect);
			try {
				const result = await this.options.botTasks.execute(
					input.name,
					input.arguments,
					input.operationId,
					controller.signal,
				);
				if (!response.destroyed) sendJson(response, 200, result);
			} finally {
				response.off('close', disconnect);
				this.requests.delete(id);
			}
		} else if (route === 'GET /bots') {
			if (!this.options.bots) throw new HttpError(404, 'Update this FreeLM host to use Bots.');
			sendJson(
				response,
				200,
				compatibleBotSnapshot(
					await this.options.bots.snapshot(),
					request.headers['x-freelm-bot-runtime'] === '1',
				),
			);
		} else if (route === 'POST /bots/command') {
			if (!this.options.bots) throw new HttpError(404, 'Update this FreeLM host to use Bots.');
			const input = await readJson(request, 256 * 1024);
			validateBotCommand(input);
			const result = await this.options.bots.command(input, true);
			sendJson(response, 200, {
				...result,
				snapshot: compatibleBotSnapshot(
					result.snapshot,
					request.headers['x-freelm-bot-runtime'] === '1',
				),
			});
		} else if (route === 'POST /bots/group-send') {
			if (!this.options.bots) throw new HttpError(404, 'Update this FreeLM host to use Bots.');
			if (request.headers['x-freelm-bot-group-outreach'] !== '1')
				throw new HttpError(
					400,
					'Update FreeLM on the bot’s home computer to initiate group messages.',
				);
			const input = await readJson(request, 256 * 1024);
			validateBotGroupSendRequest(input);
			const controller = new AbortController();
			const id = `bot-group-send-${randomUUID()}`;
			this.requests.set(id, controller);
			const disconnect = () => {
				if (!response.writableEnded) controller.abort();
			};
			response.once('close', disconnect);
			try {
				const result = await this.options.bots.sendGroup(input, controller.signal, true);
				if (!response.destroyed) sendJson(response, 200, result);
			} finally {
				response.off('close', disconnect);
				this.requests.delete(id);
			}
		} else if (route === 'POST /bots/steer') {
			if (!this.options.bots) throw new HttpError(404, 'Update this FreeLM host to use Bots.');
			if (request.headers['x-freelm-bot-runtime'] !== '1')
				throw new HttpError(
					400,
					'Update FreeLM on the conversation computer to steer active bot replies.',
				);
			const input = await readJson(request, 1024 * 1024);
			validateBotReplyRequest(input);
			sendJson(response, 200, { accepted: await this.options.bots.steer(input) });
		} else if (route === 'POST /bots/respond') {
			if (!this.options.bots) throw new HttpError(404, 'Update this FreeLM host to use Bots.');
			const input = await readJson(request, 1024 * 1024);
			validateBotReplyRequest(input);
			const controller = new AbortController();
			const id = `bot-${randomUUID()}`;
			this.requests.set(id, controller);
			const disconnect = () => {
				if (!response.writableEnded) controller.abort();
			};
			response.once('close', disconnect);
			const runtimeSupported = request.headers['x-freelm-bot-runtime'] === '1';
			const streaming = request.headers.accept
				?.split(',')
				.some((value) => /^text\/event-stream(?:\s*;|$)/i.test(value.trim()));
			let sentBytes = 0;
			let previousActivity: BotReplyActivity | undefined;
			const sendEvent = (event: 'activity' | 'message' | 'result' | 'error', data: unknown) => {
				if (response.destroyed || controller.signal.aborted) return;
				const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
				sentBytes += Buffer.byteLength(payload, 'utf8');
				if (sentBytes > 1024 * 1024) throw new Error('Remote bot response is too large.');
				if (!response.headersSent)
					response.writeHead(200, {
						'Content-Type': 'text/event-stream; charset=utf-8',
						'Cache-Control': 'no-store',
						'X-Content-Type-Options': 'nosniff',
						'X-Accel-Buffering': 'no',
					});
				response.write(payload);
			};
			try {
				const result = streaming
					? await this.options.bots.respond(
							input,
							controller.signal,
							true,
							undefined,
							(activity) => {
								if (!['queued', 'thinking', 'writing'].includes(activity))
									throw new Error('Invalid bot activity.');
								if (activity === previousActivity) return;
								previousActivity = activity;
								sendEvent('activity', { activity });
							},
							runtimeSupported
								? async (message) => {
										if (!validBotSentMessage(message))
											throw new Error('Invalid explicit bot message.');
										sendEvent('message', message);
									}
								: undefined,
							runtimeSupported,
						)
					: await this.options.bots.respond(
							input,
							controller.signal,
							true,
							undefined,
							undefined,
							undefined,
							runtimeSupported,
						);
				validateBotReplyResult(result, input);
				const compatibleResult = compatibleBotReply(result, runtimeSupported);
				if (streaming) {
					sendEvent('result', compatibleResult);
					response.end();
				} else if (!response.destroyed) {
					if (Buffer.byteLength(JSON.stringify(compatibleResult), 'utf8') > 1024 * 1024)
						throw new HttpError(502, 'Remote bot response is too large.');
					sendJson(response, 200, compatibleResult);
				}
			} catch (error) {
				if (!streaming || !response.headersSent) throw error;
				const message = (
					error instanceof Error ? error.message : 'The remote bot could not reply.'
				).slice(0, 4096);
				// Even a limit failure gets a small terminal error instead of masquerading as success.
				if (!response.destroyed)
					response.end(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
			} finally {
				response.off('close', disconnect);
				this.requests.delete(id);
			}
		} else if (route === 'POST /bots/watch') {
			if (!this.options.bots)
				throw new HttpError(404, 'Update this FreeLM host to watch bot tasks.');
			const input = await readJson(request, 8 * 1024);
			if (
				!record(input) ||
				Object.keys(input).some((key) => !['botId', 'watch'].includes(key)) ||
				!validBotId(input.botId) ||
				!validBotTaskWatch(input.watch)
			)
				throw new HttpError(400, 'Choose a valid bot and task to watch.');
			const controller = new AbortController();
			const id = `bot-watch-${randomUUID()}`;
			this.requests.set(id, controller);
			const disconnect = () => {
				if (!response.writableEnded) controller.abort();
			};
			response.once('close', disconnect);
			try {
				const result = await this.options.bots.observeTask(
					input.botId,
					input.watch,
					controller.signal,
				);
				if (Buffer.byteLength(JSON.stringify(result) ?? '', 'utf8') > 512 * 1024)
					throw new HttpError(502, 'The watched task response exceeds the 512 KiB limit.');
				if (!response.destroyed) sendJson(response, 200, result);
			} finally {
				response.off('close', disconnect);
				this.requests.delete(id);
			}
		} else if (route === 'GET /workspace') {
			sendJson(response, 200, await this.options.authority.load(true));
		} else if (route === 'POST /code-surface') {
			const input = await readJson(request, CODE_SURFACE_RESPONSE_BYTES);
			validateCodeSurfaceRequest(input);
			if (input.workspaceId !== 'local')
				throw new HttpError(400, 'Code surface operations execute in the host workspace.');
			sendJson(response, 200, await this.codeSurface.execute(input, true));
		} else if (route === 'POST /composer/discover') {
			const input = await readJson(request, 2_048);
			validateComposerDiscovery(input);
			if (input.workspaceId !== 'local')
				throw new HttpError(400, 'Composer discovery is executed in the host workspace.');
			sendJson(response, 200, await this.composer.discover(input, true));
		} else if (route === 'POST /composer/resolve') {
			const input = await readJson(request, 1_024);
			if (
				!record(input) ||
				Object.keys(input).some((key) => !['threadId', 'messageId'].includes(key))
			)
				throw new HttpError(400, 'A saved task and user message are required.');
			validateComposerResolution(input.threadId, input.messageId);
			sendJson(
				response,
				200,
				await this.composer.resolve(input.threadId, input.messageId as string, true),
			);
		} else if (route === 'POST /task-output-status') {
			const input = await readJson(request, 1_024);
			if (!record(input) || Object.keys(input).some((key) => key !== 'threadId'))
				throw new HttpError(400, 'A recorded task identifier is required.');
			validateTaskOutputThreadId(input.threadId);
			sendJson(response, 200, await taskOutputStatus(this.options.authority, input.threadId));
		} else if (route === 'POST /task-output') {
			const input = await readJson(request, 16 * 1024);
			if (
				!record(input) ||
				Object.keys(input).some((key) => !['threadId', 'outputId'].includes(key))
			)
				throw new HttpError(400, 'A task and recorded output identifier are required.');
			validateTaskOutputIds(input.threadId, input.outputId);
			sendJson(
				response,
				200,
				await readTaskOutput(this.options.authority, input.threadId, input.outputId as string),
			);
		} else if (route === 'PUT /workspace') {
			const input = await readJson(request, 512 * 1024 * 1024);
			if (!record(input) || typeof input.revision !== 'string')
				throw new HttpError(400, 'A workspace revision is required.');
			validateState(input.state);
			sendJson(response, 200, await this.options.authority.save(input.state, input.revision, true));
		} else if (
			[
				'POST /tools/catalog',
				'POST /tools/execute',
				'POST /tools/cancel',
				'POST /tools/release',
			].includes(route)
		) {
			if (!this.options.agent)
				throw new HttpError(404, 'This FreeLM host does not support tools. Update it first.');
			const input = await readJson(request, 230 * 1024 * 1024);
			if (
				!record(input) ||
				typeof input.runId !== 'string' ||
				!/^[a-zA-Z0-9_-]{1,200}$/.test(input.runId)
			)
				throw new HttpError(400, 'Invalid tool run.');
			const runId = `remote:${input.runId}`;
			if (route.endsWith('/release')) {
				if (input.interrupted !== undefined && typeof input.interrupted !== 'boolean')
					throw new HttpError(400, 'Invalid task release.');
				if (this.toolClaims.has(runId)) {
					this.options.agent.cancel(runId);
					this.toolRuns.delete(runId);
					await this.options.botTasks?.releaseExternal?.(runId, input.interrupted === true);
					this.toolClaims.delete(runId);
				}
				sendJson(response, 200, {});
				return;
			}
			if (route.endsWith('/cancel')) {
				if (this.toolRuns.has(runId)) this.options.agent.cancel(runId);
				this.toolRuns.delete(runId);
				sendJson(response, 200, {});
				return;
			}
			const disconnected = () => {
				if (!response.writableEnded) {
					this.options.agent!.cancel(runId);
					this.toolRuns.delete(runId);
					if (this.toolClaims.delete(runId))
						void this.options.botTasks
							?.releaseExternal?.(runId, true)
							.catch((error) => console.error('Remote task disconnect:', error));
				}
			};
			response.on('close', disconnected);
			try {
				if (route.endsWith('/catalog')) {
					if (
						typeof input.threadId !== 'string' ||
						input.threadId.length > 256 ||
						this.toolRuns.has(runId) ||
						(input.temporary !== undefined && typeof input.temporary !== 'boolean') ||
						(input.claimTask !== undefined && typeof input.claimTask !== 'boolean')
					)
						throw new HttpError(400, 'Invalid chat or duplicate run.');
					if (
						input.claimTask === true &&
						input.temporary !== true &&
						this.options.botTasks?.claimExternal
					) {
						if (!this.options.botTasks.claimExternal(input.threadId, runId))
							throw new HttpError(409, 'This conversation already has an active task.');
						this.toolClaims.add(runId);
					}
					this.toolRuns.add(runId);
					try {
						sendJson(
							response,
							200,
							await this.options.agent.catalog(
								runId,
								input.threadId,
								true,
								input.temporary === true,
							),
						);
					} catch (e) {
						this.toolRuns.delete(runId);
						if (this.toolClaims.delete(runId))
							await this.options.botTasks?.releaseExternal?.(runId, true);
						throw e;
					}
				} else {
					if (!this.toolRuns.has(runId))
						throw new HttpError(400, 'Start this tool run on the host first.');
					const call = { ...input, runId, workspaceId: 'local' };
					validateToolRequest(call);
					sendJson(response, 200, await this.options.agent.execute(call));
				}
			} finally {
				response.removeListener('close', disconnected);
			}
		} else if (route === 'POST /request') {
			await this.perform(request, response);
		} else if (route === 'POST /asset') {
			await this.asset(request, response);
		} else throw new HttpError(404, 'Unknown FreeLM endpoint.');
	}

	private async perform(request: IncomingMessage, response: ServerResponse) {
		const input = await readJson(request);
		if (!record(input) || ['baseUrl', 'apiKey', 'workspaceId'].some((key) => key in input))
			throw new HttpError(400, 'Remote requests must use a host connection identifier.');
		const connection = await this.connection(input.connectionId);
		const wire = { ...input, baseUrl: connection.baseUrl, apiKey: connection.apiKey };
		validateRequest(wire);
		if (!supportedRequest(wire))
			throw new HttpError(400, 'This API endpoint is not supported for remote execution.');
		apiUrl(wire.baseUrl, wire.path);
		if (response.destroyed) return;
		if (this.requests.has(wire.id)) throw new HttpError(409, 'This request is already running.');
		if (this.requests.size >= 20)
			throw new HttpError(429, 'Too many requests are running on the host.');
		const controller = new AbortController();
		this.requests.set(wire.id, controller);
		const cancel = () => controller.abort();
		response.once('close', cancel);
		response.writeHead(200, {
			'Content-Type': 'application/x-ndjson',
			'Cache-Control': 'no-store',
			'X-Content-Type-Options': 'nosniff',
		});
		response.flushHeaders();
		try {
			const result = await this.mediaModeration.request(
				wire,
				(text) => {
					if (!response.destroyed) response.write(JSON.stringify({ type: 'chunk', text }) + '\n');
				},
				controller.signal,
			);
			if (!response.destroyed)
				response.end(JSON.stringify({ type: 'response', response: result }) + '\n');
		} finally {
			response.off('close', cancel);
			this.requests.delete(wire.id);
		}
	}

	private async asset(request: IncomingMessage, response: ServerResponse) {
		const input = await readJson(request);
		if (!record(input) || typeof input.url !== 'string' || input.url.length > 32_768)
			throw new HttpError(400, 'A valid media URL is required.');
		await this.connection(input.connectionId);
		if (response.destroyed) return;
		const url = new URL(input.url);
		if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
			throw new HttpError(400, 'Use an HTTP or HTTPS media URL without embedded credentials.');
		if (this.requests.size >= 20)
			throw new HttpError(429, 'Too many requests are running on the host.');
		const controller = new AbortController();
		const id = `asset:${randomUUID()}`;
		this.requests.set(id, controller);
		const cancel = () => controller.abort();
		response.once('close', cancel);
		try {
			// Media URLs can be signed or point to a separate origin. Never forward provider credentials.
			const upstream = await fetch(url, {
				redirect: 'error',
				signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
			});
			if (Number(upstream.headers.get('content-length')) > MAX_ASSET_BYTES) {
				await upstream.body?.cancel();
				throw new Error('Remote media exceeds the 32 MB download limit.');
			}
			const chunks: Uint8Array[] = [];
			let length = 0;
			const reader = upstream.body?.getReader();
			try {
				if (reader)
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						length += value.byteLength;
						if (length > MAX_ASSET_BYTES)
							throw new Error('Remote media exceeds the 32 MB download limit.');
						chunks.push(value);
					}
			} catch (error) {
				await reader?.cancel().catch(() => undefined);
				throw error;
			} finally {
				reader?.releaseLock();
			}
			const body = Buffer.concat(chunks);
			const result: WireResponse = {
				status: upstream.status,
				contentType: upstream.headers.get('content-type') ?? 'application/octet-stream',
				body: body.toString(upstream.ok ? 'base64' : 'utf8'),
				encoding: upstream.ok ? 'base64' : 'text',
			};
			sendJson(response, 200, result);
		} finally {
			response.off('close', cancel);
			this.requests.delete(id);
		}
	}
}

/** Legacy peers can display completed messages but do not know durable jobs or their provenance. */
function compatibleBotSnapshot(snapshot: BotSnapshot, runtimeSupported: boolean): BotSnapshot {
	if (runtimeSupported) return snapshot;
	const { jobs: _jobs, runtimeSupported: _runtime, ...legacy } = snapshot;
	return {
		...legacy,
		conversations: snapshot.conversations.map((conversation) => ({
			...conversation,
			messages: conversation.messages.map((message) => {
				if (message.notification?.type !== 'job') return message;
				const { notification: _notification, ...rest } = message;
				return rest;
			}),
		})),
	};
}
function compatibleBotReply(result: BotReplyResult, runtimeSupported: boolean): BotReplyResult {
	if (runtimeSupported) return result;
	const { messages, backgroundWork: _backgroundWork, ...legacy } = result;
	if (!messages?.length) return legacy;
	const content = [...messages.map((message) => message.content), result.content]
		.filter(Boolean)
		.join('\n\n');
	legacy.content =
		content.length <= MAX_BOT_MESSAGE
			? content
			: `${content.slice(0, MAX_BOT_MESSAGE - 90)}\n[More text is available on the bot’s home computer; update FreeLM for live messages.]`;
	delete legacy.silent;
	return legacy;
}
