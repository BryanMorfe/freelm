import { createSSEParser } from './sse';
export { createSSEParser } from './sse';
import { messageInputText } from './text-attachments';
import type {
	Attachment,
	Connection,
	MediaAsset,
	Message,
	WireFile,
	WireRequest,
	WireResponse,
} from '../types';
import { currentWorkspaceId } from './workspace';
import { assertModelSupports, thinkingParameters } from './catalog';
import { createUtf8Decoder, decodeUtf8 } from './stream-decoder';
import { moderatedBrowserRequest } from './browser-media-moderation';
import { validModerationWarnings } from './moderation-warnings';
export { setBrowserMediaModerationContext } from './browser-media-moderation';

type Json = Record<string, any>;
const abortError = () => new DOMException('Request cancelled.', 'AbortError');
const object = (value: unknown): Json =>
	value && typeof value === 'object' ? (value as Json) : {};

function endpointUrl(baseUrl: string, path: string): string {
	const url = new URL(baseUrl.trim());
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
		throw new Error('Use an HTTP or HTTPS API URL without embedded credentials.');
	}
	url.pathname = `${url.pathname.replace(/\/+$/, '') || '/v1'}${path}`;
	url.hash = '';
	return url.toString();
}

function base64(bytes: Uint8Array): string {
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += 32768) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
	}
	return btoa(binary);
}

async function browserRequest(
	request: WireRequest,
	onChunk: (text: string) => void,
	signal?: AbortSignal,
): Promise<WireResponse> {
	const headers: Record<string, string> = {};
	if (request.apiKey.trim()) headers.Authorization = `Bearer ${request.apiKey.trim()}`;
	let body: BodyInit | undefined;
	if (request.form) {
		const form = new FormData();
		for (const field of request.form) {
			if (field.file) {
				const bytes = Uint8Array.from(atob(field.file.base64), (char) => char.charCodeAt(0));
				form.append(field.name, new Blob([bytes], { type: field.file.type }), field.file.name);
			} else if (field.value !== undefined) form.append(field.name, field.value);
		}
		body = form;
	} else if (request.body) {
		body = JSON.stringify(request.body);
		headers['Content-Type'] = 'application/json';
	}
	let response: Response;
	try {
		response = await fetch(endpointUrl(request.baseUrl, request.path), {
			method: request.method,
			headers,
			body,
			signal,
			redirect: 'error',
		});
	} catch (error) {
		if (signal?.aborted) throw abortError();
		if (error instanceof TypeError)
			throw new Error(
				'Could not reach the API. Check the URL and connection. Browser preview also requires API CORS support; the desktop app does not.',
			);
		throw error;
	}
	const contentType = response.headers.get('content-type') || 'application/octet-stream';
	const streaming = response.ok && request.stream && /text\/event-stream/i.test(contentType);
	const chunks: Uint8Array[] = [];
	const decoder = createUtf8Decoder();
	const reader = response.body?.getReader();
	let total = 0;
	let characters = 0;
	const emit = (text: string) => {
		characters += text.length;
		onChunk(text);
	};
	const limit = (streaming ? 16 : 256) * 1024 * 1024;
	try {
		if (reader) {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				total += value.length;
				if (total > limit) throw new Error('The API response exceeds the prototype size limit.');
				if (streaming) emit(decoder.push(value));
				else chunks.push(value);
			}
			if (streaming) emit(decoder.finish());
		}
	} catch (error) {
		await reader?.cancel().catch(() => {});
		throw error;
	} finally {
		reader?.releaseLock();
	}
	if (streaming)
		return {
			status: response.status,
			contentType,
			body: '',
			encoding: 'text',
			stream: { bytes: total, characters },
		};
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	const text = /(?:json|text\/|xml|javascript)/i.test(contentType) || !response.ok;
	return {
		status: response.status,
		contentType,
		encoding: text ? 'text' : 'base64',
		body: text ? decodeUtf8(bytes) : base64(bytes),
	};
}

function errorMessage(value: unknown, fallback = 'The API request failed.'): string {
	if (typeof value === 'string') return value;
	const data = object(value);
	if (data.error) return errorMessage(data.error, fallback);
	return typeof data.message === 'string' ? data.message : fallback;
}

