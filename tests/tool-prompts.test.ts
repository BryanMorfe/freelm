import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ToolApproval } from '../src/agent-types';
import { InlineToolApprovals } from '../src/components/InlineToolApprovals';
import { ToolPrompts } from '../src/components/ToolPrompts';

interface ElementProps {
	children?: ReactNode;
	onClick?: () => void;
	type?: string;
	role?: string;
	autoFocus?: boolean;
	onKeyDown?: unknown;
}

function elements(node: ReactNode): ReactElement<ElementProps>[] {
	if (Array.isArray(node)) return node.flatMap(elements);
	if (!isValidElement<ElementProps>(node)) return [];
	return [node, ...elements(node.props.children)];
}
function text(node: ReactNode): string {
	if (Array.isArray(node)) return node.map(text).join('');
	if (isValidElement<ElementProps>(node)) return text(node.props.children);
	return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
}
const approval: ToolApproval = {
	id: 'approval-one',
	runId: 'run-one',
	threadId: 'task-one',
	name: 'exec_command',
	arguments: { cmd: 'cat README.md', workdir: '/fixture/source', yield_time_ms: 1000 },
	effectiveDirectory: '/fixture/source',
	message: 'Read the README in the selected project.',
	rememberLabel: 'Allow this action for this task',
};

describe('inline tool approvals', () => {
	it('announces pending work without a modal, autofocus, or keyboard approval handler', () => {
		const onApprove = vi.fn();
		const tree = InlineToolApprovals({ approvals: [approval], onApprove });
		const html = renderToStaticMarkup(tree);
		expect(html).toContain('aria-label="Pending tool approvals"');
		expect(html).toContain('role="status"');
		expect(html).toContain('Approval needed');
		expect(html).toContain('class="inline-approval-status"');
		expect(html).not.toContain('role="dialog"');
		expect(html).not.toContain('aria-modal');
		expect(html).not.toContain('tool-prompt-backdrop');
		expect(elements(tree).some((element) => element.props.autoFocus)).toBe(false);
		expect(elements(tree).some((element) => element.props.onKeyDown)).toBe(false);
		expect(onApprove).not.toHaveBeenCalled();
	});

	it('keeps the complete proposed action visible as escaped text even when Debug is off', () => {
		const marker = 'LAST_ACTION_LINE';
		const fullCommand = `echo '<script>alert(1)</script>'\n${'x'.repeat(12000)}\n${marker}`;
		const html = renderToStaticMarkup(
			createElement(InlineToolApprovals, {
				approvals: [{ ...approval, arguments: { cmd: fullCommand } }],
				onApprove: vi.fn(),
			}),
		);
		expect(html).toContain('Working directory');
		expect(html).toContain('/fixture/source');
		expect(html).toContain('Read the README in the selected project.');
		expect(html).toContain(marker);
		expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
		expect(html).not.toContain('<script>');
		expect(html).toContain('tabindex="0"');
		expect(html).toContain('aria-label="Command to run"');
		expect(html).toContain('<code>');
		expect(html).not.toContain('Arguments for exec_command');
		expect(html).not.toContain('&quot;cmd&quot;');
		expect(html).not.toContain('yield_time_ms');
	});

	it('exposes raw arguments only behind explicit Debug mode', () => {
		const html = renderToStaticMarkup(
			createElement(InlineToolApprovals, {
				approvals: [approval],
				onApprove: vi.fn(),
				debugMode: true,
			}),
		);
		expect(html).toContain('<summary>Debug arguments</summary>');
		expect(html).toContain('aria-label="Arguments for exec_command"');
		expect(html).toContain('&quot;yield_time_ms&quot;');
	});

	it('shows a resolved image path and a specific scope message without arguments JSON', () => {
		const html = renderToStaticMarkup(
			createElement(InlineToolApprovals, {
				approvals: [
					{
						...approval,
						name: 'view_image',
						arguments: { path: '../reference/Diagram.png' },
						message: 'Read an image outside the project directory.',
					},
				],
				onApprove: vi.fn(),
			}),
		);
		expect(html).toContain('Read image');
		expect(html).toContain('<code>/fixture/reference/Diagram.png</code>');
		expect(html).toContain('Read an image outside the project directory.');
		expect(html).not.toContain('Arguments for view_image');
	});

	it('describes affected files and keeps the actual patch available separately from raw arguments', () => {
		const html = renderToStaticMarkup(
			createElement(InlineToolApprovals, {
				approvals: [
					{
						...approval,
						name: 'apply_patch',
						arguments: {
							patch:
								'*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n@@\n-before\n+after\n*** End Patch',
						},
						message: 'Allow this tool action? Review its arguments before continuing.',
					},
				],
				onApprove: vi.fn(),
			}),
		);
		expect(html).toContain('aria-label="Affected files"');
		expect(html).toContain('<span>Update</span><code>/fixture/source/old.txt</code>');
		expect(html).toContain('<span>Move to</span><code>/fixture/source/new.txt</code>');
		expect(html).toContain('<summary>View changes</summary>');
		expect(html).toContain('aria-label="Proposed patch"');
		expect(html).not.toContain('Review its arguments');
		expect(html).not.toContain('&quot;patch&quot;');
	});

	it('keeps stopping available once for all queued approvals without granting any action', () => {
		const onStop = vi.fn(),
			onApprove = vi.fn();
		const tree = InlineToolApprovals({
			approvals: [approval, { ...approval, id: 'second' }],
			onApprove,
			onStop,
		});
		const buttons = elements(tree).filter((element) => element.type === 'button');
		const stop = buttons.filter((button) => text(button) === '');
		expect(stop).toHaveLength(1);
		stop[0].props.onClick?.();
		expect(onStop).toHaveBeenCalledOnce();
		expect(onApprove).not.toHaveBeenCalled();
		expect(renderToStaticMarkup(tree)).toContain('2 approvals needed');
		expect(renderToStaticMarkup(tree)).toContain('aria-label="Stop response"');
	});

	it('routes each explicit decision to the exact approval ID without submitting the composer', () => {
		const onApprove = vi.fn();
		const tree = InlineToolApprovals({
			approvals: [approval, { ...approval, id: 'approval-two' }],
			onApprove,
		});
		const target = elements(tree).find((element) => element.key === 'approval-two');
		const buttons = elements(target).filter((element) => element.type === 'button');
		for (const button of buttons) expect(button.props.type).toBe('button');
		for (const label of ['Allow once', 'Allow this action for this task', 'Decline']) {
			buttons.find((button) => text(button) === label)?.props.onClick?.();
		}
		expect(onApprove.mock.calls).toEqual([
			['approval-two', true],
			['approval-two', true, true],
			['approval-two', false],
		]);
	});

	it('omits a remembered grant when the host does not offer one', () => {
		const tree = InlineToolApprovals({
			approvals: [{ ...approval, rememberLabel: undefined }],
			onApprove: vi.fn(),
		});
		const buttons = elements(tree).filter((element) => element.type === 'button');
		expect(buttons.map(text)).toEqual(['Allow once', 'Decline']);
	});

	it('renders nothing after all pending approvals resolve', () => {
		expect(InlineToolApprovals({ approvals: [], onApprove: vi.fn() })).toBeNull();
	});
});

