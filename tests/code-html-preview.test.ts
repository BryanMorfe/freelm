import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
	CodeSurfaceService,
	validCodeSurfaceResult,
	validateCodeSurfaceRequest,
} from '../electron/code-surface';
import { CodeHtmlViews } from '../electron/code-html-views';
import { codeBrowserError, codeBrowserLocalPath } from '../src/lib/code-browser-errors';

const cleanup: string[] = [];
afterEach(async () => {
	for (const directory of cleanup.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function fixture() {
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'freelm-html-preview-')));
	cleanup.push(root);
	const service = new CodeSurfaceService(async () => ({
		kind: 'code',
		roots: [root],
		skillDirectories: [],
		allowRemote: true,
	}));
	const filename = path.join(root, 'index.html');
	const request = {
		workspaceId: 'local',
		threadId: 'fixture',
		action: 'preview' as const,
		path: filename,
	};
	return { root, service, filename, request };
}

describe('isolated local HTML previews', () => {
	it('embeds relative classic scripts, nested CSS imports, images, and fonts through the scoped reader', async () => {
		const { root, service, filename, request } = await fixture();
		await mkdir(path.join(root, 'assets'));
		await writeFile(
			filename,
			'<link rel="stylesheet" href="assets/app.css"><script src="assets/app.js"></script><img src="assets/photo.svg"><button>Run</button>',
		);
		await writeFile(
			path.join(root, 'assets/app.css'),
			'@import "colors.css"; body{background-image:url(photo.svg)} @font-face{src:url(font.woff2)}',
		);
		await writeFile(path.join(root, 'assets/colors.css'), 'body{color:rgb(1,2,3)}');
		await writeFile(path.join(root, 'assets/app.js'), 'globalThis.ready=true');
		await writeFile(
			path.join(root, 'assets/photo.svg'),
			'<svg xmlns="http://www.w3.org/2000/svg"/>',
		);
		await writeFile(path.join(root, 'assets/font.woff2'), 'font-fixture');
		const result = await service.execute(request);
		expect(result.kind).toBe('preview');
		if (result.kind !== 'preview') return;
		expect(result.notices).toEqual([]);
		expect(result.html).toContain('data:text/javascript;base64,');
		expect(result.html).toContain('data:image/svg+xml;base64,');
		const css = Buffer.from(
			/data:text\/css;base64,([^"]+)/.exec(result.html)![1],
			'base64',
		).toString();
		expect(css).toContain('data:text/css;base64,');
		expect(css).toContain('data:image/svg+xml;base64,');
		expect(css).toContain('data:font/woff2;base64,');
		expect(validCodeSurfaceResult(result, request)).toBe(true);
	});
	it('does not broaden local reads through traversal, symlinks, file URLs, or external resources', async () => {
		const { root, service, filename, request } = await fixture();
		const secret = path.join(path.dirname(root), `${path.basename(root)}-secret.js`);
		cleanup.push(secret);
		await writeFile(secret, 'private-marker-not-previewable');
		await symlink(secret, path.join(root, 'linked.js'));
		await writeFile(
			filename,
			`<script src="../${path.basename(secret)}"></script><script src="linked.js"></script><script src="file://${secret}"></script><img src="https://example.invalid/image.png">`,
		);
		const result = await service.execute(request);
		if (result.kind !== 'preview') throw new Error('No preview');
		expect(result.html).not.toContain(
			Buffer.from('private-marker-not-previewable').toString('base64'),
		);
		expect(result.html.match(/data:,/g)).toHaveLength(4);
		expect(result.notices).toHaveLength(4);
		expect(result.html).toContain("connect-src 'none'");
		await expect(service.execute({ ...request, path: secret })).rejects.toThrow('outside');
	});
	it('removes base and refresh redirects and warns about modules without pretending they are bundled', async () => {
		const { service, filename, request } = await fixture();
		await writeFile(
			filename,
			'<base href="https://external.invalid/"><meta http-equiv="refresh" content="0;url=https://external.invalid"><script type="module">import "./app.js";</script>',
		);
		const result = await service.execute(request);
		if (result.kind !== 'preview') throw new Error('No preview');
		expect(result.html).not.toContain('<base');
		expect(result.html).not.toContain('refresh');
		expect(result.notices.join(' ')).toContain('module imports need a development server');
	});
	it('accepts preview only with a path and never accepts a remote URL as a preview capability', () => {
		const request = {
			workspaceId: 'remote',
			action: 'preview' as const,
			path: '/project/index.html',
		};
		expect(() => validateCodeSurfaceRequest(request)).not.toThrow();
		expect(() => validateCodeSurfaceRequest({ ...request, path: undefined })).toThrow();
		expect(
			validCodeSurfaceResult(
				{ kind: 'preview', path: request.path, html: '<p>Hi</p>', notices: [] },
				request,
			),
		).toBe(true);
		expect(
			validCodeSurfaceResult(
				{
					kind: 'preview',
					path: request.path,
					html: '',
					url: 'https://untrusted.invalid',
					notices: [],
				},
				request,
			),
		).toBe(false);
	});
	it('bounds repeated cached resources before document serialization can expand them', async () => {
		const { root, service, filename, request } = await fixture();
		await writeFile(filename, '<img src="large.png">'.repeat(30));
		await writeFile(path.join(root, 'large.png'), Buffer.alloc(1024 * 1024, 1));
		const result = await service.execute(request);
		if (result.kind !== 'preview') throw new Error('No preview');
		expect(Buffer.byteLength(result.html)).toBeLessThan(12 * 1024 * 1024);
		expect(result.notices.join(' ')).toContain('Repeated assets exceed');
	});
	it('serves single-use documents under response sandbox policy, with no persistent capabilities', async () => {
		const views = new CodeHtmlViews();
		const url = views.create('<button>Run</button>');
		expect(views.allows(url)).toBe(true);
		const response = views.respond(new Request(url));
		expect(response.headers.get('Content-Security-Policy')).toContain('sandbox allow-scripts;');
		expect(response.headers.get('Content-Security-Policy')).not.toContain('allow-same-origin');
		expect(response.headers.get('Content-Security-Policy')).toContain("connect-src 'none'");
		expect(await response.text()).toContain('<button>Run</button>');
		expect(views.respond(new Request(url)).status).toBe(404);
		views.clear();
		expect(views.allows(url)).toBe(false);
	});
});

describe('browser user-facing recovery', () => {
	it.each([
		[
			"Error invoking remote method 'freelm:code-browser': Error: The browser supports HTTP and HTTPS addresses without embedded credentials.",
			'Open local HTML files in Files',
		],
		['Error: net::ERR_CONNECTION_REFUSED (-102)', 'start its development server'],
		['Could not load this page: ERR_CERT_AUTHORITY_INVALID (-202).', 'server certificate'],
		[
			"Error invoking remote method 'freelm:code-browser': Error: This browser tab is closed.",
			'This browser tab is closed.',
		],
	])('explains %s', (error, expected) => {
		expect(codeBrowserError(error)).toContain(expected);
		expect(codeBrowserError(error)).not.toContain('remote method');
	});
	it('recognizes local file addresses without accepting other schemes or network file hosts', () => {
		expect(codeBrowserLocalPath('file:///tmp/My%20app/index.html')).toBe('/tmp/My app/index.html');
		expect(codeBrowserLocalPath('/tmp/index.html')).toBe('/tmp/index.html');
		expect(codeBrowserLocalPath('file://remote/etc/passwd')).toBeUndefined();
		expect(codeBrowserLocalPath('javascript:alert(1)')).toBeUndefined();
	});
});
