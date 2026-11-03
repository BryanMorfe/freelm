import { readFile, readdir } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { pluginCatalog, pluginCatalogPackage } from '../src/lib/plugin-catalog';
import { validatePluginManifest } from '../src/lib/plugin-manifest';

const directories = ['notebook', 'follow-up', 'rewrite-selection', 'attachment-drawer'];
describe('included plugin example catalog', () => {
	it('uses the actual validated repository manifests without marketplace claims', async () => {
		const manifests = await Promise.all(
			directories.map(async (directory) =>
				validatePluginManifest(
					JSON.parse(await readFile(`examples/plugins/${directory}/manifest.json`, 'utf8')),
				),
			),
		);
		expect(pluginCatalog).toEqual(manifests);
		expect(new Set(pluginCatalog.map((plugin) => plugin.id)).size).toBe(4);
	});
	it.each(directories)(
		'packages the exact %s source for the existing ZIP inspector without executing it',
		async (directory) => {
			const manifest = validatePluginManifest(
				JSON.parse(await readFile(`examples/plugins/${directory}/manifest.json`, 'utf8')),
			);
			const files = unzipSync(await pluginCatalogPackage(manifest.id));
			expect(validatePluginManifest(JSON.parse(strFromU8(files['manifest.json'])))).toEqual(
				manifest,
			);
			for (const filename of await readdir(`examples/plugins/${directory}/src`))
				expect(strFromU8(files[`src/${filename}`])).toBe(
					await readFile(`examples/plugins/${directory}/src/${filename}`, 'utf8'),
				);
			expect(
				Object.keys(files).every((name) => !name.startsWith('/') && !name.includes('..')),
			).toBe(true);
		},
	);
	it('rejects unknown or traversal IDs before loading package source', async () => {
		await expect(pluginCatalogPackage('../notebook')).rejects.toThrow('not in the included');
		await expect(pluginCatalogPackage('unregistered.plugin')).rejects.toThrow(
			'not in the included',
		);
	});
});
