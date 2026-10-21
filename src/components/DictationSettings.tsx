import type { Connection, DictationSettings as Values } from '../types';
import { listModelChoices } from '../lib/catalog';
import Select from './Select';
import Switch from './Switch';
import { SettingsGroup, SettingsRow } from './SettingsList';
import './chat-composer-features.css';

export default function DictationSettings({
	settings,
	connections,
	onChange,
}: {
	settings: Values;
	connections: Connection[];
	onChange: (settings: Values) => void;
}) {
	const connection = connections.find((item) => item.id === settings.connectionId);
	const models = connection ? listModelChoices(connection, 'transcription') : [];
	const ready = !!(connection && settings.model.trim());
	return (
		<SettingsGroup
			title="Dictation"
			className="dictation-settings"
			footer={
				<>
					Dictation records your microphone when you start it and sends the recording to your
					selected transcription API. Stop to add the transcript to your draft for review, or choose
					Send to transcribe and send it with your message.
				</>
			}
		>
			<SettingsRow label="API connection">
				<Select
					aria-label="Dictation API connection"
					value={settings.connectionId}
					options={connections.map((item) => ({ value: item.id, label: item.name }))}
					onChange={(connectionId) => onChange({ enabled: false, connectionId, model: '' })}
				/>
			</SettingsRow>
			<SettingsRow label="Transcription model">
				<Select
					aria-label="Dictation transcription model"
					value={settings.model}
					disabled={!connection}
					placeholder="Choose a transcription model"
					options={models.map((item) => ({ value: item.id, label: item.name }))}
					onChange={(model) => onChange({ ...settings, model })}
				/>
			</SettingsRow>
			<SettingsRow
				label="Custom model ID"
				description="Enter an ASR model ID if it isn’t in the catalog."
			>
				<input
					aria-label="Dictation custom model ID"
					value={settings.model}
					disabled={!connection}
					placeholder="Or enter an ASR model ID"
					onChange={(event) => {
						const model = event.target.value;
						onChange({ ...settings, model, enabled: !!model.trim() && settings.enabled });
					}}
				/>
			</SettingsRow>
			<SettingsRow
				label="Enable dictation"
				description={
					ready
						? 'Use the microphone button in Chat.'
						: 'Select a connection and transcription model first.'
				}
			>
				<Switch
					aria-label="Enable dictation"
					checked={ready && settings.enabled}
					disabled={!ready}
					onChange={(enabled) => onChange({ ...settings, enabled })}
				/>
			</SettingsRow>
		</SettingsGroup>
	);
}
