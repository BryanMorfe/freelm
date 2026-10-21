import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Isolated native proof: host tasks finish after the last workspace renderer is destroyed.
const profile = await mkdtemp(path.join(os.tmpdir(), 'freelm-headless-task-'));
let release;
const gate = new Promise((resolve) => {
	release = resolve;
});
let releaseShutdown;
const shutdownGate = new Promise((resolve) => {
	releaseShutdown = resolve;
});
let requestCount = 0;
const server = createServer(async (request, response) => {
	let raw = '';
	for await (const part of request) raw += part;
	const body = JSON.parse(raw || '{}');
	assert.equal(body.model, 'fixture-worker');
	requestCount++;
	await (requestCount === 1 ? gate : shutdownGate);
	if (response.destroyed) return;
	response.writeHead(200, { 'content-type': 'application/json' });
	response.end(
		JSON.stringify({
			output: [
				{
					type: 'message',
					role: 'assistant',
					content: [{ type: 'output_text', text: 'Finished with no workspace window.' }],
				},
			],
		}),
	);
});
let desktop;
try {
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const env = { ...process.env, FREELM_HOME: profile, FREELM_USER_DATA: profile };
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.FREELM_DEV_URL;
	const executablePath = process.env.FREELM_SMOKE_EXECUTABLE;
	desktop = await electron.launch({
		...(executablePath
			? { executablePath, args: [`--user-data-dir=${profile}`] }
			: { args: ['.'] }),
		env,
	});
	desktop.process().stderr.on('data', (data) => process.stderr.write(data));
	console.log('Native app launched');
	let page = await desktop.firstWindow();
	await page.locator('.app-shell').waitFor();
	await page.evaluate(
		async ({ baseUrl }) => {
			const state = (await window.desktop.load()) || {
				version: 1,
				connections: [],
				threads: [],
				projects: [],
				generations: [],
				theme: 'dark',
				activeConnectionId: '',
			};
			state.connections = [
				{
					id: 'fixture',
					name: 'Fixture',
					baseUrl,
					apiKey: '',
					chatApi: 'responses',
					discoveredModels: [],
					models: { chat: 'fixture-worker', images: '', videos: '', speech: '', transcription: '' },
					catalog: [
						{
							id: 'fixture-worker',
							name: 'Fixture worker',
							enabled: true,
							tasks: ['chat'],
							inputModalities: ['text'],
							outputModalities: ['text'],
							thinkingModes: [
								{
									id: 'high',
									name: 'High',
									parameters: { responses: { reasoning: { effort: 'high' } } },
								},
							],
						},
					],
				},
			];
			state.activeConnectionId = 'fixture';
			state.threads = [
				{
					id: 'headless',
					kind: 'chat',
					title: 'Background host proof',
					model: 'fixture-worker',
					thinkingMode: 'high',
					connectionId: 'fixture',
					createdAt: Date.now(),
					updatedAt: Date.now(),
					messages: [],
					queuedMessages: [
						{ id: 'queued-input', content: 'Run in the background.', createdAt: Date.now() },
					],
				},
			];
			await window.desktop.save(state);
		},
		{ baseUrl: `http://127.0.0.1:${server.address().port}/v1` },
	);
	console.log('Fixture saved');
	await page.reload();
	await page.locator('.app-shell').waitFor();
	assert.equal(
		(await page.evaluate(() => window.desktop.hostTaskDispatch('headless'))).status,
		'started',
	);
	console.log('Task dispatched', await page.evaluate(() => window.desktop.hostTasksSnapshot()));
	await expect.poll(() => requestCount, { timeout: 30_000 }).toBe(1);
	console.log('Provider admitted');
	await expect
		.poll(() =>
			page.evaluate(async () =>
				(await window.desktop.hostTasksSnapshot()).runs.some(
					(run) => run.threadId === 'headless' && run.owner === 'host',
				),
			),
		)
		.toBe(true);
	// This deliberately destroys the isolated test renderer instead of merely hiding its window.
	await desktop.evaluate(({ BrowserWindow }) => {
		for (const window of BrowserWindow.getAllWindows()) window.destroy();
	});
	assert.equal(
		await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
		0,
	);
	release();
	console.log('Last renderer destroyed');
	await expect
		.poll(
			async () => {
				const data = JSON.parse(await readFile(path.join(profile, 'workspace.json'), 'utf8'));
				return data.threads.find((thread) => thread.id === 'headless')?.messages.at(-1)?.content;
			},
			{ timeout: 30_000 },
		)
		.toBe('Finished with no workspace window.');
	const reopened = desktop.waitForEvent('window');
	await desktop.evaluate(({ app }) => {
		app.emit('activate');
	});
	page = await reopened;
	await page.locator('.app-shell').waitFor();
	await expect(page.getByText('Background host proof', { exact: false }).first()).toBeVisible();
	await page.getByText('Background host proof', { exact: false }).first().click();
	await expect(page.getByText('Finished with no workspace window.', { exact: true })).toBeVisible();
	const snapshot = await page.evaluate(() => window.desktop.workspaceLoad('local'));
	assert.equal(snapshot.state.threads[0].messages.at(-1).interrupted, undefined);
	assert.equal(requestCount, 1);
	await page.screenshot({ path: '/tmp/freelm-headless-task-native.png' });
	console.log(
		'Native host task proof passed: dispatched, last renderer destroyed, completed/persisted, reopened with one provider request.',
	);
	await page.evaluate(async () => {
		const snapshot = await window.desktop.workspaceLoad('local');
		snapshot.state.threads[0].queuedMessages = [
			{ id: 'before-quit', content: 'Stay pending until the app quits.', createdAt: Date.now() },
		];
		await window.desktop.workspaceSave('local', snapshot.revision, snapshot.state);
	});
	assert.equal(
		(await page.evaluate(() => window.desktop.hostTaskDispatch('headless'))).status,
		'started',
	);
	await expect.poll(() => requestCount, { timeout: 30_000 }).toBe(2);
	await desktop.close();
	desktop = undefined;
	const closed = JSON.parse(await readFile(path.join(profile, 'workspace.json'), 'utf8'));
	assert.equal(closed.threads[0].messages.at(-1).interrupted, true);
	console.log(
		'Native full-quit proof passed: in-flight host request cancelled and persisted as interrupted.',
	);
} finally {
	release?.();
	releaseShutdown?.();
	await desktop?.close().catch(() => {});
	await new Promise((resolve) => {
		server.close(resolve);
		server.closeAllConnections();
	});
	await rm(profile, { recursive: true, force: true });
}
