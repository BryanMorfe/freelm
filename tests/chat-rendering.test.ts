import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import ChatMessage from '../src/components/ChatMessage';
import ChatImageResult from '../src/components/ChatImageResult';
import type { ConversationKind, Message } from '../src/types';
import type { ToolCallRecord } from '../src/agent-types';

const command: ToolCallRecord = {
	id: 'command',
	name: 'exec_command',
	arguments: '{"cmd":"pwd"}',
	status: 'completed',
	startedAt: 1,
	result: { content: [{ type: 'text', text: '/fixture/project' }] },
};
const update: ToolCallRecord = {
	id: 'update',
	name: 'send_message_to_user_async',
	arguments: '{"message":"The **inspection** is complete."}',
	status: 'completed',
	startedAt: 2,
	result: { content: [{ type: 'text', text: 'The **inspection** is complete.' }] },
};
const image: ToolCallRecord = {
	...command,
	id: 'image',
	name: 'image_gen.imagegen',
	arguments: '{"prompt":"a galaxy","size":"1024x1024"}',
	result: {
		content: [{ type: 'image', dataUrl: 'data:image/png;base64,AA==', name: 'galaxy.png' }],
	},
};
function render(message: Partial<Message>, live = false, kind: ConversationKind = 'chat') {
	return renderToStaticMarkup(
		createElement(ChatMessage, {
			message: { id: 'answer', role: 'assistant', content: '', createdAt: 1000, ...message },
			modelId: 'fixture',
			modelName: 'Fixture model',
			live,
			conversationKind: kind,
			retryDisabled: false,
		}),
	);
}
const timeline: Partial<Message> = {
	content: 'I will inspect the project.\n\nThe result follows.\n\n**Finished.**',
	toolCalls: [command, update],
	completedAt: 16000,
	activityFinishedAt: 12000,
	activity: [
		{ type: 'text', id: 'first', text: 'I will inspect the project.' },
		{ type: 'tool', id: 'run', toolCallId: 'command' },
		{ type: 'text', id: 'middle', text: 'The result follows.' },
		{ type: 'tool', id: 'progress', toolCallId: 'update' },
		{ type: 'text', id: 'last', text: '**Finished.**' },
	],
};

