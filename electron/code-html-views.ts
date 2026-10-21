import { randomUUID } from 'node:crypto';
import { CODE_HTML_PREVIEW_BYTES, CODE_HTML_PREVIEW_CSP } from './code-html-preview';

/** Single-use rendered documents never inherit app scripts, storage, preload, or privileges. */
export class CodeHtmlViews {
	private documents = new Map<string, { html: string; expires: number }>();
	create(html: string): string {
		if (Buffer.byteLength(html) > CODE_HTML_PREVIEW_BYTES)
			throw new Error('HTML preview is too large.');
		for (const [key, value] of this.documents)
			if (value.expires < Date.now()) this.documents.delete(key);
		while (this.documents.size >= 12) this.documents.delete(this.documents.keys().next().value!);
		const url = `freelm-code-preview://view/${randomUUID()}`;
		this.documents.set(url, { html, expires: Date.now() + 60_000 });
		return url;
	}
	allows(url: string) {
		return (this.documents.get(url)?.expires ?? 0) >= Date.now();
	}
	respond(request: Request): Response {
		const document = this.documents.get(request.url);
		if (request.method !== 'GET' || !document?.html || document.expires < Date.now())
			return new Response('Preview expired. Reload the file to try again.', { status: 404 });
		const html = document.html;
		document.html = '';
		return new Response(html, {
			headers: {
				'Content-Type': 'text/html; charset=utf-8',
				'Cache-Control': 'no-store',
				'Connection-Allowlist': '()',
				'X-Content-Type-Options': 'nosniff',
				'Content-Security-Policy': `sandbox allow-scripts; ${CODE_HTML_PREVIEW_CSP}`,
				'Permissions-Policy':
					'camera=(), microphone=(), geolocation=(), display-capture=(), clipboard-read=(), clipboard-write=()',
			},
		});
	}
	clear() {
		this.documents.clear();
	}
}
