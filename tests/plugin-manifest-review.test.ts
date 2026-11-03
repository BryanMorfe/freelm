import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import PluginManifestReview from '../src/components/PluginManifestReview';
import { pluginCatalog } from '../src/lib/plugin-catalog';
import { PLUGIN_CAPABILITY_LABELS } from '../src/lib/plugin-manifest';
import type { PluginManifest } from '../src/plugin-types';

describe('grouped plugin permission review', () => {
	it('retains every declared capability, network/storage state and identity in grouped rows', () => {
		for (const manifest of pluginCatalog) {
			const html = renderToStaticMarkup(createElement(PluginManifestReview, { manifest }));
			expect(html).toContain(manifest.id);
			expect(html).toContain('Network access');
			expect(html).toContain('No sign-in required');
			for (const capability of manifest.permissions.capabilities ?? [])
				expect(html).toContain(PLUGIN_CAPABILITY_LABELS[capability]);
			expect(html).toContain('settings-group-list');
			expect(html).not.toContain('<dl');
		}
	});
	it('keeps OAuth scopes, endpoints, resource and revocation visible and escapes metadata', () => {
		const manifest: PluginManifest = {
			manifestVersion: 1,
			id: 'synthetic.service',
			name: '<unsafe name>',
			version: '1.0.0',
			description: 'Synthetic review only',
			mcp: { url: 'https://service.example/mcp' },
			auth: {
				type: 'oauth2',
				clientId: 'fixture-client',
				authorizationUrl: 'https://service.example/authorize',
				tokenUrl: 'https://service.example/token',
				revocationUrl: 'https://service.example/revoke',
				resource: 'https://service.example',
				scopes: ['read', 'write'],
			},
		};
		const html = renderToStaticMarkup(createElement(PluginManifestReview, { manifest }));
		for (const value of [
			'read, write',
			'fixture-client',
			'/authorize',
			'/token',
			'/revoke',
			'Resource',
		])
			expect(html).toContain(value);
		expect(html).toContain('&lt;unsafe name&gt;');
		expect(html).not.toContain('<unsafe name>');
	});
});
