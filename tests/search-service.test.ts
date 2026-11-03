import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { SearchServiceManager } from '../electron/search-service';

const folders: string[] = [];
const managers: SearchServiceManager[] = [];
const servers: Server[] = [];

afterEach(async () => {
	await Promise.all(managers.splice(0).map((manager) => manager.close()));
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.closeAllConnections();
					server.close(() => resolve());
				}),
		),
	);
	await Promise.all(
		folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
	);
});

const catalogue = {
	version: 'test-native-search',
	engines: [
		{
			name: 'bing',
			enabled: true,
			categories: ['general'],
			paging: false,
			time_range_support: false,
			safesearch: true,
		},
		{
			name: 'google images',
			enabled: true,
			categories: ['images'],
			paging: true,
			time_range_support: true,
			safesearch: true,
		},
	],
};

type FakeOptions = {
	delay?: number;
	neverReady?: boolean;
	healthHtml?: boolean;
	badConfig?: boolean;
	crashAfter?: number;
	ignoreTerm?: boolean;
	logs?: boolean;
	logFlood?: boolean;
};

async function fixture(
	fake: FakeOptions = {},
	options: { startupTimeoutMs?: number; allocatePort?: () => Promise<number>; recoveryDelaysMs?: number[] } = {},
) {
	const folder = await mkdtemp(path.join(os.tmpdir(), 'freelm-search-manager-'));
	folders.push(folder);
	const runtime = path.join(folder, 'python3');
	const launcher = path.join(folder, 'launcher.cjs');
	const configFile = path.join(folder, 'fake.json');
	await writeFile(configFile, JSON.stringify(fake));
	await writeFile(path.join(folder, 'engines.json'), JSON.stringify(catalogue));
	const quotedNode = `'${process.execPath.replaceAll("'", "'\\''")}'`;
	await writeFile(runtime, `#!/bin/sh\nexec ${quotedNode} ${JSON.stringify(launcher)} "$@"\n`);
	await chmod(runtime, 0o700);
	await writeFile(
		launcher,
		`
const http = require('node:http');
const fs = require('node:fs');
const args = process.argv.slice(2);
const value = name => args[args.indexOf(name) + 1];
const home = value('--config-dir');
const fake = JSON.parse(fs.readFileSync(${JSON.stringify(configFile)}, 'utf8'));
const selected = JSON.parse(value('--engines-json'));
fs.writeFileSync(home + '/child.json', JSON.stringify({ pid:process.pid, argv:args,
  providerSecret: process.env.OPENAI_API_KEY, pythonPath:process.env.PYTHONPATH,
  parent:process.env.FREELM_SEARCH_PARENT_PID }));
if (fake.ignoreTerm) process.on('SIGTERM', () => {});
if (fake.neverReady) setInterval(() => {}, 500);
else setTimeout(() => {
 const server = http.createServer((req,res) => {
  if (req.url === '/synthetic-query') { fs.appendFileSync(home + '/queries', 'x'); return; }
  if (req.url === '/healthz') {
   res.setHeader('Content-Type', fake.healthHtml ? 'text/html' : 'text/plain');
   res.setHeader('X-FreeLM-Search-Instance', process.env.FREELM_SEARCH_INSTANCE_ID);
   return res.end('OK');
  }
  res.setHeader('Content-Type','application/json');
  res.end(fake.badConfig ? '{bad' : JSON.stringify({version:'fixture-v1',
   engines:${JSON.stringify(catalogue.engines)}.filter(engine => selected.includes(engine.name))}));
 });
 server.on('error', e => { console.error(e.message); process.exit(1); });
 server.listen(Number(value('--port')), '127.0.0.1');
}, fake.delay || 0);
if (fake.logs) {
 console.error('Authorization: Bearer secret-header-value');
 console.log('api_key=secret-key-value http://user:password@host/path?q=privatequery');
}
if (fake.logFlood) console.log('x'.repeat(200000));
if (fake.crashAfter) setTimeout(() => process.exit(7), fake.crashAfter);
`,
	);
	const manager = new SearchServiceManager({
		bundleRoot: folder,
		executablePath: runtime,
		launcherPath: launcher,
		searchHome: path.join(folder, 'profile-search'),
		startupTimeoutMs: options.startupTimeoutMs ?? 2500,
		pollIntervalMs: 25,
		stopTimeoutMs: 75,
		...(options.allocatePort ? { allocatePort: options.allocatePort } : {}),
		recoveryDelaysMs: options.recoveryDelaysMs ?? [100, 150],
	});
	managers.push(manager);
	await manager.ready;
	return { folder, manager, runtime, launcher, searchHome: path.join(folder, 'profile-search') };
}

