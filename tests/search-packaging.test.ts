import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readFile,
	readlink,
	readdir,
	rm,
	stat,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const hook = await import(pathToFileURL(path.resolve('scripts/package-search-resources.mjs')).href);
const temporary: string[] = [];
afterEach(async () => {
	for (const directory of temporary.splice(0))
		await rm(directory, { recursive: true, force: true });
});

async function fixture() {
	const directory = await mkdtemp(path.join(tmpdir(), 'freelm-search-packaging-'));
	temporary.push(directory);
	const project = path.join(directory, 'project');
	const source = path.join(project, 'resources/search');
	const output = path.join(directory, 'output-without-architecture-in-name');
	const resources = path.join(output, 'AnyName.app/Contents/Resources');
	const put = async (filename: string, bytes: string | Buffer) => {
		const absolute = path.join(source, filename);
		await mkdir(path.dirname(absolute), { recursive: true });
		await writeFile(absolute, bytes);
	};
	const manifest = {
		schema: 1,
		searxng: { revision: '3'.repeat(40), version: 'test-version' },
		python: {
			version: '3.12.14',
			notices: [
				{
					filename: 'LICENSE.cpython.txt',
					sha256: createHash('sha256').update('notice').digest('hex'),
				},
			],
		},
	};
	const manifestBytes = JSON.stringify(manifest);
	const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
	await put('manifest.json', manifestBytes);
	await put(
		'engines.json',
		JSON.stringify({ version: manifest.searxng.version, engines: [{ name: 'bing' }] }),
	);
	for (const filename of [
		'launcher.py',
		'requirements.lock',
		'NOTICE.md',
		'source/LICENSE',
		'source/searx/webapp.py',
		'source/searx/settings.yml',
		'source/searx/version_frozen.py',
		'source/docs/example.md',
	])
		await put(filename, 'payload: ' + filename);
	await put('source/.freelm-revision', manifest.searxng.revision);
	await put('licenses/python-standalone/LICENSE.cpython.txt', 'notice');
	for (const target of [
		'darwin-arm64',
		'darwin-x64',
		'linux-arm64',
		'darwin-arm64.staging-leftover',
	]) {
		await put(`runtime/${target}/python/bin/python3.12`, 'interpreter: ' + target);
		await chmod(path.join(source, `runtime/${target}/python/bin/python3.12`), 0o755);
		await symlink('python3.12', path.join(source, `runtime/${target}/python/bin/python3`));
		await put(`runtime/${target}/python/lib/python3.12/LICENSE.txt`, 'Python license');
		for (const filename of [
			'waitress/__init__.py',
			'flask/__init__.py',
			'curl_cffi/__init__.py',
			'yaml/__init__.py',
			'certifi/cacert.pem',
		])
			await put(`runtime/${target}/site-packages/${filename}`, 'dependency');
		await put(
			`runtime/${target}/bundle.json`,
			JSON.stringify({
				schema: 1,
				preparationVersion: 1,
				target,
				manifestSha256,
				python: 'python/bin/python3',
				pythonVersion: manifest.python.version,
				searxngVersion: manifest.searxng.version,
			}),
		);
	}
	const context = (arch: number, requested = [arch]) => ({
		arch,
		appOutDir: output,
		electronPlatformName: 'darwin',
		packager: {
			projectDir: project,
			info: {
				options: {
					targets: new Map([
						[
							{ nodeName: 'darwin', buildConfigurationKey: 'mac' },
							new Map(requested.map((value) => [value, ['dir']])),
						],
					]),
				},
			},
			getResourcesDir: () => resources,
		},
	});
	return { source, resources, destination: path.join(resources, 'search'), context, put };
}

