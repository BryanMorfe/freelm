import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
	readTaskOutput,
	MAX_TASK_OUTPUT_BYTES,
	MAX_TASK_OUTPUT_PREVIEW_BYTES,
} from '../electron/task-output-reader';
import { collectTaskOutputs } from '../src/lib/task-outputs';
import type { Thread } from '../src/types';
import type { WorkspaceAuthority } from '../electron/workspace-authority';
import { initialState } from '../src/lib/state';
import { StateStore } from '../electron/state-store';
import { WorkspaceAuthority as Authority } from '../electron/workspace-authority';

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function temporary() {
	const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'freelm-task-output-read-')));
	directories.push(dir);
	return dir;
}
function thread(filename: string, name = 'apply_patch'): Thread {
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
				id: 'answer',
				role: 'assistant',
				content: 'Created a file.',
				createdAt: 1,
				toolCalls: [
					{
						id: 'create',
						name,
						arguments: '{}',
						status: 'completed',
						startedAt: 1,
						completedAt: 2,
						result: { content: [], outputFiles: [{ kind: 'add', path: filename }] },
					},
				],
			},
		],
	};
}
function source(task: Thread, roots: string[], root = roots[0]) {
	const authority: Pick<WorkspaceAuthority, 'loadTaskOutputState'> = {
		loadTaskOutputState: vi.fn(async (id) => {
			if (id !== task.id) throw new Error('Task not found');
			return { thread: task, workspaceRoot: root, workspaceRoots: roots };
		}),
	};
	const id = collectTaskOutputs(task, { workspaceRoot: root }).items[0]?.id;
	return { authority, id };
}

