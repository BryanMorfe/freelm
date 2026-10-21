import { userFacingError } from '../lib/user-facing-error';
import { useState } from 'react';
import {
	AlertCircle,
	Check,
	ChevronDown,
	LoaderCircle,
	ShieldQuestion,
	Square,
} from 'lucide-react';
import type { BotJobView } from '../bot-types';
import './bot-jobs.css';

export type BotJobAction = 'job-approve' | 'job-deny' | 'job-cancel';
export interface BotJobItem extends BotJobView {
	/** Routing identity is derived from the owning host snapshot, never from tool arguments. */
	ownerTargetId: string;
	ownerName: string;
	botName?: string;
	connected: boolean;
}
interface Props {
	jobs: readonly BotJobItem[];
	history?: boolean;
	onAction?: (job: BotJobItem, action: BotJobAction) => Promise<void> | void;
}
const terminal = new Set<BotJobView['status']>([
	'succeeded',
	'failed',
	'outcome_unknown',
	'cancelled',
]);
const labels: Record<BotJobView['status'], string> = {
	pending: 'Queued',
	running: 'Running',
	awaiting_approval: 'Needs approval',
	succeeded: 'Completed',
	failed: 'Couldn’t complete',
	outcome_unknown: 'Outcome needs checking',
	cancelled: 'Stopped',
};

/** The drawer keeps work visible without blocking the conversation or composer. */
export default function BotJobs({ jobs, history = false, onAction }: Props) {
	const visible = jobs.filter((job) => history || !['succeeded', 'cancelled'].includes(job.status));
	if (!visible.length) return null;
	return (
		<section
			className={`bot-jobs${history ? ' bot-jobs-history' : ''}`}
			aria-label={history ? 'Task history' : 'Background work'}
		>
			{history && <h3>Task history</h3>}
			{visible.map((job) => (
				<BotJobRow key={`${job.ownerTargetId}:${job.id}`} job={job} onAction={onAction} />
			))}
		</section>
	);
}
function BotJobRow({ job, onAction }: { job: BotJobItem; onAction?: Props['onAction'] }) {
	const [expanded, setExpanded] = useState(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState('');
	const failed = job.status === 'failed' || job.status === 'outcome_unknown';
	const Icon =
		job.status === 'awaiting_approval'
			? ShieldQuestion
			: failed
				? AlertCircle
				: job.status === 'succeeded'
					? Check
					: job.status === 'cancelled'
						? Square
						: LoaderCircle;
	const act = async (action: BotJobAction) => {
		if (!onAction || pending || !job.connected) return;
		setPending(true);
		setError('');
		try {
			await onAction(job, action);
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : 'Could not update this job.');
		} finally {
			setPending(false);
		}
	};
	return (
		<div
			className={`bot-job${failed ? ' bot-job-error' : ''}`}
			role="group"
			aria-label={`${job.title}: ${labels[job.status]}`}
		>
			<div className="bot-job-line">
				<button
					type="button"
					className="bot-job-summary"
					aria-expanded={expanded}
					onClick={() => setExpanded((value) => !value)}
				>
					<Icon
						size={16}
						className={job.status === 'running' ? 'bot-job-spinner' : undefined}
						aria-hidden="true"
					/>
					<span className="bot-job-title">{job.title}</span>
					<span className="bot-job-status">{labels[job.status]}</span>
					<ChevronDown size={14} className={expanded ? 'expanded' : undefined} aria-hidden="true" />
				</button>
				{onAction && !terminal.has(job.status) && (
					<div className="bot-job-actions">
						{job.status === 'awaiting_approval' ? (
							<>
								<button
									type="button"
									className="secondary-button"
									disabled={pending || !job.connected}
									onClick={() => void act('job-deny')}
								>
									Deny
								</button>
								<button
									type="button"
									className="primary-button"
									disabled={pending || !job.connected}
									onClick={() => void act('job-approve')}
								>
									Approve
								</button>
							</>
						) : (
							<button
								type="button"
								className="secondary-button"
								disabled={pending || !job.connected}
								onClick={() => void act('job-cancel')}
							>
								Stop job
							</button>
						)}
					</div>
				)}
			</div>
			{expanded && (
				<div className="bot-job-detail">
					<p>
						{job.botName ? `${job.botName} · ` : ''}
						{job.ownerName}
						{!job.connected ? ' · Disconnected' : ''}
					</p>
					{job.status === 'awaiting_approval' && (
						<p>
							Approve this action with the arguments below. Access to a plugin does not approve
							every action.
						</p>
					)}
					{job.status === 'outcome_unknown' && (
						<p>
							The outcome could not be confirmed. This action may have taken effect; check its
							result before trying it again.
						</p>
					)}
					<code>{job.toolName}</code>
					{job.args && <pre>{JSON.stringify(job.args, null, 2)}</pre>}
					{job.error && <p className="bot-job-error-text">{userFacingError(job.error)}</p>}
					{!terminal.has(job.status) && (
						<p>
							Stopping a reply leaves this job running. Stopping this job does not undo work or stop
							a task already sent to Chat or Code.
						</p>
					)}
				</div>
			)}
			{error && (
				<p className="bot-job-action-error" role="alert">
					{userFacingError(error)}
				</p>
			)}
		</div>
	);
}
