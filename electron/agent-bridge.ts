import { dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import type {
	ToolApproval,
	ToolApprovalResponse,
	ToolHostRequest,
	ToolSettings,
} from '../src/agent-types';
import type { PluginToolProvider } from '../src/plugin-types';
import { AgentHost } from './agent-host';
import type { WorkspaceAuthority } from './workspace-authority';
import type { InstanceManager } from './instance-manager';
import { validateToolRequest, validateToolSettings } from './agent-validation';
import { validateRequestId } from './validation';
import {
	createComputerAdapter,
	requestComputerPermissions,
	computerHelperPath,
} from './computer-native';
import { ComputerCursor } from './computer-cursor';
import { createProjectDirectory } from './project-directories';

export function createAgentHost(
	authority: WorkspaceAuthority,
	window: () => BrowserWindow | null,
	resolveWebService?: (
		settings: NonNullable<ToolSettings['webBrowsing']>,
	) => string | Promise<string>,
	codeHome?: string,
	plugins?: PluginToolProvider,
) {
	const cursor = new ComputerCursor();
	const adapter = createComputerAdapter({ onCursor: (event) => cursor.show(event) });
	const approvals = new Map<
		string,
		{ approval: ToolApproval; finish: (decision: ToolApprovalResponse) => void }
	>();
	const approvalObservers = new Set<(approval: ToolApproval, waiting: boolean) => void>();
	const emitApproval = (approval: ToolApproval) => {
		const contents = window()?.webContents;
		if (contents && !contents.isDestroyed()) contents.send('freelm:tool-approval', approval);
	};
	const requestApproval = (approval: ToolApproval, signal: AbortSignal) =>
		new Promise<ToolApprovalResponse>((resolve) => {
			if (signal.aborted) {
				resolve(false);
				return;
			}
			let settled = false;
			const finish = (decision: ToolApprovalResponse) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				approvals.delete(approval.id);
				signal.removeEventListener('abort', abort);
				emitApproval({ ...approval, cancelled: true });
				for (const observer of approvalObservers) observer(approval, false);
				resolve(decision);
			};
			const abort = () => finish(false);
			const timer = setTimeout(() => finish(false), 30 * 60 * 1000);
			approvals.set(approval.id, { approval, finish });
			signal.addEventListener('abort', abort, { once: true });
			emitApproval(approval);
			for (const observer of approvalObservers) observer(approval, true);
		});
	const service = new AgentHost(
		() => authority.loadToolState(),
		requestApproval,
		resolveWebService,
		undefined,
		(threadId) => authority.loadCodeReviewState(threadId),
		codeHome,
		(threadId) => authority.loadCodeHistory(threadId),
		{
			adapter,
			onPreview: (preview) => {
				if (preview.status === 'stopped') cursor.hide(preview.app.id);
				else cursor.prepare();
				const contents = window()?.webContents;
				if (contents && !contents.isDestroyed()) contents.send('freelm:computer-preview', preview);
			},
		},
		plugins,
	);
	return {
		service,
		requestApproval,
		respond: (id: string, approved: boolean, remember = false) =>
			approvals.get(id)?.finish({ approved, remember }),
		onApproval: (observer: (approval: ToolApproval, waiting: boolean) => void) => {
			approvalObservers.add(observer);
			return () => approvalObservers.delete(observer);
		},
		replayApprovals: () => {
			for (const { approval } of approvals.values()) emitApproval(approval);
		},
		rejectAll: () => {
			cursor.close();
			for (const { finish } of approvals.values()) finish(false);
		},
	};
}

