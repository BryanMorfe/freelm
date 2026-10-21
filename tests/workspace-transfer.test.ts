import { describe, expect, it } from 'vitest';
import {
	WORKSPACE_TRANSFER_CHUNK_SIZE,
	WORKSPACE_TRANSFER_INLINE_METADATA_LIMIT,
	WORKSPACE_TRANSFER_STRING_THRESHOLD,
	assertWorkspaceTransferDescriptor,
	assertWorkspaceTransferManifest,
	describeWorkspaceTransfer,
	encodeWorkspaceTransfer,
	hydrateWorkspaceTransfer,
	parseWorkspaceTransferManifest,
	readWorkspaceTransfer,
	workspaceTransferChunk,
	writeWorkspaceTransfer,
	type WorkspaceTransferCache,
	type WorkspaceTransferManifest,
	type WorkspaceTransferWriter,
} from '../src/workspace-transfer';

const large = (character = 'A') => character.repeat(WORKSPACE_TRANSFER_STRING_THRESHOLD);

function pool() {
	const values = new Map<string, string>();
	const uploads = new Map<string, { length: number; chunks: string[]; offset: number }>();
	const reads: { id: string; offset: number; length: number }[] = [];
	const writes: { id: string; offset: number; chunk: string; kind: string }[] = [];
	let nextId = 0;
	function put(value: string): string {
		const id = `opaque:${++nextId}`;
		values.set(id, value);
		return id;
	}
	async function create(length: number): Promise<string> {
		const id = `opaque:${++nextId}`;
		uploads.set(id, { length, chunks: [], offset: 0 });
		return id;
	}
	async function append(id: string, offset: number, chunk: string, kind: string): Promise<void> {
		const upload = uploads.get(id)!;
		expect(offset).toBe(upload.offset);
		expect(chunk.length).toBeGreaterThan(0);
		expect(chunk.length).toBeLessThanOrEqual(WORKSPACE_TRANSFER_CHUNK_SIZE);
		// JSON round trips deliberately preserve lone surrogate halves at chunk boundaries.
		const wireChunk = JSON.parse(JSON.stringify(chunk)) as string;
		expect(Buffer.byteLength(JSON.stringify([id, offset, wireChunk]))).toBeLessThan(1024 * 1024);
		writes.push({ id, offset, chunk: wireChunk, kind });
		upload.chunks.push(wireChunk);
		upload.offset += wireChunk.length;
		expect(upload.offset).toBeLessThanOrEqual(upload.length);
		if (upload.offset === upload.length) values.set(id, upload.chunks.join(''));
	}
	const writer: WorkspaceTransferWriter = {
		createString: create,
		writeChunk: (id, offset, chunk) => append(id, offset, chunk, 'string'),
		createMetadata: create,
		writeMetadataChunk: (id, offset, chunk) => append(id, offset, chunk, 'metadata'),
	};
	const read = async (id: string, offset: number, length: number) => {
		reads.push({ id, offset, length });
		const value = workspaceTransferChunk(values.get(id)!, offset, length);
		expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(1024 * 1024);
		return JSON.parse(JSON.stringify(value)) as string;
	};
	return { values, uploads, reads, writes, put, writer, read };
}

