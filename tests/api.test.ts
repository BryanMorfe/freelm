import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	createSSEParser,
	createVideo,
	downloadVideo,
	generateImages,
	generateSpeech,
	getVideo,
	listModels,
	streamChat,
	transcribeAudio,
} from '../src/lib/api';
import type {
	Connection,
	DesktopBridge,
	Message,
	ModelDefinition,
	WireRequest,
	WireResponse,
} from '../src/types';

const connection: Connection = {
	id: 'local',
	name: 'Test API',
	baseUrl: 'http://localhost:9999/v1',
	apiKey: 'test-only',
	chatApi: 'responses',
	models: {
		chat: 'custom-chat',
		images: 'custom-image',
		videos: 'custom-video',
		speech: 'custom-speech',
		transcription: 'custom-transcribe',
	},
	discoveredModels: [],
	catalog: ['custom-chat', 'model', 'arbitrary-model'].map((id) => ({
		id,
		name: id,
		enabled: true,
		tasks: ['chat'],
		inputModalities: ['text', 'image'],
		outputModalities: ['text'],
		thinkingModes: [
			{
				id: 'low',
				name: 'Low',
				parameters: {
					responses: { reasoning: { effort: 'low' } },
					chat: { reasoning_effort: 'low' },
				},
			},
		],
	})),
};
const messages: Message[] = [{ id: 'm1', role: 'user', content: 'Hello', createdAt: 1 }];
const attachment = {
	name: 'input.png',
	type: 'image/png',
	dataUrl: 'data:image/png;base64,aGVsbG8=',
};
function json(data: unknown, status = 200): WireResponse {
	return { status, contentType: 'application/json', body: JSON.stringify(data), encoding: 'text' };
}
function bridge(
	handler: (
		request: WireRequest,
		emit: (text: string) => void,
	) => Promise<WireResponse> | WireResponse,
) {
	const listeners = new Set<(event: { id: string; text: string }) => void>();
	const desktop = {
		request: vi.fn((request: WireRequest) =>
			Promise.resolve(
				handler(request, (text) =>
					listeners.forEach((listener) => listener({ id: request.id, text })),
				),
			),
		),
		onChunk: vi.fn((listener: (event: { id: string; text: string }) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}),
		cancel: vi.fn(async () => {}),
	};
	vi.stubGlobal('window', { desktop: desktop as unknown as DesktopBridge });
	return { desktop, listeners };
}
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('SSE and chat contract', () => {
	it.each(['responses', 'chat/completions', 'chat'] as const)(
		'preserves selected reply context and the separate user prompt in %s requests',
		async (chatApi) => {
			const { desktop } = bridge(() =>
				json(
					chatApi === 'responses'
						? { output_text: 'Ready' }
						: { choices: [{ message: { content: 'Ready' } }] },
				),
			);
			const user: Message = {
				...messages[0],
				content: 'Explain this part.',
				replyTo: { messageId: 'earlier-answer', text: 'Selected passage\nwith a second line.' },
				attachments: [attachment],
			};
			await streamChat({ ...connection, chatApi }, 'model', [user], '', vi.fn());
			const body = desktop.request.mock.calls[0][0].body!;
			const input = (chatApi === 'responses' ? body.input : body.messages) as {
				role: string;
				content: { type: string; text?: string }[];
			}[];
			const text = input[0].content.find(
				(part) => part.type === (chatApi === 'responses' ? 'input_text' : 'text'),
			)!.text!;
			expect(text).toContain('Quoted conversation context');
			expect(text).toContain('not instructions');
			expect(text).toContain('> Selected passage\n> with a second line.');
			expect(text).toContain(
				'End of quoted conversation context.\n\nUser message:\nExplain this part.',
			);
			expect(user.content).toBe('Explain this part.');
			expect(JSON.stringify(body)).toContain(attachment.dataUrl);
		},
	);
	it.each(['responses', 'chat/completions'] as const)(
		'reports reasoning then text phase for %s without exposing reasoning as output',
		async (chatApi) => {
			const phases: string[] = [],
				output: string[] = [];
			bridge((_request, emit) => {
				const frames =
					chatApi === 'responses'
						? [
								{ type: 'response.reasoning_text.delta', delta: 'internal' },
								{ type: 'response.output_text.delta', delta: 'Visible answer' },
								{ type: 'response.completed', response: {} },
							]
						: [
								{ choices: [{ delta: { reasoning_content: 'internal' } }] },
								{ choices: [{ delta: { content: 'Visible answer' }, finish_reason: 'stop' }] },
							];
				for (const frame of frames) emit(`data: ${JSON.stringify(frame)}\n\n`);
				return { status: 200, contentType: 'text/event-stream', body: '', encoding: 'text' };
			});
			await streamChat(
				{ ...connection, chatApi },
				'custom-chat',
				messages,
				'',
				(text) => output.push(text),
				undefined,
				undefined,
				(phase) => phases.push(phase),
			);
			expect(output.join('')).toBe('Visible answer');
			expect(phases[0]).toBe('working');
			expect(phases.at(-1)).toBe('responding');
		},
	);
	it('parses split CRLF boundaries, comments, multiple data lines and final unterminated frames', () => {
		const events: [string, string][] = [];
		const parser = createSSEParser((data, event) => events.push([data, event]));
		for (const chunk of [
			': ping\r',
			'\nevent: notice\r\ndata: first\r',
			'\ndata: second\r\n\r',
			'\ndata: last',
		])
			parser.push(chunk);
		parser.finish();
		expect(events).toEqual([
			['first\nsecond', 'notice'],
			['last', ''],
		]);
	});

	it('streams Responses text/refusal, sends image attachments and project instructions', async () => {
		const { desktop, listeners } = bridge((_request, emit) => {
			const frames = [
				'data: {"type":"response.output_text.delta","delta":"Hello "}\r\n\r\n',
				'data: {"type":"response.refusal.delta","delta":"world"}\n\n',
				'data: {"type":"response.completed","response":{"output_text":"Hello world"}}\n\n',
			].join('');
			for (let i = 0; i < frames.length; i += 7) emit(frames.slice(i, i + 7));
			return {
				status: 200,
				contentType: 'text/event-stream; charset=utf-8',
				body: '',
				encoding: 'text',
			};
		});
		const deltas: string[] = [];
		await streamChat(
			connection,
			'arbitrary-model',
			[{ ...messages[0], attachments: [attachment] }],
			'Be concise',
			(text) => deltas.push(text),
		);
		expect(deltas.join('')).toBe('Hello world');
		const wire = desktop.request.mock.calls[0][0];
		expect(wire.path).toBe('/responses');
		expect(wire.body).toMatchObject({
			instructions: 'Be concise',
			store: false,
			model: 'arbitrary-model',
			input: [
				{
					content: [
						{ type: 'input_text', text: 'Hello' },
						{ type: 'input_image', image_url: attachment.dataUrl },
					],
				},
			],
		});
		expect(listeners.size).toBe(0);
	});

	it.each(['', '\n', '\r', '\r\n', '\n\n'])(
		'accepts response.completed from the SSE event name at EOF with delimiter %j',
		async (ending) => {
			bridge((_request, emit) => {
				const frame = `event: response.completed\r\ndata: {"response":{"output_text":"Final café 👋"}}${ending}`;
				for (const character of frame) emit(character);
				return { status: 200, contentType: 'text/event-stream', body: '', encoding: 'text' };
			});
			const onDelta = vi.fn();
			await streamChat(connection, 'model', messages, '', onDelta);
			expect(onDelta).toHaveBeenCalledExactlyOnceWith('Final café 👋');
		},
	);

	it('drains every split position of a final completion event without a newline', async () => {
		const frame = 'data: {"type":"response.completed","response":{"output_text":"Done"}}';
		for (let split = 0; split <= frame.length; split += 1) {
			bridge((_request, emit) => {
				emit(frame.slice(0, split));
				emit(frame.slice(split));
				return { status: 200, contentType: 'text/event-stream', body: '', encoding: 'text' };
			});
			const onDelta = vi.fn();
			await streamChat(connection, 'model', messages, '', onDelta);
			expect(onDelta).toHaveBeenCalledExactlyOnceWith('Done');
		}
	});

	it.each(['chat/completions', 'chat'] as const)(
		'uses the selected %s route and chat content schema',
		async (chatApi) => {
			const { desktop } = bridge((_request, emit) => {
				emit(
					'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
				);
				return { status: 200, contentType: 'text/event-stream', body: '', encoding: 'text' };
			});
			const onDelta = vi.fn();
			await streamChat(
				{ ...connection, chatApi },
				'model',
				[{ ...messages[0], attachments: [attachment] }],
				'Project',
				onDelta,
			);
			expect(onDelta).toHaveBeenCalledWith('Hi');
			const wire = desktop.request.mock.calls[0][0];
			expect(wire.path).toBe(`/${chatApi}`);
			expect(wire.body?.messages).toMatchObject([
				{ role: 'system', content: 'Project' },
				{
					role: 'user',
					content: [
						{ type: 'text' },
						{ type: 'image_url', image_url: { url: attachment.dataUrl } },
					],
				},
			]);
		},
	);

	it('accepts providers that return JSON even when streaming was requested', async () => {
		bridge(() =>
			json({
				output: [
					{ type: 'message', content: [{ type: 'output_text', text: 'Nonstream response' }] },
				],
			}),
		);
		const onDelta = vi.fn();
		await streamChat(connection, 'model', messages, '', onDelta);
		expect(onDelta).toHaveBeenCalledWith('Nonstream response');
	});

	it('surfaces error events and preserves already emitted partial text', async () => {
		bridge((_request, emit) => {
			emit(
				'data: {"type":"response.output_text.delta","delta":"Partial"}\n\ndata: {"type":"response.failed","response":{"error":{"message":"GPU unavailable"}}}\n\n',
			);
			return { status: 200, contentType: 'text/event-stream', encoding: 'text', body: '' };
		});
		const onDelta = vi.fn();
		await expect(streamChat(connection, 'model', messages, '', onDelta)).rejects.toThrow(
			'GPU unavailable',
		);
		expect(onDelta).toHaveBeenCalledWith('Partial');
	});

	it('does not silently accept truncated streams', async () => {
		bridge((_request, emit) => {
			emit('data: {"type":"response.output_text.delta","delta":"Partial"}\n\n');
			return { status: 200, contentType: 'text/event-stream', encoding: 'text', body: '' };
		});
		await expect(streamChat(connection, 'model', messages, '', () => {})).rejects.toThrow(
			/ended before completion.*1 events, last event: response.output_text.delta, completion: missing/,
		);
	});

	it('exposes a malformed final frame without including response contents', async () => {
		bridge((_request, emit) => {
			emit('event: response.completed\ndata: {"private":"secret-output"');
			return { status: 200, contentType: 'text/event-stream', body: '', encoding: 'text' };
		});
		const error = await streamChat(connection, 'model', messages, '', () => {}).catch(
			(error) => error,
		);
		expect(error.message).toMatch(/malformed streaming data: event 1 \(response.completed/);
		expect(error.message).not.toContain('secret-output');
	});

	it('distinguishes desktop delivery loss from a provider stream without completion', async () => {
		bridge((_request, emit) => {
			const frame = 'data: {"type":"response.output_text.delta","delta":"Partial"}\n\n';
			emit(frame);
			return {
				status: 200,
				contentType: 'text/event-stream',
				body: '',
				encoding: 'text',
				stream: { bytes: frame.length + 100, characters: frame.length + 100 },
			};
		});
		await expect(streamChat(connection, 'model', messages, '', () => {})).rejects.toThrow(
			/The desktop stream delivery was incomplete:.*but chat received/,
		);
	});

	it('drains buffered text before a transport failure without marking it successful', async () => {
		bridge((_request, emit) => {
			emit('data: {"type":"response.output_text.delta","delta":"Buffered"}');
			throw new Error('Connection terminated.');
		});
		const onDelta = vi.fn();
		await expect(streamChat(connection, 'model', messages, '', onDelta)).rejects.toThrow(
			/Connection terminated.*1 events, last event: response.output_text.delta/,
		);
		expect(onDelta).toHaveBeenCalledExactlyOnceWith('Buffered');
	});

	it('retains decoding evidence when the transport also fails', async () => {
		bridge((_request, emit) => {
			emit('event: response.completed\ndata: {"response":');
			throw new Error('Connection terminated.');
		});
		await expect(streamChat(connection, 'model', messages, '', () => {})).rejects.toThrow(
			/malformed streaming data.*Transport error: Connection terminated/,
		);
	});

	it('cancels an in-flight desktop request and removes event listeners', async () => {
		const { desktop, listeners } = bridge(() => new Promise(() => {}));
		const controller = new AbortController();
		const promise = streamChat(connection, 'model', messages, '', () => {}, controller.signal);
		controller.abort();
		await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
		expect(desktop.cancel).toHaveBeenCalledWith(desktop.request.mock.calls[0][0].id);
		expect(listeners.size).toBe(0);
	});
});

describe('media contracts', () => {
	const mediaOperations = [
		[
			'image generation',
			'/images/generations',
			(onWarnings: (warnings: string[]) => void) =>
				generateImages(connection, { model: 'custom', prompt: 'forest' }, undefined, onWarnings),
		],
		[
			'image editing',
			'/images/edits',
			(onWarnings: (warnings: string[]) => void) =>
				generateImages(
					connection,
					{ model: 'custom', prompt: 'forest', images: [attachment] },
					undefined,
					onWarnings,
				),
		],
		[
			'video creation',
			'/videos',
			(onWarnings: (warnings: string[]) => void) =>
				createVideo(connection, { model: 'custom-video', prompt: 'waves' }, undefined, onWarnings),
		],
		[
			'video download',
			'/videos/video_123/content',
			(onWarnings: (warnings: string[]) => void) =>
				downloadVideo(connection, 'video_123', undefined, onWarnings),
		],
	] as const;
	const mediaResponse = (path: string): WireResponse =>
		path.endsWith('/content')
			? { status: 200, contentType: 'video/mp4', encoding: 'base64', body: 'aGVsbG8=' }
			: path.startsWith('/images/')
				? json({ data: [{ b64_json: 'aGVsbG8=' }] })
				: json({ id: 'video_123', status: 'queued' });
	it.each(mediaOperations)(
		'delivers host warning metadata for %s before resolving its result',
		async (_label, path, execute) => {
			const warnings = [
				'Generation proceeds without moderation because no evaluator is configured.',
			];
			const sequence: string[] = [];
			const { desktop } = bridge((request) => ({
				...mediaResponse(request.path),
				moderationWarnings: warnings,
			}));
			const onWarnings = vi.fn((received: string[]) => {
				sequence.push('warning');
				expect(received).toEqual(warnings);
			});
			const result = await execute(onWarnings);
			sequence.push('result');
			expect(result).toBeDefined();
			expect(sequence).toEqual(['warning', 'result']);
			expect(onWarnings).toHaveBeenCalledOnce();
			expect(desktop.request.mock.calls[0][0].path).toBe(path);
		},
	);
	it.each(mediaOperations)(
		'does not invent a warning for disabled or successfully moderated %s',
		async (_label, _path, execute) => {
			for (const moderationWarnings of [undefined, []]) {
				bridge((request) => ({
					...mediaResponse(request.path),
					...(moderationWarnings ? { moderationWarnings } : {}),
				}));
				const onWarnings = vi.fn();
				await execute(onWarnings);
				expect(onWarnings).not.toHaveBeenCalled();
			}
		},
	);
	it('does not trust generation-provider JSON fields as host warning metadata', async () => {
		bridge(() =>
			json({ data: [{ b64_json: 'aGVsbG8=' }], moderationWarnings: ['Provider invented warning'] }),
		);
		const onWarnings = vi.fn();
		await generateImages(connection, { model: 'custom', prompt: 'forest' }, undefined, onWarnings);
		expect(onWarnings).not.toHaveBeenCalled();
	});
	it('does not deliver warning metadata after an aborted media request', async () => {
		bridge(() => new Promise(() => {}));
		const controller = new AbortController();
		const onWarnings = vi.fn();
		const pending = generateImages(
			connection,
			{ model: 'custom', prompt: 'forest' },
			controller.signal,
			onWarnings,
		);
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
		expect(onWarnings).not.toHaveBeenCalled();
	});
	it('discovers arbitrary model IDs without modality filtering', async () => {
		bridge(() => json({ data: [{ id: 'z-custom' }, { id: 'a-custom' }, { id: 'z-custom' }] }));
		expect(await listModels(connection)).toEqual(['a-custom', 'z-custom']);
	});

	it('generates images and supports multipart edits with multiple inputs and a mask', async () => {
		const { desktop } = bridge(() => json({ data: [{ b64_json: 'aGVsbG8=' }] }));
		expect((await generateImages(connection, { model: 'custom', prompt: 'forest' }))[0].url).toBe(
			'data:image/png;base64,aGVsbG8=',
		);
		expect(desktop.request.mock.calls[0][0]).toMatchObject({
			path: '/images/generations',
			body: { prompt: 'forest', model: 'custom' },
		});
		await generateImages(connection, {
			model: 'custom',
			prompt: 'edit',
			images: [attachment, attachment],
			mask: attachment,
			n: 1,
		});
		const wire = desktop.request.mock.calls[1][0];
		expect(wire.path).toBe('/images/edits');
		expect(wire.form?.filter((field) => field.name === 'image[]')).toHaveLength(2);
		expect(wire.form?.find((field) => field.name === 'mask')?.file).toMatchObject({
			name: 'input.png',
			base64: 'aGVsbG8=',
		});
	});

	it('creates video jobs, retrieves status, and downloads authenticated content', async () => {
		const { desktop } = bridge((wire) =>
			wire.path.endsWith('/content')
				? { status: 200, contentType: 'video/mp4', encoding: 'base64', body: 'aGVsbG8=' }
				: json({ id: 'video_123', status: 'in_progress', progress: 40 }),
		);
		expect(
			await createVideo(connection, {
				model: 'custom-video',
				prompt: 'waves',
				seconds: 8,
				reference: attachment,
			}),
		).toMatchObject({ id: 'video_123', progress: 40 });
		expect(desktop.request.mock.calls[0][0].form).toContainEqual({ name: 'seconds', value: '8' });
		expect(
			desktop.request.mock.calls[0][0].form?.find((field) => field.name === 'input_reference')?.file
				?.name,
		).toBe('input.png');
		await getVideo(connection, 'video_123');
		expect(desktop.request.mock.calls[1][0].path).toBe('/videos/video_123');
		expect((await downloadVideo(connection, 'video_123')).url).toBe(
			'data:video/mp4;base64,aGVsbG8=',
		);
		expect(desktop.request.mock.calls[2][0]).toMatchObject({
			path: '/videos/video_123/content',
			apiKey: 'test-only',
		});
	});

	it.each(['failed', 'error', 'cancelled', 'canceled', 'FAILED'])(
		'preserves terminal video status %s and provider error details',
		async (status) => {
			const job = {
				id: 'video_123',
				status,
				error: { message: 'Backend generation limit reached.' },
			};
			bridge(() => json(job));
			await expect(getVideo(connection, 'video_123')).resolves.toMatchObject(job);
		},
	);

	it('preserves an immediately failed video creation as a terminal job', async () => {
		const job = { id: 'video_123', status: 'failed', error: 'Generation failed.' };
		bridge(() => json(job));
		await expect(
			createVideo(connection, { model: 'custom-video', prompt: 'waves' }),
		).resolves.toMatchObject(job);
	});

	it.each([
		{},
		{ status: 'failed' },
		{ id: '', status: 'failed' },
		{ id: ' ', status: 'failed' },
		{ id: 42, status: 'failed' },
		{ id: 'video_123' },
		{ id: 'video_123', status: 'in_progress' },
		{ id: 'video_123', status: 'completed' },
		{ id: 'video_123', status: 'unknown' },
	])('rejects video error envelopes without a valid terminal job: %j', async (fields) => {
		bridge(() => json({ ...fields, error: { message: 'Provider request failed.' } }));
		await expect(getVideo(connection, 'video_123')).rejects.toThrow('Provider request failed.');
	});

	it('keeps HTTP failures and malformed JSON distinct from terminal video jobs', async () => {
		bridge(() =>
			json({ id: 'video_123', status: 'failed', error: { message: 'Unavailable.' } }, 503),
		);
		await expect(getVideo(connection, 'video_123')).rejects.toThrow('API 503: Unavailable.');
		bridge(() => ({ ...json({}), body: '{invalid json' }));
		await expect(getVideo(connection, 'video_123')).rejects.toThrow(
			'The API returned an invalid JSON response.',
		);
	});

	it('sends speech format, custom voice, and instructions while preserving binary output', async () => {
		const { desktop } = bridge(() => ({
			status: 200,
			contentType: 'application/octet-stream',
			body: 'aGVsbG8=',
			encoding: 'base64',
		}));
		const result = await generateSpeech(connection, {
			model: 'custom',
			input: 'hello',
			voice: 'local-speaker',
			format: 'wav',
			instructions: 'Softly',
			speed: 0.8,
		});
		expect(result.mimeType).toBe('audio/wav');
		expect(desktop.request.mock.calls[0][0].body).toEqual({
			model: 'custom',
			input: 'hello',
			voice: 'local-speaker',
			response_format: 'wav',
			instructions: 'Softly',
			speed: 0.8,
		});
	});

	it('uploads transcription audio as multipart and accepts a JSON transcript', async () => {
		const { desktop } = bridge(() => json({ text: 'The transcript.' }));
		const audio = {
			name: 'voice.wav',
			type: 'audio/wav',
			dataUrl: 'data:audio/wav;base64,aGVsbG8=',
		};
		expect(await transcribeAudio(connection, { model: 'custom', audio, language: 'en' })).toBe(
			'The transcript.',
		);
		const wire = desktop.request.mock.calls[0][0];
		expect(wire.path).toBe('/audio/transcriptions');
		expect(wire.form).toContainEqual({
			name: 'file',
			file: { name: 'voice.wav', type: 'audio/wav', base64: 'aGVsbG8=' },
		});
		expect(wire.form).toContainEqual({ name: 'response_format', value: 'json' });
	});

	it('surfaces HTTP errors without treating them as media', async () => {
		bridge(() => json({ error: { message: 'Unknown model' } }, 400));
		await expect(
			generateSpeech(connection, { model: 'custom', input: 'hello', voice: 'voice' }),
		).rejects.toThrow('API 400: Unknown model');
	});
});

describe('browser preview transport', () => {
	it.each([
		[new Uint8Array([0xff]), 'invalid UTF-8'],
		[new Uint8Array([0xf0, 0x9f]), 'incomplete UTF-8'],
	])(
		'exposes byte decoding errors rather than replacing invalid text (%s)',
		async (tail, expected) => {
			vi.stubGlobal('window', {});
			const start = new TextEncoder().encode(
				'data: {"type":"response.output_text.delta","delta":"',
			);
			const bytes = new Uint8Array(start.length + tail.length);
			bytes.set(start);
			bytes.set(tail, start.length);
			vi.stubGlobal(
				'fetch',
				vi.fn(
					async () => new Response(bytes, { headers: { 'content-type': 'text/event-stream' } }),
				),
			);
			await expect(streamChat(connection, 'model', messages, '', () => {})).rejects.toThrow(
				expected,
			);
		},
	);

	it('joins proxy prefixes, streams text split across UTF-8 byte boundaries, and authenticates', async () => {
		vi.stubGlobal('window', {});
		const bytes = new TextEncoder().encode(
			'data: {"type":"response.output_text.delta","delta":"Café"}\n\ndata: {"type":"response.completed"}\n\n',
		);
		const mockFetch = vi.fn(
			async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
							controller.close();
						},
					}),
					{ headers: { 'content-type': 'text/event-stream' } },
				),
		);
		vi.stubGlobal('fetch', mockFetch);
		const onDelta = vi.fn();
		await streamChat(
			{ ...connection, baseUrl: 'http://localhost:9999/proxy/v1/?tenant=test' },
			'model',
			messages,
			'',
			onDelta,
		);
		expect(onDelta).toHaveBeenCalledWith('Café');
		expect(mockFetch.mock.calls[0]).toMatchObject([
			'http://localhost:9999/proxy/v1/responses?tenant=test',
			{ headers: { Authorization: 'Bearer test-only' }, redirect: 'error' },
		]);
	});
});

