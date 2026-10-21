import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { AgentHost } from '../electron/agent-host';
import { ProcessRuntime } from '../electron/tools/processes';
import { ToolRuntime } from '../electron/tools/runtime';
import {
	assertRemoteProjectAssignments,
	assertRemoteProjectDirectories,
	projectToolScope,
	validProjectDirectories,
} from '../electron/project-roots';
import { validateState } from '../electron/validation';
import { defaultToolSettings } from '../src/lib/tool-settings';
import type { AppState } from '../src/types';
import type { ToolApproval, ToolHostRequest, ToolResult, ToolSettings } from '../src/agent-types';

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
const request = (name: string, args: Record<string, unknown> = {}): ToolHostRequest => ({
	workspaceId: 'local',
	runId: 'run',
	threadId: 'thread',
	name,
	arguments: args,
});
function stateFor(directories: string[], globalRoot = '/global'): AppState {
	return {
		version: 1,
		theme: 'dark',
		activeConnectionId: 'connection',
		generations: [],
		connections: [
			{
				id: 'connection',
				name: 'Test',
				baseUrl: 'http://localhost:9999/v1',
				apiKey: '',
				chatApi: 'responses',
				models: { chat: 'model', images: '', videos: '', speech: '', transcription: '' },
				discoveredModels: [],
			},
		],
		projects: [{ id: 'project', name: 'Project', instructions: '', createdAt: 1, directories }],
		threads: [
			{
				id: 'thread',
				kind: 'code',
				title: 'Chat',
				projectId: 'project',
				connectionId: 'connection',
				model: 'model',
				messages: [],
				createdAt: 1,
				updatedAt: 1,
			},
		],
		toolSettings: {
			...defaultToolSettings(),
			enabled: true,
			commandExecution: true,
			workspaceRoot: globalRoot,
		},
	};
}
async function folders() {
	const directory = await mkdtemp(path.join(tmpdir(), 'freelm-project-roots-'));
	cleanup.push(() => rm(directory, { recursive: true, force: true }));
	const first = path.join(directory, 'first'),
		second = path.join(directory, 'second'),
		global = path.join(directory, 'global');
	await Promise.all([first, second, global].map((folder) => mkdir(folder)));
	return { directory, first, second, global };
}
async function hostFixture(
	approve: (request: ToolApproval, signal: AbortSignal) => Promise<boolean> = async () => true,
) {
	const paths = await folders(),
		state = stateFor([paths.first, paths.second], paths.global);
	const host = new AgentHost(async () => structuredClone(state), approve);
	cleanup.push(() => host.close());
	return { ...paths, state, host };
}

