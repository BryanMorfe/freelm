import type { Connection, WireRequest, WireResponse } from '../src/types';
import type { PluginCaller } from '../src/plugin-types';
import type { ProviderRequest, ProviderResult } from '../src/provider-types';
import type { PluginHost } from './plugins/host';
import { performRequest } from './transport';

const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
function content(value: unknown): string {
	if (value === null || value === undefined) return '';
	if (typeof value === 'string') return value;
	if (Array.isArray(value) && value.every(part => object(part) && part.type === 'text' && typeof part.text === 'string')) return value.map(part => part.text).join('\n');
	throw new Error('Provider adapters currently support text and tools only. Remove image or other media inputs.');
}
/** Compatibility bridge keeps existing transcript/tool-loop behavior while adapters use canonical data. */
export function canonicalProviderRequest(wire: WireRequest): ProviderRequest {
	if (wire.method !== 'POST' || wire.path !== '/chat/completions' || wire.form || !object(wire.body)) throw new Error('Provider adapters support text chat only. Enter model IDs manually; discovery and media endpoints are unavailable.');
	const body = wire.body;
	const unsupported = Object.keys(body).filter(key => !['model','messages','tools','stream','stream_options','max_tokens','max_completion_tokens','store'].includes(key));
	if (unsupported.length) throw new Error(`Provider adapter does not support these options: ${unsupported.join(', ')}. Use Standard thinking and plain text output.`);
	if (!Array.isArray(body.messages) || typeof body.model !== 'string') throw new Error('Invalid adapter chat request.');
	const system: string[] = [], messages: ProviderRequest['messages'] = [];
	for (const message of body.messages) {
		if (!object(message)) throw new Error('Invalid adapter message.');
		if (message.role === 'system' || message.role === 'developer') { system.push(content(message.content)); continue; }
		if (!['user','assistant','tool'].includes(message.role)) throw new Error('Unsupported adapter message role.');
		const calls = message.tool_calls;
		if (calls !== undefined && !Array.isArray(calls)) throw new Error('Invalid adapter tool history.');
		messages.push({ role: message.role, text: content(message.content), ...(message.role === 'tool' ? { callId: message.tool_call_id } : {}),
			...(calls === undefined ? {} : { calls: calls.map((call: any) => {
				if (!object(call) || call.type !== 'function' || !object(call.function) || typeof call.function.arguments !== 'string') throw new Error('Invalid adapter tool history.');
				return { id: call.id, name: call.function.name, arguments: JSON.parse(call.function.arguments) };
			}) }) });
	}
	if (body.tools !== undefined && !Array.isArray(body.tools)) throw new Error('Invalid adapter tools.');
	const tools = (body.tools ?? []).map((tool: any) => {
		if (!object(tool) || tool.type !== 'function' || !object(tool.function)) throw new Error('Provider adapter supports function tools only.');
		return { name: tool.function.name, description: tool.function.description ?? '', parameters: tool.function.parameters, ...(tool.function.strict === undefined ? {} : { strict: tool.function.strict }) };
	});
	return { version: 1, model: body.model, system: system.join('\n\n'), messages, tools,
		maxOutputTokens: (body.max_completion_tokens ?? body.max_tokens ?? 4096) as number, stream: wire.stream === true };
}
export function compatibleProviderReply(result: ProviderResult): WireResponse {
	return { status: 200, contentType: 'application/json', encoding: 'text', body: JSON.stringify({
		choices: [{ index: 0, message: { role: 'assistant', content: result.text,
			...(result.calls.length ? { tool_calls: result.calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : {}) }, finish_reason: result.finishReason === 'tools' ? 'tool_calls' : 'stop' }],
		usage: { ...(result.usage.inputTokens === undefined ? {} : { prompt_tokens: result.usage.inputTokens }), ...(result.usage.outputTokens === undefined ? {} : { completion_tokens: result.usage.outputTokens }) },
	}) };
}
export async function routeProviderRequest(connection: Connection | undefined, wire: WireRequest, caller: PluginCaller,
	plugins: Pick<PluginHost, 'generateWithProvider'>, onChunk: (text: string) => void, signal?: AbortSignal,
	builtin: typeof performRequest = performRequest): Promise<WireResponse> {
	if (!connection?.providerAdapter) {
		if (wire.providerAdapterRequired) throw new Error('Selected provider adapter connection is unavailable. Save the connection before using it.');
		return builtin(wire, onChunk, signal);
	}
	signal?.throwIfAborted();
	if (caller.remote || (wire.workspaceId && wire.workspaceId !== 'local')) throw new Error('Provider adapters are not supported for remote workspaces or remote callers yet.');
	if (connection.chatApi !== 'chat/completions') throw new Error('Provider adapter connections must use the Chat compatibility format. Re-select the adapter in Settings.');
	const canonical = canonicalProviderRequest(wire), adapter = connection.providerAdapter;
	const callIds = new Map<string, number>(); let characters = 0, bytes = 0;
	const emit = (chunk: unknown) => { signal?.throwIfAborted(); const text = `data: ${JSON.stringify(chunk)}\n\n`; characters += text.length; bytes += Buffer.byteLength(text); onChunk(text); };
	// Emit text promptly, but hold tools and terminal completion until the entire stream validates.
	const result = await plugins.generateWithProvider({ ...adapter, caller, baseUrl: connection.baseUrl,
		...(connection.apiKey ? { credential: { header: adapter.credentialHeader, value: adapter.credentialHeader === 'authorization' ? `Bearer ${connection.apiKey}` : connection.apiKey } } : {}),
		request: canonical, signal: signal ?? new AbortController().signal,
		onEvent(event) { if (wire.stream && event.type === 'text') emit({ choices: [{ index: 0, delta: { content: event.text } }] }); },
	});
	signal?.throwIfAborted();
	if (!wire.stream) return compatibleProviderReply(result);
	for (const call of result.calls) { const index = callIds.size; callIds.set(call.id, index); emit({ choices: [{ index: 0, delta: { tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } }] }); }
	const reply = JSON.parse(compatibleProviderReply(result).body);
	emit({ choices: [{ index: 0, delta: {}, finish_reason: result.finishReason === 'tools' ? 'tool_calls' : 'stop' }], usage: reply.usage });
	return { status: 200, contentType: 'text/event-stream', encoding: 'text', body: '', stream: { bytes, characters } };
}
