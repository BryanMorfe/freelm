import { describe, expect, it, vi } from 'vitest';
import { generatePluginText, type PluginInferenceExecutor } from '../../electron/plugins/inference';
import type { Connection, WireResponse } from '../../src/types';

const model = { hostId: 'local', connectionId: 'fixture', modelId: 'test-model', thinkingModeId: 'high' };
function connection(responses = true): Connection {
	return { id: 'fixture', name: 'Fixture', baseUrl: 'https://provider.invalid/v1', apiKey: 'private-key', chatApi: responses ? 'responses' : 'chat/completions', models: { chat: 'test-model', images: '', videos: '', speech: '', transcription: '' }, discoveredModels: [], catalog: [{ id: 'test-model', name: 'Test', enabled: true, tasks: ['chat'], inputModalities: ['text'], outputModalities: ['text'], thinkingModes: [{ id: 'high', name: 'High', parameters: { responses: { reasoning: { effort: 'high' } }, chat: { reasoning_effort: 'high' } } }] }] };
}
const signal = () => new AbortController().signal;
const sse: WireResponse = { status: 200, contentType: 'text/event-stream', encoding: 'text', body: '' };
const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
const request = { system: 'Write one question.', messages: [{ role: 'user', content: 'Conversation text' }], maxOutputTokens: 8192 };

describe('independent plugin text inference', () => {
	it.each([true, false])('uses configured transport and explicit thinking without adding app history or tools (Responses=%s)', async responses => {
		const execute = vi.fn<PluginInferenceExecutor>(async (_host, wire, push) => {
			if (responses) {
				push(frame({ type: 'response.reasoning_summary_text.delta', delta: 'Private reasoning' }));
				push(frame({ type: 'response.output_text.delta', delta: 'What comes next?' }));
				push('event: response.completed\ndata: {"response":{"status":"completed","usage":{"input_tokens":42}}}');
			} else {
				push(frame({ choices: [{ index: 0, delta: { reasoning_content: 'Private reasoning' } }] }));
				push(frame({ choices: [{ index: 0, delta: { content: 'What comes next?' } }] }));
				push(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 42 } }));
			}
			return sse;
		});
		await expect(generatePluginText(connection(responses), model, request, signal(), execute)).resolves.toEqual({ text: 'What comes next?', model, usage: { inputTokens: 42 } });
		const wire = execute.mock.calls[0][1], body = wire.body as Record<string, unknown>;
		expect(wire.path).toBe(responses ? '/responses' : '/chat/completions');
		expect(body).not.toHaveProperty('tools'); expect(body).not.toHaveProperty('tool_choice');
		if (responses) expect(body).toMatchObject({ instructions: request.system, input: request.messages, reasoning: { effort: 'high' }, max_output_tokens: 8192, store: false });
		else expect(body).toMatchObject({ messages: [{ role: 'system', content: request.system }, ...request.messages], reasoning_effort: 'high', max_completion_tokens: 8192 });
	});

	it('allows general plugin outputs above the Bot-specific text limit while keeping a bounded result', async () => {
		const execute = vi.fn<PluginInferenceExecutor>(async (_host, _wire, push) => {
			push(frame({ type: 'response.output_text.delta', delta: 'x'.repeat(40_000) }));
			push(frame({ type: 'response.completed' })); return sse;
		});
		const result = await generatePluginText(connection(), model, request, signal(), execute);
		expect(result.text).toHaveLength(40_000);
	});

	it('falls back only when streaming is explicitly unsupported and still requires a complete response', async () => {
		const execute = vi.fn<PluginInferenceExecutor>()
			.mockResolvedValueOnce({ status: 400, contentType: 'application/json', encoding: 'text', body: '{"error":"Streaming is not supported"}' })
			.mockResolvedValueOnce({ status: 200, contentType: 'application/json', encoding: 'text', body: JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Next?' }] }] }) });
		await expect(generatePluginText(connection(), model, request, signal(), execute)).resolves.toMatchObject({ text: 'Next?' });
		expect(execute.mock.calls.map(call => call[1].stream)).toEqual([true, false]);
		const failed = vi.fn<PluginInferenceExecutor>().mockResolvedValue({ status: 500, contentType: 'application/json', encoding: 'text', body: '{}' });
		await expect(generatePluginText(connection(), model, request, signal(), failed)).rejects.toThrow('HTTP 500');
		expect(failed).toHaveBeenCalledOnce();
	});

	it('never returns unfinished streaming text or executes model tool calls', async () => {
		const truncated = vi.fn<PluginInferenceExecutor>(async (_host, _wire, push) => { push(frame({ type: 'response.output_text.delta', delta: 'Partial' })); return sse; });
		await expect(generatePluginText(connection(), model, request, signal(), truncated)).rejects.toThrow(/ended|completion|complete/);
		const tools = vi.fn<PluginInferenceExecutor>().mockResolvedValue({ status: 200, contentType: 'application/json', encoding: 'text', body: JSON.stringify({ status: 'completed', output: [{ type: 'function_call', name: 'unavailable', call_id: 'call-1', arguments: '{}' }] }) });
		await expect(generatePluginText(connection(), model, request, signal(), tools)).rejects.toThrow('cannot call tools');
	});

	it('rejects unavailable thinking selections, mismatched connections, and oversize inputs before dispatch', async () => {
		const execute = vi.fn<PluginInferenceExecutor>();
		await expect(generatePluginText(connection(), { ...model, thinkingModeId: 'deleted' }, request, signal(), execute)).rejects.toThrow('not configured');
		await expect(generatePluginText(connection(), { ...model, connectionId: 'different' }, request, signal(), execute)).rejects.toThrow('does not match');
		await expect(generatePluginText(connection(), model, { ...request, messages: [{ role: 'user', content: 'x'.repeat(128001) }] }, signal(), execute)).rejects.toThrow('128,000');
		await expect(generatePluginText(connection(), model, { ...request, maxOutputTokens: 0 }, signal(), execute)).rejects.toThrow('budget');
		expect(execute).not.toHaveBeenCalled();
	});
});
