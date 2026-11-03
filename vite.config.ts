import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command }) => {
	const development = command === 'serve';
	const csp = [
		"default-src 'self'",
		`script-src 'self'${development ? " 'unsafe-inline'" : ''}`,
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data: blob: https: http: freelm-workflow:",
		"media-src 'self' data: blob: https: http: freelm-workflow:",
		"font-src 'self' data:",
		`connect-src 'self' https: http:${development ? ' ws://127.0.0.1:* ws://localhost:*' : ''}`,
		"object-src 'none'",
		'frame-src freelm-plugin: freelm-code-preview:',
		"base-uri 'none'",
		"form-action 'none'",
	].join('; ');
	return {
		base: './',
		plugins: [
			react(),
			{
				name: 'freelm-content-security-policy',
				transformIndexHtml: () => [
					{
						tag: 'meta',
						attrs: { 'http-equiv': 'Content-Security-Policy', content: csp },
						injectTo: 'head-prepend',
					},
				],
			},
		],
		server: { host: '127.0.0.1', port: 5173, strictPort: true },
		build: { outDir: 'dist', sourcemap: true },
		test: {
			include: ['tests/**/*.test.ts'],
			// These raw stylesheets are package source, so their ZIP byte checks
			// must not receive Vitest's default empty CSS stubs.
			css: { include: [/examples\/plugins\/.*\.css(?:\?|$)/] },
		},
	};
});
