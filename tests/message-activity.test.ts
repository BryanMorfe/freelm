import { describe, expect, it, vi } from 'vitest';
import type { ToolCallRecord } from '../src/agent-types';
import type { Message } from '../src/types';
import {
	activeToolCall,
	activityDuration,
	editedFileActivityChanges,
	editedFileActivityCount,
	formatActivityDuration,
	groupActivityHistory,
	splitMessageActivity,
	toolActivityLabel,
	toolActivityLabels,
	toolArguments,
} from '../src/lib/message-activity';

function call(id: string, name = 'web.run', args: Record<string, unknown> = {}): ToolCallRecord {
	return { id, name, arguments: JSON.stringify(args), status: 'completed', startedAt: 1 };
}
function message(fields: Partial<Message> = {}): Message {
	return { id: 'answer', role: 'assistant', content: '', createdAt: 1_000, ...fields };
}

describe('completed message presentation', () => {
	it('separates the final round from intermediate prose and tools without repeating content', () => {
		const search = call('search', 'web.run', { search_query: [{ q: 'ocean evidence' }] });
		const read = call('read');
		const result = splitMessageActivity(
			message({
				content: 'I will search.\n\nThe search found a source.\n\n**Final answer.**',
				toolCalls: [search, read],
				activity: [
					{ type: 'text', id: 'intro', text: 'I will search.' },
					{ type: 'tool', id: 'search-part', toolCallId: 'search' },
					{ type: 'text', id: 'middle', text: 'The search found a source.' },
					{ type: 'tool', id: 'read-part', toolCallId: 'read' },
					{ type: 'text', id: 'final', text: '**Final answer.**' },
				],
			}),
		);
		expect(result.finalText).toBe('**Final answer.**');
		expect(result.intermediate.map((part) => part.id)).toEqual([
			'intro',
			'search-part',
			'middle',
			'read-part',
		]);
		expect(result.callsById.get('search')).toBe(search);
		expect(result.hasActivity).toBe(true);
	});

	it('does not turn the last pre-tool update into a final answer after an interrupted call', () => {
		const result = splitMessageActivity(
			message({
				content: 'I will look that up.',
				interrupted: true,
				toolCalls: [{ ...call('search'), status: 'failed' }],
				activity: [
					{ type: 'text', id: 'intro', text: 'I will look that up.' },
					{ type: 'tool', id: 'search-part', toolCallId: 'search' },
				],
			}),
		);
		expect(result.finalText).toBe('');
		expect(result.intermediate.map((part) => part.id)).toEqual(['intro', 'search-part']);
	});

	it('preserves legacy content, unreferenced tool records, and one history entry per call', () => {
		const search = call('search');
		const read = call('read');
		const legacy = splitMessageActivity(message({ content: 'Saved answer.', toolCalls: [search] }));
		expect(legacy.finalText).toBe('Saved answer.');
		expect(legacy.intermediate).toEqual([
			{ type: 'tool', id: 'unreferenced-search', toolCallId: 'search' },
		]);
		const timeline = splitMessageActivity(
			message({
				toolCalls: [search, read],
				activity: [
					{ type: 'tool', id: 'first-search', toolCallId: 'search' },
					{ type: 'tool', id: 'second-search', toolCallId: 'search' },
					{ type: 'tool', id: 'unknown-tool', toolCallId: 'missing' },
				],
			}),
		);
		expect(timeline.intermediate.map((part) => part.id)).toEqual([
			'first-search',
			'unreferenced-read',
		]);
	});

	it('keeps generated images, image progress and screenshots outside the collapsed history', () => {
		const generation = call('image', 'image_gen.imagegen');
		const pending = { ...call('pending', 'image_gen.imagegen'), status: 'running' as const };
		const screenshot: ToolCallRecord = {
			...call('screenshot'),
			result: {
				content: [{ type: 'image', dataUrl: 'data:image/png;base64,AA==', name: 'page.png' }],
			},
		};
		const result = splitMessageActivity(
			message({ toolCalls: [call('search'), generation, pending, screenshot] }),
		);
		expect(result.imageCalls).toEqual([generation, pending, screenshot]);
		expect(result.intermediate).toHaveLength(4);
	});

	it('keeps image-round text classification stable while the final explanation streams and completes', () => {
		const generation: ToolCallRecord = {
			...call('image', 'image_gen.imagegen'),
			result: {
				content: [{ type: 'image', dataUrl: 'data:image/png;base64,AA==', name: 'galaxy.png' }],
			},
		};
		const source = message({
			content: 'I will create an image.\n\nHere is the galaxy.',
			phase: 'responding',
			toolCalls: [generation],
			activity: [
				{ type: 'text', id: 'preamble', text: 'I will create an image.' },
				{ type: 'tool', id: 'generation', toolCallId: generation.id },
				{ type: 'text', id: 'final', text: 'Here is the galaxy.' },
			],
		});
		const live = splitMessageActivity(source);
		const done = splitMessageActivity({ ...source, completedAt: 6_000 });
		for (const result of [live, done]) {
			expect(result.finalText).toBe('Here is the galaxy.');
			expect(result.intermediate).toEqual(source.activity!.slice(0, 2));
			expect(result.imageCalls).toEqual([generation]);
		}
	});

	it('does not promote pre-image commentary when the tool returns no assistant text', () => {
		const generation = call('image', 'image_gen.imagegen');
		const source = message({
			content: 'I will create an image.',
			toolCalls: [generation],
			activity: [
				{ type: 'text', id: 'preamble', text: 'I will create an image.' },
				{ type: 'tool', id: 'generation', toolCallId: generation.id },
			],
		});
		for (const completedAt of [undefined, 6_000]) {
			const result = splitMessageActivity({ ...source, completedAt });
			expect(result.finalText).toBe('');
			expect(result.intermediate).toEqual(source.activity);
			expect(result.imageCalls).toEqual([generation]);
		}
	});

	it('marks new plain responses as having activity while keeping old plain answers plain', () => {
		expect(
			splitMessageActivity(message({ content: 'New answer.', phase: 'responding' })).hasActivity,
		).toBe(true);
		expect(splitMessageActivity(message({ content: 'Old answer.' })).hasActivity).toBe(false);
	});

	it('retains reasoning timing without inventing intermediate history', () => {
		const result = splitMessageActivity(
			message({
				content: 'An answer after reasoning.',
				activityFinishedAt: 5_000,
				completedAt: 8_000,
				activity: [
					{ type: 'text', id: 'empty', text: ' \n ' },
					{ type: 'tool', id: 'missing', toolCallId: 'not-recorded' },
					{ type: 'text', id: 'final', text: 'An answer after reasoning.' },
				],
			}),
		);
		expect(result.hasActivity).toBe(true);
		expect(result.intermediate).toEqual([]);
		expect(result.finalText).toBe('An answer after reasoning.');
	});

	it('preserves meaningful assistant updates as history even without a tool call', () => {
		const update = { type: 'text' as const, id: 'update', text: 'Comparing the two options.' };
		const result = splitMessageActivity(
			message({
				content: 'Comparing the two options.\n\nThe first option fits.',
				activity: [update, { type: 'text', id: 'final', text: 'The first option fits.' }],
			}),
		);
		expect(result.intermediate).toEqual([update]);
		expect(result.hasActivity).toBe(true);
		expect(result.finalText).toBe('The first option fits.');
	});
});

