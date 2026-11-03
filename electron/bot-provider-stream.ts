import type { WireResponse } from '../src/types';
import type { BotReplyActivity } from '../src/bot-types';
import { createSSEParser } from '../src/lib/sse';
const replyChannel = (channel: unknown) =>
	channel === undefined || channel === null || channel === '' || channel === 'final';
const object = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === 'object' && !Array.isArray(value);
export function parseProviderReply(
	response: WireResponse,
	responses: boolean,
): {
	text: string;
	calls: { id: string; name: string; arguments: string }[];
	output: Record<string, unknown>[];
	assistant: Record<string, unknown>;
	inputTokens?: number;
} {
	if (response.status < 200 || response.status >= 300)
		throw new Error(
			`Bot API request failed (HTTP ${response.status}). Check its connection and model.`,
		);
	if (response.encoding !== 'text' || !/json/i.test(response.contentType))
		throw new Error('The bot API returned an invalid response format.');
	if (response.body.length > 2 * 1024 * 1024)
		throw new Error('The bot API response exceeded the 2 MiB reply limit.');
	const data: unknown = JSON.parse(response.body);
	if (!object(data)) throw new Error('The bot API returned an invalid response.');
	const result = {
		text: '',
		calls: [] as { id: string; name: string; arguments: string }[],
		output: [] as Record<string, unknown>[],
		assistant: {} as Record<string, unknown>,
		inputTokens: undefined as number | undefined,
	};
	if (object(data.usage)) {
		const tokens = responses ? data.usage.input_tokens : data.usage.prompt_tokens;
		if (Number.isSafeInteger(tokens) && Number(tokens) >= 0) result.inputTokens = Number(tokens);
	}
	if (responses) {
		if ((data.status !== undefined && data.status !== 'completed') || !Array.isArray(data.output))
			throw new Error('The bot response did not complete.');
		for (const item of data.output) {
			if (!object(item)) continue;
			if (
				item.type === 'message' &&
				item.role === 'assistant' &&
				replyChannel(item.channel) &&
				Array.isArray(item.content)
			)
				for (const part of item.content) {
					if (!object(part)) continue;
					if (part.type === 'output_text' && typeof part.text === 'string')
						result.text += part.text;
					else if (part.type === 'refusal' && typeof part.refusal === 'string')
						result.text += part.refusal;
				}
			if (
				item.type === 'function_call' &&
				(typeof item.call_id !== 'string' ||
					!item.call_id ||
					typeof item.name !== 'string' ||
					!item.name ||
					typeof item.arguments !== 'string')
			)
				throw new Error(
					'The bot returned an invalid function call. No tools in this batch were executed.',
				);
			if (
				item.type === 'function_call' &&
				typeof item.call_id === 'string' &&
				typeof item.name === 'string' &&
				typeof item.arguments === 'string'
			)
				result.calls.push({ id: item.call_id, name: item.name, arguments: item.arguments });
			result.output.push(item);
		}
	} else {
		const choice = Array.isArray(data.choices) ? data.choices[0] : undefined;
		if (
			!object(choice) ||
			!['stop', 'tool_calls', 'function_call'].includes(String(choice.finish_reason)) ||
			!object(choice.message)
		)
			throw new Error('The bot response did not complete.');
		result.assistant = choice.message;
		if (replyChannel(choice.message.channel))
			result.text = contentText(choice.message.content) || contentText(choice.message.refusal);
		if (choice.finish_reason === 'function_call' || choice.message.function_call)
			throw new Error(
				'This provider returned legacy function calls. Use modern tool_calls for bot tools.',
			);
		if (choice.message.tool_calls !== undefined && !Array.isArray(choice.message.tool_calls))
			throw new Error('The bot returned invalid tool calls.');
		if (Array.isArray(choice.message.tool_calls))
			for (const call of choice.message.tool_calls) {
				if (
					!object(call) ||
					typeof call.id !== 'string' ||
					!call.id ||
					!object(call.function) ||
					typeof call.function.name !== 'string' ||
					!call.function.name ||
					typeof call.function.arguments !== 'string'
				)
					throw new Error(
						'The bot returned an invalid function call. No tools in this batch were executed.',
					);
				if (
					object(call) &&
					typeof call.id === 'string' &&
					object(call.function) &&
					typeof call.function.name === 'string' &&
					typeof call.function.arguments === 'string'
				)
					result.calls.push({
						id: call.id,
						name: call.function.name,
						arguments: call.function.arguments,
					});
			}
	}
	if (result.calls.length > 32)
		throw new Error(
			'The bot returned more than 32 tool calls in one batch. No tools in this batch were executed.',
		);
	if (new Set(result.calls.map((call) => call.id)).size !== result.calls.length)
		throw new Error(
			'The bot returned duplicate function call IDs. No tools in this batch were executed.',
		);
	return result;
}

