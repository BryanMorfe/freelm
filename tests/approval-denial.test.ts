import { describe, expect, it } from 'vitest';
import type { ToolCallRecord } from '../src/agent-types';
import { approvalDenial } from '../src/lib/approval-denial';
import { validToolRecords } from '../electron/agent-validation';

const call: ToolCallRecord = {
	id: 'read-project',
	name: 'exec_command',
	arguments: '{"cmd":"cat README.md"}',
	status: 'failed',
	startedAt: 1,
	result: { isError: true, content: [{ type: 'text', text: 'Execution failed.' }] },
};

describe('host authorization outcomes', () => {
	it('preserves review errors without treating them as denials and validates saved metadata', () => {
		const record: ToolCallRecord = {
			...call,
			result: {
				isError: true,
				content: [{ type: 'text', text: 'Review unavailable.' }],
				approvalReviewError: {
					reason: 'Review unavailable.',
					code: 'unavailable',
					attempts: 3,
					permissionMode: 'auto-review',
				},
			},
		};
		expect(approvalDenial(record)).toBeUndefined();
		expect(validToolRecords([JSON.parse(JSON.stringify(record))])).toBe(true);
		for (const metadata of [
			{ reason: '' },
			{ code: 'allow' },
			{ attempts: -1 },
			{ attempts: '3' },
			{ permissionMode: 'admin' },
		])
			expect(
				validToolRecords([
					{
						...record,
						result: {
							...record.result,
							approvalReviewError: { ...record.result!.approvalReviewError, ...metadata },
						},
					},
				]),
			).toBe(false);
	});
	it('prefers structured authorization evidence without interpreting arbitrary tool text', () => {
		const denial = {
			reason: 'The requested destination is not authorized.',
			permissionMode: 'auto-review' as const,
			effectiveDirectory: '/tmp/project',
		};
		expect(approvalDenial({ ...call, result: { ...call.result!, approvalDenied: denial } })).toBe(
			denial,
		);
	});

	it('supports explicit denied records, with a useful reason when none was persisted', () => {
		expect(approvalDenial({ ...call, status: 'denied' })).toEqual({ reason: 'Execution failed.' });
		expect(approvalDenial({ ...call, status: 'denied', result: undefined })).toEqual({
			reason: 'This action was not approved.',
		});
	});

	it('never exposes an old explicit denial JSON payload as its readable reason', () => {
		expect(
			approvalDenial({
				...call,
				status: 'denied',
				result: {
					isError: true,
					content: [{ type: 'text', text: '{"private_error":"debug only"}' }],
				},
			}),
		).toEqual({ reason: 'This action was not approved.' });
		expect(
			approvalDenial({
				...call,
				status: 'denied',
				result: {
					isError: true,
					content: [
						{
							type: 'text',
							text: '{"reason":"The user did not authorize this action.","private_error":"debug only"}',
						},
					],
				},
			}),
		).toEqual({ reason: 'The user did not authorize this action.' });
	});

	it('recognizes saved records from the old host by its complete single-text denial envelope', () => {
		const reason = 'Automatic approval review needs more information.';
		expect(
			approvalDenial({
				...call,
				result: {
					isError: true,
					content: [
						{
							type: 'text',
							text: `${reason} Do not retry this action without a new user request.`,
						},
					],
				},
			}),
		).toEqual({ reason });
	});

	it.each([
		'Permission denied: ./README.md',
		'Approval denied',
		'The tool failed. Do not retry this action.',
		'Do not retry this action without a new user request.',
	])('does not misclassify ordinary errors: %s', (text) => {
		expect(
			approvalDenial({ ...call, result: { isError: true, content: [{ type: 'text', text }] } }),
		).toBeUndefined();
	});

	it('does not treat a successful result or a quoted multi-part denial as an authorization outcome', () => {
		const text = 'Quoted denial. Do not retry this action without a new user request.';
		expect(
			approvalDenial({
				...call,
				status: 'completed',
				result: {
					content: [{ type: 'text', text }],
					approvalDenied: { reason: 'Ignored stale metadata' },
				},
			}),
		).toBeUndefined();
		expect(
			approvalDenial({
				...call,
				result: {
					isError: true,
					content: [
						{ type: 'text', text },
						{ type: 'text', text: 'Additional output' },
					],
				},
			}),
		).toBeUndefined();
	});

	it('allows valid persisted denial metadata and rejects malformed metadata at the host boundary', () => {
		const record = {
			...call,
			status: 'denied',
			result: {
				...call.result!,
				approvalDenied: {
					reason: 'Not authorized.',
					permissionMode: 'auto-review',
					effectiveDirectory: '/tmp/project',
				},
			},
		};
		expect(validToolRecords([record])).toBe(true);
		for (const denial of [
			null,
			{},
			{ reason: 1 },
			{ reason: ' ' },
			{ reason: 'No', permissionMode: 'arbitrary' },
			{ reason: 'No', effectiveDirectory: 42 },
		])
			expect(
				validToolRecords([{ ...record, result: { ...record.result, approvalDenied: denial } }]),
			).toBe(false);
		expect(validToolRecords([call])).toBe(true);
	});
});
