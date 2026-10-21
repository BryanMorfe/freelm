import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ImagePlayground } from '../src/components/ImagePlayground';
import { VideoPlayground } from '../src/components/VideoPlayground';
import ChatImageResult from '../src/components/ChatImageResult';
import ChatVideoResult from '../src/components/ChatVideoResult';
import ModerationNotice from '../src/components/ModerationNotice';
import { newConnection } from '../src/lib/state';
import type { Generation } from '../src/types';
import type { ToolCallRecord } from '../src/agent-types';

const reason = 'Output moderation could not complete. Check the evaluator connection, then retry.';
const rawError = `Error invoking remote method 'freelm:tool-execute': MediaModerationError: ${reason}\n    at evaluate (/private/fixture/moderation.js:12:4)`;
const connection = newConnection();
connection.models.images = 'image-fixture';
connection.models.videos = 'video-fixture';

describe('media error presentation', () => {
	it.each(['images', 'videos'] as const)(
		'cleans persisted %s failures without changing saved diagnostics or retry controls',
		(kind) => {
			const generation: Generation = {
				id: 'saved-failure',
				kind,
				prompt: 'A fixture request',
				model: connection.models[kind],
				connectionId: connection.id,
				createdAt: 1,
				status: 'failed',
				assets: [],
				error: rawError,
			};
			const before = structuredClone(generation);
			const html = renderToStaticMarkup(
				createElement(kind === 'images' ? ImagePlayground : VideoPlayground, {
					connection,
					generations: [generation],
					onAdd: () => {},
					onUpdate: () => {},
					onDelete: () => {},
					onSettings: () => {},
				}),
			);
			expect(html).toContain(reason);
			expect(html).toContain('role="alert"');
			expect(html).toContain('Retry generation');
			expect(html).not.toMatch(
				/Error invoking|freelm:tool-execute|MediaModerationError|private\/fixture/,
			);
			expect(generation).toEqual(before);
		},
	);

	it.each(['image', 'video'] as const)(
		'keeps the actual reason visible on a failed generated %s card',
		(kind) => {
			const call: ToolCallRecord = {
				id: 'failed-media-tool',
				name: `${kind}_gen`,
				status: 'failed',
				arguments: '{}',
				startedAt: 1,
				result: { isError: true, content: [{ type: 'text', text: rawError }] },
			};
			const html = renderToStaticMarkup(
				kind === 'image'
					? createElement(ChatImageResult, { call, live: false, args: {} })
					: createElement(ChatVideoResult, { call, live: false }),
			);
			expect(html).toContain(reason);
			expect(html).toContain('role="alert"');
			expect(html).not.toMatch(/Error invoking|MediaModerationError|private\/fixture/);
			expect(call.result?.content[0]).toEqual({ type: 'text', text: rawError });
		},
	);

	it('renders a moderation warning plainly while retaining its original diagnostic value', () => {
		const warnings = [rawError];
		const html = renderToStaticMarkup(createElement(ModerationNotice, { warnings }));
		expect(html).toContain(reason);
		expect(html).toContain('aria-label="Moderation warning"');
		expect(html).not.toMatch(/Error invoking|MediaModerationError|private\/fixture/);
		expect(warnings).toEqual([rawError]);
	});
});