describe('chat message rendering', () => {
	it.each(['chat', 'code'] as const)(
		'cleans persisted %s errors without rewriting assistant prose or code',
		(kind) => {
			const error =
				"Error invoking remote method 'freelm:tool-execute': MediaModerationError: Select an evaluator in Settings.\n    at evaluate (/private/host.ts:12:5)";
			const content =
				'The literal message is `Error: intentional example`.\n\n```js\nthrow new Error("example");\n```';
			const html = render({ content, error, completedAt: 5000 }, false, kind);
			expect(html).toContain('role="alert">Select an evaluator in Settings.</div>');
			expect(html).not.toContain('Error invoking remote method');
			expect(html).not.toContain('MediaModerationError');
			expect(html).not.toContain('/private/host.ts');
			expect(html).toContain('Error: intentional example');
			expect(html.replace(/<[^>]*>/g, '')).toContain('new Error');
		},
	);
	it.each(['chat', 'code'] as const)(
		'shows an image moderation warning outside collapsed %s tool details with Debug off',
		(kind) => {
			const warning =
				'Image moderation is enabled, but its evaluator is unavailable. Generation proceeds without image moderation.';
			const warnedImage: ToolCallRecord = {
				...image,
				result: { ...image.result!, moderationWarnings: [warning] },
			};
			const html = render(
				{
					content: 'Here is the image.',
					toolCalls: [command, warnedImage],
					activityFinishedAt: 12000,
					completedAt: 16000,
				},
				false,
				kind,
			);
			expect(html).toContain('aria-expanded="false"');
			expect(html).toContain('aria-label="Moderation warning"');
			expect(html).toContain(warning);
			expect(html).toContain('alt="galaxy.png"');
			expect(html).not.toContain('thought-history');
			expect(html).not.toContain('tool-debug');
		},
	);
	it('renders image warnings as plain text while preserving generated assets', () => {
		const warning =
			'Generation proceeds without image moderation. <script>alert("not markup")</script>';
		const html = renderToStaticMarkup(
			createElement(ChatImageResult, {
				call: { ...image, result: { ...image.result!, moderationWarnings: [warning] } },
				args: { prompt: 'a galaxy', size: '1024x1024' },
				live: false,
			}),
		);
		expect(html).toContain('role="status" aria-label="Moderation warning"');
		expect(html).toContain('&lt;script&gt;');
		expect(html).not.toContain('<script>');
		expect(html).toContain('alt="galaxy.png"');
	});
	it('omits moderation notices for ordinary image results with no warning metadata', () => {
		const html = render({ content: 'Here is the image.', toolCalls: [image], completedAt: 4000 });
		expect(html).toContain('alt="galaxy.png"');
		expect(html).not.toContain('Moderation warning');
		expect(html).not.toContain('moderation-notice');
	});
	it('places completed Code file edits after the final answer and before message actions', () => {
		const patch: ToolCallRecord = {
			id: 'edit',
			name: 'apply_patch',
			arguments: JSON.stringify({
				patch: '*** Begin Patch\n*** Update File: src/app.ts\n@@\n-before\n+after\n*** End Patch',
			}),
			status: 'completed',
			startedAt: 1500,
			result: { content: [{ type: 'text', text: 'Applied patch:\nM src/app.ts' }] },
		};
		const message = { content: 'The change is ready.', toolCalls: [patch], completedAt: 4000 };
		const html = render(message, false, 'code');
		expect(html).toContain('Edited 1 file');
		expect(html).toContain('src/');
		expect(html).toContain('app.ts');
		expect(html.indexOf('file-edit-summary')).toBeGreaterThan(html.indexOf('The change is ready.'));
		expect(html.indexOf('file-edit-summary')).toBeLessThan(html.indexOf('message-footer'));
		// Local changes belong to Code and appear only when its response has stopped streaming.
		expect(render(message, false, 'chat')).not.toContain('file-edit-summary');
		expect(render(message, true, 'code')).not.toContain('file-edit-summary');
		expect(render({ ...message, role: 'user' }, false, 'code')).not.toContain('file-edit-summary');
	});
	it('retains applied file edits after cancellation but does not claim failed patches were applied', () => {
		const patch: ToolCallRecord = {
			id: 'edit',
			name: 'apply_patch',
			arguments: JSON.stringify({
				patch: '*** Begin Patch\n*** Add File: note.md\n+note\n*** End Patch',
			}),
			status: 'completed',
			startedAt: 1500,
			result: { content: [] },
		};
		expect(render({ interrupted: true, toolCalls: [patch] }, false, 'code')).toContain(
			'Edited 1 file',
		);
		expect(render({ toolCalls: [{ ...patch, status: 'failed' }] }, false, 'code')).not.toContain(
			'file-edit-summary',
		);
	});
	it.each(['chat', 'code'] as const)(
		'shows plain shimmering compaction progress in %s without exposing the checkpoint',
		(kind) => {
			const html = render({ phase: 'compacting' }, true, kind);
			expect(html).toContain('aria-label="Compacting conversation"');
			expect(html).toContain('class="activity-shimmer">Compacting context');
			expect(html).not.toContain('Generating response');
			if (kind === 'code') expect(html).toContain('working-section-header');
			else expect(html).not.toContain('Working for');
			expect(html).not.toContain('>Thinking<');
		},
	);
	it.each(['chat', 'code'] as const)(
		'marks only the final %s answer as eligible for selection replies',
		(kind) => {
			const html = render({ ...timeline, phase: 'responding' }, true, kind);
			const scope = 'data-reply-scope="assistant-final"';
			expect(html.split(scope)).toHaveLength(2);
			expect(html.indexOf('I will inspect the project.')).toBeLessThan(html.indexOf(scope));
			expect(html.indexOf('The result follows.')).toBeLessThan(html.indexOf(scope));
			expect(html.indexOf('The <strong>inspection</strong> is complete.')).toBeLessThan(
				html.indexOf(scope),
			);
			expect(html.indexOf('<strong>Finished.</strong>')).toBeGreaterThan(html.indexOf(scope));
			expect(render({ role: 'user', content: 'The user prompt.' }, false, kind)).not.toContain(
				scope,
			);
			expect(render({ phase: 'working' }, true, kind)).not.toContain(scope);
			expect(
				render(
					{
						content: 'I will create the image.',
						phase: 'tools',
						toolCalls: [image],
						activity: [
							{ type: 'text', id: 'intermediate', text: 'I will create the image.' },
							{ type: 'tool', id: 'image', toolCallId: image.id },
						],
					},
					false,
					kind,
				),
			).not.toContain(scope);
		},
	);
	it.each(['chat', 'code'] as const)(
		'keeps the %s final answer unseparated while its activity is collapsed or empty',
		(kind) => {
			const collapsed = render(timeline, false, kind);
			expect(collapsed).toContain('aria-expanded="false"');
			expect(collapsed).not.toContain('thought-output-divider');
			const plain = render({ content: 'The final answer.', completedAt: 4_000 }, false, kind);
			expect(plain).not.toContain('thought-output-divider');
			expect(plain).toContain('The final answer.');
		},
	);
	it('keeps the assistant send time together with its completed message actions', () => {
		const createdAt = new Date(2026, 9, 1, 20, 20).getTime();
		const html = render(
			{
				content: 'The timestamped answer.',
				phase: 'responding',
				createdAt,
				completedAt: createdAt + 5 * 60_000,
			},
			false,
		);
		expect(html).toContain(
			`class="message-time" dateTime="${new Date(createdAt).toISOString()}">8:20 PM</time>`,
		);
		expect(html.indexOf('class="message-time"')).toBeGreaterThan(
			html.indexOf('The timestamped answer.'),
		);
		expect(html.split('class="message-time"')).toHaveLength(2);
		expect(html.indexOf('class="message-footer"')).toBeLessThan(
			html.indexOf('class="message-time"'),
		);
		expect(html).toContain('class="message-actions"');
	});
	it.each(['working', 'responding', 'tools'] as const)(
		'omits the entire assistant footer while the response is %s',
		(phase) => {
			const html = render({ content: 'Streaming answer.', phase }, true);
			for (const footer of ['message-footer', 'message-actions', 'message-time'])
				expect(html).not.toContain(`class="${footer}"`);
		},
	);
	it('does not show an orphan timestamp for an empty assistant message', () => {
		expect(render({ interrupted: true })).not.toContain('class="message-footer"');
	});
	it('omits invalid assistant timestamps and leaves user dates to the conversation timeline', () => {
		expect(render({ content: 'Imported answer.', createdAt: Number.NaN })).not.toContain(
			'class="message-time"',
		);
		expect(render({ role: 'user', content: 'The question.' })).not.toContain(
			'class="message-time"',
		);
	});
	it('uses the refreshed viewer time zone for assistant timestamps', () => {
		const createdAt = Date.parse('2026-10-01T20:20:00Z');
		const html = renderToStaticMarkup(
			createElement(ChatMessage, {
				message: { id: 'zoned', role: 'assistant', content: 'Local time.', createdAt },
				timeZone: 'America/New_York',
				modelId: 'fixture',
				modelName: 'Fixture model',
				live: false,
				retryDisabled: false,
			}),
		);
		expect(html).toContain('>4:20 PM</time>');
	});
	it.each(['chat', 'code'] as const)(
		'keeps completed %s reasoning without intermediate activity noninteractive',
		(kind) => {
			const html = render(
				{
					content: 'The final answer.',
					phase: 'responding',
					activityFinishedAt: 6_000,
					completedAt: 8_000,
					activity: [{ type: 'text', id: 'final', text: 'The final answer.' }],
				},
				false,
				kind,
			);
			expect(html).toContain(kind === 'code' ? 'Worked for 7s' : 'Thought for 5s');
			expect(html).toContain('thought-summary-static');
			if (kind === 'code') expect(html).toContain('worked-section-header');
			else expect(html).not.toContain('worked-section-header');
			for (const hidden of ['aria-expanded', 'aria-controls', 'thought-history', 'chevron-right'])
				expect(html).not.toContain(hidden);
			expect(html).not.toMatch(/<button[^>]*class="thought-summary/);
			expect(html.split('The final answer.')).toHaveLength(2);
		},
	);
	it('does not expose an empty history for whitespace and unresolved tool references', () => {
		const html = render({
			content: 'Saved answer.',
			activityFinishedAt: 2_000,
			completedAt: 3_000,
			activity: [
				{ type: 'text', id: 'empty', text: ' \n ' },
				{ type: 'tool', id: 'orphan', toolCallId: 'missing' },
				{ type: 'text', id: 'final', text: 'Saved answer.' },
			],
		});
		expect(html).toContain('thought-summary-static');
		expect(html).not.toContain('aria-expanded');
		expect(html).not.toContain('thought-history');
		expect(html).toContain('Saved answer.');
	});
	it('retains a Code completed section header above its collapsed history and final answer', () => {
		const html = render(timeline, false, 'code');
		expect(html).toContain('class="thought-summary worked-section-header"');
		expect(html).toContain('aria-expanded="false"');
		expect(html).toContain('aria-controls="thought-answer"');
		expect(html.indexOf('worked-section-header')).toBeLessThan(html.indexOf('message-final'));
		expect(html).not.toContain('thought-output-divider');
		expect(html).not.toContain('working-section-header');
		expect(render(timeline)).not.toContain('worked-section-header');
	});
	it('keeps meaningful intermediate assistant prose expandable even without tools', () => {
		const html = render({
			content: 'I will compare the options.\n\nThe result.',
			activityFinishedAt: 2_000,
			completedAt: 3_000,
			activity: [
				{ type: 'text', id: 'intermediate', text: 'I will compare the options.' },
				{ type: 'text', id: 'final', text: 'The result.' },
			],
		});
		expect(html).toContain('aria-expanded="false"');
		expect(html).toContain('aria-controls="thought-answer"');
		expect(html).not.toContain('thought-summary-static');
		expect(html).not.toContain('I will compare the options.');
		expect(html).toContain('The result.');
	});
	it('collapses completed intermediates and tools while rendering only the final answer', () => {
		const html = render(timeline);
		expect(html).toContain('Thought for 11s');
		expect(html).toContain('aria-expanded="false"');
		expect(html).toContain('aria-controls="thought-answer"');
		expect(html.split('<strong>Finished.</strong>')).toHaveLength(2);
		for (const hidden of [
			'I will inspect the project.',
			'The result follows.',
			'data-tool-id="command"',
			'The <strong>inspection</strong>',
		])
			expect(html).not.toContain(hidden);
		expect(html).not.toContain('activity-shimmer');
	});
	it('keeps Chat tool summaries in order between intermediate assistant messages while streaming', () => {
		const html = render({ ...timeline, phase: 'responding' }, true);
		const markers = [
			'I will inspect the project.',
			'data-tool-id="command"',
			'The result follows.',
			'The <strong>inspection</strong> is complete.',
			'<strong>Finished.</strong>',
		];
		for (const marker of markers) expect(html.split(marker)).toHaveLength(2);
		for (let index = 1; index < markers.length; index++)
			expect(html.indexOf(markers[index])).toBeGreaterThan(html.indexOf(markers[index - 1]));
		expect(html).not.toContain('Thought for');
	});
	it('keeps Code commentary and completed tool summaries interleaved while streaming', () => {
		const html = render({ ...timeline, phase: 'responding' }, true, 'code');
		const markers = [
			'I will inspect the project.',
			'data-tool-id="command"',
			'The result follows.',
			'data-tool-id="update"',
			'The <strong>inspection</strong> is complete.',
			'<strong>Finished.</strong>',
		];
		for (const marker of markers) expect(html.split(marker)).toHaveLength(2);
		for (let index = 1; index < markers.length; index++)
			expect(html.indexOf(markers[index])).toBeGreaterThan(html.indexOf(markers[index - 1]));
		expect(html).toContain('>Ran pwd</span>');
		expect(html).not.toContain('Worked for');
		expect(html).not.toContain('active-tool-status');
		expect(html).not.toContain('tool-debug-details');
		expect(html).not.toContain('/fixture/project');
	});
	it('retains earlier Code tools when a later batch runs and finishes', () => {
		const next: ToolCallRecord = {
			...command,
			id: 'next',
			arguments: '{"cmd":"rg --files"}',
			status: 'running',
			result: undefined,
		};
		const activity: NonNullable<Message['activity']> = [
			{ type: 'text', id: 'first', text: 'I will inspect the project.' },
			{ type: 'tool', id: 'run', toolCallId: command.id },
			{ type: 'text', id: 'middle', text: 'Now I will list its files.' },
			{ type: 'tool', id: 'next-run', toolCallId: next.id },
		];
		for (const status of ['running', 'completed'] as const) {
			const html = render(
				{ phase: 'tools', activity, toolCalls: [command, { ...next, status }] },
				true,
				'code',
			);
			for (const marker of ['data-tool-id="command"', 'data-tool-id="next"'])
				expect(html.split(marker)).toHaveLength(2);
			expect(html.indexOf('data-tool-id="command"')).toBeLessThan(
				html.indexOf('Now I will list its files.'),
			);
			expect(html.indexOf('Now I will list its files.')).toBeLessThan(
				html.indexOf('data-tool-id="next"'),
			);
			expect(html).toContain(`${status === 'running' ? 'Running' : 'Ran'} rg --files</span>`);
			expect(html).not.toContain('active-tool-status');
			expect(html.split('activity-shimmer')).toHaveLength(status === 'running' ? 2 : 1);
		}
	});
	it('keeps concurrent Code tools separate until they complete, then groups them during streaming', () => {
		const second = { ...command, id: 'second', arguments: '{"cmd":"ls"}' };
		const third = { ...command, id: 'third', arguments: '{"cmd":"git status"}' };
		for (const status of ['running', 'completed'] as const) {
			const html = render(
				{
					phase: 'tools',
					toolCalls: [command, { ...second, status }, { ...third, status }],
					activity: [command, second, third].map((call) => ({
						type: 'tool' as const,
						id: `part-${call.id}`,
						toolCallId: call.id,
					})),
				},
				true,
				'code',
			);
			for (const call of [command, second, third])
				expect(html.split(`data-tool-id="${call.id}"`)).toHaveLength(2);
			if (status === 'running') expect(html).not.toContain('activity-history-group');
			else {
				expect(html).toContain('activity-history-group');
				expect(html).toContain('Ran 3 commands');
			}
			expect(html).not.toContain('active-tool-status');
		}
	});
	it('retains failed and denied Code tool summaries during subsequent reasoning', () => {
		const html = render(
			{
				phase: 'working',
				toolCalls: [
					{ ...command, status: 'failed' },
					{ ...command, id: 'denied', status: 'denied' },
				],
			},
			true,
			'code',
		);
		expect(html).toContain('data-tool-status="failed"');
		expect(html).toContain('data-tool-status="denied"');
		expect(html).toContain('Working for');
		expect(html).not.toContain('tool-debug-details');
	});
	it('keeps legacy answer content visible without inventing a zero-duration Chat label', () => {
		const html = render({ content: 'Older **answer**.', toolCalls: [command] });
		expect(html).not.toContain('thought-summary');
		expect(html).not.toContain('aria-expanded');
		expect(html).toContain('Older <strong>answer</strong>.');
		expect(render({ content: 'Plain legacy answer.' })).not.toContain('thought-summary');
	});
	it.each([999, 1000])(
		'uses the %sms activity duration boundary rather than final-answer streaming time for Chat labels',
		(duration) => {
			const html = render({
				content: 'The final answer.',
				phase: 'responding',
				activityFinishedAt: 1000 + duration,
				completedAt: 10_000,
			});
			if (duration < 1000) {
				expect(html).not.toContain('Thought for');
				expect(html).not.toContain('thought-summary');
			} else {
				expect(html).toContain('Thought for 1s');
				expect(html).toContain('thought-summary-static');
			}
			expect(html.split('The final answer.')).toHaveLength(2);
			expect(html).not.toContain('aria-expanded');
		},
	);
	it('keeps a quick Chat image and final answer visible while omitting its completed activity label', () => {
		const html = render({
			content: 'I will create the galaxy.\n\nHere is the **finished galaxy**.',
			phase: 'responding',
			activityFinishedAt: 1999,
			completedAt: 10_000,
			toolCalls: [command, image],
			activity: [
				{ type: 'text', id: 'preamble', text: 'I will create the galaxy.' },
				{ type: 'tool', id: 'command', toolCallId: command.id },
				{ type: 'tool', id: 'generation', toolCallId: image.id },
				{ type: 'text', id: 'final', text: 'Here is the **finished galaxy**.' },
			],
		});
		expect(html).not.toContain('thought-summary');
		expect(html).not.toContain('aria-expanded');
		expect(html).not.toContain('I will create the galaxy.');
		expect(html).not.toContain('/fixture/project');
		expect(html.split('alt="galaxy.png"')).toHaveLength(2);
		expect(html.split('Here is the <strong>finished galaxy</strong>.')).toHaveLength(2);
		expect(html.indexOf('alt="galaxy.png"')).toBeLessThan(html.indexOf('class="message-final"'));
	});
	it.each([0, 999])(
		'includes final streaming time in the Code Worked label after %sms of earlier activity',
		(duration) => {
			const html = render(
				{
					content: 'Code task complete.',
					activityFinishedAt: 1000 + duration,
					completedAt: 10_000,
					toolCalls: [command],
				},
				false,
				'code',
			);
			expect(html).toContain('Worked for 9s');
			expect(html).toContain('aria-expanded="false"');
			expect(html).toContain('Code task complete.');
		},
	);
	it('uses Thinking for Chat and keeps the elapsed Working label exclusive to Code', () => {
		expect(render({ phase: 'working' }, true)).toContain('activity-shimmer">Thinking</span>');
		expect(render({}, true)).toContain('activity-shimmer">Thinking</span>');
		expect(render({ phase: 'working' }, true, 'code')).toContain('Working for ');
		expect(render(timeline, false, 'code')).toContain('Worked for 15s');
		for (const phase of ['responding', 'tools'] as const)
			expect(render({ phase, content: 'Already responding.' }, true)).not.toContain(
				'working-status',
			);
		expect(render({ phase: 'working', completedAt: 2000 })).not.toContain('activity-shimmer');
	});
	it('keeps completed Chat tools before its new active tool, with only current work shimmering', () => {
		const old = { ...command, status: 'completed' as const };
		const search: ToolCallRecord = {
			...old,
			id: 'search',
			name: 'web.run',
			status: 'running',
			arguments: '{"search_query":[{"q":"galaxy formation"}]}',
		};
		const html = render({ phase: 'tools', toolCalls: [old, search] }, true);
		expect(html).toContain('class="activity-label-text activity-shimmer"');
		expect(html).toContain('Searching for galaxy formation</span>');
		expect(html).toContain('data-activity-icon="search" aria-hidden="true" focusable="false"');
		expect(html).toContain('Ran pwd');
		expect(html.indexOf('Ran pwd')).toBeLessThan(html.indexOf('Searching for galaxy formation'));
		expect(html).not.toContain('<details');
		expect(html).not.toContain('tool-output');
		expect(html.split('activity-shimmer')).toHaveLength(2);
	});
	it.each(['working', 'tools', 'responding', 'compacting'] as const)(
		'keeps the Code elapsed section header throughout %s without attaching timers to activity rows',
		(phase) => {
			const clock = vi.spyOn(Date, 'now').mockReturnValue(10_000);
			try {
				const html = render(
					{ phase, createdAt: 4_000, content: phase === 'responding' ? 'Streaming answer.' : '' },
					true,
					'code',
				);
				expect(html).toContain('class="working-section-header"');
				expect(html).toContain('<span>Working for 6s</span>');
				expect(html.indexOf('working-section-header')).toBeLessThan(
					html.indexOf('message-live-text'),
				);
				expect(html.split('Working for')).toHaveLength(2);
				if (phase === 'working') {
					expect(html).toContain('activity-shimmer">Thinking</span>');
					expect(html).not.toContain('data-activity-icon="reasoning"');
				}
				expect(
					render({ phase, content: 'Answer.', completedAt: 10_000 }, false, 'code'),
				).not.toContain('working-section-header');
				expect(render({ phase, error: 'Request failed.' }, true, 'code')).not.toContain(
					'working-section-header',
				);
			} finally {
				clock.mockRestore();
			}
		},
	);
	it('shows the command in Code live activity, including while approval is pending', () => {
		for (const status of ['running', 'approval'] as const) {
			const html = render({ phase: 'tools', toolCalls: [{ ...command, status }] }, true, 'code');
			expect(html).toContain('data-activity-icon="terminal" aria-hidden="true" focusable="false"');
			expect(html).toContain('class="activity-label-text activity-shimmer"');
			expect(html).toContain('>Running pwd</span>');
			if (status === 'approval') expect(html).toContain('<small>Waiting for approval</small>');
			expect(html.split('data-tool-id="command"')).toHaveLength(2);
			expect(html).toContain('role="status" aria-live="polite"');
			expect(html).not.toContain('active-tool-status');
			expect(html).not.toContain('<details');
		}
	});
	it('keeps generated images and their errors outside collapsed activity', () => {
		const html = render({
			content: 'Here it is.',
			phase: 'responding',
			toolCalls: [image],
			completedAt: 3000,
		});
		expect(html).toContain('Thought for 2s');
		expect(html).toContain('alt="galaxy.png"');
		expect(html).toContain('Here it is.');
		const failure = render({
			phase: 'tools',
			completedAt: 3000,
			toolCalls: [
				{
					...image,
					status: 'failed',
					result: { isError: true, content: [{ type: 'text', text: 'Image API unavailable.' }] },
				},
			],
		});
		expect(failure).toContain('Image API unavailable.');
	});
	it.each(['chat', 'code'] as const)(
		'keeps a streamed final answer below its generated image before and after %s completes',
		(kind) => {
			const message: Partial<Message> = {
				content: 'I will create the galaxy.\n\nHere is the **finished galaxy**.',
				phase: 'responding',
				toolCalls: [image],
				activity: [
					{ type: 'text', id: 'preamble', text: 'I will create the galaxy.' },
					{ type: 'tool', id: 'generation', toolCallId: image.id },
					{ type: 'text', id: 'final', text: 'Here is the **finished galaxy**.' },
				],
			};
			const live = render(message, true, kind);
			const done = render({ ...message, completedAt: 3_000 }, false, kind);
			for (const html of [live, done]) {
				expect(html.split('alt="galaxy.png"')).toHaveLength(2);
				expect(html.split('Here is the <strong>finished galaxy</strong>.')).toHaveLength(2);
				expect(html.indexOf('alt="galaxy.png"')).toBeLessThan(
					html.indexOf('class="message-final"'),
				);
				expect(html.indexOf('class="message-final"')).toBeLessThan(
					html.indexOf('Here is the <strong>finished galaxy</strong>.'),
				);
			}
			expect(live.indexOf('I will create the galaxy.')).toBeLessThan(
				live.indexOf('alt="galaxy.png"'),
			);
			expect(live.split('I will create the galaxy.')).toHaveLength(2);
			expect(done).not.toContain('I will create the galaxy.');
		},
	);
	it.each([true, false])('keeps legacy post-image prose below the asset with live=%s', (live) => {
		const html = render({ content: 'A saved image explanation.', toolCalls: [image] }, live);
		expect(html.indexOf('alt="galaxy.png"')).toBeLessThan(
			html.indexOf('A saved image explanation.'),
		);
		expect(html.split('A saved image explanation.')).toHaveLength(2);
		expect(html.split('alt="galaxy.png"')).toHaveLength(2);
	});
	it('preserves image-only turns and pre-tool commentary without inventing a final response', () => {
		const message: Partial<Message> = {
			content: 'I will create the galaxy.',
			phase: 'tools',
			toolCalls: [image],
			activity: [
				{ type: 'text', id: 'preamble', text: 'I will create the galaxy.' },
				{ type: 'tool', id: 'generation', toolCallId: image.id },
			],
		};
		const live = render(message, true);
		const done = render({ ...message, completedAt: 3_000 });
		expect(live).toContain('I will create the galaxy.');
		expect(done).not.toContain('I will create the galaxy.');
		for (const html of [live, done]) {
			expect(html).not.toContain('class="message-final"');
			expect(html.split('alt="galaxy.png"')).toHaveLength(2);
		}
	});
	it('keeps a plain streamed answer visible once without tool activity', () => {
		const html = render(
			{
				content: 'A streamed **answer**.',
				phase: 'responding',
				activity: [{ type: 'text', id: 'final', text: 'A streamed **answer**.' }],
			},
			true,
		);
		expect(html.split('A streamed <strong>answer</strong>.')).toHaveLength(2);
		expect(html).toContain('class="message-final"');
		expect(html).not.toContain('Thought for');
	});
	it('retains actionable errors and stopped markers outside the collapsed trace', () => {
		const html = render({ ...timeline, error: 'API stream failed.', interrupted: true });
		expect(html).toContain('role="alert">API stream failed.');
		expect(html).toContain('Response stopped.');
		expect(html).toContain('<strong>Finished.</strong>');
	});
});

describe('generated videos in conversation history', () => {
	const video: ToolCallRecord = {
		...image,
		id: 'video',
		name: 'video_gen.videogen',
		arguments: '{"prompt":"waves"}',
		result: {
			content: [
				{
					type: 'file',
					dataUrl: 'data:video/mp4;base64,AA==',
					name: 'generated.mp4',
					mimeType: 'video/mp4',
				},
			],
		},
	};
	it.each(['chat', 'code'] as const)(
		'keeps the %s video visible before the final reply when the activity is collapsed',
		(kind) => {
			const html = render(
				{
					content: 'Here is your film.',
					toolCalls: [video],
					completedAt: 16000,
					activityFinishedAt: 15000,
					activity: [
						{ type: 'tool', id: 'video-step', toolCallId: video.id },
						{ type: 'text', id: 'final', text: 'Here is your film.' },
					],
				},
				false,
				kind,
			);
			expect(html).toContain('<video');
			expect(html).toContain('download="generated.mp4"');
			expect(html.indexOf('<video')).toBeLessThan(html.indexOf('Here is your film.'));
			expect(html.match(/data:video\/mp4/g)).toHaveLength(2);
		},
	);
	it('shows pending video progress without exposing an unfinished asset', () => {
		const html = render(
			{
				toolCalls: [{ ...video, status: 'running', result: undefined }],
				activity: [{ type: 'tool', id: 'video-step', toolCallId: video.id }],
			},
			true,
		);
		expect(html).toContain('Creating video');
		expect(html).not.toContain('<video');
	});
	it('does not release a failed or moderated video result', () => {
		const html = render({
			toolCalls: [
				{
					...video,
					status: 'failed',
					result: {
						isError: true,
						content: [
							{ type: 'text', text: 'Video output blocked by moderation.' },
							...video.result!.content,
						],
					},
				},
			],
		});
		expect(html).toContain('Video output blocked by moderation.');
		expect(html).not.toContain('<video');
		expect(html).not.toContain('data:video');
	});
});
