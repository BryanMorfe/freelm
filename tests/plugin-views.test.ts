import { describe, it, expect, vi } from 'vitest';
import { PluginViews } from '../electron/plugins/views';
const options = { nonce: '9cb8f145-318d-44ab-9bfc-7aecbb526a5e', theme: 'dark' };
describe('isolated plugin documents', () => {
	it('issues single-use documents with a restrictive response policy', async () => {
		const views = new PluginViews();
		const url = views.create('__FREELM_PLUGIN_THEME__ __FREELM_PLUGIN_CHANNEL__', options);
		expect(views.allows(url)).toBe(true);
		expect(views.allows(url + '?other')).toBe(false);
		const response = views.respond(new Request(url));
		expect(await response.text()).toBe(`dark ${options.nonce}`);
		expect(response.headers.get('Content-Security-Policy')).toContain("connect-src 'none'");
		expect(response.headers.get('Cache-Control')).toBe('no-store');
		expect(response.headers.get('Connection-Allowlist')).toBe('()');
		expect(response.headers.get('Content-Security-Policy')).toContain('sandbox allow-scripts;');
		expect(views.respond(new Request(url)).status).toBe(404);
		views.clear();
		expect(views.allows(url)).toBe(false);
	});
	it('bounds documents and expires navigation permits', () => {
		const views = new PluginViews();
		const first = views.create('test', options);
		for (let i = 0; i < 8; i++) views.create('test', options);
		expect(views.allows(first)).toBe(false);
		const last = views.create('test', options);
		const now = Date.now();
		vi.spyOn(Date, 'now').mockReturnValue(now + 60_001);
		expect(views.allows(last)).toBe(false);
		expect(views.respond(new Request(last)).status).toBe(404);
		vi.restoreAllMocks();
	});
	it('rejects markup in substitutions and oversized documents', () => {
		const views = new PluginViews();
		expect(() => views.create('test', { ...options, nonce: '</script>' })).toThrow();
		expect(() => views.create('test', { ...options, theme: '<script>' })).toThrow();
		expect(() => views.create('x'.repeat(8 * 1024 * 1024 + 1), options)).toThrow();
		const url = views.create('test', options);
		expect(views.respond(new Request(url, { method: 'POST' })).status).toBe(404);
		expect(views.respond(new Request(url)).status).toBe(200);
	});
});