describe('catalog request enforcement', () => {
	const definition: ModelDefinition = {
		id: 'catalog-model',
		name: 'Configured model',
		enabled: true,
		tasks: ['chat'],
		inputModalities: ['text'],
		outputModalities: ['text'],
		thinkingModes: [
			{
				id: 'deep',
				name: 'Deep',
				parameters: {
					responses: { reasoning: { effort: 'high' } },
					chat: { reasoning_effort: 'high' },
				},
			},
		],
		defaultThinkingMode: 'deep',
	};
	const catalogConnection = (overrides: Partial<ModelDefinition> = {}): Connection => ({
		...connection,
		catalog: [{ ...definition, ...overrides }],
	});

	it.each(['responses', 'chat/completions', 'chat'] as const)(
		'sends selected thinking parameters on %s without replacing chat content',
		async (chatApi) => {
			const { desktop } = bridge(() => json({ output_text: 'Hello' }));
			await streamChat(
				{ ...catalogConnection(), chatApi },
				definition.id,
				messages,
				'Stay concise',
				() => {},
				undefined,
				'deep',
			);
			const body = desktop.request.mock.calls[0][0].body;
			expect(body).toMatchObject({ model: definition.id, stream: true });
			if (chatApi === 'responses') {
				expect(body).toMatchObject({
					reasoning: { effort: 'high' },
					instructions: 'Stay concise',
					input: [{ role: 'user' }],
				});
				expect(body).not.toHaveProperty('reasoning_effort');
			} else {
				expect(body).toMatchObject({
					reasoning_effort: 'high',
					messages: [{ role: 'system' }, { role: 'user' }],
				});
				expect(body).not.toHaveProperty('reasoning');
			}
			await streamChat({ ...catalogConnection(), chatApi }, definition.id, messages, '', () => {});
			expect(desktop.request.mock.calls[1][0].body).toMatchObject(
				chatApi === 'responses' ? { reasoning: { effort: 'high' } } : { reasoning_effort: 'high' },
			);
		},
	);

	it('declines chat before transport when no thinking value is configured', async () => {
		const { desktop } = bridge(() => json({ output_text: 'Should not run' }));
		await expect(
			streamChat({ ...connection, catalog: [] }, 'model', messages, '', () => {}),
		).rejects.toThrow('Configure a thinking value');
		expect(desktop.request).not.toHaveBeenCalled();
	});

	it('blocks disabled models, missing image capability and unavailable thinking modes before requesting', async () => {
		const { desktop } = bridge(() => json({ output_text: 'Should not run' }));
		await expect(
			streamChat(catalogConnection({ enabled: false }), definition.id, messages, '', () => {}),
		).rejects.toThrow('disabled');
		await expect(
			streamChat(
				catalogConnection(),
				definition.id,
				[{ ...messages[0], attachments: [attachment] }],
				'',
				() => {},
			),
		).rejects.toThrow('image input');
		await expect(
			streamChat(catalogConnection(), definition.id, messages, '', () => {}, undefined, 'missing'),
		).rejects.toThrow('Choose a mode again');
		const unsafe = catalogConnection({
			thinkingModes: [
				{ id: 'override', name: 'Override', parameters: { responses: { stream: false } } },
			],
		});
		await expect(
			streamChat(unsafe, definition.id, messages, '', () => {}, undefined, 'override'),
		).rejects.toThrow('cannot override');
		expect(desktop.request).not.toHaveBeenCalled();
	});

	it('supports catalogued image-capable chat and declines audio/video chat payloads until an adapter exists', async () => {
		const { desktop } = bridge(() => json({ output_text: 'A picture' }));
		const configured = catalogConnection({ inputModalities: ['text', 'image', 'audio', 'video'] });
		await streamChat(
			configured,
			definition.id,
			[{ ...messages[0], attachments: [attachment] }],
			'',
			() => {},
		);
		expect(desktop.request).toHaveBeenCalledTimes(1);
		for (const type of ['audio/wav', 'video/mp4'])
			await expect(
				streamChat(
					configured,
					definition.id,
					[{ ...messages[0], attachments: [{ ...attachment, type }] }],
					'',
					() => {},
				),
			).rejects.toThrow('not supported yet');
		expect(desktop.request).toHaveBeenCalledTimes(1);
	});

	it('enforces optional image edits and video references separately from generation capability', async () => {
		const { desktop } = bridge((wire) =>
			wire.path === '/videos'
				? json({ id: 'video', status: 'queued' })
				: json({ data: [{ b64_json: 'YWJj' }] }),
		);
		const painter = catalogConnection({
			tasks: ['images'],
			outputModalities: ['image'],
			thinkingModes: [],
			defaultThinkingMode: undefined,
		});
		const video = catalogConnection({
			tasks: ['videos'],
			outputModalities: ['video'],
			thinkingModes: [],
			defaultThinkingMode: undefined,
		});
		await generateImages(painter, { model: definition.id, prompt: 'Sky' });
		await createVideo(video, { model: definition.id, prompt: 'Sky' });
		await expect(
			generateImages(painter, { model: definition.id, prompt: 'Sky', images: [attachment] }),
		).rejects.toThrow('image input');
		await expect(
			createVideo(video, { model: definition.id, prompt: 'Sky', reference: attachment }),
		).rejects.toThrow('image input');
		await expect(
			generateSpeech(painter, { model: definition.id, input: 'Sky', voice: 'speaker' }),
		).rejects.toThrow('not configured for speech generation');
		expect(desktop.request).toHaveBeenCalledTimes(2);
	});

	it('requires audio output for speech and audio input for transcription, with text input for optional prompts', async () => {
		const { desktop } = bridge(() => json({ text: 'Words' }));
		const invalidSpeech = catalogConnection({
			tasks: ['speech'],
			outputModalities: ['text'],
			thinkingModes: [],
			defaultThinkingMode: undefined,
		});
		await expect(
			generateSpeech(invalidSpeech, { model: definition.id, input: 'Words', voice: 'speaker' }),
		).rejects.toThrow('audio output');
		const transcription = catalogConnection({
			tasks: ['transcription'],
			inputModalities: ['audio'],
			outputModalities: ['text'],
			thinkingModes: [],
			defaultThinkingMode: undefined,
		});
		const audio = { name: 'voice.wav', type: 'audio/wav', dataUrl: 'data:audio/wav;base64,YWJj' };
		await transcribeAudio(transcription, { model: definition.id, audio });
		await expect(
			transcribeAudio(transcription, { model: definition.id, audio, prompt: 'Names mentioned' }),
		).rejects.toThrow('text input');
		await expect(
			transcribeAudio(catalogConnection(), { model: definition.id, audio }),
		).rejects.toThrow('not configured for transcription');
		expect(desktop.request).toHaveBeenCalledTimes(1);
	});
});
