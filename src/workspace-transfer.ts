import { normalizeJson } from './json-normalize';

/** Bounds apply to individual IPC messages, never to the whole workspace. */
export const WORKSPACE_TRANSFER_CHUNK_SIZE = 128 * 1024;
export const WORKSPACE_TRANSFER_STRING_THRESHOLD = 64 * 1024;
export const WORKSPACE_TRANSFER_INLINE_METADATA_LIMIT = WORKSPACE_TRANSFER_CHUNK_SIZE;
const maximumDepth = 256;

export type WorkspaceTransferJson =
	| null
	| boolean
	| number
	| string
	| WorkspaceTransferJson[]
	| { [key: string]: WorkspaceTransferJson };
export type WorkspaceTransferPath = (string | number)[];
export interface WorkspaceTransferString {
	id: string;
	/** UTF-16 code units, so even a split surrogate pair is lossless. */
	length: number;
	paths: WorkspaceTransferPath[];
}
export interface WorkspaceTransferManifest {
	version: 1;
	shape: WorkspaceTransferJson;
	strings: WorkspaceTransferString[];
}
export interface WorkspaceTransferDescriptor {
	version: 1;
	metadata: { json: string } | { id: string; length: number };
}
/** Scope this cache to the same renderer/pool lifetime as its opaque handles. */
export type WorkspaceTransferCache = Map<string, { id: string; length: number }>;
export type WorkspaceTransferReader = (
	id: string,
	offset: number,
	length: number,
) => Promise<string>;
export interface WorkspaceTransferWriter {
	createString(length: number): Promise<string>;
	writeChunk(id: string, offset: number, chunk: string): Promise<void>;
	createMetadata(length: number): Promise<string>;
	writeMetadataChunk(id: string, offset: number, chunk: string): Promise<void>;
}

