import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = path.join(root, 'resources/search');
const MAX_DOWNLOAD = 64 * 1024 * 1024;
const allowedHosts = new Set([
	'github.com',
	'codeload.github.com',
	'release-assets.githubusercontent.com',
	'objects.githubusercontent.com',
	'files.pythonhosted.org',
	'raw.githubusercontent.com',
]);

export function validateArtifact(artifact) {
	const url = new URL(artifact.url);
	if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname) || url.username || url.password)
		throw new Error('Runtime artifacts must use an approved official HTTPS host.');
	if (!/^[a-f0-9]{64}$/.test(artifact.sha256))
		throw new Error('Runtime artifact requires a SHA-256 pin.');
	if (
		artifact.size !== undefined &&
		(!Number.isSafeInteger(artifact.size) || artifact.size <= 0 || artifact.size > MAX_DOWNLOAD)
	)
		throw new Error('Runtime artifact size exceeds the download budget.');
}

export function selectTargets(args, platform = process.platform, arch = process.arch) {
	const value = args.find((arg) => arg.startsWith('--targets='))?.slice(10);
	const targets = value ? value.split(',') : [`${platform}-${arch}`];
	if (
		!targets.length ||
		targets.some(
			(target) => !['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'].includes(target),
		)
	)
		throw new Error('Supported search targets: darwin-arm64,darwin-x64,linux-arm64,linux-x64');
	return [...new Set(targets)];
}

async function sha256(file) {
	const hash = createHash('sha256');
	for await (const bytes of createReadStream(file)) hash.update(bytes);
	return hash.digest('hex');
}

async function download(artifact, cache) {
	validateArtifact(artifact);
	const destination = path.join(cache, artifact.sha256);
	try {
		if (
			(await stat(destination)).size <= MAX_DOWNLOAD &&
			(await sha256(destination)) === artifact.sha256
		)
			return destination;
	} catch (error) {
		if (error.code !== 'ENOENT') throw error;
	}
	let url = new URL(artifact.url);
	const abort = AbortSignal.timeout(120_000);
	let response;
	for (let redirects = 0; redirects <= 5; redirects++) {
		validateArtifact({ ...artifact, url: url.href });
		response = await fetch(url, { redirect: 'manual', signal: abort });
		if ([301, 302, 303, 307, 308].includes(response.status)) {
			await response.body?.cancel();
			url = new URL(response.headers.get('location') ?? '', url);
			continue;
		}
		break;
	}
	if (!response?.ok || !response.body) throw new Error(`Runtime download HTTP ${response?.status}`);
	const length = Number(response.headers.get('content-length'));
	if (length > MAX_DOWNLOAD) {
		await response.body.cancel();
		throw new Error('Runtime download exceeds 64 MiB.');
	}
	const temporary = destination + `.partial-${process.pid}`;
	let size = 0;
	const hash = createHash('sha256');
	try {
		await pipeline(
			Readable.fromWeb(response.body),
			new Transform({
				transform(chunk, _encoding, callback) {
					size += chunk.length;
					if (size > MAX_DOWNLOAD) return callback(new Error('Runtime download exceeds 64 MiB.'));
					hash.update(chunk);
					callback(null, chunk);
				},
			}),
			createWriteStream(temporary, { mode: 0o600 }),
		);
		if (
			hash.digest('hex') !== artifact.sha256 ||
			(artifact.size !== undefined && size !== artifact.size)
		)
			throw new Error('Runtime artifact integrity check failed.');
		await rename(temporary, destination);
	} finally {
		await rm(temporary, { force: true });
	}
	return destination;
}

async function run(executable, args, options = {}) {
	await new Promise((resolve, reject) => {
		const child = spawn(executable, args, { stdio: 'inherit', ...options });
		child.once('error', reject);
		child.once('exit', (code) =>
			code === 0 ? resolve() : reject(new Error(`${path.basename(executable)} exited ${code}`)),
		);
	});
}

const installWheels = `
import pathlib,sys,zipfile
destination=pathlib.Path(sys.argv[1]); destination.mkdir(parents=True,exist_ok=True)
for filename in sys.argv[2:]:
 with zipfile.ZipFile(filename) as wheel:
  for item in wheel.infolist():
   if item.is_dir(): continue
   parts=pathlib.PurePosixPath(item.filename).parts
   if '..' in parts or item.filename.startswith('/') or len(parts)>30: raise ValueError('unsafe wheel path')
   if parts[0].endswith('.data'):
    if len(parts)<3 or parts[1] not in ('purelib','platlib'): continue
    parts=parts[2:]
   target=destination.joinpath(*parts)
   target.parent.mkdir(parents=True,exist_ok=True)
   target.write_bytes(wheel.read(item))
   if target.suffix in ('.so','.dylib'): target.chmod(0o755)
`;

