import { WorkflowEngine, validateWorkflowCommand } from './workflows/engine';
import { WorkflowStore } from './workflows/store';
import { createWorkflowAdapters } from './workflows/adapters';
import { WorkflowAssets } from './workflows/assets';
import { WorkflowPreviews } from './workflows/previews';
import { WorkflowThreadNotifications } from './workflows/notifications';
import { WorkflowToolService } from './workflows/tool-service';
import { SchedulerService } from './scheduler/service';
import { SchedulerToolService } from './scheduler-tools';
import { createSchedulerDispatcher } from './scheduler-dispatch';
import { schedulerTools } from '../src/lib/scheduler-tools';
import { AgentHost } from './agent-host';
import type { WorkflowSnapshot } from '../src/workflow-types';
import { CodeSurfaceService, validateCodeSurfaceRequest } from './code-surface';
import { CodeBrowserService } from './code-browser';
import {
	app,
	BrowserWindow,
	clipboard,
	dialog,
	ipcMain,
	Menu,
	Notification,
	protocol,
	safeStorage,
	shell,
	type IpcMainInvokeEvent,
	type MenuItemConstructorOptions,
} from 'electron';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performRequest } from './transport';
import { MediaModerationGuard } from './media-moderation';
import { downloadImageAsset, downloadVideoAsset } from './image-assets';
import { StateStore, type SecretStorage } from './state-store';
import { WorkspaceAuthority } from './workspace-authority';
import { textContextMenu } from './context-menu';
import { InstanceManager } from './instance-manager';
import { saveWorkspaceRecovery } from './workspace-backup';
import { validateAssetUrl, validateInstanceInput } from './instance-client';
import type { AppState } from '../src/types';
import { projectKind } from '../src/lib/conversation-kind';
import { validateRequest, validateRequestId } from './validation';
import { STREAM_CHANNEL, type StreamEvent } from './stream-protocol';
import { createAgentHost, registerAgentBridge } from './agent-bridge';
import { resolveStoragePaths } from './storage-paths';
import { initializeStorage } from './storage-migration';
import { SearchServiceManager } from './search-service';
import { SearchController } from './search-controller';
import type { WorkspacePatch } from '../src/workspace-patch';
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
import { WorkspaceTransferPool } from './workspace-transfer-pool';
import { jsonLengthAtMost } from '../src/json-normalize';
import { BotHost } from './bot-host';
import { validateBotCommand } from '../src/lib/bots';
import { HostTaskService } from './host-task-service';
import { assertBotTaskRemoteExecution, botTaskTools } from '../src/lib/bot-task-tools';
import { PluginHost } from './plugins/host';
import { PluginViews } from './plugins/views';
import { CodeHtmlViews } from './code-html-views';
import { PluginSurfaceHost } from './plugins/surfaces';
import type { PluginSurfaceBinding } from '../src/plugin-surface-types';
import type { PluginCommand } from '../src/plugin-types';

app.setName('FreeLM');
protocol.registerSchemesAsPrivileged([
	{ scheme: 'freelm-plugin', privileges: { standard: true, secure: true } },
	{ scheme: 'freelm-code-preview', privileges: { standard: true, secure: true } },
	{
		scheme: 'freelm-workflow',
		privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true },
	},
]);
const pluginViews = new PluginViews();
const codeHtmlViews = new CodeHtmlViews();
if (!app.isPackaged && process.env.FREELM_USER_DATA)
	app.setPath('userData', path.resolve(process.env.FREELM_USER_DATA));
const storagePaths = resolveStoragePaths({
	platform: process.platform,
	home: app.getPath('home'),
	userData: app.getPath('userData'),
	packaged: app.isPackaged,
	env: process.env,
});
// Keep OS-bound Electron/keychain metadata in its existing profile. Chromium's
// disposable session cache is separate from the portable FreeLM home.
mkdirSync(storagePaths.cache, { recursive: true, mode: 0o700 });
app.setPath('sessionData', storagePaths.cache);
const ownsProfile = app.requestSingleInstanceLock();
if (!ownsProfile) app.quit();
app.on('second-instance', () => {
	if (mainWindow?.isMinimized()) mainWindow.restore();
	mainWindow?.show();
	mainWindow?.focus();
});
const devUrl =
	!app.isPackaged && process.env.FREELM_DEV_URL === 'http://127.0.0.1:5173'
		? process.env.FREELM_DEV_URL
		: undefined;
const appUrl = devUrl ?? pathToFileURL(path.join(__dirname, '../dist/index.html')).href;
const appIconPath = path.join(app.getAppPath(), 'resources/branding/icon.png');
let mainWindow: BrowserWindow | null = null;
let store: StateStore;
let authority: WorkspaceAuthority;
let composer: ComposerContextHost;
let codeSurface: CodeSurfaceService;
let codeBrowser: CodeBrowserService | undefined;
let mediaModeration: MediaModerationGuard;
let instances: InstanceManager;
let bots: BotHost;
let scheduler: SchedulerService;
let scheduleTools: SchedulerToolService;
let schedulerReady = false;
let schedulerInitializationError = '';
let pendingSchedulerNavigation = false;
let workflows: WorkflowEngine;
let workflowHostInitialized = false;
let workflowThreadsReady = false;
let workflowInitializationError = '';
function assertWorkflowsReady() {
	if (workflowInitializationError) throw new Error(workflowInitializationError);
}
let workflowAdapters: ReturnType<typeof createWorkflowAdapters>;
let workflowPreviews: WorkflowPreviews;
let workflowNotifications: WorkflowThreadNotifications | undefined;
let plugins: PluginHost;
let pluginSurfaces: PluginSurfaceHost;
let botTasks: HostTaskService;
let agent: ReturnType<typeof createAgentHost>;
let searchService: SearchServiceManager;
let search: SearchController;
let cancelAgentRuns: (() => Promise<void>) | undefined;
let legacyRevision: string | undefined;
let managerClosed = false;
let shutdown: Promise<void> | undefined;
let quitRequested = false;
let closeRequested = false;
let allowWindowClose = false;
const requests = new Map<string, AbortController>();
const workspaceTransfers = new WorkspaceTransferPool();

function isAppUrl(candidate: string) {
	try {
		const url = new URL(candidate);
		const expected = new URL(appUrl);
		return (
			url.protocol === expected.protocol &&
			url.host === expected.host &&
			url.pathname === expected.pathname
		);
	} catch {
		return false;
	}
}

function validateSender(event: IpcMainInvokeEvent) {
	if (
		!mainWindow ||
		event.sender !== mainWindow.webContents ||
		!event.senderFrame ||
		event.senderFrame !== mainWindow.webContents.mainFrame ||
		!isAppUrl(event.senderFrame.url)
	) {
		throw new Error('This page is not allowed to access the desktop bridge.');
	}
}

