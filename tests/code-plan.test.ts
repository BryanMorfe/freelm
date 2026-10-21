import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import {
	codePlanInstructions,
	codePlanToolDenial,
	latestComposerMode,
	parseCodePlanCommand,
} from '../src/lib/code-plan';
import { initialState } from '../src/lib/state';
import { defaultToolSettings } from '../src/lib/tool-settings';
import type { AppState, Message } from '../src/types';
import type { ToolCatalog, ToolHostRequest, ToolResult } from '../src/agent-types';
import { AgentHost } from '../electron/agent-host';
import { ToolRuntime } from '../electron/tools/runtime';
import { ProcessRuntime } from '../electron/tools/processes';
import { MCPRuntime } from '../electron/tools/mcp';
import { OrchestrationRuntime } from '../electron/tools/orchestration';

const user = (id: string, plan = false): Message => ({
	id,
	role: 'user',
	content: 'Inspect the implementation and propose a plan.',
	createdAt: 1,
	...(plan ? { composer: { mode: 'plan' as const } } : {}),
});
const text = (result: ToolResult) =>
	result.content
		.filter((part) => part.type === 'text')
		.map((part) => part.text)
		.join('\n');

describe('committed composer planning mode', () => {
	it('derives mode from the last human input, never from assistant prose or earlier turns', () => {
		const messages = [
			user('planning', true),
			{ ...user('assistant'), role: 'assistant' as const, composer: { mode: 'goal' as const } },
		];
		expect(latestComposerMode(messages)).toBe('plan');
		expect(codePlanInstructions({ messages })).toContain('<proposed_plan>');
		messages.push(user('implementation'));
		expect(latestComposerMode(messages)).toBeUndefined();
		expect(codePlanInstructions(messages)).toBe('');
		expect(latestComposerMode({})).toBeUndefined();
	});
	it.each([
		'pwd',
		'ls -la src',
		'cat "src/a file.ts"',
		'rg --files src',
		"rg -n 'foo$|bar' src | head -20",
		"sed -n '1,240p' src/app.ts",
		"find src -type f -name '*.ts' -print",
		'git status --short',
		'git -C /tmp diff --stat',
		'git show HEAD:src/app.ts',
		'git branch --list',
		"cat a && wc -l b; printf '%s\\n' 'hello'",
		'/usr/bin/head -20 src/app.ts',
	])('admits literal read command %s', (command) => {
		expect(parseCodePlanCommand(command), command).toBeDefined();
		expect(codePlanToolDenial('exec_command', { cmd: command })).toBeUndefined();
	});
	it.each([
		'cat file > other',
		'cat file 2>&1',
		'cat $(touch file)',
		'cat "$NAME"',
		'cat `touch file`',
		'cat *',
		'cat file &',
		'cat file | sh',
		'echo hi; rm -rf src',
		'npm test',
		'python -c "print(1)"',
		'node -e "process.exit()"',
		'./rg foo src',
		'/tmp/rg foo src',
		'env rg foo src',
		'git reset --hard',
		'git log --output=log.txt',
		'git show --ext-diff HEAD',
		'git cat-file --filters HEAD:path',
		'git branch feature',
		'git branch --list --delete feature',
		'rg --pre=./script foo src',
		'rg --hostname-bin=./script foo src',
		'find src -delete',
		'find src -exec touch marker \\;',
		'find src -fprint marker',
		"sed -n '1p;w marker' src/app.ts",
		'sed -i s/a/b/ file',
		'sort -o marker file',
		'sort --compress-program=./script file',
		'file -C -m magic',
		'date -s 2026-01-01',
		'cat file # then rm',
		"cat 'unterminated",
	])('blocks ambiguous or mutating command %s', (command) => {
		expect(parseCodePlanCommand(command), command).toBeUndefined();
		expect(codePlanToolDenial('exec_command', { cmd: command })).toContain('Plan mode');
	});
	it.each([
		'apply_patch',
		'image_gen.imagegen',
		'python.exec',
		'mcp_files_read',
		'memories.update',
		'notes.append_to_file',
		'tasks.create_thread',
		'tasks.send_message_to_thread',
		'create_goal',
		'update_goal',
		'new_context',
		'code_task_authorize',
	])('blocks %s independently of approval mode', (name) => {
		expect(codePlanToolDenial(name, {})).toContain('Plan mode');
	});
	it.each([
		'functions.exec',
		'functions.wait',
		'skills.read',
		'view_image',
		'web.run',
		'update_plan',
		'request_user_input',
		'history.read_item',
		'memories.search',
		'notes.read_file',
		'tasks.read_thread',
		'get_context_remaining',
	])('retains read-only exploration and interaction through %s', (name) => {
		expect(codePlanToolDenial(name, {})).toBeUndefined();
	});
	it('rejects custom/login shells and arbitrary process input', () => {
		expect(codePlanToolDenial('exec_command', { cmd: 'pwd', login: true })).toBeTruthy();
		expect(codePlanToolDenial('exec_command', { cmd: 'pwd', shell: '/tmp/shell' })).toBeTruthy();
		expect(codePlanToolDenial('write_stdin', { chars: 'yes\n' })).toBeTruthy();
		expect(codePlanToolDenial('write_stdin', {})).toBeUndefined();
		expect(codePlanToolDenial('write_stdin', { chars: '\u0003' })).toBeUndefined();
	});
});

