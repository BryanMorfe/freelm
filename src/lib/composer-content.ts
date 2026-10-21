import { parseDocument } from 'htmlparser2';
import type { Attachment } from '../types';

export const LARGE_PASTE_THRESHOLD = 10_000;
export const MAX_PASTED_TEXT = 1_000_000;

export function quoteSelection(text: string): string {
	return `${text
		.trim()
		.split('\n')
		.map((line) => `> ${line}`)
		.join('\n')}\n\n`;
}

function safeLink(value: string): string | undefined {
	try {
		const url = new URL(value);
		return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : undefined;
	} catch {
		return undefined;
	}
}

/** Parse clipboard markup as data. Never mount it or retain executable attributes. */
export function htmlToMarkdown(html: string): string {
	const document = parseDocument(html.slice(0, 2_000_000));
	type HtmlNode = {
		type: string;
		data?: string;
		name?: string;
		attribs?: Record<string, string>;
		children?: HtmlNode[];
	};
	function render(node: HtmlNode, depth = 0, pre = false): string {
		if (depth > 64) return '';
		if (node.type === 'text') return pre ? node.data || '' : (node.data || '').replace(/\s+/g, ' ');
		const tag = node.name?.toLowerCase() || '';
		if (['script', 'style', 'iframe', 'object', 'embed', 'svg', 'noscript', 'head'].includes(tag))
			return '';
		const body = (node.children || [])
			.map((child) => render(child, depth + 1, pre || tag === 'pre'))
			.join('');
		if (tag === 'br') return '\n';
		if (/^h[1-6]$/.test(tag)) return `\n\n${'#'.repeat(Number(tag[1]))} ${body.trim()}\n\n`;
		if (['p', 'div', 'section', 'article', 'table', 'tr'].includes(tag))
			return `\n\n${body.trim()}\n\n`;
		if (tag === 'strong' || tag === 'b') return `**${body}**`;
		if (tag === 'em' || tag === 'i') return `*${body}*`;
		if (tag === 'del' || tag === 's') return `~~${body}~~`;
		if (tag === 'a') {
			const href = safeLink(node.attribs?.href || '');
			return href ? `[${body.replaceAll(']', '\\]')}](${href.replaceAll(')', '%29')})` : body;
		}
		if (tag === 'pre') {
			const code = body.replace(/\n$/, '');
			const fence = '`'.repeat(
				Math.max(3, ...Array.from(code.matchAll(/`+/g), (match) => match[0].length + 1)),
			);
			return `\n\n${fence}\n${code}\n${fence}\n\n`;
		}
		if (tag === 'code' && !pre) return `\`${body.replaceAll('`', '\\`')}\``;
		if (tag === 'blockquote') return `\n\n${quoteSelection(body)}\n`;
		if (tag === 'ul' || tag === 'ol') {
			let index = 0;
			return `\n${(node.children || [])
				.map((child) => {
					if (child.name !== 'li') return render(child, depth + 1);
					const item = (child.children || [])
						.map((part) => render(part, depth + 1))
						.join('')
						.trim();
					return `${tag === 'ol' ? `${++index}.` : '-'} ${item.replaceAll('\n', '\n  ')}\n`;
				})
				.join('')}\n`;
		}
		return body;
	}
	return render(document as HtmlNode)
		.split(/(`{3,}[^\n]*\n[\s\S]*?\n`{3,})/g)
		.map((part, index) =>
			index % 2 ? part : part.replace(/\n[ \t]+\n/g, '\n\n').replace(/\n{3,}/g, '\n\n'),
		)
		.join('')
		.trim();
}

export function textAttachment(text: string, name = 'Pasted text.txt'): Attachment {
	if (text.length > MAX_PASTED_TEXT)
		throw new Error('Pasted text must be smaller than 1 million characters.');
	const bytes = new TextEncoder().encode(text);
	let binary = '';
	for (let index = 0; index < bytes.length; index += 8192)
		binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
	return {
		name,
		type: 'text/plain',
		dataUrl: `data:text/plain;charset=utf-8;base64,${btoa(binary)}`,
	};
}

export function spliceComposerText(content: string, inserted: string, start: number, end = start) {
	return content.slice(0, start) + inserted + content.slice(end);
}
