import { afterEach, describe, expect, it } from 'vitest';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createProjectDirectory } from '../electron/project-directories';
import { suggestedProjectDirectoryName } from '../src/lib/project-directories';

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
	const root = await mkdtemp(path.join(tmpdir(), 'freelm-project-directory-'));
	roots.push(root);
	return { root, base: path.join(root, 'Documents', 'FreeLM') };
}

describe('automatic project directory names', () => {
	it('preserves meaningful Unicode and spaces while treating separators as text', () => {
		expect(suggestedProjectDirectoryName('  Café 工作 🚀  ')).toBe('Café 工作 🚀');
		expect(suggestedProjectDirectoryName('Design / prototypes\\drafts: v2')).toBe(
			'Design prototypes drafts v2',
		);
	});
	it('removes traversal edges and control characters and supplies a usable leaf', () => {
		expect(suggestedProjectDirectoryName('../../outside')).toBe('outside');
		expect(suggestedProjectDirectoryName('a\u0000b\n\u007fc')).toBe('a b c');
		for (const name of ['.', '..', '/', '\\', '...'])
			expect(suggestedProjectDirectoryName(name)).toBe('Untitled project');
	});
	it('limits UTF-8 bytes without cutting codepoints and reserves suffix space', () => {
		const result = suggestedProjectDirectoryName('工作🚀'.repeat(40));
		expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(120);
		expect(result).toBe('工作🚀'.repeat(12));
		expect(Buffer.byteLength(`${result} 1000`, 'utf8')).toBeLessThan(255);
		expect(suggestedProjectDirectoryName('name\ud800')).toBe('name\ufffd');
	});
});

describe('local project directory creation', () => {
	it('creates missing parent folders and an empty project directory', async () => {
		const { base } = await fixture();
		const directory = await createProjectDirectory('My project', base);
		expect(directory).toBe(path.join(base, 'My project'));
		expect((await lstat(directory)).isDirectory()).toBe(true);
		expect(await readdir(directory)).toEqual([]);
	});
	it('rejects malformed input before creating parent folders', async () => {
		const { root, base } = await fixture();
		for (const name of [null, undefined, 123, {}, [], '', ' \n ', 'a'.repeat(513)])
			await expect(createProjectDirectory(name, base)).rejects.toThrow('Enter a project name');
		expect(await readdir(root)).toEqual([]);
	});
	it('never reuses or overwrites existing files, folders or symlinks', async () => {
		const { root, base } = await fixture();
		await mkdir(path.join(base, 'Project'), { recursive: true });
		await writeFile(path.join(base, 'Project', 'keep.txt'), 'untouched');
		await writeFile(path.join(base, 'Project 2'), 'also untouched');
		await symlink(path.join(root, 'missing-target'), path.join(base, 'Project 3'));
		expect(await createProjectDirectory('Project', base)).toBe(path.join(base, 'Project 4'));
		expect(await readFile(path.join(base, 'Project', 'keep.txt'), 'utf8')).toBe('untouched');
		expect(await readFile(path.join(base, 'Project 2'), 'utf8')).toBe('also untouched');
		expect((await lstat(path.join(base, 'Project 3'))).isSymbolicLink()).toBe(true);
	});
	it('atomically assigns separate directories for concurrent project saves', async () => {
		const { base } = await fixture();
		const directories = await Promise.all(
			Array.from({ length: 8 }, () => createProjectDirectory('Concurrent', base)),
		);
		expect(new Set(directories).size).toBe(8);
		expect(directories.map((directory) => path.basename(directory)).sort()).toEqual([
			'Concurrent',
			'Concurrent 2',
			'Concurrent 3',
			'Concurrent 4',
			'Concurrent 5',
			'Concurrent 6',
			'Concurrent 7',
			'Concurrent 8',
		]);
	});
	it('keeps path-like titles inside the managed parent', async () => {
		const { base } = await fixture();
		for (const name of ['../../outside', '/absolute/path', '..\\..\\outside', '..']) {
			const directory = await createProjectDirectory(name, base);
			expect(path.dirname(directory)).toBe(base);
			expect((await lstat(directory)).isDirectory()).toBe(true);
		}
	});
	it('reports a usable error when the managed parent cannot be created', async () => {
		const { root } = await fixture();
		const base = path.join(root, 'blocked');
		await writeFile(base, 'preserve this file');
		await expect(createProjectDirectory('Project', base)).rejects.toThrow(
			'Check folder permissions or choose an existing directory',
		);
		expect(await readFile(base, 'utf8')).toBe('preserve this file');
	});
	it('bounds collision retries', async () => {
		const { base } = await fixture();
		await mkdir(base, { recursive: true });
		await Promise.all(
			Array.from({ length: 1000 }, (_, index) =>
				mkdir(path.join(base, index === 0 ? 'Project' : `Project ${index + 1}`)),
			),
		);
		await expect(createProjectDirectory('Project', base)).rejects.toThrow(
			'Too many project directories share this name',
		);
		expect((await readdir(base)).length).toBe(1000);
	});
});
