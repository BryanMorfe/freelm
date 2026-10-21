import { describe, expect, it, vi } from 'vitest';
import {
	structuredWorkflowOutput,
	validateWorkflowOutput,
} from '../electron/workflows/structured-output';

const schema = {
	type: 'object',
	properties: {
		score: { type: 'integer', minimum: 0, maximum: 10 },
		verdict: { enum: ['pass', 'fail'] },
	},
	required: ['score', 'verdict'],
	additionalProperties: false,
};

describe('workflow structured output contract', () => {
	it('keeps ordinary text nodes unchanged and rejects invalid schema configuration', () => {
		expect(structuredWorkflowOutput({ responseFormat: 'text' })).toBeUndefined();
		expect(() => structuredWorkflowOutput({ responseFormat: 'json', schema: 'wrong' })).toThrow(
			'JSON object',
		);
		expect(() =>
			structuredWorkflowOutput({
				responseFormat: 'json',
				schema: { type: 'object', nonsense: true },
			}),
		).toThrow('Invalid output schema');
		expect(() =>
			structuredWorkflowOutput({
				responseFormat: 'json',
				schema: { $ref: 'https://example.com/schema' },
			}),
		).toThrow('references must stay');
	});
	it.each([
		{},
		{ $schema: 'http://json-schema.org/draft-07/schema#' },
		{ $schema: 'https://json-schema.org/draft/2020-12/schema' },
	])('validates required fields, types, bounds, enums and extra fields with %j', (dialect) => {
		const contract = structuredWorkflowOutput({ schema: { ...schema, ...dialect } })!;
		expect(contract.parse('{"score":7,"verdict":"pass"}')).toEqual({ score: 7, verdict: 'pass' });
		for (const invalid of [
			'{"score":"7","verdict":"pass"}',
			'{"verdict":"pass"}',
			'{"score":11,"verdict":"pass"}',
			'{"score":7,"verdict":"maybe"}',
			'{"score":7,"verdict":"pass","other":true}',
		])
			expect(() => contract.parse(invalid)).toThrow('does not match');
	});
	it('supports local definitions, nested arrays, union values and standard formats', () => {
		const contract = structuredWorkflowOutput({
			schema: {
				type: 'object',
				required: ['sources'],
				additionalProperties: false,
				properties: { sources: { type: 'array', minItems: 1, items: { $ref: '#/$defs/source' } } },
				$defs: {
					source: {
						type: 'object',
						properties: {
							url: { type: 'string', format: 'uri' },
							note: { type: ['string', 'null'] },
						},
						required: ['url', 'note'],
						additionalProperties: false,
					},
				},
			},
		})!;
		expect(contract.parse('{"sources":[{"url":"https://example.com","note":null}]}')).toEqual({
			sources: [{ url: 'https://example.com', note: null }],
		});
		expect(() => contract.parse('{"sources":[{"url":"not a url","note":null}]}')).toThrow('format');
	});
	it('enforces JSON object mode and finite numbers without coercion or Markdown extraction', () => {
		const contract = structuredWorkflowOutput({ responseFormat: 'json' })!;
		expect(contract.parse('{"answer":42}')).toEqual({ answer: 42 });
		for (const invalid of ['[1,2]', 'null', '42', '```json\n{}\n```', '{"n":1e9999}'])
			expect(() => contract.parse(invalid)).toThrow();
	});
	it('bounds retries and validates every corrected result', async () => {
		const contract = structuredWorkflowOutput({ schema, validationRetries: 2 })!;
		const correct = vi
			.fn()
			.mockResolvedValueOnce('{"score":"3","verdict":"pass"}')
			.mockResolvedValueOnce('{"score":3,"verdict":"pass"}');
		const value = await validateWorkflowOutput(
			contract,
			'{}',
			new AbortController().signal,
			correct,
		);
		expect(value.value).toEqual({ score: 3, verdict: 'pass' });
		expect(value.validationAttempts).toBe(3);
		expect(correct).toHaveBeenCalledTimes(2);
		expect(correct.mock.calls[0][1]).toContain('required');
		await expect(
			validateWorkflowOutput(contract, '{}', new AbortController().signal, async () => '{}'),
		).rejects.toThrow('after 3 attempts');
		for (const validationRetries of [-1, 3, 1.5, '1'])
			expect(() => structuredWorkflowOutput({ schema, validationRetries })).toThrow('0 to 2');
	});
	it('does not correct after cancellation or when correction is disabled', async () => {
		const controller = new AbortController();
		const correct = vi.fn(async () => {
			controller.abort();
			return '{"score":3,"verdict":"pass"}';
		});
		await expect(
			validateWorkflowOutput(
				structuredWorkflowOutput({ schema })!,
				'{}',
				controller.signal,
				correct,
			),
		).rejects.toMatchObject({ name: 'AbortError' });
		expect(correct).toHaveBeenCalledTimes(1);
		correct.mockClear();
		await expect(
			validateWorkflowOutput(
				structuredWorkflowOutput({ schema, validationRetries: 0 })!,
				'{}',
				new AbortController().signal,
				correct,
			),
		).rejects.toThrow('after 1 attempt');
		expect(correct).not.toHaveBeenCalled();
	});
	it('rejects oversized and excessively nested outputs without resending them', async () => {
		const contract = structuredWorkflowOutput({ responseFormat: 'json' })!;
		const correct = vi.fn();
		await expect(
			validateWorkflowOutput(
				contract,
				'x'.repeat(2 * 1024 * 1024 + 1),
				new AbortController().signal,
				correct,
			),
		).rejects.toThrow('2 MiB');
		expect(correct).not.toHaveBeenCalled();
		expect(() => contract.parse('{"a":'.repeat(66) + '0' + '}'.repeat(66))).toThrow(
			'deeply nested',
		);
	});
});
