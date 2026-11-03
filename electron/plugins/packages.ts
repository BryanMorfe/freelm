import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { PluginLocalManifest, PluginPackagePreview } from '../../src/plugin-types';
import { validatePluginManifest } from '../../src/lib/plugin-manifest';
import { pluginWorkerPath } from './runtime';
import { PLUGIN_ARCHIVE_LIMITS, unpackPluginArchive } from './archive';

function error(message: string): never { throw new Error(message); }

export const PACKAGE_LIMITS = { ...PLUGIN_ARCHIVE_LIMITS, previewTTL: 10 * 60_000, previews: 3 };
interface SourceFile { name: string; data: Uint8Array }
interface Reviewed {
	manifest: PluginLocalManifest;
	files: SourceFile[];
	bytes: number;
	hash: string;
	expires: number;
}
interface Compiled {
	runtime: string;
	tabs: Record<string, { js: string; css: string }>;
}
interface Options {
	compilerWorkerPath?: string;
	compileTimeoutMs?: number;
	now?: () => number;
}
function escapeHTML(text: string) {
	return text.replace(
		/[&<>"']/g,
		(char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
	);
}
function tabHTML(tab: { js: string; css: string }): string {
	const csp =
		"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'";
	return `<!doctype html><html data-theme="__FREELM_PLUGIN_THEME__"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeHTML(csp)}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{font:13px system-ui,sans-serif;color-scheme:light dark}html[data-theme=dark]{color-scheme:dark;color:#eee}html[data-theme=light]{color-scheme:light;color:#222}body{margin:0;background:transparent}button,input,select,textarea{font:inherit}${tab.css.replace(/<\/style/gi, '<\\/style')}</style></head><body><div id="root"></div><script>globalThis.__freelmPluginNonce="__FREELM_PLUGIN_CHANNEL__";</script><script>${tab.js.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
}
export class PluginPackageStore {
	private readonly pending = new Map<string, Reviewed>();
	private preparing = 0;
	private compiling = 0;
	constructor(
		private readonly directory: string,
		private readonly options: Options = {},
	) {}
	private now() {
		return this.options.now?.() ?? Date.now();
	}
	private prune() {
		for (const [id, review] of this.pending)
			if (review.expires <= this.now()) this.pending.delete(id);
	}
	async prepare(bytes: Uint8Array): Promise<PluginPackagePreview> {
		this.prune();
		if (this.pending.size + this.preparing >= PACKAGE_LIMITS.previews)
			error('Finish installing a reviewed plugin or wait for its review to expire.');
		this.preparing++;
		try {
			if (!(bytes instanceof Uint8Array) || bytes.byteLength > PACKAGE_LIMITS.archiveBytes)
				error('Plugin ZIP must be at most 8 MiB.');
			bytes = Uint8Array.from(bytes);
			const files = await unpackPluginArchive(bytes);
			const manifestFile = files.find((file) => file.name === 'manifest.json');
			if (!manifestFile) error('Plugin ZIP requires manifest.json at its root.');
			if (manifestFile.data.length > 64_000) error('Plugin manifest exceeds 64 KiB.');
			const manifest = validatePluginManifest(
				JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestFile.data)),
			);
			if (manifest.manifestVersion !== 2)
				error('Source plugin packages require manifestVersion 2.');
			if (
				!files.some((file) => file.name === manifest.runtime.entry) ||
				manifest.contributes.tabs.some((tab) => !files.some((file) => file.name === tab.entry)) ||
				(manifest.contributes.views ?? []).some((view) => !files.some((file) => file.name === view.entry))
			)
				error('A declared plugin entry is missing from the ZIP.');
			const reviewId = randomUUID(),
				total = files.reduce((sum, file) => sum + file.data.byteLength, 0),
				hash = createHash('sha256').update('freelm-plugin-build-v3\0').update(bytes).digest('hex');
			this.pending.set(reviewId, {
				manifest,
				files,
				bytes: total,
				hash,
				expires: this.now() + PACKAGE_LIMITS.previewTTL,
			});
			return { reviewId, manifest: structuredClone(manifest), files: files.length, bytes: total };
		} finally {
			this.preparing--;
		}
	}
	async consume(
		reviewId: string,
	): Promise<{ manifest: PluginLocalManifest; hash: string; installedBytes: number }> {
		this.prune();
		const review = this.pending.get(reviewId);
		if (!review) error('Plugin package review expired. Choose the ZIP again.');
		if (this.compiling >= 2) error('Plugin compilation is busy. Try again shortly.');
		this.pending.delete(reviewId);
		this.compiling++;
		let temporary: string | undefined;
		try {
			const compiled = await this.compile(review!);
			const manifestJSON = JSON.stringify(review!.manifest),
				tabsJSON = JSON.stringify(compiled.tabs),
				indexJSON = JSON.stringify({
					format: 1,
					hash: review!.hash,
					runtimeHash: createHash('sha256').update(compiled.runtime).digest('hex'),
					tabsHash: createHash('sha256').update(tabsJSON).digest('hex'),
				});
			const installedBytes =
				Buffer.byteLength(manifestJSON) +
				Buffer.byteLength(compiled.runtime) +
				Buffer.byteLength(tabsJSON) +
				Buffer.byteLength(indexJSON);
			const base = path.join(this.directory, 'packages');
			await mkdir(base, { recursive: true, mode: 0o700 });
			temporary = path.join(base, `.install-${randomUUID()}`);
			await mkdir(temporary, { mode: 0o700 });
			await Promise.all([
				writeFile(path.join(temporary, 'manifest.json'), manifestJSON, { mode: 0o600 }),
				writeFile(path.join(temporary, 'runtime.js'), compiled.runtime, { mode: 0o600 }),
				writeFile(path.join(temporary, 'tabs.json'), tabsJSON, { mode: 0o600 }),
				writeFile(path.join(temporary, 'index.json'), indexJSON, { mode: 0o600 }),
			]);
			try {
				await rename(temporary, path.join(base, review!.hash));
				temporary = undefined;
			} catch (failure) {
				if (!['EEXIST', 'ENOTEMPTY'].includes((failure as NodeJS.ErrnoException).code || ''))
					throw failure;
				await this.readBundle(review!.hash);
				await this.readData(review!.hash, 'tabs.json');
			}
			return { manifest: structuredClone(review!.manifest), hash: review!.hash, installedBytes };
		} finally {
			this.compiling--;
			if (temporary) await rm(temporary, { recursive: true, force: true });
		}
	}
	private compile(review: Reviewed): Promise<Compiled> {
		return new Promise((resolve, reject) => {
			const worker = new Worker(this.options.compilerWorkerPath ?? pluginWorkerPath('compiler'), {
				workerData: { manifest: review.manifest, files: review.files },
				env: {},
				resourceLimits: { maxOldGenerationSizeMb: 192, stackSizeMb: 4 },
			});
			let finished = false;
			const finish = (failure?: Error, result?: Compiled) => {
				if (finished) return;
				finished = true;
				clearTimeout(timer);
				void worker.terminate();
				failure ? reject(failure) : resolve(result!);
			};
			const timer = setTimeout(
				() => finish(new Error('Plugin compilation timed out.')),
				this.options.compileTimeoutMs ?? 30_000,
			);
			worker.on('error', (failure) => finish(failure));
			worker.on('exit', (code) => {
				if (!finished) finish(new Error(`Plugin compiler exited before completion (${code}).`));
			});
			worker.on('message', (result: Compiled & { error?: string }) => {
				if (result.error) {
					finish(new Error(result.error));
					return;
				}
				if (
					typeof result.runtime !== 'string' ||
					!result.tabs ||
					typeof result.tabs !== 'object' ||
					Buffer.byteLength(JSON.stringify(result)) > 40 * 1024 * 1024
				) {
					finish(new Error('Plugin compiler returned invalid or oversized output.'));
					return;
				}
				finish(undefined, result);
			});
		});
	}
	private async readFile(hash: string, name: string): Promise<string> {
		if (!/^[a-f0-9]{64}$/.test(hash)) error('Invalid installed plugin hash.');
		const base = path.join(this.directory, 'packages', hash),
			directory = await lstat(base);
		if (!directory.isDirectory() || directory.isSymbolicLink())
			error('Invalid installed plugin directory.');
		const filename = path.join(base, name),
			stats = await lstat(filename);
		if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 40 * 1024 * 1024)
			error('Invalid installed plugin file.');
		return readFile(filename, 'utf8');
	}
	private async readData(hash: string, name: 'runtime.js' | 'tabs.json'): Promise<string> {
		const [indexJSON, data] = await Promise.all([
			this.readFile(hash, 'index.json'),
			this.readFile(hash, name),
		]);
		const index = JSON.parse(indexJSON);
		if (
			index.format !== 1 ||
			index.hash !== hash ||
			createHash('sha256').update(data).digest('hex') !==
				index[name === 'runtime.js' ? 'runtimeHash' : 'tabsHash']
		)
			error('Installed plugin files failed their integrity check. Reinstall the package.');
		return data;
	}
	async readBundle(hash: string): Promise<string> {
		return this.readData(hash, 'runtime.js');
	}
	async readTab(hash: string, tabId: string): Promise<{ html: string }> {
		const tabs = JSON.parse(await this.readData(hash, 'tabs.json')) as Compiled['tabs'];
		if (
			!Object.hasOwn(tabs, tabId) ||
			typeof tabs[tabId]?.js !== 'string' ||
			typeof tabs[tabId]?.css !== 'string'
		)
			error('This plugin tab is unavailable.');
		return { html: tabHTML(tabs[tabId]) };
	}
}
