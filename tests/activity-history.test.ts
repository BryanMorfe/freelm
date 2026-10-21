import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ChatActivityPart, ToolCallRecord } from '../src/agent-types';
import ActivityHistory from '../src/components/ActivityHistory';
import ToolActivityIcon from '../src/components/ActivityIcon';
import { toolActivityLabels } from '../src/lib/message-activity';

function call(id: string, path: string): ToolCallRecord {
	return {
		id,
		name: 'view_image',
		arguments: JSON.stringify({ path }),
		status: 'completed',
		startedAt: 1,
		result: {
			content: [
				{ type: 'text', text: '{"debug_marker":"private-result"}' },
				{ type: 'image', dataUrl: 'data:image/png;base64,AA==', name: path },
			],
		},
	};
}
function render(
	calls: ToolCallRecord[],
	debugMode = false,
	parts?: ChatActivityPart[],
	live = false,
) {
	return renderToStaticMarkup(
		createElement(ActivityHistory, {
			parts:
				parts ||
				calls.map((tool) => ({ type: 'tool', id: `part-${tool.id}`, toolCallId: tool.id })),
			callsById: new Map(calls.map((tool) => [tool.id, tool])),
			labels: toolActivityLabels(calls, true),
			debugMode,
			live,
		}),
	);
}

describe('completed activity history', () => {
	it('provides a compact native expandable image group with escaped paths and without duplicate assets or debug', () => {
		const html = render([
			call('first', '/fixture/<first>.png'),
			call('second', '/fixture/second image.png'),
		]);
		expect(html).toContain('<details class="activity-history-group">');
		expect(html).not.toContain(' open="');
		expect(html).toContain('<span>Viewed 2 images</span>');
		expect(html).toContain('Viewed an image: /fixture/&lt;first&gt;.png');
		expect(html).toContain('Viewed an image: /fixture/second image.png');
		expect(html).toContain('data-tool-id="first"');
		expect(html).toContain('data-tool-id="second"');
		expect(html).not.toContain('<img');
		expect(html).not.toContain('Tool details');
		expect(html).not.toContain('debug_marker');
	});
	it('groups completed neighbors during live work while keeping the current call separate and shimmering', () => {
		const active = {
			...call('current', '/fixture/current.png'),
			status: 'running' as const,
			result: undefined,
		};
		const html = render(
			[call('first', '/fixture/first.png'), call('second', '/fixture/second.png'), active],
			false,
			undefined,
			true,
		);
		expect(html).toContain('<span>Viewed 2 images</span>');
		expect(html.indexOf('data-tool-id="second"')).toBeLessThan(
			html.indexOf('data-tool-id="current"'),
		);
		expect(html).toContain('Viewing an image: /fixture/current.png');
		expect(html.match(/activity-shimmer/g)).toHaveLength(1);
		expect(html).toContain('role="status" aria-live="polite"');
	});
	it('shows the path on a single image row without adding a second disclosure', () => {
		const html = render([call('one', '/fixture/photo.png')]);
		expect(html).toContain('Viewed an image: /fixture/photo.png');
		expect(html).not.toContain('<details');
		expect(html).not.toContain('<img');
	});
	it('keeps a failure separate and visibly unsuccessful, in original order', () => {
		const failed = { ...call('failed', '/fixture/missing.png'), status: 'failed' as const };
		const html = render([
			call('before', '/fixture/before.png'),
			failed,
			call('after', '/fixture/after.png'),
		]);
		expect(html).not.toContain('activity-history-group');
		expect(html).toContain('Could not view an image: /fixture/missing.png');
		expect(html).toContain('data-activity-state="failed"');
		expect(html).not.toContain('<small>failed</small>');
		expect(html.indexOf('data-tool-id="before"')).toBeLessThan(
			html.indexOf('data-tool-id="failed"'),
		);
		expect(html.indexOf('data-tool-id="failed"')).toBeLessThan(
			html.indexOf('data-tool-id="after"'),
		);
	});
	it('keeps raw result and argument details behind the explicit Debug setting', () => {
		const html = render(
			[call('first', '/fixture/first.png'), call('second', '/fixture/second.png')],
			true,
		);
		expect(html).toContain('Viewed 2 images');
		expect(html.match(/Tool details/g)).toHaveLength(2);
		expect(html).toContain('debug_marker');
		expect(html).not.toContain('<img');
	});
	it('preserves white intermediate assistant prose between groups', () => {
		const calls = [
			call('first', '/fixture/first.png'),
			call('second', '/fixture/second.png'),
			call('third', '/fixture/third.png'),
			call('fourth', '/fixture/fourth.png'),
		];
		const parts: ChatActivityPart[] = calls.map((tool) => ({
			type: 'tool',
			id: `part-${tool.id}`,
			toolCallId: tool.id,
		}));
		parts.splice(2, 0, { type: 'text', id: 'explanation', text: 'Now comparing the next pair.' });
		const html = render(calls, false, parts);
		expect(html.match(/<span>Viewed 2 images<\/span>/g)).toHaveLength(2);
		expect(html).toContain('class="thought-assistant-message"');
		expect(html).toContain('Now comparing the next pair.');
		expect(html.indexOf('data-tool-id="second"')).toBeLessThan(
			html.indexOf('data-activity-id="explanation"'),
		);
		expect(html.indexOf('data-activity-id="explanation"')).toBeLessThan(
			html.indexOf('data-tool-id="third"'),
		);
	});
	it('uses the outlined square terminal icon for execution rows', () => {
		const html = renderToStaticMarkup(
			createElement(ToolActivityIcon, { call: { ...call('command', ''), name: 'exec_command' } }),
		);
		expect(html).toContain('lucide-square-terminal');
		expect(html).toContain('data-activity-icon="terminal"');
		expect(html).toContain('<rect');
	});
});
