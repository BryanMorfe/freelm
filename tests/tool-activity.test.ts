import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import ToolActivity, { ToolCallActivity } from '../src/components/ToolActivity';
import { ApprovalDeniedDetails } from '../src/components/ApprovalDeniedActivity';
import type { ToolCallRecord } from '../src/agent-types';
import { toolActivityDetails } from '../src/components/ToolActivityDetails';

const command: ToolCallRecord = {
	id: 'command',
	name: 'exec_command',
	arguments: JSON.stringify({ cmd: 'pwd', workdir: '/fixture/private-project' }),
	status: 'completed',
	startedAt: 1,
	result: { content: [{ type: 'text', text: '{"debug_output_marker":"private-tool-result"}' }] },
};

function render(
	call: ToolCallRecord,
	options: { debugMode?: boolean; hideImages?: boolean; assetsOnly?: boolean } = {},
) {
	return renderToStaticMarkup(createElement(ToolCallActivity, { call, ...options }));
}

describe('tool activity from model arguments', () => {
	it.each(['computer_act', 'web.run', 'exec_command', 'mcp_fixture_tool'])(
		'provides readable expanded %s errors while preserving the raw debug record',
		(name) => {
			const raw =
				"Error invoking remote method 'freelm:tool-execute': ToolExecutionError: The request could not complete. Try again.\n    at execute (/private/host.ts:12:5)";
			const call: ToolCallRecord = {
				...command,
				name,
				status: 'failed',
				result: { isError: true, content: [{ type: 'text', text: raw }] },
			};
			const content = toolActivityDetails(call, {})?.content;
			expect(content).toBeTruthy();
			const html = renderToStaticMarkup(content);
			expect(html).toContain('The request could not complete. Try again.');
			expect(html).not.toContain('Error invoking remote method');
			expect(html).not.toContain('ToolExecutionError');
			expect(html).not.toContain('/private/host.ts');
			expect(render(call, { debugMode: true })).toContain('ToolExecutionError');
			expect(call.result?.content[0]).toEqual({ type: 'text', text: raw });
		},
	);
	it('does not rewrite process output or expose it as an exception', () => {
		const raw = 'Error: a literal program log\n    at worker (/project/example.js:5:2)';
		const call: ToolCallRecord = {
			...command,
			status: 'failed',
			result: {
				isError: true,
				process: { command: 'pwd', sessionId: 'process', exitCode: 1 },
				content: [{ type: 'text', text: raw }],
			},
		};
		expect(toolActivityDetails(call, { cmd: 'pwd' })).toBeUndefined();
		expect(render(call, { debugMode: true })).toContain(raw);
		expect(call.result?.content[0]).toEqual({ type: 'text', text: raw });
	});
	it('cleans reviewer exceptions but preserves the exact requested command', () => {
		const html = renderToStaticMarkup(
			createElement(ApprovalDeniedDetails, {
				call: command,
				args: { cmd: 'printf "Error: example"' },
				denial: {
					reason:
						"Error invoking remote method 'freelm:review': ReviewError: Reviewer unavailable.\n    at review (/private/review.ts:2:1)",
					permissionMode: 'auto-review',
				},
			}),
		);
		expect(html).toContain('Reviewer unavailable.');
		expect(html).toContain('Error: example');
		expect(html).not.toContain('Error invoking remote method');
		expect(html).not.toContain('ReviewError');
		expect(html).not.toContain('/private/review.ts');
	});
	it.each(['null', '[]', '"not an object"', '{"plan":[null]}'])(
		'renders malformed arguments %s while the host rejects the call',
		(args) => {
			expect(() =>
				renderToStaticMarkup(
					createElement(ToolActivity, {
						calls: [
							{
								id: 'malformed',
								name: 'update_plan',
								arguments: args,
								status: 'running',
								startedAt: 1,
							},
						],
					}),
				),
			).not.toThrow();
		},
	);
	it('shows a plain expandable completed tool label without raw data by default', () => {
		const markup = render(command);
		expect(markup).toContain('class="activity-label" aria-expanded="false"');
		expect(markup).toContain('aria-label="Expand command: Ran pwd"');
		expect(markup).toContain('>Ran pwd</span>');
		expect(markup).toContain('data-activity-state="completed"');
		expect(markup).toContain('data-details="true"');
		expect(markup).toContain('data-activity-icon="terminal" aria-hidden="true" focusable="false"');
		for (const hidden of [
			'<details',
			'<summary',
			'<pre',
			'>Done<',
			'/fixture/private-project',
			'debug_output_marker',
		])
			expect(markup).not.toContain(hidden);
	});
	it('shows the active command as escaped text in the shimmer, preserving shell whitespace', () => {
		const markup = renderToStaticMarkup(
			createElement(ToolCallActivity, {
				call: {
					...command,
					status: 'running',
					arguments: JSON.stringify({ cmd: 'printf "a  b"\ncat <input.txt' }),
				},
				live: true,
			}),
		);
		expect(markup).toContain('activity-shimmer');
		expect(markup).toContain('data-activity-state="active"');
		expect(markup).toContain('Running printf &quot;a  b&quot;\ncat &lt;input.txt</span>');
		expect(markup).not.toContain('<details');
	});
	it('exposes tool arguments and results only when Debug mode is explicitly enabled', () => {
		const markup = render(command, { debugMode: true });
		expect(markup).toContain('<details');
		expect(markup).toContain('Tool details');
		expect(markup).toContain('tool-arguments');
		expect(markup).toContain('/fixture/private-project');
		expect(markup).toContain('tool-output');
		expect(markup).toContain('debug_output_marker');
		expect(markup).toContain('private-tool-result');
	});
	it('formats the original command when a process poll provides a resolved label', () => {
		const markup = renderToStaticMarkup(
			createElement(ToolCallActivity, {
				call: { ...command, name: 'write_stdin', arguments: '{"session_id":"one"}' },
				label: 'Ran printf "hello"',
			}),
		);
		expect(markup).toContain('Ran printf &quot;hello&quot;</span>');
		expect(markup).not.toContain('<code');
	});
	it('keeps a valid plan collapsed behind its own disclosure, independently of Debug', () => {
		const plan: ToolCallRecord = {
			...command,
			name: 'update_plan',
			arguments: JSON.stringify({
				explanation: 'First inspect the current behavior.',
				plan: [
					{ step: 'Inspect the project.', status: 'completed' },
					{ step: 'Implement the update.', status: 'in_progress' },
				],
			}),
		};
		const markup = render(plan);
		expect(markup).toContain('aria-label="Expand plan: Updated the plan"');
		expect(markup).toContain('aria-expanded="false"');
		expect(markup).toContain('class="activity-details" hidden=""');
		expect(markup).not.toContain('Inspect the project.');
		expect(markup).not.toContain('First inspect the current behavior.');
		expect(markup).not.toContain('tool-plan');
		expect(markup).not.toContain('Tool details');
		expect(render(plan, { debugMode: true })).toContain('Tool details');
	});
	it.each(['exec_command', 'write_stdin'])(
		'keeps missing %s commands as a plain fallback',
		(name) => {
			const markup = render({ ...command, name, arguments: '{}', status: 'running' });
			expect(markup).toContain(
				name === 'exec_command' ? 'Running a command' : 'Interacting with a process',
			);
			expect(markup).not.toContain('<code');
			expect(markup).not.toContain('<button');
			expect(markup).not.toContain('aria-expanded');
			expect(markup).not.toContain('data-activity-icon');
		},
	);
	it.each(['{}', '{"plan":[]}'])('does not offer an empty plan disclosure for %s', (args) => {
		const markup = render({ ...command, name: 'update_plan', arguments: args });
		expect(markup).toContain('Updated the plan');
		expect(markup).toContain('activity-label-static');
		expect(markup).not.toContain('<button');
		expect(markup).not.toContain('aria-expanded');
	});
	it('keeps unknown integration status noninteractive without revealing private result text', () => {
		const markup = render({ ...command, name: 'mcp_fixture_status', arguments: '{}' });
		expect(markup).not.toContain('<button');
		expect(markup).not.toContain('aria-expanded');
		expect(markup).not.toContain('debug_output_marker');
	});
	it('shows an ordinary failure without mislabeling it as an approval denial', () => {
		const markup = render({
			...command,
			status: 'failed',
			result: { ...command.result!, isError: true },
		});
		expect(markup).toContain('data-tool-status="failed"');
		expect(markup).toContain('data-activity-state="failed"');
		expect(markup).toContain('Could not run pwd');
		expect(markup).not.toMatch(/>failed</i);
		expect(markup).not.toContain('activity-shimmer');
		expect(markup).not.toContain('<details');
		expect(markup).not.toContain('private-tool-result');
		expect(markup).not.toContain('Approval denied');
	});
	it('presents a completed error result as failed without a duplicate status badge', () => {
		const markup = render({
			...command,
			result: { ...command.result!, isError: true },
		});
		expect(markup).toContain('data-tool-status="completed"');
		expect(markup).toContain('data-activity-state="failed"');
		expect(markup).toContain('Could not run pwd');
		expect(markup).not.toContain('>failed<');
	});
	it('keeps failed process-poll command details available from the resolved label', () => {
		const markup = renderToStaticMarkup(
			createElement(ToolCallActivity, {
				call: {
					...command,
					name: 'write_stdin',
					arguments: '{"session_id":"one"}',
					status: 'failed',
				},
				label: 'Could not run printf "hello"',
			}),
		);
		expect(markup).toContain('aria-label="Expand command: Could not run printf &quot;hello&quot;"');
		expect(markup).toContain('data-details="true"');
	});
	it('replaces failed authorization with one concise expandable denial and no shimmer', () => {
		const reason = 'The action sends private project content to an unrequested destination.';
		const markup = render({
			...command,
			status: 'failed',
			result: {
				...command.result!,
				isError: true,
				approvalDenied: { reason, permissionMode: 'auto-review' },
			},
		});
		expect(markup).toContain('data-tool-status="denied"');
		expect(markup).toContain('class="approval-denied-activity"');
		expect(markup).toContain('aria-label="Approval denied"');
		expect(markup).toContain('data-activity-icon="approval-denied"');
		expect(markup.match(/data-tool-id="command"/g)).toHaveLength(1);
		for (const hidden of [
			reason,
			'Ran pwd',
			'>failed<',
			'/fixture/private-project',
			'debug_output_marker',
			'approval-denied-details',
			'activity-shimmer',
		])
			expect(markup).not.toContain(hidden);
	});
	it('distinguishes an unavailable reviewer from a denied action with Debug off', () => {
		const markup = render({
			...command,
			status: 'failed',
			result: {
				content: [],
				isError: true,
				approvalReviewError: {
					reason: 'Review service unavailable.',
					code: 'unavailable',
					attempts: 3,
					permissionMode: 'auto-review',
				},
			},
		});
		expect(markup).toContain('aria-label="Approval review failed"');
		expect(markup).toContain('data-tool-status="failed"');
		expect(markup).not.toContain('Approval denied');
		expect(markup).not.toContain('activity-shimmer');
	});
	it('keeps explicit and saved legacy denials expandable with Debug off', () => {
		for (const call of [
			{ ...command, status: 'denied' as const, result: { ...command.result!, isError: true } },
			{
				...command,
				status: 'failed' as const,
				result: {
					isError: true,
					content: [
						{
							type: 'text' as const,
							text: 'User declined the request. Do not retry this action without a new user request.',
						},
					],
				},
			},
		]) {
			const markup = render(call);
			expect(markup).toContain('class="approval-denied-activity"');
			expect(markup).not.toContain('tool-debug-details');
		}
	});
	it('exposes raw denial arguments and result JSON only in Debug', () => {
		const call = {
			...command,
			status: 'denied' as const,
			result: { ...command.result!, isError: true },
		};
		expect(render(call, { debugMode: true })).toContain('debug_output_marker');
		expect(render(call)).not.toContain('debug_output_marker');
	});
	it('presents the reviewer reason, exact command and directory as escaped readable content', () => {
		const cmd = 'printf "two  spaces"\ncat <README.md';
		const markup = renderToStaticMarkup(
			createElement(ApprovalDeniedDetails, {
				call: command,
				args: { cmd, workdir: '../other' },
				denial: {
					reason: 'Denied <script>invalid()</script>\nPlease review the destination.',
					permissionMode: 'auto-review',
					effectiveDirectory: '/project/source',
				},
			}),
		);
		expect(markup).toContain('Automatic review');
		expect(markup).toContain('Denied &lt;script&gt;invalid()&lt;/script&gt;');
		expect(markup).toContain('Run command');
		expect(markup).toContain('/project/other');
		expect(markup).toContain('printf &quot;two  spaces&quot;\ncat &lt;README.md');
		expect(markup).not.toContain('<script>');
		expect(markup).not.toContain('debug_output_marker');
		expect(markup).not.toContain('tool-arguments');
	});
	it('describes denied edits as requested changes without pretending the files were edited', () => {
		const patch =
			'*** Begin Patch\n*** Update File: source.txt\n@@\n-before\n+after\n*** End Patch';
		const markup = renderToStaticMarkup(
			createElement(ApprovalDeniedDetails, {
				call: { ...command, name: 'functions.apply_patch' },
				args: { patch },
				denial: { reason: 'The requested edit was not approved.', effectiveDirectory: '/project' },
			}),
		);
		expect(markup).toContain('Requested action');
		expect(markup).toContain('Edit files');
		expect(markup).toContain('Update');
		expect(markup).toContain('/project/source.txt');
		expect(markup).toContain('-before\n+after');
		expect(markup).not.toContain('Edited ');
	});
	it('checks image-generation denials before asset rendering and never duplicates them beside assets', () => {
		const image = {
			...command,
			name: 'image_gen.imagegen',
			status: 'denied' as const,
			arguments: '{"prompt":"A landscape"}',
			result: {
				isError: true,
				approvalDenied: { reason: 'Image upload was not authorized.' },
				content: [{ type: 'text' as const, text: 'Image upload was not authorized.' }],
			},
		};
		expect(render(image)).toContain('class="approval-denied-activity"');
		expect(render(image)).not.toContain('chat-image');
		expect(render(image, { assetsOnly: true })).toBe('');
	});
	it('keeps image generation metadata in Debug history and never beside the generated asset', () => {
		const image: ToolCallRecord = {
			...command,
			name: 'image_gen.imagegen',
			arguments: JSON.stringify({ prompt: 'Europa above a dark ocean', size: '1024x768' }),
			result: {
				content: [
					{ type: 'text', text: '{"image_metadata_marker":"private-generation-result"}' },
					{ type: 'image', dataUrl: 'data:image/png;base64,AA==', name: 'europa.png' },
				],
			},
		};
		const history = render(image, { hideImages: true });
		expect(history).toContain('Generated an image');
		expect(history).not.toContain('<img');
		expect(history).not.toContain('image_metadata_marker');
		expect(history).not.toContain('<details');
		const debugHistory = render(image, { hideImages: true, debugMode: true });
		expect(debugHistory).toContain('Tool details');
		expect(debugHistory).toContain('image_metadata_marker');
		expect(debugHistory).not.toContain('<img');
		const asset = render(image, { assetsOnly: true, debugMode: true });
		expect(asset).toContain('alt="europa.png"');
		expect(asset).not.toContain('image_metadata_marker');
		expect(asset).not.toContain('Tool details');
		expect(asset).not.toContain('data-activity-icon');
	});
});
