import { useEffect, useState } from 'react';
import type { Connection } from '../types';
import type {
	InstalledPlugin,
	PluginSettingDeclaration,
	PluginSettingValue,
	PluginSettingsValues,
} from '../plugin-types';
import { availableThinkingModes, listModelChoices } from '../lib/catalog';
import { defaultPluginSettings } from '../lib/plugin-manifest';
import Select from './Select';
import Switch from './Switch';
import { SettingsGroup, SettingsRow } from './SettingsList';

function SettingField({
	setting,
	value,
	disabled,
	connections,
	workspaceId,
	onChange,
}: {
	setting: PluginSettingDeclaration;
	value: PluginSettingValue;
	disabled: boolean;
	connections: Connection[];
	workspaceId: string;
	onChange: (value: PluginSettingValue) => void;
}) {
	const [draft, setDraft] = useState(String(value));
	useEffect(() => setDraft(String(value)), [value]);
	if (setting.type === 'toggle')
		return (
			<Switch
				aria-label={setting.label}
				checked={value === true}
				disabled={disabled}
				onChange={onChange}
			/>
		);
	if (setting.type === 'enum')
		return (
			<Select
				aria-label={setting.label}
				value={String(value)}
				options={setting.options}
				disabled={disabled}
				onChange={onChange}
			/>
		);
	if (setting.type === 'model') {
		const current = JSON.stringify(value);
		const options = [
			{
				value: JSON.stringify({ source: 'conversation' }),
				label: 'Same as conversation',
				description: 'Uses its current host, connection, model, and thinking effort',
			},
		];
		for (const connection of connections) {
			for (const model of listModelChoices(connection, 'chat')) {
				for (const mode of availableThinkingModes(connection, model.id)) {
					options.push({
						value: JSON.stringify({
							source: 'configured',
							hostId: workspaceId,
							connectionId: connection.id,
							modelId: model.id,
							thinkingModeId: mode.id,
						}),
						label: `${model.name} · ${mode.name}`,
						description: `${connection.name} · ${workspaceId === 'local' ? 'This computer' : workspaceId}`,
					});
				}
			}
		}
		const unavailable = !options.some((option) => option.value === current);
		if (unavailable)
			options.push({
				value: current,
				label: 'Unavailable model selection',
				description: 'Choose a configured model and thinking effort',
			});
		return (
			<div className="plugin-setting-model">
				<Select
					aria-label={setting.label}
					value={current}
					options={options}
					disabled={disabled}
					onChange={(selection) => onChange(JSON.parse(selection))}
				/>
				{unavailable && (
					<span className="settings-help">
						The saved model or thinking effort is unavailable. No fallback model will be used.
					</span>
				)}
			</div>
		);
	}
	const commit = (element: HTMLInputElement | HTMLTextAreaElement) => {
		if (!element.checkValidity() || draft === String(value)) return;
		if (setting.type === 'number') {
			if (!draft.trim()) {
				setDraft(String(value));
				return;
			}
			onChange(Number(draft));
		} else onChange(draft);
	};
	if (setting.type === 'text' && setting.multiline)
		return (
			<textarea
				aria-label={setting.label}
				rows={3}
				value={draft}
				maxLength={setting.maxLength ?? 8000}
				disabled={disabled}
				onChange={(event) => setDraft(event.target.value)}
				onBlur={(event) => commit(event.currentTarget)}
			/>
		);
	return (
		<input
			aria-label={setting.label}
			type={setting.type === 'number' ? 'number' : 'text'}
			value={draft}
			disabled={disabled}
			min={setting.type === 'number' ? setting.min : undefined}
			max={setting.type === 'number' ? setting.max : undefined}
			step={setting.type === 'number' ? (setting.step ?? 1) : undefined}
			maxLength={setting.type === 'text' ? (setting.maxLength ?? 8000) : undefined}
			onChange={(event) => setDraft(event.target.value)}
			onBlur={(event) => commit(event.currentTarget)}
			onKeyDown={(event) => {
				if (event.key === 'Enter') {
					event.preventDefault();
					commit(event.currentTarget);
				}
			}}
		/>
	);
}

export default function PluginNativeSettings({
	plugin,
	busy,
	connections,
	workspaceId,
	onChange,
}: {
	plugin: InstalledPlugin;
	busy: boolean;
	connections: Connection[];
	workspaceId: string;
	onChange: (values: PluginSettingsValues) => void;
}) {
	if (plugin.manifest.manifestVersion !== 2 || !plugin.manifest.contributes.settings?.length)
		return null;
	const values = { ...defaultPluginSettings(plugin.manifest), ...plugin.settings };
	return (
		<SettingsGroup
			title={`${plugin.manifest.name} settings`}
			description="Saved immediately on this computer."
		>
			{plugin.manifest.contributes.settings.map((setting) => (
				<SettingsRow
					key={setting.id}
					label={setting.label}
					description={setting.description}
					layout={setting.type === 'text' && setting.multiline ? 'stacked' : undefined}
					className="plugin-native-setting"
				>
					<SettingField
						setting={setting}
						value={values[setting.id]}
						disabled={busy}
						connections={connections}
						workspaceId={workspaceId}
						onChange={(value) => onChange({ ...values, [setting.id]: value })}
					/>
				</SettingsRow>
			))}
		</SettingsGroup>
	);
}
