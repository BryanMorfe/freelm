import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

// Real packaged renderer/preload/IPC, a temporary profile, and only benign local fixtures.
const profile = await mkdtemp(path.join(os.tmpdir(), 'freelm-composer-native-'));
const workdir = path.join(profile, 'workspace');
const skilldir = path.join(profile, 'skills');
await mkdir(workdir);
await mkdir(path.join(skilldir, 'fixture'), { recursive: true });
await writeFile(path.join(workdir, 'example.txt'), 'Native composer reference fixture.\n');
await writeFile(
	path.join(skilldir, 'fixture', 'SKILL.md'),
	'---\nname: Native Fixture\ndescription: Benign composer test skill.\n---\nRead the selected fixture and summarize it.\n',
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
const seeded = initialState();
seeded.toolSettings = { ...defaultToolSettings(), workspaceRoot: workdir };
await new StateStore(
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
).save(seeded);
let desktop;
try {
	const env = { ...process.env, FREELM_USER_DATA: profile };
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.FREELM_DEV_URL;
	delete env.FREELM_HOME;
	desktop = await electron.launch({ args: ['.'], env });
	const page = await desktop.firstWindow();
	const errors = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await page.waitForFunction(() => !!window.desktop);
	await page.locator('.app-shell').waitFor();
	await page.waitForFunction(
		async () => (await window.desktop.workspaceLoad('local')).state !== null,
	);
	const result = await page.evaluate(
		async ({ workdir, skilldir }) => {
			const bridge = window.desktop;
			const snapshot = await bridge.workspaceLoad('local');
			const state = snapshot.state;
			if (!state) throw new Error('Native fixture workspace was not loaded.');
			state.toolSettings = {
				...state.toolSettings,
				enabled: true,
				workspaceRoot: workdir,
				commandExecution: true,
				approvalMode: 'full-access',
				skillDirectories: [skilldir],
				mcpServers: [],
			};
			state.projects = [
				{
					id: 'fixture',
					kind: 'code',
					name: 'Fixture',
					directories: [workdir],
					instructions: '',
					createdAt: 1,
				},
			];
			state.threads = [
				{
					id: 'native-composer',
					kind: 'code',
					projectId: 'fixture',
					title: 'Native composer',
					connectionId: state.activeConnectionId,
					model: 'fixture',
					permissionMode: 'full-access',
					createdAt: 1,
					updatedAt: 1,
					messages: [
						{
							id: 'user',
							role: 'user',
							content: 'Plan the fixture.',
							composer: { mode: 'plan' },
							createdAt: 1,
						},
					],
				},
			];
			let revision = (await bridge.workspaceSave('local', snapshot.revision, state)).revision;
			const base = {
				workspaceId: 'local',
				conversationKind: 'code',
				threadId: 'native-composer',
				projectId: 'fixture',
			};
			const files = await bridge.composerDiscover({ ...base, kind: 'files', query: 'example' });
			const skills = await bridge.composerDiscover({
				...base,
				kind: 'skills',
				query: 'Native Fixture',
			});
			const refs = [files.items[0], skills.items[0]].map((item) => {
				const payload = encodeURIComponent(
					JSON.stringify({ id: item.id, label: item.label, path: item.path }),
				).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
				return {
					kind: item.kind,
					id: item.id,
					label: item.label,
					path: item.path,
					token: `[${item.label}](freelm-${item.kind}:${payload})`,
				};
			});
			state.threads[0].messages[0].composer.references = refs;
			state.threads[0].messages[0].content = refs.map((ref) => ref.token).join(' ');
			revision = (await bridge.workspaceSave('local', revision, state)).revision;
			const resolved = await bridge.composerResolve('local', 'native-composer', 'user');
			const catalog = await bridge.toolCatalog('local', 'native-plan', 'native-composer');
			const read = await bridge.toolExecute({
				workspaceId: 'local',
				runId: 'native-plan',
				threadId: 'native-composer',
				name: 'exec_command',
				arguments: { cmd: 'cat example.txt', workdir, yield_time_ms: 1000 },
			});
			const denied = await bridge.toolExecute({
				workspaceId: 'local',
				runId: 'native-plan',
				threadId: 'native-composer',
				name: 'apply_patch',
				arguments: {
					patch: '*** Begin Patch\n*** Add File: should-not-exist.txt\n+blocked\n*** End Patch',
				},
			});
			await bridge.toolCancel('native-plan');
			state.threads.push({ ...state.threads[0], id: 'chat', kind: 'chat', projectId: undefined });
			revision = (await bridge.workspaceSave('local', revision, state)).revision;
			let chatError = '';
			try {
				await bridge.composerDiscover({
					...base,
					threadId: 'chat',
					projectId: undefined,
					kind: 'files',
					query: 'example',
				});
			} catch (error) {
				chatError = String(error);
			}
			return {
				files,
				skills,
				resolved,
				catalog: { codePlanMode: catalog.codePlanMode },
				read,
				denied,
				chatError,
			};
		},
		{ workdir, skilldir },
	);
	assert.equal(result.files.items[0].label, 'example.txt');
	assert.equal(result.skills.items[0].label, 'Native Fixture');
	assert.match(result.resolved.instructions, /Native Fixture/);
	assert.match(result.resolved.instructions, /example\.txt/);
	assert.equal(result.catalog.codePlanMode, 1);
	assert.notEqual(result.read.isError, true);
	assert.match(JSON.stringify(result.read.content), /Native composer reference fixture/);
	assert.equal(result.denied.isError, true);
	assert.match(JSON.stringify(result.denied.content), /Plan mode blocked/);
	assert.match(result.chatError, /only in Code/);
	await assert.rejects(readFile(path.join(workdir, 'should-not-exist.txt')));
	assert.deepEqual(errors, []);
	console.log(
		'Native composer: 10 checks passed (discovery, exact skill resolution, Plan read/write enforcement, Chat isolation, renderer health).',
	);
} finally {
	await desktop?.close().catch(() => {});
	await rm(profile, { recursive: true, force: true });
}