describe('bounded workspace transfer', () => {
	it('uses explicit paths and deduplicates all large string leaves without marker collisions', async () => {
		const media = large();
		const value = {
			empty: '',
			nil: null,
			text: 'hello',
			marker: { id: 'opaque:1', length: media.length, paths: [['empty']] },
			assets: [{ dataUrl: media }, media, '', null],
			other: { '0': media, '': 'a value at an empty key' },
		};
		const memory = pool();
		const manifest = encodeWorkspaceTransfer(value, memory.put);
		expect(manifest.strings).toEqual([
			{
				id: 'opaque:1',
				length: media.length,
				paths: [
					['assets', 0, 'dataUrl'],
					['assets', 1],
					['other', '0'],
				],
			},
		]);
		expect(manifest.shape).toEqual({
			...value,
			assets: [{ dataUrl: '' }, '', '', null],
			other: { '0': '', '': 'a value at an empty key' },
		});
		const descriptor = describeWorkspaceTransfer(manifest, memory.put);
		const cache: WorkspaceTransferCache = new Map();
		expect(await readWorkspaceTransfer(descriptor, memory.read, cache)).toEqual(value);
		expect(memory.reads).toHaveLength(1);
		expect(cache.get(media)).toEqual({ id: 'opaque:1', length: media.length });
		expect(value.assets[1]).toBe(media);
		expect((manifest.shape as typeof value).assets[1]).toBe('');
	});

	it('preserves JSON normalization, empty roots and strings exactly at the extraction boundary', () => {
		const memory = pool();
		for (const value of ['', null, true, 2, [], {}, large(), { emptyKey: { '': large('B') } }]) {
			const manifest = encodeWorkspaceTransfer(value, memory.put);
			expect(hydrateWorkspaceTransfer(manifest, (id) => memory.values.get(id)!)).toEqual(value);
		}
		const below = large().slice(1);
		const source = {
			below,
			at: large(),
			omit: undefined,
			numbers: [undefined, NaN, Infinity, -0],
			date: new Date(0),
			custom: { toJSON: () => ({ nested: large('C'), absent: undefined }) },
		};
		const manifest = encodeWorkspaceTransfer(source, memory.put);
		expect(manifest.strings).toHaveLength(2);
		expect(hydrateWorkspaceTransfer(manifest, (id) => memory.values.get(id)!)).toEqual(
			JSON.parse(JSON.stringify(source)),
		);
		expect(() => encodeWorkspaceTransfer(undefined, memory.put)).toThrow('JSON values');
	});

	it('reassembles astral and lone surrogate text across bounded JSON chunks in both directions', async () => {
		const value = {
			data:
				'A'.repeat(WORKSPACE_TRANSFER_CHUNK_SIZE - 1) +
				'🙂' +
				'\ud800' +
				'B'.repeat(WORKSPACE_TRANSFER_CHUNK_SIZE - 3) +
				'\udfff' +
				'🌍',
			worstEscape: '\ud800'.repeat(WORKSPACE_TRANSFER_CHUNK_SIZE + 1),
		};
		const memory = pool();
		const descriptor = await writeWorkspaceTransfer(value, memory.writer);
		expect(memory.writes[0].chunk.charCodeAt(WORKSPACE_TRANSFER_CHUNK_SIZE - 1)).toBe(0xd83d);
		expect(memory.writes[1].chunk.charCodeAt(0)).toBe(0xde42);
		expect(await readWorkspaceTransfer(descriptor, memory.read)).toEqual(value);
		expect(memory.reads.every((entry) => entry.length <= WORKSPACE_TRANSFER_CHUNK_SIZE)).toBe(true);
	});

	it('chunks metadata larger than a megabyte and preserves dense arrays and all leaf values', async () => {
		const value = Array.from({ length: 1200 }, (_, index) => ({
			index,
			text: 'small'.repeat(200),
			list: [false, 0, '', null],
		}));
		const memory = pool();
		const manifest = encodeWorkspaceTransfer(value, memory.put);
		expect(JSON.stringify(manifest).length).toBeGreaterThan(1024 * 1024);
		const descriptor = describeWorkspaceTransfer(manifest, memory.put);
		expect(descriptor.metadata).not.toHaveProperty('json');
		expect(JSON.stringify(descriptor).length).toBeLessThan(256);
		expect(await readWorkspaceTransfer(descriptor, memory.read)).toEqual(value);
		memory.reads.length = 0;
		const uploaded = await writeWorkspaceTransfer(value, memory.writer);
		expect(uploaded.metadata).not.toHaveProperty('json');
		expect(memory.writes.length).toBeGreaterThan(8);
		expect(memory.writes.every((entry) => entry.kind === 'metadata')).toBe(true);
		expect(await readWorkspaceTransfer(uploaded, memory.read)).toEqual(value);
	});

	it('reuses loaded and newly uploaded media handles on reverse saves and patches', async () => {
		const media = large();
		const added = large('B');
		const memory = pool();
		const cache: WorkspaceTransferCache = new Map();
		const loaded = describeWorkspaceTransfer(
			encodeWorkspaceTransfer({ assets: [media, media] }, memory.put),
			memory.put,
		);
		await readWorkspaceTransfer(loaded, memory.read, cache);
		const descriptor = await writeWorkspaceTransfer(
			{ assets: [media, added, added] },
			memory.writer,
			cache,
		);
		expect(memory.writes.filter((entry) => entry.kind === 'string')).toHaveLength(1);
		expect(await readWorkspaceTransfer(descriptor, memory.read)).toEqual({
			assets: [media, added, added],
		});
		memory.writes.length = 0;
		const patch = await writeWorkspaceTransfer(
			{ changes: { assets: [media, added] } },
			memory.writer,
			cache,
		);
		expect(memory.writes).toHaveLength(0);
		expect(await readWorkspaceTransfer(patch, memory.read)).toEqual({
			changes: { assets: [media, added] },
		});
	});

	it('reads repeated opaque handles from cache and downloads only new strings', async () => {
		const memory = pool();
		const cache: WorkspaceTransferCache = new Map();
		const first = large();
		const second = large('B');
		const firstId = memory.put(first);
		const makeDescriptor = (withNewString: boolean) =>
			describeWorkspaceTransfer(
				{
					version: 1,
					shape: { first: '', ...(withNewString ? { second: '' } : {}) },
					strings: [
						{ id: firstId, length: first.length, paths: [['first']] },
						...(withNewString
							? [{ id: memory.put(second), length: second.length, paths: [['second']] }]
							: []),
					],
				},
				memory.put,
			);
		const initial = makeDescriptor(false);
		expect(await readWorkspaceTransfer(initial, memory.read, cache)).toEqual({ first });
		memory.reads.length = 0;
		expect(await readWorkspaceTransfer(initial, memory.read, cache)).toEqual({ first });
		expect(memory.reads).toHaveLength(0);
		expect(await readWorkspaceTransfer(makeDescriptor(true), memory.read, cache)).toEqual({
			first,
			second,
		});
		expect(memory.reads).toHaveLength(1);
		expect(memory.reads[0].id).not.toBe(firstId);
	});

	it('treats all cached IDs as opaque even when they resemble temporary handles', async () => {
		const memory = pool();
		const first = large();
		const cache: WorkspaceTransferCache = new Map([
			[first, { id: 'pending:0', length: first.length }],
		]);
		memory.values.set('pending:0', first);
		const descriptor = await writeWorkspaceTransfer(
			{ first, added: large('B') },
			memory.writer,
			cache,
		);
		expect(await readWorkspaceTransfer(descriptor, memory.read)).toEqual({
			first,
			added: large('B'),
		});
	});

	it('does not cap a workspace whose hydrated strings collectively exceed one gigabyte', async () => {
		const media = large();
		const value = Array.from({ length: 17_000 }, () => ({ data: media }));
		expect(value.length * media.length).toBeGreaterThan(1024 * 1024 * 1024);
		const memory = pool();
		const manifest = encodeWorkspaceTransfer(value, memory.put);
		expect(manifest.strings).toHaveLength(1);
		expect(manifest.strings[0].paths).toHaveLength(value.length);
		const restored = await readWorkspaceTransfer<typeof value>(
			describeWorkspaceTransfer(manifest, memory.put),
			memory.read,
		);
		expect(restored.length).toBe(value.length);
		expect(restored[0].data).toBe(media);
		expect(restored.at(-1)?.data).toBe(media);
		expect(memory.reads.filter((entry) => entry.id === manifest.strings[0].id)).toHaveLength(1);
	});

	it('keeps every inline descriptor below the conservative per-message bound', () => {
		const memory = pool();
		const manifest = encodeWorkspaceTransfer({ data: '\ud800'.repeat(20_000) }, memory.put);
		const descriptor = describeWorkspaceTransfer(manifest, memory.put);
		expect(descriptor.metadata).toHaveProperty('json');
		expect(Buffer.byteLength(JSON.stringify(descriptor))).toBeLessThan(1024 * 1024);
	});
});

