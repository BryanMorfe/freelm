import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

// Isolated native renderer/preload/host/MCP/model continuation. No real accounts.
const home = await mkdtemp(path.join(os.tmpdir(), 'freelm-plugins-smoke-'));
const failures = [], calls = [];
let desktop;
const server = createServer(async (request, response) => {
	try {
		if (request.method !== 'POST') { response.writeHead(405).end(); return; }
		let raw = '';
		for await (const chunk of request) raw += chunk;
		const body = JSON.parse(raw);
		if (request.url === '/mcp') {
			if (body.id === undefined) { response.writeHead(202).end(); return; }
			let result;
			if (body.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'Fixture', version: '1' } };
			else if (body.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Read a fixture item.', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] };
			else if (body.method === 'tools/call') {
				assert.equal(body.params.name, 'echo');
				calls.push(body.params.arguments.text);
				result = { content: [{ type: 'text', text: `Fixture echoed: ${body.params.arguments.text}` }] };
			} else result = {};
			response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
			return;
		}
		assert.ok(['/v1/responses', '/v1/chat/completions'].includes(request.url));
		const responses = request.url.endsWith('/responses');
		const plugin = body.tools?.find(t => (t.name || t.function?.name)?.startsWith('plugin_'));
		assert.ok(plugin, `Plugin tools must reach the selected model: ${JSON.stringify({ model: body.model, instructions: String(body.instructions || body.messages?.[0]?.content || '').slice(0, 180) })}`);
		const name = plugin.name || plugin.function.name;
		const history = responses ? body.input : body.messages;
		const hasResult = history.some(item => item.type === 'function_call_output' || item.role === 'tool');
		const text = `Plugin round trip passed for ${body.model}.`;
		response.writeHead(200, { 'content-type': 'text/event-stream' });
		if (responses) {
			const output = hasResult
				? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }]
				: [{ type: 'function_call', id: 'item-plugin', call_id: 'call-plugin', name, arguments: JSON.stringify({ text: body.model }), status: 'completed' }];
			response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'res-plugin', status: 'completed', output } })}\n\n`);
		} else {
			const delta = hasResult ? { content: text } : { tool_calls: [{ index: 0, id: 'call-plugin', type: 'function', function: { name, arguments: JSON.stringify({ text: body.model }) } }] };
			response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
			response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: hasResult ? 'stop' : 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
		}
	} catch (error) {
		failures.push(error.message);
		if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
		response.end(JSON.stringify({ error: { message: error.message } }));
	}
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;
try {
	// Seed before renderer startup so initialization saves cannot race fixture setup.
	await writeFile(path.join(home, 'config.json'), JSON.stringify({
		format: 'freelm-config-v1', version: 1, encryptedKeys: {}, theme: 'dark', activeConnectionId: 'provider-0',
		memorySettings: { savedMemories: false, referenceHistory: false },
		toolSettings: { enabled: false, workspaceRoot: '', commandExecution: false, approvalMode: 'ask', mcpServers: [], skillDirectories: [], imageGeneration: { enabled: false, connectionId: '', model: '', size: '', quality: '' }, pythonExecution: { enabled: false } },
		connections: ['responses', 'chat/completions'].map((chatApi, i) => ({
			id: `provider-${i}`, name: `Fixture ${i}`, baseUrl: `${endpoint}/v1`, apiKey: '', chatApi,
			models: { chat: `model-${i}`, images: '', videos: '', speech: '', transcription: '' }, discoveredModels: [],
			catalog: [{ id: `model-${i}`, name: `Model ${i}`, enabled: true, tasks: ['chat'], inputModalities: ['text'], outputModalities: ['text'], thinkingModes: [{ id: 'low', name: 'Low', parameters: { responses: { reasoning: { effort: 'low' } }, chat: { reasoning_effort: 'low' } } }] }],
		})),
	}));
	await writeFile(path.join(home, 'workspace.json'), JSON.stringify({
		format: 'freelm-workspace-v2', version: 1, projects: [], generations: [],
		threads: [0, 1].map(i => ({ id: `chat-${i}`, kind: 'chat', title: `Plugin chat ${i}`, titleSource: 'manual', connectionId: `provider-${i}`, model: `model-${i}`, thinkingMode: 'low', messages: [], createdAt: Date.now(), updatedAt: Date.now() })),
	}));
	const env = { ...process.env, FREELM_HOME: home, FREELM_USER_DATA: home };
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.FREELM_DEV_URL;
	const executablePath = process.env.FREELM_SMOKE_EXECUTABLE;
	desktop = await electron.launch({ ...(executablePath ? { executablePath, args: [`--user-data-dir=${home}`] } : { args: ['.'] }), env });
	const page = await desktop.firstWindow();
	page.setDefaultTimeout(15000);
	const errors = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.locator('.app-shell').waitFor();
	await page.evaluate(async endpoint => {
		await window.desktop.pluginCommand({ type: 'install', manifest: { manifestVersion: 1, id: 'org.freelm.fixture', name: 'Fixture plugin', version: '1.0.0', description: 'Native test only.', mcp: { url: `${endpoint}/mcp` }, auth: { type: 'none' } } });
		await window.desktop.pluginCommand({ type: 'connect', pluginId: 'org.freelm.fixture', label: 'Fixture account' });
	}, endpoint);
	await page.reload();
	await page.locator('.app-shell').waitFor();
	console.log('Fixture profile and plugin loaded.');
	const account = await page.evaluate(async () => (await window.desktop.pluginSnapshot()).accounts[0]);
	assert.equal(account.access.chat, false);
	assert.deepEqual(account.access.tools, []);
	await page.evaluate(async accountId => {
		await window.desktop.pluginCommand({ type: 'discover', accountId });
		await window.desktop.pluginCommand({ type: 'access', accountId, access: { chat: true, code: true, botIds: ['bot-0', 'bot-1'], tools: ['echo'], allowRemote: false } });
	}, account.id);
	for (const i of [0, 1]) {
		console.log(`Checking Chat API ${i}.`);
		await page.getByRole('button', { name: `Plugin chat ${i}`, exact: true }).click();
		await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Use the fixture plugin to read the item.');
		await page.getByRole('textbox', { name: 'Message', exact: true }).press('Enter');
		await expect(page.getByText(`Plugin round trip passed for model-${i}.`, { exact: true })).toBeVisible({ timeout: 20000 });
	}
	await page.evaluate(async () => {
		const bridge = window.desktop;
		const { host } = await bridge.botsSnapshot('local');
		for (const i of [0, 1]) {
			await bridge.botsCommand('local', { type: 'create-bot', id: `bot-${i}`, profile: { name: `Plugin bot ${i}`, identity: 'A test companion.', connectionId: `provider-${i}`, model: `model-${i}`, thinkingMode: 'low', historyAccess: false, personalityLearning: false } });
			await bridge.botsCommand('local', { type: 'create-conversation', id: `bot-chat-${i}`, participants: [{ hostId: host.id, botId: `bot-${i}` }] });
			await bridge.botsCommand('local', { type: 'send', conversationId: `bot-chat-${i}`, messageId: `message-${i}`, content: 'Use the fixture plugin.' });
		}
	});
	for (const i of [0, 1]) {
		await expect.poll(() => page.evaluate(async id => (await window.desktop.botsSnapshot('local')).conversations.find(c => c.id === id)?.messages.findLast(m => m.role === 'bot')?.content, `bot-chat-${i}`), { timeout: 20000 }).toBe(`Plugin round trip passed for model-${i}.`);
	}
	const denial = await page.evaluate(async accountId => {
		const bridge = window.desktop;
		const offered = await bridge.toolCatalog('local', 'revoke-run', 'chat-0');
		const tool = offered.tools.find(t => t.source === 'plugin');
		if (!tool) throw new Error('No plugin catalog entry to revoke');
		await bridge.pluginCommand({ type: 'access', accountId, access: { chat: false, code: false, botIds: [], tools: [], allowRemote: false } });
		try {
			const result = await bridge.toolExecute({ workspaceId: 'local', threadId: 'chat-0', runId: 'revoke-run', name: tool.name, arguments: { text: 'must-not-run' } });
			return { blocked: result.isError === true };
		} catch { return { blocked: true }; }
		finally { await bridge.toolCancel('revoke-run'); }
	}, account.id);
	assert.equal(denial.blocked, true);
	assert.ok(!calls.includes('must-not-run'));
	assert.equal(calls.length, 4);
	assert.deepEqual(failures, []);
	assert.deepEqual(errors, []);
	await page.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name: 'Plugins', exact: true }).click();
	await expect(page.getByText('Fixture plugin', { exact: true }).first()).toBeVisible();
	await page.screenshot({ path: '/tmp/freelm-plugins-native.png' });
	const registry = await readFile(path.join(home, 'plugins', 'registry.json'), 'utf8').catch(() => '');
	console.log(`PASS: native plugin import/account/discovery, Chat and Bots both API formats, disabled-by-default grants and live revocation; ${calls.length} fixture calls. Stored registry bytes: ${registry.length}.`);
} finally {
	if (desktop) await desktop.close();
	server.closeAllConnections();
	await new Promise(resolve => server.close(resolve));
	await rm(home, { recursive: true, force: true });
}
