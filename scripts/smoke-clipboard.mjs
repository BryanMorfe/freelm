import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

// Run after npm run build. This uses the real desktop UI/IPC and OS clipboard,
// without contacting providers or opening the user's profile or running app.
// Use a dedicated benign clipboard sentinel; never read/snapshot prior clipboard
// contents. The final clipboard value is also a known fixture sentinel.
const profile = await mkdtemp(path.join(os.tmpdir(), 'freelm-clipboard-smoke-'));
const baseline = process.argv.includes('--baseline');
const checks = [];
const now = Date.now() - 60_000;
const fixture = (kind) => {
	const user = `Copy my ${kind} message exactly.\n\nUnicode: café 🚀 日本語\nFinal line.`;
	const code = `const title = 'café 🚀 日本語';\nconsole.log(title);\n// Preserve indentation and symbols: <>&`;
	const answer = `The ${kind} **answer** retains its Markdown.\n\n\`\`\`typescript\n${code}\n\`\`\`\n\nFinal paragraph.`;
	return { kind, user, code, answer, title: `Clipboard ${kind} fixture` };
};
const fixtures = ['chat', 'code'].map(fixture);
let desktop;
let lastFixtureText;

async function check(name, action) {
	try {
		await action();
		checks.push({ name, passed: true });
	} catch (error) {
		if (!baseline) throw error;
		checks.push({ name, passed: false, error: error.message.split('\n')[0] });
	}
}

