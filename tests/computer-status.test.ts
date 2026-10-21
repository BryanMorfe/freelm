import { describe, expect, it } from 'vitest';
import type { ComputerStatus } from '../src/computer-types';
import { computerEnvironmentIssue, computerReady } from '../src/lib/computer-status';

const ready: ComputerStatus = {
	platform: 'darwin',
	available: true,
	accessibility: true,
	screenRecording: true,
};

describe('Computer Use environment status', () => {
	it.each([
		[{ screenLocked: true }, 'Unlock it'],
		[{ sessionActive: false }, 'Switch back to this user session'],
		[{ displaysAwake: false }, 'Wake a display'],
	] as const)(
		'gives actionable guidance for %j without changing permission flags',
		(environment, guidance) => {
			const status = { ...ready, ...environment };
			expect(computerEnvironmentIssue(status)?.message).toContain(guidance);
			expect(computerReady(status)).toBe(false);
			expect(status.accessibility).toBe(true);
			expect(status.screenRecording).toBe(true);
		},
	);

	it('prioritizes unlock before session activation and display wake', () => {
		expect(
			computerEnvironmentIssue({
				...ready,
				screenLocked: true,
				sessionActive: false,
				displaysAwake: false,
			})?.title,
		).toBe('Mac is locked');
		expect(
			computerEnvironmentIssue({ ...ready, sessionActive: false, displaysAwake: false })?.title,
		).toBe('User session is inactive');
	});

	it('does not treat missing environment probes as false', () => {
		for (const platform of ['darwin', 'linux']) {
			const status = { ...ready, platform };
			expect(computerEnvironmentIssue(status)).toBeUndefined();
			expect(computerReady(status)).toBe(true);
		}
		expect(
			computerReady({ ...ready, screenLocked: false, sessionActive: true, displaysAwake: true }),
		).toBe(true);
	});

	it('still requires available capabilities and OS permissions', () => {
		for (const key of ['available', 'accessibility', 'screenRecording'] as const)
			expect(computerReady({ ...ready, [key]: false })).toBe(false);
		expect(computerReady(undefined)).toBe(false);
	});
});
