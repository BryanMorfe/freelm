import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from '@playwright/test';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

// Exercise the real renderer facade, contextBridge, preload, and main process.
// Repeated immutable strings keep the fixture modest while its hydrated state
// exceeds V8's old single-message serializer limit. Never use the live profile.
const profile = await mkdtemp(path.join(os.tmpdir(), 'freelm-workspace-transfer-'));
const galleryCount = 48;
const attachmentCount = 12;
const fieldCount = galleryCount + attachmentCount;
let desktop;

function imageFixture() {
	// A valid 24-bit BMP, about 10 MiB as a data URL. The default Chat screen
	// does not decode the gallery, but the fixture remains usable by the UI.
	const width = 1650;
	const height = 1590;
	const rowBytes = Math.ceil((width * 3) / 4) * 4;
	const pixels = rowBytes * height;
	const bmp = Buffer.alloc(54 + pixels);
	bmp.write('BM');
	bmp.writeUInt32LE(bmp.length, 2);
	bmp.writeUInt32LE(54, 10);
	bmp.writeUInt32LE(40, 14);
	bmp.writeInt32LE(width, 18);
	bmp.writeInt32LE(height, 22);
	bmp.writeUInt16LE(1, 26);
	bmp.writeUInt16LE(24, 28);
	bmp.writeUInt32LE(pixels, 34);
	return `data:image/bmp;base64,${bmp.toString('base64')}`;
}

const original = imageFixture();
// Change only the final pixel bytes to create a second valid, equally large
// original. Saves must upload its exact contents rather than reuse a stale blob.
const alternate = original.slice(0, -4) + 'AQAA';
const digest = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const signature = (state) =>
	JSON.stringify(state, (_key, value) => {
		if (value && typeof value === 'object' && !Array.isArray(value))
			return Object.fromEntries(
				Object.keys(value)
					.sort()
					.map((key) => [key, value[key]]),
			);
		if (typeof value !== 'string' || value.length <= 64 * 1024) return value;
		if (value === original) return '<original-media>';
		if (value === alternate) return '<alternate-media>';
		throw new Error('An unexpected large string was returned by the native workspace bridge.');
	});

