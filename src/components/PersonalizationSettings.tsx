import { useState } from 'react';
import type { ConversationKind } from '../types';
import {
	MAX_CUSTOM_INSTRUCTIONS,
	PERSONALIZATION_LEVELS,
	type PersonalizationProfile,
	type PersonalizationSettings as PersonalizationValues,
} from '../personalization-types';
import { personalityOptions } from '../lib/personalization';
import Select from './Select';
import { SettingsGroup, SettingsRow } from './SettingsList';
import './personalization-settings.css';

interface Props {
	value: PersonalizationValues;
	onChange: (value: PersonalizationValues) => void;
	supported?: boolean;
	initialKind?: ConversationKind;
}
const fields = [
	{ key: 'warmth', label: 'Warmth', help: 'How warm and conversational responses should feel.' },
	{ key: 'enthusiasm', label: 'Enthusiasm', help: 'How much excitement and encouragement to use.' },
	{ key: 'responseLength', label: 'Response length', help: 'How much detail to include.' },
	{
		key: 'formatting',
		label: 'Formatting',
		help: 'How often to use headings, lists and other structure.',
	},
	{ key: 'emojis', label: 'Emojis', help: 'How often to include emojis in responses.' },
] as const;
const display = (value: string) => value[0].toUpperCase() + value.slice(1);
const levelOptions = PERSONALIZATION_LEVELS.map((level) => ({
	value: level,
	label: display(level),
}));

export default function PersonalizationSettings({
	value,
	onChange,
	supported = true,
	initialKind = 'chat',
}: Props) {
	const [kind, setKind] = useState<ConversationKind>(initialKind);
	const profile = value[kind];
	function update(patch: Partial<PersonalizationProfile>) {
		if (supported) onChange({ ...value, [kind]: { ...profile, ...patch } });
	}
	return (
		<div className="personalization-settings">
			{!supported && (
				<p className="remote-settings-note">
					Update this remote FreeLM instance to enable personalization.
				</p>
			)}
			<SettingsGroup title="Profile">
				<SettingsRow
					label="Personalization mode"
					description="Chat and Code each keep their own personality and instructions."
				>
					<div className="settings-mode-tabs" role="tablist" aria-label="Personalization mode">
						{(['chat', 'code'] as const).map((mode) => (
							<button
								type="button"
								role="tab"
								key={mode}
								id={`personalization-tab-${mode}`}
								aria-controls="personalization-profile"
								aria-selected={kind === mode}
								tabIndex={kind === mode ? 0 : -1}
								onKeyDown={(event) => {
									if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
									event.preventDefault();
									const next =
										event.key === 'Home'
											? 'chat'
											: event.key === 'End'
												? 'code'
												: mode === 'chat'
													? 'code'
													: 'chat';
									setKind(next);
									event.currentTarget.parentElement
										?.querySelector<HTMLButtonElement>(`#personalization-tab-${next}`)
										?.focus();
								}}
								onClick={() => setKind(mode)}
							>
								{display(mode)}
							</button>
						))}
					</div>
				</SettingsRow>
			</SettingsGroup>
			<div
				id="personalization-profile"
				className="personalization-profile"
				role="tabpanel"
				aria-labelledby={`personalization-tab-${kind}`}
			>
				<SettingsGroup
					title="Behavior"
					description={`These preferences apply to ${display(kind)} in this workspace.`}
				>
					<SettingsRow label="Personality" htmlFor="personalization-personality">
						<Select
							id="personalization-personality"
							aria-label="Personality"
							disabled={!supported}
							value={profile.personality}
							options={personalityOptions}
							onChange={(personality) =>
								update({ personality: personality as PersonalizationProfile['personality'] })
							}
						/>
					</SettingsRow>
					{fields.map(({ key, label, help }) => (
						<SettingsRow
							key={key}
							label={label}
							description={help}
							htmlFor={`personalization-${key}`}
						>
							<Select
								id={`personalization-${key}`}
								aria-label={label}
								disabled={!supported}
								value={profile[key]}
								options={levelOptions}
								onChange={(level) => update({ [key]: level })}
							/>
						</SettingsRow>
					))}
				</SettingsGroup>
				<SettingsGroup
					title="Custom instructions"
					footer={`${profile.customInstructions.length.toLocaleString()} / ${MAX_CUSTOM_INSTRUCTIONS.toLocaleString()} characters. Save settings to apply your changes.`}
				>
					<SettingsRow layout="stacked">
						<textarea
							aria-label={`${display(kind)} custom instructions`}
							rows={5}
							maxLength={MAX_CUSTOM_INSTRUCTIONS}
							disabled={!supported}
							value={profile.customInstructions}
							placeholder={
								kind === 'chat'
									? 'What should Chat know about how you like to be helped?'
									: 'How should Code approach your work and communicate with you?'
							}
							onChange={(event) => update({ customInstructions: event.target.value })}
						/>
					</SettingsRow>
				</SettingsGroup>
			</div>
		</div>
	);
}
