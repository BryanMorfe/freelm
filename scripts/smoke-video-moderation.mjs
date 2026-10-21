import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createCanvas, loadImage } from '@napi-rs/canvas';

// Real desktop transport and sandboxed Chromium decoder; only loopback mock inference.
// The 3.25 s fixture is red/green/blue/yellow at t=0/1/2/3, encoded as H.264 MP4.
const profile = await mkdtemp(path.join(os.tmpdir(), 'freelm-video-moderation-'));
const video = await readFile(new URL('../tests/fixtures/moderation-samples.mp4', import.meta.url));
const referencePng =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const referenceAvif = await readFile(new URL('../tests/fixtures/reference.avif', import.meta.url));
let reference = {
	name: 'reference.png',
	type: 'image/png',
	dataUrl: `data:image/png;base64,${referencePng}`,
};
const clean = Object.fromEntries(
	[
		'ncii',
		'sexual_minors',
		'violent_minors',
		'sexual_content',
		'artistic_nudity',
		'nudity',
		'gore',
	].map((k) => [k, false]),
);
let mode = 'clean';
let seen = [];
let inputChecks = 0;
let referenceChecks = 0;
let expectReference = false;
const videoRequests = [];
const failures = [];
const provider = createServer(async (request, response) => {
	try {
		if (request.url === '/v1/videos' && request.method === 'POST') {
			const chunks = [];
			for await (const chunk of request) chunks.push(chunk);
			const formBytes = Buffer.concat(chunks);
			const form = formBytes.toString();
			assert.match(request.headers['content-type'], /multipart\/form-data/);
			assert.ok(form.includes('A short color sequence for the video tool.'));
			assert.ok(form.includes('name="model"\r\n\r\nvideo'));
			assert.ok(
				form.includes('name="size"\r\n\r\n1280x736'),
				'Legacy blank tool settings must still send an explicit size',
			);
			assert.equal(inputChecks, 1, 'Input moderation must run before submitting the video job');
			if (expectReference) {
				assert.equal(referenceChecks, 1, 'Reference images must be classified before generation');
				assert.ok(form.includes(`name="input_reference"; filename="${reference.name}"`));
				assert.ok(form.includes(`Content-Type: ${reference.type}`));
				assert.ok(formBytes.includes(Buffer.from(reference.dataUrl.split(',')[1], 'base64')));
			}
			videoRequests.push('create');
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(JSON.stringify({ id: 'clip', status: 'queued' }));
			return;
		}
		if (request.url === '/v1/videos/clip') {
			videoRequests.push('poll');
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(JSON.stringify({ id: 'clip', status: 'completed' }));
			return;
		}
		if (request.url === '/v1/videos/clip/content') {
			videoRequests.push('content');
			response.writeHead(200, { 'content-type': 'video/mp4' });
			response.end(video);
			return;
		}
		if (request.url !== '/v1/responses') {
			response.writeHead(404);
			response.end();
			return;
		}
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		const body = JSON.parse(Buffer.concat(chunks).toString());
		assert.equal(body.text.format.type, 'json_schema');
		assert.equal(body.text.format.strict, true);
		assert.equal(body.model, 'image-evaluator');
		assert.equal(body.reasoning.effort, 'low');
		const parts = body.input[1].content;
		if (body.text.format.schema.required.includes('edit_nudity')) {
			assert.equal(body.text.format.schema.required.length, 10);
			assert.equal(body.text.format.schema.additionalProperties, false);
			assert.equal(parts.length, 2, 'Input classifier must see both the prompt and reference');
			assert.equal(parts[1].type, 'input_image');
			assert.equal(parts[1].image_url, reference.dataUrl);
			assert.ok(
				parts[0].text.includes(
					mode === 'deny-reference'
						? 'The top has been completely removed'
						: 'A short color sequence for the video tool.',
				),
			);
			inputChecks++;
			referenceChecks++;
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(
				JSON.stringify({
					status: 'completed',
					output: [
						{
							type: 'message',
							role: 'assistant',
							status: 'completed',
							content: [
								{
									type: 'output_text',
									text: JSON.stringify({
										...clean,
										input_contains_person: true,
										edit_sexual_content: false,
										edit_nudity: mode === 'deny-reference',
									}),
								},
							],
						},
					],
				}),
			);
			return;
		}
		if (parts.length === 1) {
			assert.equal(parts[0].type, 'input_text');
			assert.ok(parts[0].text.includes('A short color sequence for the video tool.'));
			inputChecks++;
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(
				JSON.stringify({
					status: 'completed',
					output: [
						{
							type: 'message',
							role: 'assistant',
							status: 'completed',
							content: [{ type: 'output_text', text: JSON.stringify(clean) }],
						},
					],
				}),
			);
			return;
		}
		const timestamp = Number(parts[0].text.match(/sampled at (\d+) seconds/)?.[1]);
		assert.equal(timestamp, seen.length);
		assert.equal(parts.length, 2);
		assert.equal(parts[1].type, 'input_image');
		assert.ok(!JSON.stringify(body).includes(video.toString('base64')));
		const image = await loadImage(parts[1].image_url);
		assert.equal(image.width, 64);
		assert.equal(image.height, 48);
		const canvas = createCanvas(1, 1),
			context = canvas.getContext('2d');
		context.drawImage(image, 0, 0, 1, 1);
		const pixel = Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
		const expected = [
			[255, 0, 0],
			[0, 128, 0],
			[0, 0, 255],
			[255, 255, 0],
		][timestamp];
		assert.ok(
			pixel.every((value, index) => Math.abs(value - expected[index]) < 8),
			`Frame ${timestamp}: ${pixel}`,
		);
		seen.push({ timestamp, pixel });
		const labels = { ...clean, gore: mode === 'deny-last' && timestamp === 3 };
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end(
			JSON.stringify({
				status: 'completed',
				output: [
					{
						type: 'message',
						role: 'assistant',
						status: 'completed',
						content: [{ type: 'output_text', text: JSON.stringify(labels) }],
					},
				],
			}),
		);
	} catch (error) {
		failures.push(error.stack);
		response.writeHead(500);
		response.end('Fixture failed');
	}
});
let app;
try {
	await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
	const baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;
	const config = {
		format: 'freelm-config-v1',
		version: 1,
		encryptedKeys: {},
		theme: 'dark',
		backgroundNotifications: false,
		activeConnectionId: 'fixture',
		connections: [
			{
				id: 'fixture',
				name: 'Fixture',
				baseUrl,
				apiKey: '',
				chatApi: 'responses',
				discoveredModels: [],
				models: {
					chat: 'image-evaluator',
					images: '',
					videos: 'video',
					speech: '',
					transcription: '',
				},
				catalog: [
					{
						id: 'image-evaluator',
						name: 'Image evaluator',
						enabled: true,
						tasks: ['chat'],
						inputModalities: ['text', 'image'],
						outputModalities: ['text'],
						thinkingModes: [
							{
								id: 'low',
								name: 'Low',
								parameters: { responses: { reasoning: { effort: 'low' } } },
							},
						],
						defaultThinkingMode: 'low',
					},
					{
						id: 'video',
						name: 'Video generator',
						enabled: true,
						tasks: ['videos'],
						inputModalities: ['text', 'image'],
						outputModalities: ['video'],
						thinkingModes: [],
					},
				],
			},
		],
		moderation: {
			image: { enabled: false, level: 'low', connectionId: '', model: '' },
			video: {
				enabled: true,
				level: 'high',
				connectionId: 'fixture',
				model: 'image-evaluator',
				thinkingMode: 'low',
				videoApi: 'chat',
			},
		},
	};
	await writeFile(path.join(profile, 'config.json'), JSON.stringify(config));
	await writeFile(
		path.join(profile, 'workspace.json'),
		JSON.stringify({
			format: 'freelm-workspace-v2',
			version: 1,
			threads: [],
			projects: [],
			generations: [],
		}),
	);
	const initialModified = (await stat(path.join(profile, 'config.json'))).mtimeMs;
	const env = { ...process.env, FREELM_HOME: profile, FREELM_USER_DATA: profile };
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.FREELM_DEV_URL;
	app = await electron.launch({
		// Packaged builds ignore FREELM_USER_DATA. Isolate Chromium's profile and
		// single-instance lock explicitly, independently of FREELM_HOME's data path.
		args: process.env.FREELM_SMOKE_EXECUTABLE
			? [`--user-data-dir=${path.join(profile, 'electron')}`]
			: ['.'],
		executablePath: process.env.FREELM_SMOKE_EXECUTABLE,
		env,
	});
	const page = await app.firstWindow();
	await expect
		.poll(async () => (await stat(path.join(profile, 'config.json'))).mtimeMs, { timeout: 30000 })
		.not.toBe(initialModified);
	const download = () =>
		page.evaluate(async (baseUrl) => {
			try {
				return {
					response: await window.desktop.request({
						id: crypto.randomUUID(),
						connectionId: 'fixture',
						baseUrl,
						apiKey: '',
						method: 'GET',
						path: '/videos/clip/content',
					}),
				};
			} catch (error) {
				return { error: error.message };
			}
		}, baseUrl);
	const result = await download();
	assert.equal(result.error, undefined, result.error || failures.join('\n'));
	assert.equal(result.response.body, video.toString('base64'));
	assert.deepEqual(
		seen.map((frame) => frame.timestamp),
		[0, 1, 2, 3],
	);
	assert.equal(
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
		1,
		'Decoder window must be destroyed after success',
	);
	mode = 'deny-last';
	seen = [];
	const denied = await download();
	assert.match(denied.error, /Video output blocked by high moderation/);
	assert.equal(denied.response, undefined);
	assert.deepEqual(
		seen.map((frame) => frame.timestamp),
		[0, 1, 2, 3],
	);
	assert.equal(
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
		1,
		'Decoder window must be destroyed after denial',
	);
	mode = 'clean';
	seen = [];
	videoRequests.length = 0;
	const generated = await page.evaluate(async () => {
		const state = await window.desktop.load();
		const threadId = 'video-tool-smoke',
			runId = 'video-tool-smoke-run';
		state.threads.push({
			id: threadId,
			kind: 'chat',
			title: 'Video tool fixture',
			connectionId: 'fixture',
			model: 'image-evaluator',
			thinkingMode: 'low',
			createdAt: Date.now(),
			updatedAt: Date.now(),
			messages: [],
		});
		state.toolSettings = {
			...state.toolSettings,
			enabled: false,
			commandExecution: false,
			workspaceRoot: '',
			approvalMode: 'ask',
			allowRemote: false,
			imageGeneration: { enabled: false, connectionId: '', model: '', size: '', quality: '' },
			videoGeneration: {
				enabled: true,
				connectionId: 'fixture',
				model: 'video',
				size: '',
				seconds: '3.25',
			},
			mcpServers: [],
			skillDirectories: [],
		};
		await window.desktop.save(state);
		try {
			const catalog = await window.desktop.toolCatalog('local', runId, threadId);
			if (!catalog.tools.some((tool) => tool.name === 'video_gen.videogen'))
				throw new Error('Video generation tool is missing from the Chat catalog.');
			const result = await window.desktop.toolExecute({
				workspaceId: 'local',
				runId,
				threadId,
				name: 'video_gen.videogen',
				arguments: { prompt: 'A short color sequence for the video tool.' },
			});
			return { result };
		} catch (error) {
			return { error: error.message };
		} finally {
			await window.desktop.toolCancel(runId);
		}
	});
	assert.equal(generated.error, undefined, generated.error || failures.join('\n'));
	const file = generated.result.content.find((part) => part.type === 'file');
	assert.ok(file, 'Video tool must return the completed video file');
	assert.equal(file.mimeType, 'video/mp4');
	assert.equal(file.dataUrl, `data:video/mp4;base64,${video.toString('base64')}`);
	assert.match(file.name, /^generated-video-.+\.mp4$/);
	assert.equal(inputChecks, 1);
	assert.deepEqual(videoRequests, ['create', 'poll', 'content']);
	assert.deepEqual(
		seen.map((frame) => frame.timestamp),
		[0, 1, 2, 3],
	);
	assert.equal(
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
		1,
		'Tool completion must release its decoder',
	);
	const generateWithReference = (prompt) =>
		page.evaluate(
			async ({ prompt, reference }) => {
				const state = await window.desktop.load();
				state.moderation.video.level = 'low';
				await window.desktop.save(state);
				const runId = crypto.randomUUID();
				try {
					await window.desktop.toolCatalog('local', runId, 'video-tool-smoke');
					return {
						result: await window.desktop.toolExecute({
							workspaceId: 'local',
							runId,
							threadId: 'video-tool-smoke',
							name: 'video_gen.videogen',
							arguments: { prompt, num_last_images_to_include: 1 },
							recentImages: [reference],
						}),
					};
				} catch (error) {
					return { error: error.message };
				} finally {
					await window.desktop.toolCancel(runId);
				}
			},
			{ prompt, reference },
		);
	mode = 'deny-reference';
	expectReference = true;
	inputChecks = referenceChecks = 0;
	videoRequests.length = 0;
	seen = [];
	const blockedReference = await generateWithReference('The top has been completely removed');
	assert.match(blockedReference.error, /Video .* blocked by low moderation/);
	assert.equal(blockedReference.result, undefined);
	assert.equal(referenceChecks, 1);
	assert.deepEqual(
		videoRequests,
		[],
		'A rejected reference-based request must never reach generation',
	);
	assert.deepEqual(seen, []);
	mode = 'clean';
	inputChecks = referenceChecks = 0;
	const allowedReference = await generateWithReference(
		'A short color sequence for the video tool.',
	);
	assert.equal(allowedReference.error, undefined, allowedReference.error || failures.join('\n'));
	assert.equal(referenceChecks, 1);
	assert.deepEqual(videoRequests, ['create', 'poll', 'content']);
	assert.deepEqual(
		seen.map((frame) => frame.timestamp),
		[0, 1, 2, 3],
	);
	assert.ok(
		allowedReference.result.content.some(
			(part) => part.type === 'file' && part.mimeType === 'video/mp4',
		),
	);
	reference = {
		name: 'reference.avif',
		type: 'image/avif',
		dataUrl: `data:image/avif;base64,${referenceAvif.toString('base64')}`,
	};
	mode = 'deny-reference';
	inputChecks = referenceChecks = 0;
	videoRequests.length = 0;
	seen = [];
	const blockedAvif = await generateWithReference('The top has been completely removed');
	assert.match(blockedAvif.error, /Video .* blocked by low moderation/);
	assert.equal(referenceChecks, 1, 'AVIF must reach contextual moderation through desktop IPC');
	assert.deepEqual(videoRequests, [], 'A denied AVIF reference must never reach generation');
	mode = 'clean';
	inputChecks = referenceChecks = 0;
	const allowedAvif = await generateWithReference('A short color sequence for the video tool.');
	assert.equal(allowedAvif.error, undefined, allowedAvif.error || failures.join('\n'));
	assert.equal(referenceChecks, 1);
	assert.deepEqual(videoRequests, ['create', 'poll', 'content']);
	assert.deepEqual(
		seen.map((frame) => frame.timestamp),
		[0, 1, 2, 3],
	);
	assert.deepEqual(failures, []);
	console.log(
		'Video moderation passed: real MP4 frames at 0/1/2/3 seconds, exact pixels, image-only model, strict Responses schema, identical output bytes, late-frame denial, decoder cleanup, Chat video tool pipeline, joint PNG/AVIF prompt/reference classification, and Low-level reference denial before generation.',
	);
} finally {
	await app?.close();
	await new Promise((resolve) => {
		provider.close(resolve);
		provider.closeAllConnections();
	});
	await rm(profile, { recursive: true, force: true });
}
