import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';
import type { ModerationVideoFrameExtractor } from '../src/lib/moderation-video-frames';
import * as imagePayload from '../src/lib/moderation-image-payload';
import { MediaModerationGuard } from '../electron/media-moderation';
import { MediaModerationError, type ModerationState } from '../src/lib/media-moderation-guard';
import {
	defaultModerationSettings,
	IMAGE_EDIT_MODERATION_RUBRIC,
	VIDEO_REFERENCE_MODERATION_RUBRIC,
	MODERATION_RUBRIC,
} from '../src/lib/moderation';
import type {
	ModerationLabels,
	ModerationLevel,
	ModerationSettings,
} from '../src/moderation-types';
import type { Connection, WireRequest, WireResponse } from '../src/types';

const PNG =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const AVIF = readFileSync(new URL('./fixtures/reference.avif', import.meta.url)).toString('base64');
const MP4 = btoa('\x00\x00\x00\x18ftypisomCOMPLETE-VIDEO-INCLUDING-END');
const CLEAN: ModerationLabels = {
	ncii: false,
	sexual_minors: false,
	violent_minors: false,
	sexual_content: false,
	artistic_nudity: false,
	nudity: false,
	gore: false,
};
const CLEAN_EDIT = {
	...CLEAN,
	input_contains_person: false,
	edit_sexual_content: false,
	edit_nudity: false,
};
const OUTPUT_SCHEMA = {
	type: 'object',
	properties: Object.fromEntries(Object.keys(CLEAN).map((key) => [key, { type: 'boolean' }])),
	required: Object.keys(CLEAN),
	additionalProperties: false,
};
function pngChunk(type: string, data: Buffer): Buffer {
	const result = Buffer.alloc(data.length + 12);
	result.writeUInt32BE(data.length);
	result.write(type, 4, 'ascii');
	data.copy(result, 8);
	let crc = 0xffffffff;
	for (const byte of result.subarray(4, data.length + 8)) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
	}
	result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, data.length + 8);
	return result;
}
function storedPng() {
	const width = 1024,
		height = 512;
	const pixels = Buffer.alloc((width * 4 + 1) * height);
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++) {
			const offset = y * (width * 4 + 1) + 1 + x * 4;
			pixels[offset] = x % 256;
			pixels[offset + 1] = y % 256;
			pixels[offset + 2] = (x + y) % 256;
			pixels[offset + 3] = x % 2 ? 64 : 255;
		}
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 6;
	return Buffer.concat([
		Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'),
		pngChunk('IHDR', header),
		pngChunk('tEXt', Buffer.from('Author\0FreeLM lossless moderation fixture')),
		pngChunk('IDAT', deflateSync(pixels, { level: 0 })),
		pngChunk('IEND', Buffer.alloc(0)),
	]);
}
function pngChunks(base64: string) {
	const bytes = Buffer.from(base64, 'base64');
	const chunks: { type: string; data: Buffer; raw: Buffer }[] = [];
	for (let offset = 8; offset < bytes.length;) {
		const length = bytes.readUInt32BE(offset);
		chunks.push({
			type: bytes.toString('ascii', offset + 4, offset + 8),
			data: bytes.subarray(offset + 8, offset + 8 + length),
			raw: bytes.subarray(offset, offset + 12 + length),
		});
		offset += length + 12;
	}
	return chunks;
}
function expectOutputSchema(request: WireRequest, api: Connection['chatApi']) {
	const format = { name: 'freelm_moderation', strict: true, schema: OUTPUT_SCHEMA };
	if (api === 'responses') {
		expect((request.body!.text as { format: unknown }).format).toEqual({
			type: 'json_schema',
			...format,
		});
		expect(request.body).not.toHaveProperty('response_format');
	} else {
		expect(request.body!.response_format).toEqual({ type: 'json_schema', json_schema: format });
		expect(request.body).not.toHaveProperty('text');
	}
}
const GENERATION: WireRequest = {
	id: 'generation',
	connectionId: 'generator',
	baseUrl: 'https://generation.example/v1',
	apiKey: 'generation-secret',
	path: '/images/generations',
	method: 'POST',
	body: { model: 'generator', prompt: 'A white square' },
};
const EDIT: WireRequest = {
	...GENERATION,
	path: '/images/edits',
	body: undefined,
	form: [
		{ name: 'prompt', value: 'Brighten the photograph' },
		{ name: 'image', file: { name: 'reference.png', type: 'image/png', base64: PNG } },
	],
};
const VIDEO_REFERENCE: WireRequest = {
	...GENERATION,
	path: '/videos',
	body: undefined,
	form: [
		{ name: 'prompt', value: 'Animate the scene, keeping the clothing fully opaque' },
		{ name: 'input_reference', file: { name: 'person.png', type: 'image/png', base64: PNG } },
	],
};
const json = (body: unknown, status = 200): WireResponse => ({
	status,
	contentType: 'application/json',
	encoding: 'text',
	body: JSON.stringify(body),
});

const evaluation = (labels: unknown = CLEAN, api: 'responses' | 'chat' = 'responses') =>
	json(
		api === 'responses'
			? {
					status: 'completed',
					output: [
						{
							type: 'message',
							role: 'assistant',
							status: 'completed',
							content: [
								{
									type: 'output_text',
									text: typeof labels === 'string' ? labels : JSON.stringify(labels),
								},
							],
						},
					],
				}
			: {
					choices: [
						{
							finish_reason: 'stop',
							message: { content: typeof labels === 'string' ? labels : JSON.stringify(labels) },
						},
					],
				},
	);
