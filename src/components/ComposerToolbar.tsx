import { useLayoutEffect, useRef, type ReactNode } from 'react';
import './composer-toolbar.css';

/** Keep the real controls in one row, compacting labels in priority order. */
export default function ComposerToolbar({
	children,
	dictating = false,
}: {
	children: ReactNode;
	dictating?: boolean;
}) {
	const toolbar = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const element = toolbar.current!;
		let frame = 0;
		function fit() {
			frame = 0;
			if (!element.clientWidth) return;
			const style = getComputedStyle(element);
			// DOM rectangles include the app's CSS zoom; scale gaps to match them.
			const scale = element.getBoundingClientRect().width / element.offsetWidth;
			const available =
				(element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)) *
				scale;
			const gap = (parseFloat(style.columnGap) || 0) * scale;
			for (const mode of ['full', 'permissions', 'icons']) {
				element.dataset.compact = mode;
				const groups = Array.from(element.children).filter(
					(child) => getComputedStyle(child).display !== 'none',
				);
				const required =
					groups.reduce((width, group) => width + group.getBoundingClientRect().width, 0) +
					Math.max(0, groups.length - 1) * gap;
				if (required <= available) break;
			}
		}
		function schedule() {
			if (!frame) frame = requestAnimationFrame(fit);
		}
		fit();
		const resize = new ResizeObserver(schedule);
		resize.observe(element);
		for (const child of element.children) resize.observe(child);
		// Hidden labels still need to reflow when their model/effort text changes.
		const mutation = new MutationObserver(schedule);
		mutation.observe(element, { childList: true, characterData: true, subtree: true });
		document.fonts.addEventListener('loadingdone', schedule);
		return () => {
			cancelAnimationFrame(frame);
			resize.disconnect();
			mutation.disconnect();
			document.fonts.removeEventListener('loadingdone', schedule);
		};
	}, [dictating]);
	return (
		<div
			ref={toolbar}
			className="composer-toolbar adaptive-composer-toolbar"
			data-dictating={dictating}
		>
			{children}
		</div>
	);
}
