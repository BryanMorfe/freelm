import { createContext, useContext } from 'react';
import type { ToolCallRecord } from '../agent-types';

export interface CodeSurfaceActions {
	openFile(path: string, line?: number): void;
	openBrowser(url: string): void;
	openChanges(calls?: readonly ToolCallRecord[]): void;
}
export const CodeSurfaceContext = createContext<CodeSurfaceActions | undefined>(undefined);
export const useCodeSurfaceActions = () => useContext(CodeSurfaceContext);

/** Match the native browser's HTTP(S)-only, credential-free navigation contract. */
export function codeBrowserLink(href: string): string | undefined {
	if (href.length > 8192 || !/^https?:\/\//i.test(href) || /[\x00-\x20\x7f]/.test(href)) return;
	try {
		const url = new URL(href);
		if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password)
			return url.href;
	} catch {}
}

/** Only local file references, never a URL that can invoke an external protocol. */
export function codeFileLink(href: string): { path: string; line?: number } | undefined {
	if (!href || href.length > 8192) return;
	let value: string;
	try {
		if (/^file:/i.test(href)) {
			const url = new URL(href);
			if (
				(url.hostname && url.hostname !== 'localhost') ||
				url.username ||
				url.password ||
				url.port
			)
				return;
			// The scoped filesystem service remains the authority for access. A
			// local file URL is just another spelling of the same workspace path.
			value = decodeURIComponent(url.pathname);
			if (/^#L\d+(?:C\d+)?$/.test(url.hash)) value += url.hash;
		} else value = decodeURIComponent(href);
	} catch {
		return;
	}
	if (/[\x00-\x1f]/.test(value)) return;
	const match = value.match(/^(.*?)(?::(\d+)(?::\d+)?|#L(\d+)(?:C\d+)?)?$/);
	if (
		!match ||
		!match[1] ||
		/^[a-z][a-z\d+.-]*:/i.test(match[1]) ||
		match[1].startsWith('//') ||
		match[1].startsWith('#')
	)
		return;
	if (!match[1].startsWith('/') && !match[1].includes('/') && !/\.[a-z\d_-]+$/i.test(match[1]))
		return;
	const line = Number(match[2] || match[3]);
	if ((match[2] || match[3]) && !Number.isSafeInteger(line)) return;
	return {
		path: match[1],
		...(match[2] || match[3] ? { line: Math.max(1, line) } : {}),
	};
}
