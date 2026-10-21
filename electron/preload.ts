import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge } from '../src/types';
import { createStreamBridge } from './stream-bridge';
import { STREAM_CHANNEL, type StreamEvent } from './stream-protocol';

const streams = createStreamBridge({
	invoke: (request, token) => ipcRenderer.invoke('freelm:request', request, token),
	cancel: (id) => ipcRenderer.invoke('freelm:cancel', id),
});
ipcRenderer.on(STREAM_CHANNEL, (_event, value: StreamEvent) => streams.receive(value));

const closeListeners = new Set<() => void>();
let closePending = false;
ipcRenderer.on('freelm:prepare-close', () => {
	closePending = true;
	for (const listener of closeListeners) listener();
});

const bridge: DesktopBridge = {
	pluginSurfaceOpen: (binding) => ipcRenderer.invoke('freelm:plugin-surface-open', binding),
	pluginSurfaceActivate: (ids) => ipcRenderer.invoke('freelm:plugin-surface-activate', ids),
	pluginSurfaceClose: (ids) => ipcRenderer.invoke('freelm:plugin-surface-close', ids),
	pluginSurfaceReply: (sessionId, requestId, reply) =>
		ipcRenderer.invoke('freelm:plugin-surface-reply', sessionId, requestId, reply),
	pluginSurfaceEvent: (sessionId, name, payload) =>
		ipcRenderer.invoke('freelm:plugin-surface-event', sessionId, name, payload),
	pluginSurfaceCommand: (sessionId, id, payload) =>
		ipcRenderer.invoke('freelm:plugin-surface-command', sessionId, id, payload),
	pluginSurfaceViewCall: (sessionId, method, args) =>
		ipcRenderer.invoke('freelm:plugin-surface-view-call', sessionId, method, args),
	onPluginSurfaceCall: (listener) => {
		const handler = (
			_event: Electron.IpcRendererEvent,
			call: import('../src/plugin-surface-types').PluginSurfaceCall,
		) => listener(call);
		ipcRenderer.on('freelm:plugin-surface-call', handler);
		return () => ipcRenderer.removeListener('freelm:plugin-surface-call', handler);
	},
	pluginSnapshot: () => ipcRenderer.invoke('freelm:plugins-snapshot'),
	pluginCommand: (command) => ipcRenderer.invoke('freelm:plugins-command', command),
	pluginCancelConnect: () => ipcRenderer.invoke('freelm:plugins-cancel-connect'),
	pluginPreparePackage: (bytes) => ipcRenderer.invoke('freelm:plugins-prepare-package', bytes),
	pluginInstallPackage: (reviewId) =>
		ipcRenderer.invoke('freelm:plugins-install-package', reviewId),
	pluginTabContent: (pluginId, tabId, options) =>
		ipcRenderer.invoke('freelm:plugins-tab-content', pluginId, tabId, options),
	pluginInvokeAction: (pluginId, tabId, accountId, action, args) =>
		ipcRenderer.invoke('freelm:plugins-invoke-action', pluginId, tabId, accountId, action, args),
	botTasksReady: (ready) => ipcRenderer.invoke('freelm:bot-tasks-ready', ready),
	hostTasksSnapshot: () => ipcRenderer.invoke('freelm:host-tasks-snapshot'),
	onHostTasksChanged: (listener) => {
		const handler = () => listener();
		ipcRenderer.on('freelm:host-tasks-changed', handler);
		return () => ipcRenderer.removeListener('freelm:host-tasks-changed', handler);
	},
	hostTaskClaim: (threadId, runId) => ipcRenderer.invoke('freelm:host-task-claim', threadId, runId),
	hostTaskRelease: (threadId, runId) =>
		ipcRenderer.invoke('freelm:host-task-release', threadId, runId),
	hostTaskStop: (threadId) => ipcRenderer.invoke('freelm:host-task-stop', threadId),
	hostTaskDispatch: (threadId) => ipcRenderer.invoke('freelm:host-task-dispatch', threadId),
	hostTaskAnswer: (id, answers) => ipcRenderer.invoke('freelm:host-task-answer', id, answers),
	botTaskResult: (id, response) => ipcRenderer.invoke('freelm:bot-task-result', id, response),
	onBotTaskRequest: (listener) => {
		const handler = (
			_event: Electron.IpcRendererEvent,
			request: import('../src/bot-task-types').BotTaskRequest,
		) => listener(request);
		ipcRenderer.on('freelm:bot-task-request', handler);
		return () => ipcRenderer.removeListener('freelm:bot-task-request', handler);
	},
	onBotTaskCancel: (listener) => {
		const handler = (_event: Electron.IpcRendererEvent, id: string) => listener(id);
		ipcRenderer.on('freelm:bot-task-cancel', handler);
		return () => ipcRenderer.removeListener('freelm:bot-task-cancel', handler);
	},
	schedulerSnapshot: () => ipcRenderer.invoke('freelm:scheduler-snapshot'),
	schedulerCommand: (command) => ipcRenderer.invoke('freelm:scheduler-command', command),
	schedulerTakeNavigation: () => ipcRenderer.invoke('freelm:scheduler-take-navigation'),
	onOpenScheduler: (listener) => {
		const handler = () => listener();
		ipcRenderer.on('freelm:open-scheduler', handler);
		return () => ipcRenderer.removeListener('freelm:open-scheduler', handler);
	},
	onSchedulerChanged: (listener) => {
		const handler = () => listener();
		ipcRenderer.on('freelm:scheduler-changed', handler);
		return () => ipcRenderer.removeListener('freelm:scheduler-changed', handler);
	},
	workflowSnapshot: (scope?: { bindingId?: string; projectId?: string }) =>
		ipcRenderer.invoke('freelm:workflow-snapshot', scope),
	workflowBindings: () => ipcRenderer.invoke('freelm:workflow-bindings'),
	workflowCommand: (command) => ipcRenderer.invoke('freelm:workflow-command', command),
	workflowAsset: (runId, path) => ipcRenderer.invoke('freelm:workflow-asset', runId, path),
	workflowThreadCompleted: (input) => ipcRenderer.invoke('freelm:workflow-thread-completed', input),
	onWorkflowsChanged: (listener) => {
		const handler = () => listener();
		ipcRenderer.on('freelm:workflows-changed', handler);
		return () => ipcRenderer.removeListener('freelm:workflows-changed', handler);
	},
	botsSnapshot: (target) => ipcRenderer.invoke('freelm:bots-snapshot', target),
	botsCommand: (target, command) => ipcRenderer.invoke('freelm:bots-command', target, command),
	onBotsChanged: (listener) => {
		const handler = () => listener();
		ipcRenderer.on('freelm:bots-changed', handler);
		return () => ipcRenderer.removeListener('freelm:bots-changed', handler);
	},
	workspaceTransfer: {
		open: (operation, args) =>
			ipcRenderer.invoke('freelm:workspace-transfer-open', operation, args),
		read: (id, offset, length) =>
			ipcRenderer.invoke('freelm:workspace-transfer-read', id, offset, length),
		create: (length, kind) => ipcRenderer.invoke('freelm:workspace-transfer-create', length, kind),
		write: (id, offset, chunk) =>
			ipcRenderer.invoke('freelm:workspace-transfer-write', id, offset, chunk),
		commit: (operation, args, descriptor) =>
			ipcRenderer.invoke('freelm:workspace-transfer-commit', operation, args, descriptor),
		release: (ids) => ipcRenderer.invoke('freelm:workspace-transfer-release', ids),
	},
	clipboardWriteText: (text) => ipcRenderer.invoke('freelm:clipboard-write-text', text),
	computerSetup: (action) => ipcRenderer.invoke('freelm:computer-setup', action),
	computerStatus: () => ipcRenderer.invoke('freelm:computer-status'),
	computerSessions: () => ipcRenderer.invoke('freelm:computer-sessions'),
	computerStop: (sessionId) => ipcRenderer.invoke('freelm:computer-stop', sessionId),
	onComputerPreview: (listener) => {
		const handler = (
			_event: Electron.IpcRendererEvent,
			preview: import('../src/computer-types').ComputerSessionPreview,
		) => listener(preview);
		ipcRenderer.on('freelm:computer-preview', handler);
		return () => ipcRenderer.removeListener('freelm:computer-preview', handler);
	},
	composerDiscover: (request) => ipcRenderer.invoke('freelm:composer-discover', request),
	composerResolve: (workspaceId, threadId, messageId) =>
		ipcRenderer.invoke('freelm:composer-resolve', workspaceId, threadId, messageId),
	codeSurface: (request) => ipcRenderer.invoke('freelm:code-surface', request),
	codeBrowser: (request) => ipcRenderer.invoke('freelm:code-browser', request),
	onCodeBrowserState: (listener) => {
		const handler = (
			_event: Electron.IpcRendererEvent,
			value: import('../src/code-browser-types').CodeBrowserState,
		) => listener(value);
		ipcRenderer.on('freelm:code-browser-state', handler);
		return () => ipcRenderer.removeListener('freelm:code-browser-state', handler);
	},
	onCodeBrowserElement: (listener) => {
		const handler = (
			_event: Electron.IpcRendererEvent,
			value: import('../src/code-browser-types').CodeBrowserSelection,
		) => listener(value);
		ipcRenderer.on('freelm:code-browser-element', handler);
		return () => ipcRenderer.removeListener('freelm:code-browser-element', handler);
	},
	taskOutputStatus: (workspaceId, threadId) =>
		ipcRenderer.invoke('freelm:task-output-status', workspaceId, threadId),
	taskOutputRead: (workspaceId, threadId, outputId) =>
		ipcRenderer.invoke('freelm:task-output-read', workspaceId, threadId, outputId),
	notifyCompletion: (input) => ipcRenderer.invoke('freelm:notify-completion', input),
	onOpenThread: (listener) => {
		const handler = (_event: Electron.IpcRendererEvent, id: string) => listener(id);
		ipcRenderer.on('freelm:open-thread', handler);
		return () => ipcRenderer.removeListener('freelm:open-thread', handler);
	},
	toolCatalog: (workspaceId, runId, threadId, temporary, claimTask) =>
		ipcRenderer.invoke('freelm:tool-catalog', workspaceId, runId, threadId, temporary, claimTask),
	toolExecute: (request) => ipcRenderer.invoke('freelm:tool-execute', request),
	toolCancel: (runId) => ipcRenderer.invoke('freelm:tool-cancel', runId),
	toolRelease: (runId, interrupted) =>
		ipcRenderer.invoke('freelm:tool-release', runId, interrupted),
	toolApprove: (id, approved, remember) =>
		ipcRenderer.invoke('freelm:tool-approve', id, approved, remember),
	onToolApproval: (listener) => {
		const handler = (
			_event: Electron.IpcRendererEvent,
			value: import('../src/agent-types').ToolApproval,
		) => listener(value);
		ipcRenderer.on('freelm:tool-approval', handler);
		return () => {
			ipcRenderer.removeListener('freelm:tool-approval', handler);
		};
	},
	toolPickDirectory: () => ipcRenderer.invoke('freelm:tool-directory'),
	projectCreateDirectory: (name) => ipcRenderer.invoke('freelm:project-create-directory', name),
	toolInspect: (settings) => ipcRenderer.invoke('freelm:tool-inspect', settings),
	toolWebDiscover: (url) => ipcRenderer.invoke('freelm:tool-web-discover', url),
	searchStatus: () => ipcRenderer.invoke('freelm:search-status'),
	searchStart: () => ipcRenderer.invoke('freelm:search-start'),
	searchStop: () => ipcRenderer.invoke('freelm:search-stop'),
	onSearchStatus: (listener) => {
		const handler = (
			_event: Electron.IpcRendererEvent,
			value: import('../src/agent-types').SearchServiceStatus,
		) => listener(value);
		ipcRenderer.on('freelm:search-status', handler);
		return () => ipcRenderer.removeListener('freelm:search-status', handler);
	},
	platform: process.platform,
	request: (request) =>
		request.stream ? streams.request(request) : ipcRenderer.invoke('freelm:request', request),
	cancel: (id) => {
		streams.cancel(id);
		return ipcRenderer.invoke('freelm:cancel', id);
	},
	load: () => ipcRenderer.invoke('freelm:load'),
	save: (state) => ipcRenderer.invoke('freelm:save', state),
	storageInfo: () => ipcRenderer.invoke('freelm:storage-info'),
	workspaceBackup: (state) => ipcRenderer.invoke('freelm:workspace-backup', state),
	workspaceLoad: (target) => ipcRenderer.invoke('freelm:workspace-load', target),
	workspaceSave: (target, revision, state) =>
		ipcRenderer.invoke('freelm:workspace-save', target, revision, state),
	workspacePatch: (target, revision, patch) =>
		ipcRenderer.invoke('freelm:workspace-patch', target, revision, patch),
	instanceStatus: () => ipcRenderer.invoke('freelm:instance-status'),
	hostStart: (options) =>
		ipcRenderer.invoke('freelm:host-start', { name: options.name, port: options.port }),
	hostStop: () => ipcRenderer.invoke('freelm:host-stop'),
	instanceConnect: (input) =>
		ipcRenderer.invoke('freelm:instance-connect', {
			id: input.id,
			name: input.name,
			transport: input.transport,
			sshHost: input.sshHost,
			port: input.port,
			url: input.url,
			token: input.token,
		}),
	instanceOpen: (id) => ipcRenderer.invoke('freelm:instance-open', id),
	instanceDisconnect: (id) => ipcRenderer.invoke('freelm:instance-disconnect', id),
	instanceRemove: (id) => ipcRenderer.invoke('freelm:instance-remove', id),
	instanceAsset: (target, connectionId, url, kind) =>
		ipcRenderer.invoke('freelm:instance-asset', target, connectionId, url, kind),
	onPrepareClose: (listener) => {
		closeListeners.add(listener);
		if (closePending) listener();
		return () => {
			closeListeners.delete(listener);
		};
	},
	completeClose: () => ipcRenderer.invoke('freelm:complete-close'),
	onChunk: streams.onChunk,
};

contextBridge.exposeInMainWorld('desktopNative', bridge);
ipcRenderer.on('freelm:command', (_event, command: unknown) => {
	if (command === 'new-chat' || command === 'settings')
		window.dispatchEvent(new CustomEvent(`freelm:${command}`));
});
