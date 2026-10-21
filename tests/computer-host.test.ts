import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentHost } from '../electron/agent-host';
import type { ComputerAdapter } from '../electron/tools/computer';
import type {
	CodeActionDecision,
	ToolApproval,
	ToolApprovalResponse,
	ToolHostRequest,
	ToolResult,
} from '../src/agent-types';
import type {
	ComputerAction,
	ComputerApp,
	ComputerObservation,
	ComputerSessionPreview,
	ComputerStatus,
} from '../src/computer-types';
import type { AppState } from '../src/types';
import { defaultToolSettings } from '../src/lib/tool-settings';
import { promptApiTools } from '../src/lib/system-prompt';

const png = 'data:image/png;base64,iVBORw0KGgo=';
const apps: ComputerApp[] = [
	{ id: 'app.editor', name: 'Editor' },
	{ id: 'app.notes', name: 'Notes' },
];
class FakeAdapter implements ComputerAdapter {
	frames = 0;
	status = vi.fn(async (): Promise<ComputerStatus> => ({
		available: true,
		platform: 'test',
		accessibility: true,
		screenRecording: true,
	}));
	apps = vi.fn(async (query: string, _signal: AbortSignal) =>
		apps.filter((app) => app.name.toLowerCase().includes(query.toLowerCase())),
	);
	open = vi.fn(async (_appId: string, _signal: AbortSignal) => {});
	snapshot = vi.fn(async (appId: string, _signal: AbortSignal): Promise<ComputerObservation> => ({
		app: apps.find((app) => app.id === appId)!,
		frameId: `frame-${++this.frames}`,
		window: {
			id: 'window-1',
			title: 'Document',
			bounds: { x: 10, y: 20, width: 400, height: 300 },
		},
		image: { dataUrl: png, width: 800, height: 600 },
		elements: [
			{ id: 'save-button', role: 'button', label: 'Save', actions: ['press'] },
			{ id: 'locations-row', role: 'row', label: 'Documents', actions: ['select'] },
		],
	}));
	act = vi.fn(
		async (_appId: string, _frameId: string, _action: ComputerAction, _signal: AbortSignal) => {},
	);
	close = vi.fn(async () => {});
}
const hosts: AgentHost[] = [];
afterEach(async () => {
	await Promise.all(hosts.splice(0).map((host) => host.close()));
});
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
function fixture(
	options: {
		enabled?: boolean;
		mode?: 'ask' | 'auto-review' | 'full-access';
		kind?: 'chat' | 'code';
		plan?: boolean;
		vision?: boolean;
		approve?: (approval: ToolApproval, signal: AbortSignal) => Promise<ToolApprovalResponse>;
		review?: (
			state: AppState,
			thread: AppState['threads'][number],
			request: ToolHostRequest,
			signal: AbortSignal,
		) => Promise<CodeActionDecision>;
	} = {},
) {
	const adapter = new FakeAdapter();
	const previews: ComputerSessionPreview[] = [];
	const state: AppState = {
		version: 1,
		theme: 'dark',
		activeConnectionId: 'provider',
		projects: [],
		generations: [],
		threads: [
			{
				id: 'thread',
				kind: options.kind ?? 'code',
				title: 'Test',
				connectionId: 'provider',
				model: 'vision-model',
				messages: options.plan
					? [
							{
								id: 'message',
								role: 'user',
								content: 'Plan',
								createdAt: 1,
								composer: { mode: 'plan' },
							},
						]
					: [],
				createdAt: 1,
				updatedAt: 1,
			},
		],
		connections: [
			{
				id: 'provider',
				name: 'Provider',
				baseUrl: 'http://provider.invalid/v1',
				apiKey: '',
				chatApi: 'responses',
				models: { chat: 'vision-model', images: '', videos: '', speech: '', transcription: '' },
				discoveredModels: [],
				catalog: [
					{
						id: 'vision-model',
						name: 'Vision',
						enabled: true,
						tasks: ['chat'],
						inputModalities: options.vision === false ? ['text'] : ['text', 'image'],
						outputModalities: ['text'],
						thinkingModes: [],
					},
				],
			},
		],
		toolSettings: {
			...defaultToolSettings(),
			enabled: true,
			commandExecution: false,
			allowRemote: true,
			approvalMode: options.mode ?? 'ask',
			computerUse: { enabled: options.enabled ?? true },
			webBrowsing: { enabled: true, mode: 'external', searxngUrl: 'http://search.invalid' },
		},
	};
	const approve = vi.fn(options.approve ?? (async () => true));
	const review = vi.fn(
		options.review ?? (async () => ({ approved: true, reason: 'The user requested this app.' })),
	);
	const host = new AgentHost(
		async () => state,
		approve,
		undefined,
		review,
		undefined,
		undefined,
		undefined,
		{ adapter, onPreview: (preview) => previews.push(preview) },
	);
	hosts.push(host);
	const call = (name: string, args: Record<string, unknown>, runId = 'run') =>
		host.execute({ workspaceId: 'local', runId, threadId: 'thread', name, arguments: args });
	return { state, adapter, host, call, approve, review, previews };
}
function frame(result: ToolResult): { sessionId: string; frameId: string } {
	const content = result.content.find((part) => part.type === 'text');
	if (!content || content.type !== 'text') throw new Error('No observation');
	const value = JSON.parse(content.text);
	return { sessionId: value.sessionId, frameId: value.frameId };
}

