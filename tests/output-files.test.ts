import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	mkdtemp,
	mkdir,
	readFile,
	realpath,
	rename,
	rm,
	symlink,
	unlink,
	writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OutputFileTracker } from '../electron/tools/output-files';
import { ToolRuntime } from '../electron/tools/runtime';
import { defaultToolSettings } from '../src/lib/tool-settings';
import { validOutputFileChanges, validToolRecords } from '../electron/agent-validation';
import type { ToolHostRequest, ToolSettings } from '../src/agent-types';

describe('bounded host output discovery', () => {
	let directory: string;
	let root: string;
	let runtime: ToolRuntime;
	let settings: ToolSettings;
	const trackers: OutputFileTracker[] = [];
	const track = async (
		roots = [root],
		options?: Parameters<typeof OutputFileTracker.create>[1],
	) => {
		const tracker = await OutputFileTracker.create(roots, options);
		trackers.push(tracker);
		return tracker;
	};
	const execute = (name: string, args: Record<string, unknown>) =>
		runtime.execute(
			{
				workspaceId: 'local',
				threadId: 'output-task',
				runId: 'output-run',
				name,
				arguments: args,
			} satisfies ToolHostRequest,
			settings,
			new AbortController().signal,
		);

	beforeEach(async () => {
		directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'freelm-outputs-')));
		root = path.join(directory, 'project');
		await mkdir(root);
		runtime = new ToolRuntime();
		settings = {
			...defaultToolSettings(),
			enabled: true,
			commandExecution: true,
			workspaceRoot: root,
		};
	});
	afterEach(async () => {
		for (const tracker of trackers.splice(0)) tracker.close();
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	});

	it('discovers actual files, leaves pre-existing files as updates, and excludes dependencies and symlink targets', async () => {
		await writeFile(path.join(root, 'existing.txt'), 'before');
		await mkdir(path.join(root, 'node_modules'));
		const outside = path.join(directory, 'outside');
		await mkdir(outside);
		await symlink(outside, path.join(root, 'linked'));
		const tracker = await track();
		await writeFile(path.join(root, 'existing.txt'), 'changed existing content');
		await mkdir(path.join(root, 'reports'));
		await writeFile(path.join(root, 'reports', 'new.txt'), 'new output');
		await writeFile(path.join(root, 'node_modules', 'ignored.js'), 'dependency');
		await writeFile(path.join(outside, 'ignored.txt'), 'outside symlink');
		const result = await tracker.collect(true);
		expect(result.outputFiles).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: 'update', path: path.join(root, 'existing.txt') }),
				expect.objectContaining({
					kind: 'add',
					path: path.join(root, 'reports', 'new.txt'),
					size: 10,
				}),
			]),
		);
		expect(result.outputFiles).toHaveLength(2);
		expect(result.outputTrackingNotices?.join(' ')).toContain('Dependency and cache');
		expect(result.outputTrackingNotices?.join(' ')).toContain('Symbolic links');
	});

	it('preserves identity when outputs are moved and reports later removal', async () => {
		const tracker = await track();
		const first = path.join(root, 'first.txt');
		const second = path.join(root, 'second.txt');
		await writeFile(first, 'artifact');
		expect((await tracker.collect(true)).outputFiles).toEqual([
			expect.objectContaining({ kind: 'add', path: first }),
		]);
		await rename(first, second);
		expect((await tracker.collect(true)).outputFiles).toEqual([
			expect.objectContaining({ kind: 'move', path: second, previousPath: first }),
		]);
		await unlink(second);
		expect((await tracker.collect(true)).outputFiles).toEqual([{ kind: 'delete', path: second }]);
	});

	it('does not invent additions or deletions when the inventory is incomplete', async () => {
		await Promise.all(
			['one', 'two', 'three'].map((name) => writeFile(path.join(root, name), name)),
		);
		const tracker = await track([root], { maxEntries: 2 });
		await unlink(path.join(root, 'one'));
		await writeFile(path.join(root, 'four'), 'four');
		const result = await tracker.collect(true);
		expect(result.outputFiles).toEqual([]);
		expect(result.outputTrackingNotices?.join(' ')).toContain('scan limit');
	});

	it('keeps prior outputs when an observed directory becomes unavailable', async () => {
		await writeFile(path.join(root, 'output.txt'), 'artifact');
		const tracker = await track();
		await rename(root, path.join(directory, 'temporarily-moved'));
		const result = await tracker.collect(true);
		expect(result.outputFiles).toEqual([]);
		expect(result.outputTrackingNotices?.join(' ')).toContain('not treated as deleted');
	});

	it('captures shell-created artifacts even when the command exits unsuccessfully', async () => {
		const result = await execute('exec_command', {
			cmd: 'printf artifact > output.txt; exit 7',
			yield_time_ms: 2000,
		});
		expect(result.isError).toBe(true);
		expect(await readFile(path.join(root, 'output.txt'), 'utf8')).toBe('artifact');
		expect(result.outputFiles).toEqual([
			expect.objectContaining({ kind: 'add', path: path.join(root, 'output.txt'), size: 8 }),
		]);
	});

	it('keeps discovery alive across process yields and stdin interaction', async () => {
		const started = await execute('exec_command', {
			cmd: 'read line; printf "%s" "$line" > delayed.txt',
			yield_time_ms: 0,
		});
		const sessionId = started.process!.sessionId;
		expect(started.process?.exitCode).toBeUndefined();
		expect(started.outputFiles).toEqual([]);
		const completed = await execute('write_stdin', {
			session_id: sessionId,
			chars: 'delayed artifact\n',
			yield_time_ms: 2000,
		});
		expect(completed.process?.exitCode).toBe(0);
		expect(completed.outputFiles).toEqual([
			expect.objectContaining({ kind: 'add', path: path.join(root, 'delayed.txt'), size: 16 }),
		]);
	});

	it('observes every assigned root and an explicit external workdir without scanning a default fallback', async () => {
		const second = path.join(directory, 'second-project');
		const third = path.join(directory, 'explicit-workdir');
		await mkdir(second);
		await mkdir(third);
		settings.workspaceRoots = [root, second];
		settings.workspacePathsUnrestricted = true;
		const result = await execute('exec_command', {
			cmd: `printf second > '${path.join(second, 'second.txt')}'; printf third > third.txt`,
			workdir: third,
			yield_time_ms: 2000,
		});
		expect(result.outputFiles?.map((event) => event.path).sort()).toEqual(
			[path.join(second, 'second.txt'), path.join(third, 'third.txt')].sort(),
		);
		settings.workspaceRoots = [];
		const unbound = await execute('exec_command', {
			cmd: 'printf fallback > fallback.txt',
			yield_time_ms: 2000,
		});
		expect(unbound.outputFiles).toEqual([]);
		expect(unbound.outputTrackingNotices?.join(' ')).toContain(
			'default home directory is not scanned',
		);
	});

	it('publishes canonical committed patch outputs but none for a rejected patch', async () => {
		const applied = await execute('apply_patch', {
			patch: '*** Begin Patch\n*** Add File: docs/output.txt\n+artifact\n*** End Patch',
		});
		expect(applied.fileChanges?.[0].path).toBe('docs/output.txt');
		expect(applied.outputFiles).toEqual([
			{ kind: 'add', path: path.join(root, 'docs', 'output.txt'), size: 9 },
		]);
		const failed = await execute('apply_patch', {
			patch: '*** Begin Patch\n*** Add File: docs/output.txt\n+replace existing\n*** End Patch',
		});
		expect(failed.isError).toBe(true);
		expect(failed.outputFiles).toBeUndefined();
	});
});