export function registerAgentBridge(options: {
	validateSender: (event: IpcMainInvokeEvent) => void;
	window: () => BrowserWindow | null;
	agent: ReturnType<typeof createAgentHost>;
	instances: InstanceManager;
}) {
	const { validateSender, agent, instances, window } = options;
	const runs = new Map<string, string>();
	const remoteLeases = new Map<string, string>();
	ipcMain.handle(
		'freelm:tool-catalog',
		async (
			event,
			workspaceId: string,
			runId: string,
			threadId: string,
			temporary?: boolean,
			claimTask?: boolean,
		) => {
			validateSender(event);
			validateRequestId(workspaceId);
			validateRequestId(runId);
			validateRequestId(threadId);
			if (temporary !== undefined && typeof temporary !== 'boolean')
				throw new Error('Invalid temporary chat.');
			if (claimTask !== undefined && typeof claimTask !== 'boolean')
				throw new Error('Invalid task claim.');
			if (runs.has(runId) || remoteLeases.has(runId)) throw new Error('Tool run already exists.');
			if (workspaceId !== 'local' && claimTask && !temporary) remoteLeases.set(runId, workspaceId);
			runs.set(runId, workspaceId);
			try {
				return workspaceId === 'local'
					? await agent.service.catalog(runId, threadId, false, temporary === true)
					: await instances.tools(workspaceId, 'catalog', {
							runId,
							threadId,
							temporary: temporary === true,
							claimTask: claimTask === true,
						});
			} catch (e) {
				runs.delete(runId);
				remoteLeases.delete(runId);
				throw e;
			}
		},
	);
	ipcMain.handle('freelm:tool-execute', async (event, request: ToolHostRequest) => {
		validateSender(event);
		validateToolRequest(request);
		if (runs.get(request.runId) !== request.workspaceId)
			throw new Error('Tool run does not belong to this workspace.');
		return request.workspaceId === 'local'
			? agent.service.execute(request)
			: instances.tools(request.workspaceId, 'execute', request);
	});
	ipcMain.handle('freelm:tool-cancel', async (event, runId: string) => {
		validateSender(event);
		validateRequestId(runId);
		const target = runs.get(runId);
		runs.delete(runId);
		if (target && target !== 'local')
			await instances.tools(target, 'cancel', { runId }).catch(() => {});
		else agent.service.cancel(runId);
	});
	ipcMain.handle('freelm:tool-release', async (event, runId: string, interrupted = false) => {
		validateSender(event);
		validateRequestId(runId);
		if (typeof interrupted !== 'boolean') throw new Error('Invalid task release.');
		const target = remoteLeases.get(runId);
		if (!target) return;
		await instances.tools(target, 'release', { runId, interrupted });
		remoteLeases.delete(runId);
	});
	ipcMain.handle(
		'freelm:tool-approve',
		(event, id: string, approved: boolean, remember?: boolean) => {
			validateSender(event);
			validateRequestId(id);
			if (typeof approved !== 'boolean') throw new Error('Invalid approval decision.');
			if (remember !== undefined && typeof remember !== 'boolean')
				throw new Error('Invalid approval grant.');
			agent.respond(id, approved, remember);
		},
	);
	ipcMain.handle('freelm:computer-setup', async (event, action: unknown) => {
		validateSender(event);
		if (!['request', 'accessibility', 'screen-recording', 'helper'].includes(String(action)))
			throw new Error('Invalid Computer Use setup action.');
		if (process.platform !== 'darwin') return agent.service.computerStatus();
		if (action === 'request') return requestComputerPermissions();
		if (action === 'helper') shell.showItemInFolder(computerHelperPath());
		else
			await shell.openExternal(
				action === 'accessibility'
					? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
					: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
			);
		return agent.service.computerStatus();
	});
	ipcMain.handle('freelm:computer-status', (event) => {
		validateSender(event);
		return agent.service.computerStatus();
	});
	ipcMain.handle('freelm:computer-sessions', (event) => {
		validateSender(event);
		return agent.service.currentComputerSessions();
	});
	ipcMain.handle('freelm:computer-stop', (event, sessionId: unknown) => {
		validateSender(event);
		validateRequestId(sessionId);
		agent.service.stopComputerSession(sessionId);
	});
	ipcMain.handle('freelm:tool-inspect', (event, settings: unknown) => {
		validateSender(event);
		validateToolSettings(settings);
		return agent.service.inspect(settings);
	});
	ipcMain.handle('freelm:tool-web-discover', (event, url: unknown) => {
		validateSender(event);
		if (typeof url !== 'string' || url.length > 2048)
			throw new Error('Enter a valid SearXNG service URL.');
		return agent.service.discoverWeb(url);
	});
	ipcMain.handle('freelm:tool-directory', async (event) => {
		validateSender(event);
		const parent = window();
		if (!parent) return null;
		const result = await dialog.showOpenDialog(parent, {
			properties: ['openDirectory'],
			title: 'Choose a tool workspace or skills folder',
		});
		return result.canceled ? null : result.filePaths[0] || null;
	});
	ipcMain.handle('freelm:project-create-directory', (event, name: unknown) => {
		validateSender(event);
		return createProjectDirectory(name);
	});
	return async () => {
		const pending = [...runs]
			.filter(([, target]) => target !== 'local')
			.map(([runId, target]) => instances.tools(target, 'cancel', { runId }).catch(() => {}));
		// Window teardown owns only runs admitted through this renderer bridge.
		// Host tasks, their approval promises and their Computer Use sessions stay alive.
		for (const [runId, target] of runs) if (target === 'local') agent.service.cancel(runId);
		runs.clear();
		for (const [runId, target] of remoteLeases)
			pending.push(
				instances.tools(target, 'release', { runId, interrupted: true }).catch(() => {}),
			);
		remoteLeases.clear();
		await Promise.allSettled(pending);
	};
}
