import { afterEach, describe, expect, it } from 'vitest';
import {
	lstat,
	mkdtemp,
	mkdir,
	readFile,
	readdir,
	realpath,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodeKnowledgeRuntime, type CodeKnowledgeContext } from '../electron/tools/code-knowledge';
import { codeKnowledgeTools } from '../src/lib/code-knowledge-tools';
import { machineIndependentTools } from '../src/lib/conversation-tools';
import type { Thread } from '../src/types';
import type { ToolResult } from '../src/agent-types';

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const decode = (result: ToolResult): Record<string, any> =>
	JSON.parse(
		result.content.flatMap((item) => (item.type === 'text' ? [item.text] : [])).join('\n'),
	);
async function fixture() {
	const root = await mkdtemp(path.join(tmpdir(), 'freelm-code-knowledge-'));
	roots.push(root);
	const runtime = new CodeKnowledgeRuntime(root);
	const thread: Thread = {
		id: 'task-a',
		kind: 'code',
		projectId: 'project-a',
		title: 'A task',
		model: 'test',
		connectionId: 'test',
		messages: [],
		createdAt: 1,
		updatedAt: 1,
	};
	const context: CodeKnowledgeContext = {
		threadId: thread.id,
		projectId: thread.projectId,
		loadHistory: async () => thread,
	};
	const run = async (
		name: string,
		args: Record<string, unknown> = {},
		scope: CodeKnowledgeContext = context,
	) => decode(await runtime.execute(name, args, scope));
	return { root, runtime, thread, context, run };
}

