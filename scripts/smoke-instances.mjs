import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

async function chooseOption(page, control, value) {
	await control.click();
	const escaped = await page.evaluate((value) => CSS.escape(value), value);
	await page.locator(`[role="listbox"] [role="option"][data-value="${escaped}"]`).click();
}

const require = createRequire(import.meta.url);
const directory = await mkdtemp(path.join(os.tmpdir(), 'freelm-instances-'));
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6pAAAAABJRU5ErkJggg==',
	'base64',
);
const requests = [];
const provider = createServer(async (request, response) => {
	const parts = [];
	for await (const part of request) parts.push(part);
	requests.push({
		path: request.url,
		authorization: request.headers.authorization,
		body: Buffer.concat(parts).toString(),
		bytes: Buffer.concat(parts),
	});
	if (request.url === '/v1/models') {
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end(JSON.stringify({ data: [{ id: 'mock-chat' }, { id: 'mock-image' }] }));
	} else if (request.url === '/v1/responses') {
		response.writeHead(200, { 'content-type': 'text/event-stream' });
		response.end(
			'data: {"type":"response.output_text.delta","delta":"Hello from your remote workspace."}\n\ndata: [DONE]\n\n',
		);
	} else if (['/v1/images/generations', '/v1/images/edits'].includes(request.url)) {
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end(
			JSON.stringify({ data: [{ url: `http://127.0.0.1:${provider.address().port}/output.png` }] }),
		);
	} else if (request.url === '/output.png') {
		response.writeHead(200, { 'content-type': 'image/png' });
		response.end(PNG);
	} else {
		response.writeHead(404);
		response.end('Unexpected mock endpoint');
	}
});
await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;
const apps = [];
const errors = [];
async function launch(name) {
	const env = { ...process.env, FREELM_USER_DATA: path.join(directory, name) };
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.FREELM_DEV_URL;
	delete env.FREELM_HOME;
	const app = await electron.launch({ executablePath: require('electron'), args: ['.'], env });
	apps.push(app);
	const page = await app.firstWindow();
	page.on('pageerror', (error) => errors.push(`${name}: ${error.message}`));
	await page.locator('.app-shell').waitFor();
	await page.waitForFunction(
		async () => (await window.desktop.workspaceLoad('local')).state !== null,
	);
	return { app, page };
}
async function configure(page, name) {
	await page.getByRole('button', { name: /Personal workspace/ }).click();
	await page.getByRole('button', { name: 'Connections', exact: true }).click();
	await page.getByLabel('Connection name').fill(`${name} provider`);
	await page.getByLabel('API base URL').fill(baseUrl);
	await page.getByLabel(/API key/).fill(`${name}-provider-secret`);
	await page.getByRole('button', { name: 'Configuration', exact: true }).click();
	await page.getByRole('button', { name: 'Discover models', exact: true }).click();
	await expect(page.getByText('Found 2 models. Configure any model below.')).toBeVisible();
	await page.getByRole('button', { name: 'Configure model mock-chat', exact: true }).click();
	if (name === 'Host') {
		await page.getByLabel('Display name', { exact: true }).fill('Host reasoner');
		for (const value of ['Low', 'Medium', 'High']) {
			await page.getByRole('button', { name: `Add thinking value ${value}`, exact: true }).click();
		}
		await chooseOption(page, page.getByLabel('Default thinking mode', { exact: true }), 'medium');
	} else await page.getByRole('button', { name: 'Add thinking value Low', exact: true }).click();
	await page.getByLabel('Use as default for: Chat', { exact: true }).check();
	await page.getByRole('button', { name: 'Apply model', exact: true }).click();
	await page.getByRole('button', { name: 'Configure model mock-image', exact: true }).click();
	await page.getByLabel('Available in: Chat', { exact: true }).uncheck();
	await page.getByLabel('Available in: Images', { exact: true }).check();
	await page.getByLabel('Input modalities: image', { exact: true }).check();
	await page.getByLabel('Output modalities: text', { exact: true }).uncheck();
	await page.getByLabel('Output modalities: image', { exact: true }).check();
	await page.getByLabel('Use as default for: Images', { exact: true }).check();
	await page.getByRole('button', { name: 'Apply model', exact: true }).click();
	await page.getByRole('button', { name: 'Save settings' }).click();
	await page.getByRole('button', { name: 'Back to workspace', exact: true }).click();
	await createProject(page, `${name} project`);
}
async function createProject(page, name) {
	await page.getByRole('button', { name: 'Code', exact: true }).click();
	await page.getByRole('button', { name: 'New project', exact: true }).click();
	await page.getByLabel('Project name').fill(name);
	const directories = page.getByLabel('Project directories');
	if (await directories.isEditable()) await directories.fill(os.tmpdir());
	await page.getByRole('button', { name: 'Create project', exact: true }).click();
}
const localState = (page) =>
	page.evaluate(async () => (await window.desktop.workspaceLoad('local')).state);
