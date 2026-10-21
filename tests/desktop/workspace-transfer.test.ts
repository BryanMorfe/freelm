import { describe, expect, it } from 'vitest';
import { WorkspaceTransferPool } from '../../electron/workspace-transfer-pool';
import {
	WORKSPACE_TRANSFER_CHUNK_SIZE,
	readWorkspaceTransfer,
	writeWorkspaceTransfer,
} from '../../src/workspace-transfer';
import { workspaceDesktopBridge } from '../../src/lib/desktop-workspace';
import type { DesktopBridge } from '../../src/types';
import type { WorkspaceTransferBridge } from '../../src/desktop-workspace-types';

const large = 'A'.repeat(3 * WORKSPACE_TRANSFER_CHUNK_SIZE + 5);
const inlineDescriptor = (id: string, length = large.length) => ({
	version: 1,
	metadata: {
		json: JSON.stringify({
			version: 1,
			shape: { data: '' },
			strings: [{ id, length, paths: [['data']] }],
		}),
	},
});

describe('desktop workspace string pool', () => {
	it('transfers a logically multi-gigabyte repeated snapshot without a large IPC result', async () => {
		const pool = new WorkspaceTransferPool();
		const state = { rows: Array.from({ length: 6000 }, () => ({ image: large })) };
		const descriptor = pool.encode(7, state);
		let maximum = 0;
		let reads = 0;
		const actual = await readWorkspaceTransfer<typeof state>(
			descriptor,
			async (id, offset, length) => {
				const chunk = pool.read(7, id, offset, length);
				maximum = Math.max(maximum, chunk.length);
				reads++;
				return chunk;
			},
		);
		expect(actual.rows).toHaveLength(6000);
		expect(actual.rows.every((row) => row.image === large)).toBe(true);
		expect(maximum).toBeLessThanOrEqual(WORKSPACE_TRANSFER_CHUNK_SIZE);
		expect(reads).toBeLessThan(8); // One media string plus metadata, rather than 6000 strings.
	});

	it('isolates pools by renderer identity and removes them on destruction', () => {
		const pool = new WorkspaceTransferPool();
		const descriptor = pool.encode(1, { image: large });
		expect(() => pool.decode(2, descriptor)).toThrow(/no longer available/);
		expect(pool.decode(1, descriptor)).toEqual({ image: large });
		pool.clear(1);
		expect(() => pool.decode(1, descriptor)).toThrow(/no longer available/);
		expect(() => pool.read(1, '/etc/passwd', 0, 10)).toThrow(/identifier/);
	});

	it('rejects out of order, oversized and incomplete upload chunks', () => {
		const pool = new WorkspaceTransferPool();
		const id = pool.create(1, large.length);
		expect(() => pool.write(1, id, 1, 'hello')).toThrow(/out of order/);
		expect(() => pool.write(1, id, 0, 'A'.repeat(WORKSPACE_TRANSFER_CHUNK_SIZE + 1))).toThrow(
			/chunk/,
		);
		expect(() => pool.decode(1, inlineDescriptor(id))).toThrow(/incomplete/);
		pool.write(1, id, 0, 'A');
		expect(() => pool.write(1, id, 0, 'A')).toThrow(/out of order/);
		expect(() => pool.write(1, id, 1, '')).toThrow(/chunk/);
		expect(() => pool.create(1, -1)).toThrow(/length/);
	});

	it('expires abandoned uploads while completed strings survive save errors and cancellation', async () => {
		let now = 0;
		const pool = new WorkspaceTransferPool(() => now);
		const expired = pool.create(1, large.length);
		const cache = new Map();
		const created: string[] = [];
		const create = async (length: number) => {
			const id = pool.create(1, length);
			created.push(id);
			return id;
		};
		const descriptor = await writeWorkspaceTransfer(
			{ image: large },
			{
				createString: create,
				createMetadata: create,
				writeChunk: async (id, offset, text) => pool.write(1, id, offset, text),
				writeMetadataChunk: async (id, offset, text) => pool.write(1, id, offset, text),
			},
			cache,
		);
		pool.release(1, created);
		now = 6 * 60 * 1000;
		expect(() => pool.write(1, expired, 0, 'A')).toThrow(/no longer available/);
		expect(pool.decode(1, descriptor)).toEqual({ image: large });
	});

	it('releases transient metadata without discarding reusable media strings', () => {
		const pool = new WorkspaceTransferPool();
		const state = { image: large, rows: Array.from({ length: 2000 }, () => 'x'.repeat(100)) };
		const descriptor = pool.encode(1, state);
		if (!('id' in descriptor.metadata)) throw new Error('Expected pooled metadata.');
		expect(pool.decode(1, descriptor)).toEqual(state);
		pool.release(1, [descriptor.metadata.id]);
		expect(() => pool.decode(1, descriptor)).toThrow(/no longer available/);
		expect(pool.decode(1, pool.encode(1, { image: large }))).toEqual({ image: large });
	});
});

describe('renderer desktop workspace façade', () => {
	it('coalesces startup loads and reuses handles on later reads, saves, patches and backups', async () => {
		const pool = new WorkspaceTransferPool();
		let opens = 0;
		let chunkReads = 0;
		let uploads = 0;
		const saved: { operation: string; args: unknown[]; value: unknown }[] = [];
		const snapshot = { revision: 'revision', state: { gallery: [large, large] } };
		const transport: WorkspaceTransferBridge = {
			open: async () => {
				opens++;
				return pool.encode(1, snapshot);
			},
			read: async (id, offset, length) => {
				chunkReads++;
				return pool.read(1, id, offset, length);
			},
			create: async (length, kind) => {
				uploads++;
				return pool.create(1, length, kind);
			},
			write: async (id, offset, text) => pool.write(1, id, offset, text),
			commit: async (operation, args, descriptor) => {
				saved.push({ operation, args, value: pool.decode(1, descriptor) });
				if (operation === 'workspace-backup') return '/fixture/recovery.json';
				return { revision: 'next' };
			},
			release: async (ids) => pool.release(1, ids),
		};
		const bridge = workspaceDesktopBridge({ workspaceTransfer: transport } as DesktopBridge);
		const [first, second] = await Promise.all([
			bridge.workspaceLoad('local'),
			bridge.workspaceLoad('local'),
		]);
		expect(opens).toBe(1);
		expect(first).toEqual(snapshot);
		expect(second).toEqual(first);
		const initialReads = chunkReads;
		await bridge.workspaceLoad('local');
		expect(chunkReads).toBe(initialReads);
		await bridge.workspaceSave('local', 'revision', first.state!);
		await bridge.workspacePatch!('local', 'revision', { changes: { threads: [] } });
		expect(await bridge.workspaceBackup(first.state!)).toBe('/fixture/recovery.json');
		expect(uploads).toBe(0);
		expect(saved.map((entry) => entry.operation)).toEqual([
			'workspace-save',
			'workspace-patch',
			'workspace-backup',
		]);
		expect(saved[0].value).toEqual(snapshot.state);
	});
	it('uses the original bridge when bounded transport is unavailable', () => {
		const original = {} as DesktopBridge;
		expect(workspaceDesktopBridge(original)).toBe(original);
	});
});
