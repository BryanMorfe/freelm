import { userFacingError } from '../lib/user-facing-error';
import { useEffect, useState } from 'react';
import { Monitor, ShieldCheck, Square } from 'lucide-react';
import type { ComputerSessionPreview, ComputerStatus } from '../computer-types';
import type { ToolApproval } from '../agent-types';
import { computerEnvironmentIssue, computerReady } from '../lib/computer-status';
import { SettingsGroup, SettingsRow } from './SettingsList';
import Switch from './Switch';
import './computer-use.css';

function useComputerPermissions(initialStatus?: ComputerStatus) {
	const [status, setStatus] = useState(initialStatus);
	const [error, setError] = useState('');
	const [checking, setChecking] = useState(false);
	async function refresh(action?: 'request' | 'accessibility' | 'screen-recording' | 'helper') {
		setChecking(true);
		setError('');
		try {
			const next = action
				? await window.desktop?.computerSetup?.(action)
				: await window.desktop?.computerStatus?.();
			if (!next)
				throw new Error('Computer permissions are unavailable. Reopen FreeLM and try again.');
			setStatus(next);
			return next;
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
			return undefined;
		} finally {
			setChecking(false);
		}
	}
	return { status, error, checking, refresh };
}

export function ComputerUseSettings({
	enabled,
	onChange,
}: {
	enabled: boolean;
	onChange: (enabled: boolean) => void;
}) {
	const { status, error, checking, refresh } = useComputerPermissions();
	const environmentIssue = computerEnvironmentIssue(status);
	return (
		<SettingsGroup
			title="Computer Use"
			footer="App screenshots and interface text are sent to your selected model and retained in task history. Access is limited to the current run and ends when it finishes or you stop it. Available in local Code tasks with image-capable models."
		>
			<SettingsRow
				label="Use apps on this computer"
				description="Let Code observe and interact with selected apps. Ask for approval requests app access; Approve for me reviews it; Full access allows it automatically. Operating-system permissions are always required."
			>
				<Switch aria-label="Use apps on this computer" checked={enabled} onChange={onChange} />
			</SettingsRow>
			<SettingsRow
				label="Computer permissions"
				description={
					(!environmentIssue && status?.message) ||
					'macOS needs Accessibility and Screen Recording. Linux supports X11 with xdotool, wmctrl, and ImageMagick; Wayland is not supported yet.'
				}
			>
				<button
					type="button"
					className="secondary-button"
					disabled={checking || !window.desktop?.computerStatus}
					onClick={() => void refresh()}
				>
					{checking ? 'Checking…' : 'Check permissions'}
				</button>
			</SettingsRow>
			{status && (
				<SettingsRow
					label={
						environmentIssue?.title ||
						(computerReady(status) ? 'Ready for Computer Use' : 'Setup required')
					}
					description={
						environmentIssue ? (
							<span role="status">{environmentIssue.message}</span>
						) : status.platform === 'darwin' ? (
							`Accessibility: ${status.accessibility ? 'allowed' : 'needed'} · Screen Recording: ${status.screenRecording ? 'allowed' : 'needed'}`
						) : undefined
					}
				/>
			)}
			{window.desktop?.platform === 'darwin' && (
				<SettingsRow
					label="Set up macOS access"
					layout="stacked"
					description="macOS controls these permissions. Enable FreeLM or its freelm-computer helper in Accessibility and Screen Recording, then check permissions again. If it is missing, reveal the helper and add it in System Settings."
				>
					<div className="computer-setup-actions">
						<button
							type="button"
							className="secondary-button"
							disabled={checking}
							onClick={() => void refresh('request')}
						>
							Request permissions
						</button>
						<button
							type="button"
							className="secondary-button"
							disabled={checking}
							onClick={() => void refresh('accessibility')}
						>
							Accessibility
						</button>
						<button
							type="button"
							className="secondary-button"
							disabled={checking}
							onClick={() => void refresh('screen-recording')}
						>
							Screen Recording
						</button>
						<button
							type="button"
							className="secondary-button"
							disabled={checking}
							onClick={() => void refresh('helper')}
						>
							Reveal helper
						</button>
					</div>
				</SettingsRow>
			)}
			{error && (
				<p className="error-text" role="alert">
					{userFacingError(error)}
				</p>
			)}
		</SettingsGroup>
	);
}

export function ComputerAuthorization({
	approval,
	onApprove,
}: {
	approval: ToolApproval;
	onApprove: (id: string, approved: boolean) => void;
}) {
	const app = approval.computer!.app;
	if (approval.computer?.setup)
		return <ComputerPermissionSetup key={approval.id} approval={approval} onApprove={onApprove} />;
	return (
		<section className="computer-authorization" aria-label={`Authorize ${app.name}`}>
			<div className="computer-authorization-heading">
				{app.icon ? <img src={app.icon} alt="" /> : <Monitor size={22} />}
				<h3>Allow FreeLM to use {app.name}?</h3>
			</div>
			<p>View and control this app for the current run. You can stop access at any time.</p>
			{approval.permissionMode === 'auto-review' && (
				<p className="computer-review-reason">{approval.message}</p>
			)}
			<div className="computer-authorization-actions">
				<button className="secondary-button" onClick={() => onApprove(approval.id, false)}>
					Don’t allow
				</button>
				<button className="computer-authorize-button" onClick={() => onApprove(approval.id, true)}>
					<ShieldCheck size={16} />
					Authorize computer use
				</button>
			</div>
		</section>
	);
}

