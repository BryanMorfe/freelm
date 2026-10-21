import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import type { ComponentProps } from 'react';
import 'katex/dist/katex.min.css';
import { codeFileLink, useCodeSurfaceActions } from './code-surface-context';

const remarkPlugins = [remarkGfm, remarkMath];
const rehypePlugins: NonNullable<ComponentProps<typeof ReactMarkdown>['rehypePlugins']> = [
	[rehypeKatex, { strict: false, throwOnError: false, trust: false }],
];
export default function MathMarkdown({
	text,
	components,
}: {
	text: string;
	components: Components;
}) {
	const surface = useCodeSurfaceActions();
	return (
		<ReactMarkdown
			remarkPlugins={remarkPlugins}
			rehypePlugins={rehypePlugins}
			components={components}
			urlTransform={(url) =>
				(surface && codeFileLink(url)) || /^freelm-(?:skill|file|folder|app):/.test(url)
					? url
					: defaultUrlTransform(url)
			}
		>
			{text}
		</ReactMarkdown>
	);
}