describe('Search resources staged after universal merging and before signing', () => {
	it('excludes only declared source, license, and Babel data paths from individual signing while retaining those bytes in the app resource tree', async () => {
		const config = JSON.parse(await readFile(path.resolve('package.json'), 'utf8'));
		const declared = config.build.mac.signIgnore as string[];
		expect(Array.isArray(declared)).toBe(true);
		expect(declared.length).toBeGreaterThan(0);
		const patterns = declared.map((value) => new RegExp(value));
		const ignored = (filename: string) =>
			patterns.some((pattern) =>
				pattern.test('/Example.app/Contents/Resources/search/' + filename),
			);
		const data = {
			'source/searx/translations/en/LC_MESSAGES/messages.mo': Buffer.from([
				0xde, 0x12, 0x04, 0x95, 1, 2, 3,
			]),
			'source/searx/static/reference.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]),
			'runtime/darwin-arm64/site-packages/babel/locale-data/en.dat': Buffer.from([
				0x80, 0x04, 0x95, 1, 2, 3,
			]),
		};
		const value = await fixture();
		for (const [filename, bytes] of Object.entries(data)) {
			expect(ignored(filename), filename).toBe(true);
			await value.put(filename, bytes);
		}
		expect(ignored('licenses/python-standalone/LICENSE.cpython.txt')).toBe(true);
		for (const architecture of ['arm64', 'x64']) {
			for (const filename of [
				'python/bin/python3.12',
				'python/lib/libpython3.12.dylib',
				'python/lib/python3.12/lib-dynload/_ssl.cpython-312-darwin.so',
				'site-packages/curl_cffi/_wrapper.abi3.so',
				'site-packages/lxml/etree.cpython-312-darwin.so',
				'site-packages/babel/locale-data/accidental.dylib',
			])
				expect(ignored(`runtime/darwin-${architecture}/${filename}`), filename).toBe(false);
		}
		for (const filename of [
			'launcher.py',
			'source-backup/program.dylib',
			'runtime/darwin-arm64/site-packages/babel/locale-data/en.dat.so',
		])
			expect(ignored(filename), filename).toBe(false);
		await hook.afterPack(value.context(4));
		for (const [filename, bytes] of Object.entries(data))
			expect(await readFile(path.join(value.destination, filename))).toEqual(bytes);
		if (process.platform === 'darwin') {
			// Verify the real prepared payload as well as representative path vectors.
			// Mach-O detection reads four bytes, independent of names/extensions.
			const actualRoot = path.resolve('resources/search');
			const files: string[] = [];
			const collect = async (directory: string): Promise<void> => {
				for (const entry of await readdir(directory, { withFileTypes: true })) {
					const filename = path.join(directory, entry.name);
					if (entry.isDirectory()) await collect(filename);
					else if (entry.isFile()) files.push(filename);
				}
			};
			await collect(actualRoot);
			let nativeFiles = 0;
			const magic = new Set([
				'feedface',
				'feedfacf',
				'cefaedfe',
				'cffaedfe',
				'cafebabe',
				'bebafeca',
				'cafebabf',
				'bfbafeca',
			]);
			for (let offset = 0; offset < files.length; offset += 32) {
				await Promise.all(
					files.slice(offset, offset + 32).map(async (filename) => {
						const handle = await open(filename, 'r');
						try {
							const bytes = Buffer.alloc(4);
							const { bytesRead } = await handle.read(bytes, 0, 4, 0);
							if (bytesRead === 4 && magic.has(bytes.toString('hex'))) {
								nativeFiles++;
								const relative = path.relative(actualRoot, filename).split(path.sep).join('/');
								expect(ignored(relative), relative).toBe(false);
							}
						} finally {
							await handle.close();
						}
					}),
				);
			}
			expect(nativeFiles).toBeGreaterThanOrEqual(2); // Both prepared Python interpreters.
		}
		// signIgnore affects child codesign calls only. These files remain inside
		// the enclosing application's resource tree for its normal resource seal.
	});
	it('skips both thin inputs based on the normalized target map, without reading or copying the source', async () => {
		const value = await fixture();
		await rm(value.source, { recursive: true });
		for (const arch of [1, 3]) {
			expect(hook.searchPackagingTargets(value.context(arch, [4]))).toEqual([]);
			await hook.afterPack(value.context(arch, [4]));
		}
		await expect(stat(value.resources)).rejects.toMatchObject({ code: 'ENOENT' });
	});
	it('copies full common source and notices plus both native runtimes once, retaining relative executable symlinks and modes', async () => {
		const value = await fixture();
		await hook.afterPack(value.context(4));
		for (const target of ['darwin-arm64', 'darwin-x64']) {
			const executable = path.join(value.destination, 'runtime', target, 'python/bin/python3');
			expect((await lstat(executable)).isSymbolicLink()).toBe(true);
			expect(await readlink(executable)).toBe('python3.12');
			expect((await stat(executable)).mode & 0o777).toBe(0o755);
		}
		for (const filename of [
			'source/.freelm-revision',
			'source/docs/example.md',
			'source/LICENSE',
			'licenses/python-standalone/LICENSE.cpython.txt',
			'manifest.json',
			'NOTICE.md',
		])
			expect(await readFile(path.join(value.destination, filename))).toEqual(
				await readFile(path.join(value.source, filename)),
			);
		for (const target of ['linux-arm64', 'darwin-arm64.staging-leftover'])
			await expect(stat(path.join(value.destination, 'runtime', target))).rejects.toMatchObject({
				code: 'ENOENT',
			});
		const first = await stat(path.join(value.destination, 'packaged.json'));
		await hook.afterPack(value.context(4));
		expect((await stat(path.join(value.destination, 'packaged.json'))).mtimeMs).toBe(first.mtimeMs);
	});

	for (const [arch, target, other] of [
		[1, 'darwin-x64', 'darwin-arm64'],
		[3, 'darwin-arm64', 'darwin-x64'],
	] as const) {
		it(`includes only ${target} for a standalone build`, async () => {
			const value = await fixture();
			await hook.afterPack(value.context(arch));
			expect(
				await readFile(
					path.join(value.destination, 'runtime', target, 'python/bin/python3'),
					'utf8',
				),
			).toContain(target);
			await expect(stat(path.join(value.destination, 'runtime', other))).rejects.toMatchObject({
				code: 'ENOENT',
			});
		});
	}

	it('recognizes raw API/configuration universal targets, ignores other platforms, and rejects ambiguous mixed target invocations', async () => {
		const value = await fixture();
		for (const target of ['dir:universal', { target: 'dir', arch: 'universal' }]) {
			const context = {
				arch: 1,
				electronPlatformName: 'darwin',
				packager: { info: { options: { mac: [target] } } },
			};
			expect(hook.searchPackagingTargets(context)).toEqual([]);
		}
		expect(
			hook.searchPackagingTargets({ ...value.context(1, [4]), electronPlatformName: 'linux' }),
		).toEqual([]);
		expect(() => hook.searchPackagingTargets(value.context(1, [1, 4]))).toThrow(
			'separate invocations',
		);
	});
	it('fails before output mutation when a runtime stamp is stale or a required helper dependency is missing', async () => {
		for (const missing of [
			'runtime/darwin-arm64/bundle.json',
			'runtime/darwin-arm64/site-packages/waitress/__init__.py',
			'source/LICENSE',
			'NOTICE.md',
		]) {
			const value = await fixture();
			await rm(path.join(value.source, missing));
			await expect(hook.afterPack(value.context(4))).rejects.toThrow('Missing bundled search');
			await expect(stat(value.resources)).rejects.toMatchObject({ code: 'ENOENT' });
		}
		const value = await fixture();
		const stampPath = path.join(value.source, 'runtime/darwin-arm64/bundle.json');
		const stamp = JSON.parse(await readFile(stampPath, 'utf8'));
		stamp.manifestSha256 = '0'.repeat(64);
		await writeFile(stampPath, JSON.stringify(stamp));
		await expect(hook.afterPack(value.context(4))).rejects.toThrow('stale preparation stamp');
		await expect(stat(value.resources)).rejects.toMatchObject({ code: 'ENOENT' });
	});
	it('rejects damaged license notices and resources resolving outside the bundle', async () => {
		const value = await fixture();
		await value.put('licenses/python-standalone/LICENSE.cpython.txt', 'damaged notice');
		await expect(hook.afterPack(value.context(4))).rejects.toThrow('notice integrity');
		const outside = await fixture();
		const executable = path.join(outside.source, 'runtime/darwin-arm64/python/bin/python3');
		await rm(executable);
		await symlink(process.execPath, executable);
		await expect(hook.afterPack(outside.context(4))).rejects.toThrow('outside its trusted');
	});
	it('refuses duplicate extraResources without overwriting the existing package', async () => {
		const value = await fixture();
		await mkdir(value.destination, { recursive: true });
		const sentinel = path.join(value.destination, 'original');
		await writeFile(sentinel, 'keep');
		await expect(hook.afterPack(value.context(4))).rejects.toThrow(
			'Remove search from mac.extraResources',
		);
		expect(await readFile(sentinel, 'utf8')).toBe('keep');
	});
});
