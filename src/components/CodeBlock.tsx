import { memo, useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { copyToClipboard } from '../lib/clipboard';

export default memo(function CodeBlock({ text, language }: { text: string; language?: string }) {
	const [highlighted, setHighlighted] = useState<{
		text: string;
		language: string;
		html: string;
	}>();
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		let active = true;
		if (language && text.length <= 100_000)
			void import('../lib/syntax-highlight')
				.then(({ highlightCode }) => {
					const html = highlightCode(text, language);
					if (active && html) setHighlighted({ text, language, html });
				})
				.catch(() => {});
		return () => {
			active = false;
		};
	}, [text, language]);
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 1800);
		return () => clearTimeout(timer);
	}, [copied]);
	return (
		<div className="code-block">
			<div className="code-block-toolbar">
				<span>{language || 'Code'}</span>
				<button
					type="button"
					className="code-copy"
					aria-label="Copy code"
					onClick={async () => {
						try {
							await copyToClipboard(text);
							setCopied(true);
						} catch {
							setCopied(false);
						}
					}}
				>
					{copied ? <Check size={14} /> : <Copy size={14} />}
					{copied ? 'Copied' : 'Copy code'}
				</button>
			</div>
			<pre>
				{highlighted?.text === text && highlighted.language === language ? (
					<code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted.html }} />
				) : (
					<code>{text}</code>
				)}
			</pre>
		</div>
	);
});
