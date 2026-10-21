import * as videoFrames from '../../electron/moderation-video-frames';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InstanceClient } from '../../electron/instance-client';
import { InstanceHost } from '../../electron/instance-host';
import { StateStore } from '../../electron/state-store';
import { WorkspaceAuthority } from '../../electron/workspace-authority';
import { initialState } from '../../src/lib/state';
import { defaultModerationSettings, moderationSettings } from '../../src/lib/moderation';
import type { AppState, ModelDefinition, WireRequest } from '../../src/types';
import type { ModerationLabels, ModerationSettings } from '../../src/moderation-types';

const PNG =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+HXXkAAAAASUVORK5CYII=';
const TOKEN = 'remote-moderation-test-token-not-a-real-secret';
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
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
	for (const dispose of cleanup.splice(0).reverse()) await dispose();
	vi.restoreAllMocks();
});
const secrets = {
	available: () => false,
	encrypt: () => {
		throw new Error('No test secrets should be encrypted.');
	},
	decrypt: () => {
		throw new Error('No test secrets should be decrypted.');
	},
};
function definition(id: string, input: ModelDefinition['inputModalities']): ModelDefinition {
	return {
		id,
		name: id,
		enabled: true,
		tasks: ['chat'],
		inputModalities: input,
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
	};
}
function state(
	baseUrl = 'http://127.0.0.1:8000/v1',
): AppState & { moderation: ModerationSettings } {
	const result = initialState();
	result.activeConnectionId = 'provider';
	result.connections = [
		{
			id: 'provider',
			name: 'Local fixture provider',
			baseUrl,
			apiKey: '',
			chatApi: 'responses',
			models: {
				chat: 'evaluate-image',
				images: 'image',
				videos: '',
				speech: '',
				transcription: '',
			},
			discoveredModels: [],
			catalog: [
				definition('evaluate-image', ['text', 'image']),
				definition('evaluate-video', ['text', 'image']),
				{
					id: 'image',
					name: 'Image generator',
					enabled: true,
					tasks: ['images'],
					inputModalities: ['text'],
					outputModalities: ['image'],
					thinkingModes: [],
				},
			],
		},
	];
	const moderation: ModerationSettings = {
		image: {
			enabled: true,
			level: 'high',
			connectionId: 'provider',
			model: 'evaluate-image',
			thinkingMode: 'low',
		},
		video: {
			enabled: true,
			level: 'high',
			connectionId: 'provider',
			model: 'evaluate-video',
			thinkingMode: 'low',
			videoApi: 'chat/completions',
		},
	};
	return { ...result, moderation };
}
function json(response: ServerResponse, body: unknown) {
	response.setHeader('Content-Type', 'application/json');
	response.end(JSON.stringify(body));
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function server(handler: (request: IncomingMessage, response: ServerResponse) => void) {
	const instance = createServer(handler);
	await new Promise<void>((resolve, reject) => {
		instance.once('error', reject);
		instance.listen(0, '127.0.0.1', resolve);
	});
	cleanup.push(() => close(instance));
	return `http://127.0.0.1:${(instance.address() as { port: number }).port}`;
}
function close(instance: Server) {
	return new Promise<void>((resolve) => {
		instance.close(() => resolve());
		instance.closeAllConnections();
	});
}
async function paired(url: string) {
	const { client } = await InstanceClient.connect({
		name: 'Test host',
		transport: 'direct',
		url,
		token: TOKEN,
	});
	cleanup.push(() => client.disconnect());
	return client;
}
async function host(initial = state()) {
	const directory = await mkdtemp(path.join(tmpdir(), 'freelm-remote-moderation-'));
	cleanup.push(() => rm(directory, { recursive: true, force: true }));
	const workspacePath = path.join(directory, 'workspace.json');
	const configPath = path.join(directory, 'config.json');
	const store = new StateStore(workspacePath, secrets, configPath);
	await store.save(initial);
	const authority = new WorkspaceAuthority(store);
	const instance = new InstanceHost({
		authority,
		instanceId: 'moderation-test-host',
		name: 'Moderation host',
		token: TOKEN,
		port: 0,
	});
	const port = await instance.start();
	cleanup.push(() => instance.stop());
	const url = `http://127.0.0.1:${port}`;
	return { store, authority, workspacePath, configPath, url, client: await paired(url) };
}
function imageRequest(): WireRequest {
	return {
		id: crypto.randomUUID(),
		connectionId: 'provider',
		baseUrl: 'http://ignored-client-provider.invalid/v1',
		apiKey: 'not-a-real-key',
		path: '/images/generations',
		method: 'POST',
		body: { model: 'image', prompt: 'A simple blue square' },
	};
}
function legacyInfo(response: ServerResponse, mediaModeration = false, structured = false) {
	json(response, {
		protocol: 1,
		instanceId: 'legacy-host',
		name: 'Legacy host',
		conversationModes: true,
		chatMemory: true,
		personalization: true,
		codeCompaction: true,
		...(mediaModeration ? { mediaModeration: true } : {}),
		...(structured ? { moderationStructuredOutput: true } : {}),
	});
}
function evaluation(response: ServerResponse, labels: ModerationLabels) {
	json(response, {
		status: 'completed',
		output: [
			{
				type: 'message',
				role: 'assistant',
				content: [{ type: 'output_text', text: JSON.stringify(labels) }],
			},
		],
	});
}

describe('remote media moderation capability', () => {
	it('advertises capability and saves independent evaluator settings in host configuration', async () => {
		const instance = await host();
		const info = await fetch(instance.url + '/info', {
			headers: { Authorization: `Bearer ${TOKEN}` },
		}).then((response) => response.json());
		expect(info.mediaModeration).toBe(true);
		expect(info.moderationStructuredOutput).toBe(true);
		expect(info.moderationPolicies).toBe(1);
		expect(info.moderationImageEdits).toBe(1);
		expect(info.moderationVideoFrames).toBe(1);
		expect(info.moderationVideoReferences).toBe(1);
		const snapshot = await instance.client.load();
		expect(snapshot.moderationSupported).toBe(true);
		expect(snapshot.state!.moderation).toEqual(state().moderation);
		const updated = {
			...structuredClone(snapshot.state!),
			moderation: moderationSettings(snapshot.state!.moderation),
		};
		updated.moderation!.image.level = 'medium';
		updated.moderation!.video.enabled = false;
		updated.moderation!.video.videoApi = 'chat';
		await instance.client.save(snapshot.revision, updated);
		const reload = await instance.client.load();
		expect(reload.state!.moderation).toEqual(updated.moderation);
		expect(reload.state!.moderation!.image.model).toBe('evaluate-image');
		expect(reload.state!.moderation!.video.model).toBe('evaluate-video');
		expect(JSON.parse(await readFile(instance.configPath, 'utf8')).moderation).toEqual(
			updated.moderation,
		);
		expect(JSON.parse(await readFile(instance.workspacePath, 'utf8'))).not.toHaveProperty(
			'moderation',
		);
		expect(
			(await new StateStore(instance.workspacePath, secrets, instance.configPath).load())!
				.moderation,
		).toEqual(updated.moderation);
	});
	it('removes unsupported moderation from legacy snapshots and rejects new settings before HTTP', async () => {
		const original = state();
		let writes = 0;
		const url = await server((request, response) => {
			if (request.url === '/info') return legacyInfo(response);
			if (request.method !== 'GET') writes++;
			json(response, { state: original, revision: 'legacy:0' });
		});
		const client = await paired(url);
		const snapshot = await client.load();
		expect(snapshot.moderationSupported).toBe(false);
		expect(snapshot.state).not.toHaveProperty('moderation');
		expect(original.moderation!.image.enabled).toBe(true);
		await expect(
			client.save(snapshot.revision, {
				...snapshot.state!,
				moderation: defaultModerationSettings(),
			}),
		).rejects.toThrow('configure media moderation');
		expect(writes).toBe(0);
	});
	it('rejects legacy generation, content download, and direct image/orchestration tools before contacting the host', async () => {
		let protectedCalls = 0;
		const url = await server((request, response) => {
			if (request.url === '/info') return legacyInfo(response);
			protectedCalls++;
			json(response, {});
		});
		const client = await paired(url);
		for (const [method, path] of [
			['POST', '/images/generations'],
			['POST', '/v1/images/edits?unused=1'],
			['POST', '/videos'],
			['POST', '/videos/video-id/remix'],
			['GET', '/videos/video-id/content'],
		] as const)
			await expect(client.request({ ...imageRequest(), method, path }, () => {})).rejects.toThrow(
				'does not support media moderation',
			);
		for (const name of ['image_gen', 'image_gen.imagegen', 'functions.exec'])
			await expect(
				client.tools('execute', { runId: 'run', threadId: 'thread', name, arguments: {} }),
			).rejects.toThrow('Update FreeLM');
		expect(protectedCalls).toBe(0);
	});
	it.each([false, true])(
		'requires independent-policy capability on older moderated hosts (strict=%s) and preserves their hidden global policy',
		async (structured) => {
			const fixture = state();
			const { enabled: _imageEnabled, level: _imageLevel, ...image } = fixture.moderation.image;
			const { enabled: _videoEnabled, level: _videoLevel, ...video } = fixture.moderation.video;
			const original: AppState = {
				...fixture,
				moderation: { enabled: true, level: 'high', image, video },
			};
			let received: AppState | undefined;
			let calls = 0;
			const url = await server((request, response) => {
				if (request.url === '/info') return legacyInfo(response, true, structured);
				if (request.method === 'GET' && request.url === '/workspace')
					return json(response, { state: original, revision: 'old-moderation:0' });
				calls++;
				void body(request)
					.then((input) => {
						received = input.state as AppState;
						json(response, { revision: 'old-moderation:1' });
					})
					.catch(() => response.writeHead(400).end());
			});
			const client = await paired(url);
			const snapshot = await client.load();
			expect(snapshot.moderationSupported).toBe(false);
			expect(snapshot.state).not.toHaveProperty('moderation');
			await expect(client.request(imageRequest(), () => {})).rejects.toThrow(
				'does not support media moderation',
			);
			for (const name of ['image_gen.imagegen', 'functions.exec'])
				await expect(
					client.tools('execute', { runId: 'run', threadId: 'thread', name, arguments: {} }),
				).rejects.toThrow('Update FreeLM');
			await expect(
				client.save(snapshot.revision, {
					...snapshot.state!,
					moderation: defaultModerationSettings(),
				}),
			).rejects.toThrow('configure media moderation');
			expect(calls).toBe(0);
			await expect(
				client.save(snapshot.revision, { ...snapshot.state!, theme: 'light' }),
			).resolves.toEqual({ revision: 'old-moderation:1' });
			expect(calls).toBe(1);
			expect(received!.moderation).toEqual(original.moderation);
			expect(received!.theme).toBe('light');
			expect(snapshot.state).not.toHaveProperty('moderation');
			expect(original.moderation).toHaveProperty('enabled', true);
		},
	);
	it('filters unsafe legacy catalog entries with a warning while preserving ordinary execution and cancellation', async () => {
		const calls: string[] = [];
		const names = [
			'image_gen',
			'image_gen.imagegen',
			'functions.exec',
			'exec_command',
			'tool_search',
		];
		const url = await server((request, response) => {
			if (request.url === '/info') return legacyInfo(response);
			calls.push(request.url!);
			if (request.url === '/tools/catalog')
				return json(response, {
					tools: names.map((name) => ({ name })),
					instructions: 'Existing instructions.',
					warnings: ['Existing warning.'],
				});
			json(response, { ok: true });
		});
		const client = await paired(url);
		const catalog = await client.tools('catalog', { runId: 'run', threadId: 'thread' });
		expect(catalog.tools.map((tool: { name: string }) => tool.name)).toEqual([
			'exec_command',
			'tool_search',
		]);
		expect(catalog.warnings).toHaveLength(2);
		expect(catalog.warnings[1]).toContain('support media moderation');
		expect(catalog.instructions).toContain('Existing instructions.');
		expect(catalog.instructions).toContain('programmatic tool orchestration are unavailable');
		await expect(
			client.tools('execute', {
				runId: 'run',
				threadId: 'thread',
				name: 'exec_command',
				arguments: { cmd: 'pwd' },
			}),
		).resolves.toEqual({ ok: true });
		await expect(client.tools('cancel', { runId: 'run' })).resolves.toEqual({ ok: true });
		expect(calls).toEqual(['/tools/catalog', '/tools/execute', '/tools/cancel']);
	});
	it('preserves supported host catalogs and permits programmatic execution', async () => {
		const catalog = {
			tools: [{ name: 'image_gen.imagegen' }, { name: 'functions.exec' }],
			instructions: 'Host instructions.',
			warnings: [],
		};
		const url = await server((request, response) => {
			if (request.url === '/info')
				return json(response, {
					protocol: 1,
					instanceId: 'updated-host',
					name: 'Updated',
					mediaModeration: true,
					moderationStructuredOutput: true,
					moderationPolicies: 1,
					moderationImageEdits: 1,
				});
			json(response, request.url === '/tools/catalog' ? catalog : { ok: true });
		});
		const client = await paired(url);
		expect(await client.tools('catalog', { runId: 'run', threadId: 'thread' })).toEqual(catalog);
		await expect(
			client.tools('execute', {
				runId: 'run',
				threadId: 'thread',
				name: 'functions.exec',
				arguments: { code: 'text(1)' },
			}),
		).resolves.toEqual({ ok: true });
	});
	it('requires contextual edit capability before sending image-edit requests or dynamic tool code', async () => {
		const calls: string[] = [];
		const url = await server((request, response) => {
			if (request.url === '/info')
				return json(response, {
					protocol: 1,
					instanceId: 'prompt-only-host',
					name: 'Prompt-only moderation host',
					mediaModeration: true,
					moderationStructuredOutput: true,
					moderationPolicies: 1,
				});
			calls.push(request.url!);
			json(response, { ok: true });
		});
		const client = await paired(url);
		const reference = `data:image/png;base64,${PNG}`;
		const requests: WireRequest[] = [
			{ ...imageRequest(), path: '/images/edits' },
			{ ...imageRequest(), path: '/v1/images/edits/?unused=1' },
			{ ...imageRequest(), body: { ...imageRequest().body, image: reference } },
			{ ...imageRequest(), body: { ...imageRequest().body, images: [reference] } },
			{
				...imageRequest(),
				body: { input: [{ type: 'input_image', image_url: { url: reference } }] },
			},
			{
				...imageRequest(),
				form: [{ name: 'image[]', file: { name: 'ref.png', type: 'image/png', base64: PNG } }],
			},
			{ ...imageRequest(), form: [{ name: 'image', value: reference }] },
			{
				...imageRequest(),
				form: [
					{ name: 'custom_reference', file: { name: 'ref.png', type: 'image/png', base64: PNG } },
				],
			},
			...[
				'image[]',
				'images[]',
				'image_url',
				'image_urls',
				'input_image',
				'input_images',
				'input_reference',
				'input_references',
				'reference',
				'references',
				'reference_image',
				'reference_images',
				'init_image',
				'attachments',
				'input',
				'file',
				'source',
			].map((name) => ({ ...imageRequest(), body: { prompt: 'An edit', [name]: reference } })),
			{ ...imageRequest(), body: { prompt: 'An edit', payload: { image: reference } } },
			{ ...imageRequest(), body: { prompt: 'An edit', images: [] } },
			{
				...imageRequest(),
				form: [
					{
						name: 'unknown',
						file: { name: 'ref.png', type: 'application/octet-stream', base64: PNG },
					},
				],
			},
		];
		for (const request of requests)
			await expect(client.request(request, () => {})).rejects.toThrow(
				'contextual image-edit moderation',
			);
		for (const name of ['image_gen', 'image_gen.imagegen'])
			for (const arguments_ of [
				{ prompt: 'Change the background', num_last_images_to_include: 1 },
				{ prompt: 'Change the background', referenced_image_paths: ['/workspace/ref.png'] },
			])
				await expect(
					client.tools('execute', {
						runId: 'run',
						threadId: 'thread',
						name,
						arguments: arguments_,
					}),
				).rejects.toThrow('contextual image-edit moderation');
		await expect(
			client.tools('execute', {
				runId: 'run',
				threadId: 'thread',
				name: 'functions.exec',
				arguments: { code: "await tools['image_gen.imagegen']({num_last_images_to_include:1})" },
			}),
		).rejects.toThrow('contextual image-edit moderation');
		await expect(
			client.tools('execute', {
				runId: 'run',
				threadId: 'thread',
				name: 'functions.wait',
				arguments: { cell_id: 'existing-cell' },
			}),
		).rejects.toThrow('contextual image-edit moderation');
		expect(calls).toEqual([]);
	});
	it('keeps prompt-only generation, chat, ordinary tools, and saved policies available on earlier policy hosts', async () => {
		const original = state();
		const calls: string[] = [];
		let received: AppState | undefined;
		const url = await server((request, response) => {
			if (request.url === '/info')
				return json(response, {
					protocol: 1,
					instanceId: 'prompt-only-host',
					name: 'Prompt-only moderation host',
					conversationModes: true,
					chatMemory: true,
					personalization: true,
					codeCompaction: true,
					mediaModeration: true,
					moderationStructuredOutput: true,
					moderationPolicies: 1,
				});
			calls.push(request.url!);
			if (request.url === '/workspace' && request.method === 'GET')
				return json(response, { state: original, revision: 'prompt-only:0' });
			if (request.url === '/workspace') {
				void body(request).then((input) => {
					received = input.state as AppState;
					json(response, { revision: 'prompt-only:1' });
				});
				return;
			}
			if (request.url === '/tools/catalog')
				return json(response, {
					tools: [
						{ name: 'image_gen.imagegen' },
						{ name: 'functions.exec' },
						{ name: 'functions.wait' },
						{ name: 'tool_search' },
					],
					instructions: 'Host instructions.',
					warnings: ['Host warning.'],
				});
			if (request.url === '/request') {
				response.setHeader('Content-Type', 'application/x-ndjson');
				response.end(
					JSON.stringify({
						type: 'response',
						response: {
							status: 200,
							contentType: 'application/json',
							encoding: 'text',
							body: '{}',
						},
					}) + '\n',
				);
				return;
			}
			json(response, { ok: true });
		});
		const client = await paired(url);
		const snapshot = await client.load();
		expect(snapshot.moderationSupported).toBe(true);
		expect(snapshot.state!.moderation).toEqual(original.moderation);
		await client.save(snapshot.revision, { ...snapshot.state!, theme: 'light' });
		expect(received!.moderation).toEqual(original.moderation);
		expect(received!.theme).toBe('light');
		const catalog = await client.tools('catalog', { runId: 'run', threadId: 'thread' });
		expect(catalog.tools.map((tool: { name: string }) => tool.name)).toEqual([
			'image_gen.imagegen',
			'tool_search',
		]);
		expect(catalog.warnings).toEqual([
			'Host warning.',
			expect.stringContaining('contextual image-edit moderation'),
		]);
		expect(catalog.instructions).toContain('Host instructions.');
		await expect(client.request(imageRequest(), () => {})).resolves.toHaveProperty('status', 200);
		await expect(
			client.request(
				{
					...imageRequest(),
					body: {
						prompt: 'A blue square',
						model: 'image',
						image_size: '1024x1024',
						output_format: 'png',
						image_quality: 'high',
						mask: `data:image/png;base64,${PNG}`,
					},
				},
				() => {},
			),
		).resolves.toHaveProperty('status', 200);
		await expect(
			client.request({ ...imageRequest(), path: '/responses', body: { input: 'Hello' } }, () => {}),
		).resolves.toHaveProperty('status', 200);
		await expect(
			client.tools('execute', {
				runId: 'run',
				threadId: 'thread',
				name: 'image_gen.imagegen',
				arguments: { prompt: 'A blue square' },
				recentImages: [{ dataUrl: `data:image/png;base64,${PNG}` }],
			}),
		).resolves.toEqual({ ok: true });
		await expect(
			client.tools('execute', { runId: 'run', name: 'exec_command', arguments: { cmd: 'pwd' } }),
		).resolves.toEqual({ ok: true });
		await expect(client.tools('cancel', { runId: 'run' })).resolves.toEqual({ ok: true });
		expect(calls).toEqual([
			'/workspace',
			'/workspace',
			'/tools/catalog',
			'/request',
			'/request',
			'/request',
			'/tools/execute',
			'/tools/execute',
			'/tools/cancel',
		]);
	});
	it.each([false, true])(
		'gates video references separately from text-only video on a reference-capable=%s host',
		async (supported) => {
			const calls: { route: string; input: Record<string, unknown> }[] = [];
			const url = await server((request, response) => {
				if (request.url === '/info')
					return json(response, {
						protocol: 1,
						instanceId: 'video-host',
						name: 'Video moderation host',
						mediaModeration: true,
						moderationStructuredOutput: true,
						moderationPolicies: 1,
						moderationImageEdits: 1,
						moderationVideoFrames: 1,
						...(supported ? { moderationVideoReferences: 1 } : {}),
					});
				void body(request).then((input) => {
					calls.push({ route: request.url!, input });
					if (request.url === '/request') {
						response.setHeader('Content-Type', 'application/x-ndjson');
						response.end(
							JSON.stringify({
								type: 'response',
								response: {
									status: 200,
									encoding: 'text',
									contentType: 'application/json',
									body: '{}',
								},
							}) + '\n',
						);
						return;
					}
					json(
						response,
						request.url === '/tools/catalog'
							? {
									tools: [{ name: 'video_gen.videogen' }, { name: 'functions.exec' }],
									instructions: 'Original guidance.',
									warnings: [],
								}
							: { ok: true },
					);
				});
			});
			const client = await paired(url);
			const request = {
				...imageRequest(),
				path: '/videos',
				body: { model: 'video', prompt: 'A scene' },
			};
			const image = `data:image/png;base64,${PNG}`;
			const references: WireRequest[] = [
				{ ...request, body: { ...request.body, input_reference: image } },
				{
					...request,
					path: '/v1/%76ideos/?unused=1',
					form: [
						{ name: 'input_reference', file: { name: 'ref.png', type: 'image/png', base64: PNG } },
					],
				},
				{ ...request, path: '/videos/job/remix', body: { ...request.body, image } },
				{ ...request, body: { ...request.body, payload: { reference_image: image } } },
				{ ...request, form: [{ name: 'custom_reference', value: image }] },
				{
					...request,
					form: [{ name: 'unknown', file: { name: 'ref.png', type: 'image/png', base64: PNG } }],
				},
			];
			for (const reference of references) {
				const pending = client.request(reference, () => {});
				if (supported) await expect(pending).resolves.toHaveProperty('status', 200);
				else await expect(pending).rejects.toThrow('contextual video-reference moderation');
			}
			const tool = { runId: 'run', threadId: 'thread', name: 'video_gen.videogen' };
			for (const arguments_ of [
				{ prompt: 'A scene', num_last_images_to_include: 1 },
				{ prompt: 'A scene', referenced_image_paths: ['/workspace/reference.png'] },
			]) {
				const pending = client.tools('execute', { ...tool, arguments: arguments_ });
				if (supported) await expect(pending).resolves.toEqual({ ok: true });
				else await expect(pending).rejects.toThrow('contextual video-reference moderation');
			}
			if (!supported) expect(calls).toEqual([]);
			else expect(calls).toHaveLength(references.length + 2);
			await expect(client.request(request, () => {})).resolves.toHaveProperty('status', 200);
			await expect(
				client.request(
					{ ...request, method: 'GET', path: '/videos/job/content', body: undefined },
					() => {},
				),
			).resolves.toHaveProperty('status', 200);
			// Available conversation images alone do not imply they are used by a prompt-only call.
			await expect(
				client.tools('execute', {
					...tool,
					arguments: { prompt: 'A scene' },
					recentImages: [{ dataUrl: image, type: 'image/png', name: 'ref.png' }],
				}),
			).resolves.toEqual({ ok: true });
			const catalog = await client.tools('catalog', { runId: 'run', threadId: 'thread' });
			expect(catalog.tools.map((item: { name: string }) => item.name)).toEqual([
				'video_gen.videogen',
				'functions.exec',
			]);
			if (supported) expect(catalog.warnings).toEqual([]);
			else {
				expect(catalog.warnings).toEqual([
					expect.stringContaining('contextual video-reference moderation'),
				]);
				expect(catalog.instructions).toContain('text-only video generation remains available');
			}
		},
	);
	it('passes reference requests and direct edit tools to hosts advertising contextual image-edit moderation', async () => {
		const calls: { route: string; input: Record<string, unknown> }[] = [];
		const url = await server((request, response) => {
			if (request.url === '/info')
				return json(response, {
					protocol: 1,
					instanceId: 'updated-host',
					name: 'Updated moderation host',
					mediaModeration: true,
					moderationStructuredOutput: true,
					moderationPolicies: 1,
					moderationImageEdits: 1,
				});
			void body(request).then((input) => {
				calls.push({ route: request.url!, input });
				if (request.url === '/request') {
					response.setHeader('Content-Type', 'application/x-ndjson');
					response.end(
						JSON.stringify({
							type: 'response',
							response: {
								status: 200,
								contentType: 'application/json',
								encoding: 'text',
								body: '{}',
							},
						}) + '\n',
					);
					return;
				}
				json(response, { ok: true });
			});
		});
		const client = await paired(url);
		const request = {
			...imageRequest(),
			path: '/images/edits',
			body: { image: `data:image/png;base64,${PNG}` },
		};
		await expect(client.request(request, () => {})).resolves.toHaveProperty('status', 200);
		const tool = {
			runId: 'run',
			threadId: 'thread',
			name: 'image_gen.imagegen',
			arguments: { prompt: 'Change the background', num_last_images_to_include: 1 },
		};
		await expect(client.tools('execute', tool)).resolves.toEqual({ ok: true });
		expect(calls[0].input).toHaveProperty('path', '/images/edits');
		expect(calls[0].input).toHaveProperty('body', request.body);
		expect(calls[1]).toEqual({ route: '/tools/execute', input: tool });
	});
});

describe('remote host media guard through localhost providers', () => {
	it.each(['body', 'form'] as const)(
		'blocks contextual person-to-nudity video %s references at Low before the provider receives a job',
		async (transport) => {
			const calls: { route: string; body: Record<string, unknown> }[] = [];
			const labels = {
				...clean,
				input_contains_person: true,
				edit_sexual_content: false,
				edit_nudity: true,
			};
			const provider = await server((request, response) => {
				void body(request).then((input) => {
					calls.push({ route: request.url!, body: input });
					if (request.url === '/v1/responses') return evaluation(response, labels);
					json(response, { id: 'should-not-be-created', status: 'queued' });
				});
			});
			const configured = state(provider + '/v1');
			configured.moderation.video.level = 'low';
			const instance = await host(configured);
			const prompt = 'By the end of the video, the top has been completely removed.';
			const request: WireRequest = {
				...imageRequest(),
				path: '/videos',
				...(transport === 'body'
					? { body: { model: 'video', prompt, input_reference: `data:image/png;base64,${PNG}` } }
					: {
							body: undefined,
							form: [
								{ name: 'model', value: 'video' },
								{ name: 'prompt', value: prompt },
								{
									name: 'input_reference',
									file: { name: 'reference.png', type: 'image/png', base64: PNG },
								},
							],
						}),
			};
			await expect(instance.client.request(request, () => {})).rejects.toThrow(
				/Video edit blocked by low moderation/,
			);
			expect(calls).toHaveLength(1);
			expect(calls[0].route).toBe('/v1/responses');
			expect(calls[0].body).toMatchObject({
				model: 'evaluate-video',
				text: {
					format: {
						type: 'json_schema',
						strict: true,
						schema: {
							type: 'object',
							properties: Object.fromEntries(
								Object.keys(labels).map((key) => [key, { type: 'boolean' }]),
							),
							required: Object.keys(labels),
							additionalProperties: false,
						},
					},
				},
				input: expect.arrayContaining([
					expect.objectContaining({
						role: 'user',
						content: expect.arrayContaining([
							{ type: 'input_image', image_url: `data:image/png;base64,${PNG}` },
							expect.objectContaining({
								type: 'input_text',
								text: expect.stringContaining(prompt),
							}),
						]),
					}),
				]),
			});
		},
	);
	it.each(['clean', 'prompt-denied', 'output-denied', 'disabled'] as const)(
		'enforces %s policy at the host before returning generated image assets',
		async (scenario) => {
			const calls: { route: string; body: Record<string, unknown> }[] = [];
			let evaluations = 0;
			const provider = await server((request, response) => {
				void body(request)
					.then((input) => {
						calls.push({ route: request.url!, body: input });
						if (request.url === '/v1/images/generations')
							return json(response, { data: [{ b64_json: PNG }] });
						if (request.url === '/v1/responses') {
							evaluations++;
							const denied =
								(scenario === 'prompt-denied' && evaluations === 1) ||
								(scenario === 'output-denied' && evaluations === 2);
							return evaluation(response, { ...clean, gore: denied });
						}
						response.writeHead(404).end();
					})
					.catch(() => response.writeHead(500).end());
			});
			const configured = state(provider + '/v1');
			configured.moderation!.image.enabled = scenario !== 'disabled';
			const instance = await host(configured);
			const request = imageRequest();
			const chunks: string[] = [];
			const pending = instance.client.request(request, (chunk) => chunks.push(chunk));
			if (scenario === 'prompt-denied' || scenario === 'output-denied') {
				await expect(pending).rejects.toThrow(/blocked.*gore/i);
				expect(chunks).toEqual([]);
			} else {
				const response = await pending;
				expect(response.status).toBe(200);
				expect(JSON.parse(response.body).data[0].b64_json).toBe(PNG);
			}
			expect(calls).toHaveLength(scenario === 'clean' || scenario === 'output-denied' ? 3 : 1);
			const generation = calls.find((call) => call.route === '/v1/images/generations');
			if (scenario === 'prompt-denied') expect(generation).toBeUndefined();
			else expect(generation!.body).toEqual(request.body);
			if (scenario !== 'disabled') {
				expect(JSON.stringify(calls[0].body)).not.toContain('"level":"high"');
				expect(calls[0].body.model).toBe('evaluate-image');
				for (const call of calls.filter((call) => call.route === '/v1/responses')) {
					expect(call.body.text).toEqual({
						format: {
							type: 'json_schema',
							name: 'freelm_moderation',
							strict: true,
							schema: outputSchema,
						},
					});
					expect(call.body).not.toHaveProperty('response_format');
				}
			}
			if (evaluations === 2)
				expect(JSON.stringify(calls[2].body)).toContain(`data:image/png;base64,${PNG}`);
		},
	);
	it('continues on an updated host with a warning when default evaluators are unconfigured', async () => {
		let providerCalls = 0;
		const provider = await server((_request, response) => {
			providerCalls++;
			json(response, { data: [{ b64_json: PNG }] });
		});
		const unconfigured = state(provider + '/v1');
		unconfigured.moderation = defaultModerationSettings();
		const instance = await host(unconfigured);
		const response = await instance.client.request(imageRequest(), () => {});
		expect(JSON.parse(response.body)).toEqual({ data: [{ b64_json: PNG }] });
		expect(response.moderationWarnings).toHaveLength(1);
		expect(response.moderationWarnings![0]).toMatch(/without image moderation/i);
		expect(providerCalls).toBe(1);
	});
	it('returns only a video warning while a separately configured image evaluator still checks both stages', async () => {
		const calls: string[] = [];
		const provider = await server((request, response) => {
			void body(request)
				.then((input) => {
					calls.push(request.url!);
					if (request.url === '/v1/responses') {
						expect(input.text).toEqual({
							format: {
								type: 'json_schema',
								name: 'freelm_moderation',
								strict: true,
								schema: outputSchema,
							},
						});
						return evaluation(response, clean);
					}
					if (request.url === '/v1/images/generations')
						return json(response, { data: [{ b64_json: PNG }] });
					if (request.url === '/v1/videos') return json(response, { id: 'job', status: 'queued' });
					response.writeHead(404).end();
				})
				.catch(() => response.writeHead(500).end());
		});
		const configured = state(provider + '/v1');
		configured.moderation.video = defaultModerationSettings().video;
		const instance = await host(configured);
		const image = await instance.client.request(imageRequest(), () => {});
		expect(image.moderationWarnings).toBeUndefined();
		const video = await instance.client.request(
			{
				...imageRequest(),
				id: crypto.randomUUID(),
				path: '/videos',
				body: { model: 'video', prompt: 'A quiet scene' },
			},
			() => {},
		);
		expect(video.moderationWarnings).toHaveLength(1);
		expect(video.moderationWarnings![0]).toMatch(/without video moderation/i);
		expect(JSON.parse(video.body)).toEqual({ id: 'job', status: 'queued' });
		expect(calls).toEqual([
			'/v1/responses',
			'/v1/images/generations',
			'/v1/responses',
			'/v1/videos',
		]);
	});
	it('moderates sampled frames on the remote host with its image-capable model before returning video bytes', async () => {
		const video = Buffer.from('\x00\x00\x00\x18ftypisomremote-video', 'binary');
		let closed = false;
		vi.spyOn(videoFrames, 'extractDesktopModerationVideoFrames').mockImplementation(
			async function* (asset) {
				expect(asset).toBe(`data:video/mp4;base64,${video.toString('base64')}`);
				try {
					for (let timestamp = 0; timestamp < 3; timestamp++)
						yield { timestamp, image: `data:image/png;base64,${PNG}` };
				} finally {
					closed = true;
				}
			},
		);
		const calls: Record<string, unknown>[] = [];
		let denyLast = false;
		const provider = await server((request, response) => {
			if (request.url === '/v1/videos/clip/content') {
				response.setHeader('content-type', 'video/mp4');
				response.end(video);
				return;
			}
			void body(request)
				.then((input) => {
					calls.push(input);
					expect(request.url).toBe('/v1/responses');
					expect(input.model).toBe('evaluate-video');
					expect(JSON.stringify(input)).toContain('input_image');
					expect(JSON.stringify(input)).not.toContain(video.toString('base64'));
					expect(input.text).toMatchObject({ format: { type: 'json_schema', strict: true } });
					evaluation(response, {
						...clean,
						gore: denyLast && JSON.stringify(input).includes('sampled at 2 seconds'),
					});
				})
				.catch(() => response.writeHead(500).end());
		});
		const instance = await host(state(provider + '/v1'));
		const request: WireRequest = {
			...imageRequest(),
			method: 'GET',
			path: '/videos/clip/content',
			body: undefined,
		};
		const result = await instance.client.request(request, () => {});
		expect(result.body).toBe(video.toString('base64'));
		expect(calls).toHaveLength(3);
		expect(closed).toBe(true);
		closed = false;
		denyLast = true;
		await expect(
			instance.client.request({ ...request, id: crypto.randomUUID() }, () => {}),
		).rejects.toThrow(/Video output blocked/);
		expect(calls).toHaveLength(6);
		expect(closed).toBe(true);
	});
});
