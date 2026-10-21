import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { validatePluginManifest, pluginPackagePath } from '../src/lib/plugin-manifest';
const sample = () => JSON.parse(readFileSync('examples/plugins/notebook/manifest.json', 'utf8'));
describe('local plugin manifest contract', () => {
	it('declares tools, tabs, actions and storage without enabling model access', () => {
		const manifest = validatePluginManifest(sample());
		expect(manifest.manifestVersion).toBe(2);
		if (manifest.manifestVersion !== 2) throw new Error('Wrong version');
		expect(manifest.permissions).toEqual({ network: [], storage: true });
		expect(manifest.contributes.tabs[0].entry).toBe('src/tab.ts');
	});
	it.each([
		'../escape.ts',
		'/absolute.ts',
		'file:///secret.ts',
		'src\\\\escape.ts',
		'src/../index.ts',
		'.env',
		'src/evil.ts?x',
		'src/CON.ts',
		'src/trailing.',
		'src/double//x.ts',
	])('rejects unsafe package entry %s', (entry) => {
		expect(() => pluginPackagePath(entry)).toThrow();
	});
	it('rejects unknown runtime versions, executable hooks and duplicate contributions', () => {
		let value = sample();
		value.runtime.apiVersion = 99;
		expect(() => validatePluginManifest(value)).toThrow(/version/);
		value = sample();
		value.scripts = { install: 'evil' };
		expect(() => validatePluginManifest(value)).toThrow(/unsupported fields/);
		value = sample();
		value.contributes.tools.push(value.contributes.tools[0]);
		expect(() => validatePluginManifest(value)).toThrow(/Duplicate/);
		value = sample();
		value.contributes.actions.push('constructor');
		expect(() => validatePluginManifest(value)).toThrow(/action/);
	});

	it('accepts bounded execution metadata and rejects misleading risk declarations', () => {
		const value = sample();
		value.contributes.tools[0] = {
			...value.contributes.tools[0],
			readOnly: true,
			execution: 'sync',
			effect: 'read',
			requiresApproval: false,
		};
		const parsed = validatePluginManifest(value);
		if (parsed.manifestVersion !== 2) throw new Error('Wrong version');
		expect(parsed.contributes.tools[0]).toMatchObject({ execution: 'sync', effect: 'read' });
		for (const patch of [
			{ execution: 'later' },
			{ effect: 'safe' },
			{ requiresApproval: 'yes' },
			{ readOnly: false, effect: 'read' },
			{ readOnly: true, effect: 'destructive' },
		]) {
			const invalid = structuredClone(value);
			Object.assign(invalid.contributes.tools[0], patch);
			expect(() => validatePluginManifest(invalid)).toThrow();
		}
	});
	it('binds authenticated direct API requests to an explicit allowed origin without inventing a resource', () => {
		const value = sample();
		value.permissions.network = ['https://gmail.googleapis.com'];
		value.auth = {
			type: 'oauth2',
			clientId: 'public-id',
			authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
			tokenUrl: 'https://oauth2.googleapis.com/token',
			scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
			apiOrigin: 'https://gmail.googleapis.com',
		};
		const parsed = validatePluginManifest(value);
		expect(parsed.auth).not.toHaveProperty('resource');
		value.auth.apiOrigin = 'https://attacker.example';
		expect(() => validatePluginManifest(value)).toThrow(/declared network/);
		value.auth.apiOrigin = 'https://gmail.googleapis.com';
		value.auth.resource = 'https://attacker.example/';
		expect(() => validatePluginManifest(value)).toThrow(/resource/);
	});
	it('rejects network wildcard, credentials and path-scoped origins', () => {
		for (const origin of [
			'*',
			'https://example.com/path',
			'https://user:pass@example.com',
			'http://example.com',
		]) {
			const value = sample();
			value.permissions.network = [origin];
			expect(() => validatePluginManifest(value)).toThrow();
		}
	});
	it('preserves existing remote MCP manifests and their resource binding', () => {
		const value = {
			manifestVersion: 1,
			id: 'test.mcp',
			name: 'MCP',
			version: '1',
			description: 'Remote service',
			mcp: { url: 'https://example.com/mcp' },
			auth: {
				type: 'oauth2',
				clientId: 'id',
				authorizationUrl: 'https://example.com/auth',
				tokenUrl: 'https://example.com/token',
				scopes: ['read'],
			},
		};
		const parsed = validatePluginManifest(value);
		expect(parsed.auth).toHaveProperty('resource', 'https://example.com/mcp');
	});
});
