import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import {
	access,
	cp,
	mkdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import path from 'node:path';

// electron-builder's public Arch enum. The afterPack callback runs on both thin
// inputs and again on the combined universal app, immediately before signing.
const X64 = 1;
const ARM64 = 3;
const UNIVERSAL = 4;
const commonFiles = [
	'launcher.py',
	'manifest.json',
	'engines.json',
	'requirements.lock',
	'NOTICE.md',
];

function requestedMacArchitectures(context) {
	const options = context.packager.info?.options ?? {};
	const result = new Set();
	if (options.targets instanceof Map) {
		for (const [platform, targets] of options.targets) {
			if (
				platform?.nodeName !== 'darwin' &&
				platform?.buildConfigurationKey !== 'mac' &&
				platform !== 'mac'
			)
				continue;
			if (targets instanceof Map) for (const arch of targets.keys()) result.add(arch);
		}
	}
	// Programmatic calls may retain raw mac targets; CLI normalizes them into the
	// targets map and removes options.mac. Configuration can also specify arches.
	const definitions = [...(Array.isArray(options.mac) ? options.mac : [])];
	const configured = context.packager.platformSpecificBuildOptions?.target;
	if (configured && !result.size)
		definitions.push(...(Array.isArray(configured) ? configured : [configured]));
	for (const definition of definitions) {
		const target = typeof definition === 'string' ? definition : definition?.target;
		const arches = typeof definition === 'object' ? definition?.arch : undefined;
		for (const value of [
			...(Array.isArray(arches) ? arches : arches ? [arches] : []),
			target?.split(':')[1],
		].filter(Boolean)) {
			if (value === 'universal') result.add(UNIVERSAL);
			else if (value === 'x64') result.add(X64);
			else if (value === 'arm64') result.add(ARM64);
		}
	}
	return result;
}

export function searchPackagingTargets(context) {
	if (context.electronPlatformName !== 'darwin') return [];
	const requested = requestedMacArchitectures(context);
	if (requested.has(UNIVERSAL) && [...requested].some((arch) => arch !== UNIVERSAL))
		throw new Error(
			'Package universal and standalone macOS targets in separate invocations to stage search runtimes correctly.',
		);
	if (context.arch === UNIVERSAL) return ['darwin-arm64', 'darwin-x64'];
	if (requested.has(UNIVERSAL)) return []; // Thin temporary passes of universal packaging.
	if (context.arch === ARM64) return ['darwin-arm64'];
	if (context.arch === X64) return ['darwin-x64'];
	throw new Error('Bundled search supports macOS arm64, x64, and universal packaging.');
}

async function contained(root, filename, directory = false) {
	const resolved = await realpath(filename).catch(() => {
		throw new Error(
			`Missing bundled search resource: ${path.relative(root, filename)}. Run prepare:search first.`,
		);
	});
	const relative = path.relative(root, resolved);
	if (
		!relative ||
		relative === '..' ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	)
		throw new Error('A bundled search resource resolves outside its trusted resource directory.');
	const information = await stat(resolved);
	if (directory ? !information.isDirectory() : !information.isFile())
		throw new Error(`Invalid bundled search resource: ${path.relative(root, filename)}.`);
	return resolved;
}

function digest(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

async function validateBundle(source, targets) {
	for (const filename of commonFiles) await contained(source, path.join(source, filename));
	const manifestBytes = await readFile(path.join(source, 'manifest.json'));
	const manifest = JSON.parse(manifestBytes);
	if (manifest.schema !== 1 || !/^[a-f0-9]{40}$/.test(manifest.searxng?.revision ?? ''))
		throw new Error('The bundled search manifest is invalid.');
	const manifestSha256 = digest(manifestBytes);
	const catalog = JSON.parse(await readFile(path.join(source, 'engines.json'), 'utf8'));
	if (
		catalog.version !== manifest.searxng.version ||
		!Array.isArray(catalog.engines) ||
		!catalog.engines.length
	)
		throw new Error('The bundled engine catalogue does not match the pinned SearXNG version.');
	await contained(source, path.join(source, 'source'), true);
	for (const filename of [
		'LICENSE',
		'searx/webapp.py',
		'searx/settings.yml',
		'searx/version_frozen.py',
		'.freelm-revision',
	])
		await contained(source, path.join(source, 'source', filename));
	if (
		(await readFile(path.join(source, 'source/.freelm-revision'), 'utf8')).trim() !==
		manifest.searxng.revision
	)
		throw new Error('The bundled SearXNG source revision does not match its manifest.');
	await contained(source, path.join(source, 'licenses'), true);
	if (!Array.isArray(manifest.python?.notices) || !manifest.python.notices.length)
		throw new Error('The bundled Python dependency notices are missing from the manifest.');
	for (const notice of manifest.python.notices) {
		if (
			!/^LICENSE(?:\.[A-Za-z0-9.-]+)?$/.test(notice.filename) ||
			!/^[a-f0-9]{64}$/.test(notice.sha256)
		)
			throw new Error('The bundled Python notice pin is invalid.');
		const filename = path.join(source, 'licenses/python-standalone', notice.filename);
		await contained(source, filename);
		if (digest(await readFile(filename)) !== notice.sha256)
			throw new Error(`Bundled Python notice integrity failed: ${notice.filename}.`);
	}
	for (const target of targets) {
		const runtime = path.join(source, 'runtime', target);
		await contained(source, runtime, true);
		await contained(source, path.join(runtime, 'bundle.json'));
		const stamp = JSON.parse(await readFile(path.join(runtime, 'bundle.json'), 'utf8'));
		if (
			stamp.schema !== 1 ||
			stamp.preparationVersion !== 1 ||
			stamp.target !== target ||
			stamp.manifestSha256 !== manifestSha256 ||
			stamp.python !== 'python/bin/python3' ||
			stamp.pythonVersion !== manifest.python.version ||
			stamp.searxngVersion !== manifest.searxng.version
		)
			throw new Error(
				`Bundled search runtime ${target} has a missing or stale preparation stamp. Run prepare:search first.`,
			);
		const executable = await contained(source, path.join(runtime, stamp.python));
		await access(executable, constants.X_OK);
		await contained(source, path.join(runtime, 'python/lib/python3.12/LICENSE.txt'));
		await contained(source, path.join(runtime, 'site-packages'), true);
		for (const filename of [
			'waitress/__init__.py',
			'flask/__init__.py',
			'curl_cffi/__init__.py',
			'yaml/__init__.py',
			'certifi/cacert.pem',
		])
			await contained(source, path.join(runtime, 'site-packages', filename));
	}
	return manifestSha256;
}

export async function afterPack(context) {
	const targets = searchPackagingTargets(context);
	if (!targets.length) return;
	const project = context.packager.projectDir ?? context.packager.info?.projectDir;
	if (!path.isAbsolute(project ?? '') || typeof context.packager.getResourcesDir !== 'function')
		throw new Error(
			'The search packaging hook requires electron-builder project and resource paths.',
		);
	const source = await realpath(path.join(project, 'resources/search'));
	const manifestSha256 = await validateBundle(source, targets);
	const resources = context.packager.getResourcesDir(context.appOutDir);
	if (!path.isAbsolute(resources))
		throw new Error('The packaged resources directory must be absolute.');
	const destination = path.join(resources, 'search');
	const expected = { schema: 1, manifestSha256, targets };
	try {
		const existing = JSON.parse(await readFile(path.join(destination, 'packaged.json'), 'utf8'));
		if (JSON.stringify(existing) === JSON.stringify(expected)) return;
	} catch (error) {
		if (error.code !== 'ENOENT') throw error;
	}
	if (
		await stat(destination).then(
			() => true,
			(error) => (error.code === 'ENOENT' ? false : Promise.reject(error)),
		)
	)
		throw new Error(
			'Search resources were already copied. Remove search from mac.extraResources when using the afterPack hook.',
		);
	await mkdir(resources, { recursive: true });
	const staging = path.join(resources, `search.staging-${randomBytes(8).toString('hex')}`);
	await mkdir(staging);
	const copyOptions = {
		recursive: true,
		verbatimSymlinks: true,
		preserveTimestamps: true,
		force: false,
		errorOnExist: true,
	};
	try {
		for (const filename of commonFiles)
			await cp(path.join(source, filename), path.join(staging, filename), copyOptions);
		for (const directory of ['source', 'licenses'])
			await cp(path.join(source, directory), path.join(staging, directory), copyOptions);
		for (const target of targets)
			await cp(
				path.join(source, 'runtime', target),
				path.join(staging, 'runtime', target),
				copyOptions,
			);
		await writeFile(path.join(staging, 'packaged.json'), JSON.stringify(expected));
		await rename(staging, destination);
		console.log(`Bundled search staged before signing (${targets.join(', ')}).`);
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}

export default afterPack;