try {
	const connection = {
		id: 'clipboard-fixture',
		name: 'Offline clipboard fixture',
		baseUrl: 'http://clipboard-fixture.invalid/v1',
		apiKey: '',
		chatApi: 'responses',
		models: { chat: 'clipboard-model', images: '', videos: '', speech: '', transcription: '' },
		discoveredModels: [],
		catalog: [
			{
				id: 'clipboard-model',
				name: 'Clipboard model',
				enabled: true,
				tasks: ['chat'],
				inputModalities: ['text'],
				outputModalities: ['text'],
				thinkingModes: [
					{ id: 'low', name: 'Low', parameters: { responses: { reasoning: { effort: 'low' } } } },
				],
				defaultThinkingMode: 'low',
			},
		],
	};
	await writeFile(
		path.join(profile, 'config.json'),
		JSON.stringify({
			format: 'freelm-config-v1',
			version: 1,
			theme: 'dark',
			activeConnectionId: connection.id,
			connections: [connection],
			encryptedKeys: {},
			memorySettings: { savedMemories: false, referenceHistory: false },
			backgroundNotifications: false,
			toolSettings: {
				enabled: false,
				commandExecution: false,
				workspaceRoot: '',
				approvalMode: 'ask',
				imageGeneration: { enabled: false, connectionId: '', model: '', size: '', quality: '' },
				mcpServers: [],
				skillDirectories: [],
			},
		}),
		{ mode: 0o600 },
	);
	await writeFile(
		path.join(profile, 'workspace.json'),
		JSON.stringify({
			format: 'freelm-workspace-v2',
			version: 1,
			projects: [],
			generations: [],
			threads: fixtures.map(({ kind, title, user, answer }) => ({
				id: `clipboard-${kind}`,
				kind,
				title,
				titleSource: 'manual',
				connectionId: connection.id,
				model: 'clipboard-model',
				thinkingMode: 'low',
				createdAt: now,
				updatedAt: now + 1000,
				messages: [
					{ id: `${kind}-user`, role: 'user', content: user, createdAt: now },
					{
						id: `${kind}-assistant`,
						role: 'assistant',
						content: answer,
						createdAt: now + 1000,
						completedAt: now + 2000,
					},
				],
			})),
		}),
		{ mode: 0o600 },
	);
	const env = { ...process.env, FREELM_USER_DATA: profile };
	delete env.FREELM_DEV_URL;
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.FREELM_HOME;
	console.log('Launching isolated native clipboard fixture.');
	desktop = await electron.launch({
		// Let Playwright resolve Electron and inject its startup loader. With an
		// explicit executablePath, Playwright 1.63 does not inject that loader.
		args: ['.'],
		env,
		timeout: 30_000,
	});
	console.log('Isolated native clipboard fixture launched.');
	const page = await desktop.firstWindow();
	const rendererErrors = [];
	page.setDefaultTimeout(10_000);
	page.on('pageerror', (error) => rendererErrors.push(error.message));
	page.on('console', (entry) => {
		if (entry.type() === 'error') rendererErrors.push(entry.text());
	});
	await page.locator('.app-shell').waitFor();
	const writeSentinel = async (name) => {
		lastFixtureText = `FreeLM native clipboard fixture: ${name}`;
		await desktop.evaluate(({ clipboard }, text) => clipboard.writeText(text), lastFixtureText);
	};
	const verifyClipboard = async (text) => {
		await expect.poll(() => desktop.evaluate(({ clipboard }) => clipboard.readText())).toBe(text);
		lastFixtureText = text;
	};
	await check('browser clipboard API stays denied by the desktop permission policy', async () => {
		await writeSentinel('browser-policy');
		const rejected = await page.evaluate(async () => {
			try {
				await navigator.clipboard.writeText('This browser write must remain denied.');
				return false;
			} catch {
				return true;
			}
		});
		assert.equal(rejected, true);
		await verifyClipboard(lastFixtureText);
	});
	for (const current of fixtures) {
		await page
			.getByRole('button', { name: current.kind === 'code' ? 'Code' : 'Chat', exact: true })
			.click();
		await page.getByRole('button', { name: current.title, exact: true }).click();
		const user = page.locator('.message.user');
		const assistant = page.locator('.message.assistant');
		await expect(assistant).toContainText('Final paragraph.');
		await check(`${current.kind}: user-message button copies exact multiline Unicode`, async () => {
			await writeSentinel(`${current.kind}-user`);
			await user.hover();
			await user.getByRole('button', { name: 'Copy', exact: true }).click();
			await verifyClipboard(current.user);
			await expect(user.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
		});
		await check(`${current.kind}: assistant button copies original Markdown`, async () => {
			await writeSentinel(`${current.kind}-assistant`);
			await assistant.hover();
			await assistant.getByRole('button', { name: 'Copy', exact: true }).click();
			await verifyClipboard(current.answer);
			await expect(assistant.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
		});
		await check(`${current.kind}: code-block button copies exact source`, async () => {
			await writeSentinel(`${current.kind}-code`);
			const copy = assistant.getByRole('button', { name: 'Copy code', exact: true });
			await copy.click();
			await verifyClipboard(current.code);
			await expect(copy).toContainText('Copied');
		});
		await check(`${current.kind}: context-menu action copies the message`, async () => {
			await writeSentinel(`${current.kind}-context`);
			await user.locator('.message-bubble').click({ button: 'right' });
			await page.getByRole('menuitem', { name: 'Copy message', exact: true }).click();
			await verifyClipboard(current.user);
		});
	}
	const nativeBridge = await page.evaluate(() => typeof window.desktop?.clipboardWriteText);
	if (nativeBridge === 'function') {
		await check('native bridge rejects a non-string without changing clipboard', async () => {
			await writeSentinel('invalid-type');
			const error = await page.evaluate(async () => {
				try {
					await window.desktop.clipboardWriteText({ text: 'invalid clipboard payload' });
					return '';
				} catch (error) {
					return error.message;
				}
			});
			assert.match(error, /string|invalid|text/i);
			await verifyClipboard(lastFixtureText);
		});
		await check(
			'native bridge rejects an untrusted window without changing clipboard',
			async () => {
				await writeSentinel('untrusted-window');
				const error = await desktop.evaluate(async ({ BrowserWindow, app }) => {
					const window = new BrowserWindow({
						show: false,
						webPreferences: {
							preload: `${app.getAppPath()}/dist-electron/preload.cjs`,
							contextIsolation: true,
							nodeIntegration: false,
							sandbox: true,
						},
					});
					try {
						await window.loadURL('data:text/html,<title>Untrusted clipboard fixture</title>');
						return await window.webContents.executeJavaScript(`(async () => {
						try { await window.desktopNative.clipboardWriteText('must not write'); return ''; }
						catch (error) { return error.message; }
					})()`);
					} finally {
						window.destroy();
					}
				});
				assert.match(error, /trusted|unauthorized|untrusted|main window|blocked|not allowed/i);
				await verifyClipboard(lastFixtureText);
			},
		);
	} else {
		assert.ok(baseline, 'The desktop clipboard bridge must exist in the fixed build.');
	}
	assert.deepEqual(rendererErrors, []);
	await expect(page.locator('vite-error-overlay, #webpack-dev-server-client-overlay')).toHaveCount(
		0,
	);
	await page.screenshot({ path: '/tmp/freelm-clipboard-native.png' });
	console.log(
		JSON.stringify(
			{
				title: await page.title(),
				url: page.url(),
				checks,
				passed: checks.filter((check) => check.passed).length,
				rendererErrors,
				screenshot: '/tmp/freelm-clipboard-native.png',
			},
			null,
			2,
		),
	);
	if (checks.some((check) => !check.passed)) process.exitCode = 1;
} finally {
	if (desktop && lastFixtureText !== undefined)
		await desktop
			.evaluate(({ clipboard }) => clipboard.writeText('FreeLM clipboard check completed.'))
			.catch(() => {});
	await desktop?.close();
	await rm(profile, { recursive: true, force: true });
}
