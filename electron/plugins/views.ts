import { randomUUID } from 'node:crypto';

// Single-use documents get their own response policy rather than inheriting the
// app's script policy (as srcdoc/blob pages do). The iframe still has an opaque
// origin: allow-same-origin is deliberately never enabled.
export class PluginViews {
	private documents = new Map<string, { html: string; expires: number }>();
	create(html: string, options: unknown): string {
		if (!options || typeof options !== 'object') throw new Error('Missing plugin view options.');
		const { nonce, theme } = options as { nonce?: unknown; theme?: unknown };
		if (
			typeof nonce !== 'string' ||
			!/^[\da-f-]{36}$/.test(nonce) ||
			(theme !== 'light' && theme !== 'dark')
		)
			throw new Error('Invalid plugin view options.');
		if (Buffer.byteLength(html) > 8 * 1024 * 1024) throw new Error('Plugin view is too large.');
		for (const [key, value] of this.documents)
			if (value.expires < Date.now()) this.documents.delete(key);
		while (this.documents.size >= 8) this.documents.delete(this.documents.keys().next().value!);
		const url = `freelm-plugin://view/${randomUUID()}`;
		this.documents.set(url, {
			html: html
				.replaceAll('__FREELM_PLUGIN_CHANNEL__', nonce)
				.replaceAll('__FREELM_PLUGIN_THEME__', theme),
			expires: Date.now() + 60_000,
		});
		return url;
	}
	allows(url: string): boolean {
		const document = this.documents.get(url);
		return !!document && document.expires >= Date.now();
	}
	respond(request: Request): Response {
		const document = this.documents.get(request.url);
		if (request.method !== 'GET' || !document || document.expires < Date.now() || !document.html)
			return new Response('Plugin view expired. Reopen the tab.', { status: 404 });
		const html = document.html;
		// Keep only a short-lived navigation permit after serving; no reusable HTML.
		document.html = '';
		return new Response(html, {
			headers: {
				'Content-Type': 'text/html; charset=utf-8',
				'Cache-Control': 'no-store',
				'Connection-Allowlist': '()',
				'X-Content-Type-Options': 'nosniff',
				'Content-Security-Policy':
					"sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'",
				'Permissions-Policy':
					'camera=(), microphone=(), geolocation=(), display-capture=(), clipboard-read=(), clipboard-write=()',
			},
		});
	}
	clear() {
		this.documents.clear();
	}
}
