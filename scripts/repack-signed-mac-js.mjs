/**
 * Repack frozen JS outputs into a COPY of an already signed universal macOS app.
 * Native dependencies, resources, and the source/installed apps are never modified.
 * Run only after the normal build/tests finish; changing native inputs needs a full package.
 *
 * node scripts/repack-signed-mac-js.mjs --build-frozen \
 *   --source-app release/bot-runtime-20261019/mac-universal/FreeLM.app \
 *   --output-app release/bot-runtime-fixed-20261019/mac-universal/FreeLM.app \
 *   --identity 'Apple Development: …'
 */
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import asar from '@electron/asar';
import plist from 'plist';

const project = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2), options = {};
for (let index = 0; index < args.length; index++) {
	if (args[index] === '--build-frozen') options.frozen = true;
	else if (['--source-app', '--output-app', '--identity'].includes(args[index])) {
		const key = args[index], value = args[++index];
		if (!value || value.startsWith('--') || options[key]) throw new Error(`Invalid ${key}.`);
		options[key] = value;
	} else throw new Error(`Unknown argument: ${args[index]}`);
}
if (process.platform !== 'darwin' || !options.frozen || !options['--identity'] ||
	!options['--source-app'] || !options['--output-app'])
	throw new Error('macOS, --build-frozen, --source-app, --output-app and --identity are required.');

const sourceApp = await fs.realpath(path.resolve(project, options['--source-app']));
const outputApp = path.resolve(project, options['--output-app']);
const release = await fs.realpath(path.join(project, 'release'));
const beneath = (root, target) => target.startsWith(`${root}${path.sep}`);
if (!sourceApp.endsWith('.app') || !outputApp.endsWith('.app') ||
	!beneath(release, sourceApp) || !beneath(release, outputApp) ||
	sourceApp === outputApp || beneath(sourceApp, outputApp) || beneath(outputApp, sourceApp))
	throw new Error('Source and output must be distinct .app paths inside this checkout’s release directory.');