describe('workspace transfer validation', () => {
	const base = (): WorkspaceTransferManifest => ({
		version: 1,
		shape: { item: '', list: [''], '0': '' },
		strings: [{ id: 'opaque', length: WORKSPACE_TRANSFER_STRING_THRESHOLD, paths: [['item']] }],
	});

	it('preserves own prototype-looking JSON keys safely and rejects inherited paths', () => {
		for (const key of ['__proto__', 'constructor', 'prototype']) {
			const shape = JSON.parse(`{"${key}":"${large()}"}`);
			const memory = pool();
			const encoded = encodeWorkspaceTransfer(shape, memory.put);
			const restored = hydrateWorkspaceTransfer<typeof shape>(encoded, (id) =>
				memory.values.get(id)!,
			);
			expect(restored).toEqual(shape);
			expect(Object.hasOwn(restored, key)).toBe(true);
			expect(Object.getPrototypeOf(restored)).toBe(Object.prototype);
			const manifest = base();
			manifest.strings[0].paths = [[key]];
			expect(() => assertWorkspaceTransferManifest(manifest)).toThrow('object path');
		}
		expect(({} as { injected?: boolean }).injected).toBeUndefined();
	});

	it('rejects malformed shapes, missing placeholders, duplicate handles and ambiguous paths', () => {
		const circular: Record<string, unknown> = {};
		circular.child = circular;
		const sparse = new Array(1);
		const extraArray = Object.assign([''], { extra: 'value' });
		for (const shape of [undefined, Infinity, large(), new Date(0), circular, sparse, extraArray])
			expect(() => assertWorkspaceTransferManifest({ ...base(), shape })).toThrow(
				'Invalid workspace transfer',
			);
		for (const paths of [
			[],
			[['missing']],
			[['list', '0']],
			[['list', -1]],
			[['list', 0.5]],
			[['list', 1]],
			[[0]],
			[['item', 'crossed']],
			[['item'], ['item']],
			[[null]],
			'item',
		]) {
			const manifest = base();
			manifest.strings[0].paths = paths as (typeof manifest.strings)[0]['paths'];
			expect(() => assertWorkspaceTransferManifest(manifest)).toThrow('Invalid workspace transfer');
		}
		for (const field of [
			{ id: '' },
			{ id: 'i'.repeat(257) },
			{ length: -1 },
			{ length: 1.5 },
			{ length: Number.MAX_SAFE_INTEGER + 1 },
			{ length: WORKSPACE_TRANSFER_STRING_THRESHOLD - 1 },
			{ extra: true },
		]) {
			const manifest = base();
			Object.assign(manifest.strings[0], field);
			expect(() => assertWorkspaceTransferManifest(manifest)).toThrow('string entry');
		}
		const duplicates = base();
		duplicates.strings.push({ ...duplicates.strings[0], paths: [['0']] });
		expect(() => assertWorkspaceTransferManifest(duplicates)).toThrow('string entry');
		duplicates.strings[1].id = 'different';
		duplicates.strings[1].paths = [['item']];
		expect(() => assertWorkspaceTransferManifest(duplicates)).toThrow('duplicate string path');
		const nonempty = base();
		nonempty.shape = { item: 'original' };
		expect(() => assertWorkspaceTransferManifest(nonempty)).toThrow('empty placeholder');
	});

	it('validates descriptor fields, metadata size, version and exact JSON manifest schema', () => {
		for (const value of [
			null,
			{},
			{ version: 2, metadata: { json: '{}' } },
			{ version: 1, metadata: { json: '{}', id: 'both' } },
			{ version: 1, metadata: { json: 'A'.repeat(WORKSPACE_TRANSFER_INLINE_METADATA_LIMIT + 1) } },
			{ version: 1, metadata: { id: '', length: WORKSPACE_TRANSFER_INLINE_METADATA_LIMIT + 1 } },
			{ version: 1, metadata: { id: 'id', length: WORKSPACE_TRANSFER_INLINE_METADATA_LIMIT } },
			{ version: 1, metadata: { id: 'id', length: Infinity } },
			{ version: 1, metadata: { id: 'id', length: 100_000.5 } },
			{ version: 1, metadata: { id: 'id', length: 200_000 }, extra: true },
		])
			expect(() => assertWorkspaceTransferDescriptor(value)).toThrow('Invalid workspace transfer');
		expect(() => parseWorkspaceTransferManifest('{broken')).toThrow('valid JSON');
		for (const value of [
			{ ...base(), version: 2 },
			{ ...base(), extra: true },
			{ shape: null, strings: [] },
		])
			expect(() => parseWorkspaceTransferManifest(JSON.stringify(value))).toThrow(
				'invalid manifest',
			);
	});

	it('rejects excessive nesting and cycles without serializing hydrated media', () => {
		let deep: unknown = '';
		for (let index = 0; index < 257; index++) deep = { item: deep };
		expect(() => encodeWorkspaceTransfer(deep, () => 'id')).toThrow('nested too deeply');
		expect(() => assertWorkspaceTransferManifest({ version: 1, shape: deep, strings: [] })).toThrow(
			'nested too deeply',
		);
		const cycle: unknown[] = [];
		cycle.push(cycle);
		expect(() => encodeWorkspaceTransfer(cycle, () => 'id')).toThrow('circular');
	});

	it('enforces exact positive chunk ranges and fails on incomplete or oversized reads', async () => {
		const value = large();
		for (const [offset, length] of [
			[-1, 1],
			[0.5, 1],
			[0, 0],
			[0, 1.5],
			[0, WORKSPACE_TRANSFER_CHUNK_SIZE + 1],
			[value.length, 1],
			[Number.MAX_SAFE_INTEGER, 1],
			[0, Infinity],
		])
			expect(() => workspaceTransferChunk(value, offset, length)).toThrow('chunk bounds');
		expect(workspaceTransferChunk(value, 1, value.length - 1)).toBe(value.slice(1));
		const memory = pool();
		const descriptor = describeWorkspaceTransfer(
			encodeWorkspaceTransfer({ data: value }, memory.put),
			memory.put,
		);
		for (const wrong of ['short', value + 'extra', null])
			await expect(readWorkspaceTransfer(descriptor, async () => wrong as string)).rejects.toThrow(
				'chunk',
			);
		const metadataDescriptor = {
			version: 1 as const,
			metadata: { id: 'metadata', length: 200_000 },
		};
		await expect(readWorkspaceTransfer(metadataDescriptor, async () => '{}')).rejects.toThrow(
			'chunk',
		);
		await expect(
			readWorkspaceTransfer(descriptor, async () => {
				throw new Error('Pool expired');
			}),
		).rejects.toThrow('Pool expired');
		expect(() => hydrateWorkspaceTransfer(base(), () => 'short')).toThrow('string length');
	});

	it('rejects invalid provider handles, corrupt cache entries, and failed uploads', async () => {
		const memory = pool();
		expect(() => encodeWorkspaceTransfer({ a: large(), b: large('B') }, () => 'same')).toThrow(
			'duplicate string handle',
		);
		expect(() => encodeWorkspaceTransfer(large(), () => '')).toThrow('string handle');
		const largeMetadata = encodeWorkspaceTransfer(
			Array.from({ length: 200 }, () => 'x'.repeat(1000)),
			memory.put,
		);
		expect(() => describeWorkspaceTransfer(largeMetadata, () => '')).toThrow('metadata handle');
		const corrupt: WorkspaceTransferCache = new Map([[large(), { id: 'id', length: 1 }]]);
		await expect(writeWorkspaceTransfer(large(), memory.writer, corrupt)).rejects.toThrow(
			'cached handle',
		);
		await expect(
			writeWorkspaceTransfer(large(), { ...memory.writer, createString: async () => '' }),
		).rejects.toThrow('string handle');
		const cache: WorkspaceTransferCache = new Map();
		await expect(
			writeWorkspaceTransfer(
				large(),
				{
					...memory.writer,
					writeChunk: async () => {
						throw new Error('Interrupted upload');
					},
				},
				cache,
			),
		).rejects.toThrow('Interrupted upload');
		expect(cache.size).toBe(0);
		await expect(
			writeWorkspaceTransfer(largeMetadata.shape, {
				...memory.writer,
				createMetadata: async () => '',
			}),
		).rejects.toThrow('metadata handle');
	});
});
