import { _electron as electron, expect } from '@playwright/test';
import { build } from 'esbuild';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

// Synthetic aggregate shape only. Never reads or copies a user's profile or calls a provider.
const profile = await mkdtemp(path.join(os.tmpdir(), 'freelm-large-workspace-'));
const fixtureModule = path.join(profile, 'seed.cjs');
let desktop;
try {
	await build({
		stdin: {
			contents: `
import { StateStore } from './electron/state-store';
import { initialState } from './src/lib/state';
async function seed() {
 const state = initialState(); state.theme = 'dark';
 state.connections[0].baseUrl = 'http://127.0.0.1:1/v1'; state.connections[0].apiKey = '';
 const blobs = Array.from({ length: 8 }, (_, i) => 'data:image/png;base64,' + Buffer.alloc(3750000, i).toString('base64'));
 let call = 0, image = 0, message = 0;
 state.threads = Array.from({ length: 30 }, (_, t) => ({
  id: 'thread-' + t, kind: 'code', title: 'Synthetic task ' + t, connectionId: state.connections[0].id, model: 'fixture', createdAt: 1, updatedAt: 2,
  messages: Array.from({ length: t < 26 ? 13 : 12 }, (_, m) => {
   const id = 'message-' + message++; const assistant = m % 2 === 1;
   const calls = assistant ? Array.from({ length: call < 574 ? 7 : 6 }, () => {
    const n = call++; return { id: 'tool-' + n, name: 'exec_command', arguments: '{}', status: 'completed', startedAt: 1, completedAt: 2,
     result: { content: [{ type: 'text', text: ('Synthetic output ' + n + ': ').padEnd(19000, 'x') }, ...(image < 565 ? [{ type: 'image', name: 'fixture.png', dataUrl: blobs[image++ % blobs.length] }] : [])] } };
   }) : undefined;
   return { id, role: assistant ? 'assistant' : 'user', content: assistant ? 'Completed synthetic task.' : 'Synthetic request.', createdAt: 1, ...(assistant ? { completedAt: 2, phase: 'responding', toolCalls: calls } : {}) };
  })
 }));
 state.generations = Array.from({ length: 76 }, (_, i) => ({ id: 'generation-' + i, kind: 'images', prompt: 'Synthetic fixture', model: 'fixture', connectionId: state.connections[0].id, createdAt: 1, status: 'completed', assets: [{ url: blobs[i % blobs.length], mimeType: 'image/png', name: 'fixture.png' }] }));
 const store = new StateStore(process.argv[2] + '/workspace.json', { available: () => false, encrypt: () => Buffer.from(''), decrypt: () => '' }, process.argv[2] + '/config.json');
 await store.save(state);
 console.log(JSON.stringify({ threads: state.threads.length, messages: message, toolCalls: call, mediaReferences: image + 76, logicalMediaChars: (image + 76) * blobs[0].length }));
} seed().catch(error => { console.error(error); process.exitCode = 1; });
`,
			resolveDir: process.cwd(),
			sourcefile: 'large-workspace-fixture.ts',
			loader: 'ts',
		},
		outfile: fixtureModule,
		platform: 'node',
		format: 'cjs',
		bundle: true,
		external: ['electron'],
		logLevel: 'silent',
	});
	const seeded = await promisify(execFile)(process.execPath, [fixtureModule, profile], {
		maxBuffer: 1024 * 1024,
	});
	console.log(
		'Fixture',
		seeded.stdout.trim(),
		'workspaceBytes',
		(await stat(path.join(profile, 'workspace.json'))).size,
	);
	const env = { ...process.env, FREELM_HOME: profile, FREELM_USER_DATA: profile };
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.FREELM_DEV_URL;
	const executablePath = process.env.FREELM_SMOKE_EXECUTABLE;
	desktop = await electron.launch({
		...(executablePath
			? { executablePath, args: [`--user-data-dir=${profile}`] }
			: { args: ['.'] }),
		env,
	});
	desktop.process().stderr.on('data', (data) => process.stderr.write(data));
	const page = await desktop.firstWindow();
	let crashed = false;
	page.on('crash', () => {
		crashed = true;
	});
	try {
		await page.locator('.app-shell').waitFor({ timeout: 60_000 });
		// Stay responsive past the first host sync and autosave; those caused the regression.
		await expect
			.poll(async () => page.evaluate(() => document.querySelectorAll('.app-shell').length), {
				timeout: 10_000,
			})
			.toBe(1);
		await page.waitForTimeout(2500);
		await expect(page.locator('.app-shell')).toBeVisible();
		assert.equal(crashed, false);
		await page.evaluate(async () => {
			const snapshot = await window.desktop.hostTasksSnapshot();
			await window.desktop.workspacePatch('local', snapshot.workspaceRevision, { changes: { theme: 'light' } });
		});
		await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme), { timeout: 30_000 }).toBe('light');
		await page.waitForTimeout(1000);
		assert.equal(crashed, false);
		await page.screenshot({ path: '/tmp/freelm-large-workspace-native.png' });
		console.log(
			'PASS: large synthetic workspace opened, initial sync/autosave and an external host checkpoint completed, and renderer stayed responsive.',
		);
		if (process.env.FREELM_EXPECT_STARTUP_FAILURE === '1')
			throw new Error('Expected old build to reproduce the startup crash.');
	} catch (error) {
		if (process.env.FREELM_EXPECT_STARTUP_FAILURE === '1' && crashed)
			console.log('REPRODUCED: old build renderer crashed on large synthetic workspace.');
		else throw error;
	}
} finally {
	await desktop?.close().catch(() => {});
	await rm(profile, { recursive: true, force: true });
}