function invalid(detail: string): never {
	throw new Error(`Invalid workspace transfer: ${detail}.`);
}
function object(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
function keys(value: Record<string, unknown>, expected: string[]): boolean {
	const names = Object.keys(value);
	return names.length === expected.length && names.every((name) => expected.includes(name));
}
function validId(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= 256;
}
function validLength(value: unknown, minimum = 0): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function assertShape(value: unknown, depth = 0, ancestors = new Set<object>()): void {
	if (depth > maximumDepth) invalid('shape is nested too deeply');
	if (typeof value === 'string') {
		if (value.length >= WORKSPACE_TRANSFER_STRING_THRESHOLD)
			invalid('large string is missing from the manifest');
		return;
	}
	if (value === null || typeof value === 'boolean') return;
	if (typeof value === 'number' && Number.isFinite(value)) return;
	if (!Array.isArray(value) && !object(value)) invalid('shape must contain JSON values');
	if (ancestors.has(value)) invalid('circular shape');
	ancestors.add(value);
	if (Array.isArray(value)) {
		if (Object.keys(value).length !== value.length) invalid('shape array must be dense');
		for (let index = 0; index < value.length; index++) {
			if (!Object.hasOwn(value, index)) invalid('shape array must be dense');
			assertShape(value[index], depth + 1, ancestors);
		}
	} else {
		for (const item of Object.values(value)) assertShape(item, depth + 1, ancestors);
	}
	ancestors.delete(value);
}

/** Resolve only own object properties and integer array indices. */
function pathValue(shape: WorkspaceTransferJson, path: unknown): WorkspaceTransferJson {
	if (!Array.isArray(path) || path.length > maximumDepth) invalid('invalid string path');
	let current = shape;
	for (const key of path) {
		if (Array.isArray(current)) {
			if (!validLength(key) || key >= current.length || !Object.hasOwn(current, key))
				invalid('invalid array path');
			current = current[key];
		} else if (object(current)) {
			if (typeof key !== 'string' || !Object.hasOwn(current, key)) invalid('invalid object path');
			current = current[key] as WorkspaceTransferJson;
		} else invalid('path crosses a leaf');
	}
	return current;
}

export function assertWorkspaceTransferManifest(
	value: unknown,
): asserts value is WorkspaceTransferManifest {
	if (
		!object(value) ||
		!keys(value, ['version', 'shape', 'strings']) ||
		value.version !== 1 ||
		!Array.isArray(value.strings)
	)
		invalid('invalid manifest');
	assertShape(value.shape);
	const identifiers = new Set<string>();
	const locations = new Set<string>();
	for (const entry of value.strings) {
		if (
			!object(entry) ||
			!keys(entry, ['id', 'length', 'paths']) ||
			!validId(entry.id) ||
			!validLength(entry.length, WORKSPACE_TRANSFER_STRING_THRESHOLD) ||
			!Array.isArray(entry.paths) ||
			!entry.paths.length ||
			identifiers.has(entry.id)
		)
			invalid('invalid string entry');
		identifiers.add(entry.id);
		for (const path of entry.paths) {
			if (pathValue(value.shape as WorkspaceTransferJson, path) !== '')
				invalid('string path must point to an empty placeholder');
			const location = JSON.stringify(path);
			if (locations.has(location)) invalid('duplicate string path');
			locations.add(location);
		}
	}
}

export function assertWorkspaceTransferDescriptor(
	value: unknown,
): asserts value is WorkspaceTransferDescriptor {
	if (
		!object(value) ||
		!keys(value, ['version', 'metadata']) ||
		value.version !== 1 ||
		!object(value.metadata)
	)
		invalid('invalid descriptor');
	const metadata = value.metadata;
	if (Object.hasOwn(metadata, 'json')) {
		if (
			!keys(metadata, ['json']) ||
			typeof metadata.json !== 'string' ||
			metadata.json.length > WORKSPACE_TRANSFER_INLINE_METADATA_LIMIT
		)
			invalid('inline metadata exceeds its message bound');
	} else if (
		!keys(metadata, ['id', 'length']) ||
		!validId(metadata.id) ||
		!validLength(metadata.length, WORKSPACE_TRANSFER_INLINE_METADATA_LIMIT + 1)
	)
		invalid('invalid metadata handle');
}

/** The callback stores immutable string leaves; no hydrated snapshot is stringified. */
export function encodeWorkspaceTransfer(
	value: unknown,
	putString: (value: string) => string,
): WorkspaceTransferManifest {
	const strings = new Map<string, WorkspaceTransferString>();
	const identifiers = new Set<string>();
	function visit(item: unknown, path: WorkspaceTransferPath): WorkspaceTransferJson {
		if (path.length > maximumDepth) invalid('shape is nested too deeply');
		if (typeof item === 'string') {
			if (item.length < WORKSPACE_TRANSFER_STRING_THRESHOLD) return item;
			let entry = strings.get(item);
			if (!entry) {
				const id = putString(item);
				if (!validId(id) || identifiers.has(id)) invalid('invalid or duplicate string handle');
				identifiers.add(id);
				entry = { id, length: item.length, paths: [] };
				strings.set(item, entry);
			}
			entry.paths.push(path);
			return '';
		}
		if (item === null || typeof item === 'boolean') return item;
		if (typeof item === 'number' && Number.isFinite(item)) return item;
		if (Array.isArray(item)) return item.map((entry, index) => visit(entry, [...path, index]));
		if (!object(item)) invalid('shape must contain JSON values');
		const shape: Record<string, WorkspaceTransferJson> = {};
		for (const [key, entry] of Object.entries(item)) {
			Object.defineProperty(shape, key, {
				value: visit(entry, [...path, key]),
				writable: true,
				enumerable: true,
				configurable: true,
			});
		}
		return shape;
	}
	const shape = visit(normalizeJson(value), []);
	return { version: 1, shape, strings: [...strings.values()] };
}

/** Metadata uses the same bounded transport as media when its JSON is large. */
export function describeWorkspaceTransfer(
	manifest: WorkspaceTransferManifest,
	putMetadata: (json: string) => string,
): WorkspaceTransferDescriptor {
	assertWorkspaceTransferManifest(manifest);
	const json = JSON.stringify(manifest);
	if (json.length <= WORKSPACE_TRANSFER_INLINE_METADATA_LIMIT)
		return { version: 1, metadata: { json } };
	const id = putMetadata(json);
	if (!validId(id)) invalid('invalid metadata handle');
	return { version: 1, metadata: { id, length: json.length } };
}

export function parseWorkspaceTransferManifest(json: string): WorkspaceTransferManifest {
	let manifest: unknown;
	try {
		manifest = JSON.parse(json);
	} catch {
		invalid('metadata is not valid JSON');
	}
	assertWorkspaceTransferManifest(manifest);
	return manifest;
}

export function workspaceTransferChunk(value: string, offset: number, length: number): string {
	if (
		typeof value !== 'string' ||
		!validLength(offset) ||
		!validLength(length, 1) ||
		length > WORKSPACE_TRANSFER_CHUNK_SIZE ||
		offset > value.length - length
	)
		invalid('invalid chunk bounds');
	return value.slice(offset, offset + length);
}

function putAtPath(
	shape: WorkspaceTransferJson,
	path: WorkspaceTransferPath,
	value: string,
): WorkspaceTransferJson {
	if (!path.length) return value;
	let parent = shape as WorkspaceTransferJson[] | Record<string, WorkspaceTransferJson>;
	for (const key of path.slice(0, -1))
		parent = (parent as Record<string | number, WorkspaceTransferJson>)[key] as typeof parent;
	Object.defineProperty(parent, path[path.length - 1], {
		value,
		writable: true,
		enumerable: true,
		configurable: true,
	});
	return shape;
}

/** Main may resolve its own pool synchronously; renderer uses the async reader below. */
export function hydrateWorkspaceTransfer<T>(
	manifest: WorkspaceTransferManifest,
	getString: (id: string) => string,
	cache?: WorkspaceTransferCache,
): T {
	assertWorkspaceTransferManifest(manifest);
	const resolved = manifest.strings.map((entry) => {
		const value = getString(entry.id);
		if (typeof value !== 'string' || value.length !== entry.length)
			invalid('string length does not match its manifest');
		return { entry, value };
	});
	let shape = normalizeJson(manifest.shape);
	for (const { entry, value } of resolved) {
		for (const path of entry.paths) shape = putAtPath(shape, path, value);
		cache?.set(value, { id: entry.id, length: entry.length });
	}
	return shape as T;
}

async function readString(
	id: string,
	length: number,
	readChunk: WorkspaceTransferReader,
): Promise<string> {
	const chunks: string[] = [];
	for (let offset = 0; offset < length; offset += WORKSPACE_TRANSFER_CHUNK_SIZE) {
		const count = Math.min(WORKSPACE_TRANSFER_CHUNK_SIZE, length - offset);
		const chunk = await readChunk(id, offset, count);
		if (typeof chunk !== 'string' || chunk.length !== count)
			invalid('received an incomplete or oversized chunk');
		chunks.push(chunk);
	}
	return chunks.join('');
}

/** Run in the renderer, outside preload/contextBridge, to avoid a giant bridge return. */
export async function readWorkspaceTransfer<T>(
	descriptor: WorkspaceTransferDescriptor,
	readChunk: WorkspaceTransferReader,
	cache?: WorkspaceTransferCache,
): Promise<T> {
	assertWorkspaceTransferDescriptor(descriptor);
	const metadata = descriptor.metadata;
	const manifest = parseWorkspaceTransferManifest(
		'json' in metadata ? metadata.json : await readString(metadata.id, metadata.length, readChunk),
	);
	const reused = new Map<string, string>();
	for (const [text, handle] of cache ?? []) {
		if (!validId(handle.id) || handle.length !== text.length) invalid('invalid cached handle');
		if (reused.has(handle.id) && reused.get(handle.id) !== text)
			invalid('duplicate cached string handle');
		reused.set(handle.id, text);
	}
	const strings = new Map<string, string>();
	for (const entry of manifest.strings) {
		const cached = reused.get(entry.id);
		strings.set(
			entry.id,
			cached !== undefined && cached.length === entry.length
				? cached
				: await readString(entry.id, entry.length, readChunk),
		);
	}
	return hydrateWorkspaceTransfer<T>(manifest, (id) => strings.get(id)!, cache);
}

async function writeString(
	value: string,
	id: string,
	writeChunk: WorkspaceTransferWriter['writeChunk'],
): Promise<void> {
	for (let offset = 0; offset < value.length; offset += WORKSPACE_TRANSFER_CHUNK_SIZE)
		await writeChunk(id, offset, value.slice(offset, offset + WORKSPACE_TRANSFER_CHUNK_SIZE));
}

/** Reuses handles from loads/saves, so unchanged gallery strings are never reuploaded. */
export async function writeWorkspaceTransfer(
	value: unknown,
	writer: WorkspaceTransferWriter,
	cache?: WorkspaceTransferCache,
): Promise<WorkspaceTransferDescriptor> {
	const pending = new Map<string, string>();
	const reserved = new Set([...(cache?.values() ?? [])].map((entry) => entry.id));
	let nextPendingId = 0;
	const manifest = encodeWorkspaceTransfer(value, (text) => {
		const reused = cache?.get(text);
		if (reused) {
			if (!validId(reused.id) || reused.length !== text.length) invalid('invalid cached handle');
			return reused.id;
		}
		let id: string;
		do id = `pending:${nextPendingId++}`;
		while (reserved.has(id));
		pending.set(id, text);
		return id;
	});
	const identifiers = new Set(
		manifest.strings.filter((entry) => !pending.has(entry.id)).map((entry) => entry.id),
	);
	for (const entry of manifest.strings) {
		const text = pending.get(entry.id);
		if (text === undefined) continue;
		const id = await writer.createString(entry.length);
		if (!validId(id) || identifiers.has(id)) invalid('invalid or duplicate string handle');
		identifiers.add(id);
		await writeString(text, id, (handle, offset, chunk) =>
			writer.writeChunk(handle, offset, chunk),
		);
		entry.id = id;
		cache?.set(text, { id, length: entry.length });
	}
	const json = JSON.stringify(manifest);
	if (json.length <= WORKSPACE_TRANSFER_INLINE_METADATA_LIMIT)
		return { version: 1, metadata: { json } };
	const id = await writer.createMetadata(json.length);
	if (!validId(id)) invalid('invalid metadata handle');
	await writeString(json, id, (handle, offset, chunk) =>
		writer.writeMetadataChunk(handle, offset, chunk),
	);
	return { version: 1, metadata: { id, length: json.length } };
}