describe('Computer Use host boundary', () => {
	it.each([
		{ enabled: false, mode: 'full-access' as const },
		{ kind: 'chat' as const },
		{ plan: true },
		{ vision: false },
	])('does not expose tools outside enabled local image-capable Code: %j', async (options) => {
		const { host, call, adapter } = fixture(options);
		const catalog = await host.catalog('run', 'thread');
		expect(catalog.tools.some((tool) => tool.name.startsWith('computer_'))).toBe(false);
		const result = call('computer_open', { appId: 'app.editor' });
		if (options.plan) expect((await result).isError).toBe(true);
		else await expect(result).rejects.toThrow();
		expect(adapter.open).not.toHaveBeenCalled();
		expect(adapter.snapshot).not.toHaveBeenCalled();
	});
	it('does not expose or execute Computer Use for a remote Code run', async () => {
		const { host, call, adapter } = fixture();
		const catalog = await host.catalog('run', 'thread', true);
		expect(catalog.tools.some((tool) => tool.name.startsWith('computer_'))).toBe(false);
		await expect(call('computer_open', { appId: 'app.editor' })).rejects.toThrow('unavailable');
		expect(adapter.apps).not.toHaveBeenCalled();
	});
	it('refreshes direct Computer Use tools for an existing task after enablement despite older unavailable claims', async () => {
		const { host, state } = fixture({ enabled: false });
		state.threads[0].messages.push({
			id: 'old-answer',
			role: 'assistant',
			content: 'Computer tools are unavailable in this conversation.',
			createdAt: 1,
		});
		const old = await host.catalog('old-run', 'thread');
		expect(old.tools.some((tool) => tool.name.startsWith('computer_'))).toBe(false);
		host.cancel('old-run');
		state.toolSettings!.computerUse!.enabled = true;
		const current = await host.catalog('run', 'thread');
		expect(
			current.tools.filter((tool) => tool.name.startsWith('computer_')).map((tool) => tool.name),
		).toEqual([
			'computer_apps',
			'computer_open',
			'computer_observe',
			'computer_act',
			'computer_close',
		]);
		expect(
			current.tools
				.filter((tool) => tool.name.startsWith('computer_'))
				.every((tool) => !tool.deferred),
		).toBe(true);
		expect(current.instructions).toContain('supersedes older conversation claims');
		expect(current.instructions).toContain('absent from the JavaScript ALL_TOOLS');
		for (const protocol of ['responses', 'chat/completions'] as const)
			expect(JSON.stringify(promptApiTools(current.tools, protocol))).toContain('computer_open');
	});
	it('keeps malformed unrelated registry display names from blocking a verified app', async () => {
		const { host, call, adapter, approve } = fixture();
		const registry = [
			{ id: 'blank', name: '   ' },
			{ id: 'controls', name: '\0\n' },
			{ id: 'long', name: 'x'.repeat(1024) },
			{ id: 'nonstring', name: 42 },
			{ id: '\0invalid', name: 'Invalid' },
			{ name: 'Missing identity' },
			apps[0],
		] as ComputerApp[];
		adapter.apps.mockImplementation(async (query) => (query ? [apps[0]] : registry));
		await host.catalog('run', 'thread');
		const filtered = await call('computer_apps', { query: 'Editor' });
		expect(filtered.isError).not.toBe(true);
		const result = await call('computer_open', { appId: apps[0].id });
		expect(result.computer?.app).toEqual(apps[0]);
		expect(approve.mock.calls[0][0].computer?.app).toEqual(apps[0]);
		expect(adapter.open).toHaveBeenCalledTimes(1);
		const list = await host.computerApps('');
		expect(list.find((app) => app.id === 'blank')?.name).toBe('blank');
		expect(list.find((app) => app.id === 'long')?.name).toHaveLength(256);
		expect(list.some((app) => app.name === 'Missing identity')).toBe(false);
	});
	it('uses the verified registry name when a snapshot omits display metadata', async () => {
		const { host, call, adapter } = fixture();
		const snapshot = adapter.snapshot.getMockImplementation()!;
		adapter.snapshot.mockImplementation(async (appId, signal) => ({
			...(await snapshot(appId, signal)),
			app: { id: appId } as ComputerApp,
		}));
		await host.catalog('run', 'thread');
		expect((await call('computer_open', { appId: apps[0].id })).computer?.app).toEqual(apps[0]);
	});
	it('finds a discovered app beyond the broad registry limit by exact identity', async () => {
		const { host, call, adapter } = fixture();
		adapter.apps.mockImplementation(async (query) =>
			query === apps[0].id ? [apps[0], apps[1]] : [apps[1]],
		);
		await host.catalog('run', 'thread');
		expect((await call('computer_open', { appId: apps[0].id })).computer?.app.id).toBe(apps[0].id);
		expect(adapter.apps).toHaveBeenCalledWith(apps[0].id, expect.any(AbortSignal));
		await expect(call('computer_open', { appId: 'unregistered' })).rejects.toThrow('registry');
		expect(adapter.open).toHaveBeenCalledTimes(1);
	});
	it('verifies the app before consent, grants only this run, and returns marked screenshots', async () => {
		const { host, call, approve, adapter, previews } = fixture({
			approve: async (request) => {
				expect(adapter.open).not.toHaveBeenCalled();
				expect(adapter.snapshot).not.toHaveBeenCalled();
				expect(request.computer).toEqual({ app: apps[0], scope: 'run' });
				expect(request.rememberLabel).toBeUndefined();
				return { approved: true, remember: true };
			},
		});
		await host.catalog('run', 'thread');
		await expect(call('computer_open', { appId: '/bin/anything' })).rejects.toThrow('registry');
		expect(approve).not.toHaveBeenCalled();
		const opened = await call('computer_open', { appId: apps[0].id });
		const session = frame(opened);
		expect(opened.content).toContainEqual({
			type: 'image',
			dataUrl: png,
			name: 'Editor screen',
			purpose: 'computer',
		});
		expect(opened.computer).toEqual({ sessionId: session.sessionId, app: apps[0] });
		await call('computer_observe', { sessionId: session.sessionId });
		await call('computer_open', { appId: apps[0].id });
		expect(approve).toHaveBeenCalledTimes(1);
		expect(previews.at(-1)?.status).toBe('active');
		host.cancel('run');
		expect(previews.at(-1)?.status).toBe('stopped');
		expect(previews.at(-1)?.image?.dataUrl).toBe(png);
		await host.catalog('next-run', 'thread');
		// A remembered generic approval never grants a subsequent computer run.
		approve.mockImplementation(async () => true);
		await call('computer_open', { appId: apps[0].id }, 'next-run');
		expect(approve).toHaveBeenCalledTimes(2);
	});
	it('returns a permission denial without opening or observing the app', async () => {
		const { host, call, adapter } = fixture({ approve: async () => false });
		await host.catalog('run', 'thread');
		const result = await call('computer_open', { appId: apps[0].id });
		expect(result.approvalDenied?.reason).toContain('declined');
		expect(adapter.open).not.toHaveBeenCalled();
		expect(adapter.snapshot).not.toHaveBeenCalled();
	});
	it.each(['denied', 'failure'])(
		'falls back to human app consent when automatic review is %s',
		async (outcome) => {
			const { host, call, approve, review } = fixture({
				mode: 'auto-review',
				review: async () => {
					if (outcome === 'failure') throw new Error('Reviewer unavailable');
					return { approved: false, reason: 'Needs human app consent' };
				},
			});
			await host.catalog('run', 'thread');
			await call('computer_open', { appId: apps[0].id });
			expect(review).toHaveBeenCalledTimes(1);
			expect(approve).toHaveBeenCalledTimes(1);
			expect(approve.mock.calls[0][0].computer?.app.id).toBe(apps[0].id);
			expect(approve.mock.calls[0][0].message).toContain(
				outcome === 'failure'
					? 'Automatic approval review could not complete'
					: 'Needs human app consent',
			);
		},
	);
	it.each([
		{
			approved: true,
			reason: 'Contradictory approval',
			reviewError: { code: 'unavailable', attempts: 3 },
		},
		{ approved: true, reason: '   ' },
		{ approved: 'yes', reason: 'Malformed approval' },
		{
			approved: false,
			reason: 'Malformed error attempt count',
			reviewError: { code: 'unavailable', attempts: 6 },
		},
	])('requires explicit app consent for an invalid review decision: %j', async (decision) => {
		const { host, call, approve, adapter } = fixture({
			mode: 'auto-review',
			review: async () => decision as CodeActionDecision,
			approve: async () => false,
		});
		await host.catalog('run', 'thread');
		const result = await call('computer_open', { appId: apps[0].id });
		expect(approve).toHaveBeenCalledTimes(1);
		expect(approve.mock.calls[0][0].message).toContain('invalid decision');
		expect(result.approvalDenied?.reason).toContain('user declined');
		expect(adapter.open).not.toHaveBeenCalled();
		expect(adapter.snapshot).not.toHaveBeenCalled();
	});
	it('allows explicit per-app consent after a valid review error', async () => {
		const { host, call, approve, adapter } = fixture({
			mode: 'auto-review',
			review: async () => ({
				approved: false,
				reason: 'Review could not complete after bounded retries.',
				reviewError: { code: 'unavailable', attempts: 3 },
			}),
			approve: async () => {
				expect(adapter.open).not.toHaveBeenCalled();
				expect(adapter.snapshot).not.toHaveBeenCalled();
				return true;
			},
		});
		await host.catalog('run', 'thread');
		await call('computer_open', { appId: apps[0].id });
		expect(approve).toHaveBeenCalledTimes(1);
		expect(approve.mock.calls[0][0].message).toContain('Review could not complete');
		expect(adapter.open).toHaveBeenCalledTimes(1);
	});
	it('does not expose reviewer transport credentials in the app consent prompt', async () => {
		const secret = 'https://private-user:private-password@provider.invalid/?token=private-token';
		const { host, call, approve, adapter } = fixture({
			mode: 'auto-review',
			review: async () => {
				throw new Error(`Request to ${secret} failed: private-provider-response`);
			},
			approve: async () => false,
		});
		await host.catalog('run', 'thread');
		const result = await call('computer_open', { appId: apps[0].id });
		expect(approve).toHaveBeenCalledTimes(1);
		expect(approve.mock.calls[0][0].message).toContain('could not complete');
		expect(JSON.stringify(approve.mock.calls)).not.toContain('private-');
		expect(JSON.stringify(result)).not.toContain('private-');
		expect(adapter.open).not.toHaveBeenCalled();
	});
	it.each(['auto-review', 'full-access'] as const)(
		'uses %s only after the separate Computer Use opt-in',
		async (mode) => {
			const { host, call, approve, review } = fixture({ mode });
			await host.catalog('run', 'thread');
			await call('computer_open', { appId: apps[0].id });
			expect(approve).not.toHaveBeenCalled();
			expect(review).toHaveBeenCalledTimes(mode === 'auto-review' ? 1 : 0);
		},
	);
	it.each(['ask', 'auto-review', 'full-access'] as const)(
		'pauses %s app access for missing OS permissions and rechecks after Continue',
		async (mode) => {
			let setupCount = 0;
			const { host, call, adapter, approve } = fixture({
				mode,
				approve: async (request) => {
					if (request.computer?.setup) {
						setupCount++;
						expect(adapter.open).not.toHaveBeenCalled();
						expect(adapter.snapshot).not.toHaveBeenCalled();
						expect(request.computer.app).toEqual(apps[0]);
						// A forged/stale Continue while permissions remain missing cannot open.
						if (setupCount === 2)
							adapter.status.mockResolvedValue({
								available: true,
								platform: 'darwin',
								accessibility: true,
								screenRecording: true,
							});
					}
					return true;
				},
			});
			adapter.status.mockResolvedValue({
				available: true,
				platform: 'darwin',
				accessibility: false,
				screenRecording: false,
			});
			await host.catalog('run', 'thread');
			await call('computer_open', { appId: apps[0].id });
			expect(setupCount).toBe(2);
			expect(approve).toHaveBeenCalledTimes(mode === 'ask' ? 3 : 2);
			expect(adapter.open).toHaveBeenCalledTimes(1);
			expect(adapter.snapshot).toHaveBeenCalledTimes(1);
		},
	);
	it.each([
		[{ screenLocked: true }, 'Unlock it'],
		[{ sessionActive: false }, 'Switch back to this user session'],
		[{ displaysAwake: false }, 'Wake a display'],
	] as const)(
		'reports %j without asking for OS permission setup',
		async (environment, guidance) => {
			const { host, call, adapter, approve, review } = fixture({ mode: 'full-access' });
			adapter.status.mockResolvedValue({
				available: true,
				platform: 'darwin',
				accessibility: false,
				screenRecording: false,
				...environment,
			});
			await host.catalog('run', 'thread');
			await expect(call('computer_open', { appId: apps[0].id })).rejects.toThrow(guidance);
			expect(approve).not.toHaveBeenCalled();
			expect(review).not.toHaveBeenCalled();
			expect(adapter.open).not.toHaveBeenCalled();
			expect(adapter.snapshot).not.toHaveBeenCalled();
			expect(adapter.act).not.toHaveBeenCalled();
		},
	);
	it('blocks input while the desktop sleeps and can observe again after wake without a new approval', async () => {
		const { host, call, adapter, approve } = fixture({ mode: 'full-access' });
		await host.catalog('run', 'thread');
		const session = frame(await call('computer_open', { appId: apps[0].id }));
		adapter.status.mockResolvedValue({
			available: true,
			platform: 'darwin',
			accessibility: true,
			screenRecording: true,
			displaysAwake: false,
		});
		await expect(
			call('computer_act', { ...session, action: { type: 'click', x: 1, y: 1 } }),
		).rejects.toThrow('Wake a display');
		expect(adapter.act).not.toHaveBeenCalled();
		expect(adapter.snapshot).toHaveBeenCalledTimes(1);
		expect(approve).not.toHaveBeenCalled();
		adapter.status.mockResolvedValue({
			available: true,
			platform: 'darwin',
			accessibility: true,
			screenRecording: true,
			screenLocked: false,
			sessionActive: true,
			displaysAwake: true,
		});
		const refreshed = frame(await call('computer_observe', { sessionId: session.sessionId }));
		expect(refreshed.frameId).not.toBe(session.frameId);
		expect(approve).not.toHaveBeenCalled();
		expect(adapter.snapshot).toHaveBeenCalledTimes(2);
	});
	it('declining OS setup blocks app access without native input or capture', async () => {
		const { host, call, adapter } = fixture({ mode: 'full-access', approve: async () => false });
		adapter.status.mockResolvedValue({
			available: true,
			platform: 'darwin',
			accessibility: false,
			screenRecording: true,
		});
		await host.catalog('run', 'thread');
		const result = await call('computer_open', { appId: apps[0].id });
		expect(result.isError).toBe(true);
		expect(result.approvalDenied?.reason).toContain('declined');
		expect(adapter.open).not.toHaveBeenCalled();
		expect(adapter.snapshot).not.toHaveBeenCalled();
		expect(host.currentComputerSessions().at(-1)?.status).toBe('stopped');
	});
	it('returns an actionable unavailable-host error without attempting OS setup or opening', async () => {
		const { host, call, adapter, approve } = fixture({ mode: 'full-access' });
		adapter.status.mockResolvedValue({
			available: false,
			platform: 'test',
			accessibility: false,
			screenRecording: false,
		});
		await host.catalog('run', 'thread');
		await expect(call('computer_open', { appId: apps[0].id })).rejects.toThrow(
			'Check Computer Use setup',
		);
		expect(approve).not.toHaveBeenCalled();
		expect(adapter.open).not.toHaveBeenCalled();
	});
	it.each(['cancel', 'disable'] as const)(
		'rechecks %s while OS setup is paused before native operations',
		async (change) => {
			const pending = deferred<ToolApprovalResponse>();
			const requested = deferred<void>();
			const { host, call, state, adapter } = fixture({
				mode: 'full-access',
				approve: async () => {
					requested.resolve();
					return pending.promise;
				},
			});
			adapter.status.mockResolvedValue({
				available: true,
				platform: 'darwin',
				accessibility: false,
				screenRecording: true,
			});
			await host.catalog('run', 'thread');
			const rejected = expect(call('computer_open', { appId: apps[0].id })).rejects.toThrow();
			await requested.promise;
			if (change === 'cancel') host.cancel('run');
			else state.toolSettings!.computerUse!.enabled = false;
			adapter.status.mockResolvedValue({
				available: true,
				platform: 'darwin',
				accessibility: true,
				screenRecording: true,
			});
			pending.resolve(true);
			await rejected;
			expect(adapter.open).not.toHaveBeenCalled();
			expect(adapter.snapshot).not.toHaveBeenCalled();
		},
	);
	it.each(['computer_observe', 'computer_open', 'computer_act'] as const)(
		'rechecks revoked OS permissions for existing %s sessions and refreshes frames after setup',
		async (name) => {
			const { host, call, adapter, approve } = fixture({ mode: 'full-access' });
			await host.catalog('run', 'thread');
			const session = frame(await call('computer_open', { appId: apps[0].id }));
			let focused = true;
			const snapshot = adapter.snapshot.getMockImplementation()!;
			adapter.snapshot.mockImplementation(async (appId, signal) => {
				if (!focused) throw new Error('The approved app is not frontmost');
				return snapshot(appId, signal);
			});
			adapter.open.mockImplementation(async () => {
				focused = true;
			});
			adapter.status.mockResolvedValue({
				available: true,
				platform: 'darwin',
				accessibility: false,
				screenRecording: true,
			});
			approve.mockImplementation(async (request) => {
				focused = false; // System Settings took focus while permissions were granted.
				expect(request.computer?.setup?.accessibility).toBe(false);
				expect(adapter.act).not.toHaveBeenCalled();
				expect(adapter.snapshot).toHaveBeenCalledTimes(1);
				adapter.status.mockResolvedValue({
					available: true,
					platform: 'darwin',
					accessibility: true,
					screenRecording: true,
				});
				return true;
			});
			const args =
				name === 'computer_open'
					? { appId: apps[0].id }
					: name === 'computer_act'
						? { ...session, action: { type: 'click', x: 1, y: 1 } }
						: { sessionId: session.sessionId };
			const refreshed = frame(await call(name, args));
			expect(refreshed.frameId).not.toBe(session.frameId);
			expect(approve).toHaveBeenCalledTimes(1);
			expect(adapter.act).not.toHaveBeenCalled();
			await expect(
				call('computer_act', { ...session, action: { type: 'click', x: 1, y: 1 } }),
			).rejects.toThrow('stale');
		},
	);
	it('does not replay an uncertain native action when OS permissions are revoked during dispatch', async () => {
		const { host, call, adapter, approve } = fixture({ mode: 'full-access' });
		await host.catalog('run', 'thread');
		const session = frame(await call('computer_open', { appId: apps[0].id }));
		adapter.act.mockImplementationOnce(async () => {
			adapter.status.mockResolvedValue({
				available: true,
				platform: 'darwin',
				accessibility: false,
				screenRecording: true,
			});
			throw new Error('Native permission revoked');
		});
		approve.mockImplementation(async () => {
			adapter.status.mockResolvedValue({
				available: true,
				platform: 'darwin',
				accessibility: true,
				screenRecording: true,
			});
			return true;
		});
		const result = await call('computer_act', {
			...session,
			action: { type: 'click', x: 1, y: 1 },
		});
		expect(frame(result).frameId).not.toBe(session.frameId);
		expect(JSON.stringify(result.content)).toContain('was not replayed');
		expect(adapter.act).toHaveBeenCalledTimes(1);
	});
	it('does not allow another run to borrow an app session', async () => {
		const { host, call, adapter } = fixture();
		await host.catalog('run', 'thread');
		const session = frame(await call('computer_open', { appId: apps[0].id }));
		await host.catalog('other-run', 'thread');
		await expect(
			call('computer_observe', { sessionId: session.sessionId }, 'other-run'),
		).rejects.toThrow('another task');
		expect(adapter.snapshot).toHaveBeenCalledTimes(1);
	});
	it('rejects stale frames, unobserved elements, out-of-image clicks, and extra arguments', async () => {
		const { host, call, adapter } = fixture();
		await host.catalog('run', 'thread');
		const session = frame(await call('computer_open', { appId: apps[0].id }));
		const send = (action: unknown, extra = {}) =>
			call('computer_act', { ...session, action, ...extra });
		await expect(send({ type: 'click', x: 1, y: 1 }, { frameId: 'stale' })).rejects.toThrow(
			'stale',
		);
		await expect(send({ type: 'press', elementId: 'invented' })).rejects.toThrow('not present');
		await expect(send({ type: 'select', elementId: 'invented' })).rejects.toThrow('not present');
		await expect(send({ type: 'select', elementId: 'save-button' })).rejects.toThrow(
			'does not advertise select',
		);
		await expect(
			send({ type: 'select', elementId: 'locations-row', text: 'ignored' }),
		).rejects.toThrow('arguments');
		await expect(send({ type: 'click', x: 800, y: 1 })).rejects.toThrow('inside');
		await expect(send({ type: 'click', x: 1.1, y: 1 })).rejects.toThrow('inside');
		await expect(send({ type: 'key', key: 'Enter', script: 'unexpected' })).rejects.toThrow(
			'arguments',
		);
		await expect(send({ type: 'type', text: 'x'.repeat(16001) })).rejects.toThrow('limit');
		await expect(send({ type: 'key', key: 'a', modifiers: ['cmd', 'cmd'] })).rejects.toThrow(
			'modifiers',
		);
		await expect(send({ type: 'click', x: 1, y: 1 }, { appId: apps[1].id })).rejects.toThrow(
			'arguments',
		);
		expect(adapter.act).not.toHaveBeenCalled();
		const next = frame(await send({ type: 'click', x: 1, y: 1 }));
		expect(next.frameId).not.toBe(session.frameId);
		await expect(send({ type: 'click', x: 1, y: 1 })).rejects.toThrow('stale');
		expect(adapter.act).toHaveBeenCalledTimes(1);
	});
	it('selects only an advertised current-frame row and returns its observed state', async () => {
		const { host, call, adapter } = fixture();
		const catalog = await host.catalog('run', 'thread');
		const definition = catalog.tools.find((tool) => tool.name === 'computer_act')!;
		expect(JSON.stringify(definition.parameters)).toContain('"const":"select"');
		expect(catalog.instructions).toContain('select instead of press');
		let selected = false;
		const snapshot = adapter.snapshot.getMockImplementation()!;
		adapter.snapshot.mockImplementation(async (appId, signal) => ({
			...(await snapshot(appId, signal)),
			elements: [
				{
					id: 'locations-row',
					role: 'row',
					label: 'Documents',
					value: selected ? 'Selected' : 'Not selected',
					actions: selected ? [] : ['select'],
				},
			],
		}));
		adapter.act.mockImplementationOnce(async () => {
			selected = true;
		});
		const initial = frame(await call('computer_open', { appId: apps[0].id }));
		const action = { type: 'select', elementId: 'locations-row' };
		const result = await call('computer_act', { ...initial, action });
		const next = frame(result);
		expect(next.frameId).not.toBe(initial.frameId);
		expect(adapter.act).toHaveBeenCalledWith(
			apps[0].id,
			initial.frameId,
			action,
			expect.any(AbortSignal),
		);
		expect(result.content).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: 'text',
					text: expect.stringContaining('"value":"Selected"'),
				}),
			]),
		);
		await expect(call('computer_act', { ...initial, action })).rejects.toThrow('stale');
		await expect(call('computer_act', { ...next, action })).rejects.toThrow(
			'does not advertise select',
		);
		expect(adapter.act).toHaveBeenCalledTimes(1);
	});
	it.each([
		{ type: 'press', elementId: 'save-button' },
		{ type: 'select', elementId: 'locations-row' },
	])(
		'consumes a frame even if the native $type action fails, preventing uncertain replay',
		async (action) => {
			const { host, call, adapter } = fixture();
			await host.catalog('run', 'thread');
			const session = frame(await call('computer_open', { appId: apps[0].id }));
			adapter.act.mockRejectedValueOnce(new Error('Focus changed'));
			const args = { ...session, action };
			await expect(call('computer_act', args)).rejects.toThrow('Focus changed');
			await expect(call('computer_act', args)).rejects.toThrow('stale');
			expect(adapter.act).toHaveBeenCalledTimes(1);
			await call('computer_observe', { sessionId: session.sessionId });
		},
	);
	it('bounds both ends of a drag to the latest screenshot', async () => {
		const { host, call, adapter } = fixture();
		await host.catalog('run', 'thread');
		const current = frame(await call('computer_open', { appId: apps[0].id }));
		await expect(
			call('computer_act', {
				...current,
				action: { type: 'drag', x: 0, y: 0, toX: 800, toY: 599 },
			}),
		).rejects.toThrow('destination');
		await expect(
			call('computer_act', {
				...current,
				action: { type: 'drag', x: -1, y: 0, toX: 799, toY: 599 },
			}),
		).rejects.toThrow('coordinates');
		expect(adapter.act).not.toHaveBeenCalled();
		await call('computer_act', {
			...current,
			action: { type: 'drag', x: 0, y: 0, toX: 799, toY: 599 },
		});
		expect(adapter.act.mock.calls[0][2]).toEqual({ type: 'drag', x: 0, y: 0, toX: 799, toY: 599 });
	});
	it.each(['permission', 'deleted'] as const)(
		'revokes app authority when the task is %s',
		async (change) => {
			const { host, call, state, adapter } = fixture();
			await host.catalog('run', 'thread');
			const current = frame(await call('computer_open', { appId: apps[0].id }));
			if (change === 'permission') state.threads[0].permissionMode = 'full-access';
			else state.threads = [];
			await expect(
				call('computer_act', { ...current, action: { type: 'type', text: 'no' } }),
			).rejects.toThrow();
			expect(adapter.act).not.toHaveBeenCalled();
			expect(host.currentComputerSessions().at(-1)?.status).toBe('stopped');
		},
	);
	it('refocuses an already approved app before observing without another grant', async () => {
		const { host, call, adapter, approve } = fixture();
		await host.catalog('run', 'thread');
		const first = frame(await call('computer_open', { appId: apps[0].id }));
		let focused = false;
		const snapshot = adapter.snapshot.getMockImplementation()!;
		adapter.open.mockImplementationOnce(async () => {
			focused = true;
		});
		adapter.snapshot.mockImplementationOnce(async (appId, signal) => {
			if (!focused) throw new Error('The app is not frontmost');
			return snapshot(appId, signal);
		});
		const next = frame(await call('computer_open', { appId: apps[0].id }));
		expect(next.sessionId).toBe(first.sessionId);
		expect(next.frameId).not.toBe(first.frameId);
		expect(adapter.open).toHaveBeenCalledTimes(2);
		expect(approve).toHaveBeenCalledTimes(1);
	});
	it('a human Stop cancels the owning run and prevents Full access from reopening', async () => {
		const { host, call, adapter } = fixture({ mode: 'full-access' });
		await host.catalog('run', 'thread');
		const first = frame(await call('computer_open', { appId: apps[0].id }));
		const second = frame(await call('computer_open', { appId: apps[1].id }));
		host.stopComputerSession(first.sessionId);
		await expect(call('computer_open', { appId: apps[0].id })).rejects.toThrow('no longer active');
		expect(adapter.open).toHaveBeenCalledTimes(2);
		expect(
			host
				.currentComputerSessions()
				.filter((session) => [first.sessionId, second.sessionId].includes(session.sessionId))
				.every((session) => session.status === 'stopped'),
		).toBe(true);
	});
	it('rechecks enablement after permission and performs no native action on revocation', async () => {
		const pending = deferred<ToolApprovalResponse>();
		const requested = deferred<void>();
		const { host, call, state, adapter } = fixture({
			approve: async () => {
				requested.resolve();
				return pending.promise;
			},
		});
		await host.catalog('run', 'thread');
		const opening = call('computer_open', { appId: apps[0].id });
		const rejected = expect(opening).rejects.toThrow('settings changed');
		await requested.promise;
		state.toolSettings!.computerUse!.enabled = false;
		pending.resolve(true);
		await rejected;
		expect(adapter.open).not.toHaveBeenCalled();
	});
	it('rechecks Plan mode after pending app consent', async () => {
		const pending = deferred<ToolApprovalResponse>();
		const requested = deferred<void>();
		const { host, call, state, adapter } = fixture({
			approve: async () => {
				requested.resolve();
				return pending.promise;
			},
		});
		await host.catalog('run', 'thread');
		const rejected = expect(call('computer_open', { appId: apps[0].id })).rejects.toThrow('Plan');
		await requested.promise;
		state.threads[0].messages.push({
			id: 'plan',
			role: 'user',
			content: 'Plan now',
			createdAt: 2,
			composer: { mode: 'plan' },
		});
		pending.resolve(true);
		await rejected;
		expect(adapter.open).not.toHaveBeenCalled();
	});
	it('stops the granted session when the task model loses image capability', async () => {
		const { host, call, state, adapter } = fixture();
		await host.catalog('run', 'thread');
		const session = frame(await call('computer_open', { appId: apps[0].id }));
		state.connections[0].catalog![0].inputModalities = ['text'];
		await expect(
			call('computer_act', { ...session, action: { type: 'type', text: 'no' } }),
		).rejects.toThrow('image-capable');
		expect(adapter.act).not.toHaveBeenCalled();
		expect(host.currentComputerSessions().at(-1)?.status).toBe('stopped');
	});
	it('serializes actions across runs and cancels a queued action when its session stops', async () => {
		const { host, call, adapter } = fixture({ mode: 'full-access' });
		await host.catalog('run', 'thread');
		await host.catalog('other-run', 'thread');
		const first = frame(await call('computer_open', { appId: apps[0].id }));
		const second = frame(await call('computer_open', { appId: apps[1].id }, 'other-run'));
		const pending = deferred<void>();
		const started = deferred<void>();
		adapter.act.mockImplementationOnce(async () => {
			started.resolve();
			await pending.promise;
		});
		const one = call('computer_act', { ...first, action: { type: 'type', text: 'one' } });
		await started.promise;
		const two = call(
			'computer_act',
			{ ...second, action: { type: 'type', text: 'two' } },
			'other-run',
		);
		const rejected = expect(two).rejects.toThrow();
		host.stopComputerSession(second.sessionId);
		pending.resolve();
		await one;
		await rejected;
		expect(adapter.act).toHaveBeenCalledTimes(1);
	});
	it('cancels pending consent with the run, and rejects observations after session close', async () => {
		const requested = deferred<void>();
		const { host, call, adapter, approve } = fixture({
			approve: async (_request, signal) => {
				requested.resolve();
				return new Promise((resolve) =>
					signal.addEventListener('abort', () => resolve(false), { once: true }),
				);
			},
		});
		await host.catalog('run', 'thread');
		const rejected = expect(call('computer_open', { appId: apps[0].id })).rejects.toThrow();
		await requested.promise;
		host.cancel('run');
		await rejected;
		expect(adapter.open).not.toHaveBeenCalled();
		approve.mockImplementation(async () => true);
		await host.catalog('next-run', 'thread');
		const session = frame(await call('computer_open', { appId: apps[0].id }, 'next-run'));
		await call('computer_close', { sessionId: session.sessionId }, 'next-run');
		await expect(
			call('computer_observe', { sessionId: session.sessionId }, 'next-run'),
		).rejects.toThrow('unavailable');
		expect(adapter.snapshot).toHaveBeenCalledTimes(1);
	});
	it('rejects a screenshot of a different app and revokes its session', async () => {
		const { host, call, adapter } = fixture();
		await host.catalog('run', 'thread');
		const original = adapter.snapshot.getMockImplementation()!;
		adapter.snapshot.mockImplementationOnce(async (appId, signal) => ({
			...(await original(appId, signal)),
			app: apps[1],
		}));
		await expect(call('computer_open', { appId: apps[0].id })).rejects.toThrow('does not match');
		expect(host.currentComputerSessions().at(-1)?.status).toBe('stopped');
	});
	it('returns bounded valid JSON for large accessibility trees and rejects omitted element IDs', async () => {
		const { host, call, adapter } = fixture();
		await host.catalog('run', 'thread');
		const snapshot = adapter.snapshot.getMockImplementation()!;
		adapter.snapshot.mockImplementationOnce(async (appId, signal) => ({
			...(await snapshot(appId, signal)),
			elements: Array.from({ length: 250 }, (_, index) => ({
				id: `node-${index}`,
				role: 'text',
				value: 'x'.repeat(1000),
			})),
			notices: Array.from({ length: 32 }, () => 'Native notice '.repeat(250)),
		}));
		const result = await call('computer_open', { appId: apps[0].id });
		const output = result.content.find((part) => part.type === 'text')!;
		if (output.type !== 'text') throw new Error('No observation');
		expect(output.text.length).toBeLessThanOrEqual(60_000);
		const parsed = JSON.parse(output.text);
		expect(parsed.frameId).toBe('frame-1');
		expect(parsed.elements.length).toBeGreaterThan(0);
		expect(parsed.elements.length).toBeLessThan(250);
		expect(parsed.notices.join(' ')).toContain('Accessibility tree truncated');
		expect(parsed.notices.join(' ')).toContain('notices were shortened');
		await expect(
			call('computer_act', { ...frame(result), action: { type: 'press', elementId: 'node-249' } }),
		).rejects.toThrow('not present');
		expect(adapter.act).not.toHaveBeenCalled();
	});
	it('strips icons and limits model app listings while preserving UI app metadata', async () => {
		const { host, call, adapter } = fixture();
		await host.catalog('run', 'thread');
		const icon = `data:image/png;base64,${'A'.repeat(6000)}`;
		adapter.apps.mockResolvedValue(
			Array.from({ length: 300 }, (_, index) => ({
				id: `app-${index}`,
				name: `App ${index}`,
				icon,
			})),
		);
		const result = await call('computer_apps', {});
		const text = result.content[0];
		if (text.type !== 'text') throw new Error('No app list');
		const parsed = JSON.parse(text.text);
		expect(parsed.apps).toHaveLength(256);
		expect(parsed.truncated).toBe(true);
		expect(parsed.apps.every((app: object) => !Object.hasOwn(app, 'icon'))).toBe(true);
		expect(text.text.length).toBeLessThan(60_000);
		adapter.apps.mockResolvedValue([{ ...apps[0], icon }]);
		const opened = await call('computer_open', { appId: apps[0].id });
		expect(opened.computer?.app.icon).toBe(icon);
		const observed = opened.content[0];
		if (observed.type !== 'text') throw new Error('No observation');
		expect(JSON.parse(observed.text).app).toEqual(apps[0]);
		expect(host.currentComputerSessions()[0].app.icon).toBe(icon);
	});
});