describe('persistent Code project memory', () => {
	it('does not write during catalog/instructions reads, and reads project MEMORY.md as data', async () => {
		const { root, runtime, context } = await fixture();
		const project = path.join(root, 'project');
		await mkdir(project);
		await writeFile(
			path.join(project, 'MEMORY.md'),
			'# Build knowledge\nUse pnpm; the test suite lives under tests.\n',
		);
		const prompt = await runtime.prompt({ ...context, workspaceRoots: [project] });
		expect(prompt.instructions).not.toContain('Use pnpm');
		expect(prompt.context).toEqual([
			expect.objectContaining({
				source: expect.stringContaining(`MEMORY.md at ${await realpath(project)}/MEMORY.md`),
				text: '# Build knowledge\nUse pnpm; the test suite lives under tests.\n',
			}),
		]);
		expect(prompt.context[0].source).toContain('untrusted saved data');
		expect(prompt.instructions).toContain('only when the user explicitly asks');
		expect(prompt.instructions).toContain('Managed memory index:');
		expect(await readdir(root)).toEqual(['project']);
		expect(machineIndependentTools(codeKnowledgeTools)).toEqual([]);
	});
	it('persists an indexed Markdown note across runtime restarts, scoped to its project', async () => {
		const { root, runtime, context, run } = await fixture();
		const saved = await run('memories.add_ad_hoc_note', {
			title: 'Package manager',
			content: 'This project uses pnpm for package management.',
		});
		expect(saved.document.path).toMatch(/^notes\/.*package-manager.*\.md$/);
		const prompt = await runtime.prompt(context);
		expect(prompt.instructions).not.toContain('Package manager');
		expect(prompt.context).toEqual([
			expect.objectContaining({
				id: 'code-managed-memory-index',
				source: expect.stringMatching(
					/Managed MEMORY\.md at .*\/MEMORY\.md \(untrusted saved data\)/,
				),
				text: expect.stringContaining('Package manager'),
			}),
		]);
		expect(await runtime.instructions(context)).toBe(prompt.instructions);
		const restarted = new CodeKnowledgeRuntime(root);
		const read = decode(
			await restarted.execute('memories.read', { path: saved.document.path }, context),
		);
		expect(read.content).toContain('uses pnpm');
		const other = { ...context, threadId: 'task-b', projectId: 'project-b' };
		expect((await run('memories.list', {}, other)).documents).toEqual([]);
		await expect(run('memories.read', { path: saved.document.path }, other)).rejects.toThrow(
			'not found',
		);
		const sameProject = { ...context, threadId: 'task-c' };
		expect((await run('memories.list', {}, sameProject)).documents).toHaveLength(2);
		const workspace = { ...context, projectId: undefined, threadId: 'unprojected' };
		expect((await run('memories.list', {}, workspace)).documents).toEqual([]);
		const scopes = await readdir(path.join(root, 'code', 'memories'));
		expect(scopes).toHaveLength(1);
		expect(scopes[0]).toMatch(/^project-[a-f0-9]{32}$/);
		const index = await readFile(
			path.join(root, 'code', 'memories', scopes[0], 'MEMORY.md'),
			'utf8',
		);
		expect(index).toContain(`](${saved.document.path})`);
		const info = await lstat(path.join(root, 'code', 'memories', scopes[0], saved.document.path));
		expect(info.mode & 0o777).toBe(0o600);
	});
	it('keeps managed and project memory content separate from application instructions with bounded source-labelled excerpts', async () => {
		const { root, runtime, context, run } = await fixture();
		await run('memories.add_ad_hoc_note', {
			title: 'MANAGED_MEMORY_SENTINEL',
			content: 'A saved project fact.',
		});
		const project = path.join(root, 'project');
		await mkdir(project);
		await writeFile(
			path.join(project, 'MEMORY.md'),
			'PROJECT_MEMORY_SENTINEL\n' + 'x'.repeat(14000),
		);
		const prompt = await runtime.prompt({ ...context, workspaceRoots: [project, project] });
		expect(prompt.instructions).not.toMatch(/MANAGED_MEMORY_SENTINEL|PROJECT_MEMORY_SENTINEL/);
		expect(prompt.context).toHaveLength(2);
		expect(new Set(prompt.context.map((section) => section.id)).size).toBe(2);
		expect(prompt.context[0].text).toContain('MANAGED_MEMORY_SENTINEL');
		expect(prompt.context[1].source).toContain(path.join(await realpath(project), 'MEMORY.md'));
		expect(prompt.context[1].text).toContain('PROJECT_MEMORY_SENTINEL');
		expect(prompt.context[1].text).toContain(
			'[Truncated; read the file with approved project tools to continue.]',
		);
		expect(prompt.context[1].text.length).toBeLessThan(12100);
		expect((await runtime.prompt({ ...context, projectId: 'different-project' })).context).toEqual(
			[],
		);
	});
	it('searches literal terms and rejects stale revisions while updating/deleting index links', async () => {
		const { run } = await fixture();
		const saved = await run('memories.add_ad_hoc_note', {
			title: 'Tests',
			content: 'Run pnpm test\nLiteral dollar $(do-not-execute) and parentheses [x].',
		});
		const same = await run('memories.add_ad_hoc_note', {
			title: 'Duplicate',
			content: 'Run pnpm test\nLiteral dollar $(do-not-execute) and parentheses [x].',
		});
		expect(same.duplicate).toBe(true);
		const hits = await run('memories.search', { query: 'pnpm test' });
		expect(hits.matches).toEqual(
			expect.arrayContaining([expect.objectContaining({ path: saved.document.path, line: 1 })]),
		);
		expect((await run('memories.search', { query: '$(do-not-execute)' })).matches).toHaveLength(1);
		const updated = await run('memories.update', {
			path: saved.document.path,
			revision: saved.document.revision,
			content: 'Run pnpm check instead.',
		});
		await expect(
			run('memories.update', {
				path: saved.document.path,
				revision: saved.document.revision,
				content: 'Stale overwrite',
			}),
		).rejects.toThrow('latest revision');
		await expect(
			run('memories.delete', { path: saved.document.path, revision: saved.document.revision }),
		).rejects.toThrow('latest revision');
		await run('memories.delete', {
			path: saved.document.path,
			revision: updated.document.revision,
		});
		expect((await run('memories.read', { path: 'MEMORY.md' })).content).not.toContain(
			saved.document.path,
		);
		expect((await run('memories.list')).documents).toHaveLength(1);
		const index = await run('memories.read', { path: 'MEMORY.md' });
		await expect(
			run('memories.delete', { path: 'MEMORY.md', revision: index.revision }),
		).rejects.toThrow('rather than deleting');
	});
});

