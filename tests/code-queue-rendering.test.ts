import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Chat from '../src/components/Chat';
import { initialState } from '../src/lib/state';
import CodeMessageQueue from '../src/components/CodeMessageQueue';
import type { CodeQueueFailure, Message, QueuedCodeMessage } from '../src/types';

const message: QueuedCodeMessage = {
	id: 'queue-1',
	content: 'Inspect the next file.\nKeep the changes small.',
	createdAt: 1,
};
function render(props: Partial<ComponentProps<typeof CodeMessageQueue>>, messages = [message]) {
	return renderToStaticMarkup(
		createElement(CodeMessageQueue, {
			messages,
			running: true,
			onEdit: () => {},
			onRemove: () => {},
			onSteer: () => {},
			...props,
		}),
	);
}

describe('Code queue drawer rendering', () => {
	it('cleans saved queue delivery errors while leaving the queued request unchanged', () => {
		const html = render({
			running: false,
			failures: [
				{
					id: 'error',
					assistantId: 'answer',
					messageIds: ['input'],
					failedAt: 1,
					error:
						"Error invoking remote method 'freelm:host-task': NetworkError: The server is unavailable.\n    at send (/private/host.ts:4:8)",
					messages: [
						{
							id: 'input',
							role: 'user',
							content: 'Explain Error: connection reset.',
							createdAt: 1,
						},
					],
				},
			],
		});
		expect(html).toContain('The server is unavailable.');
		expect(html).toContain('Explain Error: connection reset.');
		expect(html).not.toContain('Error invoking remote method');
		expect(html).not.toContain('NetworkError');
		expect(html).not.toContain('/private/host.ts');
	});
	it('shows compact expandable messages and automatic safe-boundary delivery status', () => {
		const html = render({});
		expect(html).toContain('aria-label="Queued messages"');
		expect(html).toContain('aria-label="Expand queued message" aria-expanded="false"');
		expect(html).toContain('Inspect the next file.');
		expect(html).toContain('title="Sends at next tool boundary"');
		expect(html).toContain('<span>Queued</span>');
		expect(html).not.toContain('aria-label="Steer with queued message"');
		expect(html).toContain('aria-label="Remove queued message"');
		expect(html).toContain('aria-label="Queued message actions"');
		expect(html).not.toContain('code-message-queue-expanded');
	});
	it('offers Send when idle and omits the drawer when there are no queued messages', () => {
		expect(render({ running: false })).toContain('title="Send message"');
		expect(render({}, [])).toBe('');
	});
	it('shows an image thumbnail and filename when the queued input only has an attachment', () => {
		const html = render({}, [
			{
				...message,
				content: '',
				attachments: [
					{ name: 'reference.png', type: 'image/png', dataUrl: 'data:image/png;base64,AA==' },
				],
			},
		]);
		expect(html).toContain('class="code-message-queue-thumbnail"');
		expect(html).toContain('alt="reference.png"');
		expect(html).toContain('<span>reference.png</span>');
	});
	it('pauses steering while an entry is being edited and labels that entry', () => {
		const html = render({ editingId: 'queue-1', running: false }, [
			message,
			{ ...message, id: 'queue-2' },
		]);
		expect(html).toContain('Editing message');
		expect(html).toContain('aria-label="Send queued message" disabled=""');
		expect(html).not.toContain('Open in side chat');
		expect(html).not.toContain('Turn off queueing');
	});
	it('keeps a failed committed follow-up visible alongside pending inputs and exposes explicit Retry', () => {
		const onRetry = vi.fn();
		const failure: CodeQueueFailure & { messages: Message[] } = {
			id: 'failed-delivery',
			assistantId: 'failed-answer',
			messageIds: ['committed-input'],
			error: 'Provider HTTP 503: <temporary outage>',
			failedAt: 2,
			messages: [
				{
					id: 'committed-input',
					role: 'user',
					content: 'Continue the existing inspection.',
					createdAt: 1,
				},
			],
		};
		const html = render({ running: false, failures: [failure], onRetry });
		expect(html).toContain('aria-label="Failed queued messages"');
		expect(html).toContain('Continue the existing inspection.');
		expect(html).toContain('Retry continues from saved progress.');
		expect(html).toContain('Provider HTTP 503: &lt;temporary outage&gt;');
		expect(html).toContain('aria-label="Retry queued messages"');
		expect(html).not.toContain('aria-label="Retry queued messages" disabled');
		expect(html).toContain(message.content);
		expect(onRetry).not.toHaveBeenCalled();
		for (const props of [{ running: true }, { disabled: true }, { editingId: 'queue-1' }])
			expect(render({ running: false, failures: [failure], onRetry, ...props }, [])).toContain(
				'aria-label="Retry queued messages" disabled=""',
			);
		expect(render({ running: false, failures: [failure], onRetry }, [])).toContain(
			'aria-label="Failed queued messages"',
		);
	});
});

