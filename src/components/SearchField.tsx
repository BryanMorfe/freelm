import type { InputHTMLAttributes } from 'react';
import { Search } from 'lucide-react';
import './ui-primitives.css';

export default function SearchField({
	label,
	value,
	onValueChange,
	className = '',
	onKeyDown,
	...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> & {
	label: string;
	value: string;
	onValueChange: (value: string) => void;
}) {
	return (
		<div className={`ui-search-field ${className}`}>
			<Search size={16} aria-hidden="true" />
			<input
				{...props}
				type="search"
				aria-label={label}
				value={value}
				onChange={(event) => onValueChange(event.currentTarget.value)}
				onKeyDown={(event) => {
					onKeyDown?.(event);
					if (
						event.key === 'Escape' &&
						value &&
						!event.defaultPrevented &&
						!event.isPropagationStopped()
					) {
						event.preventDefault();
						event.stopPropagation();
						onValueChange('');
					}
				}}
			/>
		</div>
	);
}
