import { describe, expect, it, vi } from 'vitest';
import { canonicalProviderRequest, routeProviderRequest } from '../electron/provider-routing';
import { streamAgentChat } from '../src/lib/agent';
import { generatePluginText } from '../electron/plugins/inference';
import { standardThinkingMode } from '../src/lib/catalog';
import type { Connection, WireRequest } from '../src/types';
import type { PluginHost } from '../electron/plugins/host';

const connection: Connection = {
	id: 'adapter', name: 'Synthetic', baseUrl: 'https://fixture.invalid/v1', apiKey: 'host-only', chatApi: 'chat/completions',
	providerAdapter: { pluginId: 'fixture', providerId: 'custom', accountId: 'account', credentialHeader: 'x-api-key' },
	models: { chat: 'model', images: '', videos: '', speech: '', transcription: '' }, discoveredModels: [],
	catalog: [{ id: 'model', name: 'Model', enabled: true, tasks: ['chat'], inputModalities: ['text'], outputModalities: ['text'], thinkingModes: [standardThinkingMode()] }],
};
const wire = (body = { model: 'model', messages: [{ role: 'user', content: 'Hello' }] }): WireRequest => ({ id: 'request', connectionId: 'adapter', baseUrl: 'https://untrusted.invalid', apiKey: 'untrusted', method: 'POST', path: '/chat/completions', body, providerAdapterRequired: true });
type Generate = PluginHost['generateWithProvider'];
describe('provider routing and existing consumers', () => {
	it.each(['chat','code'] as const)('runs a two-round tool exchange through the real %s agent', async surface => {
		let rounds = 0;
		const generateWithProvider = vi.fn<Generate>(async input => {
			expect(input.caller).toEqual({ surface });
			expect(input.baseUrl).toBe(connection.baseUrl);
			expect(input.credential).toEqual({ header: 'x-api-key', value: 'host-only' });
			if (++rounds === 1) return { text: '', calls: [{ id: 'call_one', name: input.request.tools[0].name, arguments: { value: 'fixture' } }], usage: { inputTokens: 12 }, finishReason: 'tools' };
			expect(input.request.messages).toEqual(expect.arrayContaining([
				expect.objectContaining({ role: 'assistant', calls: [expect.objectContaining({ id: 'call_one' })] }),
				expect.objectContaining({ role: 'tool', callId: 'call_one', text: expect.stringContaining('tool result') }),
			]));
			input.onEvent({ type: 'text', text: 'Completed' });
			return { text: 'Completed', calls: [], usage: { inputTokens: 24, outputTokens: 4 }, finishReason: 'stop' };
		});
		const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'tool result' }] }));
		const result = await streamAgentChat({ connection, providerCaller: surface, model: 'model', history: [{ id: 'user', role: 'user', content: 'Use fixture', createdAt: 1 }], instructions: 'Test', tools: [{ name: 'lookup', description: 'Read synthetic data', parameters: { type: 'object', properties: { value: { type: 'string' } } }, source: 'builtin' }], execute, onUpdate() {},
			request: (_connection, request, signal, chunk = () => {}) => routeProviderRequest(connection, { ...wire(), ...request }, request.providerCaller!, { generateWithProvider }, chunk, signal),
		});
		expect(rounds).toBe(2); expect(execute).toHaveBeenCalledOnce(); expect(result.content).toBe('Completed');
	});
	it('serves plugin inference with the same normalized transport', async () => {
		const generateWithProvider = vi.fn<Generate>(async input => { input.onEvent({ type: 'text', text: 'Suggestion' }); return { text: 'Suggestion', calls: [], usage: { inputTokens: 3 }, finishReason: 'stop' }; });
		const result = await generatePluginText(connection, { hostId: 'local', connectionId: 'adapter', modelId: 'model', thinkingModeId: 'standard' }, { system: '', messages: [{ role: 'user', content: 'Suggest' }] }, new AbortController().signal,
			(_host, request, chunk, signal) => routeProviderRequest(connection, request, { surface: 'code' }, { generateWithProvider }, chunk, signal));
		expect(result.text).toBe('Suggestion'); expect(generateWithProvider.mock.calls[0][0].request.tools).toEqual([]);
	});
	it('fails closed for disabled adapters, missing bindings, remote requests and unsupported features', async () => {
		const generateWithProvider = vi.fn<Generate>(async () => { throw new Error('Plugin account is disabled or needs reconnection.'); });
		const builtin = vi.fn();
		for (const [selected, request, caller] of [
			[connection, wire(), { surface: 'chat' }],
			[undefined, wire(), { surface: 'chat' }],
			[connection, { ...wire(), workspaceId: 'peer' }, { surface: 'code' }],
			[connection, wire(), { surface: 'bot', botId: 'b', remote: true }],
		] as const) await expect(routeProviderRequest(selected, request, caller, { generateWithProvider }, () => {}, undefined, builtin)).rejects.toThrow();
		expect(builtin).not.toHaveBeenCalled();
		expect(() => canonicalProviderRequest({ ...wire(), body: { ...wire().body, reasoning_effort: 'high' } })).toThrow('Standard');
		expect(() => canonicalProviderRequest({ ...wire(), path: '/models', method: 'GET' })).toThrow('manually');
	});
	it('preserves the built-in transport unchanged and propagates cancellation', async () => {
		const builtin = vi.fn<typeof import('../electron/transport').performRequest>(async () => ({ status: 200, contentType: 'application/json', body: '{}', encoding: 'text' as const }));
		const original = { ...wire(), providerAdapterRequired: false };
		await routeProviderRequest({ ...connection, providerAdapter: undefined }, original, { surface: 'chat' }, {} as any, () => {}, undefined, builtin);
		expect(builtin.mock.calls[0][0]).toBe(original);
		const controller = new AbortController();
		const generateWithProvider: Generate = async input => { controller.abort(); input.signal.throwIfAborted(); throw new Error('unreachable'); };
		await expect(routeProviderRequest(connection, wire(), { surface: 'chat' }, { generateWithProvider }, () => {}, controller.signal)).rejects.toThrow();
	});
});
