import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = [
	{
		arch: 'arm64',
		name: '@napi-rs/canvas-darwin-arm64',
		binary: 'skia.darwin-arm64.node',
		cpu: 0x0100000c,
	},
	{
		arch: 'x64',
		name: '@napi-rs/canvas-darwin-x64',
		binary: 'skia.darwin-x64.node',
		cpu: 0x01000007,
	},
];
async function metadata(directory) {
	return JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
}
async function exists(filename) {
	try {
		await lstat(filename);
		return true;
	} catch (error) {
		if (error.code === 'ENOENT') return false;
		throw error;
	}
}
async function correctAddon(directory, target, version) {
	try {
		const info = await lstat(directory);
		if (!info.isDirectory() || info.isSymbolicLink()) return false;
		const pkg = await metadata(directory);
		if (
			pkg.name !== target.name ||
			pkg.version !== version ||
			pkg.main !== target.binary ||
			!Array.isArray(pkg.os) ||
			!pkg.os.includes('darwin') ||
			!Array.isArray(pkg.cpu) ||
			!pkg.cpu.includes(target.arch)
		)
			return false;
		const binary = path.join(directory, target.binary);
		const stat = await lstat(binary);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 16 || stat.size > 128 * 1024 * 1024)
			return false;
		const file = await open(binary, 'r');
		try {
			const header = Buffer.alloc(8);
			await file.read(header, 0, header.length, 0);
			return header.readUInt32LE(0) === 0xfeedfacf && header.readUInt32LE(4) === target.cpu;
		} finally {
			await file.close();
		}
	} catch (error) {
		if (['ENOENT', 'ENOTDIR'].includes(error.code) || error instanceof SyntaxError) return false;
		throw error;
	}
}
function lockedPackage(lock, canvas, target) {
	const version = canvas.optionalDependencies?.[target.name];
	if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
		throw new Error(
			`Installed Canvas must specify an exact version for ${target.name}. Run npm ci before packaging.`,
		);
	const entry = lock.packages?.[`node_modules/${target.name}`];
	if (
		!entry ||
		entry.version !== version ||
		typeof entry.integrity !== 'string' ||
		typeof entry.resolved !== 'string'
	)
		throw new Error(
			`package-lock.json does not match the installed Canvas ${target.name}@${version}. Run npm ci before packaging.`,
		);
	const url = new URL(entry.resolved);
	const basename = target.name.split('/')[1];
	if (
		url.protocol !== 'https:' ||
		url.hostname !== 'registry.npmjs.org' ||
		url.port ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== `/@napi-rs/${basename}/-/${basename}-${version}.tgz`
	)
		throw new Error(
			`The locked ${target.name} archive must use its exact official npm registry URL.`,
		);
	const integrity = ['sha512', 'sha384', 'sha256']
		.flatMap((algorithm) =>
			entry.integrity.split(/\s+/).filter((token) => token.startsWith(`${algorithm}-`)),
		)
		.at(0);
	if (!integrity)
		throw new Error(
			`The locked ${target.name} archive needs a SHA-256 or stronger integrity value.`,
		);
	return { version, resolved: url.href, integrity };
}
async function verifyArchive(filename, integrity) {
	const stat = await lstat(filename);
	if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || stat.size > 64 * 1024 * 1024)
		throw new Error('The Canvas archive must be a regular file no larger than 64 MiB.');
	const separator = integrity.indexOf('-');
	const hash = createHash(integrity.slice(0, separator));
	for await (const chunk of createReadStream(filename)) hash.update(chunk);
	if (hash.digest('base64') !== integrity.slice(separator + 1))
		throw new Error('The downloaded Canvas archive does not match package-lock.json integrity.');
}

/** Only these two architecture-specific Canvas packages may be changed. */
export async function prepareMacDependencies({
	nodeModules = path.join(root, 'node_modules'),
	lockfile = path.join(root, 'package-lock.json'),
	log = console.log,
} = {}) {
	const canvas = await metadata(path.join(nodeModules, '@napi-rs', 'canvas'));
	if (canvas.name !== '@napi-rs/canvas')
		throw new Error('Install @napi-rs/canvas before preparing macOS packaging.');
	const lock = JSON.parse(await readFile(lockfile, 'utf8'));
	for (const target of targets) {
		const locked = lockedPackage(lock, canvas, target);
		const destination = path.join(nodeModules, target.name);
		if (await correctAddon(destination, target, locked.version)) {
			log(`Canvas ${target.arch} ${locked.version} is ready.`);
			continue;
		}
		const download = await mkdtemp(path.join(os.tmpdir(), 'freelm-canvas-download-'));
		let stage;
		let retainPrevious = false;
		try {
			const { stdout } = await execute(
				'npm',
				[
					'pack',
					locked.resolved,
					'--ignore-scripts',
					'--json',
					'--pack-destination',
					download,
					'--registry=https://registry.npmjs.org',
					'--fetch-retries=0',
					'--fetch-timeout=60000',
					'--prefer-offline',
				],
				{
					cwd: root,
					timeout: 90000,
					maxBuffer: 1024 * 1024,
					env: { ...process.env, npm_config_update_notifier: 'false' },
				},
			);
			const records = JSON.parse(stdout);
			if (
				!Array.isArray(records) ||
				records.length !== 1 ||
				records[0].name !== target.name ||
				records[0].version !== locked.version ||
				typeof records[0].filename !== 'string' ||
				path.basename(records[0].filename) !== records[0].filename
			)
				throw new Error(`npm pack returned an unexpected Canvas package for ${target.arch}.`);
			const archive = path.join(download, records[0].filename);
			await verifyArchive(archive, locked.integrity);
			const { stdout: listing } = await execute('tar', ['-tzf', archive], {
				timeout: 30000,
				maxBuffer: 1024 * 1024,
			});
			const files = listing.trim().split(/\r?\n/);
			if (
				files.length > 1024 ||
				files.some(
					(file) =>
						!file.startsWith('package/') || file.includes('\\') || file.split('/').includes('..'),
				)
			)
				throw new Error('The Canvas archive contains unexpected file paths.');
			const scope = path.dirname(destination);
			await mkdir(scope, { recursive: true });
			stage = await mkdtemp(path.join(scope, `.freelm-canvas-${target.arch}-`));
			const contents = path.join(stage, 'contents');
			await mkdir(contents);
			await execute('tar', ['-xzf', archive, '--strip-components=1', '-C', contents], {
				timeout: 30000,
				maxBuffer: 1024 * 1024,
			});
			if (!(await correctAddon(contents, target, locked.version)))
				throw new Error(`The staged ${target.name} metadata or native binary is invalid.`);
			const previous = path.join(stage, 'previous');
			const hadPrevious = await exists(destination);
			if (hadPrevious) await rename(destination, previous);
			try {
				await rename(contents, destination);
			} catch (error) {
				if (hadPrevious) {
					try {
						await rename(previous, destination);
					} catch (restoreError) {
						retainPrevious = true;
						throw new AggregateError(
							[error, restoreError],
							`Could not restore the previous Canvas addon. It is preserved at ${previous}.`,
						);
					}
				}
				throw error;
			}
			log(`Prepared Canvas ${target.arch} ${locked.version} from the verified npm archive.`);
		} finally {
			if (stage && !retainPrevious) await rm(stage, { recursive: true, force: true });
			await rm(download, { recursive: true, force: true });
		}
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await prepareMacDependencies();
}