describe('output metadata validation', () => {
	it('bounds canonical metadata and rejects malformed or relative paths', () => {
		expect(
			validOutputFileChanges([
				{
					kind: 'move',
					path: '/project/new',
					previousPath: '/project/old',
					size: 5,
					modifiedAt: 1,
				},
			]),
		).toBe(true);
		for (const value of [
			[{ kind: 'add', path: 'relative.txt' }],
			[{ kind: 'add', path: '/project/file', size: -1 }],
			[{ kind: 'move', path: '/project/file' }],
			[{ kind: 'move', path: '/same', previousPath: '/same' }],
			Array.from({ length: 1001 }, () => ({ kind: 'add', path: '/project/file' })),
		])
			expect(validOutputFileChanges(value)).toBe(false);
		const call = {
			id: 'output-call',
			name: 'exec_command',
			arguments: '{}',
			startedAt: 1,
			status: 'completed',
			result: {
				content: [{ type: 'text', text: '' }],
				outputFiles: [{ kind: 'add', path: '/project/artifact' }],
				outputTrackingNotices: ['Partial inventory'],
			},
		};
		expect(validToolRecords([call])).toBe(true);
		expect(
			validToolRecords([{ ...call, result: { ...call.result, outputTrackingNotices: [42] } }]),
		).toBe(false);
	});
});
