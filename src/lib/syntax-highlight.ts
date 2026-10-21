import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import sql from 'highlight.js/lib/languages/sql';
import rust from 'highlight.js/lib/languages/rust';
import swift from 'highlight.js/lib/languages/swift';
import yaml from 'highlight.js/lib/languages/yaml';
import markdown from 'highlight.js/lib/languages/markdown';
import cpp from 'highlight.js/lib/languages/cpp';
import java from 'highlight.js/lib/languages/java';
import go from 'highlight.js/lib/languages/go';

for (const [name, grammar] of Object.entries({
	javascript,
	typescript,
	python,
	bash,
	json,
	css,
	xml,
	sql,
	rust,
	swift,
	yaml,
	markdown,
	cpp,
	java,
	go,
}))
	hljs.registerLanguage(name, grammar);
const aliases: Record<string, string> = {
	js: 'javascript',
	jsx: 'javascript',
	ts: 'typescript',
	tsx: 'typescript',
	py: 'python',
	sh: 'bash',
	shell: 'bash',
	html: 'xml',
	yml: 'yaml',
	c: 'cpp',
};
export function highlightCode(text: string, language: string): string | undefined {
	const normalized = aliases[language.toLowerCase()] || language.toLowerCase();
	if (!hljs.getLanguage(normalized)) return undefined;
	return hljs.highlight(text, { language: normalized, ignoreIllegals: true }).value;
}
