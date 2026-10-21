import { createHash } from 'node:crypto';
import { constants as bufferLimits } from 'node:buffer';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite, jsonPayloadAsync, type JsonPayload } from './json-file';

const INLINE_LIMIT = 64 * 1024;
const MAX_BLOB_BYTES = 512 * 1024 * 1024;
const roots = ['threads', 'projects', 'generations', 'chatDrafts'];
export interface MediaReference {
	path: string[];
	hash: string;
	characters: number;
}
interface Source extends MediaReference {
	value: string;
	payload?: JsonPayload;
}
interface Encoded {
	value: unknown;
	sources: Source[];
}
interface BlobFile {
	size: number;
	mtimeMs: number;
	ctimeMs: number;
	ino: number;
}
const record = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === 'object' && !Array.isArray(value);

/** Private immutable workspace strings are content-addressed; public API state remains inline. */
export class MediaStore {
	private encoded = new WeakMap<object, Encoded>();
	private identities = new WeakMap<object, Map<string, Source>>();
	private ready = new Map<string, BlobFile>();
	constructor(readonly directory: string) {}

	private async encode(
		value: unknown,
		stack = new Set<object>(),
		strings = new Map<string, Source>(),
	): Promise<Encoded> {
		if (!value || typeof value !== 'object') return { value, sources: [] };
		const cached = this.encoded.get(value);
		if (cached) return cached;
		if (stack.has(value)) throw new Error('Cannot save circular workspace data.');
		stack.add(value);
		const output: unknown[] | Record<string, unknown> = Array.isArray(value) ? [] : {};
		const sources: Source[] = [];
		for (const key of Object.keys(value)) {
			const child = (value as Record<string, unknown>)[key];
			let encoded: unknown;
			if (typeof child === 'string' && child.length > INLINE_LIMIT) {
				let source = this.identities.get(value)?.get(key) ?? strings.get(child);
				if (!source || source.value !== child) {
					const hash = createHash('sha256');
					const payload = await jsonPayloadAsync(child, false, (part) => hash.update(part, 'utf8'));
					source = {
						path: [],
						hash: hash.digest('hex'),
						characters: child.length,
						value: child,
						payload,
					};
				}
				strings.set(child, source);
				sources.push({ ...source, path: [key] });
				encoded = '';
			} else {
				const nested = await this.encode(child, stack, strings);
				encoded = nested.value;
				for (const source of nested.sources)
					sources.push({ ...source, path: [key, ...source.path] });
			}
			Object.defineProperty(output, key, {
				value: encoded,
				writable: true,
				enumerable: true,
				configurable: true,
			});
		}
		stack.delete(value);
		const result = { value: output, sources };
		this.encoded.set(value, result);
		return result;
	}

	async encodeWorkspace<T extends { format: 'freelm-workspace-v2' }>(
		workspace: T,
	): Promise<T | (Omit<T, 'format'> & { format: 'freelm-workspace-v3'; blobs: MediaReference[] })> {
		const encoded = await this.encode(workspace);
		if (!encoded.sources.length) return workspace;
		const files = new Map(encoded.sources.map((source) => [source.hash, source]));
		for (const source of files.values()) await this.ensure(source);
		return {
			...(encoded.value as T),
			format: 'freelm-workspace-v3',
			blobs: encoded.sources.map(({ path, hash, characters }) => ({ path, hash, characters })),
		};
	}

