import { randomUUID } from 'node:crypto';
import type { Connection, WireRequest, WireResponse } from '../../src/types';
import { assertModelSupports, thinkingParameters } from '../../src/lib/catalog';
import { createBotProviderStream } from '../bot-provider-stream';

export type PluginInferenceExecutor = (hostId: string, request: WireRequest, onChunk: (text: string) => void, signal: AbortSignal) => Promise<WireResponse>;
export interface PluginInferenceModel { hostId: string; connectionId: string; modelId: string; thinkingModeId: string }

/** A single text request, with no tools, history writes, title generation, or agent loop. */
export async function generatePluginText(
	connection: Connection,
	model: PluginInferenceModel,
	args: Record<string, unknown>,
	signal: AbortSignal,
	execute: PluginInferenceExecutor,
) {
	if (connection.id !== model.connectionId) throw new Error('Plugin inference connection does not match its model binding.');
	assertModelSupports(connection, model.modelId, 'chat');
	if (!model.thinkingModeId) throw new Error('Select an explicit thinking mode for plugin inference.');
	const parameters = thinkingParameters(connection, model.modelId, model.thinkingModeId);
	if (typeof args.system !== 'string' || args.system.length > 32000 || !Array.isArray(args.messages) || args.messages.length > 100)
		throw new Error('Use a system string and at most 100 text messages.');
	let inputLength = args.system.length;
	const messages = args.messages.map((item: unknown) => {
		if (!item || typeof item !== 'object') throw new Error('Invalid inference message.');
		const value = item as Record<string, unknown>;
		if (!['user', 'assistant'].includes(String(value.role)) || typeof value.content !== 'string')
			throw new Error('Plugin inference supports user and assistant text messages.');
		inputLength += value.content.length;
		return { role: value.role as 'user' | 'assistant', content: value.content };
	});
	if (inputLength > 128000) throw new Error('Plugin inference input exceeds 128,000 characters.');
	const tokens = args.maxOutputTokens ?? 4096;
	if (!Number.isSafeInteger(tokens) || Number(tokens) < 1 || Number(tokens) > 32768)
		throw new Error('Plugin output budget must be between 1 and 32,768 tokens.');
	const responses = connection.chatApi === 'responses';
	for (const streaming of [true, false]) {
		signal.throwIfAborted();
		const body: Record<string, unknown> = {
			...parameters,
			...(responses ? {
				store: false, instructions: args.system, input: messages, max_output_tokens: tokens,
			} : {
				messages: [{ role: 'system', content: args.system }, ...messages], max_completion_tokens: tokens,
			}),
			model: model.modelId, stream: streaming,
		};
		delete body.tools;
		delete body.tool_choice;
		const parser = createBotProviderStream(responses, () => {}, { maxTextCharacters: 128000 });
		const reply = await execute(model.hostId, {
			id: randomUUID(), workspaceId: model.hostId, connectionId: connection.id,
			baseUrl: model.hostId === 'local' ? connection.baseUrl : '',
			apiKey: model.hostId === 'local' ? connection.apiKey : '',
			method: 'POST', path: responses ? '/responses' : '/chat/completions', body, stream: streaming,
		}, (chunk) => { signal.throwIfAborted(); parser.push(chunk); }, signal);
		if (streaming && [400, 422].includes(reply.status) && /(?:stream(?:ing)?.*(?:unsupported|not supported)|(?:unsupported|not supported).*stream)/i.test(reply.body)) continue;
		signal.throwIfAborted();
		try {
			const result = parser.finish(reply);
			if (result.calls.length) throw new Error('Plugin text inference cannot call tools.');
			if (result.text.length > 128000) throw new Error('Plugin inference output exceeds its size limit.');
			return { text: result.text, model, usage: result.inputTokens === undefined ? undefined : { inputTokens: result.inputTokens } };
		} catch (error) {
			throw new Error((error instanceof Error ? error.message : 'Plugin inference failed.').replace(/\bbot\b/gi, 'plugin'));
		}
	}
	throw new Error('This provider does not support plugin text inference.');
}
