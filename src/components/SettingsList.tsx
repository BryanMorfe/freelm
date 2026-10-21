import { useId, type ReactNode } from 'react';
import './settings-list.css';

interface SettingsGroupProps {
	title: ReactNode;
	description?: ReactNode;
	actions?: ReactNode;
	footer?: ReactNode;
	children: ReactNode;
	className?: string;
	id?: string;
}

/** A section heading and one inset, divided list of related settings. */
export function SettingsGroup({
	title,
	description,
	actions,
	footer,
	children,
	className = '',
	id,
}: SettingsGroupProps) {
	const generatedId = useId();
	const headingId = id || generatedId;
	return (
		<section className={`settings-group ${className}`} aria-labelledby={headingId}>
			<div className="settings-group-heading">
				<div>
					<h3 id={headingId}>{title}</h3>
					{description && <div className="settings-group-description">{description}</div>}
				</div>
				{actions && <div className="settings-group-actions">{actions}</div>}
			</div>
			<div className="settings-group-list">{children}</div>
			{footer && <div className="settings-group-footer">{footer}</div>}
		</section>
	);
}

interface SettingsRowProps {
	label?: ReactNode;
	description?: ReactNode;
	children?: ReactNode;
	htmlFor?: string;
	layout?: 'inline' | 'stacked';
	className?: string;
}

/** Labels remain outside controls so interactive descriptions never nest labels. */
export function SettingsRow({
	label,
	description,
	children,
	htmlFor,
	layout = 'inline',
	className = '',
}: SettingsRowProps) {
	return (
		<div className={`settings-row settings-row-${layout} ${className}`}>
			{(label || description) && (
				<div className="settings-row-copy">
					{label &&
						(htmlFor ? (
							<label className="settings-row-label" htmlFor={htmlFor}>
								{label}
							</label>
						) : (
							<div className="settings-row-label">{label}</div>
						))}
					{description && <div className="settings-row-description">{description}</div>}
				</div>
			)}
			{children && <div className="settings-row-control">{children}</div>}
		</div>
	);
}