describe('task scratch notes and bounded file access', () => {
	it('serializes concurrent appends without losing text and preserves notes after restart', async () => {
		const { root, runtime, context, run } = await fixture();
		await Promise.all(
			Array.from({ length: 20 }, (_, index) =>
				run('notes.append_to_file', { path: 'progress/work.md', text: `Finding ${index}\n` }),
			),
		);
		const note = await run('notes.read_file', { path: 'progress/work.md' });
		for (let index = 0; index < 20; index++) expect(note.content).toContain(`Finding ${index}\n`);
		expect((await run('notes.search_contents', { query: 'Finding 12' })).matches).toHaveLength(1);
		const restarted = new CodeKnowledgeRuntime(root);
		expect(
			decode(await restarted.execute('notes.read_file', { path: 'progress/work.md' }, context))
				.content,
		).toBe(note.content);
		expect(
			(await run('notes.list_files_by_prefix', {}, { ...context, threadId: 'different-task' }))
				.documents,
		).toEqual([]);
		await expect(
			run('notes.write_file', { path: 'progress/work.md', text: 'Overwrite' }),
		).rejects.toThrow('revision');
		await run('notes.write_file', {
			path: 'progress/work.md',
			text: 'Revised',
			revision: note.revision,
		});
	});
	it('rejects traversal, hidden files, invalid content, model-selected scopes and unsafe pagination', async () => {
		const { run } = await fixture();
		for (const path of [
			'../outside.md',
			'/outside.md',
			'.secret.md',
			'x/../outside.md',
			'x//y.md',
			'x\\y.md',
			'x.json',
		])
			await expect(run('notes.write_file', { path, text: 'Bad' })).rejects.toThrow();
		await expect(run('memories.list', { projectId: 'another-project' })).rejects.toThrow('Scope');
		await expect(
			run('notes.write_file', { path: 'x.md', text: 'x'.repeat(65537) }),
		).rejects.toThrow('65536');
		await expect(run('notes.write_file', { path: 'x.md', text: 'a\0b' })).rejects.toThrow('UTF-8');
		await expect(run('notes.list_files_by_prefix', { limit: 1000 })).rejects.toThrow('integer');
		await expect(
			run('history.read_item', { item_id: 'x', character_limit: Infinity }),
		).rejects.toThrow();
	});
	it('rejects symlinks in managed stores and project MEMORY.md without reading the target', async () => {
		const { root, runtime, context, run } = await fixture();
		await run('notes.write_file', { path: 'safe.md', text: 'Safe' });
		const task = (await readdir(path.join(root, 'code', 'tasks')))[0];
		const notes = path.join(root, 'code', 'tasks', task, 'notes');
		const secret = path.join(root, 'secret.md');
		await writeFile(secret, 'Do not expose');
		await symlink(secret, path.join(notes, 'unsafe.md'));
		await expect(run('notes.read_file', { path: 'unsafe.md' })).rejects.toThrow('Symbolic');
		await expect(run('notes.list_files_by_prefix')).rejects.toThrow('Symbolic');
		const project = path.join(root, 'project');
		await mkdir(project);
		await symlink(secret, path.join(project, 'MEMORY.md'));
		const unavailable = await runtime.instructions({ ...context, workspaceRoots: [project] });
		expect(unavailable).toContain('unavailable');
		expect(unavailable).toContain('Code tools remain available');
		expect(unavailable).not.toContain('Do not expose');
		const outside = path.join(root, 'outside');
		await mkdir(outside);
		const linkedRoot = path.join(root, 'linked-profile');
		await symlink(outside, linkedRoot);
		const linkedRuntime = new CodeKnowledgeRuntime(linkedRoot);
		await expect(
			linkedRuntime.execute('notes.write_file', { path: 'x.md', text: 'Bad' }, context),
		).rejects.toThrow('symbolic');
		expect(await readdir(outside)).toEqual([]);
	});
	it('returns bounded line and character windows without making a long line unreadable', async () => {
		const { run } = await fixture();
		await run('notes.write_file', {
			path: 'long.md',
			text: `Header\n${'a'.repeat(40000)}TAIL\nLast`,
		});
		const first = await run('notes.read_file', { path: 'long.md', start_line: 2, line_count: 1 });
		expect(first.content).toHaveLength(32000);
		expect(first.next_character_offset).toBe(32000);
		const rest = await run('notes.read_file', {
			path: 'long.md',
			start_line: 2,
			line_count: 1,
			character_offset: first.next_character_offset,
		});
		expect(rest.content).toContain('TAIL');
		expect(rest.next_line).toBe(3);
	});
	it('stops before mutations when cancelled', async () => {
		const { root, runtime, context } = await fixture();
		const controller = new AbortController();
		controller.abort();
		await expect(
			runtime.execute(
				'notes.write_file',
				{ path: 'x.md', text: 'No write' },
				context,
				controller.signal,
			),
		).rejects.toThrow('cancelled');
		expect(await readdir(root)).toEqual([]);
	});
});