const noop = () => {};
function renderActiveCode(overrides: Partial<ComponentProps<typeof Chat>> = {}) {
	vi.stubGlobal('window', { desktop: { toolExecute: noop } });
	const connection = initialState().connections[0];
	connection.models.chat = 'queue-model';
	connection.catalog = [
		{
			id: 'queue-model',
			name: 'Queue model',
			enabled: true,
			tasks: ['chat'],
			inputModalities: ['text'],
			outputModalities: ['text'],
			thinkingModes: [
				{ id: 'low', name: 'Low', parameters: { responses: { reasoning: { effort: 'low' } } } },
			],
		},
	];
	return renderToStaticMarkup(
		createElement(Chat, {
			conversationKind: 'code',
			connection,
			model: 'queue-model',
			thinkingMode: 'low',
			thread: {
				id: 'active-code',
				kind: 'code',
				title: 'Active task',
				connectionId: connection.id,
				model: 'queue-model',
				thinkingMode: 'low',
				createdAt: 1,
				updatedAt: 1,
				messages: [
					{ id: 'request', role: 'user', content: 'Inspect this private sample.', createdAt: 1 },
				],
			},
			busy: true,
			runningHere: true,
			canQueue: true,
			permissionMode: 'ask',
			toolsEnabled: true,
			onThinkingMode: noop,
			onModel: noop,
			onSend: noop,
			onStop: noop,
			onRetry: noop,
			onSettings: noop,
			onPermissionMode: noop,
			onMove: noop,
			projects: [],
			...overrides,
		}),
	);
}
function controlTag(html: string, name: string) {
	const tag = html.match(new RegExp(`<button\\b[^>]*aria-label="${name}"[^>]*>`))?.[0];
	expect(tag, `Missing ${name} control`).toBeDefined();
	return tag!;
}
afterEach(() => vi.unstubAllGlobals());

describe('active Code composer controls', () => {
	it('shows Stop for an empty active draft while leaving attachments, model and permissions enabled', () => {
		const html = renderActiveCode();
		expect(html).toContain('aria-label="Stop response"');
		expect(html).not.toContain('aria-label="Send message"');
		expect(html).not.toContain('aria-label="Queue message"');
		for (const label of ['Attach files', 'Chat model', 'Code permissions'])
			expect(controlTag(html, label)).not.toContain('disabled');
	});
	it.each([
		{ content: 'Queue this follow-up.', attachments: [], updatedAt: 1 },
		{
			content: '',
			attachments: [
				{ name: 'notes.md', type: 'text/markdown', dataUrl: 'data:text/markdown;base64,U2FtcGxl' },
			],
			updatedAt: 1,
		},
	])('replaces Stop with ordinary enabled Send for draft text or attachments', (draft) => {
		const html = renderActiveCode({ draft });
		expect(controlTag(html, 'Send message')).not.toContain('disabled');
		expect(html).not.toContain('aria-label="Stop response"');
		expect(html).not.toContain('aria-label="Queue message"');
		expect(html).not.toContain('queue-send-button');
	});
	it('keeps host-owned permission controls read only during the active task', () => {
		const html = renderActiveCode({ permissionReadOnly: true });
		expect(controlTag(html, 'Code permissions')).toContain('disabled');
		expect(controlTag(html, 'Chat model')).not.toContain('disabled');
	});
});