function openExternal(url: string) {
	try {
		const target = new URL(url);
		if (['https:', 'http:'].includes(target.protocol) && !target.username && !target.password) {
			void shell
				.openExternal(target.href)
				.catch((error) => console.error('Could not open link:', error.message));
		}
	} catch {
		/* Malformed URLs never leave the app. */
	}
}

async function readDesktopWorkspace(operation: unknown, args: unknown) {
	if (!Array.isArray(args)) throw new Error('Invalid workspace operation arguments.');
	if (operation === 'load' && args.length === 0) {
		const snapshot = await authority.load();
		legacyRevision = snapshot.revision;
		return snapshot.state;
	}
	if (operation === 'workspace-load' && args.length === 1) {
		const [target] = args;
		validateTarget(target);
		return target === 'local' ? authority.load() : instances.load(target);
	}
	if (operation === 'instance-connect' && args.length === 1) {
		validateInstanceInput(args[0]);
		return instances.connect(args[0]);
	}
	if (operation === 'instance-open' && args.length === 1) {
		validateTarget(args[0]);
		return instances.open(args[0]);
	}
	if (operation === 'bots-snapshot' && args.length === 1) {
		validateTarget(args[0]);
		return args[0] === 'local' ? bots.snapshot() : instances.botsSnapshot(args[0]);
	}
	throw new Error('Unsupported workspace read operation.');
}

async function writeDesktopWorkspace(operation: unknown, args: unknown, value: unknown) {
	if (!Array.isArray(args)) throw new Error('Invalid workspace operation arguments.');
	if (operation === 'bots-command' && args.length === 1) {
		validateTarget(args[0]);
		validateBotCommand(value);
		const result =
			args[0] === 'local' ? await bots.command(value) : await instances.botsCommand(args[0], value);
		const { snapshot: _snapshot, ...acknowledgement } = result;
		return acknowledgement;
	}
	if (operation === 'save' && args.length === 0) {
		if (!legacyRevision) throw new Error('Load the workspace before saving.');
		legacyRevision = (await authority.save(value as AppState, legacyRevision)).revision;
		reconcileSearch();
		return;
	}
	if (operation === 'workspace-save' && args.length === 2) {
		const [target, revision] = args;
		validateTarget(target);
		validateRequestId(revision);
		if (target !== 'local') return instances.save(target, revision, value as AppState);
		const result = await authority.save(value as AppState, revision);
		reconcileSearch();
		return result;
	}
	if (operation === 'workspace-patch' && args.length === 2) {
		const [target, revision] = args;
		validateTarget(target);
		validateRequestId(revision);
		if (target !== 'local') throw new Error('Workspace patches require a local workspace.');
		const result = await authority.patch(value, revision);
		const saved = value as WorkspacePatch;
		if (Object.hasOwn(saved.changes, 'toolSettings') || saved.removed?.includes('toolSettings'))
			reconcileSearch();
		return result;
	}
	if (operation === 'workspace-backup' && args.length === 0)
		return saveWorkspaceRecovery(storagePaths.recovery, value as AppState);
	throw new Error('Unsupported workspace write operation.');
}

function directWorkspaceReply<T>(value: T): T {
	// Compatibility for small legacy callers. Product state uses the bounded renderer façade.
	if (!jsonLengthAtMost(value, 16 * 1024 * 1024))
		throw new Error(
			'This workspace requires the bounded desktop transport. Reload or update FreeLM.',
		);
	return value;
}

async function workflowSnapshot(
	scope: { bindingId?: string; projectId?: string } = {},
): Promise<WorkflowSnapshot> {
	assertWorkflowsReady();
	const snapshot = workflows.snapshot(scope);
	const [current, context] = await Promise.all([
		authority.loadModerationState(),
		authority.loadWorkflowContext(),
	]);
	return {
		...snapshot,
		projects: context.projects.filter((project) => projectKind(project) === 'code'),
		connections: current?.connections.map((connection) => ({ ...connection, apiKey: '' })) ?? [],
	};
}

