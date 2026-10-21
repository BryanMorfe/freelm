import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const preparation = await import(
	pathToFileURL(path.resolve('scripts/prepare-search-runtime.mjs')).href
);
const root = path.resolve('resources/search');
const children: ChildProcess[] = [];
const directories: string[] = [];
afterEach(async () => {
	for (const child of children.splice(0)) {
		if (child.exitCode === null) {
			child.kill('SIGTERM');
			await new Promise<void>((resolve) => child.once('exit', () => resolve()));
		}
	}
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});

async function port() {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const value = server.address();
	if (!value || typeof value === 'string') throw new Error('No local port');
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
	return value.port;
}

describe('Pinned bundled search preparation', () => {
	it('rejects floating, unauthenticated, oversized, or unrelated download artifacts', () => {
		const artifact = {
			url: 'https://files.pythonhosted.org/packages/example.whl',
			sha256: 'a'.repeat(64),
			size: 100,
		};
		expect(() => preparation.validateArtifact(artifact)).not.toThrow();
		for (const patch of [
			{ url: 'http://files.pythonhosted.org/a' },
			{ url: 'https://files.pythonhosted.org.attacker.example/a' },
			{ url: 'https://user:secret@github.com/a' },
			{ sha256: 'latest' },
			{ size: 64 * 1024 * 1024 + 1 },
			{ size: 0 },
		])
			expect(() => preparation.validateArtifact({ ...artifact, ...patch })).toThrow();
	});
	it('supports both native desktop architectures without silently accepting another target', () => {
		expect(preparation.selectTargets([], 'linux', 'arm64')).toEqual(['linux-arm64']);
		expect(preparation.selectTargets(['--targets=darwin-arm64,darwin-x64,darwin-arm64'])).toEqual([
			'darwin-arm64',
			'darwin-x64',
		]);
		expect(() => preparation.selectTargets(['--targets=windows-x64'])).toThrow();
	});
	it('locks all dependency wheels separately for four native targets and retains upstream licensing', async () => {
		const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
		const catalog = JSON.parse(await readFile(path.join(root, 'engines.json'), 'utf8'));
		expect(manifest.searxng.revision).toMatch(/^[a-f0-9]{40}$/);
		expect(catalog.version).toBe(manifest.searxng.version);
		expect(Object.keys(manifest.targets).sort()).toEqual([
			'darwin-arm64',
			'darwin-x64',
			'linux-arm64',
			'linux-x64',
		]);
		for (const target of Object.values(manifest.targets) as {
			python: object;
			wheels: { name: string; version: string; filename: string }[];
		}[]) {
			preparation.validateArtifact(target.python);
			expect(new Set(target.wheels.map((wheel) => wheel.name)).size).toBe(31);
			for (const wheel of target.wheels) {
				preparation.validateArtifact(wheel);
				expect(wheel.version).toMatch(/^\d/);
				expect(wheel.filename).toMatch(/\.whl$/);
			}
		}
		expect(await readFile(path.join(root, 'NOTICE.md'), 'utf8')).toContain('AGPL-3.0-or-later');
	});

	for (const architecture of ['arm64', 'x64']) {
		it.skipIf(process.platform !== 'darwin')(
			`runs ${architecture} offline-installed helper with only selected engines and private persistent settings`,
			async () => {
				const executable = path.join(
					root,
					'runtime',
					`darwin-${architecture}`,
					'python/bin/python3',
				);
				const directory = await mkdtemp(path.join(tmpdir(), 'freelm-bundled-search-'));
				directories.push(directory);
				const selected = ['bing', 'bing images'];
				const servicePort = await port();
				let logs = '';
				const child = spawn(
					executable,
					[
						'-I',
						'-B',
						path.join(root, 'launcher.py'),
						'--config-dir',
						directory,
						'--port',
						String(servicePort),
						'--engines-json',
						JSON.stringify(selected),
					],
					{
						env: {
							PATH: '/usr/bin:/bin',
							FREELM_SEARCH_INSTANCE_ID: '0123456789abcdef',
							FREELM_SEARCH_PARENT_PID: String(process.pid),
						},
						stdio: ['ignore', 'pipe', 'pipe'],
					},
				);
				children.push(child);
				child.stdout?.on('data', (value: Buffer) => {
					logs += value.toString();
				});
				child.stderr?.on('data', (value: Buffer) => {
					logs += value.toString();
				});
				const endpoint = `http://127.0.0.1:${servicePort}`;
				let health: Response | undefined;
				for (let attempt = 0; attempt < 100; attempt++) {
					if (child.exitCode !== null) throw new Error(logs);
					try {
						health = await fetch(endpoint + '/healthz');
						if (health.ok) break;
					} catch {
						/* startup */
					}
					await new Promise((resolve) => setTimeout(resolve, 100));
				}
				expect(health?.status, logs).toBe(200);
				expect(await health?.text()).toBe('OK');
				expect(health?.headers.get('x-freelm-search-instance')).toBe('0123456789abcdef');
				const config = await (await fetch(endpoint + '/config')).json();
				expect(config.engines.map((engine: { name: string }) => engine.name).sort()).toEqual(
					selected.sort(),
				);
				expect(config.version).toBe('2026.9.23+3cd69d30e');
				const settings = JSON.parse(await readFile(path.join(directory, 'settings.yml'), 'utf8'));
				expect(settings.server.bind_address).toBe('127.0.0.1');
				expect(settings.server.limiter).toBe(false);
				expect(settings.valkey.url).toBe(false);
				expect(settings.search.formats).toContain('json');
				expect((await stat(path.join(directory, 'settings.yml'))).mode & 0o777).toBe(0o600);
				expect((await stat(path.join(directory, 'secret.key'))).mode & 0o777).toBe(0o600);
				expect(settings.use_default_settings.engines.keep_only.sort()).toEqual(selected);
				expect(logs).not.toContain('X-Forwarded-For nor X-Real-IP');
			},
			20_000,
		);
	}
});
