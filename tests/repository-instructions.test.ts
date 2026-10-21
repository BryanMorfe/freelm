import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
	discoverRepositoryInstructions,
	REPOSITORY_INSTRUCTION_BYTES,
} from '../electron/tools/repository-instructions';
import { ToolRuntime } from '../electron/tools/runtime';
import { AgentHost } from '../electron/agent-host';
import { defaultToolSettings } from '../src/lib/tool-settings';
import { initialState } from '../src/lib/state';

describe('scoped Code repository instructions', () => {
	let directory: string;
	const folder = async (...parts: string[]) => {
		const result = path.join(directory, ...parts);
		await mkdir(result, { recursive: true });
		return result;
	};
	const agents = (root: string, text: string, override = false) =>
		writeFile(path.join(root, override ? 'AGENTS.override.md' : 'AGENTS.md'), text);
	beforeEach(async () => {
		directory = await realpath(
			await mkdtemp(path.join(os.tmpdir(), 'freelm-repository-instructions-')),
		);
	});
	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it('loads only the explicit root-to-working-directory path, with override precedence and provenance', async () => {
		const root = await folder('project');
		const child = await folder('project', 'src');
		const cwd = await folder('project', 'src', 'feature');
		const unrelated = await folder('project', 'other');
		await mkdir(path.join(directory, '.git'));
		await agents(directory, 'UNRELATED ANCESTOR');
		await agents(root, 'ROOT RULE');
		await agents(child, 'REPLACED RULE');
		await agents(child, 'CHILD OVERRIDE', true);
		await agents(cwd, 'FEATURE RULE');
		await agents(unrelated, 'UNRELATED SUBTREE');
		const result = await discoverRepositoryInstructions({
			workspaceRoot: cwd,
			workspaceRoots: [root],
		});
		expect(result.context.map((part) => part.source)).toEqual([
			path.join(root, 'AGENTS.md'),
			path.join(child, 'AGENTS.override.md'),
			path.join(cwd, 'AGENTS.md'),
		]);
		expect(result.context.map((part) => part.text).join('\n')).not.toMatch(/UNRELATED|REPLACED/);
		expect(result.context[1].text).toContain(`Scope: ${JSON.stringify(child)} and its descendants`);
		expect(result.instructions).toContain('more deeply scoped instructions take precedence');
		expect(result.instructions).toContain('Before editing another directory');
		expect(result.instructions).not.toContain('CHILD OVERRIDE');
		expect(result.warnings).toEqual([]);
	});

	it.each(['directory', 'file'])(
		'uses the nearest .git %s boundary only when there is no explicit root',
		async (kind) => {
			const outer = await folder('outer');
			const root = await folder('outer', 'repository');
			const cwd = await folder('outer', 'repository', 'src');
			await mkdir(path.join(outer, '.git'));
			if (kind === 'directory') await mkdir(path.join(root, '.git'));
			else await writeFile(path.join(root, '.git'), 'gitdir: ignored-metadata-only');
			await agents(outer, 'OUTER REPOSITORY');
			await agents(root, 'NEAREST REPOSITORY');
			await agents(cwd, 'CURRENT DIRECTORY');
			const result = await discoverRepositoryInstructions({
				workspaceRoot: cwd,
				workspaceRoots: [],
			});
			expect(result.context.map((part) => part.source)).toEqual([
				path.join(root, 'AGENTS.md'),
				path.join(cwd, 'AGENTS.md'),
			]);
			expect(result.context.map((part) => part.text).join('\n')).not.toContain('OUTER REPOSITORY');
		},
	);

	it('does not load ancestor documents without a repository marker', async () => {
		const cwd = await folder('unversioned');
		await agents(directory, 'UNRELATED PARENT');
		await agents(cwd, 'LOCAL');
		const result = await discoverRepositoryInstructions({ workspaceRoot: cwd });
		expect(result.context.map((part) => part.source)).toEqual([path.join(cwd, 'AGENTS.md')]);
	});

	it('supports multiple roots without merging their scopes or duplicating overlapping paths', async () => {
		const root = await folder('first');
		const nested = await folder('first', 'nested');
		const other = await folder('second');
		await agents(root, 'FIRST');
		await agents(nested, 'NESTED');
		await agents(other, 'SECOND');
		const result = await discoverRepositoryInstructions({
			workspaceRoot: nested,
			workspaceRoots: [nested, other, root, root],
		});
		expect(result.context).toHaveLength(3);
		expect(new Set(result.context.map((part) => part.id)).size).toBe(3);
		const sources = result.context.map((part) => part.source);
		expect(sources.indexOf(path.join(root, 'AGENTS.md'))).toBeLessThan(
			sources.indexOf(path.join(nested, 'AGENTS.md')),
		);
		expect(
			result.context.find((part) => part.source === path.join(other, 'AGENTS.md'))?.text,
		).toContain(`Scope: ${JSON.stringify(other)}`);
	});

	it('resolves explicitly selected root aliases but rejects symlink traversal below a root', async () => {
		const root = await folder('project');
		const child = await folder('project', 'src');
		const outside = await folder('outside');
		const alias = path.join(directory, 'selected-alias');
		await symlink(root, alias, 'dir');
		await symlink(outside, path.join(root, 'escape'), 'dir');
		await agents(root, 'ROOT');
		await agents(child, 'CHILD');
		await agents(outside, 'OUTSIDE');
		const valid = await discoverRepositoryInstructions({
			workspaceRoot: path.join(alias, 'src'),
			workspaceRoots: [alias],
		});
		expect(valid.context.map((part) => part.source)).toEqual([
			path.join(root, 'AGENTS.md'),
			path.join(child, 'AGENTS.md'),
		]);
		const invalid = await discoverRepositoryInstructions({
			workspaceRoot: path.join(root, 'escape'),
			workspaceRoots: [root],
		});
		expect(invalid.context.map((part) => part.text).join('\n')).not.toContain('OUTSIDE');
		expect(invalid.warnings.join('\n')).toContain('nested repository instructions');
	});

	it('does not follow instruction-file symlinks or fall back behind an unsafe override', async () => {
		const root = await folder('project');
		const outside = path.join(directory, 'outside.md');
		await writeFile(outside, 'OUTSIDE FILE');
		await agents(root, 'BASE SHOULD NOT REPLACE OVERRIDE');
		await symlink(outside, path.join(root, 'AGENTS.override.md'));
		const result = await discoverRepositoryInstructions({
			workspaceRoot: root,
			workspaceRoots: [root],
		});
		expect(result.context).toEqual([]);
		expect(result.warnings.join('\n')).toContain('non-symlink');
	});

	it('an intentionally empty override suppresses the base file', async () => {
		const root = await folder('project');
		await agents(root, 'SUPPRESSED');
		await agents(root, '  \n', true);
		const result = await discoverRepositoryInstructions({ workspaceRoot: root });
		expect(result.context).toEqual([]);
		expect(result.warnings).toEqual([]);
	});

	it('bounds shared reads, preserves complete UTF-8 characters, and reports omitted files', async () => {
		const root = await folder('project');
		const cwd = await folder('project', 'src');
		await agents(root, '€'.repeat(REPOSITORY_INSTRUCTION_BYTES));
		await agents(cwd, 'OMITTED CHILD');
		const result = await discoverRepositoryInstructions({
			workspaceRoot: cwd,
			workspaceRoots: [root],
		});
		expect(result.context).toHaveLength(1);
		expect(result.context[0].text).not.toContain('\uFFFD');
		expect(result.context[0].text).toContain('[File truncated');
		expect(result.context[0].text.length).toBeLessThan(REPOSITORY_INSTRUCTION_BYTES);
		expect(result.warnings.join('\n')).toContain('remaining files were omitted');
		expect(result.instructions).toContain('Read any omitted or truncated applicable instructions');
	});

	it('handles missing and nonregular instruction files without failing the catalog', async () => {
		const root = await folder('project');
		await mkdir(path.join(root, 'AGENTS.md'));
		const result = await discoverRepositoryInstructions({
			workspaceRoot: root,
			workspaceRoots: [root, path.join(directory, 'missing')],
		});
		expect(result.context).toEqual([]);
		expect(result.warnings).toHaveLength(2);
		expect(result.warnings.join('\n')).toContain('regular, non-symlink files');
		const empty = await discoverRepositoryInstructions({ workspaceRoot: await folder('empty') });
		expect(empty.warnings).toEqual([]);
	});

	it.each([Buffer.from('binary\0content'), Buffer.from([0xff, 0xfe, 0x41])])(
		'rejects binary or invalid UTF-8 instructions',
		async (content) => {
			const root = await folder('project');
			await writeFile(path.join(root, 'AGENTS.md'), content);
			const result = await discoverRepositoryInstructions({ workspaceRoot: root });
			expect(result.context).toEqual([]);
			expect(result.warnings.join('\n')).toContain('expected UTF-8 text');
		},
	);

	it('the production host selects all project roots and confines a configured default workspace', async () => {
		const root = await folder('project');
		const second = await folder('second');
		const fallback = await folder('default');
		await mkdir(path.join(directory, '.git'));
		await agents(directory, 'OUTSIDE SELECTED ROOTS');
		await agents(root, 'PROJECT ONE');
		await agents(second, 'PROJECT TWO');
		await agents(fallback, 'DEFAULT WORKSPACE');
		const state = initialState();
		state.toolSettings = {
			...defaultToolSettings(),
			workspaceRoot: fallback,
			approvalMode: 'full-access',
		};
		state.projects = [
			{
				id: 'project',
				name: 'Project',
				kind: 'code',
				directories: [root, second],
				instructions: '',
				createdAt: 1,
			},
		];
		state.threads = ['project-code', 'unassigned-code'].map((id) => ({
			id,
			title: id,
			kind: 'code',
			connectionId: '',
			model: 'fixture',
			messages: [],
			createdAt: 1,
			updatedAt: 1,
			...(id === 'project-code' ? { projectId: 'project' } : {}),
		}));
		const host = new AgentHost(
			async () => state,
			async () => true,
		);
		try {
			const project = await host.catalog('project-run', 'project-code');
			expect(project.context?.map((part) => part.source)).toEqual([
				path.join(root, 'AGENTS.md'),
				path.join(second, 'AGENTS.md'),
			]);
			const standalone = await host.catalog('default-run', 'unassigned-code');
			expect(standalone.context?.map((part) => part.source)).toEqual([
				path.join(fallback, 'AGENTS.md'),
			]);
			expect(JSON.stringify([project.context, standalone.context])).not.toContain(
				'OUTSIDE SELECTED ROOTS',
			);
		} finally {
			await host.close();
		}
	});

	it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
		'reports unreadable overrides instead of silently loading the base',
		async () => {
			const root = await folder('project');
			await agents(root, 'BASE');
			await agents(root, 'UNREADABLE', true);
			await chmod(path.join(root, 'AGENTS.override.md'), 0);
			const result = await discoverRepositoryInstructions({ workspaceRoot: root });
			expect(result.context).toEqual([]);
			expect(result.warnings.join('\n')).toMatch(/EACCES|EPERM/);
		},
	);

	it('returns no filesystem context without a working directory and honors cancellation', async () => {
		expect(await discoverRepositoryInstructions({ workspaceRoot: '', workspaceRoots: [] })).toEqual(
			{ context: [], instructions: '', warnings: [] },
		);
		const controller = new AbortController();
		controller.abort();
		await expect(
			discoverRepositoryInstructions({ workspaceRoot: directory }, controller.signal),
		).rejects.toThrow('cancelled');
	});

	it('the host tool catalog separates file contents from trusted guidance and refreshes each run', async () => {
		const root = await folder('project');
		await agents(root, 'INITIAL REPOSITORY INSTRUCTION');
		const runtime = new ToolRuntime();
		const settings = { ...defaultToolSettings(), workspaceRoot: root, workspaceRoots: [root] };
		try {
			const first = await runtime.catalog(settings);
			expect(first.context?.[0].text).toContain('INITIAL REPOSITORY INSTRUCTION');
			expect(first.instructions).not.toContain('INITIAL REPOSITORY INSTRUCTION');
			expect(first.instructions).toContain(
				'User requests and host permission rules take precedence',
			);
			await agents(root, 'UPDATED REPOSITORY INSTRUCTION');
			const next = await runtime.catalog(settings);
			expect(next.context?.[0].text).toContain('UPDATED REPOSITORY INSTRUCTION');
			expect(next.context?.[0].id).toBe(first.context?.[0].id);
		} finally {
			await runtime.close();
		}
	});
});
