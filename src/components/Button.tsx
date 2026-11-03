import type { ButtonHTMLAttributes, Ref } from 'react';
import type { LucideIcon } from 'lucide-react';
import './ui-primitives.css';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	ref?: Ref<HTMLButtonElement>;
	variant?: 'primary' | 'secondary' | 'tertiary' | 'destructive';
	size?: 'standard' | 'compact';
	busy?: boolean;
}

export default function Button({
	variant = 'secondary',
	size = 'standard',
	busy = false,
	disabled,
	className = '',
	type = 'button',
	...props
}: ButtonProps) {
	return (
		<button
			{...props}
			type={type}
			disabled={disabled || busy}
			aria-busy={busy || undefined}
			className={`ui-button ui-button-${variant} ui-button-${size} ${className}`}
		/>
	);
}

export function IconButton({
	label,
	icon: Icon,
	size = 'standard',
	className = '',
	title,
	...props
}: Omit<ButtonProps, 'children'> & { label: string; icon: LucideIcon }) {
	return (
		<Button
			{...props}
			size={size}
			variant={props.variant ?? 'tertiary'}
			aria-label={label}
			title={title ?? label}
			className={`ui-icon-button ${className}`}
		>
			<Icon size={16} aria-hidden="true" />
		</Button>
	);
}
