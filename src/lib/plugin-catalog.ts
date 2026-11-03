import type { PluginLocalManifest } from '../plugin-types';
import { validatePluginManifest } from './plugin-manifest';
import notebook from '../../examples/plugins/notebook/manifest.json';
import followUp from '../../examples/plugins/follow-up/manifest.json';
import selectedText from '../../examples/plugins/rewrite-selection/manifest.json';
import attachmentDrawer from '../../examples/plugins/attachment-drawer/manifest.json';

// This is the actual repository example collection, not a hosted marketplace.
// Source is loaded as text only; browsing never evaluates plugin code.
export const pluginCatalog = [notebook, followUp, selectedText, attachmentDrawer].map(
	(value) => validatePluginManifest(value) as PluginLocalManifest,
);
const sources = import.meta.glob('../../examples/plugins/**/*.{ts,json,css,html}', {
	query: '?raw',
	import: 'default',
});
const directories: Record<string, string> = {
	'dev.freelm.notebook': 'notebook',
	'dev.freelm.follow-up': 'follow-up',
	'dev.freelm.rewrite-selection': 'rewrite-selection',
	'dev.freelm.attachment-drawer': 'attachment-drawer',
};

/** Feed the included source through the same inspected ZIP review as a local file. */
export async function pluginCatalogPackage(id: string): Promise<Uint8Array> {
	const directory = directories[id];
	if (!directory || !pluginCatalog.some((entry) => entry.id === id))
		throw new Error('This plugin is not in the included example collection.');
	const prefix = `../../examples/plugins/${directory}/`;
	const files = Object.create(null) as Record<string, Uint8Array>;
	await Promise.all(
		Object.entries(sources)
			.filter(([name]) => name.startsWith(prefix))
			.map(async ([name, load]) => {
				files[name.slice(prefix.length)] = new TextEncoder().encode(String(await load()));
			}),
	);
	if (!files['manifest.json']) throw new Error('The included plugin package is unavailable.');
	const { zipSync } = await import('fflate');
	return zipSync(files, { level: 6 });
}