async function unusedPort() {
	const server = createServer();
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const port = server.address().port;
	await new Promise((resolve) => server.close(resolve));
	return port;
}
try {
	const host = await launch('host');
	const client = await launch('client');
	await configure(host.page, 'Host');
	await configure(client.page, 'Client');
	await expect.poll(async () => (await localState(host.page)).projects.length).toBe(1);
	await expect.poll(async () => (await localState(client.page)).projects.length).toBe(1);
	assert.equal((await localState(host.page)).projects[0].kind, 'code');
	assert.equal((await localState(client.page)).projects[0].kind, 'code');
	// An image created locally on the host remains a host-only URL in saved history.
	await host.page.getByRole('button', { name: 'Images', exact: true }).click();
	await host.page.getByLabel('Generation prompt').fill('Existing host image');
	await host.page.getByRole('button', { name: 'Generate image', exact: true }).click();
	await expect(host.page.locator('.media-generated-image')).toHaveAttribute(
		'src',
		/^data:image\/png;base64,/,
	);
	await expect
		.poll(async () => (await localState(host.page)).generations[0]?.status)
		.toBe('completed');
	assert.match(
		(await localState(host.page)).generations[0].assets[0].url,
		/^http:\/\/127\.0\.0\.1:/,
	);
	await host.page.getByRole('button', { name: 'Close image viewer', exact: true }).click();

	// Enable the host and pair through the real desktop UI.
	await host.page.getByRole('button', { name: 'Personal workspace settings', exact: true }).click();
	await host.page
		.getByRole('region', { name: 'Settings', exact: true })
		.getByRole('button', { name: 'Remote FreeLM', exact: true })
		.click();
	await host.page.getByLabel('Sharing name').fill('Studio workstation');
	const port = await unusedPort();
	await host.page.getByLabel('Local FreeLM host port').fill(String(port));
	await host.page.getByRole('button', { name: 'Start sharing' }).click();
	await expect(host.page.getByRole('button', { name: 'Stop sharing' })).toBeVisible();
	const status = await host.page.evaluate(() => window.desktop.instanceStatus());
	assert.equal(status.host.running, true);
	await host.page.getByRole('button', { name: 'Back to workspace', exact: true }).click();
	await client.page
		.getByRole('button', { name: 'Personal workspace settings', exact: true })
		.click();
	await client.page
		.getByRole('region', { name: 'Settings', exact: true })
		.getByRole('button', { name: 'Remote FreeLM', exact: true })
		.click();
	await client.page.getByRole('button', { name: 'Add instance' }).click();
	await client.page.getByLabel('Instance name').fill('Studio workstation');
	await chooseOption(client.page, client.page.getByLabel('Connection method'), 'direct');
	await client.page.getByLabel('Instance URL').fill(`http://127.0.0.1:${port}`);
	await client.page.getByLabel('Access token', { exact: true }).fill(status.host.token);
	await client.page.screenshot({ path: '/tmp/freelm-instances.png' });
	await client.page
		.locator('.instance-edit-form')
		.getByRole('button', { name: 'Connect and open', exact: true })
		.click();
	await expect(client.page.locator('.instance-context-bar')).toContainText('Studio workstation');
	await client.page.getByRole('button', { name: 'Code', exact: true }).click();
	await expect(
		client.page.getByRole('button', { name: 'Host project', exact: true }),
	).toBeVisible();
	await client.page.getByRole('button', { name: 'Host project', exact: true }).click();
	await expect(
		client.page.getByRole('button', { name: 'Client project', exact: true }),
	).toHaveCount(0);
	const paired = await client.page.evaluate(() => window.desktop.instanceStatus());
	const remoteId = paired.instances[0].id;
	const remote = await client.page.evaluate((id) => window.desktop.workspaceLoad(id), remoteId);
	assert.equal(remote.state.connections[0].apiKey, '');
	assert.equal(remote.state.connections[0].catalog[0].defaultThinkingMode, 'medium');
	const remoteModel = client.page.getByRole('button', { name: 'Chat model', exact: true });
	await expect(remoteModel.locator('.composer-model-name')).toHaveText('Host reasoner');
	await expect(remoteModel.locator('.composer-thinking-value')).toHaveText('Medium');
	await client.page.getByRole('button', { name: /Personal workspace/ }).click();
	await expect(client.page.locator('.model-catalog')).toContainText('Host reasoner');
	await expect(client.page.locator('.model-catalog')).toContainText('Low · Medium · High');
	await expect(client.page.getByRole('button', { name: 'Add model', exact: true })).toHaveCount(0);
	await expect(client.page.getByLabel('Enable Host reasoner', { exact: true })).toHaveCount(0);
	await client.page.getByRole('button', { name: 'Back to workspace', exact: true }).click();
	await client.page.getByRole('button', { name: 'Chat model', exact: true }).click();
	await client.page.getByRole('button', { name: 'High', exact: true }).click();
	await client.page.getByRole('slider', { name: 'Thinking mode', exact: true }).press('Escape');

	// Stream with the host's provider connection and persist back to the host.
	await client.page.getByLabel('Message', { exact: true }).fill('Say hello from the workstation');
	await client.page.getByRole('button', { name: 'Send message' }).click();
	await expect(client.page.locator('.message.assistant')).toContainText(
		'Hello from your remote workspace.',
	);
	await expect
		.poll(async () => (await localState(host.page)).threads[0]?.messages.at(-1)?.content)
		.toBe('Hello from your remote workspace.');
	assert.equal(
		requests.find((request) => request.path === '/v1/responses').authorization,
		'Bearer Host-provider-secret',
	);
	assert.deepEqual(
		JSON.parse(requests.find((request) => request.path === '/v1/responses').body).reasoning,
		{ effort: 'high' },
	);
	const hostChat = (await localState(host.page)).threads[0];
	assert.equal(hostChat.kind, 'code');
	assert.equal(hostChat.projectId, (await localState(host.page)).projects[0].id);
	assert.equal(hostChat.thinkingMode, 'high');
	assert.equal(hostChat.messages.at(-1).thinkingMode, 'high');
	assert.equal(hostChat.messages.at(-1).model, 'mock-chat');
	assert.equal((await localState(client.page)).threads.length, 0);
	await client.page.screenshot({ path: '/tmp/freelm-remote-chat.png' });

	// Host-only image URLs are materialized by the host without forwarding its API key.
	await client.page.getByRole('button', { name: 'Images', exact: true }).click();
	await client.page.getByRole('button', { name: 'Open Existing host image', exact: true }).click();
	await expect(client.page.locator('.media-generated-image')).toHaveAttribute(
		'src',
		/^data:image\/png;base64,/,
	);
	await expect(
		client.page.getByRole('link', { name: 'Download image', exact: true }),
	).toHaveAttribute('href', /^data:image\/png;base64,/);
	await client.page.getByLabel('Describe image edits').fill('Make this host image blue');
	await client.page
		.getByRole('dialog', { name: 'Image viewer', exact: true })
		.getByRole('button', { name: 'Edit image', exact: true })
		.click();
	await expect(client.page.locator('.image-viewer-original')).toContainText(
		'Make this host image blue',
	);
	const remoteEdit = requests.find((request) => request.path === '/v1/images/edits');
	assert.equal(remoteEdit.authorization, 'Bearer Host-provider-secret');
	assert.ok(remoteEdit.body.includes('name="image"'));
	assert.ok(remoteEdit.bytes.includes(PNG), 'Remote edits submit the actual source image bytes.');
	assert.ok(
		(await localState(host.page)).generations.some((item) => item.prompt === 'Existing host image'),
	);
	await client.page.getByRole('button', { name: 'Close image viewer', exact: true }).click();
	await client.page.getByLabel('Generation prompt').fill('A remote paper forest');
	await client.page.getByRole('button', { name: 'Generate image', exact: true }).click();
	await expect(client.page.locator('.media-generated-image')).toHaveAttribute(
		'src',
		/^data:image\/png;base64,/,
	);
	await expect
		.poll(async () => (await localState(host.page)).generations[0]?.status)
		.toBe('completed');
	assert.equal(requests.find((request) => request.path === '/output.png').authorization, undefined);
	const profileSource = await readFile(path.join(directory, 'client', 'instances.json'), 'utf8');
	assert.ok(!profileSource.includes(status.host.token));
	const clientSource = await readFile(path.join(directory, 'client', 'workspace.json'), 'utf8');
	assert.ok(!clientSource.includes('Host-provider-secret'));
	assert.ok(!clientSource.includes('A remote paper forest'));
	const clientConfigSource = await readFile(path.join(directory, 'client', 'config.json'), 'utf8');
	assert.ok(!clientConfigSource.includes('Host-provider-secret'));
	assert.ok(!clientConfigSource.includes('Client-provider-secret'));
	assert.ok(!clientConfigSource.includes(status.host.token));
	const clientConfig = JSON.parse(clientConfigSource);
	const clientWorkspace = JSON.parse(clientSource);
	assert.equal(clientConfig.format, 'freelm-config-v1');
	assert.equal(clientConfig.connections.length, 1);
	assert.equal(clientConfig.connections[0].name, 'Client provider');
	assert.equal(clientConfig.connections[0].apiKey, '');
	assert.equal(clientConfig.threads, undefined);
	assert.equal(clientConfig.generations, undefined);
	assert.equal(clientWorkspace.format, 'freelm-workspace-v2');
	assert.equal(clientWorkspace.threads.length, 0);
	assert.equal(clientWorkspace.generations.length, 0);
	assert.equal(clientWorkspace.projects.length, 1);
	assert.equal(clientWorkspace.connections, undefined);
	const hostConfig = JSON.parse(
		await readFile(path.join(directory, 'host', 'config.json'), 'utf8'),
	);
	const hostWorkspace = JSON.parse(
		await readFile(path.join(directory, 'host', 'workspace.json'), 'utf8'),
	);
	assert.equal(hostConfig.format, 'freelm-config-v1');
	assert.equal(hostConfig.connections[0].name, 'Host provider');
	assert.equal(hostConfig.connections[0].apiKey, '');
	assert.equal(hostWorkspace.format, 'freelm-workspace-v2');
	assert.equal(hostWorkspace.threads.length, 1);
	assert.equal(hostWorkspace.generations.length, 3);
	assert.equal(hostWorkspace.projects.length, 1);
	await client.page.getByRole('button', { name: 'Close image viewer', exact: true }).click();

	// A host edit advances authority. The stale client cannot overwrite or create paid work.
	await host.page.evaluate(async () => {
		const snapshot = await window.desktop.workspaceLoad('local');
		snapshot.state.projects.push({
			id: 'another-writer',
			kind: 'code',
			name: 'Host added project',
			instructions: '',
			createdAt: Date.now(),
		});
		await window.desktop.workspaceSave('local', snapshot.revision, snapshot.state);
	});
	const paidBefore = requests.filter((request) => request.path === '/v1/images/generations').length;
	await client.page.getByLabel('Generation prompt').fill('Stale generation must not run');
	await client.page.getByRole('button', { name: 'Generate image', exact: true }).click();
	await expect(client.page.locator('.storage-error')).toContainText(
		/WORKSPACE_CONFLICT|changed on another client/,
	);
	assert.equal(
		requests.filter((request) => request.path === '/v1/images/generations').length,
		paidBefore,
	);
	assert.ok(
		(await localState(host.page)).projects.some((project) => project.id === 'another-writer'),
	);
	await client.page.getByRole('button', { name: 'Reload latest', exact: true }).click();
	await client.page.getByRole('button', { name: 'Back up and reload', exact: true }).click();
	await client.page.getByRole('button', { name: 'Code', exact: true }).click();
	await expect(
		client.page.getByRole('button', { name: 'Host added project', exact: true }),
	).toBeVisible();
	await expect(client.page.locator('.storage-error')).toHaveCount(0);
	const recovery = path.join(directory, 'client', 'recovery');
	const backups = await readdir(recovery);
	assert.equal(backups.length, 1);
	assert.match(
		await readFile(path.join(recovery, backups[0]), 'utf8'),
		/Stale generation must not run/,
	);

	// Offline hosts never trap the user or replace their local workspace.
	await host.page.evaluate(() => window.desktop.hostStop());
	await client.page
		.getByRole('button', { name: 'Personal workspace settings', exact: true })
		.click();
	await client.page
		.getByRole('region', { name: 'Settings', exact: true })
		.getByRole('button', { name: 'Remote FreeLM', exact: true })
		.click();
	await client.page
		.locator('.instance-card')
		.filter({ has: client.page.getByRole('heading', { name: /^This (Mac|computer)$/ }) })
		.getByRole('button', { name: 'Open', exact: true })
		.click();
	await expect(client.page.locator('.instance-context-bar')).toHaveCount(0);
	await expect(client.page.getByRole('dialog', { name: 'Keep a copy and switch?' })).toHaveCount(0);
	assert.equal((await readdir(recovery)).length, backups.length);
	await client.page.getByRole('button', { name: 'Code', exact: true }).click();
	await expect(
		client.page.getByRole('button', { name: 'Client project', exact: true }),
	).toBeVisible();
	await expect(client.page.locator('.instance-context-bar')).toHaveCount(0);
	assert.equal((await localState(client.page)).threads.length, 0);
	assert.equal((await localState(client.page)).generations.length, 0);
	assert.deepEqual(errors, []);
	console.log(
		'Two-instance desktop smoke passed: UI hosting/pairing, remote catalog/thinking persistence and Code/image execution, host-only credentials and media fetching, split config/workspace files with isolated local history, stale media rejection, conflict backup/reload, and offline return to local.',
	);
} finally {
	// Test-only force-close avoids native save prompts if an assertion left a stale renderer.
	for (const app of apps.reverse()) {
		await app.evaluate(({ app }) => app.exit()).catch(() => {});
		await app.close().catch(() => {});
	}
	provider.closeAllConnections();
	await new Promise((resolve) => provider.close(resolve));
	await rm(directory, { recursive: true, force: true });
}
