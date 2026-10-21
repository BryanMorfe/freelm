import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type GeometryResult = Record<string, number[][] | string[]>;

// Execute the actual Swift mapping used by the helper: reimplementing its math
// in TS would not catch the CGFloat-to-Double cast that broke native drags.
describe.skipIf(process.platform !== 'darwin')('native Computer Use coordinate geometry', () => {
	let temporary: string;
	let executable: string;
	beforeAll(() => {
		temporary = mkdtempSync(path.join(tmpdir(), 'freelm-computer-geometry-'));
		executable = path.join(temporary, 'geometry-tests');
		const native = fileURLToPath(new URL('../native/', import.meta.url));
		const compiled = spawnSync(
			'/usr/bin/xcrun',
			[
				'swiftc',
				'-module-cache-path',
				path.join(temporary, 'module-cache'),
				path.join(native, 'computer-geometry.swift'),
				path.join(native, 'computer-geometry-tests.swift'),
				'-o',
				executable,
			],
			{ encoding: 'utf8', timeout: 120_000 },
		);
		expect(compiled.error, compiled.stderr).toBeUndefined();
		expect(compiled.status, compiled.stderr).toBe(0);
	}, 125_000);
	afterAll(() => {
		if (temporary) rmSync(temporary, { recursive: true, force: true });
	});
	function run(name: string): GeometryResult {
		const result = spawnSync(executable, [name], { encoding: 'utf8', timeout: 10_000 });
		expect(result.error, result.stderr).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		return JSON.parse(result.stdout);
	}
	it('accepts both reported 1440x880 drags and preserves their exact endpoints', () => {
		const result = run('reported');
		expect(result.vertical).toHaveLength(13);
		expect(result.vertical[0]).toEqual([1315, 369]);
		expect(result.vertical.at(-1)).toEqual([1315, 334]);
		expect(result.vertical[0]).toEqual(result.start[0]);
		expect(result.vertical.at(-1)).toEqual(result.end[0]);
		expect(result.small).toHaveLength(13);
		expect(result.small[0]).toEqual([1196, 439]);
		expect(result.small.at(-1)).toEqual([1206, 449]);
	});
	it('maps Retina image pixels to window points without treating them as screen pixels', () => {
		const result = run('retina');
		expect(result.path).toHaveLength(13);
		expect(result.path[0]).toEqual([609.5, 165]);
		expect(result.path.at(-1)).toEqual([609.5, 147.5]);
	});
	it('handles a secondary display with negative origins and fractional scaling', () => {
		const points = run('secondary').path as number[][];
		expect(points).toHaveLength(4);
		expect(points[0]).toEqual([-1920, -1080]);
		expect(points.at(-1)![0]).toBeCloseTo(-4 / 3);
		expect(points.at(-1)![1]).toBeCloseTo(-4 / 3);
		for (let index = 0; index < points.length; index++) {
			expect(points[index][0]).toBeCloseTo(-1920 + (((1439 * 4) / 3) * index) / 3);
			expect(points[index][1]).toBeCloseTo(-1080 + (((809 * 4) / 3) * index) / 3);
		}
	});
	it('accepts included borders and rejects invalid start, destination, and point coordinates', () => {
		const result = run('borders');
		expect(result.corners).toEqual([
			[296, 139],
			[1735, 1018],
		]);
		for (const key of ['pointErrors', 'startErrors', 'endErrors']) {
			expect(result[key]).toHaveLength(8);
			expect(
				result[key].every((error) => error === 'Coordinates must be inside the observed image.'),
			).toBe(true);
		}
	});
	it('rejects zero image dimensions and non-finite or empty window geometry', () => {
		const result = run('invalid-geometry');
		expect(result.errors).toHaveLength(7);
		expect(
			result.errors.every((error) => error === 'Coordinates must be inside the observed image.'),
		).toBe(true);
	});
	it('returns start plus each interpolation step, including stationary drags, and bounds the count', () => {
		const result = run('steps');
		expect(result.one).toEqual([
			[396, 239],
			[496, 439],
		]);
		expect(result.four).toEqual([
			[396, 239],
			[421, 289],
			[446, 339],
			[471, 389],
			[496, 439],
		]);
		expect(result.stationary).toEqual(Array.from({ length: 13 }, () => [396, 239]));
		expect(result.maximum).toHaveLength(101);
		expect(result.maximum[0]).toEqual([296, 139]);
		expect(result.maximum.at(-1)).toEqual([1735, 1018]);
		expect(result.errors).toEqual(Array(3).fill('Invalid drag step count.'));
	});
});
