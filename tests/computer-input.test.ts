import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Compile the production event preparation path. No test calls its post route,
// requests privacy access, activates an app, or shows a window.
describe.skipIf(process.platform !== 'darwin')('native Computer Use event preparation', () => {
	let temporary: string;
	let executable: string;
	beforeAll(() => {
		temporary = mkdtempSync(path.join(tmpdir(), 'freelm-computer-input-'));
		executable = path.join(temporary, 'input-tests');
		const native = fileURLToPath(new URL('../native/', import.meta.url));
		const compiled = spawnSync(
			'/usr/bin/xcrun',
			[
				'swiftc',
				'-module-cache-path',
				path.join(temporary, 'module-cache'),
				path.join(native, 'computer-geometry.swift'),
				path.join(native, 'computer-input.swift'),
				path.join(native, 'computer-input-tests.swift'),
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
	function run(name: string) {
		const result = spawnSync(executable, [name], { encoding: 'utf8', timeout: 10_000 });
		expect(result.error, result.stderr).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		return JSON.parse(result.stdout);
	}
	it('reports lock, inactive session, and sleeping displays without inventing unknown state', () => {
		const result = run('environment');
		expect(result.unknown).toEqual({ blocked: false });
		expect(result.noDisplays).toEqual({ blocked: false });
		expect(result.awake).toEqual({ sessionActive: true, displaysAwake: true, blocked: false });
		expect(result.locked).toMatchObject({
			screenLocked: true,
			blocked: true,
			message: expect.stringContaining('Mac is locked'),
		});
		expect(result.otherSession).toMatchObject({
			sessionActive: false,
			blocked: true,
			message: expect.stringContaining('user session is not active'),
		});
		expect(result.loggedOut).toMatchObject({ sessionActive: false, blocked: true });
		expect(result.asleep).toMatchObject({
			displaysAwake: false,
			blocked: true,
			message: expect.stringContaining('displays are asleep'),
		});
		expect(result.oneAwake).toEqual({ screenLocked: false, displaysAwake: true, blocked: false });
	});
	it('keeps global and window-local pointer coordinates distinct without changing event semantics', () => {
		const { events } = run('pointer');
		expect(events.map((event: { type: number }) => event.type)).toEqual([5, 1, 2, 6]);
		for (const event of events) {
			expect(event.global).toEqual([1315, 369]);
			expect(event.local).toEqual([1019, 230]);
			expect(event.pid).toBe(1234);
			expect(event.window).toBe(5678);
			expect(event.underPointer).toBe(5678);
			expect(event.canHandle).toBe(5678);
			expect(event.eventNumber).toBe(42);
			expect(event.clickCount).toBe(2);
			expect(event.subtype).toBe(0);
			expect(event.flags).toBe(0x20000);
			expect(event.freshTimestamp).toBe(true);
		}
	});
	it('routes both scroll axes to the window-local point', () => {
		const event = run('scroll');
		expect(event.type).toBe(22);
		expect(event.global).toEqual([1315, 369]);
		expect(event.local).toEqual([1019, 230]);
		expect(event.vertical).toBe(135);
		expect(event.horizontal).toBe(-72);
	});
	it('preserves fractional points and negative display origins', () => {
		const event = run('secondary');
		expect(event.global).toEqual([-543.25, -234.5]);
		expect(event.local).toEqual([1376.75, 845.5]);
	});
	it('assigns fresh keyboard timestamps without changing Unicode or modifiers', () => {
		const event = run('keyboard');
		expect(event.type).toBe(10);
		expect(event.pid).toBe(1234);
		expect(event.window).toBe(5678);
		expect(event.unicode).toBe('A🦉');
		expect(event.flags).toBe(0x20000);
		expect(event.freshTimestamp).toBe(true);
		expect(event.existingTimestamp).toBe(123456789);
	});
	it('rejects invalid target identities, geometry, and non-finite coordinates', () => {
		const result = run('invalid');
		expect(result.targets).toEqual([true, true, true, true]);
		expect(result.points).toEqual([true, true, true, true, true, true]);
	});
	it('roundtrips into the correct AppKit point in an unshown own window', () => {
		const result = run('roundtrip');
		expect(result.available).toBe(true);
		expect(result.local).toEqual([200, 100]);
		expect(result.globalMatches).toBe(true);
		expect(result.privateLocationMatches).toBe(true);
		expect(result.windowMatches).toBe(true);
		expect(result.windowVisible).toBe(false);
		expect(result.appActive).toBe(false);
	});
});
