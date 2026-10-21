import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inflateRaw } from 'node:zlib';
import { Worker } from 'node:worker_threads';
import type { PluginLocalManifest, PluginPackagePreview } from '../../src/plugin-types';
import { pluginPackagePath, validatePluginManifest } from '../../src/lib/plugin-manifest';
import { pluginWorkerPath } from './runtime';

export const PACKAGE_LIMITS = {
	archiveBytes: 8 * 1024 * 1024,
	unpackedBytes: 24 * 1024 * 1024,
	fileBytes: 4 * 1024 * 1024,
	entries: 256,
	ratio: 100,
	previewTTL: 10 * 60_000,
	previews: 3,
};
interface SourceFile {
	name: string;
	data: Uint8Array;
}
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
const crcTable = Array.from({ length: 256 }, (_, index) => {
	let value = index;
	for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
	return value >>> 0;
});
function crc32(data: Uint8Array) {
	let crc = 0xffffffff;
	for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}
function error(message: string): never {
	throw new Error(message);
}
/** Parse and bound central/local records before asynchronous, output-limited inflation. */
async function unpack(bytes: Uint8Array): Promise<SourceFile[]> {
	if (
		!(bytes instanceof Uint8Array) ||
		bytes.byteLength < 22 ||
		bytes.byteLength > PACKAGE_LIMITS.archiveBytes
	)
		error('Plugin ZIP must be at most 8 MiB.');
	const buffer = Buffer.from(bytes),
		length = buffer.length;
	let eocd = -1;
	for (let offset = length - 22; offset >= Math.max(0, length - 65557); offset--)
		if (
			buffer.readUInt32LE(offset) === 0x06054b50 &&
			offset + 22 + buffer.readUInt16LE(offset + 20) === length
		) {
			eocd = offset;
			break;
		}
	if (eocd < 0) error('Invalid plugin ZIP directory.');
	const count = buffer.readUInt16LE(eocd + 10),
		centralSize = buffer.readUInt32LE(eocd + 12),
		centralStart = buffer.readUInt32LE(eocd + 16);
	if (
		buffer.readUInt16LE(eocd + 4) ||
		buffer.readUInt16LE(eocd + 6) ||
		buffer.readUInt16LE(eocd + 8) !== count ||
		count < 1 ||
		count > PACKAGE_LIMITS.entries ||
		centralStart + centralSize !== eocd
	)
		error('Split, ZIP64, empty, or oversized ZIP archives are unsupported.');
	const entries: { name: string; data: Buffer; method: number; size: number; crc: number }[] = [],
		names = new Set<string>(),
		ranges: { start: number; end: number }[] = [];
	let cursor = centralStart,
		total = 0;
	const decoder = new TextDecoder('utf-8', { fatal: true });
	for (let index = 0; index < count; index++) {
		if (cursor + 46 > eocd || buffer.readUInt32LE(cursor) !== 0x02014b50)
			error('Invalid plugin ZIP entry.');
		const flags = buffer.readUInt16LE(cursor + 8),
			method = buffer.readUInt16LE(cursor + 10),
			crc = buffer.readUInt32LE(cursor + 16),
			packed = buffer.readUInt32LE(cursor + 20),
			size = buffer.readUInt32LE(cursor + 24),
			nameLength = buffer.readUInt16LE(cursor + 28),
			extraLength = buffer.readUInt16LE(cursor + 30),
			commentLength = buffer.readUInt16LE(cursor + 32),
			attributes = buffer.readUInt32LE(cursor + 38),
			local = buffer.readUInt32LE(cursor + 42);
		if (
			cursor + 46 + nameLength + extraLength + commentLength > eocd ||
			buffer.readUInt16LE(cursor + 34) !== 0 ||
			!nameLength ||
			flags & 1 ||
			![0, 8].includes(method) ||
			size > PACKAGE_LIMITS.fileBytes ||
			packed > PACKAGE_LIMITS.archiveBytes ||
			size > Math.max(4096, packed * PACKAGE_LIMITS.ratio)
		)
			error('Plugin ZIP entry exceeds supported compression or size limits.');
		const mode = (attributes >>> 16) & 0xf000;
		if (mode && mode !== 0x8000 && mode !== 0x4000)
			error('Plugin ZIP cannot contain symlinks or special files.');
		let name: string;
		try {
			name = decoder.decode(buffer.subarray(cursor + 46, cursor + 46 + nameLength));
		} catch {
			error('Plugin ZIP paths must be UTF-8.');
		}
		const directory = name!.endsWith('/');
		name = pluginPackagePath(directory ? name!.slice(0, -1) : name!);
		if ((mode === 0x4000 && !directory) || names.has(name.toLowerCase()))
			error('Plugin ZIP has duplicate or conflicting paths.');
		names.add(name.toLowerCase());
		if (local + 30 > centralStart || buffer.readUInt32LE(local) !== 0x04034b50)
			error('Invalid plugin ZIP local entry.');
		const localFlags = buffer.readUInt16LE(local + 6),
			localMethod = buffer.readUInt16LE(local + 8),
			localNameLength = buffer.readUInt16LE(local + 26),
			localExtraLength = buffer.readUInt16LE(local + 28),
			dataStart = local + 30 + localNameLength + localExtraLength;
		if (
			localFlags !== flags ||
			localMethod !== method ||
			localNameLength !== nameLength ||
			dataStart + packed > centralStart ||
			!buffer
				.subarray(local + 30, local + 30 + localNameLength)
				.equals(buffer.subarray(cursor + 46, cursor + 46 + nameLength))
		)
			error('Plugin ZIP local and central paths or sizes disagree.');
		if (
			!(flags & 8) &&
			(buffer.readUInt32LE(local + 14) !== crc ||
				buffer.readUInt32LE(local + 18) !== packed ||
				buffer.readUInt32LE(local + 22) !== size)
		)
			error('Plugin ZIP local sizes disagree.');
		ranges.push({ start: local, end: dataStart + packed });
		if (directory) {
			if (size || packed) error('Plugin ZIP directory contains data.');
		} else {
			total += size;
			if (total > PACKAGE_LIMITS.unpackedBytes) error('Plugin ZIP expands beyond 24 MiB.');
			entries.push({
				name,
				data: buffer.subarray(dataStart, dataStart + packed),
				method,
				size,
				crc,
			});
		}
		cursor += 46 + nameLength + extraLength + commentLength;
	}
	if (cursor !== eocd) error('Invalid plugin ZIP directory size.');
	ranges.sort((a, b) => a.start - b.start);
	if (ranges.some((range, index) => index > 0 && range.start < ranges[index - 1].end))
		error('Plugin ZIP entries overlap.');
	for (const entry of entries)
		for (const other of entries)
			if (other.name.startsWith(entry.name + '/'))
				error('Plugin ZIP has conflicting file and folder paths.');
	const result: SourceFile[] = [];
	for (const entry of entries) {
		const data =
			entry.method === 0
				? entry.data
				: await new Promise<Buffer>((resolve, reject) =>
						inflateRaw(
							entry.data,
							{ maxOutputLength: Math.max(1, entry.size) },
							(failure, output) =>
								failure
									? reject(
											new Error('Plugin ZIP expansion exceeded its declared size or is corrupt.'),
										)
									: resolve(output),
						),
					);
		if (data.length !== entry.size || crc32(data) !== entry.crc)
			error('Plugin ZIP contents do not match their directory.');
		result.push({ name: entry.name, data: new Uint8Array(data) });
	}
	return result;
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
			const files = await unpack(bytes);
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
