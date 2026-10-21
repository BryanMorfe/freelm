import { _electron as electron, expect as baseExpect } from '@playwright/test';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

// Run after npm run build. All data, provider calls, and Electron userData are
// temporary. Large fixture files are streamed; never print or inspect full state.
const require = createRequire(import.meta.url);
const expect = baseExpect.configure({ timeout: 60000 });
const directory = await mkdtemp(path.join(os.tmpdir(), 'freelm-chat-image-smoke-'));
const workspaceFile = path.join(directory, 'workspace.json');
const MiB = 1024 * 1024;
const imageChars = 20 * MiB; // Full-resolution result retained locally; API context uses a preview.
const dataPrefix = 'data:image/png;base64,';
const prompt = 'Generate a large fixture image in Chat.';
const imagePrompt = 'Large Chat image regression';
const title = 'Large Chat image';
const finalText = 'Your generated image is ready and saved.';
const unicodeBaseline = 'Existing fixture 🚀日本語';
const png = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAKAAAAB4CAIAAAD6wG44AAABLklEQVR4nO3RAQkAIBDAwC9kU8MawRQijIMLMNisfQib7wU8ZXCcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEXmJqKRaCsQ4gAAAAASUVORK5CYII=',
	'base64',
);
function paddedImage(characters) {
	// Trailing bytes after IEND pad transport/storage while retaining a decodable PNG.
	const bytes = Buffer.alloc((characters / 4) * 3);
	png.copy(bytes);
	return bytes.toString('base64');
}
const generatedImage = paddedImage(imageChars);
const errors = [];
let chatRequests = 0;
let imageRequests = 0;
let titleRequests = 0;
let replayVerified = false;
let desktop;
let page;
let stderr = '';

function textResponse(response, text) {
	response.writeHead(200, { 'content-type': 'text/event-stream' });
	response.end(
		`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n` +
			`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] } })}\n\n`,
	);
}
const provider = createServer(async (request, response) => {
	try {
		const parts = [];
		let bytes = 0;
		for await (const part of request) {
			bytes += part.length;
			assert.ok(bytes < 32 * MiB, 'Unexpectedly large fixture request');
			parts.push(part);
		}
		const body = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
		if (request.url === '/v1/responses')
			assert.ok(bytes < 2 * MiB, 'Chat continuation must fit a 2 MiB provider request limit');
		if (request.url === '/v1/images/generations') {
			imageRequests++;
			assert.equal(body.model, 'large-image-fixture');
			assert.equal(body.prompt, imagePrompt);
			assert.equal(body.size, '1536x864');
			response.writeHead(200, { 'content-type': 'application/json' });
			response.write('{"data":[{"b64_json":"');
			for (let offset = 0; offset < generatedImage.length; offset += MiB) {
				if (!response.write(generatedImage.slice(offset, offset + MiB)))
					await new Promise((resolve) => response.once('drain', resolve));
			}
			response.end('"}]}');
			return;
		}
		assert.equal(request.url, '/v1/responses');
		assert.deepEqual(body.reasoning, { effort: 'low' });
		if (body.instructions?.startsWith('Write a short conversation title')) {
			titleRequests++;
			textResponse(response, title);
			return;
		}
		chatRequests++;
		assert.equal(body.model, 'vision-fixture');
		assert.equal(body.tools.length, 1, 'Chat must expose only the image API tool');
		const tool = body.tools[0];
		assert.match(tool.name, /^image_gen_imagegen_/);
		if (chatRequests === 1) {
			const call = {
				type: 'function_call',
				id: 'image-call-item',
				call_id: 'large-image-call',
				name: tool.name,
				arguments: JSON.stringify({ prompt: imagePrompt, size: '1536x864' }),
				status: 'completed',
			};
			response.writeHead(200, { 'content-type': 'text/event-stream' });
			response.end(
				`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [call] } })}\n\n`,
			);
			return;
		}
		assert.equal(chatRequests, 2, 'Unexpected additional Chat continuation');
		const output = body.input.find(
			(item) => item.type === 'function_call_output' && item.call_id === 'large-image-call',
		);
		const image = output?.output.find((part) => part.type === 'input_image');
		assert.ok(image?.image_url.length <= MiB, 'Generated image vision preview must be bounded');
		assert.match(image.image_url, /^data:image\/(jpeg|webp|png);base64,/);
		assert.notEqual(image.image_url, dataPrefix + generatedImage);
		replayVerified = true;
		textResponse(response, finalText);
	} catch (error) {
		errors.push(`Provider: ${error.message}`);
		if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
		response.end(JSON.stringify({ error: { message: error.message } }));
	}
});

