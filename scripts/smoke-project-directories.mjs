import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { _electron as electron, expect } from '@playwright/test';
import { lstat, mkdtemp, readdir, rm, rmdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

// Real renderer/preload/IPC acceptance. This smoke creates one uniquely named,
// empty project folder under the real ~/Documents/FreeLM default root, then
// removes only that exact returned folder with non-recursive rmdir. It never
// overrides HOME, requests a provider, or reads/writes the user's FreeLM profile.
// Parent folders are left alone. Unexpected contents/replacements are preserved.
// Run a packaged build with FREELM_SMOKE_EXECUTABLE=/.../Contents/MacOS/FreeLM.
const executablePath = process.env.FREELM_SMOKE_EXECUTABLE;
const profile = await mkdtemp(path.join(os.tmpdir(), 'freelm-project-directory-smoke-'));
const name = `FreeLM verification ${randomUUID()}`;
const expectedBase = path.join(os.homedir(), 'Documents', 'FreeLM');
const untrustedName = `${name} untrusted`;
let desktop;
let page;
let createdDirectory;
let createdIdentity;
let stage = 'Preparing isolated profile';
const progress = (next) => {
	stage = next;
	console.log(`[project directories] ${next}`);
};

async function selectCode() {
	const picker = page.getByRole('combobox', { name: 'Conversation mode', exact: true });
	if (!(await picker.isVisible()))
		await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
	await picker.click();
	await page.getByRole('listbox').locator('[role="option"][data-value="code"]').click();
	await expect(picker).toHaveText('Code');
}

async function captureReturnedDirectory() {
	if (!page || page.isClosed() || createdDirectory) return;
	const created = await page.evaluate(() => window.__projectDirectorySmoke?.created);
	if (!created) return;
	assert.equal(created.name, name, 'Only the intended test project may be created.');
	assert.equal(path.dirname(created.path), expectedBase);
	assert.match(
		path.basename(created.path),
		new RegExp(`^${name}(?: [2-9]| [1-9][0-9]{1,2}| 1000)?$`),
	);
	createdDirectory = created.path;
	createdIdentity = await lstat(createdDirectory);
	assert.ok(createdIdentity.isDirectory() && !createdIdentity.isSymbolicLink());
}

try {
	progress('Preparing isolated profile');
	const seedModule = path.join(profile, 'seed.mjs');
	await build({
		stdin: {
			contents:
				'export { initialState } from "./src/lib/state"; export { StateStore } from "./electron/state-store"; export { defaultToolSettings } from "./src/lib/tool-settings"; export { projectToolScope } from "./electron/project-roots";',
			resolveDir: process.cwd(),
		},
		bundle: true,
		platform: 'node',
		format: 'esm',
		outfile: seedModule,
	});
	const { initialState, StateStore, defaultToolSettings, projectToolScope } = await import(
		pathToFileURL(seedModule).href
	);
	const state = initialState();
	state.projects = [];
	state.threads = [];
	state.toolSettings = defaultToolSettings();
	for (const connection of state.connections) {
		connection.baseUrl = 'http://127.0.0.1:9/v1';
		connection.apiKey = '';
	}
	await new StateStore(
		path.join(profile, 'workspace.json'),
		{
			available: () => false,
			encrypt: () => {
				throw new Error('No test secrets');
			},
			decrypt: () => {
				throw new Error('No test secrets');
			},
		},
		path.join(profile, 'config.json'),
	).save(state);
	const env = { ...process.env, FREELM_USER_DATA: profile };
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.FREELM_HOME;
	delete env.FREELM_DEV_URL;
	// Packaged apps ignore FREELM_USER_DATA; isolate their storage and singleton metadata.
	if (executablePath) env.FREELM_HOME = profile;
	progress('Launching the isolated desktop app');
	desktop = await electron.launch({
		...(executablePath
			? { executablePath, args: [`--user-data-dir=${profile}`] }
			: { args: ['.'] }),
		env,
		timeout: 45_000,
	});
	desktop.context().setDefaultTimeout(45_000);
	desktop.context().setDefaultNavigationTimeout(45_000);
	page = await desktop.firstWindow({ timeout: 45_000 });
	page.setDefaultTimeout(45_000);
	page.setDefaultNavigationTimeout(45_000);
	const errors = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await page.waitForFunction(() => !!window.desktop?.projectCreateDirectory);
	await page.locator('.app-shell').waitFor();
	assert.equal(
		(await page.evaluate(() => window.desktop.storageInfo())).location,
		path.join(profile, 'config.json'),
		'The smoke must use only its disposable profile.',
	);
	await page.waitForFunction(async () => !!(await window.desktop.workspaceLoad('local')).state);
	progress('Isolated profile loaded; checking untrusted IPC rejection');

	// Reject a different origin before it can create anything in the filesystem.
	const appUrl = page.url();
	await page.goto('data:text/html,<h1>Untrusted project fixture</h1>');
	const denied = await page.evaluate(async (untrustedName) => {
		try {
			await window.desktopNative.projectCreateDirectory(untrustedName);
			return false;
		} catch (error) {
			return /not allowed to access the desktop bridge/i.test(String(error));
		}
	}, untrustedName);
	assert.equal(denied, true, 'Untrusted renderer must be rejected before folder creation.');
	await assert.rejects(lstat(path.join(expectedBase, untrustedName)), { code: 'ENOENT' });
	progress('Untrusted IPC rejected; returning to the real project UI');
	await page.goto(appUrl);
	await page.locator('.app-shell').waitFor();
	await page.waitForFunction(() => !!window.desktop?.projectCreateDirectory);
	// Observe the real bridge result for narrowly scoped cleanup; no host behavior is mocked.
	await page.evaluate(() => {
		const bridge = window.desktop;
		const create = bridge.projectCreateDirectory.bind(bridge);
		window.__projectDirectorySmoke = { calls: 0 };
		window.desktop = {
			...bridge,
			projectCreateDirectory: async (name) => {
				window.__projectDirectorySmoke.calls++;
				const directory = await create(name);
				window.__projectDirectorySmoke.created = { name, path: directory };
				return directory;
			},
		};
	});
	await selectCode();
	progress('Creating the name-only Code project through its dialog');
	await page.getByRole('button', { name: 'New project', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Create a project', exact: true });
	await dialog.getByLabel('Project name', { exact: true }).fill(name);
	await expect(dialog.getByLabel('Project directories')).toHaveValue('');
	await dialog.getByRole('button', { name: 'Create project', exact: true }).click();
	await page.waitForFunction(() => !!window.__projectDirectorySmoke.created);
	await captureReturnedDirectory();
	progress(`Created the test directory: ${createdDirectory}`);
	await expect(dialog).toHaveCount(0);
	assert.equal(await page.evaluate(() => window.__projectDirectorySmoke.calls), 1);
	assert.deepEqual(await readdir(createdDirectory), []);
	await page.waitForFunction(
		async ({ name, directory }) => {
			const snapshot = await window.desktop.workspaceLoad('local');
			return snapshot.state?.projects.some(
				(project) => project.name === name && project.directories?.[0] === directory,
			);
		},
		{ name, directory: createdDirectory },
	);
	progress('Project binding persisted; reloading the app');

	// Reload from persisted host state, then inspect the user's actual edit dialog.
	await page.reload();
	await page.locator('.app-shell').waitFor();
	await selectCode();
	progress('Verifying the persisted folder in the project edit dialog');
	const editButton = page.getByRole('button', { name: `Edit project ${name}`, exact: true });
	// Project actions appear on row hover, matching the actual user interaction.
	await page.locator('.project-row').filter({ has: editButton }).hover();
	await editButton.click();
	const edit = page.getByRole('dialog', { name: 'Edit project', exact: true });
	await expect(edit.getByLabel('Project directories')).toHaveValue(createdDirectory);
	await edit.getByRole('button', { name: 'Cancel', exact: true }).click();
	const persisted = (await page.evaluate(() => window.desktop.workspaceLoad('local'))).state;
	const project = persisted.projects.find((item) => item.name === name);
	assert.equal(project.kind, 'code');
	assert.deepEqual(project.directories, [createdDirectory]);
	// Pure host scope resolution proves this persisted binding becomes a task's cwd;
	// no shell command, provider request, or permission elevation is needed.
	const thread = {
		id: 'project-directory-scope-check',
		kind: 'code',
		projectId: project.id,
		connectionId: persisted.activeConnectionId,
		model: 'unused',
		messages: [],
	};
	const scope = projectToolScope({ ...persisted, threads: [thread] }, thread.id);
	assert.equal(scope.settings.workspaceRoot, createdDirectory);
	assert.deepEqual(scope.settings.workspaceRoots, [createdDirectory]);
	assert.deepEqual(errors, []);
	console.log(
		'Project directory smoke passed: real name-only Code project creation, exclusive default folder, persisted binding after reload, host cwd resolution, and untrusted IPC rejection. No provider request or shell command executed.',
	);
} catch (error) {
	console.error(`[project directories] Failed during: ${stage}`);
	throw error;
} finally {
	progress('Closing the isolated app and cleaning up only owned test artifacts');
	try {
		await captureReturnedDirectory();
	} finally {
		try {
			if (desktop) await desktop.close();
		} finally {
			try {
				if (createdDirectory && createdIdentity) {
					const current = await lstat(createdDirectory);
					assert.ok(
						current.isDirectory() &&
							current.ino === createdIdentity.ino &&
							current.dev === createdIdentity.dev,
						`Cleanup preserved a replaced test path: ${createdDirectory}`,
					);
					// Never recurse outside the disposable profile; fail safely on unexpected contents.
					await rmdir(createdDirectory);
					console.log(`Removed only the empty test project directory: ${createdDirectory}`);
				}
			} finally {
				await rm(profile, { recursive: true, force: true });
			}
		}
	}
}