describe('active tool status', () => {
	it.each(['running', 'approval', 'completed'] as const)(
		'shows the exact command for %s calls',
		(status) => {
			const cmd = 'printf "a  b"\ncat <input.txt';
			const command = { ...call('command', 'exec_command', { cmd }), status };
			expect(toolActivityLabel(command)).toBe(
				`${status === 'completed' ? 'Ran' : 'Running'} ${cmd}`,
			);
		},
	);
	it('keeps the full command visible, including the end of a long script', () => {
		const cmd = `printf '${'x'.repeat(1_000)}'\nprintf final-command`;
		expect(toolActivityLabel(call('command', 'exec_command', { cmd }))).toBe(`Ran ${cmd}`);
	});
	it.each(['failed', 'denied'] as const)(
		'does not claim a %s command ran without execution evidence',
		(status) => {
			expect(
				toolActivityLabel({ ...call('command', 'exec_command', { cmd: 'pwd' }), status }),
			).toBe('Could not run pwd');
		},
	);
	it('uses failure wording when a command returns an error without a failed transport status', () => {
		const command = {
			...call('command', 'exec_command', { cmd: 'cat missing.txt' }),
			result: { content: [], isError: true },
		};
		expect(toolActivityLabel(command)).toBe('Could not run cat missing.txt');
		expect(toolActivityLabel({ ...command, arguments: '{}' })).toBe('Could not run command');
	});
	it('retains the full command in a failed process interaction', () => {
		const cmd = 'printf "a  b"\ncat <input.txt';
		const command = {
			...call('command', 'exec_command', { cmd }),
			result: { content: [], process: { command: cmd, sessionId: 'session' } },
		};
		const poll = {
			...call('poll', 'write_stdin', { session_id: 'session' }),
			status: 'failed' as const,
		};
		expect(toolActivityLabels([command, poll]).get(poll.id)).toBe(`Could not run ${cmd}`);
	});
	it.each(['null', '[]', '{', '{"cmd":42}'])(
		'handles incomplete command arguments %s',
		(argumentsText) => {
			expect(
				toolActivityLabel({
					...call('command', 'exec_command'),
					arguments: argumentsText,
					status: 'running',
				}),
			).toBe('Running a command');
		},
	);
	it('keeps yielded commands running and resolves the same command during process polling', () => {
		const command = {
			...call('command', 'exec_command', { cmd: 'cat README.md' }),
			result: { content: [], process: { command: 'cat README.md', sessionId: 'session' } },
		};
		const poll = {
			...call('poll', 'write_stdin', { session_id: 'session' }),
			status: 'running' as const,
		};
		expect(toolActivityLabel(command)).toBe('Running cat README.md');
		const labels = toolActivityLabels([command, poll]);
		expect(labels.get(command.id)).toBe('Running cat README.md');
		expect(labels.get(poll.id)).toBe('Running cat README.md');
	});
	it('does not leave a stopped run claiming its yielded command is still running', () => {
		const command = {
			...call('command', 'exec_command', { cmd: 'cat README.md' }),
			result: { content: [], process: { command: 'cat README.md', sessionId: 'session' } },
		};
		expect(toolActivityLabels([command], true).get(command.id)).toBe('Ran cat README.md');
	});
	it.each([0, 1, null])(
		'updates the original command after a process closes with exit %s despite truncated output',
		(exitCode) => {
			const process = { command: 'cat README.md', sessionId: 'session' };
			const command = {
				...call('command', 'exec_command', { cmd: process.command }),
				result: { content: [], process },
			};
			const poll = {
				...call('poll', 'write_stdin', { session_id: 'session' }),
				result: {
					content: [{ type: 'text' as const, text: '{"output":"truncated' }],
					process: { ...process, exitCode },
				},
			};
			const labels = toolActivityLabels([command, poll]);
			expect(labels.get(command.id)).toBe('Ran cat README.md');
			expect(labels.get(poll.id)).toBe('Ran cat README.md');
		},
	);
	it('resolves saved legacy process output and does not mix concurrent sessions', () => {
		const command = {
			...call('command', 'exec_command', { cmd: 'cat README.md' }),
			result: {
				content: [{ type: 'text' as const, text: '{"output":"","session_id":"session"}' }],
			},
		};
		const other = {
			...call('other', 'exec_command', { cmd: 'sleep 5' }),
			result: { content: [], process: { command: 'sleep 5', sessionId: 'other-session' } },
		};
		const poll = {
			...call('poll', 'write_stdin', { session_id: 'session' }),
			result: { content: [{ type: 'text' as const, text: '{"output":"","exit_code":0}' }] },
		};
		const labels = toolActivityLabels([command, other, poll]);
		expect(labels.get(command.id)).toBe('Ran cat README.md');
		expect(labels.get(poll.id)).toBe('Ran cat README.md');
		expect(labels.get(other.id)).toBe('Running sleep 5');
	});
	it('selects only the newest active call while ignoring completed tools', () => {
		const first = { ...call('first'), status: 'running' as const };
		const next = { ...call('next'), status: 'approval' as const };
		expect(activeToolCall(message({ toolCalls: [first, next, call('done')] }))).toBe(next);
		expect(activeToolCall(message({ toolCalls: [call('done')] }))).toBeUndefined();
	});
	it('uses the proposed file count while active and host-confirmed paths after completion', () => {
		const patch = '*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new\n*** End Patch';
		const active = { ...call('edit', 'apply_patch', { patch }), status: 'running' as const };
		expect(toolActivityLabel(active)).toBe('Editing 1 file');
		expect(
			toolActivityLabel({
				...active,
				status: 'completed',
				result: {
					content: [],
					fileChanges: [
						{ kind: 'update', path: 'src/app.ts' },
						{ kind: 'add', path: 'src/new.ts' },
					],
				},
			}),
		).toBe('Edited 2 files');
		expect(toolActivityLabel({ ...active, status: 'failed' })).toBe('Could not edit 1 file');
		expect(toolActivityLabel({ ...active, arguments: '{' })).toBe('Editing files');
	});
	it.each(['object', 'quoted', 'freeform', 'legacy-object'])(
		'counts every unique path in a %s patch argument',
		(format) => {
			const patch =
				'*** Begin Patch\n*** Add File: src/one.ts\n+one\n*** Add File: src/two.ts\n+two\n*** End Patch';
			const argumentsValue =
				format === 'object'
					? JSON.stringify({ patch })
					: format === 'quoted'
						? JSON.stringify(patch)
						: format === 'legacy-object'
							? ({ patch } as unknown as string)
							: patch;
			const current = {
				...call('edit', 'apply_patch'),
				arguments: argumentsValue,
				status: 'running' as const,
			};
			expect(toolActivityLabel(current)).toBe('Editing 2 files');
			expect(toolActivityLabel({ ...current, status: 'completed' })).toBe('Edited 2 files');
			expect(editedFileActivityCount([current])).toBe(2);
		},
	);
	it('counts all legacy applied paths when authored arguments are unavailable', () => {
		const current = {
			...call('legacy', 'apply_patch'),
			arguments: '{',
			result: {
				content: [
					{
						type: 'text' as const,
						text: 'Applied patch:\nM src/one.ts\nA src/two.ts\nD src/three.ts',
					},
				],
			},
		};
		expect(toolActivityLabel(current)).toBe('Edited 3 files');
		expect(editedFileActivityCount([current])).toBe(3);
	});

	it.each([
		[{ search_query: [{ q: 'Europa   ocean\nevidence' }] }, 'Searching for Europa ocean evidence'],
		[{ image_query: [{ q: 'Europa surface' }] }, 'Searching for images of Europa surface'],
		[{ open: [{ ref_id: 'https://science.nasa.gov/europa/' }] }, 'Reading science.nasa.gov'],
		[{ open: [{ ref_id: 'turn1search0' }] }, 'Reading web pages'],
		[{ find: [{ ref_id: 'page', pattern: 'ice crust' }] }, 'Finding ice crust'],
		[{ click: [{ ref_id: 'page', id: 3 }] }, 'Following a web link'],
		[{ screenshot: [{ ref_id: 'paper', pageno: 0 }] }, 'Viewing PDF pages'],
	])('uses a human status for web arguments %j', (args, expected) => {
		expect(toolActivityLabel({ ...call('web', 'web.run', args), status: 'running' })).toBe(
			expected,
		);
	});

	it('keeps malformed arguments safe and bounds long active labels', () => {
		for (const argumentsText of ['null', '[]', '{', '"string"']) {
			const invalid = { ...call('web'), arguments: argumentsText };
			expect(toolArguments(invalid)).toEqual({});
			expect(toolActivityLabel(invalid)).toBe('Read web pages');
		}
		const label = toolActivityLabel({
			...call('web', 'web.run', { search_query: [{ q: 'x'.repeat(1_000) }] }),
			status: 'running',
		});
		expect(label.length).toBe('Searching for '.length + 160);
		expect(label.endsWith('…')).toBe(true);
		expect(toolActivityLabel(call('image', 'image_gen.imagegen'))).toBe('Generated an image');
	});
	it.each([
		['view_image', { path: '/fixture/photo one.png' }, 'Viewed an image: /fixture/photo one.png'],
		[
			'image.view',
			{ target: 'https://example.org/image.png' },
			'Viewed a web image: https://example.org/image.png',
		],
		['web.run', { search_query: [{ q: 'Europa' }] }, 'Searched for Europa'],
		['web.run', { image_query: [{ q: 'Europa' }] }, 'Searched for images of Europa'],
		['web.run', { open: [{ ref_id: 'https://example.org' }] }, 'Read example.org'],
		['web.run', { screenshot: [{ ref_id: 'paper', pageno: 1 }] }, 'Viewed PDF pages'],
		['skills.read', {}, 'Read a skill'],
		['apply_patch', {}, 'Edited files'],
		['python.exec', {}, 'Ran Python'],
		['mcp_service_lookup', {}, 'Used service lookup'],
	])('uses past tense for a completed %s call', (name, args, expected) => {
		expect(
			toolActivityLabel(call('completed', name as string, args as Record<string, unknown>)),
		).toBe(expected);
	});
	it.each(['running', 'approval'] as const)(
		'keeps active image reads present tense for %s',
		(status) => {
			expect(
				toolActivityLabel({
					...call('image', 'view_image', { path: '/fixture/photo.png' }),
					status,
				}),
			).toBe('Viewing an image: /fixture/photo.png');
		},
	);
	it.each(['failed', 'denied', 'completed'] as const)(
		'does not claim an unsuccessful %s image read succeeded',
		(status) => {
			const failed = {
				...call('image', 'view_image', { path: '/fixture/missing.png' }),
				status,
				result: { content: [], isError: true },
			};
			expect(toolActivityLabel(failed)).toBe('Could not view an image: /fixture/missing.png');
		},
	);
});