function fixture(level: ModerationLevel = 'low') {
	const connection: Connection = {
		id: 'judge',
		name: 'Evaluator',
		baseUrl: 'https://evaluation.example/v1',
		apiKey: 'evaluation-secret',
		chatApi: 'responses',
		models: { chat: 'vision', images: '', videos: '', speech: '', transcription: '' },
		discoveredModels: [],
		catalog: [
			{
				id: 'vision',
				name: 'Vision evaluator',
				enabled: true,
				tasks: ['chat'],
				inputModalities: ['text', 'image'],
				outputModalities: ['text'],
				defaultThinkingMode: 'careful',
				thinkingModes: [
					{
						id: 'careful',
						name: 'Careful',
						parameters: {
							responses: { reasoning: { effort: 'high' } },
							chat: { reasoning_effort: 'high' },
						},
					},
				],
			},
		],
	};
	const moderation = defaultModerationSettings();
	moderation.image = {
		enabled: true,
		level,
		connectionId: 'judge',
		model: 'vision',
		thinkingMode: 'careful',
	};
	moderation.video = {
		enabled: true,
		level,
		connectionId: 'judge',
		model: 'vision',
		thinkingMode: 'careful',
		videoApi: 'chat/completions',
	};
	const state: ModerationState & { moderation: ModerationSettings } = {
		connections: [connection],
		moderation,
	};
	const requests: WireRequest[] = [];
	const responses = [evaluation(), json({ data: [{ b64_json: PNG }] }), evaluation()];
	const execute = vi.fn(
		async (request: WireRequest, _onChunk: (text: string) => void, signal?: AbortSignal) => {
			signal?.throwIfAborted();
			requests.push(request);
			const response = responses.shift();
			if (!response) throw new Error('Unexpected mock request');
			return response;
		},
	);
	const download = vi.fn(
		async (
			_url: string,
			_signal?: AbortSignal,
			_kind?: 'image' | 'video',
		): Promise<WireResponse> => ({
			status: 200,
			contentType: 'image/png',
			encoding: 'base64',
			body: PNG,
		}),
	);
	const frames = vi.fn<ModerationVideoFrameExtractor>(async function* () {
		yield { timestamp: 0, image: `data:image/png;base64,${PNG}` };
	});
	const guard = new MediaModerationGuard(async () => state, execute, download, frames);
	return { state, connection, requests, responses, execute, download, guard, frames };
}
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('media moderation transport boundary', () => {
	it.each(['responses', 'chat/completions'] as const)(
		'passes intact AVIF to the %s input evaluator and image provider',
		async (api) => {
			const { guard, responses, requests, state } = fixture();
			state.connections[0].chatApi = api;
			const transport = api === 'responses' ? 'responses' : 'chat';
			responses[0] = evaluation(CLEAN_EDIT, transport);
			responses[2] = evaluation(CLEAN, transport);
			const editing: WireRequest = {
				...EDIT,
				form: [
					EDIT.form![0],
					{ name: 'image', file: { name: 'reference.avif', type: 'image/avif', base64: AVIF } },
				],
			};
			const original = structuredClone(editing);
			await guard.request(editing, () => {});
			expect(requests).toHaveLength(3);
			expect(JSON.stringify(requests[0].body)).toContain(`data:image/avif;base64,${AVIF}`);
			expect(requests[1]).toBe(editing);
			expect(editing).toEqual(original);
		},
	);

	it('blocks classified contextual nudity in AVIF edits before reaching the image provider', async () => {
		const { guard, responses, requests } = fixture('low');
		responses[0] = evaluation({ ...CLEAN_EDIT, input_contains_person: true, edit_nudity: true });
		const editing: WireRequest = {
			...EDIT,
			form: [
				EDIT.form![0],
				{ name: 'image', file: { name: 'reference.avif', type: 'image/avif', base64: AVIF } },
			],
		};
		await expect(guard.request(editing, () => {})).rejects.toThrow('Image edit blocked by low');
		expect(requests).toHaveLength(1);
		expect(JSON.stringify(requests[0].body)).toContain(`data:image/avif;base64,${AVIF}`);
	});

	it('keeps AVIF edits blocked if their configured input evaluator cannot inspect the image', async () => {
		const { guard, responses, requests } = fixture();
		responses[0] = json({ error: { message: 'Unsupported evaluator image format' } }, 400);
		const editing: WireRequest = {
			...EDIT,
			form: [
				EDIT.form![0],
				{ name: 'image', file: { name: 'reference.avif', type: 'image/avif', base64: AVIF } },
			],
		};
		await expect(guard.request(editing, () => {})).rejects.toThrow(/moderation could not complete/);
		expect(requests).toHaveLength(1);
		expect(requests[0].path).toBe('/responses');
	});

	it('uses image/avif for compatible-brand AVIF output evaluation without modifying its bytes', async () => {
		const { guard, responses, requests } = fixture();
		const compatible = Buffer.from(AVIF, 'base64');
		compatible.write('mif1', 8, 'ascii');
		const encoded = compatible.toString('base64');
		responses[1] = json({ data: [{ b64_json: encoded }] });
		const result = await guard.request(GENERATION, () => {});
		expect(JSON.parse(result.body).data[0].b64_json).toBe(encoded);
		expect(JSON.stringify(requests[2].body)).toContain(`data:image/avif;base64,${encoded}`);
	});

	it('sends a losslessly recompressed full-resolution copy to the evaluator and preserves the generator image', async () => {
		const { guard, responses, requests } = fixture();
		const original = storedPng().toString('base64');
		responses[1] = json({ data: [{ b64_json: original }] });
		const result = await guard.request(GENERATION, () => {});
		expect(JSON.parse(result.body).data[0].b64_json).toBe(original);
		expect(requests).toHaveLength(3);
		expect(requests[1]).toBe(GENERATION);
		for (const request of [requests[0], requests[2]]) expectOutputSchema(request, 'responses');
		const content = (
			requests[2].body!.input as { role: string; content: { type: string; image_url?: string }[] }[]
		)[1].content;
		const evaluated = content.find((part) => part.type === 'input_image')!.image_url!.split(',')[1];
		expect(evaluated.length).toBeLessThan(original.length);
		const originalChunks = pngChunks(original),
			evaluatedChunks = pngChunks(evaluated);
		expect(evaluatedChunks.map((chunk) => chunk.type)).toEqual(
			originalChunks.map((chunk) => chunk.type),
		);
		expect(
			evaluatedChunks.filter((chunk) => chunk.type !== 'IDAT').map((chunk) => chunk.raw),
		).toEqual(originalChunks.filter((chunk) => chunk.type !== 'IDAT').map((chunk) => chunk.raw));
		const inflated = (chunks: ReturnType<typeof pngChunks>) =>
			inflateSync(
				Buffer.concat(chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data)),
			);
		expect(Buffer.compare(inflated(evaluatedChunks), inflated(originalChunks))).toBe(0);
		const header = evaluatedChunks.find((chunk) => chunk.type === 'IHDR')!.data;
		expect([header.readUInt32BE(0), header.readUInt32BE(4), header[9]]).toEqual([1024, 512, 6]);
	});
	it('fails closed with an image preparation diagnosis when lossless inspection preparation fails', async () => {
		const { guard, requests } = fixture();
		vi.spyOn(imagePayload, 'moderateImagePayload').mockRejectedValue(
			new Error(`PRIVATE_IMAGE ${PNG}`),
		);
		const pending = guard.request(GENERATION, () => {});
		await expect(pending).rejects.toThrow(
			'The image could not be prepared for lossless inspection',
		);
		try {
			await pending;
		} catch (error) {
			expect(String(error)).not.toContain('Transport error');
			expect(String(error)).not.toContain('PRIVATE_IMAGE');
			expect(String(error)).not.toContain(PNG);
		}
		expect(requests).toHaveLength(2);
	});
	it('preserves cancellation during image preparation and does not call the output evaluator', async () => {
		const { guard, requests } = fixture();
		const controller = new AbortController(),
			reason = new Error('User cancelled during preparation');
		vi.spyOn(imagePayload, 'moderateImagePayload').mockImplementation(async (_url, signal) => {
			controller.abort(reason);
			signal?.throwIfAborted();
			return _url;
		});
		await expect(guard.request(GENERATION, () => {}, controller.signal)).rejects.toBe(reason);
		expect(requests).toHaveLength(2);
	});
	it.each(['responses', 'chat', 'chat/completions'] as const)(
		'requests strict image category output for both classifier stages over %s',
		async (api) => {
			const { guard, connection, requests, responses } = fixture();
			connection.chatApi = api;
			// A user's thinking parameters must never downgrade the moderation contract.
			const parameters = connection.catalog![0].thinkingModes[0].parameters;
			if (api === 'responses')
				parameters.responses = { text: { format: { type: 'text' }, verbosity: 'low' } };
			else parameters.chat = { response_format: { type: 'json_object' } };
			responses.splice(
				0,
				responses.length,
				evaluation(CLEAN, api === 'responses' ? 'responses' : 'chat'),
				json({ data: [{ b64_json: PNG }] }),
				evaluation(CLEAN, api === 'responses' ? 'responses' : 'chat'),
			);
			await guard.request(GENERATION, () => {});
			expect(requests).toHaveLength(3);
			for (const request of [requests[0], requests[2]]) {
				expect(request.path).toBe(`/${api}`);
				expectOutputSchema(request, api);
				if (api === 'responses') expect(request.body!.text).toHaveProperty('verbosity', 'low');
			}
			expect(requests[1]).toBe(GENERATION);
		},
	);
	it.each(['responses', 'chat/completions'] as const)(
		'uses isolated evaluator requests over %s with the same rubric and no output prompt contamination',
		async (api) => {
			const { guard, connection, requests, responses } = fixture();
			connection.chatApi = api;
			responses[0] = evaluation(CLEAN, api === 'responses' ? 'responses' : 'chat');
			responses[2] = evaluation(CLEAN, api === 'responses' ? 'responses' : 'chat');
			const result = await guard.request(GENERATION, () => {});
			expect(JSON.parse(result.body).data[0].b64_json).toBe(PNG);
			expect(requests).toHaveLength(3);
			expect(requests[1]).toBe(GENERATION);
			for (const request of [requests[0], requests[2]]) {
				expectOutputSchema(request, api);
				expect(request).toMatchObject({
					baseUrl: 'https://evaluation.example/v1',
					apiKey: 'evaluation-secret',
					connectionId: 'judge',
					path: `/${api}`,
					stream: false,
				});
				expect(request.body).toMatchObject({
					model: 'vision',
					...(api === 'responses'
						? { reasoning: { effort: 'high' }, store: false }
						: { reasoning_effort: 'high' }),
				});
				for (const key of [
					'tools',
					'previous_response_id',
					'conversation',
					'personality',
					'memories',
					'moderation_level',
				])
					expect(request.body).not.toHaveProperty(key);
				const inputs = (
					api === 'responses' ? request.body!.input : request.body!.messages
				) as any[];
				expect(inputs).toHaveLength(2);
				expect(api === 'responses' ? inputs[0].content[0].text : inputs[0].content).toBe(
					MODERATION_RUBRIC,
				);
			}
			expect(JSON.stringify(requests[0].body)).not.toContain(PNG);
			expect(JSON.stringify(requests[2].body)).not.toContain('A white square');
			expect(JSON.stringify(requests[2].body)).toContain(PNG);
		},
	);
	it('does not call the classifier or downloader when disabled', async () => {
		const { guard, state, responses, requests, download } = fixture('high');
		const prepare = vi.spyOn(imagePayload, 'moderateImagePayload');
		state.moderation.image.enabled = false;
		responses.splice(0, responses.length, json({ data: [{ url: 'https://cdn.example/raw.png' }] }));
		const result = await guard.request(GENERATION, () => {});
		expect(JSON.parse(result.body).data[0].url).toBe('https://cdn.example/raw.png');
		expect(requests).toEqual([GENERATION]);
		expect(download).not.toHaveBeenCalled();
		expect(prepare).not.toHaveBeenCalled();
	});
	it('keeps image enablement independent while video moderation remains active', async () => {
		const { guard, state, requests, responses, download } = fixture('high');
		state.moderation.image.enabled = false;
		responses.splice(
			0,
			responses.length,
			json({ data: [{ url: 'https://cdn.example/raw.png' }] }),
			{ status: 200, contentType: 'video/mp4', encoding: 'base64', body: MP4 },
			evaluation({ ...CLEAN, gore: true }),
		);
		const image = await guard.request(GENERATION, () => {});
		expect(image.moderationWarnings).toBeUndefined();
		expect(JSON.parse(image.body).data[0].url).toBe('https://cdn.example/raw.png');
		await expect(
			guard.request(
				{ ...GENERATION, method: 'GET', path: '/videos/job/content', body: undefined },
				() => {},
			),
		).rejects.toThrow('Video output blocked by high');
		expect(requests).toHaveLength(3);
		expect(download).not.toHaveBeenCalled();
	});
	it('applies different image and video levels to the same category labels', async () => {
		const { guard, state, responses, requests } = fixture();
		state.moderation.video.level = 'high';
		responses[2] = evaluation({ ...CLEAN, gore: true });
		responses.push(
			{ status: 200, contentType: 'video/mp4', encoding: 'base64', body: MP4 },
			evaluation({ ...CLEAN, gore: true }),
		);
		expect((await guard.request(GENERATION, () => {})).status).toBe(200);
		await expect(
			guard.request(
				{ ...GENERATION, method: 'GET', path: '/videos/job/content', body: undefined },
				() => {},
			),
		).rejects.toThrow('Video output blocked by high');
		expect(requests).toHaveLength(5);
	});
	it.each([
		'/images/generations/',
		'/v1/images/generations?x=1',
		'/images/edits/?x=1',
		'/images/%67enerations',
	])('normalizes protected route %s before dispatch', async (path) => {
		const { guard, requests, responses } = fixture();
		const editing = path.includes('/edits');
		responses[0] = evaluation({ ...(editing ? CLEAN_EDIT : CLEAN), ncii: true });
		await expect(
			guard.request({ ...(editing ? EDIT : GENERATION), path }, () => {}),
		).rejects.toThrow('blocked');
		expect(requests).toHaveLength(1);
	});
	it.each(['ncii', 'sexual_minors', 'violent_minors'] as const)(
		'never sends a generation when %s is flagged at low',
		async (category) => {
			const { guard, requests, responses } = fixture();
			responses[0] = evaluation({ ...CLEAN, [category]: true });
			await expect(guard.request(GENERATION, () => {})).rejects.toThrow(
				'generation request was not sent',
			);
			expect(requests).toHaveLength(1);
		},
	);
	it.each([
		['low', { nudity: true }, true],
		['medium', { nudity: true }, false],
		['medium', { nudity: true, artistic_nudity: true }, true],
		['medium', { nudity: true, artistic_nudity: true, sexual_content: true }, false],
	] as [ModerationLevel, Partial<ModerationLabels>, boolean][])(
		'applies %s input policy before generation, requiring a nonsexual artistic classification for Medium nudity',
		async (level, labels, allowed) => {
			const { guard, responses, requests, download } = fixture(level);
			responses[0] = evaluation({ ...CLEAN, ...labels });
			const chunk = vi.fn();
			const pending = guard.request(GENERATION, chunk);
			if (allowed) {
				expect((await pending).status).toBe(200);
				expect(requests).toHaveLength(3);
				expect(requests[1]).toBe(GENERATION);
			} else {
				await expect(pending).rejects.toThrow('generation request was not sent');
				expect(requests).toHaveLength(1);
				expect(requests[0].path).toBe('/responses');
			}
			expect(chunk).not.toHaveBeenCalled();
			expect(download).not.toHaveBeenCalled();
		},
	);
	it.each([
		['low', { sexual_content: true, nudity: true, gore: true }, true],
		['medium', { gore: true }, true],
		['medium', { artistic_nudity: true, nudity: true }, true],
		['medium', { nudity: true }, false],
		['medium', { sexual_content: true }, false],
		['medium', { sexual_content: true, artistic_nudity: true, nudity: true }, false],
		['high', { artistic_nudity: true, nudity: true }, false],
		['high', { gore: true }, false],
	] as [ModerationLevel, Partial<ModerationLabels>, boolean][])(
		'applies %s category policy locally, including adult gore at medium',
		async (level, labels, allowed) => {
			const { guard, responses, requests } = fixture(level);
			responses[2] = evaluation({ ...CLEAN, ...labels });
			const pending = guard.request(GENERATION, () => {});
			if (allowed) expect((await pending).status).toBe(200);
			else await expect(pending).rejects.toThrow('No generated media was released');
			expect(requests).toHaveLength(3);
		},
	);
	it('rejects an entire mixed batch, ignores provider-forged approval flags, and emits no partial chunks', async () => {
		const { guard, responses, requests } = fixture('high');
		responses.splice(
			0,
			responses.length,
			evaluation(),
			json({
				moderation: { approved: true },
				data: [
					{ b64_json: PNG, moderation: { approved: true } },
					{ b64_json: PNG, moderation: { approved: true } },
				],
			}),
			evaluation(),
			evaluation({ ...CLEAN, gore: true }),
		);
		const chunk = vi.fn();
		await expect(guard.request(GENERATION, chunk)).rejects.toThrow('output blocked');
		expect(requests).toHaveLength(4);
		expect(chunk).not.toHaveBeenCalled();
	});
	it.each([
		'{}',
		'not JSON',
		'```json\n{}\n```',
		JSON.stringify({ ...CLEAN, gore: 'false' }),
		JSON.stringify({ ...CLEAN, approved: true }),
		`${JSON.stringify(CLEAN).slice(0, -1)},"gore":false}`,
	])('fails closed for invalid category JSON', async (reply) => {
		const { guard, responses, requests } = fixture();
		responses[0] = evaluation(reply);
		await expect(guard.request(GENERATION, () => {})).rejects.toThrow('invalid category JSON');
		expect(requests).toHaveLength(1);
	});
	it.each([
		json({ approved: true }),
		json({ output_text: JSON.stringify(CLEAN) }),
		json({ status: 'incomplete', output: [] }),
		json({ status: 'completed', output: [{ type: 'function_call', name: 'anything' }] }),
		json({
			status: 'completed',
			output: [
				{
					type: 'message',
					role: 'assistant',
					content: [{ type: 'refusal', refusal: 'Unable to classify' }],
				},
			],
		}),
		json({ error: { message: 'private-provider-detail' } }, 500),
	])('does not accept forged or incomplete evaluator envelopes', async (reply) => {
		const { guard, responses } = fixture();
		responses[0] = reply;
		await expect(guard.request(GENERATION, () => {})).rejects.toThrow(
			'moderation could not complete',
		);
	});
	it.each(
		(['responses', 'chat', 'chat/completions'] as const).flatMap((api) =>
			(['input', 'output'] as const).map((stage) => [api, stage] as const),
		),
	)(
		'fails closed without format fallback when %s rejects strict schemas at the %s stage',
		async (api, stage) => {
			const { guard, connection, requests, responses } = fixture();
			connection.chatApi = api;
			responses[0] = evaluation(CLEAN, api === 'responses' ? 'responses' : 'chat');
			responses[stage === 'input' ? 0 : 2] = json(
				{ error: { message: 'json_schema output is unsupported' } },
				400,
			);
			await expect(guard.request(GENERATION, () => {})).rejects.toThrow(
				'moderation could not complete',
			);
			expect(requests).toHaveLength(stage === 'input' ? 1 : 3);
			for (const request of requests.filter((request) => request !== GENERATION))
				expectOutputSchema(request, api);
		},
	);
	it('preserves evaluator HTTP status, error code and schema message while withholding generated output', async () => {
		const { guard, responses, requests } = fixture();
		responses[2] = json(
			{
				error: {
					code: 'unsupported_format',
					type: 'invalid_request_error',
					param: 'text.format',
					message: 'json_schema is unsupported for this model.',
				},
			},
			400,
		);
		await expect(guard.request(GENERATION, () => {})).rejects.toThrow(
			/Image output moderation could not complete\. Evaluator HTTP 400: code=unsupported_format; type=invalid_request_error; param=text\.format; message=json_schema is unsupported/,
		);
		expect(requests).toHaveLength(3);
		expectOutputSchema(requests[2], 'responses');
	});
	it('exposes the backend request_too_large diagnostic for an output evaluator HTTP 413', async () => {
		const { guard, responses, requests } = fixture();
		responses[2] = json(
			{ error: { code: 'request_too_large', message: 'Request body exceeds configured limit.' } },
			413,
		);
		await expect(guard.request(GENERATION, () => {})).rejects.toThrow(
			'Image output moderation could not complete. Evaluator HTTP 413: code=request_too_large; message=Request body exceeds configured limit.',
		);
		expect(requests).toHaveLength(3);
	});
	it('reports provider validation locations without echoing the rejected image input', async () => {
		const { guard, responses } = fixture();
		responses[2] = json(
			{
				detail: [
					{
						loc: ['body', 'input', 1, 'content', 1, 'detail'],
						msg: 'Field required',
						input: { image_url: `data:image/png;base64,${PNG}`, prompt: GENERATION.body!.prompt },
						type: 'missing',
					},
				],
			},
			422,
		);
		const pending = guard.request(GENERATION, () => {});
		await expect(pending).rejects.toThrow(
			'Evaluator HTTP 422: body.input.1.content.1.detail: Field required',
		);
		try {
			await pending;
		} catch (error) {
			expect(String(error)).not.toContain(PNG);
			expect(String(error)).not.toContain('A white square');
		}
	});
	it('reports incomplete Responses reason and token usage without displaying reasoning or partial category text', async () => {
		const { guard, responses, requests } = fixture();
		responses[2] = json({
			status: 'incomplete',
			incomplete_details: { reason: 'max_output_tokens' },
			usage: {
				input_tokens: 2431,
				output_tokens: 8192,
				output_tokens_details: { reasoning_tokens: 8192, private: 'not diagnostic data' },
			},
			output: [
				{ type: 'reasoning', summary: [{ text: 'PRIVATE_REASONING' }] },
				{
					type: 'message',
					role: 'assistant',
					content: [{ type: 'output_text', text: 'PRIVATE_PARTIAL_CLASSIFICATION' }],
				},
			],
		});
		const pending = guard.request(GENERATION, () => {});
		await expect(pending).rejects.toThrow(
			'Responses status=incomplete; incomplete reason=max_output_tokens',
		);
		try {
			await pending;
		} catch (error) {
			expect(String(error)).toContain(
				'input_tokens=2431, output_tokens=8192, reasoning_tokens=8192',
			);
			expect(String(error)).not.toContain('PRIVATE_');
			expect(String(error)).not.toContain('not diagnostic data');
		}
		expect(requests).toHaveLength(3);
	});
	it.each(['length', 'content_filter', 'tool_calls'])(
		'reports Chat finish_reason=%s and bounded token usage without the assistant content',
		async (finishReason) => {
			const { guard, connection, responses } = fixture();
			connection.chatApi = 'chat/completions';
			responses[0] = json({
				choices: [
					{
						finish_reason: finishReason,
						message: { content: 'PRIVATE_CLASSIFICATION', reasoning_content: 'PRIVATE_REASONING' },
					},
				],
				usage: {
					prompt_tokens: 800,
					completion_tokens: 8192,
					completion_tokens_details: { reasoning_tokens: 8000 },
				},
			});
			const pending = guard.request(GENERATION, () => {});
			await expect(pending).rejects.toThrow(`Chat finish_reason=${finishReason}`);
			try {
				await pending;
			} catch (error) {
				expect(String(error)).toContain(
					'prompt_tokens=800, completion_tokens=8192, reasoning_tokens=8000',
				);
				expect(String(error)).not.toContain('PRIVATE_');
			}
		},
	);
	it.each([
		[
			json({
				status: 'completed',
				output: [
					{
						type: 'message',
						role: 'assistant',
						status: 'incomplete',
						content: [{ type: 'output_text', text: 'PRIVATE_OUTPUT' }],
					},
				],
			}),
			'assistant message status=incomplete',
		],
		[
			json({
				status: 'completed',
				output: [{ type: 'reasoning', summary: [{ text: 'PRIVATE_OUTPUT' }] }],
				usage: { output_tokens: 8192 },
			}),
			'no assistant output text. Usage: output_tokens=8192',
		],
		[
			{ ...json({}), body: '{"output":"PRIVATE_OUTPUT"' },
			'JSON response could not be decoded or parsed',
		],
		[
			{
				status: 200,
				contentType: 'text/html',
				encoding: 'text',
				body: '<html>PRIVATE_OUTPUT</html>',
			} as WireResponse,
			'content type=text/html; expected JSON',
		],
		[
			{
				status: 200,
				contentType: 'application/json',
				encoding: 'base64',
				body: PNG,
			} as WireResponse,
			'response encoding=base64; expected JSON text',
		],
		[
			{ ...json({}), body: 'PRIVATE_OUTPUT'.repeat(10000) },
			'JSON response exceeds the 128000-character limit',
		],
	] as [WireResponse, string][])(
		'reports envelope/decoding failure: %s',
		async (response, diagnostic) => {
			const { guard, responses, requests } = fixture();
			responses[0] = response;
			const pending = guard.request(GENERATION, () => {});
			await expect(pending).rejects.toThrow(diagnostic);
			try {
				await pending;
			} catch (error) {
				expect(String(error)).not.toContain('PRIVATE_OUTPUT');
				expect(String(error)).not.toContain(PNG);
			}
			expect(requests).toHaveLength(1);
		},
	);
	it('redacts credentials, prompts, URLs and media when preserving provider error details', async () => {
		const { guard, responses } = fixture();
		const prompt = 'Private prompt with a quoted "description"';
		const request = { ...GENERATION, body: { ...GENERATION.body, prompt } };
		responses[2] = json(
			{
				error: {
					code: 'invalid_image',
					message: `Image was rejected: api_key=evaluation-secret generation-secret prompt=${prompt} escaped=${JSON.stringify(prompt).slice(1, -1)} encoded=${encodeURIComponent(prompt)} data:image/png;base64,${PNG} bare=${PNG} https://cdn.example/private.png?api_key=unknown-secret`,
				},
			},
			413,
		);
		const pending = guard.request(request, () => {});
		await expect(pending).rejects.toThrow('Evaluator HTTP 413: code=invalid_image');
		try {
			await pending;
		} catch (error) {
			const message = String(error);
			for (const sensitive of [
				'evaluation-secret',
				'generation-secret',
				prompt,
				JSON.stringify(prompt).slice(1, -1),
				encodeURIComponent(prompt),
				PNG,
				'cdn.example',
				'unknown-secret',
			])
				expect(message).not.toContain(sensitive);
			expect(message).toContain('[redacted');
		}
	});
	it('bounds provider diagnostic text and omits unrelated successful outputs from an error envelope', async () => {
		const { guard, responses } = fixture();
		responses[0] = json({
			error: { code: 'overloaded', message: 'Evaluator unavailable. '.repeat(200) },
			output: [
				{
					type: 'message',
					content: [{ type: 'output_text', text: 'PRIVATE_SUCCESSFUL_CLASSIFICATION' }],
				},
			],
			reasoning: 'PRIVATE_REASONING',
		});
		try {
			await guard.request(GENERATION, () => {});
			throw new Error('Expected evaluation failure');
		} catch (error) {
			const message = String(error);
			expect(message).toContain('code=overloaded');
			expect(message).toContain('…');
			expect(message.length).toBeLessThan(1900);
			expect(message).not.toContain('PRIVATE_');
		}
	});
	it('redacts short unprefixed video payloads from provider messages', async () => {
		const { guard, responses } = fixture();
		const shortVideo = btoa('\x00\x00\x00\x0cftypisom');
		responses.splice(
			0,
			responses.length,
			{ status: 200, contentType: 'video/mp4', encoding: 'base64', body: shortVideo },
			json({ error: { code: 1002, message: `Invalid video bytes: ${shortVideo}` } }, 400),
		);
		const pending = guard.request(
			{ ...GENERATION, method: 'GET', path: '/videos/job/content', body: undefined },
			() => {},
		);
		await expect(pending).rejects.toThrow('Evaluator HTTP 400: code=1002');
		try {
			await pending;
		} catch (error) {
			expect(String(error)).not.toContain(shortVideo);
			expect(String(error)).toContain('[redacted]');
		}
	});
	it('keeps diagnostics usable and private when the original prompt has malformed UTF-16', async () => {
		const { guard, responses } = fixture();
		const prompt = 'PRIVATE_PROMPT\ud800';
		responses[0] = json(
			{ error: { code: 'invalid_input', message: `Unsupported prompt: ${prompt}` } },
			400,
		);
		const pending = guard.request(
			{ ...GENERATION, body: { ...GENERATION.body, prompt } },
			() => {},
		);
		await expect(pending).rejects.toThrow('Evaluator HTTP 400: code=invalid_input');
		try {
			await pending;
		} catch (error) {
			expect(String(error)).not.toContain('PRIVATE_PROMPT');
		}
	});
	it.each([
		[
			new TypeError('fetch failed', {
				cause: Object.assign(new Error('Private network address'), { code: 'ECONNREFUSED' }),
			}),
			'Transport error (TypeError; code=ECONNREFUSED): network request failed',
		],
		[
			new Error('Request timed out while processing PRIVATE_DATA'),
			'Transport error (Error): request timed out',
		],
		[
			new TypeError('Malformed UTF-8 in PRIVATE_DATA'),
			'Transport error (TypeError): response decoding failed',
		],
	] as [Error, string][])('reports safe transport evidence for %s', async (failure, diagnostic) => {
		const { state } = fixture();
		const execute = vi.fn(async () => {
			throw failure;
		});
		const guard = new MediaModerationGuard(async () => state, execute);
		const pending = guard.request(GENERATION, () => {});
		await expect(pending).rejects.toThrow(diagnostic);
		try {
			await pending;
		} catch (error) {
			expect(String(error)).not.toContain('PRIVATE_DATA');
			expect(String(error)).not.toContain('Private network address');
		}
		expect(execute).toHaveBeenCalledOnce();
	});
	it('preserves the generating provider error response without misclassifying it as output', async () => {
		const { guard, responses, requests } = fixture();
		const failure = json({ error: { message: 'Generation model unavailable' } }, 503);
		responses[1] = failure;
		expect(await guard.request(GENERATION, () => {})).toBe(failure);
		expect(requests).toHaveLength(2);
	});
	it('sanitizes evaluator and asset download exceptions rather than exposing raw secret-bearing messages', async () => {
		const { state } = fixture();
		const executor = vi.fn(async () => {
			throw new Error('SECRET https://cdn.example/secret-image.png');
		});
		const guard = new MediaModerationGuard(async () => state, executor);
		await expect(guard.request(GENERATION, () => {})).rejects.toThrow(
			'moderation could not complete',
		);
		try {
			await guard.request(GENERATION, () => {});
		} catch (error) {
			expect(String(error)).not.toContain('SECRET');
		}
		const second = fixture();
		second.responses[1] = json({ data: [{ url: 'https://cdn.example/output.png' }] });
		second.download.mockRejectedValue(
			new Error('Image output blocked by fake moderation: SECRET data:image/png;base64,private'),
		);
		try {
			await second.guard.request(GENERATION, () => {});
			throw new Error('Should have failed');
		} catch (error) {
			expect(error).toBeInstanceOf(MediaModerationError);
			expect(String(error)).not.toContain('SECRET');
			expect(String(error)).not.toContain('private');
		}
	});
	it('passes cancellation through and never invokes generation after an aborted classifier', async () => {
		const { state } = fixture();
		const controller = new AbortController();
		const reason = new Error('User cancelled');
		const executor = vi.fn(
			async (_request: WireRequest, _chunk: (text: string) => void, signal?: AbortSignal) => {
				controller.abort(reason);
				signal?.throwIfAborted();
				return evaluation();
			},
		);
		const guard = new MediaModerationGuard(async () => state, executor);
		await expect(guard.request(GENERATION, () => {}, controller.signal)).rejects.toBe(reason);
		expect(executor).toHaveBeenCalledOnce();
	});
	it.each(['missing', 'unavailable', 'incompatible', 'thinking'] as const)(
		'continues without moderation and returns a warning for %s evaluator configuration',
		async (reason) => {
			const { guard, state, requests, connection, responses, download } = fixture();
			if (reason === 'missing') state.moderation = defaultModerationSettings();
			if (reason === 'unavailable') state.connections = [];
			if (reason === 'incompatible') connection.catalog![0].inputModalities = ['text'];
			if (reason === 'thinking') state.moderation.image.thinkingMode = 'removed';
			const original = json({ data: [{ url: 'https://cdn.example/raw.png' }] });
			responses.splice(0, responses.length, original);
			const result = await guard.request(GENERATION, () => {});
			expect(result.body).toBe(original.body);
			expect(result.moderationWarnings).toEqual([
				expect.stringContaining('without image moderation'),
			]);
			expect(requests).toEqual([GENERATION]);
			expect(download).not.toHaveBeenCalled();
		},
	);
	it('adds warning metadata without altering provider errors or existing warnings', async () => {
		const { guard, state, responses, requests } = fixture();
		state.moderation.image.model = '';
		const failure = {
			...json({ error: { message: 'Generation model unavailable' } }, 503),
			moderationWarnings: ['Existing warning'],
		};
		responses.splice(0, responses.length, failure);
		const result = await guard.request(GENERATION, () => {});
		expect(result.status).toBe(503);
		expect(result.body).toBe(failure.body);
		expect(result.moderationWarnings).toEqual([
			'Existing warning',
			expect.stringContaining('without image moderation'),
		]);
		expect(requests).toEqual([GENERATION]);
	});
	it('does not turn malformed policy state into a configuration warning', async () => {
		const { state, execute, download } = fixture();
		const malformed = {
			...state,
			moderation: { ...state.moderation, image: { ...state.moderation.image, enabled: 'yes' } },
		} as unknown as ModerationState;
		const guard = new MediaModerationGuard(async () => malformed, execute, download);
		await expect(guard.request(GENERATION, () => {})).rejects.toThrow('settings are invalid');
		expect(execute).not.toHaveBeenCalled();
	});
	it('normalizes a legacy shared policy before running the configured classifier', async () => {
		const { state, execute, responses, requests, download } = fixture();
		const { enabled: _imageEnabled, level: _imageLevel, ...image } = state.moderation.image;
		const { enabled: _videoEnabled, level: _videoLevel, ...video } = state.moderation.video;
		const legacy: ModerationState = {
			...state,
			moderation: { enabled: true, level: 'high', image, video },
		};
		responses[0] = evaluation({ ...CLEAN, gore: true });
		const guard = new MediaModerationGuard(async () => legacy, execute, download);
		await expect(guard.request(GENERATION, () => {})).rejects.toThrow(
			'Image prompt blocked by high',
		);
		expect(requests).toHaveLength(1);
	});
	it('permits other-kind policy and evaluator edits during image classification', async () => {
		const { state, responses } = fixture();
		let count = 0;
		const executor = vi.fn(async () => {
			const response = responses.shift()!;
			if (++count === 1)
				state.moderation.video = {
					enabled: false,
					level: 'high',
					connectionId: 'another-api',
					model: 'another-video-model',
					thinkingMode: 'fast',
					videoApi: 'responses',
				};
			return response;
		});
		const guard = new MediaModerationGuard(async () => state, executor);
		expect((await guard.request(GENERATION, () => {})).status).toBe(200);
		expect(executor).toHaveBeenCalledTimes(3);
	});
	it('requires retry if an unconfigured evaluator becomes configured while generation is in progress', async () => {
		const { state } = fixture();
		state.moderation.image.model = '';
		const guard = new MediaModerationGuard(
			async () => state,
			async () => {
				state.moderation.image.model = 'vision';
				return json({ data: [{ b64_json: PNG }] });
			},
		);
		await expect(guard.request(GENERATION, () => {})).rejects.toThrow(
			'changed during this request',
		);
	});
	it('fails closed if policy changes during input evaluation or while holding an approved output batch', async () => {
		for (const changedAfter of [1, 3]) {
			const { state, responses } = fixture();
			let count = 0;
			const executor = vi.fn(async () => {
				const response = responses.shift()!;
				if (++count === changedAfter) state.moderation.image.level = 'high';
				return response;
			});
			const guard = new MediaModerationGuard(async () => state, executor);
			await expect(guard.request(GENERATION, () => {})).rejects.toThrow(
				'changed during this request',
			);
			expect(executor).toHaveBeenCalledTimes(changedAfter);
		}
	});
	it('fails closed when disabled moderation becomes enabled before a generated asset is released', async () => {
		const { state } = fixture();
		state.moderation.image.enabled = false;
		const guard = new MediaModerationGuard(
			async () => state,
			async () => {
				state.moderation.image.enabled = true;
				return json({ data: [{ b64_json: PNG }] });
			},
		);
		await expect(guard.request(GENERATION, () => {})).rejects.toThrow(
			'changed during this request',
		);
	});
	it.each(['responses', 'chat/completions', 'chat'] as const)(
		'jointly checks all edit references using strict ten-flag %s input and isolated seven-flag output',
		async (api) => {
			const { guard, requests, responses, state } = fixture();
			state.connections[0].chatApi = api;
			const transport = api === 'responses' ? 'responses' : 'chat';
			responses[0] = evaluation({ ...CLEAN_EDIT, input_contains_person: true }, transport);
			responses[2] = evaluation(CLEAN, transport);
			const mask = btoa('mask-not-a-person');
			const editing: WireRequest = {
				...EDIT,
				form: [
					{ name: 'prompt', value: 'Remove the logo from the shirt' },
					{ name: 'image[]', file: { name: 'first.png', type: 'image/png', base64: PNG } },
					{ name: 'image[]', file: { name: 'second.png', type: 'image/png', base64: PNG } },
					{ name: 'mask', file: { name: 'mask.png', type: 'image/png', base64: mask } },
				],
			};
			const original = structuredClone(editing);
			await guard.request(editing, () => {});
			expect(editing).toEqual(original);
			expect(requests[1]).toBe(editing);
			const body = requests[0].body!;
			const format =
				api === 'responses' ? (body.text as any).format : (body.response_format as any).json_schema;
			expect(format.name).toBe('freelm_image_edit_moderation');
			expect(format.strict).toBe(true);
			expect(format.schema.required).toEqual(Object.keys(CLEAN_EDIT));
			expect(format.schema.additionalProperties).toBe(false);
			const input = (api === 'responses' ? body.input : body.messages) as any[];
			expect(api === 'responses' ? input[0].content[0].text : input[0].content).toBe(
				IMAGE_EDIT_MODERATION_RUBRIC,
			);
			expect(input[1].content).toHaveLength(3);
			expect(JSON.stringify(input[1])).toContain('Remove the logo from the shirt');
			expect(JSON.stringify(body)).not.toContain(mask);
			expect(input[1].content.slice(1)).toEqual(
				[0, 1].map(() =>
					api === 'responses'
						? { type: 'input_image', image_url: `data:image/png;base64,${PNG}` }
						: { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
				),
			);
			expectOutputSchema(requests[2], api);
			expect(JSON.stringify(requests[2].body)).not.toContain('Remove the logo');
			expect(JSON.stringify(requests[2].body)).not.toContain('input_contains_person');
		},
	);
	it.each(['low', 'medium', 'high'] as const)(
		'blocks contextual undressing and sexual edits at %s before generation',
		async (level) => {
			for (const category of ['edit_nudity', 'edit_sexual_content'] as const) {
				const { guard, requests, responses } = fixture(level);
				responses[0] = evaluation({ ...CLEAN_EDIT, input_contains_person: true, [category]: true });
				const editing = {
					...EDIT,
					form: EDIT.form!.map((field) =>
						field.name === 'prompt'
							? { ...field, value: 'The top has been completely removed' }
							: field,
					),
				};
				await expect(guard.request(editing, () => {})).rejects.toThrow(
					`Image edit blocked by ${level}`,
				);
				expect(requests).toHaveLength(1);
				expect(requests[0].path).toBe('/responses');
			}
		},
	);
	it.each(['sexual_content', 'nudity', 'artistic_nudity'] as const)(
		'holds %s output from an otherwise harmless edit at Low',
		async (category) => {
			const { guard, requests, responses } = fixture('low');
			responses[0] = evaluation({ ...CLEAN_EDIT, input_contains_person: true });
			responses[2] = evaluation({ ...CLEAN, [category]: true });
			await expect(guard.request(EDIT, () => {})).rejects.toThrow('Image output blocked by low');
			expect(requests).toHaveLength(3);
		},
	);
	it('applies edit rules to reference-bearing generation requests too', async () => {
		const { guard, requests, responses } = fixture('low');
		responses[0] = evaluation({ ...CLEAN_EDIT, edit_nudity: true });
		await expect(
			guard.request(
				{ ...GENERATION, body: { ...GENERATION.body, image: `data:image/png;base64,${PNG}` } },
				() => {},
			),
		).rejects.toThrow('Image edit blocked by low');
		expect(requests).toHaveLength(1);
	});
	it.each([CLEAN, { ...CLEAN_EDIT, edit_nudity: 'false' }, { ...CLEAN_EDIT, extra: false }])(
		'holds edits on malformed contextual classification',
		async (labels) => {
			const { guard, requests, responses } = fixture('low');
			responses[0] = evaluation(labels);
			await expect(guard.request(EDIT, () => {})).rejects.toThrow('invalid category JSON');
			expect(requests).toHaveLength(1);
		},
	);
	it.each([
		{ ...EDIT, form: [{ name: 'prompt', value: 'A background change' }] },
		{ ...GENERATION, body: { ...GENERATION.body, image: 'https://cdn.example/mutable.png' } },
		{
			...EDIT,
			form: [
				...EDIT.form!,
				{ name: 'image[]', file: { name: 'bad.png', type: 'image/png', base64: 'invalid' } },
			],
		},
	])(
		'requires every reference to be inspectable before contacting either model',
		async (editing) => {
			const { guard, requests, download } = fixture('low');
			await expect(guard.request(editing, () => {})).rejects.toThrow('reference images');
			expect(requests).toHaveLength(0);
			expect(download).not.toHaveBeenCalled();
		},
	);
	it('keeps disabled and unconfigured edit moderation behavior', async () => {
		for (const configured of [false, true]) {
			const { guard, requests, responses, state } = fixture('low');
			if (configured) state.moderation.image.enabled = false;
			else state.moderation.image.model = '';
			responses[0] = json({ data: [{ b64_json: PNG }] });
			const result = await guard.request(EDIT, () => {});
			expect(requests).toEqual([EDIT]);
			expect(result.moderationWarnings?.length).toBe(configured ? undefined : 1);
		}
	});
	it('downloads CDN images without provider credentials, checks downloaded bytes and returns a snapshot', async () => {
		const { state, execute, responses } = fixture();
		responses[1] = json({ data: [{ url: 'https://cdn.example/output.png' }] });
		const fetch = vi.fn(
			async (_url: string | URL | Request, _options?: RequestInit) =>
				new Response(
					Uint8Array.from(atob(PNG), (char) => char.charCodeAt(0)),
					{ headers: { 'content-type': 'image/png' } },
				),
		);
		vi.stubGlobal('fetch', fetch);
		const guard = new MediaModerationGuard(async () => state, execute);
		const result = await guard.request(GENERATION, () => {});
		expect(fetch.mock.calls[0]).toHaveLength(2);
		const options = fetch.mock.calls[0][1] as RequestInit;
		expect(options.headers).toBeUndefined();
		expect(options.redirect).toBe('error');
		const image = JSON.parse(result.body).data[0];
		expect(image.url).toBeUndefined();
		expect(image.b64_json).toBe(PNG);
	});
	it.each(['chat/completions', 'chat', 'responses'] as const)(
		'evaluates sampled images using the connection %s transport, ignoring legacy videoApi',
		async (api) => {
			const { guard, state, requests, responses } = fixture();
			const prepare = vi.spyOn(imagePayload, 'moderateImagePayload');
			state.connections[0].chatApi = api;
			state.moderation!.video.videoApi = api === 'responses' ? 'chat' : 'responses';
			responses.splice(
				0,
				responses.length,
				evaluation(CLEAN, api === 'responses' ? 'responses' : 'chat'),
				json({ id: 'job', status: 'queued' }),
				{ status: 200, contentType: 'video/mp4', encoding: 'base64', body: MP4 },
				evaluation(CLEAN, api === 'responses' ? 'responses' : 'chat'),
			);
			await guard.request({ ...GENERATION, path: '/videos' }, () => {});
			const result = await guard.request(
				{ ...GENERATION, method: 'GET', path: '/videos/job/content', body: undefined },
				() => {},
			);
			expect(result.body).toBe(MP4);
			expect(requests).toHaveLength(4);
			for (const request of [requests[0], requests[3]]) {
				expect(request.path).toBe(`/${api}`);
				expectOutputSchema(request, api);
			}
			const content = JSON.stringify(requests[3].body);
			expect(content).not.toContain(MP4);
			expect(content).toContain('image_url');
			expect(content).toContain(PNG);
			expect(content).toContain('sampled at 0 seconds');
			expect(content).not.toContain('video_url');
			expect(prepare).toHaveBeenCalled();
		},
	);
	it('checks video creation/remix text before submitting, and inspects immediately returned native video URLs', async () => {
		const { guard, state, responses, requests, download } = fixture('high');
		state.connections[0].chatApi = 'chat';
		responses.splice(
			0,
			responses.length,
			evaluation(CLEAN, 'chat'),
			json({ id: 'job', status: 'completed', video_url: 'https://cdn.example/result.mp4' }),
			evaluation({ ...CLEAN, gore: true }, 'chat'),
		);
		download.mockResolvedValue({
			status: 200,
			contentType: 'video/mp4',
			encoding: 'base64',
			body: MP4,
		});
		await expect(
			guard.request({ ...GENERATION, path: '/videos/previous/remix' }, () => {}),
		).rejects.toThrow('Video output blocked');
		expect(requests[1].path).toBe('/videos/previous/remix');
		expect(download).toHaveBeenCalledWith('https://cdn.example/result.mp4', undefined, 'video');
	});
	it('rejects invalid media, oversized output batches and attempts to stream unreviewed generated output', async () => {
		const first = fixture();
		first.responses[1] = json({ data: [{ b64_json: btoa('not an image') }] });
		await expect(first.guard.request(GENERATION, () => {})).rejects.toThrow(
			'could not be safely inspected',
		);
		const second = fixture();
		second.responses[1] = json({ data: Array.from({ length: 17 }, () => ({ b64_json: PNG })) });
		await expect(second.guard.request(GENERATION, () => {})).rejects.toThrow('1–16 images');
		const third = fixture();
		await expect(third.guard.request({ ...GENERATION, stream: true }, () => {})).rejects.toThrow(
			'streaming',
		);
		expect(third.requests).toHaveLength(0);
	});
	it('moderates every sampled frame sequentially before releasing the original video bytes', async () => {
		const { guard, frames, responses, requests } = fixture();
		const lifecycle: string[] = [];
		frames.mockImplementation(async function* (_asset, signal) {
			try {
				for (let timestamp = 0; timestamp < 4; timestamp++) {
					signal?.throwIfAborted();
					lifecycle.push(`frame-${timestamp}`);
					yield { timestamp, image: `data:image/png;base64,${PNG}` };
					expect(requests).toHaveLength(timestamp + 2);
				}
			} finally {
				lifecycle.push('closed');
			}
		});
		responses.splice(
			0,
			responses.length,
			{ status: 200, contentType: 'video/mp4', encoding: 'base64', body: MP4 },
			...Array.from({ length: 4 }, () => evaluation()),
		);
		const result = await guard.request(
			{ ...GENERATION, method: 'GET', path: '/videos/job/content', body: undefined },
			() => {},
		);
		expect(result.body).toBe(MP4);
		expect(lifecycle).toEqual(['frame-0', 'frame-1', 'frame-2', 'frame-3', 'closed']);
		for (let i = 0; i < 4; i++) {
			expect(JSON.stringify(requests[i + 1].body)).toContain(`sampled at ${i} seconds`);
			expect(JSON.stringify(requests[i + 1].body)).not.toContain(MP4);
			expectOutputSchema(requests[i + 1], 'responses');
		}
	});
	it.each(['denied', 'invalid', 'aborted', 'decode-error'] as const)(
		'withholds the entire video and closes its iterator after a later frame is %s',
		async (failure) => {
			const { guard, frames, responses, requests, state } = fixture('high');
			const controller = new AbortController();
			let closed = false;
			frames.mockImplementation(async function* () {
				try {
					yield { timestamp: 0, image: `data:image/png;base64,${PNG}` };
					if (failure === 'aborted') controller.abort(new DOMException('Stopped', 'AbortError'));
					if (failure === 'decode-error') throw new Error('Decoder failed');
					yield { timestamp: 1, image: `data:image/png;base64,${PNG}` };
					yield { timestamp: 2, image: `data:image/png;base64,${PNG}` };
				} finally {
					closed = true;
				}
			});
			responses.splice(
				0,
				responses.length,
				{ status: 200, contentType: 'video/mp4', encoding: 'base64', body: MP4 },
				evaluation(),
				evaluation(failure === 'invalid' ? '{}' : { ...CLEAN, gore: true }),
			);
			await expect(
				guard.request(
					{ ...GENERATION, method: 'GET', path: '/videos/job/content', body: undefined },
					() => {},
					controller.signal,
				),
			).rejects.toThrow(
				failure === 'aborted'
					? /Stopped/
					: failure === 'decode-error'
						? /decode all required frames/
						: failure === 'invalid'
							? /invalid category JSON/
							: /Video output blocked/,
			);
			expect(closed).toBe(true);
			expect(requests).toHaveLength(failure === 'aborted' || failure === 'decode-error' ? 2 : 3);
			expect(state.moderation.video.enabled).toBe(true);
		},
	);
	it.each(['empty', 'skipped'] as const)('rejects a %s frame sequence', async (kind) => {
		const { guard, frames, responses } = fixture();
		frames.mockImplementation(async function* () {
			if (kind === 'skipped') yield { timestamp: 1, image: `data:image/png;base64,${PNG}` };
		});
		responses.splice(0, responses.length, {
			status: 200,
			contentType: 'video/mp4',
			encoding: 'base64',
			body: MP4,
		});
		await expect(
			guard.request(
				{ ...GENERATION, method: 'GET', path: '/videos/job/content', body: undefined },
				() => {},
			),
		).rejects.toThrow(/decode all required frames/);
	});
	it('retains video output moderation when a job ID contains encoded path separators', async () => {
		const { guard, responses, requests } = fixture('high');
		responses.splice(
			0,
			responses.length,
			{ status: 200, contentType: 'video/mp4', encoding: 'base64', body: MP4 },
			evaluation({ ...CLEAN, gore: true }),
		);
		await expect(
			guard.request(
				{ ...GENERATION, method: 'GET', path: '/v1/videos/job%2Fclip/content', body: undefined },
				() => {},
			),
		).rejects.toThrow('Video output blocked');
		expect(requests).toHaveLength(2);
	});
});