async function waitFor(condition: () => boolean | Promise<boolean>, deadline = 3000) {
	const end = Date.now() + deadline;
	while (!(await condition())) {
		if (Date.now() > end) throw new Error('Fixture condition did not become true.');
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe('bundled search lifecycle', () => {
	it('loads its offline catalogue and starts only the trusted runtime on a loopback ephemeral port', async () => {
		const { manager, searchHome } = await fixture();
		expect(manager.status().phase).toBe('stopped');
		expect(manager.status().engines.map((engine) => engine.name)).toEqual([
			'bing',
			'google images',
		]);
		const phases: string[] = [];
		const unsubscribe = manager.onStatus((status) => phases.push(status.phase));
		const status = await manager.start(['bing']);
		expect(status.phase).toBe('running');
		expect(status.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		expect(status.version).toBe('fixture-v1');
		expect(status.engines.find((engine) => engine.name === 'google images')?.enabled).toBe(false);
		const child = JSON.parse(await readFile(path.join(searchHome, 'child.json'), 'utf8'));
		expect(child.argv.slice(0, 2)).toEqual(['-I', '-B']);
		expect(child.parent).toBe(String(process.pid));
		const firstPid = child.pid;
		await manager.start(['bing']);
		expect(JSON.parse(await readFile(path.join(searchHome, 'child.json'), 'utf8')).pid).toBe(
			firstPid,
		);
		const url = status.url!;
		await manager.stop();
		expect(manager.status().phase).toBe('stopped');
		await expect(fetch(`${url}/healthz`)).rejects.toThrow();
		expect(phases).toContain('starting');
		expect(phases).toContain('running');
		expect(phases).toContain('stopping');
		expect(phases.at(-1)).toBe('stopped');
		unsubscribe();
	});

	it('never forwards inherited API keys or Python paths into the helper', async () => {
		const { manager, searchHome } = await fixture();
		const previousKey = process.env.OPENAI_API_KEY;
		const previousPythonPath = process.env.PYTHONPATH;
		process.env.OPENAI_API_KEY = 'never-inherit-this-provider-credential';
		process.env.PYTHONPATH = '/untrusted/python-modules';
		try {
			expect((await manager.start(['bing'])).phase).toBe('running');
		} finally {
			if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = previousKey;
			if (previousPythonPath === undefined) delete process.env.PYTHONPATH;
			else process.env.PYTHONPATH = previousPythonPath;
		}
		const child = JSON.parse(await readFile(path.join(searchHome, 'child.json'), 'utf8'));
		expect(child.providerSecret).toBeUndefined();
		expect(child.pythonPath).toBeUndefined();
	});

	it('rejects empty and unknown engine selections without launching a process', async () => {
		const { manager, searchHome } = await fixture();
		await expect(manager.start([])).rejects.toThrow('Select between');
		await expect(manager.start(['arbitrary engine'])).rejects.toThrow('unavailable');
		await expect(stat(path.join(searchHome, 'child.json'))).rejects.toMatchObject({
			code: 'ENOENT',
		});
	});

	it('stop cancels an in-flight startup and a subsequent start works', async () => {
		const { manager } = await fixture({ delay: 350 });
		const starting = manager.start(['bing']);
		await waitFor(() => manager.status().phase === 'starting');
		await manager.stop();
		expect((await starting).phase).toBe('stopped');
		expect(manager.status().phase).toBe('stopped');
		expect((await manager.start(['bing'])).phase).toBe('running');
	});

	it('restart applies the new engine selection and stops the previous process', async () => {
		const { manager, searchHome } = await fixture();
		const before = await manager.start(['bing']);
		const pid = JSON.parse(await readFile(path.join(searchHome, 'child.json'), 'utf8')).pid;
		const after = await manager.restart(['google images']);
		expect(after.phase).toBe('running');
		expect(after.selectedEngineNames).toEqual(['google images']);
		expect(after.url).not.toBe(before.url);
		expect(() => process.kill(pid, 0)).toThrow();
	});

	it.each([{ neverReady: true }, { healthHtml: true }, { badConfig: true }])(
		'enforces both health and discovery readiness with a bounded startup deadline (%j)',
		async (fake) => {
			const { manager } = await fixture(fake, { startupTimeoutMs: 250 });
			const started = Date.now();
			const result = await manager.start(['bing']);
			expect(result.phase).toBe('error');
			expect(result.message).toContain('startup deadline');
			expect(result.url).toBeUndefined();
			expect(Date.now() - started).toBeLessThan(1700);
		},
	);

	it('does not accept another server that wins the selected port', async () => {
		const occupied = createServer((request, response) => {
			response.setHeader(
				'Content-Type',
				request.url === '/healthz' ? 'text/plain' : 'application/json',
			);
			response.end(request.url === '/healthz' ? 'OK' : JSON.stringify(catalogue));
		});
		servers.push(occupied);
		await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
		const port = (occupied.address() as { port: number }).port;
		const { manager } = await fixture({}, { allocatePort: async () => port });
		const status = await manager.start(['bing']);
		expect(status.phase).toBe('error');
		expect(status.message).toContain('Another process occupied');
	});

	it('restarts an unexpectedly exited helper without replaying an interrupted query', async () => {
		const { manager, searchHome, folder } = await fixture({ crashAfter: 300 });
		const status = await manager.start(['bing']);
		expect(status.phase).toBe('running');
		const pid = JSON.parse(await readFile(path.join(searchHome, 'child.json'), 'utf8')).pid;
		const query = fetch(`${status.url}/synthetic-query`).then(() => false, () => true);
		await waitFor(() => manager.status().phase === 'error');
		expect(await query).toBe(true);
		await writeFile(path.join(folder, 'fake.json'), '{}');
		await waitFor(() => manager.status().phase === 'running');
		expect(JSON.parse(await readFile(path.join(searchHome, 'child.json'), 'utf8')).pid).not.toBe(pid);
		expect(await readFile(path.join(searchHome, 'queries'), 'utf8')).toBe('x');
	});

	it('cuts off repeated helper crashes and cancels a pending restart on Stop', async () => {
		const { manager, searchHome } = await fixture({ crashAfter: 300 });
		await manager.start(['bing']);
		await waitFor(() => !!manager.status().message?.includes('Automatic recovery is paused'));
		const pid = JSON.parse(await readFile(path.join(searchHome, 'child.json'), 'utf8')).pid;
		await new Promise((r) => setTimeout(r, 250));
		expect(manager.status().phase).toBe('error');
		expect(JSON.parse(await readFile(path.join(searchHome, 'child.json'), 'utf8')).pid).toBe(pid);
		const other = await fixture({ crashAfter: 300 }, { recoveryDelaysMs: [250] });
		await other.manager.start(['bing']);
		await waitFor(() => other.manager.status().phase === 'error');
		const stoppedPid = JSON.parse(await readFile(path.join(other.searchHome, 'child.json'), 'utf8')).pid;
		await other.manager.stop();
		await new Promise((r) => setTimeout(r, 350));
		expect(other.manager.status().phase).toBe('stopped');
		expect(JSON.parse(await readFile(path.join(other.searchHome, 'child.json'), 'utf8')).pid).toBe(stoppedPid);
	});

	it('escalates shutdown to SIGKILL for a helper that ignores SIGTERM', async () => {
		const { manager, searchHome } = await fixture({ ignoreTerm: true });
		expect((await manager.start(['bing'])).phase).toBe('running');
		const pid = JSON.parse(await readFile(path.join(searchHome, 'child.json'), 'utf8')).pid;
		await manager.close();
		expect(() => process.kill(pid, 0)).toThrow();
		await expect(manager.start(['bing'])).rejects.toThrow('shutting down');
	});

	it('a newer Stop prevents a restart from relaunching after its shutdown finishes', async () => {
		const { manager, searchHome } = await fixture({ ignoreTerm: true });
		const initial = await manager.start(['bing']);
		expect(initial.phase).toBe('running');
		const childBefore = await readFile(path.join(searchHome, 'child.json'), 'utf8');
		const restarting = manager.restart(['google images']);
		await waitFor(() => manager.status().phase === 'stopping');
		const stopped = manager.stop();
		await Promise.all([restarting, stopped]);
		expect(manager.status().phase).toBe('stopped');
		expect(await readFile(path.join(searchHome, 'child.json'), 'utf8')).toBe(childBefore);
		await expect(fetch(`${initial.url}/healthz`)).rejects.toThrow();
	});

	it('close aborts startup immediately and never leaves a helper behind', async () => {
		const { manager } = await fixture({ neverReady: true });
		const starting = manager.start(['bing']);
		await waitFor(() => manager.status().phase === 'starting');
		await manager.close();
		expect((await starting).phase).toBe('stopped');
		expect(manager.status().phase).toBe('stopped');
	});

	it('fails before spawn when persistent search storage is not writable', async () => {
		const { manager, searchHome } = await fixture();
		await writeFile(searchHome, 'not a directory');
		const status = await manager.start(['bing']);
		expect(status.phase).toBe('error');
		expect(status.message).toContain('configuration directory');
	});

	it('rejects interpreter symlinks that escape the trusted bundle', async () => {
		const { manager, runtime } = await fixture();
		await rm(runtime);
		await symlink(process.execPath, runtime);
		const status = await manager.start(['bing']);
		expect(status.phase).toBe('unavailable');
		expect(status.message).toContain('trusted FreeLM bundle');
	});

	it('keeps a missing runtime unavailable after a stop or status inspection', async () => {
		const { manager, runtime } = await fixture();
		await rm(runtime);
		expect((await manager.start(['bing'])).phase).toBe('unavailable');
		expect((await manager.stop()).phase).toBe('unavailable');
		expect((await manager.inspect()).phase).toBe('unavailable');
	});

	it('bounds and redacts persistent diagnostics and returns detached status snapshots', async () => {
		const { manager, searchHome } = await fixture({ logs: true });
		expect((await manager.start(['bing'])).phase).toBe('running');
		await manager.stop();
		const log = await readFile(path.join(searchHome, 'service.log'), 'utf8');
		expect(Buffer.byteLength(log)).toBeLessThanOrEqual(128 * 1024);
		expect(log).not.toMatch(/secret-header-value|secret-key-value|privatequery|user:password/);
		expect(log).toContain('[redacted]');
		expect(manager.status().logExcerpt!.length).toBeLessThanOrEqual(8192);
		expect((await stat(path.join(searchHome, 'service.log'))).mode & 0o777).toBe(0o600);
		const copy = manager.status();
		copy.engines[0].categories.push('malicious mutation');
		copy.selectedEngineNames.push('malicious mutation');
		expect(manager.status().engines[0].categories).not.toContain('malicious mutation');
		expect(manager.status().selectedEngineNames).not.toContain('malicious mutation');
	});

	it('keeps a large subprocess log and pre-existing log file within its storage budget', async () => {
		const { manager, searchHome } = await fixture({ logFlood: true });
		expect((await manager.start(['bing'])).phase).toBe('running');
		await manager.stop();
		expect((await stat(path.join(searchHome, 'service.log'))).size).toBeLessThanOrEqual(128 * 1024);
		await writeFile(path.join(searchHome, 'service.log'), 'older log line\n'.repeat(100000));
		expect((await manager.start(['bing'])).phase).toBe('running');
		await manager.stop();
		expect((await stat(path.join(searchHome, 'service.log'))).size).toBeLessThanOrEqual(128 * 1024);
	});
});
