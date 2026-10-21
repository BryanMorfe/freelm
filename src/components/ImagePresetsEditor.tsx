import Select from './Select';
import { SettingsGroup, SettingsRow } from './SettingsList';
import { useState } from 'react';
import { ChevronDown, Plus, Sparkles, Trash2 } from 'lucide-react';
import type { ImageAspectRatioPreset, ImageQualityPreset } from '../types';
import { recommendedImagePresets } from '../lib/image-presets';

interface Props {
	modelId: string;
	presets: ImageQualityPreset[];
	defaultPreset?: string;
	onChange: (presets: ImageQualityPreset[], defaultPreset?: string) => void;
}
function newRatio(): ImageAspectRatioPreset {
	return { id: crypto.randomUUID(), name: '', width: 0, height: 0 };
}
export default function ImagePresetsEditor({ modelId, presets, defaultPreset, onChange }: Props) {
	const [expanded, setExpanded] = useState<string | null>(null);
	const recommendations = recommendedImagePresets(modelId.trim());
	function updatePreset(id: string, patch: Partial<ImageQualityPreset>) {
		onChange(
			presets.map((preset) => (preset.id === id ? { ...preset, ...patch } : preset)),
			defaultPreset,
		);
	}
	function updateRatio(
		preset: ImageQualityPreset,
		id: string,
		patch: Partial<ImageAspectRatioPreset>,
	) {
		updatePreset(preset.id, {
			aspectRatios: preset.aspectRatios.map((ratio) =>
				ratio.id === id ? { ...ratio, ...patch } : ratio,
			),
		});
	}
	function addPreset() {
		const ratio = newRatio();
		const preset: ImageQualityPreset = {
			id: crypto.randomUUID(),
			name: '',
			aspectRatios: [ratio],
			defaultAspectRatio: ratio.id,
		};
		onChange([...presets, preset], defaultPreset || preset.id);
		setExpanded(preset.id);
	}
	function removePreset(id: string) {
		const next = presets.filter((preset) => preset.id !== id);
		onChange(next, defaultPreset === id ? next[0]?.id : defaultPreset);
		if (expanded === id) setExpanded(null);
	}
	function useRecommendations() {
		onChange(recommendations, recommendations[0]?.id);
		setExpanded(null);
	}
	return (
		<SettingsGroup
			className="image-presets-editor"
			id="image-presets-title"
			title="Image presets"
			description="Group image sizes by quality or resolution, then choose the aspect ratios available in the image playground. Labels stay in FreeLM; only dimensions and an optional API quality value are sent."
			actions={
				<button
					className="secondary-button compact"
					disabled={presets.length >= 32}
					onClick={addPreset}
				>
					<Plus size={13} /> Add image preset
				</button>
			}
		>
			{recommendations.length > 0 && (
				<SettingsRow
					label="Recommended sizes"
					description={`${presets.length ? 'Replaces the presets below with' : 'Adds'} recommended presets for ${modelId}. Review them for your provider.`}
					className="image-preset-recommendations"
				>
					<button className="secondary-button compact" onClick={useRecommendations}>
						<Sparkles size={13} /> Use recommended presets
					</button>
				</SettingsRow>
			)}
			{presets.length === 0 && (
				<SettingsRow layout="stacked" className="catalog-empty">
					No image presets. The playground will use custom dimensions and provider quality values.
				</SettingsRow>
			)}
			{presets.map((preset, presetIndex) => (
				<SettingsRow layout="stacked" className="image-preset-list-row" key={preset.id}>
					<details className="image-preset-card" open={expanded === preset.id}>
						<summary
							onClick={(event) => {
								event.preventDefault();
								setExpanded(expanded === preset.id ? null : preset.id);
							}}
						>
							<ChevronDown size={14} aria-hidden="true" />
							<div>
								<strong>{preset.name || `Image preset ${presetIndex + 1}`}</strong>
								<span>
									{preset.aspectRatios.length}{' '}
									{preset.aspectRatios.length === 1 ? 'aspect ratio' : 'aspect ratios'}
									{preset.quality ? ` · API quality: ${preset.quality}` : ' · No API quality'}
									{defaultPreset === preset.id ? ' · Default' : ''}
								</span>
							</div>
						</summary>
						<div className="image-preset-fields">
							<div className="catalog-field-pair">
								<label>
									Preset label
									<input
										aria-label={`Image preset ${presetIndex + 1} label`}
										maxLength={128}
										value={preset.name}
										onChange={(event) => updatePreset(preset.id, { name: event.target.value })}
										placeholder="Recommended 2K"
									/>
								</label>
								<label>
									API quality <span className="optional">optional</span>
									<input
										aria-label={`Image preset ${presetIndex + 1} API quality`}
										maxLength={256}
										value={preset.quality ?? ''}
										onChange={(event) =>
											updatePreset(preset.id, { quality: event.target.value || undefined })
										}
										placeholder="e.g. high"
									/>
								</label>
							</div>
							<p className="field-hint">
								Leave API quality empty when the model does not support it. A resolution label such
								as 2K is not sent as quality.
							</p>
							<div className="image-ratios-heading">
								<h5>Aspect ratios</h5>
								<button
									className="secondary-button compact"
									aria-label={`Add aspect ratio to image preset ${presetIndex + 1}`}
									disabled={preset.aspectRatios.length >= 64}
									onClick={() => {
										const ratio = newRatio();
										updatePreset(preset.id, {
											aspectRatios: [...preset.aspectRatios, ratio],
											defaultAspectRatio: preset.defaultAspectRatio || ratio.id,
										});
									}}
								>
									<Plus size={13} /> Add aspect ratio
								</button>
							</div>
							{preset.aspectRatios.map((ratio, ratioIndex) => (
								<div className="image-ratio-row" key={ratio.id}>
									<label>
										Label
										<input
											aria-label={`Image preset ${presetIndex + 1} aspect ratio ${ratioIndex + 1} label`}
											maxLength={128}
											value={ratio.name}
											placeholder="Landscape 16:9"
											onChange={(event) =>
												updateRatio(preset, ratio.id, { name: event.target.value })
											}
										/>
									</label>
									<label>
										Width
										<input
											aria-label={`Image preset ${presetIndex + 1} aspect ratio ${ratioIndex + 1} width`}
											type="number"
											min={1}
											step={1}
											value={ratio.width || ''}
											placeholder="2048"
											onChange={(event) =>
												updateRatio(preset, ratio.id, { width: event.target.valueAsNumber || 0 })
											}
										/>
									</label>
									<span className="image-ratio-times" aria-hidden="true">
										×
									</span>
									<label>
										Height
										<input
											aria-label={`Image preset ${presetIndex + 1} aspect ratio ${ratioIndex + 1} height`}
											type="number"
											min={1}
											step={1}
											value={ratio.height || ''}
											placeholder="1152"
											onChange={(event) =>
												updateRatio(preset, ratio.id, { height: event.target.valueAsNumber || 0 })
											}
										/>
									</label>
									<button
										className="icon-button danger"
										aria-label={`Remove image preset ${presetIndex + 1} aspect ratio ${ratioIndex + 1}`}
										onClick={() => {
											const remaining = preset.aspectRatios.filter((item) => item.id !== ratio.id);
											updatePreset(preset.id, {
												aspectRatios: remaining,
												defaultAspectRatio:
													preset.defaultAspectRatio === ratio.id
														? remaining[0]?.id
														: preset.defaultAspectRatio,
											});
										}}
									>
										<Trash2 size={14} />
									</button>
								</div>
							))}
							<label>
								Default aspect ratio
								<Select
									aria-label={`Image preset ${presetIndex + 1} default aspect ratio`}
									value={preset.defaultAspectRatio ?? ''}
									onChange={(defaultAspectRatio) =>
										updatePreset(preset.id, { defaultAspectRatio: defaultAspectRatio || undefined })
									}
									options={[
										{ value: '', label: 'First available ratio' },
										...preset.aspectRatios.map((ratio, index) => ({
											value: ratio.id,
											label: ratio.name || `Aspect ratio ${index + 1}`,
										})),
									]}
								/>
							</label>
							<button
								className="secondary-button compact danger image-preset-remove"
								aria-label={`Remove image preset ${presetIndex + 1}`}
								onClick={() => removePreset(preset.id)}
							>
								<Trash2 size={13} /> Remove preset
							</button>
						</div>
					</details>
				</SettingsRow>
			))}
			{presets.length > 0 && (
				<SettingsRow label="Default image preset">
					<Select
						aria-label="Default image preset"
						value={defaultPreset ?? ''}
						onChange={(defaultValue) => onChange(presets, defaultValue || undefined)}
						options={[
							{ value: '', label: 'First available preset' },
							...presets.map((preset, index) => ({
								value: preset.id,
								label: preset.name || `Image preset ${index + 1}`,
							})),
						]}
					/>
				</SettingsRow>
			)}
		</SettingsGroup>
	);
}
