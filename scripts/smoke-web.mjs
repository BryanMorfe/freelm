import { _electron as electron, expect as baseExpect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

// Run after npm run build. The actual renderer, preload, tool host, HTTP transport,
// and persistence run against local fixtures with a completely temporary profile.
const require = createRequire(import.meta.url);
const expect = baseExpect.configure({ timeout: 30000 });
const userData = await mkdtemp(path.join(os.tmpdir(), 'freelm-web-smoke-'));
const sourceUrl = 'https://example.com/article';
const sourceTitle = 'Native web fixture source';
const sourceSnippet = 'A fixture source returned through the configured SearXNG service.';
const apis = ['responses', 'chat'];
const titles = { responses: 'Responses web smoke', chat: 'Chat Completions web smoke' };
const finalText = (api) => `${api} web search completed. [${sourceTitle}](${sourceUrl})`;
const replayText = (api) => `${api} saved source replay confirmed. [${sourceTitle}](${sourceUrl})`;
const requests = { responses: 0, chat: 0 };
const searchRequests = [];
const searchReleases = new Map();
const replayVerified = new Set();
const fixtureErrors = [];
const rendererErrors = [];
let desktop;
let page;
let stderr = '';

function sse(response, events, done = false) {
	response.writeHead(200, { 'content-type': 'text/event-stream' });
	response.end(
		events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') +
			(done ? 'data: [DONE]\n\n' : ''),
	);
}
function textResponse(response, api, text) {
	if (api === 'responses') {
		sse(response, [
			{ type: 'response.output_text.delta', delta: text },
			{
				type: 'response.completed',
				response: {
					status: 'completed',
					output: [
						{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
					],
				},
			},
		]);
	} else {
		sse(
			response,
			[
				{
					choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
				},
				{ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
			],
			true,
		);
	}
}
function webOutput(body, api) {
	const id = `${api}-web-call`;
	if (api === 'responses') {
		assert.ok(
			body.input.some((item) => item.type === 'function_call' && item.call_id === id),
			'Responses continuation must preserve the tool call ID',
		);
		const output = body.input.find(
			(item) => item.type === 'function_call_output' && item.call_id === id,
		);
		assert.ok(output, 'Responses continuation must include the matching web tool output');
		return output.output;
	}
	assert.ok(
		body.messages.some(
			(item) => item.role === 'assistant' && item.tool_calls?.some((call) => call.id === id),
		),
		'Chat continuation must preserve the tool call ID',
	);
	const output = body.messages.find((item) => item.role === 'tool' && item.tool_call_id === id);
	assert.ok(output, 'Chat continuation must include the matching web tool output');
	return output.content;
}
function verifyWebOutput(body, api) {
	const result = JSON.parse(webOutput(body, api));
	assert.equal(result.sources_are_untrusted, true);
	assert.equal(result.results.length, 1);
	assert.equal(result.results[0].operation, 'search_query');
	assert.equal(result.results[0].query, `native web ${api} query`);
	const source = result.results[0].results[0];
	assert.equal(source.url, sourceUrl);
	assert.equal(source.title, sourceTitle);
	assert.equal(source.snippet, sourceSnippet);
	assert.match(source.ref_id, /^web_[a-f0-9]{8}_\d+$/);
}

const server = createServer(async (request, response) => {
	try {
		const url = new URL(request.url, 'http://fixture.invalid');
		if (url.pathname === '/fixture/proxy/search') {
			assert.equal(request.method, 'GET');
			assert.equal(url.searchParams.get('format'), 'json');
			assert.ok(apis.some((api) => url.searchParams.get('q') === `native web ${api} query`));
			assert.equal(
				request.headers.authorization,
				undefined,
				'Provider API credentials must not be forwarded to SearXNG',
			);
			assert.equal(
				request.headers.cookie,
				undefined,
				'Web search must not receive browser cookies',
			);
			assert.ok(!JSON.stringify(request.headers).includes('fixture-secret'));
			searchRequests.push(url.searchParams.get('q'));
			await new Promise((resolve) => searchReleases.set(url.searchParams.get('q'), resolve));
			response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
			response.end(
				JSON.stringify({
					results: [{ title: sourceTitle, url: sourceUrl, content: sourceSnippet }],
				}),
			);
			return;
		}
		assert.equal(request.method, 'POST');
		assert.equal(request.headers.authorization, 'Bearer fixture-secret');
		const chunks = [];
		let bytes = 0;
		for await (const chunk of request) {
			bytes += chunk.length;
			assert.ok(bytes < 1024 * 1024, 'Unexpectedly large provider fixture request');
			chunks.push(chunk);
		}
		const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
		const api = url.pathname === '/v1/responses' ? 'responses' : 'chat';
		assert.ok(['/v1/responses', '/v1/chat/completions'].includes(url.pathname));
		assert.equal(body.model, `native-web-${api}`);
		assert.equal(body.stream, true);
		if (api === 'responses') assert.deepEqual(body.reasoning, { effort: 'low' });
		else assert.equal(body.reasoning_effort, 'low');
		const instructions =
			body.instructions ??
			body.messages.find((message) => message.role === 'system')?.content ??
			'';
		if (instructions.startsWith('Write a short conversation title')) {
			textResponse(response, api, titles[api]);
			return;
		}
		requests[api]++;
		assert.equal(
			body.tools.length,
			1,
			'Chat must advertise only web browsing with Code and image tools disabled',
		);
		const tool = api === 'responses' ? body.tools[0] : body.tools[0].function;
		assert.match(tool.name, /^web_run_[a-f0-9]{16}$/);
		assert.match(instructions, /SearXNG|web\.run|browsing/i);
		assert.equal(tool.parameters.properties.searxngUrl, undefined);
		if (requests[api] === 1) {
			const args = JSON.stringify({ search_query: [{ q: `native web ${api} query` }] });
			const id = `${api}-web-call`;
			if (api === 'responses') {
				sse(response, [
					{
						type: 'response.completed',
						response: {
							status: 'completed',
							output: [
								{
									type: 'function_call',
									id: `${api}-web-item`,
									call_id: id,
									name: tool.name,
									arguments: args,
									status: 'completed',
								},
							],
						},
					},
				]);
			} else {
				sse(
					response,
					[
						{
							choices: [
								{
									index: 0,
									delta: {
										role: 'assistant',
										tool_calls: [
											{
												index: 0,
												id,
												type: 'function',
												function: { name: tool.name, arguments: args },
											},
										],
									},
									finish_reason: null,
								},
							],
						},
						{ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
					],
					true,
				);
			}
			return;
		}
		verifyWebOutput(body, api);
		if (requests[api] === 2) {
			textResponse(response, api, finalText(api));
			return;
		}
		assert.equal(requests[api], 3, 'Unexpected additional provider fixture request');
		assert.ok(
			JSON.stringify(api === 'responses' ? body.input.at(-1) : body.messages.at(-1)).includes(
				'Confirm the saved source.',
			),
			'The restarted continuation must include the new user question',
		);
		replayVerified.add(api);
		textResponse(response, api, replayText(api));
	} catch (error) {
		fixtureErrors.push(error.message);
		if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
		response.end(JSON.stringify({ error: { message: error.message } }));
	}
});

async function launch() {
	const env = { ...process.env, FREELM_USER_DATA: userData };
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
	page.on('pageerror', (error) => rendererErrors.push(error.message));
	await page.locator('.app-shell').waitFor();
	await page.waitForFunction(() => !!window.desktop?.toolCatalog);
}
async function stop() {
	await desktop?.evaluate(({ app }) => app.exit()).catch(() => {});
	await desktop?.close().catch(() => {});
	desktop = undefined;
}
async function savedState() {
	return JSON.parse(await readFile(path.join(userData, 'workspace.json'), 'utf8'));
}
async function send(api, prompt, text, inspectSearch = false) {
	await page.getByRole('button', { name: titles[api], exact: true }).click();
	const picker = page.getByRole('button', { name: 'Chat model', exact: true });
	await expect(picker.locator('.composer-model-name')).toHaveText(`native-web-${api}`);
	await expect(picker.locator('.composer-thinking-value')).toHaveText('Low');
	await page.getByLabel('Message', { exact: true }).fill(prompt);
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	if (inspectSearch) {
		const active = page.locator('.active-tool-status');
		await expect(active).toHaveCount(1);
		await expect(active).toHaveText(`Searching for native web ${api} query`);
		await expect(active.locator('.activity-shimmer')).toHaveCount(1);
		await expect(page.locator('.tool-call')).toHaveCount(0);
		await expect(page.locator('.message.assistant')).not.toContainText('Working for');
		await expect.poll(() => typeof searchReleases.get(`native web ${api} query`)).toBe('function');
		searchReleases.get(`native web ${api} query`)();
	}
	await expect(page.locator('.message.assistant').last()).toContainText(
		text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'),
	);
	await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toHaveCount(0);
	await expect(page.locator('.message.assistant [role="alert"]')).toHaveCount(0);
	const assistant = page.locator('.message.assistant').last();
	await expect(assistant.locator('.thought-summary')).toHaveText(/^Thought for \d+(?:s|m \d+s)$/);
	await expect(assistant.locator('.thought-summary')).toHaveAttribute('aria-expanded', 'false');
	await expect(assistant.locator('.thought-history')).toHaveCount(0);
	await expect(assistant.locator('.activity-shimmer')).toHaveCount(0);
	await expect(
		page.locator('.message.assistant').last().getByRole('link', { name: sourceTitle, exact: true }),
	).toHaveAttribute('href', sourceUrl);
	await expect
		.poll(
			async () =>
				(await savedState()).threads
					.find((thread) => thread.id === `${api}-thread`)
					?.messages.at(-1)?.content,
		)
		.toBe(text);
}

try {
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const origin = `http://127.0.0.1:${server.address().port}`;
	const state = {
		version: 1,
		theme: 'dark',
		activeConnectionId: 'responses',
		projects: [],
		generations: [],
		connections: apis.map((api) => ({
			id: api,
			name: `Web ${api} fixture`,
			baseUrl: `${origin}/v1`,
			apiKey: 'fixture-secret',
			chatApi: api === 'responses' ? 'responses' : 'chat/completions',
			models: { chat: `native-web-${api}`, images: '', videos: '', speech: '', transcription: '' },
			discoveredModels: [],
			catalog: [
				{
					id: `native-web-${api}`,
					name: `native-web-${api}`,
					enabled: true,
					tasks: ['chat'],
					inputModalities: ['text'],
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
		})),
		threads: apis.map((api) => ({
			id: `${api}-thread`,
			kind: 'chat',
			title: titles[api],
			titleSource: 'manual',
			connectionId: api,
			model: `native-web-${api}`,
			thinkingMode: 'low',
			messages: [],
			createdAt: 1,
			updatedAt: 1,
		})),
		toolSettings: {
			enabled: false,
			commandExecution: false,
			workspaceRoot: '',
			approvalMode: 'ask',
			allowRemote: false,
			imageGeneration: { enabled: false, connectionId: '', model: '', size: '', quality: '' },
			webBrowsing: { enabled: true, searxngUrl: `${origin}/fixture/proxy/` },
			mcpServers: [],
			skillDirectories: [],
		},
	};
	await launch();
	await page.getByLabel('Message', { exact: true }).waitFor();
	assert.equal(
		(await page.evaluate(() => window.desktop.storageInfo())).location,
		path.join(userData, 'config.json'),
		'Web smoke must use its disposable profile before writing any state',
	);
	await page.evaluate(async (next) => {
		await window.desktop.load();
		await window.desktop.save(next);
	}, state);
	await page.reload();
	await page.getByRole('button', { name: 'Chat', exact: true }).click();
	for (const api of apis) {
		await send(api, `Find the native web ${api} source.`, finalText(api), true);
		const summary = page.locator('.thought-summary');
		await summary.click();
		await expect(page.locator('.thought-history')).toContainText(
			`Searching for native web ${api} query`,
		);
		await expect(page.locator(`[data-tool-id="${api}-web-call"]`)).toHaveAttribute(
			'data-tool-status',
			'completed',
		);
		await summary.click();
	}
	assert.deepEqual(searchRequests.sort(), apis.map((api) => `native web ${api} query`).sort());
	const stored = await savedState();
	assert.equal(stored.threads.length, 2);
	for (const api of apis) {
		const thread = stored.threads.find((thread) => thread.id === `${api}-thread`);
		assert.equal(thread.kind, 'chat');
		assert.equal(thread.thinkingMode, 'low');
		const message = thread.messages.at(-1);
		assert.equal(message.thinkingMode, 'low');
		assert.equal(message.agentTranscript.api, api);
		assert.ok(message.activityFinishedAt >= message.createdAt);
		assert.ok(message.activityFinishedAt <= message.completedAt);
		assert.deepEqual(
			message.toolCalls.map((call) => ({ name: call.name, status: call.status })),
			[{ name: 'web.run', status: 'completed' }],
		);
		verifyWebOutput(
			api === 'responses'
				? { input: message.agentTranscript.items }
				: { messages: message.agentTranscript.items },
			api,
		);
	}
	const config = JSON.parse(await readFile(path.join(userData, 'config.json'), 'utf8'));
	assert.deepEqual(config.toolSettings, state.toolSettings);
	await page.screenshot({ path: '/tmp/freelm-web-native.png' });
	await stop();
	await launch();
	await page.getByRole('button', { name: 'Chat', exact: true }).click();
	for (const api of apis) {
		await send(api, 'Confirm the saved source.', replayText(api));
		const original = page.locator('.message.assistant').first();
		await expect(original.locator('.thought-summary')).toHaveAttribute('aria-expanded', 'false');
		await original.locator('.thought-summary').click();
		await expect(original.locator(`[data-tool-id="${api}-web-call"]`)).toHaveAttribute(
			'data-tool-status',
			'completed',
		);
		await original.locator('.thought-summary').click();
	}
	assert.deepEqual([...replayVerified].sort(), [...apis].sort());
	assert.equal(
		searchRequests.length,
		2,
		'A persisted replay must reuse the saved tool output without performing another search',
	);
	assert.deepEqual(requests, { responses: 3, chat: 3 });
	assert.deepEqual(fixtureErrors, []);
	assert.deepEqual(rendererErrors, []);
	await page.screenshot({ path: '/tmp/freelm-web-native-restored.png' });
	console.log(
		'Native web smoke passed: Responses and Chat Completions tool calls, one active search shimmer, completed Thought for disclosures and expandable saved tools, real SearXNG proxy-prefix requests, no forwarded API credentials, Low thinking effort, rendered citations, and transcript replay after a full restart.',
	);
} catch (error) {
	await page
		?.screenshot({ path: '/tmp/freelm-web-native-failed.png', timeout: 5000 })
		.catch(() => {});
	console.error('Web fixture errors:', fixtureErrors);
	console.error('Electron stderr tail:', stderr);
	throw error;
} finally {
	for (const release of searchReleases.values()) release();
	await stop();
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
	await rm(userData, { recursive: true, force: true });
}