describe('structured assistant questions', () => {
	it('keeps Code questions non-modal, controlled and inactive without answering or taking composer focus', () => {
		const answer = vi.fn();
		const onAnswersChange = vi.fn();
		const props = {
			questions: {
				id: 'question-request',
				questions: [{ id: 'scope', question: 'Which files should I update?', options: [] }],
				answer,
			},
			answers: { scope: 'Preserve this answer while I queue a follow-up.' },
			onAnswersChange,
		};
		const html = renderToStaticMarkup(createElement(ToolPrompts, props));
		expect(html).toContain('role="region"');
		expect(html).toContain('aria-label="Assistant question"');
		expect(html).toContain('Preserve this answer while I queue a follow-up.');
		expect(html).not.toContain('role="dialog"');
		expect(html).not.toContain('aria-modal');
		expect(html).not.toContain('tool-prompt-backdrop');
		expect(html).not.toContain('autofocus');
		const inactive = renderToStaticMarkup(createElement(ToolPrompts, { ...props, active: false }));
		expect(inactive).toContain('aria-label="Assistant question" hidden=""');
		expect(inactive).toContain('Preserve this answer while I queue a follow-up.');
		expect(answer).not.toHaveBeenCalled();
		expect(onAnswersChange).not.toHaveBeenCalled();
	});
	it('always uses a question sheet with choices and an editable answer', () => {
		const html = renderToStaticMarkup(
			createElement(ToolPrompts, {
				questions: {
					id: 'question-request',
					questions: [
						{
							id: 'scope',
							question: 'Which files should I update?',
							options: [{ label: 'Parser', description: 'Update only the parser.' }],
						},
					],
					answer: vi.fn(),
				},
			}),
		);
		expect(html).toContain('role="region"');
		expect(html).not.toContain('role="dialog"');
		expect(html).not.toContain('aria-modal');
		expect(html).not.toContain('tool-prompt-backdrop');
		expect(html).toContain('Minimize question');
		expect(html).toContain('aria-label="Assistant question"');
		expect(html).toContain('Which files should I update?');
		expect(html).toContain('Update only the parser.');
		expect(html).toContain('aria-label="Your answer: Which files should I update?"');
		expect(html).not.toContain('Allow once');
	});

	it('does not open a question dialog when only an approval is pending elsewhere', () => {
		expect(renderToStaticMarkup(createElement(ToolPrompts))).toBe('');
	});
});
