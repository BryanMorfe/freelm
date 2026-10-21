import { memo, useMemo, useState } from 'react';
import { ChevronRight, ShieldAlert, ShieldX } from 'lucide-react';
import type { ToolCallRecord } from '../agent-types';
import type { ApprovalDenial } from '../lib/approval-denial';
import { toolApprovalPresentation } from '../lib/tool-approval-presentation';
import { isFileEditingCall } from '../lib/message-activity';
import { userFacingError } from '../lib/user-facing-error';
import CodeBlock from './CodeBlock';
import './approval-denied-activity.css';

/** The requested action is display data only; opening this disclosure cannot retry it. */
export function ApprovalDeniedDetails({
	call,
	args,
	denial,
}: {
	call: ToolCallRecord;
	args: Record<string, unknown>;
	denial: ApprovalDenial;
}) {
	const presentation = useMemo(
		() =>
			toolApprovalPresentation({
				id: call.id,
				runId: '',
				name: isFileEditingCall(call) ? 'apply_patch' : call.name,
				arguments: args,
				message: '',
				effectiveDirectory: denial.effectiveDirectory,
			}),
		[call.id, call.name, args, denial.effectiveDirectory],
	);
	return (
		<div className="approval-denied-details">
			<div className="approval-denied-reason">
				<span className="approval-denied-caption">
					{denial.permissionMode === 'auto-review' ? 'Automatic review' : 'Reason'}
				</span>
				<p>{userFacingError(denial.reason)}</p>
			</div>
			<div className="approval-denied-action">
				<span className="approval-denied-caption">Requested action</span>
				<p>{presentation.action}</p>
			</div>
			{presentation.directory && (
				<div className="approval-denied-field">
					<span className="approval-denied-caption">Working directory</span>
					<code>{presentation.directory}</code>
				</div>
			)}
			{presentation.command && <CodeBlock text={presentation.command} language="bash" />}
			{!!presentation.files?.length && (
				<div className="approval-denied-files">
					{presentation.files.map((file, index) => (
						<div className="approval-denied-field" key={`${file.path}:${index}`}>
							<span className="approval-denied-caption">{file.action}</span>
							<code>{file.path}</code>
						</div>
					))}
				</div>
			)}
			{presentation.patch && <CodeBlock text={presentation.patch} language="diff" />}
			{presentation.fields.map((field, index) => (
				<div className="approval-denied-field" key={`${field.label}:${index}`}>
					<span className="approval-denied-caption">{field.label}</span>
					{field.code ? <code>{field.value}</code> : <p>{field.value}</p>}
				</div>
			))}
		</div>
	);
}

export default memo(function ApprovalDeniedActivity({
	call,
	args,
	denial,
	reviewFailed = false,
}: {
	call: ToolCallRecord;
	args: Record<string, unknown>;
	denial: ApprovalDenial;
	reviewFailed?: boolean;
}) {
	const [expanded, setExpanded] = useState(false);
	const label = reviewFailed ? 'Approval review failed' : 'Approval denied';
	const Icon = reviewFailed ? ShieldAlert : ShieldX;
	return (
		<details
			className="approval-denied-activity"
			onToggle={(event) => setExpanded(event.currentTarget.open)}
		>
			<summary aria-label={label}>
				<Icon
					size={14}
					data-activity-icon={reviewFailed ? 'approval-review-failed' : 'approval-denied'}
					aria-hidden="true"
				/>
				<span className="approval-denied-label">{label}</span>
				<ChevronRight className="approval-denied-chevron" size={12} aria-hidden="true" />
			</summary>
			{expanded && <ApprovalDeniedDetails call={call} args={args} denial={denial} />}
		</details>
	);
});
