import { memo, useEffect, useRef, useState, type CSSProperties } from 'react';

/** Clamp full lines within the image instead of clipping an arbitrary overlay height. */
export default memo(function ImageGalleryCaption({ prompt }: { prompt: string }) {
	const caption = useRef<HTMLSpanElement>(null);
	const [layout, setLayout] = useState({ lines: 3, top: 35, bottom: 13, right: 14 });
	useEffect(() => {
		const element = caption.current;
		const imageButton = element?.parentElement;
		if (!element || !imageButton) return;
		const update = (height: number) => {
			const lineHeight = parseFloat(getComputedStyle(element).lineHeight);
			const bottom = Math.min(13, Math.max(0, height - lineHeight));
			const top = Math.min(35, Math.max(0, height - lineHeight - bottom));
			const lines = Math.max(
				0,
				Math.min(3, Math.floor((height - top - bottom + 0.01) / lineHeight)),
			);
			// Short captions share the delete control's row; keep their ellipsis visible beside it.
			const right = height - bottom - lines * lineHeight < 38 ? 52 : 14;
			setLayout((current) =>
				current.lines === lines &&
				current.top === top &&
				current.bottom === bottom &&
				current.right === right
					? current
					: { lines, top, bottom, right },
			);
		};
		const observer = new ResizeObserver(([entry]) => update(entry.contentRect.height));
		observer.observe(imageButton);
		return () => observer.disconnect();
	}, []);
	return (
		<span
			ref={caption}
			className="image-gallery-caption"
			hidden={layout.lines === 0}
			style={
				{
					'--image-caption-lines': layout.lines,
					paddingTop: layout.top,
					paddingBottom: layout.bottom,
					paddingRight: layout.right,
				} as CSSProperties
			}
		>
			<span className="image-gallery-caption-text">{prompt}</span>
		</span>
	);
});