describe('host project directory binding', () => {
	it('uses only the selected project directories and never enables execution or changes approval mode', () => {
		const state = stateFor(['/projects/one', '/projects/two']);
		state.toolSettings!.workspaceRoots = ['/forged'];
		state.toolSettings!.commandExecution = false;
		const scope = projectToolScope(state, 'thread');
		expect(scope.settings).toMatchObject({
			workspaceRoot: '/projects/one',
			workspaceRoots: ['/projects/one', '/projects/two'],
			enabled: true,
			commandExecution: false,
			approvalMode: 'ask',
		});
		expect(state.toolSettings!.workspaceRoot).toBe('/global');
	});

	it('keeps the global default for nonproject tasks and uses home for an unbound project', () => {
		const state = stateFor([]);
		expect(projectToolScope(state, 'thread').settings).toMatchObject({
			workspaceRoot: homedir(),
			workspaceRoots: [],
			workspacePathsUnrestricted: true,
		});
		delete state.threads[0].projectId;
		expect(projectToolScope(state, 'thread').settings).toMatchObject({
			workspaceRoot: '/global',
			workspaceRoots: ['/global'],
		});
		state.threads[0].projectId = 'deleted-project';
		expect(() => projectToolScope(state, 'thread')).toThrow('no longer exists');
	});

	it('validates ordered unique absolute project directories while retaining legacy projects', () => {
		for (const dirs of [
			['relative'],
			[''],
			['/one', '/one'],
			['/one/../one', '/one'],
			['//one/./two/../', '/one'],
			['/../../', '/'],
			['C:\\one'],
			['/bad\0path'],
			Array.from({ length: 33 }, (_, i) => `/path${i}`),
		])
			expect(validProjectDirectories(dirs)).toBe(false);
		expect(validProjectDirectories(['/one', '/two'])).toBe(true);
		expect(validProjectDirectories(['/folder with spaces', '/ümlaut'])).toBe(true);
		expect(validProjectDirectories([])).toBe(true);
		const state = stateFor(['/one']);
		expect(() => validateState(state)).not.toThrow();
		state.projects[0].directories = ['relative'];
		expect(() => validateState(state)).toThrow('Workspace data is invalid');
		delete state.projects[0].directories;
		expect(() => validateState(state)).not.toThrow();
	});

	it('runs in the first project directory by default and supports another selected directory by absolute path', async () => {
		const { host, first, second, global } = await hostFixture();
		const catalog = await host.catalog('run', 'thread');
		expect(catalog.instructions).toContain(first);
		expect(catalog.instructions).toContain(second);
		expect(catalog.instructions).not.toContain(global);
		const defaultResult = await host.execute(
			request('exec_command', { cmd: 'pwd', yield_time_ms: 1000 }),
		);
		expect(JSON.parse(text(defaultResult)).output.trim()).toBe(await realpath(first));
		const secondResult = await host.execute(
			request('exec_command', { cmd: 'pwd', workdir: second, yield_time_ms: 1000 }),
		);
		expect(JSON.parse(text(secondResult)).output.trim()).toBe(await realpath(second));
		const outside = await host.execute(request('exec_command', { cmd: 'pwd', workdir: global }));
		expect(outside.isError).not.toBe(true);
		expect(JSON.parse(text(outside)).output.trim()).toBe(await realpath(global));
	});

	it('offers tools in unbound projects while preserving an explicitly disabled command setting', async () => {
		const { host, state } = await hostFixture();
		state.projects[0].directories = [];
		const unbound = await host.catalog('run', 'thread');
		expect(
			unbound.tools
				.filter((tool) => ['exec_command', 'apply_patch', 'view_image'].includes(tool.name))
				.map((tool) => tool.name),
		).toEqual(['exec_command', 'apply_patch', 'view_image']);
		host.cancel('run');
		state.projects[0].directories = ['/bound-but-not-necessarily-existing-yet'];
		state.toolSettings!.commandExecution = false;
		const disabled = await host.catalog('run', 'thread');
		expect(disabled.tools.some((tool) => tool.name === 'exec_command')).toBe(false);
		expect(disabled.tools.some((tool) => tool.name === 'view_image')).toBe(true);
	});

	it('cancels a run if project bindings change before another tool call', async () => {
		const { host, state, global } = await hostFixture();
		await host.catalog('run', 'thread');
		state.projects[0].directories = [global];
		await expect(host.execute(request('clock.curr_time'))).rejects.toThrow(
			'Project directories changed',
		);
		await expect(host.execute(request('clock.curr_time'))).rejects.toThrow('no longer active');
	});

	it('rechecks project bindings after an approval and never starts a command using a changed binding', async () => {
		let respond!: (approved: boolean) => void;
		const approve = vi.fn(
			async () =>
				await new Promise<boolean>((resolve) => {
					respond = resolve;
				}),
		);
		const process = vi.spyOn(ProcessRuntime.prototype, 'exec');
		const { host, state, global } = await hostFixture(approve);
		await host.catalog('run', 'thread');
		const pending = host.execute(request('exec_command', { cmd: 'printf should-not-run' }));
		const rejected = expect(pending).rejects.toThrow('Project directories changed');
		await vi.waitFor(() => expect(approve).toHaveBeenCalledOnce());
		state.projects[0].directories = [global];
		respond(true);
		await rejected;
		expect(process).not.toHaveBeenCalled();
	});

	it('blocks remote changes to directory bindings and existing chat execution scope', () => {
		const original = stateFor(['/host/one']);
		const modified = structuredClone(original);
		modified.projects[0].directories = ['/host/two'];
		expect(() => assertRemoteProjectDirectories(original.projects, modified.projects)).toThrow(
			'host computer',
		);
		expect(() => assertRemoteProjectDirectories([], original.projects)).toThrow('host computer');
		expect(() =>
			assertRemoteProjectDirectories(original.projects, [
				{ ...original.projects[0], name: 'Renamed' },
			]),
		).not.toThrow();
		modified.projects[0].directories = ['/host/one'];
		delete modified.threads[0].projectId;
		expect(() => assertRemoteProjectAssignments(original, modified)).toThrow('host computer');
		modified.threads[0].id = 'new-chat';
		expect(() => assertRemoteProjectAssignments(original, modified)).not.toThrow();
	});
});

