import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

// Real renderer -> preload -> host -> isolated Python -> provider continuation.
// The model is a deterministic local fixture; all data belongs to a temp profile.
const require = createRequire(import.meta.url);
const home = await mkdtemp(path.join(os.tmpdir(), 'freelm-chat-python-smoke-'));
let rounds = 0,
	desktop;
const providerErrors = [];
const send = (response, data) => {
	response.writeHead(200, { 'content-type': 'text/event-stream' });
	response.end(`data: ${JSON.stringify(data)}\n\n`);
};
const server = createServer(async (request, response) => {
	try {
		assert.equal(request.url, '/v1/responses');
		let raw = '';
		for await (const chunk of request) raw += chunk.toString();
		const body = JSON.parse(raw);
		const python = body.tools.find((tool) => tool.name.startsWith('python_exec_'));
		assert.ok(python, 'Chat must advertise its dedicated Python tool');
		assert.ok(!body.tools.some((tool) => tool.name === 'exec_command'));
		assert.deepEqual(body.reasoning, { effort: 'low' });
		const outputs = body.input.filter((item) => item.type === 'function_call_output');
		rounds++;
		if (rounds <= 2) {
			if (rounds === 2) {
				assert.match(JSON.stringify(outputs), /sum=6/);
				assert.match(JSON.stringify(outputs), /report.csv/);
				assert.ok(
					!JSON.stringify(outputs).includes('data:text/csv;base64'),
					'Files stay in the renderer, not the model continuation',
				);
			}
			const code =
				rounds === 1
					? "total = sum([1, 2, 3])\nprint(f'sum={total}')\nwith open('report.csv', 'w') as file:\n    file.write('value\\n6\\n')"
					: "print(f'persistent={total * 7}')";
			const item = {
				type: 'function_call',
				id: `item-${rounds}`,
				call_id: `python-${rounds}`,
				name: python.name,
				arguments: JSON.stringify({ code }),
				status: 'completed',
			};
			send(response, {
				type: 'response.completed',
				response: { status: 'completed', output: [item] },
			});
		} else {
			assert.equal(rounds, 3);
			assert.match(JSON.stringify(outputs), /persistent=42/);
			send(response, {
				type: 'response.completed',
				response: {
					status: 'completed',
					output: [
						{
							type: 'message',
							role: 'assistant',
							content: [
								{ type: 'output_text', text: 'Python calculated 42 and created your CSV.' },
							],
						},
					],
				},
			});
		}
	} catch (error) {
		providerErrors.push(error.message);
		if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
		response.end(JSON.stringify({ error: { message: error.message } }));
	}
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
try {
	const executablePath = process.env.FREELM_SMOKE_APP || require('electron');
	const env = { ...process.env, FREELM_HOME: home, FREELM_USER_DATA: home };
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.FREELM_DEV_URL;
	desktop = await electron.launch({
		executablePath,
		args: process.env.FREELM_SMOKE_APP
			? [`--user-data-dir=${path.join(home, 'os-profile')}`]
			: ['.'],
		env,
	});
	const page = await desktop.firstWindow();
	const errors = [];
	page.on('pageerror', (error) => errors.push(error.message));
	try {
		await page.getByLabel('Message', { exact: true }).waitFor();
	} catch (error) {
		await page.screenshot({ path: '/tmp/freelm-chat-python-startup-failure.png' }).catch(() => {});
		console.error('Renderer errors:', errors);
		throw error;
	}
	assert.equal(
		(await page.evaluate(() => window.desktop.storageInfo())).location,
		path.join(home, 'config.json'),
	);
	await expect
		.poll(
			() => page.evaluate(async () => Boolean((await window.desktop.workspaceLoad('local')).state)),
			{ timeout: 15_000 },
		)
		.toBe(true);
	await page.evaluate(async (baseUrl) => {
		const snapshot = await window.desktop.workspaceLoad('local');
		const state = snapshot.state;
		const connection = state.connections[0];
		connection.baseUrl = baseUrl;
		connection.models.chat = 'python-fixture';
		connection.catalog = [
			{
				id: 'python-fixture',
				name: 'Python fixture',
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
		];
		state.memorySettings = { savedMemories: false, referenceHistory: false };
		state.toolSettings = {
			enabled: false,
			workspaceRoot: '',
			commandExecution: false,
			approvalMode: 'ask',
			pythonExecution: { enabled: true },
			imageGeneration: { enabled: false, connectionId: '', model: '', size: '', quality: '' },
			mcpServers: [],
			skillDirectories: [],
		};
		state.threads = [
			{
				id: 'python-fixture-chat',
				kind: 'chat',
				title: 'Python smoke',
				titleSource: 'manual',
				connectionId: connection.id,
				model: 'python-fixture',
				thinkingMode: 'low',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				messages: [],
			},
		];
		await window.desktop.workspaceSave('local', snapshot.revision, state);
	}, `http://127.0.0.1:${server.address().port}/v1`);
	await page.reload();
	await page.getByRole('button', { name: 'Python smoke', exact: true }).click();
	await page
		.getByLabel('Message', { exact: true })
		.fill('Calculate the answer with Python and create a CSV.');
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	await expect(
		page.getByText('Python calculated 42 and created your CSV.', { exact: true }),
	).toBeVisible({ timeout: 30_000 });
	const download = page.locator('a[download="report.csv"]').first();
	await expect(download).toBeVisible();
	assert.equal(
		Buffer.from((await download.getAttribute('href')).split(',')[1], 'base64').toString(),
		'value\n6\n',
	);
	await expect
		.poll(async () =>
			page.evaluate(async () => {
				const state = (await window.desktop.workspaceLoad('local')).state;
				return state.threads[0].messages.at(-1).completedAt;
			}),
		)
		.toBeTruthy();
	await page.screenshot({ path: '/tmp/freelm-chat-python.png' });
	assert.equal(rounds, 3);
	assert.deepEqual(errors, []);
	assert.deepEqual(providerErrors, []);
	console.log(
		'Chat Python native smoke passed: advertised Chat-only tool, isolated interpreter, persistent variables, CSV download, model continuation, and saved response.',
	);
} finally {
	if (desktop) {
		const child = desktop.process();
		let timer;
		await Promise.race([
			desktop.close().catch(() => {}),
			new Promise((resolve) => {
				timer = setTimeout(resolve, 5_000);
			}),
		]);
		clearTimeout(timer);
		// A failed startup may never install the renderer's close handshake.
		// Stop only this test's child, whose storage belongs to our temp directory.
		if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
	}
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
	await rm(home, { recursive: true, force: true });
}
