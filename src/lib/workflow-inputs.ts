import type { WorkflowDefinition, WorkflowRequest } from '../workflow-types';

const safeKey = (value: unknown): value is string =>
	typeof value === 'string' &&
	/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(value) &&
	!['__proto__', 'prototype', 'constructor'].includes(value);
const object = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === 'object' && !Array.isArray(value);
const matches = (value: unknown, type: string): boolean =>
	type === 'text'
		? typeof value === 'string'
		: type === 'number'
			? typeof value === 'number' && Number.isFinite(value)
			: type === 'boolean'
				? typeof value === 'boolean'
				: type === 'list'
					? Array.isArray(value)
					: object(value);

export function validateWorkflowRequest(request: WorkflowRequest | undefined): void {
	if (request === undefined) return;
	if (!object(request) || !object(request.prompt) || !safeKey(request.prompt.key))
		throw new Error('Workflow request requires a valid prompt field name.');
	for (const key of ['label', 'placeholder'] as const)
		if (
			request.prompt[key] !== undefined &&
			(typeof request.prompt[key] !== 'string' || request.prompt[key].length > 1000)
		)
			throw new Error('Workflow request labels and placeholders are limited to 1000 characters.');
	if (request.prompt.required !== undefined && typeof request.prompt.required !== 'boolean')
		throw new Error('Workflow request required state must be a boolean.');
	if (
		request.fields !== undefined &&
		(!Array.isArray(request.fields) || request.fields.length > 30)
	)
		throw new Error('Workflow requests support up to 30 additional fields.');
	const keys = new Set([request.prompt.key]);
	for (const field of request.fields ?? []) {
		if (
			!object(field) ||
			!safeKey(field.key) ||
			keys.has(field.key) ||
			typeof field.label !== 'string' ||
			!field.label.trim() ||
			field.label.length > 200 ||
			!['text', 'number', 'boolean', 'object', 'list'].includes(field.type) ||
			(field.required !== undefined && typeof field.required !== 'boolean')
		)
			throw new Error('Invalid or duplicate workflow request field.');
		if (field.defaultValue !== undefined && !matches(field.defaultValue, field.type))
			throw new Error(`Default for ${field.label} must be ${field.type}.`);
		keys.add(field.key);
	}
}

/** Normalizes every entry path, while legacy graphs retain arbitrary pass-through inputs. */
export function normalizeWorkflowInputs(
	workflow: WorkflowDefinition,
	inputs: Record<string, unknown> = {},
	defaults: Record<string, unknown> = {},
): Record<string, unknown> {
	validateWorkflowRequest(workflow.request);
	const result = { ...defaults, ...inputs };
	const request = workflow.request;
	if (!request) return result;
	const key = request.prompt.key;
	// An explicit generic composer prompt always wins over a saved project default.
	const prompt = inputs[key] ?? inputs.prompt ?? inputs.text ?? result[key];
	if (prompt !== undefined && typeof prompt !== 'string')
		throw new Error(`${request.prompt.label ?? 'Request'} must be text.`);
	if (request.prompt.required && (typeof prompt !== 'string' || !prompt.trim()))
		throw new Error(`${request.prompt.label ?? 'Request'} is required.`);
	if (prompt !== undefined) result[key] = prompt;
	for (const field of request.fields ?? []) {
		const value = result[field.key] ?? field.defaultValue;
		if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
			if (field.required) throw new Error(`${field.label} is required.`);
			continue;
		}
		if (!matches(value, field.type)) throw new Error(`${field.label} must be ${field.type}.`);
		result[field.key] = value;
	}
	return result;
}
