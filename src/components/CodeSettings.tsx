import type { CodeCompactionSettings, ModelDefinition } from '../types';
import { modelCompactionSettings } from '../lib/catalog';
import { defaultCodeCompactionSettings } from '../lib/code-compaction';
import { SettingsGroup, SettingsRow } from './SettingsList';
import './code-settings.css';

export default function CodeSettings({
	value,
	model,
	supported = true,
	onChange,
}: {
	value: CodeCompactionSettings;
	model?: ModelDefinition;
	supported?: boolean;
	onChange: (value: CodeCompactionSettings) => void;
}) {
	const defaults = defaultCodeCompactionSettings();
	let preview = '';
	try {
		const settings = modelCompactionSettings(model, value);
		preview = `With ${model?.name || 'the fallback context window'}: compact at ${settings.triggerTokens.toLocaleString()} of ${settings.contextWindow.toLocaleString()} tokens used.`;
		if (value.reserveTokens >= settings.contextWindow)
			preview += ` This model uses a smaller reserve of ${settings.reserveTokens.toLocaleString()} tokens.`;
	} catch (error) {
		preview = error instanceof Error ? error.message : 'Check your compaction settings.';
	}
	return (
		<div className="code-compaction-settings">
			<SettingsGroup
				title="Context compaction"
				id="code-compaction-title"
				description={
					<>
						Apply these settings to all Code models. Configure each model’s context window in
						Configuration. Chat uses FreeLM’s automatic compaction defaults.
					</>
				}
				footer={
					<>
						<p>
							Compact when either the percentage is reached or the remaining-token reserve is
							reached, whichever happens first. If the reserve is as large as a model’s context
							window, FreeLM uses 25% of that window as its reserve instead.
						</p>
						<output className="code-compaction-preview" aria-live="polite">
							{preview}
						</output>
					</>
				}
			>
				{!supported && (
					<SettingsRow layout="stacked">
						<p className="remote-settings-note">
							Update the remote FreeLM instance to configure Code compaction.
						</p>
					</SettingsRow>
				)}
				<fieldset className="code-compaction-fields" disabled={!supported}>
					<SettingsRow label="Compact at (%)" htmlFor="code-compaction-threshold">
						<input
							id="code-compaction-threshold"
							type="number"
							min={1}
							max={99}
							step={1}
							placeholder={String(defaults.thresholdPercent)}
							value={Number.isFinite(value.thresholdPercent) ? value.thresholdPercent : ''}
							onChange={(event) =>
								onChange({ ...value, thresholdPercent: event.target.valueAsNumber })
							}
						/>
					</SettingsRow>
					<SettingsRow label="Minimum remaining tokens" htmlFor="code-compaction-reserve">
						<input
							id="code-compaction-reserve"
							type="number"
							min={0}
							step={1}
							placeholder={String(defaults.reserveTokens)}
							value={Number.isFinite(value.reserveTokens) ? value.reserveTokens : ''}
							onChange={(event) =>
								onChange({ ...value, reserveTokens: event.target.valueAsNumber })
							}
						/>
					</SettingsRow>
				</fieldset>
			</SettingsGroup>
		</div>
	);
}
