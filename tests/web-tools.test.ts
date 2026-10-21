import { describe, expect, it } from 'vitest';
import {
	configuredWebBrowsing,
	searxngSearchUrl,
	webInstructions,
	webTool,
} from '../src/lib/web-tools';
import { defaultToolSettings } from '../src/lib/tool-settings';

describe('web tool configuration and guidance', () => {
	it('normalizes service URLs while preserving reverse proxy prefixes', () => {
		for (const [input, expected] of [
			['http://192.168.0.221:8080', 'http://192.168.0.221:8080/search'],
			['https://search.example/proxy/', 'https://search.example/proxy/search'],
			[' https://search.example/proxy/search/ ', 'https://search.example/proxy/search'],
		])
			expect(searxngSearchUrl(input).href).toBe(expected);
	});
	it('rejects non-web URLs, secrets and accidental search links', () => {
		for (const input of [
			'',
			'example.com',
			'file:///tmp/settings',
			'ftp://search.example',
			'https://user:pass@search.example',
			'https://search.example/search?q=private',
			'https://search.example/#private',
		])
			expect(() => searxngSearchUrl(input)).toThrow();
	});
	it('only enables the capability with a valid explicitly enabled service', () => {
		expect(configuredWebBrowsing(undefined)).toBe(false);
		const settings = defaultToolSettings();
		for (const config of [
			{ enabled: false, searxngUrl: 'https://search.example' },
			{ enabled: true, searxngUrl: '' },
			{ enabled: true, searxngUrl: 'javascript:alert(1)' },
		]) {
			settings.webBrowsing = config;
			expect(configuredWebBrowsing(settings)).toBe(false);
		}
		settings.webBrowsing = { enabled: true, searxngUrl: 'http://localhost:8080' };
		expect(configuredWebBrowsing(settings)).toBe(true);
		expect(webTool.name).toBe('web.run');
		expect(webInstructions).toContain('untrusted source material');
		expect(webInstructions).toContain('ordinary Markdown links');
	});
});
