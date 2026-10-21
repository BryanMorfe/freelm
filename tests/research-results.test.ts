import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ResearchResults from '../src/components/ResearchResults';
import { collectResearchResults } from '../src/lib/research';
import type { ToolCallRecord } from '../src/agent-types';
import type { ResearchResults as Results } from '../src/research-types';

const call = (research: Results, extra: Partial<ToolCallRecord> = {}): ToolCallRecord => ({
	id: 'search',
	name: 'web.run',
	arguments: '{}',
	status: 'completed',
	startedAt: 1,
	result: { content: [{ type: 'text', text: '{}' }], research },
	...extra,
});

describe('research source and image presentation', () => {
	it('deduplicates a searched and read source while retaining its snippet and read status', () => {
		const result = collectResearchResults([
			call({
				sources: [
					{
						id: 'web_one',
						title: 'Search title',
						url: 'https://example.com/paper',
						snippet: 'A useful excerpt.',
					},
				],
			}),
			call({
				sources: [
					{
						id: 'web_one',
						title: 'Full paper title',
						url: 'https://example.com/paper',
						accessedAt: 1000,
					},
				],
			}),
		]);
		expect(result.sources).toEqual([
			{
				id: 'web_one',
				title: 'Full paper title',
				url: 'https://example.com/paper',
				snippet: 'A useful excerpt.',
				accessedAt: 1000,
			},
		]);
	});
	it('ignores failed, private and executable metadata and bounds the visible result list', () => {
		const values = [
			{ id: 'bad', title: 'Untrusted', url: 'javascript:alert(1)' },
			{ id: 'local', title: 'Private', url: 'http://127.0.0.1/private' },
			...Array.from({ length: 100 }, (_, index) => ({
				id: String(index),
				title: `Source ${index}`,
				url: `https://example.com/${index}`,
			})),
		];
		expect(collectResearchResults([call({ sources: values })]).sources).toHaveLength(64);
		expect(
			collectResearchResults([call({ sources: values }, { status: 'failed' })]).sources,
		).toHaveLength(0);
	});
	it('shows compact source titles and full URL links without debug JSON', () => {
		const result = collectResearchResults([
			call({
				sources: [
					{
						id: 'web_x',
						title: '<script>bad</script>',
						url: 'https://example.com/paper',
						snippet: '<img src=x onerror=bad()>',
						accessedAt: 100,
					},
				],
			}),
		]);
		const html = renderToStaticMarkup(createElement(ResearchResults, { results: result }));
		expect(html).toContain('Sources · 1');
		expect(html).toContain('href="https://example.com/paper"');
		expect(html).toContain('>https://example.com/paper</a>');
		expect(html).toContain('&lt;script&gt;bad&lt;/script&gt;');
		expect(html).not.toContain('<script>');
		expect(html).not.toContain('onerror=bad');
		expect(html).not.toContain('Tool details');
	});
	it('does not render image previews from saved search metadata', () => {
		const result = collectResearchResults([
			call({
				images: [
					{
						id: 'one',
						title: 'Mountain',
						url: 'https://images.example/full.jpg',
						sourceUrl: 'https://example.com/source',
						thumbnailUrl: 'https://images.example/thumb.jpg',
						previewDataUrl: 'data:image/jpeg;base64,AA==',
					},
					{
						id: 'two',
						title: 'Ocean',
						url: 'https://images.example/other.jpg',
						sourceUrl: 'https://example.com/source',
						previewDataUrl: 'javascript:alert(1)',
					},
				],
			}),
		]);
		const html = renderToStaticMarkup(createElement(ResearchResults, { results: result }));
		expect(html).toBe('');
	});
});
