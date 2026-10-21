import { _electron as electron, expect as baseExpect } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const expect = baseExpect.configure({ timeout: 20_000 });

// The real built renderer, preload, native browser, and filesystem service. All
// state and files are disposable, with only a loopback page and no model requests.
const profile = await mkdtemp(path.join(os.tmpdir(), 'freelm-html-preview-'));
const workdir = path.join(profile, 'workspace');
await mkdir(path.join(workdir, 'src'), { recursive: true });
// Optional real-app regression: use an exact disposable copy, never execute in
// the user's workspace or write to the original artifact.
const timerSource = process.env.FREELM_SMOKE_TIMER_FILE;
const timerCopy = timerSource ? path.join(workdir, 'Focus Timer.html') : undefined;
if (timerSource) await writeFile(timerCopy, await readFile(timerSource));
await writeFile(
	path.join(workdir, 'README.md'),
	'# Surface fixture\n\nA **rendered** Markdown file.\n',
);
await writeFile(
	path.join(workdir, 'src', 'app.ts'),
	Array.from({ length: 45 }, (_, i) => `export const line${i + 1} = ${i + 1};`).join('\n'),
);
await writeFile(
	path.join(workdir, 'index.html'),
	`<!doctype html><html><head><title>Local preview fixture</title><link rel="stylesheet" href="src/style.css"><script src="src/preview.js" defer></script></head><body><h1>Focus timer</h1><button id="increment">Add minute</button><output id="minutes">0 minutes</output><img src="src/check.svg" alt="Local asset"></body></html>`,
);
await writeFile(
	path.join(workdir, 'src/style.css'),
	'body{font:16px system-ui;background:rgb(239,246,255);padding:32px}button{padding:12px;border-radius:8px}img{width:40px;height:40px}',
);
await writeFile(
	path.join(workdir, 'src/preview.js'),
	'let count=0;document.querySelector("#increment").onclick=()=>{document.querySelector("#minutes").textContent=++count+" minutes"}',
);
await writeFile(
	path.join(workdir, 'src/check.svg'),
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" fill="green"/></svg>',
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
					content: `Open [Interactive app](${workdir}/index.html) or [File URL app](${pathToFileURL(path.join(workdir, 'index.html')).href}). Read [app.ts line 32](${workdir}/src/app.ts:32) and [Workspace notes](${workdir}/README.md). Open [Agent preview](${base}/linked-page), or visit ${base}/linked-page.`,
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
	await expect(page.getByRole('button', { name: 'Home', exact: true })).toBeVisible({
		timeout: 30_000,
	});
	await page.getByRole('combobox', { name: 'Conversation mode', exact: true }).click();
	await page.getByRole('listbox').locator('[role="option"][data-value="code"]').click();
	await page.getByRole('button', { name: 'Surface task', exact: true }).click();
	// An empty summary uses one compact explanation instead of two prominent
	// empty sections, while preserving the existing explicit visibility control.
	const emptySummary = page.locator('.conversation-summary-empty');
	await expect(emptySummary.getByRole('heading', { name: 'Outputs & sources' })).toBeVisible();
	const emptySummarySize = await emptySummary.evaluate((node) => ({
		height: node.getBoundingClientRect().height,
		fontSize: Number.parseFloat(getComputedStyle(node.querySelector('h2')).fontSize),
	}));
	assert(emptySummarySize.height < 100 && emptySummarySize.fontSize >= 13);
	await page.getByRole('button', { name: 'Hide pinned summary', exact: true }).click();
	await expect(page.locator('#pinned-summary-panel')).toBeHidden();
	await page.getByRole('button', { name: 'Show pinned summary', exact: true }).click();
	await expect(emptySummary).toBeVisible();
	await page.getByRole('button', { name: 'Hide pinned summary', exact: true }).click();
	await expect(page.locator('#pinned-summary-panel')).toBeHidden();

	// Code and Chat restore their own locations and unsent text, not a fresh blank
	// task or the other mode's draft. Neither fixture draft is submitted.
	const editor = page.getByRole('textbox', { name: 'Message', exact: true });
	const switchMode = async (mode) => {
		await page.getByRole('combobox', { name: 'Conversation mode', exact: true }).click();
		await page.getByRole('listbox').locator(`[role="option"][data-value="${mode}"]`).click();
	};
	await editor.fill('Keep this Code draft.');
	await switchMode('chat');
	await editor.fill('Keep this Chat draft.');
	await switchMode('code');
	await expect(page.getByRole('link', { name: 'Interactive app', exact: true })).toBeVisible();
	await expect(editor).toHaveText('Keep this Code draft.');
	await switchMode('chat');
	await expect(editor).toHaveText('Keep this Chat draft.');
	await switchMode('code');
	await expect(editor).toHaveText('Keep this Code draft.');
	await page.getByRole('link', { name: 'Interactive app', exact: true }).click();
	const surface = page.getByRole('region', { name: 'Code workspace tabs', exact: true });
	const frameElement = surface.locator('iframe[title="Preview of index.html"]');
	await expect(frameElement).toHaveAttribute('sandbox', 'allow-scripts');
	const frame = frameElement.contentFrame();
	await expect(frame.getByRole('heading', { name: 'Focus timer' })).toBeVisible();
	await frame.getByRole('button', { name: 'Add minute' }).click();
	await expect(frame.locator('output')).toHaveText('1 minutes');
	await expect(frame.locator('body')).toHaveCSS('background-color', 'rgb(239, 246, 255)');
	assert.equal(
		await frame
			.getByAltText('Local asset')
			.evaluate((image) => image.complete && image.naturalWidth > 0),
		true,
	);
	const isolation = await frame.locator('body').evaluate(() => {
		let parentBlocked = false,
			storageBlocked = false,
			topBlocked = false;
		try {
			void parent.document.body;
		} catch {
			parentBlocked = true;
		}
		try {
			localStorage.setItem('preview', 'escape');
		} catch {
			storageBlocked = true;
		}
		try {
			top.location.href = 'https://example.invalid/escape';
		} catch {
			topBlocked = true;
		}
		return {
			bridge: typeof window.desktop,
			node: typeof require,
			parentBlocked,
			storageBlocked,
			topBlocked,
		};
	});
	assert.deepEqual(isolation, {
		bridge: 'undefined',
		node: 'undefined',
		parentBlocked: true,
		storageBlocked: true,
		topBlocked: true,
	});
	assert.equal(
		await frame.locator('body').evaluate(async (_body, url) => {
			try {
				await fetch(url);
				return 'allowed';
			} catch {
				return 'blocked';
			}
		}, `${base}/forbidden`),
		'blocked',
	);
	assert(!requests.includes('/forbidden'));
	await page.screenshot({ path: '/tmp/freelm-code-html-preview.png' });
	await surface.getByRole('button', { name: 'Source', exact: true }).click();
	await expect(surface.locator('.cm-content')).toContainText(
		'<title>Local preview fixture</title>',
	);
	await surface.getByRole('button', { name: 'Preview', exact: true }).click();
	await expect(frame.getByRole('heading', { name: 'Focus timer' })).toBeVisible();
	await page.getByRole('link', { name: 'Agent preview', exact: true }).click();
	const address = surface.getByRole('textbox', { name: 'Browser address', exact: true });
	await address.fill('javascript:alert(1)');
	await address.press('Enter');
	await expect(surface.getByRole('alert')).toContainText(
		'Open local HTML files in Files to preview them.',
	);
	assert(!(await surface.getByRole('alert').innerText()).includes('remote method'));
	// Background page loading emits state changes and refreshes annotation overlays.
	// Those automatic updates must not clear a failed address submission.
	await desktop.evaluate(({ webContents }, url) => {
		const browser = webContents.getAllWebContents().find((contents) => contents.getURL() === url);
		if (!browser) throw new Error('Fixture browser contents not found.');
		browser.reload();
	}, `${base}/linked-page`);
	await expect
		.poll(() =>
			desktop.evaluate(({ webContents }, url) => {
				const browser = webContents
					.getAllWebContents()
					.find((contents) => contents.getURL() === url);
				return !!browser && !browser.isLoading();
			}, `${base}/linked-page`),
		)
		.toBe(true);
	await page.waitForFunction(() => !document.querySelector('[aria-label="Reload page"] .spin'));
	await page.evaluate(
		() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
	);
	await expect(surface.getByRole('alert')).toContainText(
		'Open local HTML files in Files to preview them.',
	);
	await address.fill(pathToFileURL(path.join(workdir, 'index.html')).href);
	await address.press('Enter');
	await expect(frame.getByRole('heading', { name: 'Focus timer' })).toBeVisible();
	await surface.getByRole('tab', { name: /Surface preview/ }).click();
	await page.getByRole('link', { name: 'File URL app', exact: true }).click();
	await expect(frame.getByRole('heading', { name: 'Focus timer' })).toBeVisible();
	if (timerCopy) {
		// Repeat the user's browser-address flow with their generated app, including
		// escaped spaces in the file URL, rather than only testing a minimal fixture.
		await surface.getByRole('tab', { name: /Surface preview/ }).click();
		await address.fill(pathToFileURL(timerCopy).href);
		await address.press('Enter');
		const timerFrame = surface
			.locator('iframe[title="Preview of Focus Timer.html"]')
			.contentFrame();
		await expect(
			timerFrame.getByRole('heading', { name: 'Focus Timer', exact: true }),
		).toBeVisible();
		await expect(timerFrame.locator('#time')).toHaveText('10:00');
		await timerFrame.getByRole('button', { name: 'Start', exact: true }).click();
		await expect(timerFrame.locator('#status')).toContainText('Focusing.');
		await expect(timerFrame.locator('#time')).not.toHaveText('10:00');
		await timerFrame.getByRole('button', { name: 'Pause', exact: true }).click();
		await expect(timerFrame.locator('#status')).toContainText('Paused at');
		await timerFrame.getByRole('button', { name: 'Reset', exact: true }).click();
		await expect(timerFrame.locator('#time')).toHaveText('10:00');
		await expect(timerFrame.locator('#sessions')).toHaveText('Sessions completed: 0');
		await timerFrame.getByRole('button', { name: 'Start', exact: true }).click();
		await timerFrame.locator('body').evaluate(() => {
			const now = Date.now.bind(Date);
			Date.now = () => now() + 10 * 60 * 1000;
		});
		await expect(timerFrame.locator('#status')).toContainText("Time's up!");
		await expect(timerFrame.locator('#sessions')).toHaveText('Sessions completed: 1');
		await page.screenshot({ path: '/tmp/freelm-code-actual-html-preview.png' });
	}
	assert(
		!requests.some((url) => url.startsWith('/v1/')),
		'This UI smoke must not request model inference.',
	);
	console.log(
		JSON.stringify({
			htmlPreview: 'passed',
			localAssets: 'CSS, classic JS and SVG',
			isolation,
			browserRecovery: 'passed',
			modeAndDraftRestoration: 'passed',
			emptySummary: { visibilityToggle: 'passed', ...emptySummarySize },
			...(timerCopy
				? { actualTimer: 'render, countdown, pause, reset, completion, file URL passed' }
				: {}),
			screenshot: '/tmp/freelm-code-html-preview.png',
		}),
	);
} catch (error) {
	console.error('Native Code UX smoke failed:', error);
	throw error;
} finally {
	if (desktop) {
		const fixtureProcess = desktop.process();
		let timer;
		try {
			await Promise.race([
				desktop.close().catch(() => {}),
				new Promise((resolve) => {
					timer = setTimeout(() => {
						fixtureProcess.kill('SIGKILL');
						resolve();
					}, 5_000);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
	await rm(profile, { recursive: true, force: true });
}
