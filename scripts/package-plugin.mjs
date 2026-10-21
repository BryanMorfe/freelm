import { readdir, readFile, lstat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { zipSync } from 'fflate';
const [source, output] = process.argv.slice(2);
if (!source || !output) throw new Error('Usage: node scripts/package-plugin.mjs SOURCE_DIRECTORY OUTPUT.freelm-plugin');
const root = path.resolve(source);
const files = Object.create(null);
let total = 0;
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const filename = path.join(directory, entry.name);
    const stats = await lstat(filename);
    if (stats.isSymbolicLink()) throw new Error(`Symlinks are not supported: ${filename}`);
    if (entry.isDirectory()) await walk(filename);
    else if (entry.isFile()) {
      if (Object.keys(files).length >= 256 || stats.size > 2 * 1024 * 1024 || (total += stats.size) > 16 * 1024 * 1024)
        throw new Error('Package source exceeds its file count or size limit.');
      files[path.relative(root, filename).split(path.sep).join('/')] = new Uint8Array(await readFile(filename));
    }
  }
}
await walk(root);
if (!files['manifest.json']) throw new Error('Source must contain manifest.json at its root.');
const archive = zipSync(files, { level: 6 });
if (archive.length > 8 * 1024 * 1024) throw new Error('Archive exceeds 8 MiB.');
await writeFile(path.resolve(output), archive);
console.log(`Packaged ${Object.keys(files).length} files into ${path.resolve(output)} (${archive.length} bytes).`);