function registerBridge() {
	ipcMain.handle('freelm:scheduler-snapshot', (event) => {
		validateSender(event);
		if (!schedulerReady) throw new Error(schedulerInitializationError || 'Scheduler is not ready.');
		return scheduler.snapshot();
	});
	ipcMain.handle('freelm:scheduler-command', (event, command) => {
		validateSender(event);
		if (!schedulerReady) throw new Error(schedulerInitializationError || 'Scheduler is not ready.');
		return scheduler.command(command);
	});
	ipcMain.handle('freelm:scheduler-take-navigation', (event) => {
		validateSender(event);
		const pending = pendingSchedulerNavigation;
		pendingSchedulerNavigation = false;
		return pending;
	});
	ipcMain.handle('freelm:workflow-bindings', async (event) => {
		validateSender(event);
		assertWorkflowsReady();
		const { projects } = await authority.loadWorkflowContext();
		const existing = new Set(projects.map((project) => project.id));
		return workflows.listBindingSummaries().filter((binding) => existing.has(binding.projectId));
	});
	ipcMain.handle(
		'freelm:workflow-snapshot',
		(event, scope: { bindingId?: string; projectId?: string } = {}) => {
			validateSender(event);
			if (!scope || typeof scope !== 'object' || Array.isArray(scope))
				throw new Error('Invalid workflow history scope.');
			validateWorkflowCommand({
				type: 'catalog',
				bindingId: scope.bindingId,
				projectId: scope.projectId,
			});
			return workflowSnapshot(scope);
		},
	);
	ipcMain.handle('freelm:workflow-command', async (event, command: unknown) => {
		validateSender(event);
		assertWorkflowsReady();
		validateWorkflowCommand(command);
		if (command.type === 'catalog') {
			const workflow = command.bindingId
				? workflows.getBinding(command.bindingId)?.workflowSnapshot
				: command.workflowId
					? workflows.listWorkflows().find((item) => item.id === command.workflowId)
					: undefined;
			const catalog = await workflowAdapters.catalog(workflow);
			return { ...(await workflowSnapshot(command)), tools: catalog.tools, skills: catalog.skills };
		}
		await workflows.command(command);
		const run = 'runId' in command ? workflows.getRun(command.runId) : undefined;
		return workflowSnapshot(
			'bindingId' in command ? { bindingId: command.bindingId } : { bindingId: run?.bindingId },
		);
	});
	ipcMain.handle('freelm:workflow-asset', async (event, runId: unknown, filename: unknown) => {
		validateSender(event);
		validateRequestId(runId);
		if (typeof filename !== 'string' || filename.length > 4096)
			throw new Error('Invalid workflow media path.');
		const run = workflows.getRun(runId);
		if (!run) throw new Error('Workflow run not found.');
		const state = await authority.loadToolState();
		return workflowPreviews.create(
			run,
			filename,
			run.workflowSnapshot.settings?.workspaceRoot ?? state?.toolSettings?.workspaceRoot ?? '',
		);
	});
	ipcMain.handle('freelm:workflow-thread-completed', async (event, input: unknown) => {
		validateSender(event);
		if (!input || typeof input !== 'object') throw new Error('Invalid workflow event.');
		const { threadId, title, workspaceId } = input as {
			threadId: unknown;
			title: unknown;
			workspaceId: unknown;
		};
		validateRequestId(threadId);
		validateRequestId(workspaceId);
		if (typeof title !== 'string' || title.length > 4096) throw new Error('Invalid thread title.');
		await workflows.emit('thread.completed', { threadId, title, workspaceId });
	});
	// Account administration is local-only and never exposed through remote tools.
	ipcMain.handle('freelm:plugins-snapshot', (event) => {
		validateSender(event);
		return plugins.snapshot();
	});
	ipcMain.handle('freelm:plugins-command', (event, command: PluginCommand) => {
		validateSender(event);
		return plugins.command(command);
	});
	ipcMain.handle('freelm:plugins-cancel-connect', (event) => {
		validateSender(event);
		plugins.cancelConnect();
	});
	ipcMain.handle('freelm:plugin-surface-open', (event, binding: PluginSurfaceBinding) => {
		validateSender(event);
		return pluginSurfaces.open(event.sender.id, binding);
	});
	ipcMain.handle('freelm:plugin-surface-activate', (event, ids: string[]) => {
		validateSender(event);
		return pluginSurfaces.activate(event.sender.id, ids);
	});
	ipcMain.handle('freelm:plugin-surface-close', (event, ids: string[]) => {
		validateSender(event);
		pluginSurfaces.close(event.sender.id, ids);
	});
	ipcMain.handle(
		'freelm:plugin-surface-reply',
		(event, sessionId: string, requestId: string, reply: unknown) => {
			validateSender(event);
			pluginSurfaces.reply(event.sender.id, sessionId, requestId, reply);
		},
	);
	ipcMain.handle(
		'freelm:plugin-surface-event',
		(event, sessionId: string, name: string, payload: unknown) => {
			validateSender(event);
			pluginSurfaces.event(event.sender.id, sessionId, name, payload);
		},
	);
	ipcMain.handle(
		'freelm:plugin-surface-command',
		(event, sessionId: string, id: string, payload: unknown) => {
			validateSender(event);
			pluginSurfaces.command(event.sender.id, sessionId, id, payload);
		},
	);
	ipcMain.handle(
		'freelm:plugin-surface-view-call',
		(event, sessionId: string, method: string, args: Record<string, unknown>) => {
			validateSender(event);
			return pluginSurfaces.viewCall(event.sender.id, sessionId, method, args);
		},
	);
	ipcMain.handle('freelm:plugins-prepare-package', (event, bytes: unknown) => {
		validateSender(event);
		if (
			!Array.isArray(bytes) ||
			bytes.length > 8 * 1024 * 1024 ||
			bytes.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
		)
			throw new Error('Plugin package must be a ZIP archive no larger than 8 MiB.');
		return plugins.preparePackage(Uint8Array.from(bytes));
	});
	ipcMain.handle('freelm:plugins-install-package', (event, reviewId: string) => {
		validateSender(event);
		return plugins.installPackage(reviewId);
	});
	ipcMain.handle(
		'freelm:plugins-tab-content',
		async (event, pluginId: string, tabId: string, options: unknown) => {
			validateSender(event);
			const content = await plugins.tabContent(pluginId, tabId);
			return options ? { html: '', url: pluginViews.create(content.html, options) } : content;
		},
	);
	ipcMain.handle(
		'freelm:plugins-invoke-action',
		(event, pluginId: string, tabId: string, accountId: string, action: string, args: unknown) => {
			validateSender(event);
			return plugins.invokeAction(pluginId, tabId, accountId, action, args);
		},
	);
	ipcMain.handle('freelm:bot-tasks-ready', (event, ready: unknown) => {
		validateSender(event);
		if (typeof ready !== 'boolean') throw new Error('Invalid bot task readiness.');
		botTasks.setReady(ready);
		// Host execution is independent of renderer readiness.
		if (ready) {
			workflowHostInitialized = true;
			if (schedulerReady)
				void scheduler.tick().catch((error) => console.error('Scheduler readiness:', error));
			void workflows?.tick().catch((error) => console.error('Workflow readiness:', error));
			workflowNotifications?.schedule();
		}
	});
	ipcMain.handle('freelm:bot-task-result', (event, id: unknown, result: unknown) => {
		validateSender(event);
		validateRequestId(id);
		botTasks.settle(id, result);
	});
	ipcMain.handle('freelm:host-tasks-snapshot', (event) => {
		validateSender(event);
		agent.replayApprovals();
		return botTasks.snapshot();
	});
	ipcMain.handle('freelm:host-task-claim', (event, threadId: unknown, runId: unknown) => {
		validateSender(event);
		validateRequestId(threadId);
		validateRequestId(runId);
		return botTasks.claimRenderer(threadId, runId);
	});
	ipcMain.handle('freelm:host-task-release', (event, threadId: unknown, runId: unknown) => {
		validateSender(event);
		validateRequestId(threadId);
		validateRequestId(runId);
		botTasks.releaseRenderer(threadId, runId);
	});
	ipcMain.handle('freelm:host-task-stop', (event, threadId: unknown) => {
		validateSender(event);
		validateRequestId(threadId);
		return botTasks.cancelThreads([threadId]);
	});
	ipcMain.handle('freelm:host-task-dispatch', (event, threadId: unknown) => {
		validateSender(event);
		validateRequestId(threadId);
		return botTasks.dispatch(threadId);
	});
	ipcMain.handle('freelm:host-task-answer', (event, id: unknown, answers: unknown) => {
		validateSender(event);
		validateRequestId(id);
		if (
			!answers ||
			typeof answers !== 'object' ||
			Array.isArray(answers) ||
			JSON.stringify(answers).length > 64000 ||
			!Object.values(answers).every(
				(value) =>
					value &&
					typeof value === 'object' &&
					Array.isArray(value.answers) &&
					value.answers.every((answer: unknown) => typeof answer === 'string'),
			)
		)
			throw new Error('Invalid question answers.');
		return botTasks.answerQuestion(id, answers as Record<string, { answers: string[] }>);
	});
	ipcMain.handle('freelm:bots-snapshot', async (event, target: unknown) => {
		validateSender(event);
		return directWorkspaceReply(await readDesktopWorkspace('bots-snapshot', [target]));
	});
	ipcMain.handle('freelm:bots-command', async (event, target: unknown, command: unknown) => {
		validateSender(event);
		const result = (await writeDesktopWorkspace('bots-command', [target], command)) as Omit<
			import('../src/bot-types').BotCommandResult,
			'snapshot'
		>;
		return directWorkspaceReply({
			...result,
			snapshot: await readDesktopWorkspace('bots-snapshot', [target]),
		});
	});
	ipcMain.handle(
		'freelm:workspace-transfer-open',
		async (event, operation: unknown, args: unknown) => {
			validateSender(event);
			return workspaceTransfers.encode(
				event.sender.id,
				await readDesktopWorkspace(operation, args),
			);
		},
	);
	ipcMain.handle(
		'freelm:workspace-transfer-read',
		(event, id: unknown, offset: number, length: number) => {
			validateSender(event);
			return workspaceTransfers.read(event.sender.id, id, offset, length);
		},
	);
	ipcMain.handle('freelm:workspace-transfer-create', (event, length: unknown, kind: unknown) => {
		validateSender(event);
		return workspaceTransfers.create(event.sender.id, length, kind);
	});
	ipcMain.handle(
		'freelm:workspace-transfer-write',
		(event, id: unknown, offset: unknown, chunk: unknown) => {
			validateSender(event);
			return workspaceTransfers.write(event.sender.id, id, offset, chunk);
		},
	);
	ipcMain.handle(
		'freelm:workspace-transfer-commit',
		(event, operation: unknown, args: unknown, descriptor: unknown) => {
			validateSender(event);
			return writeDesktopWorkspace(
				operation,
				args,
				workspaceTransfers.decode(event.sender.id, descriptor),
			);
		},
	);
	ipcMain.handle('freelm:workspace-transfer-release', (event, ids: unknown) => {
		validateSender(event);
		return workspaceTransfers.release(event.sender.id, ids);
	});
	ipcMain.handle('freelm:clipboard-write-text', (event, text: unknown) => {
		validateSender(event);
		if (typeof text !== 'string') throw new Error('Clipboard content must be text.');
		return clipboard.writeText(text);
	});
	ipcMain.handle('freelm:request', async (event, request: unknown, streamToken: unknown) => {
		validateSender(event);
		validateRequest(request);
		const streaming = request.stream === true;
		let token = '';
		if (streaming) {
			validateRequestId(streamToken);
			token = streamToken;
		}
		if (request.workspaceId !== undefined) validateTarget(request.workspaceId);
		if (request.connectionId !== undefined) validateRequestId(request.connectionId);
		const remote =
			request.workspaceId && request.workspaceId !== 'local' ? request.workspaceId : undefined;
		if (remote && !request.connectionId) throw new Error('A remote API connection is required.');
		if (requests.has(request.id)) throw new Error('This request is already running.');
		if (requests.size >= 20)
			throw new Error('Too many requests are running. Wait for one to finish.');
		const controller = new AbortController();
		requests.set(request.id, controller);
		let deliveryFailed = false;
		const sendStreamEvent = (value: StreamEvent) => {
			if (event.sender.isDestroyed()) return;
			try {
				event.sender.send(STREAM_CHANNEL, value);
			} catch (error) {
				deliveryFailed = true;
				throw error;
			}
		};
		try {
			const execute = remote
				? (
						request: Parameters<typeof performRequest>[0],
						onChunk: Parameters<typeof performRequest>[1],
						signal?: AbortSignal,
					) => instances.request(remote, request, onChunk, signal)
				: mediaModeration.request.bind(mediaModeration);
			let response;
			try {
				response = await execute(
					request,
					(chunk) => {
						if (streaming && !controller.signal.aborted)
							sendStreamEvent({ id: request.id, token, type: 'chunk', text: chunk });
					},
					controller.signal,
				);
			} catch (error) {
				if (!streaming || deliveryFailed) throw error;
				sendStreamEvent({
					id: request.id,
					token,
					type: 'error',
					error: {
						name: error instanceof Error ? error.name.slice(0, 128) : 'Error',
						message:
							error instanceof Error ? error.message.slice(0, 4096) : 'The API request failed.',
					},
				});
				return null;
			}
			if (!streaming) return response;
			sendStreamEvent({ id: request.id, token, type: 'complete', response });
			// This invoke reply only acknowledges the call. The ordered stream event settles it.
			return null;
		} finally {
			requests.delete(request.id);
		}
	});
	ipcMain.handle('freelm:cancel', (event, id: unknown) => {
		validateSender(event);
		validateRequestId(id);
		requests.get(id)?.abort();
	});
	ipcMain.handle('freelm:load', async (event) => {
		validateSender(event);
		return directWorkspaceReply(await readDesktopWorkspace('load', []));
	});
	ipcMain.handle('freelm:save', async (event, state: AppState) => {
		validateSender(event);
		return writeDesktopWorkspace('save', [], state);
	});
	ipcMain.handle('freelm:workspace-load', async (event, target: unknown) => {
		validateSender(event);
		return directWorkspaceReply(await readDesktopWorkspace('workspace-load', [target]));
	});
	ipcMain.handle('freelm:code-surface', async (event, request: unknown) => {
		validateSender(event);
		validateCodeSurfaceRequest(request);
		validateTarget(request.workspaceId);
		const result = await (request.workspaceId === 'local'
			? codeSurface.execute(request)
			: instances.codeSurface(request));
		return result.kind === 'preview'
			? { ...result, html: '', url: codeHtmlViews.create(result.html) }
			: result;
	});
	ipcMain.handle('freelm:code-browser', (event, request: unknown) => {
		validateSender(event);
		if (!codeBrowser) throw new Error('Browser unavailable.');
		return codeBrowser.handle(request);
	});
	ipcMain.handle('freelm:composer-discover', async (event, request: unknown) => {
		validateSender(event);
		validateComposerDiscovery(request);
		validateTarget(request.workspaceId);
		return request.workspaceId === 'local'
			? composer.discover(request)
			: instances.composerDiscover(request.workspaceId, request);
	});
	ipcMain.handle(
		'freelm:composer-resolve',
		async (event, target: unknown, threadId: unknown, messageId: unknown) => {
			validateSender(event);
			validateTarget(target);
			validateComposerResolution(threadId, messageId);
			return target === 'local'
				? composer.resolve(threadId, messageId as string)
				: instances.composerResolve(target, threadId, messageId as string);
		},
	);
	ipcMain.handle('freelm:task-output-status', async (event, target: unknown, threadId: unknown) => {
		validateSender(event);
		validateTarget(target);
		validateTaskOutputThreadId(threadId);
		return target === 'local'
			? taskOutputStatus(authority, threadId)
			: instances.taskOutputStatus(target, threadId);
	});
	ipcMain.handle(
		'freelm:task-output-read',
		async (event, target: unknown, threadId: unknown, outputId: unknown) => {
			validateSender(event);
			validateTarget(target);
			validateTaskOutputIds(threadId, outputId);
			return target === 'local'
				? readTaskOutput(authority, threadId, outputId as string)
				: instances.taskOutputRead(target, threadId, outputId as string);
		},
	);
	ipcMain.handle(
		'freelm:workspace-save',
		async (event, target: unknown, revision: unknown, state: AppState) => {
			validateSender(event);
			return writeDesktopWorkspace('workspace-save', [target, revision], state);
		},
	);
	ipcMain.handle(
		'freelm:workspace-patch',
		async (event, target: unknown, revision: unknown, patch: unknown) => {
			validateSender(event);
			return writeDesktopWorkspace('workspace-patch', [target, revision], patch);
		},
	);
	ipcMain.handle('freelm:search-status', async (event) => {
		validateSender(event);
		await searchService.ready;
		return search.status();
	});
	ipcMain.handle('freelm:search-start', (event) => {
		validateSender(event);
		return search.start();
	});
	ipcMain.handle('freelm:search-stop', (event) => {
		validateSender(event);
		return search.stop();
	});
	ipcMain.handle('freelm:instance-status', (event) => {
		validateSender(event);
		return instances.status();
	});
	ipcMain.handle('freelm:host-start', (event, options: { name: string; port: number }) => {
		validateSender(event);
		return instances.startHost(options);
	});
	ipcMain.handle('freelm:host-stop', (event) => {
		validateSender(event);
		return instances.stopHost();
	});
	ipcMain.handle('freelm:instance-connect', async (event, input: unknown) => {
		validateSender(event);
		return directWorkspaceReply(await readDesktopWorkspace('instance-connect', [input]));
	});
	ipcMain.handle('freelm:instance-open', async (event, id: unknown) => {
		validateSender(event);
		return directWorkspaceReply(await readDesktopWorkspace('instance-open', [id]));
	});
	ipcMain.handle('freelm:instance-disconnect', (event, id: unknown) => {
		validateSender(event);
		validateTarget(id);
		return instances.disconnect(id);
	});
	ipcMain.handle('freelm:instance-remove', (event, id: unknown) => {
		validateSender(event);
		validateTarget(id);
		return instances.remove(id);
	});
	ipcMain.handle(
		'freelm:instance-asset',
		async (
			event,
			target: unknown,
			connectionId: unknown,
			url: unknown,
			kind: unknown = 'image',
		) => {
			validateSender(event);
			validateTarget(target);
			validateRequestId(connectionId);
			validateAssetUrl(url);
			if (kind !== 'image' && kind !== 'video') throw new Error('Unsupported media type.');
			if (target === 'local') {
				const snapshot = await authority.load();
				if (!snapshot.state?.connections.some((connection) => connection.id === connectionId))
					throw new Error('The media API connection is no longer available.');
				if (requests.size >= 20) throw new Error('Too much media is loading. Try again shortly.');
				const id = `asset:${crypto.randomUUID()}`;
				const controller = new AbortController();
				requests.set(id, controller);
				try {
					return await (kind === 'video' ? downloadVideoAsset : downloadImageAsset)(
						url,
						controller.signal,
					);
				} finally {
					requests.delete(id);
				}
			}
			return instances.asset(target, connectionId, url);
		},
	);
	ipcMain.handle('freelm:notify-completion', (event, input: unknown) => {
		validateSender(event);
		if (!input || typeof input !== 'object' || Array.isArray(input))
			throw new Error('Invalid notification.');
		const { threadId, title } = input as { threadId: unknown; title: unknown };
		validateRequestId(threadId);
		if (typeof title !== 'string' || title.length > 4096)
			throw new Error('Invalid notification title.');
		if (!Notification.isSupported() || mainWindow?.isFocused()) return;
		const notification = new Notification({
			title: `FreeLM · ${title.slice(0, 160)}`,
			body: 'Your reply is ready.',
		});
		notification.on('click', () => {
			mainWindow?.show();
			mainWindow?.focus();
			mainWindow?.webContents.send('freelm:open-thread', threadId);
		});
		notification.show();
	});
	ipcMain.handle('freelm:workspace-backup', (event, state: AppState) => {
		validateSender(event);
		return writeDesktopWorkspace('workspace-backup', [], state);
	});
	ipcMain.handle('freelm:storage-info', (event) => {
		validateSender(event);
		return store.info();
	});
	ipcMain.handle('freelm:complete-close', async (event) => {
		validateSender(event);
		if (!closeRequested || allowWindowClose) return;
		await authority.load();
		await store.flush();
		if (quitRequested) await closeInstances();
		allowWindowClose = true;
		// Let the invoke reply settle before disposing its renderer.
		setImmediate(() => {
			if (quitRequested) app.quit();
			else mainWindow?.close();
		});
	});
}

