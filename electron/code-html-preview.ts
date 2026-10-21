import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseDocument, DomUtils } from 'htmlparser2';

export const CODE_HTML_PREVIEW_BYTES = 12 * 1024 * 1024;
export const CODE_HTML_PREVIEW_CSP =
	"default-src 'none'; script-src 'unsafe-inline' data: blob:; style-src 'unsafe-inline' data:; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'";
const MIME: Record<string, string> = {
	'.js': 'text/javascript',
	'.mjs': 'text/javascript',
	'.css': 'text/css',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.avif': 'image/avif',
	'.gif': 'image/gif',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.otf': 'font/otf',
	'.mp3': 'audio/mpeg',
	'.wav': 'audio/wav',
	'.ogg': 'audio/ogg',
	'.mp4': 'video/mp4',
	'.webm': 'video/webm',
};

/** Embed only explicitly referenced assets through the caller's canonical workspace read checks. */
export async function buildCodeHtmlPreview(
	filename: string,
	root: string,
	read: (filename: string) => Promise<Buffer>,
): Promise<{ html: string; notices: string[] }> {
	const notices = new Set<string>();
	const cache = new Map<string, string>();
	const pending = new Set<string>();
	let embeddedBytes = 0;
	const include = (value: string) => {
		embeddedBytes += value.length;
		if (embeddedBytes > 8 * 1024 * 1024)
			throw new Error('Repeated assets exceed the preview size limit. Use a development server.');
		return value;
	};
	let bytes = 0,
		reads = 0,
		nodes = 0;
	const note = (value: string) => {
		if (notices.size < 32) notices.add(value.slice(0, 1000));
	};
	const readBounded = async (name: string) => {
		if (++reads > 96)
			throw new Error(
				'The HTML preview references too many files. Start a development server to preview this app.',
			);
		const data = await read(name);
		bytes += data.length;
		if (bytes > 8 * 1024 * 1024)
			throw new Error(
				'The HTML preview exceeds 8 MiB. Start a development server to preview this app.',
			);
		return data;
	};
	const resolve = (url: string, parent: string) => {
		if (/^[a-z][a-z\d+.-]*:|^\/\//i.test(url))
			throw new Error(
				'External resources are unavailable in this preview. Use a development URL in Browser for network access.',
			);
		const target = url.startsWith('/')
			? new URL(`.${url}`, pathToFileURL(`${root}${path.sep}`))
			: new URL(url, pathToFileURL(parent));
		return fileURLToPath(target);
	};
	const asset = async (url: string, parent: string, depth = 0): Promise<string> => {
		if (!url.trim() || /^(data:|#)/i.test(url)) return url;
		let name = '';
		try {
			if (depth > 8)
				throw new Error('Nested assets exceed the preview limit. Use a development server.');
			name = resolve(url.trim(), parent);
			if (cache.has(name)) return include(cache.get(name)!);
			if (pending.has(name)) throw new Error('A circular stylesheet import was skipped.');
			const mime = MIME[path.extname(name).toLowerCase()];
			if (!mime) throw new Error('This resource type needs a development server.');
			pending.add(name);
			let data = await readBounded(name);
			if (mime === 'text/css')
				data = Buffer.from(await css(data.toString('utf8'), name, depth + 1));
			const result = `data:${mime};base64,${data.toString('base64')}`;
			cache.set(name, result);
			return include(result);
		} catch (error) {
			note(
				`Could not preview ${url.slice(0, 180)}. ${error instanceof Error ? error.message : 'Open it using a development server.'}`,
			);
			return 'data:,';
		} finally {
			if (name) pending.delete(name);
		}
	};
	const css = async (source: string, parent: string, depth = 0) => {
		// Convert quoted @imports to url(), then resolve every local URL relative to this stylesheet.
		const normalized = source.replace(/@import\s+(["'])(.*?)\1/gi, '@import url("$2")');
		let output = '',
			last = 0;
		for (const match of normalized.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)) {
			output +=
				normalized.slice(last, match.index) +
				`url("${await asset(match[1] ?? match[2] ?? match[3], parent, depth)}")`;
			last = match.index! + match[0].length;
		}
		return output + normalized.slice(last);
	};
	const input = await readBounded(filename);
	if (input.length > 2 * 1024 * 1024 || input.includes(0))
		throw new Error(
			'HTML preview requires a UTF-8 file under 2 MiB. Use Source to inspect this file.',
		);
	const document = parseDocument(new TextDecoder('utf-8', { fatal: true }).decode(input));
	const visit = async (children: typeof document.children): Promise<void> => {
		for (const child of [...children]) {
			if (++nodes > 50000)
				throw new Error(
					'This document is too complex for the file preview. Use a development server.',
				);
			if (!('attribs' in child)) continue;
			if (child.name === 'base' || (child.name === 'meta' && child.attribs['http-equiv'])) {
				DomUtils.removeElement(child);
				continue;
			}
			const attrs = child.attribs;
			if (attrs.style) attrs.style = await css(attrs.style, filename);
			if (child.name === 'style') {
				const content = await css(DomUtils.textContent(child), filename);
				child.children = parseDocument(
					`<style>${content.replace(/<\/style/gi, '<\\/style')}</style>`,
				).children.flatMap((node) => ('children' in node ? node.children : []));
			}
			if (child.name === 'script' && attrs.type === 'module') {
				note(
					'JavaScript module imports need a development server. Open its HTTP address in Browser.',
				);
			}
			for (const attribute of ['src', 'poster']) {
				if (!attrs[attribute] || ['iframe', 'embed', 'object'].includes(child.name)) continue;
				attrs[attribute] = await asset(attrs[attribute], filename);
				delete attrs.integrity;
				delete attrs.crossorigin;
			}
			if (attrs.srcset) {
				// Data URLs contain commas; retain existing data srcsets without interpreting them as paths.
				if (!attrs.srcset.includes('data:')) {
					const entries = [];
					for (const entry of attrs.srcset.split(',')) {
						const [url, ...descriptor] = entry.trim().split(/\s+/);
						entries.push(`${await asset(url, filename)} ${descriptor.join(' ')}`.trim());
					}
					attrs.srcset = entries.join(', ');
				}
			}
			if (child.name === 'link' && attrs.href) {
				attrs.href = await asset(attrs.href, filename);
				delete attrs.integrity;
				delete attrs.crossorigin;
			}
			await visit(child.children);
		}
	};
	await visit(document.children);
	const html = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${CODE_HTML_PREVIEW_CSP}">${DomUtils.getOuterHTML(document)}`;
	if (Buffer.byteLength(html) > CODE_HTML_PREVIEW_BYTES)
		throw new Error(
			'The assembled preview is too large. Start a development server to preview this app.',
		);
	return { html, notices: [...notices] };
}
