import { describe, expect, it } from 'vitest';
import type { ToolApproval } from '../src/agent-types';
import { toolApprovalPresentation } from '../src/lib/tool-approval-presentation';

function approval(
	name: string,
	arguments_: Record<string, unknown>,
	message = 'Allow this local action? Review its arguments before continuing.',
): ToolApproval {
	return {
		id: 'approval',
		runId: 'run',
		name,
		arguments: arguments_,
		message,
		effectiveDirectory: '/project/source',
	};
}

describe('human-readable tool approvals', () => {
	it('presents video prompts, duration, dimensions and references with a video-specific action', () => {
		expect(
			toolApprovalPresentation(
				approval('video_gen.videogen', {
					prompt: 'A bird crossing a sunset sky.',
					size: '1920x1088',
					seconds: 15,
					num_last_images_to_include: 1,
				}),
			),
		).toMatchObject({
			action: 'Generate video',
			kind: 'video',
			fields: [
				{ label: 'Prompt', value: 'A bird crossing a sunset sky.' },
				{ label: 'Size', value: '1920x1088' },
				{ label: 'Duration (seconds)', value: '15' },
				{ label: 'Recent image references', value: '1' },
			],
		});
	});
	it('preserves the exact command while resolving an explicit workdir instead of the project default', () => {
		const cmd = "printf 'a  b\\n'\ncat ./README.md\n";
		const request = approval('exec_command', {
			cmd,
			workdir: '../other',
			shell: '/bin/zsh',
			login: true,
			max_output_tokens: 20,
		});
		const before = structuredClone(request);
		expect(toolApprovalPresentation(request)).toMatchObject({
			action: 'Run command',
			command: cmd,
			directory: '/project/other',
			fields: [
				{ label: 'Shell', value: '/bin/zsh', code: true },
				{ label: 'Shell mode', value: 'Login shell' },
			],
		});
		expect(request).toEqual(before);
	});

	it('uses an absolute workdir and omits only duplicated default directory boilerplate', () => {
		const request = approval(
			'exec_command',
			{ cmd: 'pwd', workdir: '/outside/project' },
			'Allow this command or process input? It runs with your account permissions and is not isolated in an OS sandbox. Default working directory: /project/source.',
		);
		expect(toolApprovalPresentation(request)).toMatchObject({
			directory: '/outside/project',
			message: undefined,
		});
		request.message = 'Remote FreeLM client request. Delete files outside the selected project.';
		expect(toolApprovalPresentation(request).message).toBe(
			'Requested by a remote FreeLM client. Delete files outside the selected project.',
		);
	});

	it('names every affected patch path including move destinations and absolute external targets', () => {
		const patch =
			'*** Begin Patch\n*** Add File: new.txt\n+hello\n*** Delete File: ../old.txt\n*** Update File: /shared/current.txt\n*** Move to: /shared/renamed.txt\n@@\n-before\n+after\n*** End Patch';
		expect(toolApprovalPresentation(approval('apply_patch', { patch }))).toMatchObject({
			patch,
			files: [
				{ action: 'Add', path: '/project/source/new.txt' },
				{ action: 'Delete', path: '/project/old.txt' },
				{ action: 'Update', path: '/shared/current.txt' },
				{ action: 'Move to', path: '/shared/renamed.txt' },
			],
		});
	});

	it('keeps unresolved relative image paths honest when no working directory is supplied', () => {
		const request = approval('view_image', { path: 'images/diagram.png' });
		delete request.effectiveDirectory;
		expect(toolApprovalPresentation(request).fields).toEqual([
			{ label: 'Image', value: 'images/diagram.png', code: true },
		]);
	});

	it('makes process input and control actions readable without changing their arguments', () => {
		expect(
			toolApprovalPresentation(
				approval('write_stdin', { session_id: 'process-1', chars: 'hello\n' }),
			),
		).toMatchObject({
			action: 'Send process input',
			command: 'hello\n',
			fields: [{ label: 'Process', value: 'process-1', code: true }],
		});
		expect(
			toolApprovalPresentation(
				approval('write_stdin', { session_id: 'process-1', chars: '\u0003' }),
			).action,
		).toBe('Interrupt process');
		expect(
			toolApprovalPresentation(
				approval('write_stdin', { session_id: 'process-1', chars: '\u0004' }),
			).action,
		).toBe('Close process input');
	});

	it('presents unknown MCP inputs as bounded meaningful fields with truncation explicitly indicated', () => {
		const result = toolApprovalPresentation(
			approval(
				'mcp_server_write_note_abcdef123456',
				{
					path: '/notes/today.txt',
					text: 'x'.repeat(5000),
					options: { overwrite: true, tags: ['work', 'today'] },
					constructor: 'meaningful field',
				},
				'Overwrite the existing note.',
			),
		);
		expect(result).toMatchObject({
			action: 'Use server write note',
			kind: 'integration',
			message: 'Overwrite the existing note.',
		});
		expect(result.fields).toEqual([
			{ label: 'Path', value: '/notes/today.txt', code: true },
			{ label: 'Text', value: `${'x'.repeat(4096)}… [value truncated]`, code: false },
			{ label: 'Options', value: 'Overwrite: true\nTags: work\ntoday', code: false },
			{ label: 'Constructor', value: 'meaningful field', code: false },
		]);
	});
});
