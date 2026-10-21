import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import ConversationSources from '../src/components/ConversationSources';
import {
	collectConversationSources,
	sourceImagePreview,
	sourceProvenance,
} from '../src/lib/conversation-sources';
import type { ToolCallRecord } from '../src/agent-types';
import type { Message, Thread } from '../src/types';

const page = { id: 'web_one', title: 'Example paper', url: 'https://example.com/paper' };
function call(
	id: string,
	args: Record<string, unknown>,
	extra: Partial<ToolCallRecord> = {},
): ToolCallRecord {
	return {
		id,
		name: 'web.run',
		arguments: JSON.stringify(args),
		status: 'completed',
		startedAt: 1,
		result: { content: [], research: { sources: [page] } },
		...extra,
	};
}
function message(calls: ToolCallRecord[] = [], extra: Partial<Message> = {}): Message {
	return {
		id: 'answer',
		role: 'assistant',
		content: 'The answer.',
		createdAt: 1,
		toolCalls: calls,
		...extra,
	};
}
function thread(messages: Message[], history: Message[] = []): Thread {
	return {
		id: 'thread',
		title: 'Sources fixture',
		connectionId: 'connection',
		model: 'model',
		createdAt: 1,
		updatedAt: 2,
		messages,
		messageHistory: history,
	};
}