try { await fs.lstat(outputApp); throw new Error('Output already exists; choose a new staging path.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

function run(command, commandArgs, capture = false) {
	const result = spawnSync(command, commandArgs, {
		cwd: project, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
		stdio: capture ? 'pipe' : 'inherit',
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${command} failed (${result.status}). ${capture ? result.stderr : ''}`);
	return capture ? `${result.stdout ?? ''}${result.stderr ?? ''}` : '';
}
const hash = data => createHash('sha256').update(data).digest('hex');
async function fileHash(filename) {
	const digest = createHash('sha256');
	for await (const chunk of createReadStream(filename)) digest.update(chunk);
	return digest.digest('hex');
}
async function diskEntries(root, prefix = '') {
	const entries = [];
	for (const name of (await fs.readdir(path.join(root, prefix))).sort()) {
		const relative = prefix ? `${prefix}/${name}` : name;
		const stat = await fs.lstat(path.join(root, relative));
		if (stat.isSymbolicLink()) throw new Error(`Unexpected symlink in extracted/build inputs: ${relative}`);
		entries.push({ relative, stat });
		if (stat.isDirectory()) entries.push(...await diskEntries(root, relative));
		else if (!stat.isFile()) throw new Error(`Unsupported input: ${relative}`);
	}
	return entries;
}
function archiveEntries(archive) {
	const result = new Map();
	function visit(node, prefix = '') {
		for (const [name, entry] of Object.entries(node.files ?? {})) {
			const relative = prefix ? `${prefix}/${name}` : name;
			if (entry.link) throw new Error(`Archive contains a symlink; use the full packager: ${relative}`);
			result.set(relative, entry);
			if (entry.files) visit(entry, relative);
		}
	}
	visit(asar.getRawHeader(archive).header);
	return result;
}
const compiled = name => name === 'dist' || name.startsWith('dist/') ||
	name === 'dist-electron' || name.startsWith('dist-electron/');
async function buildManifest() {
	const rows = [];
	for (const folder of ['dist', 'dist-electron'])
		for (const entry of await diskEntries(path.join(project, folder)))
			if (entry.stat.isFile()) rows.push([`${folder}/${entry.relative}`, await fileHash(path.join(project, folder, entry.relative))]);
	if (!rows.some(([name]) => name === 'dist/index.html') ||
		!rows.some(([name]) => name === 'dist-electron/main.cjs')) throw new Error('Build output is incomplete.');
	return rows;
}
function same(value, expected, message) {
	if (JSON.stringify(value) !== JSON.stringify(expected)) throw new Error(message);
}
function signatureMetadata(bundle) {
	const raw = run('/usr/bin/codesign', ['-dvv', '--entitlements', ':-', bundle], true);
	const xml = raw.match(/<\?xml[\s\S]*?<\/plist>/)?.[0];
	if (/invalid entitlements|not bound|Authority=\(unavailable\)/.test(raw))
		throw new Error('Signing metadata is incomplete. Run outside the sandbox with normal keychain access.');
	return {
		identifier: raw.match(/^Identifier=(.+)$/m)?.[1],
		team: raw.match(/^TeamIdentifier=(.+)$/m)?.[1],
		flags: raw.match(/flags=(\S+)/)?.[1],
		runtime: raw.match(/^Runtime Version=(.+)$/m)?.[1],
		entitlements: xml ? plist.parse(xml) : null,
		requirements: run('/usr/bin/codesign', ['-d', '-r-', bundle], true).split('\n').filter(line => line.startsWith('designated =>')).join('\n'),
	};
}

const sourceArchive = path.join(sourceApp, 'Contents/Resources/app.asar');
const sourceArchiveHash = await fileHash(sourceArchive);
const oldEntries = archiveEntries(sourceArchive);
const packageBefore = JSON.parse(asar.extractFile(sourceArchive, 'package.json'));
const packageNow = JSON.parse(await fs.readFile(path.join(project, 'package.json'), 'utf8'));
same(packageBefore.dependencies, packageNow.dependencies, 'Dependencies changed; use the full packager.');
if (packageBefore.version !== packageNow.version || packageBefore.main !== packageNow.main)
	throw new Error('Package entry/version changed; use the full packager.');
const frozenBuild = await buildManifest();
for (const [name] of frozenBuild)
	if (name.startsWith('dist-electron/') && !oldEntries.has(name))
		throw new Error(`New Electron entry requires the full packager: ${name}`);

run('/usr/bin/codesign', ['--verify', '--deep', '--strict', sourceApp]);
await fs.mkdir(path.dirname(outputApp), { recursive: true });
const realOutputParent = await fs.realpath(path.dirname(outputApp));
if (!beneath(release, realOutputParent)) throw new Error('Output parent resolves outside release.');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'freelm-js-repack-'));
const extracted = path.join(temporary, 'app');
try {
	console.log('Copying the signed candidate; original and installed app are untouched.');
	run('/usr/bin/ditto', [sourceApp, outputApp]);
	asar.extractAll(sourceArchive, extracted);
	// extractAll does not preserve executable modes on unpacked entries; restore exact source modes.
	for (const [relative, entry] of oldEntries)
		if (entry.unpacked && !entry.files)
			await fs.chmod(path.join(extracted, relative), (await fs.stat(`${sourceArchive}.unpacked/${relative}`)).mode);
	for (const folder of ['dist', 'dist-electron']) {
		await fs.rm(path.join(extracted, folder), { recursive: true });
		await fs.cp(path.join(project, folder), path.join(extracted, folder), { recursive: true });
	}
	same(await buildManifest(), frozenBuild, 'Build outputs changed during staging. Stop and rebuild a fresh candidate.');
	const newArchive = path.join(temporary, 'app.asar');
	const streams = (await diskEntries(extracted)).map(({ relative, stat }) => ({
		path: relative, type: stat.isDirectory() ? 'directory' : 'file',
		unpacked: oldEntries.get(relative)?.unpacked === true,
		stat, streamGenerator: () => createReadStream(path.join(extracted, relative)),
	}));
	await asar.createPackageFromStreams(newArchive, streams);
	const newEntries = archiveEntries(newArchive);
	for (const [relative, entry] of oldEntries) {
		if (compiled(relative)) continue;
		const updated = newEntries.get(relative);
		if (!updated || !!entry.files !== !!updated.files || !!entry.unpacked !== !!updated.unpacked)
			throw new Error(`Dependency layout changed: ${relative}`);
		if (!entry.files) {
			const expected = entry.unpacked ? await fileHash(`${sourceArchive}.unpacked/${relative}`) : entry.integrity?.hash;
			if (!expected || updated.integrity?.hash !== expected) throw new Error(`Dependency bytes changed: ${relative}`);
		}
	}
	for (const relative of newEntries.keys())
		if (!compiled(relative) && !oldEntries.has(relative)) throw new Error(`Unexpected dependency added: ${relative}`);
	for (const [relative, expected] of frozenBuild)
		if (hash(asar.extractFile(newArchive, relative)) !== expected) throw new Error(`Compiled output mismatch: ${relative}`);
	const outputArchive = path.join(outputApp, 'Contents/Resources/app.asar');
	await fs.copyFile(newArchive, outputArchive);
	// Preserve every unchanged unpacked native file and its metadata from ditto.
	for (const [relative, entry] of newEntries)
		if (compiled(relative) && entry.unpacked && !entry.files)
			await fs.copyFile(`${newArchive}.unpacked/${relative}`, `${outputArchive}.unpacked/${relative}`);

	const integrity = { 'Resources/app.asar': { algorithm: 'SHA256', hash: hash(asar.getRawHeader(newArchive).headerString) } };
	const contents = path.join(outputApp, 'Contents');
	const integrityPlists = [];
	async function findPlists(directory) {
		for (const name of await fs.readdir(directory)) {
			const filename = path.join(directory, name), stat = await fs.lstat(filename);
			if (stat.isSymbolicLink()) continue;
			if (stat.isDirectory()) await findPlists(filename);
			else if (name === 'Info.plist') {
				const data = plist.parse(run('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', filename], true));
				if (data.ElectronAsarIntegrity) integrityPlists.push({ filename, data });
			}
		}
	}
	await findPlists(contents);
	if (integrityPlists.length !== 9) throw new Error('Unexpected integrity-plist layout; use the full packager.');
	const signingBundles = [...new Set(integrityPlists.map(({ filename }) => {
		const relative = path.relative(contents, filename);
		if (relative === 'Info.plist') return outputApp;
		const match = relative.match(/^(Frameworks\/[^/]+\.(?:app|framework))\//);
		if (!match) throw new Error(`Unexpected nested integrity location: ${relative}`);
		return path.join(contents, match[1]);
	}))].sort((left, right) => right.split(path.sep).length - left.split(path.sep).length);
	if (signingBundles.length !== 9 || signingBundles.at(-1) !== outputApp) throw new Error('Unexpected signing order.');
	const signatures = new Map(signingBundles.map(bundle => [bundle, signatureMetadata(bundle)]));
	for (const { filename, data } of integrityPlists)
		await fs.writeFile(filename, plist.build({ ...data, ElectronAsarIntegrity: integrity }));
	for (const bundle of signingBundles) {
		console.log(`Resealing ${path.relative(outputApp, bundle) || 'FreeLM.app'}`);
		run('/usr/bin/codesign', [
			'--force', '--sign', options['--identity'], '--timestamp',
			'--preserve-metadata=identifier,entitlements,requirements,flags,runtime,launch-constraints,library-constraints',
			bundle,
		]);
		same(signatureMetadata(bundle), signatures.get(bundle), `Signing metadata changed: ${bundle}`);
	}
	run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', outputApp]);
	same(await buildManifest(), frozenBuild, 'Build outputs changed during signing; do not install this candidate.');
	if (await fileHash(sourceArchive) !== sourceArchiveHash) throw new Error('Source archive changed unexpectedly.');
	console.log(JSON.stringify({ outputApp, compiledFiles: frozenBuild.length, integrityPlists: integrityPlists.length, resealedBundles: signingBundles.length, integrity, verified: true }, null, 2));
} finally {
	await fs.rm(temporary, { recursive: true, force: true });
}