function createMenu() {
	const isMac = process.platform === 'darwin';
	const command = (name: 'new-chat' | 'settings') =>
		mainWindow?.webContents.send('freelm:command', name);
	const template: MenuItemConstructorOptions[] = [
		...(isMac
			? [
					{
						label: app.name,
						submenu: [
							{ role: 'about' as const },
							{ type: 'separator' as const },
							{ label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => command('settings') },
							{ type: 'separator' as const },
							{ role: 'services' as const },
							{ type: 'separator' as const },
							{ role: 'hide' as const },
							{ role: 'hideOthers' as const },
							{ role: 'unhide' as const },
							{ type: 'separator' as const },
							{ role: 'quit' as const },
						],
					},
				]
			: []),
		{
			label: 'File',
			submenu: [
				{ label: 'New chat', accelerator: 'CmdOrCtrl+N', click: () => command('new-chat') },
				...(!isMac
					? [{ label: 'Settings…', accelerator: 'Ctrl+,', click: () => command('settings') }]
					: []),
				{ type: 'separator' },
				{ role: isMac ? 'close' : 'quit' },
			],
		},
		{ role: 'editMenu' },
		{
			label: 'View',
			submenu: [
				{ role: 'reload' },
				...(!app.isPackaged ? [{ role: 'toggleDevTools' as const }] : []),
				{ type: 'separator' },
				{ role: 'resetZoom' },
				{ role: 'zoomIn' },
				{ role: 'zoomOut' },
				{ type: 'separator' },
				{ role: 'togglefullscreen' },
			],
		},
		{ role: 'windowMenu' },
	];
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
	closeRequested = false;
	allowWindowClose = false;
	mainWindow = new BrowserWindow({
		width: 1440,
		height: 940,
		minWidth: 820,
		minHeight: 600,
		title: 'FreeLM',
		icon: appIconPath,
		backgroundColor: '#212121',
		show: false,
		...(process.platform === 'darwin'
			? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 20, y: 19 } }
			: {}),
		webPreferences: {
			// Bot-delegated work must keep reaching task/paint boundaries when minimized.
			backgroundThrottling: false,
			preload: path.join(__dirname, 'preload.cjs'),
			nodeIntegration: false,
			contextIsolation: true,
			sandbox: true,
			webSecurity: true,
			allowRunningInsecureContent: false,
			webviewTag: false,
		},
	});
	codeBrowser?.dispose();
	codeBrowser = new CodeBrowserService(mainWindow, {
		onState: (state) => {
			if (!mainWindow?.webContents.isDestroyed())
				mainWindow?.webContents.send('freelm:code-browser-state', state);
		},
		onElement: (selection) => {
			if (!mainWindow?.webContents.isDestroyed())
				mainWindow?.webContents.send('freelm:code-browser-element', selection);
		},
	});
	const contents = mainWindow.webContents;
	contents.on('context-menu', (_event, params) => {
		const template = textContextMenu(params);
		if (template.length && mainWindow)
			Menu.buildFromTemplate(template).popup({ window: mainWindow });
	});
	contents.setWindowOpenHandler(({ url }) => {
		openExternal(url);
		return { action: 'deny' };
	});
	contents.on('will-navigate', (event, url) => {
		event.preventDefault();
		openExternal(url);
	});
	contents.on('will-attach-webview', (event) => event.preventDefault());
	contents.on('will-frame-navigate', (event) => {
		// Only host-issued, short-lived documents can load in plugin frames.
		if (
			!event.isMainFrame &&
			event.url !== 'about:blank' &&
			!pluginViews.allows(event.url) &&
			!codeHtmlViews.allows(event.url)
		)
			event.preventDefault();
	});
	contents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
		if (mainFrame && !inPlace) {
			pluginSurfaces?.closeOwner(contents.id);
			pluginViews.clear();
			codeHtmlViews.clear();
			workspaceTransfers.clear(contents.id);
			void botTasks
				?.rendererClosed()
				.catch((error) => console.error('Detached renderer task recovery:', error));
		}
	});
	contents.on('did-finish-load', () => agent?.replayApprovals());
	contents.on('render-process-gone', () => {
		pluginSurfaces?.closeOwner(contents.id);
		void botTasks
			?.rendererClosed()
			.catch((error) => console.error('Detached renderer task recovery:', error));
		workspaceTransfers.clear(contents.id);
		void cancelAgentRuns?.();
		for (const controller of requests.values()) controller.abort();
	});
	contents.session.setPermissionCheckHandler((webContents, permission, _origin, details) => {
		return webContents === contents && permission === 'media' && details.mediaType === 'audio';
	});
	contents.session.setPermissionRequestHandler((webContents, permission, callback, details) => {
		callback(
			webContents === contents &&
				isAppUrl(details.requestingUrl) &&
				permission === 'media' &&
				'mediaTypes' in details &&
				!!details.mediaTypes?.length &&
				details.mediaTypes.every((type) => type === 'audio'),
		);
	});
	mainWindow.once('ready-to-show', () => mainWindow?.show());
	mainWindow.on('close', (event) => {
		if (allowWindowClose) return;
		event.preventDefault();
		closeRequested = true;
		void botTasks
			?.rendererClosed()
			.catch((error) => console.error('Detached renderer task recovery:', error));
		void cancelAgentRuns?.();
		for (const controller of requests.values()) controller.abort();
		contents.send('freelm:prepare-close');
	});
	mainWindow.on('closed', () => {
		void botTasks
			?.rendererClosed()
			.catch((error) => console.error('Detached renderer task recovery:', error));
		workspaceTransfers.clear(contents.id);
		void cancelAgentRuns?.();
		for (const controller of requests.values()) controller.abort();
		mainWindow = null;
	});
	void (devUrl ? mainWindow.loadURL(devUrl) : mainWindow.loadFile(fileURLToPath(appUrl)));
}

