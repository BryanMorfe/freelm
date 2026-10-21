import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initializeStorage } from '../../electron/storage-migration';
import { resolveStoragePaths } from '../../electron/storage-paths';
import { splitLegacyWorkspace, validateSplitWorkspace } from '../../electron/state-store';

const folders: string[] = [];
afterEach(async () => {
	await Promise.all(folders.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const legacy = {
	format: 'freelm-workspace-v1',
	state: {
		version: 1,
		theme: 'dark',
		activeConnectionId: 'local',
		systemPrompt: 'Keep this prompt.',
		connections: [
			{
				id: 'local',
				name: 'Local',
				baseUrl: 'http://localhost:8000/v1',
				apiKey: '',
				chatApi: 'responses',
				models: { chat: 'chat', images: 'image', videos: '', speech: '', transcription: '' },
				discoveredModels: ['chat', 'image'],
			},
		],
		threads: [
			{
				id: 'thread',
				title: 'Preserved chat',
				connectionId: 'local',
				model: 'chat',
				createdAt: 1,
				updatedAt: 2,
				messages: [{ id: 'message', role: 'user', content: 'Keep me', createdAt: 1 }],
			},
		],
		projects: [{ id: 'project', name: 'Work', instructions: 'Instructions', createdAt: 1 }],
		generations: [
			{
				id: 'image',
				kind: 'images',
				prompt: 'Image',
				model: 'image',
				connectionId: 'local',
				createdAt: 1,
				status: 'completed',
				assets: [{ url: 'data:image/png;base64,YQ==', mimeType: 'image/png', name: 'image.png' }],
			},
		],
	},
	encryptedKeys: { local: 'dGVzdC1jaXBoZXJ0ZXh0' },
};
const instances = {
	format: 'freelm-instances-v1',
	instanceId: 'host',
	name: 'My host',
	profiles: [
		{
			id: 'remote',
			instanceId: 'remote-host',
			name: 'Remote',
			transport: 'direct',
			url: 'https://example.com',
			encryptedToken: 'cHJlc2VydmU=',
		},
	],
};
async function fixture() {
	const root = await mkdtemp(path.join(os.tmpdir(), 'freelm-migration-'));
	folders.push(root);
	const old = path.join(root, 'Library', 'Application Support', 'FreeLM');
	await mkdir(old, { recursive: true });
	await writeFile(path.join(old, 'workspace.json'), JSON.stringify(legacy));
	await writeFile(path.join(old, 'instances.json'), JSON.stringify(instances));
	const paths = resolveStoragePaths({
		home: root,
		platform: 'darwin',
		userData: old,
		packaged: true,
		env: {},
	});
	return { root, old, paths };
}

describe('FreeLM home paths', () => {
	it('uses a predictable home with platform caches and legacy metadata kept separate', () => {
		const mac = resolveStoragePaths({
			home: '/Users/test',
			platform: 'darwin',
			userData: '/legacy',
			packaged: true,
			env: {},
		});
		expect(mac.home).toBe('/Users/test/.freelm');
		expect(mac.cache).toBe('/Users/test/Library/Caches/FreeLM');
		expect(mac.legacy).toBe('/legacy');
		const linux = resolveStoragePaths({
			home: '/home/test',
			platform: 'linux',
			userData: '/legacy',
			packaged: true,
			env: { XDG_CACHE_HOME: '/cache' },
		});
		expect(linux.cache).toBe('/cache/FreeLM');
		expect(linux.config).toBe('/home/test/.freelm/config.json');
		expect(
			resolveStoragePaths({
				home: '/home/test',
				platform: 'linux',
				userData: '/legacy',
				packaged: true,
				env: { XDG_CACHE_HOME: 'relative' },
			}).cache,
		).toBe('/home/test/.cache/FreeLM');
	});
	it('isolates explicit homes and gives development test profiles priority', () => {
		const options = {
			home: '/home/test',
			platform: 'linux',
			userData: '/legacy',
			packaged: true,
			env: { FREELM_HOME: '~/portable', FREELM_USER_DATA: '/test' },
		};
		expect(resolveStoragePaths(options).home).toBe('/home/test/portable');
		expect(resolveStoragePaths(options).legacy).toBeUndefined();
		const dev = resolveStoragePaths({ ...options, packaged: false });
		expect(dev.home).toBe('/test');
		expect(dev.cache).toBe('/test/.cache');
		expect(() => resolveStoragePaths({ ...options, env: { FREELM_HOME: 'relative' } })).toThrow(
			'absolute path',
		);
	});
});

describe('legacy profile migration', () => {
	it('starts empty for a new profile or explicit home without importing unrelated data', async () => {
		const { root, old, paths } = await fixture();
		const isolated = resolveStoragePaths({
			home: root,
			platform: 'darwin',
			userData: old,
			packaged: true,
			env: { FREELM_HOME: path.join(root, 'isolated') },
		});
		await initializeStorage(isolated);
		expect(await readdir(isolated.home)).toEqual(['skills']);
		await initializeStorage({ ...paths, legacy: path.join(root, 'no-old-profile') });
		expect(await readdir(paths.home)).toEqual(['skills']);
	});
	it('rejects symlink source files without publishing a migrated workspace', async () => {
		const { root, old, paths } = await fixture();
		await rm(path.join(old, 'workspace.json'));
		await writeFile(path.join(root, 'outside.json'), JSON.stringify(legacy));
		await symlink(path.join(root, 'outside.json'), path.join(old, 'workspace.json'));
		await expect(initializeStorage(paths)).rejects.toThrow('regular file');
		expect(await readdir(paths.home)).toEqual(['skills']);
	});
	it('preserves all state, encrypted credentials, remote identity and recovery copies without touching originals', async () => {
		const { old, paths } = await fixture();
		await mkdir(path.join(old, 'recovery'));
		await writeFile(path.join(old, 'recovery', 'freelm-unsaved-test.json'), 'recovery bytes');
		const beforeWorkspace = await readFile(path.join(old, 'workspace.json'));
		const beforeInstances = await readFile(path.join(old, 'instances.json'));
		await initializeStorage(paths);
		const config = JSON.parse(await readFile(paths.config, 'utf8'));
		const workspace = JSON.parse(await readFile(paths.workspace, 'utf8'));
		expect(validateSplitWorkspace(config, workspace)).toEqual({
			state: legacy.state,
			encryptedKeys: legacy.encryptedKeys,
		});
		expect(await readFile(paths.instances)).toEqual(beforeInstances);
		expect(await readFile(path.join(old, 'workspace.json'))).toEqual(beforeWorkspace);
		expect(await readFile(path.join(old, 'instances.json'))).toEqual(beforeInstances);
		expect(await readFile(path.join(paths.recovery, 'freelm-unsaved-test.json'), 'utf8')).toBe(
			'recovery bytes',
		);
		expect((await stat(paths.config)).mode & 0o777).toBe(0o600);
		expect((await stat(paths.home)).mode & 0o777).toBe(0o700);
		expect((await stat(paths.skills)).isDirectory()).toBe(true);
		expect((await readdir(paths.home)).some((name) => name.startsWith('.migration'))).toBe(false);
	});
	it('does not reimport old data after the new home changes', async () => {
		const { paths } = await fixture();
		await initializeStorage(paths);
		const config = JSON.parse(await readFile(paths.config, 'utf8'));
		config.theme = 'light';
		await writeFile(paths.config, JSON.stringify(config));
		await initializeStorage(paths);
		expect(JSON.parse(await readFile(paths.config, 'utf8')).theme).toBe('light');
	});
	it('leaves an existing destination alone even if the old profile is corrupt', async () => {
		const { old, paths } = await fixture();
		await mkdir(paths.home);
		await writeFile(paths.config, 'existing destination');
		await writeFile(path.join(old, 'workspace.json'), '{broken');
		await initializeStorage(paths);
		expect(await readFile(paths.config, 'utf8')).toBe('existing destination');
		expect(await readdir(paths.home)).toEqual(['config.json', 'skills']);
	});
	it('refuses malformed source data before publishing any destination files', async () => {
		const { old, paths } = await fixture();
		await writeFile(path.join(old, 'instances.json'), '{broken');
		await expect(initializeStorage(paths)).rejects.toThrow('original data is unchanged');
		expect(await readdir(paths.home)).toEqual(['skills']);
		expect(await readFile(path.join(old, 'workspace.json'), 'utf8')).toBe(JSON.stringify(legacy));
	});
	it('refuses conflicting destination profiles without replacing them or publishing history', async () => {
		const { paths } = await fixture();
		await mkdir(paths.home);
		await writeFile(paths.instances, 'keep existing');
		await expect(initializeStorage(paths)).rejects.toThrow('already exists with different content');
		expect(await readFile(paths.instances, 'utf8')).toBe('keep existing');
		await expect(stat(paths.workspace)).rejects.toMatchObject({ code: 'ENOENT' });
	});
	it('resumes a verified interrupted copy even when a target file was already published', async () => {
		const { old, paths } = await fixture();
		const pair = splitLegacyWorkspace(legacy);
		const staging = `.migration-${randomUUID()}`;
		await mkdir(path.join(paths.home, staging), { recursive: true });
		const files = [];
		for (const [name, contents] of [
			['config.json', pair.config],
			['workspace.json', pair.workspace],
		] as const) {
			const bytes = JSON.stringify(contents);
			await writeFile(path.join(paths.home, staging, name), bytes);
			files.push({ name, sha256: createHash('sha256').update(bytes).digest('hex') });
		}
		await writeFile(paths.config, JSON.stringify(pair.config));
		await writeFile(
			path.join(paths.home, '.migration-pending.json'),
			JSON.stringify({
				format: 'freelm-home-migration-v1',
				source: old,
				createdAt: new Date().toISOString(),
				staging,
				files,
			}),
		);
		await initializeStorage(paths);
		expect(JSON.parse(await readFile(paths.workspace, 'utf8'))).toEqual(pair.workspace);
		await expect(stat(path.join(paths.home, '.migration-pending.json'))).rejects.toMatchObject({
			code: 'ENOENT',
		});
	});
	it('detects damaged staged copies and leaves partial destinations untouched', async () => {
		const { old, paths } = await fixture();
		const staging = `.migration-${randomUUID()}`;
		await mkdir(path.join(paths.home, staging), { recursive: true });
		await writeFile(path.join(paths.home, staging, 'workspace.json'), 'damaged');
		await writeFile(
			path.join(paths.home, '.migration-pending.json'),
			JSON.stringify({
				format: 'freelm-home-migration-v1',
				source: old,
				createdAt: '',
				staging,
				files: [{ name: 'workspace.json', sha256: 'a'.repeat(64) }],
			}),
		);
		await expect(initializeStorage(paths)).rejects.toThrow('verification failed');
		await expect(stat(paths.workspace)).rejects.toMatchObject({ code: 'ENOENT' });
	});
});
