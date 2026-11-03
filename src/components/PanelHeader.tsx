import type { ReactNode } from 'react';
import './ui-primitives.css';

/** A static title or the Home mode picker shares the same title slot and baseline. */
export default function PanelHeader({
	title,
	children,
	actions,
}: {
	title?: string;
	children?: ReactNode;
	actions?: ReactNode;
}) {
	return (
		<div className="sidebar-panel-header">
			<div className="panel-header-title-slot">
				{title ? <h2 className="sidebar-panel-title">{title}</h2> : children}
			</div>
			{actions && <div className="panel-header-actions">{actions}</div>}
		</div>
	);
}
