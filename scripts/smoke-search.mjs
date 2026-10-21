import { _electron as electron } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

// Browser plugin not available. These are isolated native fixture instances,
// never the user's running app. No model API is called.
const require = createRequire(import.meta.url);
const profile = await mkdtemp(path.join(os.tmpdir(), 'freelm-builtin-search-'));
const env = { ...process.env, FREELM_HOME: profile, FREELM_USER_DATA: profile };
for (const key of ['ELECTRON_RUN_AS_NODE', 'FREELM_DEV_URL']) delete env[key];
let desktop;
let page;
let lastUrl;
const errors = [];
const observations = {};

function deadline(operation, label, milliseconds = 30000) {
	let timer;
	return Promise.race([
		operation,
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${label} timed out.`)), milliseconds);
		}),
	]).finally(() => clearTimeout(timer));
}

async function launch() {
	desktop = await electron.launch({
		executablePath: process.env.FREELM_TEST_ELECTRON || require('electron'),
		args: ['.'],
		env,
		timeout: 60000,
	});
	page = await desktop.firstWindow();
	page.on('pageerror', (error) => errors.push(error.message));
	await page.waitForFunction(() => Boolean(window.desktop?.searchStatus));
	await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
	const storage = await page.evaluate(() => window.desktop.storageInfo());
	assert.equal(
		storage.location,
		path.join(profile, 'config.json'),
		'The fixture must use a temporary FreeLM home.',
	);
}
async function status() {
	return await deadline(
		page.evaluate(() => window.desktop.searchStatus()),
		'Search status',
		5000,
	);
}
async function waitStatus(phase, selected) {
	const end = Date.now() + 60000;
	let next;
	do {
		next = await status();
		if (next.phase === 'error' || next.phase === 'unavailable') throw new Error(next.message);
		if (
			next.phase === phase &&
			(!selected ||
				[...next.selectedEngineNames].sort().join(',') === [...selected].sort().join(','))
		) {
			if (next.url) lastUrl = next.url;
			return next;
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	} while (Date.now() < end);
	throw new Error(`Waiting for ${phase}: ${JSON.stringify(next)}`);
}
async function save(state) {
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			await deadline(
				page.evaluate(async (value) => {
					await window.desktop.load();
					await window.desktop.save(value);
				}, state),
				'Save search configuration',
			);
			return;
		} catch (error) {
			// Only this explicitly disposable fixture can replace its seed state.
			// Initial renderer setup can commit between the fixture's load and save.
			if (attempt === 2 || !String(error).includes('WORKSPACE_CONFLICT')) throw error;
			await page.reload();
			await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
		}
	}
}
async function tool(arguments_) {
	const result = await page.evaluate(
		(args) =>
			window.desktop.toolExecute({
				workspaceId: 'local',
				runId: 'search-smoke-run',
				threadId: 'search-smoke-thread',
				name: 'web.run',
				arguments: args,
			}),
		arguments_,
	);
	const text = result.content
		.filter((part) => part.type === 'text')
		.map((part) => part.text)
		.join('\n');
	assert.ok(!result.isError, text);
	const output = JSON.parse(text);
	assert.ok(!output.results[0].error, output.results[0].error);
	return output.results[0];
}
async function endpointIsStopped(url) {
	for (let attempt = 0; attempt < 40; attempt++) {
		try {
			await fetch(url + '/healthz', { signal: AbortSignal.timeout(250) });
		} catch {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert.fail('The bundled helper must not remain running after Stop or app quit.');
}
async function quit() {
	if (!desktop) return;
	try {
		// Fixture writes bypass the React store. Reload its durable snapshot before
		// exercising the real close/save handshake, avoiding a stale-view conflict.
		await page.reload();
		await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
		await deadline(
			desktop.evaluate(({ app }) => app.quit()),
			'Quit request',
			5000,
		).catch(() => {});
		await deadline(desktop.close(), 'Graceful app shutdown');
	} catch (error) {
		// Only this disposable fixture may be force-exited after a failed shutdown.
		await deadline(
			desktop.evaluate(({ app }) => app.exit()),
			'Fixture cleanup',
			5000,
		).catch(() => {});
		throw error;
	} finally {
		desktop = undefined;
	}
	if (lastUrl) await endpointIsStopped(lastUrl);
}

try {
	await launch();
	const initial = await status();
	assert.equal(initial.phase, 'stopped', initial.message);
	assert.ok(initial.engines.length >= 4, 'Engine selection must be available before Start.');
	const state = {
		version: 1,
		theme: 'dark',
		activeConnectionId: 'unused',
		projects: [],
		generations: [],
		connections: [
			{
				id: 'unused',
				name: 'No model requests',
				baseUrl: 'http://unused.invalid/v1',
				apiKey: '',
				chatApi: 'responses',
				models: { chat: 'unused', images: '', videos: '', speech: '', transcription: '' },
				discoveredModels: [],
			},
		],
		threads: [
			{
				id: 'search-smoke-thread',
				kind: 'chat',
				title: 'Isolated built-in search qualification',
				titleSource: 'manual',
				connectionId: 'unused',
				model: 'unused',
				thinkingMode: 'low',
				messages: [],
				createdAt: 1,
				updatedAt: 1,
			},
		],
		toolSettings: {
			enabled: false,
			commandExecution: false,
			workspaceRoot: '',
			approvalMode: 'ask',
			allowRemote: false,
			imageGeneration: { enabled: false, connectionId: '', model: '', size: '', quality: '' },
			mcpServers: [],
			skillDirectories: [],
			webBrowsing: {
				enabled: true,
				mode: 'builtin',
				autoStart: false,
				searxngUrl: 'http://external-preserved.invalid',
				engines: ['bing', 'brave', 'bing images', 'google images'],
			},
		},
	};
	await save(state);
	await page.evaluate(() => window.desktop.searchStart());
	const running = await waitStatus('running', state.toolSettings.webBrowsing.engines);
	console.log('Bundled service ready; checking live searches.');
	assert.equal(new URL(running.url).hostname, '127.0.0.1');
	const native = await page.evaluate((url) => window.desktop.toolWebDiscover(url), running.url);
	assert.equal(native.health, 'ok');
	assert.deepEqual(
		native.engines.map((engine) => engine.name).sort(),
		[...state.toolSettings.webBrowsing.engines].sort(),
	);
	const catalog = await page.evaluate(() =>
		window.desktop.toolCatalog('local', 'search-smoke-run', 'search-smoke-thread'),
	);
	assert.deepEqual(
		catalog.tools.map((item) => item.name),
		['web.run'],
	);
	const text = await tool({
		search_query: [{ q: 'SearXNG search engine', engines: ['bing'], limit: 3 }],
	});
	assert.ok(text.results.length > 0, 'The live Bing request must return usable text results.');
	const images = await tool({ image_query: [{ q: 'Golden Gate Bridge', limit: 3 }] });
	assert.ok(images.results.length > 0, 'The live image request must return usable image results.');
	observations.search = {
		version: running.version,
		catalogue: initial.engines.length,
		textResults: text.results.length,
		imageResults: images.results.length,
		unresponsive_engines: [...text.unresponsive_engines, ...images.unresponsive_engines],
	};
	console.log('Live text/image searches passed; checking saved engine restart.');
	await page.evaluate(() => window.desktop.toolCancel('search-smoke-run'));
	const prior = lastUrl;
	state.toolSettings.webBrowsing.engines = ['bing', 'bing images'];
	await save(state);
	await waitStatus('running', state.toolSettings.webBrowsing.engines);
	console.log('New service instance is running.');
	await endpointIsStopped(prior);
	const restarted = await deadline(
		page.evaluate((url) => window.desktop.toolWebDiscover(url), lastUrl),
		'Restarted service discovery',
	);
	assert.deepEqual(
		restarted.engines.map((engine) => engine.name).sort(),
		['bing', 'bing images'].sort(),
	);
	console.log('Saved engine restart passed; checking Stop and automatic startup.');
	await page.evaluate(() => window.desktop.searchStop());
	await waitStatus('stopped');
	await endpointIsStopped(lastUrl);
	state.toolSettings.webBrowsing.autoStart = true;
	await save(state);
	await waitStatus('running', state.toolSettings.webBrowsing.engines);
	console.log('Automatic startup passed; checking full app restart.');
	await quit();
	await launch();
	await waitStatus('running', state.toolSettings.webBrowsing.engines);
	state.toolSettings.webBrowsing.mode = 'external';
	await save(state);
	await waitStatus('stopped');
	await endpointIsStopped(lastUrl);
	const persisted = await page.evaluate(() => window.desktop.load());
	assert.deepEqual(persisted.toolSettings.webBrowsing, state.toolSettings.webBrowsing);
	assert.deepEqual(errors, []);
	observations.architecture = await desktop.evaluate(() => process.arch);
	observations.lifecycle =
		'offline engine list, Start, saved engine restart, Stop, auto-start after full restart, external switch, clean quit';
	console.log(JSON.stringify(observations, null, 2));
} finally {
	await quit().catch(() => {});
	await rm(profile, { recursive: true, force: true });
}