const str = (value: unknown) => (typeof value === 'string' ? value : '');
const record = (value: unknown): Record<string, unknown> => (object(value) ? value : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const contentText = (value: unknown): string =>
	typeof value === 'string'
		? value
		: list(value)
				.map((part) => str(record(part).text) || str(record(part).refusal))
				.join('');

/** Aggregate one model round while exposing only live activity, never reasoning text. */
export function createBotProviderStream(
	responses: boolean,
	onActivity: (activity: BotReplyActivity) => void,
	options: { maxTextCharacters?: number } = {},
) {
	const textLimit = options.maxTextCharacters ?? 32_000;
	let text = '',
		characters = 0,
		events = 0,
		terminal = false,
		finishReason = '',
		toolRound = false;
	let messageChannel: unknown, chatChannel: unknown;
	let lastEvent = 'none',
		error: Error | undefined,
		completion: Record<string, unknown> | undefined;
	let usage: Record<string, unknown> | undefined;
	const items = new Map<number, Record<string, unknown>>();
	const calls = new Map<
		number,
		{ id: string; type: string; function: { name: string; arguments: string } }
	>();
	const extra: Record<string, unknown> = {};
	const details = () =>
		`Stream details: ${characters} characters, ${events} events, last event: ${lastEvent}, completion: ${terminal ? 'received' : 'missing'}.`;
	const fail = (message: string) => new Error(`${message} ${details()}`);
	const output = (delta: string) => {
		text += delta;
		if (text.length > textLimit) throw new Error(`The bot reply exceeded the ${textLimit.toLocaleString('en-US')}-character limit.`);
		if (delta.trim() && !toolRound) onActivity('writing');
	};
	const tool = () => {
		toolRound = true;
		onActivity(
			[...items.values()].some((item) => item.name === 'bot_send_message') ||
			[...calls.values()].some((call) => call.function.name === 'bot_send_message')
				? 'writing'
				: 'thinking',
		);
	};
	const indexFor = (data: Record<string, unknown>) => {
		if (
			Number.isInteger(data.output_index) &&
			Number(data.output_index) >= 0 &&
			Number(data.output_index) < 128
		)
			return Number(data.output_index);
		for (const [index, item] of items) if (data.item_id && item.id === data.item_id) return index;
		throw new Error('A streamed output could not be matched to its item.');
	};
	const parser = createSSEParser((raw, event) => {
		events++;
		lastEvent = /^[\w.-]{1,80}$/.test(event) ? event : 'unnamed';
		if (error) return;
		try {
			if (raw.trim() === '[DONE]') {
				lastEvent = '[DONE]';
				return;
			}
			let data: Record<string, unknown>;
			try {
				const parsed: unknown = JSON.parse(raw);
				if (!object(parsed)) throw new Error();
				data = parsed;
			} catch {
				throw new Error(
					`The bot API sent malformed streaming data: event ${events} is not a valid JSON object.`,
				);
			}
			const type = str(data.type) || event;
			lastEvent = /^[\w.-]{1,80}$/.test(type)
				? type
				: Array.isArray(data.choices)
					? 'chat.completion.chunk'
					: 'unnamed';
			if (type === 'error' || type === 'response.failed' || data.error) {
				const detail = record(record(data.response).error || data.error);
				throw new Error(
					str(detail.message).slice(0, 1000) || 'The bot API reported a streaming failure.',
				);
			}
			if (type === 'response.incomplete') throw new Error('The bot response did not complete.');
			if (responses) {
				if (type.startsWith('response.reasoning')) onActivity('thinking');
				else if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
					const item =
						items.get(Number(data.output_index)) ||
						[...items.values()].find((item) => data.item_id && item.id === data.item_id);
					if (replyChannel(data.channel ?? item?.channel ?? messageChannel))
						output(str(data.delta));
					else onActivity('thinking');
				} else if (type === 'response.output_item.added' || type === 'response.output_item.done') {
					const incoming = record(data.item),
						index = indexFor(data);
					items.set(index, { ...items.get(index), ...incoming });
					if (incoming.type === 'message') {
						messageChannel = incoming.channel;
						if (!replyChannel(messageChannel)) onActivity('thinking');
					}
					if (incoming.type === 'function_call') tool();
					else if (incoming.type === 'reasoning') onActivity('thinking');
				} else if (
					type === 'response.function_call_arguments.delta' ||
					type === 'response.function_call_arguments.done'
				) {
					tool();
					const index = indexFor(data),
						item = items.get(index) || { type: 'function_call', id: data.item_id };
					const args = type.endsWith('.done')
						? str(data.arguments)
						: str(item.arguments) + str(data.delta);
					if (args.length > 256_000)
						throw new Error('The streamed tool arguments exceed the 256 KB limit.');
					items.set(index, { ...item, arguments: args });
				} else if (type === 'response.completed') {
					terminal = true;
					completion = record(data.response);
				}
			} else if (Array.isArray(data.choices)) {
				if (object(data.usage)) usage = data.usage;
				const choice = data.choices
					.map(record)
					.find((entry) => entry.index === 0 || entry.index === undefined);
				if (!choice) return;
				const delta = record(choice.delta);
				if (delta.channel !== undefined) chatChannel = delta.channel;
				if (delta.function_call)
					throw new Error(
						'This provider returned legacy function calls. Use modern tool_calls for bot tools.',
					);
				if (delta.reasoning_content || delta.reasoning || delta.reasoning_details)
					onActivity('thinking');
				for (const key of ['reasoning_content', 'reasoning', 'reasoning_details']) {
					if (typeof delta[key] === 'string') extra[key] = str(extra[key]) + delta[key];
					else if (Array.isArray(delta[key])) extra[key] = [...list(extra[key]), ...delta[key]];
				}
				if (list(delta.tool_calls).length) toolRound = true;
				if (replyChannel(chatChannel))
					output(contentText(delta.content) || contentText(delta.refusal));
				else onActivity('thinking');
				for (const value of list(delta.tool_calls)) {
					const part = record(value),
						index = Number(part.index);
					if (!Number.isInteger(index) || index < 0 || index >= 32)
						throw new Error('The bot API returned an invalid streamed tool-call index.');
					const call = calls.get(index) || {
						id: '',
						type: 'function',
						function: { name: '', arguments: '' },
					};
					if (part.id && call.id && part.id !== call.id)
						throw new Error('A streamed tool call changed its call ID.');
					if (part.id) call.id = str(part.id);
					if (part.type) call.type = str(part.type);
					if (call.type !== 'function')
						throw new Error('The bot returned an unsupported tool call type.');
					const fn = record(part.function);
					if (fn.name && fn.name !== call.function.name) call.function.name += str(fn.name);
					call.function.arguments += str(fn.arguments);
					if (call.function.arguments.length > 256_000)
						throw new Error('The streamed tool arguments exceed the 256 KB limit.');
					calls.set(index, call);
				}
				if (list(delta.tool_calls).length) tool();
				if (choice.finish_reason) {
					finishReason = str(choice.finish_reason);
					if (!['stop', 'tool_calls'].includes(finishReason))
						throw new Error(`The provider stopped this response: ${finishReason}.`);
					terminal = true;
				}
			}
		} catch (value) {
			error = value instanceof Error ? value : new Error('Invalid bot API stream.');
		}
	});
	return {
		push(chunk: string) {
			characters += chunk.length;
			if (characters > 2 * 1024 * 1024)
				throw fail('The bot API response exceeded the 2 MiB reply limit.');
			parser.push(chunk);
			if (error) throw fail(error.message);
		},
		finish(response: WireResponse) {
			if (
				!/text\/event-stream/i.test(response.contentType) ||
				response.status < 200 ||
				response.status >= 300
			)
				return parseProviderReply(response, responses);
			if (response.encoding !== 'text')
				throw fail('The bot API returned an invalid response format.');
			if (!characters && response.body) this.push(response.body);
			parser.finish();
			if (error) throw fail(error.message);
			if (response.stream && response.stream.characters !== characters)
				throw fail('The bot stream delivery was incomplete.');
			if (!terminal)
				throw fail('The bot API stream ended before completion. You can retry this message.');
			let data: Record<string, unknown>;
			if (responses) {
				const output = Array.isArray(completion?.output)
					? completion.output
					: [...items.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
				data = { ...completion, status: completion?.status ?? 'completed', output };
				// Some compatible servers omit final message content but provide complete text deltas.
				if (
					text &&
					!output.some(
						(item) =>
							record(item).type === 'message' &&
							replyChannel(record(item).channel) &&
							contentText(record(item).content),
					)
				)
					output.push({
						type: 'message',
						role: 'assistant',
						content: [{ type: 'output_text', text }],
					});
			} else
				data = {
					usage,
					choices: [
						{
							finish_reason: finishReason,
							message: {
								...extra,
								role: 'assistant',
								content: text || null,
								...(calls.size
									? {
											tool_calls: [...calls.entries()]
												.sort(([a], [b]) => a - b)
												.map(([, call]) => call),
										}
									: {}),
							},
						},
					],
				};
			return parseProviderReply(
				{
					status: response.status,
					encoding: 'text',
					contentType: 'application/json',
					body: JSON.stringify(data),
				},
				responses,
			);
		},
	};
}
