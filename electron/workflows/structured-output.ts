import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { ValidateFunction } from 'ajv';
import type { AgentResponseFormat } from '../../src/lib/agent';

const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export interface StructuredWorkflowOutput {
	format: AgentResponseFormat;
	retries: number;
	instructions: string;
	parse(text: string): unknown;
}

/** Checks schema configuration before inference or tools can perform any work. */
export function structuredWorkflowOutput(
	config: Record<string, unknown>,
): StructuredWorkflowOutput | undefined {
	if (config.responseFormat === 'text') return;
	if (
		config.schema !== undefined &&
		(!config.schema || typeof config.schema !== 'object' || Array.isArray(config.schema))
	)
		throw new Error('Output schema must be a JSON object.');
	const schema = config.schema as Record<string, unknown> | undefined;
	const hasSchema = !!schema && Object.keys(schema).length > 0;
	if (config.responseFormat !== 'json' && !hasSchema) return;
	const retries = config.validationRetries ?? 1;
	if (typeof retries !== 'number' || !Number.isInteger(retries) || retries < 0 || retries > 2)
		throw new Error('Validation retries must be an integer from 0 to 2.');
	let validate: ValidateFunction | undefined;
	if (hasSchema) {
		try {
			if (Buffer.byteLength(JSON.stringify(schema)) > MAX_SCHEMA_BYTES)
				throw new Error('schema exceeds 64 KiB');
			const visit = (value: unknown, depth: number) => {
				if (depth > 32) throw new Error('schema nesting exceeds 32 levels');
				if (!value || typeof value !== 'object') return;
				if (Array.isArray(value)) {
					for (const item of value) visit(item, depth + 1);
					return;
				}
				for (const [key, item] of Object.entries(value)) {
					if (key === '$async') throw new Error('asynchronous schemas are not supported');
					if (
						(key === '$ref' || key === '$dynamicRef') &&
						typeof item === 'string' &&
						!item.startsWith('#')
					)
						throw new Error('references must stay within this schema');
					visit(item, depth + 1);
				}
			};
			visit(schema, 0);
			const options = {
				allErrors: false,
				strictSchema: true,
				strictTypes: false,
				strictTuples: false,
				ownProperties: true,
				allowUnionTypes: true,
			};
			const validator = /draft-07/.test(String(schema.$schema ?? ''))
				? new Ajv(options)
				: new Ajv2020(options);
			addFormats(validator);
			validate = validator.compile(schema);
		} catch (error) {
			throw new Error(
				`Invalid output schema: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	const format: AgentResponseFormat = hasSchema
		? { type: 'json_schema', name: 'workflow_output', strict: true, schema: schema! }
		: { type: 'json_object' };
	return {
		format,
		retries,
		instructions: `When finished, return only ${hasSchema ? 'JSON matching the requested output schema' : 'a JSON object'}. Do not wrap the final JSON in Markdown. Tool calls and intermediate reasoning are allowed; this format applies to your final answer.`,
		parse(output) {
			if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES)
				throw new Error('Structured output exceeds 2 MiB.');
			let value: unknown;
			try {
				value = JSON.parse(output);
			} catch {
				throw new Error('The final response is not valid JSON.');
			}
			let items = 0;
			const check = (item: unknown, depth: number) => {
				if (++items > 100_000 || depth > 64)
					throw new Error('Structured output is too deeply nested or contains too many values.');
				if (typeof item === 'number' && !Number.isFinite(item))
					throw new Error('Structured output contains a non-finite number.');
				if (item && typeof item === 'object')
					for (const child of Object.values(item)) check(child, depth + 1);
			};
			check(value, 0);
			if (validate) {
				if (!validate(value)) {
					const errors = (validate.errors ?? [])
						.slice(0, 5)
						.map(
							(error) =>
								`${error.instancePath || '/'} ${error.message ?? 'does not match the schema'} (${JSON.stringify(error.params)})`,
						);
					throw new Error(`Final JSON does not match the output schema: ${errors.join('; ')}`);
				}
			} else if (!value || typeof value !== 'object' || Array.isArray(value)) {
				throw new Error('The final response must be a JSON object.');
			}
			return value;
		},
	};
}

/** Corrections are separate inference requests with no tools and never replay agent actions. */
export async function validateWorkflowOutput(
	contract: StructuredWorkflowOutput,
	initial: string,
	signal: AbortSignal,
	correct: (draft: string, issue: string, attempt: number) => Promise<string>,
): Promise<{ value: unknown; text: string; validationAttempts: number }> {
	let output = initial;
	for (let attempt = 0; ; attempt++) {
		signal.throwIfAborted();
		try {
			return { value: contract.parse(output), text: output, validationAttempts: attempt + 1 };
		} catch (error) {
			if (signal.aborted) throw error;
			const issue = error instanceof Error ? error.message : String(error);
			if (attempt >= contract.retries)
				throw new Error(
					`Structured output validation failed after ${attempt + 1} attempt${attempt ? 's' : ''}: ${issue}`,
				);
			// Do not resend a pathological oversized result to the provider.
			if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) throw error;
			output = await correct(output, issue, attempt + 1);
		}
	}
}
