import * as videoFrames from '../src/lib/moderation-video-frames';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	apiRequest,
	createVideo,
	downloadVideo,
	generateImages,
	setBrowserMediaModerationContext,
} from '../src/lib/api';
import { downloadBrowserModerationAsset } from '../src/lib/browser-media-moderation';
import { defaultModerationSettings } from '../src/lib/moderation';
import type { Connection, DesktopBridge, ModelDefinition, WireRequest } from '../src/types';
import type {
	ImageEditModerationLabels,
	ModerationLabels,
	ModerationLevel,
} from '../src/moderation-types';

const PNG =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const VIDEO = btoa('\0\0\0\x18ftypisom\0\0\0\0isommp42whole video bytes');
const clean: ModerationLabels = {
	ncii: false,
	sexual_minors: false,
	violent_minors: false,
	sexual_content: false,
	artistic_nudity: false,
	nudity: false,
	gore: false,
};
const outputSchema = {
	type: 'object',
	properties: Object.fromEntries(Object.keys(clean).map((key) => [key, { type: 'boolean' }])),
	required: Object.keys(clean),
	additionalProperties: false,
};
const cleanEdit: ImageEditModerationLabels = {
	...clean,
	input_contains_person: true,
	edit_sexual_content: false,
	edit_nudity: false,
};
const imageEditSchema = {
	type: 'object',
	properties: Object.fromEntries(Object.keys(cleanEdit).map((key) => [key, { type: 'boolean' }])),
	required: Object.keys(cleanEdit),
	additionalProperties: false,
};
function expectOutputSchema(body: Record<string, unknown>, api: Connection['chatApi']) {
	const format = { name: 'freelm_moderation', strict: true, schema: outputSchema };
	if (api === 'responses') {
		expect(body.text).toEqual({ format: { type: 'json_schema', ...format } });
		expect(body).not.toHaveProperty('response_format');
	} else {
		expect(body.response_format).toEqual({ type: 'json_schema', json_schema: format });
		expect(body).not.toHaveProperty('text');
	}
}
function expectImageEditSchema(body: Record<string, unknown>, api: Connection['chatApi']) {
	const format = { name: 'freelm_image_edit_moderation', strict: true, schema: imageEditSchema };
	if (api === 'responses') {
		expect(body.text).toEqual({ format: { type: 'json_schema', ...format } });
		expect(body).not.toHaveProperty('response_format');
	} else {
		expect(body.response_format).toEqual({ type: 'json_schema', json_schema: format });
		expect(body).not.toHaveProperty('text');
	}
}
const definition = (
	id: string,
	tasks: ModelDefinition['tasks'],
	input: ModelDefinition['inputModalities'],
): ModelDefinition => ({
	id,
	name: id,
	enabled: true,
	tasks,
	inputModalities: input,
	outputModalities: tasks.includes('chat')
		? ['text']
		: tasks.includes('images')
			? ['image']
			: ['video'],
	thinkingModes: tasks.includes('chat')
		? [
				{
					id: 'low',
					name: 'Low',
					parameters: {
						responses: { reasoning: { effort: 'low' } },
						chat: { reasoning_effort: 'low' },
					},
				},
			]
		: [],
});
const connection: Connection = {
	id: 'test-api',
	name: 'Test API',
	baseUrl: 'https://provider.test/v1',
	apiKey: 'private-api-key',
	chatApi: 'responses',
	models: { chat: 'evaluate', images: 'image', videos: 'video', speech: '', transcription: '' },
	discoveredModels: [],
	catalog: [
		definition('evaluate', ['chat'], ['text', 'image', 'video']),
		definition('image', ['images'], ['text', 'image']),
		definition('video', ['videos'], ['text', 'image']),
	],
};
function settings(level: ModerationLevel = 'low', enabled = true) {
	const moderation = defaultModerationSettings();
	moderation.image = {
		enabled,
		level,
		connectionId: connection.id,
		model: 'evaluate',
		thinkingMode: 'low',
	};
	moderation.video = {
		enabled,
		level,
		connectionId: connection.id,
		model: 'evaluate',
		thinkingMode: 'low',
		videoApi: 'chat/completions',
	};
	return moderation;
}
function fixture(level: ModerationLevel = 'low', enabled = true) {
	vi.spyOn(videoFrames, 'extractBrowserModerationVideoFrames').mockImplementation(
		async function* () {
			yield { timestamp: 0, image: `data:image/png;base64,${PNG}` };
		},
	);
	vi.stubGlobal('window', {});
	const context = {
		connections: [structuredClone(connection)],
		moderation: settings(level, enabled),
	};
	setBrowserMediaModerationContext(() => context);
	return context;
}
const json = (value: unknown) =>
	new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const evaluation = (labels: unknown) =>
	json({
		status: 'completed',
		output: [
			{
				type: 'message',
				role: 'assistant',
				content: [
					{
						type: 'output_text',
						text: typeof labels === 'string' ? labels : JSON.stringify(labels),
					},
				],
			},
		],
	});
