import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { AgentHost } from '../electron/agent-host';
import { ProcessRuntime } from '../electron/tools/processes';
import { MCPRuntime } from '../electron/tools/mcp';
import { WebRuntime } from '../electron/tools/web';
import { assertRemoteProjectAssignments, projectToolScope } from '../electron/project-roots';
import { defaultToolSettings, normalizeCodePermissionMode } from '../src/lib/tool-settings';
import type { AppState, Thread } from '../src/types';
import type {
	CodeActionDecision,
	ToolApproval,
	ToolApprovalResponse,
	ToolHostRequest,
	ToolResult,
} from '../src/agent-types';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
	vi.restoreAllMocks();
});
const text = (result: ToolResult) =>
	result.content
		.filter((part) => part.type === 'text')
		.map((part) => part.text)
		.join('\n');
const call = (
	name: string,
	args: Record<string, unknown>,
	runId = 'run',
	threadId = 'thread',
): ToolHostRequest => ({ workspaceId: 'local', runId, threadId, name, arguments: args });
async function fixture(
	response: ToolApprovalResponse = true,
	reviewDecision: CodeActionDecision = { approved: true, reason: 'Authorized development action.' },
) {
	const directory = await mkdtemp(path.join(tmpdir(), 'freelm-code-permissions-'));
	cleanup.push(() => rm(directory, { recursive: true, force: true }));
	const project = path.join(directory, 'project'),
		outside = path.join(directory, 'outside');
	await Promise.all([mkdir(project), mkdir(outside)]);
	const state: AppState = {
		version: 1,
		theme: 'dark',
		activeConnectionId: 'provider',
		generations: [],
		projects: [
			{
				id: 'project',
				kind: 'code',
				name: 'Project',
				instructions: '',
				directories: [project],
				createdAt: 1,
			},
		],
		connections: [
			{
				id: 'provider',
				name: 'Provider',
				baseUrl: 'http://provider.invalid/v1',
				apiKey: '',
				chatApi: 'responses',
				models: { chat: 'model', images: '', videos: '', speech: '', transcription: '' },
				discoveredModels: [],
			},
		],
		threads: [
			{
				id: 'thread',
				kind: 'code',
				title: 'Task',
				projectId: 'project',
				connectionId: 'provider',
				model: 'model',
				thinkingMode: 'low',
				messages: [],
				createdAt: 1,
				updatedAt: 1,
			},
		],
		toolSettings: { ...defaultToolSettings(), workspaceRoot: project },
	};
	const approve = vi.fn(async (_request: ToolApproval, _signal: AbortSignal) => response),
		reviewer = vi.fn(
			async (_state: AppState, _thread: Thread, _request: ToolHostRequest, _signal: AbortSignal) =>
				reviewDecision,
		);
	const load = vi.fn(async () => structuredClone(state));
	const host = new AgentHost(load, approve, undefined, reviewer);
	cleanup.push(() => host.close());
	return { state, host, approve, reviewer, project, outside, load };
}