describe('video reference input moderation', () => {
	const apis = ['responses', 'chat/completions', 'chat'] as const;
	const paths = ['/videos', '/v1/videos/previous/remix'] as const;
	it.each(
		apis.flatMap((api) =>
			paths.flatMap((path) =>
				(['multipart', 'json'] as const).map((carrier) => ({ api, path, carrier })),
			),
		),
	)(
		'jointly checks all $carrier references on $path with strict ten-flag $api input',
		async ({ api, path, carrier }) => {
			const { guard, requests, responses, state } = fixture();
			state.connections[0].chatApi = api;
			state.moderation.video.videoApi = api === 'responses' ? 'chat' : 'responses';
			const transport = api === 'responses' ? 'responses' : 'chat';
			responses.splice(
				0,
				responses.length,
				evaluation({ ...CLEAN_EDIT, input_contains_person: true }, transport),
				json({ id: 'job', status: 'queued' }),
				{ status: 200, contentType: 'video/mp4', encoding: 'base64', body: MP4 },
				evaluation(CLEAN, transport),
			);
			const prompt = 'Animate the scene, keeping the clothing fully opaque';
			const request: WireRequest =
				carrier === 'multipart'
					? {
							...VIDEO_REFERENCE,
							path,
							form: [
								...VIDEO_REFERENCE.form!,
								{
									name: 'input_reference',
									file: { name: 'scene.avif', type: 'image/avif', base64: AVIF },
								},
							],
						}
					: {
							...GENERATION,
							path,
							body: {
								model: 'generator',
								prompt,
								input_references: [
									`data:image/png;base64,${PNG}`,
									{ image_url: `data:image/avif;base64,${AVIF}` },
								],
							},
						};
			const original = structuredClone(request);
			await guard.request(request, () => {});
			expect(request).toEqual(original);
			expect(requests[1]).toBe(request);
			expect(requests[0].path).toBe(`/${api}`);
			const body = requests[0].body!;
			const format =
				api === 'responses' ? (body.text as any).format : (body.response_format as any).json_schema;
			expect(format).toMatchObject({ name: 'freelm_image_edit_moderation', strict: true });
			expect(format.schema.required).toEqual(Object.keys(CLEAN_EDIT));
			expect(format.schema.additionalProperties).toBe(false);
			const input = (api === 'responses' ? body.input : body.messages) as any[];
			expect(api === 'responses' ? input[0].content[0].text : input[0].content).toBe(
				VIDEO_REFERENCE_MODERATION_RUBRIC,
			);
			expect(input[1].content).toHaveLength(3);
			expect(input[1].content[0].text).toContain(prompt);
			expect(input[1].content[0].text).toContain('all 2 supplied reference images');
			expect(input[1].content[0].text).toContain('at any point in its requested timeline');
			expect(input[1].content.slice(1)).toEqual(
				[`data:image/png;base64,${PNG}`, `data:image/avif;base64,${AVIF}`].map((url) =>
					api === 'responses'
						? { type: 'input_image', image_url: url }
						: { type: 'image_url', image_url: { url } },
				),
			);
			const result = await guard.request(
				{ ...GENERATION, method: 'GET', path: '/videos/job/content', body: undefined },
				() => {},
			);
			expect(result.body).toBe(MP4);
			expectOutputSchema(requests[3], api);
			expect(JSON.stringify(requests[3].body)).not.toContain(prompt);
			expect(JSON.stringify(requests[3].body)).not.toContain(AVIF);
			expect(JSON.stringify(requests[3].body)).not.toContain('input_contains_person');
		},
	);
	it.each(['low', 'medium', 'high'] as const)(
		'blocks contextual video nudity, sexual edits, NCII and harm involving minors at %s before dispatch',
		async (level) => {
			for (const category of [
				'edit_nudity',
				'edit_sexual_content',
				'ncii',
				'sexual_minors',
				'violent_minors',
			] as const) {
				for (const path of paths) {
					const { guard, requests, responses } = fixture(level);
					responses[0] = evaluation({
						...CLEAN_EDIT,
						input_contains_person: true,
						[category]: true,
					});
					await expect(
						guard.request(
							{
								...VIDEO_REFERENCE,
								path,
								form: [
									{
										name: 'prompt',
										value: 'After a few seconds, the top has been completely removed',
									},
									VIDEO_REFERENCE.form![1],
								],
							},
							() => {},
						),
					).rejects.toThrow(`Video edit blocked by ${level}`);
					expect(requests).toHaveLength(1);
					expect(requests[0].path).toBe('/responses');
				}
			}
		},
	);
	it.each(['low', 'medium', 'high'] as const)(
		'uses the video evaluator and %s policy independently of image settings',
		async (level) => {
			const { guard, requests, responses, state, connection } = fixture(level);
			state.connections.push({
				...connection,
				id: 'video-judge',
				baseUrl: 'https://video-judge.example/v1',
				apiKey: 'video-secret',
			});
			state.moderation.video.connectionId = 'video-judge';
			state.moderation.image = {
				...state.moderation.image,
				enabled: false,
				level: level === 'high' ? 'low' : 'high',
				model: '',
			};
			responses.splice(
				0,
				responses.length,
				evaluation({ ...CLEAN_EDIT, gore: true }),
				json({ id: 'job', status: 'queued' }),
			);
			const result = guard.request(VIDEO_REFERENCE, () => {});
			if (level === 'high') await expect(result).rejects.toThrow('Video edit blocked by high');
			else await expect(result).resolves.toMatchObject({ status: 200 });
			expect(requests).toHaveLength(level === 'high' ? 1 : 2);
			expect(requests[0]).toMatchObject({
				connectionId: 'video-judge',
				baseUrl: 'https://video-judge.example/v1',
				apiKey: 'video-secret',
			});
		},
	);
	it('blocks retaining nudity from a reference even for an otherwise harmless animation at Low', async () => {
		const { guard, requests, responses } = fixture('low');
		responses[0] = evaluation({
			...CLEAN_EDIT,
			input_contains_person: true,
			nudity: true,
			artistic_nudity: true,
			edit_nudity: true,
		});
		await expect(guard.request(VIDEO_REFERENCE, () => {})).rejects.toThrow(
			'Video edit blocked by low',
		);
		expect(requests).toHaveLength(1);
	});
	it.each([
		JSON.stringify(CLEAN),
		JSON.stringify({ ...CLEAN_EDIT, edit_nudity: 'false' }),
		JSON.stringify({ ...CLEAN_EDIT, extra: false }),
		JSON.stringify(CLEAN_EDIT).replace(
			'"edit_nudity":false',
			'"edit_nudity":true,"edit_nudity":false',
		),
		'not JSON',
	])('never dispatches after malformed contextual category JSON: %s', async (labels) => {
		const { guard, requests, responses } = fixture();
		responses[0] = evaluation(labels);
		await expect(guard.request(VIDEO_REFERENCE, () => {})).rejects.toThrow('invalid category JSON');
		expect(requests).toHaveLength(1);
	});
	it.each([
		{
			...VIDEO_REFERENCE,
			form: [
				...VIDEO_REFERENCE.form!,
				{
					name: 'input_reference',
					file: { name: 'bad.png', type: 'image/png', base64: 'invalid' },
				},
			],
		},
		{
			...GENERATION,
			path: '/videos',
			body: { prompt: 'Animate this', input_reference: 'https://cdn.example/mutable.png' },
		},
		{ ...GENERATION, path: '/videos', body: { prompt: 'Animate this', input_references: [] } },
		{ ...GENERATION, path: '/videos', body: { prompt: 'Animate this', input_reference: null } },
		{
			...GENERATION,
			path: '/videos/previous/remix',
			body: {
				prompt: 'Animate this',
				input_reference: { url: `data:image/png;base64,${PNG}`, base64: PNG },
			},
		},
		{
			...VIDEO_REFERENCE,
			form: [
				...VIDEO_REFERENCE.form!,
				{ name: 'input_reference', file: { name: 'clip.mp4', type: 'video/mp4', base64: MP4 } },
			],
		},
	])('requires every reference to be readable before contacting either model', async (request) => {
		const { guard, requests, download } = fixture();
		await expect(guard.request(request, () => {})).rejects.toThrow(
			'Video edit input moderation could not inspect all reference images',
		);
		expect(requests).toHaveLength(0);
		expect(download).not.toHaveBeenCalled();
	});
	it.each(apis.flatMap((api) => paths.map((path) => ({ api, path }))))(
		'keeps text-only $path input on the standard seven-flag $api classifier',
		async ({ api, path }) => {
			const { guard, requests, responses, state } = fixture();
			state.connections[0].chatApi = api;
			responses.splice(
				0,
				responses.length,
				evaluation(CLEAN, api === 'responses' ? 'responses' : 'chat'),
				json({ id: 'job', status: 'queued' }),
			);
			await guard.request({ ...GENERATION, path }, () => {});
			expectOutputSchema(requests[0], api);
			expect(JSON.stringify(requests[0].body)).not.toContain('input_contains_person');
			expect(requests).toHaveLength(2);
		},
	);
	it.each(['disabled', 'unconfigured'] as const)(
		'preserves %s video moderation behavior',
		async (configuration) => {
			const { guard, requests, responses, state } = fixture();
			if (configuration === 'disabled') state.moderation.video.enabled = false;
			else state.moderation.video.model = '';
			responses.splice(0, responses.length, json({ id: 'job', status: 'queued' }));
			const result = await guard.request(VIDEO_REFERENCE, () => {});
			expect(requests).toEqual([VIDEO_REFERENCE]);
			expect(result.moderationWarnings?.length).toBe(
				configuration === 'unconfigured' ? 1 : undefined,
			);
		},
	);
});
