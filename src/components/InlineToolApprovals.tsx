import { FilePenLine, Image, Plug, ShieldCheck, Square, Terminal, Video } from 'lucide-react';
import type { ToolApproval } from '../agent-types';
import { toolApprovalPresentation } from '../lib/tool-approval-presentation';
import './inline-tool-approvals.css';

export interface InlineToolApprovalsProps {
	approvals: ToolApproval[];
	onApprove: (id: string, approved: boolean, remember?: boolean) => void;
	debugMode?: boolean;
	onStop?: () => void;
}

/** Approval is an explicit action within the task, so it never steals focus or traps navigation. */
export function InlineToolApprovals({
	approvals,
	onApprove,
	debugMode = false,
	onStop,
}: InlineToolApprovalsProps) {
	if (!approvals.length) return null;
	return (
		<section
			className={`inline-tool-approvals${onStop ? ' has-stop' : ''}`}
			aria-label="Pending tool approvals"
		>
			<p className="inline-approval-status" role="status" aria-live="polite">
				{approvals.length === 1 ? 'Approval needed' : `${approvals.length} approvals needed`}
			</p>
			{onStop && (
				<button
					type="button"
					className="icon-button inline-approval-stop"
					aria-label="Stop response"
					title="Stop response"
					onClick={onStop}
				>
					<Square size={13} fill="currentColor" aria-hidden="true" />
				</button>
			)}
			{approvals.map((approval) => {
				const presentation = toolApprovalPresentation(approval);
				const Icon =
					presentation.kind === 'command'
						? Terminal
						: presentation.kind === 'image'
							? Image
							: presentation.kind === 'video'
								? Video
								: presentation.kind === 'files'
									? FilePenLine
									: presentation.kind === 'integration'
										? Plug
										: ShieldCheck;
				return (
					<article
						key={approval.id}
						className="inline-tool-approval"
						aria-label={`Approve ${presentation.action.toLowerCase()}`}
					>
						<header>
							<Icon size={16} aria-hidden="true" />
							<h3>{presentation.action}</h3>
						</header>
						{presentation.message && (
							<p className="inline-approval-message">{presentation.message}</p>
						)}
						{presentation.command !== undefined && (
							<pre
								className="inline-approval-command"
								tabIndex={0}
								aria-label={approval.name === 'write_stdin' ? 'Process input' : 'Command to run'}
							>
								<code>{presentation.command}</code>
							</pre>
						)}
						{presentation.directory && (
							<p className="inline-approval-directory">
								<span>Working directory</span>
								<code>{presentation.directory}</code>
							</p>
						)}
						{presentation.files?.length ? (
							<ul className="inline-approval-files" aria-label="Affected files">
								{presentation.files.map((file, index) => (
									<li key={`${file.action}:${file.path}:${index}`}>
										<span>{file.action}</span>
										<code>{file.path}</code>
									</li>
								))}
							</ul>
						) : null}
						{presentation.fields.length ? (
							<dl className="inline-approval-fields">
								{presentation.fields.map((field, index) => (
									<div key={`${field.label}:${index}`}>
										<dt>{field.label}</dt>
										<dd>{field.code ? <code>{field.value}</code> : field.value}</dd>
									</div>
								))}
							</dl>
						) : null}
						{presentation.patch && (
							<details className="inline-approval-details">
								<summary>View changes</summary>
								<pre tabIndex={0} aria-label="Proposed patch">
									<code>{presentation.patch}</code>
								</pre>
							</details>
						)}
						{debugMode && (
							<details className="inline-approval-details inline-approval-debug">
								<summary>Debug arguments</summary>
								<pre tabIndex={0} aria-label={`Arguments for ${approval.name}`}>
									{JSON.stringify(approval.arguments, null, 2)}
								</pre>
							</details>
						)}
						<footer>
							<button
								type="button"
								className="primary-button"
								onClick={() => onApprove(approval.id, true)}
							>
								Allow once
							</button>
							{approval.rememberLabel && (
								<button
									type="button"
									className="secondary-button"
									onClick={() => onApprove(approval.id, true, true)}
								>
									{approval.rememberLabel}
								</button>
							)}
							<button
								type="button"
								className="secondary-button"
								onClick={() => onApprove(approval.id, false)}
							>
								Decline
							</button>
						</footer>
					</article>
				);
			})}
		</section>
	);
}
