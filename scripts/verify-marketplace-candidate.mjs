import { extractFile } from '@electron/asar';
import { readFile, writeFile, readdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';

const app = path.resolve(
  process.argv[2] || 'release/marketplace-local-20261102/mac-arm64/FreeLM.app',
);
const output = path.resolve(
  process.argv[3] || 'release/marketplace-local-20261102/verification.json',
);
const resources = path.join(app, 'Contents/Resources');
execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' });
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(filename)));
    else if (entry.isFile()) result.push(filename);
  }
  return result;
}
const compiled = [];
for (const filename of [...(await files('dist')), ...(await files('dist-electron'))]) {
  const expected = sha(await readFile(filename));
  const actual = sha(extractFile(path.join(resources, 'app.asar'), filename));
  if (expected !== actual) throw new Error(`Packaged content mismatch: ${filename}`);
  compiled.push({ file: filename, sha256: actual });
}
const unpacked = await realpath(path.join(resources, 'app.asar.unpacked'));
const workerRequire = createRequire(path.join(unpacked, 'dist-electron/plugin-runtime-worker.cjs'));
const dependencies = [];
for (const dependency of [
  'quickjs-emscripten',
  'quickjs-emscripten-core',
  'esbuild-wasm/lib/browser.js',
  'esbuild-wasm/esbuild.wasm',
]) {
  const resolved = await realpath(workerRequire.resolve(dependency));
  if (!resolved.startsWith(unpacked + path.sep))
    throw new Error(`Dependency resolves outside bundle: ${dependency}`);
  dependencies.push({ dependency, path: path.relative(resources, resolved) });
}
const source = [];
for (const filename of [
  'electron/plugins/archive.ts',
  'electron/plugins/packages.ts',
  'src/components/Marketplace.tsx',
  'src/components/marketplace.css',
  'src/components/PluginBrowser.tsx',
  'src/components/PluginSettings.tsx',
  'src/components/WorkflowsFeature.tsx',
  'src/lib/marketplace-client.ts',
  'tests/marketplace-client.test.ts',
]) {
  source.push({ file: filename, sha256: sha(await readFile(filename)) });
}
const evidence = {
  verifiedAt: new Date().toISOString(),
  app,
  architecture: execFileSync('lipo', ['-archs', path.join(app, 'Contents/MacOS/FreeLM')], {
    encoding: 'utf8',
  }).trim(),
  signatureVerified: true,
  signatureDetails: spawnSync('codesign', ['-dvv', app], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).stderr,
  compiled,
  dependencies,
  source,
  baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  dirtyCheckout: true,
  productionMarketplaceTrust: false,
  scope: 'Content/signature verification only; UI and test evidence are recorded separately.',
};
await writeFile(output, JSON.stringify(evidence, null, 2) + '\n');
console.log(
  JSON.stringify({
    app,
    output,
    signatureVerified: true,
    compiledFiles: compiled.length,
    packagedDependencies: dependencies.length,
    architecture: evidence.architecture,
  }),
);
