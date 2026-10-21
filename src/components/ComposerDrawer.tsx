import { Children, type ReactNode } from 'react';
import './composer-drawer.css';

/** Shared, vertically stacked task context attached to the composer. */
export default function ComposerDrawer({ children }: { children: ReactNode }) {
	const sections = Children.toArray(children);
	if (!sections.length) return null;
	return (
		<div className="composer-drawer" role="group" aria-label="Task drawer">
			{sections}
		</div>
	);
}
