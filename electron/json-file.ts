import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { constants as bufferLimits } from 'node:buffer';
import { setImmediate as yieldToIo } from 'node:timers/promises';
const MAX_BYTES = Math.min(512 * 1024 * 1024, bufferLimits.MAX_STRING_LENGTH);
export async function syncDirectory(directory: string): Promise<void> {
	let handle;
	try {
		handle = await open(directory, 'r');
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (process.platform === 'win32' && (code === 'EISDIR' || code === 'EPERM' || code === 'EINVAL'))
			return;
		throw error;
	}
	try {
		await handle.sync();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (process.platform === 'win32' && (code === 'EPERM' || code === 'EINVAL')) return;
		throw error;
	} finally {
		await handle.close();
	}
}
export async function atomicWrite(filename: string, payload: JsonPayload): Promise<void> {
	const directory = path.dirname(filename);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const temporary = `${filename}.${randomUUID()}.tmp`;
	try {
		const handle = await open(temporary, 'wx', 0o600);
		try {
			let written = 0;
			for (const chunk of payloadBuffers(payload)) {
				let offset = 0;
				while (offset < chunk.length) {
					const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null);
					if (bytesWritten <= 0) throw new Error('The workspace write made no progress.');
					offset += bytesWritten;
					written += bytesWritten;
				}
			}
			if (written !== payload.bytes)
				throw new Error('The workspace changed while it was being saved.');
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, filename);
		await syncDirectory(directory);
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
}
// Never hand V8/Node one workspace-sized string to flatten or convert to UTF-8.
// Source slices are small enough that even worst-case JSON escaping stays bounded.
const STRING_SLICE = 16 * 1024;
const WRITE_BYTES = 256 * 1024;
export interface JsonPayload {
	bytes: number;
	parts(): Iterable<string>;
}
function assertStorageSize(bytes: number): void {
	if (bytes > MAX_BYTES)
		throw new Error(
			'Workspace metadata or an individual media file exceeds the 512 MB storage limit. Your saved files have not been replaced.',
		);
}
function* quotedParts(value: string): Generator<string> {
	yield '"';
	for (let start = 0; start < value.length;) {
		let end = Math.min(start + STRING_SLICE, value.length);
		// Keep a surrogate pair together; stringify must still escape genuinely lone surrogates.
		const last = value.charCodeAt(end - 1),
			next = value.charCodeAt(end);
		if (end < value.length && last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff)
			end--;
		yield JSON.stringify(value.slice(start, end)).slice(1, -1);
		start = end;
	}
	yield '"';
}
function jsonValue(value: unknown, key: string): unknown {
	if (value && typeof value === 'object') {
		const object = value as { toJSON?: (key: string) => unknown };
		if (typeof object.toJSON === 'function') return object.toJSON(key);
		if (value instanceof Number || value instanceof String || value instanceof Boolean)
			return value.valueOf();
	}
	return value;
}
function omitted(value: unknown): boolean {
	return value === undefined || typeof value === 'function' || typeof value === 'symbol';
}
function* jsonParts(
	value: unknown,
	pretty = false,
	depth = 0,
	stack = new Set<object>(),
): Generator<string> {
	if (typeof value === 'string') {
		yield* quotedParts(value);
		return;
	}
	if (value === null || typeof value !== 'object') {
		yield JSON.stringify(value) ?? 'null';
		return;
	}
	if (stack.has(value)) throw new Error('Cannot save circular workspace data.');
	if (depth > 1000) throw new Error('Workspace data is nested too deeply.');
	stack.add(value);
	const array = Array.isArray(value);
	yield array ? '[' : '{';
	let count = 0;
	const entries: Iterable<[string, unknown]> = array
		? (value.entries() as Iterable<[string, unknown]>)
		: Object.keys(value).map((key) => [key, (value as Record<string, unknown>)[key]]);
	for (const [key, raw] of entries) {
		const item = jsonValue(raw, String(key));
		if (!array && omitted(item)) continue;
		if (count++) yield ',';
		if (pretty) yield '\n' + '  '.repeat(depth + 1);
		if (!array) {
			yield* quotedParts(key);
			yield pretty ? ': ' : ':';
		}
		yield* jsonParts(omitted(item) ? null : item, pretty, depth + 1, stack);
	}
	if (pretty && count) yield '\n' + '  '.repeat(depth);
	yield array ? ']' : '}';
	stack.delete(value);
}
export function jsonPayload(value: unknown, pretty = false): JsonPayload {
	const parts = function* () {
		yield* jsonParts(jsonValue(value, ''), pretty);
		if (pretty) yield '\n';
	};
	let bytes = 0;
	for (const part of parts()) {
		bytes += Buffer.byteLength(part, 'utf8');
		assertStorageSize(bytes);
	}
	return { bytes, parts };
}

/** Size and optionally consume the exact bounded serializer without monopolizing the event loop. */
export async function jsonPayloadAsync(
	value: unknown,
	pretty = false,
	consume?: (part: string) => void,
): Promise<JsonPayload> {
	const parts = function* () {
		yield* jsonParts(jsonValue(value, ''), pretty);
		if (pretty) yield '\n';
	};
	let bytes = 0,
		budget = 0;
	for (const part of parts()) {
		const size = Buffer.byteLength(part, 'utf8');
		bytes += size;
		budget += size;
		assertStorageSize(bytes);
		consume?.(part);
		if (budget >= 1024 * 1024) {
			budget = 0;
			await yieldToIo();
		}
	}
	return { bytes, parts };
}
export function literal(value: string): JsonPayload {
	return {
		bytes: Buffer.byteLength(value, 'utf8'),
		parts: function* () {
			yield value;
		},
	};
}
export function joinedPayload(parts: JsonPayload[]): JsonPayload {
	const bytes = parts.reduce((total, part) => total + part.bytes, 0);
	assertStorageSize(bytes);
	return {
		bytes,
		parts: function* () {
			for (const part of parts) yield* part.parts();
		},
	};
}
function* payloadBuffers(payload: JsonPayload): Generator<Buffer> {
	let buffer = Buffer.allocUnsafe(WRITE_BYTES),
		offset = 0;
	for (const part of payload.parts()) {
		const bytes = Buffer.byteLength(part, 'utf8');
		if (bytes > WRITE_BYTES) throw new Error('Workspace serialization exceeded its chunk limit.');
		if (offset + bytes > buffer.length) {
			yield buffer.subarray(0, offset);
			buffer = Buffer.allocUnsafe(WRITE_BYTES);
			offset = 0;
		}
		offset += buffer.write(part, offset, bytes, 'utf8');
	}
	if (offset) yield buffer.subarray(0, offset);
}