async function prepare() {
	const manifestBytes = await readFile(path.join(bundle, 'manifest.json'));
	const manifest = JSON.parse(manifestBytes);
	const pin = createHash('sha256').update(manifestBytes).digest('hex');
	const targets = selectTargets(process.argv.slice(2));
	const cache = path.join(tmpdir(), 'freelm-search-runtime-cache');
	await mkdir(cache, { recursive: true, mode: 0o700 });
	await chmod(cache, 0o700);
	const noticeDir = path.join(bundle, 'licenses/python-standalone');
	await mkdir(noticeDir, { recursive: true });
	for (const notice of manifest.python.notices) {
		if (!/^LICENSE(?:\.[A-Za-z0-9.-]+)?$/.test(notice.filename))
			throw new Error('Invalid notice filename.');
		const destination = path.join(noticeDir, notice.filename);
		if ((await sha256(destination).catch(() => '')) === notice.sha256) continue;
		const source = await download(notice, cache);
		await writeFile(destination, await readFile(source));
	}
	const sourcePin = path.join(bundle, 'source/.freelm-revision');
	if ((await readFile(sourcePin, 'utf8').catch(() => '')) !== manifest.searxng.revision) {
		const sourceArchive = await download(manifest.searxng, cache);
		const staging = path.join(bundle, `source.staging-${process.pid}`);
		await rm(staging, { recursive: true, force: true });
		await mkdir(staging, { recursive: true });
		await run('tar', ['-xzf', sourceArchive, '-C', staging, '--strip-components=1']);
		await writeFile(
			path.join(staging, 'searx/version_frozen.py'),
			`# Generated from the immutable bundled revision.\nVERSION_STRING = ${JSON.stringify(manifest.searxng.version)}\nVERSION_TAG = ${JSON.stringify(manifest.searxng.version)}\nDOCKER_TAG = ${JSON.stringify(manifest.searxng.version)}\nGIT_URL = "https://github.com/searxng/searxng"\nGIT_BRANCH = "master"\n`,
		);
		await writeFile(path.join(staging, '.freelm-revision'), manifest.searxng.revision);
		await rm(path.join(bundle, 'source'), { recursive: true, force: true });
		await rename(staging, path.join(bundle, 'source'));
	}
	// A host-compatible bundled interpreter can unpack other targets' wheels without
	// importing them. Every target uses CPython 3.12 and its own ABI-correct wheels.
	let unpacker;
	for (const target of targets) {
		const metadata = manifest.targets[target];
		if (!metadata || metadata.wheels.length > 64)
			throw new Error('Invalid runtime target manifest.');
		const targetDir = path.join(bundle, 'runtime', target);
		const ready = path.join(targetDir, 'bundle.json');
		const existing = JSON.parse(await readFile(ready, 'utf8').catch(() => '{}'));
		if (existing.manifestSha256 === pin && existing.preparationVersion === 1) {
			console.log(`Search runtime ${target} already prepared.`);
			continue;
		}
		const pythonArchive = await download(metadata.python, cache);
		const staging = path.join(bundle, 'runtime', `${target}.staging-${process.pid}`);
		await rm(staging, { recursive: true, force: true });
		await mkdir(staging, { recursive: true });
		try {
			await run('tar', ['-xzf', pythonArchive, '-C', staging]);
			const wheels = [];
			for (const wheel of metadata.wheels) wheels.push(await download(wheel, cache));
			const ownPython = path.join(staging, 'python/bin/python3');
			const hostTarget = `${process.platform}-${process.arch}`;
			// Prefer this target's interpreter when native; Rosetta can also run the
			// Intel helper on Apple Silicon. Linux cross-builds use an existing host.
			const executable =
				target === hostTarget || (process.platform === 'darwin' && target.startsWith('darwin-'))
					? ownPython
					: (unpacker ?? path.join(bundle, 'runtime', hostTarget, 'python/bin/python3'));
			await run(executable, [
				'-I',
				'-B',
				'-c',
				installWheels,
				path.join(staging, 'site-packages'),
				...wheels,
			]);
			await writeFile(
				path.join(staging, 'bundle.json'),
				JSON.stringify(
					{
						schema: 1,
						preparationVersion: 1,
						target,
						manifestSha256: pin,
						pythonVersion: manifest.python.version,
						searxngVersion: manifest.searxng.version,
						python: 'python/bin/python3',
					},
					null,
					2,
				) + '\n',
			);
			await rm(targetDir, { recursive: true, force: true });
			await rename(staging, targetDir);
			if (target === hostTarget) unpacker = path.join(targetDir, 'python/bin/python3');
			console.log(
				`Prepared ${target}: Python ${manifest.python.version}, SearXNG ${manifest.searxng.version}, ${wheels.length} pinned wheels.`,
			);
		} finally {
			await rm(staging, { recursive: true, force: true });
		}
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	prepare().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
