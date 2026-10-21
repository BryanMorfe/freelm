import type { ToolDefinition, ToolResult } from '../agent-types';
import { textResult } from './interaction-tools';

export interface CodeGoal {
	id: string;
	objective: string;
	status: 'active' | 'paused' | 'complete' | 'blocked' | 'budget_limited';
	createdAt: number;
	updatedAt: number;
	tokenBudget?: number;
	usedTokens: number;
	estimatedUsage?: boolean;
	elapsedMs: number;
	turns: number;
	/** Suppress idle spinning after a continuation without a tool call. */
	awaitingResume?: boolean;
}
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
	type: 'object',
	properties,
	required,
	additionalProperties: false,
});
export const goalTools: ToolDefinition[] = [
	{
		name: 'get_goal',
		source: 'builtin',
		description: 'Read the current Code task goal, status, token budget, usage and elapsed time.',
		parameters: schema({}),
	},
	{
		name: 'create_goal',
		source: 'builtin',
		description:
			'Create a persistent goal only when the user explicitly requests a goal. Never infer one from an ordinary task. Supply token_budget only when the user requested a budget. An unfinished goal cannot be replaced.',
		parameters: schema(
			{ objective: { type: 'string' }, token_budget: { type: 'integer', minimum: 1 } },
			['objective'],
		),
	},
	{
		name: 'update_goal',
		source: 'builtin',
		description:
			'Update an existing goal to complete only with concrete evidence that the objective is achieved. paused requires an explicit user request. blocked requires the same blocker for at least three consecutive goal turns. Only the user can resume or change budgets; reaching a budget is not completion.',
		parameters: schema({ status: { type: 'string', enum: ['complete', 'blocked', 'paused'] } }, [
			'status',
		]),
	},
];
export const isGoalTool = (name: string) => goalTools.some((tool) => tool.name === name);
export function validCodeGoal(value: unknown): value is CodeGoal {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const g = value as CodeGoal;
	return (
		typeof g.id === 'string' &&
		g.id.length > 0 &&
		g.id.length <= 256 &&
		typeof g.objective === 'string' &&
		!!g.objective.trim() &&
		g.objective.length <= 16000 &&
		['active', 'paused', 'complete', 'blocked', 'budget_limited'].includes(g.status) &&
		[g.createdAt, g.updatedAt, g.usedTokens, g.elapsedMs, g.turns].every(
			(n) => Number.isSafeInteger(n) && n >= 0,
		) &&
		(g.tokenBudget === undefined || (Number.isSafeInteger(g.tokenBudget) && g.tokenBudget > 0)) &&
		(g.estimatedUsage === undefined || typeof g.estimatedUsage === 'boolean') &&
		(g.awaitingResume === undefined || typeof g.awaitingResume === 'boolean')
	);
}
export function createCodeGoal(
	previous: CodeGoal | undefined,
	objective: unknown,
	tokenBudget?: unknown,
): CodeGoal {
	if (previous && previous.status !== 'complete')
		throw new Error(
			'An unfinished goal already exists. Resume, complete, or clear it through the goal controls.',
		);
	if (typeof objective !== 'string' || !objective.trim() || objective.length > 16000)
		throw new Error('Provide a concrete goal of at most 16000 characters.');
	if (tokenBudget !== undefined && (!Number.isSafeInteger(tokenBudget) || Number(tokenBudget) < 1))
		throw new Error('A token budget must be a positive integer.');
	return {
		id: crypto.randomUUID(),
		objective: objective.trim(),
		status: 'active',
		createdAt: Date.now(),
		updatedAt: Date.now(),
		usedTokens: 0,
		elapsedMs: 0,
		turns: 0,
		...(tokenBudget !== undefined ? { tokenBudget: Number(tokenBudget) } : {}),
	};
}
export function accountGoal(
	goal: CodeGoal,
	tokens: number,
	elapsedMs = 0,
	estimated = false,
	completedTurn = false,
): CodeGoal {
	const usedTokens = goal.usedTokens + Math.max(0, Math.ceil(tokens));
	return {
		...goal,
		usedTokens,
		elapsedMs: goal.elapsedMs + Math.max(0, Math.round(elapsedMs)),
		turns: goal.turns + (completedTurn ? 1 : 0),
		updatedAt: Date.now(),
		estimatedUsage: goal.estimatedUsage || estimated,
		...(goal.status === 'active' && goal.tokenBudget !== undefined && usedTokens >= goal.tokenBudget
			? { status: 'budget_limited' as const }
			: {}),
	};
}
export function goalInstructions(goal?: CodeGoal): string {
	if (!goal)
		return 'Persistent goals are optional. Create one only when the user explicitly asks. Normal requests do not create a goal.';
	return `Persistent Code goal: ${goal.objective}\nStatus: ${goal.status}. Token usage: ${goal.usedTokens}${goal.tokenBudget ? ` / ${goal.tokenBudget}` : ' (no token budget)'}${goal.estimatedUsage ? ' (includes local estimates)' : ''}. ${goal.status === 'active' ? 'Continue toward this objective; verify concrete evidence before calling update_goal complete. Keep unresolved work explicit. History and notes survive compaction. If the same blocker repeats for three goal turns and no useful progress remains, mark blocked.' : 'Do not continue this goal unless the user resumes it. A budget limit is not completion.'}`;
}
export function shouldContinueGoal(
	goal: CodeGoal | undefined,
	input: {
		succeeded: boolean;
		interrupted: boolean;
		queued: boolean;
		automatic: boolean;
		usedTools: boolean;
	},
): boolean {
	return (
		!!goal &&
		goal.status === 'active' &&
		!goal.awaitingResume &&
		input.succeeded &&
		!input.interrupted &&
		!input.queued &&
		(!input.automatic || input.usedTools)
	);
}
export async function executeGoalTool(
	name: string,
	args: Record<string, unknown>,
	context: {
		load: () => CodeGoal | undefined;
		write: (goal: CodeGoal) => Promise<void>;
		authorize: (message: string) => Promise<boolean>;
	},
): Promise<ToolResult> {
	const goal = context.load();
	if (name === 'get_goal')
		return textResult({
			goal: goal ?? null,
			remainingTokens:
				goal?.tokenBudget === undefined ? null : Math.max(0, goal.tokenBudget - goal.usedTokens),
		});
	if (name === 'create_goal') {
		if (Object.keys(args).some((key) => !['objective', 'token_budget'].includes(key)))
			throw new Error('Unsupported goal fields.');
		const next = createCodeGoal(goal, args.objective, args.token_budget);
		if (
			!(await context.authorize(
				`Start the persistent goal “${next.objective}”${next.tokenBudget ? ` with a ${next.tokenBudget}-token budget` : ' without a token budget'}? It can continue after a response finishes.`,
			))
		)
			return {
				...textResult('Goal creation was not approved.'),
				isError: true,
				approvalDenied: { reason: 'Goal creation was not approved.' },
			};
		await context.write(next);
		return textResult({ goal: next });
	}
	if (
		name !== 'update_goal' ||
		Object.keys(args).some((key) => key !== 'status') ||
		!['complete', 'paused', 'blocked'].includes(String(args.status))
	)
		throw new Error('Provide a valid goal status.');
	if (!goal) throw new Error('No goal exists for this task.');
	if (goal.status === 'budget_limited')
		throw new Error(
			'This goal reached its budget. Only the user can increase the budget and resume it.',
		);
	if (goal.status !== 'active') throw new Error('Only an active goal can be updated by the model.');
	if (args.status === 'blocked' && goal.turns < 2)
		throw new Error(
			'Do not mark blocked before the same blocker recurs across at least three goal turns.',
		);
	if (args.status === 'paused' && !(await context.authorize('Pause this persistent goal?')))
		return textResult({ goal, paused: false });
	const next = { ...goal, status: args.status as CodeGoal['status'], updatedAt: Date.now() };
	await context.write(next);
	return textResult({ goal: next });
}
