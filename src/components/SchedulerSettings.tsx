import { userFacingError } from '../lib/user-facing-error';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
	Bell,
	Bot,
	CalendarClock,
	Check,
	Clock3,
	LoaderCircle,
	Pause,
	Play,
	Plus,
	RefreshCw,
	SquareTerminal,
	Trash2,
} from 'lucide-react';
import type {
	SchedulerBridge,
	SchedulerCommand,
	SchedulerJob,
	SchedulerOccurrence,
	SchedulerSnapshot,
} from '../scheduler-types';
import type { Thread } from '../types';
import { SettingsGroup, SettingsRow } from './SettingsList';
import Select from './Select';
import './scheduler-settings.css';

const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const kinds = [
	{ value: 'once', label: 'Once' },
	{ value: 'interval', label: 'At an interval' },
	{ value: 'daily', label: 'Every day' },
	{ value: 'weekly', label: 'Every week' },
];
const emptySnapshot: SchedulerSnapshot = { jobs: [], occurrences: [] };

function localZone() {
	return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}
function localDateTime(value: number) {
	const date = new Date(value);
	return new Date(value - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
function displayDate(value?: number) {
	return value === undefined
		? ''
		: new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
function scheduleDescription(job: SchedulerJob) {
	const schedule = job.schedule;
	if (schedule.kind === 'once') return `Once · ${displayDate(new Date(schedule.at!).getTime())}`;
	if (schedule.kind === 'interval')
		return `Every ${schedule.intervalMinutes} minute${schedule.intervalMinutes === 1 ? '' : 's'}`;
	const cadence =
		schedule.kind === 'daily'
			? 'Daily'
			: (schedule.weekdays || []).map((day) => days[day].slice(0, 3)).join(', ');
	return `${cadence} at ${schedule.time} · ${schedule.timezone || 'UTC'}`;
}
function jobMessage(job: SchedulerJob) {
	return job.target.kind === 'reminder' ? job.target.message : job.target.prompt;
}
function JobIcon({ job }: { job: SchedulerJob }) {
	const Icon =
		job.target.kind === 'reminder' ? Bell : job.target.kind === 'bot' ? Bot : SquareTerminal;
	return <Icon size={18} aria-hidden="true" />;
}
function outcomeLabel(occurrence: SchedulerOccurrence) {
	switch (occurrence.status) {
		case 'pending':
			return 'Scheduled';
		case 'dispatching':
			return 'Sending';
		case 'waiting':
			return 'Waiting to send';
		case 'delivered':
			return 'Delivered';
		case 'admitted':
			return occurrence.jobSnapshot.target.kind === 'bot' ? 'Sent to bot' : 'Sent to Code';
		case 'failed':
			return 'Couldn’t send';
		case 'cancelled':
			return 'Cancelled';
		case 'dismissed':
			return 'Dismissed';
	}
}

function ScheduleEditor({
	job,
	busy,
	onSave,
	onCancel,
}: {
	job?: SchedulerJob;
	busy: boolean;
	onSave: (command: SchedulerCommand) => Promise<boolean>;
	onCancel: () => void;
}) {
	const [title, setTitle] = useState(job?.title || '');
	const [message, setMessage] = useState(job ? jobMessage(job) : '');
	const [kind, setKind] = useState(job?.schedule.kind || 'once');
	const [at, setAt] = useState(() =>
		localDateTime(
			job?.schedule.at ? new Date(job.schedule.at).getTime() : Date.now() + 60 * 60_000,
		),
	);
	const [interval, setInterval] = useState(String(job?.schedule.intervalMinutes || 60));
	const [time, setTime] = useState(job?.schedule.time || '09:00');
	const [timezone, setTimezone] = useState(job?.schedule.timezone || localZone());
	const [weekdays, setWeekdays] = useState(job?.schedule.weekdays || [new Date().getDay()]);
	const [missed, setMissed] = useState(
		job?.schedule.missed || (job && job.schedule.kind !== 'once' ? 'skip' : 'once'),
	);
	const [overlap, setOverlap] = useState(job?.schedule.overlap || 'skip');
	const [error, setError] = useState('');
	const idempotencyKey = useRef(crypto.randomUUID());
	const reminder = !job || job.target.kind === 'reminder';
	// Compare the editable values, not serialized backend defaults. An instruction
	// edit must not reset interval anchors, round timestamps, or reschedule work.
	const scheduleIdentity = JSON.stringify([
		kind,
		missed,
		overlap,
		kind === 'once'
			? at
			: kind === 'interval'
				? Number(interval)
				: [time, timezone.trim(), kind === 'weekly' ? [...weekdays].sort() : null],
	]);
	const initialScheduleIdentity = useRef(scheduleIdentity);
	async function submit(event: FormEvent) {
		event.preventDefault();
		setError('');
		if (!title.trim() || !message.trim()) {
			setError('Enter a title and a message.');
			return;
		}
		const schedule: SchedulerJob['schedule'] = { kind, missed, overlap };
		const scheduleChanged = !job || scheduleIdentity !== initialScheduleIdentity.current;
		if (kind === 'once') {
			const timestamp = new Date(at).getTime();
			if (!Number.isFinite(timestamp) || (scheduleChanged && timestamp <= Date.now())) {
				setError('Choose a future date and time.');
				return;
			}
			schedule.at = timestamp;
			schedule.timezone = localZone();
		} else if (kind === 'interval') {
			const minutes = Number(interval);
			if (!Number.isFinite(minutes) || minutes < 1) {
				setError('Use an interval of at least one minute.');
				return;
			}
			schedule.intervalMinutes = minutes;
			if (job?.schedule.kind === 'interval' && job.schedule.at !== undefined)
				schedule.at = job.schedule.at;
		} else {
			try {
				new Intl.DateTimeFormat('en', { timeZone: timezone.trim() }).format();
			} catch {
				setError('Enter a valid time zone, such as America/New_York.');
				return;
			}
			if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
				setError('Choose a valid time.');
				return;
			}
			if (kind === 'weekly' && !weekdays.length) {
				setError('Choose at least one day.');
				return;
			}
			schedule.time = time;
			schedule.timezone = timezone.trim();
			if (kind === 'weekly') schedule.weekdays = weekdays;
		}
		const target: SchedulerJob['target'] =
			job?.target.kind === 'bot' || job?.target.kind === 'code'
				? { ...job.target, prompt: message.trim() }
				: { ...job?.target, kind: 'reminder', message: message.trim() };
		const values = { title: title.trim(), schedule, target };
		if (
			await onSave(
				job
					? {
							type: 'update',
							id: job.id,
							patch: { title: values.title, target, ...(scheduleChanged ? { schedule } : {}) },
						}
					: { type: 'create', job: values, idempotencyKey: idempotencyKey.current },
			)
		)
			onCancel();
	}
	return (
		<form
			className="scheduler-editor"
			aria-label={job ? 'Edit scheduled task' : 'New reminder'}
			onSubmit={submit}
		>
			<SettingsGroup
				title={job ? 'Edit scheduled task' : 'New reminder'}
				description={
					job
						? 'The destination stays the same. Changes apply to future runs.'
						: 'A reminder delivers your message without running a model.'
				}
			>
				<fieldset disabled={busy}>
					<SettingsRow label="Title" htmlFor="schedule-title">
						<input
							id="schedule-title"
							autoFocus
							value={title}
							onChange={(event) => setTitle(event.target.value)}
							maxLength={200}
							required
						/>
					</SettingsRow>
					<SettingsRow
						label={reminder ? 'Message' : 'Instructions'}
						htmlFor="schedule-message"
						layout="stacked"
					>
						<textarea
							id="schedule-message"
							rows={3}
							value={message}
							onChange={(event) => setMessage(event.target.value)}
							maxLength={reminder ? 16_000 : 32_000}
							required
						/>
					</SettingsRow>
					<SettingsRow label="Repeat" htmlFor="schedule-kind">
						<Select
							id="schedule-kind"
							value={kind}
							onChange={(value) => setKind(value as typeof kind)}
							options={kinds}
						/>
					</SettingsRow>
					{kind === 'once' && (
						<SettingsRow
							label="Date and time"
							description={`In this computer’s time zone: ${localZone()}`}
							htmlFor="schedule-at"
						>
							<input
								id="schedule-at"
								type="datetime-local"
								value={at}
								onChange={(event) => setAt(event.target.value)}
								required
							/>
						</SettingsRow>
					)}
					{kind === 'interval' && (
						<SettingsRow label="Every (minutes)" htmlFor="schedule-interval">
							<input
								id="schedule-interval"
								type="number"
								min={1}
								max={525600}
								step="any"
								value={interval}
								onChange={(event) => setInterval(event.target.value)}
								required
							/>
						</SettingsRow>
					)}
					{(kind === 'daily' || kind === 'weekly') && (
						<>
							<SettingsRow label="Time" htmlFor="schedule-time">
								<input
									id="schedule-time"
									type="time"
									value={time}
									onChange={(event) => setTime(event.target.value)}
									required
								/>
							</SettingsRow>
							<SettingsRow label="Time zone" htmlFor="schedule-zone">
								<input
									id="schedule-zone"
									value={timezone}
									onChange={(event) => setTimezone(event.target.value)}
									placeholder="America/New_York"
									required
								/>
							</SettingsRow>
						</>
					)}
					{kind === 'weekly' && (
						<SettingsRow label="Days" layout="stacked">
							<div className="scheduler-weekdays" role="group" aria-label="Days of the week">
								{days.map((day, index) => (
									<button
										key={day}
										type="button"
										aria-label={day}
										aria-pressed={weekdays.includes(index)}
										onClick={() =>
											setWeekdays((current) =>
												current.includes(index)
													? current.filter((value) => value !== index)
													: [...current, index].sort(),
											)
										}
									>
										{day.slice(0, 3)}
									</button>
								))}
							</div>
						</SettingsRow>
					)}
					<SettingsRow
						label="If a run is missed"
						htmlFor="schedule-missed"
						description="FreeLM must be running and this computer awake to deliver on time."
					>
						<Select
							id="schedule-missed"
							value={missed}
							onChange={(value) => setMissed(value as typeof missed)}
							options={[
								{ value: 'once', label: 'Run once when available' },
								{ value: 'skip', label: 'Skip missed runs' },
							]}
						/>
					</SettingsRow>
					{!reminder && (
						<SettingsRow
							label="If delivery is still pending"
							htmlFor="schedule-overlap"
							description="This applies while FreeLM is waiting to send. Work already accepted by a bot or Code thread follows that conversation’s queue; it isn’t interrupted."
						>
							<Select
								id="schedule-overlap"
								value={overlap}
								onChange={(value) => setOverlap(value as typeof overlap)}
								options={[
									{ value: 'skip', label: 'Skip this run' },
									{ value: 'queue', label: 'Queue the run' },
								]}
							/>
						</SettingsRow>
					)}
				</fieldset>
			</SettingsGroup>
			{error && (
				<p className="error-note" role="alert">
					{userFacingError(error)}
				</p>
			)}
			<div className="scheduler-editor-actions">
				<button
					type="button"
					className="secondary-button compact"
					disabled={busy}
					onClick={onCancel}
				>
					Cancel
				</button>
				<button type="submit" className="primary-button compact" disabled={busy}>
					{busy ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}{' '}
					{job ? 'Save schedule' : 'Create reminder'}
				</button>
			</div>
		</form>
	);
}

export default function SchedulerSettings({
	remote = false,
	bridge = window.desktop,
	threads = [],
}: {
	remote?: boolean;
	bridge?: Partial<SchedulerBridge>;
	threads?: Pick<Thread, 'id' | 'title'>[];
}) {
	const [snapshot, setSnapshot] = useState<SchedulerSnapshot>(emptySnapshot);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const [editor, setEditor] = useState<SchedulerJob | 'new' | null>(null);
	const [deleteId, setDeleteId] = useState<string>();
	const [showAll, setShowAll] = useState(false);
	const refreshSequence = useRef(0);
	const commandPending = useRef(false);
	const mounted = useRef(true);
	const supported = Boolean(bridge?.schedulerSnapshot && bridge.schedulerCommand);
	useEffect(() => {
		mounted.current = true;
		if (remote || !supported) {
			setLoading(false);
			return;
		}
		let disposed = false;
		async function refresh() {
			const sequence = ++refreshSequence.current;
			try {
				const next = await bridge!.schedulerSnapshot!();
				if (!disposed && sequence === refreshSequence.current) {
					setSnapshot(next);
					setError('');
				}
			} catch (error) {
				if (!disposed && sequence === refreshSequence.current)
					setError(error instanceof Error ? error.message : 'Could not load scheduled tasks.');
			} finally {
				if (!disposed) setLoading(false);
			}
		}
		void refresh();
		const unsubscribe = bridge!.onSchedulerChanged?.(() => {
			void refresh();
		});
		return () => {
			disposed = true;
			mounted.current = false;
			unsubscribe?.();
			refreshSequence.current++;
		};
	}, [bridge, remote, supported]);
	async function command(value: SchedulerCommand) {
		if (!bridge?.schedulerCommand || commandPending.current || remote) return false;
		commandPending.current = true;
		setBusy(true);
		setError('');
		try {
			await bridge.schedulerCommand(value);
			if (mounted.current) {
				// Dispatch can finish and emit a newer snapshot while the command's
				// acknowledgement is in flight. Re-read instead of replacing that
				// newer state with the acknowledgement's older snapshot.
				const sequence = ++refreshSequence.current;
				try {
					const next = await bridge.schedulerSnapshot!();
					if (mounted.current && sequence === refreshSequence.current) setSnapshot(next);
				} catch (error) {
					if (mounted.current && sequence === refreshSequence.current)
						setError(
							`The change was saved, but the list could not refresh. Reopen Scheduled tasks to reload. ${error instanceof Error ? error.message : ''}`,
						);
				}
			}
			return true;
		} catch (error) {
			if (mounted.current)
				setError(error instanceof Error ? error.message : 'Could not update this schedule.');
			return false;
		} finally {
			commandPending.current = false;
			if (mounted.current) setBusy(false);
		}
	}
	if (remote)
		return (
			<SettingsGroup title="Schedules belong to their computer">
				<SettingsRow
					label="Open Settings on the owning computer"
					description="Remote schedule management is not available yet. This page does not read or change this computer’s schedules while a remote workspace is selected."
				/>
			</SettingsGroup>
		);
	if (!supported)
		return (
			<SettingsGroup title="Scheduled tasks">
				<SettingsRow
					label="Open the desktop app"
					description="Reminders and scheduled tasks run in the FreeLM desktop app on their owning computer."
				/>
			</SettingsGroup>
		);
	const jobs = [...snapshot.jobs].sort(
		(a, b) =>
			Number(b.enabled) - Number(a.enabled) ||
			(a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity) ||
			b.createdAt - a.createdAt,
	);
	const occurrences = [...snapshot.occurrences].sort((a, b) => b.createdAt - a.createdAt);
	return (
		<div className="scheduler-settings">
			<p className="scheduler-host-note">
				<CalendarClock size={17} aria-hidden="true" />
				<span>
					Saved on this computer. Keep FreeLM open and this computer awake for on-time delivery.
					Code tasks wait until the local workspace is available.
				</span>
			</p>
			{error && (
				<p className="error-note" role="alert">
					{userFacingError(error)}
				</p>
			)}
			{editor && (
				<ScheduleEditor
					key={typeof editor === 'string' ? editor : editor.id}
					job={editor === 'new' ? undefined : editor}
					busy={busy}
					onSave={command}
					onCancel={() => setEditor(null)}
				/>
			)}
			<SettingsGroup
				title="Your schedules"
				actions={
					<button
						className="secondary-button compact"
						disabled={busy || Boolean(editor)}
						onClick={() => setEditor('new')}
					>
						<Plus size={15} /> New reminder
					</button>
				}
				footer="Schedule changes are saved immediately. Ask a bot or a Code agent to schedule work in its conversation; you can manage those schedules here."
			>
				{loading ? (
					<SettingsRow label="Loading schedules…" />
				) : !jobs.length ? (
					<SettingsRow
						label="No scheduled tasks yet"
						description="Create a reminder, or ask a bot or Code agent to do something later."
					/>
				) : (
					jobs.map((job) => (
						<div
							className="scheduler-job settings-list-item"
							key={job.id}
							data-schedule-id={job.id}
						>
							<div className="scheduler-job-heading">
								<JobIcon job={job} />
								<div className="scheduler-job-copy">
									<h4>{job.title}</h4>
									<p>{scheduleDescription(job)}</p>
									<p>
										{job.target.kind === 'reminder'
											? 'Reminder'
											: job.target.kind === 'bot'
												? 'Bot task'
												: `Code · ${threads.find((thread) => job.target.kind === 'code' && thread.id === job.target.threadId)?.title || 'Existing task'}`}{' '}
										·{' '}
										{!job.enabled
											? 'Paused'
											: job.nextRunAt
												? `Next ${displayDate(job.nextRunAt)}`
												: 'No upcoming run'}
									</p>
								</div>
							</div>
							<p className="scheduler-job-message">{jobMessage(job)}</p>
							{job.lastError && <p className="scheduler-error">{userFacingError(job.lastError)}</p>}
							<div className="scheduler-actions">
								<button
									className="secondary-button compact"
									disabled={busy || Boolean(editor)}
									onClick={() => setEditor(job)}
								>
									Edit
								</button>
								<button
									className="secondary-button compact"
									disabled={busy}
									onClick={() =>
										void command({ type: job.enabled ? 'pause' : 'resume', id: job.id })
									}
								>
									{job.enabled ? <Pause size={14} /> : <Play size={14} />}
									{job.enabled ? 'Pause' : 'Resume'}
								</button>
								<button
									className="secondary-button compact"
									disabled={busy || !job.enabled}
									title={job.enabled ? undefined : 'Resume this schedule to run it.'}
									onClick={() => void command({ type: 'run-now', id: job.id })}
								>
									<Play size={14} />
									Run now
								</button>
								<button
									className="scheduler-delete"
									aria-label={`Delete ${job.title}`}
									title="Delete schedule"
									disabled={busy}
									onClick={() => setDeleteId(job.id)}
								>
									<Trash2 size={16} />
								</button>
							</div>
							{deleteId === job.id && (
								<div
									className="scheduler-delete-confirm"
									role="group"
									aria-label={`Confirm delete ${job.title}`}
								>
									<span>Delete this schedule? Future runs will be cancelled.</span>
									<button
										className="secondary-button compact"
										disabled={busy}
										onClick={() => setDeleteId(undefined)}
									>
										Keep
									</button>
									<button
										className="secondary-button compact danger"
										disabled={busy}
										onClick={async () => {
											if (await command({ type: 'delete', id: job.id })) setDeleteId(undefined);
										}}
									>
										Delete schedule
									</button>
								</div>
							)}
						</div>
					))
				)}
			</SettingsGroup>
			<SettingsGroup
				title="Recent activity"
				description="Sent means accepted by the bot or Code thread, not that its work has finished."
			>
				{!occurrences.length ? (
					<SettingsRow label="No activity yet" />
				) : (
					(showAll ? occurrences : occurrences.slice(0, 20)).map((occurrence) => {
						const reminder = occurrence.jobSnapshot.target.kind === 'reminder';
						const dismissible = reminder && occurrence.status === 'delivered';
						const retryable = occurrence.status === 'failed' || occurrence.status === 'waiting';
						const currentJob = jobs.find((job) => job.id === occurrence.jobId);
						return (
							<div
								className="scheduler-occurrence settings-list-item"
								key={occurrence.id}
								data-occurrence-id={occurrence.id}
							>
								<div className="scheduler-activity-heading">
									<h4>{occurrence.jobSnapshot.title}</h4>
									<span className={retryable ? 'scheduler-error' : 'scheduler-status'}>
										{outcomeLabel(occurrence)}
									</span>
								</div>
								<p className="scheduler-metadata">
									{displayDate(occurrence.scheduledAt)}
									{occurrence.kind === 'manual' ? ' · Manual' : ''}
									{occurrence.retryAt ? ` · Retrying ${displayDate(occurrence.retryAt)}` : ''}
								</p>
								{reminder && (
									<p className="scheduler-job-message">{jobMessage(occurrence.jobSnapshot)}</p>
								)}
								{occurrence.error && (
									<p className="scheduler-error">{userFacingError(occurrence.error)}</p>
								)}
								{occurrence.result?.message && (
									<p className="scheduler-metadata">{occurrence.result.message}</p>
								)}
								{(retryable || dismissible) && (
									<div className="scheduler-actions">
										{retryable && (
											<button
												className="secondary-button compact"
												disabled={busy || !currentJob?.enabled}
												title={
													currentJob?.enabled ? undefined : 'Resume this schedule before retrying.'
												}
												onClick={() => void command({ type: 'retry', occurrenceId: occurrence.id })}
											>
												<RefreshCw size={14} />
												Retry
											</button>
										)}
										{dismissible && (
											<>
												<button
													className="secondary-button compact"
													disabled={busy}
													onClick={() =>
														void command({ type: 'dismiss', occurrenceId: occurrence.id })
													}
												>
													<Check size={14} />
													Dismiss
												</button>
												{currentJob && (
													<button
														className="secondary-button compact"
														disabled={busy || !currentJob.enabled}
														title={
															currentJob.enabled
																? undefined
																: 'Resume this reminder before snoozing.'
														}
														onClick={() =>
															void command({
																type: 'snooze',
																id: occurrence.jobId,
																occurrenceId: occurrence.id,
																until: Date.now() + 10 * 60_000,
															})
														}
													>
														<Clock3 size={14} />
														Snooze 10 minutes
													</button>
												)}
											</>
										)}
									</div>
								)}
							</div>
						);
					})
				)}
				{occurrences.length > 20 && (
					<SettingsRow>
						<button
							className="secondary-button compact"
							onClick={() => setShowAll((value) => !value)}
						>
							{showAll ? 'Show less' : `Show ${occurrences.length - 20} more`}
						</button>
					</SettingsRow>
				)}
			</SettingsGroup>
		</div>
	);
}
