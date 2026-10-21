import { useState } from 'react';
import type { ToolSettings } from '../agent-types';
import Switch from './Switch';
import { SettingsGroup, SettingsRow } from './SettingsList';

interface Props {
	value: ToolSettings;
	onChange: (value: ToolSettings) => void;
	readOnly: boolean;
}

export default function PythonSettings({ value, onChange, readOnly }: Props) {
	const [checking, setChecking] = useState(false);
	const [status, setStatus] = useState('');
	async function check() {
		if (!window.desktop?.toolInspect || readOnly) return;
		setChecking(true);
		try {
			const catalog = await window.desktop.toolInspect({
				...value,
				enabled: false,
				commandExecution: false,
				workspaceRoot: '',
				workspaceRoots: [],
				mcpServers: [],
				skillDirectories: [],
				webBrowsing: { ...value.webBrowsing, enabled: false, searxngUrl: '' },
				imageGeneration: { ...value.imageGeneration, enabled: false },
				pythonExecution: { enabled: true },
			});
			setStatus(
				catalog.warnings.length
					? catalog.warnings.join('\n')
					: catalog.instructions
							.split('\n\n')
							.find((part) => part.startsWith('Isolated Python ')) || 'Python runtime checked.',
			);
		} catch (error) {
			setStatus(error instanceof Error ? error.message : String(error));
		} finally {
			setChecking(false);
		}
	}
	return (
		<SettingsGroup
			title="Python analysis"
			footer="Python has no access to your files, network, or shell. Variables stay in each conversation until cancelled, timed out, or idle for 30 minutes. macOS uses its system sandbox; Linux requires bubblewrap. The tool remains unavailable if isolation cannot start."
		>
			<SettingsRow
				label="Run Python in Chat"
				description="Calculate, analyze data, and create downloadable files in a separate isolated interpreter."
			>
				<Switch
					aria-label="Run Python in Chat"
					checked={value.pythonExecution?.enabled ?? false}
					disabled={readOnly || checking}
					onChange={(enabled) => onChange({ ...value, pythonExecution: { enabled } })}
				/>
			</SettingsRow>
			<SettingsRow
				label="Python runtime"
				description={
					status ? (
						<span role="status" style={{ whiteSpace: 'pre-wrap' }}>
							{status}
						</span>
					) : (
						'Check whether the isolated interpreter can start on this computer.'
					)
				}
			>
				<button
					className="secondary-button"
					type="button"
					disabled={readOnly || checking || !window.desktop?.toolInspect}
					onClick={() => void check()}
				>
					{checking ? 'Checking Python…' : 'Check Python runtime'}
				</button>
			</SettingsRow>
		</SettingsGroup>
	);
}
