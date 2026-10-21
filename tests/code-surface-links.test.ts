import { describe, expect, it } from 'vitest';
import { codeBrowserLink, codeFileLink } from '../src/components/code-surface-context';

describe('Code browser links', () => {
	it('accepts and normalizes web URLs, including local development servers', () => {
		expect(codeBrowserLink('http://localhost:3000')).toBe('http://localhost:3000/');
		expect(codeBrowserLink('http://127.0.0.1:5173/page?q=one%20two#section')).toBe(
			'http://127.0.0.1:5173/page?q=one%20two#section',
		);
		expect(codeBrowserLink('https://example.com/docs')).toBe('https://example.com/docs');
	});
	it('never treats file, executable, relative, or credential-bearing URLs as browser links', () => {
		for (const href of [
			'file:///tmp/a.html',
			'javascript:alert(1)',
			'data:text/html,hello',
			'//example.com',
			'/workspace/index.html',
			'#section',
			'https://',
			'https://user:secret@example.com',
			'https://example.com/\nother',
		])
			expect(codeBrowserLink(href)).toBeUndefined();
	});
});

describe('Code file links', () => {
	it('opens absolute and relative file references at their source line', () => {
		expect(codeFileLink('/project/src/app.ts:32:4')).toEqual({
			path: '/project/src/app.ts',
			line: 32,
		});
		expect(codeFileLink('app.ts:32')).toEqual({ path: 'app.ts', line: 32 });
		expect(codeFileLink('docs/guide.md#L12')).toEqual({ path: 'docs/guide.md', line: 12 });
		expect(codeFileLink('/project/My%20File.md')).toEqual({ path: '/project/My File.md' });
	});
	it('routes local file URLs through the scoped file reader, including spaces and source lines', () => {
		expect(codeFileLink('file:///project/My%20App/index.html')).toEqual({
			path: '/project/My App/index.html',
		});
		expect(codeFileLink('file://localhost/project/src/app.ts#L32C4')).toEqual({
			path: '/project/src/app.ts',
			line: 32,
		});
		expect(codeFileLink('file:///project/index.html#timer')).toEqual({
			path: '/project/index.html',
		});
	});
	it('keeps URLs and invalid encoded references out of file navigation', () => {
		for (const href of [
			'https://example.com/app.ts:32',
			'javascript:alert(1)',
			'file://another-computer/project/app.html',
			'file://user:secret@localhost/project/app.html',
			'file:////server/project/app.html',
			'file:///project/a%00.html',
			'file:///project/%zz.html',
			'//example.com/app.ts',
			'#L12',
			'/tmp/a%00.ts',
			'/tmp/%zz',
			'app.ts:999999999999999999999',
		]) {
			expect(codeFileLink(href)).toBeUndefined();
		}
	});
});
