import { messageInputText } from './text-attachments';
import { isVideoFile, MAX_GENERATED_VIDEO_CHARS } from './generated-video';
import type {
	AgentTranscript,
	AgentUpdate,
	ChatActivityPart,
	ToolCallRecord,
	ToolDefinition,
	ToolResult,
	PromptContextSection,
} from '../agent-types';
import { formatPromptContext, normalizePromptContext } from './prompt-context';
import type { CodeCompactionSettings, Connection, Message, WireResponse } from '../types';
import { apiRequest, createSSEParser } from './api';
import {
	assertModelSupports,
	getModelDefinition,
	modelCompactionSettings,
	modelSupports,
	thinkingParameters,
} from './catalog';
import { generatedImageContext } from './generated-image-context';
import { unavailableToolMessage } from './tool-availability';
import {
	COMPACTION_PROMPT,
	ContextTokenUsage,
	compactedContext,
	contextOverflow,
	estimateContextTokens,
	latestContextCheckpoint,
	latestContextUsage,
	trimOldestContextGroup,
} from './context-compaction';

type Item = Record<string, unknown>;
type Call = { id: string; name: string; arguments: string };
interface Round {
	text: string;
	items: Item[];
	calls: Call[];
	inputTokens?: number;
	outputTokens?: number;
}
export interface AgentChatOptions {
	/** Host executions inject their transport without using renderer globals. */
	request?: typeof apiRequest;
	/** Provider-enforced final response format; tool calls remain available. Omitted for compaction. */
	responseFormat?: AgentResponseFormat;
	/** Called only for the final tool-free response, excluding intermediate narration. */
	onFinal?: (text: string) => void;
	connection: Connection;
	model: string;
	history: Message[];
	instructions: string;
	/** Source-labelled host/project context, sent as user context rather than application policy. */
	context?: PromptContextSection[];
	thinkingMode?: string;
	tools: ToolDefinition[];
	signal?: AbortSignal;
	execute: (name: string, args: Record<string, unknown>, callId: string) => Promise<ToolResult>;
	onUpdate: (update: AgentUpdate) => void;
	/** Exact prompt/tool fields immediately before each API request; excludes history/assets. */
	onRequest?: (request: {
		instructions: string;
		context?: PromptContextSection[];
		tools: Record<string, unknown>[];
	}) => void;
	/** Enable context-window checkpoints for interactive Chat and Code conversations. */
	compaction?: boolean;
	/** Global Code policy. Chat omits this and uses automatic compaction defaults. */
	compactionSettings?: Partial<CodeCompactionSettings>;
	/** Pause for queued input only after a complete model response and its tool results. */
	shouldYieldForInput?: () => boolean;
	/** Code-only explicit context tools operate on this exact protocol context. */
	contextControls?: boolean;
	onUsage?: (usage: { tokens: number; estimated: boolean }) => void;
}
export type AgentResponseFormat =
	| { type: 'json_object' }
	| { type: 'json_schema'; name: string; strict: boolean; schema: Record<string, unknown> };

/** Shared Chat Completions/Responses mapping; callers still validate returned data locally. */
export function agentResponseFormatBody(
	format: AgentResponseFormat | undefined,
	responses: boolean,
): Item {
	if (!format) return {};
	return responses
		? { text: { format } }
		: {
				response_format:
					format.type === 'json_schema'
						? {
								type: 'json_schema',
								json_schema: { name: format.name, strict: format.strict, schema: format.schema },
							}
						: format,
			};
}
export type AgentChatResult = AgentUpdate & {
	yieldedForInput?: boolean;
	/** Already-discovered definitions remain available when the caller resumes the same run. */
	continuationTools?: ToolDefinition[];
};
const MAX_CALLS_PER_TURN = 16;
const MAX_TOOLS = 128;
const MAX_ARGUMENT_CHARS = 256 * 1024;
const MAX_TEXT_CHARS = 2 * 1024 * 1024;
const MAX_RESULT_CHARS = 64 * 1024;
const MAX_IMAGE_CHARS = 24 * 1024 * 1024;
const MAX_GENERATED_IMAGE_CHARS = 45_000_128;
const PREVIEW_NOTE =
	'Generated image previews are attached for visual review. Full-resolution originals remain available in FreeLM.';
const PREVIEW_UNAVAILABLE =
	'The generated image is available in FreeLM, but a bounded preview could not be decoded. Do not claim to have inspected its pixels.';
const abortError = () => new DOMException('Request cancelled.', 'AbortError');
const object = (value: unknown): Item =>
	value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Item) : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const string = (value: unknown): string => (typeof value === 'string' ? value : '');
function textContent(value: unknown): string {
	return typeof value === 'string'
		? value
		: list(value)
				.map((part) => string(object(part).text) || string(object(part).refusal))
				.join('');
}
function responseText(items: Item[]): string {
	return items
		.filter((item) => item.type === 'message')
		.map((item) => textContent(item.content))
		.join('');
}
function detail(value: unknown, fallback = 'The API request failed.'): string {
	const data = object(value);
	return string(data.message) || (data.error ? detail(data.error, fallback) : fallback);
}
function checkAbort(signal?: AbortSignal) {
	if (signal?.aborted) throw abortError();
}
async function cancellable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return operation;
	checkAbort(signal);
	let cancel: () => void = () => {};
	const aborted = new Promise<never>((_, reject) => {
		cancel = () => reject(abortError());
		signal.addEventListener('abort', cancel, { once: true });
	});
	try {
		return await Promise.race([operation, aborted]);
	} finally {
		signal.removeEventListener('abort', cancel);
	}
}

