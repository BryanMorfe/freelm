import type { Connection } from '../types';
import type {
	ModerationLevel,
	ModerationMediaSettings,
	ModerationMediaKind,
	ModerationSettings as Values,
} from '../moderation-types';
import {
	IMAGE_EDIT_MODERATION_RUBRIC,
	MODERATION_RUBRIC,
	moderationConfigurationWarning,
} from '../lib/moderation';
import { availableThinkingModes, defaultThinkingMode, listModelChoices } from '../lib/catalog';
import Select, { type SelectOption } from './Select';
import Switch from './Switch';
import { SettingsGroup, SettingsRow } from './SettingsList';
import './moderation-settings.css';

const levels = [
	{ value: 'low', label: 'Low' },
	{ value: 'medium', label: 'Medium' },
	{ value: 'high', label: 'High' },
] as const;
const descriptions: Record<ModerationLevel, string> = {
	low: 'Blocks non-consensual intimate imagery and sexual or violent content involving minors.',
	medium:
		'Also blocks sexual content and nudity without a clearly artistic, nonsexual purpose. Clearly artistic adult nudity and adult gore are allowed.',
	high: 'Also blocks all nudity, sexual content and gore, including artistic nudity.',
};

function EvaluatorSettings({
	kind,
	value,
	connections,
	supported,
	warning,
	onChange,
}: {
	kind: ModerationMediaKind;
	value: ModerationMediaSettings;
	connections: Connection[];
	supported: boolean;
	warning?: string;
	onChange: (value: ModerationMediaSettings) => void;
}) {
	const name = kind === 'image' ? 'Image' : 'Video';
	const connection = connections.find((item) => item.id === value.connectionId);
	const effective = connection;
	const models = connection
		? listModelChoices(connection, 'chat').filter(
				(item) =>
					item.definition?.inputModalities.includes('text') &&
					item.definition.inputModalities.includes('image') &&
					item.definition.outputModalities.includes('text'),
			)
		: [];
	const modes = effective ? availableThinkingModes(effective, value.model) : [];
	const selectedMode =
		value.thinkingMode || (effective && defaultThinkingMode(effective, value.model));
	const selectedModel = models.some((item) => item.id === value.model);
	const options: SelectOption[] = models.map((item) => ({ value: item.id, label: item.name }));
	if (value.model && !selectedModel)
		options.unshift({ value: value.model, label: `${value.model} (unavailable)`, disabled: true });
	const modeOptions: SelectOption[] = modes.map((mode) => ({ value: mode.id, label: mode.name }));
	if (selectedMode && !modes.some((mode) => mode.id === selectedMode))
		modeOptions.unshift({
			value: selectedMode,
			label: `${selectedMode} (unavailable)`,
			disabled: true,
		});
	return (
		<SettingsGroup
			title={`${name} moderation`}
			footer={
				supported &&
				(warning ? (
					<p className="moderation-configuration-warning" role="status">
						{name} moderation is enabled, but its evaluator is not ready.{' '}
						{kind === 'image' ? 'Images' : 'Videos'} will be generated without moderation until a
						compatible model and thinking value are configured.
					</p>
				) : value.enabled ? (
					'The evaluator returns category flags; FreeLM applies this policy separately.'
				) : (
					`Moderation is off for ${kind === 'image' ? 'images' : 'videos'}.`
				))
			}
		>
			<SettingsRow
				label="Enable moderation"
				description={
					kind === 'image'
						? 'Check image prompts and generated images.'
						: 'Check video prompts and one frame per second of generated videos. Audio is not evaluated.'
				}
			>
				<Switch
					aria-label={`Enable ${kind} moderation`}
					checked={value.enabled}
					disabled={!supported}
					onChange={(enabled) => onChange({ ...value, enabled })}
				/>
			</SettingsRow>
			<SettingsRow
				label="Moderation level"
				description={`${descriptions[value.level]}${kind === 'image' ? ' Image edits that produce or retain sexual content or nudity are blocked at every level.' : ''}`}
			>
				<Select
					aria-label={`${name} moderation level`}
					value={value.level}
					options={levels}
					disabled={!supported}
					onChange={(level) => onChange({ ...value, level: level as ModerationLevel })}
				/>
			</SettingsRow>
			<SettingsRow label="API connection">
				<Select
					aria-label={`${name} moderation API connection`}
					value={value.connectionId}
					disabled={!supported}
					placeholder="Choose a connection"
					options={connections.map((item) => ({ value: item.id, label: item.name }))}
					onChange={(connectionId) =>
						onChange({ ...value, connectionId, model: '', thinkingMode: undefined })
					}
				/>
			</SettingsRow>
			<SettingsRow label="Evaluator model">
				<Select
					aria-label={`${name} moderation model`}
					value={value.model}
					disabled={!supported || !connection || !options.length}
					placeholder="Choose an image-capable model"
					options={options}
					onChange={(model) =>
						onChange({
							...value,
							model,
							thinkingMode: effective && defaultThinkingMode(effective, model),
						})
					}
				/>
			</SettingsRow>
			<SettingsRow label="Thinking effort">
				<Select
					aria-label={`${name} moderation thinking effort`}
					value={selectedMode ?? ''}
					disabled={!supported || !selectedModel || !modes.length}
					placeholder="Configure a thinking value"
					options={modeOptions}
					onChange={(thinkingMode) => onChange({ ...value, thinkingMode })}
				/>
			</SettingsRow>
		</SettingsGroup>
	);
}

export default function ModerationSettings({
	settings,
	connections,
	supported = true,
	onChange,
}: {
	settings: Values;
	connections: Connection[];
	supported?: boolean;
	onChange: (settings: Values) => void;
}) {
	return (
		<div className="moderation-settings">
			{!supported && (
				<p className="remote-settings-note">
					Update the remote FreeLM instance to configure moderation.
				</p>
			)}
			{(['image', 'video'] as const).map((kind) => (
				<EvaluatorSettings
					key={kind}
					kind={kind}
					value={settings[kind]}
					connections={connections}
					supported={supported}
					warning={
						supported ? moderationConfigurationWarning(settings, kind, connections) : undefined
					}
					onChange={(evaluator) => onChange({ ...settings, [kind]: evaluator })}
				/>
			))}
			<p className="moderation-settings-explanation">
				Configured image evaluators check editing instructions together with every attached
				reference image. Other generation input checks inspect the prompt. Generated media is
				evaluated independently before display. Evaluator context and output stay out of
				conversations. Unknown age or consent cannot be established with certainty. Policy denials
				and evaluation errors stop the request.
			</p>
			<details className="moderation-rubric">
				<summary>View evaluator rubric</summary>
				<p>
					The model returns JSON category flags. It does not choose a moderation level or policy.
				</p>
				<textarea
					aria-label="Moderation evaluator rubric"
					value={MODERATION_RUBRIC}
					readOnly
					spellCheck={false}
					rows={12}
				/>
			</details>
			<details className="moderation-rubric">
				<summary>View image edit evaluator rubric</summary>
				<p>
					The evaluator classifies people in references and the expected edited result. Sexual
					content and nudity in image edits are blocked at every enabled level, including Low.
				</p>
				<textarea
					aria-label="Image edit moderation evaluator rubric"
					value={IMAGE_EDIT_MODERATION_RUBRIC}
					readOnly
					spellCheck={false}
					rows={12}
				/>
			</details>
		</div>
	);
}
