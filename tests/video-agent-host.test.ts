import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentHost } from '../electron/agent-host';
import { performRequest } from '../electron/transport';
import { ToolRuntime } from '../electron/tools/runtime';
import * as videoFrames from '../electron/moderation-video-frames';
import { initialState } from '../src/lib/state';
import { defaultToolSettings } from '../src/lib/tool-settings';
import { defaultModerationSettings } from '../src/lib/moderation';
import type { ToolHostRequest } from '../src/agent-types';
import type { WireResponse } from '../src/types';

vi.mock('../electron/transport', async (original) => ({
	...(await original<typeof import('../electron/transport')>()),
	performRequest: vi.fn(),
}));
const cleanup: (() => Promise<unknown>)[] = [];
beforeEach(() => vi.mocked(performRequest).mockReset());
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
	vi.restoreAllMocks();
	vi.useRealTimers();
});
const json = (value: unknown): WireResponse => ({
	status: 200,
	encoding: 'text',
	contentType: 'application/json',
	body: JSON.stringify(value),
});
const binary: WireResponse = {
	status: 200,
	encoding: 'base64',
	contentType: 'video/mp4',
	body: 'dmlkZW8=',
};
const png =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const reference = {
	name: 'reference.png',
	type: 'image/png',
	dataUrl: `data:image/png;base64,${png}`,
};
const avif = readFileSync(new URL('./fixtures/reference.avif', import.meta.url)).toString('base64');
const avifReference = {
	name: 'reference.avif',
	type: 'image/avif',
	dataUrl: `data:image/avif;base64,${avif}`,
};
const videoFixture = readFileSync(
	new URL('./fixtures/moderation-samples.mp4', import.meta.url),
).toString('base64');
const call = (
	args: Record<string, unknown> = {},
	extra: Partial<ToolHostRequest> = {},
): ToolHostRequest => ({
	workspaceId: 'local',
	runId: 'run',
	threadId: 'thread',
	name: 'video_gen.videogen',
	arguments: { prompt: 'A landscape.', ...args },
	...extra,
});

async function fixture(kind: 'chat' | 'code' = 'chat', approve = vi.fn(async () => true)) {
	const directory = await mkdtemp(path.join(tmpdir(), 'freelm-video-host-'));
	cleanup.push(() => rm(directory, { recursive: true, force: true }));
	const state = initialState();
	state.moderation = {
		image: { ...defaultModerationSettings().image, enabled: false },
		video: { ...defaultModerationSettings().video, enabled: false },
	};
	state.connections = [
		{
			id: 'video-api',
			name: 'Video',
			baseUrl: 'https://videos.invalid/v1',
			apiKey: 'video-secret',
			chatApi: 'responses',
			models: { chat: '', images: '', videos: 'video-model', speech: '', transcription: '' },
			discoveredModels: [],
			catalog: [
				{
					id: 'video-model',
					name: 'Video model',
					enabled: true,
					tasks: ['videos'],
					inputModalities: ['text', 'image'],
					outputModalities: ['video'],
					thinkingModes: [],
				},
			],
		},
	];
	state.threads = [
		{
			id: 'thread',
			kind,
			title: 'Test',
			connectionId: 'video-api',
			model: 'chat-model',
			messages: [],
			createdAt: 1,
			updatedAt: 1,
		},
	];
	state.toolSettings = {
		...defaultToolSettings(),
		enabled: kind === 'code',
		workspaceRoot: directory,
		videoGeneration: {
			enabled: true,
			connectionId: 'video-api',
			model: 'video-model',
			size: '',
			seconds: '',
		},
	};
	const host = new AgentHost(async () => structuredClone(state), approve);
	cleanup.push(() => host.close());
	return { state, host, approve, directory };
}

