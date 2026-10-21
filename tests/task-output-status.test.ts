import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	link,
	lstat,
	mkdtemp,
	mkdir,
	open,
	realpath,
	rename,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { taskOutputStatus } from '../electron/task-output-reader';
import type { Thread } from '../src/types';
import type { WorkspaceAuthority } from '../electron/workspace-authority';

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>();
	return { ...actual, open: vi.fn(actual.open), lstat: vi.fn(actual.lstat) };
});

const directories: string[] = [];
beforeEach(() => vi.clearAllMocks());
afterEach(async () => {
	vi.mocked(lstat).mockReset();
	vi.mocked(lstat).mockImplementation(
		(await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).lstat,
	);
	await Promise.all(
		directories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});
async function directory() {
	const root = await realpath(await mkdtemp(path.join(tmpdir(), 'freelm-output-status-')));
	directories.push(root);
	return root;
}
function task(paths: string[]): Thread {
	return {
		id: 'task',
		kind: 'code',
		title: 'Task',
		connectionId: 'provider',
		model: 'test',
		createdAt: 1,
		updatedAt: 2,
		messages: [
			{
				id: 'reply',
				role: 'assistant',
				content: 'Created files.',
				createdAt: 1,
				toolCalls: [
					{
						id: 'create',
						name: 'exec_command',
						arguments: '{}',
						status: 'completed',
						startedAt: 1,
						completedAt: 2,
						result: {
							content: [],
							outputFiles: paths.map((filename) => ({ kind: 'add', path: filename })),
						},
					},
				],
			},
		],
	};
}
function source(thread: Thread, roots: string[]): Pick<WorkspaceAuthority, 'loadTaskOutputState'> {
	return {
		loadTaskOutputState: vi.fn(async (id) => {
			if (id !== thread.id) throw new Error('Task not found');
			return { thread, workspaceRoot: roots[0], workspaceRoots: roots };
		}),
	};
}

describe('task output existence and physical identity', () => {
	it('checks only recorded metadata, removes missing files, and never opens file contents', async () => {
		const root = await directory();
		const present = path.join(root, 'present.txt');
		const removed = path.join(root, 'removed.txt');
		await writeFile(present, 'private file contents must never be returned');
		await writeFile(removed, 'deleted');
		const authority = source(task([present, removed]), [root]);
		let status = await taskOutputStatus(authority, 'task');
		expect(status.files.every((file) => file.exists)).toBe(true);
		await rm(removed);
		status = await taskOutputStatus(authority, 'task');
		expect(status.files.map((file) => file.exists)).toEqual([true, false]);
		expect(status.files[0]).toMatchObject({
			canonicalPath: present,
			identity: expect.stringMatching(/^(?:inode:|path:)/),
		});
		expect(status.files[1]).not.toHaveProperty('identity');
		expect(status.notices).toEqual([]);
		expect(JSON.stringify(status)).not.toContain('private file contents');
		expect(open).not.toHaveBeenCalled();
	});

	it('matches configured-root aliases and hardlinks while preserving distinct same-name files', async () => {
		const parent = await directory();
		const root = path.join(parent, 'project');
		const alias = path.join(parent, 'configured-project');
		await mkdir(root);
		await symlink(root, alias);
		await mkdir(path.join(root, 'a'));
		await mkdir(path.join(root, 'b'));
		const original = path.join(root, 'a', 'route.ts');
		const other = path.join(root, 'b', 'route.ts');
		const hardlink = path.join(root, 'same-file.ts');
		await writeFile(original, 'a');
		await writeFile(other, 'b');
		await link(original, hardlink);
		const status = await taskOutputStatus(
			source(task([path.join(alias, 'a', 'route.ts'), original, hardlink, other]), [alias]),
			'task',
		);
		expect(status.files).toHaveLength(4);
		expect(status.files.every((file) => file.exists)).toBe(true);
		expect(status.files[0].canonicalPath).toBe(original);
		expect(status.files[0].identity).toBe(status.files[1].identity);
		expect(status.files[0].identity).toBe(status.files[2].identity);
		expect(status.files[3].identity).not.toBe(status.files[0].identity);
	});

	it('accepts macOS system root spellings only as the same verified configured scope', async () => {
		if (process.platform !== 'darwin') return;
		const aliasRoot = await mkdtemp('/tmp/freelm-output-status-system-');
		const canonicalRoot = await realpath(aliasRoot);
		directories.push(canonicalRoot);
		const canonicalFile = path.join(canonicalRoot, 'created.txt');
		await writeFile(canonicalFile, 'output');
		const status = await taskOutputStatus(
			source(task([path.join(aliasRoot, 'created.txt'), canonicalFile]), [canonicalRoot]),
			'task',
		);
		expect(status.files.every((file) => file.exists)).toBe(true);
		expect(status.files[0].canonicalPath).toBe(canonicalFile);
		expect(status.files[0].identity).toBe(status.files[1].identity);
	});

	it('uses confirmed moves and sees externally removed files without inventing new outputs', async () => {
		const root = await directory();
		const old = path.join(root, 'old.txt');
		const moved = path.join(root, 'moved.txt');
		await writeFile(old, 'output');
		const thread = task([old]);
		await rename(old, moved);
		thread.messages[0].toolCalls!.push({
			id: 'move',
			name: 'apply_patch',
			arguments: '{}',
			status: 'completed',
			startedAt: 3,
			completedAt: 4,
			result: { content: [], outputFiles: [{ kind: 'move', path: moved, previousPath: old }] },
		});
		const authority = source(thread, [root]);
		let status = await taskOutputStatus(authority, 'task');
		expect(status.files).toHaveLength(1);
		expect(status.files[0]).toMatchObject({ exists: true, canonicalPath: moved });
		await rm(moved);
		status = await taskOutputStatus(authority, 'task');
		expect(status.files[0].exists).toBe(false);
	});

	it('excludes outside-root paths, symlink escapes, nonregular files and unsupported provenance', async () => {
		const root = await directory();
		const outside = await directory();
		const privateFile = path.join(outside, 'private.txt');
		await writeFile(privateFile, 'secret');
		await symlink(outside, path.join(root, 'escape'));
		await symlink(privateFile, path.join(root, 'linked.txt'));
		await mkdir(path.join(root, 'folder'));
		const thread = task([
			privateFile,
			path.join(root, 'escape', 'private.txt'),
			path.join(root, 'linked.txt'),
			path.join(root, 'folder'),
		]);
		thread.messages[0].toolCalls!.push({
			...thread.messages[0].toolCalls![0],
			id: 'forged',
			name: 'mcp.fake.exec_command',
			result: { content: [], outputFiles: [{ kind: 'add', path: path.join(root, 'forged.txt') }] },
		});
		const status = await taskOutputStatus(source(thread, [root]), 'task');
		expect(status.files).toHaveLength(4);
		expect(
			status.files.every((file) => !file.exists && !file.canonicalPath && !file.identity),
		).toBe(true);
		expect(status.notices.join(' ')).toMatch(/outside.*Symlink.*regular/);
		expect(JSON.stringify(status)).not.toContain('secret');
		const queried = vi.mocked(lstat).mock.calls.map(([filename]) => String(filename));
		expect(queried).not.toContain(privateFile);
	});

	it('reports unavailable permissions and roots rather than treating a failed check as existence', async () => {
		const root = await directory();
		const filename = path.join(root, 'created.txt');
		await writeFile(filename, 'file');
		const actual = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises'))
			.lstat;
		vi.mocked(lstat).mockImplementation((async (name: Parameters<typeof lstat>[0]) => {
			if (String(name) === filename) throw Object.assign(new Error('denied'), { code: 'EACCES' });
			return actual(name);
		}) as typeof lstat);
		const status = await taskOutputStatus(source(task([filename]), [root]), 'task');
		expect(status.files[0]).toMatchObject({
			exists: false,
			unavailable: expect.stringContaining('permissions'),
		});
		expect(status.notices.join(' ')).toContain('permissions');
		const unbound = await taskOutputStatus(source(task([filename]), []), 'task');
		expect(unbound.files[0].exists).toBe(false);
		expect(unbound.notices.join(' ')).toContain('Bind this task');
		await expect(taskOutputStatus(source(task([filename]), [root]), 'other')).rejects.toThrow(
			'Task not found',
		);
		await expect(taskOutputStatus(source(task([filename]), [root]), 'bad\n')).rejects.toThrow(
			'Invalid',
		);
	});

	it('bounds candidate checks and reports a truncated task instead of scanning unrelated directories', async () => {
		const root = await directory();
		const thread = task([]);
		thread.messages[0].toolCalls = Array.from({ length: 3 }, (_item, batch) => ({
			id: `create-${batch}`,
			name: 'exec_command',
			arguments: '{}',
			status: 'completed',
			startedAt: batch + 1,
			completedAt: batch + 2,
			result: {
				content: [],
				outputFiles: Array.from({ length: 512 }, (_change, index) => ({
					kind: 'add',
					path: path.join(root, `created-${batch}-${index}.txt`),
				})),
			},
		}));
		const status = await taskOutputStatus(source(thread, [root]), 'task');
		expect(status.files).toHaveLength(1_024);
		expect(status.files.every((file) => !file.exists)).toBe(true);
		expect(status.truncated).toBe(true);
		expect(status.notices.join(' ')).toContain('metadata limits');
		expect(vi.mocked(lstat).mock.calls.length).toBeLessThanOrEqual(1 + 2 * 1_024);
		expect(open).not.toHaveBeenCalled();
	});
});
