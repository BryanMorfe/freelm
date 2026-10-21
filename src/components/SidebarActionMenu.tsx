import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

/** Shared, viewport-constrained action menu for sidebar rows. */
export default function SidebarActionMenu({
	anchor,
	label,
	dismissLabel,
	onClose,
	children,
}: {
	anchor: RefObject<HTMLButtonElement | null>;
	label: string;
	dismissLabel: string;
	onClose: () => void;
	children: ReactNode;
}) {
	const menu = useRef<HTMLDivElement>(null);
	const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
	useLayoutEffect(() => {
		const trigger = anchor.current?.getBoundingClientRect();
		const popup = menu.current;
		if (!trigger || !popup) return;
		const bounds = popup.getBoundingClientRect();
		const scale = popup.offsetWidth ? bounds.width / popup.offsetWidth : 1;
		const width = bounds.width / scale;
		const height = bounds.height / scale;
		const viewportWidth = window.innerWidth / scale;
		const viewportHeight = window.innerHeight / scale;
		const bottom = trigger.bottom / scale;
		setPosition({
			left: Math.max(8, Math.min(trigger.right / scale - width, viewportWidth - width - 8)),
			top: Math.max(
				8,
				bottom + height + 8 <= viewportHeight
					? bottom + 4
					: Math.min(trigger.top / scale - height - 4, viewportHeight - height - 8),
			),
		});
		window.addEventListener('resize', onClose);
		window.addEventListener('scroll', onClose, true);
		return () => {
			window.removeEventListener('resize', onClose);
			window.removeEventListener('scroll', onClose, true);
		};
	}, [anchor, onClose]);
	useLayoutEffect(() => {
		if (position)
			menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus({
				preventScroll: true,
			});
	}, [position]);
	return createPortal(
		<>
			<button
				className="menu-dismiss"
				aria-label={dismissLabel}
				tabIndex={-1}
				style={{ zIndex: 109 }}
				onClick={onClose}
			/>
			<div
				ref={menu}
				className="thread-menu thread-menu-floating"
				role="menu"
				aria-label={label}
				style={{
					position: 'fixed',
					left: position?.left ?? 0,
					top: position?.top ?? 0,
					right: 'auto',
					visibility: position ? 'visible' : 'hidden',
					zIndex: 110,
				}}
				onKeyDown={(event) => {
					if (event.key === 'Escape' || event.key === 'Tab') {
						if (event.key === 'Escape') {
							event.preventDefault();
							event.stopPropagation();
						}
						onClose();
						return;
					}
					if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
					event.preventDefault();
					event.stopPropagation();
					const items = Array.from(
						event.currentTarget.querySelectorAll<HTMLButtonElement>(
							'[role="menuitem"]:not(:disabled)',
						),
					);
					const current = items.indexOf(document.activeElement as HTMLButtonElement);
					const next =
						event.key === 'Home'
							? 0
							: event.key === 'End'
								? items.length - 1
								: (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
					items[next]?.focus({ preventScroll: true });
				}}
			>
				{children}
			</div>
		</>,
		document.body,
	);
}
