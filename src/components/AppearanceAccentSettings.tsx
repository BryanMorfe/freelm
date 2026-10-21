import { ArrowUp } from 'lucide-react';
import type { AppearanceAccent, AppearanceSettings, AppState } from '../types';
import {
	appearanceOptions,
	defaultAppearance,
	normalizeAccentColor,
	resolveAppearance,
} from '../lib/appearance';
import Select from './Select';
import { SettingsGroup, SettingsRow } from './SettingsList';

export default function AppearanceAccentSettings({
	appearance,
	theme,
	disabled,
	onChange,
}: {
	appearance: AppearanceSettings;
	theme: AppState['theme'];
	disabled: boolean;
	onChange: (appearance: AppearanceSettings) => void;
}) {
	const customColor = normalizeAccentColor(appearance.customAccent);
	const custom = appearance.accent === 'custom';
	const colors = resolveAppearance(
		{ ...appearance, customAccent: customColor || defaultAppearance().customAccent },
		theme === 'system'
			? window.matchMedia('(prefers-color-scheme: dark)').matches
				? 'dark'
				: 'light'
			: theme,
	);
	return (
		<SettingsGroup title="Colors" className="appearance-accent-settings">
			<SettingsRow
				label="Accent color"
				htmlFor="appearance-accent"
				description="Color your message bubbles and primary buttons."
			>
				<Select
					id="appearance-accent"
					aria-label="Accent color"
					value={appearance.accent}
					options={appearanceOptions.map((option) =>
						option.value === 'custom'
							? { ...option, color: customColor || defaultAppearance().customAccent }
							: option,
					)}
					disabled={disabled}
					onChange={(accent) =>
						onChange({
							accent: accent as AppearanceAccent,
							customAccent: customColor || defaultAppearance().customAccent,
						})
					}
				/>
			</SettingsRow>
			{custom && (
				<SettingsRow layout="stacked">
					<div className="appearance-custom-color">
						<input
							type="color"
							aria-label="Choose custom accent color"
							value={customColor || defaultAppearance().customAccent}
							disabled={disabled}
							onChange={(event) => onChange({ ...appearance, customAccent: event.target.value })}
						/>
						<label>
							<span>Custom accent color</span>
							<input
								type="text"
								aria-label="Custom accent color"
								aria-describedby={!customColor ? 'custom-accent-error' : undefined}
								aria-invalid={!customColor}
								value={appearance.customAccent}
								maxLength={7}
								placeholder="#3478f6"
								spellCheck={false}
								disabled={disabled}
								onChange={(event) => onChange({ ...appearance, customAccent: event.target.value })}
							/>
						</label>
						{!customColor && (
							<small id="custom-accent-error" className="error-note" role="alert">
								Enter a hex color such as #3478f6 or #abc.
							</small>
						)}
					</div>
				</SettingsRow>
			)}
			<SettingsRow layout="stacked">
				<div className="appearance-accent-preview" role="group" aria-label="Accent preview">
					<span
						className="appearance-preview-bubble"
						style={{ backgroundColor: colors.bubble, color: colors.bubbleText }}
					>
						This is how your messages will look.
					</span>
					<span
						className="appearance-preview-send"
						style={{ backgroundColor: colors.primary, color: colors.onPrimary }}
						aria-hidden="true"
					>
						<ArrowUp size={18} />
					</span>
				</div>
			</SettingsRow>
		</SettingsGroup>
	);
}
