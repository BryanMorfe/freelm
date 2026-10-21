import { describe, expect, it, vi } from 'vitest';
import {
	accountGoal,
	createCodeGoal,
	executeGoalTool,
	goalInstructions,
	shouldContinueGoal,
	validCodeGoal,
} from '../src/lib/code-goals';
import { initialState, recoverState } from '../src/lib/state';
import { validateState } from '../electron/validation';

describe('persistent Code goals', () => {
	it('stores objectives and explicit budgets in the workspace and waits for resume after reload', () => {
		const state = initialState();
		const goal = createCodeGoal(undefined, 'Make the correctness suite pass', 32000);
		state.threads = [
			{
				id: 'code',
				kind: 'code',
				title: 'Task',
				connectionId: state.connections[0].id,
				model: 'model',
				createdAt: 1,
				updatedAt: 1,
				messages: [],
				goal,
			},
		];
		validateState(state);
		const restored = recoverState(JSON.parse(JSON.stringify(state)));
		expect(restored.threads[0].goal).toMatchObject({
			objective: goal.objective,
			tokenBudget: 32000,
			status: 'active',
			awaitingResume: true,
		});
		expect(validCodeGoal({ ...goal, tokenBudget: -1 })).toBe(false);
	});
	it('never replaces an unfinished objective and supports unlimited goals', () => {
		const goal = createCodeGoal(undefined, 'Build it');
		expect(goal.tokenBudget).toBeUndefined();
		expect(() => createCodeGoal(goal, 'Other')).toThrow('unfinished');
		expect(createCodeGoal({ ...goal, status: 'complete' }, 'Other').objective).toBe('Other');
	});
	it('accounts usage and distinguishes budget limits from completion', () => {
		let goal = createCodeGoal(undefined, 'Keep going', 100);
		goal = accountGoal(goal, 75, 1000, true, true);
		expect(goal).toMatchObject({
			usedTokens: 75,
			elapsedMs: 1000,
			estimatedUsage: true,
			turns: 1,
			status: 'active',
		});
		goal = accountGoal(goal, 25);
		expect(goal.status).toBe('budget_limited');
		expect(goalInstructions(goal)).toContain('not completion');
	});
	it('continues idle successful work but never spins after an empty automatic turn', () => {
		const goal = createCodeGoal(undefined, 'Finish');
		const base = {
			succeeded: true,
			interrupted: false,
			queued: false,
			automatic: true,
			usedTools: true,
		};
		expect(shouldContinueGoal(goal, base)).toBe(true);
		for (const patch of [
			{ succeeded: false },
			{ interrupted: true },
			{ queued: true },
			{ usedTools: false },
		])
			expect(shouldContinueGoal(goal, { ...base, ...patch })).toBe(false);
		for (const status of ['paused', 'blocked', 'complete', 'budget_limited'] as const)
			expect(shouldContinueGoal({ ...goal, status }, base)).toBe(false);
	});
	it('checks authorization before activating a model-created goal', async () => {
		const write = vi.fn();
		const result = await executeGoalTool(
			'create_goal',
			{ objective: 'Do the work' },
			{ load: () => undefined, write, authorize: async () => false },
		);
		expect(result.approvalDenied).toBeDefined();
		expect(write).not.toHaveBeenCalled();
	});
	it('rejects premature blocking and model resume/budget changes', async () => {
		const goal = createCodeGoal(undefined, 'Finish');
		const ctx = { load: () => goal, write: vi.fn(), authorize: async () => true };
		await expect(executeGoalTool('update_goal', { status: 'blocked' }, ctx)).rejects.toThrow(
			'three',
		);
		await expect(executeGoalTool('update_goal', { status: 'active' }, ctx)).rejects.toThrow(
			'valid',
		);
		await expect(
			executeGoalTool('update_goal', { status: 'complete', token_budget: 999 }, ctx),
		).rejects.toThrow('valid');
		await executeGoalTool('update_goal', { status: 'complete' }, ctx);
		expect(ctx.write).toHaveBeenCalledWith(expect.objectContaining({ status: 'complete' }));
	});
});
