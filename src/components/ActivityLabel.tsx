import { useId, useState, type ReactNode } from 'react';
import type { ToolCallRecord } from '../agent-types';
import { toolArguments } from '../lib/message-activity';
import CodeBlock from './CodeBlock';
import './activity-label.css';

/** A process poll can inherit the original command through its resolved label. */
export function activityCommand(call: ToolCallRecord, label: string): string | undefined {
	if (call.name !== 'exec_command' && call.name !== 'write_stdin') return;
	const args = toolArguments(call);
	if (typeof args.cmd === 'string' && args.cmd.trim()) return args.cmd;
	const processCommand = call.result?.process?.command;
	if (typeof processCommand === 'string' && processCommand.trim()) return processCommand;
	if (call.name !== 'write_stdin') return;
	const prefix = [
		'Waiting for approval: Running ',
		'Running ',
		'Ran ',
		'Could not run ',
		'Command: ',
	].find((value) => label.startsWith(value));
	const command = prefix ? label.slice(prefix.length) : undefined;
	return command?.trim() && command !== 'a command' ? command : undefined;
}

/** Use the resolved lifecycle label so process polls keep their original command. */
export default function ActivityLabel({
	call,
	label,
	active = false,
	details,
	detailKind,
}: {
	call: ToolCallRecord;
	label: string;
	active?: boolean;
	details?: ReactNode;
	detailKind?: string;
}) {
	// A new active tool occupies the same row, so expansion follows the tool ID
	// rather than carrying over from the previous command.
	const [expandedCallId, setExpandedCallId] = useState<string | null>(null);
	const detailsId = useId();
	const isCommand = call.name === 'exec_command' || call.name === 'write_stdin';
	const command = activityCommand(call, label);
	const hasDetails = !!command || !!details;
	const expanded = hasDetails && expandedCallId === call.id;
	const text = (
		<span className={`activity-label-text${active ? ' activity-shimmer' : ''}`}>{label}</span>
	);
	return (
		<div className="activity-label-container">
			{hasDetails ? (
				<button
					type="button"
					className="activity-label"
					aria-expanded={expanded}
					aria-controls={detailsId}
					data-details="true"
					aria-label={`${expanded ? 'Collapse' : 'Expand'} ${detailKind || (isCommand ? 'command' : 'tool activity')}: ${label}`}
					title={expanded ? 'Collapse activity' : 'Expand full activity'}
					onClick={() => setExpandedCallId(expanded ? null : call.id)}
				>
					{text}
				</button>
			) : (
				<div className="activity-label-static">{text}</div>
			)}
			{hasDetails && (
				<div id={detailsId} className="activity-details" hidden={!expanded}>
					{expanded && (
						<>
							{details}
							{command && <CodeBlock text={command} language="bash" />}
						</>
					)}
				</div>
			)}
		</div>
	);
}
