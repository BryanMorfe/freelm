import { describe, expect, it } from 'vitest';
import { createBotProviderStream } from '../../electron/bot-provider-stream';
import type { WireResponse } from '../../src/types';
import type { BotReplyActivity } from '../../src/bot-types';
const response: WireResponse = {
	status: 200,
	contentType: 'text/event-stream',
	body: '',
	encoding: 'text',
};
const frame = (data: unknown) => `data: ${JSON.stringify(data)}\r\n\r\n`;

describe('bot provider activity stream', () => {
	it('keeps reasoning and whitespace out of writing, parses split CRLF and completed at EOF', () => {
		const activities: BotReplyActivity[] = [];
		const stream = createBotProviderStream(true, (activity) => activities.push(activity));
		const reasoning = frame({
			type: 'response.reasoning_summary_text.delta',
			delta: 'Private reasoning',
		});
		for (const chunk of reasoning) stream.push(chunk);
		stream.push(frame({ type: 'response.output_text.delta', delta: ' \n' }));
		expect(activities).toEqual(['thinking']);
		stream.push(frame({ type: 'response.output_text.delta', delta: 'Hi!' }));
		expect(activities).toEqual(['thinking', 'writing']);
		stream.push(
			'event: response.completed\ndata: {"response":{"status":"completed","usage":{"input_tokens":18}}}',
		);
		expect(stream.finish(response)).toMatchObject({ text: ' \nHi!', inputTokens: 18, calls: [] });
	});
	it('preserves streamed tool arguments and encrypted reasoning in Responses replay', () => {
		const activities: BotReplyActivity[] = [];
		const stream = createBotProviderStream(true, (activity) => activities.push(activity));
		stream.push(
			frame({
				type: 'response.output_item.done',
				output_index: 0,
				item: { id: 'r1', type: 'reasoning', encrypted_content: 'opaque', summary: [] },
			}),
		);
		stream.push(
			frame({
				type: 'response.output_item.added',
				output_index: 1,
				item: {
					id: 'fc',
					type: 'function_call',
					call_id: 'call',
					name: 'threads_read',
					arguments: '',
				},
			}),
		);
		stream.push(
			frame({ type: 'response.function_call_arguments.delta', item_id: 'fc', delta: '{"id":' }),
		);
		stream.push(
			frame({ type: 'response.function_call_arguments.delta', item_id: 'fc', delta: '"target"}' }),
		);
		stream.push(frame({ type: 'response.completed' }));
		const result = stream.finish(response);
		expect(result.calls).toEqual([
			{ id: 'call', name: 'threads_read', arguments: '{"id":"target"}' },
		]);
		expect(result.output[0]).toMatchObject({ type: 'reasoning', encrypted_content: 'opaque' });
		expect(activities).not.toContain('writing');
	});
	it('preserves Chat Completions reasoning, tools, and usage without treating tool arguments as writing', () => {
		const activities: BotReplyActivity[] = [];
		const stream = createBotProviderStream(false, (activity) => activities.push(activity));
		for (const delta of [
			{ reasoning_content: 'Inspect ' },
			{ reasoning_content: 'the thread' },
			{
				tool_calls: [
					{
						index: 0,
						id: 'call',
						type: 'function',
						function: { name: 'threads_read', arguments: '{"id":' },
					},
				],
			},
			{ tool_calls: [{ index: 0, function: { arguments: '"target"}' } }] },
		])
			stream.push(frame({ choices: [{ index: 0, delta }] }));
		stream.push(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
		stream.push(frame({ choices: [], usage: { prompt_tokens: 89 } }));
		stream.push('data: [DONE]\n\n');
		const result = stream.finish(response);
		expect(result).toMatchObject({
			inputTokens: 89,
			assistant: { reasoning_content: 'Inspect the thread' },
			calls: [{ id: 'call', name: 'threads_read', arguments: '{"id":"target"}' }],
		});
		expect(activities).not.toContain('writing');
	});
	it('uses Chat Completions output text deltas as writing and handles refusal', () => {
		const activities: BotReplyActivity[] = [];
		const stream = createBotProviderStream(false, (activity) => activities.push(activity));
		stream.push(frame({ choices: [{ delta: { reasoning: 'Consider' }, index: 0 }] }));
		stream.push(frame({ choices: [{ delta: { refusal: 'I can’t do that.' }, index: 0 }] }));
		stream.push(frame({ choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] }));
		expect(stream.finish(response).text).toBe('I can’t do that.');
		expect(activities).toEqual(['thinking', 'writing']);
	});
	it.each([true, false])('fails truncated streams for Responses=%s even with DONE', (responses) => {
		const stream = createBotProviderStream(responses, () => {});
		stream.push(
			frame(
				responses
					? { type: 'response.output_text.delta', delta: 'partial' }
					: { choices: [{ index: 0, delta: { content: 'partial' } }] },
			),
		);
		stream.push('data: [DONE]\n\n');
		expect(() => stream.finish(response)).toThrow(/ended before completion.*completion: missing/);
	});
	it('exposes malformed buffered events before EOF and error events', () => {
		const stream = createBotProviderStream(true, () => {});
		stream.push('data: {invalid');
		expect(() => stream.finish(response)).toThrow(/malformed streaming data/);
		const failed = createBotProviderStream(true, () => {});
		expect(() =>
			failed.push(
				frame({ type: 'response.failed', response: { error: { message: 'Model crashed' } } }),
			),
		).toThrow(/Model crashed/);
	});
	it('rejects changed call IDs, unsupported call types and delivery mismatch', () => {
		const stream = createBotProviderStream(false, () => {});
		stream.push(
			frame({
				choices: [{ delta: { tool_calls: [{ index: 0, id: 'one', function: { name: 'x' } }] } }],
			}),
		);
		expect(() =>
			stream.push(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'two' }] } }] })),
		).toThrow(/changed its call ID/);
		const missing = createBotProviderStream(true, () => {});
		missing.push(frame({ type: 'response.completed' }));
		expect(() => missing.finish({ ...response, stream: { bytes: 999, characters: 999 } })).toThrow(
			/delivery was incomplete/,
		);
	});
	it('accepts providers returning JSON without claiming a live writing phase', () => {
		const activities: BotReplyActivity[] = [];
		const stream = createBotProviderStream(false, (activity) => activities.push(activity));
		const result = stream.finish({
			...response,
			contentType: 'application/json',
			body: JSON.stringify({
				choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Done.' } }],
			}),
		});
		expect(result.text).toBe('Done.');
		expect(activities).toEqual([]);
	});
	it('ignores explicit Responses commentary for typing and final text, while preserving a final refusal', () => {
		const phases: BotReplyActivity[] = [];
		const stream = createBotProviderStream(true, (phase) => phases.push(phase));
		const commentary = {
			type: 'message',
			role: 'assistant',
			id: 'comment',
			channel: 'commentary',
			content: [{ type: 'output_text', text: 'I will inspect it.' }],
		};
		stream.push(frame({ type: 'response.output_item.added', output_index: 0, item: commentary }));
		stream.push(
			frame({
				type: 'response.output_text.delta',
				item_id: 'comment',
				delta: 'I will inspect it.',
			}),
		);
		expect(phases).not.toContain('writing');
		const final = {
			type: 'message',
			role: 'assistant',
			id: 'final',
			channel: 'final',
			content: [{ type: 'refusal', refusal: 'I can’t help with that.' }],
		};
		stream.push(
			frame({
				type: 'response.output_item.added',
				output_index: 1,
				item: { ...final, content: [] },
			}),
		);
		stream.push(
			frame({ type: 'response.refusal.delta', output_index: 1, delta: 'I can’t help with that.' }),
		);
		stream.push(
			frame({
				type: 'response.completed',
				response: { status: 'completed', output: [commentary, final] },
			}),
		);
		expect(stream.finish(response).text).toBe('I can’t help with that.');
		expect(phases.at(-1)).toBe('writing');
	});
	it('ignores explicit Chat commentary and writes only final-channel content', () => {
		const phases: BotReplyActivity[] = [];
		const stream = createBotProviderStream(false, (phase) => phases.push(phase));
		stream.push(
			frame({ choices: [{ delta: { channel: 'analysis', content: 'Private thought' } }] }),
		);
		stream.push(
			frame({ choices: [{ delta: { channel: 'commentary', content: 'Let me look.' } }] }),
		);
		expect(phases).not.toContain('writing');
		stream.push(frame({ choices: [{ delta: { channel: 'final', content: 'Done!' } }] }));
		stream.push(frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
		expect(stream.finish(response).text).toBe('Done!');
		expect(phases.at(-1)).toBe('writing');
	});
	it('returns to thinking if a tool call follows unmarked output text', () => {
		const phases: BotReplyActivity[] = [];
		const stream = createBotProviderStream(true, (phase) => phases.push(phase));
		stream.push(frame({ type: 'response.output_text.delta', delta: 'A preliminary note.' }));
		stream.push(
			frame({
				type: 'response.output_item.added',
				output_index: 0,
				item: {
					type: 'function_call',
					id: 'x',
					call_id: 'call',
					name: 'threads_read',
					arguments: '{}',
				},
			}),
		);
		stream.push(frame({ type: 'response.output_text.delta', delta: 'More tool commentary' }));
		expect(phases).toEqual(['writing', 'thinking']);
	});
});