async function request(
	connection: Connection,
	input: Pick<WireRequest, 'path' | 'method' | 'body' | 'form' | 'stream'>,
	signal?: AbortSignal,
	onChunk: (text: string) => void = () => {},
): Promise<WireResponse> {
	if (signal?.aborted) throw abortError();
	const workspaceId = currentWorkspaceId();
	const wire: WireRequest = {
		...input,
		id: crypto.randomUUID(),
		workspaceId,
		connectionId: connection.id,
		baseUrl: workspaceId === 'local' ? connection.baseUrl : '',
		apiKey: workspaceId === 'local' ? connection.apiKey : '',
	};
	const desktop = typeof window === 'undefined' ? undefined : window.desktop;
	let response: WireResponse;
	if (desktop) {
		let deliveredCharacters = 0;
		const unsubscribe = desktop.onChunk((event) => {
			if (event.id === wire.id) {
				deliveredCharacters += event.text.length;
				onChunk(event.text);
			}
		});
		let rejectAbort: ((error: Error) => void) | undefined;
		const aborted = new Promise<never>((_, reject) => {
			rejectAbort = reject;
		});
		const cancel = () => {
			void desktop.cancel(wire.id).catch(() => {});
			rejectAbort?.(abortError());
		};
		signal?.addEventListener('abort', cancel, { once: true });
		try {
			if (signal?.aborted) throw abortError();
			response = await Promise.race([desktop.request(wire), aborted]);
			if (response.stream && response.stream.characters !== deliveredCharacters)
				throw new Error(
					`The desktop stream delivery was incomplete: the transport read ${response.stream.bytes} bytes / ${response.stream.characters} characters, but chat received ${deliveredCharacters} characters. Retry this message.`,
				);
		} finally {
			signal?.removeEventListener('abort', cancel);
			unsubscribe();
		}
	} else response = await moderatedBrowserRequest(wire, onChunk, signal, browserRequest);
	if (signal?.aborted) throw abortError();
	if (response.status < 200 || response.status >= 300) {
		let detail: unknown = response.body;
		try {
			detail = JSON.parse(response.body);
		} catch {
			/* A proxy may return plain text. */
		}
		throw new Error(
			`API ${response.status}: ${errorMessage(detail, 'Request failed.').slice(0, 1200)}`,
		);
	}
	return response;
}

// Agent turns use the same transport, cancellation, decoding, and desktop delivery checks.
export { request as apiRequest };

function parseJsonObject(response: WireResponse): Json {
	try {
		return object(JSON.parse(response.body));
	} catch (error) {
		if (error instanceof SyntaxError) throw new Error('The API returned an invalid JSON response.');
		throw error;
	}
}
function json(response: WireResponse): Json {
	const data = parseJsonObject(response);
	if (data.error) throw new Error(errorMessage(data));
	return data;
}

function contentText(value: unknown): string {
	if (typeof value === 'string') return value;
	if (!Array.isArray(value)) return '';
	return value
		.map((part) => {
			const data = object(part);
			return typeof data.text === 'string'
				? data.text
				: typeof data.refusal === 'string'
					? data.refusal
					: '';
		})
		.join('');
}

function responseText(data: Json): string {
	if (typeof data.output_text === 'string') return data.output_text;
	if (Array.isArray(data.output))
		return data.output.map((item) => contentText(object(item).content)).join('');
	const message = object(data.choices?.[0]?.message);
	return (
		contentText(message.content) ||
		contentText(message.refusal) ||
		contentText(data.message?.content) ||
		contentText(data.content)
	);
}

