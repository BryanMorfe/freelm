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

export function hasMath(text: string) {
	return /\$[^\s$][\s\S]*?\$|\$\$|\\\(|\\\[/.test(text);
}
/** Support conventional TeX delimiters, leaving code fences and inline code untouched. */
export function normalizeMath(text: string) {
	return text
		.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g)
		.map((part, index) =>
			index % 2
				? part
				: part
						.replace(/\\\(([\s\S]*?)\\\)/g, '$$$1$')
						.replace(/\\\[([\s\S]*?)\\\]/g, (_match, body) => `\n$$\n${body}\n$$\n`),
		)
		.join('');
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
}: {
	text: string;
	sources?: ResearchSource[];
}) {
	const deferredText = useDeferredValue(text);
	return (
		<div className="message-content">
			<MarkdownContent text={deferredText.replace(/<\/?proposed_plan>/g, '')} sources={sources} />
		</div>
	);
});
