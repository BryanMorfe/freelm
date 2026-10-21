import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile, writeFile, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { deflateSync, inflateSync } from 'node:zlib';

// Real desktop bridge, isolated profile, localhost mock providers and benign fixtures.
const profile = await mkdtemp(path.join(os.tmpdir(), 'freelm-moderation-smoke-'));
const labels = {
	ncii: false,
	sexual_minors: false,
	violent_minors: false,
	sexual_content: false,
	artistic_nudity: false,
	nudity: false,
	gore: false,
};
const strictOutputFormat = {
	type: 'json_schema',
	json_schema: {
		name: 'freelm_moderation',
		strict: true,
		schema: {
			type: 'object',
			properties: Object.fromEntries(Object.keys(labels).map((key) => [key, { type: 'boolean' }])),
			required: Object.keys(labels),
			additionalProperties: false,
		},
	},
};
const editLabels = {
	...labels,
	input_contains_person: true,
	edit_sexual_content: false,
	edit_nudity: false,
};
const strictEditInputFormat = {
	type: 'json_schema',
	json_schema: {
		name: 'freelm_image_edit_moderation',
		strict: true,
		schema: {
			type: 'object',
			properties: Object.fromEntries(
				Object.keys(editLabels).map((key) => [key, { type: 'boolean' }]),
			),
			required: Object.keys(editLabels),
			additionalProperties: false,
		},
	},
};
const png =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFioAAAAASUVORK5CYII=';
function pngChunk(type, data) {
	const chunk = Buffer.alloc(data.length + 12);
	chunk.writeUInt32BE(data.length);
	chunk.write(type, 4, 'ascii');
	data.copy(chunk, 8);
	let crc = 0xffffffff;
	for (const byte of chunk.subarray(4, data.length + 8)) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
	}
	chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, data.length + 8);
	return chunk;
}
function storedPng() {
	const width = 1024,
		height = 512;
	const scanlines = Buffer.alloc((width * 4 + 1) * height);
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++) {
			const offset = y * (width * 4 + 1) + 1 + x * 4;
			scanlines[offset] = x % 256;
			scanlines[offset + 1] = y % 256;
			scanlines[offset + 2] = (x + y) % 256;
			scanlines[offset + 3] = x % 2 ? 64 : 255;
		}
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 6;
	return {
		scanlines,
		bytes: Buffer.concat([
			Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'),
			pngChunk('IHDR', header),
			pngChunk('tEXt', Buffer.from('Author\0FreeLM native lossless moderation fixture')),
			pngChunk('IDAT', deflateSync(scanlines, { level: 0 })),
			pngChunk('IEND', Buffer.alloc(0)),
		]),
	};
}
function pngChunks(bytes) {
	const chunks = [];
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
const largePng = storedPng(),
	largePngBase64 = largePng.bytes.toString('base64');
assert.ok(largePng.bytes.length > 2 * 1024 * 1024);
const video = await readFile(new URL('../tests/fixtures/moderation-samples.mp4', import.meta.url));
let mode = 'clean',
	generated = 0,
	edited = 0,
	inspected = 0;
const seen = [];
const fixtureErrors = [];
let normalizedImageBytes;
const provider = createServer(async (request, response) => {
	try {
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		const source = Buffer.concat(chunks).toString();
		if (request.url === '/v1/chat/completions') {
			const body = JSON.parse(source);
			assert.equal(body.stream, false);
			assert.deepEqual(body.reasoning_effort, 'low');
			assert.equal(body.tools, undefined);
			const editInput = body.response_format?.json_schema?.name === 'freelm_image_edit_moderation';
			assert.deepEqual(
				body.response_format,
				editInput ? strictEditInputFormat : strictOutputFormat,
			);
			assert.equal(body.text, undefined);
			const output =
				!editInput &&
				body.messages[1].content.some(
					(part) => part.type === 'image_url' || part.type === 'video_url',
				);
			if (output) inspected++;
			seen.push({ output, editInput, body });
			if (editInput) {
				const references = body.messages[1].content.filter((part) => part.type === 'image_url');
				assert.equal(references.length, 1, 'Native image-edit input must include its reference');
				assert.equal(references[0].image_url.url, `data:image/png;base64,${png}`);
				assert.match(body.messages[0].content, /JOINT input evaluation/);
				assert.match(body.messages[0].content, /EXPECTED EDITED RESULT/);
				assert.ok(
					body.messages[1].content.some(
						(part) =>
							part.type === 'text' &&
							part.text.includes(
								mode === 'edit-deny-input'
									? 'The top has been completely removed'
									: 'Replace the background with a garden; keep the shirt opaque',
							),
					),
					'Native image-edit input must jointly classify the edit request',
				);
			}
			if (mode === 'large-png' && output) {
				const url = body.messages[1].content.find((part) => part.type === 'image_url').image_url
					.url;
				assert.ok(url.startsWith('data:image/png;base64,'));
				const bytes = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
				normalizedImageBytes = bytes.length;
				assert.ok(
					bytes.length < largePng.bytes.length / 2,
					'Native host must losslessly reduce the large PNG moderation payload',
				);
				const chunks = pngChunks(bytes);
				assert.deepEqual(
					inflateSync(
						Buffer.concat(
							chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data),
						),
					),
					largePng.scanlines,
					'Native normalization must preserve every scanline and alpha byte',
				);
				assert.deepEqual(
					chunks.filter((chunk) => chunk.type !== 'IDAT').map((chunk) => chunk.raw),
					pngChunks(largePng.bytes)
						.filter((chunk) => chunk.type !== 'IDAT')
						.map((chunk) => chunk.raw),
					'Native normalization must preserve PNG dimensions and metadata chunks',
				);
			}
			if (mode === 'unsupported-schema') {
				response.writeHead(400, { 'content-type': 'application/json' });
				response.end(JSON.stringify({ error: { message: 'Strict JSON schema is unsupported' } }));
				return;
			}
			if (mode === 'output-too-large' && output) {
				response.writeHead(413, { 'content-type': 'application/json' });
				response.end(
					JSON.stringify({
						error: {
							code: 'request_too_large',
							message: 'Evaluator request exceeds the 20 MiB limit.',
						},
					}),
				);
				return;
			}
			const result = {
				...(editInput ? editLabels : labels),
				ncii: mode === 'deny-input' && !output,
				gore: mode === 'deny-output' && output,
				nudity:
					(mode === 'edit-deny-input' && editInput) || (mode === 'edit-deny-output' && output),
				...(editInput ? { edit_nudity: mode === 'edit-deny-input' } : {}),
			};
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(
				JSON.stringify({
					choices: [
						{
							finish_reason: 'stop',
							message: {
								role: 'assistant',
								content: mode === 'invalid' ? '{}' : JSON.stringify(result),
							},
						},
					],
				}),
			);
		} else if (request.url === '/v1/images/generations') {
			generated++;
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(
				JSON.stringify({ data: [{ b64_json: mode === 'large-png' ? largePngBase64 : png }] }),
			);
		} else if (request.url === '/v1/images/edits') {
			edited++;
			assert.match(request.headers['content-type'], /multipart\/form-data/);
			assert.ok(source.includes('reference.png'), 'Reference image must reach the edit provider');
			assert.ok(source.includes('keep the shirt opaque'), 'Edit instruction must be preserved');
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(JSON.stringify({ data: [{ b64_json: png }] }));
		} else if (request.url === '/v1/videos') {
			generated++;
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(JSON.stringify({ id: 'clip', status: 'completed', progress: 100 }));
		} else if (request.url === '/v1/videos/clip/content') {
			response.writeHead(200, { 'content-type': 'video/mp4' });
			response.end(video);
		} else {
			response.writeHead(404);
			response.end();
		}
	} catch (error) {
		fixtureErrors.push(error.message.slice(0, 1000));
		response.writeHead(500);
		response.end('Fixture failed');
	}
});
let app;
try {
	await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
	const baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;
	const seed = {
		version: 1,
		codeCompaction: { thresholdPercent: 90, reserveTokens: 32000 },
		backgroundNotifications: false,
		activeConnectionId: 'mock',
		theme: 'dark',
		threads: [],
		projects: [],
		generations: [],
		connections: [
			{
				id: 'mock',
				name: 'Mock',
				baseUrl,
				apiKey: '',
				chatApi: 'chat/completions',
				discoveredModels: [],
				models: { chat: 'vlm', images: 'image', videos: 'video', speech: '', transcription: '' },
				catalog: [
					{
						id: 'vlm',
						name: 'VLM',
						enabled: true,
						tasks: ['chat'],
						inputModalities: ['text', 'image'],
						outputModalities: ['text'],
						thinkingModes: [
							{ id: 'low', name: 'Low', parameters: { chat: { reasoning_effort: 'low' } } },
						],
						defaultThinkingMode: 'low',
					},
				],
			},
		],
	};
	const { threads, projects, generations, ...config } = seed;
	await writeFile(
		path.join(profile, 'config.json'),
		JSON.stringify({ format: 'freelm-config-v1', ...config, encryptedKeys: {} }),
		{ mode: 0o600 },
	);
	await writeFile(
		path.join(profile, 'workspace.json'),
		JSON.stringify({ format: 'freelm-workspace-v2', version: 1, threads, projects, generations }),
		{ mode: 0o600 },
	);
	const seedModified = (await stat(path.join(profile, 'config.json'))).mtimeMs;
	const env = { ...process.env, FREELM_USER_DATA: profile };
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.FREELM_DEV_URL;
	delete env.FREELM_HOME;
	app = await electron.launch({ args: ['.'], env });
	const page = await app.firstWindow();
	await expect(page.getByRole('combobox', { name: 'Conversation mode', exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
	// Wait for the renderer's initial debounced save before manual bridge-only checks.
	await expect
		.poll(async () => (await stat(path.join(profile, 'config.json'))).mtimeMs)
		.not.toBe(seedModified);
	const generate = (kind = 'image') =>
		page.evaluate(
			async ({ baseUrl, kind }) => {
				try {
					const response = await window.desktop.request({
						id: crypto.randomUUID(),
						connectionId: 'mock',
						baseUrl,
						apiKey: '',
						method: 'POST',
						path: kind === 'image' ? '/images/generations' : '/videos',
						body: { model: kind, prompt: 'A small sailboat on a calm lake' },
					});
					return { response };
				} catch (error) {
					return { error: error.message };
				}
			},
			{ baseUrl, kind },
		);
	const unconfigured = await generate();
	assert.equal(JSON.parse(unconfigured.response.body).data[0].b64_json, png);
	assert.equal(unconfigured.response.moderationWarnings.length, 1);
	assert.match(unconfigured.response.moderationWarnings[0], /without image moderation/i);
	assert.equal(generated, 1);
	assert.equal(seen.length, 0);
	await page.evaluate(async () => {
		const state = await window.desktop.load();
		state.moderation = {
			image: {
				enabled: true,
				level: 'high',
				connectionId: 'mock',
				model: 'vlm',
				thinkingMode: 'low',
			},
			video: {
				enabled: true,
				level: 'low',
				connectionId: 'mock',
				model: 'vlm',
				thinkingMode: 'low',
				videoApi: 'chat/completions',
			},
		};
		await window.desktop.save(state);
	});
	mode = 'deny-input';
	assert.match((await generate()).error, /prompt blocked by high moderation/);
	assert.equal(generated, 1);
	mode = 'invalid';
	assert.match((await generate()).error, /invalid category JSON/);
	assert.equal(generated, 1);
	mode = 'unsupported-schema';
	assert.match((await generate()).error, /strict JSON[- ]schema/i);
	assert.equal(generated, 1);
	mode = 'output-too-large';
	const mediaFiles = async () =>
		readdir(path.join(profile, 'media'), { recursive: true }).catch((error) => {
			if (error.code === 'ENOENT') return [];
			throw error;
		});
	const beforeDeniedToolMedia = await mediaFiles();
	const deniedTool = await page.evaluate(async () => {
		const state = await window.desktop.load();
		const threadId = 'moderation-tool-fixture',
			runId = 'moderation-tool-run';
		state.threads.push({
			id: threadId,
			kind: 'chat',
			title: 'Moderation tool fixture',
			connectionId: 'mock',
			model: 'vlm',
			thinkingMode: 'low',
			createdAt: Date.now(),
			updatedAt: Date.now(),
			messages: [],
		});
		state.toolSettings = {
			enabled: false,
			commandExecution: false,
			workspaceRoot: '',
			approvalMode: 'ask',
			allowRemote: false,
			imageGeneration: {
				enabled: true,
				connectionId: 'mock',
				model: 'image',
				size: '1024x1024',
				quality: '',
			},
			mcpServers: [],
			skillDirectories: [],
		};
		await window.desktop.save(state);
		try {
			const catalog = await window.desktop.toolCatalog('local', runId, threadId);
			if (!catalog.tools.some((tool) => tool.name === 'image_gen.imagegen'))
				throw new Error('Image tool is unavailable in fixture catalog.');
			const result = await window.desktop.toolExecute({
				workspaceId: 'local',
				runId,
				threadId,
				name: 'image_gen.imagegen',
				arguments: { prompt: 'A small sailboat on a calm lake' },
			});
			return { result };
		} catch (error) {
			return { error: error.message };
		} finally {
			await window.desktop.toolCancel(runId);
		}
	});
	assert.match(deniedTool.error, /output moderation/i);
	assert.match(deniedTool.error, /HTTP 413/);
	assert.match(deniedTool.error, /request_too_large/);
	assert.match(deniedTool.error, /Evaluator request exceeds the 20 MiB limit/);
	assert.equal(deniedTool.result, undefined, 'Rejected output must not return tool media');
	assert.deepEqual(
		await mediaFiles(),
		beforeDeniedToolMedia,
		'Rejected tool output must not persist media files',
	);
	assert.equal(generated, 2);
	mode = 'deny-output';
	const denied = await generate();
	assert.match(denied.error, /output blocked by high moderation/);
	assert.equal(denied.response, undefined);
	assert.equal(generated, 3);
	mode = 'large-png';
	const normalized = await generate();
	assert.equal(normalized.error, undefined, fixtureErrors.join('; ') || normalized.error);
	assert.equal(
		JSON.parse(normalized.response.body).data[0].b64_json,
		largePngBase64,
		'Displayed image must retain the original encoded PNG',
	);
	assert.ok(normalizedImageBytes < largePng.bytes.length / 2);
	mode = 'clean';
	assert.equal(JSON.parse((await generate()).response.body).data[0].b64_json, png);
	// Gore labels are blocked for high image policy, but allowed for low video policy.
	mode = 'deny-output';
	assert.equal(JSON.parse((await generate('video')).response.body).id, 'clip');
	const downloaded = await page.evaluate(
		async (baseUrl) =>
			window.desktop.request({
				id: crypto.randomUUID(),
				connectionId: 'mock',
				baseUrl,
				apiKey: '',
				method: 'GET',
				path: '/videos/clip/content',
			}),
		baseUrl,
	);
	assert.equal(downloaded.body, video.toString('base64'));
	for (const call of seen.filter((call) => call.output))
		assert.ok(
			!JSON.stringify(call.body).includes('small sailboat'),
			'Output evaluator must not receive the prompt',
		);
	assert.ok(
		seen.some((call) =>
			call.body.messages[1].content.some(
				(part) => part.type === 'text' && part.text.includes('sampled at 3 seconds'),
			),
		),
	);
	assert.deepEqual(fixtureErrors, []);
	await page.evaluate(async () => {
		const state = await window.desktop.load();
		state.moderation.image.level = 'low';
		await window.desktop.save(state);
	});
	const edit = () =>
		page.evaluate(
			async ({ baseUrl, png, mode }) => {
				try {
					const response = await window.desktop.request({
						id: crypto.randomUUID(),
						connectionId: 'mock',
						baseUrl,
						apiKey: '',
						method: 'POST',
						path: '/images/edits',
						form: [
							{ name: 'model', value: 'image' },
							{
								name: 'prompt',
								value:
									mode === 'edit-deny-input'
										? 'The top has been completely removed'
										: 'Replace the background with a garden; keep the shirt opaque',
							},
							{ name: 'image', file: { name: 'reference.png', type: 'image/png', base64: png } },
						],
					});
					return { response };
				} catch (error) {
					return { error: error.message };
				}
			},
			{ baseUrl, png, mode },
		);
	mode = 'edit-deny-input';
	const beforeEditCalls = seen.length;
	const deniedEdit = await edit();
	assert.match(deniedEdit.error, /blocked by low moderation/);
	assert.equal(deniedEdit.response, undefined);
	assert.equal(edited, 0, 'Contextual undressing denial must occur before the edit provider');
	assert.equal(seen.length, beforeEditCalls + 1);
	assert.equal(seen.at(-1).editInput, true);
	mode = 'edit-clean';
	const cleanEdit = await edit();
	assert.equal(cleanEdit.error, undefined, fixtureErrors.join('; ') || cleanEdit.error);
	assert.equal(JSON.parse(cleanEdit.response.body).data[0].b64_json, png);
	assert.equal(edited, 1);
	assert.equal(seen.at(-2).editInput, true);
	assert.equal(seen.at(-1).editInput, false);
	assert.equal(
		seen.at(-1).output,
		true,
		'Harmless edits must still receive isolated output review',
	);
	assert.deepEqual(seen.at(-1).body.response_format, strictOutputFormat);
	mode = 'edit-deny-output';
	const driftedEdit = await edit();
	assert.match(driftedEdit.error, /output blocked by low moderation/);
	assert.equal(driftedEdit.response, undefined, 'Unexpected nude output must not escape at Low');
	assert.equal(edited, 2);
	assert.deepEqual(fixtureErrors, []);
	const before = seen.length;
	mode = 'clean';
	await page.evaluate(async () => {
		const state = await window.desktop.load();
		state.moderation.image.enabled = false;
		await window.desktop.save(state);
	});
	assert.equal(JSON.parse((await generate()).response.body).data[0].b64_json, png);
	assert.equal(seen.length, before, 'Disabled moderation must not call evaluator');
	assert.equal(JSON.parse((await generate('video')).response.body).id, 'clip');
	assert.equal(seen.length, before + 1, 'Disabling images must leave video evaluation enabled');
	await page.evaluate(async () => {
		const state = await window.desktop.load();
		state.moderation.video.model = '';
		await window.desktop.save(state);
	});
	const warningVideo = await generate('video');
	assert.equal(JSON.parse(warningVideo.response.body).id, 'clip');
	assert.match(warningVideo.response.moderationWarnings[0], /without video moderation/i);
	assert.equal(seen.length, before + 1, 'Unconfigured video must skip its evaluator');
	const saved = JSON.parse(await readFile(path.join(profile, 'workspace.json'), 'utf8'));
	assert.equal(saved.generations.length, 0);
	assert.ok(
		!JSON.stringify(saved).includes(png),
		'Direct bridge checks never persist denied media',
	);
	console.log(
		JSON.stringify({
			passed: true,
			checks: 15,
			generated,
			edited,
			outputInspections: inspected,
			largeImageOriginalBytes: largePng.bytes.length,
			largeImageEvaluatorBytes: normalizedImageBytes,
			profile: 'isolated',
			providers: 'localhost mocks',
		}),
	);
} finally {
	// Manual bridge writes intentionally bypass the renderer's revision cache. Exit
	// this disposable test process without an unrelated draft-flush conflict dialog.
	await app?.evaluate(({ app }) => app.exit(0)).catch(() => {});
	await app?.close().catch(() => {});
	await new Promise((resolve) => {
		provider.close(resolve);
		provider.closeAllConnections();
	});
	await rm(profile, { recursive: true, force: true });
}