export async function streamChat(
	connection: Connection,
	model: string,
	messages: Message[],
	instructions: string,
	onDelta: (text: string) => void,
	signal?: AbortSignal,
	thinkingMode?: string,
	onPhase?: (phase: 'working' | 'responding') => void,
	onRequest?: (instructions: string) => void,
): Promise<void> {
	onPhase?.('working');
	if (!model.trim()) throw new Error('Choose a chat model first.');
	const history = messages.filter(
		(message) => messageInputText(message) || message.attachments?.length,
	);
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
	const parameters = thinkingParameters(connection, model, thinkingMode);
	const responses = connection.chatApi === 'responses';
	let body: Record<string, unknown>;
	if (responses) {
		body = {
			model,
			stream: true,
			store: false,
			input: history.map((message) => ({
				role: message.role,
				content:
					message.role === 'assistant'
						? messageInputText(message)
						: [
								...(messageInputText(message)
									? [{ type: 'input_text', text: messageInputText(message) }]
									: []),
								...(message.attachments || [])
									.filter((attachment) => attachment.type.startsWith('image/'))
									.map((attachment) => ({
										type: 'input_image',
										image_url: attachment.dataUrl,
										detail: 'auto',
									})),
							],
			})),
		};
		if (instructions.trim()) body.instructions = instructions.trim();
	} else {
		body = {
			model,
			stream: true,
			messages: [
				...(instructions.trim() ? [{ role: 'system', content: instructions.trim() }] : []),
				...history.map((message) => ({
					role: message.role,
					content: message.attachments?.some((attachment) => attachment.type.startsWith('image/'))
						? [
								{ type: 'text', text: messageInputText(message) },
								...message.attachments
									.filter((attachment) => attachment.type.startsWith('image/'))
									.map((attachment) => ({
										type: 'image_url',
										image_url: { url: attachment.dataUrl },
									})),
							]
						: messageInputText(message),
				})),
			],
		};
	}
	body = { ...body, ...parameters };
	let emitted = false;
	let terminal = false;
	let streamError: Error | undefined;
	let receivedCharacters = 0;
	let receivedBytes: number | undefined;
	let eventCount = 0;
	let lastEvent = 'none';
	const eventLabel = (value: unknown) =>
		typeof value === 'string' && /^[\w.-]{1,80}$/.test(value) ? value : 'unnamed';
	const diagnostics = () =>
		`Stream details: ${receivedBytes === undefined ? '' : `${receivedBytes} bytes, `}${receivedCharacters} characters, ${eventCount} events, last event: ${lastEvent}, completion: ${terminal ? 'received' : 'missing'}.`;
	const withDetails = (error: Error) =>
		new Error(`${error.message} ${diagnostics()}`, { cause: error });
	const emit = (text: string) => {
		if (text) {
			emitted = true;
			onPhase?.('responding');
			onDelta(text);
		}
	};
	const parser = createSSEParser((raw, event) => {
		eventCount += 1;
		lastEvent = eventLabel(event);
		if (streamError) return;
		if (raw.trim() === '[DONE]') {
			lastEvent = '[DONE]';
			terminal = true;
			return;
		}
		let data: Json;
		try {
			const parsed: unknown = JSON.parse(raw);
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
				throw new Error('Expected a JSON object.');
			data = parsed as Json;
		} catch {
			streamError = new Error(
				`The API sent malformed streaming data: event ${eventCount} (${lastEvent}, ${raw.length} characters) is not a valid JSON object.`,
			);
			return;
		}
		const type = data.type || event;
		if (typeof type === 'string' && type.startsWith('response.reasoning')) onPhase?.('working');
		lastEvent = eventLabel(type || (Array.isArray(data.choices) ? 'chat.completion.chunk' : ''));
		if (type === 'error' || type === 'response.failed' || data.error) {
			streamError = new Error(errorMessage(data.response || data));
			return;
		}
		if (type === 'response.incomplete') {
			streamError = new Error(
				`The response was incomplete: ${data.response?.incomplete_details?.reason || 'generation stopped early'}.`,
			);
			return;
		}
		if (type === 'response.output_text.delta' || type === 'response.refusal.delta')
			emit(data.delta || '');
		else if (type === 'response.completed') {
			terminal = true;
			if (!emitted) emit(responseText(object(data.response)));
		} else if (Array.isArray(data.choices)) {
			const choice = data.choices[0];
			if (!choice) return;
			if (
				choice.delta?.reasoning_content ||
				choice.delta?.reasoning ||
				choice.delta?.reasoning_details
			)
				onPhase?.('working');
			emit(contentText(choice.delta?.content) || contentText(choice.delta?.refusal));
			if (choice.finish_reason) {
				terminal = true;
				if (choice.finish_reason === 'length')
					streamError = new Error('The response reached the provider output limit.');
				else if (choice.finish_reason === 'content_filter')
					streamError = new Error('The provider stopped this response with a content filter.');
			}
		}
	});
	let result: WireResponse;
	try {
		if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
		onRequest?.(instructions.trim());
		result = await request(
			connection,
			{ method: 'POST', path: `/${connection.chatApi}`, body, stream: true },
			signal,
			(text) => {
				receivedCharacters += text.length;
				parser.push(text);
			},
		);
	} catch (error) {
		if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
		// A transport can fail after delivering a final line without its blank-line delimiter.
		// Drain it before reporting the failure, retaining both parser and transport evidence.
		parser.finish();
		if (receivedCharacters) {
			const transportError =
				error instanceof Error ? error : new Error('The API connection failed.');
			throw withDetails(
				streamError
					? new Error(`${streamError.message} Transport error: ${transportError.message}`)
					: transportError,
			);
		}
		throw error;
	}
	if (/text\/event-stream/i.test(result.contentType)) {
		receivedBytes = result.stream?.bytes;
		parser.finish();
		if (streamError) throw withDetails(streamError);
		if (!terminal)
			throw withDetails(
				new Error('The API stream ended before completion. You can retry this message.'),
			);
	} else {
		const data = json(result);
		if (data.status === 'failed' || data.status === 'incomplete')
			throw new Error(errorMessage(data, `The response was ${data.status}.`));
		emit(responseText(data));
	}
	if (!emitted)
		throw new Error('The API returned no text. This prototype does not execute tool calls yet.');
}

