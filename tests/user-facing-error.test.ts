import { describe, expect, it } from 'vitest';
import { userFacingError } from '../src/lib/user-facing-error';

describe('user-facing errors', () => {
	it('unwraps nested IPC and named exceptions without losing the explanation', () => {
		const raw = new Error(
			`Error invoking remote method 'freelm:tool-execute': MediaModerationError: Error invoking remote method "freelm:request": Error: The evaluator is unavailable. Check Settings → Moderation.`,
		);
		expect(userFacingError(raw)).toBe('The evaluator is unavailable. Check Settings → Moderation.');
		expect(raw.message).toContain('freelm:tool-execute');
	});
	it('cleans embedded wrappers after meaningful context and removes stack frames', () => {
		expect(
			userFacingError(
				`Could not save: Error invoking remote method 'freelm:save': TypeError: Disk is full.\n    at save (/Applications/FreeLM.app/main.cjs:32:4)\n    at async worker (/tmp/worker.js:5:1)`,
			),
		).toBe('Could not save: Disk is full.');
	});
	it('reads provider error envelopes and retains status and actionable details', () => {
		expect(
			userFacingError(
				'API 400: {"error":{"message":"Reference image must be PNG or JPEG.","type":"invalid_request_error"}}',
			),
		).toBe('API 400: Reference image must be PNG or JPEG.');
		expect(
			userFacingError({ error: { message: 'The selected model does not support audio input.' } }),
		).toBe('The selected model does not support audio input.');
		expect(userFacingError('{"detail":"Video duration must be 15 seconds or less."}')).toBe(
			'Video duration must be 15 seconds or less.',
		);
	});
	it('retains permission, moderation and validation reasons instead of pretending retry is sufficient', () => {
		for (const text of [
			'Approval denied: The request would delete files outside this project.',
			'Generation blocked by High moderation. Change the prompt and try again.',
			'API 429: Rate limit exceeded. Try again in 20 seconds.',
			'The requested file is outside the project workspace.',
			'Invalid JSON at line 3: expected a comma.',
		])
			expect(userFacingError(text)).toBe(text);
	});
	it('preserves prose, multiline recovery steps and paths that are not stack frames', () => {
		const text = 'Cannot open /tmp/example.ts:10.\nCheck that the file exists.\nRetry at 9:20 PM.';
		expect(userFacingError(text)).toBe(text);
	});
	it('provides readable guidance for bare transport failures, preserving existing richer guidance', () => {
		expect(userFacingError(new TypeError('Failed to fetch'))).toContain('Check the server address');
		expect(userFacingError('Error: connect ECONNREFUSED 127.0.0.1:8090')).toContain(
			'Check the server address',
		);
		expect(userFacingError('Error: ETIMEDOUT')).toContain('took too long');
		expect(
			userFacingError(
				'Could not reach http://localhost:8090 (EHOSTUNREACH). Check the API address.',
			),
		).toBe('Could not reach http://localhost:8090. Check the API address.');
	});
	it('shows a Python exception explanation without its traceback', () => {
		expect(
			userFacingError(
				'Traceback (most recent call last):\n  File "/tmp/run.py", line 4, in <module>\n    run()\nRuntimeError: The image decoder could not read this file.',
			),
		).toBe('The image decoder could not read this file.');
		expect(
			userFacingError(
				'Traceback (most recent call last):\n  File "run.py", line 4\nException: Select an image evaluator in Settings.',
			),
		).toBe('Select an image evaluator in Settings.');
	});
	it('preserves structured field validation details', () => {
		expect(
			userFacingError('API 422: {"detail":[{"loc":["body","size"],"msg":"Field required"}]}'),
		).toBe('API 422: body.size: Field required');
	});
	it('handles missing/unstructured/cyclic errors and internal JS failures with a contextual fallback', () => {
		const circular: Record<string, unknown> = {};
		circular.error = circular;
		for (const value of [
			undefined,
			null,
			{},
			circular,
			'[object Object]',
			new TypeError("Cannot read properties of undefined (reading 'url')"),
		]) {
			expect(userFacingError(value, 'Could not open the preview. Try again.')).toBe(
				'Could not open the preview. Try again.',
			);
		}
	});
	it('preserves a model configuration explanation', () => {
		expect(userFacingError('The selected model is not defined.')).toBe(
			'The selected model is not defined.',
		);
	});
	it('is idempotent for already formatted errors', () => {
		const formatted = userFacingError(
			"Error invoking remote method 'freelm:tool-execute': Error: The server is busy.",
		);
		expect(userFacingError(formatted)).toBe(formatted);
	});
});
