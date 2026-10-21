import { describe, expect, it } from 'vitest';
import { PluginCpuBudget } from '../../electron/plugins/cpu-budget';

function fixture(slice = 200) {
	const time = { wall: 0, cpu: 0 };
	const budget = new PluginCpuBudget(slice, { wall: () => time.wall, cpu: () => time.cpu });
	return { time, budget };
}
describe('plugin worker CPU accounting', () => {
	it('does not charge a suspended worker or host wait as guest CPU', () => {
		const { time, budget } = fixture();
		budget.begin(); time.wall += 350; time.cpu += 3;
		expect(budget.exceeded()).toBe(false); budget.end();
		time.wall += 8000; // No synchronous interpreter execution during provider I/O.
		budget.begin(); time.wall += 5; time.cpu += 5;
		expect(budget.exceeded()).toBe(false);
	});
	it('enforces the per-turn CPU limit regardless of scheduling delay', () => {
		const { time, budget } = fixture();
		budget.begin(); time.wall += 700; time.cpu += 201;
		expect(budget.exceeded()).toBe(true);
	});
	it('bounds aggregate CPU across callbacks and resets the ten-second window', () => {
		const { time, budget } = fixture(1000);
		for (let i = 0; i < 4; i++) {
			budget.begin(); time.wall += 500; time.cpu += 500;
			expect(budget.exceeded()).toBe(false); budget.end();
		}
		budget.begin(); time.wall += 1; time.cpu += 1;
		expect(budget.exceeded()).toBe(true); budget.end();
		time.wall = 10_000; budget.begin(); time.wall += 5; time.cpu += 5;
		expect(budget.exceeded()).toBe(false);
	});
	it('retains an independent five-second wall guard', () => {
		const { time, budget } = fixture();
		budget.begin(); time.wall += 5001; time.cpu += 1;
		expect(budget.exceeded()).toBe(true);
	});
});