/** Stable across discovery and history replay; collisions are rejected when building the catalog. */
export function toolApiName(name: string): string {
	if (/^[A-Za-z0-9_-]{1,64}$/.test(name)) return name;
	let hash = 14695981039346656037n;
	for (const byte of new TextEncoder().encode(name)) {
		hash ^= BigInt(byte);
		hash = BigInt.asUintN(64, hash * 1099511628211n);
	}
	return `${name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 47)}_${hash.toString(16).padStart(16, '0')}`;
}

function plainHistory(message: Message, responses: boolean): Item {
	const images = (message.attachments || []).filter((attachment) =>
		attachment.type.startsWith('image/'),
	);
	if (responses)
		return {
			role: message.role,
			content:
				message.role === 'assistant'
					? messageInputText(message)
					: [
							...(messageInputText(message)
								? [{ type: 'input_text', text: messageInputText(message) }]
								: []),
							...images.map((image) => ({
								type: 'input_image',
								image_url: image.dataUrl,
								detail: 'auto',
							})),
						],
		};
	return {
		role: message.role,
		content: images.length
			? [
					{ type: 'text', text: messageInputText(message) },
					...images.map((image) => ({ type: 'image_url', image_url: { url: image.dataUrl } })),
				]
			: messageInputText(message),
	};
}

/** Old saved image-generation transcripts can contain full-resolution PNGs. Never mutate them. */
async function generatedImageHistory(
	message: Message,
	responses: boolean,
	signal?: AbortSignal,
	start = 0,
): Promise<Item[]> {
	const items = start
		? message.agentTranscript!.items.slice(start)
		: message.agentTranscript!.items;
	const callIds = new Set(
		(message.toolCalls || [])
			.filter((call) => call.name === 'image_gen.imagegen')
			.map((call) => call.id),
	);
	const generatedName = toolApiName('image_gen.imagegen');
	for (const item of items) {
		if (
			item.type === 'function_call' &&
			(item.name === generatedName || item.name === 'image_gen.imagegen')
		)
			callIds.add(string(item.call_id));
		for (const value of list(item.tool_calls)) {
			const call = object(value);
			if ([generatedName, 'image_gen.imagegen'].includes(string(object(call.function).name)))
				callIds.add(string(call.id));
		}
	}
	if (!callIds.size) return items;
	const replay: Item[] = [];
	for (const item of items) {
		checkAbort(signal);
		const output = responses ? item.output : item.content;
		const generated = responses
			? item.type === 'function_call_output' && callIds.has(string(item.call_id))
			: item.role === 'user' &&
				list(output).some((part) =>
					[...callIds].some((id) =>
						string(object(part).text).startsWith(`Images returned by tool call ${id} (`),
					),
				);
		if (!generated || !Array.isArray(output)) {
			replay.push(item);
			continue;
		}
		const content: Item[] = [];
		let previewed = false;
		for (const value of output) {
			const part = object(value);
			const imageUrl = responses
				? part.type === 'input_image' && string(part.image_url)
				: part.type === 'image_url' && string(object(part.image_url).url);
			if (!imageUrl || !imageUrl.startsWith('data:')) {
				content.push(part);
				continue;
			}
			const preview = await generatedImageContext(imageUrl, signal);
			checkAbort(signal);
			if (!preview)
				content.push({ type: responses ? 'input_text' : 'text', text: PREVIEW_UNAVAILABLE });
			else {
				previewed ||= preview !== imageUrl;
				content.push({
					...part,
					image_url: responses ? preview : { ...object(part.image_url), url: preview },
				});
			}
		}
		if (previewed) content.push({ type: responses ? 'input_text' : 'text', text: PREVIEW_NOTE });
		replay.push({ ...item, [responses ? 'output' : 'content']: content });
	}
	return replay;
}

function validateCalls(calls: Call[]): void {
	if (calls.length > MAX_CALLS_PER_TURN)
		throw new Error(`The model requested more than ${MAX_CALLS_PER_TURN} tools in one turn.`);
	const ids = new Set<string>();
	for (const call of calls) {
		if (!call.id || call.id.length > 512 || /[\s\u0000-\u001f]/.test(call.id))
			throw new Error(
				'The API returned a tool call without a valid call ID. No tools were executed for this turn.',
			);
		if (ids.has(call.id))
			throw new Error(
				'The API returned duplicate tool call IDs. No tools were executed for this turn.',
			);
		ids.add(call.id);
		if (!call.name || call.name.length > 256 || call.arguments.length > MAX_ARGUMENT_CHARS)
			throw new Error(
				'The API returned an invalid or oversized tool call. No tools were executed for this turn.',
			);
	}
}