const hosts: AgentHost[] = [];
const executeFile = promisify(execFile);
const directories: string[] = [];
let workerDirectory: string, workerPath: string;
beforeAll(async () => {
	const cache = path.join(process.cwd(), 'node_modules/.cache');
	await mkdir(cache, { recursive: true });
	workerDirectory = await mkdtemp(path.join(cache, 'freelm-plan-worker-'));
	workerPath = path.join(workerDirectory, 'worker.cjs');
	await build({
		entryPoints: ['electron/tools/orchestration-worker.ts'],
		outfile: workerPath,
		bundle: true,
		platform: 'node',
		format: 'cjs',
		external: ['quickjs-emscripten'],
	});
});
afterEach(async () => {
	for (const host of hosts.splice(0)) await host.close();
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
	vi.restoreAllMocks();
});
afterAll(async () => await rm(workerDirectory, { recursive: true, force: true }));

function call(name: string, args: Record<string, unknown> = {}): ToolHostRequest {
	return {
		workspaceId: 'local',
		runId: 'plan-run',
		threadId: 'code-thread',
		name,
		arguments: args,
	};
}
async function fixture(plan = true, approve = vi.fn(async () => true)) {
	const directory = await mkdtemp(path.join(tmpdir(), 'freelm-code-plan-'));
	directories.push(directory);
	const state: AppState = initialState();
	state.threads = [
		{
			id: 'code-thread',
			kind: 'code',
			title: 'Plan test',
			connectionId: state.activeConnectionId,
			model: 'local-model',
			messages: [user('request', plan)],
			createdAt: 1,
			updatedAt: 1,
			permissionMode: 'full-access',
		},
	];
	state.toolSettings = {
		...defaultToolSettings(),
		enabled: true,
		commandExecution: true,
		workspaceRoot: directory,
		imageGeneration: { ...defaultToolSettings().imageGeneration, enabled: false },
	};
	const host = new AgentHost(async () => structuredClone(state), approve);
	(host as unknown as { orchestration: OrchestrationRuntime }).orchestration =
		new OrchestrationRuntime({ workerPath });
	hosts.push(host);
	const catalog = await host.catalog('plan-run', 'code-thread');
	return { host, state, catalog, directory, approve };
}
async function completed(host: AgentHost, result: ToolResult): Promise<ToolResult> {
	const output = [result];
	for (let attempt = 0; attempt < 10; attempt++) {
		const cell = text(output.at(-1)!).match(/Script running with cell ID ([\w-]+)/)?.[1];
		if (!cell) return { ...output.at(-1)!, content: output.flatMap((item) => item.content) };
		output.push(await host.execute(call('functions.wait', { cell_id: cell, yield_time_ms: 1000 })));
	}
	throw new Error('Plan interpreter did not complete.');
}

