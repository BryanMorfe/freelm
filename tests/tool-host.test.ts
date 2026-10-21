import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ToolHostRequest, ToolResult, ToolSettings } from '../src/agent-types';
import { defaultToolSettings } from '../src/lib/tool-settings';
import { ToolRuntime } from '../electron/tools/runtime';

function text(result: ToolResult): string {
	return result.content
		.filter((item) => item.type === 'text')
		.map((item) => item.text)
		.join('\n');
}

describe('host code and skill tools', () => {
	let directory: string;
	let root: string;
	let runtime: ToolRuntime;
	let settings: ToolSettings;
	const request = (
		name: string,
		args: Record<string, unknown>,
		overrides: Partial<ToolHostRequest> = {},
	): ToolHostRequest => ({
		workspaceId: 'local',
		threadId: 'thread-one',
		runId: 'run-one',
		name,
		arguments: args,
		...overrides,
	});
	const execute = (
		name: string,
		args: Record<string, unknown>,
		overrides: Partial<ToolHostRequest> = {},
	) => runtime.execute(request(name, args, overrides), settings, new AbortController().signal);

	beforeEach(async () => {
		directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'freelm-tool-host-')));
		root = path.join(directory, 'workspace');
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
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	});

	it('runs bounded shell output and exposes nonzero exit status', async () => {
		const result = await execute('exec_command', {
			cmd: "printf 'hello from fixture'; exit 7",
			yield_time_ms: 2000,
		});
		expect(result.isError).toBe(true);
		expect(JSON.parse(text(result))).toMatchObject({ output: 'hello from fixture', exit_code: 7 });
		expect(result.process).toEqual({
			command: "printf 'hello from fixture'; exit 7",
			sessionId: expect.any(String),
			exitCode: 7,
		});
		const bounded = await execute('exec_command', {
			cmd: `"${process.execPath}" -e 'process.stdout.write("x".repeat(200000))'`,
			max_output_tokens: 100,
			yield_time_ms: 2000,
		});
		expect(text(bounded)).toContain('omitted');
		expect(text(bounded).length).toBeLessThan(600);
	});

	it('supports stdin across yields and rejects another run using that session', async () => {
		const started = await execute('exec_command', {
			cmd: 'read line; printf "received:%s" "$line"',
			yield_time_ms: 0,
		});
		const id = JSON.parse(text(started)).session_id;
		expect(typeof id).toBe('string');
		expect(started.process).toEqual({
			command: 'read line; printf "received:%s" "$line"',
			sessionId: id,
		});
		const polled = await execute('write_stdin', { session_id: id, yield_time_ms: 0 });
		expect(polled.process).toEqual(started.process);
		expect(JSON.parse(text(polled))).toEqual({ output: '', session_id: id });
		const foreign = await execute(
			'write_stdin',
			{ session_id: id, chars: 'foreign\n' },
			{ runId: 'other-run' },
		);
		expect(foreign.isError).toBe(true);
		expect(text(foreign)).toContain('does not belong');
		expect(foreign.process).toBeUndefined();
		const completed = await execute('write_stdin', {
			session_id: id,
			chars: 'fixture\n',
			yield_time_ms: 2000,
		});
		expect(JSON.parse(text(completed))).toMatchObject({ output: 'received:fixture', exit_code: 0 });
		expect(completed.process).toEqual({ ...started.process, exitCode: 0 });
		expect(Object.keys(JSON.parse(text(completed))).sort()).toEqual([
			'exit_code',
			'output',
			'signal',
		]);
	});

	it('cancels commands, blocks unavailable tools, and does not claim PTY support', async () => {
		const started = await execute('exec_command', { cmd: 'sleep 30', yield_time_ms: 0 });
		const id = JSON.parse(text(started)).session_id;
		runtime.cancel('run-one');
		expect((await execute('write_stdin', { session_id: id })).isError).toBe(true);
		expect(text(await execute('exec_command', { cmd: 'true', tty: true }))).toContain(
			'PTY mode is not available',
		);
		settings.commandExecution = false;
		expect((await execute('exec_command', { cmd: 'true' })).isError).toBe(true);
		expect(
			(await runtime.catalog(settings)).tools.some((tool) => tool.name === 'apply_patch'),
		).toBe(false);
		settings.enabled = false;
		expect(text(await execute('view_image', { path: 'any.png' }))).toContain('disabled');
	});

	it('rejects outside cwd and symlink traversal', async () => {
		await symlink(directory, path.join(root, 'escape'));
		for (const workdir of ['..', 'escape']) {
			const result = await execute('exec_command', { cmd: 'true', workdir });
			expect(result.isError).toBe(true);
		}
	});

	it('terminates redirected background children when their shell closes', async () => {
		const result = await execute('exec_command', {
			cmd: 'sleep 30 </dev/null >/dev/null 2>&1 & printf "%s" "$!"',
			shell: '/bin/bash',
			yield_time_ms: 2000,
		});
		const pid = Number(JSON.parse(text(result)).output);
		expect(pid).toBeGreaterThan(0);
		await expect
			.poll(
				() => {
					try {
						process.kill(pid, 0);
						return true;
					} catch {
						return false;
					}
				},
				{ timeout: 2000 },
			)
			.toBe(false);
	});

	it('applies add/update/move/delete hunks together', async () => {
		await writeFile(path.join(root, 'old.txt'), 'first\nsecond\nlast\n');
		await writeFile(path.join(root, 'remove.txt'), 'obsolete');
		const result = await execute('apply_patch', {
			patch: [
				'*** Begin Patch',
				'*** Add File: sub/new.txt',
				'+new line',
				'*** Update File: old.txt',
				'*** Move to: renamed.txt',
				'@@',
				' first',
				'-second',
				'+changed',
				' last',
				'*** End of File',
				'*** Delete File: remove.txt',
				'*** End Patch',
			].join('\n'),
		});
		expect(result.isError).toBeUndefined();
		expect(result.fileChanges).toEqual([
			{ kind: 'add', path: 'sub/new.txt', addedLines: 1, removedLines: 0 },
			{
				kind: 'move',
				path: 'renamed.txt',
				previousPath: 'old.txt',
				addedLines: 1,
				removedLines: 1,
			},
			{ kind: 'delete', path: 'remove.txt', addedLines: 0, removedLines: 1 },
		]);
		expect(await readFile(path.join(root, 'renamed.txt'), 'utf8')).toBe('first\nchanged\nlast\n');
		expect(await readFile(path.join(root, 'sub/new.txt'), 'utf8')).toBe('new line\n');
		await expect(readFile(path.join(root, 'old.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
		await expect(readFile(path.join(root, 'remove.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('validates every patch before writing and rejects absolute or symlink escapes', async () => {
		await writeFile(path.join(root, 'source.txt'), 'unchanged\n');
		const failed = await execute('apply_patch', {
			patch:
				'*** Begin Patch\n*** Add File: would-create.txt\n+hello\n*** Update File: source.txt\n@@\n-mismatch\n+changed\n*** End Patch',
		});
		expect(failed.isError).toBe(true);
		expect(failed.fileChanges).toBeUndefined();
		await expect(readFile(path.join(root, 'would-create.txt'))).rejects.toMatchObject({
			code: 'ENOENT',
		});
		expect(await readFile(path.join(root, 'source.txt'), 'utf8')).toBe('unchanged\n');
		await symlink(directory, path.join(root, 'escape'));
		for (const target of [
			'../outside.txt',
			path.join(directory, 'absolute.txt'),
			'escape/target.txt',
		]) {
			const result = await execute('apply_patch', {
				patch: `*** Begin Patch\n*** Add File: ${target}\n+no\n*** End Patch`,
			});
			expect(result.isError).toBe(true);
		}
	});

	it('returns local images as media, validates content, and confines reads', async () => {
		const png = Buffer.from(
			'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6XcAAAAASUVORK5CYII=',
			'base64',
		);
		await writeFile(path.join(root, 'pixel.bin'), png);
		expect((await execute('view_image', { path: 'pixel.bin' })).content[0]).toMatchObject({
			type: 'image',
			dataUrl: `data:image/png;base64,${png.toString('base64')}`,
		});
		await writeFile(path.join(root, 'fake.png'), '<svg>not a bitmap</svg>');
		expect((await execute('view_image', { path: 'fake.png' })).isError).toBe(true);
		await symlink(path.join(root, 'pixel.bin'), path.join(root, 'link.png'));
		expect((await execute('view_image', { path: 'link.png' })).isError).toBe(true);
		expect((await execute('view_image', { path: '../outside.png' })).isError).toBe(true);
	});

	it('discovers only configured skills and loads relative resources progressively', async () => {
		const skills = path.join(directory, 'skills');
		const skill = path.join(skills, 'fixture-skill');
		await mkdir(path.join(skill, 'references'), { recursive: true });
		await writeFile(
			path.join(skill, 'SKILL.md'),
			'---\nname: fixture\ndescription: A fixture for host tests\n---\nRead references/example.md.\n',
		);
		await writeFile(path.join(skill, 'references/example.md'), 'line one\nline two\nline three');
		settings.skillDirectories = [skills];
		settings.enabled = false;
		const catalog = await runtime.catalog(settings);
		expect(catalog.skills).toEqual([
			{
				id: expect.stringMatching(/^[a-f0-9]{16}$/),
				name: 'fixture',
				description: 'A fixture for host tests',
				path: path.join(skill, 'SKILL.md'),
			},
		]);
		expect(catalog.instructions).toContain('metadata only');
		expect(catalog.instructions).not.toContain('Read references/example.md');
		settings.enabled = true;
		const listed = JSON.parse(text(await execute('skills.list', {})));
		expect(listed[0].id).toBe(catalog.skills![0].id);
		expect(listed).toHaveLength(1);
		const loaded = JSON.parse(text(await execute('skills.read', { skill: listed[0].id })));
		expect(loaded.content).toContain('Read references/example.md');
		const reference = JSON.parse(
			text(
				await execute('skills.read', {
					skill: 'fixture',
					path: 'references/example.md',
					start_line: 2,
					line_count: 1,
				}),
			),
		);
		expect(reference.content).toBe('line two');
		expect(reference.truncated).toBe(true);
		expect(
			(await execute('skills.read', { skill: 'fixture', path: '../outside.md' })).isError,
		).toBe(true);
		await symlink(path.join(skill, 'SKILL.md'), path.join(skill, 'alias.md'));
		expect((await execute('skills.read', { skill: 'fixture', path: 'alias.md' })).isError).toBe(
			true,
		);
	});
});
