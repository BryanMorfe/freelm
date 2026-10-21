import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ModerationNotice from '../src/components/ModerationNotice';
import { validModerationWarnings } from '../src/lib/moderation-warnings';
import { moderationSettings } from '../src/lib/moderation';
import { initialState, recoverState } from '../src/lib/state';
import { validateState } from '../electron/validation';
import { validToolRecords } from '../electron/agent-validation';
import { StateStore } from '../electron/state-store';
import { applyWorkspacePatch, createWorkspacePatch } from '../src/workspace-patch';
import type { Generation } from '../src/types';
import type { ToolCallRecord } from '../src/agent-types';

const warning =
	'Image moderation is enabled, but its evaluator is unavailable. Generation proceeds without image moderation.';
const generation: Generation = {
	id: 'image-generation',
	kind: 'images',
	prompt: 'A white square',
	model: 'image',
	connectionId: 'api',
	createdAt: 1000,
	status: 'completed',
	assets: [{ url: 'data:image/png;base64,AA==', mimeType: 'image/png', name: 'image.png' }],
	moderationWarnings: [warning],
};
const call: ToolCallRecord = {
	id: 'image-call',
	name: 'image_gen.imagegen',
	arguments: '{"prompt":"A white square"}',
	status: 'completed',
	startedAt: 1000,
	result: {
		content: [{ type: 'image', dataUrl: 'data:image/png;base64,AA==', name: 'image.png' }],
		moderationWarnings: [warning],
	},
};
const invalidWarnings: unknown[] = [
	null,
	'warning',
	[null],
	[1],
	[''],
	[' \n '],
	['x'.repeat(2049)],
	Array(9).fill('warning'),
];
const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe('moderation warning display and persistence boundaries', () => {
	it('accepts plain text at the eight-message and 2048-character bounds', () => {
		expect(validModerationWarnings([])).toBe(true);
		expect(validModerationWarnings([warning])).toBe(true);
		expect(validModerationWarnings(Array(8).fill('x'.repeat(2048)))).toBe(true);
		for (const value of [undefined, ...invalidWarnings])
			expect(validModerationWarnings(value)).toBe(false);
	});
	it('renders warnings once as escaped text and omits absent, empty or invalid notices', () => {
		const text = 'Generation proceeds without image moderation. <b>Review settings</b>';
		const html = renderToStaticMarkup(createElement(ModerationNotice, { warnings: [text, text] }));
		expect(html).toContain('role="status" aria-label="Moderation warning"');
		expect(html).toContain('&lt;b&gt;Review settings&lt;/b&gt;');
		expect(html).not.toContain('<b>');
		expect(html.split('Generation proceeds')).toHaveLength(2);
		for (const warnings of [undefined, [], ...invalidWarnings])
			expect(
				renderToStaticMarkup(
					createElement(ModerationNotice, { warnings: warnings as string[] | undefined }),
				),
			).toBe('');
	});
	it('validates generation warning metadata before workspace persistence', () => {
		const state = { ...initialState(), generations: [generation] };
		expect(() => validateState(state)).not.toThrow();
		for (const moderationWarnings of invalidWarnings)
			expect(() =>
				validateState({ ...state, generations: [{ ...generation, moderationWarnings }] }),
			).toThrow('Workspace data is invalid');
	});
	it('validates tool-result warnings and rejects invalid history records', () => {
		expect(validToolRecords([call])).toBe(true);
		for (const moderationWarnings of invalidWarnings)
			expect(validToolRecords([{ ...call, result: { ...call.result, moderationWarnings } }])).toBe(
				false,
			);
		const state = initialState();
		state.threads = [
			{
				id: 'chat',
				kind: 'chat',
				title: 'Image',
				connectionId: state.activeConnectionId,
				model: 'chat-model',
				createdAt: 1,
				updatedAt: 2000,
				messages: [
					{
						id: 'answer',
						role: 'assistant',
						content: 'Here is the image.',
						createdAt: 1000,
						completedAt: 2000,
						toolCalls: [call],
					},
				],
			},
		];
		expect(() => validateState(state)).not.toThrow();
		const invalid = structuredClone(state);
		invalid.threads[0].messages[0].toolCalls![0].result!.moderationWarnings = ['x'.repeat(2049)];
		expect(() => validateState(invalid)).toThrow('Workspace data is invalid');
	});
	it('preserves historical generation and tool warnings after reload and later disabling moderation', async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'freelm-warning-history-'));
		directories.push(directory);
		const secrets = {
			available: () => false,
			encrypt: () => {
				throw new Error('Unused');
			},
			decrypt: () => {
				throw new Error('Unused');
			},
		};
		const store = new StateStore(
			path.join(directory, 'workspace.json'),
			secrets,
			path.join(directory, 'config.json'),
		);
		const state = initialState();
		state.generations = [generation];
		state.threads = [
			{
				id: 'chat',
				kind: 'chat',
				title: 'Image',
				connectionId: state.activeConnectionId,
				model: 'chat-model',
				createdAt: 1,
				updatedAt: 2000,
				messages: [
					{
						id: 'answer',
						role: 'assistant',
						content: 'Here is the image.',
						createdAt: 1000,
						completedAt: 2000,
						toolCalls: [call],
					},
				],
			},
		];
		await store.save(state);
		const loaded = await store.load();
		if (!loaded) throw new Error('Saved warning history must load.');
		const policy = moderationSettings(loaded.moderation);
		policy.image.enabled = false;
		policy.video.enabled = false;
		const updated = recoverState({ ...loaded, moderation: policy });
		expect(updated.generations[0].moderationWarnings).toEqual([warning]);
		expect(updated.threads[0].messages[0].toolCalls![0].result!.moderationWarnings).toEqual([
			warning,
		]);
		await store.save(updated);
		expect((await store.load())?.generations[0].moderationWarnings).toEqual([warning]);
	});
	it('carries generation warning edits through workspace patches', () => {
		const previous = { ...initialState(), generations: [generation] };
		const next = {
			...previous,
			generations: [
				{ ...generation, moderationWarnings: [warning, 'Video moderation was also unavailable.'] },
			],
		};
		expect(applyWorkspacePatch(previous, createWorkspacePatch(previous, next))).toEqual(next);
	});
});