describe('host enforced Code planning', () => {
	it('advertises the enforcement capability and reads real project files without touching them', async () => {
		const { host, catalog, directory } = await fixture();
		expect(catalog.codePlanMode).toBe(1);
		await writeFile(path.join(directory, 'read-me.txt'), 'original contents');
		const result = await host.execute(
			call('exec_command', { cmd: 'cat read-me.txt', yield_time_ms: 1000 }),
		);
		expect(result.isError).not.toBe(true);
		expect(text(result)).toContain('original contents');
		expect(result.process?.command).toBe('cat read-me.txt');
		expect(await readFile(path.join(directory, 'read-me.txt'), 'utf8')).toBe('original contents');
	});
	it('reads Git status and diffs without invoking configured clean filters or modifying the worktree', async () => {
		const { host, directory } = await fixture();
		const git = (...args: string[]) => executeFile('/usr/bin/git', args, { cwd: directory });
		await git('init', '--quiet');
		await git('config', 'user.email', 'fixture@example.invalid');
		await git('config', 'user.name', 'Plan fixture');
		await writeFile(path.join(directory, '.gitattributes'), 'tracked.txt filter=unsafe\n');
		await writeFile(path.join(directory, 'tracked.txt'), 'original contents\n');
		await git('add', '.');
		await git('commit', '--quiet', '-m', 'Fixture baseline');
		const marker = path.join(directory, 'filter-was-executed');
		const filter = path.join(directory, 'unsafe-filter.sh');
		await writeFile(
			filter,
			`#!/bin/sh\nprintf invoked > '${marker.replace(/'/g, "'\\''")}'\ncat\n`,
		);
		await git('config', 'filter.unsafe.clean', `sh '${filter.replace(/'/g, "'\\''")}'`);
		await git('config', 'filter.unsafe.required', 'true');
		await writeFile(path.join(directory, 'tracked.txt'), 'changed contents\n');
		const command = 'git status --short && git diff -- tracked.txt';
		const result = await host.execute(call('exec_command', { cmd: command, yield_time_ms: 1000 }));
		expect(result.isError).not.toBe(true);
		expect(text(result)).toContain('changed contents');
		expect(result.process?.command).toBe(command);
		expect(await readFile(path.join(directory, 'tracked.txt'), 'utf8')).toBe('changed contents\n');
		await expect(readFile(marker)).rejects.toThrow();
	});
	it('rejects direct writes and external MCP calls even with Full access, without invoking the reviewer', async () => {
		const { host, approve } = await fixture();
		const execute = vi.spyOn(ToolRuntime.prototype, 'execute');
		for (const request of [
			call('exec_command', { cmd: 'touch marker' }),
			call('apply_patch', { patch: 'anything' }),
			call('mcp_files_read', { path: '/tmp/file' }),
		]) {
			const result = await host.execute(request);
			expect(result.isError).toBe(true);
			expect(text(result)).toContain('Plan mode');
		}
		expect(execute).not.toHaveBeenCalled();
		expect(approve).not.toHaveBeenCalled();
	});
	it('checks nested JavaScript tool calls against the same policy', async () => {
		const { host, directory } = await fixture();
		const execute = vi.spyOn(ToolRuntime.prototype, 'execute');
		const result = await completed(
			host,
			await host.execute(
				call('functions.exec', {
					code: 'const result = await tools.apply_patch({patch:"*** Begin Patch\\n*** Add File: marker.txt\\n+blocked\\n*** End Patch"}); text(result);',
					yield_time_ms: 1000,
				}),
			),
		);
		expect(text(result)).toContain('Plan mode blocked apply_patch');
		expect(execute).not.toHaveBeenCalled();
		await expect(readFile(path.join(directory, 'marker.txt'))).rejects.toThrow();
	});
	it('allows read-only nested orchestration', async () => {
		const { host, directory } = await fixture();
		await writeFile(path.join(directory, 'read-me.txt'), 'nested read contents');
		const result = await completed(
			host,
			await host.execute(
				call('functions.exec', {
					code: 'text(await tools.exec_command({cmd:"cat read-me.txt"}));',
					yield_time_ms: 1000,
				}),
			),
		);
		expect(text(result)).toContain('nested read contents');
	});
	it('applies queued Plan selection only after that input is committed and permits implementation after explicit removal', async () => {
		const { host, state } = await fixture(false);
		state.threads[0].queuedMessages = [
			{ id: 'queued', content: 'Plan the next changes.', createdAt: 2, composer: { mode: 'plan' } },
		];
		const execute = vi
			.spyOn(ToolRuntime.prototype, 'execute')
			.mockResolvedValue({ content: [{ type: 'text', text: 'executed' }] });
		const request = call('apply_patch', { patch: '*** Begin Patch\n*** End Patch' });
		expect(text(await host.execute(request))).toBe('executed');
		state.threads[0].messages.push(user('committed-plan', true));
		state.threads[0].queuedMessages = [];
		expect(text(await host.execute(request))).toContain('Plan mode');
		state.threads[0].messages.push(user('implement'));
		expect(text(await host.execute(request))).toBe('executed');
		expect(execute).toHaveBeenCalledTimes(2);
	});
	it('rechecks Plan selection after an asynchronous permission review', async () => {
		const approve = vi.fn(async () => {
			state.threads[0].messages.push(user('plan', true));
			return true;
		});
		const { host, state } = await fixture(false, approve);
		state.threads[0].permissionMode = 'ask';
		const execute = vi.spyOn(ToolRuntime.prototype, 'execute');
		const result = await host.execute(
			call('apply_patch', { patch: '*** Begin Patch\n*** End Patch' }),
		);
		expect(approve).toHaveBeenCalledOnce();
		expect(result.isError).toBe(true);
		expect(text(result)).toContain('Plan mode');
		expect(execute).not.toHaveBeenCalled();
	});
	it('does not launch configured MCP servers during initial Plan discovery', async () => {
		const discover = vi.spyOn(MCPRuntime.prototype, 'discover');
		const { state, host } = await fixture();
		host.cancel('plan-run');
		state.toolSettings!.mcpServers = [
			{
				id: 'server',
				name: 'Custom',
				enabled: true,
				transport: 'stdio',
				command: '/tmp/unknown-program',
			},
		];
		const catalog = await host.catalog('second-run', 'code-thread');
		expect(catalog.tools.some((tool) => tool.source === 'mcp')).toBe(false);
		expect(discover).toHaveBeenLastCalledWith([], expect.anything());
	});
	it('uses absolute host binaries, safe quoting and no inherited ripgrep configuration for read commands', async () => {
		const { host } = await fixture();
		const execute = vi.spyOn(ProcessRuntime.prototype, 'exec').mockResolvedValue({ content: [] });
		await host.execute(call('exec_command', { cmd: 'pwd && cat "a file.txt"', shell: '/bin/zsh' }));
		const request = execute.mock.calls[0][0];
		expect(request.arguments).toMatchObject({ shell: '/bin/sh', login: false });
		expect(request.arguments.cmd).toMatch(
			/'\/(?:usr\/)?bin\/pwd' && '\/(?:usr\/)?bin\/cat' 'a file.txt'/,
		);
	});
});