describe('video generation host authorization and moderation', () => {
	it.each(['chat', 'code'] as const)(
		'accepts an AVIF reference through the %s tool boundary and moderates it without changing provider bytes',
		async (kind) => {
			const frames = vi
				.spyOn(videoFrames, 'extractDesktopModerationVideoFrames')
				.mockImplementation(async function* () {
					yield { timestamp: 0, image: reference.dataUrl };
				});
			const { host, state } = await fixture(kind);
			state.moderation!.video = {
				...defaultModerationSettings().video,
				enabled: true,
				level: 'low',
				connectionId: 'video-api',
				model: 'reviewer',
			};
			state.connections[0].catalog!.push({
				id: 'reviewer',
				name: 'Image reviewer',
				enabled: true,
				tasks: ['chat'],
				inputModalities: ['text', 'image'],
				outputModalities: ['text'],
				thinkingModes: [
					{ id: 'low', name: 'Low', parameters: { responses: { reasoning: { effort: 'low' } } } },
				],
				defaultThinkingMode: 'low',
			});
			const clean = {
				ncii: false,
				sexual_minors: false,
				violent_minors: false,
				sexual_content: false,
				artistic_nudity: false,
				nudity: false,
				gore: false,
			};
			const labels = {
				...clean,
				input_contains_person: true,
				edit_sexual_content: false,
				edit_nudity: false,
			};
			const classified = (value: typeof clean) =>
				json({
					status: 'completed',
					output: [
						{
							type: 'message',
							role: 'assistant',
							content: [{ type: 'output_text', text: JSON.stringify(value) }],
						},
					],
				});
			vi.mocked(performRequest)
				.mockResolvedValueOnce(classified(labels))
				.mockResolvedValueOnce(json({ id: 'avif-job', status: 'completed' }))
				.mockResolvedValueOnce({ ...binary, body: videoFixture })
				.mockResolvedValueOnce(classified(clean));
			await host.catalog('run', 'thread');
			const prompt = 'Animate the colored shapes while preserving the reference.';
			const before = structuredClone(avifReference);
			const result = await host.execute(
				call({ prompt, num_last_images_to_include: 1 }, { recentImages: [avifReference] }),
			);
			expect(result.content).toContainEqual(
				expect.objectContaining({ type: 'file', mimeType: 'video/mp4' }),
			);
			const [input, generation, content, output] = vi
				.mocked(performRequest)
				.mock.calls.map(([wire]) => wire);
			expect(performRequest).toHaveBeenCalledTimes(4);
			expect(input).toMatchObject({
				path: '/responses',
				body: {
					text: {
						format: {
							type: 'json_schema',
							strict: true,
							schema: { required: Object.keys(labels), additionalProperties: false },
						},
					},
				},
			});
			expect(JSON.stringify(input.body)).toContain(prompt);
			expect(JSON.stringify(input.body)).toContain(avifReference.dataUrl);
			expect(generation.path).toBe('/videos');
			expect(generation.form).toContainEqual({
				name: 'input_reference',
				file: { name: avifReference.name, type: avifReference.type, base64: avif },
			});
			expect(generation.form).toContainEqual({ name: 'prompt', value: prompt });
			expect(content.path).toBe('/videos/avif-job/content');
			expect(frames).toHaveBeenCalledOnce();
			expect(JSON.stringify(output.body)).toContain(reference.dataUrl);
			expect(JSON.stringify(output.body)).not.toContain(avifReference.dataUrl);
			expect(avifReference).toEqual(before);
		},
	);
	it.each(['chat', 'code'] as const)(
		'blocks a classified AVIF reference transformation in %s before video generation',
		async (kind) => {
			const { host, state } = await fixture(kind);
			state.moderation!.video = {
				...defaultModerationSettings().video,
				enabled: true,
				level: 'low',
				connectionId: 'video-api',
				model: 'reviewer',
			};
			state.connections[0].catalog!.push({
				id: 'reviewer',
				name: 'Image reviewer',
				enabled: true,
				tasks: ['chat'],
				inputModalities: ['text', 'image'],
				outputModalities: ['text'],
				thinkingModes: [
					{ id: 'low', name: 'Low', parameters: { responses: { reasoning: { effort: 'low' } } } },
				],
				defaultThinkingMode: 'low',
			});
			const labels = {
				ncii: false,
				sexual_minors: false,
				violent_minors: false,
				sexual_content: false,
				artistic_nudity: false,
				nudity: false,
				gore: false,
				input_contains_person: true,
				edit_sexual_content: false,
				edit_nudity: true,
			};
			vi.mocked(performRequest).mockResolvedValueOnce(
				json({
					status: 'completed',
					output: [
						{
							type: 'message',
							role: 'assistant',
							content: [{ type: 'output_text', text: JSON.stringify(labels) }],
						},
					],
				}),
			);
			await host.catalog('run', 'thread');
			const prompt = 'The top has been completely removed by the final frame.';
			await expect(
				host.execute(
					call({ prompt, num_last_images_to_include: 1 }, { recentImages: [avifReference] }),
				),
			).rejects.toThrow('Video edit blocked by low moderation');
			expect(performRequest).toHaveBeenCalledOnce();
			const input = vi.mocked(performRequest).mock.calls[0][0];
			expect(input.path).toBe('/responses');
			expect(JSON.stringify(input.body)).toContain(prompt);
			expect(JSON.stringify(input.body)).toContain(avifReference.dataUrl);
		},
	);
	it.each(['chat', 'code'] as const)(
		'sends an explicit default size in %s when both the model and legacy settings omit it',
		async (kind) => {
			const { host } = await fixture(kind);
			const catalog = await host.catalog('run', 'thread');
			expect(
				JSON.stringify(catalog.tools.find((tool) => tool.name === 'video_gen.videogen')),
			).toContain('1280x736');
			vi.mocked(performRequest)
				.mockResolvedValueOnce(json({ id: 'default-size', status: 'completed' }))
				.mockResolvedValueOnce(binary);
			await host.execute(call());
			const form = vi.mocked(performRequest).mock.calls[0][0].form!;
			expect(form).toContainEqual({ name: 'size', value: '1280x736' });
			expect(form.some((field) => field.name === 'seconds')).toBe(false);
		},
	);

	it.each(['chat', 'code'] as const)(
		'preserves the saved size and duration in %s when the model omits both',
		async (kind) => {
			const { host, state } = await fixture(kind);
			state.toolSettings!.videoGeneration!.size = '736x1280';
			state.toolSettings!.videoGeneration!.seconds = '10';
			const catalog = await host.catalog('run', 'thread');
			expect(
				JSON.stringify(catalog.tools.find((tool) => tool.name === 'video_gen.videogen')),
			).toContain('Saved default size: 736x1280');
			vi.mocked(performRequest)
				.mockResolvedValueOnce(json({ id: 'saved-size', status: 'completed' }))
				.mockResolvedValueOnce(binary);
			await host.execute(call());
			expect(vi.mocked(performRequest).mock.calls[0][0].form).toEqual(
				expect.arrayContaining([
					{ name: 'size', value: '736x1280' },
					{ name: 'seconds', value: '10' },
				]),
			);
			expect(state.toolSettings!.videoGeneration!.size).toBe('736x1280');
		},
	);

	it('offers and runs Chat videos without enabling Code or reading the filesystem', async () => {
		const { host, state, approve } = await fixture();
		state.toolSettings!.workspaceRoot = '/missing-root';
		state.toolSettings!.skillDirectories = ['/missing-skills'];
		state.toolSettings!.mcpServers = [
			{ id: 'server', name: 'Unused', enabled: true, transport: 'stdio', command: 'never-start' },
		];
		const local = vi.spyOn(ToolRuntime.prototype, 'execute');
		const catalog = await host.catalog('run', 'thread', true);
		expect(catalog.tools.map((tool) => tool.name)).toEqual(['video_gen.videogen']);
		vi.mocked(performRequest)
			.mockResolvedValueOnce(json({ id: 'done', status: 'completed' }))
			.mockResolvedValueOnce(binary);
		const result = await host.execute(
			call(
				{ size: '1920x1080', seconds: 15, num_last_images_to_include: 1 },
				{ recentImages: [reference] },
			),
		);
		expect(result.content.at(-1)).toMatchObject({ type: 'file', mimeType: 'video/mp4' });
		expect(vi.mocked(performRequest).mock.calls[0][0].form).toEqual(
			expect.arrayContaining([
				{ name: 'size', value: '1920x1088' },
				{ name: 'seconds', value: '15' },
				{
					name: 'input_reference',
					file: { name: reference.name, type: reference.type, base64: png },
				},
			]),
		);
		expect(local).not.toHaveBeenCalled();
		expect(approve).not.toHaveBeenCalled();
	});
	it('never reads Chat-supplied local paths or silently substitutes missing references', async () => {
		const { host } = await fixture();
		const local = vi.spyOn(ToolRuntime.prototype, 'execute');
		await host.catalog('run', 'thread');
		await expect(
			host.execute(call({ referenced_image_paths: ['/tmp/private.png'] })),
		).rejects.toThrow(/cannot read local/);
		await expect(host.execute(call({ num_last_images_to_include: 1 }))).rejects.toThrow(
			/no recent chat image/,
		);
		await expect(
			host.execute(
				call({ num_last_images_to_include: 2 }, { recentImages: [reference, reference] }),
			),
		).rejects.toThrow(/one recent image/);
		expect(local).not.toHaveBeenCalled();
		expect(performRequest).not.toHaveBeenCalled();
	});
	it('requires Code approval before reading a reference or contacting the generation provider', async () => {
		const { host, directory, approve } = await fixture(
			'code',
			vi.fn(async () => false),
		);
		const local = vi.spyOn(ToolRuntime.prototype, 'execute');
		await host.catalog('run', 'thread');
		const result = await host.execute(
			call({ referenced_image_paths: [path.join(directory, 'private.png')] }),
		);
		expect(result.approvalDenied).toBeDefined();
		expect(approve).toHaveBeenCalledOnce();
		expect(local).not.toHaveBeenCalled();
		expect(performRequest).not.toHaveBeenCalled();
	});
	it('reads an approved workspace reference through the existing Code image reader', async () => {
		const { host, directory, approve } = await fixture('code');
		await writeFile(path.join(directory, 'reference.png'), Buffer.from(png, 'base64'));
		const local = vi.spyOn(ToolRuntime.prototype, 'execute');
		await host.catalog('run', 'thread');
		vi.mocked(performRequest)
			.mockResolvedValueOnce(json({ id: 'done', status: 'completed' }))
			.mockResolvedValueOnce(binary);
		await host.execute(call({ referenced_image_paths: ['reference.png'] }));
		expect(approve).toHaveBeenCalledOnce();
		expect(local).toHaveBeenCalledWith(
			expect.objectContaining({ name: 'view_image', arguments: { path: 'reference.png' } }),
			expect.anything(),
			expect.anything(),
		);
		expect(vi.mocked(performRequest).mock.calls[0][0].form).toContainEqual({
			name: 'input_reference',
			file: { name: 'reference.png', type: 'image/png', base64: png },
		});
	});
	it('stops on changed video model capabilities instead of using stale configuration', async () => {
		const { host, state } = await fixture();
		await host.catalog('run', 'thread');
		state.connections[0].catalog![0].inputModalities = ['text'];
		await expect(
			host.execute(call({ num_last_images_to_include: 1 }, { recentImages: [reference] })),
		).rejects.toThrow(/Video model settings changed/);
		expect(performRequest).not.toHaveBeenCalled();
	});
	it('applies input moderation before submitting the job using an image-capable evaluator', async () => {
		const { host, state } = await fixture();
		state.moderation = {
			...defaultModerationSettings(),
			video: {
				...defaultModerationSettings().video,
				level: 'high',
				connectionId: 'video-api',
				model: 'reviewer',
			},
		};
		state.connections[0].catalog!.push({
			id: 'reviewer',
			name: 'Image reviewer',
			enabled: true,
			tasks: ['chat'],
			inputModalities: ['text', 'image'],
			outputModalities: ['text'],
			thinkingModes: [
				{ id: 'low', name: 'Low', parameters: { responses: { reasoning: { effort: 'low' } } } },
			],
			defaultThinkingMode: 'low',
		});
		vi.mocked(performRequest).mockResolvedValueOnce(
			json({
				status: 'completed',
				output: [
					{
						type: 'message',
						role: 'assistant',
						content: [
							{
								type: 'output_text',
								text: JSON.stringify({
									ncii: false,
									sexual_minors: false,
									violent_minors: false,
									sexual_content: false,
									artistic_nudity: false,
									nudity: true,
									gore: false,
								}),
							},
						],
					},
				],
			}),
		);
		await host.catalog('run', 'thread');
		await expect(host.execute(call())).rejects.toThrow(/Video prompt blocked by high moderation/);
		expect(performRequest).toHaveBeenCalledOnce();
		expect(vi.mocked(performRequest).mock.calls[0][0]).toMatchObject({
			path: '/responses',
			body: { model: 'reviewer', text: { format: { type: 'json_schema', strict: true } } },
		});
	});
	it.each(['chat', 'code'] as const)(
		'jointly moderates the selected recent image and video instruction before submitting in %s',
		async (kind) => {
			const { host, state } = await fixture(kind);
			state.moderation!.video = {
				...defaultModerationSettings().video,
				enabled: true,
				level: 'low',
				connectionId: 'video-api',
				model: 'reviewer',
			};
			state.connections[0].catalog!.push({
				id: 'reviewer',
				name: 'Image reviewer',
				enabled: true,
				tasks: ['chat'],
				inputModalities: ['text', 'image'],
				outputModalities: ['text'],
				thinkingModes: [
					{ id: 'low', name: 'Low', parameters: { responses: { reasoning: { effort: 'low' } } } },
				],
				defaultThinkingMode: 'low',
			});
			const labels = {
				ncii: false,
				sexual_minors: false,
				violent_minors: false,
				sexual_content: false,
				artistic_nudity: false,
				nudity: false,
				gore: false,
				input_contains_person: true,
				edit_sexual_content: false,
				edit_nudity: true,
			};
			vi.mocked(performRequest).mockResolvedValueOnce(
				json({
					status: 'completed',
					output: [
						{
							type: 'message',
							role: 'assistant',
							content: [{ type: 'output_text', text: JSON.stringify(labels) }],
						},
					],
				}),
			);
			await host.catalog('run', 'thread');
			const prompt = 'By the end of the video, the top has been completely removed.';
			await expect(
				host.execute(
					call({ prompt, num_last_images_to_include: 1 }, { recentImages: [reference] }),
				),
			).rejects.toThrow(/Video edit blocked by low moderation/);
			expect(performRequest).toHaveBeenCalledOnce();
			expect(vi.mocked(performRequest).mock.calls[0][0]).toMatchObject({
				path: '/responses',
				body: {
					model: 'reviewer',
					text: {
						format: {
							type: 'json_schema',
							strict: true,
							schema: { required: Object.keys(labels), additionalProperties: false },
						},
					},
					input: expect.arrayContaining([
						expect.objectContaining({
							role: 'user',
							content: [
								expect.objectContaining({
									type: 'input_text',
									text: expect.stringContaining(prompt),
								}),
								{ type: 'input_image', image_url: reference.dataUrl },
							],
						}),
					]),
				},
			});
		},
	);
	it('does not expire an active video run at the idle limit and still honors explicit cancellation', async () => {
		vi.useFakeTimers();
		const { host } = await fixture();
		await host.catalog('run', 'thread');
		let requestSignal: AbortSignal | undefined;
		vi.mocked(performRequest).mockImplementation(async (_wire, _chunk, signal) => {
			requestSignal = signal;
			return new Promise<WireResponse>((_resolve, reject) =>
				signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }),
			);
		});
		const pending = host.execute(call());
		const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
		await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
		expect(requestSignal).toBeDefined();
		expect(requestSignal!.aborted).toBe(false);
		host.cancel('run');
		await rejected;
		expect(requestSignal!.aborted).toBe(true);
	});
});