describe('Code host permissions', () => {
	it('rechecks authorization when permission changes in the final pre-execution load', async () => {
		const { host, state, load, approve } = await fixture(false);
		state.threads[0].permissionMode = 'full-access';
		const process = vi.spyOn(ProcessRuntime.prototype, 'exec');
		await host.catalog('run', 'thread');
		let reads = 0;
		load.mockImplementation(async () => {
			// execute, consent, consent recheck, authorize recheck, final dispatch check.
			if (++reads === 5) state.threads[0].permissionMode = 'ask';
			return structuredClone(state);
		});
		const result = await host.execute(call('exec_command', { cmd: 'printf must-not-run' }));
		expect(approve).toHaveBeenCalledOnce();
		expect(result.approvalDenied).toMatchObject({ permissionMode: 'ask' });
		expect(process).not.toHaveBeenCalled();
	});
	it('defaults new Code tools to enabled with Ask, retaining explicit disabled settings and legacy trust', () => {
		expect(defaultToolSettings()).toMatchObject({
			enabled: true,
			commandExecution: true,
			approvalMode: 'ask',
		});
		expect(normalizeCodePermissionMode('trusted')).toBe('full-access');
		expect(normalizeCodePermissionMode('invalid')).toBe('ask');
	});

	it('uses host home without a project or configured directory and offers working tools', async () => {
		const { host, state } = await fixture();
		delete state.threads[0].projectId;
		state.toolSettings!.workspaceRoot = '';
		expect(projectToolScope(state, 'thread').settings.workspaceRoot).toBe(homedir());
		const catalog = await host.catalog('run', 'thread');
		expect(catalog.tools.map((tool) => tool.name)).toEqual(
			expect.arrayContaining(['exec_command', 'apply_patch', 'view_image']),
		);
		const result = await host.execute(call('exec_command', { cmd: 'pwd' }));
		expect(JSON.parse(text(result)).output.trim()).toBe(await realpath(homedir()));
	});

	it('allows an approved command, image, and all-target patch outside the project', async () => {
		const { host, approve, project, outside } = await fixture();
		await writeFile(path.join(outside, 'image.png'), Buffer.from('iVBORw0KGgo=', 'base64'));
		await host.catalog('run', 'thread');
		const command = await host.execute(call('exec_command', { cmd: 'pwd', workdir: outside }));
		expect(JSON.parse(text(command)).output.trim()).toBe(await realpath(outside));
		expect(
			(await host.execute(call('view_image', { path: path.join(outside, 'image.png') }))).content[0]
				.type,
		).toBe('image');
		const patch = await host.execute(
			call('apply_patch', {
				patch: `*** Begin Patch\n*** Add File: inside.txt\n+inside\n*** Add File: ${path.join(outside, 'nested', 'outside.txt')}\n+outside\n*** End Patch`,
			}),
		);
		expect(patch.isError).not.toBe(true);
		expect(await readFile(path.join(project, 'inside.txt'), 'utf8')).toBe('inside\n');
		expect(await readFile(path.join(outside, 'nested', 'outside.txt'), 'utf8')).toBe('outside\n');
		expect(approve).toHaveBeenCalledTimes(3);
	});

	it('denies commands, file reads, patches and browsing before any effect', async () => {
		const { host, state, outside } = await fixture(false);
		state.toolSettings!.webBrowsing = {
			enabled: true,
			mode: 'external',
			searxngUrl: 'http://search.invalid',
		};
		const process = vi.spyOn(ProcessRuntime.prototype, 'exec'),
			web = vi.spyOn(WebRuntime.prototype, 'execute');
		await host.catalog('run', 'thread');
		for (const [name, args] of [
			['exec_command', { cmd: `touch ${path.join(outside, 'command.txt')}` }],
			['view_image', { path: path.join(outside, 'image.png') }],
			[
				'apply_patch',
				{
					patch: `*** Begin Patch\n*** Add File: ${path.join(outside, 'patch.txt')}\n+blocked\n*** End Patch`,
				},
			],
			['web.run', { search_query: [{ q: 'test' }] }],
		] as [string, Record<string, unknown>][]) {
			const result = await host.execute(call(name, args));
			expect(result.isError).toBe(true);
			expect(text(result)).toContain('declined');
		}
		expect(process).not.toHaveBeenCalled();
		expect(web).not.toHaveBeenCalled();
		for (const file of ['command.txt', 'patch.txt'])
			await expect(readFile(path.join(outside, file))).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('validates every patch target before writing an approved valid target', async () => {
		const { host, project, outside } = await fixture();
		await writeFile(path.join(outside, 'parent-file'), 'not a directory');
		await host.catalog('run', 'thread');
		const result = await host.execute(
			call('apply_patch', {
				patch: `*** Begin Patch\n*** Add File: valid.txt\n+valid\n*** Add File: ${path.join(outside, 'parent-file', 'invalid.txt')}\n+invalid\n*** End Patch`,
			}),
		);
		expect(result.isError).toBe(true);
		await expect(readFile(path.join(project, 'valid.txt'))).rejects.toMatchObject({
			code: 'ENOENT',
		});
	});

	it('runs a separate reviewer and exposes its denial, invalid decisions and failure without manual fallback', async () => {
		const { host, state, reviewer, approve } = await fixture(true, {
			approved: false,
			reason: 'The human did not authorize uploading these files.',
		});
		state.threads[0].permissionMode = 'auto-review';
		const process = vi.spyOn(ProcessRuntime.prototype, 'exec');
		await host.catalog('run', 'thread');
		const request = call('exec_command', { cmd: 'printf approved' });
		expect(text(await host.execute(request))).toContain('did not authorize');
		expect(reviewer).toHaveBeenCalledWith(
			expect.objectContaining({ threads: state.threads }),
			state.threads[0],
			request,
			expect.any(AbortSignal),
		);
		reviewer.mockRejectedValueOnce(new Error('Provider offline'));
		const failedReview = await host.execute(request);
		expect(text(failedReview)).toContain('Automatic approval review could not complete');
		expect(text(failedReview)).not.toContain('Provider offline');
		expect(failedReview.approvalReviewError).toMatchObject({ code: 'unavailable' });
		expect(failedReview.approvalDenied).toBeUndefined();
		reviewer.mockResolvedValueOnce({
			approved: 'yes',
			reason: '',
		} as unknown as CodeActionDecision);
		expect(text(await host.execute(request))).toContain('invalid decision');
		expect(process).not.toHaveBeenCalled();
		expect(approve).not.toHaveBeenCalled();
	});

	it('Full access and legacy trust bypass approval, while explicit thread Ask overrides the default', async () => {
		const { host, state, approve, reviewer } = await fixture();
		state.toolSettings!.approvalMode = 'trusted';
		await host.catalog('run', 'thread');
		await host.execute(call('exec_command', { cmd: 'printf legacy' }));
		expect(approve).not.toHaveBeenCalled();
		expect(reviewer).not.toHaveBeenCalled();
		host.cancel('run');
		state.threads[0].permissionMode = 'ask';
		await host.catalog('run', 'thread');
		await host.execute(call('exec_command', { cmd: 'printf ask' }));
		expect(approve).toHaveBeenCalledOnce();
	});

	it('reuses explicit exact-action grants only in that task and revokes them when settings change', async () => {
		const { host, state, approve } = await fixture({ approved: true, remember: true });
		await host.catalog('run', 'thread');
		await host.execute(call('exec_command', { cmd: 'printf repeated', max_output_tokens: 100 }));
		await host.execute(call('exec_command', { cmd: 'printf repeated', max_output_tokens: 200 }));
		expect(approve).toHaveBeenCalledOnce();
		host.cancel('run');
		await host.catalog('run-next', 'thread');
		await host.execute(call('exec_command', { cmd: 'printf repeated' }, 'run-next'));
		expect(approve).toHaveBeenCalledOnce();
		state.threads.push({ ...state.threads[0], id: 'other-thread' });
		await host.catalog('other-run', 'other-thread');
		await host.execute(
			call('exec_command', { cmd: 'printf repeated' }, 'other-run', 'other-thread'),
		);
		expect(approve).toHaveBeenCalledTimes(2);
		state.toolSettings!.allowRemote = true;
		await expect(
			host.execute(call('exec_command', { cmd: 'printf repeated' }, 'run-next')),
		).rejects.toThrow('Tool settings changed');
		await host.catalog('run-final', 'thread');
		await host.execute(call('exec_command', { cmd: 'printf repeated' }, 'run-final'));
		expect(approve).toHaveBeenCalledTimes(3);
	});

	it('reevaluates pending Ask under Full access and executes the same action once despite a stale denial', async () => {
		const { host, state, approve, project } = await fixture();
		let respond!: (response: ToolApprovalResponse) => void;
		approve.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					respond = resolve;
				}),
		);
		const process = vi.spyOn(ProcessRuntime.prototype, 'exec');
		await host.catalog('run', 'thread');
		const pending = host.execute(call('exec_command', { cmd: 'printf executed >> consent.txt' }));
		await vi.waitFor(() => expect(approve).toHaveBeenCalledOnce());
		expect(process).not.toHaveBeenCalled();
		state.threads[0].permissionMode = 'full-access';
		respond(false);
		expect((await pending).isError).not.toBe(true);
		expect(process).toHaveBeenCalledOnce();
		expect(process.mock.calls[0][0]).toMatchObject({
			runId: 'run',
			threadId: 'thread',
			arguments: { cmd: 'printf executed >> consent.txt' },
		});
		expect(await readFile(path.join(project, 'consent.txt'), 'utf8')).toBe('executed');
		expect(approve).toHaveBeenCalledOnce();
	});

	it('denies MCP startup before discovery and prevents remote clients changing host permission modes', async () => {
		const { host, state } = await fixture(false);
		state.toolSettings!.mcpServers = [
			{ id: 'server', name: 'Server', enabled: true, transport: 'stdio', command: 'never-run' },
		];
		const discover = vi.spyOn(MCPRuntime.prototype, 'discover');
		await expect(host.catalog('run', 'thread')).rejects.toThrow('MCP connection was declined');
		expect(discover).not.toHaveBeenCalled();
		const modified = structuredClone(state);
		modified.threads[0].permissionMode = 'full-access';
		expect(() => assertRemoteProjectAssignments(state, modified)).toThrow('host computer');
		modified.threads[0].id = 'new-remote-task';
		expect(() => assertRemoteProjectAssignments(state, modified)).toThrow('host computer');
	});

	it('keeps the proposed action immutable when a caller or approval callback mutates arguments', async () => {
		const { host, approve } = await fixture();
		let respond!: (response: ToolApprovalResponse) => void;
		approve.mockImplementationOnce(async (approval) => {
			approval.arguments.cmd = 'printf callback-mutation';
			return await new Promise<ToolApprovalResponse>((resolve) => {
				respond = resolve;
			});
		});
		await host.catalog('run', 'thread');
		const request = call('exec_command', { cmd: 'printf original' });
		const pending = host.execute(request);
		await vi.waitFor(() => expect(approve).toHaveBeenCalledOnce());
		request.arguments.cmd = 'printf caller-mutation';
		respond(true);
		expect(JSON.parse(text(await pending)).output).toBe('original');
	});

	it('requires approval for process input, while polling an owned process needs no new approval', async () => {
		const { host, approve } = await fixture();
		const write = vi.spyOn(ProcessRuntime.prototype, 'write');
		await host.catalog('run', 'thread');
		const process = await host.execute(
			call('exec_command', { cmd: 'read input; printf "%s" "$input"', yield_time_ms: 0 }),
		);
		const session = JSON.parse(text(process)).session_id;
		approve.mockResolvedValueOnce(false);
		const denied = await host.execute(
			call('write_stdin', { session_id: session, chars: 'blocked\n' }),
		);
		expect(denied.isError).toBe(true);
		expect(write).not.toHaveBeenCalled();
		await host.execute(call('write_stdin', { session_id: session, yield_time_ms: 0 }));
		expect(write).toHaveBeenCalledOnce();
		expect(approve).toHaveBeenCalledTimes(2);
	});

	it.each(['model', 'thinkingMode', 'connectionId'] as const)(
		'rereviews a pending action after the reviewer %s changes without accepting the stale approval',
		async (field) => {
			const { host, state, reviewer, approve } = await fixture(true, {
				approved: false,
				reason: 'Updated review declined this action.',
			});
			state.threads[0].permissionMode = 'auto-review';
			const process = vi.spyOn(ProcessRuntime.prototype, 'exec');
			let respond!: (decision: CodeActionDecision) => void;
			reviewer.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						respond = resolve;
					}),
			);
			await host.catalog('run', 'thread');
			const pending = host.execute(call('exec_command', { cmd: 'printf should-not-run' }));
			await vi.waitFor(() => expect(reviewer).toHaveBeenCalledOnce());
			if (field === 'connectionId')
				state.connections.push({ ...state.connections[0], id: 'another-provider' });
			state.threads[0][field] =
				field === 'model'
					? 'another-model'
					: field === 'thinkingMode'
						? 'high'
						: 'another-provider';
			respond({ approved: true, reason: 'Authorized' });
			const result = await pending;
			expect(result.isError).toBe(true);
			expect(text(result)).toContain('Updated review declined');
			expect(reviewer).toHaveBeenCalledTimes(2);
			expect(reviewer.mock.calls[1][1]).toMatchObject({ [field]: state.threads[0][field] });
			expect(reviewer.mock.calls[1][2]).toMatchObject({
				runId: 'run',
				arguments: { cmd: 'printf should-not-run' },
			});
			expect(approve).not.toHaveBeenCalled();
			expect(process).not.toHaveBeenCalled();
		},
	);

	it('switches pending auto-review to Ask and waits for a fresh manual decision before any effect', async () => {
		const { host, state, reviewer, approve, project } = await fixture();
		state.threads[0].permissionMode = 'auto-review';
		let reviewResponse!: (decision: CodeActionDecision) => void;
		let manualResponse!: (response: ToolApprovalResponse) => void;
		reviewer.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					reviewResponse = resolve;
				}),
		);
		approve.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					manualResponse = resolve;
				}),
		);
		const process = vi.spyOn(ProcessRuntime.prototype, 'exec');
		await host.catalog('run', 'thread');
		const pending = host.execute(call('exec_command', { cmd: 'printf approved >> manual.txt' }));
		await vi.waitFor(() => expect(reviewer).toHaveBeenCalledOnce());
		state.threads[0].permissionMode = 'ask';
		reviewResponse({ approved: true, reason: 'Old automatic decision.' });
		await vi.waitFor(() => expect(approve).toHaveBeenCalledOnce());
		expect(approve.mock.calls[0][0]).toMatchObject({
			permissionMode: 'ask',
			runId: 'run',
			arguments: { cmd: 'printf approved >> manual.txt' },
		});
		expect(process).not.toHaveBeenCalled();
		await expect(readFile(path.join(project, 'manual.txt'))).rejects.toMatchObject({
			code: 'ENOENT',
		});
		manualResponse(true);
		expect((await pending).isError).not.toBe(true);
		expect(await readFile(path.join(project, 'manual.txt'), 'utf8')).toBe('approved');
		expect(process).toHaveBeenCalledOnce();
		expect(reviewer).toHaveBeenCalledOnce();
	});

	it('still discards late auto-review approval after an explicit run cancellation', async () => {
		const { host, state, reviewer } = await fixture();
		state.threads[0].permissionMode = 'auto-review';
		let respond!: (decision: CodeActionDecision) => void;
		reviewer.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					respond = resolve;
				}),
		);
		const process = vi.spyOn(ProcessRuntime.prototype, 'exec');
		await host.catalog('cancelled-run', 'thread');
		const cancelled = host.execute(
			call('exec_command', { cmd: 'printf should-not-run' }, 'cancelled-run'),
		);
		const aborted = expect(cancelled).rejects.toThrow('cancelled');
		await vi.waitFor(() => expect(reviewer).toHaveBeenCalledOnce());
		host.cancel('cancelled-run');
		respond({ approved: true, reason: 'Authorized' });
		await aborted;
		expect(process).not.toHaveBeenCalled();
	});

	it.each(['directories', 'toolSettings'] as const)(
		'cancels pending approval before execution when actual %s change',
		async (field) => {
			const { host, state, approve, outside } = await fixture();
			let respond!: (response: ToolApprovalResponse) => void;
			approve.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						respond = resolve;
					}),
			);
			const process = vi.spyOn(ProcessRuntime.prototype, 'exec');
			await host.catalog('run', 'thread');
			const pending = host.execute(call('exec_command', { cmd: 'printf should-not-run' }));
			const rejected = expect(pending).rejects.toThrow(
				field === 'directories' ? 'Project directories changed' : 'Tool settings changed',
			);
			await vi.waitFor(() => expect(approve).toHaveBeenCalledOnce());
			if (field === 'directories') state.projects[0].directories = [outside];
			else state.toolSettings!.commandExecution = false;
			respond(true);
			await rejected;
			expect(process).not.toHaveBeenCalled();
		},
	);

	it('preserves an owned interactive process and run while model, effort and permission mode change', async () => {
		const { host, state, approve } = await fixture();
		state.threads[0].permissionMode = 'full-access';
		const exec = vi.spyOn(ProcessRuntime.prototype, 'exec');
		await host.catalog('run', 'thread');
		const initial = await host.execute(
			call('exec_command', {
				cmd: 'read input; printf "received:%s" "$input"',
				yield_time_ms: 0,
			}),
		);
		const session = JSON.parse(text(initial)).session_id;
		expect(session).toEqual(expect.any(String));
		state.threads[0].model = 'another-model';
		state.threads[0].thinkingMode = 'high';
		state.threads[0].permissionMode = 'ask';
		const poll = await host.execute(call('write_stdin', { session_id: session, yield_time_ms: 0 }));
		expect(JSON.parse(text(poll)).session_id).toBe(session);
		expect(approve).not.toHaveBeenCalled();
		const completed = await host.execute(
			call('write_stdin', { session_id: session, chars: 'continued\n', yield_time_ms: 1000 }),
		);
		expect(JSON.parse(text(completed))).toMatchObject({
			output: 'received:continued',
			exit_code: 0,
		});
		expect(completed.process?.sessionId).toBe(session);
		expect(exec).toHaveBeenCalledOnce();
		expect(approve).toHaveBeenCalledOnce();
		expect(approve.mock.calls[0][0]).toMatchObject({
			name: 'write_stdin',
			runId: 'run',
			permissionMode: 'ask',
		});
	});

	it('revokes remembered Ask grants across an observed Full access and Ask mode cycle without replacing the run', async () => {
		const { host, state, approve } = await fixture({ approved: true, remember: true });
		const process = vi.spyOn(ProcessRuntime.prototype, 'exec');
		await host.catalog('run', 'thread');
		await host.execute(call('exec_command', { cmd: 'printf remembered' }));
		state.threads[0].permissionMode = 'full-access';
		await host.execute(call('exec_command', { cmd: 'printf full' }));
		state.threads[0].permissionMode = 'ask';
		approve.mockResolvedValueOnce(false);
		const denied = await host.execute(call('exec_command', { cmd: 'printf remembered' }));
		expect(denied.isError).toBe(true);
		expect(text(denied)).toContain('declined');
		expect(approve).toHaveBeenCalledTimes(2);
		expect(process).toHaveBeenCalledTimes(2);
	});
});