void app
	.whenReady()
	.then(async () => {
		if (!ownsProfile) return;
		// Packaged macOS builds use the bundle's ICNS. The Electron dev host needs
		// an explicit Dock icon; Linux and Windows use the BrowserWindow icon above.
		if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(appIconPath);
		protocol.handle('freelm-plugin', (request) => pluginViews.respond(request));
		protocol.handle('freelm-code-preview', (request) => codeHtmlViews.respond(request));
		await initializeStorage(storagePaths);
		// Feature-detect the async API introduced after Electron 38. Linux also rejects
		// the basic_text fallback, whose encryption password is not a user secret.
		const secretApi = safeStorage as typeof safeStorage & {
			isAsyncEncryptionAvailable?: () => Promise<boolean>;
			encryptStringAsync?: (value: string) => Promise<Buffer>;
			decryptStringAsync?: (value: Buffer) => Promise<{ result: string }>;
		};
		const asynchronous =
			typeof secretApi.isAsyncEncryptionAvailable === 'function' &&
			typeof secretApi.encryptStringAsync === 'function' &&
			typeof secretApi.decryptStringAsync === 'function';
		let secretAvailability: boolean | undefined;
		const secrets: SecretStorage = {
			// Even the synchronous availability API can access the macOS keychain.
			// Informational UI uses only the last real credential operation's status.
			status: () => secretAvailability,
			available: async () => {
				const available = asynchronous
					? await secretApi.isAsyncEncryptionAvailable!()
					: safeStorage.isEncryptionAvailable();
				secretAvailability =
					available &&
					(process.platform !== 'linux' ||
						(typeof safeStorage.getSelectedStorageBackend === 'function' &&
							!['basic_text', 'unknown'].includes(safeStorage.getSelectedStorageBackend())));
				return secretAvailability;
			},
			encrypt: (value) =>
				asynchronous ? secretApi.encryptStringAsync!(value) : safeStorage.encryptString(value),
			decrypt: async (value) =>
				asynchronous
					? (await secretApi.decryptStringAsync!(value)).result
					: safeStorage.decryptString(value),
		};
		store = new StateStore(storagePaths.workspace, secrets, storagePaths.config);
		plugins = new PluginHost({
			directory: path.join(storagePaths.home, 'plugins'),
			secrets,
			openExternal: (url) => shell.openExternal(url),
		});
		authority = new WorkspaceAuthority(store);
		pluginSurfaces = new PluginSurfaceHost({
			plugins,
			emit: (owner, call) => {
				if (mainWindow?.webContents.id === owner && !mainWindow.webContents.isDestroyed())
					mainWindow.webContents.send('freelm:plugin-surface-call', call);
			},
			connection: async (hostId, connectionId) => {
				if (hostId === 'local')
					return (await authority.loadModerationState()).connections.find(
						(c) => c.id === connectionId,
					);
				validateTarget(hostId);
				return (await instances.load(hostId)).state?.connections.find((c) => c.id === connectionId);
			},
			execute: (hostId, request, onChunk, signal) =>
				hostId === 'local'
					? performRequest(request, onChunk, signal)
					: instances.request(hostId, request, onChunk, signal),
			viewURL: (html, options) => pluginViews.create(html, options),
			foregroundBusy: () => requests.size > 0,
		});
		codeSurface = new CodeSurfaceService((request) => authority.loadComposerState(request));
		composer = new ComposerContextHost(
			(request) => authority.loadComposerState(request),
			(query) => agent.service.computerApps(query),
		);
		mediaModeration = new MediaModerationGuard(() => authority.loadModerationState());
		// Validate/decrypt before any renderer can initialize and autosave a fresh state.
		await authority.load();
		const searchBundle = app.isPackaged
			? path.join(process.resourcesPath, 'search')
			: path.resolve(__dirname, '../resources/search');
		searchService = new SearchServiceManager({
			searchHome: path.join(storagePaths.home, 'search'),
			bundleRoot: searchBundle,
			executablePath: path.join(
				searchBundle,
				'runtime',
				`${process.platform}-${process.arch}`,
				'python',
				'bin',
				'python3',
			),
			launcherPath: path.join(searchBundle, 'launcher.py'),
		});
		search = new SearchController(searchService, () => authority.loadSearchSettings());
		searchService.onStatus((status) => {
			const contents = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : undefined;
			if (contents && !contents.isDestroyed()) contents.send('freelm:search-status', status);
		});
		await searchService.ready;
		agent = createAgentHost(
			authority,
			() => mainWindow,
			(settings) => search.resolve(settings),
			storagePaths.home,
			plugins,
		);
		instances = new InstanceManager(
			storagePaths.instances,
			secrets,
			authority,
			undefined,
			agent.service,
		);
		await instances.status();
		botTasks = new HostTaskService({
			authority,
			agent: agent.service,
			hostId: async () => (await instances.status()).host.instanceId,
			request: performRequest,
			changed: () => {
				const contents =
					mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : undefined;
				if (contents && !contents.isDestroyed()) contents.send('freelm:host-tasks-changed');
			},
			completed: async (thread) => {
				if (workflows && workflowHostInitialized)
					await workflows.emit('thread.completed', {
						threadId: thread.id,
						title: thread.title,
						workspaceId: 'local',
					});
			},
			resolveMentions: async (threadId, messageId) =>
				(await composer.resolve(threadId, messageId)).instructions,
		});
		await botTasks.ready;
		workflowThreadsReady = true;
		workflowHostInitialized = true;
		agent.onApproval((approval, waiting) => botTasks.noteApproval(approval.runId, waiting));
		instances.setBotTasks(botTasks);
		const workflowRoot = path.join(storagePaths.home, 'workflows');
		const artifactDirectory = path.join(workflowRoot, 'artifacts');
		workflowPreviews = new WorkflowPreviews(new WorkflowAssets(artifactDirectory));
		protocol.handle('freelm-workflow', (request) => workflowPreviews.respond(request));
		workflowAdapters = createWorkflowAdapters({
			loadState: () => authority.loadToolState(),
			request: (request, onChunk, signal) => performRequest(request, onChunk, signal),
			createAgentHost: (load) =>
				new AgentHost(
					load,
					agent.requestApproval,
					(settings) => search.resolve(settings),
					undefined,
					() => load(),
					path.join(workflowRoot, 'code'),
					undefined,
					undefined,
					plugins,
				),
			task: async (name, args, operationId, signal) => {
				while (!workflowThreadsReady) {
					signal.throwIfAborted();
					await new Promise<void>((resolve, reject) => {
						const timer = setTimeout(() => {
							signal.removeEventListener('abort', abort);
							resolve();
						}, 250);
						const abort = () => {
							clearTimeout(timer);
							reject(signal.reason ?? new Error('Workflow cancelled.'));
						};
						signal.addEventListener('abort', abort, { once: true });
					});
				}
				const { host } = await instances.status();
				return instances.botTask(
					name,
					{
						...args,
						hostId: args.hostId && args.hostId !== 'local' ? args.hostId : host.instanceId,
					},
					operationId,
					signal,
				);
			},
			notify: (title, body) => {
				if (!Notification.isSupported())
					throw new Error('Desktop notifications are unavailable on this host.');
				new Notification({ title: `FreeLM · ${title}`, body }).show();
			},
			artifactDirectory,
		});
		workflows = new WorkflowEngine({
			store: new WorkflowStore(workflowRoot),
			resolveProject: async (id) => {
				const { projects } = await authority.loadWorkflowContext();
				const project = projects.find((item) => item.id === id);
				return project ? { ...project, directories: project.directories ?? [] } : undefined;
			},
			canRun: () => workflowHostInitialized && !workflowInitializationError,
			execute: workflowAdapters.execute,
			onChange: () => {
				const contents =
					mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : undefined;
				if (contents && !contents.isDestroyed()) contents.send('freelm:workflows-changed');
				workflowNotifications?.schedule();
			},
			onError: (error) => console.error('Workflow background task:', error),
		});
		try {
			await workflows.init();
			agent.service.setWorkflowTools(new WorkflowToolService(workflows));
			workflowNotifications = new WorkflowThreadNotifications({
				filename: path.join(workflowRoot, 'completion-receipts.json'),
				runs: () => workflows.listThreadCompletions(),
				threads: async () => (await authority.loadWorkflowContext()).threads,
				ready: () => workflowThreadsReady && !quitRequested,
				deliver: (threadId, prompt, operationId) =>
					botTasks.execute('threads_send', { threadId, prompt }, operationId),
				onError: (error) => console.error('Workflow completion delivery:', error),
			});
			await workflowNotifications.init();
		} catch (error) {
			workflowInitializationError = `Could not load workflows: ${error instanceof Error ? error.message : String(error)}. Your other FreeLM workspaces are still available.`;
			console.error(workflowInitializationError);
		}
		bots = new BotHost({
			filename: path.join(storagePaths.home, 'bots', 'workspace.json'),
			schedulerToolDefinitions: () =>
				!schedulerReady
					? []
					: schedulerTools.map(({ name, description, parameters }) => ({
							name: name.replace('.', '_'),
							description,
							parameters,
						})),
			executeSchedulerTool: async (name, args, context) => {
				if (!schedulerReady)
					throw new Error(schedulerInitializationError || 'Scheduler is not ready.');
				if (context.remote)
					throw new Error('Scheduling is available only on the bot’s local host.');
				const result = await scheduleTools.execute(
					name.replace(/^scheduler_/, 'scheduler.'),
					args,
					{
						origin: {
							kind: 'bot',
							botId: context.bot.id,
							conversationId: context.conversationId,
							userMessageId: context.userMessageId,
						},
						signal: context.signal,
					},
				);
				return result.content
					.filter((part) => part.type === 'text')
					.map((part) => (part.type === 'text' ? part.text : ''))
					.join('\n');
			},
			onScheduledReply: ({ title, content, failed }) =>
				showSchedulerNotification(
					title,
					failed ? `Scheduled task needs attention: ${content}` : content,
				),
			pluginDefinitions: (bot, remote) =>
				plugins.catalog({ surface: 'bot', botId: bot.id, remote }),
			executePlugin: (name, args, context) =>
				plugins.execute(
					{ surface: 'bot', botId: context.bot.id, remote: context.remote },
					name,
					args,
					context.signal,
					{
						operationId: context.operationId,
						...(context.approval ? { approval: context.approval } : {}),
					},
				),
			identity: async () => {
				const { host } = await instances.status();
				return { id: host.instanceId, name: host.name };
			},
			workspace: () => authority.loadBotState(),
			onChanged: () => {
				const contents =
					mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : undefined;
				if (contents && !contents.isDestroyed()) contents.send('freelm:bots-changed');
			},
			remoteSteer: (participant, request, signal) =>
				instances.botsSteer(participant, request, signal),
			remoteGroupSend: (hostId, request, signal) =>
				instances.botsGroupSend(hostId, request, signal),
			remoteProfile: (participant) => instances.botProfile(participant),
			groupSnapshots: (signal) => instances.connectedBotSnapshots(signal),
			remoteRespond: (participant, request, signal, onActivity, onMessage) =>
				instances.botsRespond(participant, request, signal, onActivity, onMessage),
			pollTask: async (participant, watch, signal) => {
				const { host } = await instances.status();
				if (participant.hostId !== host.instanceId)
					return instances.botsPollTask(participant, watch, signal);
				return instances.botTask(
					'threads_wait',
					{
						hostId: watch.hostId,
						targets: [
							{
								threadId: watch.threadId,
								...(watch.afterCursor ? { afterCursor: watch.afterCursor } : {}),
							},
						],
						timeoutMs: 0,
					},
					`bot-watch:${watch.hostId}:${watch.threadId}`,
					signal,
				);
			},
			taskToolDefinitions: (bot) =>
				bot.historyAccess
					? [
							{
								name: 'hosts_list',
								description:
									'List this bot’s home computer and its connected FreeLM hosts. Use the returned stable hostId when working with remote threads. Never assume thread IDs are global.',
								parameters: { type: 'object', properties: {}, additionalProperties: false },
							},
							...botTaskTools.map(({ name, description, parameters }) => ({
								name,
								description,
								parameters,
							})),
						]
					: [],
			executeTaskTool: async (name, args, context) => {
				if (!context.bot.historyAccess)
					throw new Error('Chat and Code thread access is disabled for this bot.');
				if (name === 'hosts_list') {
					if (Object.keys(args).length) throw new Error('hosts_list takes no arguments.');
					const { host, instances: remotes } = await instances.status();
					return {
						hosts: [
							{ hostId: host.instanceId, name: host.name, local: true, connected: true },
							...remotes
								.filter((item) => item.instanceId && item.connected)
								.map((item) => ({
									hostId: item.instanceId,
									name: item.name,
									local: false,
									connected: item.connected,
								})),
						],
					};
				}
				if (context.remote) {
					const { host } = await instances.status();
					if (args.hostId === undefined || args.hostId === host.instanceId)
						assertBotTaskRemoteExecution(name, args, await authority.loadToolState());
				}
				return instances.botTask(name, args, context.operationId, context.signal);
			},
		});
		instances.setBots(bots);
		const { host: schedulerHost } = await instances.status();
		scheduler = new SchedulerService({
			filename: path.join(storagePaths.home, 'scheduler', 'jobs.json'),
			hostId: schedulerHost.instanceId,
			autoStart: false,
			dispatch: createSchedulerDispatcher({
				codeReady: () => workflowThreadsReady && !quitRequested,
				codeThread: async (id) =>
					(await authority.loadWorkflowContext()).threads.find((thread) => thread.id === id),
				sendCode: (threadId, prompt, operationId, signal) =>
					botTasks.execute('threads_send', { threadId, prompt }, operationId, signal),
				remindBot: (input) => bots.deliverScheduledReminder(input),
				wakeBot: (input) => bots.wakeScheduled(input),
				notify: showSchedulerNotification,
			}),
			onChange: () => {
				const contents =
					mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : undefined;
				if (contents && !contents.isDestroyed()) contents.send('freelm:scheduler-changed');
			},
			onError: (error) => console.error('Scheduler:', error),
		});
		try {
			await scheduler.init();
			scheduleTools = new SchedulerToolService(scheduler);
			agent.service.setSchedulerTools(scheduleTools);
			schedulerReady = true;
		} catch (error) {
			schedulerInitializationError = `Could not load scheduled tasks: ${error instanceof Error ? error.message : String(error)}. Your other FreeLM features are still available.`;
			console.error(schedulerInitializationError);
		}
		await bots.start().catch((error) => console.error('Could not start the bot mailbox:', error));
		if (schedulerReady) scheduler.start();
		registerBridge();
		cancelAgentRuns = registerAgentBridge({
			validateSender,
			window: () => mainWindow,
			agent,
			instances,
		});
		createMenu();
		createWindow();
		reconcileSearch();
		app.on('activate', () => {
			if (BrowserWindow.getAllWindows().length === 0) createWindow();
		});
	})
	.catch((error) => {
		dialog.showErrorBox(
			'FreeLM could not open your data',
			error instanceof Error ? error.message : String(error),
		);
		app.exit(1);
	});
