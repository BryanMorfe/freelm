import { _electron as electron, expect as baseExpect } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const expect = baseExpect.configure({ timeout: 20_000 });

// The real built renderer, preload, native browser, and filesystem service. All
// state and files are disposable, with only a loopback page and no model requests.
const profile = await mkdtemp(path.join(os.tmpdir(), 'freelm-code-surface-'));
const workdir = path.join(profile, 'workspace');
await mkdir(path.join(workdir, 'src'), { recursive: true });
await writeFile(
	path.join(workdir, 'README.md'),
	'# Surface fixture\n\nA **rendered** Markdown file.\n',
);
await writeFile(
	path.join(workdir, 'src', 'app.ts'),
	Array.from({ length: 45 }, (_, i) => `export const line${i + 1} = ${i + 1};`).join('\n'),
);
const seedModule = path.join(profile, 'seed.mjs');
await build({
	stdin: {
		contents:
			'export { initialState } from "./src/lib/state"; export { StateStore } from "./electron/state-store"; export { defaultToolSettings } from "./src/lib/tool-settings";',
		resolveDir: process.cwd(),
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	outfile: seedModule,
});
const { initialState, StateStore, defaultToolSettings } = await import(
	pathToFileURL(seedModule).href
);
const requests = [];
const server = createServer((request, response) => {
	requests.push(request.url);
	response.setHeader('Content-Type', 'text/html');
	response.end(
		'<!doctype html><html><head><title>Surface preview</title></head><body style="margin:0;background:#eef0f4;font:16px system-ui"><button id="sample-button" style="position:absolute;left:50px;top:60px;width:200px;height:60px;background:#44c48e" onclick="window.clicked=true">Preview button</button><p style="margin:160px 40px">A local browser fixture.</p></body></html>',
	);
});
let desktop;
try {
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const base = `http://127.0.0.1:${server.address().port}`;
	const state = initialState();
	state.theme = 'dark';
	state.backgroundNotifications = false;
	state.memorySettings = { savedMemories: false, referenceHistory: false };
	state.toolSettings = { ...defaultToolSettings(), enabled: false, workspaceRoot: workdir };
	state.connections[0].baseUrl = `${base}/v1`;
	state.connections[0].models.chat = 'surface-model';
	state.connections[0].catalog = [
		{
			id: 'surface-model',
			name: 'Surface model',
			enabled: true,
			tasks: ['chat'],
			inputModalities: ['text', 'image'],
			outputModalities: ['text'],
			thinkingModes: [
				{ id: 'low', name: 'Low', parameters: { responses: { reasoning: { effort: 'low' } } } },
			],
		},
	];
	state.projects = [
		{
			id: 'surface-project',
			kind: 'code',
			name: 'Surface project',
			instructions: '',
			directories: [workdir],
			createdAt: 1,
		},
	];
	state.threads = [
		{
			id: 'surface-task',
			kind: 'code',
			projectId: 'surface-project',
			title: 'Surface task',
			titleSource: 'manual',
			connectionId: state.activeConnectionId,
			model: 'surface-model',
			thinkingMode: 'low',
			createdAt: 1,
			updatedAt: 2,
			messages: [
				{ id: 'user', role: 'user', content: 'Review the workspace.', createdAt: 1 },
				{
					id: 'answer',
					role: 'assistant',
					content: `Read [app.ts line 32](${workdir}/src/app.ts:32) and [Workspace notes](${workdir}/README.md). Open [Agent preview](${base}/linked-page), or visit ${base}/linked-page.`,
					createdAt: 2,
					completedAt: 3,
				},
				{
					id: 'math-answer',
					role: 'assistant',
					content: `For $x^2$, open [Math preview](${base}/linked-page).`,
					createdAt: 4,
					completedAt: 5,
				},
			],
		},
	];
	await new StateStore(
		path.join(profile, 'workspace.json'),
		{
			available: () => false,
			encrypt: () => {
				throw new Error('No fixture secrets');
			},
			decrypt: () => {
				throw new Error('No fixture secrets');
			},
		},
		path.join(profile, 'config.json'),
	).save(state);
	const env = { ...process.env, FREELM_HOME: profile, FREELM_USER_DATA: profile };
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.FREELM_DEV_URL;
	const executablePath = process.env.FREELM_SMOKE_EXECUTABLE;
	desktop = await electron.launch({
		...(executablePath
			? { executablePath, args: [`--user-data-dir=${path.join(profile, 'electron')}`] }
			: { args: ['.'] }),
		env,
	});
	const page = await desktop.firstWindow();
	page.setDefaultTimeout(20_000);
	const errors = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await expect(page.getByRole('button', { name: 'Home', exact: true })).toBeVisible({
		timeout: 30_000,
	});
	const picker = page.getByRole('combobox', { name: 'Conversation mode', exact: true });
	await picker.click();
	await page.getByRole('listbox').locator('[role="option"][data-value="code"]').click();
	await page.getByRole('button', { name: 'Surface task', exact: true }).click();
	await page.getByRole('link', { name: 'Workspace notes', exact: true }).click();
	const surface = page.getByRole('region', { name: 'Code workspace tabs', exact: true });
	await expect(surface).toBeVisible();
	await expect(surface.getByRole('heading', { name: 'Surface fixture' })).toBeVisible();
	await surface.getByRole('button', { name: 'Source', exact: true }).click();
	await expect(surface.locator('.cm-content')).toContainText('# Surface fixture');
	await surface.getByRole('button', { name: 'Preview', exact: true }).click();
	await page.getByRole('link', { name: 'app.ts line 32', exact: true }).click();
	await expect(surface.locator('[role="tabpanel"]:visible .cm-content')).toContainText('line32');
	await expect(surface.locator('[role="tabpanel"]:visible .cm-activeLine')).toContainText('line32');
	// CodeMirror can paint the text and initial keyword tokens before its deferred
	// parser reaches the numeric literals. Wait for actual tokenization, not a
	// fixed delay or just the first spans, before comparing syntax colors.
	await expect
		.poll(
			() =>
				surface
					.locator('[role="tabpanel"]:visible .cm-content .cm-line span')
					.evaluateAll((elements) =>
						elements.some((element) => /^\d+$/.test(element.textContent?.trim() ?? '')),
					),
			{ message: 'TypeScript numeric literals should be syntax-highlighted', timeout: 20_000 },
		)
		.toBe(true);
	const tokens = await surface
		.locator('[role="tabpanel"]:visible .cm-content .cm-line span')
		.evaluateAll((elements) =>
			elements.map((element) => ({
				text: element.textContent,
				classes: element.className,
				color: getComputedStyle(element).color,
			})),
		);
	console.log(
		JSON.stringify({
			sourceTokenColors: [...new Set(tokens.map((token) => token.color))],
			sampleTokens: tokens.slice(0, 12),
		}),
	);
	assert(
		new Set(tokens.map((token) => token.color)).size > 1,
		`Source syntax colors are missing: ${JSON.stringify({
			tokens: tokens.slice(0, 24),
			diagnostics: await surface
				.locator('[role="tabpanel"]:visible .cm-content')
				.evaluate((content) => {
					const element = content.querySelector('.cm-line span');
					const style = getComputedStyle(content);
					const rules = [];
					for (const sheet of document.styleSheets) {
						try {
							for (const rule of sheet.cssRules)
								if (element && 'selectorText' in rule && element.matches(rule.selectorText))
									rules.push(rule.cssText);
						} catch {}
					}
					return {
						keyword: style.getPropertyValue('--code-keyword'),
						string: style.getPropertyValue('--code-string'),
						number: style.getPropertyValue('--code-number'),
						rules,
						html: content.innerHTML.slice(0, 1500),
					};
				}),
		})}`,
	);
	// Observe actual Electron routing while preventing a broken link handler from
	// opening the user's external browser. The profile remains fully disposable.
	await desktop.evaluate(({ shell }) => {
		globalThis.__surfaceExternalLinks = [];
		shell.openExternal = async (url) => {
			globalThis.__surfaceExternalLinks.push(url);
		};
	});
	const linkedUrl = `${base}/linked-page`;
	const beforeLinkTabs = await surface.getByRole('tab').count();
	await page.getByRole('link', { name: 'Agent preview', exact: true }).click();
	await expect(surface.getByRole('textbox', { name: 'Browser address', exact: true })).toHaveValue(
		linkedUrl,
	);
	await expect
		.poll(() =>
			desktop.evaluate(
				({ webContents }, url) =>
					webContents
						.getAllWebContents()
						.filter((item) => item.getURL() === url && !item.isLoading()).length,
				linkedUrl,
			),
		)
		.toBe(1);
	const linkedPanel = await surface
		.getByRole('tab', { selected: true })
		.getAttribute('aria-controls');
	for (const label of [linkedUrl, 'Math preview']) {
		await page.getByRole('link', { name: 'Workspace notes', exact: true }).click();
		await page.getByRole('link', { name: label, exact: true }).click();
		await expect(surface.getByRole('tab', { selected: true })).toHaveAttribute(
			'aria-controls',
			linkedPanel,
		);
		await expect(
			surface.getByRole('textbox', { name: 'Browser address', exact: true }),
		).toHaveValue(linkedUrl);
		await expect(surface.getByRole('tab')).toHaveCount(beforeLinkTabs + 1);
	}
	assert.deepEqual(await desktop.evaluate(() => globalThis.__surfaceExternalLinks), []);
	await surface.getByRole('button', { name: 'New workspace tab', exact: true }).click();
	await surface.getByRole('menuitem', { name: 'Browser', exact: true }).click();
	const browserPanelId = await surface
		.getByRole('tab', { name: 'Browser', exact: true })
		.getAttribute('aria-controls');
	const browserTabId = browserPanelId.replace(/^workspace-tab-/, '');
	const browserState = () =>
		page.evaluate(
			async (tabId) => (await window.desktop.codeBrowser({ action: 'state', tabId })).state,
			browserTabId,
		);
	await expect(
		surface.getByRole('heading', { name: 'Browse beside your task', exact: true }),
	).toBeVisible();
	await expect.poll(async () => (await browserState().catch(() => undefined))?.visible).toBe(false);
	const address = surface.getByRole('textbox', { name: 'Browser address', exact: true });
	await address.fill(`${base}/page`);
	await address.press('Enter');
	await expect
		.poll(() =>
			desktop.evaluate(
				({ webContents }, base) =>
					webContents
						.getAllWebContents()
						.some((item) => item.getURL() === `${base}/page` && !item.isLoading()),
				base,
			),
		)
		.toBe(true);
	const isolation = await desktop.evaluate(async ({ webContents }, base) => {
		const contents = webContents
			.getAllWebContents()
			.find((item) => item.getURL() === `${base}/page`);
		return contents.executeJavaScript(
			'({process:typeof process, require:typeof require, bridge:typeof window.desktop})',
		);
	}, base);
	assert.deepEqual(isolation, { process: 'undefined', require: 'undefined', bridge: 'undefined' });
	await surface.getByRole('button', { name: 'Annotate page', exact: true }).click();
	await expect
		.poll(() =>
			desktop.evaluate(async ({ webContents }, base) => {
				const contents = webContents
					.getAllWebContents()
					.find((item) => item.getURL() === `${base}/page`);
				return contents.executeJavaScriptInIsolatedWorld(1007, [
					{ code: '!!globalThis.__freelmBrowserOverlay' },
				]);
			}, base),
		)
		.toBe(true);
	await desktop.evaluate(async ({ webContents }, base) => {
		const contents = webContents
			.getAllWebContents()
			.find((item) => item.getURL() === `${base}/page`);
		if (!contents.debugger.isAttached()) contents.debugger.attach('1.3');
		await contents.debugger.sendCommand('Input.dispatchMouseEvent', {
			type: 'mouseMoved',
			x: 90,
			y: 90,
		});
		// Let Chromium composite the selection outline before pressing the pointer.
		await new Promise((resolve) => setTimeout(resolve, 200));
		await contents.debugger.sendCommand('Input.dispatchMouseEvent', {
			type: 'mousePressed',
			x: 90,
			y: 90,
			button: 'left',
			buttons: 1,
			clickCount: 1,
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		await contents.debugger.sendCommand('Input.dispatchMouseEvent', {
			type: 'mouseReleased',
			x: 90,
			y: 90,
			button: 'left',
			buttons: 0,
			clickCount: 1,
		});
	}, base);
	await surface
		.getByRole('textbox', { name: 'Annotation comment', exact: true })
		.fill('Make this button blue.');
	await surface.getByRole('button', { name: 'Add comment', exact: true }).click();
	await expect(surface.getByText('1 annotation', { exact: true })).toBeVisible();
	await surface.getByRole('button', { name: 'Exit annotation mode', exact: true }).click();
	await surface.getByRole('button', { name: 'Annotate', exact: true }).click();
	await expect(surface.getByText('1 annotation', { exact: true })).toBeVisible();
	await surface.getByRole('button', { name: 'Add to message', exact: true }).click();
	const composer = page.getByRole('textbox', { name: 'Message', exact: true });
	await expect(composer).toContainText('Make this button blue.');
	await expect(composer).not.toContainText('#sample-button');
	await expect(
		page.getByRole('img', { name: 'browser-annotations.png', exact: true }),
	).toBeVisible();
	await expect(
		page
			.locator('.attachment-document')
			.getByText('Browser annotation context.txt', { exact: true }),
	).toBeVisible();
	await page.evaluate(() => window.dispatchEvent(new Event('freelm:flush-drafts')));
	let contextAttachment;
	await expect
		.poll(async () => {
			contextAttachment = await page.evaluate(async () => {
				const snapshot = await window.desktop.workspaceLoad('local');
				return Object.values(snapshot.state?.chatDrafts || {})
					.flatMap((draft) => draft.attachments || [])
					.find((item) => item.name === 'Browser annotation context.txt');
			});
			return !!contextAttachment;
		})
		.toBe(true);
	const comma = contextAttachment.dataUrl.indexOf(',');
	const payload = contextAttachment.dataUrl.slice(comma + 1);
	const metadata = contextAttachment.dataUrl.slice(0, comma).endsWith(';base64')
		? Buffer.from(payload, 'base64').toString('utf8')
		: decodeURIComponent(payload);
	assert.match(metadata, /#sample-button/);
	assert.equal(
		requests.some((url) => url?.startsWith('/v1/')),
		false,
		'Annotations must remain an unsent draft',
	);
	await surface.getByRole('button', { name: 'Expand workspace tabs', exact: true }).click();
	await expect(
		surface.getByRole('button', { name: 'Restore split view', exact: true }),
	).toBeVisible();
	await surface.getByRole('button', { name: 'Restore split view', exact: true }).click();
	await page.getByRole('button', { name: 'Hide workspace tabs', exact: true }).click();
	await expect(surface).toBeHidden();
	await expect.poll(async () => (await browserState()).visible).toBe(false);
	await page.getByRole('button', { name: 'Show workspace tabs', exact: true }).click();
	await expect(surface).toBeVisible();
	await expect.poll(async () => (await browserState()).visible).toBe(true);
	await page.screenshot({ path: '/tmp/freelm-native-code-surface.png' });
	assert.deepEqual(errors, []);
	console.log(
		JSON.stringify({
			result: 'passed',
			markdown: 'preview/source',
			fileLink: 'line 32',
			webLinks: 'Markdown, GFM, math -> one native browser tab, no external navigation',
			browser: 'native isolated WebContentsView',
			annotation: 'trusted input -> comment -> screenshot and metadata in unsent draft',
			layout: 'split/full/hide/restore',
			requests,
			profile: 'disposable',
		}),
	);
	const hold = Math.min(60_000, Math.max(0, Number(process.env.FREELM_SMOKE_HOLD_MS) || 0));
	if (hold) {
		console.log(
			`Holding disposable native fixture for ${hold}ms; Electron PID ${desktop.process().pid}`,
		);
		await new Promise((resolve) => setTimeout(resolve, hold));
	}
} finally {
	await desktop?.evaluate(({ app }) => app.exit(0)).catch(() => {});
	await desktop?.close().catch(() => {});
	await new Promise((resolve) => {
		server.close(resolve);
		server.closeAllConnections();
	});
	await rm(profile, { recursive: true, force: true });
}