async function seed() {
	const config = {
		// This large-image regression isolates transport/storage, with moderation tested separately.
		moderation: {
			enabled: false,
			level: 'low',
			image: { connectionId: '', model: '' },
			video: { connectionId: '', model: '' },
		},
		format: 'freelm-config-v1',
		version: 1,
		activeConnectionId: 'fixture',
		theme: 'dark',
		encryptedKeys: {},
		connections: [
			{
				id: 'fixture',
				name: 'Large image fixture',
				baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
				apiKey: '',
				chatApi: 'responses',
				models: {
					chat: 'vision-fixture',
					images: 'large-image-fixture',
					videos: '',
					speech: '',
					transcription: '',
				},
				discoveredModels: [],
				catalog: [
					{
						id: 'vision-fixture',
						name: 'vision-fixture',
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
					},
					{
						id: 'large-image-fixture',
						name: 'large-image-fixture',
						enabled: true,
						tasks: ['images'],
						inputModalities: ['text', 'image'],
						outputModalities: ['image'],
						thinkingModes: [],
					},
				],
			},
		],
		toolSettings: {
			enabled: false,
			commandExecution: false,
			workspaceRoot: '',
			approvalMode: 'ask',
			allowRemote: false,
			imageGeneration: {
				enabled: true,
				connectionId: 'fixture',
				model: 'large-image-fixture',
				size: '1024x1024',
				quality: '',
			},
			mcpServers: [],
			skillDirectories: [],
		},
	};
	await writeFile(path.join(directory, 'config.json'), JSON.stringify(config));
	const file = await open(workspaceFile, 'wx', 0o600);
	try {
		await file.writeFile(
			'{"format":"freelm-workspace-v2","version":1,"threads":[],"projects":[],"generations":[',
		);
		// 12 × 20 MiB plus 17 MiB = 257 MiB of existing gallery data.
		for (let index = 0; index < 13; index++) {
			if (index) await file.writeFile(',');
			const metadata = {
				id: `baseline-${index}`,
				kind: 'images',
				prompt: index === 0 ? unicodeBaseline : `Existing fixture ${index}`,
				model: 'large-image-fixture',
				connectionId: 'fixture',
				createdAt: index,
				status: 'completed',
			};
			await file.writeFile(
				JSON.stringify(metadata).slice(0, -1) +
					',"assets":[{"mimeType":"image/png","name":"baseline.png","url":"' +
					dataPrefix,
			);
			const data = index === 12 ? paddedImage(17 * MiB) : generatedImage;
			for (let offset = 0; offset < data.length; offset += MiB)
				await file.writeFile(data.slice(offset, offset + MiB));
			await file.writeFile('"}]}');
		}
		await file.writeFile(']}');
	} finally {
		await file.close();
	}
	const size = (await stat(workspaceFile)).size;
	assert.ok(size > 257 * MiB && size < 258 * MiB);
	console.log(`Seeded isolated gallery: ${(size / MiB).toFixed(1)} MiB.`);
}

async function launch() {
	const env = { ...process.env, FREELM_USER_DATA: directory };
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.FREELM_DEV_URL;
	delete env.FREELM_HOME;
	desktop = await electron.launch({
		executablePath: process.env.FREELM_TEST_ELECTRON || require('electron'),
		args: ['.'],
		env,
		timeout: 60000,
	});
	desktop.process().stderr?.on('data', (data) => {
		stderr = (stderr + data.toString()).slice(-6000);
	});
	page = await desktop.firstWindow();
	page.setDefaultTimeout(60000);
	page.on('pageerror', (error) => errors.push(`Renderer: ${error.message}`));
	await page.locator('.app-shell').waitFor();
	await expect(page.getByRole('button', { name: 'Chat', exact: true })).toBeVisible();
}

async function visibleImage(locator) {
	await expect(locator).toBeVisible();
	await expect
		.poll(() => locator.evaluate((image) => image.complete && image.naturalWidth > 0))
		.toBe(true);
	assert.equal(await locator.evaluate((image) => image.src.length), imageChars + dataPrefix.length);
}

async function savedMarkers() {
	const needles = [
		unicodeBaseline,
		finalText,
		'"thinkingMode":"low"',
		'"call_id":"large-image-call"',
		`"prompt":"${imagePrompt}"`,
		'"size":"1536x864"',
	];
	const found = new Set();
	let tail = '';
	for await (const chunk of createReadStream(workspaceFile, {
		encoding: 'utf8',
		highWaterMark: MiB,
	})) {
		const sample = tail + chunk;
		for (const needle of needles) if (sample.includes(needle)) found.add(needle);
		tail = sample.slice(-256);
	}
	assert.equal(
		found.size,
		needles.length,
		'Saved workspace must contain the completed Chat, replay, and gallery record',
	);
}