export async function listModels(connection: Connection, signal?: AbortSignal): Promise<string[]> {
	const data = json(await request(connection, { path: '/models', method: 'GET' }, signal));
	const models = Array.isArray(data.data)
		? data.data
		: Array.isArray(data.models)
			? data.models
			: [];
	return [
		...new Set<string>(
			models
				.map((item: unknown) => (typeof item === 'string' ? item : object(item).id))
				.filter((id: unknown): id is string => typeof id === 'string' && !!id),
		),
	].sort();
}

function file(attachment: Attachment): WireFile {
	const match = /^data:([^;,]*)(?:;[^,]*)?;base64,([\s\S]*)$/.exec(attachment.dataUrl);
	if (!match) throw new Error(`The attachment ${attachment.name} is not a valid embedded file.`);
	return {
		name: attachment.name,
		type: attachment.type || match[1] || 'application/octet-stream',
		base64: match[2],
	};
}

function fields(values: Record<string, unknown>): NonNullable<WireRequest['form']> {
	return Object.entries(values)
		.filter(([, value]) => value !== undefined && value !== '')
		.map(([name, value]) => ({ name, value: String(value) }));
}

function modelRequired(model: string) {
	if (!model.trim()) throw new Error('Choose a model first.');
}

export interface ImageOptions {
	model: string;
	prompt: string;
	size?: string;
	quality?: string;
	n?: number;
	images?: Attachment[];
	mask?: Attachment;
}
export async function generateImages(
	connection: Connection,
	options: ImageOptions,
	signal?: AbortSignal,
	onWarnings?: (warnings: string[]) => void,
): Promise<MediaAsset[]> {
	modelRequired(options.model);
	const { images, mask, ...body } = options;
	if (mask && !images?.length) throw new Error('Add an input image before adding a mask.');
	const editing = !!images?.length;
	assertModelSupports(connection, options.model, 'images', editing ? ['image'] : []);
	const form = editing ? fields(body) : undefined;
	if (form && images) {
		for (const attachment of images)
			form.push({ name: images.length === 1 ? 'image' : 'image[]', file: file(attachment) });
		if (mask) form.push({ name: 'mask', file: file(mask) });
	}
	const response = await request(
		connection,
		{
			method: 'POST',
			path: `/images/${editing ? 'edits' : 'generations'}`,
			...(editing ? { form } : { body }),
		},
		signal,
	);
	const data = json(response);
	if (validModerationWarnings(response.moderationWarnings) && response.moderationWarnings.length)
		onWarnings?.(response.moderationWarnings);
	if (!Array.isArray(data.data) || !data.data.length)
		throw new Error('The API returned no images.');
	return data.data.map((item: Json, index: number) => {
		const format = item.output_format || data.output_format || 'png';
		const mimeType = `image/${format === 'jpg' ? 'jpeg' : format}`;
		const url = item.b64_json ? `data:${mimeType};base64,${item.b64_json}` : item.url;
		if (typeof url !== 'string' || !/^(https?:\/\/|data:image\/)/i.test(url))
			throw new Error('The API returned an invalid image URL.');
		return { url, mimeType, name: `image-${Date.now()}-${index + 1}.${format}` };
	});
}

