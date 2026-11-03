import { inflateRaw } from 'node:zlib';
import { pluginPackagePath } from '../../src/lib/plugin-manifest';

export const PLUGIN_ARCHIVE_LIMITS = {
  archiveBytes: 8 * 1024 * 1024,
  unpackedBytes: 24 * 1024 * 1024,
  fileBytes: 4 * 1024 * 1024,
  entries: 256,
  ratio: 100,
};
interface SourceFile {
  name: string;
  data: Uint8Array;
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
export async function unpackPluginArchive(bytes: Uint8Array): Promise<SourceFile[]> {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength < 22 ||
    bytes.byteLength > PLUGIN_ARCHIVE_LIMITS.archiveBytes
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
    buffer.readUInt16LE(eocd + 20) ||
    buffer.readUInt16LE(eocd + 8) !== count ||
    count < 1 ||
    count > PLUGIN_ARCHIVE_LIMITS.entries ||
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
      (flags & ~0x0800) !== 0 ||
      extraLength !== 0 ||
      commentLength !== 0 ||
      ![0, 8].includes(method) ||
      size > PLUGIN_ARCHIVE_LIMITS.fileBytes ||
      packed > PLUGIN_ARCHIVE_LIMITS.archiveBytes ||
      size > Math.max(4096, packed * PLUGIN_ARCHIVE_LIMITS.ratio)
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
    const canonical = name.normalize('NFC').toLowerCase();
    if ((mode === 0x4000 && !directory) || names.has(canonical))
      error('Plugin ZIP has duplicate or conflicting paths.');
    names.add(canonical);
    if (local + 30 > centralStart || buffer.readUInt32LE(local) !== 0x04034b50)
      error('Invalid plugin ZIP local entry.');
    const localFlags = buffer.readUInt16LE(local + 6),
      localMethod = buffer.readUInt16LE(local + 8),
      localNameLength = buffer.readUInt16LE(local + 26),
      localExtraLength = buffer.readUInt16LE(local + 28),
      dataStart = local + 30 + localNameLength + localExtraLength;
    if (
      localFlags !== flags ||
      localExtraLength !== 0 ||
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
      if (total > PLUGIN_ARCHIVE_LIMITS.unpackedBytes) error('Plugin ZIP expands beyond 24 MiB.');
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
  if (
    ranges.some((range, index) => range.start !== (index ? ranges[index - 1].end : 0)) ||
    ranges.at(-1)?.end !== centralStart
  )
    error('Plugin ZIP entries overlap or contain unsupported unaccounted bytes.');
  for (const entry of entries)
    for (const other of names)
      if (other.startsWith(entry.name.normalize('NFC').toLowerCase() + '/'))
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
