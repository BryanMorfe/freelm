import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { splitLegacyWorkspace, validateSplitWorkspace } from './state-store';
import { validateInstanceInput } from './instance-client';
import type { StoragePaths } from './storage-paths';

interface Migration {
	format: 'freelm-home-migration-v1';
	source: string;
	createdAt: string;
	staging: string;
	files: { name: string; sha256: string }[];
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

async function exists(filename: string) {
	try {
		await lstat(filename);
		return true;
	} catch (error) {
		if (missing(error)) return false;
		throw error;
	}
}
async function readRegular(filename: string): Promise<Buffer | undefined> {
	let info;
	try {
		info = await lstat(filename);
	} catch (error) {
		if (missing(error)) return undefined;
		throw error;
	}
	if (!info.isFile() || info.size > 512 * 1024 * 1024)
		throw new Error(`Cannot migrate ${filename}: expected a regular file smaller than 512 MB.`);
	return readFile(filename);
}
async function syncDirectory(directory: string) {
	const handle = await open(directory, 'r');
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}
async function writePrivate(filename: string, bytes: Buffer) {
	await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
	const handle = await open(filename, 'wx', 0o600);
	try {
		await handle.writeFile(bytes);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await syncDirectory(path.dirname(filename));
}

function validateInstances(bytes: Buffer) {
	const saved = JSON.parse(bytes.toString('utf8'));
	if (
		!saved ||
		saved.format !== 'freelm-instances-v1' ||
		typeof saved.instanceId !== 'string' ||
		!/^[a-zA-Z0-9-]{1,128}$/.test(saved.instanceId) ||
		typeof saved.name !== 'string' ||
		saved.name.length > 256 ||
		!Array.isArray(saved.profiles) ||
		saved.profiles.length > 100
	)
		throw new Error('Saved remote instance settings are invalid.');
	const ids = new Set<string>();
	for (const profile of saved.profiles) {
		const instanceId: unknown = profile?.instanceId;
		const encryptedToken: unknown = profile?.encryptedToken;
		validateInstanceInput(profile);
		if (
			typeof profile.id !== 'string' ||
			ids.has(profile.id) ||
			typeof instanceId !== 'string' ||
			!instanceId ||
			(encryptedToken !== undefined && typeof encryptedToken !== 'string')
		)
			throw new Error('Saved remote instance settings are invalid.');
		ids.add(profile.id);
	}
}

function validateMigration(value: unknown): asserts value is Migration {
	const saved = value as Migration;
	if (
		!saved ||
		saved.format !== 'freelm-home-migration-v1' ||
		typeof saved.source !== 'string' ||
		typeof saved.createdAt !== 'string' ||
		typeof saved.staging !== 'string' ||
		!/^\.migration-[a-f0-9-]{36}$/.test(saved.staging) ||
		!Array.isArray(saved.files) ||
		saved.files.length > 10_000 ||
		saved.files.some(
			(file) =>
				!file ||
				typeof file.name !== 'string' ||
				!(
					/^(config|workspace|instances)\.json$/.test(file.name) ||
					/^recovery\/[a-zA-Z0-9_.-]+\.json$/.test(file.name)
				) ||
				typeof file.sha256 !== 'string' ||
				!/^[a-f0-9]{64}$/.test(file.sha256),
		) ||
		new Set(saved.files.map((file) => file.name)).size !== saved.files.length
	)
		throw new Error(
			'The saved migration record is invalid. Keep the migration files for recovery.',
		);
}

/** Copy app-owned data only. The source and its OS-bound credential metadata are never changed. */
export async function initializeStorage(paths: StoragePaths): Promise<void> {
	await mkdir(paths.home, { recursive: true, mode: 0o700 });
	await mkdir(paths.skills, { recursive: true, mode: 0o700 });
	const pending = path.join(paths.home, '.migration-pending.json');
	try {
		const journal = await readRegular(pending);
		if (journal) {
			const migration: unknown = JSON.parse(journal.toString('utf8'));
			validateMigration(migration);
			await finishMigration(paths, migration);
			return;
		}
		if (
			!paths.legacy ||
			(await exists(paths.config)) ||
			(await exists(paths.workspace)) ||
			(await exists(path.join(paths.home, 'migration.json')))
		)
			return;
		if (path.resolve(paths.legacy) === path.resolve(paths.home))
			throw new Error('The legacy profile and new FreeLM home must be separate directories.');
		const files = new Map<string, Buffer>();
		const oldWorkspace = await readRegular(path.join(paths.legacy, 'workspace.json'));
		if (oldWorkspace) {
			const pair = splitLegacyWorkspace(oldWorkspace.toString('utf8'));
			validateSplitWorkspace(pair.config, pair.workspace);
			files.set('config.json', Buffer.from(JSON.stringify(pair.config, null, 2)));
			files.set('workspace.json', Buffer.from(JSON.stringify(pair.workspace)));
		}
		const oldInstances = await readRegular(path.join(paths.legacy, 'instances.json'));
		if (oldInstances) {
			validateInstances(oldInstances);
			files.set('instances.json', oldInstances);
		}
		const recovery = path.join(paths.legacy, 'recovery');
		if (await exists(recovery)) {
			if (!(await lstat(recovery)).isDirectory())
				throw new Error('The recovery folder must be a directory.');
			for (const name of await readdir(recovery)) {
				if (!/^[a-zA-Z0-9_.-]+\.json$/.test(name)) continue;
				const bytes = await readRegular(path.join(recovery, name));
				if (bytes) files.set(`recovery/${name}`, bytes);
			}
		}
		if (!files.size) return;
		const migration: Migration = {
			format: 'freelm-home-migration-v1',
			source: paths.legacy,
			createdAt: new Date().toISOString(),
			staging: `.migration-${randomUUID()}`,
			files: [...files].map(([name, bytes]) => ({ name, sha256: hash(bytes) })),
		};
		validateMigration(migration);
		const stage = path.join(paths.home, migration.staging);
		try {
			for (const [name, bytes] of files) await writePrivate(path.join(stage, name), bytes);
			// Publish the recovery record only after every staged file is durable.
			const stagedJournal = path.join(stage, 'manifest.json');
			await writePrivate(stagedJournal, Buffer.from(JSON.stringify(migration, null, 2)));
			await link(stagedJournal, pending);
			await syncDirectory(paths.home);
		} catch (error) {
			if (!(await exists(pending))) await rm(stage, { recursive: true, force: true });
			throw error;
		}
		await finishMigration(paths, migration);
	} catch (error) {
		throw new Error(
			`Could not migrate FreeLM data to ${paths.home}. Your original data is unchanged. ${(error as Error).message}`,
		);
	}
}

async function finishMigration(paths: StoragePaths, migration: Migration) {
	const stage = path.join(paths.home, migration.staging);
	// Check all inputs/conflicts before publishing anything. Never replace a destination file.
	for (const file of migration.files) {
		const source = await readRegular(path.join(stage, file.name));
		if (!source || hash(source) !== file.sha256)
			throw new Error(`Migration verification failed for ${file.name}.`);
		const target = await readRegular(path.join(paths.home, file.name));
		if (target && hash(target) !== file.sha256)
			throw new Error(
				`${file.name} already exists with different content. It has not been overwritten.`,
			);
	}
	for (const file of migration.files) {
		const target = path.join(paths.home, file.name);
		await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
		try {
			await link(path.join(stage, file.name), target);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
		}
		if (hash((await readRegular(target))!) !== file.sha256)
			throw new Error(`Migration verification failed for ${file.name}.`);
		await syncDirectory(path.dirname(target));
	}
	await rename(
		path.join(paths.home, '.migration-pending.json'),
		path.join(paths.home, 'migration.json'),
	);
	await syncDirectory(paths.home);
	await rm(stage, { recursive: true, force: true });
}
