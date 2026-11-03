import { userFacingError } from '../lib/user-facing-error';
import Select from './Select';
import Switch from './Switch';
import { SettingsGroup, SettingsRow } from './SettingsList';
import { useState } from 'react';
import { ArrowLeft, Check, ChevronDown, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import type {
	Connection,
	JsonValue,
	Modality,
	ModelDefinition,
	ModelKind,
	ThinkingMode,
} from '../types';
import {
	assertModelCatalog,
	hasThinkingValue,
	hasThinkingParameters,
	standardThinkingMode,
	modelCompactionSettings,
	orderThinkingModes,
} from '../lib/catalog';
import ImagePresetsEditor from './ImagePresetsEditor';
import './model-catalog.css';

const TASKS: [ModelKind, string][] = [
	['chat', 'Chat'],
	['images', 'Images'],
	['videos', 'Video'],
	['speech', 'Speech'],
	['transcription', 'Transcription'],
];
const MODALITIES: Modality[] = ['text', 'image', 'audio', 'video'];
const MODEL_SECTIONS: { id: string; title: string; tasks: ModelKind[] }[] = [
	{ id: 'chat', title: 'Chat & Code', tasks: ['chat'] },
	{ id: 'images', title: 'Image', tasks: ['images'] },
	{ id: 'videos', title: 'Video', tasks: ['videos'] },
	{ id: 'audio', title: 'Audio', tasks: ['speech', 'transcription'] },
	{ id: 'unknown', title: 'Unknown', tasks: [] },
];
/** One primary section keeps multimodal models and their edit actions unique. */
function primaryModelSection(model?: ModelDefinition): string {
	return (
		MODEL_SECTIONS.find((section) => section.tasks.some((task) => model?.tasks.includes(task)))
			?.id || 'unknown'
	);
}
interface ModeDraft extends Omit<ThinkingMode, 'parameters'> {
	key: string;
	responses: string;
	chat: string;
}
interface Draft extends Omit<ModelDefinition, 'thinkingModes'> {
	thinkingModes: ModeDraft[];
}
interface Props {
	catalog: ModelDefinition[];
	discoveredModels: string[];
	modelIds?: string[];
	models?: Connection['models'];
	chatApi?: Connection['chatApi'];
	onDefaultsChange?: (models: Connection['models']) => void;
	thinkingPresets?: ThinkingMode[];
	readOnly?: boolean;
	onChange: (catalog: ModelDefinition[]) => void;
	onEditingChange: (editing: boolean) => void;
}
function modeDraft(mode: ThinkingMode): ModeDraft {
	return {
		id: mode.id,
		name: mode.name,
		key: crypto.randomUUID(),
		useProviderDefaults: mode.useProviderDefaults,
		responses: mode.parameters.responses ? JSON.stringify(mode.parameters.responses, null, 2) : '',
		chat: mode.parameters.chat ? JSON.stringify(mode.parameters.chat, null, 2) : '',
	};
}
function parseParameters(value: string, label: string): Record<string, JsonValue> | undefined {
	if (!value.trim()) return undefined;
	try {
		const result: unknown = JSON.parse(value);
		if (result === null || Array.isArray(result) || typeof result !== 'object') throw new Error();
		if (!hasThinkingValue(result as Record<string, JsonValue>))
			throw new Error(`${label} must specify a thinking value.`);
		return result as Record<string, JsonValue>;
	} catch (error) {
		if (error instanceof Error && error.message.includes('must specify')) throw error;
		throw new Error(`${label} must be a JSON object with an explicit thinking value.`);
	}
}
function ChoiceGroup<T extends string>({
	label,
	values,
	choices,
	onChange,
	disabled = false,
}: {
	label: string;
	values: T[];
	choices: [T, string][];
	onChange: (values: T[]) => void;
	disabled?: boolean;
}) {
	return (
		<SettingsRow layout="stacked" className="catalog-choice-row">
			<fieldset className="catalog-choices" disabled={disabled}>
				<legend>{label}</legend>
				<div>
					{choices.map(([value, name]) => (
						<label key={value}>
							<input
								type="checkbox"
								aria-label={`${label}: ${name}`}
								checked={values.includes(value)}
								onChange={(event) =>
									onChange(
										event.target.checked ? [...values, value] : values.filter((v) => v !== value),
									)
								}
							/>
							{name}
						</label>
					))}
				</div>
			</fieldset>
		</SettingsRow>
	);
}
function ContextSettings({
	model,
	onChange,
}: {
	model: Draft;
	onChange: (patch: Partial<Draft>) => void;
}) {
	let windowLabel = '';
	try {
		windowLabel = `Effective context window: ${modelCompactionSettings(model).contextWindow.toLocaleString()} tokens.`;
	} catch (error) {
		windowLabel =
			error instanceof Error ? error.message.replace(/^Model: /, '') : 'Check this limit.';
	}
	return (
		<SettingsGroup
			title="Context window"
			className="catalog-context"
			footer={
				<>
					Shared by Chat and Code. Set the context window supported by your backend. Leave blank to
					use FreeLM’s fallback of 128,000 tokens; this is not the model’s advertised capacity.
					Configure compaction behavior for all Code models in Settings → Code.
				</>
			}
		>
			<SettingsRow
				label="Context window (tokens)"
				description={<output aria-live="polite">{windowLabel}</output>}
			>
				<input
					aria-label="Context window (tokens)"
					type="number"
					min={1}
					step={1}
					placeholder="128000"
					value={model.contextWindow ?? ''}
					onChange={(event) =>
						onChange({
							contextWindow: event.target.value === '' ? undefined : event.target.valueAsNumber,
						})
					}
				/>
			</SettingsRow>
		</SettingsGroup>
	);
}
export default function ModelCatalogEditor({
	catalog,
	discoveredModels,
	modelIds = [],
	models,
	chatApi = 'responses',
	onDefaultsChange,
	thinkingPresets = [],
	readOnly = false,
	onChange,
	onEditingChange,
}: Props) {
	const [draft, setDraft] = useState<Draft | null>(null);
	const [editingIndex, setEditingIndex] = useState<number | null>(null);
	const [query, setQuery] = useState('');
	const [defaultTasks, setDefaultTasks] = useState<ModelKind[]>([]);
	const [error, setError] = useState('');
	const [notice, setNotice] = useState('');
	const endpoint = chatApi === 'responses' ? 'responses' : 'chat';
	const orderedDraftModes = orderThinkingModes(draft?.thinkingModes || []);
	const usableDraftModes = (draft?.thinkingModes || []).filter((mode) => {
		if (!mode.id.trim()) return false;
		try {
			return mode.useProviderDefaults || !!parseParameters(mode[endpoint], 'Thinking parameters');
		} catch {
			return false;
		}
	});
	const draftDefault =
		usableDraftModes.find((mode) => mode.id === draft?.defaultThinkingMode)?.id ||
		usableDraftModes[0]?.id ||
		'';
	const configuredModels = new Map(catalog.map((model, index) => [model.id, { model, index }]));
	const allIds = [
		...new Set([
			...catalog.map((model) => model.id),
			...discoveredModels,
			...modelIds,
			...Object.values(models || {}),
		]),
	].filter(Boolean);
	const matchingModels = allIds.filter((id) => {
		const name = configuredModels.get(id)?.model.name || id;
		return `${name} ${id}`.toLowerCase().includes(query.trim().toLowerCase());
	});
	const modelSections = MODEL_SECTIONS.map((section) => ({
		...section,
		ids: matchingModels.filter(
			(id) => primaryModelSection(configuredModels.get(id)?.model) === section.id,
		),
	})).filter((section) => section.ids.length > 0);
	function begin(model?: ModelDefinition, index?: number, id = '') {
		if (readOnly || draft) return;
		setDraft(
			model
				? { ...structuredClone(model), thinkingModes: model.thinkingModes.map(modeDraft) }
				: {
						id,
						name: id,
						enabled: true,
						tasks: ['chat'],
						inputModalities: ['text'],
						outputModalities: ['text'],
						thinkingModes: [],
					},
		);
		setEditingIndex(index ?? null);
		setDefaultTasks(
			TASKS.filter(([task]) => models?.[task] === (model?.id || id) && !!(model?.id || id)).map(
				([task]) => task,
			),
		);
		setError('');
		setNotice('');
		onEditingChange(true);
	}
	function cancel() {
		setDraft(null);
		setError('');
		onEditingChange(false);
	}
	function update(patch: Partial<Draft>) {
		setDraft((value) => (value ? { ...value, ...patch } : value));
		setError('');
	}
	function updateMode(key: string, patch: Partial<ModeDraft>) {
		if (!draft) return;
		update({
			thinkingModes: draft.thinkingModes.map((mode) =>
				mode.key === key ? { ...mode, ...patch } : mode,
			),
		});
	}
	function apply() {
		if (!draft || readOnly) return;
		try {
			const model: ModelDefinition = {
				...draft,
				id: draft.id.trim(),
				name: draft.name.trim(),
				defaultThinkingMode: draft.defaultThinkingMode?.trim() || undefined,
				imagePresets: draft.imagePresets?.map((preset) => ({
					...preset,
					name: preset.name.trim(),
					quality: preset.quality?.trim() || undefined,
					aspectRatios: preset.aspectRatios.map((ratio) => ({ ...ratio, name: ratio.name.trim() })),
				})),
				thinkingModes: draft.thinkingModes.map((mode) => ({
					id: mode.id.trim(),
					...(mode.useProviderDefaults ? { useProviderDefaults: true } : {}),
					name: mode.name.trim(),
					parameters: mode.useProviderDefaults
						? { responses: {}, chat: {} }
						: {
								...(mode.responses.trim()
									? {
											responses: parseParameters(
												mode.responses,
												`${mode.name || 'Thinking mode'} Responses parameters`,
											),
										}
									: {}),
								...(mode.chat.trim()
									? {
											chat: parseParameters(
												mode.chat,
												`${mode.name || 'Thinking mode'} Chat parameters`,
											),
										}
									: {}),
							},
				})),
			};
			if (model.tasks.includes('chat')) {
				const usable = model.thinkingModes.filter((mode) => hasThinkingParameters(mode, endpoint));
				if (!usable.length)
					throw new Error(
						`Configure at least one thinking value or Standard mode for the ${endpoint === 'responses' ? 'Responses' : 'Chat'} API.`,
					);
				model.defaultThinkingMode =
					usable.find((mode) => mode.id === model.defaultThinkingMode)?.id || usable[0].id;
			} else model.defaultThinkingMode = undefined;
			const next =
				editingIndex === null
					? [...catalog, model]
					: catalog.map((existing, index) => (index === editingIndex ? model : existing));
			assertModelCatalog(next);
			if (models && onDefaultsChange) {
				const previousId = editingIndex === null ? model.id : catalog[editingIndex].id;
				const nextDefaults = { ...models };
				for (const [task] of TASKS) {
					if (defaultTasks.includes(task) && model.tasks.includes(task) && model.enabled)
						nextDefaults[task] = model.id;
					else if (models[task] === previousId) nextDefaults[task] = '';
				}
				onDefaultsChange(nextDefaults);
			}
			onChange(next);
			setNotice(`${model.name} is ready. Save settings to keep your changes.`);
			setDraft(null);
			onEditingChange(false);
			setError('');
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Check the model details.');
		}
	}
	return (
		<div className="model-catalog">
			{!draft && (
				<>
					<SettingsGroup
						title="Models"
						id="model-catalog-title"
						actions={
							!readOnly && (
								<button className="secondary-button compact" onClick={() => begin()}>
									<Plus size={14} /> Add model
								</button>
							)
						}
						footer={notice && <span role="status">{notice}</span>}
					>
						<SettingsRow label="Find a model" layout="stacked" className="catalog-search-row">
							<label className="catalog-search">
								<Search size={16} aria-hidden="true" />
								<input
									aria-label="Search models"
									placeholder="Search models by name or API ID"
									value={query}
									onChange={(event) => setQuery(event.target.value)}
								/>
							</label>
							<p className="catalog-count">
								{allIds.length} {allIds.length === 1 ? 'model' : 'models'} · {catalog.length}{' '}
								configured
							</p>
						</SettingsRow>
						{allIds.length === 0 ? (
							<SettingsRow layout="stacked" className="catalog-empty">
								Discover models from this connection, or add a model by its API ID.
							</SettingsRow>
						) : matchingModels.length === 0 ? (
							<SettingsRow layout="stacked" className="catalog-empty">
								No models match “{query}”. Try another name or API ID.
							</SettingsRow>
						) : null}
					</SettingsGroup>
					{modelSections.map((section) => (
						<SettingsGroup title={section.title} key={section.id} className="catalog-model-section">
							{section.ids.map((id) => {
								const configured = configuredModels.get(id);
								const model = configured?.model;
								return (
									<SettingsRow
										className={`catalog-entry ${model && !model.enabled ? 'catalog-entry-disabled' : ''}`}
										key={id}
										label={model?.name || id}
										description={model && model.name !== id ? <code>{id}</code> : undefined}
									>
										{!readOnly && (
											<button
												className="secondary-button compact"
												aria-label={`${model ? 'Edit' : 'Configure'} model ${model?.name || id}`}
												onClick={() => begin(model, configured?.index, id)}
											>
												{model ? <Pencil size={13} /> : <Plus size={13} />}{' '}
												{model ? 'Edit' : 'Configure'}
											</button>
										)}
									</SettingsRow>
								);
							})}
						</SettingsGroup>
					))}
				</>
			)}
			{draft && (
				<div
					className="catalog-editor"
					role="group"
					aria-label={editingIndex === null ? 'New catalog model' : 'Edit catalog model'}
				>
					<div className="catalog-editor-title">
						<button
							className="icon-button"
							aria-label="Cancel model changes and return to models"
							onClick={cancel}
						>
							<ArrowLeft size={17} />
						</button>
						<h4>
							{editingIndex === null
								? draft.id
									? `Configure ${draft.id}`
									: 'New model'
								: `Edit ${catalog[editingIndex]?.name}`}
						</h4>
					</div>
					<SettingsGroup title="Model identity">
						<SettingsRow label="Enabled in model choosers">
							<Switch
								aria-label="Enabled in model choosers"
								checked={draft.enabled}
								onChange={(enabled) => update({ enabled })}
							/>
						</SettingsRow>
						<SettingsRow label="Display name">
							<input
								aria-label="Display name"
								autoFocus
								value={draft.name}
								onChange={(event) => update({ name: event.target.value })}
								placeholder="My reasoning model"
							/>
						</SettingsRow>
						<SettingsRow label="API model ID">
							<input
								aria-label="API model ID"
								value={draft.id}
								onChange={(event) => update({ id: event.target.value })}
								placeholder="provider/model-id"
							/>
						</SettingsRow>
					</SettingsGroup>
					<SettingsGroup
						title="Capabilities"
						footer="Declare the inputs and outputs your provider supports. The current chat interface sends text and image attachments."
					>
						<ChoiceGroup
							label="Available in"
							values={draft.tasks}
							choices={TASKS}
							onChange={(tasks) =>
								update({
									tasks,
									...(!tasks.includes('images')
										? { imagePresets: undefined, defaultImagePreset: undefined }
										: {}),
									...(!tasks.includes('chat')
										? {
												contextWindow: undefined,
											}
										: {}),
								})
							}
						/>
						<ChoiceGroup
							label="Input modalities"
							values={draft.inputModalities}
							choices={MODALITIES.map((modality) => [modality, modality])}
							onChange={(inputModalities) => update({ inputModalities })}
						/>
						<ChoiceGroup
							label="Output modalities"
							values={draft.outputModalities}
							choices={MODALITIES.map((modality) => [modality, modality])}
							onChange={(outputModalities) => update({ outputModalities })}
						/>

						{models && onDefaultsChange && (
							<>
								<ChoiceGroup
									label="Use as default for"
									values={defaultTasks}
									disabled={!draft.enabled}
									choices={TASKS.filter(([task]) => draft.tasks.includes(task))}
									onChange={setDefaultTasks}
								/>
								<SettingsRow layout="stacked" className="catalog-empty">
									Used when starting a new chat or opening a playground with this connection.
								</SettingsRow>
							</>
						)}
					</SettingsGroup>
					{draft.tasks.includes('images') && (
						<ImagePresetsEditor
							modelId={draft.id}
							presets={draft.imagePresets ?? []}
							defaultPreset={draft.defaultImagePreset}
							onChange={(imagePresets, defaultImagePreset) =>
								update({
									imagePresets: imagePresets.length ? imagePresets : undefined,
									defaultImagePreset,
								})
							}
						/>
					)}
					{draft.tasks.includes('chat') && <ContextSettings model={draft} onChange={update} />}
					<SettingsGroup
						title="Thinking modes"
						description="Choose Standard for models without thinking parameters, or configure explicit thinking values. New chats use the default mode below."
						actions={
							<>
								<button
									className="secondary-button compact"
									disabled={!draft.tasks.includes('chat') || draft.thinkingModes.length >= 32}
									onClick={() =>
										update({
											thinkingModes: [
												...draft.thinkingModes,
												modeDraft({ id: '', name: '', parameters: {} }),
											],
										})
									}
								>
									<Plus size={13} /> Add thinking mode
								</button>
								<button
									className="secondary-button compact"
									disabled={
										!draft.tasks.includes('chat') ||
										draft.thinkingModes.length >= 32 ||
										draft.thinkingModes.some((mode) => mode.id === 'standard')
									}
									onClick={() =>
										update({
											thinkingModes: [...draft.thinkingModes, modeDraft(standardThinkingMode())],
										})
									}
								>
									Add Standard mode
								</button>
							</>
						}
					>
						{thinkingPresets.length > 0 && (
							<SettingsRow
								layout="stacked"
								label="Add from your thinking values"
								className="catalog-presets"
							>
								<div className="catalog-preset-options">
									{orderThinkingModes(thinkingPresets).map((preset) => {
										const added = draft.thinkingModes.some((mode) => mode.id === preset.id);
										return (
											<button
												key={preset.id}
												className="secondary-button compact"
												aria-label={`Add thinking value ${preset.name}`}
												disabled={
													!draft.tasks.includes('chat') || added || draft.thinkingModes.length >= 32
												}
												onClick={() =>
													update({ thinkingModes: [...draft.thinkingModes, modeDraft(preset)] })
												}
											>
												{added ? <Check size={13} /> : <Plus size={13} />} {preset.name}
											</button>
										);
									})}
								</div>
								<p className="field-hint">
									Adds a copy to this model. Changes here do not change your reusable thinking
									values.
								</p>
							</SettingsRow>
						)}
						{orderedDraftModes.map((mode, index) => (
							<SettingsRow layout="stacked" className="catalog-mode" key={mode.key}>
								<div className="catalog-mode-heading">
									<strong>Mode {index + 1}</strong>
									<button
										className="icon-button danger"
										aria-label={`Remove thinking mode ${index + 1}`}
										onClick={() =>
											update({
												thinkingModes: draft.thinkingModes.filter((item) => item.key !== mode.key),
												defaultThinkingMode:
													draft.defaultThinkingMode === mode.id
														? undefined
														: draft.defaultThinkingMode,
											})
										}
									>
										<Trash2 size={14} />
									</button>
								</div>
								<div className="catalog-field-pair">
									<label>
										Mode name
										<input
											aria-label={`Thinking mode ${index + 1} name`}
											value={mode.name}
											onChange={(event) => updateMode(mode.key, { name: event.target.value })}
											placeholder="High"
										/>
									</label>
									<label>
										Mode ID
										<input
											aria-label={`Thinking mode ${index + 1} ID`}
											value={mode.id}
											onChange={(event) => {
												const id = event.target.value;
												update({
													thinkingModes: draft.thinkingModes.map((item) =>
														item.key === mode.key ? { ...item, id } : item,
													),
													defaultThinkingMode:
														draft.defaultThinkingMode === mode.id ? id : draft.defaultThinkingMode,
												});
											}}
											placeholder="high"
										/>
									</label>
								</div>
								<label className="catalog-custom-toggle">
									<Switch
										aria-label={`Thinking mode ${index + 1} use provider defaults`}
										checked={!!mode.useProviderDefaults}
										onChange={(useProviderDefaults) =>
											updateMode(mode.key, {
												useProviderDefaults,
											})
										}
									/>
									Send no thinking parameters (provider defaults)
								</label>
								<details className="catalog-advanced">
									<summary>
										<ChevronDown size={13} /> Request parameters
									</summary>
									<p className="field-hint">
										JSON objects are merged into their endpoint’s request. Each configured endpoint
										must specify a thinking value unless provider defaults are selected. Empty
										fields leave that API unconfigured. Request content, model, and transport fields
										cannot be overridden.
									</p>
									<label>
										Responses JSON
										<textarea
											aria-label={`Thinking mode ${index + 1} Responses JSON`}
											rows={4}
											spellCheck={false}
											value={mode.responses}
											disabled={mode.useProviderDefaults}
											onChange={(event) => updateMode(mode.key, { responses: event.target.value })}
											placeholder={'{"reasoning": {"effort": "high"}}'}
										/>
									</label>
									<label>
										Chat JSON
										<textarea
											aria-label={`Thinking mode ${index + 1} Chat JSON`}
											rows={4}
											spellCheck={false}
											value={mode.chat}
											disabled={mode.useProviderDefaults}
											onChange={(event) => updateMode(mode.key, { chat: event.target.value })}
											placeholder={'{"reasoning_effort": "high"}'}
										/>
									</label>
								</details>
							</SettingsRow>
						))}
						<SettingsRow label="Default thinking mode">
							<Select
								aria-label="Default thinking mode"
								value={draftDefault}
								disabled={!draft.tasks.includes('chat') || !usableDraftModes.length}
								onChange={(defaultThinkingMode) => update({ defaultThinkingMode })}
								placeholder="Configure a mode"
								options={orderedDraftModes
									.filter((mode) => mode.id.trim())
									.map((mode) => ({
										value: mode.id,
										label: mode.name || mode.id,
										disabled: !usableDraftModes.includes(mode),
									}))}
							/>
						</SettingsRow>
					</SettingsGroup>
					{error && (
						<div className="error-note" role="alert">
							{userFacingError(error)}
						</div>
					)}
					<div className="catalog-editor-actions">
						{editingIndex !== null && (
							<button
								className="secondary-button compact danger catalog-remove"
								onClick={() => {
									onChange(catalog.filter((_, index) => index !== editingIndex));
									cancel();
									setNotice(
										'Model configuration removed. Configure a thinking value or Standard mode before using this model in chat.',
									);
								}}
							>
								<Trash2 size={14} /> Remove configuration
							</button>
						)}
						<button className="secondary-button compact" onClick={cancel}>
							Cancel model changes
						</button>
						<button className="primary-button compact" onClick={apply}>
							<Check size={14} /> Apply model
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