try {
	await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
	await seed();
	await launch();
	// Observe the real save result without requesting another 300+ MiB snapshot over IPC.
	// Electron exposes its handler map internally; this wrapper delegates unchanged.
	await desktop.evaluate(({ ipcMain }, completedText) => {
		const handler = ipcMain._invokeHandlers.get('freelm:workspace-patch');
		if (!handler) throw new Error('Workspace patch handler was not registered');
		globalThis.chatImageSaveEvidence = { count: 0, revision: '', completedRevision: '' };
		ipcMain.removeHandler('freelm:workspace-patch');
		ipcMain.handle('freelm:workspace-patch', async (event, ...args) => {
			const patch = args[2];
			const finalMessage = (message) =>
				message.role === 'assistant' && message.content === completedText;
			const completed =
				patch?.changes?.threads?.some((thread) => thread.messages.some(finalMessage)) ||
				patch?.records?.threads?.upsert?.some((thread) => thread.messages.some(finalMessage)) ||
				patch?.records?.threads?.updates?.some(
					(thread) =>
						thread.changes.messages?.some(finalMessage) ||
						thread.messages?.upsert?.some(finalMessage) ||
						thread.messages?.updates?.some((message) => message.changes.content === completedText),
				);
			const result = await handler(event, ...args);
			globalThis.chatImageSaveEvidence = {
				count: globalThis.chatImageSaveEvidence.count + 1,
				revision: result.revision,
				completedRevision: completed
					? result.revision
					: globalThis.chatImageSaveEvidence.completedRevision,
			};
			return result;
		});
	}, finalText);
	await page.getByLabel('Message', { exact: true }).fill(prompt);
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	await visibleImage(page.locator('.tool-images img'));
	await expect(page.locator('.message.assistant')).toContainText(finalText);
	await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toHaveCount(0);
	await expect(page.getByRole('button', { name: title, exact: true })).toBeVisible();
	await expect
		.poll(
			async () => {
				const saved = await desktop.evaluate(() => globalThis.chatImageSaveEvidence);
				return saved.count >= 2 && Number(saved.completedRevision.split(':').at(-1)) >= 2;
			},
			{ timeout: 90000 },
		)
		.toBe(true);
	await expect(page.getByRole('button', { name: 'Retry save', exact: true })).toHaveCount(0);
	assert.equal(replayVerified, true);
	assert.equal(chatRequests, 2);
	assert.equal(imageRequests, 1);
	assert.equal(titleRequests, 1);
	await savedMarkers();
	await assert.rejects(stat(`${workspaceFile}.pending`), { code: 'ENOENT' });
	const savedSize = (await stat(workspaceFile)).size;
	console.log(
		`Chat completed and autosaved: ${(savedSize / MiB).toFixed(1)} MiB; image replay verified.`,
	);
	await page.screenshot({ path: '/tmp/freelm-large-chat-image.png' });
	await desktop.evaluate(({ app }) => app.exit());
	await desktop.close();
	desktop = undefined;
	await launch();
	await page.getByRole('button', { name: title, exact: true }).click();
	await expect(page.locator('.message.assistant')).toContainText(finalText);
	await visibleImage(page.locator('.tool-images img'));
	await page.getByRole('button', { name: 'Images', exact: true }).click();
	await page.getByRole('button', { name: `Open ${imagePrompt}`, exact: true }).click();
	await visibleImage(page.locator('.media-generated-image'));
	assert.deepEqual(errors, []);
	console.log(
		'Native large Chat image smoke passed: 257 MiB gallery, 20 MiB API image, vision continuation, autosave revision, and Chat/gallery persistence after full restart.',
	);
} catch (error) {
	await page
		?.screenshot({ path: '/tmp/freelm-large-chat-image-failed.png', timeout: 5000 })
		.catch(() => {});
	console.error('Fixture errors:', errors);
	console.error('Electron stderr tail:', stderr);
	throw error;
} finally {
	await desktop?.evaluate(({ app }) => app.exit()).catch(() => {});
	await desktop?.close().catch(() => {});
	provider.closeAllConnections();
	await new Promise((resolve) => provider.close(resolve));
	await rm(directory, { recursive: true, force: true });
}
