import { memo, useId, useLayoutEffect, useRef, useState } from 'react';
import MessageMarkdown from './MessageMarkdown';
import './bot-message-body.css';

const PREVIEW_LINES = 10;
const INTERACTIVE_CONTENT =
	'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable="true"], audio[controls], video[controls]';

/** Keep the original Markdown intact; the preview is a presentation choice, not a new message. */
export default memo(function BotMessageBody({ text }: { text: string }) {
	const [expanded, setExpanded] = useState(false);
	const [collapsible, setCollapsible] = useState(false);
	const bodyId = useId();
	const contentRef = useRef<HTMLDivElement>(null);
	const markdownRef = useRef<HTMLDivElement>(null);
	const toggleRef = useRef<HTMLButtonElement>(null);

	useLayoutEffect(() => {
		const content = contentRef.current;
		const markdown = markdownRef.current;
		if (!content || !markdown) return;
		const clippedControls = new Map<HTMLElement, boolean>();
		function restoreControls() {
			for (const [element, wasInert] of clippedControls) element.inert = wasInert;
			clippedControls.clear();
		}
		function measure() {
			if (!content || !markdown) return;
			restoreControls();
			const style = getComputedStyle(content);
			const lineHeight =
				Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.5;
			const previewHeight = lineHeight * PREVIEW_LINES;
			// Entrance animations transform the bubble; use its unscaled layout height.
			const canCollapse = markdown.offsetHeight > previewHeight + 1;
			content.style.setProperty('--bot-message-preview-height', `${previewHeight}px`);
			setCollapsible((previous) => (previous === canCollapse ? previous : canCollapse));
			if (expanded || !canCollapse) return;
			const contentBounds = content.getBoundingClientRect();
			const scaleY = content.offsetHeight ? contentBounds.height / content.offsetHeight : 1;
			// The final line fades out; controls there need the expanded view as well.
			const visibleBottom = contentBounds.top + (previewHeight - lineHeight) * scaleY;
			for (const element of markdown.querySelectorAll<HTMLElement>(INTERACTIVE_CONTENT)) {
				const bounds = element.getBoundingClientRect();
				if (bounds.bottom <= visibleBottom && bounds.height > 0) continue;
				// Clipping alone leaves invisible links and code-copy buttons in the Tab order.
				const hadFocus = element.contains(document.activeElement);
				clippedControls.set(element, element.inert);
				element.inert = true;
				if (hadFocus) toggleRef.current?.focus();
			}
		}
		measure();
		// Observe the natural content size, not the capped box, to avoid resize feedback loops.
		const resize = new ResizeObserver(measure);
		resize.observe(markdown);
		// Deferred Markdown/math rendering can replace links without changing the total height.
		const mutation = new MutationObserver(measure);
		mutation.observe(markdown, { childList: true, subtree: true });
		return () => {
			resize.disconnect();
			mutation.disconnect();
			restoreControls();
		};
	}, [expanded, text]);

	return (
		<div className="bot-message-body">
			<div
				id={bodyId}
				className="bot-message-body-content"
				ref={contentRef}
				data-collapsed={collapsible && !expanded ? 'true' : undefined}
			>
				<div className="bot-message-body-markdown" ref={markdownRef}>
					<MessageMarkdown text={text} />
				</div>
			</div>
			{collapsible && (
				<button
					ref={toggleRef}
					type="button"
					className="bot-message-body-toggle"
					aria-expanded={expanded}
					aria-controls={bodyId}
					onClick={() => setExpanded((value) => !value)}
				>
					{expanded ? 'See less' : 'See more'}
				</button>
			)}
		</div>
	);
});