try {
	assert.ok(original.length * fieldCount > 512 * 1024 * 1024);
	assert.notEqual(original, alternate);
	const seedModule = path.join(profile, 'seed.mjs');
	await build({
		stdin: {
			contents:
				'export { initialState } from "./src/lib/state"; export { StateStore } from "./electron/state-store"; export { loadWorkspaceRecovery } from "./electron/workspace-backup";',
			resolveDir: process.cwd(),
		},
		bundle: true,
		platform: 'node',
		format: 'esm',
		outfile: seedModule,
	});
	const { initialState, StateStore, loadWorkspaceRecovery } = await import(
		pathToFileURL(seedModule).href
	);
	const seeded = initialState();
	seeded.connections[0].baseUrl = 'http://127.0.0.1:9/v1';
	seeded.threads = [
		{
			id: 'large-chat',
			kind: 'chat',
			title: 'Native transfer fixture',
			connectionId: seeded.activeConnectionId,
			model: 'fixture',
			createdAt: 1,
			updatedAt: 1,
			messages: Array.from({ length: attachmentCount }, (_, index) => ({
				id: `message-${index}`,
				role: 'user',
				content: `Attachment ${index}: Café 你好 😀`,
				createdAt: index + 1,
				attachments: [{ name: `chat-${index}.bmp`, type: 'image/bmp', dataUrl: original }],
			})),
		},
	];
	seeded.generations = Array.from({ length: galleryCount }, (_, index) => ({
		id: `gallery-${index}`,
		kind: 'images',
		prompt: `Gallery ${index}: Café 你好 😀`,
		model: 'fixture',
		connectionId: seeded.activeConnectionId,
		createdAt: index + 1,
		status: 'completed',
		assets: [{ name: `gallery-${index}.bmp`, mimeType: 'image/bmp', url: original }],
	}));
	const openStore = () =>
		new StateStore(
			path.join(profile, 'workspace.json'),
			{
				available: () => false,
				encrypt: () => {
					throw new Error('Fixture has no secrets');
				},
				decrypt: () => {
					throw new Error('Fixture has no secrets');
				},
			},
			path.join(profile, 'config.json'),
		);
	await openStore().save(seeded);
	const manifest = JSON.parse(await readFile(path.join(profile, 'workspace.json'), 'utf8'));
	assert.equal(manifest.format, 'freelm-workspace-v3');
	assert.equal(manifest.blobs.length, fieldCount);
	assert.equal(new Set(manifest.blobs.map((blob) => blob.hash)).size, 1);
	assert.equal((await readdir(path.join(profile, 'media'))).length, 1);
	assert.ok((await stat(path.join(profile, 'workspace.json'))).size < 256 * 1024);

	const env = { ...process.env, FREELM_USER_DATA: profile };
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.FREELM_DEV_URL;
	delete env.FREELM_HOME;
	desktop = await electron.launch({ args: ['.'], env, timeout: 120_000 });
	const page = await desktop.firstWindow();
	const errors = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('crash', () => errors.push('Renderer crashed during workspace transfer.'));
	await page.waitForFunction(() => !!window.desktop, null, { timeout: 120_000 });
	// This proves App's actual initial hydration completed, not just a separate
	// IPC call in a test page. A serializer crash used to leave this screen blank.
	await page.locator('.app-shell').waitFor({ timeout: 120_000 });
	const preferences = await desktop.evaluate(({ BrowserWindow }) => {
		const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
		return {
			sandbox: prefs.sandbox,
			isolation: prefs.contextIsolation,
			node: prefs.nodeIntegration,
		};
	});
	assert.deepEqual(preferences, { sandbox: true, isolation: true, node: false });

	const result = await page.evaluate(
		async ({
			expectedSignature,
			expectedCharacters,
			originalDigest,
			alternateDigest,
			fieldCount,
		}) => {
			const bridge = window.desktop;
			const initial = await bridge.workspaceLoad('local');
			if (!initial.state) throw new Error('Native transfer fixture was not loaded.');
			const original = initial.state.generations[0].assets[0].url;
			const alternate = original.slice(0, -4) + 'AQAA';
			const signature = (state) =>
				JSON.stringify(state, (_key, value) => {
					if (value && typeof value === 'object' && !Array.isArray(value))
						return Object.fromEntries(
							Object.keys(value)
								.sort()
								.map((key) => [key, value[key]]),
						);
					if (typeof value !== 'string' || value.length <= 64 * 1024) return value;
					if (value === original) return '<original-media>';
					if (value === alternate) return '<alternate-media>';
					throw new Error('Native transfer returned unexpected large content.');
				});
			const digest = async (value) =>
				Array.from(
					new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
					(byte) => byte.toString(16).padStart(2, '0'),
				).join('');
			const verify = async (state, expected, label) => {
				if (!state || signature(state) !== expected)
					throw new Error(`${label}: workspace contents changed across the native bridge.`);
				const fields = [
					...state.generations.flatMap((generation) => generation.assets.map((asset) => asset.url)),
					...state.threads.flatMap((thread) =>
						thread.messages.flatMap((message) => (message.attachments ?? []).map((a) => a.dataUrl)),
					),
				];
				if (
					fields.length !== fieldCount ||
					fields.some((value) => value.length !== expectedCharacters)
				)
					throw new Error(`${label}: original media lengths or counts changed.`);
				const unique = new Set(fields);
				for (const value of unique) {
					const expectedDigest = value === original ? originalDigest : alternateDigest;
					if ((await digest(value)) !== expectedDigest)
						throw new Error(`${label}: original media bytes changed.`);
				}
			};
			await verify(initial.state, expectedSignature, 'Startup load');
			const legacy = await bridge.load();
			await verify(legacy, expectedSignature, 'Legacy load');
			let state = initial.state;
			let revision = initial.revision;
			for (const generation of state.generations) generation.assets[0].url = alternate;
			for (const message of state.threads[0].messages) message.attachments[0].dataUrl = alternate;
			state.generations[0].prompt = 'Native save: Café 你好 😀';
			const savedSignature = signature(state);
			revision = (await bridge.workspaceSave('local', revision, state)).revision;
			let loaded = await bridge.workspaceLoad('local');
			if (loaded.revision !== revision) throw new Error('Native save returned the wrong revision.');
			await verify(loaded.state, savedSignature, 'Full save');
			state = loaded.state;
			for (const generation of state.generations) generation.assets[0].url = original;
			for (const message of state.threads[0].messages) message.attachments[0].dataUrl = original;
			state.threads[0].title = 'Native patch: Café 你好 😀';
			const patchedSignature = signature(state);
			// The patch itself carries >512 MiB logically, covering the reverse
			// contextBridge and IPC path instead of only small metadata updates.
			revision = (
				await bridge.workspacePatch('local', revision, {
					changes: { threads: state.threads, generations: state.generations },
				})
			).revision;
			loaded = await bridge.workspaceLoad('local');
			await verify(loaded.state, patchedSignature, 'Media-bearing patch');
			state = loaded.state;
			const patchedMessage = {
				...state.threads[0].messages[0],
				content: 'Native message patch: Café 你好 😀',
				attachments: [{ ...state.threads[0].messages[0].attachments[0], dataUrl: alternate }],
			};
			state.threads[0].messages[0] = patchedMessage;
			const finalSignature = signature(state);
			revision = (
				await bridge.workspacePatch('local', revision, {
					changes: {},
					records: {
						threads: {
							updates: [{ id: 'large-chat', changes: {}, messages: { upsert: [patchedMessage] } }],
						},
					},
				})
			).revision;
			loaded = await bridge.workspaceLoad('local');
			if (loaded.revision !== revision)
				throw new Error('Native patch returned the wrong revision.');
			await verify(loaded.state, finalSignature, 'Nested attachment patch');
			const backup = await bridge.workspaceBackup(loaded.state);
			// Return bounded metadata only. Returning the hydrated state through
			// Playwright would test another serializer instead of FreeLM's bridge.
			return { backup, finalSignature, revision, logicalBytes: expectedCharacters * fieldCount };
		},
		{
			expectedSignature: signature(seeded),
			expectedCharacters: original.length,
			originalDigest: digest(original),
			alternateDigest: digest(alternate),
			fieldCount,
		},
	);
	assert.ok(result.logicalBytes > 512 * 1024 * 1024);
	assert.ok(result.backup.startsWith(path.join(profile, 'recovery') + path.sep));
	const backup = await loadWorkspaceRecovery(result.backup);
	assert.equal(signature(backup), result.finalSignature);
	assert.equal(
		backup.connections.every((connection) => connection.apiKey === ''),
		true,
	);
	const recoveredFields = [
		...backup.generations.flatMap((generation) => generation.assets.map((asset) => asset.url)),
		...backup.threads.flatMap((thread) =>
			thread.messages.flatMap((message) => (message.attachments ?? []).map((a) => a.dataUrl)),
		),
	];
	assert.equal(recoveredFields.length, fieldCount);
	assert.equal(new Set(recoveredFields).size, 2);
	assert.deepEqual(errors, []);
	await desktop.close();
	desktop = undefined;
	const persisted = await openStore().load();
	assert.equal(signature(persisted), result.finalSignature);
	console.log(
		`Native workspace transfer passed: ${fieldCount} exact media fields, ${Math.floor(result.logicalBytes / 1024 / 1024)} MiB logical state, startup and legacy loads, full save, media and message patches, portable recovery, durable reload, renderer health.`,
	);
} finally {
	await desktop?.close().catch(() => {});
	await rm(profile, { recursive: true, force: true });
}
