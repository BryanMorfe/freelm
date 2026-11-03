import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import http from 'node:http';
import { zipSync } from 'fflate';

// Isolated actual Electron host/compiler/runtime/renderer. Fixture inference only;
// never reads or edits the user's FreeLM profile or connects a real provider.
const home = await mkdtemp(path.join(os.tmpdir(), 'freelm-plugin-surfaces-smoke-'));
const requests = [],
	held = [];
let holdNext = false,
	desktop,
	page;
const server = http.createServer(async (request, response) => {
	let body = '';
	for await (const chunk of request) body += chunk;
	if (!request.url?.endsWith('/responses')) {
		response.writeHead(404);
		response.end();
		return;
	}
	const parsed = JSON.parse(body);
	requests.push(parsed);
	const content = body.includes('Beta source')
		? 'Explore the next Beta step.'
		: body.includes('Code source')
			? 'Implement the next Code step.'
			: 'Explore the next Alpha step.';
	const finish = () => {
		if (response.destroyed) return;
		response.writeHead(200, { 'content-type': 'text/event-stream' });
		response.end(
			`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: content })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'fixture', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: content }] }], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } })}\n\n`,
		);
	};
	if (holdNext) {
		holdNext = false;
		held.push(finish);
	} else finish();
});
await new Promise((resolve, reject) => {
	server.once('error', reject);
	server.listen(0, '127.0.0.1', resolve);
});
const port = server.address().port;
async function packageExample(name) {
	const source = path.resolve('examples/plugins', name),
		entries = Object.create(null);
	async function collect(dir) {
		for (const item of await readdir(dir, { withFileTypes: true })) {
			const filename = path.join(dir, item.name);
			if (item.isDirectory()) await collect(filename);
			else
				entries[path.relative(source, filename).split(path.sep).join('/')] = new Uint8Array(
					await readFile(filename),
				);
		}
	}
	await collect(source);
	if (name === 'attachment-drawer') {
		const manifest = JSON.parse(new TextDecoder().decode(entries['manifest.json']));
		manifest.contributes.views = [{ id: 'report-panel', entry: 'src/view.ts' }];
		entries['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest));
		let source = new TextDecoder().decode(entries['src/index.ts']);
		source = source.replace(
			'return () => {',
			`const view = context.composer.drawer.addView({id:'interactive-report',view:'report-panel',title:'Interactive report',props:{title:'Interactive report'},height:100}); await view.ready; return () => { view.dispose();`,
		);
		entries['src/index.ts'] = new TextEncoder().encode(source);
		entries['src/view.ts'] = new TextEncoder()
			.encode(`import {getViewProps,onViewPropsChanged,runCommand} from '@freelm/plugin-ui';
		const title=document.createElement('p'),button=document.createElement('button'); button.textContent='Attach from view'; button.onclick=()=>runCommand('attach-report'); document.body.append(title,button);
		function render(props){title.textContent=String(props.title||'Loading view');} render(getViewProps());onViewPropsChanged(render);`);
	}
	const bytes = zipSync(entries),
		filename = path.join(home, `${name}.freelm-plugin`);
	await writeFile(filename, bytes);
	return { bytes, filename };
}
const followup = await packageExample('follow-up'),
	drawer = await packageExample('attachment-drawer'),
	rewrite = await packageExample('rewrite-selection');
function thread(id, title, kind, source) {
	return {
		id,
		title,
		kind,
		titleSource: 'manual',
		connectionId: 'fixture',
		model: 'fixture',
		thinkingMode: 'low',
		createdAt: 1,
		updatedAt: 2,
		messages: [
			{ id: `${id}-u`, role: 'user', content: source, createdAt: 1 },
			{
				id: `${id}-a`,
				role: 'assistant',
				content: 'This task is complete.',
				createdAt: 2,
				completedAt: 3,
			},
		],
	};
}
try {
	await writeFile(
		path.join(home, 'config.json'),
		JSON.stringify({
			format: 'freelm-config-v1',
			version: 1,
			encryptedKeys: {},
			theme: 'dark',
			connections: [
				{
					id: 'fixture',
					name: 'Fixture provider',
					baseUrl: `http://127.0.0.1:${port}/v1`,
					apiKey: '',
					chatApi: 'responses',
					models: { chat: 'fixture', images: '', videos: '', speech: '', transcription: '' },
					discoveredModels: ['fixture'],
					catalog: [
						{
							id: 'fixture',
							name: 'Fixture',
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
					],
				},
			],
			activeConnectionId: 'fixture',
			memorySettings: { savedMemories: false, referenceHistory: false },
			toolSettings: {
				enabled: false,
				workspaceRoot: '',
				commandExecution: false,
				approvalMode: 'ask',
				mcpServers: [],
				skillDirectories: [],
				imageGeneration: {
					enabled: false,
					connectionId: 'fixture',
					model: 'fixture',
					size: '',
					quality: '',
				},
				pythonExecution: { enabled: false },
			},
		}),
	);
	await writeFile(
		path.join(home, 'workspace.json'),
		JSON.stringify({
			format: 'freelm-workspace-v2',
			version: 1,
			projects: [],
			generations: [],
			threads: [
				thread('alpha', 'Plugin Alpha', 'chat', 'Alpha source'),
				thread('beta', 'Plugin Beta', 'chat', 'Beta source'),
				thread('code', 'Plugin Code', 'code', 'Code source'),
			],
		}),
	);
	const env = { ...process.env, FREELM_HOME: home, FREELM_USER_DATA: home };
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.FREELM_DEV_URL;
	const executablePath = process.env.FREELM_SMOKE_EXECUTABLE;
	console.log('Launching isolated surface test app:', home);
	desktop = await electron.launch({
		...(executablePath ? { executablePath, args: [`--user-data-dir=${home}`] } : { args: ['.'] }),
		env,
	});
	desktop.process().stderr?.on('data', (chunk) => process.stderr.write(chunk));
	desktop.process().stdout?.on('data', (chunk) => process.stdout.write(chunk));
	console.log('App process connected.');
	await desktop.evaluate(({ dialog }) => {
		dialog.showErrorBox = (title, content) => {
			console.error('Startup error:', title, content);
		};
	});
	page = await desktop.firstWindow({ timeout: 60000 });
	console.log('Test window opened.');
	page.setDefaultTimeout(30000);
	const errors = [];
	const runtimeErrors = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (message) => {
		if (['error', 'warning'].includes(message.type())) console.log('Renderer:', message.text());
		if (/Plugin surface:/.test(message.text()) && ['error', 'warning'].includes(message.type()))
			runtimeErrors.push(message.text());
	});
	await page.locator('.app-shell').waitFor();
	await page.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name: 'Plugins', exact: true }).click();
	await page.getByRole('button', { name: 'Install plugin', exact: true }).click();
	await page.getByLabel('Choose plugin ZIP', { exact: true }).setInputFiles(followup.filename);
	await expect(page.getByText('Review plugin', { exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Install reviewed plugin', exact: true }).click();
	await expect(
		page.getByRole('switch', { name: 'Enable Follow-up Prompts', exact: true }),
	).toBeVisible({
		timeout: 60000,
	});
	const snapshot = await page.evaluate(() => window.desktop.pluginSnapshot());
	assert.equal(
		snapshot.accounts.length,
		0,
		'Accountless surface plugin unexpectedly created an account.',
	);
	console.log('Follow-up ZIP reviewed, compiled, installed without accounts.');
	await page.getByRole('navigation', { name: 'Workspaces', exact: true }).getByRole('button', { name: 'Home', exact: true }).click();
	await page.getByRole('button', { name: 'Plugin Alpha', exact: true }).click();
	const editor = page.getByRole('textbox', { name: 'Message', exact: true });
	const hint = page.getByRole('button', { name: 'Tab to use', exact: true });
	await expect(hint).toBeVisible({ timeout: 60000 });
	await expect(page.locator('.cm-placeholder')).toHaveText('Explore the next Alpha step.');
	assert.equal(requests.at(-1).model, 'fixture');
	assert.equal(requests.at(-1).reasoning.effort, 'low');
	await editor.click();
	await editor.press('Tab');
	await expect(editor).toHaveText('Explore the next Alpha step.');
	assert.equal(
		(await page.evaluate(() => window.desktop.workspaceLoad('local'))).state.threads.find(
			(t) => t.id === 'alpha',
		).messages.length,
		2,
		'Accepting a plugin edit sent a message.',
	);
	await editor.press('ControlOrMeta+z');
	await expect(editor.locator('.cm-placeholder')).toBeVisible();
	await expect(hint).toHaveCount(0);
	console.log(
		'Real provider-shaped fixture response became a placeholder; Tab edits, Undo works, no submission.',
	);
	const beforeCompletion = requests.length;
	await editor.fill('What about another step?');
	await editor.press('Enter');
	await expect(hint).toBeVisible({ timeout: 60000 });
	await expect.poll(() => requests.length).toBeGreaterThanOrEqual(beforeCompletion + 2);
	await expect
		.poll(
			async () =>
				(await page.evaluate(() => window.desktop.workspaceLoad('local'))).state.threads.find(
					(thread) => thread.id === 'alpha',
				).messages.length,
		)
		.toBe(4);
	console.log('A new assistant completion triggers the independent follow-up plugin.');
	holdNext = true;
	const beforeTyping = requests.length;
	await page.getByRole('button', { name: 'Plugin Beta', exact: true }).click();
	await expect.poll(() => requests.length).toBeGreaterThan(beforeTyping);
	await editor.fill('Keep my draft');
	held.shift()?.();
	await expect(editor).toHaveText('Keep my draft');
	await expect(hint).toHaveCount(0);
	await editor.fill('');
	await expect(hint).toHaveCount(0);
	holdNext = true;
	const beforeSwitch = requests.length;
	await page.getByRole('button', { name: 'Plugin Alpha', exact: true }).click();
	await expect.poll(() => requests.length).toBeGreaterThan(beforeSwitch);
	await page.getByRole('button', { name: 'Plugin Beta', exact: true }).click();
	await expect(hint).toBeVisible({ timeout: 60000 });
	held.shift()?.();
	await expect(page.locator('.cm-placeholder')).toHaveText('Explore the next Beta step.');
	await page.screenshot({ path: '/tmp/freelm-plugin-follow-up-dark.png' });
	await page.evaluate(async () => {
		await window.desktop.pluginCommand({
			type: 'enable',
			pluginId: 'dev.freelm.follow-up',
			enabled: false,
		});
		window.dispatchEvent(new Event('freelm:plugins-changed'));
	});
	await expect(hint).toHaveCount(0);
	console.log('Typing and thread switches reject stale results; disabling removes contributions.');
	for (const pkg of [drawer, rewrite])
		await page.evaluate(
			async (bytes) => {
				const review = await window.desktop.pluginPreparePackage(bytes);
				await window.desktop.pluginInstallPackage(review.reviewId);
				window.dispatchEvent(new Event('freelm:plugins-changed'));
			},
			[...pkg.bytes],
		);
	await expect(page.getByText('Prepared report', { exact: true })).toBeVisible({ timeout: 60000 });
	await editor.fill('make this uppercase');
	await expect(page.getByText('Prepared report', { exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Attach', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Remove report.txt' })).toBeVisible();
	await editor.click();
	await editor.press('ControlOrMeta+a');
	await page.getByRole('button', { name: 'Uppercase selection', exact: true }).click();
	await expect(editor).toHaveText('MAKE THIS UPPERCASE');
	await editor.click();
	await editor.press('ControlOrMeta+z');
	await expect(editor).toHaveText('make this uppercase');
	const frame = page.frameLocator('iframe[title="Interactive report"]');
	await expect(frame.getByText('Interactive report', { exact: true })).toBeVisible();
	const isolated = await frame.locator('body').evaluate(() => ({
		desktop: typeof window.desktop,
		process: typeof window.process,
		parentAccess: (() => {
			try {
				return !!parent.document.body;
			} catch {
				return false;
			}
		})(),
	}));
	assert.deepEqual(isolated, { desktop: 'undefined', process: 'undefined', parentAccess: false });
	await page.getByRole('button', { name: 'Remove report.txt' }).click();
	await frame.getByRole('button', { name: 'Attach from view', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Remove report.txt' })).toBeVisible();
	console.log(
		'Declared sandbox drawer view received props and invoked its own registered attachment command.',
	);
	await page.screenshot({ path: '/tmp/freelm-plugin-drawer-dark.png' });
	await page.evaluate(async () => {
		await window.desktop.pluginCommand({
			type: 'enable',
			pluginId: 'dev.freelm.attachment-drawer',
			enabled: false,
		});
		window.dispatchEvent(new Event('freelm:plugins-changed'));
	});
	await expect(page.getByText('Prepared report', { exact: true })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Remove report.txt' })).toBeVisible();
	const picker = page.getByRole('combobox', { name: 'Conversation mode', exact: true });
	await picker.click();
	await page.getByRole('listbox').locator('[role="option"][data-value="code"]').click();
	await page.getByRole('button', { name: 'Plugin Code', exact: true }).click();
	await expect(
		page.getByRole('button', { name: 'Uppercase selection', exact: true }),
	).toBeVisible();
	await editor.fill('code draft');
	await editor.press('ControlOrMeta+a');
	await page.getByRole('button', { name: 'Uppercase selection', exact: true }).click();
	await expect(editor).toHaveText('CODE DRAFT');
	console.log('Selected-text extension edited the actual Code composer.');
	await editor.fill('');
	await page.evaluate(async () => {
		await window.desktop.pluginCommand({
			type: 'enable',
			pluginId: 'dev.freelm.follow-up',
			enabled: true,
		});
		window.dispatchEvent(new Event('freelm:plugins-changed'));
	});
	await expect(hint).toBeVisible({ timeout: 60000 });
	await expect(page.locator('.cm-placeholder')).toHaveText('Implement the next Code step.');
	await page.getByRole('button', { name: 'Personal workspace settings', exact: true }).click();
	await page.getByRole('button', { name: 'Appearance', exact: true }).click();
	await page.getByRole('radio', { name: 'Light', exact: true }).click();
	await page.getByRole('button', { name: 'Save settings', exact: true }).click();
	await page.getByRole('button', { name: 'Back to workspace', exact: true }).click();
	await expect(hint).toBeVisible({ timeout: 60000 });
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
	await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(950, 750));
	await page.screenshot({ path: '/tmp/freelm-plugin-code-light-narrow.png' });
	console.log(
		'Code follow-up works with the same SDK; actual Light appearance renders in a narrow window.',
	);
	assert.deepEqual(errors, []);
	assert.deepEqual(
		runtimeErrors,
		[],
		'An installed surface plugin reported an unexpected runtime error.',
	);
	console.log(
		'PASS: actual ZIP compilation/runtime/inference + Chat/Code placeholder, Tab/Undo, stale cancellation, isolated drawer attachments, selection rewrite and disable cleanup.',
	);
} catch (error) {
	console.error('Fixture requests:', requests.length);
	if (page && !page.isClosed()) {
		await page.screenshot({ path: '/tmp/freelm-plugin-surface-failure.png' }).catch(() => {});
		console.error(
			await page
				.locator('body')
				.innerText()
				.catch(() => ''),
		);
		console.error(
			JSON.stringify(await page.evaluate(() => window.desktop.pluginSnapshot()).catch(() => null)),
		);
	}
	throw error;
} finally {
	for (const finish of held) finish();
	if (desktop) {
		const timer = setTimeout(() => desktop.process().kill('SIGKILL'), 5000);
		await desktop.close().catch(() => {});
		clearTimeout(timer);
	}
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
	await rm(home, { recursive: true, force: true });
}