function parseRound(
	data: Item,
	responses: boolean,
	streamedText = '',
	streamedItems: Item[] = [],
): Round {
	if (data.error || data.status === 'failed' || data.status === 'incomplete')
		throw new Error(detail(data.error || data, `The response was ${String(data.status)}.`));
	const usage = object(data.usage);
	const inputTokensValue = responses ? usage.input_tokens : usage.prompt_tokens;
	const inputTokens =
		typeof inputTokensValue === 'number' &&
		Number.isSafeInteger(inputTokensValue) &&
		inputTokensValue >= 0
			? inputTokensValue
			: undefined;
	const outputValue = responses ? usage.output_tokens : usage.completion_tokens;
	const outputTokens =
		typeof outputValue === 'number' && Number.isSafeInteger(outputValue) && outputValue >= 0
			? outputValue
			: undefined;
	if (responses) {
		let items = Array.isArray(data.output) ? data.output.map(object) : streamedItems;
		const text = responseText(items) || string(data.output_text) || streamedText;
		if (!items.some((item) => item.type === 'message') && text)
			items = [
				...items,
				{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
			];
		const calls = items
			.filter((item) => item.type === 'function_call')
			.map((item) => ({
				id: string(item.call_id),
				name: string(item.name),
				arguments: string(item.arguments),
			}));
		validateCalls(calls);
		return { text, items, calls, inputTokens, outputTokens };
	}
	const choice = object(list(data.choices)[0]);
	if (choice.finish_reason === 'length' || choice.finish_reason === 'content_filter')
		throw new Error(`The provider stopped this response: ${String(choice.finish_reason)}.`);
	const message = object(choice.message);
	const text = textContent(message.content) || textContent(message.refusal) || streamedText;
	const calls = list(message.tool_calls).map((value) => {
		const call = object(value);
		if (call.type && call.type !== 'function')
			throw new Error('The API returned an unsupported tool call type.');
		return {
			id: string(call.id),
			name: string(object(call.function).name),
			arguments: string(object(call.function).arguments),
		};
	});
	validateCalls(calls);
	return {
		text,
		calls,
		items: [{ ...message, role: 'assistant', content: text || null }],
		inputTokens,
		outputTokens,
	};
}

async function requestRound(
	options: AgentChatOptions,
	body: Item,
	onText: (text: string) => void,
	onReasoning: () => void,
): Promise<Round> {
	const responses = options.connection.chatApi === 'responses';
	let text = '';
	let terminal = false;
	let finishedChoice = false;
	let streamError: Error | undefined;
	let completion: Item | undefined;
	let receivedCharacters = 0;
	let receivedBytes: number | undefined;
	let eventCount = 0;
	let lastEvent = 'none';
	const items = new Map<number, Item>();
	const chatCalls = new Map<
		number,
		{ id: string; type: string; function: { name: string; arguments: string } }
	>();
	const chatExtra: Item = {};
	let chatUsage: Item | undefined;
	const diagnostics = () =>
		`Stream details: ${receivedBytes === undefined ? '' : `${receivedBytes} bytes, `}${receivedCharacters} characters, ${eventCount} events, last event: ${lastEvent}, completion: ${terminal ? 'received' : 'missing'}.`;
	const withDetails = (error: Error) =>
		new Error(`${error.message} ${diagnostics()}`, { cause: error });
	const emit = (delta: string) => {
		text += delta;
		if (text.length > MAX_TEXT_CHARS)
			throw new Error('The model output exceeds the 2 MB text limit.');
		if (delta) onText(text);
	};
	const indexFor = (data: Item): number => {
		if (Number.isInteger(data.output_index) && Number(data.output_index) >= 0)
			return Number(data.output_index);
		const id = string(data.item_id);
		for (const [index, item] of items) if (id && item.id === id) return index;
		throw new Error('A streamed tool argument could not be matched to its output item.');
	};
	const parser = createSSEParser((raw, event) => {
		eventCount += 1;
		lastEvent = /^[\w.-]{1,80}$/.test(event) ? event : 'unnamed';
		if (streamError) return;
		try {
			if (raw.trim() === '[DONE]') {
				lastEvent = '[DONE]';
				if (!responses && (!chatCalls.size || finishedChoice)) terminal = true;
				return;
			}
			let data: Item;
			try {
				const parsed: unknown = JSON.parse(raw);
				if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
				data = parsed as Item;
			} catch {
				throw new Error(
					`The API sent malformed streaming data: event ${eventCount} (${lastEvent}, ${raw.length} characters) is not a valid JSON object.`,
				);
			}
			const type = string(data.type) || event;
			if (!responses && data.usage) chatUsage = object(data.usage);
			if (type.startsWith('response.reasoning')) onReasoning();
			lastEvent = /^[\w.-]{1,80}$/.test(type)
				? type
				: Array.isArray(data.choices)
					? 'chat.completion.chunk'
					: 'unnamed';
			if (type === 'error' || type === 'response.failed' || data.error)
				throw new Error(detail(data.response || data));
			if (type === 'response.incomplete')
				throw new Error(
					`The response was incomplete: ${string(object(object(data.response).incomplete_details).reason) || 'generation stopped early'}.`,
				);
			if (type === 'response.output_text.delta' || type === 'response.refusal.delta')
				emit(string(data.delta));
			else if (type === 'response.output_item.added' || type === 'response.output_item.done') {
				const index = indexFor(data);
				const incoming = object(data.item);
				items.set(index, { ...items.get(index), ...incoming });
			} else if (
				type === 'response.function_call_arguments.delta' ||
				type === 'response.function_call_arguments.done'
			) {
				const index = indexFor(data);
				const item = items.get(index) || { type: 'function_call', id: data.item_id };
				const args = type.endsWith('.done')
					? string(data.arguments)
					: string(item.arguments) + string(data.delta);
				if (args.length > MAX_ARGUMENT_CHARS)
					throw new Error('The streamed tool arguments exceed the 256 KB limit.');
				items.set(index, { ...item, arguments: args });
			} else if (type === 'response.completed') {
				terminal = true;
				completion = object(data.response);
			} else if (!responses && Array.isArray(data.choices)) {
				const choice = data.choices
					.map(object)
					.find((item) => item.index === 0 || item.index === undefined);
				if (!choice) return;
				const delta = object(choice.delta);
				if (delta.reasoning_content || delta.reasoning || delta.reasoning_details) onReasoning();
				emit(textContent(delta.content) || textContent(delta.refusal));
				for (const key of ['reasoning_content', 'reasoning', 'reasoning_details']) {
					if (typeof delta[key] === 'string') chatExtra[key] = string(chatExtra[key]) + delta[key];
					else if (Array.isArray(delta[key]))
						chatExtra[key] = [...list(chatExtra[key]), ...delta[key]];
				}
				for (const entry of list(delta.tool_calls)) {
					const part = object(entry);
					const index = Number(part.index);
					if (!Number.isInteger(index) || index < 0 || index >= MAX_CALLS_PER_TURN)
						throw new Error('The API returned an invalid streamed tool-call index.');
					const call = chatCalls.get(index) || {
						id: '',
						type: 'function',
						function: { name: '', arguments: '' },
					};
					// IDs are normally sent once. Some compatible providers repeat the complete ID.
					if (part.id && call.id && call.id !== part.id)
						throw new Error('A streamed tool call changed its call ID.');
					if (part.id) call.id = string(part.id);
					if (part.type) call.type = string(part.type);
					const fn = object(part.function);
					if (fn.name && call.function.name !== fn.name) call.function.name += string(fn.name);
					call.function.arguments += string(fn.arguments);
					if (call.function.arguments.length > MAX_ARGUMENT_CHARS)
						throw new Error('The streamed tool arguments exceed the 256 KB limit.');
					chatCalls.set(index, call);
				}
				if (choice.finish_reason) {
					if (!['stop', 'tool_calls'].includes(string(choice.finish_reason)))
						throw new Error(`The provider stopped this response: ${String(choice.finish_reason)}.`);
					terminal = true;
					finishedChoice = true;
				}
			}
		} catch (error) {
			streamError = error instanceof Error ? error : new Error('Invalid API stream.');
		}
	});
	let result: WireResponse;
	try {
		checkAbort(options.signal);
		options.onRequest?.({
			instructions:
				typeof body.instructions === 'string'
					? body.instructions
					: string(
							list(body.messages)
								.map(object)
								.find((message) => message.role === 'system')?.content,
						),
			tools: list(body.tools).map(object),
			...(options.context?.length ? { context: options.context } : {}),
		});
		let compatibleBody = body;
		let streaming = true;
		for (;;) {
			try {
				result = await (options.request ?? apiRequest)(
					options.connection,
					{
						method: 'POST',
						path: `/${options.connection.chatApi}`,
						body: compatibleBody,
						stream: streaming,
					},
					options.signal,
					(chunk) => {
						receivedCharacters += chunk.length;
						parser.push(chunk);
					},
				);
				break;
			} catch (error) {
				// Each capability can be removed once, only after an explicit rejection before bytes arrive.
				if (
					receivedCharacters ||
					!(error instanceof Error) ||
					!/^API (400|422):/i.test(error.message)
				)
					throw error;
				if (
					compatibleBody.stream_options &&
					/stream_options|include_usage/i.test(error.message) &&
					/unsupported|not supported|unknown|unrecognized|unexpected|extra|not permitted/i.test(
						error.message,
					)
				) {
					const { stream_options: _usage, ...withoutUsage } = compatibleBody;
					compatibleBody = withoutUsage;
					continue;
				}
				if (
					streaming &&
					/(?:stream(?:ing)?.*(?:unsupported|not supported)|(?:unsupported|not supported).*stream)/i.test(
						error.message,
					)
				) {
					const { stream_options: _usage, ...withoutUsage } = compatibleBody;
					compatibleBody = { ...withoutUsage, stream: false };
					streaming = false;
					continue;
				}
				throw error;
			}
		}
	} catch (error) {
		if (options.signal?.aborted || (error instanceof Error && error.name === 'AbortError'))
			throw error;
		parser.finish();
		if (receivedCharacters) {
			const transportError = error instanceof Error ? error.message : 'The API connection failed.';
			throw withDetails(
				new Error(
					streamError
						? `${streamError.message} Transport error: ${transportError}`
						: transportError,
				),
			);
		}
		throw error;
	}
	checkAbort(options.signal);
	let round: Round;
	if (/text\/event-stream/i.test(result.contentType)) {
		receivedBytes = result.stream?.bytes;
		parser.finish();
		if (streamError) throw withDetails(streamError);
		if (!terminal)
			throw withDetails(
				new Error('The API stream ended before completion. You can retry this message.'),
			);
		try {
			if (responses)
				round = parseRound(
					completion || {},
					true,
					text,
					[...items.entries()].sort(([a], [b]) => a - b).map(([, item]) => item),
				);
			else
				round = parseRound(
					{
						usage: chatUsage,
						choices: [
							{
								message: {
									...chatExtra,
									content: text,
									...(chatCalls.size
										? {
												tool_calls: [...chatCalls.entries()]
													.sort(([a], [b]) => a - b)
													.map(([, call]) => call),
											}
										: {}),
								},
							},
						],
					},
					false,
					text,
				);
		} catch (error) {
			throw withDetails(error instanceof Error ? error : new Error('Invalid tool response.'));
		}
	} else {
		let data: unknown;
		try {
			data = JSON.parse(result.body);
		} catch {
			throw new Error('The API returned an invalid JSON response.');
		}
		if (!data || typeof data !== 'object' || Array.isArray(data))
			throw new Error('The API returned an invalid JSON object.');
		round = parseRound(data as Item, responses);
	}
	if (round.text.length > MAX_TEXT_CHARS)
		throw new Error('The model output exceeds the 2 MB text limit.');
	onText(round.text);
	if (!round.text && !round.calls.length)
		throw new Error('The API returned neither text nor tool calls.');
	return round;
}

function boundedResult(
	result: ToolResult,
	budget: { text: number; images: number; generatedImages: number; videos: number; files: number },
	imageGeneration = false,
): ToolResult {
	if (!result || !Array.isArray(result.content))
		throw new Error('The tool returned an invalid result.');
	let remaining = Math.min(MAX_RESULT_CHARS, budget.text);
	let truncated = false;
	let images = 0;
	let imageChars = 0;
	const content: ToolResult['content'] = [];
	for (const part of result.content) {
		if (part.type === 'text' && typeof part.text === 'string') {
			if (remaining <= 0) {
				truncated = true;
				continue;
			}
			const text = part.text.slice(0, remaining);
			remaining -= text.length;
			budget.text -= text.length;
			content.push({ type: 'text', text });
			if (text.length < part.text.length) truncated = true;
		} else if (
			part.type === 'image' &&
			typeof part.dataUrl === 'string' &&
			/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(part.dataUrl)
		) {
			const imageLimit = imageGeneration ? MAX_GENERATED_IMAGE_CHARS : MAX_IMAGE_CHARS;
			const remainingImages = imageGeneration ? budget.generatedImages : budget.images;
			if (
				++images <= 4 &&
				(imageChars += part.dataUrl.length) <= imageLimit &&
				part.dataUrl.length <= remainingImages
			) {
				content.push(part);
				if (imageGeneration) budget.generatedImages -= part.dataUrl.length;
				else budget.images -= part.dataUrl.length;
			} else
				content.push({
					type: 'text',
					text: '[Image omitted because it exceeds the tool result size limit.]',
				});
		} else if (
			part.type === 'file' &&
			typeof part.dataUrl === 'string' &&
			typeof part.name === 'string' &&
			part.name.length <= 240 &&
			/^data:[a-zA-Z0-9.+\/-]+;base64,[A-Za-z0-9+/=]*$/.test(part.dataUrl)
		) {
			const video = isVideoFile(part);
			const limit = video ? MAX_GENERATED_VIDEO_CHARS : 12_000_000;
			if (
				part.dataUrl.length <= limit &&
				part.dataUrl.length <= (video ? budget.videos : budget.files)
			) {
				content.push(part);
				if (video) budget.videos -= part.dataUrl.length;
				else budget.files -= part.dataUrl.length;
				content.push({
					type: 'text',
					text: `Created file: ${part.name} (${part.mimeType}). Available for download.`,
				});
			} else
				content.push({
					type: 'text',
					text: `[File omitted because it exceeds the tool result size limit: ${part.name}.]`,
				});
		}
	}
	if (truncated)
		content.push({
			type: 'text',
			text: '\n[Tool output truncated: 64 KB per result, 512 KB per model round.]',
		});
	return {
		...result,
		content: content.length ? content : [{ type: 'text', text: '(Tool returned no content.)' }],
	};
}

export async function streamAgentChat(options: AgentChatOptions): Promise<AgentChatResult> {
	options = { ...options, context: normalizePromptContext(options.context) };
	const { connection, model, history, instructions, execute, onUpdate, signal } = options;
	checkAbort(signal);
	if (!model.trim()) throw new Error('Choose a chat model first.');
	if (
		history.some((message) =>
			message.attachments?.some((attachment) => /^(audio|video)\//.test(attachment.type)),
		)
	)
		throw new Error(
			'Audio and video chat attachments are not supported yet. Use the audio or video playground.',
		);
	assertModelSupports(
		connection,
		model,
		'chat',
		history.some((message) =>
			message.attachments?.some((attachment) => attachment.type.startsWith('image/')),
		)
			? ['image']
			: [],
	);
	const responses = connection.chatApi === 'responses';
	const suppliedContext = formatPromptContext(options.context);
	const contextPrefix: Item[] = suppliedContext
		? [
				{
					role: 'user',
					content: responses ? [{ type: 'input_text', text: suppliedContext }] : suppliedContext,
				},
			]
		: [];
	// Context is fixed for this segment, survives compaction, and is never persisted into history.
	const estimateInput = (items: Item[], definitions: Item[]) =>
		estimateContextTokens([...contextPrefix, ...items], instructions, definitions);
	const api: AgentTranscript['api'] = responses ? 'responses' : 'chat';
	const acceptsImages = modelSupports(connection, model, 'chat', ['image']);
	const transcript: AgentTranscript = { api, items: [] };
	let content = '';
	let toolCalls: ToolCallRecord[] = [];
	let activity: ChatActivityPart[] = [];
	let phase: NonNullable<AgentUpdate['phase']> = 'working';
	let activityFinishedAt: number | undefined;
	const publish = (): AgentUpdate => {
		const update = {
			content,
			toolCalls: [...toolCalls],
			transcript: {
				api,
				items: [...transcript.items],
				...(transcript.context ? { context: transcript.context } : {}),
				...(transcript.usage ? { usage: transcript.usage } : {}),
				...(transcript.contextWindows ? { contextWindows: [...transcript.contextWindows] } : {}),
			},
			activity: [...activity],
			phase,
			...(activityFinishedAt === undefined ? {} : { activityFinishedAt }),
		};
		onUpdate(update);
		return update;
	};
	const available = new Map<string, ToolDefinition>();
	const names = new Map<string, string>();
	const addTools = (tools: ToolDefinition[], discovered = false) => {
		for (const tool of tools) {
			if (tool.deferred && !discovered) continue;
			if (
				!tool.name ||
				tool.name.length > 512 ||
				!tool.parameters ||
				typeof tool.parameters !== 'object' ||
				Array.isArray(tool.parameters)
			)
				throw new Error('The tool catalog contains an invalid definition.');
			const name = toolApiName(tool.name);
			if (names.has(name) && names.get(name) !== tool.name)
				throw new Error('Two tools map to the same API name. Rename one of the tools.');
			if (!available.has(tool.name) && available.size >= MAX_TOOLS)
				throw new Error(`At most ${MAX_TOOLS} tools may be exposed in a chat.`);
			names.set(name, tool.name);
			// Discovery cannot replace the implementation or schema of an existing tool.
			if (!available.has(tool.name)) available.set(tool.name, tool);
		}
	};
	addTools(options.tools);
	const yieldForInput = (): AgentChatResult | undefined => {
		checkAbort(signal);
		if (!options.shouldYieldForInput?.()) return;
		checkAbort(signal);
		activityFinishedAt ??= Date.now();
		return {
			...publish(),
			yieldedForInput: true,
			continuationTools: [...available.values()].map((tool) => ({ ...tool, deferred: false })),
		};
	};
	const input: Item[] = [];
	const previousContext = options.compaction
		? latestContextCheckpoint(history, api, model, connection.id)
		: undefined;
	if (previousContext) input.push(...previousContext.checkpoint.items);
	for (const [index, message] of history.entries()) {
		if (previousContext && index < previousContext.index) continue;
		if (
			message.role === 'assistant' &&
			message.agentTranscript?.api === api &&
			message.agentTranscript.items.length
		)
			input.push(
				...(await generatedImageHistory(
					message,
					responses,
					signal,
					previousContext && index === previousContext.index
						? previousContext.checkpoint.transcriptItemCount
						: 0,
				)),
			);
		else if (message.content || message.replyTo || message.attachments?.length)
			input.push(plainHistory(message, responses));
	}
	const seenIds = new Set<string>();
	for (const item of input) {
		if (item.type === 'function_call') seenIds.add(string(item.call_id));
		for (const call of list(item.tool_calls)) seenIds.add(string(object(call).id));
	}
	const parameters = thinkingParameters(connection, model, options.thinkingMode);
	const settings = modelCompactionSettings(
		getModelDefinition(connection, model),
		options.compactionSettings,
	);
	const tokenUsage = new ContextTokenUsage();
	const previousUsage = options.compaction
		? latestContextUsage(history, api, model, connection.id)
		: undefined;
	if (previousUsage)
		tokenUsage.observe(previousUsage.estimatedInputTokens, previousUsage.inputTokens);
	let contextItems = input;
	let contextOffset = 0;
	let compactionCount = previousContext?.checkpoint.compactionCount || 0;
	const currentContext = () => [...contextItems, ...transcript.items.slice(contextOffset)];
	const requestBody = (items: Item[], definitions: Item[], summary = false): Item =>
		responses
			? {
					...parameters,
					...(!summary ? agentResponseFormatBody(options.responseFormat, true) : {}),
					model,
					stream: true,
					store: false,
					include: ['reasoning.encrypted_content'],
					input: [...contextPrefix, ...items],
					...(instructions.trim() ? { instructions: instructions.trim() } : {}),
					...(definitions.length && !summary
						? { tools: definitions.map((definition) => ({ type: 'function', ...definition })) }
						: {}),
				}
			: {
					...parameters,
					...(!summary ? agentResponseFormatBody(options.responseFormat, false) : {}),
					model,
					stream: true,
					messages: [
						...(instructions.trim() ? [{ role: 'system', content: instructions.trim() }] : []),
						...contextPrefix,
						...items,
					],
					...(definitions.length && !summary
						? {
								tools: definitions.map((definition) => ({
									type: 'function',
									function: definition,
								})),
							}
						: {}),
					...(summary ? {} : { stream_options: { include_usage: true } }),
				};
	const compact = async (definitions: Item[], force = false) => {
		const original = currentContext();
		const before = tokenUsage.count(estimateInput(original, definitions));
		if (!force && before < settings.triggerTokens) return;
		phase = 'compacting';
		publish();
		let candidate = original;
		const fixedTokens = estimateInput([], definitions);
		const usableTokens = Math.max(0, settings.triggerTokens - fixedTokens);
		const summaryTokenBudget = Math.max(64, Math.min(8192, Math.floor(usableTokens * 0.35)));
		const compactionPrompt = `${COMPACTION_PROMPT}\nAim for at most ${summaryTokenBudget} tokens. Use fewer when the remaining state is simple.`;
		const prompt: Item = {
			role: 'user',
			content: responses ? [{ type: 'input_text', text: compactionPrompt }] : compactionPrompt,
		};
		let summary: Round;
		try {
			while (true) {
				checkAbort(signal);
				try {
					summary = await requestRound(
						options,
						requestBody([...candidate, prompt], [], true),
						() => {},
						() => {},
					);
					break;
				} catch (error) {
					if (signal?.aborted || (error instanceof Error && error.name === 'AbortError'))
						throw error;
					const trimmed = contextOverflow(error) ? trimOldestContextGroup(candidate) : undefined;
					if (!trimmed) throw error;
					candidate = trimmed;
				}
			}
			checkAbort(signal);
			if (!summary.text.trim() || summary.calls.length)
				throw new Error('The summary request returned no usable tool-free summary.');
			const feasibleUserBudget = Math.min(20_000, Math.floor(usableTokens * 0.4));
			const replacement = compactedContext(summary.text, history, responses, feasibleUserBudget);
			const after = estimateInput(replacement, definitions);
			if (after >= before || after >= settings.triggerTokens)
				throw new Error(
					"The summary did not free enough context. Shorten the latest request or increase this model's context window.",
				);
			// Install atomically after successful validation; original display history stays intact.
			contextItems = replacement;
			contextOffset = transcript.items.length;
			transcript.context = {
				version: 1,
				kind: 'compaction',
				api,
				model,
				connectionId: connection.id,
				historyMessageIds: history.map((message) => message.id),
				transcriptItemCount: contextOffset,
				items: replacement,
				createdAt: Date.now(),
				compactionCount: ++compactionCount,
				inputTokensBefore: before,
				inputTokensAfter: after,
			};
			transcript.contextWindows = [
				...(transcript.contextWindows ?? []),
				{
					id: crypto.randomUUID(),
					transcriptItemCount: contextOffset,
					historyMessageIds: history.map((message) => message.id),
					createdAt: Date.now(),
					kind: 'compaction',
				},
			];
			tokenUsage.reset();
			delete transcript.usage;
			publish();
		} catch (error) {
			if (signal?.aborted || (error instanceof Error && error.name === 'AbortError'))
				throw abortError();
			throw new Error(
				`Context compaction failed; the original conversation is preserved. ${error instanceof Error ? error.message : 'The summary could not be created.'}`,
				{ cause: error },
			);
		}
	};
	for (;;) {
		checkAbort(signal);
		// Discovery takes effect on the next model request, never midway through a call batch.
		const offeredNames = new Map(names);
		const offeredTools = [...available.values()];
		const definitions = offeredTools.map((tool) => ({
			name: toolApiName(tool.name),
			description: tool.description,
			parameters: tool.parameters,
			strict: false,
		}));
		if (options.compaction) await compact(definitions);
		const outputBudget = {
			text: 512 * 1024,
			images: 48 * 1024 * 1024,
			generatedImages: MAX_GENERATED_IMAGE_CHARS * 2,
			videos: MAX_GENERATED_VIDEO_CHARS * 2,
			files: 32 * 1024 * 1024,
		};
		const prefix = content ? `${content}\n\n` : '';
		const textId = crypto.randomUUID();
		let firstTextAt: number | undefined;
		phase = 'working';
		publish();
		const updateText = (text: string) => {
			content = text ? prefix + text : prefix.trimEnd();
			if (text) {
				firstTextAt ??= Date.now();
				phase = 'responding';
				const part: ChatActivityPart = { type: 'text', id: textId, text };
				activity = activity.some((item) => item.id === textId)
					? activity.map((item) => (item.id === textId ? part : item))
					: [...activity, part];
			}
			publish();
		};
		const updateReasoning = () => {
			if (phase !== 'working') {
				phase = 'working';
				publish();
			}
		};
		let round: Round;
		let estimatedInput = estimateInput(currentContext(), definitions);
		const previousContent = content;
		const previousActivity = [...activity];
		try {
			round = await requestRound(
				options,
				requestBody(currentContext(), definitions),
				updateText,
				updateReasoning,
			);
		} catch (error) {
			if (
				!options.compaction ||
				!contextOverflow(error) ||
				signal?.aborted ||
				(error instanceof Error && error.name === 'AbortError')
			)
				throw error;
			// A rejected model round has executed no tools. Compact, then retry that request once.
			content = previousContent;
			activity = previousActivity;
			firstTextAt = undefined;
			await compact(definitions, true);
			estimatedInput = estimateInput(currentContext(), definitions);
			phase = 'working';
			publish();
			round = await requestRound(
				options,
				requestBody(currentContext(), definitions),
				updateText,
				updateReasoning,
			);
		}
		checkAbort(signal);
		tokenUsage.observe(estimatedInput, round.inputTokens);
		options.onUsage?.({
			tokens:
				(round.inputTokens ?? estimatedInput) +
				(round.outputTokens ?? estimateContextTokens(round.items)),
			estimated: round.inputTokens === undefined || round.outputTokens === undefined,
		});
		if (round.inputTokens !== undefined)
			transcript.usage = {
				version: 1,
				model,
				connectionId: connection.id,
				historyMessageIds: history.map((message) => message.id),
				estimatedInputTokens: estimatedInput,
				inputTokens: round.inputTokens,
			};
		for (const call of round.calls) {
			if (seenIds.has(call.id))
				throw new Error(
					'The API reused a previous tool call ID. No tools were executed for this turn.',
				);
			seenIds.add(call.id);
		}
		const roundTranscriptStart = transcript.items.length;
		let resetContextRequested = false;
		transcript.items.push(...round.items);
		publish();
		if (!round.calls.length) {
			activityFinishedAt = firstTextAt ?? Date.now();
			options.onFinal?.(round.text);
			return yieldForInput() ?? publish();
		}
		const chatImages: Item[] = [];
		const interruptCalls = (pendingCalls: Call[]) => {
			const cancelled: ToolResult = {
				isError: true,
				content: [{ type: 'text', text: 'Tool call interrupted by cancellation.' }],
			};
			// Every requested call needs a matching result, including calls not yet executed.
			for (const pending of pendingCalls) {
				const existing = toolCalls.find((item) => item.id === pending.id);
				const stopped: ToolCallRecord = {
					...(existing || {
						id: pending.id,
						name: offeredNames.get(pending.name) || pending.name,
						arguments: pending.arguments,
						startedAt: Date.now(),
					}),
					status: 'failed',
					result: cancelled,
					completedAt: Date.now(),
				};
				toolCalls = existing
					? toolCalls.map((item) => (item.id === pending.id ? stopped : item))
					: [...toolCalls, stopped];
				transcript.items.push(
					responses
						? {
								type: 'function_call_output',
								call_id: pending.id,
								output: 'Tool error: Tool call interrupted by cancellation.',
							}
						: {
								role: 'tool',
								tool_call_id: pending.id,
								content: 'Tool error: Tool call interrupted by cancellation.',
							},
				);
			}
		};
		for (const [callIndex, call] of round.calls.entries()) {
			const name = offeredNames.get(call.name);
			const record: ToolCallRecord = {
				id: call.id,
				name: name || call.name,
				arguments: call.arguments,
				status: 'running',
				startedAt: Date.now(),
			};
			toolCalls = [...toolCalls, record];
			activity = [...activity, { type: 'tool', id: `tool-${call.id}`, toolCallId: call.id }];
			phase = 'tools';
			publish();
			let result: ToolResult;
			try {
				checkAbort(signal);
				if (!name || !available.has(name))
					throw new Error(
						unavailableToolMessage(
							call.name,
							offeredTools.map((tool) => ({
								name: tool.name,
								apiName: toolApiName(tool.name),
								source: tool.source,
							})),
							[...available.values()]
								.filter((tool) => !offeredNames.has(toolApiName(tool.name)))
								.map((tool) => ({
									name: tool.name,
									apiName: toolApiName(tool.name),
									source: tool.source,
								})),
						),
					);
				let args: unknown;
				try {
					args = JSON.parse(call.arguments);
				} catch {
					throw new Error('Tool arguments must be valid JSON. Correct the arguments and retry.');
				}
				if (!args || typeof args !== 'object' || Array.isArray(args))
					throw new Error('Tool arguments must be a JSON object.');
				let executed: ToolResult;
				if (options.contextControls && ['get_context_remaining', 'new_context'].includes(name)) {
					if (Object.keys(args).length) throw new Error('This context tool accepts no arguments.');
					if (name === 'new_context') {
						resetContextRequested = true;
						executed = {
							content: [
								{
									type: 'text',
									text: 'A fresh context will be applied after this complete tool exchange. Original history, memory, notes and execution sessions remain available. No summary is created.',
								},
							],
						};
					} else {
						const used = tokenUsage.count(estimateInput(currentContext(), definitions));
						executed = {
							content: [
								{
									type: 'text',
									text: JSON.stringify({
										context_window: settings.contextWindow,
										estimated_input_tokens: used,
										remaining_tokens: Math.max(0, settings.contextWindow - used),
										estimated: true,
										configured_capacity: true,
									}),
								},
							],
						};
					}
				} else executed = await cancellable(execute(name, args as Item, call.id), signal);
				result = boundedResult(executed, outputBudget, name === 'image_gen.imagegen');
				checkAbort(signal);
				if (!result.isError && /(?:^|\.)tool_search$/.test(name) && result.discoveredTools)
					addTools(result.discoveredTools, true);
			} catch (error) {
				if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
					interruptCalls(round.calls.slice(callIndex));
					transcript.items.push(...chatImages);
					publish();
					throw abortError();
				}
				result = {
					isError: true,
					content: [
						{ type: 'text', text: error instanceof Error ? error.message : 'The tool failed.' },
					],
				};
			}
			toolCalls = toolCalls.map((item) =>
				item.id === call.id
					? {
							...item,
							status: result.isError ? (result.approvalDenied ? 'denied' : 'failed') : 'completed',
							result,
							completedAt: Date.now(),
						}
					: item,
			);
			const outputText = result.content
				.filter((part) => part.type === 'text')
				.map((part) => part.text)
				.join('\n');
			const originalImages = result.content.filter((part) => part.type === 'image');
			const images = [] as typeof originalImages;
			const notes = new Set<string>();
			if (name === 'image_gen.imagegen' && originalImages.length) publish();
			try {
				for (const image of originalImages) {
					if (name !== 'image_gen.imagegen' || !acceptsImages) {
						images.push(image);
						continue;
					}
					const preview = await generatedImageContext(image.dataUrl, signal);
					checkAbort(signal);
					if (preview) {
						images.push({ ...image, dataUrl: preview });
						if (preview !== image.dataUrl) notes.add(PREVIEW_NOTE);
					} else notes.add(PREVIEW_UNAVAILABLE);
				}
			} catch (error) {
				if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
					const text =
						'Image generation completed. The original is available in FreeLM. Model continuation was cancelled.';
					transcript.items.push(
						responses
							? { type: 'function_call_output', call_id: call.id, output: text }
							: { role: 'tool', tool_call_id: call.id, content: text },
					);
					interruptCalls(round.calls.slice(callIndex + 1));
					transcript.items.push(...chatImages);
					publish();
					throw abortError();
				}
				throw error;
			}
			const resultText = `${result.isError ? 'Tool error: ' : ''}${outputText}${originalImages.length && !acceptsImages ? '\n[Image available in FreeLM; this model does not accept image inputs.]' : ''}${notes.size ? `\n${[...notes].join('\n')}` : ''}`;
			if (responses)
				transcript.items.push({
					type: 'function_call_output',
					call_id: call.id,
					output:
						images.length && acceptsImages
							? [
									{ type: 'input_text', text: resultText || 'Tool returned an image.' },
									...images.map((image) => ({
										type: 'input_image',
										image_url: image.dataUrl,
										detail: 'auto',
									})),
								]
							: resultText || '(Tool returned no text.)',
				});
			else {
				transcript.items.push({
					role: 'tool',
					tool_call_id: call.id,
					content:
						resultText ||
						(images.length
							? 'Tool returned an image, attached below.'
							: '(Tool returned no text.)'),
				});
				if (acceptsImages && images.length)
					chatImages.push({
						role: 'user',
						content: [
							{ type: 'text', text: `Images returned by tool call ${call.id} (${record.name}).` },
							...images.map((image) => ({ type: 'image_url', image_url: { url: image.dataUrl } })),
						],
					});
			}
			publish();
		}
		transcript.items.push(...chatImages);
		if (resetContextRequested) {
			const latestUser = history
				.slice()
				.reverse()
				.find((message) => message.role === 'user');
			contextItems = [
				...(latestUser ? [plainHistory(latestUser, responses)] : []),
				...transcript.items.slice(roundTranscriptStart),
			];
			contextOffset = transcript.items.length;
			tokenUsage.reset();
			delete transcript.usage;
			transcript.context = {
				version: 1,
				kind: 'reset',
				api,
				model,
				connectionId: connection.id,
				historyMessageIds: history.map((message) => message.id),
				transcriptItemCount: contextOffset,
				items: contextItems,
				createdAt: Date.now(),
				compactionCount: ++compactionCount,
				inputTokensBefore: estimatedInput,
				inputTokensAfter: estimateInput(contextItems, definitions),
			};
			transcript.contextWindows = [
				...(transcript.contextWindows ?? []),
				{
					id: crypto.randomUUID(),
					transcriptItemCount: contextOffset,
					historyMessageIds: history.map((message) => message.id),
					createdAt: Date.now(),
					kind: 'reset',
				},
			];
		}
		publish();
		// Never insert user input between a requested call and its matching output.
		const yielded = yieldForInput();
		if (yielded) return yielded;
	}
}