describe('original context history recovery', () => {
	it('retains every compaction/reset boundary within one assistant response', async () => {
		const { thread, run } = await fixture();
		thread.messages = [
			{ id: 'u', role: 'user', content: 'Original user message', createdAt: 1 },
			{
				id: 'a',
				role: 'assistant',
				content: 'Final assistant',
				createdAt: 2,
				agentTranscript: {
					api: 'responses',
					items: [
						{ role: 'assistant', content: 'First original' },
						{ role: 'assistant', content: 'Second original' },
						{ role: 'assistant', content: 'Third original' },
					],
					contextWindows: [
						{
							id: 'compacted-window',
							transcriptItemCount: 1,
							historyMessageIds: ['u'],
							createdAt: 3,
							kind: 'compaction',
						},
						{
							id: 'reset-window',
							transcriptItemCount: 2,
							historyMessageIds: ['u'],
							createdAt: 4,
							kind: 'reset',
						},
						{
							id: 'empty-reset-window',
							transcriptItemCount: 2,
							historyMessageIds: ['u'],
							createdAt: 5,
							kind: 'reset',
						},
					],
				},
			},
		];
		const windows = await run('history.list_windows');
		expect(windows.windows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					window_id: 'compacted-window',
					kind: 'compaction',
					item_count: 2,
				}),
				expect.objectContaining({ window_id: 'reset-window', kind: 'reset', item_count: 1 }),
				expect.objectContaining({ window_id: 'empty-reset-window', kind: 'reset', item_count: 0 }),
			]),
		);
		expect(
			(await run('history.search_contents', { query: 'First original' })).matches[0].window_id,
		).toBe('compacted-window');
		expect(
			(await run('history.search_contents', { query: 'Second original' })).matches[0].window_id,
		).toBe('reset-window');
		expect(
			(await run('history.search_contents', { query: 'Third original' })).matches[0].window_id,
		).toBe('current');
	});
	it('recovers pre-compaction text and tool results rather than reading the compacted summary', async () => {
		const { thread, run } = await fixture();
		thread.messages = [
			{ id: 'u1', role: 'user', content: 'Implement the violet widget.', createdAt: 1 },
			{
				id: 'a1',
				role: 'assistant',
				content: 'Done with original result.',
				createdAt: 2,
				agentTranscript: {
					api: 'responses',
					items: [
						{
							type: 'function_call',
							name: 'exec_command',
							call_id: 'c1',
							arguments: '{"cmd":"cat important.txt"}',
						},
						{
							type: 'function_call_output',
							call_id: 'c1',
							output: 'Original result: customer detail VIOLET-473.',
						},
					],
				},
			},
			{
				id: 'a2',
				role: 'assistant',
				content: 'Continuing',
				createdAt: 3,
				agentTranscript: {
					api: 'responses',
					items: [
						{
							type: 'message',
							role: 'assistant',
							content: [{ type: 'output_text', text: 'Precompaction original INSIDE-729' }],
						},
						{
							type: 'message',
							role: 'assistant',
							content: [{ type: 'output_text', text: 'Later output' }],
						},
					],
					context: {
						version: 1,
						api: 'responses',
						model: 'test',
						connectionId: 'test',
						historyMessageIds: ['u1', 'a1'],
						transcriptItemCount: 1,
						items: [{ role: 'user', content: 'Only a short summary; details omitted.' }],
						createdAt: 3,
						compactionCount: 1,
						inputTokensBefore: 10000,
						inputTokensAfter: 1000,
					},
				},
			},
		];
		const before = JSON.stringify(thread);
		const windows = await run('history.list_windows');
		expect(windows.windows.map((window: any) => window.window_id)).toEqual(
			expect.arrayContaining(['current', expect.stringMatching(/^before-/)]),
		);
		const hits = await run('history.search_contents', { query: 'VIOLET-473' });
		expect(hits.matches).toHaveLength(1);
		expect(hits.matches[0].window_id).toMatch(/^before-/);
		const original = await run('history.read_item', { item_id: hits.matches[0].id });
		expect(original.content).toContain('Original result: customer detail VIOLET-473.');
		expect(
			(await run('history.search_contents', { query: 'INSIDE-729' })).matches[0].window_id,
		).toMatch(/^before-/);
		expect(
			(await run('history.search_contents', { query: 'Only a short summary' })).matches,
		).toEqual([]);
		expect((await run('history.list_items', { window_id: 'does-not-exist' })).items).toEqual([]);
		expect(JSON.stringify(thread)).toBe(before);
	});
	it('includes inactive branches and legacy tool output, omits binary payloads, and protects the task boundary', async () => {
		const { thread, runtime, context, run } = await fixture();
		thread.messages = [
			{
				id: 'a',
				role: 'assistant',
				content: 'Active',
				createdAt: 2,
				toolCalls: [
					{
						id: 'call',
						name: 'exec_command',
						arguments: '{"cmd":"pwd"}',
						status: 'completed',
						startedAt: 1,
						result: {
							content: [
								{ type: 'text', text: 'Legacy fact: aqua' },
								{ type: 'image', dataUrl: 'data:image/png;base64,aGVsbG8=' },
							],
						},
					},
				],
			},
		];
		thread.messageHistory = [
			{ id: 'old', role: 'user', content: 'Previous branch sapphire', createdAt: 1 },
		];
		const hits = await run('history.search_contents', { query: 'aqua' });
		const original = await run('history.read_item', {
			item_id: hits.matches[0].id,
			character_limit: 32000,
		});
		expect(original.content).toContain('Legacy fact: aqua');
		expect(original.content).toContain('[binary asset omitted]');
		expect(original.content).not.toContain('aGVsbG8=');
		expect((await run('history.search_contents', { query: 'sapphire' })).matches[0]).toMatchObject({
			inactive: true,
			window_id: 'inactive',
		});
		await expect(
			runtime.execute('history.list_items', {}, { ...context, threadId: 'other-task' }),
		).rejects.toThrow('scope changed');
		await expect(
			runtime.execute('history.list_items', {}, { ...context, projectId: 'other-project' }),
		).rejects.toThrow('scope changed');
	});
	it('pages long original messages and returns stable IDs after reload', async () => {
		const { thread, run, root, context } = await fixture();
		thread.messages = [
			{ id: 'long', role: 'user', content: `${'x'.repeat(40000)}FINAL`, createdAt: 1 },
		];
		const listing = await run('history.list_items', { limit: 1 });
		expect(listing.items[0].excerpt).toHaveLength(500);
		const original = await run('history.read_item', {
			item_id: listing.items[0].id,
			character_limit: 32000,
		});
		expect(original.content).toHaveLength(32000);
		const runtime = new CodeKnowledgeRuntime(root);
		const next = decode(
			await runtime.execute(
				'history.read_item',
				{ item_id: listing.items[0].id, character_offset: original.next_character_offset },
				context,
			),
		);
		expect(next.content).toContain('FINAL');
	});
});
