import { userFacingError } from '../lib/user-facing-error';
import Switch from './Switch';
import { SettingsGroup, SettingsRow } from './SettingsList';
import { useState } from 'react';
import { Check, ChevronDown, Pencil, Plus, Trash2 } from 'lucide-react';
import type { JsonValue, ThinkingMode } from '../types';
import { assertThinkingPresets, hasThinkingValue } from '../lib/catalog';
import './model-catalog.css';

interface Props {
	presets: ThinkingMode[];
	onChange: (presets: ThinkingMode[]) => void;
	onEditingChange: (editing: boolean) => void;
	readOnly?: boolean;
}
interface Draft {
	id: string;
	name: string;
	effort: string;
	custom: boolean;
	useProviderDefaults?: boolean;
	responses: string;
	chat: string;
}
function simpleEffort(mode: ThinkingMode): string | undefined {
	const { responses, chat } = mode.parameters;
	const reasoning = responses?.reasoning;
	if (!reasoning || typeof reasoning !== 'object' || Array.isArray(reasoning)) return;
	const effort = reasoning.effort;
	if (
		typeof effort === 'string' &&
		Object.keys(responses!).length === 1 &&
		Object.keys(reasoning).length === 1 &&
		chat?.reasoning_effort === effort &&
		Object.keys(chat).length === 1
	)
		return effort;
}
function parameters(
	value: string,
	endpoint: string,
	useProviderDefaults = false,
): Record<string, JsonValue> | undefined {
	if (!value.trim()) return;
	try {
		const parsed: unknown = JSON.parse(value);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
		if (
			!hasThinkingValue(parsed as Record<string, JsonValue>) &&
			!(useProviderDefaults && Object.keys(parsed).length === 0)
		)
			throw new Error(`${endpoint} parameters must specify a thinking value.`);
		return parsed as Record<string, JsonValue>;
	} catch (error) {
		if (error instanceof Error && error.message.includes('must specify')) throw error;
		throw new Error(
			`${endpoint} parameters must be a JSON object with an explicit thinking value.`,
		);
	}
}
function effortParameters(effort: string): ThinkingMode['parameters'] {
	return { responses: { reasoning: { effort } }, chat: { reasoning_effort: effort } };
}
export default function ThinkingPresetsEditor({
	presets,
	onChange,
	onEditingChange,
	readOnly = false,
}: Props) {
	const [draft, setDraft] = useState<Draft | null>(null);
	const [editingIndex, setEditingIndex] = useState<number | null>(null);
	const [error, setError] = useState('');
	const [notice, setNotice] = useState('');
	function begin(mode?: ThinkingMode, index?: number) {
		if (readOnly || draft) return;
		const effort = mode ? simpleEffort(mode) : '';
		setDraft({
			id: mode?.id || '',
			name: mode?.name || '',
			effort: effort || '',
			custom: !!mode && effort === undefined,
			useProviderDefaults: mode?.useProviderDefaults,
			responses: mode?.parameters.responses
				? JSON.stringify(mode.parameters.responses, null, 2)
				: '',
			chat: mode?.parameters.chat ? JSON.stringify(mode.parameters.chat, null, 2) : '',
		});
		setEditingIndex(index ?? null);
		setError('');
		setNotice('');
		onEditingChange(true);
	}
	function update(patch: Partial<Draft>) {
		setDraft((value) => (value ? { ...value, ...patch } : value));
		setError('');
	}
	function cancel() {
		setDraft(null);
		setError('');
		onEditingChange(false);
	}
	function apply() {
		if (!draft || readOnly) return;
		try {
			if (!draft.custom && !draft.effort.trim())
				throw new Error('Enter the API effort value, or use custom JSON parameters.');
			const responseParameters = draft.custom
				? parameters(draft.responses, 'Responses', draft.useProviderDefaults)
				: undefined;
			const chatParameters = draft.custom
				? parameters(draft.chat, 'Chat', draft.useProviderDefaults)
				: undefined;
			const mode: ThinkingMode = {
				id: draft.id.trim() || draft.effort.trim() || crypto.randomUUID(),
				name: draft.name.trim(),
				...(draft.custom && draft.useProviderDefaults ? { useProviderDefaults: true } : {}),
				parameters: draft.custom
					? {
							...(responseParameters ? { responses: responseParameters } : {}),
							...(chatParameters ? { chat: chatParameters } : {}),
						}
					: effortParameters(draft.effort.trim()),
			};
			const next =
				editingIndex === null
					? [...presets, mode]
					: presets.map((item, index) => (index === editingIndex ? mode : item));
			assertThinkingPresets(next);
			onChange(next);
			cancel();
			setNotice(`${mode.name} is ready to add to your models. Save settings to keep your changes.`);
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Check the thinking value.');
		}
	}
	return (
		<SettingsGroup
			className="thinking-presets"
			id="thinking-presets-title"
			title="Thinking values"
			description="Name the effort values you want to reuse across models."
			actions={
				!readOnly && (
					<button
						className="secondary-button compact"
						disabled={!!draft || presets.length >= 128}
						onClick={() => begin()}
					>
						<Plus size={14} /> Add thinking value
					</button>
				)
			}
			footer={
				<>
					Configure a model below to add the values it supports. Adding a value creates a copy;
					existing model settings stay independent.
					{readOnly && <p>Thinking values are managed on the connected FreeLM host.</p>}
					{notice && <p role="status">{notice}</p>}
				</>
			}
		>
			{!draft && (
				<>
					{presets.length === 0 && (
						<SettingsRow layout="stacked" className="catalog-empty">
							No thinking values yet. Add a display name and the value your API accepts.
						</SettingsRow>
					)}
					{presets.map((mode, index) => (
						<SettingsRow
							className="thinking-preset-row"
							key={mode.id}
							label={mode.name}
							description={<code>{simpleEffort(mode) ?? 'Custom request parameters'}</code>}
						>
							{!readOnly && (
								<>
									<button
										className="icon-button"
										aria-label={`Edit thinking value ${mode.name}`}
										onClick={() => begin(mode, index)}
									>
										<Pencil size={14} />
									</button>
									<button
										className="icon-button danger"
										aria-label={`Remove thinking value ${mode.name}`}
										onClick={() => onChange(presets.filter((_, i) => i !== index))}
									>
										<Trash2 size={14} />
									</button>
								</>
							)}
						</SettingsRow>
					))}
				</>
			)}
			{draft && (
				<SettingsRow layout="stacked" className="thinking-value-editor">
					<div
						className="catalog-editor"
						role="group"
						aria-label={editingIndex === null ? 'New thinking value' : 'Edit thinking value'}
					>
						<h4>
							{editingIndex === null ? 'New thinking value' : `Edit ${presets[editingIndex]?.name}`}
						</h4>
						<div className="catalog-field-pair">
							<label>
								Display name
								<input
									autoFocus
									aria-label="Thinking value display name"
									value={draft.name}
									onChange={(event) => update({ name: event.target.value })}
									placeholder="High"
								/>
							</label>
							{!draft.custom && (
								<label>
									API effort value
									<input
										aria-label="API effort value"
										value={draft.effort}
										onChange={(event) => update({ effort: event.target.value })}
										placeholder="high"
									/>
								</label>
							)}
						</div>
						{!draft.custom && (
							<p className="field-hint">
								Sends reasoning.effort to Responses and reasoning_effort to Chat. Values are case
								sensitive and depend on your API.
							</p>
						)}
						<details className="catalog-advanced" open={draft.custom || undefined}>
							<summary>
								<ChevronDown size={13} /> Advanced parameters
							</summary>
							<label className="catalog-custom-toggle">
								<Switch
									aria-label="Use custom JSON parameters"
									checked={draft.custom}
									onChange={(custom) => {
										if (custom && draft.effort.trim()) {
											const values = effortParameters(draft.effort.trim());
											update({
												custom,
												responses: JSON.stringify(values.responses, null, 2),
												chat: JSON.stringify(values.chat, null, 2),
											});
										} else update({ custom });
									}}
								/>
								Use custom JSON parameters
							</label>
							{draft.custom && (
								<>
									<p className="field-hint">
										Configure each API you use with an explicit thinking value. Empty fields leave
										that API unconfigured.
									</p>
									<label>
										Responses JSON
										<textarea
											aria-label="Thinking value Responses JSON"
											rows={4}
											spellCheck={false}
											value={draft.responses}
											onChange={(event) => update({ responses: event.target.value })}
											placeholder={'{"reasoning":{"effort":"high"}}'}
										/>
									</label>
									<label>
										Chat JSON
										<textarea
											aria-label="Thinking value Chat JSON"
											rows={4}
											spellCheck={false}
											value={draft.chat}
											onChange={(event) => update({ chat: event.target.value })}
											placeholder={'{"reasoning_effort":"high"}'}
										/>
									</label>
								</>
							)}
							<label className="catalog-mode-id">
								Value ID
								<input
									aria-label="Thinking value ID"
									value={draft.id}
									onChange={(event) => update({ id: event.target.value })}
									placeholder="Generated from the effort value"
								/>
							</label>
						</details>
						{error && (
							<div className="error-note" role="alert">
								{userFacingError(error)}
							</div>
						)}
						<div className="catalog-editor-actions">
							<button className="secondary-button compact" onClick={cancel}>
								Cancel thinking value
							</button>
							<button className="primary-button compact" onClick={apply}>
								<Check size={14} /> Apply thinking value
							</button>
						</div>
					</div>
				</SettingsRow>
			)}
		</SettingsGroup>
	);
}
