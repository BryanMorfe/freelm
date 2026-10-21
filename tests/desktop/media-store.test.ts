import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as jsonFile from '../../electron/json-file';
import { MediaStore } from '../../electron/media-store';

const folders: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(
		folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
	);
});

describe('cooperative media encoding', () => {
	it('allows event-loop work during large serialization and produces exactly the existing bytes', async () => {
		const text = 'A'.repeat(16 * 1024 - 1) + '😀\"\\\n\0\ud800' + 'B'.repeat(4 * 1024 * 1024);
		let ticks = 0,
			finished = false;
		const seenTicks = new Set<number>();
		let heartbeat: NodeJS.Immediate;
		const tick = () => {
			ticks++;
			if (!finished) heartbeat = setImmediate(tick);
		};
		heartbeat = setImmediate(tick);
		try {
			const payload = await jsonFile.jsonPayloadAsync(text, false, () => seenTicks.add(ticks));
			const expected = JSON.stringify(text);
			expect(seenTicks.size).toBeGreaterThan(2);
			expect(payload.bytes).toBe(Buffer.byteLength(expected));
			expect([...payload.parts()].join('')).toBe(expected);
		} finally {
			finished = true;
			clearImmediate(heartbeat);
		}
	});

	it('preserves content hashes, full originals, and warm immutable media reuse', async () => {
		const folder = await mkdtemp(path.join(tmpdir(), 'freelm-cooperative-media-'));
		folders.push(folder);
		const media = new MediaStore(folder);
		const original = 'data:image/png;base64,' + 'A'.repeat(2 * 1024 * 1024);
		const image = { id: 'image', assets: [{ url: original }] };
		const workspace = {
			format: 'freelm-workspace-v2' as const,
			version: 1,
			threads: [],
			projects: [],
			generations: [image],
		};
		const encode = vi.spyOn(jsonFile, 'jsonPayloadAsync');
		const encoded = await media.encodeWorkspace(workspace);
		expect(encoded.format).toBe('freelm-workspace-v3');
		if (encoded.format !== 'freelm-workspace-v3') throw new Error('Expected externalized media.');
		const hash = createHash('sha256').update(JSON.stringify(original), 'utf8').digest('hex');
		expect(encoded.blobs).toEqual([
			{ path: ['generations', '0', 'assets', '0', 'url'], hash, characters: original.length },
		]);
		expect(await readFile(path.join(folder, `${hash}.json`), 'utf8')).toBe(
			JSON.stringify(original),
		);
		expect(encode).toHaveBeenCalledTimes(1);
		const changed = await media.encodeWorkspace({ ...workspace, threads: [{ id: 'new-chat' }] });
		expect(changed).toMatchObject({ format: 'freelm-workspace-v3', blobs: encoded.blobs });
		expect(encode).toHaveBeenCalledTimes(1);
		expect(workspace.generations[0].assets[0].url).toBe(original);
		const loaded = await new MediaStore(folder).hydrate(JSON.parse(JSON.stringify(encoded)));
		expect(loaded).toEqual(workspace);
	});
});
