import { describe, expect, it, vi } from 'vitest';
import type { ToolCallRecord, ToolFileChange, ToolResult } from '../src/agent-types';
import type { Message, Thread } from '../src/types';
import { collectTaskOutputs } from '../src/lib/task-outputs';

type OutputResult = ToolResult & {
	outputFiles?: ToolFileChange[];
	outputTrackingNotices?: string[];
};
function call(id: string, overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
	return {
		id,
		name: 'apply_patch',
		arguments: '{}',
		status: 'completed',
		startedAt: 1,
		result: { content: [] },
		...overrides,
	};
}
function message(id: string, calls: ToolCallRecord[], createdAt = 1): Message {
	return { id, role: 'assistant', content: '', createdAt, toolCalls: calls };
}
function task(
	messages: Message[],
	messageHistory: Message[] = [],
): Pick<Thread, 'id' | 'messages' | 'messageHistory'> {
	return { id: 'task', messages, messageHistory };
}
function confirmed(
	id: string,
	changes: ToolFileChange[],
	at = 1,
	overrides: Partial<ToolCallRecord> = {},
) {
	return call(id, {
		completedAt: at,
		result: { content: [], outputFiles: changes } as OutputResult,
		...overrides,
	});
}
function patch(id: string, text: string, at = 1, overrides: Partial<ToolCallRecord> = {}) {
	return call(id, {
		arguments: JSON.stringify({ patch: `*** Begin Patch\n${text}\n*** End Patch` }),
		completedAt: at,
		...overrides,
	});
}
const png = 'data:image/png;base64,YQ==';
const csv = 'data:text/csv;base64,YQ==';