describe('conversation sources', () => {
	it('deduplicates result rows and repeated call records while counting separate search calls', () => {
		const first = call(
			'first',
			{ search_query: [{ q: 'first' }, { q: 'second' }] },
			{
				result: { content: [], research: { sources: [page, { ...page, id: 'web_duplicate' }] } },
			},
		);
		const data = collectConversationSources([
			message([first, first, call('second', { search_query: [{ q: 'again' }] })]),
		]);
		expect(data.items).toHaveLength(1);
		expect(data.items[0]).toMatchObject({ searched: 2, opened: 0, read: false });
		expect(data.web.searches).toBe(2);
		expect(sourceProvenance(data.items[0])).toEqual(['Searched 2 times']);
	});
	it('counts successful page actions with their actual result references instead of upgrading every snippet', () => {
		const other = { id: 'web_two', title: 'Unread result', url: 'https://example.com/other' };
		const search = call(
			'search',
			{ search_query: [{ q: 'paper' }] },
			{
				result: { content: [], research: { sources: [page, other] } },
			},
		);
		const open = call(
			'open',
			{ open: [{ ref_id: page.id }] },
			{
				result: {
					content: [
						{
							type: 'text',
							text: JSON.stringify({
								results: [{ operation: 'open', ref_id: page.id, url: page.url }],
							}),
						},
					],
					research: { sources: [{ ...page, accessedAt: 10 }] },
				},
			},
		);
		const data = collectConversationSources([
			message([search, open, { ...open, id: 'open-again' }]),
		]);
		expect(data.items.find((item) => item.url === page.url)).toMatchObject({
			searched: 1,
			opened: 2,
			read: true,
		});
		expect(data.items.find((item) => item.url === other.url)).toMatchObject({
			searched: 1,
			opened: 0,
			read: false,
		});
		expect(data.web).toMatchObject({ searches: 1, opens: 2, failedCalls: 0 });
	});
	it('keeps failed operations explicit and ignores pending, denied, unsafe, and errored source metadata', () => {
		const failed = call('failed', { search_query: [{ q: 'failed search' }] }, { status: 'failed' });
		const partial = call(
			'partial',
			{ search_query: [{ q: 'success' }], open: [{ ref_id: page.id }] },
			{
				result: {
					content: [
						{
							type: 'text',
							text: JSON.stringify({
								results: [
									{ operation: 'search_query', results: [page] },
									{ operation: 'open', error: 'Unavailable' },
								],
							}),
						},
					],
					research: { sources: [page] },
				},
			},
		);
		const unsafe = call(
			'unsafe',
			{ search_query: [{ q: 'unsafe' }] },
			{
				result: {
					content: [],
					research: {
						sources: [
							{ ...page, url: 'javascript:alert(1)' },
							{ ...page, url: 'http://127.0.0.1/private' },
							{ ...page, url: 'https://user:secret@example.com/private' },
						],
					},
				},
			},
		);
		const data = collectConversationSources([
			message([
				failed,
				partial,
				unsafe,
				call('pending', { search_query: [{ q: 'pending' }] }, { status: 'running' }),
				call('denied', { open: [{ ref_id: page.url }] }, { status: 'denied' }),
				call(
					'error',
					{ open: [{ ref_id: page.url }] },
					{ result: { isError: true, content: [], research: { sources: [page] } } },
				),
			]),
		]);
		expect(data.items).toHaveLength(1);
		expect(data.items[0]).toMatchObject({ searched: 1, opened: 0, read: false });
		expect(data.web).toMatchObject({ searches: 2, opens: 0, failedCalls: 3 });
	});
	it('retains successful empty searches and failed-only activity in the panel', () => {
		const empty = call(
			'empty',
			{ search_query: [{ q: 'no results' }] },
			{ result: { content: [], research: { sources: [] } } },
		);
		const failed = call('failed', { image_query: [{ q: 'failed' }] }, { status: 'failed' });
		const data = collectConversationSources([message([empty, failed])]);
		expect(data.items).toEqual([]);
		expect(data.hasSources).toBe(true);
		expect(data.web.searches).toBe(1);
		expect(data.images).toMatchObject({ searches: 0, failedCalls: 1 });
		const html = renderToStaticMarkup(createElement(ConversationSources, { data }));
		expect(html).toContain('aria-label="Pinned summary"');
		expect(html).not.toContain('<h2>Outputs</h2>');
		expect(html).toContain('<h2>Sources</h2>');
		expect(html).not.toContain('<h2>Pinned summary</h2>');
		expect(html).toContain('Web search');
		expect(html).toContain('Searched 1 time');
		expect(html).toContain('1 call failed');
	});
	it('recognizes user-provided Markdown and plain URLs without treating assistant links as retrieval', () => {
		const data = collectConversationSources([
			message([], {
				id: 'user',
				role: 'user',
				content:
					'Read [the paper](https://example.com/paper), or https://example.com/Function_(mathematics). Also http://192.168.0.2/private and javascript:alert(1)',
			}),
			message([], { content: 'An assistant citation: https://example.org/invented' }),
		]);
		expect(data.items).toHaveLength(2);
		expect(data.items[0]).toMatchObject({
			title: 'the paper',
			url: page.url,
			provided: true,
			searched: 0,
			opened: 0,
		});
		expect(data.items[1].url).toBe('https://example.com/Function_(mathematics)');
		expect(sourceProvenance(data.items[0])).toEqual(['Provided in conversation']);
	});
	it('retains upload references and deduplicates identical files without serializing their media', () => {
		const upload = { name: 'photo.png', type: 'image/png', dataUrl: 'data:image/png;base64,AA==' };
		const text = {
			name: 'notes.txt',
			type: 'text/plain',
			dataUrl: 'data:text/plain;charset=utf-8,hello',
		};
		const data = collectConversationSources([
			message([], { id: 'user', role: 'user', attachments: [upload, upload, text] }),
			message([], { id: 'another-user', role: 'user', attachments: [{ ...upload }] }),
			message([], { id: 'assistant', attachments: [upload] }),
		]);
		expect(data.items).toHaveLength(2);
		expect(data.items[0].attachment).toBe(upload);
		const html = renderToStaticMarkup(createElement(ConversationSources, { data }));
		expect(html).toContain('photo.png');
		expect(html).toContain('notes.txt');
		expect(html).toContain('Provided in conversation');
		expect(html).not.toContain('<img');
		expect(html).not.toContain('data:image');
	});
	it('tracks selected image viewing separately from image-search metadata and never fetches previews', () => {
		const image = {
			id: page.id,
			title: 'Paper image',
			url: 'https://images.example.org/paper.png',
			sourceUrl: page.url,
			thumbnailUrl: 'https://images.example.org/thumb.png',
		};
		const searched = call(
			'images',
			{ image_query: [{ q: 'paper' }] },
			{
				result: { content: [], research: { sources: [page], images: [image, image] } },
			},
		);
		const viewed = call(
			'viewed',
			{ target: image.id },
			{
				name: 'image.view',
				result: {
					content: [{ type: 'image', dataUrl: 'data:image/png;base64,AA==' }],
					research: { sources: [page], images: [{ ...image, viewed: true }] },
				},
			},
		);
		const data = collectConversationSources([message([searched, viewed])]);
		expect(data.items).toHaveLength(1);
		expect(data.items[0]).toMatchObject({
			kind: 'image',
			searched: 1,
			opened: 0,
			viewed: 1,
			url: page.url,
		});
		expect(data.images).toMatchObject({ searches: 1, views: 1 });
		const html = renderToStaticMarkup(createElement(ConversationSources, { data }));
		expect(html).toContain(`href="${page.url}"`);
		expect(html).not.toContain('<img');
		expect(html).not.toContain('thumb.png');
		expect(html).not.toContain('data:image');
	});
	it('shows successfully viewed local image paths as text rather than file links', () => {
		const view = call(
			'local',
			{ path: '/fixture/reference.png' },
			{
				name: 'view_image',
				result: { content: [{ type: 'image', dataUrl: 'data:image/png;base64,AA==' }] },
			},
		);
		const data = collectConversationSources([message([view, { ...view, id: 'local-again' }])]);
		expect(data.hasSources).toBe(true);
		expect(data.items[0]).toMatchObject({
			kind: 'local-image',
			path: '/fixture/reference.png',
			viewed: 2,
		});
		const html = renderToStaticMarkup(createElement(ConversationSources, { data }));
		expect(html).toContain('/fixture/reference.png');
		expect(html).toContain('Viewed 2 times');
		expect(html).not.toContain('file:');
		expect(html).not.toContain('href=');
	});
	it('uses only active thread messages, excluding sources from inactive response paths', () => {
		const inactive = message([call('inactive', { search_query: [{ q: 'inactive' }] })], {
			id: 'inactive-answer',
		});
		const html = renderToStaticMarkup(
			createElement(ConversationSources, { thread: thread([], [inactive]) }),
		);
		expect(html).not.toContain(page.title);
		expect(html).not.toContain('Searched 1 time');
		expect(html).toContain('appear here');
	});
	it('reuses parsed completed tool envelopes when a later response streams new text', () => {
		const search = call(
			'cached',
			{ search_query: [{ q: 'cached' }] },
			{
				result: {
					content: [
						{
							type: 'text',
							text: JSON.stringify({ results: [{ operation: 'search_query', results: [page] }] }),
						},
					],
					research: { sources: [page] },
				},
			},
		);
		const parse = vi.spyOn(JSON, 'parse');
		try {
			const first = collectConversationSources([message([search])]);
			const second = collectConversationSources([
				message([search], { content: 'More streamed text.' }),
			]);
			expect(first).toEqual(second);
			expect(parse).toHaveBeenCalledTimes(2);
		} finally {
			parse.mockRestore();
		}
	});
	it('bounds collected metadata and reports omissions instead of serializing every result', () => {
		const calls = Array.from({ length: 3 }, (_, round) =>
			call(
				`round-${round}`,
				{ search_query: [{ q: 'many' }] },
				{
					result: {
						content: [],
						research: {
							sources: Array.from({ length: 128 }, (_, index) => ({
								id: `${round}-${index}`,
								title: `Source ${round}-${index}`,
								url: `https://example.com/${round}-${index}`,
							})),
						},
					},
				},
			),
		);
		const data = collectConversationSources([message(calls)]);
		expect(data.items).toHaveLength(256);
		expect(data.truncated).toBe(true);
	});
	it.each([
		'https://example.com/photo.png',
		'file:///fixture/photo.png',
		'freelm-media://blob/photo',
		'javascript:alert(1)',
		'data:image/svg+xml;base64,AA==',
	])('refuses an automatic upload image preview for %s', (dataUrl) =>
		expect(sourceImagePreview({ name: 'photo', type: 'image/png', dataUrl })).toBeUndefined(),
	);
	it('accepts hydrated embedded raster pixels for an on-demand upload preview', () => {
		const dataUrl = 'data:image/png;base64,AA==';
		expect(sourceImagePreview({ name: 'photo.png', type: 'image/png', dataUrl })).toBe(dataUrl);
	});
});
