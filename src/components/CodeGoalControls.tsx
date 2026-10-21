import { userFacingError } from '../lib/user-facing-error';
import { useState } from 'react';
import { Flag, Pause, Play, X } from 'lucide-react';
import type { CodeGoal } from '../lib/code-goals';
import { createCodeGoal } from '../lib/code-goals';
import './code-goal-controls.css';

export default function CodeGoalControls({
	goal,
	onChange,
}: {
	goal?: CodeGoal;
	onChange: (goal?: CodeGoal) => void;
}) {
	const [editing, setEditing] = useState(false);
	const [objective, setObjective] = useState('');
	const [budget, setBudget] = useState('');
	const [error, setError] = useState('');
	return (
		<section className="code-goal-controls" aria-label="Persistent goal">
			<div className="code-goal-line">
				<Flag size={15} aria-hidden="true" />
				{goal ? (
					<>
						<span className="code-goal-objective" title={goal.objective}>
							{goal.objective}
						</span>
						<span className="code-goal-status">
							{goal.awaitingResume && goal.status === 'active'
								? 'Ready to resume'
								: goal.status.replace('_', ' ')}{' '}
							· {goal.estimatedUsage ? '~' : ''}
							{goal.usedTokens.toLocaleString()}
							{goal.tokenBudget ? ` / ${goal.tokenBudget.toLocaleString()}` : ''} tokens
						</span>
						{goal.status === 'active' && !goal.awaitingResume ? (
							<button
								aria-label="Pause goal"
								title="Pause goal"
								onClick={() => onChange({ ...goal, status: 'paused', updatedAt: Date.now() })}
							>
								<Pause size={15} />
							</button>
						) : goal.status !== 'complete' && goal.status !== 'budget_limited' ? (
							<button
								aria-label="Resume goal"
								title="Resume goal"
								onClick={() =>
									onChange({
										...goal,
										status: 'active',
										awaitingResume: false,
										turns: goal.status === 'blocked' ? 0 : goal.turns,
										updatedAt: Date.now(),
									})
								}
							>
								<Play size={15} />
							</button>
						) : null}
						{goal.status === 'budget_limited' && (
							<button
								onClick={() => {
									setBudget(String(goal.tokenBudget ?? ''));
									setObjective(goal.objective);
									setEditing(true);
								}}
							>
								Change budget
							</button>
						)}
						<button aria-label="Clear goal" title="Clear goal" onClick={() => onChange(undefined)}>
							<X size={15} />
						</button>
					</>
				) : (
					<button
						onClick={() => {
							setEditing(!editing);
							setObjective('');
							setBudget('');
							setError('');
						}}
					>
						Add goal
					</button>
				)}
			</div>
			{editing && (
				<form
					className="code-goal-editor"
					onSubmit={(event) => {
						event.preventDefault();
						try {
							const value = budget.trim() ? Number(budget) : undefined;
							if (goal?.status === 'budget_limited') {
								if (
									value !== undefined &&
									(!Number.isSafeInteger(value) || value <= goal.usedTokens)
								)
									throw new Error('Set a budget above the tokens already used, or leave it blank.');
								onChange({
									...goal,
									tokenBudget: value,
									status: 'active',
									awaitingResume: false,
									updatedAt: Date.now(),
								});
							} else onChange(createCodeGoal(goal, objective, value));
							setEditing(false);
							setError('');
						} catch (reason) {
							setError(reason instanceof Error ? reason.message : String(reason));
						}
					}}
				>
					{goal?.status !== 'budget_limited' && (
						<input
							aria-label="Goal objective"
							placeholder="What outcome should the agent keep working toward?"
							value={objective}
							onChange={(event) => setObjective(event.target.value)}
							maxLength={16000}
						/>
					)}
					<input
						aria-label="Goal token budget"
						type="number"
						min="1"
						step="1"
						placeholder="Token budget (optional)"
						value={budget}
						onChange={(event) => setBudget(event.target.value)}
					/>
					<div className="code-goal-actions">
						<button type="button" onClick={() => setEditing(false)}>
							Cancel
						</button>
						<button type="submit">
							{goal?.status === 'budget_limited' ? 'Resume goal' : 'Set goal'}
						</button>
					</div>
					{error && <p role="alert">{userFacingError(error)}</p>}
				</form>
			)}
		</section>
	);
}
