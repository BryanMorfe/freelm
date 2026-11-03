import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
if (!process.argv[2])
  throw new Error('Usage: node scripts/validate-custom-node.mjs package.freelm-node');
const source = await readFile(process.argv[2], 'utf8');
if (Buffer.byteLength(source) > 1024 * 1024) throw new Error('Package exceeds 1 MiB.');
const pkg = JSON.parse(source);
const validator = await build({
  entryPoints: ['electron/custom-nodes/manifest.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { validateNodeManifest } = await import(
  'data:text/javascript;base64,' + Buffer.from(validator.outputFiles[0].text).toString('base64')
);
validateNodeManifest(pkg.manifest);
await build({
  stdin: { contents: pkg.source, loader: 'ts' },
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'neutral',
  plugins: [
    {
      name: 'sdk-only',
      setup(b) {
        b.onResolve({ filter: /.*/ }, (a) => {
          if (a.path !== '@freelm/custom-node-sdk')
            throw new Error('Only the custom node SDK may be imported.');
          return { path: process.cwd() + '/packages/custom-node-sdk/index.ts' };
        });
      },
    },
  ],
});
console.log(
  `Validated ${pkg.manifest.id}@${pkg.manifest.version}; source was compiled, never executed.`,
);
