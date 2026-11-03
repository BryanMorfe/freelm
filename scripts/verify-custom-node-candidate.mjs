import { extractFile } from '@electron/asar';
import { readFile, writeFile, readdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const candidate = path.resolve(process.argv[2] ?? 'release/custom-nodes-streaming-final-20261029');
const app = path.join(candidate, 'mac-arm64/FreeLM.app');
const resources = path.join(app, 'Contents/Resources');
execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' });
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function files(directory) {
  const all = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) all.push(...(await files(filename)));
    else if (entry.isFile()) all.push(filename);
  }
  return all;
}
const compiled = [];
for (const filename of [...(await files('dist')), ...(await files('dist-electron'))]) {
  const expected = sha(await readFile(filename));
  const actual = sha(extractFile(path.join(resources, 'app.asar'), filename));
  if (expected !== actual) throw new Error(`Packaged content mismatch: ${filename}`);
  compiled.push({ file: filename, sha256: actual });
}
const unpacked = await realpath(path.join(resources, 'app.asar.unpacked'));
const workerRequire = createRequire(
  path.join(unpacked, 'dist-electron/custom-node-runtime-worker.cjs'),
);
const dependencies = [];
for (const dependency of [
  'quickjs-emscripten',
  'quickjs-emscripten-core',
  'esbuild-wasm/lib/browser.js',
  'esbuild-wasm/esbuild.wasm',
]) {
  const resolved = await realpath(workerRequire.resolve(dependency));
  if (!resolved.startsWith(unpacked + path.sep))
    throw new Error(`Packaged dependency falls back outside bundle: ${dependency}`);
  dependencies.push({ dependency, path: path.relative(resources, resolved) });
}
const sourcePaths = [
  ...(await files('electron/custom-nodes')),
  ...(await files('packages/custom-node-sdk')),
  ...(await files('examples/custom-nodes')),
  'electron/main.ts',
  'electron/workflows/engine.ts',
  'src/workflow-types.ts',
  'src/custom-node-types.ts',
  'src/lib/workflow-catalog.ts',
  'src/components/WorkflowsFeature.tsx',
  'scripts/build-electron.mjs',
  'scripts/validate-custom-node.mjs',
  'scripts/verify-custom-node-candidate.mjs',
  'package.json',
  'docs/CUSTOM_NODE_SDK.md',
  ...(await files('tests')).filter((f) => /custom-node.*\.test\.ts$/.test(f)),
];
const source = [];
for (const filename of sourcePaths)
  source.push({ file: filename, sha256: sha(await readFile(filename)) });
const evidence = {
  verifiedAt: new Date().toISOString(),
  candidate,
  architecture: 'arm64',
  signing: 'ad-hoc',
  signatureVerified: true,
  compiled,
  dependencies,
  source,
  baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  dirtyCheckout: true,
  interactiveValidation: 'Pending: locked Mac; existing disposable GUI run preserved',
  ownerInstallationChanged: false,
};
await writeFile(
  path.join(candidate, 'verification.json'),
  JSON.stringify(evidence, null, 2) + '\n',
);
console.log(
  JSON.stringify({
    signatureVerified: true,
    compiledFiles: compiled.length,
    packagedDependencies: dependencies.length,
    sourceFiles: source.length,
    candidate,
  }),
);