describe('task-wide Outputs evidence', () => {
	it('collects created files across turns without adding existing edited files or source uploads', () => {
		const data = collectTaskOutputs(
			task([
				{
					id: 'user',
					role: 'user',
					content: 'Read input',
					createdAt: 0,
					attachments: [{ name: 'source.csv', type: 'text/csv', dataUrl: csv }],
				},
				message('first', [patch('create', '*** Add File: docs/notes.md\n+note', 2)]),
				message('second', [patch('update', '*** Update File: existing.ts\n@@\n-old\n+new', 3)]),
				message('third', [confirmed('later', [{ kind: 'add', path: '/project/chart.svg' }], 4)]),
			]),
			{ workspaceRoot: '/project' },
		);
		expect(data.items.map((item) => item.path)).toEqual([
			'/project/docs/notes.md',
			'/project/chart.svg',
		]);
		expect(data.items[0]).toMatchObject({
			title: 'notes.md',
			callId: 'create',
			messageId: 'first',
			kind: 'local-file',
			createdAt: 2,
			hostConfirmed: false,
		});
		expect(data.items[1].hostConfirmed).toBe(true);
		expect(data).toMatchObject({ hasOutputs: true, truncated: false, notices: [] });
	});
	it('includes inactive response versions in actual execution order and deduplicates copied call IDs', () => {
		const first = confirmed('old', [{ kind: 'add', path: '/project/old.txt' }], 2);
		const latest = confirmed('new', [{ kind: 'add', path: '/project/new.txt' }], 5);
		const stale = { ...latest, status: 'running' as const, result: undefined };
		const data = collectTaskOutputs(
			task(
				[message('active', [latest]), message('copied', [first])],
				[message('old-version', [first]), message('stale', [stale])],
			),
		);
		expect(data.items.map((item) => item.path)).toEqual(['/project/old.txt', '/project/new.txt']);
		expect(data.items[0].messageId).toBe('copied');
		expect(data.items[1].messageId).toBe('active');
	});
	it('deduplicates repeated creation evidence by full path while preserving equal filenames in different directories', () => {
		const data = collectTaskOutputs(
			task([
				message('all', [
					patch('relative', '*** Add File: ./app/api/mcp/route.ts\n+export {};', 1),
					confirmed('canonical', [{ kind: 'add', path: '/project/app/api/mcp/route.ts' }], 2),
					confirmed('repeated', [{ kind: 'add', path: '/project/app/api/mcp/./route.ts' }], 3),
					patch('different-file', '*** Add File: app/api/game/route.ts\n+export {};', 4),
				]),
			]),
			{ workspaceRoot: '/project' },
		);
		expect(data.items.map((item) => item.path)).toEqual([
			'/project/app/api/mcp/route.ts',
			'/project/app/api/game/route.ts',
		]);
		expect(data.items.map((item) => item.title)).toEqual(['route.ts', 'route.ts']);
		expect(data.items[0].callId).toBe('relative');
	});
	it('applies deletion and recreation chronologically across inactive and active response versions', () => {
		const thread = task(
			[
				message('current', [
					confirmed('delete', [{ kind: 'delete', path: '/project/output.txt' }], 4),
				]),
			],
			[
				message('later-version', [
					confirmed('recreate', [{ kind: 'add', path: '/project/output.txt' }], 6),
				]),
				message('original-version', [
					confirmed('original', [{ kind: 'add', path: '/project/output.txt' }], 2),
				]),
			],
		);
		const outputs = collectTaskOutputs(thread);
		expect(outputs.items).toHaveLength(1);
		expect(outputs.items[0]).toMatchObject({
			path: '/project/output.txt',
			callId: 'recreate',
			messageId: 'later-version',
			createdAt: 6,
		});
	});
	it('follows moves, removes deleted outputs, and treats a recreated path as a new file', () => {
		const original = confirmed('original', [{ kind: 'add', path: '/project/a.txt' }], 1);
		const moved = confirmed(
			'move',
			[{ kind: 'move', previousPath: '/project/a.txt', path: '/project/b.txt' }],
			2,
		);
		const moveData = collectTaskOutputs(task([message('first', [original, moved])]));
		expect(moveData.items[0]).toMatchObject({
			path: '/project/b.txt',
			title: 'b.txt',
			callId: 'original',
		});
		expect(moveData.items[0].id).toBe('local:task:original:/project/a.txt');
		const data = collectTaskOutputs(
			task([
				message('all', [
					original,
					moved,
					confirmed('recreate-a', [{ kind: 'add', path: '/project/a.txt' }], 3),
					confirmed('delete-b', [{ kind: 'delete', path: '/project/b.txt' }], 4),
					confirmed('recreate-b', [{ kind: 'add', path: '/project/b.txt' }], 5),
				]),
			]),
		);
		expect(data.items.map((item) => [item.path, item.callId])).toEqual([
			['/project/a.txt', 'recreate-a'],
			['/project/b.txt', 'recreate-b'],
		]);
	});
	it('does not turn a preexisting moved file into an output or retain an overwritten output', () => {
		const data = collectTaskOutputs(
			task([
				message('all', [
					confirmed('new', [{ kind: 'add', path: '/project/destination.txt' }], 1),
					confirmed(
						'overwrite',
						[
							{
								kind: 'move',
								previousPath: '/project/existing.txt',
								path: '/project/destination.txt',
							},
						],
						2,
					),
					confirmed('existing', [{ kind: 'update', path: '/project/untouched.txt' }], 3),
				]),
			]),
		);
		expect(data.items).toEqual([]);
	});
	it('uses canonical host events instead of duplicate relative legacy metadata, including an empty event list', () => {
		const canonical = patch('canonical', '*** Add File: invented.txt\n+not applied', 1, {
			result: {
				content: [],
				fileChanges: [{ kind: 'add', path: 'display.txt' }],
				outputFiles: [{ kind: 'add', path: '/actual/output.txt' }],
			} as OutputResult,
		});
		const empty = patch('empty', '*** Add File: invented2.txt\n+not applied', 2, {
			result: { content: [], outputFiles: [] } as OutputResult,
		});
		expect(
			collectTaskOutputs(task([message('all', [canonical, empty])])).items.map((item) => item.path),
		).toEqual(['/actual/output.txt']);
	});
	it('recovers confirmed legacy patch additions from raw, JSON-string, and applied-path records', () => {
		const payload = '*** Begin Patch\n*** Add File: raw.txt\n+hello\n*** End Patch';
		const data = collectTaskOutputs(
			task([
				message('old', [
					call('raw', { arguments: payload }),
					call('string', { arguments: JSON.stringify(payload.replace('raw.txt', 'string.txt')) }),
					call('result', {
						arguments: 'broken JSON',
						result: {
							content: [
								{
									type: 'text',
									text: 'Applied patch:\nA result.txt\nM existing.txt\nD absent.txt',
								},
							],
						},
					}),
					patch('malformed', '*** Update File: invalid.txt\n@@'),
				]),
			]),
			{ workspaceRoot: '/project/' },
		);
		expect(data.items.map((item) => item.path)).toEqual([
			'/project/raw.txt',
			'/project/string.txt',
			'/project/result.txt',
		]);
	});
	it.each(['running', 'approval', 'failed', 'denied'] as const)(
		'ignores %s patch proposals and artifacts',
		(status) => {
			const proposal = patch('proposal', '*** Add File: never.txt\n+never', 1, {
				status,
				result: {
					content: [{ type: 'image', dataUrl: png }],
					fileChanges: [{ kind: 'add', path: 'never.txt' }],
					outputFiles: [{ kind: 'add', path: '/never.txt' }],
				} as OutputResult,
			});
			expect(collectTaskOutputs(task([message('all', [proposal])])).items).toEqual([]);
		},
	);
	it('retains actual output files from failed shell execution but excludes denied shell actions and error artifacts', () => {
		const actual = confirmed('actual', [{ kind: 'add', path: '/project/partial.txt' }], 2, {
			name: 'exec_command',
			status: 'failed',
			result: {
				isError: true,
				content: [{ type: 'file', name: 'error.csv', dataUrl: csv, mimeType: 'text/csv' }],
				outputFiles: [{ kind: 'add', path: '/project/partial.txt' }],
			} as OutputResult,
		});
		const denied = confirmed('denied', [{ kind: 'add', path: '/project/not-created.txt' }], 3, {
			name: 'exec_command',
			status: 'failed',
			result: {
				isError: true,
				content: [],
				approvalDenied: { reason: 'Rejected' },
				outputFiles: [{ kind: 'add', path: '/project/not-created.txt' }],
			} as OutputResult,
		});
		const update = confirmed('poll', [{ kind: 'add', path: '/project/poll.txt' }], 4, {
			name: 'write_stdin',
		});
		expect(
			collectTaskOutputs(task([message('all', [actual, denied, update])])).items.map(
				(item) => item.path,
			),
		).toEqual(['/project/partial.txt', '/project/poll.txt']);
	});
	it('never treats source image views, search results, or MCP-supplied local-path metadata as newly created files', () => {
		const data = collectTaskOutputs(
			task([
				message('sources', [
					...['view_image', 'image.view', 'web.run', 'read_mcp_resource'].map((name) =>
						call(name, {
							name,
							result: {
								content: [
									{ type: 'image', dataUrl: png, name: 'source.png' },
									{ type: 'file', dataUrl: csv, name: 'source.csv', mimeType: 'text/csv' },
								],
							},
						}),
					),
					call('mcp', {
						name: 'mcp_external_edit',
						result: {
							content: [],
							fileChanges: [{ kind: 'add', path: '/invented.txt' }],
							outputFiles: [{ kind: 'add', path: '/invented2.txt' }],
						} as OutputResult,
					}),
					call('stdout', {
						name: 'exec_command',
						result: { content: [{ type: 'text', text: 'Created file: invented3.txt' }] },
					}),
				]),
			]),
		);
		expect(data.items).toEqual([]);
	});
	it('keeps Python downloads once without counting previews and retains each generated image', () => {
		const data = collectTaskOutputs(
			task([
				message('assets', [
					call('python', {
						name: 'python.exec',
						result: {
							content: [
								{ type: 'file', name: 'chart.png', dataUrl: png, mimeType: 'image/png' },
								{
									type: 'image',
									name: 'chart-preview.jpg',
									dataUrl: 'data:image/jpeg;base64,YQ==',
								},
								{ type: 'file', name: 'result.csv', dataUrl: csv, mimeType: 'text/csv' },
								{
									type: 'file',
									name: 'empty.csv',
									dataUrl: 'data:text/csv;base64,',
									mimeType: 'text/csv',
								},
							],
						},
					}),
					call('generate', {
						name: 'image_gen.imagegen',
						result: {
							content: [
								{ type: 'image', name: 'same-name.png', dataUrl: png },
								{ type: 'image', name: 'same-name.png', dataUrl: png },
							],
						},
					}),
				]),
			]),
		);
		expect(data.items.map((item) => [item.kind, item.title])).toEqual([
			['file', 'chart.png'],
			['file', 'result.csv'],
			['file', 'empty.csv'],
			['image', 'same-name.png'],
			['image', 'same-name.png'],
		]);
		expect(new Set(data.items.map((item) => item.id)).size).toBe(5);
	});
	it('updates a repeated Python export in place, keeping the original creation order', () => {
		const make = (id: string, dataUrl: string, at: number) =>
			call(id, {
				name: 'python.exec',
				completedAt: at,
				result: { content: [{ type: 'file', name: 'results.csv', mimeType: 'text/csv', dataUrl }] },
			});
		const data = collectTaskOutputs(
			task([
				message('first', [make('first', csv, 2)]),
				message('later', [make('second', 'data:text/csv;base64,Yg==', 4)]),
			]),
		);
		expect(data.items).toHaveLength(1);
		expect(data.items[0]).toMatchObject({
			id: 'artifact:task:python:results.csv',
			createdAt: 2,
			callId: 'second',
			messageId: 'later',
			dataUrl: 'data:text/csv;base64,Yg==',
		});
	});
	it('upgrades legacy path proof when a canonical host update or move confirms the current output', () => {
		const data = collectTaskOutputs(
			task([
				message('all', [
					patch('legacy', '*** Add File: ./a.txt\n+hello', 1),
					confirmed('update', [{ kind: 'update', path: '/project/a.txt' }], 2),
					confirmed(
						'move',
						[{ kind: 'move', previousPath: '/project/a.txt', path: '/elsewhere/a.txt' }],
						3,
					),
				]),
			]),
			{ workspaceRoot: '/project' },
		);
		expect(data.items[0]).toMatchObject({
			path: '/elsewhere/a.txt',
			hostConfirmed: true,
			callId: 'legacy',
		});
	});
	it('bounds rows and records partial-tracking notices while still processing later deletes', () => {
		const make = (start: number) =>
			Array.from({ length: 512 }, (_, index): ToolFileChange => ({
				kind: 'add',
				path: `/project/file-${start + index}.txt`,
			}));
		const data = collectTaskOutputs(
			task([
				message('many', [
					confirmed('batch1', make(0), 1),
					confirmed('batch2', make(512), 2),
					confirmed('batch3', make(1024), 3),
					confirmed('delete', [{ kind: 'delete', path: '/project/file-0.txt' }], 4),
					call('notice', {
						name: 'exec_command',
						result: {
							content: [],
							outputTrackingNotices: [
								'Some paths could not be inspected.',
								'Some paths could not be inspected.',
							],
						} as OutputResult,
					}),
				]),
			]),
		);
		expect(data.items).toHaveLength(1023);
		expect(data.truncated).toBe(true);
		expect(data.notices).toEqual(['Some paths could not be inspected.']);
		expect(data.items.some((item) => item.path === '/project/file-0.txt')).toBe(false);
	});
	it('rejects unsafe paths and artifact URL schemes instead of inventing outputs', () => {
		const data = collectTaskOutputs(
			task([
				message('bad', [
					confirmed('paths', [
						{ kind: 'add', path: 'relative-host-path.txt' },
						{ kind: 'add', path: '/bad\nfile.txt' },
						{ kind: 'move', path: '/new.txt' },
					]),
					call('urls', {
						name: 'image_gen.imagegen',
						result: {
							content: [
								{ type: 'image', dataUrl: 'https://example.com/viewed.png' },
								{ type: 'image', dataUrl: 'data:text/html;base64,YQ==' },
								{ type: 'image', dataUrl: 'javascript:alert(1)' },
							],
						},
					}),
				]),
			]),
		);
		expect(data.items).toEqual([]);
	});
	it('does not reparse completed tool arguments during final text streaming and invalidates changed records', () => {
		const legacy = patch('legacy', '*** Add File: first.txt\n+first');
		const parse = vi.spyOn(JSON, 'parse');
		try {
			collectTaskOutputs(task([message('reply', [legacy])]));
			collectTaskOutputs(
				task([{ ...message('reply', [legacy]), content: 'Streaming final answer' }]),
			);
			expect(parse).toHaveBeenCalledTimes(1);
			legacy.arguments = JSON.stringify({
				patch: '*** Begin Patch\n*** Add File: changed.txt\n+changed\n*** End Patch',
			});
			expect(collectTaskOutputs(task([message('reply', [legacy])])).items[0].path).toBe(
				'changed.txt',
			);
			expect(parse).toHaveBeenCalledTimes(2);
		} finally {
			parse.mockRestore();
		}
	});
	it('does not mutate saved records or metadata when callers edit returned output rows', () => {
		const thread = task([
			message('reply', [confirmed('create', [{ kind: 'add', path: '/project/a.txt' }])]),
		]);
		const before = JSON.stringify(thread);
		const first = collectTaskOutputs(thread);
		first.items[0].path = '/changed';
		expect(JSON.stringify(thread)).toBe(before);
		expect(collectTaskOutputs(thread).items[0].path).toBe('/project/a.txt');
	});
});
