import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const children = new Set();
let stopping = false;
function stop(code = 0) {
	if (stopping) return;
	stopping = true;
	for (const child of children) child.kill('SIGTERM');
	process.exitCode = code;
}
function start(command, args, options = {}) {
	const child = spawn(command, args, { stdio: 'inherit', ...options });
	children.add(child);
	child.on('error', (error) => {
		console.error(error.message);
		stop(1);
	});
	child.on('exit', (code) => {
		children.delete(child);
		stop(code ?? 0);
	});
	return child;
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

// Build before starting the two long-running processes.
await import('./build-electron.mjs');
const vite = start(
	process.execPath,
	[
		path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js'),
		'--host',
		'127.0.0.1',
		'--port',
		'5173',
		'--strictPort',
	],
	{ stdio: ['inherit', 'pipe', 'pipe'] },
);
let viteOutput = '';
let viteListening = false;
vite.stdout.on('data', (chunk) => {
	process.stdout.write(chunk);
	viteOutput = (viteOutput + chunk.toString()).slice(-16_000);
	viteListening = /Local:.*http:\/\/127\.0\.0\.1:5173/.test(
		viteOutput.replace(/\u001b\[[0-9;]*m/g, ''),
	);
});
vite.stderr.on('data', (chunk) => process.stderr.write(chunk));
let ready = false;
for (let attempt = 0; attempt < 100 && !stopping; attempt++) {
	try {
		if (viteListening) {
			const response = await fetch('http://127.0.0.1:5173', { signal: AbortSignal.timeout(500) });
			if (response.ok) {
				ready = true;
				break;
			}
		}
	} catch {
		/* Vite is starting. */
	}
	await delay(100);
}
if (!ready) {
	console.error('The development server did not become ready on port 5173.');
	stop(1);
} else if (!stopping) {
	const env = { ...process.env, FREELM_DEV_URL: 'http://127.0.0.1:5173' };
	delete env.ELECTRON_RUN_AS_NODE;
	start(require('electron'), ['.'], { env });
}
