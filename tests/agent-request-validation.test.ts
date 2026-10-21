import { describe, expect, it } from 'vitest';
import { validateToolRequest } from '../electron/agent-validation';

const request = {
	workspaceId: 'local',
	runId: 'run',
	threadId: 'thread',
	name: 'video_gen.videogen',
	arguments: { prompt: 'Animate the reference landscape.', num_last_images_to_include: 1 },
};
const reference = (type = 'image/avif') => ({
	name: 'landscape.avif',
	type,
	dataUrl: `data:${type};base64,AAAAIGZ0eXBhdmlm`,
});

describe('tool request attachment boundary', () => {
	it.each(['image_gen.imagegen', 'video_gen.videogen'])(
		'accepts AVIF references for %s without changing their bytes or metadata',
		(name) => {
			const input = { ...request, name, recentImages: [reference()] };
			const original = structuredClone(input);
			expect(() => validateToolRequest(input)).not.toThrow();
			expect(input).toEqual(original);
		},
	);

	it('does not reject an unreferenced historical AVIF on a text-only media call', () => {
		expect(() =>
			validateToolRequest({
				...request,
				arguments: { prompt: 'Generate a mountain landscape.' },
				recentImages: [reference()],
			}),
		).not.toThrow();
	});

	it.each(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heic', 'image/heif'])(
		'leaves %s support to moderation and the provider',
		(type) => {
			expect(() =>
				validateToolRequest({ ...request, recentImages: [reference(type)] }),
			).not.toThrow();
		},
	);

	it.each([
		[{ type: 'text/plain' }, 'recentImages[0].type'],
		[{ type: 'image/avif;something' }, 'recentImages[0].type'],
		[{ dataUrl: 'https://example.com/reference.avif' }, 'recentImages[0].dataUrl'],
		[{ dataUrl: 'file:///tmp/reference.avif' }, 'recentImages[0].dataUrl'],
		[{ dataUrl: 'data:text/plain;base64,YQ==' }, 'recentImages[0].dataUrl'],
		[{ dataUrl: 'data:image/avif;base64,' }, 'recentImages[0].dataUrl'],
		[{ dataUrl: 'data:image/avif;base64,YQ==$' }, 'recentImages[0].dataUrl'],
		[{ dataUrl: 'data:image/avif;base64,YQ==\0' }, 'recentImages[0].dataUrl'],
		[{ name: 'x'.repeat(1025) }, 'recentImages[0].name'],
	] as const)('reports the failing attachment field for %j', (patch, field) => {
		expect(() =>
			validateToolRequest({ ...request, recentImages: [{ ...reference(), ...patch }] }),
		).toThrow(`Invalid tool request: ${field}`);
	});

	it('preserves the five-image limit', () => {
		expect(() =>
			validateToolRequest({
				...request,
				recentImages: Array.from({ length: 5 }, () => reference()),
			}),
		).not.toThrow();
		expect(() =>
			validateToolRequest({
				...request,
				recentImages: Array.from({ length: 6 }, () => reference()),
			}),
		).toThrow('recentImages must be an array containing at most five images');
	});

	it('preserves the embedded image size limit', () => {
		expect(() =>
			validateToolRequest({
				...request,
				recentImages: [{ ...reference(), dataUrl: 'x'.repeat(45_000_001) }],
			}),
		).toThrow('recentImages[0].dataUrl must be an embedded image of at most 45,000,000 characters');
	});

	it('identifies malformed envelope fields without echoing prompts or image bytes', () => {
		expect(() => validateToolRequest({ ...request, runId: '' })).toThrow(
			'runId must be a nonempty',
		);
		expect(() => validateToolRequest({ ...request, arguments: [] })).toThrow(
			'arguments must be an object',
		);
		expect(() =>
			validateToolRequest({ ...request, arguments: { prompt: 'x'.repeat(1_000_000) } }),
		).toThrow('arguments must be valid JSON of at most 1,000,000 characters');
	});

	it('reports unserializable arguments as invalid tool input', () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		for (const args of [circular, { number: BigInt(1) }])
			expect(() => validateToolRequest({ ...request, arguments: args })).toThrow(
				'Invalid tool request: arguments must be valid JSON',
			);
	});
});