app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', (event) => {
	agent?.service.cancelAll();
	void cancelAgentRuns?.();
	quitRequested = true;
	for (const controller of requests.values()) controller.abort();
	if ((!mainWindow || allowWindowClose) && !managerClosed && instances) {
		event.preventDefault();
		void closeInstances()
			.then(() => app.quit())
			.catch((error) => console.error('Could not finish shutdown:', error));
	}
});

function closeInstances() {
	pluginSurfaces?.closeAll();
	workflowPreviews?.clear();
	return (shutdown ??= Promise.all([
		scheduler?.close(),
		workflowNotifications?.close(),
		workflows?.dispose().then(() => workflowAdapters?.close()),
		botTasks?.close(),
		bots?.close(),
		plugins?.close(),
		instances.close(),
		agent?.service.close(),
		search?.close(),
	]).then(() => {
		managerClosed = true;
	}));
}

function showSchedulerNotification(title: string, body: string) {
	if (!Notification.isSupported()) return;
	const notification = new Notification({
		title: `FreeLM · ${title.slice(0, 160)}`,
		body: body.slice(0, 4000),
	});
	notification.on('click', () => {
		pendingSchedulerNavigation = true;
		if (!mainWindow) createWindow();
		mainWindow?.show();
		mainWindow?.focus();
		mainWindow?.webContents.send('freelm:open-scheduler');
	});
	notification.show();
}

function reconcileSearch() {
	void search?.update().catch(() => {
		// The helper's status carries the bounded, readable startup error. A valid
		// configuration stays saved even if its optional service cannot start.
	});
}

function validateTarget(value: unknown): asserts value is string {
	if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value))
		throw new Error('Invalid workspace identifier.');
}