	private async folder(create = false) {
		if (create) await mkdir(this.directory, { recursive: true, mode: 0o700 });
		const info = await lstat(this.directory);
		if (!info.isDirectory() || info.isSymbolicLink())
			throw new Error('The workspace media folder must be a real directory.');
	}
	private filename(hash: string) {
		if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid workspace media identifier.');
		return path.join(this.directory, `${hash}.json`);
	}
	private async digest(filename: string): Promise<string> {
		const hash = createHash('sha256');
		const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			for await (const chunk of file.createReadStream({
				autoClose: false,
				highWaterMark: 256 * 1024,
			}))
				hash.update(chunk);
		} finally {
			await file.close();
		}
		return hash.digest('hex');
	}
	private async readBlob(hash: string): Promise<{ content: string; info: BlobFile }> {
		const file = await open(this.filename(hash), constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const info = await file.stat();
			if (!info.isFile() || info.size > MAX_BLOB_BYTES)
				throw new Error('Invalid workspace media file.');
			const digest = createHash('sha256');
			const decoder = new TextDecoder('utf-8', { fatal: true });
			const parts: string[] = [];
			let bytes = 0,
				characters = 0;
			for await (const chunk of file.createReadStream({
				autoClose: false,
				highWaterMark: 256 * 1024,
			})) {
				bytes += chunk.length;
				if (bytes > MAX_BLOB_BYTES)
					throw new Error('A saved workspace media file exceeds its size limit.');
				digest.update(chunk);
				const text = decoder.decode(chunk, { stream: true });
				characters += text.length;
				if (characters > bufferLimits.MAX_STRING_LENGTH)
					throw new Error('A saved workspace media file exceeds the decoding limit.');
				parts.push(text);
			}
			parts.push(decoder.decode());
			if (digest.digest('hex') !== hash)
				throw new Error('A saved workspace media file is damaged.');
			const decoded: unknown = JSON.parse(parts.join(''));
			if (typeof decoded !== 'string') throw new Error('Invalid workspace media contents.');
			return { content: decoded, info };
		} finally {
			await file.close();
		}
	}
	private async ensure(source: Source) {
		await this.folder(true);
		const filename = this.filename(source.hash);
		let existing: BlobFile | undefined;
		try {
			const info = await lstat(filename);
			if (!info.isFile() || info.isSymbolicLink())
				throw new Error('The workspace media file must be a regular file.');
			existing = info;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
		const ready = this.ready.get(source.hash);
		if (
			existing &&
			((ready &&
				ready.size === existing.size &&
				ready.mtimeMs === existing.mtimeMs &&
				ready.ctimeMs === existing.ctimeMs &&
				ready.ino === existing.ino) ||
				(existing.size <= MAX_BLOB_BYTES && (await this.digest(filename)) === source.hash))
		) {
			this.ready.set(source.hash, existing);
			return;
		}
		await atomicWrite(filename, source.payload ?? (await jsonPayloadAsync(source.value)));
		this.ready.set(source.hash, await lstat(filename));
	}

	async hydrate(value: unknown): Promise<unknown> {
		if (!record(value) || value.format !== 'freelm-workspace-v3') return value;
		if (!Array.isArray(value.blobs) || value.blobs.length > 1_000_000)
			throw new Error('Invalid workspace media manifest.');
		const seen = new Set<string>();
		const loaded = new Map<string, string>();
		await this.folder();
		for (const entry of value.blobs) {
			if (
				!record(entry) ||
				Object.keys(entry).some((key) => !['path', 'hash', 'characters'].includes(key)) ||
				!Array.isArray(entry.path) ||
				entry.path.length < 2 ||
				entry.path.length > 1000 ||
				!entry.path.every((key) => typeof key === 'string' && key.length <= 4096) ||
				!roots.includes(String(entry.path[0])) ||
				typeof entry.hash !== 'string' ||
				!/^[a-f0-9]{64}$/.test(entry.hash) ||
				typeof entry.characters !== 'number' ||
				!Number.isSafeInteger(entry.characters) ||
				entry.characters < 0 ||
				entry.characters > 400_000_000
			)
				throw new Error('Invalid workspace media reference.');
			const reference = entry as unknown as MediaReference;
			const location = JSON.stringify(reference.path);
			if (seen.has(location)) throw new Error('Duplicate workspace media reference.');
			seen.add(location);
			let parent: unknown = value;
			for (const key of reference.path.slice(0, -1)) {
				if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key))
					throw new Error('Invalid workspace media location.');
				parent = (parent as Record<string, unknown>)[key];
			}
			const key = reference.path.at(-1)!;
			if (
				!parent ||
				typeof parent !== 'object' ||
				!Object.hasOwn(parent, key) ||
				(parent as Record<string, unknown>)[key] !== ''
			)
				throw new Error('Invalid workspace media placeholder.');
			let content = loaded.get(reference.hash);
			if (content === undefined) {
				const verified = await this.readBlob(reference.hash);
				content = verified.content;
				loaded.set(reference.hash, content);
				this.ready.set(reference.hash, verified.info);
			}
			if (content.length !== reference.characters)
				throw new Error('A saved workspace media file has the wrong length.');
			Object.defineProperty(parent, key, {
				value: content,
				writable: true,
				enumerable: true,
				configurable: true,
			});
			const identities = this.identities.get(parent) ?? new Map<string, Source>();
			identities.set(key, { ...reference, path: [], value: content });
			this.identities.set(parent, identities);
		}
		const { blobs: _blobs, ...workspace } = value;
		return { ...workspace, format: 'freelm-workspace-v2' };
	}

	/** Called only after both workspace files are durable and the redo journal is removed. */
	async prune(workspace: unknown): Promise<void> {
		const hashes =
			record(workspace) && Array.isArray(workspace.blobs)
				? new Set(workspace.blobs.map((entry) => (entry as MediaReference).hash))
				: new Set<string>();
		let entries: string[];
		try {
			await this.folder();
			entries = await readdir(this.directory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
			throw error;
		}
		for (const filename of entries) {
			if (!/^[a-f0-9]{64}\.json$/.test(filename) || hashes.has(filename.slice(0, -5))) continue;
			await rm(path.join(this.directory, filename));
			this.ready.delete(filename.slice(0, -5));
		}
	}
}