export interface VideoOptions {
	model: string;
	prompt: string;
	size?: string;
	seconds?: string | number;
	reference?: Attachment;
}
export interface VideoJob {
	id: string;
	status: string;
	progress?: number;
	error?: { message?: string } | string;
}
function videoJob(response: WireResponse): VideoJob {
	const data = parseJsonObject(response);
	const validId = typeof data.id === 'string' && !!data.id.trim();
	const terminalFailure =
		typeof data.status === 'string' &&
		['failed', 'error', 'cancelled', 'canceled'].includes(data.status.toLowerCase());
	// A failed job's error belongs to its terminal status. Other error envelopes
	// still represent request failures and must not become resumable job records.
	if (data.error && !(validId && terminalFailure)) throw new Error(errorMessage(data));
	if (!validId) throw new Error('The API returned a video job without an ID.');
	return {
		id: data.id,
		status: typeof data.status === 'string' ? data.status : 'queued',
		progress: typeof data.progress === 'number' ? data.progress : undefined,
		error: data.error,
	};
}
export async function createVideo(
	connection: Connection,
	options: VideoOptions,
	signal?: AbortSignal,
	onWarnings?: (warnings: string[]) => void,
): Promise<VideoJob> {
	modelRequired(options.model);
	const { reference, ...values } = options;
	assertModelSupports(connection, options.model, 'videos', reference ? ['image'] : []);
	const form = fields(values);
	if (reference) form.push({ name: 'input_reference', file: file(reference) });
	const response = await request(connection, { method: 'POST', path: '/videos', form }, signal);
	const job = videoJob(response);
	if (validModerationWarnings(response.moderationWarnings) && response.moderationWarnings.length)
		onWarnings?.(response.moderationWarnings);
	return job;
}
export async function getVideo(
	connection: Connection,
	id: string,
	signal?: AbortSignal,
): Promise<VideoJob> {
	return videoJob(
		await request(connection, { method: 'GET', path: `/videos/${encodeURIComponent(id)}` }, signal),
	);
}
function binaryAsset(response: WireResponse, fallbackType: string, name: string): MediaAsset {
	if (response.encoding !== 'base64')
		throw new Error('The API returned text instead of the requested media.');
	const suppliedType = response.contentType.split(';')[0];
	const mimeType = suppliedType === 'application/octet-stream' ? fallbackType : suppliedType;
	return { url: `data:${mimeType};base64,${response.body}`, mimeType, name };
}
export async function downloadVideo(
	connection: Connection,
	id: string,
	signal?: AbortSignal,
	onWarnings?: (warnings: string[]) => void,
): Promise<MediaAsset> {
	const response = await request(
		connection,
		{ method: 'GET', path: `/videos/${encodeURIComponent(id)}/content` },
		signal,
	);
	const asset = binaryAsset(response, 'video/mp4', `video-${id}.mp4`);
	if (validModerationWarnings(response.moderationWarnings) && response.moderationWarnings.length)
		onWarnings?.(response.moderationWarnings);
	return asset;
}

export interface SpeechOptions {
	model: string;
	input: string;
	voice: string;
	format?: string;
	instructions?: string;
	speed?: number;
}
export async function generateSpeech(
	connection: Connection,
	options: SpeechOptions,
	signal?: AbortSignal,
): Promise<MediaAsset> {
	modelRequired(options.model);
	assertModelSupports(connection, options.model, 'speech');
	const { format = 'mp3', ...values } = options;
	const types: Record<string, string> = {
		mp3: 'audio/mpeg',
		wav: 'audio/wav',
		opus: 'audio/ogg',
		aac: 'audio/aac',
		flac: 'audio/flac',
		pcm: 'audio/pcm',
	};
	return binaryAsset(
		await request(
			connection,
			{ method: 'POST', path: '/audio/speech', body: { ...values, response_format: format } },
			signal,
		),
		types[format] || 'audio/mpeg',
		`speech-${Date.now()}.${format}`,
	);
}

export interface TranscriptionOptions {
	model: string;
	audio: Attachment;
	language?: string;
	prompt?: string;
}
export async function transcribeAudio(
	connection: Connection,
	options: TranscriptionOptions,
	signal?: AbortSignal,
): Promise<string> {
	modelRequired(options.model);
	assertModelSupports(
		connection,
		options.model,
		'transcription',
		options.prompt?.trim() ? ['text'] : [],
	);
	const { audio, ...values } = options;
	const form = fields({ ...values, response_format: 'json' });
	form.push({ name: 'file', file: file(audio) });
	const result = await request(
		connection,
		{ method: 'POST', path: '/audio/transcriptions', form },
		signal,
	);
	if (/application\/json/i.test(result.contentType) || result.body.trim().startsWith('{')) {
		const data = json(result);
		if (typeof data.text !== 'string') throw new Error('The API returned no transcript text.');
		return data.text;
	}
	if (result.encoding !== 'text') throw new Error('The API returned an invalid transcript.');
	return result.body;
}