const chatEvaluation = (labels: unknown) =>
	json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(labels) } }] });
afterEach(() => {
	setBrowserMediaModerationContext();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('browser preview media moderation', () => {
	it.each(['input', 'output'] as const)(
		'propagates sanitized provider diagnostics from %s evaluation through generateImages',
		async (stage) => {
			fixture();
			let classifierCalls = 0;
			const fetch = vi.fn(async (url: string) => {
				if (url.endsWith('/images/generations')) return json({ data: [{ b64_json: PNG }] });
				if (++classifierCalls === 1 && stage === 'output') return evaluation(clean);
				return new Response(
					JSON.stringify({
						error: {
							code: 'image_size_limit',
							message: `Image too large. private-api-key data:image/png;base64,${PNG} A fox`,
						},
					}),
					{ status: 413, headers: { 'content-type': 'application/json' } },
				);
			});
			vi.stubGlobal('fetch', fetch);
			const pending = generateImages(connection, { model: 'image', prompt: 'A fox' });
			await expect(pending).rejects.toThrow(
				`Image ${stage} moderation could not complete. Evaluator HTTP 413: code=image_size_limit`,
			);
			try {
				await pending;
			} catch (error) {
				for (const sensitive of ['private-api-key', PNG, 'A fox'])
					expect(String(error)).not.toContain(sensitive);
			}
			expect(fetch).toHaveBeenCalledTimes(stage === 'input' ? 1 : 3);
		},
	);
	it('propagates output token exhaustion without exposing streamed reasoning or releasing images', async () => {
		fixture();
		let classifierCalls = 0;
		const fetch = vi.fn(async (url: string) => {
			if (url.endsWith('/images/generations')) return json({ data: [{ b64_json: PNG }] });
			if (++classifierCalls === 1) return evaluation(clean);
			return json({
				status: 'incomplete',
				incomplete_details: { reason: 'max_output_tokens' },
				usage: {
					input_tokens: 900,
					output_tokens: 8192,
					output_tokens_details: { reasoning_tokens: 8192 },
				},
				output: [{ type: 'reasoning', summary: [{ text: 'PRIVATE_REASONING' }] }],
			});
		});
		vi.stubGlobal('fetch', fetch);
		const pending = generateImages(connection, { model: 'image', prompt: 'A fox' });
		await expect(pending).rejects.toThrow(
			'Responses status=incomplete; incomplete reason=max_output_tokens',
		);
		try {
			await pending;
		} catch (error) {
			expect(String(error)).toContain(
				'input_tokens=900, output_tokens=8192, reasoning_tokens=8192',
			);
			expect(String(error)).not.toContain('PRIVATE_REASONING');
		}
		expect(fetch).toHaveBeenCalledTimes(3);
	});
	it.each(['responses', 'chat', 'chat/completions'] as const)(
		'sends strict image output schema at both classifier stages over %s',
		async (api) => {
			const context = fixture();
			context.connections[0].chatApi = api;
			const classifierBodies: Record<string, unknown>[] = [];
			vi.stubGlobal(
				'fetch',
				vi.fn(async (url: string, options?: RequestInit) => {
					if (url.endsWith('/images/generations')) return json({ data: [{ b64_json: PNG }] });
					expect(url).toBe(`https://provider.test/v1/${api}`);
					const body = JSON.parse(options!.body as string);
					classifierBodies.push(body);
					expectOutputSchema(body, api);
					return api === 'responses' ? evaluation(clean) : chatEvaluation(clean);
				}),
			);
			await generateImages(connection, { model: 'image', prompt: 'A fox' });
			expect(classifierBodies).toHaveLength(2);
			expect(JSON.stringify(classifierBodies[0])).not.toContain(PNG);
			expect(JSON.stringify(classifierBodies[1])).toContain(PNG);
		},
	);
	it.each(
		(['responses', 'chat', 'chat/completions'] as const).flatMap((api) =>
			(['input', 'output'] as const).map((stage) => [api, stage] as const),
		),
	)(
		'fails closed in browser preview when %s rejects strict schema output at the %s stage',
		async (api, stage) => {
			const context = fixture();
			context.connections[0].chatApi = api;
			let classifierCalls = 0;
			const fetch = vi.fn(async (url: string, options?: RequestInit) => {
				if (url.endsWith('/images/generations')) return json({ data: [{ b64_json: PNG }] });
				expectOutputSchema(JSON.parse(options!.body as string), api);
				if (++classifierCalls === 1 && stage === 'output')
					return api === 'responses' ? evaluation(clean) : chatEvaluation(clean);
				return new Response(JSON.stringify({ error: { message: 'Schema unsupported' } }), {
					status: 400,
					headers: { 'content-type': 'application/json' },
				});
			});
			vi.stubGlobal('fetch', fetch);
			await expect(generateImages(connection, { model: 'image', prompt: 'A fox' })).rejects.toThrow(
				/moderation could not complete/i,
			);
			expect(fetch).toHaveBeenCalledTimes(stage === 'input' ? 1 : 3);
		},
	);
	it('continues with a warning for registered App context missing default evaluator config', async () => {
		vi.stubGlobal('window', {});
		setBrowserMediaModerationContext(() => ({ connections: [connection] }));
		const payload = { data: [{ b64_json: PNG }] };
		const fetch = vi.fn(async () => json(payload));
		vi.stubGlobal('fetch', fetch);
		const response = await apiRequest(connection, {
			method: 'POST',
			path: '/images/generations',
			body: { model: 'image', prompt: 'A fox' },
		});
		expect(JSON.parse(response.body)).toEqual(payload);
		expect(response.moderationWarnings).toHaveLength(1);
		expect(response.moderationWarnings![0]).toMatch(/without image moderation/i);
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it('rejects malformed policy but continues with a warning for incompatible evaluator modalities', async () => {
		const context = fixture();
		const fetch = vi.fn(async () => json({ data: [{ b64_json: PNG }] }));
		vi.stubGlobal('fetch', fetch);
		context.moderation!.image.level = 'invalid' as ModerationLevel;
		await expect(generateImages(connection, { model: 'image', prompt: 'A fox' })).rejects.toThrow(
			/settings are invalid/i,
		);
		expect(fetch).not.toHaveBeenCalled();
		context.moderation = settings();
		context.connections[0].catalog![0].inputModalities = ['text'];
		const response = await apiRequest(connection, {
			method: 'POST',
			path: '/images/generations',
			body: { model: 'image', prompt: 'A fox' },
		});
		expect(response.moderationWarnings).toHaveLength(1);
		expect(response.moderationWarnings![0]).toMatch(/without image moderation/i);
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it('bypasses all evaluation when moderation is disabled', async () => {
		fixture('high', false);
		const fetch = vi.fn(async (_url: string, _options?: RequestInit) =>
			json({ data: [{ b64_json: PNG }] }),
		);
		vi.stubGlobal('fetch', fetch);
		const assets = await generateImages(connection, {
			model: 'image',
			prompt: 'Original unmodified prompt',
		});
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(assets[0].url).toBe(`data:image/png;base64,${PNG}`);
		expect(JSON.parse(fetch.mock.calls[0][1]!.body as string).prompt).toBe(
			'Original unmodified prompt',
		);
	});
	it('checks configured images while unconfigured video continues with its own warning', async () => {
		const context = fixture();
		context.moderation!.video = defaultModerationSettings().video;
		const evaluations: Record<string, unknown>[] = [];
		const fetch = vi.fn(async (url: string, options?: RequestInit) => {
			if (url.endsWith('/responses')) {
				const body = JSON.parse(options!.body as string);
				evaluations.push(body);
				expectOutputSchema(body, 'responses');
				return evaluation(clean);
			}
			if (url.endsWith('/images/generations')) return json({ data: [{ b64_json: PNG }] });
			if (url.endsWith('/videos')) return json({ id: 'job', status: 'queued' });
			throw new Error(`Unexpected URL ${url}`);
		});
		vi.stubGlobal('fetch', fetch);
		const image = await apiRequest(connection, {
			method: 'POST',
			path: '/images/generations',
			body: { model: 'image', prompt: 'A fox' },
		});
		expect(image.moderationWarnings).toBeUndefined();
		const video = await apiRequest(connection, {
			method: 'POST',
			path: '/videos',
			body: { model: 'video', prompt: 'A quiet scene' },
		});
		expect(video.moderationWarnings).toHaveLength(1);
		expect(video.moderationWarnings![0]).toMatch(/without video moderation/i);
		expect(JSON.parse(video.body)).toEqual({ id: 'job', status: 'queued' });
		expect(evaluations).toHaveLength(2);
		expect(fetch).toHaveBeenCalledTimes(4);
	});
	it.each([
		['image', 'video'],
		['video', 'image'],
	] as const)('disabling %s leaves %s moderation enabled', async (disabled, enabled) => {
		const context = fixture('high');
		context.moderation![disabled].enabled = false;
		let evaluations = 0;
		const fetch = vi.fn(async (url: string) => {
			if (url.endsWith('/responses')) {
				evaluations++;
				return evaluation({ ...clean, gore: true });
			}
			if (url.endsWith('/chat/completions')) {
				evaluations++;
				return chatEvaluation({ ...clean, gore: true });
			}
			return url.endsWith('/videos')
				? json({ id: 'job', status: 'queued' })
				: json({ data: [{ b64_json: PNG }] });
		});
		vi.stubGlobal('fetch', fetch);
		const send = (kind: 'image' | 'video') =>
			apiRequest(connection, {
				method: 'POST',
				path: kind === 'image' ? '/images/generations' : '/videos',
				body: { model: kind, prompt: 'A benign fixture' },
			});
		const bypassed = await send(disabled);
		expect(bypassed.moderationWarnings).toBeUndefined();
		expect(evaluations).toBe(0);
		await expect(send(enabled)).rejects.toThrow(/blocked.*gore/i);
		expect(evaluations).toBe(1);
		expect(fetch).toHaveBeenCalledTimes(2);
	});
	it.each([
		['high', 'low'],
		['low', 'high'],
	] as const)(
		'applies independent image=%s and video=%s levels to input and generated media',
		async (imageLevel, videoLevel) => {
			const context = fixture();
			context.moderation!.image.level = imageLevel;
			context.moderation!.video.level = videoLevel;
			context.connections.push({
				...structuredClone(context.connections[0]),
				id: 'video-judge',
				chatApi: 'chat/completions',
			});
			context.moderation!.video.connectionId = 'video-judge';
			const counts = { image: 0, video: 0 };
			vi.stubGlobal(
				'fetch',
				vi.fn(async (url: string, options?: RequestInit) => {
					if (url.endsWith('/responses')) {
						counts.image++;
						expectOutputSchema(JSON.parse(options!.body as string), 'responses');
						return evaluation({ ...clean, gore: true });
					}
					if (url.endsWith('/chat/completions')) {
						counts.video++;
						expectOutputSchema(JSON.parse(options!.body as string), 'chat/completions');
						return chatEvaluation({ ...clean, gore: true });
					}
					if (url.endsWith('/images/generations')) return json({ data: [{ b64_json: PNG }] });
					if (url.endsWith('/videos')) return json({ id: 'job', status: 'queued' });
					if (url.endsWith('/videos/job/content'))
						return new Response(
							Uint8Array.from(atob(VIDEO), (char) => char.charCodeAt(0)),
							{ headers: { 'content-type': 'video/mp4' } },
						);
					throw new Error(`Unexpected URL ${url}`);
				}),
			);
			const image = generateImages(connection, { model: 'image', prompt: 'A square' });
			if (imageLevel === 'high') await expect(image).rejects.toThrow(/blocked.*gore/i);
			else expect((await image)[0].url).toBe(`data:image/png;base64,${PNG}`);
			const video = createVideo(connection, { model: 'video', prompt: 'A quiet scene' });
			if (videoLevel === 'high') await expect(video).rejects.toThrow(/blocked.*gore/i);
			else {
				await video;
				expect((await downloadVideo(connection, 'job')).url).toBe(`data:video/mp4;base64,${VIDEO}`);
			}
			expect(counts).toEqual({
				image: imageLevel === 'high' ? 1 : 2,
				video: videoLevel === 'high' ? 1 : 2,
			});
		},
	);
	it.each([
		['low', { ncii: true }, true],
		['low', { sexual_minors: true }, true],
		['low', { violent_minors: true }, true],
		['low', { sexual_content: true, nudity: true, gore: true }, false],
		['medium', { sexual_content: true }, true],
		['medium', { nudity: true, artistic_nudity: true }, false],
		['medium', { nudity: true }, true],
		['high', { artistic_nudity: true, nudity: true }, true],
		['high', { gore: true }, true],
	] as [ModerationLevel, Partial<ModerationLabels>, boolean][])(
		'applies local %s policy without sending the level to the evaluator',
		async (level, labels, denied) => {
			fixture(level);
			const bodies: Record<string, unknown>[] = [];
			let calls = 0;
			const fetch = vi.fn(async (_url: string, options: RequestInit) => {
				const body = JSON.parse(options.body as string);
				bodies.push(body);
				calls++;
				return calls === 1 || calls === 3
					? evaluation({ ...clean, ...labels })
					: json({ data: [{ b64_json: PNG }] });
			});
			vi.stubGlobal('fetch', fetch);
			const pending = generateImages(connection, { model: 'image', prompt: 'Original prompt' });
			if (denied) {
				await expect(pending).rejects.toThrow(/moderation|blocked/i);
				expect(fetch).toHaveBeenCalledTimes(1);
			} else {
				const assets = await pending;
				expect(fetch).toHaveBeenCalledTimes(3);
				expect(assets[0].url).toBe(`data:image/png;base64,${PNG}`);
				expect(bodies[1]).toMatchObject({ model: 'image', prompt: 'Original prompt' });
			}
			const evaluator = bodies[0];
			expect(evaluator).not.toHaveProperty('level');
			expect(evaluator).not.toHaveProperty('moderation_level');
			expect(JSON.stringify(evaluator)).not.toContain(`"level":"${level}"`);
		},
	);
	it('checks image output even when the prompt passes and never returns blocked assets', async () => {
		fixture('high');
		let calls = 0;
		const fetch = vi.fn(async () =>
			++calls === 1
				? evaluation(clean)
				: calls === 2
					? json({ data: [{ b64_json: PNG }] })
					: evaluation({ ...clean, gore: true }),
		);
		vi.stubGlobal('fetch', fetch);
		await expect(
			generateImages(connection, { model: 'image', prompt: 'Safe prompt' }),
		).rejects.toThrow(/moderation|blocked/i);
		expect(fetch).toHaveBeenCalledTimes(3);
	});
	it.each([
		'not JSON',
		'{}',
		JSON.stringify({ ...clean, gore: 'false' }),
		JSON.stringify({ ...clean, extra: false }),
	])('fails closed on malformed evaluator reply %s', async (reply) => {
		fixture();
		const fetch = vi.fn(async () => evaluation(reply));
		vi.stubGlobal('fetch', fetch);
		await expect(generateImages(connection, { model: 'image', prompt: 'A fox' })).rejects.toThrow(
			/moderation|JSON|category|boolean/i,
		);
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it.each(['responses', 'chat', 'chat/completions'] as const)(
		'jointly inspects every edit reference over %s while preserving multipart bytes and isolated output checks',
		async (api) => {
			const context = fixture('low');
			context.connections[0].chatApi = api;
			const classifierBodies: Record<string, any>[] = [];
			let generatorBody: FormData | undefined;
			const prompt = 'Keep the clothed subjects unchanged and replace the background.';
			const fetch = vi.fn(async (url: string, options: RequestInit) => {
				if (url.endsWith('/images/edits')) {
					generatorBody = options.body as FormData;
					return json({ data: [{ b64_json: PNG }] });
				}
				expect(url).toBe(`https://provider.test/v1/${api}`);
				const body = JSON.parse(options.body as string);
				classifierBodies.push(body);
				const input = classifierBodies.length === 1;
				if (input) expectImageEditSchema(body, api);
				else expectOutputSchema(body, api);
				return api === 'responses'
					? evaluation(input ? cleanEdit : clean)
					: chatEvaluation(input ? cleanEdit : clean);
			});
			vi.stubGlobal('fetch', fetch);
			const assets = await generateImages(connection, {
				model: 'image',
				prompt,
				images: [
					{ name: 'person-a.png', type: 'image/png', dataUrl: `data:image/png;base64,${PNG}` },
					{ name: 'person-b.png', type: 'image/png', dataUrl: `data:image/png;base64,${PNG}` },
				],
				mask: { name: 'mask.png', type: 'image/png', dataUrl: `data:image/png;base64,${PNG}` },
			});
			expect(fetch).toHaveBeenCalledTimes(3);
			expect(assets[0].url).toBe(`data:image/png;base64,${PNG}`);
			expect(generatorBody?.get('prompt')).toBe(prompt);
			const files = generatorBody!.getAll('image[]') as File[];
			expect(files.map((file) => file.name)).toEqual(['person-a.png', 'person-b.png']);
			for (const file of [...files, generatorBody!.get('mask') as File])
				expect(Buffer.from(await file.arrayBuffer()).toString('base64')).toBe(PNG);
			const messages = (body: Record<string, any>) =>
				api === 'responses' ? body.input : body.messages;
			const parts = (body: Record<string, any>) =>
				messages(body).find((message: { role: string }) => message.role === 'user').content;
			const imageType = api === 'responses' ? 'input_image' : 'image_url';
			expect(
				parts(classifierBodies[0]).filter((part: { type: string }) => part.type === imageType),
			).toHaveLength(2);
			expect(
				parts(classifierBodies[1]).filter((part: { type: string }) => part.type === imageType),
			).toHaveLength(1);
			expect(JSON.stringify(classifierBodies[0])).toContain(prompt);
			expect(JSON.stringify(classifierBodies[1])).not.toContain(prompt);
			expect(JSON.stringify(classifierBodies[1])).not.toContain('input_contains_person');
		},
	);
	it.each(['edit_nudity', 'edit_sexual_content'] as const)(
		'blocks a contextual %s finding at Low before sending an image-edit request',
		async (flag) => {
			fixture('low');
			const fetch = vi.fn(async (url: string, options: RequestInit) => {
				expect(url).toBe('https://provider.test/v1/responses');
				const body = JSON.parse(options.body as string);
				expectImageEditSchema(body, 'responses');
				expect(JSON.stringify(body)).toContain(PNG);
				return evaluation({ ...cleanEdit, [flag]: true });
			});
			vi.stubGlobal('fetch', fetch);
			await expect(
				generateImages(connection, {
					model: 'image',
					prompt: 'The top has been completely removed.',
					images: [
						{ name: 'person.png', type: 'image/png', dataUrl: `data:image/png;base64,${PNG}` },
					],
				}),
			).rejects.toThrow('Image edit blocked by low moderation');
			expect(fetch).toHaveBeenCalledTimes(1);
		},
	);
	it('fails closed when an edit evaluator returns the seven-field text-only schema instead of contextual flags', async () => {
		fixture('low');
		const fetch = vi.fn(async () => evaluation(clean));
		vi.stubGlobal('fetch', fetch);
		await expect(
			generateImages(connection, {
				model: 'image',
				prompt: 'Change the background.',
				images: [
					{ name: 'person.png', type: 'image/png', dataUrl: `data:image/png;base64,${PNG}` },
				],
			}),
		).rejects.toThrow('invalid category JSON');
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it('blocks nude edited output at Low even when the contextual input check approves a harmless edit', async () => {
		fixture('low');
		let evaluations = 0;
		const fetch = vi.fn(async (url: string, options: RequestInit) => {
			if (url.endsWith('/images/edits')) return json({ data: [{ b64_json: PNG }] });
			const body = JSON.parse(options.body as string);
			if (++evaluations === 1) {
				expectImageEditSchema(body, 'responses');
				return evaluation(cleanEdit);
			}
			expectOutputSchema(body, 'responses');
			return evaluation({ ...clean, nudity: true, artistic_nudity: true });
		});
		vi.stubGlobal('fetch', fetch);
		await expect(
			generateImages(connection, {
				model: 'image',
				prompt: 'Change only the garden background.',
				images: [
					{ name: 'person.png', type: 'image/png', dataUrl: `data:image/png;base64,${PNG}` },
				],
			}),
		).rejects.toThrow('Image output blocked by low moderation: nudity');
		expect(fetch).toHaveBeenCalledTimes(3);
	});
	it('downloads image URLs without API credentials before output evaluation', async () => {
		fixture();
		const fetch = vi.fn(async (url: string, options?: RequestInit) => {
			if (url === 'https://cdn.test/generated.png')
				return new Response(
					Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0)),
					{ headers: { 'content-type': 'image/png' } },
				);
			if (url.endsWith('/images/generations'))
				return json({ data: [{ url: 'https://cdn.test/generated.png' }] });
			return evaluation(clean);
		});
		vi.stubGlobal('fetch', fetch);
		const assets = await generateImages(connection, { model: 'image', prompt: 'A fox' });
		expect(assets[0].url).toBe(`data:image/png;base64,${PNG}`);
		const assetCall = fetch.mock.calls.find(([url]) => url === 'https://cdn.test/generated.png')!;
		expect(assetCall[1]).toMatchObject({ credentials: 'omit', redirect: 'error' });
		expect(assetCall[1]?.headers).toBeUndefined();
		expect(fetch).toHaveBeenCalledTimes(4);
	});
	it.each(['responses', 'chat', 'chat/completions'] as const)(
		'jointly classifies video prompts and references over %s before preserving the allowed multipart upload',
		async (api) => {
			const context = fixture('low');
			context.connections[0].chatApi = api;
			const prompt = 'Keep the person clothed while the camera moves around the garden.';
			const classifierBodies: Record<string, any>[] = [];
			let generatorBody: FormData | undefined;
			const fetch = vi.fn(async (url: string, options: RequestInit) => {
				if (url.endsWith('/videos')) {
					generatorBody = options.body as FormData;
					return json({ id: 'reference-job', status: 'queued' });
				}
				expect(url).toBe(`https://provider.test/v1/${api}`);
				const body = JSON.parse(options.body as string);
				classifierBodies.push(body);
				expectImageEditSchema(body, api);
				return api === 'responses' ? evaluation(cleanEdit) : chatEvaluation(cleanEdit);
			});
			vi.stubGlobal('fetch', fetch);
			const response = await apiRequest(connection, {
				method: 'POST',
				path: '/videos',
				form: [
					{ name: 'model', value: 'video' },
					{ name: 'prompt', value: prompt },
					{ name: 'size', value: '1280x736' },
					{ name: 'seconds', value: '10' },
					{
						name: 'input_reference',
						file: { name: 'person.png', type: 'image/png', base64: PNG },
					},
				],
			});
			expect(JSON.parse(response.body)).toEqual({ id: 'reference-job', status: 'queued' });
			expect(response.moderationWarnings).toBeUndefined();
			expect(fetch).toHaveBeenCalledTimes(2);
			expect(fetch.mock.calls.map(([url]) => url)).toEqual([
				`https://provider.test/v1/${api}`,
				'https://provider.test/v1/videos',
			]);
			expect(classifierBodies).toHaveLength(1);
			const messages =
				api === 'responses' ? classifierBodies[0].input : classifierBodies[0].messages;
			const parts = messages.find((message: { role: string }) => message.role === 'user').content;
			expect(JSON.stringify(parts)).toContain(prompt);
			expect(
				parts.filter(
					(part: { type: string }) =>
						part.type === (api === 'responses' ? 'input_image' : 'image_url'),
				),
			).toEqual([
				api === 'responses'
					? { type: 'input_image', image_url: `data:image/png;base64,${PNG}` }
					: { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
			]);
			expect(generatorBody?.get('prompt')).toBe(prompt);
			expect(generatorBody?.get('model')).toBe('video');
			expect(generatorBody?.get('size')).toBe('1280x736');
			expect(generatorBody?.get('seconds')).toBe('10');
			const references = generatorBody!.getAll('input_reference') as File[];
			expect(references).toHaveLength(1);
			expect(references[0].name).toBe('person.png');
			expect(references[0].type).toBe('image/png');
			expect(Buffer.from(await references[0].arrayBuffer()).toString('base64')).toBe(PNG);
		},
	);
	it.each(['responses', 'chat', 'chat/completions'] as const)(
		'blocks contextual video edit nudity at Low over %s before dispatching POST /videos',
		async (api) => {
			const context = fixture('low');
			context.connections[0].chatApi = api;
			const prompt = 'The top has been completely removed.';
			const fetch = vi.fn(async (url: string, options: RequestInit) => {
				expect(url).toBe(`https://provider.test/v1/${api}`);
				const body = JSON.parse(options.body as string);
				expectImageEditSchema(body, api);
				expect(JSON.stringify(body)).toContain(prompt);
				expect(JSON.stringify(body)).toContain(`data:image/png;base64,${PNG}`);
				const labels = { ...cleanEdit, edit_nudity: true };
				return api === 'responses' ? evaluation(labels) : chatEvaluation(labels);
			});
			vi.stubGlobal('fetch', fetch);
			await expect(
				apiRequest(connection, {
					method: 'POST',
					path: '/videos',
					form: [
						{ name: 'model', value: 'video' },
						{ name: 'prompt', value: prompt },
						{
							name: 'input_reference',
							file: { name: 'person.png', type: 'image/png', base64: PNG },
						},
					],
				}),
			).rejects.toThrow('Video edit blocked by low moderation');
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(fetch.mock.calls.map(([url]) => url)).toEqual([`https://provider.test/v1/${api}`]);
		},
	);
	it('rejects a video-reference evaluation missing contextual flags before generation', async () => {
		fixture('low');
		const fetch = vi.fn(async (url: string) => {
			expect(url).toBe('https://provider.test/v1/responses');
			return evaluation(clean);
		});
		vi.stubGlobal('fetch', fetch);
		await expect(
			apiRequest(connection, {
				method: 'POST',
				path: '/videos',
				form: [
					{ name: 'model', value: 'video' },
					{ name: 'prompt', value: 'Animate the garden.' },
					{
						name: 'input_reference',
						file: { name: 'person.png', type: 'image/png', base64: PNG },
					},
				],
			}),
		).rejects.toThrow('invalid category JSON');
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it.each(['responses', 'chat', 'chat/completions'] as const)(
		'uses extracted image frames and strict schemas for both video classifier stages over %s',
		async (api) => {
			const context = fixture();
			context.connections[0].chatApi = api;
			context.moderation!.video.videoApi = api === 'responses' ? 'chat' : 'responses';
			const evaluations: Record<string, unknown>[] = [];
			const fetch = vi.fn(async (url: string, options?: RequestInit) => {
				if (url === `https://provider.test/v1/${api}`) {
					const body = JSON.parse(options?.body as string);
					evaluations.push(body);
					expectOutputSchema(body, api);
					return api === 'responses' ? evaluation(clean) : chatEvaluation(clean);
				}
				if (url.endsWith('/videos')) {
					expect((options?.body as FormData).get('prompt')).toBe('The original scene');
					return json({ id: 'job', status: 'queued' });
				}
				if (url.endsWith('/videos/job/content'))
					return new Response(
						Uint8Array.from(atob(VIDEO), (c) => c.charCodeAt(0)),
						{ headers: { 'content-type': 'video/mp4' } },
					);
				throw new Error(`Unexpected URL ${url}`);
			});
			vi.stubGlobal('fetch', fetch);
			await createVideo(connection, { model: 'video', prompt: 'The original scene' });
			const asset = await downloadVideo(connection, 'job');
			expect(asset.url).toBe(`data:video/mp4;base64,${VIDEO}`);
			expect(evaluations).toHaveLength(2);
			expect(JSON.stringify(evaluations[1])).not.toContain(VIDEO);
			expect(JSON.stringify(evaluations[1])).toContain(`data:image/png;base64,${PNG}`);
			expect(JSON.stringify(evaluations[1])).toContain(
				api === 'responses' ? 'input_image' : 'image_url',
			);
			expect(JSON.stringify(evaluations[1])).not.toContain('video_url');
		},
	);
	it('guards native video URLs returned immediately with a completed job', async () => {
		const context = fixture('high');
		context.connections[0].chatApi = 'chat/completions';
		let evaluations = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				if (url.endsWith('/chat/completions'))
					return chatEvaluation(++evaluations === 1 ? clean : { ...clean, gore: true });
				if (url.endsWith('/videos'))
					return json({ id: 'job', status: 'completed', video_url: 'https://cdn.test/result.mp4' });
				if (url === 'https://cdn.test/result.mp4')
					return new Response(
						Uint8Array.from(atob(VIDEO), (c) => c.charCodeAt(0)),
						{ headers: { 'content-type': 'video/mp4' } },
					);
				throw new Error(`Unexpected URL ${url}`);
			}),
		);
		await expect(createVideo(connection, { model: 'video', prompt: 'A scene' })).rejects.toThrow(
			/moderation|blocked/i,
		);
		expect(evaluations).toBe(2);
	});
	it('does not duplicate moderation calls when using the desktop host bridge', async () => {
		fixture('high');
		const fetch = vi.fn();
		vi.stubGlobal('fetch', fetch);
		const request = vi.fn(async (_request: WireRequest) => ({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ data: [{ b64_json: PNG }] }),
			encoding: 'text' as const,
		}));
		vi.stubGlobal('window', {
			desktop: {
				request,
				onChunk: () => () => {},
				cancel: async () => {},
			} as Partial<DesktopBridge>,
		});
		const assets = await generateImages(connection, { model: 'image', prompt: 'A fox' });
		expect(assets).toHaveLength(1);
		expect(request).toHaveBeenCalledTimes(1);
		expect(fetch).not.toHaveBeenCalled();
	});
	it('leaves unregistered standalone transport helpers compatible while guarding actual App registrations', async () => {
		vi.stubGlobal('window', {});
		const fetch = vi.fn(async () => json({ data: [{ b64_json: PNG }] }));
		vi.stubGlobal('fetch', fetch);
		await generateImages(connection, { model: 'image', prompt: 'A fox' });
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it('leaves ordinary text API requests untouched', async () => {
		fixture();
		const fetch = vi.fn(async () => json({ data: [] }));
		vi.stubGlobal('fetch', fetch);
		await apiRequest(connection, { method: 'GET', path: '/models' });
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});

describe('browser moderation generated asset downloads', () => {
	it('rejects non-HTTP, embedded credentials, oversized headers and incompatible MIME types', async () => {
		const fetch = vi.fn(
			async () =>
				new Response('bad', {
					headers: { 'content-type': 'image/png', 'content-length': String(33 * 1024 * 1024) },
				}),
		);
		vi.stubGlobal('fetch', fetch);
		await expect(downloadBrowserModerationAsset('file:///private/image.png')).rejects.toThrow(
			/HTTP/,
		);
		await expect(
			downloadBrowserModerationAsset('https://user:secret@cdn.test/image.png'),
		).rejects.toThrow(/credentials/);
		expect(fetch).not.toHaveBeenCalled();
		await expect(downloadBrowserModerationAsset('https://cdn.test/image.png')).rejects.toThrow(
			/32 MiB/,
		);
		fetch.mockResolvedValue(new Response('<html>', { headers: { 'content-type': 'text/html' } }));
		await expect(
			downloadBrowserModerationAsset('https://cdn.test/image.png', undefined, 'image'),
		).rejects.toThrow(/content type/);
	});
	it('honors cancellation and explains browser-only CORS failures', async () => {
		const fetch = vi.fn(async () => {
			throw new TypeError('Failed to fetch');
		});
		vi.stubGlobal('fetch', fetch);
		const abort = new AbortController();
		abort.abort();
		await expect(
			downloadBrowserModerationAsset('https://cdn.test/image.png', abort.signal),
		).rejects.toMatchObject({ name: 'AbortError' });
		expect(fetch).not.toHaveBeenCalled();
		await expect(downloadBrowserModerationAsset('https://cdn.test/image.png')).rejects.toThrow(
			/CORS/,
		);
	});
});
