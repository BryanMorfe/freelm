import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const userData = await mkdtemp(path.join(os.tmpdir(), 'freelm-native-smoke-'));
const videoBytes = Buffer.from([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109]);
const responseText = 'Hello desktop — Café你好';
// The final Responses event deliberately has neither [DONE] nor a trailing newline.
const responseStream =
	`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: responseText })}\r\n\r\n` +
	`event: response.completed\r\ndata: ${JSON.stringify({ type: 'response.completed', response: { output_text: responseText } })}`;
const responseBytes = Buffer.from(responseStream);
const accentSplit = responseBytes.indexOf(Buffer.from('é')) + 1;
const chineseSplit = responseBytes.indexOf(Buffer.from('你')) + 1;
const streamBoundaries = [0, accentSplit, chineseSplit, chineseSplit + 1, responseBytes.length];
// Exceed several native read buffers. Fast invoke completion used to overtake
// the final chunk events, so only small streams did not cover this failure.
const largeResponseStream =
	Array.from(
		{ length: 2500 },
		(_, sequence_number) =>
			`data: ${JSON.stringify({ type: 'response.reasoning_text.delta', delta: 'reasoning '.repeat(20), sequence_number })}\n\n`,
	).join('') + responseStream;
const server = createServer(async (request, response) => {
	if (request.url === '/v1/fixture-video') {
		assert.equal(request.headers.authorization, undefined);
		response.writeHead(200, { 'content-type': 'application/octet-stream' });
		response.end(videoBytes);
	} else if (request.url === '/v1/models') {
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end(JSON.stringify({ data: [{ id: 'desktop-test-model' }] }));
	} else if (request.url === '/v1/responses') {
		let body = '';
		for await (const chunk of request) body += chunk.toString();
		const payload = JSON.parse(body || '{}');
		response.writeHead(200, { 'content-type': 'text/event-stream' });
		if (payload.model === 'desktop-test-model') {
			response.end(largeResponseStream);
			return;
		}
		for (let i = 1; i < streamBoundaries.length; i++) {
			response.write(responseBytes.subarray(streamBoundaries[i - 1], streamBoundaries[i]));
			// Keep the split UTF-8 code points in separate HTTP writes/event-loop turns.
			await new Promise((resolve) => setTimeout(resolve, 2));
		}
		response.end();
	} else if (request.url === '/v1/chat/completions') {
		response.writeHead(200, { 'content-type': 'text/event-stream' });
		response.write(': waiting\n\n');
		request.on('close', () => response.end());
	} else {
		response.writeHead(404);
		response.end('Unknown test endpoint');
	}
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
let desktop;
try {
	const env = { ...process.env, FREELM_USER_DATA: userData };
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.FREELM_DEV_URL;
	delete env.FREELM_HOME;
	const executablePath = process.env.FREELM_SMOKE_EXECUTABLE;
	// Packaged apps ignore FREELM_USER_DATA. Isolate portable storage and
	// Electron's single-instance directory before launching the real bundle.
	if (executablePath) env.FREELM_HOME = userData;
	desktop = await electron.launch({
		...(executablePath
			? { executablePath, args: [`--user-data-dir=${userData}`] }
			: { args: ['.'] }),
		env,
	});
	const page = await desktop.firstWindow();
	const rendererErrors = [];
	page.on('pageerror', (error) => rendererErrors.push(error.message));
	await page.waitForFunction(() => !!window.desktop);
	await page.locator('.app-shell').waitFor();
	await page.waitForFunction(async () => (await window.desktop.load()) !== null);
	await page.screenshot({ path: '/tmp/freelm-native.png' });
	const preferences = await desktop.evaluate(({ BrowserWindow }) => {
		const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
		return {
			sandbox: preferences.sandbox,
			isolation: preferences.contextIsolation,
			node: preferences.nodeIntegration,
		};
	});
	assert.deepEqual(preferences, { sandbox: true, isolation: true, node: false });
	const untrustedErrors = await desktop.evaluate(async ({ BrowserWindow, app }) => {
		const window = new BrowserWindow({
			show: false,
			webPreferences: {
				preload: `${app.getAppPath()}/dist-electron/preload.cjs`,
				sandbox: true,
				contextIsolation: true,
				nodeIntegration: false,
			},
		});
		try {
			await window.loadURL('data:text/html,<html><body>Untrusted test page</body></html>');
			return await window.webContents.executeJavaScript(`(async () => {
				const bridge = window.desktopNative;
				const calls = {
					load: () => bridge.load(),
					open: () => bridge.workspaceTransfer.open('workspace-load', ['local']),
					read: () => bridge.workspaceTransfer.read('00000000-0000-0000-0000-000000000000', 0, 1),
					create: () => bridge.workspaceTransfer.create(65536, 'string'),
					commit: () => bridge.workspaceTransfer.commit('workspace-patch', ['local', 'fixture-revision'], {
						version: 1,
						metadata: { json: JSON.stringify({ version: 1, shape: { changes: {} }, strings: [] }) },
					}),
				};
				const errors = {};
				for (const [name, call] of Object.entries(calls)) {
					try { await call(); errors[name] = ''; }
					catch (error) { errors[name] = error.message; }
				}
				return errors;
			})()`);
		} finally {
			window.destroy();
		}
	});
	assert.deepEqual(Object.keys(untrustedErrors), ['load', 'open', 'read', 'create', 'commit']);
	for (const [name, error] of Object.entries(untrustedErrors))
		assert.match(
			error,
			/not allowed to access the desktop bridge/,
			`${name} must reject the untrusted sender`,
		);
	const state = {
		version: 1,
		connections: [
			{
				id: 'smoke',
				name: 'Smoke provider',
				baseUrl,
				apiKey: 'smoke-test-placeholder',
				chatApi: 'responses',
				models: {
					chat: 'desktop-test-model',
					images: '',
					videos: '',
					speech: '',
					transcription: '',
				},
				discoveredModels: [],
				catalog: [
					{
						id: 'desktop-test-model',
						name: 'desktop-test-model',
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
				],
			},
		],
		activeConnectionId: 'smoke',
		threads: [],
		projects: [],
		generations: [],
		theme: 'dark',
	};
	const result = await page.evaluate(
		async ({ state, baseUrl }) => {
			// Initial renderer autosave may advance the revision during startup checks.
			await window.desktop.load();
			await window.desktop.save(state);
			const loaded = await window.desktop.load();
			const request = { id: 'models', baseUrl, apiKey: '', path: '/models', method: 'GET' };
			const models = await window.desktop.request(request);
			const videoAsset = await window.desktop.instanceAsset(
				'local',
				'smoke',
				`${baseUrl}/fixture-video`,
				'video',
			);
			const streams = [];
			for (let attempt = 0; attempt < 10; attempt++) {
				const id = `stream-${attempt}`;
				let text = '';
				const unsubscribe = window.desktop.onChunk((chunk) => {
					if (chunk.id === id) text += chunk.text;
				});
				await window.desktop.request({
					...request,
					id,
					path: '/responses',
					method: 'POST',
					body: { input: 'Hi', stream: true },
					stream: true,
				});
				// Assert delivery at invoke resolution, before any extra renderer turn.
				unsubscribe();
				streams.push(text);
			}
			const largeStreams = [];
			for (let batch = 0; batch < 3; batch++) {
				await Promise.all(
					Array.from({ length: 4 }, async (_, attempt) => {
						const id = `large-stream-${batch}-${attempt}`;
						let text = '';
						const unsubscribe = window.desktop.onChunk((chunk) => {
							if (chunk.id === id) text += chunk.text;
						});
						await window.desktop.request({
							...request,
							id,
							path: '/responses',
							method: 'POST',
							body: { model: 'desktop-test-model', input: 'Hi', stream: true },
							stream: true,
						});
						unsubscribe();
						largeStreams.push({ id, text });
					}),
				);
			}
			const cancelled = window.desktop
				.request({
					...request,
					id: 'cancelled',
					path: '/chat/completions',
					method: 'POST',
					body: { stream: true },
					stream: true,
				})
				.then(
					() => false,
					(error) => /abort|cancel/i.test(error.message),
				);
			await new Promise((resolve) => setTimeout(resolve, 100));
			await window.desktop.cancel('cancelled');
			let invalidRejected = false;
			try {
				await window.desktop.request({ ...request, method: 'DELETE' });
			} catch {
				invalidRejected = true;
			}
			return {
				loaded,
				models,
				videoAsset,
				streams,
				largeStreams,
				cancelled: await cancelled,
				invalidRejected,
				storageInfo: await window.desktop.storageInfo(),
			};
		},
		{ state, baseUrl },
	);
	assert.deepEqual(result.loaded, state);
	assert.equal(result.models.status, 200);
	assert.match(result.models.body, /desktop-test-model/);
	assert.deepEqual(result.videoAsset, {
		status: 200,
		contentType: 'video/mp4',
		encoding: 'base64',
		body: videoBytes.toString('base64'),
	});
	assert.equal(result.streams.length, 10);
	for (const stream of result.streams)
		assert.equal(stream, responseStream, 'All stream bytes must arrive before invoke resolves');
	assert.equal(result.largeStreams.length, 12);
	for (const { id, text } of result.largeStreams) {
		assert.equal(
			text.length,
			largeResponseStream.length,
			`${id}: large stream tail must arrive before invoke resolves`,
		);
		assert.ok(text === largeResponseStream, `${id}: no duplicated, missing, or reordered chunks`);
	}
	assert.equal(result.cancelled, true);
	assert.equal(result.invalidRejected, true);
	const [savedSource, configSource] = await Promise.all([
		readFile(path.join(userData, 'workspace.json'), 'utf8'),
		readFile(path.join(userData, 'config.json'), 'utf8'),
	]);
	assert.ok(!savedSource.includes('smoke-test-placeholder'));
	assert.ok(!configSource.includes('smoke-test-placeholder'));
	const persisted = JSON.parse(savedSource);
	const config = JSON.parse(configSource);
	assert.equal(persisted.format, 'freelm-workspace-v2');
	assert.deepEqual(persisted.threads, []);
	assert.deepEqual(persisted.projects, []);
	assert.deepEqual(persisted.generations, []);
	assert.equal(persisted.connections, undefined);
	assert.equal(persisted.encryptedKeys, undefined);
	assert.equal(config.format, 'freelm-config-v1');
	assert.equal(config.connections.length, 1);
	assert.equal(config.connections[0].apiKey, '');
	assert.equal(config.activeConnectionId, 'smoke');
	assert.equal(config.theme, 'dark');
	assert.equal(config.threads, undefined);
	assert.equal(config.projects, undefined);
	assert.equal(config.generations, undefined);
	assert.ok((await stat(path.join(userData, 'skills'))).isDirectory());
	if (result.storageInfo.secure) {
		const decrypted = await desktop.evaluate(async ({ safeStorage }, encrypted) => {
			const bytes = Buffer.from(encrypted, 'base64');
			return typeof safeStorage.decryptStringAsync === 'function'
				? (await safeStorage.decryptStringAsync(bytes)).result
				: safeStorage.decryptString(bytes);
		}, config.encryptedKeys.smoke);
		assert.equal(decrypted, 'smoke-test-placeholder');
	} else assert.deepEqual(config.encryptedKeys, {});
	assert.deepEqual(rendererErrors, []);
	// The bridge fixture save advanced the shared workspace revision. Reload the UI
	// before making UI edits so it does not correctly reject them as a stale writer.
	await page.reload();
	await expectReady(page);
	// Exercise the real Chat parser with the large stream over native IPC, including EOF flush.
	await page.getByLabel('Message', { exact: true }).fill('Native streaming check');
	await page.getByRole('button', { name: 'Send message' }).click();
	await expect(page.locator('.message.assistant')).toContainText(responseText);
	await expect(page.getByRole('button', { name: 'Stop response' })).toHaveCount(0);
	await expect(page.locator('.message.assistant [role="alert"]')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
	assert.deepEqual(rendererErrors, []);
	const downloadPath = path.join(userData, 'generated-asset.txt');
	await desktop.evaluate(({ BrowserWindow }, filename) => {
		globalThis.freelmDownload = 'waiting';
		BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_event, item) => {
			globalThis.freelmDownload = 'started';
			item.setSavePath(filename);
			item.once('done', (_event, state) => {
				globalThis.freelmDownload = state;
			});
		});
	}, downloadPath);
	await page.evaluate(() => {
		const anchor = document.createElement('a');
		anchor.href = 'data:text/plain;base64,SGVsbG8gZG93bmxvYWQ=';
		anchor.download = 'generated-asset.txt';
		document.body.append(anchor);
		anchor.click();
		anchor.remove();
	});
	let downloadState = 'waiting';
	for (let attempt = 0; attempt < 50; attempt++) {
		downloadState = await desktop.evaluate(() => globalThis.freelmDownload);
		if (downloadState === 'completed') break;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert.equal(downloadState, 'completed', 'Native download must finish');
	assert.equal(await readFile(downloadPath, 'utf8'), 'Hello download');

	// Close immediately after a real UI edit, before the 350 ms autosave debounce.
	await page.getByRole('button', { name: 'New project', exact: true }).click();
	await page.getByRole('textbox', { name: 'Project name' }).fill('Saved at close');
	await page.getByRole('button', { name: 'Create project', exact: true }).click();
	await Promise.all([
		page.waitForEvent('close'),
		desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close()),
	]);
	const afterClose = JSON.parse(await readFile(path.join(userData, 'workspace.json'), 'utf8'));
	assert.ok(afterClose.projects.some((project) => project.name === 'Saved at close'));
	console.log(
		`Desktop smoke passed: sandbox, preload, split config/workspace persistence and skills directory, ${result.storageInfo.secure ? 'OS key encryption/decryption' : 'memory-only API keys'}, HTTP, 10 split UTF-8 streams, 12 concurrent large IPC streams (${largeResponseStream.length} characters each) plus Chat UI with response.completed at EOF, cancellation, payload and IPC sender validation including four workspace transfer RPCs, media download, save-before-close.`,
	);
} finally {
	await desktop?.evaluate(({ app }) => app.exit()).catch(() => {});
	await desktop?.close().catch(() => {});
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
	await rm(userData, { recursive: true, force: true });
}

async function expectReady(page) {
	await page.locator('.app-shell').waitFor();
	const picker = page.getByRole('button', { name: 'Chat model', exact: true });
	await expect(picker.locator('.composer-model-name')).toHaveText('desktop-test-model');
	await expect(picker.locator('.composer-thinking-value')).toHaveText('Low');
}
