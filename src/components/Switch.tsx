import type { ButtonHTMLAttributes } from 'react';
import './controls.css';

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'onClick'> {
	checked: boolean;
	onChange: (checked: boolean) => void;
}

export default function Switch({ checked, onChange, className = '', ...props }: Props) {
	return (
		<button
			{...props}
			type="button"
			role="switch"
			aria-checked={checked}
			className={`switch-control ${className}`.trim()}
			onClick={() => onChange(!checked)}
		>
			<span aria-hidden="true" />
		</button>
	);
}