describe('compact completed activity groups', () => {
	function edit(id: string, paths: string[]): ToolCallRecord {
		return {
			...call(id, 'apply_patch'),
			result: { content: [], fileChanges: paths.map((path) => ({ kind: 'update', path })) },
		};
	}
	function group(
		calls: ToolCallRecord[],
		parts = calls.map((tool) => ({
			type: 'tool' as const,
			id: `part-${tool.id}`,
			toolCallId: tool.id,
		})),
	) {
		return groupActivityHistory(
			parts,
			new Map(calls.map((tool) => [tool.id, tool])),
			toolActivityLabels(calls, true),
		);
	}
	it('groups adjacent image reads and keeps each exact path and original call', () => {
		const calls = [
			call('one', 'view_image', { path: '/fixture/one.png' }),
			call('two', 'view_image', { path: '/fixture/two.png' }),
		];
		expect(group(calls)).toEqual([
			{
				type: 'group',
				id: 'part-one',
				label: 'Viewed 2 images',
				parts: [
					{ type: 'tool', id: 'part-one', toolCallId: 'one' },
					{ type: 'tool', id: 'part-two', toolCallId: 'two' },
				],
			},
		]);
		expect(calls.map((tool) => toolActivityLabel(tool))).toEqual([
			'Viewed an image: /fixture/one.png',
			'Viewed an image: /fixture/two.png',
		]);
	});
	it('counts executions rather than process polls and preserves category boundaries', () => {
		const calls = [
			call('one', 'exec_command', { cmd: 'pwd' }),
			call('two', 'exec_command', { cmd: 'ls' }),
			call('three', 'exec_command', { cmd: 'cat README.md' }),
			call('poll', 'write_stdin'),
			call('search-one', 'web.run', { search_query: [{ q: 'one' }] }),
			call('search-two', 'web.run', { search_query: [{ q: 'two' }] }),
		];
		const entries = group(calls);
		expect(entries.map((entry) => (entry.type === 'group' ? entry.label : entry.part.id))).toEqual([
			'Ran 3 commands',
			'part-poll',
			'Searched the web 2 times',
		]);
	});
	it('counts unique actual edited paths, including renamed and repeatedly edited files', () => {
		const calls = [
			edit('first', ['src/app.ts', 'src/other.ts']),
			edit('repeat', ['./src/app.ts']),
			{
				...call('move', 'apply_patch'),
				result: {
					content: [],
					fileChanges: [{ kind: 'move' as const, previousPath: 'src/app.ts', path: 'src/main.ts' }],
				},
			},
		];
		const entries = group(calls);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ type: 'group', label: 'Edited 2 files' });
		if (entries[0].type === 'group') expect(entries[0].parts).toHaveLength(3);
	});
	it('normalizes qualified patch tools into one category and counts all paths across formats', () => {
		const patch =
			'*** Begin Patch\n*** Add File: src/one.ts\n+one\n*** Add File: src/two.ts\n+two\n*** End Patch';
		const calls = [
			{ ...call('first', 'functions.apply_patch'), arguments: patch },
			{ ...edit('second', ['src/two.ts', 'src/three.ts']), name: 'functions_apply_patch' },
		];
		expect(group(calls)[0]).toMatchObject({ type: 'group', label: 'Edited 3 files' });
	});
	it('does not invent a total when a legacy edit has no recoverable paths', () => {
		const entries = group([edit('known', ['src/app.ts']), call('unknown', 'apply_patch')]);
		expect(entries[0]).toMatchObject({ type: 'group', label: 'Edited files' });
	});
	it('reuses unchanged patch evidence when streaming rebuilds the timeline and refreshes changed results', () => {
		const patch = (path: string) =>
			`*** Begin Patch\n*** Update File: ${path}\n@@\n-old\n+new\n*** End Patch`;
		const first = call('first', 'apply_patch', { patch: patch('a.ts') });
		const second = call('second', 'apply_patch', { patch: patch('b.ts') });
		const parse = vi.spyOn(JSON, 'parse');
		try {
			for (let update = 0; update < 10; update++) {
				expect(group([first, second])[0]).toMatchObject({ type: 'group', label: 'Edited 2 files' });
				expect(editedFileActivityChanges(first)).toHaveLength(1);
			}
			expect(parse.mock.calls.filter(([text]) => text === first.arguments)).toHaveLength(1);
			expect(parse.mock.calls.filter(([text]) => text === second.arguments)).toHaveLength(1);
			const changed = { ...first, result: edit('result', ['c.ts', 'd.ts', 'e.ts']).result };
			expect(group([changed, second])[0]).toMatchObject({ type: 'group', label: 'Edited 4 files' });
			expect(parse.mock.calls.filter(([text]) => text === first.arguments)).toHaveLength(2);
		} finally {
			parse.mockRestore();
		}
	});
	it('collapses completed edits during streaming while keeping the current edit independent', () => {
		const calls = [
			edit('first', ['src/app.ts']),
			edit('repeat', ['src/app.ts']),
			{ ...edit('active', ['src/next.ts']), status: 'running' as const },
		];
		const parts = calls.map((tool) => ({
			type: 'tool' as const,
			id: `part-${tool.id}`,
			toolCallId: tool.id,
		}));
		const entries = groupActivityHistory(
			parts,
			new Map(calls.map((tool) => [tool.id, tool])),
			toolActivityLabels(calls),
		);
		expect(entries[0]).toMatchObject({ type: 'group', label: 'Edited 1 file' });
		expect(entries[1]).toEqual({ type: 'part', part: parts[2] });
	});
	it('does not merge the next edit back across an intermediate assistant update', () => {
		const calls = [edit('first', ['a.ts']), edit('second', ['b.ts']), edit('next', ['c.ts'])];
		const parts: import('../src/agent-types').ChatActivityPart[] = calls.map((tool) => ({
			type: 'tool',
			id: `part-${tool.id}`,
			toolCallId: tool.id,
		}));
		parts.splice(2, 0, { type: 'text', id: 'update', text: 'Next I will update the tests.' });
		const entries = groupActivityHistory(
			parts,
			new Map(calls.map((tool) => [tool.id, tool])),
			toolActivityLabels(calls),
		);
		expect(entries.map((entry) => (entry.type === 'group' ? entry.label : entry.part.id))).toEqual([
			'Edited 2 files',
			'update',
			'part-next',
		]);
	});
	it('keeps completed shell polling inside its execution group without adding commands', () => {
		const process = { command: 'cat README.md', sessionId: 'readme' };
		const calls = [
			{
				...call('read', 'exec_command', { cmd: process.command }),
				result: { content: [], process },
			},
			{
				...call('poll', 'write_stdin', { session_id: process.sessionId }),
				result: { content: [], process: { ...process, exitCode: 0 } },
			},
			{
				...call('last-poll', 'write_stdin', { session_id: process.sessionId }),
				result: { content: [], process: { ...process, exitCode: 0 } },
			},
			call('pwd', 'exec_command', { cmd: 'pwd' }),
		];
		const entries = group(calls);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ type: 'group', label: 'Ran 2 commands' });
		if (entries[0].type === 'group') expect(entries[0].parts).toHaveLength(4);
		expect(group(calls.slice(0, 3))[0]).toMatchObject({ type: 'group', label: 'Ran 1 command' });
	});
	it('does not hide the original yielded command when its later poll reports failure', () => {
		const process = { command: 'false', sessionId: 'failure' };
		const calls = [
			{
				...call('run', 'exec_command', { cmd: process.command }),
				result: { content: [], process },
			},
			call('pwd', 'exec_command', { cmd: 'pwd' }),
			{
				...call('poll', 'write_stdin', { session_id: process.sessionId }),
				result: { content: [], process: { ...process, exitCode: 1 } },
			},
		];
		expect(group(calls).every((entry) => entry.type === 'part')).toBe(true);
	});
	it('groups yielded commands during streaming and resolves their aggregate after completion', () => {
		const calls = [
			{
				...call('first', 'exec_command', { cmd: 'npm run build' }),
				result: { content: [], process: { command: 'npm run build', sessionId: 'build' } },
			},
			{
				...call('second', 'exec_command', { cmd: 'npm test' }),
				result: { content: [], process: { command: 'npm test', sessionId: 'test' } },
			},
			call('third', 'exec_command', { cmd: 'pwd' }),
			call('fourth', 'exec_command', { cmd: 'ls' }),
		];
		const parts = calls.map((tool) => ({
			type: 'tool' as const,
			id: `part-${tool.id}`,
			toolCallId: tool.id,
		}));
		const byId = new Map(calls.map((tool) => [tool.id, tool]));
		const live = groupActivityHistory(parts, byId, toolActivityLabels(calls));
		expect(live).toHaveLength(1);
		expect(live[0]).toMatchObject({ type: 'group', label: 'Running 4 commands', parts });
		expect(groupActivityHistory(parts, byId, toolActivityLabels(calls, true))[0]).toMatchObject({
			type: 'group',
			label: 'Ran 4 commands',
		});
		const divided = groupActivityHistory(
			[
				...parts.slice(0, 2),
				{ type: 'text', id: 'update', text: 'The checks are still running.' },
				...parts.slice(2),
			],
			byId,
			toolActivityLabels(calls),
		);
		expect(divided.map((entry) => (entry.type === 'group' ? entry.label : entry.part.id))).toEqual([
			'Running 2 commands',
			'update',
			'Ran 2 commands',
		]);
	});
	it('preserves a legacy command failure when its result contains both session and exit fields', () => {
		const calls = [
			call('before', 'exec_command', { cmd: 'pwd' }),
			{
				...call('legacy', 'exec_command', { cmd: 'false' }),
				result: {
					content: [{ type: 'text' as const, text: '{"session_id":"legacy","exit_code":1}' }],
				},
			},
			call('after', 'exec_command', { cmd: 'pwd' }),
		];
		expect(group(calls).every((entry) => entry.type === 'part')).toBe(true);
	});
	it('counts operations within homogeneous web batches and keeps other tool kinds separate', () => {
		const calls = [
			call('first', 'web.run', { search_query: [{ q: 'one' }, { q: 'two' }] }),
			call('second', 'web.run', { search_query: [{ q: 'three' }] }),
			call('read', 'web.run', { open: [{ ref_id: 'page' }] }),
		];
		expect(group(calls)[0]).toMatchObject({ type: 'group', label: 'Searched the web 3 times' });
		expect(group(calls)[1].type).toBe('part');
	});
	it('groups the same integration tool while a different tool breaks the sequence', () => {
		const calls = [
			call('one', 'mcp_service_lookup'),
			call('two', 'mcp_service_lookup'),
			call('other', 'mcp_service_read'),
			call('last', 'mcp_service_lookup'),
		];
		const entries = group(calls);
		expect(entries[0]).toMatchObject({ type: 'group', label: 'Used service lookup 2 times' });
		expect(entries.slice(1).map((entry) => entry.type)).toEqual(['part', 'part']);
	});
	it.each(['failed', 'denied', 'running', 'approval'] as const)(
		'keeps %s image operations visible and breaks groups around them',
		(status) => {
			const calls = [
				call('one', 'view_image'),
				{ ...call('error', 'view_image'), status },
				call('two', 'view_image'),
			];
			expect(group(calls).map((entry) => entry.type)).toEqual(['part', 'part', 'part']);
		},
	);
	it('does not conceal error results or nonzero or interrupted command exits in success groups', () => {
		const calls = [
			call('one', 'exec_command', { cmd: 'pwd' }),
			{
				...call('host-error', 'exec_command', { cmd: 'pwd' }),
				result: { content: [], isError: true },
			},
			{
				...call('exit-error', 'exec_command', { cmd: 'false' }),
				result: { content: [], process: { command: 'false', sessionId: 'failed', exitCode: 1 } },
			},
			{
				...call('interrupted', 'exec_command', { cmd: 'sleep 1' }),
				result: {
					content: [],
					process: { command: 'sleep 1', sessionId: 'interrupted', exitCode: null },
				},
			},
			{
				...call('legacy-error', 'exec_command', { cmd: 'false' }),
				result: { content: [{ type: 'text' as const, text: '{"exit_code":2}' }] },
			},
			call('last', 'exec_command', { cmd: 'pwd' }),
		];
		expect(group(calls).every((entry) => entry.type === 'part')).toBe(true);
	});
	it('preserves assistant text, asynchronous updates, plans and generation as group boundaries', () => {
		const calls = [
			call('one', 'view_image'),
			call('update', 'send_message_to_user_async'),
			call('two', 'view_image'),
			call('plan', 'update_plan'),
			call('three', 'view_image'),
			call('generate', 'image_gen.imagegen'),
			call('four', 'view_image'),
		];
		const parts: import('../src/agent-types').ChatActivityPart[] = calls.map((tool) => ({
			type: 'tool',
			id: `part-${tool.id}`,
			toolCallId: tool.id,
		}));
		parts.splice(1, 0, { type: 'text', id: 'assistant', text: 'I found the first image.' });
		const entries = groupActivityHistory(
			parts,
			new Map(calls.map((tool) => [tool.id, tool])),
			toolActivityLabels(calls, true),
		);
		expect(entries.map((entry) => (entry.type === 'part' ? entry.part.id : entry.id))).toEqual(
			parts.map((part) => part.id),
		);
		expect(entries.every((entry) => entry.type === 'part')).toBe(true);
	});
	it('groups matching web operations but does not merge text and image searches', () => {
		const calls = [
			call('one', 'web.run', { search_query: [{ q: 'one' }] }),
			call('images', 'web.run', { image_query: [{ q: 'one' }] }),
			call('two', 'web.run', { search_query: [{ q: 'two' }] }),
		];
		expect(group(calls).every((entry) => entry.type === 'part')).toBe(true);
	});
	it('keeps a successful mixed web batch outside single-category groups', () => {
		const calls = [
			call('before', 'web.run', { search_query: [{ q: 'before' }] }),
			call('mixed', 'web.run', { search_query: [{ q: 'mixed' }], open: [{ ref_id: 'source' }] }),
			call('after', 'web.run', { search_query: [{ q: 'after' }] }),
		];
		expect(group(calls).every((entry) => entry.type === 'part')).toBe(true);
	});
	it('keeps partial operation failures outside success groups even when the tool result is not isError', () => {
		const calls = [
			call('before', 'web.run', { search_query: [{ q: 'before' }] }),
			{
				...call('partial', 'web.run', { search_query: [{ q: 'failed' }, { q: 'succeeded' }] }),
				result: {
					isError: false,
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({
								results: [
									{ operation: 'search_query', error: 'Provider timed out' },
									{
										operation: 'search_query',
										results: [{ title: 'A source', url: 'https://example.org' }],
									},
								],
							}),
						},
					],
				},
			},
			call('after', 'web.run', { search_query: [{ q: 'after' }] }),
		];
		expect(group(calls).every((entry) => entry.type === 'part')).toBe(true);
	});
	it('does not infer full success when the envelope omitted operations', () => {
		const calls = [
			call('before', 'web.run', { search_query: [{ q: 'before' }] }),
			{
				...call('omitted', 'web.run', { search_query: [{ q: 'omitted' }] }),
				result: {
					content: [{ type: 'text' as const, text: '{"results":[],"omitted_operations":1}' }],
				},
			},
		];
		expect(group(calls).every((entry) => entry.type === 'part')).toBe(true);
	});
	it('keeps partial provider failures outside success groups', () => {
		const calls = [
			call('before', 'web.run', { search_query: [{ q: 'before' }] }),
			{
				...call('partial', 'web.run', { search_query: [{ q: 'partial' }] }),
				result: {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({
								results: [
									{
										operation: 'search_query',
										results: [],
										unresponsive_engines: [['google', 'CAPTCHA']],
									},
								],
							}),
						},
					],
				},
			},
			call('after', 'web.run', { search_query: [{ q: 'after' }] }),
		];
		expect(group(calls).every((entry) => entry.type === 'part')).toBe(true);
	});
	it('caches completed result inspection while allowing a replaced result to be checked again', () => {
		const output =
			'{"results":[{"operation":"search_query","results":[]}],"cache_marker":"large-result"}';
		const calls: ToolCallRecord[] = [
			call('before', 'web.run', { search_query: [{ q: 'before' }] }),
			{
				...call('cached', 'web.run', { search_query: [{ q: 'cached' }] }),
				result: { content: [{ type: 'text', text: output }] },
			},
		];
		const parse = vi.spyOn(JSON, 'parse');
		try {
			expect(group(calls)[0].type).toBe('group');
			expect(group(calls)[0].type).toBe('group');
			expect(parse.mock.calls.filter(([text]) => text === output)).toHaveLength(1);
			calls[1] = {
				...calls[1],
				result: {
					content: [
						{ type: 'text', text: '{"results":[{"operation":"search_query","error":"failed"}]}' },
					],
				},
			};
			expect(group(calls).every((entry) => entry.type === 'part')).toBe(true);
		} finally {
			parse.mockRestore();
		}
	});
});

describe('activity duration', () => {
	it('excludes final answer generation time and remains stable when reopened', () => {
		const completed = { ...message(), completedAt: 20_000, activityFinishedAt: 6_600 };
		expect(activityDuration(completed)).toBe(5_600);
		expect(formatActivityDuration(activityDuration(completed))).toBe('5s');
		expect(activityDuration(JSON.parse(JSON.stringify(completed)))).toBe(5_600);
	});

	it('uses legacy completion timing and handles missing or invalid clocks', () => {
		expect(activityDuration(message({ completedAt: 66_200 }))).toBe(65_200);
		expect(formatActivityDuration(65_200)).toBe('1m 5s');
		expect(activityDuration(message())).toBe(0);
		expect(activityDuration(message({ completedAt: 500 }))).toBe(0);
		expect(formatActivityDuration(Number.NaN)).toBe('0s');
		expect(formatActivityDuration(-100)).toBe('0s');
	});
});