describe('user-selected task output reads', () => {
	it('reads exactly the selected task output and renders HTML as bounded plain text, never executable content', async () => {
		const root = await temporary();
		const filename = path.join(root, 'index.html');
		const body = '<script>fetch("https://example.test/private")</script>\n<h1>Output</h1>';
		await writeFile(filename, body);
		const { authority, id } = source(thread(filename), [root]);
		const result = await readTaskOutput(authority, 'task', id);
		expect(result).toMatchObject({
			id,
			name: 'index.html',
			path: filename,
			size: Buffer.byteLength(body),
			mimeType: 'text/plain',
			preview: { kind: 'text', text: body, truncated: false },
		});
		expect(result.downloadUrl).toBe(
			`data:application/octet-stream;base64,${Buffer.from(body).toString('base64')}`,
		);
		await expect(readTaskOutput(authority, 'other-task', id)).rejects.toThrow('Task not found');
		await expect(readTaskOutput(authority, 'task', 'local:task:fake:/etc/passwd')).rejects.toThrow(
			'not a recorded output',
		);
	});

	it('resolves only legacy patch paths within the primary configured root and follows confirmed output moves', async () => {
		const root = await temporary();
		await writeFile(path.join(root, 'old.txt'), 'original');
		const task = thread('unused');
		const call = task.messages[0].toolCalls![0];
		call.arguments = JSON.stringify({
			patch: '*** Begin Patch\n*** Add File: old.txt\n+original\n*** End Patch',
		});
		call.result = { content: [] };
		let data = source(task, [root]);
		expect((await readTaskOutput(data.authority, 'task', data.id)).preview).toMatchObject({
			text: 'original',
		});
		await writeFile(path.join(root, 'moved.txt'), 'updated');
		task.messages[0].toolCalls!.push({
			id: 'move',
			name: 'apply_patch',
			arguments: '{}',
			status: 'completed',
			startedAt: 3,
			completedAt: 4,
			result: {
				content: [],
				outputFiles: [
					{
						kind: 'move',
						path: path.join(root, 'moved.txt'),
						previousPath: path.join(root, 'old.txt'),
					},
				],
			},
		});
		data = source(task, [root]);
		expect((await readTaskOutput(data.authority, 'task', data.id)).preview).toMatchObject({
			text: 'updated',
		});
	});

	it('previews the same safe canonical file when task records use a configured root alias', async () => {
		const parent = await temporary();
		const root = path.join(parent, 'project');
		const alias = path.join(parent, 'project-alias');
		await mkdir(root);
		await symlink(root, alias);
		const filename = path.join(root, 'created.txt');
		await writeFile(filename, 'aliased output');
		for (const recorded of [filename, path.join(alias, 'created.txt')]) {
			const item = source(thread(recorded), [alias]);
			expect((await readTaskOutput(item.authority, 'task', item.id)).preview).toMatchObject({
				text: 'aliased output',
			});
		}
		if (process.platform === 'darwin') {
			const aliasRoot = await mkdtemp('/tmp/freelm-output-read-system-');
			const canonicalRoot = await realpath(aliasRoot);
			directories.push(canonicalRoot);
			await writeFile(path.join(canonicalRoot, 'created.txt'), 'system alias');
			const item = source(thread(path.join(aliasRoot, 'created.txt')), [canonicalRoot]);
			expect((await readTaskOutput(item.authority, 'task', item.id)).preview).toMatchObject({
				text: 'system alias',
			});
		}
	});

	it('allows a configured secondary project root but refuses editable metadata outside all roots', async () => {
		const root = await temporary();
		const secondary = await temporary();
		const outside = await temporary();
		for (const dir of [secondary, outside]) await writeFile(path.join(dir, 'created.txt'), 'data');
		const inside = source(thread(path.join(secondary, 'created.txt'), 'exec_command'), [
			root,
			secondary,
		]);
		expect((await readTaskOutput(inside.authority, 'task', inside.id)).preview).toMatchObject({
			text: 'data',
		});
		const escaped = source(thread(path.join(outside, 'created.txt'), 'exec_command'), [
			root,
			secondary,
		]);
		expect(await readTaskOutput(escaped.authority, 'task', escaped.id)).toMatchObject({
			unavailable: expect.stringContaining('outside'),
			path: path.join(outside, 'created.txt'),
		});
		const noRoot = source(thread(path.join(outside, 'created.txt')), []);
		expect(await readTaskOutput(noRoot.authority, 'task', noRoot.id)).toMatchObject({
			unavailable: expect.stringContaining('Bind this task'),
		});
	});

	it('rejects symlink files and ancestor directories, deleted files, directories and unsupported tool provenance', async () => {
		const root = await temporary();
		const outside = await temporary();
		await writeFile(path.join(outside, 'private.txt'), 'secret');
		await symlink(path.join(outside, 'private.txt'), path.join(root, 'link.txt'));
		await symlink(outside, path.join(root, 'linked-directory'));
		await mkdir(path.join(root, 'folder'));
		for (const filename of [
			path.join(root, 'link.txt'),
			path.join(root, 'linked-directory', 'private.txt'),
		]) {
			const item = source(thread(filename), [root]);
			const result = await readTaskOutput(item.authority, 'task', item.id);
			expect(result.unavailable).toContain('Symlink');
			expect(result.downloadUrl).toBeUndefined();
		}
		const missing = source(thread(path.join(root, 'deleted.txt')), [root]);
		expect((await readTaskOutput(missing.authority, 'task', missing.id)).unavailable).toContain(
			'no longer available',
		);
		const folder = source(thread(path.join(root, 'folder')), [root]);
		expect((await readTaskOutput(folder.authority, 'task', folder.id)).unavailable).toContain(
			'regular',
		);
		const unsupported = source(thread(path.join(outside, 'private.txt'), 'mcp.fake.apply_patch'), [
			root,
		]);
		await expect(readTaskOutput(unsupported.authority, 'task', 'forged')).rejects.toThrow(
			'not a recorded output',
		);
	});

	it('bounds text previews and total file reads while preserving safe image and binary downloads', async () => {
		const root = await temporary();
		const cases = [
			['long.txt', Buffer.alloc(MAX_TASK_OUTPUT_PREVIEW_BYTES + 8, 97)],
			['large.bin', Buffer.alloc(MAX_TASK_OUTPUT_BYTES + 1, 0)],
			['image.png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1])],
			['binary.bin', Buffer.from([0, 255, 1, 2])],
		] as const;
		const results = new Map();
		for (const [name, body] of cases) {
			const filename = path.join(root, name);
			await writeFile(filename, body);
			const item = source(thread(filename), [root]);
			results.set(name, await readTaskOutput(item.authority, 'task', item.id));
		}
		expect(results.get('long.txt').preview).toMatchObject({
			kind: 'text',
			truncated: true,
			text: 'a'.repeat(MAX_TASK_OUTPUT_PREVIEW_BYTES),
		});
		expect(results.get('large.bin')).toMatchObject({
			size: MAX_TASK_OUTPUT_BYTES + 1,
			unavailable: expect.stringContaining('8 MiB'),
		});
		expect(results.get('large.bin').downloadUrl).toBeUndefined();
		expect(results.get('image.png')).toMatchObject({
			mimeType: 'image/png',
			preview: { kind: 'image', dataUrl: expect.stringMatching(/^data:image\/png;base64,/) },
		});
		expect(results.get('binary.bin')).toMatchObject({
			mimeType: 'application/octet-stream',
			downloadUrl: 'data:application/octet-stream;base64,AP8BAg==',
		});
		expect(results.get('binary.bin').preview).toBeUndefined();
	});

	it('projects only the selected Code task and excludes API keys, unrelated history, galleries and stdout', async () => {
		const root = await temporary();
		const state = initialState();
		state.connections[0].apiKey = 'private-provider-key';
		state.projects = [
			{
				id: 'project',
				kind: 'code',
				directories: [root],
				name: 'Code',
				instructions: '',
				createdAt: 1,
			},
		];
		const selected = thread(path.join(root, 'created.txt'));
		selected.projectId = 'project';
		selected.messages[0].toolCalls![0].result!.content = [
			{ type: 'text', text: 'secret stdout' },
			{ type: 'image', dataUrl: 'data:image/png;base64,aGVsbG8=', name: 'hidden.png' },
		];
		state.threads = [
			selected,
			{
				...thread(path.join(root, 'other.txt')),
				id: 'unrelated-task',
				messages: [
					{ id: 'private', role: 'user', content: 'private unrelated conversation', createdAt: 1 },
				],
			},
			{ ...thread(path.join(root, 'chat.txt')), id: 'chat', kind: 'chat' },
		];
		state.generations = [
			{
				id: 'gallery',
				kind: 'images',
				prompt: 'private gallery',
				model: 'image',
				connectionId: state.connections[0].id,
				createdAt: 1,
				status: 'completed',
				assets: [],
			},
		];
		const store = new StateStore(path.join(root, 'workspace.json'), {
			available: () => false,
			encrypt: () => {
				throw new Error('disabled');
			},
			decrypt: () => {
				throw new Error('disabled');
			},
		});
		await store.save(state);
		const authority = new Authority(store);
		const context = await authority.loadTaskOutputState('task');
		const serialized = JSON.stringify(context);
		for (const value of [
			'private-provider-key',
			'private unrelated conversation',
			'private gallery',
			'secret stdout',
			'data:image/png',
		])
			expect(serialized).not.toContain(value);
		expect(context.workspaceRoots).toEqual([root]);
		expect(context.thread.messages[0].toolCalls![0].result!.outputFiles).toHaveLength(1);
		await expect(authority.loadTaskOutputState('chat')).rejects.toThrow('only in Code');
		await expect(authority.loadTaskOutputState('missing')).rejects.toThrow('may no longer exist');
	});
});