describe('file tools across selected roots', () => {
	let runtime: ToolRuntime, settings: ToolSettings, first: string, second: string, global: string;
	const execute = (name: string, args: Record<string, unknown>) =>
		runtime.execute(request(name, args), settings, new AbortController().signal);
	beforeEach(async () => {
		({ first, second, global } = await folders());
		runtime = new ToolRuntime();
		cleanup.push(() => runtime.close());
		settings = {
			...defaultToolSettings(),
			enabled: true,
			commandExecution: true,
			workspaceRoot: first,
			workspaceRoots: [first, second],
		};
	});

	it('patches both roots, moves files between them, and resolves relative paths only from the first', async () => {
		await writeFile(path.join(first, 'move.txt'), 'old\n');
		const result = await execute('apply_patch', {
			patch: [
				'*** Begin Patch',
				'*** Add File: local.txt',
				'+local',
				`*** Add File: ${path.join(second, 'nested/other.txt')}`,
				'+other',
				'*** Update File: move.txt',
				`*** Move to: ${path.join(second, 'moved.txt')}`,
				'@@',
				'-old',
				'+new',
				'*** End Patch',
			].join('\n'),
		});
		expect(result.isError).not.toBe(true);
		expect(await readFile(path.join(first, 'local.txt'), 'utf8')).toBe('local\n');
		expect(await readFile(path.join(second, 'nested/other.txt'), 'utf8')).toBe('other\n');
		expect(await readFile(path.join(second, 'moved.txt'), 'utf8')).toBe('new\n');
		await expect(readFile(path.join(first, 'move.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('rejects any patch outside both roots before writing either valid target', async () => {
		const result = await execute('apply_patch', {
			patch: `*** Begin Patch\n*** Add File: valid.txt\n+valid\n*** Add File: ${path.join(global, 'outside.txt')}\n+outside\n*** End Patch`,
		});
		expect(result.isError).toBe(true);
		await expect(readFile(path.join(first, 'valid.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
		await expect(readFile(path.join(global, 'outside.txt'))).rejects.toMatchObject({
			code: 'ENOENT',
		});
	});

	it('reads images in either root but rejects symlinks and unselected directories', async () => {
		const image = Buffer.from('iVBORw0KGgo=', 'base64');
		for (const directory of [first, second, global])
			await writeFile(path.join(directory, 'image.png'), image);
		expect((await execute('view_image', { path: 'image.png' })).content[0]).toMatchObject({
			type: 'image',
		});
		expect(
			(await execute('view_image', { path: path.join(second, 'image.png') })).content[0],
		).toMatchObject({ type: 'image' });
		expect((await execute('view_image', { path: path.join(global, 'image.png') })).isError).toBe(
			true,
		);
		await symlink(second, path.join(first, 'linked'));
		expect((await execute('view_image', { path: 'linked/image.png' })).isError).toBe(true);
	});
});
