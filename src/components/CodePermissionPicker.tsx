import { useId } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { CodePermissionMode } from '../agent-types';
import Select, { type SelectOption } from './Select';

const permissionOptions: readonly SelectOption[] = [
	{
		value: 'ask',
		label: 'Ask for approval',
		description: 'Ask before running commands, editing files, or calling MCP tools.',
	},
	{
		value: 'auto-review',
		label: 'Approve for me',
		description:
			'Automatically review tool actions before they run. If the review fails, the action is blocked.',
	},
	{
		value: 'full-access',
		label: 'Full access',
		description:
			'Run enabled tools without approval prompts. Commands have your account’s access to this host’s files and network.',
	},
];

export default function CodePermissionPicker({
	value = 'ask',
	onChange,
	disabled = false,
	readOnly = false,
}: {
	value?: CodePermissionMode;
	onChange?: (value: CodePermissionMode) => void;
	disabled?: boolean;
	readOnly?: boolean;
}) {
	const id = useId();
	const label = permissionOptions.find((option) => option.value === value)?.label;
	return (
		<span className="code-permission-picker" data-permission-mode={value}>
			<Select
				id={`code-permission-${id}`}
				className="code-permission-trigger"
				aria-label="Code permissions"
				leadingIcon={<ShieldCheck size={15} aria-hidden="true" />}
				value={value}
				options={permissionOptions}
				onChange={(next) => onChange?.(next as CodePermissionMode)}
				disabled={disabled || readOnly || !onChange}
				title={
					readOnly
						? 'Code permissions are configured on the host computer'
						: `${label} — Choose how Code tool actions are approved`
				}
			/>
		</span>
	);
}
