import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ToolCallActivity } from '../src/components/ToolActivity';

describe('web browsing activity', () => {
	it('shows a readable search and shimmer without raw tool arguments', () => {
		const markup = renderToStaticMarkup(
			createElement(ToolCallActivity, {
				live: true,
				call: {
					id: 'search',
					name: 'web.run',
					arguments: JSON.stringify({ search_query: [{ q: 'SearXNG search API' }] }),
					status: 'running',
					startedAt: 1,
				},
			}),
		);
		expect(markup).toContain('Searching for SearXNG search API');
		expect(markup).toContain('SearXNG search API');
		expect(markup).toContain('activity-shimmer');
		expect(markup).not.toContain('tool-arguments');
		expect(markup).not.toContain('<details');
		expect(markup).not.toContain('<summary');
		expect(markup).toContain('data-details="true"');
		expect(markup).toContain('aria-label="Expand web activity: Searching for SearXNG search API"');
		expect(markup).not.toContain('tool-request-details');
	});

	it('hides search result JSON by default and makes it available through the Debug disclosure', () => {
		const call = {
			id: 'search-results',
			name: 'web.run',
			arguments: JSON.stringify({ search_query: [{ q: 'Europa ocean' }] }),
			status: 'completed' as const,
			startedAt: 1,
			result: {
				content: [{ type: 'text' as const, text: '{"debug_search_marker":"result","sources":[]}' }],
			},
		};
		const normal = renderToStaticMarkup(createElement(ToolCallActivity, { call }));
		expect(normal).toContain('Searched for Europa ocean');
		expect(normal).not.toContain('debug_search_marker');
		expect(normal).not.toContain('<details');
		expect(normal).not.toContain('>Done<');
		const debug = renderToStaticMarkup(createElement(ToolCallActivity, { call, debugMode: true }));
		expect(debug).toContain('Tool details');
		expect(debug).toContain('tool-arguments');
		expect(debug).toContain('search_query');
		expect(debug).toContain('tool-output');
		expect(debug).toContain('debug_search_marker');
	});

	it('renders a malformed search safely while the host rejects it', () => {
		const markup = renderToStaticMarkup(
			createElement(ToolCallActivity, {
				call: {
					id: 'malformed',
					name: 'web.run',
					arguments: '{"search_query":[null,42,{"q":false}]}',
					status: 'failed',
					startedAt: 1,
					result: {
						content: [{ type: 'text', text: 'Each search entry must be valid.' }],
						isError: true,
					},
				},
			}),
		);
		expect(markup).toContain('failed');
		expect(markup).not.toContain('Each search entry must be valid.');
		expect(markup).not.toContain('<details');
		expect(markup).toContain('aria-expanded="false"');
		expect(markup).toContain('data-details="true"');
	});

	it('keeps viewed-image pixels lazy behind an actual disclosure in activity history', () => {
		const markup = renderToStaticMarkup(
			createElement(ToolCallActivity, {
				hideImages: true,
				call: {
					id: 'viewed-image',
					name: 'image.view',
					arguments: '{"target":"https://example.org/image.png"}',
					status: 'completed',
					startedAt: 1,
					result: {
						content: [
							{ type: 'image', dataUrl: 'data:image/png;base64,AA==', name: 'inspected.png' },
						],
					},
				},
			}),
		);
		expect(markup).toContain('data-details="true"');
		expect(markup).toContain('aria-label="Expand image activity: Viewed a web image');
		expect(markup).not.toContain('<img');
		expect(markup).not.toContain('base64');
	});

	it('identifies image searches and presents PDF screenshots as viewable tool images', () => {
		const imageSearch = renderToStaticMarkup(
			createElement(ToolCallActivity, {
				live: true,
				call: {
					id: 'images',
					name: 'web.run',
					arguments: JSON.stringify({ image_query: [{ q: 'Golden Gate Bridge' }] }),
					status: 'running',
					startedAt: 1,
				},
			}),
		);
		expect(imageSearch).toContain('Searching for images');
		expect(imageSearch).toContain('Golden Gate Bridge');
		const screenshot = renderToStaticMarkup(
			createElement(ToolCallActivity, {
				call: {
					id: 'pdf',
					name: 'web.run',
					arguments: JSON.stringify({ screenshot: [{ ref_id: 'source', pageno: 0 }] }),
					status: 'completed',
					startedAt: 1,
					result: {
						content: [
							{ type: 'image', dataUrl: 'data:image/png;base64,AA==', name: 'paper-page-1.png' },
						],
					},
				},
			}),
		);
		expect(screenshot).toContain('Viewed PDF pages');
		expect(screenshot).toContain('title="Open image"');
		expect(screenshot).toContain('paper-page-1.png');
		expect(screenshot).not.toContain('Open generated image');
		expect(screenshot).not.toContain('Download image');
	});
});
