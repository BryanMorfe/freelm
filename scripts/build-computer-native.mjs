import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, access, rm } from 'node:fs/promises';
import path from 'node:path';

// The app-scoped ScreenCaptureKit screenshot API requires macOS 14. Other
// platforms package their adapter without this binary.
if (process.platform === 'darwin') {
	const root = path.resolve(import.meta.dirname, '..');
	const directory = path.join(root, 'resources/computer');
	const sources = ['computer-geometry.swift', 'computer-input.swift', 'computer-use.swift'].map(
		(name) => path.join(root, 'native', name),
	);
	const output = path.join(directory, 'freelm-computer');
	const digest = createHash('sha256')
		.update(Buffer.concat(await Promise.all(sources.map((source) => readFile(source)))))
		.update('universal-macos14-v1')
		.digest('hex');
	const stamp = path.join(directory, '.build-stamp');
	let current = false;
	try {
		current = (await readFile(stamp, 'utf8')) === digest;
		await access(output);
	} catch {
		current = false;
	}
	if (!current) {
		await mkdir(directory, { recursive: true });
		const cache = path.join(process.env.TMPDIR || '/tmp', 'freelm-computer-swift-cache');
		await mkdir(cache, { recursive: true });
		const run = (cmd, args) => {
			const result = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
			if (result.error) throw result.error;
			if (result.status !== 0) throw new Error(`${cmd} failed with ${result.status}`);
		};
		const objects = [];
		try {
			for (const arch of ['arm64', 'x86_64']) {
				const target = `${output}.${arch}`;
				objects.push(target);
				run('xcrun', [
					'swiftc',
					'-O',
					'-parse-as-library',
					'-target',
					`${arch}-apple-macos14.0`,
					'-module-cache-path',
					cache,
					...sources,
					'-o',
					target,
				]);
			}
			run('lipo', ['-create', ...objects, '-output', output]);
			run('codesign', [
				'--force',
				'--sign',
				'-',
				'--identifier',
				'app.freelm.desktop.computer',
				output,
			]);
			await writeFile(stamp, digest);
		} finally {
			await Promise.all(objects.map((file) => rm(file, { force: true })));
		}
	}
}
