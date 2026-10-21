import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
	CodeSurfaceService,
	CODE_SURFACE_TEXT_BYTES,
	CODE_SURFACE_READ_BYTES,
	validateCodeSurfaceRequest,
	validCodeSurfaceResult,
} from '../electron/code-surface';
import type { ComposerHostScope } from '../electron/composer-context';
import type { CodeSurfaceRequest } from '../src/code-surface-types';

const exec = promisify(execFile);
const cleanup: string[] = [];
afterEach(async () => {
	for (const root of cleanup.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
	const root = await realpath(await mkdtemp(path.join(tmpdir(), 'freelm-code-surface-')));
	cleanup.push(root);
	const scope: ComposerHostScope = {
		kind: 'code',
		projectId: 'project',
		roots: [root],
		skillDirectories: [],
		allowRemote: true,
	};
	const service = new CodeSurfaceService(async () => structuredClone(scope));
	const request = (
		action: CodeSurfaceRequest['action'],
		extra: Partial<CodeSurfaceRequest> = {},
	) => ({ workspaceId: 'local', threadId: 'task', action, ...extra });
	const git = (...args: string[]) =>
		exec('git', args, {
			cwd: root,
			env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
		});
	return { root, scope, service, request, git };
}

describe('Code workspace surface', () => {
	it('lists host roots and their direct children, including hidden files, without following symlinks', async () => {
		const { root, service, request } = await fixture();
		await mkdir(path.join(root, 'folder'));
		await writeFile(path.join(root, 'hello.ts'), 'export const hello = 1;');
		await writeFile(path.join(root, '.env.example'), 'KEY=');
		await symlink(path.join(root, 'hello.ts'), path.join(root, 'alias.ts'));
		expect(await service.execute(request('list'))).toMatchObject({
			kind: 'list',
			entries: [{ name: path.basename(root), path: root, kind: 'directory' }],
		});
		const listing = await service.execute(request('list', { path: root }));
		expect(listing.kind).toBe('list');
		if (listing.kind !== 'list') return;
		expect(listing.entries.map((item) => item.name)).toEqual([
			'folder',
			'.env.example',
			'hello.ts',
		]);
		expect(validCodeSurfaceResult(listing, request('list'))).toBe(true);
	});
	it('supports trusted configured aliases but rejects outside paths and nested symlinks', async () => {
		const { root, scope, service, request } = await fixture();
		const other = await fixture();
		await writeFile(path.join(other.root, 'private.txt'), 'private');
		await symlink(other.root, path.join(root, 'escape'));
		await expect(
			service.execute(request('read', { path: path.join(root, 'escape/private.txt') })),
		).rejects.toThrow('Symlink');
		await expect(
			service.execute(request('read', { path: path.join(other.root, 'private.txt') })),
		).rejects.toThrow('outside');
		const alias = path.join(other.root, 'bound-root');
		await symlink(root, alias);
		scope.roots = [alias];
		await writeFile(path.join(root, 'safe.txt'), 'safe');
		expect(
			await service.execute(request('read', { path: path.join(alias, 'safe.txt') })),
		).toMatchObject({ path: path.join(root, 'safe.txt'), content: 'safe' });
	});
	it('requires Code and host remote authorization and rechecks scope during an operation', async () => {
		const { scope, service, request } = await fixture();
		scope.kind = 'chat';
		await expect(service.execute(request('list'))).rejects.toThrow('only in Code');
		scope.kind = 'code';
		scope.allowRemote = false;
		await expect(service.execute(request('list'), true)).rejects.toThrow('Enable remote Code');
		let reads = 0;
		const changed = new CodeSurfaceService(async () => ({
			...scope,
			projectId: ++reads === 1 ? 'a' : 'b',
		}));
		await expect(changed.execute(request('list'))).rejects.toThrow('workspace changed');
	});
	it('saves UTF-8 files atomically, preserves mode, and rejects stale or concurrent revisions', async () => {
		const { root, service, request } = await fixture();
		const filename = path.join(root, 'script.sh');
		await writeFile(filename, '#!/bin/sh\necho old\n');
		await chmod(filename, 0o750);
		const original = await service.execute(request('read', { path: filename }));
		if (original.kind !== 'file') throw new Error();
		const saved = await service.execute(
			request('write', {
				path: filename,
				content: '#!/bin/sh\necho new\n',
				revision: original.revision,
			}),
		);
		expect(saved.kind).toBe('saved');
		expect(await readFile(filename, 'utf8')).toContain('echo new');
		expect((await lstat(filename)).mode & 0o777).toBe(0o750);
		await expect(
			service.execute(
				request('write', { path: filename, content: 'old overwrite', revision: original.revision }),
			),
		).rejects.toThrow('FILE_CONFLICT');
		if (saved.kind !== 'saved') throw new Error();
		const writes = await Promise.allSettled(
			['one', 'two'].map((content) =>
				service.execute(request('write', { path: filename, content, revision: saved.revision })),
			),
		);
		expect(writes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		expect(writes.filter((result) => result.status === 'rejected')).toHaveLength(1);
		expect((await readdir(root)).some((name) => name.startsWith('.freelm-save-'))).toBe(false);
	});
	it('keeps script and HTML content inert, rejects binary edits, and bounds file previews', async () => {
		const { root, service, request } = await fixture();
		const html = path.join(root, 'index.html');
		await writeFile(html, '<script>window.secret()</script>');
		expect(await service.execute(request('read', { path: html }))).toMatchObject({
			editable: true,
			content: '<script>window.secret()</script>',
		});
		const binary = path.join(root, 'binary');
		await writeFile(binary, Buffer.from([0, 1, 2]));
		const read = await service.execute(request('read', { path: binary }));
		expect(read).toMatchObject({ editable: false, unavailable: expect.stringContaining('binary') });
		if (read.kind !== 'file') throw new Error();
		await expect(
			service.execute(
				request('write', { path: binary, content: 'replace', revision: read.revision }),
			),
		).rejects.toThrow('Binary');
		const huge = path.join(root, 'large.txt');
		await writeFile(huge, 'a'.repeat(CODE_SURFACE_TEXT_BYTES + 1));
		const truncated = await service.execute(request('read', { path: huge }));
		expect(truncated).toMatchObject({ editable: false, truncated: true });
		if (truncated.kind !== 'file') throw new Error();
		expect(truncated.content?.length).toBe(256 * 1024);
		await writeFile(huge, Buffer.alloc(CODE_SURFACE_READ_BYTES + 1));
		expect(await service.execute(request('read', { path: huge }))).toMatchObject({
			unavailable: expect.stringContaining('8 MiB'),
		});
	});
	it('returns only safe image data URLs and rejects remote URL payloads', async () => {
		const { root, service, request } = await fixture();
		const image = path.join(root, 'tiny.png');
		await writeFile(
			image,
			Buffer.from(
				'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=',
				'base64',
			),
		);
		const result = await service.execute(request('read', { path: image }));
		expect(result).toMatchObject({ editable: false, image: { mimeType: 'image/png' } });
		expect(validCodeSurfaceResult(result, request('read', { path: image }))).toBe(true);
		expect(
			validCodeSurfaceResult(
				{ ...result, image: { mimeType: 'image/png', dataUrl: 'https://tracker.example/pixel' } },
				request('read', { path: image }),
			),
		).toBe(false);
	});
	it('bounds directory listings and validates request size and paths', async () => {
		const { root, service, request } = await fixture();
		await Promise.all(
			Array.from({ length: 520 }, (_, i) => writeFile(path.join(root, `file-${i}`), '')),
		);
		const result = await service.execute(request('list', { path: root }));
		if (result.kind !== 'list') throw new Error();
		expect(result.entries).toHaveLength(512);
		expect(result.truncated).toBe(true);
		expect(() => validateCodeSurfaceRequest(request('read', { path: '../outside' }))).toThrow();
		expect(() =>
			validateCodeSurfaceRequest(
				request('write', {
					path: path.join(root, 'x'),
					content: 'a'.repeat(CODE_SURFACE_TEXT_BYTES + 1),
					revision: 'a'.repeat(64),
				}),
			),
		).toThrow();
		expect(() => validateCodeSurfaceRequest({ ...request('list'), roots: ['/'] })).toThrow();
	});
	it('reviews unstaged, staged and total changes without changing the index', async () => {
		const { root, service, request, git } = await fixture();
		await git('init', '-q');
		await git('config', 'user.email', 'test@example.test');
		await git('config', 'user.name', 'Test');
		await writeFile(path.join(root, 'test.txt'), 'original\n');
		await git('add', '.');
		await git('commit', '-qm', 'initial');
		await writeFile(path.join(root, 'test.txt'), 'staged\n');
		await git('add', '.');
		await writeFile(path.join(root, 'test.txt'), 'working\n');
		const before = await readFile(path.join(root, '.git/index'));
		for (const [review, expected, absent] of [
			['staged', '+staged', '+working'],
			['unstaged', '+working', '-original'],
			['uncommitted', '+working', '+staged'],
		] as const) {
			const result = await service.execute(request('diff', { path: root, review }));
			if (result.kind !== 'diff') throw new Error();
			expect(result.diff).toContain(expected);
			expect(result.diff).not.toContain(absent);
			expect(validCodeSurfaceResult(result, request('diff', { review }))).toBe(true);
		}
		expect(await readFile(path.join(root, '.git/index'))).toEqual(before);
	});
	it('restricts Git review to the authorized subdirectory and surfaces missing repository errors', async () => {
		const { root, scope, service, request, git } = await fixture();
		await expect(service.execute(request('diff', { path: root }))).rejects.toThrow(
			'not a git repository',
		);
		await git('init', '-q');
		await git('config', 'user.email', 'test@example.test');
		await git('config', 'user.name', 'Test');
		await mkdir(path.join(root, 'allowed'));
		await writeFile(path.join(root, 'allowed/safe.txt'), 'safe\n');
		await writeFile(path.join(root, 'secret.txt'), 'secret\n');
		await git('add', '.');
		await git('commit', '-qm', 'initial');
		await writeFile(path.join(root, 'allowed/safe.txt'), 'changed\n');
		await writeFile(path.join(root, 'secret.txt'), 'sensitive change\n');
		scope.roots = [path.join(root, 'allowed')];
		const result = await service.execute(request('diff'));
		if (result.kind !== 'diff') throw new Error();
		expect(result.diff).toContain('changed');
		expect(result.diff).not.toContain('secret');
	});
	it('does not run repository-configured filters during read-only Git review', async () => {
		const { root, service, request, git } = await fixture();
		await git('init', '-q');
		await git('config', 'user.email', 'test@example.test');
		await git('config', 'user.name', 'Test');
		await writeFile(path.join(root, 'test.txt'), 'original\n');
		await git('add', '.');
		await git('commit', '-qm', 'initial');
		await writeFile(path.join(root, '.gitattributes'), '*.txt filter=unsafe');
		await git('config', 'filter.unsafe.clean', 'touch filter-executed; cat');
		await writeFile(path.join(root, 'test.txt'), 'working\n');
		await service.execute(request('diff', { path: root }));
		expect(await readdir(root)).not.toContain('filter-executed');
	});
	it('rejects a repository whose configured working tree is outside the authorized directory', async () => {
		const { root, service, request, git } = await fixture();
		const outside = await fixture();
		await git('init', '-q');
		await git('config', 'user.email', 'test@example.test');
		await git('config', 'user.name', 'Test');
		await writeFile(path.join(root, 'test.txt'), 'original\n');
		await git('add', '.');
		await git('commit', '-qm', 'initial');
		await writeFile(path.join(outside.root, 'test.txt'), 'outside private content\n');
		await git('config', 'core.worktree', outside.root);
		for (const review of ['uncommitted', 'unstaged', 'staged'] as const) {
			await expect(service.execute(request('diff', { path: root, review }))).rejects.toThrow(
				'Git points outside the selected Code workspace directory',
			);
		}
	});
	it('includes untracked text and binary files while excluding ignored files and symlink targets', async () => {
		const { root, service, request, git } = await fixture();
		const outside = await fixture();
		await git('init', '-q');
		await git('config', 'user.email', 'test@example.test');
		await git('config', 'user.name', 'Test');
		await writeFile(path.join(root, '.gitignore'), 'ignored.txt\n');
		await git('add', '.');
		await git('commit', '-qm', 'initial');
		await writeFile(path.join(root, 'new file.txt'), 'first\nlast');
		await writeFile(path.join(root, 'binary.png'), Buffer.from([0, 1, 2]));
		await writeFile(path.join(root, 'ignored.txt'), 'ignored private value');
		await writeFile(path.join(outside.root, 'secret.txt'), 'outside secret');
		await symlink(path.join(outside.root, 'secret.txt'), path.join(root, 'link.txt'));
		for (const review of ['uncommitted', 'unstaged'] as const) {
			const result = await service.execute(request('diff', { path: root, review }));
			if (result.kind !== 'diff') throw new Error();
			expect(result.diff).toContain('+first\n+last\n\\ No newline at end of file');
			expect(result.diff).toContain('Binary files /dev/null and b/binary.png differ');
			expect(result.diff).not.toContain('ignored private value');
			expect(result.diff).not.toContain('outside secret');
			expect(result.notices.join(' ')).toContain('Symlink');
		}
		const staged = await service.execute(request('diff', { path: root, review: 'staged' }));
		expect(staged).toMatchObject({ diff: '' });
	});
	it('shows current additions before the first commit and uses the nearest nested repository', async () => {
		const { root, service, request, git } = await fixture();
		await git('init', '-q');
		await writeFile(path.join(root, 'first.txt'), 'staged\n');
		await git('add', '.');
		await writeFile(path.join(root, 'first.txt'), 'working\n');
		await writeFile(path.join(root, 'new.txt'), 'new\n');
		const unborn = await service.execute(request('diff', { path: root }));
		if (unborn.kind !== 'diff') throw new Error();
		expect(unborn.diff).toContain('+working');
		expect(unborn.diff).toContain('+new');
		expect(unborn.diff).not.toContain('+staged');
		await mkdir(path.join(root, 'nested'));
		await exec('git', ['init', '-q'], { cwd: path.join(root, 'nested') });
		await writeFile(path.join(root, 'nested/nested.txt'), 'nested change');
		const nested = await service.execute(request('diff', { path: path.join(root, 'nested') }));
		if (nested.kind !== 'diff') throw new Error();
		expect(nested.diff).toContain('b/nested.txt');
		expect(nested.diff).not.toContain('first.txt');
	});
});
