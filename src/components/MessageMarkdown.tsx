import { Children, isValidElement, lazy, memo, Suspense, useDeferredValue, useMemo } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ResearchSource } from '../research-types';
import CodeBlock from './CodeBlock';
import './chat-composer-features.css';
import { codeFileLink, useCodeSurfaceActions } from './code-surface-context';
import { scanComposerMentions } from '../lib/composer-mention-codec';
import WorkspaceLink from './WorkspaceLink';

const plugins = [remarkGfm];
const MathMarkdown = lazy(() => import('./MathMarkdown'));
const baseComponents: Components = {
	pre: ({ children, node: _node, ...props }) => <CodeBlock {...codeProps(children)} />,
};
function codeProps(children: React.ReactNode) {
	const child = Children.toArray(children).find(isValidElement);
	if (!child) return { text: String(children || '') };
	const props = child.props as { children?: string; className?: string };
	return {
		text: String(props.children || '').replace(/\n$/, ''),
		language: props.className?.match(/language-([^\s]+)/)?.[1],
	};
}

const CODE_SPAN_OR_FENCE =
	/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|(`+)[^`\n]*(?:(?!\1)`[^`\n]*)*\1/g;
const CODE_OR_TEX =
	/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|(`+)[^`\n]*(?:(?!\1)`[^`\n]*)*\1|\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/g;

export function hasMath(text: string) {
	const outsideCode = text.replace(CODE_SPAN_OR_FENCE, '');
	return /(?<!\\)(?:\$\$|\\\(|\\\[|(?<!\d)\$(?!\s)(?:[^\n$]*?[^\s$])?\$(?!\d))/.test(outsideCode);
}
/** Support conventional TeX delimiters, leaving code fences and inline code untouched. */
export function normalizeMath(text: string) {
	return text.replace(CODE_OR_TEX, (match, _tick, inlineTex, blockTex) => {
		if (inlineTex !== undefined) return `$${inlineTex}$`;
		if (blockTex !== undefined) return `\n$$\n${blockTex}\n$$\n`;
		return match;
	});
}

const MarkdownContent = memo(function MarkdownContent({
	text,
	sources,
}: {
	text: string;
	sources?: ResearchSource[];
}) {
	const surface = useCodeSurfaceActions();
	const components = useMemo<Components>(
		() => ({
			...baseComponents,
			a: ({ children, node: _node, ...props }) => {
				if (/^freelm-(?:skill|file|folder|app):/.test(props.href || '')) {
					const reference = scanComposerMentions(`[App](${props.href})`)[0]?.reference;
					return (
						<span className="message-composer-mention">
							{reference?.kind === 'app' && reference.icon && (
								<img src={reference.icon} alt="" width={16} height={16} />
							)}
							{children}
						</span>
					);
				}
				const source = sources?.find((item) => item.url === props.href);
				const link = (
					<WorkspaceLink {...props} target="_blank" rel="noreferrer">
						{children}
					</WorkspaceLink>
				);
				if (!source) return link;
				let domain = source.url;
				try {
					domain = new URL(source.url).hostname;
				} catch {}
				return (
					<span className="research-citation">
						{link}
						<span className="citation-preview" role="tooltip">
							<strong>{source.title}</strong>
							<small>{domain}</small>
							{source.snippet && <span>{source.snippet.slice(0, 240)}</span>}
						</span>
					</span>
				);
			},
		}),
		[sources, surface],
	);
	const plain = (
		<ReactMarkdown
			remarkPlugins={plugins}
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
	return hasMath(text) ? (
		<Suspense fallback={plain}>
			<MathMarkdown text={normalizeMath(text)} components={components} />
		</Suspense>
	) : (
		plain
	);
});

/** Keep typing/Stop responsive while only the changing prose is parsed again. */
export default memo(function MessageMarkdown({
	text,
	sources,
	defer = true,
}: {
	text: string;
	sources?: ResearchSource[];
	/** Completed messages must stay consistent with their actions and accessibility labels. */
	defer?: boolean;
}) {
	const deferredText = useDeferredValue(defer ? text : '');
	const renderedText = defer ? deferredText : text;
	return (
		<div className="message-content">
			<MarkdownContent text={renderedText.replace(/<\/?proposed_plan>/g, '')} sources={sources} />
		</div>
	);
});
