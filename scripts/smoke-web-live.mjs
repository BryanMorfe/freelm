import { _electron as electron } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

// Opt-in qualification of the actual host HTTP/PDF path. No model API is called.
// FREELM_HOME isolates packaged storage too; FREELM_USER_DATA additionally
// separates Electron's development profile when using a checkout executable.
const serviceUrl = process.env.FREELM_LIVE_SEARXNG;
assert.ok(serviceUrl, 'Set FREELM_LIVE_SEARXNG to the SearXNG service to qualify.');
const require = createRequire(import.meta.url);
const profile = await mkdtemp(path.join(os.tmpdir(), 'freelm-web-live-'));
const env = { ...process.env, FREELM_USER_DATA: profile, FREELM_HOME: profile };
for (const name of ['ELECTRON_RUN_AS_NODE', 'FREELM_DEV_URL']) delete env[name];
const errors = [];
const observations = {};
let desktop;
let page;
let stderr = '';

async function execute(args) {
	const result = await page.evaluate(
		async (arguments_) =>
			await window.desktop.toolExecute({
				workspaceId: 'local',
				runId: 'live-web-run',
				threadId: 'live-web-thread',
				name: 'web.run',
				arguments: arguments_,
			}),
		args,
	);
	const text = result.content
		.filter((part) => part.type === 'text')
		.map((part) => part.text)
		.join('\n');
	assert.ok(!result.isError, text);
	const output = JSON.parse(text);
	assert.equal(output.sources_are_untrusted, true);
	for (const operation of output.results) assert.ok(!operation.error, operation.error);
	return { result, operation: output.results[0] };
}

try {
	desktop = await electron.launch({
		executablePath: process.env.FREELM_TEST_ELECTRON || require('electron'),
		args: ['.'],
		env,
		timeout: 60000,
	});
	desktop.process().stderr?.on('data', (chunk) => {
		stderr = (stderr + chunk.toString()).slice(-4000);
	});
	page = await desktop.firstWindow();
	page.on('pageerror', (error) => errors.push(error.message));
	await page.waitForFunction(() => Boolean(window.desktop?.toolWebDiscover));
	const storage = await page.evaluate(async () => await window.desktop.storageInfo());
	assert.equal(
		path.resolve(storage.location),
		path.join(profile, 'config.json'),
		'Live checks must use the temporary home.',
	);
	const discovery = await page.evaluate(
		async (url) => await window.desktop.toolWebDiscover(url),
		serviceUrl,
	);
	assert.ok(discovery.engines.length, 'The live service must advertise at least one engine.');
	observations.discovery = {
		version: discovery.version,
		health: discovery.health,
		engines: discovery.engines.map((engine) => engine.name),
	};
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
				id: 'live-web-thread',
				kind: 'chat',
				title: 'Isolated web qualification',
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
			webBrowsing: { enabled: true, searxngUrl: serviceUrl },
			mcpServers: [],
			skillDirectories: [],
		},
	};
	await page.evaluate(async (next) => {
		await window.desktop.load();
		await window.desktop.save(next);
	}, state);
	const catalog = await page.evaluate(
		async () => await window.desktop.toolCatalog('local', 'live-web-run', 'live-web-thread'),
	);
	assert.deepEqual(
		catalog.tools.map((tool) => tool.name),
		['web.run'],
	);
	const textEngines = discovery.engines.filter((engine) => engine.categories.includes('general'));
	const selected = ['google', 'bing'].filter((name) =>
		textEngines.some((engine) => engine.name === name),
	);
	const search = await execute({
		search_query: [
			{ q: 'continual learning', ...(selected.length ? { engines: selected } : {}), limit: 5 },
		],
	});
	assert.ok(Array.isArray(search.operation.results));
	assert.ok(search.operation.results.length <= 5);
	assert.ok(Array.isArray(search.operation.unresponsive_engines));
	observations.textSearch = {
		results: search.operation.results.length,
		unresponsive_engines: search.operation.unresponsive_engines,
	};
	const images = await execute({ image_query: [{ q: 'Golden Gate Bridge', limit: 3 }] });
	assert.ok(
		images.operation.results.length > 0,
		'The live image search returned no usable images.',
	);
	assert.ok(images.operation.results.every((source) => source.img_src || source.image_url));
	observations.imageSearch = {
		results: images.operation.results.length,
		unresponsive_engines: images.operation.unresponsive_engines,
	};
	const opened = await execute({
		open: [{ ref_id: 'https://docs.searxng.org/dev/search_api.html' }],
	});
	assert.ok(
		opened.operation.content.includes('search'),
		'The official API page must contain readable text.',
	);
	const found = await execute({ find: [{ ref_id: opened.operation.ref_id, pattern: 'format' }] });
	assert.ok(found.operation.matches.length, 'Find must locate text in the fetched page.');
	const links = opened.operation.links.filter(
		(item) => item.url !== opened.operation.url && item.url.startsWith('https://'),
	);
	const link = links.find((item) => item.url.startsWith('https://docs.searxng.org/')) ?? links[0];
	assert.ok(link, 'The official page must expose a numbered documentation link.');
	const clicked = await execute({ click: [{ ref_id: opened.operation.ref_id, id: link.id }] });
	assert.ok(clicked.operation.content.length);
	assert.notEqual(clicked.operation.url, opened.operation.url);
	observations.navigation = {
		opened: opened.operation.url,
		matches: found.operation.matches.length,
		clicked: clicked.operation.url,
	};
	const pdf = await execute({
		open: [
			{
				ref_id: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
				pageno: 0,
			},
		],
	});
	assert.match(pdf.operation.content, /Dummy PDF file/i);
	const screenshot = await execute({ screenshot: [{ ref_id: pdf.operation.ref_id, pageno: 0 }] });
	const image = screenshot.result.content.find((part) => part.type === 'image');
	assert.ok(
		image?.dataUrl.startsWith('data:image/png;base64,'),
		'The native PDF worker must render a PNG.',
	);
	const png = Buffer.from(image.dataUrl.split(',')[1], 'base64');
	assert.equal(png.subarray(1, 4).toString(), 'PNG');
	await writeFile('/tmp/freelm-web-live-pdf.png', png);
	observations.pdf = { extracted: true, screenshotBytes: png.length };
	observations.architecture = await desktop.evaluate(() => process.arch);
	assert.deepEqual(errors, []);
	console.log(JSON.stringify(observations, null, 2));
} catch (error) {
	console.error(stderr);
	throw error;
} finally {
	await page?.evaluate(async () => await window.desktop.toolCancel('live-web-run')).catch(() => {});
	await desktop?.evaluate(({ app }) => app.exit()).catch(() => {});
	await desktop?.close().catch(() => {});
	await rm(profile, { recursive: true, force: true });
}