function ComputerPermissionSetup({
	approval,
	onApprove,
}: {
	approval: ToolApproval;
	onApprove: (id: string, approved: boolean) => void;
}) {
	const app = approval.computer!.app;
	const { status, error, checking, refresh } = useComputerPermissions(approval.computer!.setup);
	const [checked, setChecked] = useState(false);
	const environmentIssue = computerEnvironmentIssue(status);
	return (
		<section
			className="computer-authorization computer-permission-setup"
			aria-label={`Set up computer access for ${app.name}`}
		>
			<div className="computer-authorization-heading">
				{app.icon ? <img src={app.icon} alt="" /> : <Monitor size={22} />}
				<h3>{environmentIssue?.title || 'Computer access needed'}</h3>
			</div>
			<p>
				{environmentIssue?.message ||
					`The task is paused before using ${app.name}. Allow access in System Settings, then continue.`}
			</p>
			{status?.platform === 'darwin' ? (
				<>
					<div className="computer-permission-status" aria-live="polite">
						<span>
							Accessibility <strong>{status.accessibility ? 'Allowed' : 'Needed'}</strong>
						</span>
						<span>
							Screen Recording <strong>{status.screenRecording ? 'Allowed' : 'Needed'}</strong>
						</span>
					</div>
					{(!status.accessibility || !status.screenRecording) && (
						<div className="computer-setup-actions">
							<button
								className="secondary-button"
								disabled={checking}
								onClick={() => void refresh('request')}
							>
								Request permissions
							</button>
							<button
								className="secondary-button"
								disabled={checking}
								onClick={() => void refresh('accessibility')}
							>
								Accessibility
							</button>
							<button
								className="secondary-button"
								disabled={checking}
								onClick={() => void refresh('screen-recording')}
							>
								Screen Recording
							</button>
						</div>
					)}
				</>
			) : (
				<p>
					{status?.message ||
						'Check that the Computer Use helper and desktop dependencies are available.'}
				</p>
			)}
			{checked && !computerReady(status) && !environmentIssue && !error && (
				<p role="status">
					Access is still needed. If macOS asks you to restart FreeLM, reopen it and retry the task.
				</p>
			)}
			{error && (
				<p className="error-text" role="alert">
					{userFacingError(error)}
				</p>
			)}
			<div className="computer-authorization-actions">
				<button className="secondary-button" onClick={() => onApprove(approval.id, false)}>
					Cancel
				</button>
				<button
					className="computer-authorize-button"
					disabled={checking}
					onClick={async () => {
						const next = await refresh();
						setChecked(true);
						if (computerReady(next)) onApprove(approval.id, true);
					}}
				>
					{checking ? 'Checking…' : 'Check and continue'}
				</button>
			</div>
		</section>
	);
}

/** Ephemeral, bounded preview state; does not hydrate the workspace or poll the desktop. */
export function useComputerSessions() {
	const [sessions, setSessions] = useState<ComputerSessionPreview[]>([]);
	useEffect(() => {
		let active = true;
		const update = (preview: ComputerSessionPreview) =>
			setSessions((previous) =>
				[preview, ...previous.filter((item) => item.sessionId !== preview.sessionId)].slice(0, 12),
			);
		const unsubscribe = window.desktop?.onComputerPreview?.(update);
		void window.desktop
			?.computerSessions?.()
			.then((values) => {
				if (active)
					setSessions((previous) =>
						[
							...previous,
							...values.filter(
								(item) => !previous.some((existing) => existing.sessionId === item.sessionId),
							),
						].slice(0, 12),
					);
			})
			.catch(() => {});
		return () => {
			active = false;
			unsubscribe?.();
		};
	}, []);
	return sessions;
}

export function ComputerPreview({
	sessions,
	onStop,
}: {
	sessions: ComputerSessionPreview[];
	onStop?: (session: ComputerSessionPreview) => void;
}) {
	const [error, setError] = useState('');
	const [expanded, setExpanded] = useState<string>();
	if (!sessions.length) return null;
	return (
		<section className="computer-previews" aria-label="Computer Use apps">
			{sessions.map((session) => (
				<article className="computer-preview" key={session.sessionId}>
					<header>
						{session.app.icon ? (
							<img className="computer-app-icon" src={session.app.icon} alt="" />
						) : (
							<Monitor size={16} />
						)}
						<span>{session.app.name}</span>
						<span className="computer-preview-state">
							{session.status === 'active' ? 'Active' : 'Finished'}
						</span>
						{session.status === 'active' && (
							<button
								className="secondary-button computer-stop"
								aria-label="Stop computer use"
								title="Stop computer use"
								onClick={() => {
									setError('');
									onStop?.(session);
									void window.desktop
										?.computerStop?.(session.sessionId)
										.catch((error) => setError(String(error)));
								}}
							>
								<Square size={12} fill="currentColor" />
								Stop
							</button>
						)}
					</header>
					{session.image && (
						<button
							className="computer-preview-image"
							aria-label={`View ${session.app.name} preview`}
							onClick={() =>
								setExpanded(expanded === session.sessionId ? undefined : session.sessionId)
							}
						>
							<img
								src={session.image.dataUrl}
								alt={`${session.app.name}: ${session.windowTitle || 'App preview'}`}
							/>
						</button>
					)}
					{expanded === session.sessionId && session.image && (
						<div
							className="computer-preview-expanded"
							role="dialog"
							aria-label={`${session.app.name} preview`}
						>
							<button className="secondary-button" onClick={() => setExpanded(undefined)}>
								Close preview
							</button>
							<img src={session.image.dataUrl} alt={session.app.name} />
						</div>
					)}
				</article>
			))}
			{error && <p role="alert">{userFacingError(error)}</p>}
		</section>
	);
}
